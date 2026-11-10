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
 *
 * Four limits are explicit, never silent:
 *  - a same-id declaration is reused ONLY after its content passes `assessVoiceCompactionPreset`
 *    (compaction rows, nothing else); an incompatible one is reported as `conflict` and neither
 *    overwritten nor mounted;
 *  - fail-open is a DEGRADED state: `status` carries `enabled:false` + `reason`, and context
 *    pressure at `nearLimitRatio` of the window sets `near-limit:true` plus one throttled
 *    `voice.compaction.near-limit` event;
 *  - `detach()` removes only a definition this instance registered (a reused one is preserved);
 *  - registration does not retro-assemble a running Agent: `status` separates `registered` /
 *    `mounted` / `active` and, when they diverge, says restart or `voice.session.recover` is needed;
 *  - a compaction that leaves pressure at/above `nearLimitRatio` (or frees nothing) is FLAGGED,
 *    never acted on: the result carries `stillNearLimit` / `compressionEffective` / `recommendation`
 *    and one `voice.compaction.still-near-limit` trace; no rollover and no new session are started.
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

/**
 * The exact npm package names that prove a capability row. A row's `id` is only a local label:
 * `{ id: 'compaction-basic', name: '@deepseek-ai/dsh-agent-loop' }` is an agent loop, NOT
 * compaction, so capability is read from `name` and from nothing else. A same-id declaration that
 * carries anything besides these rows (a tool, a persona, a permission grant) is NOT this preset:
 * reusing it would hand the voice Agent capabilities this module never intended.
 */
export const VOICE_COMPACTION_REQUIRED_PLUGINS = Object.freeze([
  '@deepseek-ai/dsh-compaction-basic',
  '@deepseek-ai/dsh-command-compact',
]);
export const VOICE_COMPACTION_OPTIONAL_PLUGINS = Object.freeze([
  '@deepseek-ai/dsh-compaction-tool-result-pruner',
]);

/**
 * Standard-preset rows that must not be copied into the companion preset: the coding persona,
 * repository instructions, plan mode and the duplicate compaction group. Every other row is a
 * native DSH capability (tools, jobs, goals, schedules, subagents, workflows, skills, web, …).
 */
export const VOICE_NATIVE_EXCLUDED_IDS = Object.freeze([
  'persona', 'agent-instructions', 'planning', 'compaction',
]);

/**
 * Copy the live `standard` preset's non-identity rows into Seirein's voice preset. This is the
 * dynamic link: a new DSH release or a user-added plugin that appears in the standard preset is
 * picked up on the next registration instead of being hard-coded here. The companion keeps its
 * own persona/context; only native capability rows are inherited.
 * @param {object} base - Seirein's compaction-only declaration.
 * @param {object|null} standard - registry definition of the standard preset.
 * @returns {object} base when no standard rows exist, otherwise a merged declaration.
 */
export function mergeVoicePresetWithNativeTools(base, standard) {
  const source = Array.isArray(standard?.plugins) ? standard.plugins : [];
  const native = source.filter((row) => {
    if (row === null || typeof row !== 'object') return false;
    const id = typeof row.id === 'string' ? row.id : '';
    const name = typeof row.name === 'string' ? row.name : '';
    return !VOICE_NATIVE_EXCLUDED_IDS.includes(id)
      && !name.includes('/dsh-persona')
      && !name.includes('/dsh-agent-instructions')
      && !name.includes('/dsh-plan-mode')
      && !name.includes('/dsh-compaction-');
  });
  if (native.length === 0) return base;
  return {
    ...base,
    // Marker used by the audit to distinguish a deliberately composed native-tool preset from an
    // arbitrary profile declaration that happens to carry tools.
    nativeTools: true,
    plugins: [...(Array.isArray(base?.plugins) ? base.plugins : []), ...native],
  };
}

/** Declaration keys that would grant a preset more than compaction. */
const VOICE_COMPACTION_EXTRA_KEYS = Object.freeze([
  'tools', 'permissions', 'persona', 'systemPrompt', 'prompt', 'allowedTools', 'sandbox', 'mcp',
]);

/** Pressure: warn at 80% of the context window, at most once per minute per plugin instance. */
export const VOICE_COMPACTION_NEAR_LIMIT_RATIO = 0.8;
export const VOICE_COMPACTION_NEAR_LIMIT_THROTTLE_MS = 60_000;
/** Used only when neither the caller nor a token meter names a window size. */
export const VOICE_COMPACTION_DEFAULT_WINDOW_TOKENS = 128_000;
/** What the operator must do when a live Agent was never assembled. */
export const VOICE_COMPACTION_RESTART_NOTE = '需重启 DSH 或执行 voice.session.recover 重新装配';
/**
 * Written once when a COMPLETED compaction left context pressure at/above the threshold, or freed
 * nothing. It is a debug trace, not a trigger: nothing rolls the session over on it.
 */
export const VOICE_COMPACTION_STILL_NEAR_LIMIT_ACTION = 'voice.compaction.still-near-limit';
/** The user decides; the flag only names the two choices, it never performs either. */
export const VOICE_COMPACTION_RECOMMENDATIONS = Object.freeze({
  NEW_SESSION: 'new-session',
  MANUAL_COMPACT: 'manual-compact',
});
/**
 * The manual next step after a compaction that did not leave a healthy context:
 * a compaction that freed tokens but is still above the threshold needs a new session + summary;
 * one that freed nothing should be retried by hand before that decision.
 */
const recommendationFor = (effective) => (
  effective ? VOICE_COMPACTION_RECOMMENDATIONS.NEW_SESSION : VOICE_COMPACTION_RECOMMENDATIONS.MANUAL_COMPACT
);

/**
 * The package name a declaration row stands for. Only `name` counts; the row `id` is a label and
 * is deliberately not consulted here (it may be renamed without changing the capability).
 */
const packageNameOf = (row) => (typeof row?.name === 'string' ? row.name.trim() : '');

/**
 * Audit a same-id declaration before it may be reused.
 *
 * Compatible: exactly the required compaction PACKAGES plus (optionally) the pruner, inside a
 * plain group and with no capability-bearing top-level/group key. Everything else is reported as
 * a conflict — never silently mounted, never overwritten, never unregistered by this plugin.
 *
 * @param {unknown} definition the registry's stored declaration (already unwrapped from its record)
 * @returns {{compatible: boolean, reason: string, plugins: string[], missing: string[], extras: string[]}}
 */
export function assessVoiceCompactionPreset(definition, { allowNativeTools = false } = {}) {
  const nativeComposition = allowNativeTools === true && definition?.nativeTools === true;
  const leaves = [];
  const extras = [];
  const addExtra = (value) => {
    if (!nativeComposition) extras.push(value);
  };
  for (const key of VOICE_COMPACTION_EXTRA_KEYS) {
    if (definition?.[key] !== undefined) addExtra(`preset:${key}`);
  }
  if (!Array.isArray(definition?.plugins)) {
    return { compatible: false, reason: '无法读取 preset 定义内容（缺少 plugins）', plugins: [], missing: [], extras };
  }
  const walk = (list, depth) => {
    if (!Array.isArray(list) || depth > 4) return;
    for (const row of list) {
      if (row === null || typeof row !== 'object') {
        addExtra('插件:?');
        continue;
      }
      if (row.group === true) {
        for (const key of VOICE_COMPACTION_EXTRA_KEYS) {
          if (row[key] !== undefined) addExtra(`group:${key}`);
        }
        walk(row.config, depth + 1);
        continue;
      }
      const name = packageNameOf(row);
      if (name.length === 0) {
        const label = typeof row.id === 'string' && row.id.length > 0 ? row.id : '?';
        addExtra(`插件:${label}(无包名)`);
        continue;
      }
      leaves.push(name);
    }
  };
  walk(definition.plugins, 0);
  const allowed = new Set([...VOICE_COMPACTION_REQUIRED_PLUGINS, ...VOICE_COMPACTION_OPTIONAL_PLUGINS]);
  const missing = VOICE_COMPACTION_REQUIRED_PLUGINS.filter((name) => !leaves.includes(name));
  for (const name of leaves) {
    if (!allowed.has(name)) addExtra(`插件:${name}`);
  }
  const reasons = [];
  if (missing.length > 0) reasons.push(`缺少压缩能力: ${missing.join(', ')}`);
  if (extras.length > 0) reasons.push(`附带压缩以外的内容: ${extras.join(', ')}`);
  return { compatible: reasons.length === 0, reason: reasons.join('；'), plugins: leaves, missing, extras };
}

/** Estimated request tokens (token meter first, backend measure second), or null. */
function measureAgentTokens(getService, agent, service) {
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
}

/** The compaction engine of an Agent's own preset realm (undefined when unbound). */
function compactionServiceOf(getService, agent) {
  try {
    const presets = getService('agentPresets');
    return typeof presets?.serviceFor === 'function' ? presets.serviceFor(agent, 'compaction') : undefined;
  } catch {
    return undefined;
  }
}

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
 *   windowTokens?: number | null,
 *   nearLimitRatio?: number,
 *   nearLimitThrottleMs?: number,
 *   now?: () => number,
 * }} options
 */
export function createVoiceCompaction({
  getService,
  log = null,
  presetId = VOICE_COMPACTION_PRESET_ID,
  presetDefinition = VOICE_COMPACTION_PRESET,
  windowTokens = null,
  nearLimitRatio = VOICE_COMPACTION_NEAR_LIMIT_RATIO,
  nearLimitThrottleMs = VOICE_COMPACTION_NEAR_LIMIT_THROTTLE_MS,
  now = () => Date.now(),
}) {
  /** Agents whose composition this instance already verified. */
  const mounted = new WeakSet();
  /** Concurrent ensure() calls for one Agent settle together. */
  const inFlight = new WeakMap();
  /** Verified evidence per Agent; never derived from the recorded marker. */
  const records = new WeakMap();
  /** Registration state of the preset itself (one per plugin instance). */
  let presetState = { status: 'idle', source: null, registered: false, error: null, reason: null, at: 0 };
  /** In-flight registration; concurrent callers settle together. */
  let presetPending = null;
  /** Disposer returned by `agentPresets.register()`; owned only when this instance registered. */
  let presetUnregister = null;
  /** A detach in progress; a later attach waits for the previous definition to be gone. */
  let presetRelease = null;
  /** Last sampled pressure (worst voice Agent), independent of any event emission. */
  let pressure = {
    nearLimit: false, sessionId: '', tokens: null, windowTokens: null, ratio: null,
    threshold: nearLimitRatio, at: 0,
  };
  /** Throttle stamp for `voice.compaction.near-limit`; reset when pressure falls again. */
  let nearLimitEmittedAt = 0;
  /**
   * Automatic compactions currently open, keyed by the durable `compactionId`:
   * `{ sessionId, before, agent }`. Only `turn != null` compactions enter it, so the idle/manual
   * path (including `voice.session.recover`'s `compactNow()`) can never double-report.
   */
  const autoCompactions = new Map();

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
   * The shipped registry stores `{ config, context, ready, ... }` per id; only `config` is the
   * declaration. A hand-written map (and the tests) may still hold the bare definition, so the
   * wrapper is recognized by its `config` member and unwrapped before any audit.
   */
  const definitionOf = (record) => (
    record !== null && typeof record === 'object'
    && record.config !== null && typeof record.config === 'object'
    && !Array.isArray(record.config)
    && record.plugins === undefined
      ? record.config
      : record
  );

  /**
   * Provenance of an existing declaration. The plugin's own registration never reaches this path
   * (it is recorded before the next read). A leftover declaration is the migration case — it came
   * from the profile patch, or from a bundle that declared the same id — so "profile" is the honest
   * default; only an explicit marker upgrades it to "builtin". The marker may sit on the registry
   * record or inside its config, so both layers are read.
   */
  const sourceOf = (record, definition) => {
    for (const candidate of [record, definition]) {
      if (typeof candidate?.source === 'string' && candidate.source.length > 0) return candidate.source;
      if (candidate?.builtin === true) return 'builtin';
    }
    return 'profile';
  };

  /** Read one declaration without the registry's loader-settling diagnostic. */
  const readPresetById = async (presets, id) => {
    const declarations = presets?.definitions;
    if (declarations instanceof Map) return declarations.get(id);
    if (declarations !== null && typeof declarations === 'object') {
      const direct = declarations[id];
      if (direct !== undefined) return direct;
    }
    if (typeof presets?.has === 'function') {
      try {
        return presets.has(id) ? { config: { id } } : undefined;
      } catch {
        return undefined;
      }
    }
    // Other registry builds answer only metadata; that is still enough to avoid a duplicate.
    if (typeof presets?.list === 'function') {
      try {
        const rows = await presets.list();
        return Array.isArray(rows) ? rows.find((row) => row?.id === id) : undefined;
      } catch {
        return undefined;
      }
    }
    return undefined;
  };

  /** Read a declaration without the registry's loader-settling diagnostic (safe during activation). */
  const readExisting = async (presets) => readPresetById(presets, presetId);

  /**
   * Ensure the plugin-owned preset exists, at most once per instance.
   *
   * A same-id declaration is reused ONLY after `assessVoiceCompactionPreset` proves it carries the
   * compaction rows and nothing else. An incompatible declaration is a CONFLICT: it is not
   * overwritten, not unregistered, and not mounted, and the state says why. Missing → `register()`.
   * Failure → one `voice.compaction.preset.register-failed` event and a latched failed state;
   * callers fail open, so voice keeps running without compaction — and status reports exactly that,
   * so fail-open is never mistaken for a working compressor. `unavailable` is retried because the
   * registry service may simply not be mounted yet.
   */
  const ensurePreset = async (presetsArg) => {
    if (presetRelease !== null) await presetRelease.catch(() => {});
    if (
      presetState.status === 'registered' || presetState.status === 'reused'
      || presetState.status === 'failed' || presetState.status === 'conflict'
    ) {
      return presetState;
    }
    if (presetPending !== null) return await presetPending;
    const presets = presetsArg ?? getService('agentPresets');
    if (presets === undefined || presets === null) {
      presetState = { status: 'unavailable', source: null, registered: false, error: null, reason: null, at: Date.now() };
      return presetState;
    }

    /** Reuse only an audited-compatible declaration; anything else is an explicit conflict. */
    const adoptExisting = (record) => {
      // The registry record wraps the definition; auditing the wrapper would always see a missing
      // `plugins` and misreport a fully compatible preset as a conflict.
      const definition = definitionOf(record);
      const source = sourceOf(record, definition);
      const audit = assessVoiceCompactionPreset(definition, { allowNativeTools: true });
      if (!audit.compatible) {
        presetState = {
          status: 'conflict',
          source,
          registered: false,
          error: null,
          reason: audit.reason,
          at: Date.now(),
        };
        note('voice.compaction.preset.conflict', { presetId, source, reason: audit.reason });
        return presetState;
      }
      presetState = {
        status: 'reused', source, registered: false, error: null, reason: null,
        at: Date.now(), nativeTools: definition?.nativeTools === true,
      };
      note('voice.compaction.preset.reused', { presetId, source, plugins: audit.plugins });
      return presetState;
    };

    const run = (async () => {
      const existing = await readExisting(presets);
      if (existing !== undefined) return adoptExisting(existing);
      if (typeof presets.register !== 'function') {
        presetState = {
          status: 'failed',
          source: null,
          registered: false,
          error: 'agentPresets.register() is unavailable',
          reason: null,
          at: Date.now(),
        };
        note('voice.compaction.preset.register-failed', { presetId, error: presetState.error });
        return presetState;
      }
      // The companion preset is composed from the LIVE standard preset, not a frozen tool list:
      // a new DSH release or a user-installed native plugin appears in the standard declaration
      // and is inherited here on the next registration. Persona, coding instructions, plan mode
      // and the duplicate compaction group are deliberately excluded by the merge.
      let effective = presetDefinition;
      let nativeTools = false;
      try {
        const standardRecord = await readPresetById(presets, 'standard');
        const standard = definitionOf(standardRecord);
        effective = mergeVoicePresetWithNativeTools(presetDefinition, standard);
        nativeTools = effective !== presetDefinition;
      } catch {
        // Standard preset unavailable: keep the compaction-only fallback rather than blocking voice.
      }
      try {
        const disposer = await presets.register(effective);
        presetUnregister = typeof disposer === 'function' ? disposer : null;
        presetState = {
          status: 'registered', source: 'registered', registered: true,
          error: null, reason: null, at: Date.now(), nativeTools,
        };
        note('voice.compaction.preset.registered', {
          presetId,
          source: 'registered',
          nativeTools,
          plugins: Array.isArray(effective?.plugins) ? effective.plugins.length : 0,
        });
      } catch (error) {
        // A declaration that appeared between the read and register() is a migration race, not a
        // failure: the declaration that won the race must pass the SAME audit before it is used.
        if (/duplicate agent preset/iu.test(describe(error))) {
          const raced = await readExisting(presets);
          if (raced === undefined) {
            presetState = {
              status: 'conflict',
              source: 'unknown',
              registered: false,
              error: null,
              reason: '同 ID 定义已存在，但无法读取其内容，不能确认兼容',
              at: Date.now(),
            };
            note('voice.compaction.preset.conflict', { presetId, source: 'unknown', reason: presetState.reason });
            return presetState;
          }
          return adoptExisting(raced);
        }
        presetState = { status: 'failed', source: null, registered: false, error: describe(error), reason: null, at: Date.now() };
        note('voice.compaction.preset.register-failed', { presetId, error: presetState.error });
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

  /** Live Agents whose session id belongs to Seirein's dated voice session. */
  const liveVoiceAgents = () => {
    try {
      const agents = getService('agents');
      const rows = typeof agents?.list === 'function' ? agents.list() : [];
      return Array.isArray(rows) ? rows.filter((agent) => isVoiceSessionId(agent?.id)) : [];
    } catch {
      return [];
    }
  };

  /** Window size: explicit option, then the token meter's own, then the documented default. */
  const resolveWindowTokens = () => {
    if (Number.isFinite(windowTokens) && windowTokens > 0) return windowTokens;
    try {
      const meter = getService('tokenMeter');
      for (const key of ['windowTokens', 'contextWindow', 'window', 'limit', 'capacity']) {
        const value = Number(meter?.[key]);
        if (Number.isFinite(value) && value > 0) return value;
      }
    } catch {
      /* no meter: the documented default is the only honest window */
    }
    return VOICE_COMPACTION_DEFAULT_WINDOW_TOKENS;
  };

  /**
   * Sample context pressure for the live voice Agents and latch it into `pressure`.
   *
   * This is the warning that fail-open does not replace: when the measured request approaches the
   * window (`ratio >= nearLimitRatio`), the flag is in `status` AND one throttled
   * `voice.compaction.near-limit` event is written. Reading status is the sampling trigger (the Web
   * card polls it), so an uncompacted session cannot grow silently into the limit without the
   * operator-visible flag; the event is the durable trace, never the only signal.
   */
  const samplePressure = () => {
    const window = resolveWindowTokens();
    let worst = null;
    for (const agent of liveVoiceAgents()) {
      const tokens = measureAgentTokens(getService, agent, compactionServiceOf(getService, agent));
      if (tokens === null) continue;
      const ratio = window > 0 ? tokens / window : 0;
      if (worst === null || ratio > worst.ratio) worst = { sessionId: agent.id, tokens, ratio };
    }
    const nearLimit = worst !== null && worst.ratio >= nearLimitRatio;
    pressure = {
      nearLimit,
      sessionId: worst?.sessionId ?? '',
      tokens: worst?.tokens ?? null,
      windowTokens: window,
      ratio: worst === null ? null : Math.round(worst.ratio * 1000) / 1000,
      threshold: nearLimitRatio,
      at: now(),
    };
    if (!nearLimit) {
      nearLimitEmittedAt = 0;
      return pressure;
    }
    const stamp = now();
    if (stamp - nearLimitEmittedAt >= nearLimitThrottleMs) {
      nearLimitEmittedAt = stamp;
      note('voice.compaction.near-limit', { presetId, ...pressure });
    }
    return pressure;
  };

  /** The live voice Agent that owns one session object (undefined outside a live Agent). */
  const agentForSession = (session) => {
    for (const agent of liveVoiceAgents()) {
      if (agent?.session === session) return agent;
    }
    return undefined;
  };

  /**
   * Observe the AUTO compaction path (never the idle/manual one).
   *
   * `compaction-basic` wraps an automatic run in `compaction/start` / `compaction/end` session
   * events carrying the same `compactionId` and the current turn. An idle compaction (manual
   * `/compact`, or `voice.session.recover`'s `compactNow()`) carries `turn:null`, so it is ignored
   * here: the recovery action reports its own result instead of writing a duplicate event.
   *
   * The observation is read-only: `before` is measured when the run opens, the new surface is
   * measured when it closes, and one event says whether pressure is still at/above the threshold.
   * A failed close (`error` in the end event) is silent here; the engine's own logging owns it.
   */
  const onSessionEvent = (session, event) => {
    try {
      const type = event?.type;
      if (type !== 'compaction/start' && type !== 'compaction/end') return;
      if (!isVoiceSessionId(session?.id)) return;
      const data = event?.data ?? {};
      const compactionId = data.compactionId;
      if (typeof compactionId !== 'string' || compactionId.length === 0) return;
      if (type === 'compaction/start') {
        if (data.turn === null || data.turn === undefined) return;
        const agent = agentForSession(session);
        if (agent === undefined) return;
        const before = measureAgentTokens(getService, agent, compactionServiceOf(getService, agent));
        // Every run is paired, but a bounded map keeps a host that drops a close from leaking.
        if (autoCompactions.size >= 32) autoCompactions.clear();
        autoCompactions.set(compactionId, { sessionId: session.id, before, agent });
        return;
      }
      const record = autoCompactions.get(compactionId);
      if (record === undefined) return;
      autoCompactions.delete(compactionId);
      if (data.error !== undefined) return;
      const after = measureAgentTokens(
        getService, record.agent, compactionServiceOf(getService, record.agent),
      );
      const window = resolveWindowTokens();
      if (after === null || !Number.isFinite(window) || window <= 0) return;
      const ratio = Math.round((after / window) * 1000) / 1000;
      if (ratio < nearLimitRatio) return;
      const effective = record.before !== null && after < record.before;
      note(VOICE_COMPACTION_STILL_NEAR_LIMIT_ACTION, {
        sessionId: record.sessionId,
        before: record.before,
        after,
        ratio,
        recommendation: recommendationFor(effective),
      });
    } catch {
      /* observing a compaction must never break the session append that produced it */
    }
  };

  /** Why automatic compaction is not usable, as the operator-facing reason. */
  const unavailableReason = (state) => {
    if (state.status === 'conflict') {
      return `自动压缩不可用：同 ID preset 定义不兼容（${state.reason ?? '内容未通过核对'}）`;
    }
    if (state.status === 'failed') return `自动压缩不可用：preset 注册失败（${state.error ?? '未知错误'}）`;
    if (state.status === 'unavailable') return '自动压缩不可用：找不到 agent preset 注册表';
    return '自动压缩不可用：语音压缩 preset 尚未注册';
  };

  /**
   * Read-only snapshot for `status` and tests; never includes the declaration itself.
   *
   * `registered` = this instance owns/validated the declaration, `mounted` = live voice Agents with
   * verified mount evidence, `active` = live voice Agents whose compaction service resolves NOW.
   * `enabled` is the functional answer (a registered preset does not make an already-running Agent
   * compacted), and `requiresRestart` names the manual/recovery step when it is not.
   */
  const presetStatus = () => {
    const agents = liveVoiceAgents();
    const mountedCount = agents.filter((agent) => records.get(agent)?.ok === true).length;
    const activeCount = agents.filter((agent) => compactionServiceOf(getService, agent) !== undefined).length;
    const sampled = samplePressure();
    const usable = presetState.status === 'registered' || presetState.status === 'reused';
    const requiresRestart = agents.length > activeCount;
    let enabled = usable;
    let reason = usable ? '' : unavailableReason(presetState);
    if (usable && agents.length > 0 && activeCount === 0) {
      enabled = false;
      reason = `自动压缩不可用：已运行的语音会话未装配（${VOICE_COMPACTION_RESTART_NOTE}）`;
    }
    return {
      presetId,
      ...presetState,
      enabled,
      reason,
      running: agents.length,
      mounted: mountedCount,
      active: activeCount,
      requiresRestart,
      note: requiresRestart ? VOICE_COMPACTION_RESTART_NOTE : '',
      nearLimit: sampled.nearLimit,
      'near-limit': sampled.nearLimit,
      pressure: { ...sampled },
    };
  };

  /** Release only a registration this instance made; a reused declaration is never removed. */
  const releasePreset = () => {
    if (presetRelease !== null) return presetRelease;
    const pending = presetPending;
    const early = presetUnregister;
    const releasedSource = presetState.source;
    presetUnregister = null;
    presetState = { status: 'idle', source: null, registered: false, error: null, reason: null, at: 0 };
    if (pending === null && typeof early !== 'function') return null;
    const release = (async () => {
      if (pending !== null) await pending.catch(() => {});
      // A registration that settled while detach waited is still ours to remove.
      const disposer = early ?? presetUnregister;
      presetUnregister = null;
      if (typeof disposer === 'function') {
        await disposer();
        note('voice.compaction.preset.released', { presetId, source: releasedSource, owned: true });
      }
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
      if (preset.status === 'failed' || preset.status === 'unavailable' || preset.status === 'conflict') {
        const reason = preset.status === 'failed'
          ? 'preset-register-failed'
          : (preset.status === 'conflict' ? 'preset-conflict' : 'preset-registry-unavailable');
        return skip(agent, reason, {
          presetId,
          ...(typeof preset.error === 'string' && preset.error.length > 0 ? { error: preset.error } : {}),
          ...(typeof preset.reason === 'string' && preset.reason.length > 0 ? { conflict: preset.reason } : {}),
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
    let offSession = null;
    if (typeof ctx.on === 'function') {
      off = ctx.on('agent/created', (payload) => {
        // Serial listener: awaiting keeps the binding before the first step; the ensure() result
        // is always fulfilled, so a missing preset can never fail Agent creation.
        return ensure(payload?.agent);
      });
      // Read-only observer for the auto-compaction path. A Host context is unscoped, so it
      // receives every session's `compaction/start`/`compaction/end`; the handler filters by
      // dated voice session and ignores the idle/manual runs.
      try {
        offSession = ctx.on('session/event', onSessionEvent);
      } catch {
        offSession = null;
      }
    }
    // Register as soon as the plugin mounts; if the registry service is not ready yet, the next
    // voice Agent's ensure() retries (an unavailable state is deliberately not latched).
    startRegistration();
    detach = () => {
      if (!attached) return undefined;
      attached = false;
      if (typeof off === 'function') off();
      if (typeof offSession === 'function') offSession();
      off = null;
      offSession = null;
      autoCompactions.clear();
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

  return {
    presetId, setup, ensure, attach, evidenceOf, ensurePreset,
    presetStatus, status: presetStatus, samplePressure,
    // The threshold and window the pressure sample uses, so recovery reports the same ratio the
    // status card sees instead of guessing one from `before`/`after` alone.
    nearLimitRatio, resolveWindowTokens,
  };
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

  /** Emit one debug line; a log that throws must never hide or fail the action. */
  const emitLog = (type, payload) => {
    try {
      const pending = log?.emit?.(type, payload);
      if (pending !== undefined && typeof pending?.catch === 'function') pending.catch(() => {});
    } catch {
      /* observability must never break the action */
    }
  };

  /** One `voice.session.recover` debug line per attempt. */
  const note = (payload) => {
    emitLog(VOICE_SESSION_RECOVER_ACTION, {
      sessionId: payload.sessionId ?? '',
      ok: payload.ok === true,
      mounted: payload.mounted === true,
      before: payload.before ?? null,
      after: payload.after ?? null,
      freed: payload.freed ?? null,
      // Real pressure (tokens/window/ratio) at each point, or null when the meter could not be
      // read: `before`/`after` alone are absolute counts, not the pressure an operator expects.
      pressureBefore: payload.pressureBefore ?? null,
      pressureAfter: payload.pressureAfter ?? null,
      // `null` means "not measured", never "healthy": a failed recovery must not read as a clean one.
      stillNearLimit: payload.stillNearLimit ?? null,
      compressionEffective: payload.compressionEffective ?? null,
      recommendation: payload.recommendation ?? '',
      // The machine code is the stable filter value; success falls back to its own note.
      reason: typeof payload.code === 'string' && payload.code.length > 0
        ? payload.code
        : (payload.reason ?? ''),
    });
  };
  /** The separate, once-per-recovery trace (only when the result is still above the threshold). */
  const noteStillNearLimit = (payload) => {
    emitLog(VOICE_COMPACTION_STILL_NEAR_LIMIT_ACTION, {
      sessionId: payload.sessionId ?? '',
      before: payload.before ?? null,
      after: payload.after ?? null,
      ratio: payload.ratio ?? payload.pressureAfter?.ratio ?? null,
      recommendation: payload.recommendation ?? '',
    });
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
    pressureBefore: null,
    pressureAfter: null,
    compacted: false,
    ...payload,
  });

  /** The compaction engine of the Agent's own preset realm (undefined when unbound). */
  const serviceOf = (agent) => compactionServiceOf(getService, agent);

  /** Estimated request tokens (token meter first, backend measure second), or null. */
  const measureTokens = (agent, service) => measureAgentTokens(getService, agent, service);

  /**
   * Context pressure for a measured token count: `{ tokens, window, ratio }`, or null when the
   * count or the window is unavailable. A ratio is never estimated from `before`/`after`; an
   * unreadable meter or window stays null so the caller cannot mistake a guess for a measurement.
   */
  const pressureOf = (tokens, window) => {
    if (tokens === null || !Number.isFinite(window) || window <= 0) return null;
    return { tokens, window, ratio: Math.round((tokens / window) * 1000) / 1000 };
  };
  /** The window size the compaction engine samples against, or null when it cannot name one. */
  const windowTokensOf = () => {
    try {
      const window = typeof engine?.resolveWindowTokens === 'function' ? engine.resolveWindowTokens() : null;
      return Number.isFinite(window) && window > 0 ? window : null;
    } catch {
      return null;
    }
  };
  /** The same threshold the engine's `near-limit` status uses (default 0.8). */
  const nearLimitRatioOf = () => {
    const value = Number(engine?.nearLimitRatio);
    return Number.isFinite(value) && value > 0 ? value : VOICE_COMPACTION_NEAR_LIMIT_RATIO;
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
    // Recovery must not resume a session only to discover that the same-id declaration was
    // incompatible: that decision is already made, and it is an actionable refusal.
    const state = typeof engine?.presetStatus === 'function' ? engine.presetStatus() : null;
    if (state?.status === 'conflict') {
      return { code: 'preset-conflict', reason: state.reason ?? '同 ID preset 定义不兼容' };
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
    const windowTokens = windowTokensOf();
    const before = measureTokens(agent, service);
    const pressureBefore = pressureOf(before, windowTokens);
    if (typeof service?.compactNow !== 'function') {
      return fail({ sessionId, mounted: true, before, pressureBefore, code: 'compaction-unavailable', reason: '该作用域没有 compactNow()' });
    }
    try {
      // Manual idle compaction: allowed below the pressure threshold, opens no turn.
      const compacted = await service.compactNow(agent, new AbortController().signal);
      // Re-measure AFTER compaction (the same meter, only if it is available): `before`/`after` are
      // raw counts, while `pressureBefore`/`pressureAfter` add the window and ratio an operator reads.
      const after = measureTokens(agent, service);
      const pressureAfter = pressureOf(after, windowTokens);
      const freed = before !== null && after !== null ? before - after : null;
      // Two independent reasons to warn: the measured pressure is still at/above the threshold, or
      // this compaction freed nothing at all (`after >= before`). `compressionEffective` answers the
      // operator's question ("did compaction leave a healthy context?"), so it is false on this
      // branch even when `before`/`after` prove a token drop; the raw counts keep that fact visible.
      const aboveThreshold = pressureAfter !== null && pressureAfter.ratio >= nearLimitRatioOf();
      const noEffect = before !== null && after !== null && after >= before;
      const measured = pressureAfter !== null;
      // `null` (not `false`) when the meter or window is unreadable: an unmeasured context must
      // never be reported as a healthy one.
      const stillNearLimit = (aboveThreshold || noEffect) ? true : (measured ? false : null);
      const tokenDrop = before !== null && after !== null && after < before;
      const compressionEffective = stillNearLimit === true ? false : tokenDrop;
      const recommendation = stillNearLimit === true ? recommendationFor(tokenDrop) : '';
      const idle = compacted === null || compacted === undefined;
      const result = {
        ok: true,
        sessionId,
        mounted: true,
        before,
        after,
        freed,
        pressureBefore,
        pressureAfter,
        stillNearLimit,
        compressionEffective,
        recommendation,
        compacted: !idle,
        ...(idle ? { reason: 'no-compactable-range' } : {}),
      };
      done(result);
      // One separate trace per recovery, and only when the result above is not healthy. Nothing
      // acts on it: no rollover, no new session, no second compaction.
      if (stillNearLimit) noteStillNearLimit(result);
      return result;
    } catch (error) {
      // The session is untouched on disk (no deletion, no rewrite) and the attempt is not retried.
      // A failed compaction cannot be called effective, and the only remaining route is the
      // user's own decision: start a new session and carry a summary over.
      return fail({
        sessionId,
        mounted: true,
        before,
        pressureBefore,
        code: 'compaction-failed',
        reason: describe(error),
        error: describe(error),
        compressionEffective: false,
        recommendation: VOICE_COMPACTION_RECOMMENDATIONS.NEW_SESSION,
      });
    }
  };

  return recover;
}
