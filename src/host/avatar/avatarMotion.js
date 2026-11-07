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
 *   verified   — something says that input really drives this part of the model. Either the user
 *                declared the mapping, or the model's parameter list contains the partner
 *                parameter named by the explicit rule table below.
 *
 * Automatic name matching alone only ever produces a *candidate* (injectable, not verified).
 * Nothing here injects values — sending belongs to the motion stage (VtsClient.injectInputs).
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
  'breath',
];

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
  unmapped: [...CHANNEL_ORDER],
  model: { ok: false, source: '', count: 0, error: '' },
  parameterCount: { default: 0, custom: 0 },
  declared: [],
  discoveredAt: '',
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
  const copyEntry = (entry) => (entry === null || entry === undefined
    ? null
    : { ...entry, modelParams: [...(entry.modelParams ?? [])] });
  return {
    ...base,
    inputs: Object.fromEntries(
      Object.entries(base.inputs).map(([channel, entry]) => [channel, copyEntry(entry)]),
    ),
    channels: (base.channels ?? []).map((entry) => copyEntry(entry)),
    mapped: [...base.mapped],
    verified: [...base.verified],
    unmapped: [...base.unmapped],
    declared: [...(base.declared ?? [])],
    model: { ...base.model },
    parameterCount: { ...base.parameterCount },
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
 *   User-declared input per channel. A declaration is trusted (verified), because only the user
 *   knows which custom input they wired to which part of the model.
 * @param {{emit?: Function}} [options.log] Event log, used for discovery lifecycle records.
 * @param {{modelId?: string, modelGeneration?: number, connectionGeneration?: number}} [options.identity]
 *   Identity this request is bound to. When given, the cache, the in-flight share and the commit
 *   are all scoped to it; a result that returns after the identity changed is dropped.
 * @param {() => (object|null)} [options.currentIdentity]
 *   Reads the identity that is current *now*. Returning null means "no usable connection".
 * @param {boolean} [options.force] Bypass a cached result, but never a request already in flight.
 * @returns {Promise<object>} `{ ok, inputs, channels, mapped, verified, unmapped, model, … }`
 */
export function discoverCapabilities({
  listInputParameters,
  listModelParameters,
  channelMap = {},
  log,
  identity = undefined,
  currentIdentity = undefined,
  force = false,
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

/** Probe one capability map; caching, identity verification and lifecycle events belong to the caller. */
async function probeCapabilities({ listInputParameters, listModelParameters, channelMap, note, fail, commit, scoped, modelId }) {
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

    let hit = null;
    let inputSource = '';
    if (declaredName.length > 0) {
      const found = byName.get(normalizeName(declaredName));
      if (found !== undefined) {
        hit = found;
        inputSource = 'declared';
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

    if (hit === null) {
      return {
        channel,
        inputName: '',
        inputSource: '',
        injectable: false,
        verified: false,
        modelParams: presentTargets,
        min: 0,
        max: 1,
        defaultValue: 0,
        notes: declaredName.length > 0
          ? `显式配置的输入 ${declaredName} 不在 InputParameterListRequest 里`
          : '没有可注入输入匹配该通道',
      };
    }

    const matched = rules.find((entry) => normalizeName(hit.name) === normalizeName(entry.input)) ?? null;
    const verified = inputSource === 'declared' || (matched !== null && presentTargets.length > 0);
    const notes = inputSource === 'declared'
      ? `用户显式映射 ${hit.name} → ${channel}`
      : verified
        ? `名称规则 ${hit.name} → ${matched.target}，且模型参数列表中存在 ${matched.target}；VTS 内部映射不可读，仍可能被改过`
        : '自动名称匹配候选：名字可注入，但没有证据表明它驱动该部位';

    return {
      channel,
      inputName: hit.name,
      inputSource,
      injectable: true,
      verified,
      modelParams: presentTargets,
      min: hit.min,
      max: hit.max,
      defaultValue: hit.defaultValue,
      notes,
    };
  };

  const channels = CHANNEL_ORDER.map(buildChannel);
  const inputs = Object.fromEntries(
    channels.map((entry) => [entry.channel, entry.injectable ? entry : null]),
  );
  const mapped = channels.filter((entry) => entry.injectable).map((entry) => entry.channel);
  const verified = channels.filter((entry) => entry.verified).map((entry) => entry.channel);
  const unmapped = channels.filter((entry) => !entry.injectable).map((entry) => entry.channel);

  return commit({
    discovered: true,
    ok: true,
    inputs,
    channels,
    mapped,
    verified,
    unmapped,
    model,
    parameterCount: { default: defaults.length, custom: customs.length },
    declared: CHANNEL_ORDER.filter((channel) => declaredInputName(channelMap, channel).length > 0),
    discoveredAt: new Date().toISOString(),
    error: '',
  });
}
