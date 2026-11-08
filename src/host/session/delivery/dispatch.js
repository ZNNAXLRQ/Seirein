/**
 * Task dispatch: run a voice-issued task in its own agent session under the Seirein workspace,
 * so the companion conversation stays responsive and long work never blocks it.
 *
 * Uses `agentLoop.createAgent` with a seeded user message. The seed shape is the public session
 * event shape; if a Harness version rejects it, the failure is reported instead of thrown.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveInstanceRoot } from '../../runtime/root.js';
import { timelineObservation } from '../timeline/turn-timeline.js';

/**
 * Session ids this process already switched to full access. The session log is the durable
 * record, but a freshly created session's projection may not be readable yet on the next
 * ensure, so the in-process set keeps the switch exactly once.
 */
const sandboxSwitched = new Set();

/** Sessions where this process already reported that the official setter is unavailable. */
const sandboxUnavailable = new Set();

/**
 * Normalize a directory for an ownership decision: absolute, `..` collapsed, no trailing
 * separator, and case-folded on Windows. An empty value stays empty, which means "unknown".
 */
function normalizeDirectory(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length === 0) return '';
  const absolute = resolve(text).replace(/[\\/]+$/u, '');
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

/** True only for the same directory: a parent or a child directory never matches. */
function sameDirectory(left, right) {
  const a = normalizeDirectory(left);
  return a.length > 0 && a === normalizeDirectory(right);
}

/**
 * The session's own directory: its recorded header cwd first, then the live working-directory
 * service. The caller's request directory is deliberately never a fallback.
 */
function sessionDirectory(session, getService) {
  const recorded = session?.header?.cwd;
  if (typeof recorded === 'string' && recorded.trim().length > 0) return recorded.trim();
  try {
    const workingDirectory = getService?.('workingDirectory');
    const current = typeof workingDirectory?.get === 'function' ? workingDirectory.get(session) : undefined;
    if (typeof current === 'string' && current.trim().length > 0) return current.trim();
  } catch {
    /* a profile without the service leaves the session directory unknown */
  }
  return '';
}

/** The caller's session id: a reuse entry must never mix two sessions' results. */
function sessionIdOf(exec) {
  const id = exec?.agent?.session?.id ?? exec?.agent?.id;
  return typeof id === 'string' ? id.trim() : '';
}

/**
 * The current turn as the session's own log knows it, so "same turn" is a real boundary. An
 * unreadable session returns `null` and the ledger falls back to its time window instead of
 * guessing a turn number.
 */
function sessionTurnOf(exec) {
  const session = exec?.agent?.session;
  try {
    const events = typeof session?.ownEvents === 'function' ? session.ownEvents() : [];
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      const turn = event?.data?.turn ?? event?.turn ?? event?.data?.turnId;
      if (Number.isSafeInteger(turn) && turn >= 0) return turn;
    }
  } catch {
    /* an unreadable session keeps the time-window fallback */
  }
  return null;
}

/** Telemetry is best-effort: a missing or failing log must never block a session. */
async function emitSandboxLog(log, type, payload) {
  try {
    await log?.emit?.(type, payload);
  } catch {
    /* ignore */
  }
}

/** Read the session's current override without applying the deployment default. */
function currentSandboxMode(session, getService) {
  try {
    const policy = getService?.('sandboxPolicy');
    const mode = typeof policy?.overrideOf === 'function' ? policy.overrideOf(session) : undefined;
    return typeof mode === 'string' && mode.length > 0 ? mode : null;
  } catch {
    return null;
  }
}

/**
 * Move one session to `danger-full-access`, once. Only a session whose **own** directory equals
 * the assistant workspace is touched: the caller's request `cwd` is log-only and never decides
 * ownership. A missing setter or a failed write only logs, never throws.
 *
 * `attempts`/`retryDelayMs` are opt-in: the observer uses a small bounded budget because its
 * append can still land against a live publish, while `ensure` keeps its single attempt. Only
 * the final verdict is logged, so a retry that succeeds emits no `switch-failed` at all.
 * @param {{session?: object, sessionId?: string, cwd?: string, scopePath?: string,
 *   getService?: Function, setSandboxMode?: Function|null, log?: object|null,
 *   trigger?: 'ensure'|'observe', attempts?: number, retryDelayMs?: number}} options
 */
export async function switchToFullAccess({
  session,
  sessionId = '',
  cwd = '',
  scopePath = '',
  getService,
  setSandboxMode = null,
  log = null,
  trigger = 'ensure',
  attempts = 1,
  retryDelayMs = 0,
}) {
  if (session === undefined || session === null) return { skipped: 'no-session' };
  const id = String(session.id ?? sessionId ?? '');
  // Ownership is read from the session itself, never from the request directory in `cwd`: a
  // resumed session can live anywhere, regardless of which directory asked for it.
  const sessionCwd = sessionDirectory(session, getService);
  if (sessionCwd.length === 0) {
    await emitSandboxLog(log, 'sandbox.skipped', { reason: 'cwd-unknown' });
    return { skipped: 'cwd-unknown' };
  }
  const scope = typeof scopePath === 'string' ? scopePath.trim() : '';
  if (!sameDirectory(sessionCwd, scope)) {
    await emitSandboxLog(log, 'sandbox.skipped', {
      reason: 'cwd-mismatch',
      sessionCwd,
      scopePath: scope,
    });
    return { skipped: 'cwd-mismatch' };
  }
  const from = currentSandboxMode(session, getService);
  if (from === 'danger-full-access') {
    // Log the verdict once per session; the observer sees every later event too.
    const known = sandboxSwitched.has(id);
    sandboxSwitched.add(id);
    if (!known) await emitSandboxLog(log, 'sandbox.already-full', { sessionId: id });
    return { skipped: 'already-full', from, to: 'danger-full-access' };
  }
  if (sandboxSwitched.has(id)) return { skipped: 'already-switched', from, to: 'danger-full-access' };
  if (typeof setSandboxMode !== 'function') {
    if (!sandboxUnavailable.has(id)) {
      sandboxUnavailable.add(id);
      await emitSandboxLog(log, 'sandbox.switch-unavailable', { sessionId: id });
    }
    return { skipped: 'switch-unavailable' };
  }
  // Mark before writing: `session.append` may synchronously dispatch the `sandbox/mode` event,
  // and the observer must not re-enter this switch for the same session.
  sandboxSwitched.add(id);
  const budget = Number.isSafeInteger(attempts) && attempts > 0 ? attempts : 1;
  const gap = Number.isFinite(retryDelayMs) && retryDelayMs > 0 ? Math.round(retryDelayMs) : 0;
  let failure = null;
  for (let attempt = 1; attempt <= budget; attempt += 1) {
    try {
      await setSandboxMode(session, 'danger-full-access');
      await emitSandboxLog(log, 'sandbox.switched', { sessionId: id, from, to: 'danger-full-access', trigger });
      return { switched: true, from, to: 'danger-full-access', trigger };
    } catch (error) {
      failure = error;
      // The memo stays set between attempts, so a concurrent observer event cannot start a
      // second append while this one is still retrying.
      if (attempt < budget && gap > 0) {
        await new Promise((done) => setTimeout(done, gap * attempt));
      }
    }
  }
  sandboxSwitched.delete(id);
  await emitSandboxLog(log, 'sandbox.switch-failed', {
    sessionId: id,
    trigger,
    error: failure?.message ?? String(failure),
  });
  return { skipped: 'switch-failed' };
}

/**
 * Sessions the observer already spent its retry budget on. A definitive failure must not be
 * restarted by every later event; one observed session gets exactly one attempt cycle.
 */
const sandboxObserveGaveUp = new Set();

/** Sessions whose deferred attempt cycle is currently running, so events cannot overlap it. */
const sandboxObserveInFlight = new Set();

/** Yield one macrotask, so the host has finished publishing the event before we append. */
const afterEventDispatch = () => new Promise((done) => setImmediate(done));

/**
 * Switch one observed session after the current event dispatch has ended. `setImmediate` (not a
 * microtask) is required: the host publishes `session/event` synchronously inside `append`, so a
 * microtask can still run before that publish completes and would be rejected as a re-entry.
 */
async function switchObservedSession({ session, cwd, scopePath, getService, setSandboxMode, log }) {
  const id = String(session?.id ?? '');
  await afterEventDispatch();
  if (sandboxObserveGaveUp.has(id) || sandboxObserveInFlight.has(id)) return;
  sandboxObserveInFlight.add(id);
  try {
    const result = await switchToFullAccess({
      session,
      cwd,
      scopePath,
      getService,
      setSandboxMode,
      log,
      trigger: 'observe',
      attempts: 3,
      retryDelayMs: 25,
    });
    if (result?.skipped === 'switch-failed') sandboxObserveGaveUp.add(id);
  } finally {
    sandboxObserveInFlight.delete(id);
  }
}

/**
 * One aggregate line per foreign session per window replaces the per-event `sandbox.skipped`
 * flood: a directory this plugin can never own would otherwise write one cwd-mismatch line for
 * every committed session event (a DSH coding session produced ~37.8 k lines in 7.5 h). Five
 * minutes keeps the count and reason auditable instead of dropping the event silently.
 */
export const SANDBOX_SKIP_SUMMARY_WINDOW_MS = 5 * 60 * 1000;

/**
 * The mismatch that is known noise: both directories are readable and the session's own
 * directory is simply not this plugin's scope. An unknown session directory (`cwd-unknown`,
 * resolved by the switch itself) or an unknown scope is a real anomaly and keeps its per-event
 * `sandbox.skipped` record.
 */
function isForeignScopeMismatch(sessionCwd, scopePath) {
  return sessionCwd.length > 0 && scopePath.length > 0 && !sameDirectory(sessionCwd, scopePath);
}

/**
 * Observe committed session events so an already existing session (for example one opened by
 * typing in the GUI) is switched on its first event instead of waiting for a voice delivery.
 * Ownership always comes from the live session (its header cwd, then the working-directory
 * service); the event payload is never consulted. `scopePathOf` is read per event so runtime
 * scope changes are honoured.
 *
 * A foreign session is filtered **at this entry**: the switch could only report `cwd-mismatch`,
 * so the observer aggregates it instead of scheduling a write per event. One
 * `sandbox.skipped.summary {sessionId, count, reason, windowMs}` is written per session per window.
 * @param {{ctx: object, cwdOf: Function, scopePathOf: Function, getService: Function,
 *   setSandboxMode?: Function|null, log?: object|null, summaryWindowMs?: number}} options
 * @returns the unsubscribe function, or null when the context cannot listen.
 */
export function observeSessionSandbox({
  ctx,
  cwdOf,
  scopePathOf,
  getService,
  setSandboxMode = null,
  log = null,
  summaryWindowMs = SANDBOX_SKIP_SUMMARY_WINDOW_MS,
}) {
  if (typeof ctx?.on !== 'function') return null;
  const configured = Number(summaryWindowMs);
  const windowMs = Number.isFinite(configured) && configured >= 0
    ? Math.round(configured)
    : SANDBOX_SKIP_SUMMARY_WINDOW_MS;
  /** Windows belong to this observer: a summary is flushed before its unsubscribe returns. */
  const windows = new Map();
  const flushWindow = (sessionId) => {
    const entry = windows.get(sessionId);
    if (entry === undefined) return;
    windows.delete(sessionId);
    if (entry.timer !== null) clearTimeout(entry.timer);
    void emitSandboxLog(entry.log, 'sandbox.skipped.summary', {
      sessionId,
      count: entry.count,
      reason: 'cwd-mismatch',
      windowMs,
    });
  };
  const noteForeignSkip = (sessionId, sink) => {
    let entry = windows.get(sessionId);
    if (entry === undefined) {
      entry = { count: 0, log: sink, timer: null };
      entry.timer = setTimeout(() => flushWindow(sessionId), windowMs);
      entry.timer?.unref?.();
      windows.set(sessionId, entry);
    }
    entry.log = sink;
    entry.count += 1;
  };
  const off = ctx.on('session/event', (session) => {
    let cwd = '';
    let scopePath = '';
    try {
      // `cwdOf` is the session's directory (log-only); a cwd carried by the event is ignored.
      cwd = typeof cwdOf === 'function' ? String(cwdOf(session) ?? '') : '';
      scopePath = typeof scopePathOf === 'function' ? String(scopePathOf() ?? '') : '';
    } catch {
      return;
    }
    // Same ownership source the switch would use, so the filter can never disagree with it.
    const sessionCwd = sessionDirectory(session, getService);
    if (isForeignScopeMismatch(sessionCwd, scopePath)) {
      noteForeignSkip(String(session?.id ?? ''), log);
      return;
    }
    // Never append from inside the dispatch: schedule past it instead.
    void switchObservedSession({ session, cwd, scopePath, getService, setSandboxMode, log }).catch(() => {});
  });
  if (typeof off !== 'function') return null;
  return () => {
    // Nothing aggregated by this observer may be lost when it is disposed.
    for (const sessionId of [...windows.keys()]) flushWindow(sessionId);
    off();
  };
}

/** Build the user message shape the Harness rides into an agent's inbox. */
export function userMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  };
}

/**
 * Resolve the daily session for `sessionId`: resume the persisted one when it exists, otherwise
 * create it. Returns the live agent so callers can `followup` a message without any browser.
 *
 * `title` is the deterministic day stamp (`2026-11-04 周三`). It is pinned through the
 * session-title service, whose `rename()` appends a `session/title` event with the `user`
 * source. Without that, DSH titles a session after its first message — the user's first
 * utterance — and the model-backed title provider replaces it with a summary of that text.
 *
 * A session whose **own** cwd equals `scopePath` is the plugin's own assistant session: it is
 * moved to DSH `danger-full-access` once, through the official `setSandboxMode(session, mode)`
 * write path supplied by the caller. Every other session is left untouched.
 */
export async function ensureSession({
  sessionId,
  cwd,
  ownerCtx,
  getService,
  workspaceId = '',
  title = '',
  scopePath = '',
  setSandboxMode = null,
  log = null,
}) {
  const agentLoop = getService('agentLoop');
  if (agentLoop === undefined) return { ok: false, error: 'agentLoop 服务不可用' };

  const desiredTitle = typeof title === 'string' ? title.trim() : '';
  /**
   * Pin the session title, repairing it on resume when it is not already correct.
   * A title the user renamed by hand (`source.kind === 'user'`) is deliberately left alone, so
   * the automatic repair can never overwrite a deliberate rename.
   */
  const applyTitle = (agent) => {
    if (desiredTitle.length === 0) return { title: '', titleChanged: false, titleError: '' };
    const service = getService('sessionTitle');
    const session = agent?.session;
    // A profile without the title service cannot pin or even read the title: report "" rather
    // than echoing the wanted stamp, so a caller never records a title the sidebar does not show.
    if (session === undefined || session === null || typeof service?.rename !== 'function') {
      return { title: '', titleChanged: false, titleError: 'sessionTitle 服务不可用' };
    }
    const current = typeof service.get === 'function' ? service.get(session) : undefined;
    const currentTitle = typeof current?.title === 'string' ? current.title : '';
    const pinnedByUser = current?.source?.kind === 'user';
    if (currentTitle === desiredTitle || pinnedByUser) {
      return { title: currentTitle, titleChanged: false, titleError: '' };
    }
    try {
      const renamed = service.rename(session, desiredTitle);
      return { title: String(renamed?.title ?? desiredTitle), titleChanged: true, titleError: '' };
    } catch (error) {
      // Never fail the turn over a cosmetic title: the utterance still goes out.
      return { title: currentTitle, titleChanged: false, titleError: error?.message ?? String(error) };
    }
  };
  // Same ownership as a typed session: the registry validates the stored header cwd and then
  // records the session under that workspace, so the sidebar groups it instead of "未分组".
  const bind = async (agent) => {
    const workspace = workspaceId.length > 0 ? getService('workspaceRegistry')?.get?.(workspaceId) : undefined;
    if (typeof workspace?.attachSession === 'function') {
      try {
        await workspace.attachSession(agent.id);
      } catch {
        /* grouping is best-effort: a missing header must not block the turn */
      }
    }
    return agent;
  };
  // Bind the workspace grouping first, then pin the title: `rename()` only accepts the exact
  // live session, and `attachSession` must never be skipped just because a title failed.
  const settle = async (agent, extra) => {
    const bound = await bind(agent);
    // Full access belongs to the plugin's own assistant sessions only; the title is cosmetic and
    // is applied afterwards so a sandbox switch failure can never suppress it.
    const sandbox = await switchToFullAccess({
      session: bound?.session,
      sessionId,
      cwd,
      scopePath,
      getService,
      setSandboxMode,
      log,
      trigger: 'ensure',
    });
    return { ok: true, agent: bound, ...extra, sandbox, ...applyTitle(bound) };
  };
  // A live agent for that id is reusable as-is.
  // Disk is the source of truth: a live in-memory agent may be an orphan (its log deleted, or
  // it was created without provider/model), so it is never reused blindly here.
  // The service exposes the current model through currentSelection(), not as plain fields.
  const selectionService = getService('agentDefaultModel');
  const selected = selectionService?.currentSelection?.() ?? null;
  const provider = String(selected?.provider ?? selected?.route?.provider ?? '');
  const model = String(selected?.model ?? selected?.route?.model ?? '');
  const agentOptions = { provider, model };
  try {
    const handle = await agentLoop.resume(ownerCtx, { resumeSessionId: sessionId, agentOptions });
    if (handle?.agent !== undefined) return await settle(handle.agent, { resumed: true });
  } catch {
    /* not persisted yet: fall through to create */
  }
  try {
    const handle = await agentLoop.createAgent(ownerCtx, {
      sessionId,
      meta: { cwd },
      agentOptions: agentOptions.provider && agentOptions.model ? agentOptions : undefined,
    });
    return await settle(handle.agent, { resumed: false, created: true });
  } catch (error) {
    // The freshly created agent is still live in memory, so resume and create both refuse:
    // reuse that live one as the last resort (it was created with provider/model above).
    const live = ownerCtx?.get?.('agents')?.get?.(sessionId);
    if (live !== undefined && live !== null) return await settle(live, { resumed: false });
    return { ok: false, error: error?.message ?? String(error) };
  }
}

// ---- latency --------------------------------------------------------------

/** The stage fields of one `voice.latency` event, in the order the event reports them. */
export const VOICE_LATENCY_FIELDS = [
  'asrMs',
  'injectToAckMs',
  'ackToFirstTextMs',
  'firstTextToFirstSentenceMs',
  'firstSentenceToFirstAudioMs',
  'totalMs',
  // Translation is part of the first-sentence path when speech and text differ. A same-language
  // round records null for both (never 0/false, which would look like a measurement).
  'translateMs',
  'translateCached',
];

// A stage that was not observed stays null: `0` would be indistinguishable from a measured 0 ms.
const stageMs = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
};

/**
 * Optional first-sentence breakdown written into `voice.latency` when it was measured.
 * They are never part of `VOICE_LATENCY_FIELDS`, so the canonical stage set (and its p50/p95
 * card) keeps a fixed shape; a stage that was not measured is simply absent.
 */
export const VOICE_LATENCY_OPTIONAL_FIELDS = [
  'firstSynthWaitMs',
  'firstSynthMs',
  'firstQueueWaitMs',
  'firstPlayerStartMs',
];

/**
 * Observation fields written beside the canonical stage set. They are additions only: the stage
 * fields above (and their p50/p95 card) keep a fixed shape, and each value is null when it was not
 * measured. `firstAudibleLane` is the earliest lane that really sounded in this turn.
 */
export const VOICE_LATENCY_OBSERVATION_FIELDS = Object.freeze([
  'firstSpawnToPcmMs',
  'ttsSlotWaitMs',
  'translateQueueWaitMs',
  'firstAudibleMs',
]);

/** The only lanes that may be reported as the first audible one. */
export const VOICE_FIRST_AUDIBLE_LANES = Object.freeze(['ack', 'say', 'reply']);

/** Read one observation in ms: absent/unmeasured is null, an explicit 0 is a real measurement. */
const observationMs = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
};

/**
 * Map the additive latency observations.
 *
 * `firstAudibleLane`/`firstAudibleMs` are written as a pair: when the lane cannot be determined
 * both are null and `firstAudibleUnknown` says why, so a null lane is never read as "lane reply".
 * @param {object} [stages] the same row handed to `voiceLatencyEvent`, plus the observations
 * @returns {{firstSpawnToPcmMs: number|null, ttsSlotWaitMs: number|null,
 *   translateQueueWaitMs: number|null, firstAudibleMs: number|null,
 *   firstAudibleLane: string|null, firstAudibleUnknown?: string}}
 */
export function voiceLatencyObservations(stages = {}) {
  const fields = {};
  for (const field of VOICE_LATENCY_OBSERVATION_FIELDS) fields[field] = observationMs(stages[field]);
  const lane = VOICE_FIRST_AUDIBLE_LANES.includes(stages.firstAudibleLane)
    ? stages.firstAudibleLane
    : null;
  fields.firstAudibleLane = lane;
  if (lane === null) {
    fields.firstAudibleMs = null;
    const reason = typeof stages.firstAudibleUnknown === 'string' && stages.firstAudibleUnknown.length > 0
      ? stages.firstAudibleUnknown
      : 'no-ack-or-speech-start';
    fields.firstAudibleUnknown = reason;
  }
  return fields;
}

/**
 * Earliest real audible start among lane readings (`{lane, firstAudioAt}`). The earliest wins;
 * equal stamps keep the first reading (the order the lanes were observed in). Unreadable or
 * unmeasured readings are ignored, and an empty list is null — never a fabricated lane.
 * @param {Array<{lane?: string, firstAudioAt?: number}>} [readings]
 * @returns {{lane: string, firstAudioAt: number}|null}
 */
export function earliestAudible(readings) {
  let best = null;
  for (const reading of Array.isArray(readings) ? readings : []) {
    const lane = reading?.lane;
    const at = Number(reading?.firstAudioAt);
    if (!VOICE_FIRST_AUDIBLE_LANES.includes(lane) || !(at > 0)) continue;
    if (best === null || at < best.firstAudioAt) best = { lane, firstAudioAt: at };
  }
  return best;
}

/**
 * Stable join keys carried by `voice.latency` and `voice.first-sentence`.
 *
 * `deliveryMessageId` is the id the session log writes as `user/message.data.id`, and `acceptTurn`
 * is the turn this delivery was accepted into. `turn` is kept for backward compatibility only: it
 * may still be re-read around the turn boundary, so it can be off by one; join on
 * `deliveryMessageId` (or `acceptTurn`) instead.
 */
export function voiceJoinKeys({ deliveryMessageId = null, acceptTurn = null, turn = null } = {}) {
  const id = typeof deliveryMessageId === 'string' && deliveryMessageId.length > 0
    ? deliveryMessageId
    : null;
  return {
    deliveryMessageId: id,
    acceptTurn: Number.isSafeInteger(acceptTurn) ? acceptTurn : null,
    turn: Number.isSafeInteger(turn) ? turn : null,
  };
}

/**
 * Build the canonical `voice.latency` payload: every measured stage is a non-negative integer ms,
 * and a stage with no observation is null (never a fabricated 0). Percentiles ignore null.
 * @param {{sessionId?: string, [stage: string]: any}} stages
 */
export function voiceLatencyEvent(stages = {}) {
  const row = { sessionId: String(stages.sessionId ?? '') };
  // A same-language round has no translation stage at all: `translated: false` plus the
  // caller's default 0/false must not be recorded as a measured 0 ms or "not cached". A failed
  // attempt may report the time it burned; without a real translation it is still not a stage.
  const translated = stages.translated === true
    || stages.translateCached === true
    || (stages.translated !== false && Number(stages.translateMs) > 0);
  for (const field of VOICE_LATENCY_FIELDS) {
    if (field === 'translateCached') {
      row[field] = translated && typeof stages.translateCached === 'boolean'
        ? stages.translateCached
        : null;
    } else if (field === 'translateMs') {
      row[field] = translated ? stageMs(stages.translateMs) : null;
    } else {
      row[field] = stageMs(stages[field]);
    }
  }
  for (const field of VOICE_LATENCY_OPTIONAL_FIELDS) {
    const raw = stages[field];
    if (raw === undefined || raw === null || raw === '') continue;
    const value = Number(raw);
    if (Number.isFinite(value) && value >= 0) row[field] = Math.round(value);
  }
  return row;
}

/** Linear-interpolated percentile over the finite values, or null when nothing was measured. */
export function percentile(values, p) {
  const sorted = (Array.isArray(values) ? values : [])
    .filter((value) => value !== null && value !== undefined)
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const rank = (sorted.length - 1) * Math.min(1, Math.max(0, p));
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  const value = low === high ? sorted[low] : sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
  return Math.round(value);
}

/** p50/p95 per stage for the settings card; null means "no sample yet". */
export function summarizeVoiceLatency(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const p50 = {};
  const p95 = {};
  for (const field of VOICE_LATENCY_FIELDS) {
    if (field === 'translateCached') {
      // A boolean has no percentile: report whether the cached share reaches that threshold.
      const measured = list
        .map((row) => row?.[field])
        .filter((value) => value === true || value === false);
      const cached = measured.filter((value) => value === true).length;
      p50[field] = measured.length === 0 ? null : cached / measured.length >= 0.5;
      p95[field] = measured.length === 0 ? null : cached / measured.length >= 0.95;
      continue;
    }
    const values = list.map((row) => row?.[field]);
    p50[field] = percentile(values, 0.5);
    p95[field] = percentile(values, 0.95);
  }
  return { count: list.length, p50, p95 };
}

/** Bounded in-memory record of recent voice rounds; the status route reads its snapshot. */
export class VoiceLatencyLog {
  constructor({ capacity = 20 } = {}) {
    this.capacity = Math.max(1, Number(capacity) || 20);
    this.rows = [];
    this.samples = 0;
  }

  record(stages) {
    const row = voiceLatencyEvent(stages);
    this.rows.push(row);
    while (this.rows.length > this.capacity) this.rows.shift();
    this.samples += 1;
    return row;
  }

  snapshot() {
    const summary = summarizeVoiceLatency(this.rows);
    const latest = this.rows[this.rows.length - 1] ?? null;
    return {
      samples: this.samples,
      recent: this.rows.slice(),
      // The newest round's translation pair, flattened for the status card; null means that
      // round had no translation (same language) and is not counted as 0 ms.
      translateMs: latest?.translateMs ?? null,
      translateCached: latest?.translateCached ?? null,
      p50: summary.p50,
      p95: summary.p95,
      fields: [...VOICE_LATENCY_FIELDS],
    };
  }
}

/** First complete sentence of a reply, or '' while no boundary has arrived yet. */
export function firstSentenceOf(text) {
  const value = String(text ?? '');
  for (let index = 0; index < value.length; index += 1) {
    const ch = value[index];
    if ('。！？!?；;\n'.includes(ch)) {
      const sentence = value.slice(0, index + 1).trim();
      return sentence.length > 0 ? sentence : '';
    }
  }
  return '';
}

/** Turn identity carried by a session event: explicit turnId when one exists, else the loop's `data.turn`. */
function eventTurnId(event) {
  const direct = event?.turnId ?? event?.turnID ?? event?.data?.turnId;
  if (direct !== undefined && direct !== null) return direct;
  const turn = event?.data?.turn;
  return turn === undefined || turn === null ? null : turn;
}

/** Extract the assistant text of one `assistant/message` event. */
function assistantText(event) {
  const content = event?.data?.message?.content ?? [];
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
    .trim();
}

/**
 * Does one committed assistant message call a tool? The Harness commits `assistant/message` at
 * every step and executes the model's `tool-call` blocks afterwards, so a step with tool calls is
 * pre-tool commentary, never the reply body that may start first-sentence playback.
 */
function hasToolCallBlocks(event) {
  const content = event?.data?.message?.content;
  if (!Array.isArray(content)) return false;
  return content.some((block) => typeof block?.type === 'string' && block.type.startsWith('tool'));
}

/**
 * Session event that streams assistant frames before the step is committed, when the installed
 * Harness emits one. Its payload is normalized into the same `{type, text, turn, step,
 * attemptId}` frame shape and handled by the one strict state machine below.
 */
const STREAM_EVENT_TYPE = 'agent/assistant-stream';

/**
 * The installed bundle also publishes assistant frames on its own channel, `agent/assistant-stream`,
 * which is not a `session/event`: it pushes `{agent, frame}`. Subscribing only to
 * `session/event` therefore never sees those frames.
 */
const STREAM_CHANNEL = 'agent/assistant-stream';

/** Split a channel callback's arguments into `{agent, frame}` for both signatures. */
function streamParts(first, second) {
  if (second !== undefined && second !== null && typeof second === 'object') {
    return { agent: first ?? null, frame: second };
  }
  if (first !== null && typeof first === 'object' && first.frame !== null && typeof first.frame === 'object') {
    return { agent: first.agent ?? null, frame: first.frame };
  }
  return { agent: null, frame: first !== null && typeof first === 'object' ? first : null };
}

/** Every protocol name a frame carries, lowercased: the type may live in any of these places. */
function frameTypes(frame) {
  const values = [
    frame?.type,
    frame?.kind,
    frame?.phase,
    frame?.event,
    frame?.chunk?.type,
    frame?.chunk?.kind,
    frame?.data?.type,
    frame?.data?.kind,
  ];
  const types = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const type = value.trim().toLowerCase();
    if (type.length > 0 && !types.includes(type)) types.push(type);
  }
  return types;
}

/** Frame names that open/close one attempt of the strict start -> chunk -> end stream. */
const FRAME_START_TYPES = new Set(['start', 'attempt-start', 'attempt_start', 'step-start', 'stream-start']);
const FRAME_END_TYPES = new Set(['end', 'attempt-end', 'attempt_end', 'step-end', 'stream-end']);
/** End outcomes that mean the attempt produced no committable reply and its buffer is garbage. */
const FAILED_END_KINDS = new Set([
  'abandoned', 'abort', 'aborted', 'cancel', 'cancelled', 'canceled',
  'error', 'failed', 'failure', 'interrupted', 'timeout',
]);

/**
 * True when an `end` frame reports abandonment/cancellation/failure rather than a normal close.
 * The installed protocol attaches `outcome.kind`; the other names are tolerated shapes.
 */
function frameEndFailed(frame) {
  const values = [
    frame?.outcome, frame?.data?.outcome,
    frame?.status, frame?.data?.status,
    frame?.reason, frame?.data?.reason,
    frame?.result, frame?.data?.result,
  ];
  for (const value of values) {
    const kind = typeof value === 'string'
      ? value
      : value?.kind ?? value?.status ?? value?.type ?? value?.reason?.kind;
    if (typeof kind === 'string' && FAILED_END_KINDS.has(kind.trim().toLowerCase())) return true;
  }
  return false;
}

/**
 * Explicit **body** delta names. This is a whitelist on purpose: a frame that merely carries a
 * `text`/`chunk` field is not body. `reasoning-delta`, `thinking`, `analysis*` and every unknown
 * name are rejected (and reasoning ones counted), so private reasoning can never be spoken.
 */
const BODY_FRAME_TYPES = new Set(['text', 'text-delta', 'text_delta', 'assistant-text-delta', 'content-delta', 'body-delta']);
const REASONING_FRAME_TYPE = /^(reasoning|thinking|thought|analysis)/u;

/**
 * Incremental text of one body frame. The frame type has already been whitelisted by the caller,
 * so `chunk` (string or `{text}`) is the installed delta shape and `text`/`delta` are fallbacks.
 */
function frameDeltaText(frame) {
  const chunk = frame?.chunk;
  if (typeof chunk === 'string') return chunk;
  const sources = [chunk?.text, chunk?.delta, frame?.text, frame?.delta, frame?.data?.text, frame?.data?.delta];
  for (const source of sources) {
    if (typeof source === 'string' && source.length > 0) return source;
  }
  return '';
}

/** Attempt identity carried by a frame, if the protocol provides one. */
function frameAttemptId(frame) {
  const value = frame?.attemptId ?? frame?.attempt?.id ?? frame?.data?.attemptId ?? frame?.data?.attempt?.id;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** A safe integer field, or null when the frame does not carry one. */
function intOrNull(value) {
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Desensitized shape of one frame: field names and value types only, never text. Recorded for the
 * first frames of a round so the real protocol can be confirmed from `voice.stream.sample`.
 */
function frameShape(value, prefix = '', depth = 0) {
  if (depth > 2) return {};
  if (value === null) return { [prefix || '.']: 'null' };
  if (Array.isArray(value)) {
    const out = { [prefix || '.']: `array(${value.length})` };
    if (value.length > 0) Object.assign(out, frameShape(value[0], `${prefix}[0]`, depth + 1));
    return out;
  }
  if (typeof value !== 'object') {
    // Protocol vocabulary (`type`/`kind`/`role`) is safe and necessary to confirm the real frame
    // format; every other string is reduced to its type so reply/reasoning text never leaks.
    const key = prefix.split('.').pop() ?? '';
    const safe = typeof value === 'string' && value.length <= 32
      && ['type', 'kind', 'phase', 'role', 'status', 'event', 'name'].includes(key)
      && /^[\w.:-]+$/u.test(value);
    return { [prefix || '.']: safe ? value : typeof value };
  }
  const out = {};
  for (const key of Object.keys(value).slice(0, 12)) Object.assign(out, frameShape(value[key], prefix ? `${prefix}.${key}` : key, depth + 1));
  return out;
}

/** Session a frame belongs to: on the agent, on the frame, or on the frame's own agent. */
function streamFrameSessionId(agent, frame) {
  const candidates = [
    agent?.session?.id,
    frame?.sessionId,
    frame?.session?.id,
    frame?.agent?.session?.id,
    frame?.data?.sessionId,
    frame?.data?.session?.id,
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return '';
}

/**
 * Identity of the user message a `user/message` event records. The Harness logs the message
 * object itself under `event.data` (`assertMessageEventShape` requires a nonempty `id`), so the
 * id `userMessage()` generated survives into the event feed unchanged.
 */
function userMessageId(event) {
  if (event?.type !== 'user/message') return null;
  const data = event?.data;
  const direct = data?.id ?? data?.messageId ?? data?.message?.id;
  return typeof direct === 'string' && direct.length > 0 ? direct : null;
}

/**
 * Map one `turn/end` reason onto a stable status. The loop records every cancellation as
 * `{kind:"aborted", reason:{kind:"user"|"parent"|"disposed"|"hook"}}`, so a user cancellation is
 * separated from an upstream abort here.
 */
function turnEndStatus(reason) {
  const kind = typeof reason?.kind === 'string' ? reason.kind : '';
  if (kind === 'cancelled' || kind === 'canceled') return 'cancelled';
  if (kind === 'aborted') {
    return reason?.reason?.kind === 'user' ? 'cancelled' : 'aborted';
  }
  if (kind === 'completed' || kind === 'max-tokens' || kind === 'blocked' || kind === 'error') return kind;
  // A missing reason is a completed turn in older feeds; an unknown kind is not a success.
  return kind.length > 0 ? 'error' : 'completed';
}

/** Build the result for one finished turn: only a normal completion counts as success. */
function turnResult(status, text) {
  const finished = status === 'completed' || status === 'max-tokens';
  if (!finished) return { ok: false, text, error: status, status };
  if (text.length === 0) return { ok: false, text: '', error: 'empty', status: 'empty' };
  return { ok: true, text, error: '', status };
}

/** One live listener per session: two overlapping waits would both consume the same turn. */
const activeSessionListeners = new Map();

/**
 * The delivery point: how far the session log had advanced when listening started.
 * `session.seq` is the next event's sequence number, so every event produced after this
 * point has `seq >= baseline`; a resumed session's replayed history stays below it.
 */
function sessionBaselineSeq(ctx, sessionId) {
  try {
    const seq = ctx?.get?.('agents')?.get?.(sessionId)?.session?.seq;
    if (Number.isSafeInteger(seq) && seq >= 0) return seq;
  } catch {
    /* service unavailable: fall back to wall time */
  }
  return null;
}

/**
 * Wait for a dispatched session's turn to finish and return that turn's assistant text.
 * Listens to the post-commit `session/event` feed.
 *
 * Two binding modes:
 *  - identity mode (`deliveryMessageId`): the wait binds to the turn that logs the delivered
 *    `user/message` with that id. Any other turn (a resume replay, another lane's turn) is
 *    therefore skipped, because its user message has a different id.
 *  - legacy mode (no id): the first `turn/start` after the delivery baseline is accepted by
 *    turn number. There is no separate digest turn to skip any more: the day background is
 *    injected into the delivered request itself (see `session/conversation/rollover-digest.js`).
 *
 * Only one listener may consume a session at a time; an overlapping call resolves immediately
 * with `{ok:false, error:"session-listener-busy", status:"busy"}`.
 *
 * Returns a promise of `{ok, text, error, status}` carrying `cancel()`; pass `signal` to abort too.
 * `status` is one of completed / max-tokens / cancelled / aborted / error / blocked / empty /
 * timeout / busy / unavailable.
 *
 * `onAssistantText` reports reply **body** text only, with `{at, text, delta, turn, seq, step,
 * toolPending}`: a message whose blocks call a tool, or any message while a `tool/call` is still
 * waiting for its `tool/result`, is never reported. `delta` is the newly available text (`text`
 * is the full text), so a caller can split it into sentences.
 *
 * A stream is a strict `start -> chunk -> end` state machine, fed by both `session/event` and the
 * separate `agent/assistant-stream` channel. Frames are accepted only after the delivered
 * `user/message` bound the target turn; only whitelisted **body** types (`text-delta`,
 * `kind:"text"`, ...) append to the attempt buffer, and reasoning/thinking types are counted as
 * `reasoningFrames` and dropped. Buffered text is **never** spoken on arrival: the step's
 * committed `assistant/message` is the release point — a message with `tool-call` blocks
 * discards the buffer (pre-tool commentary), a body message hands the buffer (the committed text
 * wins on mismatch) to `onAssistantText` immediately, before `turn/end`. Cancellation drops every
 * unreleased buffer. Without stream frames the committed-message path is unchanged.
 *
 * `onProbe` receives one `{types, streaming, streamFrames, reasoningFrames, skippedUnbound,
 * attempts, commitMismatch, sample}` summary when the wait settles: every session event type this
 * delivery's turn produced (deduplicated), the stream counters, and the desensitized shapes of
 * the first three real frames (field names + types, never text). `onCommitMismatch` receives one
 * note per step whose buffered text differed from its commit. Both only record.
 *
 * `onTimeline` receives one `{at, sessionId, turn, bound, observations}` snapshot when the wait
 * settles: the round's `turn/start`, `step/start`, `assistant/message`, `tool/call`,
 * `tool/result`, `turn/end` and `assistant/attempt` boundaries reduced to desensitized
 * observations (times, turn/step numbers, call ids, tool names, short status tokens — never text,
 * tool arguments, tool output or an error message). A boundary that arrives before the delivery's
 * `user/message` binds the turn is buffered per turn and flushed when that turn binds, so a
 * pre-bind `turn/start` is not lost. This only records; `pendingTools`, the stream state machine
 * and every binding rule are untouched.
 *
 * The result also carries `speechText` **only when body-eligible text differs from `text`**
 * (e.g. a turn whose only text was pre-tool commentary): callers must use it, not `text`, for a
 * whole-reply fallback, and treat `''` as "subtitle only, do not play".
 */
export function awaitSessionResult({
  ctx,
  sessionId,
  timeoutMs = 180_000,
  baselineSeq,
  deliveryMessageId,
  signal,
  onAck,
  onAssistantText,
  onCommitMismatch,
  onProbe,
  onTimeline,
} = {}) {
  const hasSession = typeof sessionId === 'string' && sessionId.length > 0;
  const identityMode = typeof deliveryMessageId === 'string' && deliveryMessageId.length > 0;
  if (hasSession && activeSessionListeners.has(sessionId)) {
    const busy = Promise.resolve({ ok: false, text: '', error: 'session-listener-busy', status: 'busy' });
    busy.cancel = () => {};
    busy.busy = true;
    return busy;
  }
  const listenerToken = Symbol('session-listener');
  if (hasSession) activeSessionListeners.set(sessionId, listenerToken);

  const startedAt = Date.now();
  /** Report a timing observation without letting a caller's callback break the wait. */
  const notify = (callback, info) => {
    if (typeof callback !== 'function') return;
    try {
      callback(info);
    } catch {
      /* observability is additive */
    }
  };
  const baseSeq = Number.isSafeInteger(baselineSeq) ? baselineSeq : sessionBaselineSeq(ctx, sessionId);
  let last = '';
  let lastBodyText = '';
  let lastBodyStep = null;
  /** True once any frame reached the stream state machine for this delivery (probe only). */
  let streamActive = false;
  const probeTypes = new Set();
  let pendingTools = 0;
  let targetTurn = null;
  let currentTurn = null;
  let turnStarted = false;
  let settled = false;
  let off;
  let offStream = null;
  /** Frames the independent channel delivered for *this* session (probe only). */
  let streamFrames = 0;
  /** Non-body text frames rejected by the whitelist (reasoning/thinking/analysis). */
  let reasoningFrames = 0;
  /** Frames dropped because the delivery's user message was not bound yet (or another lane). */
  let skippedUnbound = 0;
  /** Attempts opened by a `start` frame (probe only). */
  let attempts = 0;
  /** Steps whose buffered stream text differed from the committed message (probe/log only). */
  let commitMismatch = 0;
  /** Desensitized shapes of the first real frames, for `voice.stream.sample`. */
  const sampleShapes = [];
  /**
   * Strict stream state: `start` opens one attempt, body deltas append to its buffer, `end`
   * closes the receive side. A closed attempt stays buffered until its `assistant/message`
   * commits, which is the only point speech is released (or the buffer discarded).
   */
  let activeAttempt = null;
  const pendingAttempts = new Map();
  /**
   * P-46 turn timeline (observation only). `timelineNote` reduces each session event to a small,
   * desensitized observation; nothing here reads or changes `pendingTools`, the stream buffers or
   * the binding rules. A `turn/start` / `step/start` that arrives before the delivery's
   * `user/message` bound the turn is kept in a bounded per-turn pre-bind buffer and flushed when
   * that turn binds.
   */
  const timelineMode = typeof onTimeline === 'function';
  const TIMELINE_PREBIND_TURNS = 2;
  const TIMELINE_OBSERVATIONS_CAP = 512;
  const timelineSeen = [];
  const timelinePreBind = new Map();
  const timelineNote = (event) => {
    if (!timelineMode || timelineSeen.length >= TIMELINE_OBSERVATIONS_CAP) return;
    const observation = timelineObservation(event, Date.now());
    if (observation === null) return;
    if (turnStarted && (targetTurn === null || observation.turn === null || observation.turn === targetTurn)) {
      timelineSeen.push(observation);
      return;
    }
    const key = observation.turn === null ? '' : String(observation.turn);
    if (!timelinePreBind.has(key)) {
      timelinePreBind.set(key, []);
      // Only the last two turns are worth keeping: an older replay turn can never be this delivery.
      while (timelinePreBind.size > TIMELINE_PREBIND_TURNS) {
        timelinePreBind.delete(timelinePreBind.keys().next().value);
      }
    }
    const bucket = timelinePreBind.get(key);
    if (bucket.length < TIMELINE_OBSERVATIONS_CAP) bucket.push(observation);
  };
  /** Flush the pre-bind buffer of the turn that just bound (the bound turn's own boundaries). */
  const timelineTakeBound = (turn) => {
    if (!timelineMode) return;
    const key = turn === null || turn === undefined ? '' : String(turn);
    const keys = key === '' ? [''] : [key, ''];
    for (const name of keys) {
      const bucket = timelinePreBind.get(name);
      if (bucket === undefined) continue;
      timelinePreBind.delete(name);
      timelineSeen.push(...bucket);
    }
  };
  /** Ordered observations for the settled round; unbound leftovers are kept only when nothing bound. */
  const timelineSnapshot = () => {
    if (!timelineMode) return null;
    const rows = timelineSeen.slice();
    if (!turnStarted) {
      for (const bucket of timelinePreBind.values()) rows.push(...bucket);
    }
    timelinePreBind.clear();
    return rows.sort((a, b) => a.at - b.at);
  };
  let timer;
  let abortListener;
  let resolveOnce = () => {};

  const finish = (value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    // A cancelled/aborted wait never replays a buffer the commit never released.
    activeAttempt = null;
    pendingAttempts.clear();
    try {
      off?.();
    } catch {
      /* listener already removed */
    }
    try {
      offStream?.();
    } catch {
      /* channel listener already removed */
    }
    if (abortListener !== undefined) {
      try {
        signal.removeEventListener?.('abort', abortListener);
      } catch {
        /* signal already gone */
      }
    }
    if (hasSession && activeSessionListeners.get(sessionId) === listenerToken) {
      activeSessionListeners.delete(sessionId);
    }
    // Runtime probe: enough to confirm the installed event name after a restart, and no more.
    notify(onProbe, {
      at: Date.now(),
      sessionId,
      types: [...probeTypes],
      streaming: streamActive,
      turn: targetTurn ?? currentTurn,
      // Gap B probe: `types` only covers the session log, so the independent channel reports its
      // own hit count here; `streamFrames > 0` proves the frames really arrived.
      channels: [{ channel: STREAM_CHANNEL, streamFrames }],
      streamFrames,
      reasoningFrames,
      skippedUnbound,
      attempts,
      commitMismatch,
      // First real frame shapes (field names + types, never text) for `voice.stream.sample`.
      sample: sampleShapes.slice(0, 3),
    });
    // P-46: the round's raw, desensitized boundaries for `voice.turn.timeline`. The host builds
    // the payload (it owns the anchors/status); this callback only hands the observations over.
    notify(onTimeline, {
      at: Date.now(),
      sessionId,
      turn: targetTurn ?? currentTurn,
      bound: turnStarted,
      observations: timelineSnapshot(),
    });
    // Gap 4: only body-eligible text may feed a whole-reply fallback. `speechText` is present
    // only when it differs from `text`, so every existing result shape stays unchanged.
    const resolved = lastBodyText !== (value.text ?? '') ? { ...value, speechText: lastBodyText } : value;
    resolveOnce(resolved);
  };

  /** True when the event was produced after listening started (not replayed history). */
  const afterDelivery = (event) => {
    if (Number.isSafeInteger(event.seq) && baseSeq !== null) return event.seq >= baseSeq;
    if (Number.isFinite(event.time)) return event.time >= startedAt;
    return baseSeq === null;
  };

  /** Stable key of one attempt: its attemptId when present, else its turn/step. */
  const attemptKey = (turn, step, attemptId) => (
    attemptId !== null ? `id:${attemptId}` : `step:${turn ?? ''}:${step ?? ''}`
  );

  /** The buffered attempt a committed step belongs to, or null when none/ambiguous. */
  const findPendingAttempt = (step, turn) => {
    let found = null;
    for (const attempt of pendingAttempts.values()) {
      if (turn !== null && attempt.turn !== null && attempt.turn !== turn) continue;
      if (step !== null && attempt.step !== null && attempt.step !== step) continue;
      // Two candidate steps (a commit without a step) are ambiguous: leave it to the commit path.
      if (found !== null) return null;
      found = attempt;
    }
    return found;
  };

  /**
   * Apply one frame of the strict `start -> chunk -> end` stream. Frames are only accepted for the
   * delivery's own session and only after its user message bound the target turn; text is a
   * delta appended to the attempt buffer and is **never** spoken here.
   */
  const handleStreamFrame = (frame, { channel = false } = {}) => {
    if (settled || frame === null || typeof frame !== 'object') return;
    if (channel) streamFrames += 1;
    if (sampleShapes.length < 3) sampleShapes.push(frameShape(frame));
    const types = frameTypes(frame);
    const frameTurn = frame.turn ?? frame.turnId ?? frame.data?.turn ?? frame.data?.turnId ?? null;
    // Binding gate: no text of a previous round may enter this delivery before its own user
    // message is committed, and frames addressed to another turn are dropped as well.
    const bound = identityMode ? targetTurn !== null : turnStarted && targetTurn !== null;
    if (!bound) {
      skippedUnbound += 1;
      return;
    }
    if (frameTurn !== null && targetTurn !== null && frameTurn !== targetTurn) {
      skippedUnbound += 1;
      return;
    }
    if (types.some((type) => FRAME_START_TYPES.has(type))) {
      const attemptId = frameAttemptId(frame);
      const step = intOrNull(frame.step) ?? intOrNull(frame.data?.step);
      const startTurn = frameTurn ?? targetTurn;
      const key = attemptKey(startTurn, step, attemptId);
      const existing = pendingAttempts.get(key);
      // A repeated start for the attempt that is still streaming must not wipe its buffer.
      if (existing !== undefined && activeAttempt === existing) return;
      const attempt = {
        key,
        attemptId,
        turn: startTurn,
        step,
        text: '',
        revision: intOrNull(frame.revision) ?? intOrNull(frame.data?.revision),
        lastIndex: null,
      };
      pendingAttempts.set(key, attempt);
      activeAttempt = attempt;
      attempts += 1;
      streamActive = true;
      return;
    }
    if (types.some((type) => FRAME_END_TYPES.has(type))) {
      const attemptId = frameAttemptId(frame);
      const step = intOrNull(frame.step) ?? intOrNull(frame.data?.step);
      const keyed = pendingAttempts.get(attemptKey(frameTurn ?? targetTurn, step, attemptId)) ?? null;
      let ending = keyed;
      if (ending === null && activeAttempt !== null
          && (attemptId === null || activeAttempt.attemptId === null || activeAttempt.attemptId === attemptId)) {
        ending = activeAttempt;
      }
      if (ending !== null) {
        // An abandoned/cancelled/failed end is final for this attempt: drop its buffer now, so a
        // later empty commit cannot resurrect it as the answer.
        if (frameEndFailed(frame)) pendingAttempts.delete(ending.key);
        if (activeAttempt === ending) activeAttempt = null;
      }
      return;
    }
    // Reasoning/thinking frames carry text too; the whitelist below is what keeps them out.
    if (types.some((type) => REASONING_FRAME_TYPE.test(type))) {
      reasoningFrames += 1;
      return;
    }
    if (!types.some((type) => BODY_FRAME_TYPES.has(type))) return;
    const text = frameDeltaText(frame);
    if (text.length === 0) return;
    const attempt = activeAttempt;
    if (attempt === null) {
      // A delta outside any open attempt cannot be attributed to a step.
      skippedUnbound += 1;
      return;
    }
    const attemptId = frameAttemptId(frame);
    if (attemptId !== null && attempt.attemptId !== null && attemptId !== attempt.attemptId) return;
    // Protocol delta: append. `revision`/`index` only suppress duplicates and drops in order.
    const revision = intOrNull(frame.revision) ?? intOrNull(frame.data?.revision);
    const index = intOrNull(frame.index) ?? intOrNull(frame.data?.index) ?? intOrNull(frame.seq);
    if (revision !== null && attempt.revision !== null) {
      if (revision < attempt.revision) return;
      if (revision > attempt.revision) {
        attempt.revision = revision;
        attempt.lastIndex = null;
      }
    }
    if (index !== null) {
      if (attempt.lastIndex !== null && index <= attempt.lastIndex) return;
      attempt.lastIndex = index;
    }
    attempt.text += text;
    streamActive = true;
  };

  /**
   * Release or discard the buffer of the step whose `assistant/message` just committed.
   * Returns true when this commit was handled here (the generic commit path must not repeat it).
   */
  const settleAttempt = (event, { text, step, turn }) => {
    const attempt = findPendingAttempt(step, turn);
    if (attempt === null) return false;
    pendingAttempts.delete(attempt.key);
    if (activeAttempt === attempt) activeAttempt = null;
    // The tool call is only visible in the committed message, not in the streamed text: a step
    // that calls a tool is pre-tool commentary and its whole buffer is discarded, never spoken.
    if (hasToolCallBlocks(event) || event?.data?.interrupted === true) return true;
    // Only committed body text may become the reply. An empty commit stays empty: the stream
    // buffer is an uncommitted candidate, so it must never be promoted into a spoken answer.
    const spoken = text;
    if (text.length > 0 && attempt.text.length > 0 && text !== attempt.text) {
      commitMismatch += 1;
      notify(onCommitMismatch, {
        at: Date.now(),
        sessionId,
        step,
        turn,
        streamChars: attempt.text.length,
        commitChars: text.length,
      });
    }
    if (spoken.length > 0) {
      lastBodyText = spoken;
      lastBodyStep = step;
      notify(onAssistantText, {
        at: Date.now(),
        text: spoken,
        delta: spoken,
        turn: turn ?? targetTurn,
        seq: event.seq ?? null,
        step,
        toolPending: pendingTools,
        streaming: true,
      });
    }
    return true;
  };

  const promise = new Promise((resolve) => {
    resolveOnce = resolve;
  });
  promise.cancel = () => finish({ ok: false, text: last, error: 'cancelled', status: 'cancelled' });

  if (signal?.aborted === true) {
    finish({ ok: false, text: '', error: 'cancelled', status: 'cancelled' });
    return promise;
  }
  if (signal !== undefined && signal !== null) {
    abortListener = () => finish({ ok: false, text: last, error: 'cancelled', status: 'cancelled' });
    signal.addEventListener?.('abort', abortListener, { once: true });
  }

  timer = setTimeout(() => finish({ ok: false, text: last, error: 'timeout', status: 'timeout' }), timeoutMs);
  // The installed bundle publishes assistant frames on its own channel instead of the session
  // log: it pushes `{agent, frame}`. Only frames addressed to this session enter the state
  // machine, so one wait can never speak another session's words.
  try {
    if (typeof ctx.on === 'function') {
      offStream = ctx.on(STREAM_CHANNEL, (agentOrFrame, maybeFrame) => {
        if (settled) return;
        const { agent, frame } = streamParts(agentOrFrame, maybeFrame);
        if (frame === null || streamFrameSessionId(agent, frame) !== sessionId) return;
        handleStreamFrame(frame, { channel: true });
      });
    }
  } catch {
    offStream = null;
  }
  try {
    off = ctx.on('session/event', (session, event) => {
      if (session?.id !== sessionId || !event || !afterDelivery(event)) return;
      // Observation only: every boundary of this delivery's round is recorded for the timeline.
      timelineNote(event);
      const turn = eventTurnId(event);
      if (event.type === 'turn/start') {
        currentTurn = turn;
        // Probe only: a turn start observed before binding belongs to this delivery's turn in
        // the identity lane (an earlier replay turn start shares the same type name anyway).
        if (targetTurn === null) probeTypes.add('turn/start');
        if (identityMode || targetTurn !== null) return;
        // Legacy binding: no delivery id exists, so the first turn after the baseline is this
        // delivery's answer. Nothing else is sent into a session before its request.
        targetTurn = turn;
        turnStarted = true;
        timelineTakeBound(turn);
        last = '';
        lastBodyText = '';
        lastBodyStep = null;
        notify(onAck, { at: Date.now(), turn, seq: event.seq ?? null, boundBy: 'turn/start' });
        return;
      }
      if (event.type === 'user/message') {
        if (!identityMode) return;
        // Bind by message identity: any other user message (a resume replay, another lane) has a
        // different id, so its assistant text and turn/end are never accepted here.
        if (userMessageId(event) !== deliveryMessageId) return;
        const ownerTurn = currentTurn !== null ? currentTurn : turn;
        if (ownerTurn === null || targetTurn !== null) return;
        targetTurn = ownerTurn;
        turnStarted = true;
        timelineTakeBound(ownerTurn);
        last = '';
        lastBodyText = '';
        lastBodyStep = null;
        probeTypes.add('user/message');
        notify(onAck, { at: Date.now(), turn: ownerTurn, seq: event.seq ?? null, boundBy: 'user/message' });
        return;
      }
      // Probe only: every type this delivery's turn produced is recorded (deduplicated) and
      // reported at finish. Recording changes no behavior.
      if (turnStarted && (turn === null || targetTurn === null || turn === targetTurn)
          && typeof event.type === 'string' && event.type.length > 0) {
        probeTypes.add(event.type);
      }
      // Strict stream: a session-log stream event is normalized into the same frame shape and
      // runs through the same start -> chunk -> end state machine as the channel.
      if (event.type === STREAM_EVENT_TYPE) {
        if (!turnStarted) return;
        if (turn !== null && targetTurn !== null && turn !== targetTurn) return;
        handleStreamFrame({ ...(event?.data ?? {}), turn: event?.data?.turn ?? turn, seq: event?.data?.seq ?? event.seq });
        return;
      }
      // First-sentence gate: a tool call is outstanding until its result arrives. Body text that
      // arrives after it belongs to the model's post-tool step, never to the call itself.
      if (event.type === 'tool/call') {
        if (!turnStarted) return;
        if (turn !== null && targetTurn !== null && turn !== targetTurn) return;
        pendingTools += 1;
        return;
      }
      if (event.type === 'tool/result') {
        if (!turnStarted) return;
        if (turn !== null && targetTurn !== null && turn !== targetTurn) return;
        pendingTools = Math.max(0, pendingTools - 1);
        return;
      }
      if (event.type === 'assistant/message') {
        if (!turnStarted) return;
        if (turn !== null && targetTurn !== null && turn !== targetTurn) return;
        const text = assistantText(event);
        const step = intOrNull(event?.data?.step);
        if (text.length > 0) last = text;
        // Release point: the step is committed now, so a non-tool step's buffered stream text is
        // handed to sentence playback immediately (still before `turn/end`); a tool step's buffer
        // is discarded. Nothing is ever spoken before this commit.
        if (settleAttempt(event, { text, step, turn })) return;
        if (text.length > 0) {
          // Only reply body starts playback. A step that calls a tool is pre-tool commentary, a
          // pending call has no answer yet, and an interrupted message is a cancelled partial.
          const body = !hasToolCallBlocks(event) && pendingTools === 0 && event?.data?.interrupted !== true;
          if (body) {
            const sameStep = step !== null && step === lastBodyStep;
            const cumulative = sameStep && text.startsWith(lastBodyText);
            const delta = cumulative ? text.slice(lastBodyText.length) : text;
            lastBodyStep = step;
            lastBodyText = text;
            if (delta.length > 0) {
              notify(onAssistantText, {
                at: Date.now(),
                text,
                delta,
                turn: turn ?? targetTurn,
                seq: event.seq ?? null,
                step,
                toolPending: pendingTools,
              });
            }
          }
        }
        return;
      }
      if (event.type !== 'turn/end') return;
      // A turn that never became the delivery's turn (replay, another lane) is ignored.
      if (!turnStarted) return;
      if (turn !== null && targetTurn !== null && turn !== targetTurn) return;
      if (last.length > 0 || identityMode) {
        finish(turnResult(turnEndStatus(event?.data?.reason), last));
        return;
      }
      // Legacy mode: this turn produced no assistant text, so the next turn may be the delivery.
      targetTurn = null;
      turnStarted = false;
      activeAttempt = null;
      pendingAttempts.clear();
    });
  } catch {
    finish({ ok: false, text: '', error: 'unavailable', status: 'unavailable' });
  }
  return promise;
}

// ---- session_search budget -----------------------------------------------

/**
 * One `session_search` is produced by the Harness, but a run that outlives its budget must not
 * look like an ordinary empty answer. These helpers are the plugin-side boundary: they enforce
 * the budget, keep every row found so far, and attach an explicit reason + notice. They never
 * invent rows and never change the order of the rows the search returned.
 */

/** Default wall-clock budget for one `session_search` run (PLAN P-112: 8 s, configurable). */
export const SESSION_SEARCH_BUDGET_MS = 8_000;

/** Marker resolved by the budget timer, so a timeout is distinguishable from a real result. */
const SESSION_SEARCH_TIMEOUT = Symbol('session-search-timeout');

/** The budget: explicit option, then plugin config, then the 8 s default; non-positive values are ignored. */
export function sessionSearchBudgetMs({ budgetMs, config = null } = {}) {
  for (const value of [budgetMs, config?.sessionSearchBudgetMs, config?.sessionSearch?.budgetMs]) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return Math.round(n);
  }
  return SESSION_SEARCH_BUDGET_MS;
}

/**
 * Degraded result of a search that ran out of budget: the rows already scanned, plus the reason,
 * the measured time and `truncated`. `partial:true` is always present, so a caller can never
 * mistake it for a complete empty result.
 */
export function sessionSearchTimeoutResult({
  elapsedMs = 0,
  scanned = 0,
  hits = [],
  budgetMs = SESSION_SEARCH_BUDGET_MS,
} = {}) {
  const ms = Math.max(0, Math.round(Number(elapsedMs) || 0));
  const label = budgetMs >= 1_000 ? `${Math.round(budgetMs / 100) / 10} 秒` : `${budgetMs} 毫秒`;
  return {
    ok: true,
    partial: true,
    reason: 'timeout',
    elapsedMs: ms,
    scanned: Math.max(0, Math.round(Number(scanned) || 0)),
    truncated: true,
    budgetMs,
    hits: Array.isArray(hits) ? hits : [],
    notice: `检索超过 ${label}预算，只返回已扫描到的部分结果；未扫描的会话未纳入，不能据此判断没有记录。`,
  };
}

/** A range bound as a local date: a date-only string is local midnight, never UTC midnight. */
function rangeBound(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value === 'number') return Number.isFinite(value) ? new Date(value) : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const day = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(text);
  if (day !== null) return new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
  const parsed = new Date(text);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

/**
 * True when the queried range covers only the local day of `now`, so "no hit" says nothing about
 * earlier days. A `to` equal to the next local midnight is accepted as an exclusive end of today.
 */
export function isTodayOnlyRange(range, now = new Date()) {
  const from = rangeBound(range?.from);
  const to = rangeBound(range?.to);
  if (from === null || to === null || from.getTime() > to.getTime()) return false;
  const base = new Date(now);
  const start = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  const end = new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1);
  return from.getTime() >= start.getTime() && to.getTime() <= end.getTime();
}

/** Explicit coverage hint for a today-only query that found nothing. */
export function emptyScopeNotice({ suggestEarliest = '' } = {}) {
  const earliest = typeof suggestEarliest === 'string' ? suggestEarliest.trim() : '';
  const tail = earliest.length > 0
    ? `该会话最早的记录时间：${earliest}；把时间范围放宽到该日期即可重查。`
    : '无法确认该会话最早的记录时间，可放宽到更早的日期重查。';
  return `今天没有记录；更早的记录未纳入本次查询。${tail}`;
}

/** `suggestEarliest` as a printable local stamp: a string/number/Date, or an object carrying one. */
function earliestStamp(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : '';
  if (typeof value === 'number') return Number.isFinite(value) ? new Date(value).toISOString() : '';
  if (typeof value === 'string') return value.trim();
  if (value !== null && typeof value === 'object') {
    return earliestStamp(value.at ?? value.time ?? value.timestamp ?? value.earliest);
  }
  return '';
}

/**
 * Run one `session_search` under a wall-clock budget.
 *
 * `search({deadline, onProgress})` is the underlying run (typically the Harness tool call). It may
 * report `{scanned, hits}` through `onProgress` while it scans; the latest report is what a timeout
 * keeps as the partial result. Within budget the run's own `{hits, scanned, earliest}` is returned
 * untouched (same array, same order), so a normal query's ranking and hit semantics do not change.
 *
 * A timeout returns `sessionSearchTimeoutResult(...)` (ok, partial, reason:'timeout', elapsedMs,
 * scanned, truncated) and emits `session_search.timeout {elapsedMs, scanned, scope}` when the
 * caller supplied a `scope`. A today-only range with zero hits returns the same rows plus
 * `emptyScope`, `suggestEarliest` and a notice saying today has no records and earlier days were
 * not queried, and emits `session_search.empty-scope {range, scope}`. Both events are best-effort
 * and fire-and-forget: a log that hangs, throws or rejects never delays or fails the search.
 *
 * Every result also carries `queried:true`, a `reason` (`hit` / `empty` / `timeout`) and an
 * `evidenceType` (`history` / `current-state` / `none`, see `queryEvidenceType`), so an empty run is
 * never confused with a run that returned only present-tense rows.
 */
export async function runSessionSearch({
  search,
  range = {},
  query = '',
  budgetMs,
  config = null,
  log = null,
  clock = Date.now,
  scope = null,
} = {}) {
  if (typeof search !== 'function') throw new TypeError('runSessionSearch: search must be a function');
  const budget = sessionSearchBudgetMs({ budgetMs, config });
  const startedAt = clock();
  let scanned = 0;
  let hits = [];
  const onProgress = (progress) => {
    if (Number.isSafeInteger(progress?.scanned) && progress.scanned >= 0) scanned = progress.scanned;
    if (Array.isArray(progress?.hits)) hits = progress.hits;
  };
  /** Degradation events name their scope only when the caller has one (the wrapper always does). */
  const withScope = (payload) => (scope === null ? payload : { ...payload, scope });
  // Diagnostics never sit on the return path: emit is fire-and-forget, so a log that hangs, throws,
  // or rejects can neither delay the timeout/degradation result nor fail the search.
  const emit = (type, payload) => {
    try {
      const pending = log?.emit?.(type, payload);
      if (pending && typeof pending.then === 'function') pending.then(undefined, () => {});
    } catch {
      /* observability only */
    }
  };
  // Both outcomes are folded into one object here, so a rejection that arrives after the timer
  // fired is still handled instead of becoming an unhandled rejection.
  const guarded = Promise.resolve()
    .then(() => search({ deadline: startedAt + budget, onProgress }))
    .then((value) => ({ value }), (error) => ({ error }));
  let timer;
  const expiry = new Promise((resolve) => {
    timer = setTimeout(() => resolve(SESSION_SEARCH_TIMEOUT), Math.max(0, budget - (clock() - startedAt)));
  });
  const outcome = await Promise.race([guarded, expiry]);
  clearTimeout(timer);
  const elapsedMs = Math.max(0, clock() - startedAt);
  if (outcome === SESSION_SEARCH_TIMEOUT) {
    const result = sessionSearchTimeoutResult({ elapsedMs, scanned, hits, budgetMs: budget });
    emit('session_search.timeout', withScope({ elapsedMs, scanned }));
    // `queried:true` says the query ran; `evidenceType:'none'` says a partial run proves nothing.
    return {
      ...result,
      queried: true,
      evidenceType: queryEvidenceType({ query, hits: result.hits }),
    };
  }
  if ('error' in outcome) throw outcome.error;
  const value = outcome.value ?? {};
  const found = Array.isArray(value.hits) ? value.hits : [];
  const result = {
    ok: true,
    queried: true,
    reason: found.length === 0 ? 'empty' : 'hit',
    evidenceType: queryEvidenceType({ query, hits: found }),
    hits: found,
    scanned: Number.isSafeInteger(value.scanned) ? value.scanned : scanned,
    elapsedMs,
  };
  if (found.length === 0 && isTodayOnlyRange(range, new Date(clock()))) {
    const suggestEarliest = earliestStamp(value.suggestEarliest ?? value.earliest);
    const emptyScope = {
      ...result,
      emptyScope: true,
      range,
      suggestEarliest,
      notice: emptyScopeNotice({ suggestEarliest }),
    };
    emit('session_search.empty-scope', withScope({ range }));
    return emptyScope;
  }
  return result;
}

/** The Harness tool this plugin wraps; the plugin never registers or shadows it. */
export const SESSION_SEARCH_TOOL_NAME = 'session_search';

/** The Harness tool's exact empty-result line; a changed wording only disables the hint. */
export const SESSION_SEARCH_EMPTY_TEXT = 'No prior session matches found.';

/** The `session_search` time filter as `runSessionSearch`'s `{from,to}` range; absent stays absent. */
export function sessionSearchArgsRange(args = null) {
  const pick = (eventKey, createdKey) => {
    for (const value of [args?.[eventKey], args?.[createdKey]]) {
      if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    }
    return undefined;
  };
  const from = pick('event_time_from', 'created_at_from');
  const to = pick('event_time_to', 'created_at_to');
  return { ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) };
}

/** Model-facing text for a timed-out run: an explicit `partial` marker plus the budget notice. */
export function sessionSearchTimeoutText({
  elapsedMs = 0,
  scanned = 0,
  budgetMs = SESSION_SEARCH_BUDGET_MS,
  notice = '',
} = {}) {
  const ms = Math.max(0, Math.round(Number(elapsedMs) || 0));
  const count = Math.max(0, Math.round(Number(scanned) || 0));
  const budget = Math.max(0, Math.round(Number(budgetMs) || 0));
  const head = `session_search partial: true (reason=timeout, elapsedMs=${ms}, scanned=${count}, budgetMs=${budget})`;
  const tail = typeof notice === 'string' ? notice.trim() : '';
  return tail.length > 0 ? `${head}\n${tail}` : head;
}

// ---- session_search semantics: queried vs empty, and current state vs history (P-127) ----------

/** The `query` text of a `session_search` call; missing or blank stays a blank string. */
export function sessionSearchArgsQuery(args = null) {
  const value = args?.query;
  return typeof value === 'string' ? value.trim() : '';
}

/** Present-tense questions ask about now; their rows cannot stand as proof of the past. */
const CURRENT_STATE_QUERY = /(?:现在|当前|此刻|目前|眼下|正在|在做什么|在干什么|在忙什么|在干嘛|状态如何|right now|currently|at the moment)/iu;

/** An explicit past reference wins: "上周我在做什么" asks for history, not for the present. */
const PAST_QUERY = /(?:昨天|前天|上周|上个月|去年|上次|以前|之前|过去|那时|当时|那天|那会儿|早些时候|last (?:week|month|year|time)|yesterday|previously|ago)/iu;

/** A row that says what is true now rather than what happened in the past. */
function isCurrentStateRow(row) {
  if (row === null || typeof row !== 'object') return false;
  return row.currentState === true || row.evidenceType === 'current-state' || row.kind === 'current-state';
}

/**
 * How far a result may be used as evidence: `history` for past records, `current-state` when the
 * rows (or the question) only describe the present, `none` when nothing came back. A present-tense
 * question never turns into historical proof just because old rows mention the same words, and an
 * explicit past reference keeps its rows historical.
 */
export function queryEvidenceType({ query = '', hits = [] } = {}) {
  const rows = Array.isArray(hits) ? hits : [];
  if (rows.length === 0) return 'none';
  if (rows.every(isCurrentStateRow)) return 'current-state';
  const text = String(query ?? '');
  if (PAST_QUERY.test(text)) return 'history';
  return CURRENT_STATE_QUERY.test(text) ? 'current-state' : 'history';
}

/** A query as it appears inside a model-facing line; blank stays visible instead of vanishing. */
function queryLabel(query) {
  const text = typeof query === 'string' ? query.trim() : '';
  return text.length === 0 ? '（空）' : text;
}

/** The queried bounds as `from..to`, so the model can see which days the result covers. */
function rangeLabel(range) {
  const from = typeof range?.from === 'string' ? range.from.trim() : '';
  const to = typeof range?.to === 'string' ? range.to.trim() : '';
  if (from.length === 0 && to.length === 0) return '';
  return `${from.length === 0 ? '…' : from}..${to.length === 0 ? '…' : to}`;
}

/**
 * The model-facing semantics line for a call that must not read as an ordinary answer:
 * `queried=false` (a same-condition reuse, never a fresh query) or `evidenceType=current-state`
 * (the rows only describe now). A plain history hit gets no line, so its result stays by identity.
 * The head also names the condition (`query`, `range`) so a result is never detached from what
 * was actually asked.
 */
export function sessionSearchSemanticsText({
  queried = true,
  reason = 'hit',
  evidenceType = 'none',
  query = '',
  count = 1,
  range = null,
} = {}) {
  const fields = [`queried=${queried}`, `reason=${reason}`, `evidenceType=${evidenceType}`];
  if (count > 1) fields.push(`count=${count}`);
  const bounds = rangeLabel(range);
  if (bounds.length > 0) fields.push(`range=${bounds}`);
  const head = `session_search evidence: ${fields.join(', ')}`;
  if (queried === false) {
    return `${head}\n本轮已经用相同条件（query=${queryLabel(query)}）查过一次，这里直接复用上次结果、没有重复查询；复用不新增证据，也不能单独当作「没有记录」。`;
  }
  if (evidenceType === 'current-state') {
    return `${head}\n这些是「当前状态」的记录，只能说明现在，不能证明过去发生过什么；要判断「以前是否发生」，请用带时间范围的历史检索。`;
  }
  return head;
}

/** Same-condition reuse window used only when the session log cannot name the current turn. */
export const SESSION_SEARCH_DEDUP_MS = 60_000;

/** A query as a reuse key: case and whitespace folded, so a spacing-only repeat still matches. */
function queryKey(query) {
  return String(query ?? '').trim().replace(/\s+/gu, ' ').toLowerCase();
}

/** The range as a reuse key: a different range is a different condition, never a reuse. */
function rangeKey(range = {}) {
  return [range?.from ?? '', range?.to ?? ''].map((value) => String(value)).join('..');
}

/**
 * Same-turn, same-condition reuse for `session_search` (PLAN P-127): the model must not fire the
 * same shot twice within one turn, and a reused result is never reported as a fresh query.
 *
 * The turn comes from the session's own log when it is readable (`data.turn`), so a new turn
 * re-queries; without a turn the entry is reused only inside `windowMs`. `begin` reserves a slot
 * and returns its handle (carrying the monotonic `slot` generation); `complete` stores a repeat's
 * result only when that handle is still the current slot. A new turn, an expired window or a newer
 * in-flight request supersedes the old slot, so a late result is dropped and reported through
 * `onStale`, never written over the current cache. A call whose first run is still in flight is
 * not reused (there is no outcome yet), so parallel duplicates stay honest instead of sharing a
 * pending run.
 */
export function createSessionQueryLedger({
  clock = Date.now,
  windowMs = SESSION_SEARCH_DEDUP_MS,
  limit = 64,
  onStale = null,
} = {}) {
  const entries = new Map();
  /** Monotonic request generation: every non-reused `begin` opens a new slot. */
  let generation = 0;
  const prune = () => {
    while (entries.size > limit) {
      let oldestKey = null;
      let oldestAt = Infinity;
      for (const [key, entry] of entries) {
        if (entry.at < oldestAt) {
          oldestAt = entry.at;
          oldestKey = key;
        }
      }
      if (oldestKey === null) return;
      entries.delete(oldestKey);
    }
  };
  const reserve = (key, { turn, now, count, query }) => {
    generation += 1;
    entries.set(key, { slot: generation, turn, at: now, count, outcome: null, evidenceType: 'none', query });
    prune();
    return { reused: false, key, slot: generation, turn, count, query };
  };
  return {
    /** Reserve one call's slot; `reused:true` carries the stored outcome and its evidence type. */
    begin({ sessionId = '', query = '', range = {}, turn = null } = {}) {
      const key = JSON.stringify([sessionId, queryKey(query), rangeKey(range)]);
      const now = clock();
      const existing = entries.get(key);
      if (existing !== undefined) {
        const sameTurn = turn !== null && existing.turn !== null
          ? turn === existing.turn
          : now - existing.at <= windowMs;
        if (sameTurn && existing.outcome !== null) {
          existing.count += 1;
          return {
            reused: true,
            key,
            slot: existing.slot,
            turn,
            count: existing.count,
            outcome: existing.outcome,
            evidenceType: existing.evidenceType,
            query,
          };
        }
        if (sameTurn) {
          // Still running: keep the slot reserved, but never pretend this call reused a result.
          // The fresh in-flight request gets its own generation, so an older completion is stale.
          existing.count += 1;
          return reserve(key, { turn, now, count: existing.count, query });
        }
      }
      return reserve(key, { turn, now, count: 1, query });
    },
    /** Store what a repeat returns; only the current slot may write, a superseded one is dropped. */
    complete(shot, outcome, { evidenceType = 'none' } = {}) {
      if (shot?.reused === true || typeof shot?.key !== 'string') return false;
      const stored = entries.get(shot.key);
      if (stored !== undefined && stored.slot === shot.slot) {
        stored.outcome = outcome ?? null;
        stored.evidenceType = evidenceType;
        stored.at = clock();
        return true;
      }
      // The slot was superseded (new turn/window or a newer in-flight request): drop the late
      // result instead of overwriting the current cache, and report it once.
      try {
        onStale?.({
          query: shot.query ?? stored?.query ?? '',
          slot: shot.slot ?? null,
          current: stored?.slot ?? null,
        });
      } catch {
        /* observability only */
      }
      return false;
    },
  };
}

/**
 * The assistant workspace boundary, read the way `workspaceScope()` in index.js reads it: the
 * persisted `workspaceScope` from settings.json, else `<root>/workspace`; `enabled` defaults on.
 * `root` is resolved once by the caller; an empty value means ownership cannot be judged.
 */
function assistantScope(root) {
  let saved = {};
  try {
    const settings = JSON.parse(readFileSync(join(root, 'data', 'settings.json'), 'utf8'));
    saved = settings?.workspaceScope ?? {};
  } catch {
    saved = {}; // no settings yet: the host's default, scope on and `<root>/workspace`
  }
  const path = typeof saved?.path === 'string' && saved.path.trim().length > 0
    ? resolve(saved.path.trim())
    : join(root, 'workspace');
  return { enabled: saved?.enabled !== false, path };
}

/** Fuse the caller's signal with the wrapper's own, without requiring `AbortSignal.any`. */
function fuseAbortSignals(primary, secondary) {
  if (primary === undefined || typeof primary?.addEventListener !== 'function') return secondary;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([primary, secondary]);
  const fused = new AbortController();
  for (const signal of [primary, secondary]) {
    if (signal.aborted) {
      fused.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => fused.abort(signal.reason), { once: true });
  }
  return fused.signal;
}

/**
 * Wrap the Harness `session_search` call on the `tools/execute` around-dispatch waterfall.
 *
 * The wrapper is the production seam: the framework still owns the search body, ranking and hit
 * formatting, and a normal history result is returned by identity. Only a run that outlives the
 * budget is replaced by `sessionSearchTimeoutText`; the framework body is aborted at that point so
 * the timeout cannot leave it scanning in the background. A today-only empty result gains the
 * coverage notice and keeps both diagnostic events.
 *
 * Two semantics are added on top of that budget: a same-condition repeat inside one turn reuses
 * the earlier result instead of firing the same shot again (and says `queried=false`), and a
 * present-tense question is marked `current-state` so its rows can never pass as history.
 *
 * Only the assistant's own session is budgeted. A call whose session cwd is outside the workspace
 * scope (another workspace, a coding agent) reaches `next()` untouched: no budget, no dedup, no
 * signal rewrite, no event. When the cwd cannot be read at all the gate treats the call as out of
 * scope and records one debug line, so an unknown owner is never silently limited.
 */
export function createSessionSearchBudget({
  config = null,
  log = null,
  clock = Date.now,
  run = runSessionSearch,
  ledger = null,
} = {}) {
  // The same root apply() resolved; a failed resolution keeps the gate closed, never global.
  let root = '';
  try {
    root = resolveInstanceRoot(config);
  } catch {
    root = '';
  }
  /** Best-effort telemetry: a missing, throwing or rejecting log never blocks a search. */
  const emitEvent = (type, payload) => {
    try {
      const pending = log?.emit?.(type, payload);
      if (pending && typeof pending.then === 'function') pending.then(undefined, () => {});
    } catch {
      /* observability only */
    }
  };
  /** The reuse cache reports a superseded slot; a caller-supplied ledger wires its own telemetry. */
  const cacheLedger = ledger ?? createSessionQueryLedger({
    clock,
    onStale: (event) => emitEvent('session_search.cache.stale', event),
  });
  /** Debug-only: a non-`session_search.*` type, so an out-of-scope call stays event-free there. */
  const noteUnjudged = (reason) => emitEvent('dispatch.session-search.skip', { level: 'debug', reason });
  /** A value kept in the framework result's own shape: its extra contexts are carried along. */
  const withContexts = (value, original) => (
    original?.additionalContexts === undefined ? { value } : { value, additionalContexts: original.additionalContexts }
  );
  return async function sessionSearchBudget(exec, next) {
    if (exec?.name !== SESSION_SEARCH_TOOL_NAME) return next();
    // Ownership is the session's own cwd, the same rule voice/memory use for workspace scope.
    const cwd = sessionDirectory(exec?.agent?.session, null);
    if (root.length === 0 || cwd.length === 0) {
      noteUnjudged(root.length === 0 ? 'scope-unknown' : 'cwd-unknown');
      return next();
    }
    const scope = assistantScope(root);
    // A disabled scope is the host's "no boundary" rule (voice/memory behave the same), so only an
    // enabled scope can exclude a session; a mismatch is out of scope and must not be touched.
    if (scope.enabled && !sameDirectory(cwd, scope.path)) return next();
    const query = sessionSearchArgsQuery(exec.arguments);
    const range = sessionSearchArgsRange(exec.arguments);
    // Same condition in the same turn: reuse the earlier result instead of firing the same shot
    // again. Decided before the budget window, so a reuse never waits and never touches the signal.
    const shot = cacheLedger.begin({ sessionId: sessionIdOf(exec) || cwd, query, range, turn: sessionTurnOf(exec) });
    if (shot.reused) {
      emitEvent('session_search.dedup', { query, count: shot.count });
      const semantics = sessionSearchSemanticsText({
        queried: false,
        reason: 'reuse',
        evidenceType: shot.evidenceType,
        query,
        count: shot.count,
        range,
      });
      const cached = typeof shot.outcome?.value === 'string' ? shot.outcome.value : '';
      return withContexts(cached.length > 0 ? `${semantics}\n\n${cached}` : semantics, shot.outcome);
    }
    const upstream = exec.signal;
    const controller = new AbortController();
    exec.signal = fuseAbortSignals(upstream, controller.signal);
    // A timed-out body is aborted, but its `next()` promise is still in flight: restoring the
    // caller's signal is deferred to the body's quiescence (the `search` finally), never raced.
    let restoreNow = true;
    try {
      let original;
      const outcome = await run({
        config,
        log,
        clock,
        scope: 'assistant',
        query,
        range,
        search: async () => {
          try {
            original = await next();
            // The framework body returns formatted text, not rows. Use its exact empty sentinel to
            // decide the empty-scope hint; any other result counts as a hit, so a wording change can
            // only omit the hint and can never invent one.
            const text = original?.isError === false ? String(original.value ?? '') : '';
            const empty = original?.isError === false && text.trim() === SESSION_SEARCH_EMPTY_TEXT;
            return { hits: empty ? [] : [text.length > 0 ? text : SESSION_SEARCH_TOOL_NAME], scanned: empty ? 0 : 1 };
          } finally {
            exec.signal = upstream;
          }
        },
      });
      const evidenceType = outcome.evidenceType ?? 'none';
      if (outcome.partial !== true) {
        if (outcome.emptyScope === true && original?.isError === false) {
          const annotated = withContexts(`${String(original.value ?? '')}\n\n${outcome.notice}`, original);
          cacheLedger.complete(shot, annotated, { evidenceType });
          return annotated;
        }
        // A present-tense hit is annotated: its rows describe now and cannot prove the past.
        if (evidenceType === 'current-state' && original?.isError === false) {
          const annotated = withContexts(
            `${String(original.value ?? '')}\n\n${sessionSearchSemanticsText({
              queried: true,
              reason: outcome.reason ?? 'hit',
              evidenceType,
              query,
              range,
            })}`,
            original,
          );
          cacheLedger.complete(shot, annotated, { evidenceType });
          return annotated;
        }
        cacheLedger.complete(shot, original, { evidenceType });
        return original;
      }
      restoreNow = false;
      controller.abort();
      const degraded = { value: sessionSearchTimeoutText(outcome) };
      cacheLedger.complete(shot, degraded, { evidenceType });
      return degraded;
    } finally {
      if (restoreNow) exec.signal = upstream;
    }
  };
}

