/**
 * P0: the compaction capability Seirein's own voice agent mounts for itself.
 *
 * The Web surface keeps every compaction row OFF the Host plane and lets each Session compose
 * them through an Agent preset (`dsh-web-app/cordis.patch.yml`, the `compaction-basic` /
 * `command-compact` / `tool-result-pruner` disables). A preset-free Session therefore has no
 * `agent/pre-step` compaction listener at all. This module binds Seirein's dated voice Session to
 * a compaction-ONLY preset, so it gains condensation and `/compact` without importing the
 * standard preset's coding persona, filesystem tools or permission choices.
 *
 * The declaration belongs to this module: `attach()` (or the first `ensure()`) registers it with
 * the Agent preset registry, so the capability travels with the plugin instead of living in the
 * user's profile patch. A profile that still declares the same id — the migration window — is
 * detected and reused, never registered a second time. `mount()` is the registry's own composition
 * API: it binds the Agent scope's parent to the retained preset revision, so the preset's scoped
 * listeners receive that Agent's events and its isolated `compaction` service is reachable through
 * `serviceFor`.
 *
 * Everything Harness-specific is reached through the Host context (`getService` + `ctx.on`); no
 * Harness package is imported, so a profile without the preset registry keeps working (the voice
 * agent simply stays uncompacted).
 */

/** Preset identity Seirein's voice agent runs. */
export const VOICE_COMPACTION_PRESET_ID = 'seirein-voice';

/**
 * The declaration this module registers. Exported so the recovery path and the tests use one
 * source of truth; it is identical to the declaration the profile used to carry, so reusing a
 * leftover profile entry is seamless.
 */
export const VOICE_COMPACTION_PRESET = Object.freeze({
  id: VOICE_COMPACTION_PRESET_ID,
  name: 'Seirein voice',
  description: 'Compaction only, for Seirein\u2019s own dated voice session.',
  order: 40,
  plugins: [
    {
      id: 'compaction',
      name: 'cordis:group',
      group: true,
      // `compaction` and `toolResultPruner` are preset services: without their own realm the
      // mount audit rejects them as leaked root-realm services.
      isolate: { compaction: true, toolResultPruner: true },
      config: [
        { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
        { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
        {
          id: 'tool-result-pruner',
          name: '@deepseek-ai/dsh-compaction-tool-result-pruner',
          config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 },
        },
      ],
    },
  ],
});

/** The only Session identities this module may touch: `seirein-YYYY-MM-DD`. */
const VOICE_SESSION_ID_RE = /^seirein-\d{4}-\d{2}-\d{2}$/u;
/** @param {unknown} id @returns {boolean} whether the Session id is Seirein's dated voice session. */
export function isVoiceSessionId(id) {
  return typeof id === 'string' && VOICE_SESSION_ID_RE.test(id);
}

/**
 * @param {{
 *   getService: (name: string) => any,
 *   log?: { emit?: (type: string, payload: object) => unknown } | null,
 *   presetId?: string,
 *   presetDefinition?: object,
 * }} options
 */
export function createVoiceCompaction({
  getService,
  log = null,
  presetId = VOICE_COMPACTION_PRESET_ID,
  presetDefinition = VOICE_COMPACTION_PRESET,
}) {
  /** Agents whose composition this instance already verified. */
  const mounted = new WeakSet();
  /** Concurrent ensure() calls for one Agent settle together. */
  const inFlight = new WeakMap();
  /** Verified evidence per Agent; never derived from the recorded marker. */
  const records = new WeakMap();
  /** Registration state of the preset itself (one per plugin instance). */
  let presetState = { status: 'idle', source: null, registered: false, error: null, at: 0 };
  /** In-flight registration; concurrent callers settle together. */
  let presetPending = null;
  /** Disposer returned by `agentPresets.register()`; owned only when this instance registered. */
  let presetUnregister = null;
  /** A detach in progress; a later attach waits for the previous definition to be gone. */
  let presetRelease = null;

  const note = (type, payload) => {
    try {
      const pending = log?.emit?.(type, payload);
      if (pending !== undefined && typeof pending?.catch === 'function') pending.catch(() => {});
    } catch {
      /* observability must never break agent creation */
    }
  };

  const describe = (error) => (error instanceof Error ? error.message : String(error));

  const skip = (agent, reason, extra = {}) => {
    note('voice.compaction.skipped', { sessionId: agent?.id ?? '', reason, ...extra });
    return { ok: false, reason, ...extra };
  };

  const failure = (agent, reason, error, extra = {}) => {
    note('voice.compaction.failed', { sessionId: agent?.id ?? '', reason, error: describe(error), ...extra });
    return { ok: false, reason, error: describe(error), ...extra };
  };

  /**
   * Provenance of an existing declaration. The plugin's own registration never reaches this path
   * (it is recorded before the next read). A leftover declaration is the migration case — it came
   * from the profile patch, or from a bundle that declared the same id — so "profile" is the honest
   * default; only an explicit marker upgrades it to "builtin".
   */
  const sourceOf = (record) => {
    if (typeof record?.source === 'string' && record.source.length > 0) return record.source;
    if (record?.builtin === true) return 'builtin';
    return 'profile';
  };

  /** Read a declaration without the registry's loader-settling diagnostic (safe during activation). */
  const readExisting = async (presets) => {
    const declarations = presets?.definitions;
    if (declarations instanceof Map) return declarations.get(presetId);
    if (typeof presets?.has === 'function') {
      try {
        return presets.has(presetId) ? { config: { id: presetId } } : undefined;
      } catch {
        return undefined;
      }
    }
    // Other registry builds answer only metadata; that is still enough to avoid a duplicate.
    if (typeof presets?.list === 'function') {
      try {
        const rows = await presets.list();
        return Array.isArray(rows) ? rows.find((row) => row?.id === presetId) : undefined;
      } catch {
        return undefined;
      }
    }
    return undefined;
  };

  /**
   * Ensure the plugin-owned preset exists, at most once per instance.
   *
   * Existing (same id) → reuse and never call `register()`. Missing → `register(definition)`.
   * Failure → one `voice.compaction.preset.register-failed` event and a latched failed state;
   * callers fail open, so voice keeps running without compaction. `unavailable` is retried by the
   * next call because the registry service may simply not be mounted yet.
   */
  const ensurePreset = async (presetsArg) => {
    if (presetRelease !== null) await presetRelease.catch(() => {});
    if (presetState.status === 'registered' || presetState.status === 'reused' || presetState.status === 'failed') {
      return presetState;
    }
    if (presetPending !== null) return await presetPending;
    const presets = presetsArg ?? getService('agentPresets');
    if (presets === undefined || presets === null) {
      presetState = { status: 'unavailable', source: null, registered: false, error: null, at: Date.now() };
      return presetState;
    }

    const run = (async () => {
      const existing = await readExisting(presets);
      if (existing !== undefined) {
        presetState = { status: 'reused', source: sourceOf(existing), registered: false, error: null, at: Date.now() };
        note('voice.compaction.preset.reused', { presetId, source: presetState.source });
        return presetState;
      }
      if (typeof presets.register !== 'function') {
        presetState = {
          status: 'failed',
          source: null,
          registered: false,
          error: 'agentPresets.register() is unavailable',
          at: Date.now(),
        };
        note('voice.compaction.preset.register-failed', { presetId, error: presetState.error });
        return presetState;
      }
      try {
        const disposer = await presets.register(presetDefinition);
        presetUnregister = typeof disposer === 'function' ? disposer : null;
        presetState = { status: 'registered', source: 'registered', registered: true, error: null, at: Date.now() };
        note('voice.compaction.preset.registered', {
          presetId,
          source: 'registered',
          plugins: Array.isArray(presetDefinition?.plugins) ? presetDefinition.plugins.length : 0,
        });
      } catch (error) {
        // A declaration that appeared between the read and register() is a migration race, not a
        // failure: the existing declaration wins and this instance must not remove it.
        if (/duplicate agent preset/iu.test(describe(error))) {
          presetState = { status: 'reused', source: 'profile', registered: false, error: null, at: Date.now() };
          note('voice.compaction.preset.reused', { presetId, source: presetState.source, reason: 'duplicate' });
        } else {
          presetState = { status: 'failed', source: null, registered: false, error: describe(error), at: Date.now() };
          note('voice.compaction.preset.register-failed', { presetId, error: presetState.error });
        }
      }
      return presetState;
    })();

    presetPending = run;
    try {
      return await run;
    } finally {
      if (presetPending === run) presetPending = null;
    }
  };

  /** Read-only snapshot for `status` and tests; never includes the declaration itself. */
  const presetStatus = () => ({ presetId, ...presetState });

  /** Release only a registration this instance made; a reused declaration is never removed. */
  const releasePreset = () => {
    if (presetRelease !== null) return presetRelease;
    const pending = presetPending;
    const early = presetUnregister;
    presetUnregister = null;
    presetState = { status: 'idle', source: null, registered: false, error: null, at: 0 };
    if (pending === null && typeof early !== 'function') return null;
    const release = (async () => {
      if (pending !== null) await pending.catch(() => {});
      // A registration that settled while detach waited is still ours to remove.
      const disposer = early ?? presetUnregister;
      presetUnregister = null;
      if (typeof disposer === 'function') await disposer();
    })().catch(() => {});
    presetRelease = release;
    void release.finally(() => {
      if (presetRelease === release) presetRelease = null;
    });
    return release;
  };

  /**
   * Start the one eager registration. During Host startup a transitional profile row declaring the
   * same id may still be activating, so wait for the Loader tree to settle first: the existing
   * declaration then wins and is reused. A host without a readable Loader registers immediately;
   * either way the Agent path calls `ensurePreset()` before mounting.
   */
  const startRegistration = (presetsArg) => {
    const presets = presetsArg ?? getService('agentPresets');
    if (presets === undefined || presets === null) return;
    let settled = null;
    try {
      const loader = presets?.owner?.loader;
      settled = typeof loader?.await === 'function' ? loader.await() : null;
    } catch {
      settled = null;
    }
    if (settled !== null && typeof settled?.then === 'function') {
      void settled.then(() => (attached ? ensurePreset(presets) : undefined)).catch(() => {});
      return;
    }
    void ensurePreset(presets).catch(() => {});
  };

  /**
   * Record the composition on the Session. This is a MARKER (the preset projection), not the
   * success proof: `mount` + `composedPreset` + the realm's `compaction` service are the proof.
   */
  const recordMarker = (agent, presets) => {
    const session = agent?.session;
    if (session === undefined || session === null || typeof session.append !== 'function') return false;
    const recorded = typeof presets.presetForSession === 'function' ? presets.presetForSession(session) : undefined;
    if (recorded === presetId) return false;
    try {
      session.append('agent-preset/selected', { agentPreset: presetId });
      return true;
    } catch {
      return false;
    }
  };

  /**
   * Bind one voice Agent to the compaction preset, at most once per Agent.
   *
   * Success requires three independent facts, in this order:
   *  1. `agentPresets.mount(agentCtx, presetId)` resolved with that exact id;
   *  2. `composedPreset(agent.ctx)` reads the same id (the registry's own binding);
   *  3. `serviceFor(agent, 'compaction')` resolves inside the preset realm when the registry
   *     exposes that read (the preset's compaction engine actually exists for this Agent).
   * A Session marker is written only after those hold. Failures are contained: a missing preset
   * leaves the voice agent running uncompacted instead of failing the turn.
   *
   * @param {any} agent live Agent (only its `seirein-YYYY-MM-DD` session is eligible)
   * @param {any} [agentCtx] the Agent context supplied by the Agent setup callback
   */
  const ensure = async (agent, agentCtx) => {
    if (!isVoiceSessionId(agent?.id)) return { ok: false, reason: 'not-voice-session' };
    if (mounted.has(agent)) return records.get(agent);
    const pending = inFlight.get(agent);
    if (pending !== undefined) return await pending;

    const run = (async () => {
      const presets = getService('agentPresets');
      if (presets === undefined || typeof presets.mount !== 'function') {
        return skip(agent, 'preset-registry-unavailable');
      }
      // Self-registration is what makes compaction portable: a fresh machine has no profile
      // declaration, so the preset must exist before mount() is attempted. A failure here is
      // contained; the voice Agent still runs, just without condensation.
      const preset = await ensurePreset(presets);
      if (preset.status === 'failed' || preset.status === 'unavailable') {
        return skip(agent, preset.status === 'failed' ? 'preset-register-failed' : 'preset-registry-unavailable', {
          presetId,
          ...(typeof preset.error === 'string' && preset.error.length > 0 ? { error: preset.error } : {}),
        });
      }
      const ctx = agentCtx ?? agent?.ctx;
      if (ctx === undefined || ctx === null) return skip(agent, 'agent-context-unavailable');

      // Another composition already owns this Agent: never yank its preset out from under it.
      // A preset-free Agent (undefined) and our own id are both eligible.
      const composedBefore = typeof presets.composedPreset === 'function' ? presets.composedPreset(ctx) : undefined;
      if (typeof composedBefore === 'string' && composedBefore.length > 0 && composedBefore !== presetId) {
        return skip(agent, 'other-preset', { composed: composedBefore });
      }
      // A previous plugin instance (or another composition) may already have bound the same
      // revision. Verify it instead of mounting again: a second bind would be refused by the
      // registry anyway, but the voice agent must not depend on that refusal to stay
      // single-instance.
      if (composedBefore === presetId && typeof presets.serviceFor === 'function') {
        const existingService = presets.serviceFor(agent, 'compaction');
        if (existingService !== undefined) {
          const record = {
            ok: true,
            presetId,
            composed: presetId,
            service: true,
            reused: true,
            presetSource: preset.source,
            mountedAt: Date.now(),
          };
          mounted.add(agent);
          records.set(agent, record);
          note('voice.compaction.reused', { sessionId: agent.id, presetId, presetSource: preset.source });
          return record;
        }
      }

      let bound;
      try {
        bound = await presets.mount(ctx, presetId);
      } catch (error) {
        const code = typeof error?.code === 'string' ? error.code : '';
        if (code === 'agent-preset/not-found' || /unknown agent preset/iu.test(describe(error))) {
          return skip(agent, 'preset-missing', { presetId });
        }
        return failure(agent, 'mount', error, { presetId });
      }
      if (bound?.id !== presetId) {
        return failure(agent, 'identity', `mount returned ${String(bound?.id)}`, { presetId });
      }

      const composed = typeof presets.composedPreset === 'function' ? presets.composedPreset(ctx) : undefined;
      if (composed !== undefined && composed !== presetId) {
        return failure(agent, 'composition', `composedPreset=${String(composed)}`, { presetId });
      }
      // The registry can only answer serviceFor for a retained composition; when the read exists,
      // an absent compaction service means the preset did not really mount its backend.
      const compaction = typeof presets.serviceFor === 'function'
        ? presets.serviceFor(agent, 'compaction')
        : undefined;
      if (typeof presets.serviceFor === 'function' && compaction === undefined) {
        return failure(agent, 'service-missing', 'serviceFor(agent, "compaction") is undefined', { presetId });
      }

      const marked = recordMarker(agent, presets);
      const record = {
        ok: true,
        presetId,
        composed: composed ?? presetId,
        service: compaction !== undefined,
        marked,
        reused: false,
        presetSource: preset.source,
        mountedAt: Date.now(),
      };
      mounted.add(agent);
      records.set(agent, record);
      note('voice.compaction.mounted', {
        sessionId: agent.id,
        presetId,
        composed: record.composed,
        service: record.service,
        marked,
        presetSource: record.presetSource,
      });
      return record;
    })();

    inFlight.set(agent, run);
    try {
      return await run;
    } finally {
      if (inFlight.get(agent) === run) inFlight.delete(agent);
    }
  };

  /**
   * Install coverage for every Agent creation path.
   *
   * - new and resumed Agents: the loop awaits serial `agent/created` listeners before releasing
   *   input, so the preset is bound before the first step (including a resume whose creator does
   *   not compose it, e.g. `dispatch.js#ensureSession`);
   * - component reload / reconnection: Agents that were live before this instance mounted are
   *   swept once from `agents.list()`; a verified composition is reused, never mounted twice.
   *
   * @param {any} ctx Host context
   * @returns {() => void} detach (the Host fiber also disposes the registration)
   */
  let attached = false;
  /** Idempotent detach; also closes the preset registration this instance owns. */
  let detach = () => {};
  const attach = (ctx) => {
    if (ctx === undefined || ctx === null) return () => {};
    if (attached) return detach;
    attached = true;
    let off = null;
    if (typeof ctx.on === 'function') {
      off = ctx.on('agent/created', (payload) => {
        // Serial listener: awaiting keeps the binding before the first step; the ensure() result
        // is always fulfilled, so a missing preset can never fail Agent creation.
        return ensure(payload?.agent);
      });
    }
    // Register as soon as the plugin mounts; if the registry service is not ready yet, the next
    // voice Agent's ensure() retries (an unavailable state is deliberately not latched).
    startRegistration();
    detach = () => {
      if (!attached) return undefined;
      attached = false;
      if (typeof off === 'function') off();
      off = null;
      return releasePreset();
    };
    if (typeof ctx.effect === 'function') ctx.effect(() => detach);
    const agents = getService('agents');
    if (typeof agents?.list === 'function') {
      for (const agent of agents.list()) {
        void ensure(agent).catch(() => {});
      }
    }
    return detach;
  };

  /** Evidence recorded for an Agent (tests / status); `undefined` until verified. */
  const evidenceOf = (agent) => records.get(agent);

  /**
   * Setup callback for `agentLoop.createAgent`/`resume`: the Agent context comes first there.
   *
   * The shipped host awaits this and then runs `setupCommit?.commit()` (agent-loop's
   * `initializeAgent`); `AgentSetup` therefore returns either void or `{ commit() }`. Everything
   * this wiring does is already applied when `ensure` resolves, so there is nothing to commit and
   * the callback resolves void. A rejected setup would roll Agent creation back, so failures are
   * contained here: the voice Agent keeps running uncompacted instead of failing its own creation.
   */
  const setup = async (agentCtx, agent) => {
    try {
      await ensure(agent, agentCtx);
    } catch (error) {
      note('voice.compaction.failed', { sessionId: agent?.id ?? '', reason: 'setup', error: describe(error) });
    }
  };

  return { presetId, setup, ensure, attach, evidenceOf, ensurePreset, presetStatus, status: presetStatus };
}

/** The ONE action that may re-assemble an existing voice session by hand. */
export const VOICE_SESSION_RECOVER_ACTION = 'voice.session.recover';

/** Returned when the session still has a live Agent: only a DSH restart releases it. */
export const VOICE_SESSION_AGENT_OWNED_REASON = '需重启 DSH 释放 agent 后再恢复';

/**
 * Manual recovery of an EXISTING dated voice session: keep its id, resume it through
 * `agentLoop.resume(ownerCtx, { resumeSessionId, setup })` with the compaction preset mounted in
 * the setup callback, then compact once with the preset's own `compactNow()` before returning.
 *
 * This module never schedules, subscribes or otherwise triggers recovery: the caller is a single
 * explicit action (`voice.session.recover`). It opens no turn, writes no user message, creates no
 * new session and deletes no history; a resume failure is reported verbatim and never retried.
 *
 * @param {{
 *   getService: (name: string) => any,
 *   log?: { emit?: (type: string, payload: object) => unknown } | null,
 *   ownerCtx?: any,
 *   compaction?: {
 *     ensure: (agent: any, agentCtx?: any) => Promise<any>,
 *     ensurePreset?: (presets?: any) => Promise<any>,
 *   } | null,
 *   defaultSessionId?: (() => string) | null,
 *   presetId?: string,
 * }} options
 */
export function createVoiceSessionRecovery({
  getService,
  log = null,
  ownerCtx = null,
  compaction = null,
  defaultSessionId = null,
  presetId = VOICE_COMPACTION_PRESET_ID,
}) {
  const engine = compaction ?? createVoiceCompaction({ getService, log, presetId });
  const describe = (error) => (error instanceof Error ? error.message : String(error));

  /** One `voice.session.recover` debug line per attempt; observability never fails the action. */
  const note = (payload) => {
    try {
      const pending = log?.emit?.(VOICE_SESSION_RECOVER_ACTION, {
        sessionId: payload.sessionId ?? '',
        ok: payload.ok === true,
        mounted: payload.mounted === true,
        before: payload.before ?? null,
        after: payload.after ?? null,
        freed: payload.freed ?? null,
        // The machine code is the stable filter value; success falls back to its own note.
        reason: typeof payload.code === 'string' && payload.code.length > 0
          ? payload.code
          : (payload.reason ?? ''),
      });
      if (pending !== undefined && typeof pending?.catch === 'function') pending.catch(() => {});
    } catch {
      /* a log that throws must not hide the outcome */
    }
  };
  const done = (payload) => {
    note(payload);
    return payload;
  };
  /** Every refusal carries the same shape: nothing mounted, nothing compacted. */
  const fail = (payload) => done({
    ok: false,
    mounted: false,
    before: null,
    after: null,
    freed: null,
    compacted: false,
    ...payload,
  });

  /** The compaction engine of the Agent's own preset realm (undefined when unbound). */
  const serviceOf = (agent) => {
    const presets = getService('agentPresets');
    return typeof presets?.serviceFor === 'function' ? presets.serviceFor(agent, 'compaction') : undefined;
  };

  /** Estimated request tokens (token meter first, backend measure second), or null. */
  const measureTokens = (agent, service) => {
    const total = (value) => {
      const number = Number(value?.totalTokens ?? value);
      return Number.isFinite(number) ? number : null;
    };
    try {
      const meter = getService('tokenMeter');
      if (typeof meter?.measure === 'function') {
        const measured = total(meter.measure(agent.session));
        if (measured !== null) return measured;
      }
    } catch {
      /* no meter: the honest answer is null, never a guess */
    }
    try {
      if (typeof service?.measure === 'function') return total(service.measure(agent.session));
    } catch {
      /* backend measurement is optional too */
    }
    return null;
  };

  /**
   * Resolve the requested session (argument or today's voice session) and refuse before any
   * resume when it is not a dated voice session.
   */
  const resolveTarget = (body) => {
    const requested = typeof body?.sessionId === 'string' ? body.sessionId.trim() : '';
    if (requested.length > 0) return requested;
    try {
      const derived = defaultSessionId?.();
      return typeof derived === 'string' ? derived.trim() : '';
    } catch {
      return '';
    }
  };

  /** Pre-check the preset declaration before loading (or disturbing) any session. */
  const presetProblem = async (presets) => {
    if (typeof presets?.mount !== 'function') {
      return { code: 'preset-registry-unavailable', reason: '找不到 agent preset 注册表' };
    }
    try {
      const resolved = typeof presets.resolve === 'function' ? await presets.resolve(presetId) : { id: presetId };
      if (resolved?.broken !== undefined) {
        return { code: 'preset-invalid', reason: `preset ${presetId}: ${describe(resolved.broken)}` };
      }
      if (resolved?.id !== undefined && resolved.id !== presetId) {
        return { code: 'preset-missing', reason: `语音压缩 preset 未注册: ${presetId}` };
      }
      return null;
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : '';
      if (code === 'agent-preset/not-found' || /unknown agent preset/iu.test(describe(error))) {
        return { code: 'preset-missing', reason: `语音压缩 preset 未注册: ${presetId}` };
      }
      return { code: 'preset-unavailable', reason: describe(error) };
    }
  };

  /**
   * The action body. `{ sessionId }` is optional; without it today's voice session is used.
   * @param {{ sessionId?: string }} [body]
   */
  const recover = async (body = {}) => {
    const sessionId = resolveTarget(body);
    if (sessionId.length === 0) return fail({ sessionId, code: 'session-unresolved', reason: '无法确定语音会话 id' });
    if (!isVoiceSessionId(sessionId)) {
      return fail({ sessionId, code: 'not-voice-session', reason: '只恢复 seirein-YYYY-MM-DD 语音会话' });
    }

    let live;
    try {
      live = getService('agents')?.get?.(sessionId);
    } catch {
      live = undefined;
    }
    if (live !== undefined && live !== null) {
      // A live Agent owns the write lock and its preset is locked after the first turn; the caller
      // must restart DSH instead of this action silently reusing/disposing it.
      return fail({ sessionId, code: 'agent-owned', reason: VOICE_SESSION_AGENT_OWNED_REASON });
    }

    const presets = getService('agentPresets');
    // The recovery action may be the first thing that ever needs the preset (no voice Agent was
    // created in this process). Register it now; a failure is reported by presetProblem below.
    if (typeof engine?.ensurePreset === 'function') {
      try {
        await engine.ensurePreset(presets);
      } catch {
        /* fail-open: presetProblem turns a missing registration into an actionable refusal */
      }
    }
    const problem = await presetProblem(presets);
    if (problem !== null) return fail({ sessionId, code: problem.code, reason: problem.reason });

    const agentLoop = getService('agentLoop');
    if (typeof agentLoop?.resume !== 'function') {
      return fail({ sessionId, code: 'agent-loop-unavailable', reason: 'agentLoop.resume 不可用' });
    }

    let handle;
    let evidence = null;
    try {
      // `resume` awaits `initializeAgent`, which awaits this setup and only then announces
      // `agent/created` and releases queued input: resolving here means announce is complete.
      handle = await agentLoop.resume(ownerCtx, {
        resumeSessionId: sessionId,
        setup: async (agentCtx, agent) => {
          try {
            evidence = await engine.ensure(agent, agentCtx);
          } catch (error) {
            evidence = { ok: false, reason: 'setup', error: describe(error) };
          }
        },
      });
    } catch (error) {
      return fail({
        sessionId,
        code: typeof error?.code === 'string' && error.code.length > 0 ? error.code : 'resume-failed',
        reason: describe(error),
        error: describe(error),
      });
    }

    const agent = handle?.agent;
    if (agent === undefined || agent === null) {
      return fail({ sessionId, code: 'resume-failed', reason: 'resume 未返回 agent' });
    }
    const mounted = evidence?.ok === true;
    if (!mounted) {
      return fail({
        sessionId,
        code: typeof evidence?.reason === 'string' ? evidence.reason : 'mount-failed',
        reason: '恢复成功但压缩 preset 未挂载',
        error: evidence?.error ?? '',
      });
    }

    const service = serviceOf(agent);
    const before = measureTokens(agent, service);
    if (typeof service?.compactNow !== 'function') {
      return fail({ sessionId, mounted: true, before, code: 'compaction-unavailable', reason: '该作用域没有 compactNow()' });
    }
    try {
      // Manual idle compaction: allowed below the pressure threshold, opens no turn.
      const compacted = await service.compactNow(agent, new AbortController().signal);
      const after = measureTokens(agent, service);
      const freed = before !== null && after !== null ? before - after : null;
      const idle = compacted === null || compacted === undefined;
      return done({
        ok: true,
        sessionId,
        mounted: true,
        before,
        after,
        freed,
        compacted: !idle,
        ...(idle ? { reason: 'no-compactable-range' } : {}),
      });
    } catch (error) {
      // The session is untouched on disk (no deletion, no rewrite) and the attempt is not retried.
      return fail({
        sessionId,
        mounted: true,
        before,
        code: 'compaction-failed',
        reason: describe(error),
        error: describe(error),
      });
    }
  };

  return recover;
}
