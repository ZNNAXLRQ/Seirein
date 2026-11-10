/**
 * Live2D capability discovery — stage 1 of avatar motion control.
 *
 * VTS's InjectParameterDataRequest addresses *tracking input* parameters (FaceAngleX, MouthOpen,
 * …), not Live2D model parameters (ParamAngleX, …). The model only reacts when the user mapped an
 * input onto it inside VTS, and the API cannot read that mapping.
 *
 * Two different questions are therefore kept apart, because merging them is how a list of hopeful
 * names starts claiming "the avatar can do that":
 *
 *   injectable — the input exists in InputParameterListRequest, so a value can be sent at all;
 *   verified   — something says that input really drives this part of the model. Either the model's
 *                parameter list contains the partner parameter named by the explicit rule table
 *                below, or a completed runtime probe observed the target parameter change.
 *
 * Automatic name matching alone only ever produces a *candidate* (injectable, not verified).
 * A user-declared explicit mapping (`channelMap`) selects the input name but is likewise only a
 * candidate until the runtime probe proves it; a declared name VTS does not list is reported as
 * `mappingInvalid`/`unknown-input` instead of being used.
 * Nothing here injects values — sending belongs to the motion stage (VtsClient.injectInputs).
 *
 * A third, runtime-only proof is optional: with `probeMappings:true` the caller supplies
 * `probeInputMapping` (normally `VtsClient.probeInputMapping`). For gazeX/gazeY the probe injects an
 * input and compares the model parameters before/after. Only `changed:true` keeps `verified`; a
 * failed or unchanged probe marks the channel `mappingUnverified` and sets `verified:false`, but
 * never removes the injectable channel — a diagnostics failure must not take the eye channel away.
 */

/** Every channel the motion stage wants to drive, in a stable order. */
export const CHANNEL_ORDER = [
  'gazeX',
  'gazeY',
  'headX',
  'headY',
  'headZ',
  'eyeOpenL',
  'eyeOpenR',
  'browL',
  'browR',
  'mouth',
  'bodyX',
  'bodyY',
  'bodyZ',
  // Arms/shoulders/hands are part of the generic body catalog, but their Live2D target parameter
  // names are model-specific: they stay name-matched candidates and are never auto-verified below.
  'shoulderL',
  'shoulderR',
  'armL',
  'armR',
  'handL',
  'handR',
  'breath',
];

/**
 * Channels a runtime probe can check honestly: both have model parameters whose value can be read
 * before and after one injection. Other channels stay name-rule candidates; probing them is not
 * part of this stage.
 */
export const PROBE_CHANNEL_ORDER = Object.freeze(['gazeX', 'gazeY']);
/** Diagnostic injection value; gaze tracking inputs are normalised to -1..1. */
export const PROBE_VALUE = 0.5;
/** Upper bound for ONE explicit probe call; a transport that never settles becomes safe data. */
export const PROBE_TIMEOUT_MS = 5000;

/**
 * Candidate *input* names per channel, most specific first. Matching is an exact, case-insensitive
 * comparison against the VTS input list, so a partially similar name can never pick the wrong input.
 *
 * Gaze deliberately excludes FacePositionX/Y: that is where the *face* sits in the camera frame
 * (head translation), not where the eyeballs point. Treating it as gaze made discovery report
 * "gazeX mapped" while the eyes did not move — a user-declared input is the only other way in.
 */
export const PARAMETER_CANDIDATES = {
  // EyeRightX/Y are VTube Studio's default per-eye tracking inputs (Tobii / iOS eye tracking);
  // every shipped VTS model maps ParamEyeBallX/Y from them. EyeBallX/Y (the older library name)
  // stays a candidate so a model that exposes those still verifies through the rule alias below.
  gazeX: ['EyeRightX', 'EyeLeftX', 'EyeBallX', 'GazeX', 'EyeTargetX', 'EyeTrackX', 'GazeTargetX'],
  gazeY: ['EyeRightY', 'EyeLeftY', 'EyeBallY', 'GazeY', 'EyeTargetY', 'EyeTrackY', 'GazeTargetY'],
  headX: ['FaceAngleX', 'HeadAngleX', 'HeadX'],
  headY: ['FaceAngleY', 'HeadAngleY', 'HeadY'],
  headZ: ['FaceAngleZ', 'HeadAngleZ', 'HeadZ'],
  eyeOpenL: ['EyeOpenLeft', 'EyeLOpen', 'EyeOpenL'],
  eyeOpenR: ['EyeOpenRight', 'EyeROpen', 'EyeOpenR'],
  browL: ['BrowLeftY', 'BrowLY', 'BrowLeft'],
  browR: ['BrowRightY', 'BrowRY', 'BrowRight'],
  mouth: ['MouthOpen', 'MouthOpenY', 'VoiceVolume'],
  bodyX: ['BodyAngleX', 'BodyX'],
  bodyY: ['BodyAngleY', 'BodyY'],
  bodyZ: ['BodyAngleZ', 'BodyZ'],
  // Only the exact shoulder spellings are candidates. ArmLeft/ArmRight deliberately stay on the
  // arm channels: treating an arm input as a shoulder input would "discover" a shoulder the model
  // may not have. No target rule exists for shoulder in this stage, so a hit stays a candidate.
  shoulderL: ['ShoulderLeft'],
  shoulderR: ['ShoulderRight'],
  // Exact, case-insensitive candidate names only — no prefix/similarity matching.
  armL: ['ArmLeft', 'ArmLAngle', 'ArmLeftAngle'],
  armR: ['ArmRight', 'ArmRAngle', 'ArmRightAngle'],
  handL: ['HandLeft', 'HandLAngle', 'HandLeftAngle'],
  handR: ['HandRight', 'HandRAngle', 'HandRightAngle'],
  breath: ['Breath', 'BreathParam'],
};

/**
 * Explicit input → model-parameter rules. A channel is "verified" by name only when the matched
 * input is exactly the rule's input AND the model reports the rule's target parameter: that is the
 * VTS default pairing for the standard tracking inputs. Everything else stays a candidate.
 */
export const MODEL_TARGET_RULES = {
  gazeX: { input: 'EyeRightX', target: 'ParamEyeBallX' },
  gazeY: { input: 'EyeRightY', target: 'ParamEyeBallY' },
  headX: { input: 'FaceAngleX', target: 'ParamAngleX' },
  headY: { input: 'FaceAngleY', target: 'ParamAngleY' },
  headZ: { input: 'FaceAngleZ', target: 'ParamAngleZ' },
  eyeOpenL: { input: 'EyeOpenLeft', target: 'ParamEyeLOpen' },
  eyeOpenR: { input: 'EyeOpenRight', target: 'ParamEyeROpen' },
  browL: { input: 'BrowLeftY', target: 'ParamBrowLY' },
  browR: { input: 'BrowRightY', target: 'ParamBrowRY' },
  mouth: { input: 'MouthOpen', target: 'ParamMouthOpenY' },
  bodyX: { input: 'BodyAngleX', target: 'ParamBodyAngleX' },
  bodyY: { input: 'BodyAngleY', target: 'ParamBodyAngleY' },
  bodyZ: { input: 'BodyAngleZ', target: 'ParamBodyAngleZ' },
  // No shoulder/arm/hand rule on purpose: their model parameter names are not standard enough to
  // treat a name match as proof. They remain injectable candidates (`verified:false`) until a
  // runtime probe or an explicit mapping supplies real evidence.
  breath: { input: 'Breath', target: 'ParamBreath' },
};

/**
 * Additional exact input → target name pairs that also verify a channel. These are not guesses:
 * each one names the same model parameter as the primary rule, so only the input spelling differs
 * between VTS builds. A model that reports only the alias input is verified exactly like one that
 * reports the primary spelling.
 */
export const MODEL_TARGET_RULE_ALIASES = {
  gazeX: [{ input: 'EyeBallX', target: 'ParamEyeBallX' }],
  gazeY: [{ input: 'EyeBallY', target: 'ParamEyeBallY' }],
  // BodyY/BodyZ are the short spellings of the same body-channel inputs and the same model targets;
  // bodyX keeps its previous behaviour (no BodyX alias), as pinned by the existing tests.
  bodyY: [{ input: 'BodyY', target: 'ParamBodyAngleY' }],
  bodyZ: [{ input: 'BodyZ', target: 'ParamBodyAngleZ' }],
};

const normalizeName = (name) => String(name ?? '').trim().toLowerCase();

const emptyInputs = () => Object.fromEntries(CHANNEL_ORDER.map((channel) => [channel, null]));

/** Shape returned before the first discovery and whenever discovery could not run. */
const emptyCapabilities = () => ({
  discovered: false,
  ok: false,
  inputs: emptyInputs(),
  channels: [],
  mapped: [],
  verified: [],
  mappingUnverified: [],
  /** Explicit channelMap entries whose input name was not in InputParameterListRequest. */
  mappingInvalid: [],
  /** channel → 'explicit' for a valid user-declared input; other channels stay absent. */
  mappingSources: {},
  unmapped: [...CHANNEL_ORDER],
  model: { ok: false, source: '', count: 0, error: '' },
  parameterCount: { default: 0, custom: 0 },
  declared: [],
  discoveredAt: '',
  probeError: '',
  error: '',
});

/** Single in-memory snapshot: /assistant/status reads it synchronously, so it is replaced whole. */
let cached = null;
/** Identity of `cached`; '' means an unscoped (legacy) discovery with no model binding. */
let cachedKey = '';
/** Completed discoveries by identity: a new model must never read the previous model's map. */
const capabilityCache = new Map();
/** One promise per identity: a forced call must still join the request already in flight. */
const inFlight = new Map();

/** Normalise the identity every discovery result is bound to. */
export function normalizeDiscoveryIdentity(identity = {}) {
  const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
  return {
    modelId: String(identity?.modelId ?? ''),
    modelGeneration: number(identity?.modelGeneration),
    connectionGeneration: number(identity?.connectionGeneration),
  };
}

/** Cache/in-flight key: connection generation, model generation and model id. */
export function discoveryIdentityKey(identity) {
  const entry = normalizeDiscoveryIdentity(identity);
  return `${entry.connectionGeneration}\u0000${entry.modelGeneration}\u0000${entry.modelId}`;
}

/** True only when both identities name the same model on the same connection generation. */
export function sameDiscoveryIdentity(left, right) {
  if (left === null || left === undefined || right === null || right === undefined) return false;
  return discoveryIdentityKey(left) === discoveryIdentityKey(right);
}

/** Deep-enough copy so callers cannot mutate the committed snapshot or the cache. */
function copyCapabilities(base) {
  const copyEntry = (entry) => {
    if (entry === null || entry === undefined) return null;
    const copy = { ...entry, modelParams: [...(entry.modelParams ?? [])] };
    if (entry.probe !== null && typeof entry.probe === 'object') {
      copy.probe = {
        ...entry.probe,
        ...(entry.probe.delta !== null && typeof entry.probe.delta === 'object'
          ? { delta: { ...entry.probe.delta } }
          : {}),
      };
    }
    return copy;
  };
  return {
    ...base,
    inputs: Object.fromEntries(
      Object.entries(base.inputs).map(([channel, entry]) => [channel, copyEntry(entry)]),
    ),
    channels: (base.channels ?? []).map((entry) => copyEntry(entry)),
    mapped: [...base.mapped],
    verified: [...base.verified],
    mappingUnverified: [...(base.mappingUnverified ?? [])],
    mappingInvalid: [...(base.mappingInvalid ?? [])],
    mappingSources: { ...(base.mappingSources ?? {}) },
    unmapped: [...base.unmapped],
    declared: [...(base.declared ?? [])],
    model: { ...base.model },
    parameterCount: { ...base.parameterCount },
    probeError: String(base.probeError ?? ''),
  };
}

/**
 * Copy of the cached capability map. Never triggers I/O, so status routes can call it any time.
 * `unmapped` is exactly the channels with no injectable input — the list callers must surface.
 */
export function snapshot() {
  return copyCapabilities(cached ?? emptyCapabilities());
}

/** Copy of the discovery committed for one identity, or null when that model was never mapped. */
export function cachedCapabilities(identity) {
  const result = capabilityCache.get(discoveryIdentityKey(identity));
  return result === undefined ? null : copyCapabilities(result);
}

/**
 * Drop cached maps, so the next discovery starts from "nothing known" again. With an identity only
 * that model's entry is dropped; without one every identity (and in-flight share) is invalidated.
 */
export function resetCapabilities(identity) {
  if (identity === undefined) {
    capabilityCache.clear();
    inFlight.clear();
    cached = null;
    cachedKey = '';
    return;
  }
  const key = discoveryIdentityKey(identity);
  capabilityCache.delete(key);
  inFlight.delete(key);
  if (cachedKey === key) {
    cached = null;
    cachedKey = '';
  }
}

/** Accept `{ gazeX: 'MyInput' }` and `{ gazeX: { input: 'MyInput' } }` alike. */
function declaredInputName(channelMap, channel) {
  const raw = channelMap?.[channel];
  if (typeof raw === 'string') return raw.trim();
  if (raw !== null && typeof raw === 'object') {
    return String(raw.input ?? raw.name ?? '').trim();
  }
  return '';
}

/**
 * Enumerate VTS input parameters, map them onto the motion channels and cache the result.
 *
 * @param {object} options
 * @param {() => Promise<{defaultParameters: object[], customParameters: object[]}>} options.listInputParameters
 *   VTS InputParameterListRequest; a rejection is reported as `ok:false`, never thrown.
 * @param {() => Promise<object>} [options.listModelParameters]
 *   Optional Live2DParameterListRequest probe. Its parameter *names* feed `verified`: a channel
 *   whose target parameter exists can be confirmed when the input name follows the rule table.
 * @param {Record<string, string|{input?: string, name?: string}>} [options.channelMap]
 *   Explicit user-declared input per channel. A valid declaration wins over candidate names and is
 *   reported as `mappingSource:'explicit'`, but it is NOT verified by itself: only a completed
 *   runtime probe (`changed:true`) proves it. A name missing from InputParameterListRequest is
 *   recorded in `mappingInvalid` with reason `unknown-input`; the channel then falls back to the
 *   ordinary candidate search (still unverified) or stays unmapped.
 * @param {{emit?: Function}} [options.log] Event log, used for discovery lifecycle records.
 * @param {{modelId?: string, modelGeneration?: number, connectionGeneration?: number}} [options.identity]
 *   Identity this request is bound to. When given, the cache, the in-flight share and the commit
 *   are all scoped to it; a result that returns after the identity changed is dropped.
 * @param {() => (object|null)} [options.currentIdentity]
 *   Reads the identity that is current *now*. Returning null means "no usable connection".
 * @param {boolean} [options.force] Bypass a cached result, but never a request already in flight.
 * @param {boolean} [options.probeMappings=false]
 *   Explicit opt-in: after name matching, probe gazeX/gazeY at runtime. Off by default so ordinary
 *   discovery stays read-only and does not inject values into the user's model.
 * @param {(input: {inputName: string, parameterNames: string[], value: number}) => Promise<object>}
 *   [options.probeInputMapping] The evidence source, normally `VtsClient.probeInputMapping`.
 * @param {number} [options.probeValue=0.5] Value injected by the diagnostic probe.
 * @returns {Promise<object>} `{ ok, inputs, channels, mapped, verified, mappingUnverified, … }`
 */
export function discoverCapabilities({
  listInputParameters,
  listModelParameters,
  channelMap = {},
  log,
  identity = undefined,
  currentIdentity = undefined,
  force = false,
  probeMappings = false,
  probeInputMapping = undefined,
  probeValue = PROBE_VALUE,
} = {}) {
  const scoped = identity !== undefined && identity !== null;
  const key = scoped ? discoveryIdentityKey(identity) : '';
  const modelId = scoped ? normalizeDiscoveryIdentity(identity).modelId : '';

  const note = async (event, payload) => {
    try {
      await log?.emit?.(event, payload);
    } catch {
      /* logging must never change the discovery result */
    }
  };

  /** Completion check: compare the identity recorded at request time with the current one. */
  const isStillCurrent = () => {
    if (!scoped) return true;
    const current = typeof currentIdentity === 'function' ? currentIdentity() : identity;
    return sameDiscoveryIdentity(current, identity);
  };

  /** Cache and publish a finished map only while its identity is still current. */
  const commit = async (result) => {
    if (!isStillCurrent()) {
      await note('avatar.discovery.dropped', { reason: 'stale-identity', modelId });
      return { ...copyCapabilities(result), stale: true };
    }
    if (scoped) capabilityCache.set(key, result);
    cached = result;
    cachedKey = key;
    if (scoped) await note('avatar.discovery.done', { modelId, ok: result.ok === true });
    return copyCapabilities(result);
  };

  const fail = async (error) => {
    void note('avatar.capabilities.failed', { error });
    return commit({
      ...emptyCapabilities(),
      discovered: true,
      discoveredAt: new Date().toISOString(),
      error,
    });
  };

  // Same identity already in flight wins over both the cache and `force`: one request, one answer.
  if (scoped) {
    const pending = inFlight.get(key);
    if (pending !== undefined) return pending;
  }
  // A completed map for exactly this identity is reused unless the caller demands a re-probe.
  if (scoped && force !== true) {
    const hit = capabilityCache.get(key);
    if (hit !== undefined) return Promise.resolve({ ...copyCapabilities(hit), fromCache: true });
  }

  const run = probeCapabilities({
    listInputParameters, listModelParameters, channelMap, note, fail, commit, scoped, modelId,
    probeMappings, probeInputMapping, probeValue,
  });
  if (scoped) {
    inFlight.set(key, run);
    const release = () => {
      if (inFlight.get(key) === run) inFlight.delete(key);
    };
    void run.then(release, release);
  }
  return run;
}

/**
 * Optional runtime evidence for gaze channels. A probe outcome is allowed to *downgrade* a
 * name-rule verification (or confirm it), never to remove the injectable channel or its input:
 * a failed diagnostic means "not proven", not "the eye cannot be driven at all".
 *
 * Only `changed:true` from a successful probe keeps `verified`; a timeout, an error or an unchanged
 * parameter value sets `mappingUnverified:true` and `verified:false`. Returns a non-empty
 * `probeError` only when probing was requested but could not be configured.
 */
async function probeChannelMappings({ channels, probeMappings, probeInputMapping, probeValue, note }) {
  if (probeMappings !== true) return '';
  if (typeof probeInputMapping !== 'function') {
    return 'probeMappings 已开启，但没有提供 probeInputMapping';
  }
  const value = Number.isFinite(Number(probeValue)) ? Number(probeValue) : PROBE_VALUE;
  for (const channel of channels) {
    if (!PROBE_CHANNEL_ORDER.includes(channel.channel)) continue;
    if (channel.injectable !== true || channel.inputName.length === 0) continue;
    if (!Array.isArray(channel.modelParams) || channel.modelParams.length === 0) continue;

    let outcome;
    try {
      outcome = await probeInputMapping({
        inputName: channel.inputName,
        parameterNames: [...channel.modelParams],
        value,
      });
    } catch (error) {
      outcome = { ok: false, changed: false, error: error?.message ?? String(error) };
    }
    // `changed` is the decisive evidence. An explicit ok:false still wins (a contradictory
    // "changed" from a failed probe is not proof); a probe that omits ok is accepted by `changed`.
    const changed = outcome?.ok !== false && outcome?.changed === true;
    channel.verified = changed;
    channel.mappingUnverified = changed !== true;
    channel.probe = {
      ok: outcome?.ok === true,
      changed,
      value,
      error: String(outcome?.error ?? ''),
    };
    if (outcome?.delta !== null && typeof outcome?.delta === 'object') {
      channel.probe.delta = { ...outcome.delta };
    }
    if (changed) {
      channel.notes = `运行期探测确认 ${channel.inputName} 改变 ${channel.modelParams.join('、')}（阈值 0.01）`;
    } else {
      const reason = channel.probe.error.length > 0 ? `：${channel.probe.error}` : '：参数值未达到变化阈值';
      channel.notes = `运行期探测未确认 ${channel.inputName} 驱动 ${channel.modelParams.join('、')}${reason}；保留通道并标记 mappingUnverified`;
    }
    await note('avatar.mapping.probe', {
      channel: channel.channel,
      input: channel.inputName,
      changed,
      ok: channel.probe.ok,
      error: channel.probe.error,
    });
  }
  return '';
}

/** A probe/diagnostic failure is data: never let an unexpected rejection escape the caller. */
const probeErrorText = (error) => String(error?.message ?? error ?? 'unknown error');

/** Keep only numeric/null values: a probe result is evidence, never a page of transport payload. */
function sanitizeProbeDelta(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const delta = {};
  for (const [name, value] of Object.entries(raw)) {
    if (value === null) {
      delta[String(name)] = null;
    } else if (Number.isFinite(Number(value))) {
      delta[String(name)] = Number(value);
    }
  }
  return delta;
}

/**
 * Run one probe with a hard timeout. The timeout never rejects and never leaves an unhandled
 * rejection behind: a late settlement is simply ignored after the safe failure was returned.
 */
function probeWithTimeout(probeInputMapping, request, timeoutMs) {
  const call = Promise.resolve()
    .then(() => probeInputMapping(request))
    .then(
      (value) => ({ timedOut: false, value, error: '' }),
      (error) => ({ timedOut: false, value: null, error: probeErrorText(error) }),
    );
  let timer = null;
  const timeout = new Promise((resolve) => {
    if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) return;
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([call, timeout]).then((settled) => {
    if (timer !== null) clearTimeout(timer);
    if (settled?.timedOut === true) {
      return {
        ok: false,
        changed: false,
        delta: {},
        error: `mapping probe timed out after ${timeoutMs} ms`,
      };
    }
    if (settled?.error) return { ok: false, changed: false, delta: {}, error: settled.error };
    return settled?.value;
  });
}

/**
 * Explicit gaze-mapping probe. It is deliberately a pure operation over caller-supplied channel
 * rows: no cache is touched, no discovery runs and no value is written outside `probeInputMapping`
 * (normally `VtsClient.probeInputMapping`, which already pauses its frame loop while measuring).
 *
 * A row qualifies only when it has a concrete `inputName` and at least one `modelParams` target.
 * Only `changed:true` from a completed probe is evidence; an unchanged/failed/timeout probe keeps
 * the channel in `channels` and lists it in `mappingUnverified`. The result contains no paths,
 * page text or raw transport payload.
 *
 * @param {object} options
 * @param {object[]|{channels?: object[]}} options.channels Capability rows (or a capability snapshot).
 * @param {(input: {inputName: string, parameterNames: string[], value: number}) => Promise<object>}
 *   options.probeInputMapping
 * @param {number} [options.probeValue=0.5]
 * @param {number} [options.timeoutMs=5000]
 * @param {() => number} [options.now]
 * @returns {Promise<{ok: boolean, channels: object, mappingUnverified: string[], at: string,
 *   error: string}>}
 */
export async function probeGazeMapping({
  channels = [],
  probeInputMapping = undefined,
  probeValue = PROBE_VALUE,
  timeoutMs = PROBE_TIMEOUT_MS,
  now = Date.now,
} = {}) {
  const readAt = () => {
    const value = typeof now === 'function' ? Number(now()) : Date.now();
    return new Date(Number.isFinite(value) ? value : Date.now()).toISOString();
  };
  const rows = Array.isArray(channels)
    ? channels
    : (Array.isArray(channels?.channels) ? channels.channels : []);

  const candidates = [];
  const seen = new Set();
  for (const entry of rows) {
    const channel = String(entry?.channel ?? '');
    if (!PROBE_CHANNEL_ORDER.includes(channel) || seen.has(channel)) continue;
    if (entry?.injectable === false) continue;
    const inputName = String(entry?.inputName ?? '').trim();
    const parameterNames = (Array.isArray(entry?.modelParams) ? entry.modelParams : [])
      .map((name) => String(name ?? '').trim())
      .filter((name) => name.length > 0);
    if (inputName.length === 0 || parameterNames.length === 0) continue;
    seen.add(channel);
    candidates.push({ channel, inputName, parameterNames });
  }

  if (candidates.length === 0) {
    return {
      ok: false,
      channels: {},
      mappingUnverified: [],
      at: readAt(),
      error: '没有可探测的视线映射（需要已发现的 gazeX/gazeY 输入与模型参数）',
    };
  }
  if (typeof probeInputMapping !== 'function') {
    return {
      ok: false,
      channels: {},
      mappingUnverified: [],
      at: readAt(),
      error: 'probeInputMapping 不可用',
    };
  }

  const value = Number.isFinite(Number(probeValue)) ? Number(probeValue) : PROBE_VALUE;
  const resultChannels = {};
  const mappingUnverified = [];
  let ok = true;
  let firstError = '';

  for (const candidate of candidates) {
    const outcome = await probeWithTimeout(probeInputMapping, {
      inputName: candidate.inputName,
      parameterNames: [...candidate.parameterNames],
      value,
    }, timeoutMs);
    const completed = outcome !== null && typeof outcome === 'object' && outcome.ok !== false
      && outcome.timedOut !== true;
    const changed = completed && outcome.changed === true;
    const error = String(outcome?.error ?? '') || (completed ? '' : 'mapping probe failed');
    if (!completed) ok = false;
    if (error.length > 0 && firstError.length === 0) firstError = error;
    resultChannels[candidate.channel] = {
      inputName: candidate.inputName,
      parameterNames: [...candidate.parameterNames],
      changed,
      delta: sanitizeProbeDelta(outcome?.delta),
      error,
    };
    if (!changed) mappingUnverified.push(candidate.channel);
  }

  return {
    ok: ok && candidates.length > 0,
    channels: resultChannels,
    mappingUnverified,
    at: readAt(),
    error: firstError,
  };
}

/** Probe one capability map; caching, identity verification and lifecycle events belong to the caller. */
async function probeCapabilities({
  listInputParameters, listModelParameters, channelMap, note, fail, commit, scoped, modelId,
  probeMappings, probeInputMapping, probeValue,
}) {
  if (scoped) await note('avatar.discovery.start', { modelId });

  if (typeof listInputParameters !== 'function') {
    return fail('能力发现需要 listInputParameters');
  }

  let pool;
  try {
    pool = await listInputParameters();
  } catch (error) {
    return fail(error?.message ?? String(error));
  }

  const normalize = (entry) => ({
    name: String(entry?.name ?? ''),
    min: Number(entry?.min ?? 0),
    max: Number(entry?.max ?? 1),
    defaultValue: Number(entry?.defaultValue ?? 0),
  });
  const defaults = (Array.isArray(pool?.defaultParameters) ? pool.defaultParameters : [])
    .map(normalize)
    .filter((entry) => entry.name.length > 0)
    .map((entry) => ({ ...entry, source: 'default' }));
  const customs = (Array.isArray(pool?.customParameters) ? pool.customParameters : [])
    .map(normalize)
    .filter((entry) => entry.name.length > 0)
    .map((entry) => ({ ...entry, source: 'custom' }));

  if (defaults.length === 0 && customs.length === 0) {
    return fail('VTS 没有返回任何可注入的输入参数');
  }

  // Defaults are indexed first, so a custom input that reuses a default name cannot shadow it.
  const byName = new Map();
  for (const entry of [...defaults, ...customs]) {
    const key = normalizeName(entry.name);
    if (!byName.has(key)) byName.set(key, entry);
  }

  // The model's own parameters are evidence only; they are not injectable.
  const modelParameters = [];
  let model = { ok: false, source: '', count: 0, error: '' };
  if (typeof listModelParameters === 'function') {
    try {
      const result = await listModelParameters();
      const list = Array.isArray(result?.parameters) ? result.parameters : [];
      for (const entry of list) {
        const name = String(entry?.name ?? '').trim();
        if (name.length > 0 && !modelParameters.includes(name)) modelParameters.push(name);
      }
      model = result?.ok === true
        ? {
            ok: true,
            source: String(result.source ?? ''),
            count: modelParameters.length,
            error: '',
          }
        : { ok: false, source: '', count: 0, error: String(result?.error ?? 'model parameters unavailable') };
    } catch (error) {
      model = { ok: false, source: '', count: 0, error: error?.message ?? String(error) };
    }
  }
  const modelByLower = new Map(modelParameters.map((name) => [normalizeName(name), name]));
  const modelHas = (name) => modelByLower.has(normalizeName(name));

  const buildChannel = (channel) => {
    const rule = MODEL_TARGET_RULES[channel] ?? null;
    const rules = rule === null
      ? []
      : [rule, ...(MODEL_TARGET_RULE_ALIASES[channel] ?? [])];
    const targets = [...new Set(rules.map((entry) => entry.target))];
    const presentTargets = targets.filter((name) => modelHas(name)).map((name) => modelByLower.get(normalizeName(name)));
    const declaredName = declaredInputName(channelMap, channel);

    // A valid explicit mapping wins over every candidate name. An unknown explicit name is kept as
    // evidence (`mappingInvalid`/`unknown-input`) but never silently enabled: the ordinary candidate
    // search runs instead, and the resulting row stays unverified.
    let hit = null;
    let inputSource = '';
    let explicit = false;
    let mappingInvalid = false;
    if (declaredName.length > 0) {
      const found = byName.get(normalizeName(declaredName));
      if (found !== undefined) {
        hit = found;
        inputSource = 'declared';
        explicit = true;
      } else {
        mappingInvalid = true;
      }
    }
    if (hit === null) {
      for (const candidate of PARAMETER_CANDIDATES[channel] ?? []) {
        const found = byName.get(normalizeName(candidate));
        if (found !== undefined) {
          hit = found;
          inputSource = found.source;
          break;
        }
      }
    }
    const common = {
      mappingSource: explicit ? 'explicit' : '',
      mappingInvalid,
      mappingInvalidReason: mappingInvalid ? 'unknown-input' : '',
      declaredInputName: declaredName,
    };

    if (hit === null) {
      return {
        channel,
        inputName: '',
        inputSource: '',
        injectable: false,
        verified: false,
        mappingUnverified: false,
        ...common,
        modelParams: presentTargets,
        min: 0,
        max: 1,
        defaultValue: 0,
        probe: null,
        notes: mappingInvalid
          ? `显式配置的输入 ${declaredName} 不在 InputParameterListRequest 里（unknown-input），且没有候选输入可回退`
          : declaredName.length > 0
            ? `显式配置的输入 ${declaredName} 不在 InputParameterListRequest 里`
            : '未找到可注入输入或匹配的模型参数；这不证明模型没有该部位，可能只是命名或发现规则不匹配',
      };
    }

    const matched = rules.find((entry) => normalizeName(hit.name) === normalizeName(entry.input)) ?? null;
    // An explicit mapping is only evidence that the user picked a name — not proof that VTS wires
    // it to the model. It stays unverified until a runtime probe says `changed:true`.
    const verified = explicit === true
      ? false
      : mappingInvalid !== true && matched !== null && presentTargets.length > 0;
    const mappingUnverified = explicit === true || (mappingInvalid === true && hit !== null);
    const notes = explicit
      ? `用户显式映射 ${hit.name} → ${channel}（mappingSource:explicit）；仍需运行期探测确认`
      : mappingInvalid
        ? `显式配置的输入 ${declaredName} 不在 InputParameterListRequest 里（unknown-input），回退候选 ${hit.name}；该候选仍需验证`
        : verified
          ? `名称规则 ${hit.name} → ${matched.target}，且模型参数列表中存在 ${matched.target}；VTS 内部映射不可读，仍可能被改过`
          : '自动名称匹配候选：名字可注入，但没有证据表明它驱动该部位';

    return {
      channel,
      inputName: hit.name,
      inputSource,
      injectable: true,
      verified,
      mappingUnverified,
      ...common,
      modelParams: presentTargets,
      min: hit.min,
      max: hit.max,
      defaultValue: hit.defaultValue,
      probe: null,
      notes,
    };
  };

  const channels = CHANNEL_ORDER.map(buildChannel);
  const probeError = await probeChannelMappings({
    channels, probeMappings, probeInputMapping, probeValue, note,
  });
  const inputs = Object.fromEntries(
    channels.map((entry) => [entry.channel, entry.injectable ? entry : null]),
  );
  const mapped = channels.filter((entry) => entry.injectable).map((entry) => entry.channel);
  const verified = channels.filter((entry) => entry.verified).map((entry) => entry.channel);
  const mappingUnverified = channels
    .filter((entry) => entry.mappingUnverified === true)
    .map((entry) => entry.channel);
  const mappingInvalid = channels
    .filter((entry) => entry.mappingInvalid === true)
    .map((entry) => entry.channel);
  const mappingSources = Object.fromEntries(
    channels
      .filter((entry) => entry.mappingSource === 'explicit')
      .map((entry) => [entry.channel, entry.mappingSource]),
  );
  const unmapped = channels.filter((entry) => !entry.injectable).map((entry) => entry.channel);

  return commit({
    discovered: true,
    ok: true,
    inputs,
    channels,
    mapped,
    verified,
    mappingUnverified,
    mappingInvalid,
    mappingSources,
    unmapped,
    model,
    parameterCount: { default: defaults.length, custom: customs.length },
    declared: CHANNEL_ORDER.filter((channel) => declaredInputName(channelMap, channel).length > 0),
    discoveredAt: new Date().toISOString(),
    probeError,
    error: '',
  });
}
