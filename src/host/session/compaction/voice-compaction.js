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
 * The declaration itself lives in the profile (see the draft handed to the user); this module only
 * mounts it. `mount()` is the registry's own composition API: it binds the Agent scope's parent to
 * the retained preset revision, so the preset's scoped listeners receive that Agent's events and
 * its isolated `compaction` service is reachable through `serviceFor`.
 *
 * Everything Harness-specific is reached through the Host context (`getService` + `ctx.on`); no
 * Harness package is imported, so a profile without the preset registry keeps working (the voice
 * agent simply stays uncompacted).
 */

/** Preset identity Seirein's voice agent runs. Mirrors the profile draft exactly. */
export const VOICE_COMPACTION_PRESET_ID = 'seirein-voice';

/**
 * The declaration the profile is expected to carry. Exported so the draft and the tests use one
 * source of truth; `createVoiceCompaction` never registers it itself (the profile owns presets).
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
 * Fresh-session metadata for the daily voice agent. `agentPreset` is a MARKER only (the Session
 * header records it); it is written only when the preset is actually resolvable, so the header
 * never claims a composition the Agent does not run.
 * @param {{cwd: string, presetReady: boolean}} options
 */
export function dailyAgentMeta({ cwd, presetReady }) {
  return { cwd, ...(presetReady === true ? { agentPreset: VOICE_COMPACTION_PRESET_ID } : {}) };
}

/**
 * @param {{
 *   getService: (name: string) => any,
 *   log?: { emit?: (type: string, payload: object) => unknown } | null,
 *   presetId?: string,
 * }} options
 */
export function createVoiceCompaction({ getService, log = null, presetId = VOICE_COMPACTION_PRESET_ID }) {
  /** Agents whose composition this instance already verified. */
  const mounted = new WeakSet();
  /** Concurrent ensure() calls for one Agent settle together. */
  const inFlight = new WeakMap();
  /** Verified evidence per Agent; never derived from the recorded marker. */
  const records = new WeakMap();

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
   * @param {any} [agentCtx] the Agent context supplied by `setup`
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
      const ctx = agentCtx ?? agent.ctx;
      if (ctx === undefined || ctx === null) return skip(agent, 'agent-context-unavailable');

      // Another composition already owns this Agent: never yank its preset out from under it.
      // A preset-free Agent (undefined) and our own id are both eligible.
      const composedBefore = typeof presets.composedPreset === 'function' ? presets.composedPreset(ctx) : undefined;
      if (typeof composedBefore === 'string' && composedBefore.length > 0 && composedBefore !== presetId) {
        return skip(agent, 'other-preset', { composed: composedBefore });
      }
      // A previous plugin instance (or setup) may already have bound the same revision. Verify it
      // instead of mounting again: a second bind would be refused by the registry anyway, but the
      // voice agent must not depend on that refusal to stay single-instance.
      if (composedBefore === presetId && typeof presets.serviceFor === 'function') {
        const existingService = presets.serviceFor(agent, 'compaction');
        if (existingService !== undefined) {
          const record = {
            ok: true,
            presetId,
            composed: presetId,
            service: true,
            reused: true,
            mountedAt: Date.now(),
          };
          mounted.add(agent);
          records.set(agent, record);
          note('voice.compaction.reused', { sessionId: agent.id, presetId });
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
   * Install the coverage that `setup` alone cannot give: every Agent creation path.
   *
   * - new and resumed Agents: the loop awaits serial `agent/created` listeners before releasing
   *   input, so the preset is bound before the first step (including a resume whose creator did
   *   not pass `setup`, e.g. `dispatch.js#ensureSession`);
   * - component reload / reconnection: Agents that were live before this instance mounted are
   *   swept once from `agents.list()`; a verified composition is reused, never mounted twice.
   *
   * @param {any} ctx Host context
   * @returns {() => void} detach (the Host fiber also disposes the registration)
   */
  const attach = (ctx) => {
    if (ctx === undefined || ctx === null) return () => {};
    let off = null;
    if (typeof ctx.on === 'function') {
      off = ctx.on('agent/created', (payload) => {
        // Serial listener: awaiting keeps the binding before the first step; the ensure() result
        // is always fulfilled, so a missing preset can never fail Agent creation.
        return ensure(payload?.agent);
      });
      if (typeof ctx.effect === 'function' && typeof off === 'function') {
        ctx.effect(() => off);
        off = null;
      }
    }
    const agents = getService('agents');
    if (typeof agents?.list === 'function') {
      for (const agent of agents.list()) {
        void ensure(agent).catch(() => {});
      }
    }
    return () => {
      if (typeof off === 'function') off();
      off = null;
    };
  };

  /** Evidence recorded for an Agent (tests / status); `undefined` until verified. */
  const evidenceOf = (agent) => records.get(agent);

  /** Whether the preset declaration currently resolves; used for the truthful header marker. */
  const presetReady = async () => {
    const presets = getService('agentPresets');
    if (presets === undefined) return false;
    try {
      const resolved = typeof presets.resolve === 'function' ? await presets.resolve(presetId) : undefined;
      if (resolved !== undefined && resolved !== null) return typeof resolved.broken !== 'string';
      return typeof presets.mount === 'function';
    } catch {
      return false;
    }
  };

  /** Setup callback for `agentLoop.createAgent`/`resume`: the Agent context comes first there. */
  const setup = (agentCtx, agent) => ensure(agent, agentCtx);

  /**
   * `agentLoop.createAgent` options for the daily voice agent: the header marker plus the setup
   * that actually mounts (and verifies) the preset.
   * @param {{sessionId: string, cwd: string, presetReady: boolean}} options
   */
  const dailyCreateOptions = ({ sessionId, cwd, presetReady }) => ({
    sessionId,
    meta: dailyAgentMeta({ cwd, presetReady }),
    setup,
  });

  return { presetId, setup, ensure, attach, evidenceOf, presetReady, dailyCreateOptions };
}
