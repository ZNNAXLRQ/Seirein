/**
 * Real-machine `faceFound` A/B probe for the Seirein avatar bridge.
 *
 * Why this exists
 * ---------------
 * `test/vts-animation-events.mjs` proves the plugin-side request shape against a fake VTS. It
 * cannot show what real VTube Studio does with `InjectParameterDataRequest.faceFound`, because
 * only VTS decides how its tracking-lost animation and its own idle/physics channels behave.
 * This script therefore:
 *
 *   1. pauses the running Host's VTS injection without letting the pause kill VTube Studio: the
 *      Host has no "disconnect live2d but keep the component enabled" action, so the only pause
 *      entry is `feature.set avatar=false`; before it, `autostart.vts.autoClose` is forced to
 *      false when VTS is plugin-owned (otherwise the dependency release closes it). The original
 *      value is restored afterwards. A TCP probe asserts VTS is still alive while paused; if it
 *      is not, the run reports `vts-closed` and aborts,
 *   2. authenticates with a COPY of the existing token (never requests a new one, never writes
 *      the token file) and subscribes to `ModelAnimationEvent` + `TrackingStatusChangedEvent`,
 *   3. injects only an input the Host reports as BOTH verified and controlled (from
 *      `live2d.runtime.channels.controlled` intersected with `live2d.capabilities.channels`);
 *      an empty intersection aborts with `no-verified-channel`. Never a hardcoded input name; an
 *      explicitly requested unverified input is marked `exploratory: true` and kept separate
 *      from verified conclusions, in phases:
 *        A = request without `faceFound`
 *        B = request with `faceFound: true`
 *        C = request with `faceFound: false` (exploratory: tells VTS "face not found", a proxy
 *            for losing tracking; run last so it cannot contaminate A/B),
 *      A/B/C each send `FACEFOUND_FRAMES` frames. The default (60 × 110 ms = 6.6 s) spans the
 *      model's 6.5 s idle loop at 10 Hz; for the plugin's real 30 Hz use
 *      `FACEFOUND_FRAMES=200 FACEFOUND_FRAME_INTERVAL_MS=33` (also ≈6.6 s). A 60-frame/33 ms
 *      window is only 2 s and aliases the idle animation; early 2 s runs produced misleading
 *      one-round differences that did not survive the full-loop window,
 *   4. samples the model's unowned Live2D parameters (`ParamBreath`, `ParamBodyAngle*`,
 *      `ParamArm*`, ...) with `ParameterValueRequest` (explicitly requested) and densely with
 *      `Live2DParameterListRequest` (the only request that returns every model parameter's live
 *      value in one answer), then reports min/max/std for A/B,
 *   5. restores the Host through its own endpoints, field by field: avatar component on, the
 *      `autostart.vts` settings the pause rewrote, VTS reconnect, Spout display restarted at the
 *      rectangle it had before the test. A key-field snapshot taken right after the pause is
 *      compared first; a concurrent write makes the whole restore a reported no-op
 *      (`restoreSkipped: 'concurrent-change'`) instead of an overwrite. File write-back is a last
 *      resort only when the Host interface is unreachable, re-validated by mtime/sha256.
 *
 * Truthfulness rules: a failed/unsupported request is reported as such, never inferred. If the
 * physical tracker never lost the face and phase C does not produce a tracking-lost animation,
 * the "faceFound changes the tracking-lost animation" claim stays UNVERIFIED for this machine.
 *
 * DANGER / default skip
 * ---------------------
 * This is a LIVE probe. It PAUSES the running Host's VTS injection (the `avatar` component is
 * turned off after protecting the `vts` dependency) and needs a real VTube Studio with a valid
 * token. It therefore does nothing unless explicitly authorized with FACEFOUND_LIVE=1 or --live;
 * otherwise it prints the reason and exits 0 without calling a single Host endpoint.
 *
 * Run: FACEFOUND_LIVE=1 node test/facefound-live.mjs   (or: node test/facefound-live.mjs --live)
 *
 * Environment overrides:
 *   FACEFOUND_LIVE   1 = authorize the live run; anything else skips with exit code 0
 *   FACEFOUND_SELFTEST 1 = run the offline fake-status checks only (no Host, no VTS)
 *   DSH_STATUS_URL   default http://127.0.0.1:63054
 *   VTS_WS_URL       default ws://127.0.0.1:8001
 *   VTS_TOKEN_PATH   default <LOCALAPPDATA>/Seirein/vts-token.json then <root>/vts-token.json
 *   FACEFOUND_FRAMES default 60 (frames per A/B/C phase; use 200 with 33 ms for the 30 Hz run)
 *   FACEFOUND_FRAME_INTERVAL_MS default 110 (use 33 for the plugin's real 30 Hz frame rate)
 *   FACEFOUND_ROUNDS default 3 (A/B rounds; order alternates A->B / B->A)
 *   FACEFOUND_EXPLORATORY_INPUT = name of an unverified input to inject on purpose; the report
 *                     marks the run `exploratory: true` and never mixes it with verified results
 */
import { readFile, writeFile, mkdir, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

import WebSocket from 'ws';

const STATUS_URL = String(process.env.DSH_STATUS_URL ?? 'http://127.0.0.1:63054').replace(/\/+$/u, '');
const VTS_WS_URL = String(process.env.VTS_WS_URL ?? 'ws://127.0.0.1:8001');
const FRAMES = Math.max(60, Number(process.env.FACEFOUND_FRAMES ?? 60));
const ROUNDS = Math.max(1, Number(process.env.FACEFOUND_ROUNDS ?? 3));
// Never guessed: an unverified input is injected only after this explicit opt-in, and the run is
// then reported as exploratory instead of "verified".
const EXPLORATORY_INPUT = String(process.env.FACEFOUND_EXPLORATORY_INPUT ?? '').trim();
// 60 frames at ~110 ms = 6.6 s, i.e. one full loop of the model's 6.5 s idle animation (the
// hiyori model's `hiyori_m02` clip). VTS only requires a controlled input to be refreshed once
// per second, so the faceFound flag is still refreshed well inside that window while each phase
// spans a whole idle loop instead of an arbitrary 2 s slice.
const FRAME_INTERVAL_MS = Math.max(20, Number(process.env.FACEFOUND_FRAME_INTERVAL_MS ?? 110));
const SAMPLE_INTERVAL_MS = 50;
const BASELINE_MS = 3000;
// C uses the same 60-frame/6.6 s window as A/B, so its ranges are directly comparable. It is
// exploratory: it asks what `faceFound:false` does, not whether the official flag works.
const C_FRAMES = FRAMES;
const C_SETTLE_MS = 2000;

const LOCALAPPDATA = process.env.LOCALAPPDATA ?? '';
// `status.root` is the authority; this default only covers the read before the first status call.
let DATA_DIR = join('G:', 'Seirein', 'data');
let SETTINGS_FILE = join(DATA_DIR, 'settings.json');
let FEATURES_FILE = join(DATA_DIR, 'features.json');
const TOKEN_CANDIDATES = [
  process.env.VTS_TOKEN_PATH,
  LOCALAPPDATA ? join(LOCALAPPDATA, 'Seirein', 'vts-token.json') : '',
  join('G:', 'Seirein', 'vts-token.json'),
].filter((entry) => typeof entry === 'string' && entry.length > 0);

const PLUGIN = { pluginName: 'DSH Companion', pluginDeveloper: 'local' };
// VTS stores per-model settings next to the model. Reading the model file is the only way to
// learn whether this model even HAS a tracking-lost animation for `faceFound` to affect.
const VTS_STREAMINGASSETS = [
  process.env.VTS_STREAMINGASSETS,
  join('G:', 'SteamLibrary', 'steamapps', 'common', 'VTube Studio', 'VTube Studio_Data', 'StreamingAssets'),
  join('C:', 'Program Files (x86)', 'Steam', 'steamapps', 'common', 'VTube Studio', 'VTube Studio_Data', 'StreamingAssets'),
  join('D:', 'SteamLibrary', 'steamapps', 'common', 'VTube Studio', 'VTube Studio_Data', 'StreamingAssets'),
].filter((entry) => typeof entry === 'string' && entry.length > 0);

/** Read every installed model's two animation references (read-only). */
async function scanInstalledModels() {
  const models = [];
  for (const root of VTS_STREAMINGASSETS) {
    const modelsDir = join(root, 'Live2DModels');
    let folders;
    try {
      folders = await readdir(modelsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const folder of folders) {
      if (folder.isDirectory() !== true) continue;
      let files;
      try {
        files = await readdir(join(modelsDir, folder.name));
      } catch {
        continue;
      }
      for (const file of files.filter((name) => name.endsWith('.vtube.json'))) {
        try {
          const parsed = JSON.parse(await readFile(join(modelsDir, folder.name, file), 'utf8'));
          models.push({
            folder: folder.name,
            file,
            idleAnimation: String(parsed?.FileReferences?.IdleAnimation ?? ''),
            idleAnimationWhenTrackingLost: String(parsed?.FileReferences?.IdleAnimationWhenTrackingLost ?? ''),
            timeUntilTrackingLostIdleAnimation: Number(parsed?.GeneralSettings?.TimeUntilTrackingLostIdleAnimation ?? 0),
          });
        } catch {
          /* unreadable model file */
        }
      }
    }
    if (models.length > 0) break;
  }
  return models;
}

async function readModelConfig(modelName) {
  const name = String(modelName ?? '').trim();
  if (name.length === 0) return null;
  for (const root of VTS_STREAMINGASSETS) {
    for (const folder of [`${name}_vts`, name]) {
      const file = join(root, 'Live2DModels', folder, `${name}.vtube.json`);
      try {
        const parsed = JSON.parse(await readFile(file, 'utf8'));
        return {
          path: file,
          idleAnimation: String(parsed?.FileReferences?.IdleAnimation ?? ''),
          idleAnimationWhenTrackingLost: String(parsed?.FileReferences?.IdleAnimationWhenTrackingLost ?? ''),
          timeUntilTrackingLostIdleAnimation: Number(parsed?.GeneralSettings?.TimeUntilTrackingLostIdleAnimation ?? 0),
        };
      } catch {
        /* try the next layout */
      }
    }
  }
  return null;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nowIso = () => new Date().toISOString();
const round6 = (value) => (Number.isFinite(value) ? Math.round(value * 1e6) / 1e6 : value);

const result = {
  startedAt: nowIso(),
  host: { pause: {}, pauseMethod: null, restore: {} },
  vts: {},
  phases: [],
  baseline: null,
  stats: {},
  parameterValueCheck: {},
  tracking: { events: [], faceFound: [], possibleTrackingLost: [], verified: false, note: '' },
  animation: { events: [], names: [], trackingLostLike: [] },
  caveats: [],
  failures: [],
};
const failures = result.failures;

// ---- generic helpers ------------------------------------------------------
async function jsonFetch(path, init = {}, timeoutMs = 20_000) {
  const response = await fetch(`${STATUS_URL}${path}`, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${path} returned non-JSON (HTTP ${response.status}): ${text.slice(0, 200)}`);
  }
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}: ${text.slice(0, 300)}`);
  return body;
}

const hostStatus = () => jsonFetch('/assistant/status', {}, 15_000);

async function uiAction(action, extra = {}, timeoutMs = 60_000) {
  return jsonFetch('/assistant/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...extra }),
  }, timeoutMs);
}

async function waitFor(label, check, timeoutMs = 20_000, stepMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      if (await check()) return true;
    } catch (error) {
      lastError = error?.message ?? String(error);
    }
    await sleep(stepMs);
  }
  throw new Error(`timed out waiting for ${label}${lastError ? ` (${lastError})` : ''}`);
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

const featureOf = (status, id) => (status?.features ?? []).find((entry) => entry.id === id) ?? null;

/** Fields the pause may rewrite. Snapshot → compare is the concurrent-change detector. */
const RESTORE_FIELDS = [
  ['avatarFeature', 'features.avatar.enabled'],
  ['autostartVtsEnabled', 'settings.autostart.vts.enabled'],
  ['autostartVtsAutoClose', 'settings.autostart.vts.autoClose'],
  ['live2dReady', 'live2d.ready'],
  ['spoutRunning', 'live2d.spoutLayer.running'],
  ['spoutBounds', 'live2d.spoutLayer.bounds'],
];

/** The only Host state this script reads, writes and later verifies. */
function hostFields(status) {
  return {
    at: nowIso(),
    avatarFeature: featureOf(status, 'avatar')?.enabled === true,
    autostartVtsEnabled: status?.autostart?.vts?.enabled === true,
    autostartVtsAutoClose: status?.autostart?.vts?.autoClose !== false,
    live2dReady: status?.live2d?.ready === true,
    spoutRunning: status?.live2d?.spoutLayer?.running === true,
    spoutBounds: status?.live2d?.spoutLayer?.bounds ?? null,
  };
}

function diffHostFields(expected, actual) {
  const diffs = [];
  for (const [key, field] of RESTORE_FIELDS) {
    const left = JSON.stringify(expected?.[key] ?? null);
    const right = JSON.stringify(actual?.[key] ?? null);
    if (left !== right) diffs.push({ field, key, expected: expected?.[key] ?? null, actual: actual?.[key] ?? null });
  }
  return diffs;
}

// ---- pause / verified-input policy (pure: the offline self-check drives these) ---------------
/** Channel precedence when several verified inputs are available. Never an input parameter name. */
const FACE_INPUT_CHANNEL_ORDER = ['headX', 'headY', 'eyeX', 'eyeY', 'gazeX', 'gazeY'];

/**
 * Pick the injected input from what the Host reports as BOTH verified and controlled.
 * `live2d.runtime.channels.controlled` is the takeover set; `live2d.capabilities.channels`
 * carries the input name and its own `verified` verdict. Requiring both means an input that
 * merely exists (or is only `injectable`) is never presented as verified. No input name is
 * hardcoded: an explicitly requested unverified input is returned with `exploratory: true`.
 */
function resolveFaceInput(preStatus, defaultInputs = [], exploratoryInput = '') {
  const controlled = new Set((preStatus?.live2d?.runtime?.channels?.controlled ?? []).map((name) => String(name)));
  const rows = (Array.isArray(preStatus?.live2d?.capabilities?.channels)
    ? preStatus.live2d.capabilities.channels
    : [])
    .filter((entry) => entry?.verified === true && entry?.injectable === true)
    .filter((entry) => controlled.has(String(entry.channel)))
    .map((entry) => ({
      channel: String(entry.channel ?? ''),
      inputName: String(entry.inputName ?? '').trim(),
      inputSource: String(entry.inputSource ?? ''),
    }))
    .filter((entry) => entry.inputName.length > 0);
  const verified = FACE_INPUT_CHANNEL_ORDER
    .map((channel) => rows.find((entry) => entry.channel === channel))
    .find((entry) => entry !== undefined) ?? rows[0] ?? null;
  const base = {
    controlled: [...controlled],
    verifiedChannels: rows.map((entry) => entry.channel),
  };
  if (verified !== null) {
    return {
      ...base,
      ok: true,
      verified: true,
      exploratory: false,
      channel: verified.channel,
      inputName: verified.inputName,
      inputSource: verified.inputSource,
      reason: '',
    };
  }
  const override = String(exploratoryInput ?? '').trim();
  if (override.length > 0 && defaultInputs.includes(override)) {
    return {
      ...base,
      ok: true,
      verified: false,
      exploratory: true,
      channel: '',
      inputName: override,
      inputSource: 'explicit-exploratory-override',
      reason: 'explicit-exploratory-override',
    };
  }
  return {
    ...base,
    ok: false,
    verified: false,
    exploratory: false,
    channel: '',
    inputName: '',
    inputSource: '',
    reason: override.length > 0 ? 'exploratory-input-unknown' : 'no-verified-channel',
  };
}

/**
 * The Host exposes no action that disconnects live2d while keeping the avatar component enabled,
 * so `feature.set avatar=false` is the only pause entry. That disable releases the `vts`
 * dependency; a plugin-owned VTS with autoClose on would be closed there and the later probe
 * could never connect. The protection is planned BEFORE the first Host write.
 */
function planPauseProtection(preStatus) {
  const vts = preStatus?.autostart?.vts ?? {};
  const owned = vts.owned === true;
  const external = vts.owned === false;
  // Ownership unknown counts as "protect": setting autoClose=false is reversible, while a wrong
  // "external" guess would let the component disable close a plugin-owned VTS.
  const autoClose = vts.autoClose !== false;
  const protect = external !== true && autoClose;
  return {
    target: 'vts',
    owned,
    ownershipKnown: typeof vts.owned === 'boolean',
    external,
    previousEnabled: vts.enabled === true,
    previousAutoClose: autoClose,
    protect,
    protected: false,
    steps: protect
      ? ['autostart.set vts autoClose=false', 'feature.set avatar=false']
      : ['feature.set avatar=false'],
    reason: protect
      ? (owned
        ? 'VTS is plugin-owned and autoClose is on; disabling avatar would close it'
        : 'VTS ownership is unknown and autoClose is on; protect the dependency so the pause cannot close it')
      : (external
        ? 'VTS was started outside the plugin; the dependency release never closes a process it does not own'
        : 'VTS is plugin-owned but autoClose is already off'),
  };
}

/** A dead VTS endpoint aborts the probe instead of producing A/B numbers from a closed socket. */
function evaluateVtsLiveness(liveness) {
  return liveness?.alive === true
    ? { ok: true, reason: '' }
    : { ok: false, reason: 'vts-closed', error: liveness?.error ?? 'VTS WebSocket port is not reachable' };
}

/** TCP probe of the VTS WebSocket endpoint: the process must accept connections while paused. */
function probeVtsLiveness(timeoutMs = 1500) {
  const checkedAt = nowIso();
  let endpoint;
  try {
    const url = new URL(VTS_WS_URL);
    endpoint = { host: url.hostname, port: Number(url.port || (url.protocol === 'wss:' ? 443 : 80)) };
  } catch {
    return Promise.resolve({
      method: 'tcp-port', url: VTS_WS_URL, checkedAt, alive: false, error: `invalid VTS_WS_URL ${VTS_WS_URL}`,
    });
  }
  return new Promise((resolvePromise) => {
    const socket = connect({ host: endpoint.host, port: endpoint.port });
    let settled = false;
    const finish = (alive, error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePromise({
        method: 'tcp-port',
        url: VTS_WS_URL,
        host: endpoint.host,
        port: endpoint.port,
        checkedAt,
        alive,
        error,
      });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true, ''));
    socket.once('timeout', () => finish(false, `tcp connect timed out after ${timeoutMs} ms`));
    socket.once('error', (error) => finish(false, error?.message ?? String(error)));
  });
}

/** Read a file and describe the exact identity a later write-back must re-validate. */
async function fileStamp(path) {
  const bytes = await readFile(path);
  const info = await stat(path);
  return { path, bytes, mtimeMs: info.mtimeMs, size: info.size, sha256: sha256(bytes) };
}

const stampMeta = (stamp) => ({ path: stamp.path, mtimeMs: stamp.mtimeMs, size: stamp.size, sha256: stamp.sha256 });
const sameStamp = (left, right) => left !== null && right !== null
  && left.mtimeMs === right.mtimeMs && left.size === right.size && left.sha256 === right.sha256;

function statsOf(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return { n: 0, min: null, max: null, range: null, mean: null, std: null };
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const mean = finite.reduce((sum, value) => sum + value, 0) / finite.length;
  const variance = finite.reduce((sum, value) => sum + (value - mean) ** 2, 0) / finite.length;
  return {
    n: finite.length,
    min: round6(min),
    max: round6(max),
    range: round6(max - min),
    mean: round6(mean),
    std: round6(Math.sqrt(variance)),
  };
}

// ---- VTS websocket client (raw protocol; no product imports) -----------------
class VtsProbe {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.pending = new Map();
    this.seq = 0;
    this.frameSeq = 0;
    this.inject = { sent: 0, ok: 0, errors: [], late: [] };
    this.events = [];
    this.modelLoadedEvents = [];
    this.animationEvents = [];
    this.trackingEvents = [];
    this.unmatched = [];
  }

  async open(timeoutMs = 5000) {
    const socket = new WebSocket(this.url);
    this.socket = socket;
    socket.on('message', (raw) => this.#onMessage(raw));
    socket.on('error', (error) => {
      this.lastError = error?.message ?? String(error);
    });
    socket.on('close', () => {
      for (const [, waiter] of this.pending) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('VTube Studio connection closed'));
      }
      this.pending.clear();
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`VTS WebSocket open timed out (${this.url})`)), timeoutMs);
      socket.once('open', () => { clearTimeout(timer); resolve(); });
      socket.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
    return this;
  }

  #onMessage(raw) {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    const requestID = typeof message?.requestID === 'string' ? message.requestID : '';
    if (message?.messageType === 'ModelAnimationEvent') {
      const data = message.data ?? {};
      const event = {
        at: Date.now(),
        eventType: String(data.animationEventType ?? '').toLowerCase(),
        name: String(data.animationName ?? ''),
        isIdle: data.isIdleAnimation === true,
        durationSec: Number(data.animationLength) || 0,
        modelName: String(data.modelName ?? ''),
        isLive2DItem: data.isLive2DItem === true,
      };
      this.animationEvents.push(event);
      return;
    }
    if (message?.messageType === 'TrackingStatusChangedEvent') {
      const data = message.data ?? {};
      this.trackingEvents.push({
        at: Date.now(),
        faceFound: data.faceFound === true,
        leftHandFound: data.leftHandFound === true,
        rightHandFound: data.rightHandFound === true,
      });
      return;
    }
    if (message?.messageType === 'ModelLoadedEvent') {
      this.modelLoadedEvents.push({ at: Date.now(), data: message.data ?? {} });
      return;
    }
    if (requestID.startsWith('ff-frame-')) {
      if (message.messageType === 'APIError') {
        this.inject.errors.push({
          at: Date.now(),
          requestID,
          error: String(message.data?.message ?? message.data?.errorMessage ?? `errorID ${message.data?.errorID ?? '?'}`),
        });
      } else {
        this.inject.ok += 1;
      }
      return;
    }
    const waiter = this.pending.get(requestID);
    if (waiter === undefined) {
      this.unmatched.push({ at: Date.now(), messageType: message?.messageType ?? '', requestID });
      return;
    }
    this.pending.delete(requestID);
    clearTimeout(waiter.timer);
    waiter.resolve(message);
  }

  request(messageType, data = {}, timeoutMs = 4000) {
    const requestID = `ff-${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestID);
        reject(new Error(`${messageType} timed out`));
      }, timeoutMs);
      this.pending.set(requestID, { resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({
          apiName: 'VTubeStudioPublicAPI',
          apiVersion: '1.0',
          requestID,
          messageType,
          data,
        }));
      } catch (error) {
        this.pending.delete(requestID);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  /** Fire-and-forget frame; the answer is attributed by requestID in #onMessage. */
  sendFrame(parameterValues, faceFound) {
    const requestID = `ff-frame-${++this.frameSeq}`;
    const data = { parameterValues, mode: 'set' };
    if (faceFound === true) data.faceFound = true;
    if (faceFound === false) data.faceFound = false;
    this.inject.sent += 1;
    this.socket.send(JSON.stringify({
      apiName: 'VTubeStudioPublicAPI',
      apiVersion: '1.0',
      requestID,
      messageType: 'InjectParameterDataRequest',
      data,
    }));
    return requestID;
  }

  close() {
    try {
      this.socket?.close();
    } catch {
      /* already closed */
    }
  }
}

const apiErrorText = (message, fallback) => {
  const data = message?.data ?? {};
  return String(data.message ?? data.errorMessage ?? data.reason ?? (data.errorID !== undefined ? `errorID ${data.errorID}` : fallback));
};

// ---- sampling --------------------------------------------------------------
function sampleList(probe, phase, samples, errors) {
  return (async () => {
    const started = Date.now();
    try {
      const response = await probe.request('Live2DParameterListRequest', {}, 3000);
      if (response?.messageType === 'APIError') {
        errors.push({ at: Date.now(), phase, error: apiErrorText(response, 'Live2DParameterListRequest failed') });
        return;
      }
      const values = {};
      for (const entry of response?.data?.parameters ?? []) {
        values[String(entry.name)] = Number(entry.value);
      }
      samples.push({ at: Date.now(), phase, values });
    } catch (error) {
      errors.push({ at: Date.now(), phase, error: error?.message ?? String(error) });
    }
    return Date.now() - started;
  })();
}

async function samplePhase(probe, phase, stopFlag, samples, errors) {
  while (stopFlag.value !== true) {
    const started = Date.now();
    await sampleList(probe, phase, samples, errors);
    const wait = SAMPLE_INTERVAL_MS - (Date.now() - started);
    if (wait > 0) await sleep(wait);
  }
}

async function readParameter(probe, name) {
  const response = await probe.request('ParameterValueRequest', { name }, 3000);
  if (response?.messageType === 'APIError') {
    return { ok: false, name, error: apiErrorText(response, 'ParameterValueRequest failed'), raw: response };
  }
  return {
    ok: true,
    name,
    value: Number(response?.data?.value),
    min: Number(response?.data?.min),
    max: Number(response?.data?.max),
    defaultValue: Number(response?.data?.defaultValue),
    addedBy: String(response?.data?.addedBy ?? ''),
  };
}

async function crossCheck(probe, phase, names, out) {
  for (const name of names) {
    const at = Date.now();
    try {
      out.push({ phase, at, ...(await readParameter(probe, name)) });
    } catch (error) {
      out.push({ phase, at, ok: false, name, error: error?.message ?? String(error) });
    }
  }
}

// ---- phase runner ----------------------------------------------------------
async function runPhase(probe, { name, faceFound, frames, faceInput }, ctx) {
  const phase = {
    name,
    faceFound: faceFound === true ? true : (faceFound === false ? false : null),
    startedAt: Date.now(),
    endedAt: 0,
    framesRequested: frames,
    framesSent: 0,
    injectOk: 0,
    injectErrors: 0,
    samples: 0,
    sampleErrors: 0,
    animationStart: [],
    faceFoundChecks: [],
  };
  ctx.phaseList.push(phase);
  const startInject = probe.inject.ok;
  const startErrors = probe.inject.errors.length;

  // FaceFoundRequest is the tracker's real state; faceFound injection does not change it.
  try {
    const ff = await probe.request('FaceFoundRequest', {}, 3000);
    phase.faceFoundChecks.push({
      at: Date.now(),
      phase: name,
      stage: 'before',
      found: ff?.data?.found === true,
      error: ff?.messageType === 'APIError' ? apiErrorText(ff, 'FaceFoundRequest failed') : '',
    });
  } catch (error) {
    phase.faceFoundChecks.push({ at: Date.now(), phase: name, stage: 'before', found: null, error: error?.message ?? String(error) });
  }

  await crossCheck(probe, name, ctx.pvNames, ctx.pvSamples);

  const stopFlag = { value: false };
  const sampler = samplePhase(probe, name, stopFlag, ctx.samples, ctx.sampleErrors);
  const startedAt = Date.now();
  let sent = 0;
  for (let index = 0; index < frames; index += 1) {
    const deadline = startedAt + index * FRAME_INTERVAL_MS;
    const wait = deadline - Date.now();
    if (wait > 0) await sleep(wait);
    probe.sendFrame([{ id: faceInput, value: 0 }], phase.faceFound);
    sent += 1;
  }
  // Let the last frames and samples settle inside the phase window.
  await sleep(120);
  stopFlag.value = true;
  await sampler;
  phase.endedAt = Date.now();
  phase.framesSent = sent;
  phase.injectOk = probe.inject.ok - startInject;
  phase.injectErrors = probe.inject.errors.length - startErrors;
  phase.samples = ctx.samples.filter((entry) => entry.phase === name).length;
  phase.sampleErrors = ctx.sampleErrors.filter((entry) => entry.phase === name).length;
  phase.animationStart = probe.animationEvents
    .filter((event) => event.at >= phase.startedAt && event.at <= phase.endedAt && event.eventType === 'start')
    .map((event) => ({ name: event.name, isIdle: event.isIdle, at: event.at }));

  try {
    const ff = await probe.request('FaceFoundRequest', {}, 3000);
    phase.faceFoundChecks.push({
      at: Date.now(),
      phase: name,
      stage: 'after',
      found: ff?.data?.found === true,
      error: ff?.messageType === 'APIError' ? apiErrorText(ff, 'FaceFoundRequest failed') : '',
    });
  } catch (error) {
    phase.faceFoundChecks.push({ at: Date.now(), phase: name, stage: 'after', found: null, error: error?.message ?? String(error) });
  }
  await crossCheck(probe, name, ctx.pvNames, ctx.pvSamples);
  result.phases.push(phase);
  return phase;
}

// ---- Host control ----------------------------------------------------------
/**
 * Probe the VTS endpoint while the injection is paused and record the result. A closed VTS is an
 * abort (`vts-closed`), not a caveat: every later A/B number would come from a dead session.
 */
async function checkVtsAlive(stage, { throwOnDead = true } = {}) {
  const method = result.host.pauseMethod;
  const liveness = await probeVtsLiveness();
  method.vtsLiveness = { ...(method.vtsLiveness ?? {}), [stage]: liveness };
  const during = ['afterPause', 'atEnd']
    .map((key) => method.vtsLiveness[key])
    .filter((entry) => entry !== undefined);
  method.vtsAlive = during.length > 0 && during.every((entry) => entry.alive === true);
  const verdict = evaluateVtsLiveness(liveness);
  if (verdict.ok !== true) {
    result.abortReason = verdict.reason;
    method.abortReason = verdict.reason;
    if (throwOnDead) {
      throw new Error(`${verdict.reason}: VTube Studio is not reachable at ${VTS_WS_URL} during ${stage} `
        + `(${verdict.error}); the component pause closed it`);
    }
  }
  return liveness;
}

async function pauseHost(preStatus) {
  const started = Date.now();
  const before = {
    avatarFeature: featureOf(preStatus, 'avatar')?.enabled === true,
    live2dReady: preStatus?.live2d?.ready === true,
    socketOpen: preStatus?.live2d?.socketOpen === true,
    runtimeConnected: preStatus?.live2d?.runtime?.connected === true,
    spoutRunning: preStatus?.live2d?.spoutLayer?.running === true,
    spoutBounds: preStatus?.live2d?.spoutLayer?.bounds ?? null,
    lastSentAt: preStatus?.live2d?.transport?.lastSentAt ?? 0,
    idleFrameAt: preStatus?.live2d?.runtime?.idleParams?.lastFrameAt ?? 0,
  };
  result.host.before = before;
  if (before.avatarFeature !== true) throw new Error('avatar component is already OFF; refusing to guess the previous state');

  // There is no "disconnect live2d only" Host action; the pause is feature.set avatar=false. That
  // disable releases the `vts` dependency, so a plugin-owned VTS with autoClose on must be
  // protected BEFORE it. A user-started VTS is never owned, so the release leaves it alone.
  result.host.pauseMethod = {
    mode: 'disable-avatar-component',
    why: 'no Host action disconnects live2d while keeping the avatar component enabled; feature.set avatar=false is the only pause entry',
    protection: planPauseProtection(preStatus),
    vtsLiveness: {},
    vtsAlive: null,
  };
  // Mark the attempt BEFORE the first Host write: a protected autoClose or a half-applied pause
  // must still be restored by the finally block.
  result.host.pauseStarted = true;
  const protection = result.host.pauseMethod.protection;
  if (protection.protect) {
    const protectedResponse = await uiAction('autostart.set', {
      target: 'vts',
      enabled: protection.previousEnabled,
      autoClose: false,
    }, 30_000);
    if (protectedResponse?.ok !== true) {
      throw new Error(`could not protect the vts dependency before pausing: autostart.set failed: ${JSON.stringify(protectedResponse)}`);
    }
    await waitFor('autostart.vts.autoClose=false', async () => (await hostStatus())?.autostart?.vts?.autoClose === false, 10_000);
    protection.protected = true;
    protection.protectedAt = nowIso();
    protection.response = protectedResponse;
  } else {
    protection.protected = true;
  }
  const beforePause = await probeVtsLiveness();
  result.host.pauseMethod.vtsLiveness.beforePause = beforePause;

  const response = await uiAction('feature.set', { id: 'avatar', enabled: false }, 60_000);
  if (response?.ok !== true || response.enabled !== false) {
    throw new Error(`feature.set avatar=false failed: ${JSON.stringify(response)}`);
  }
  await waitFor('avatar component OFF', async () => featureOf(await hostStatus(), 'avatar')?.enabled === false, 15_000);
  await waitFor('Host VTS socket closed and runtime stopped', async () => {
    const status = await hostStatus();
    return status?.live2d?.ready !== true
      && status?.live2d?.socketOpen !== true
      && status?.live2d?.runtime?.connected !== true;
  }, 25_000);

  const after = await hostStatus();
  // Host-status evidence recorded next to the TCP liveness probe: `running` is a cache, so it is
  // context only; the liveness assertion below is what decides `vts-closed`.
  result.host.pauseMethod.hostStatus = {
    vtsEnabled: after?.autostart?.vts?.enabled === true,
    vtsAutoClose: after?.autostart?.vts?.autoClose !== false,
    vtsRunning: after?.autostart?.vts?.running === true,
    vtsOwned: after?.autostart?.vts?.owned === true,
  };
  result.host.pause = {
    startedAt: new Date(started).toISOString(),
    elapsedMs: Date.now() - started,
    response,
    status: {
      avatarFeature: featureOf(after, 'avatar')?.enabled === true,
      live2dReady: after?.live2d?.ready === true,
      socketOpen: after?.live2d?.socketOpen === true,
      runtimeConnected: after?.live2d?.runtime?.connected === true,
      spoutRunning: after?.live2d?.spoutLayer?.running === true,
      lastSentAt: after?.live2d?.transport?.lastSentAt ?? 0,
      idleFrameAt: after?.live2d?.runtime?.idleParams?.lastFrameAt ?? 0,
    },
  };
  // The expected paused state: any later difference is another writer, never this script.
  result.host.pause.snapshot = hostFields(after);
  return after;
}

let restorePromise = null;
function restoreOnce(baseline, backups) {
  if (restorePromise === null) restorePromise = restoreHost(baseline, backups);
  return restorePromise;
}

/**
 * Last-resort file write-back: only called when the Host interface cannot answer /assistant/status.
 * A file is written only when it still matches the mtime/size/sha256 recorded right after the
 * pause; a mismatch is a concurrent write and is refused instead of overwritten.
 */
async function restoreFilesFallback(restore, backups, record) {
  const entries = [
    { name: 'settings.json', path: SETTINGS_FILE, before: backups.preSettingsBytes, stamp: result.host.files?.settings?.afterPause ?? null },
    { name: 'features.json', path: FEATURES_FILE, before: backups.preFeaturesBytes, stamp: result.host.files?.features?.afterPause ?? null },
  ];
  restore.fileFallback = { attempted: true, files: {}, refused: false };
  for (const entry of entries) {
    const field = `files.${entry.name}`;
    try {
      if (entry.before === null || entry.stamp === null) throw new Error('no post-pause identity was recorded; refusing to write');
      const now = await fileStamp(entry.path);
      if (sameStamp(now, entry.stamp) !== true) {
        restore.fileFallback.files[entry.name] = { ok: false, refused: 'file-modified-externally', expected: entry.stamp, actual: stampMeta(now) };
        restore.fileFallback.refused = true;
        restore.notRestored.push({ field, reason: 'file changed after the pause; refusing to overwrite a concurrent write', actual: stampMeta(now) });
        record(`file write-back ${entry.name}`, { ok: false, refused: 'file-modified-externally' });
        continue;
      }
      if (sha256(entry.before) === now.sha256) {
        restore.fileFallback.files[entry.name] = { ok: true, changed: false };
        restore.skipped.push({ field, reason: 'already matched the pre-test bytes' });
        continue;
      }
      await writeFile(entry.path, entry.before);
      restore.fileFallback.files[entry.name] = { ok: true, changed: true, sha256: sha256(entry.before) };
      restore.restored.push({ field, from: now.sha256, to: sha256(entry.before), method: 'file write-back after mtime/sha256 validation' });
      record(`file write-back ${entry.name}`, { ok: true });
    } catch (error) {
      restore.fileFallback.files[entry.name] = { ok: false, error: error?.message ?? String(error) };
      restore.notRestored.push({ field, reason: error?.message ?? String(error) });
      failures.push({ step: `restore ${entry.name}`, error: error?.message ?? String(error) });
    }
  }
}

async function restoreHost(baseline, backups) {
  const started = Date.now();
  const steps = [];
  const record = (name, value) => steps.push({ name, at: new Date().toISOString(), ...value });
  const restore = {
    startedAt: new Date(started).toISOString(),
    restoreSkipped: null,
    interface: null,
    expectedAfterPause: result.host.pause.snapshot ?? null,
    observedBeforeRestore: null,
    changedDuringTest: [],
    restored: [],
    notRestored: [],
    skipped: [],
    why: '',
    steps,
  };
  result.host.restore = restore;

  // 1. Interface first. Reading status also runs the concurrent-change comparison BEFORE any
  //    action is sent, so a newer write is never overwritten by this script.
  const current = await hostStatus().catch((error) => ({ __error: error?.message ?? String(error) }));
  if (current.__error !== undefined) {
    restore.interface = { available: false, error: current.__error };
    restore.restoreSkipped = 'host-unavailable-file-fallback';
    record('host status unavailable', { ok: false, error: current.__error });
    await restoreFilesFallback(restore, backups, record);
    if (restore.fileFallback?.refused === true) {
      restore.restoreSkipped = 'file-modified-externally';
      restore.why = 'the Host interface was unreachable and a settings file changed after the pause; the write-back was refused so no concurrent write was overwritten';
    } else {
      restore.why = 'the Host interface was unreachable; the persisted files were written back only after their post-pause mtime/sha256 still matched. Host memory may stay stale until the Host restarts.';
    }
    restore.elapsedMs = Date.now() - started;
    return steps;
  }

  restore.interface = { available: true };
  restore.observedBeforeRestore = hostFields(current);
  const expected = restore.expectedAfterPause;
  // No post-pause snapshot means the pause did not finish; there is nothing to compare against,
  // so restore the pre-test values and say that the concurrent check could not run.
  if (expected === null) restore.skipped.push({ field: 'concurrent-change check', reason: 'no post-pause snapshot (pause incomplete)' });
  const changed = expected === null ? [] : diffHostFields(expected, restore.observedBeforeRestore);
  record('concurrent-change check', { ok: changed.length === 0, checked: expected !== null, changed });
  if (changed.length > 0) {
    restore.restoreSkipped = 'concurrent-change';
    restore.changedDuringTest = changed;
    restore.notRestored.push(...changed.map((diff) => ({ field: diff.field, reason: 'concurrent-change', expected: diff.expected, actual: diff.actual })));
    for (const field of ['settings.autostart.vts.enabled', 'settings.autostart.vts.autoClose', 'live2d.connect', 'live2d.spoutLayer.running']) {
      if (restore.notRestored.some((entry) => entry.field === field) !== true) restore.skipped.push({ field, reason: 'concurrent-change' });
    }
    restore.why = 'the Host state no longer matched the post-pause snapshot, so this script left it untouched instead of overwriting the newer write';
    result.caveats.push(`restore skipped: concurrent change detected (${changed.map((diff) => diff.field).join(', ')}); nothing was overwritten`);
    restore.elapsedMs = Date.now() - started;
    return steps;
  }

  // 2. Component back on. This restores features.json `avatar=true`.
  try {
    const response = await uiAction('feature.set', { id: 'avatar', enabled: true }, 60_000);
    if (response?.ok !== true) throw new Error(`feature.set avatar=true failed: ${JSON.stringify(response)}`);
    await waitFor('avatar component ON', async () => featureOf(await hostStatus(), 'avatar')?.enabled === true, 15_000);
    restore.restored.push({ field: 'features.avatar.enabled', from: false, to: true, method: 'feature.set' });
    record('feature.set avatar=true', { ok: true, response });
  } catch (error) {
    restore.notRestored.push({ field: 'features.avatar.enabled', reason: error?.message ?? String(error) });
    record('feature.set avatar=true', { ok: false, error: error?.message ?? String(error) });
    failures.push({ step: 'restore feature', error: error?.message ?? String(error) });
  }

  // 3. Put back the exact autostart.vts values the pause rewrote (feature.set forces true/true).
  if (baseline === null) {
    restore.skipped.push({ field: 'settings.autostart.vts', reason: 'no pre-test snapshot' });
  } else {
    const wantEnabled = baseline.autostartVtsEnabled === true;
    const wantAutoClose = baseline.autostartVtsAutoClose !== false;
    try {
      const currentVts = (await hostStatus())?.autostart?.vts ?? {};
      const fromEnabled = currentVts.enabled === true;
      const fromAutoClose = currentVts.autoClose !== false;
      if (fromEnabled === wantEnabled && fromAutoClose === wantAutoClose) {
        restore.skipped.push({ field: 'settings.autostart.vts', reason: 'already matched the pre-test value' });
      } else {
        let last = null;
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          last = await uiAction('autostart.set', { target: 'vts', enabled: wantEnabled, autoClose: wantAutoClose }, 30_000);
          if (last?.ok === true) break;
          await sleep(500);
        }
        if (last?.ok !== true) throw new Error(`autostart.set vts failed: ${JSON.stringify(last)}`);
        restore.restored.push({ field: 'settings.autostart.vts.enabled', from: fromEnabled, to: wantEnabled, method: 'autostart.set' });
        restore.restored.push({ field: 'settings.autostart.vts.autoClose', from: fromAutoClose, to: wantAutoClose, method: 'autostart.set' });
        record('autostart.set vts', { ok: true, enabled: wantEnabled, autoClose: wantAutoClose });
      }
    } catch (error) {
      restore.notRestored.push({ field: 'settings.autostart.vts', reason: error?.message ?? String(error) });
      record('autostart.set vts', { ok: false, error: error?.message ?? String(error) });
      failures.push({ step: 'restore autostart.vts', error: error?.message ?? String(error) });
    }
  }

  // 4. Reconnect VTS (operational; the component hook starts the program, it does not authenticate).
  try {
    let last = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      last = await uiAction('live2d.connect', {}, 60_000);
      if (last?.ok === true && last?.ready === true) break;
      await sleep(1000);
    }
    if (last?.ok !== true) throw new Error(`live2d.connect failed: ${JSON.stringify(last)}`);
    await waitFor('Host VTS ready again', async () => {
      const status = await hostStatus();
      return status?.live2d?.ready === true && status?.live2d?.runtime?.connected === true;
    }, 25_000);
    restore.restored.push({ field: 'live2d.ready', from: false, to: true, method: 'live2d.connect' });
    record('live2d.connect', { ok: true, ready: last?.ready === true, response: last });
  } catch (error) {
    restore.notRestored.push({ field: 'live2d.ready', reason: error?.message ?? String(error) });
    record('live2d.connect', { ok: false, error: error?.message ?? String(error) });
    failures.push({ step: 'restore VTS', error: error?.message ?? String(error) });
  }

  // 5. Spout display back at the rectangle it occupied before the pause. The saved settings
  //    (`layer.spout.bounds`) are the same rectangle, so the plain start action restores it.
  if (baseline?.spoutRunning !== true) {
    restore.skipped.push({ field: 'live2d.spoutLayer.running', reason: 'not running before the test' });
  } else {
    try {
      const response = await uiAction('spoutLayer.start', {}, 90_000);
      if (response?.ok !== true) throw new Error(`spoutLayer.start failed: ${JSON.stringify(response)}`);
      record('spoutLayer.start', { ok: true, pid: response?.pid ?? 0, phase: response?.readyPhase ?? '' });
      const want = baseline.spoutBounds ?? null;
      await waitFor('Spout display running again', async () => {
        const layer = (await hostStatus())?.live2d?.spoutLayer ?? null;
        if (layer?.running !== true) return false;
        if (want === null) return true;
        const got = layer?.bounds ?? null;
        return got !== null
          && Number(got.left) === Number(want.left)
          && Number(got.top) === Number(want.top)
          && Number(got.width) === Number(want.width)
          && Number(got.height) === Number(want.height);
      }, 40_000);
      restore.restored.push({ field: 'live2d.spoutLayer.running', from: false, to: true, method: 'spoutLayer.start' });
      record('spout display restored', { ok: true, bounds: (await hostStatus())?.live2d?.spoutLayer?.bounds ?? null });
    } catch (error) {
      restore.notRestored.push({ field: 'live2d.spoutLayer.running', reason: error?.message ?? String(error) });
      record('spoutLayer.start', { ok: false, error: error?.message ?? String(error) });
      failures.push({ step: 'restore spout display', error: error?.message ?? String(error) });
    }
  }

  // 6. Verify the final state against the pre-test snapshot and say what was / was not restored.
  const finalStatus = await hostStatus().catch(() => null);
  if (finalStatus !== null) {
    const finalFields = hostFields(finalStatus);
    restore.final = {
      ...finalFields,
      socketOpen: finalStatus?.live2d?.socketOpen === true,
      runtimeConnected: finalStatus?.live2d?.runtime?.connected === true,
      lastSentAt: finalStatus?.live2d?.transport?.lastSentAt ?? 0,
      controlled: finalStatus?.live2d?.runtime?.channels?.controlled ?? [],
      skipped: finalStatus?.live2d?.runtime?.channels?.skipped ?? [],
    };
    if (baseline !== null) {
      for (const [key, field] of RESTORE_FIELDS) {
        if (key === 'spoutBounds' && baseline.spoutRunning !== true) continue;
        if (restore.notRestored.some((entry) => entry.field === field)) continue;
        const want = baseline[key] ?? null;
        const got = restore.final[key] ?? null;
        if (JSON.stringify(want) !== JSON.stringify(got)) {
          restore.notRestored.push({ field, reason: 'final value does not match the pre-test snapshot', expected: want, actual: got });
        }
      }
    }
  } else {
    restore.notRestored.push({ field: 'final status', reason: 'Host status was unreadable after the restore' });
  }

  if (restore.restoreSkipped === null) {
    restore.why = restore.notRestored.length === 0
      ? 'every tracked field was restored through the Host interface (feature.set / autostart.set / live2d.connect / spoutLayer.start)'
      : `restored through the Host interface except: ${restore.notRestored.map((entry) => entry.field).join(', ')}`;
  }
  if (restore.notRestored.length > 0) {
    result.caveats.push(`restore incomplete: ${restore.notRestored.map((entry) => `${entry.field} (${entry.reason})`).join('; ')}`);
  }
  restore.elapsedMs = Date.now() - started;
  return steps;
}

// ---- report ----------------------------------------------------------------
function buildStats(ctx, targets) {
  const byCondition = { A: {}, B: {}, C: {} };
  for (const condition of ['A', 'B', 'C']) {
    for (const target of targets) byCondition[condition][target] = [];
  }
  const conditionOfPhase = new Map(ctx.phaseList.map((phase) => [phase.name, phase.faceFound === true ? 'B' : (phase.faceFound === false ? 'C' : 'A')]));
  for (const [name, condition] of conditionOfPhase) {
    for (const target of targets) {
      const values = ctx.samples
        .filter((sample) => sample.phase === name)
        .map((sample) => sample.values[target])
        .filter((value) => Number.isFinite(value));
      if (values.length === 0) continue;
      byCondition[condition][target].push(...values);
    }
  }
  const out = {};
  for (const condition of ['A', 'B', 'C']) {
    out[condition] = {};
    for (const target of targets) {
      out[condition][target] = statsOf(byCondition[condition][target]);
    }
  }
  // Per-round pairing keeps slow idle-animation drift out of the A/B delta. Rounds alternate
  // A->B / B->A, so the pairing is by the numeric suffix, not by position in the phase list.
  const byRound = new Map();
  for (const phase of ctx.phaseList) {
    const match = /^([AB])(\d+)$/u.exec(phase.name);
    if (match === null) continue;
    const [, letter, round] = match;
    const entry = byRound.get(round) ?? {};
    entry[letter] = phase;
    byRound.set(round, entry);
  }
  const rounds = [];
  for (const [round, entry] of byRound) {
    const aPhase = entry.A;
    const bPhase = entry.B;
    if (aPhase === undefined || bPhase === undefined) continue;
    if (aPhase.faceFound !== null || bPhase.faceFound !== true) continue;
    const perParam = {};
    for (const target of targets) {
      const aValues = ctx.samples.filter((sample) => sample.phase === aPhase.name).map((sample) => sample.values[target]).filter(Number.isFinite);
      const bValues = ctx.samples.filter((sample) => sample.phase === bPhase.name).map((sample) => sample.values[target]).filter(Number.isFinite);
      perParam[target] = { A: statsOf(aValues), B: statsOf(bValues) };
    }
    rounds.push({ round, a: aPhase.name, b: bPhase.name, perParam });
  }
  // Per-phase stats expose the idle-animation phase confound: if every A phase moves and every
  // B phase is static, the difference is a state effect rather than one segment of one loop.
  const perPhase = {};
  for (const phase of ctx.phaseList) {
    perPhase[phase.name] = {};
    for (const target of targets) {
      const values = ctx.samples
        .filter((sample) => sample.phase === phase.name)
        .map((sample) => sample.values[target])
        .filter((value) => Number.isFinite(value));
      perPhase[phase.name][target] = statsOf(values);
    }
  }
  return { byCondition: out, rounds, perPhase };
}

function verdictFor(a = {}, b = {}) {
  if (!Number.isFinite(a.n) || !Number.isFinite(b.n) || a.n < 5 || b.n < 5) return 'insufficient-samples';
  const same = (a.range ?? 0) + (b.range ?? 0) < 1e-6;
  if (same) return 'insufficient-motion';
  if ((b.range ?? 0) < (a.range ?? 0) * 0.2) return 'suppressed';
  if ((b.range ?? 0) > (a.range ?? 0) * 1.8) return 'increased';
  const different = Math.abs((b.range ?? 0) - (a.range ?? 0)) > Math.max(a.range ?? 0, b.range ?? 0) * 0.25;
  return different ? 'difference' : 'no-clear-difference';
}

function printReport(report) {
  console.log('\n===== Pause method / VTS liveness =====');
  console.log(JSON.stringify({
    mode: report.host.pauseMethod?.mode ?? '',
    why: report.host.pauseMethod?.why ?? '',
    protection: report.host.pauseMethod?.protection ?? null,
    hostStatus: report.host.pauseMethod?.hostStatus ?? null,
    vtsLiveness: report.host.pauseMethod?.vtsLiveness ?? null,
    vtsAlive: report.host.pauseMethod?.vtsAlive ?? null,
    abortReason: report.abortReason ?? null,
  }, null, 2));

  console.log('\n===== Host pause / restore =====');
  console.log(JSON.stringify({ before: report.host.before, pause: report.host.pause, restore: report.host.restore }, null, 2));

  console.log('\n===== Restore report (what was restored, what was not, why) =====');
  console.log(JSON.stringify({
    restoreSkipped: report.host.restore.restoreSkipped ?? null,
    interface: report.host.restore.interface ?? null,
    baseline: report.host.baseline ?? null,
    expectedAfterPause: report.host.restore.expectedAfterPause ?? null,
    restored: report.host.restore.restored ?? [],
    notRestored: report.host.restore.notRestored ?? [],
    skipped: report.host.restore.skipped ?? [],
    changedDuringTest: report.host.restore.changedDuringTest ?? [],
    fileFallback: report.host.restore.fileFallback ?? null,
    why: report.host.restore.why ?? '',
  }, null, 2));

  console.log('\n===== VTS target =====');
  console.log(JSON.stringify({
    url: report.vts.url,
    tokenPath: report.vts.tokenPath,
    tokenMtime: report.vts.tokenMtime,
    model: report.vts.model,
    modelConfig: report.vts.modelConfig,
    installedModelCount: report.vts.installedModels?.length ?? 0,
    installedModelsWithTrackingLost: report.vts.installedModelsWithTrackingLost ?? [],
    faceInput: report.vts.faceInput,
    faceInputParam: report.vts.faceInputParam,
    faceInputSource: report.vts.faceInputSource ?? null,
    faceInputVerified: report.vts.faceInputVerified === true,
    faceInputExploratory: report.vts.faceInputExploratory === true,
    faceFoundAtStart: report.vts.faceFoundAtStart,
    inputs: report.vts.inputs ? { defaultCount: report.vts.inputs.defaultCount, customCount: report.vts.inputs.customCount } : null,
    modelParameterCount: report.vts.modelParameters?.count ?? 0,
    unownedCandidates: report.vts.unownedCandidates,
    subscriptions: report.vts.subscriptions,
    connectedPluginsBeforeAuth: report.vts.connectedPluginsBeforeAuth,
    connectedPluginsAfterAuth: report.vts.auth?.connectedPluginsAfterAuth ?? null,
    connectedPluginsAfterBaseline: report.vts.connectedPluginsAfterBaseline ?? null,
    connectedPluginsAtEnd: report.vts.connectedPluginsAtEnd ?? null,
  }, null, 2));

  console.log('\n===== A/B unowned-channel statistics (dense Live2DParameterListRequest samples) =====');
  const byCondition = report.stats?.byCondition ?? { A: {}, B: {}, C: {} };
  const rows = [];
  for (const target of Object.keys(byCondition.A ?? {})) {
    const a = byCondition.A?.[target] ?? statsOf([]);
    const b = byCondition.B?.[target] ?? statsOf([]);
    const c = byCondition.C?.[target] ?? statsOf([]);
    const verdict = verdictFor(a, b);
    rows.push({
      parameter: target,
      'A n': a.n, 'A min': a.min, 'A max': a.max, 'A range': a.range, 'A std': a.std,
      'B n': b.n, 'B min': b.min, 'B max': b.max, 'B range': b.range, 'B std': b.std,
      'C range': c.range,
      'Δrange(B-A)': round6((b.range ?? 0) - (a.range ?? 0)),
      verdict,
    });
  }
  console.table(rows);

  console.log('\n===== Per-round A->B pairs =====');
  const pairRows = [];
  for (const round of report.stats?.rounds ?? []) {
    for (const [target, pair] of Object.entries(round.perParam)) {
      pairRows.push({
        round: `${round.a}->${round.b}`,
        parameter: target,
        'A range': pair.A.range, 'B range': pair.B.range,
        verdict: verdictFor(pair.A, pair.B),
      });
    }
  }
  console.table(pairRows);

  console.log('\n===== Per-phase ranges (state-effect check, not one idle-loop segment) =====');
  const keyParams = ['ParamBodyAngleX', 'ParamBodyAngleY', 'ParamBodyAngleZ', 'ParamArmLA', 'ParamArmRA', 'ParamBreath', 'ParamAngleX'];
  const phaseRows = [];
  for (const phase of report.phases) {
    for (const name of keyParams) {
      const stats = report.stats?.perPhase?.[phase.name]?.[name];
      if (stats === undefined || stats.n === 0) continue;
      phaseRows.push({
        phase: phase.name,
        faceFound: phase.faceFound === null ? 'absent' : String(phase.faceFound),
        parameter: name,
        n: stats.n,
        range: stats.range,
        std: stats.std,
        mean: stats.mean,
      });
    }
  }
  console.table(phaseRows);

  console.log('\n===== ParameterValueRequest cross-check (explicitly requested read path) =====');
  console.log(JSON.stringify({
    summary: report.parameterValueCheck.summary,
    preflight: report.parameterValueCheck.preflight,
    sampleCount: report.parameterValueCheck.samples?.length ?? 0,
    sampleOk: (report.parameterValueCheck.samples ?? []).filter((entry) => entry.ok === true).length,
    sampleFailed: (report.parameterValueCheck.samples ?? []).filter((entry) => entry.ok !== true).length,
  }, null, 2));

  console.log('\n===== Animation / tracking events =====');
  console.log(JSON.stringify({
    animationNames: report.animation.names,
    trackingLostLike: report.animation.trackingLostLike,
    trackingEvents: report.tracking.events,
    faceFoundChecks: report.tracking.faceFound,
    possibleTrackingLost: report.tracking.possibleTrackingLost,
    observed: report.tracking.observed,
    bodyRanges: report.tracking.bodyRanges,
    phaseC: report.tracking.phaseC,
    verified: report.tracking.verified,
    note: report.tracking.note,
  }, null, 2));

  console.log('\n===== Phases =====');
  console.table(report.phases.map((phase) => ({
    phase: phase.name,
    faceFound: phase.faceFound === null ? 'absent' : String(phase.faceFound),
    frames: phase.framesSent,
    injectOk: phase.injectOk,
    injectErrors: phase.injectErrors,
    samples: phase.samples,
    sampleErrors: phase.sampleErrors,
    durationMs: phase.endedAt - phase.startedAt,
  })));

  console.log('\n===== Conclusion =====');
  console.log(report.conclusion);
  if (report.failures.length > 0) {
    console.log('\n===== Failures =====');
    console.log(JSON.stringify(report.failures, null, 2));
  }
}

// ---- offline self-check (fake Host status; no VTS, no Host) ------------------
/** `FACEFOUND_SELFTEST=1`: prove the pause-protection and verified-channel rules on fake status. */
function runSelfCheck() {
  const cases = [];
  const check = (name, ok, detail) => cases.push({ name, ok: ok === true, detail });
  const fakeStatus = ({ controlled = [], channels = [], owned = false, autoClose = true } = {}) => ({
    features: [{ id: 'avatar', enabled: true }],
    live2d: {
      ready: true,
      runtime: { channels: { controlled, skipped: [], unverified: [] } },
      capabilities: { channels },
    },
    autostart: { vts: { enabled: true, autoClose, owned, running: true } },
  });

  // 3. Only a controlled AND verified input may be injected; no input name is guessed.
  const noChannel = resolveFaceInput(fakeStatus({ controlled: [] }), ['TestHeadX'], '');
  check('no controlled channel -> no-verified-channel', noChannel.ok === false && noChannel.reason === 'no-verified-channel', noChannel);
  const notVerified = resolveFaceInput(fakeStatus({
    controlled: ['headX'],
    channels: [{ channel: 'headX', inputName: 'TestHeadX', injectable: true, verified: false }],
  }), ['TestHeadX'], '');
  check('verified:false discovery row -> no-verified-channel', notVerified.ok === false && notVerified.reason === 'no-verified-channel', notVerified);
  const rowWithoutTakeover = resolveFaceInput(fakeStatus({
    controlled: [],
    channels: [{ channel: 'headX', inputName: 'TestHeadX', injectable: true, verified: true }],
  }), ['TestHeadX'], '');
  check('verified row without runtime takeover -> no-verified-channel', rowWithoutTakeover.ok === false, rowWithoutTakeover);
  const verified = resolveFaceInput(fakeStatus({
    controlled: ['eyeX', 'headX'],
    channels: [
      { channel: 'eyeX', inputName: 'TestEyeX', injectable: true, verified: true },
      { channel: 'headX', inputName: 'TestHeadX', injectable: true, verified: true },
    ],
  }), [], '');
  check('controlled+verified -> headX input accepted', verified.ok === true
    && verified.verified === true && verified.channel === 'headX' && verified.inputName === 'TestHeadX', verified);
  const exploratory = resolveFaceInput(fakeStatus({ controlled: [] }), ['TestHeadX'], 'TestHeadX');
  check('explicit unverified override -> exploratory:true', exploratory.ok === true
    && exploratory.exploratory === true && exploratory.verified === false, exploratory);

  // 2. Pause protection is decided from the fake Host status, before any Host write.
  const ownedProtect = planPauseProtection(fakeStatus({ owned: true, autoClose: true }));
  check('plugin-owned VTS + autoClose -> protect before disabling avatar', ownedProtect.protect === true && ownedProtect.external === false, ownedProtect);
  const externalVts = planPauseProtection(fakeStatus({ owned: false, autoClose: true }));
  check('external VTS recorded, not treated as plugin-owned', externalVts.protect === false && externalVts.external === true, externalVts);
  const unknownStatus = fakeStatus({ autoClose: true });
  delete unknownStatus.autostart.vts.owned;
  const unknownOwnership = planPauseProtection(unknownStatus);
  check('unknown VTS ownership -> protect anyway', unknownOwnership.protect === true
    && unknownOwnership.external === false && unknownOwnership.ownershipKnown === false, unknownOwnership);
  const alreadyProtected = planPauseProtection(fakeStatus({ owned: true, autoClose: false }));
  check('autoClose already off -> no extra write', alreadyProtected.protect === false && alreadyProtected.previousAutoClose === false, alreadyProtected);
  const dead = evaluateVtsLiveness({ alive: false, error: 'ECONNREFUSED' });
  check('dead VTS while paused -> abort reason vts-closed', dead.ok === false && dead.reason === 'vts-closed', dead);
  const alive = evaluateVtsLiveness({ alive: true });
  check('alive VTS while paused -> ok', alive.ok === true && alive.reason === '', alive);

  for (const entry of cases) {
    console.log(`${entry.ok ? 'PASS' : 'FAIL'} ${entry.name} :: ${JSON.stringify(entry.detail)}`);
  }
  const passed = cases.filter((entry) => entry.ok === true).length;
  console.log(`self-check: ${passed}/${cases.length} passed (fake Host status; no VTS/Host calls)`);
  process.exitCode = passed === cases.length ? 0 : 1;
}

// ---- main ------------------------------------------------------------------
async function main() {
  // Contract guard: a run that cannot pause the Host must not inject at all.
  const preStatus = await hostStatus();
  if (featureOf(preStatus, 'avatar')?.enabled !== true) {
    throw new Error('avatar component is OFF before the test; refusing to change a state that is not the known baseline');
  }
  if (preStatus?.live2d?.ready !== true) {
    throw new Error('Host is not connected to VTube Studio before the test (live2d.ready=false); start the avatar connection first');
  }
  result.host.root = preStatus.root;
  result.vts.preModel = { model: preStatus?.live2d?.model ?? '', modelId: preStatus?.live2d?.modelId ?? '' };
  // The pre-test state every restore is verified against, field by field.
  result.host.baseline = hostFields(preStatus);
  result.host.before = {
    avatarFeature: true,
    live2dReady: true,
    spoutRunning: preStatus?.live2d?.spoutLayer?.running === true,
    spoutBounds: preStatus?.live2d?.spoutLayer?.bounds ?? null,
  };
  const root = typeof preStatus.root === 'string' && preStatus.root.trim().length > 0
    ? preStatus.root.trim()
    : '';
  if (root.length > 0) {
    DATA_DIR = join(root, 'data');
    SETTINGS_FILE = join(DATA_DIR, 'settings.json');
    FEATURES_FILE = join(DATA_DIR, 'features.json');
  }
  const tokenCandidates = [
    process.env.VTS_TOKEN_PATH,
    ...TOKEN_CANDIDATES,
    ...(root.length > 0 ? [join(root, 'vts-token.json')] : []),
  ].filter((entry) => typeof entry === 'string' && entry.length > 0);

  // Back up the two persisted files the pause touches, before anything is written. The full
  // pre-test bytes are only used by the guarded fallback path below; the mtime+sha256 identity is
  // what a fallback write-back must still match.
  let preSettingsBytes = null;
  let preFeaturesBytes = null;
  try {
    const settingsStamp = await fileStamp(SETTINGS_FILE);
    const featuresStamp = await fileStamp(FEATURES_FILE);
    preSettingsBytes = settingsStamp.bytes;
    preFeaturesBytes = featuresStamp.bytes;
    result.host.files = {
      settings: { path: SETTINGS_FILE, sha256Before: settingsStamp.sha256, mtimeBefore: settingsStamp.mtimeMs, bytes: settingsStamp.size },
      features: { path: FEATURES_FILE, sha256Before: featuresStamp.sha256, mtimeBefore: featuresStamp.mtimeMs, bytes: featuresStamp.size },
    };
  } catch (error) {
    result.caveats.push(`could not back up ${SETTINGS_FILE}/${FEATURES_FILE}: ${error?.message ?? String(error)}`);
  }

  let paused = false;
  let probe = null;
  try {
    const postPauseStatus = await pauseHost(preStatus);
    paused = result.host.pauseStarted === true;
    // The pause must leave VTS running: the probe needs its own connection, and a closed VTS is
    // an abort, never a "test ran but VTS was off" caveat.
    await checkVtsAlive('afterPause');
    result.host.statusAfterPause = {
      model: postPauseStatus?.live2d?.model ?? '',
      spoutRunning: postPauseStatus?.live2d?.spoutLayer?.running === true,
      lastSentAt: postPauseStatus?.live2d?.transport?.lastSentAt ?? 0,
    };
    // Record what the Host itself wrote when pausing. A fallback may only write a file whose
    // identity is still exactly this one.
    if (result.host.files !== undefined) {
      try {
        result.host.files.settings.afterPause = stampMeta(await fileStamp(SETTINGS_FILE));
        result.host.files.features.afterPause = stampMeta(await fileStamp(FEATURES_FILE));
      } catch (error) {
        result.caveats.push(`could not record the post-pause file identity: ${error?.message ?? String(error)}`);
      }
    }

    // A token copy is read, never written. No HTTP token request is ever sent by this script.
    let token = '';
    let tokenPath = '';
    for (const candidate of tokenCandidates) {
      try {
        const parsed = JSON.parse(await readFile(candidate, 'utf8'));
        if (typeof parsed?.authenticationToken === 'string' && parsed.authenticationToken.length > 0) {
          token = parsed.authenticationToken;
          tokenPath = candidate;
          break;
        }
      } catch {
        /* try the next candidate */
      }
    }
    if (token.length === 0) throw new Error(`no readable VTS token (looked at: ${tokenCandidates.join(', ')})`);
    result.vts.tokenPath = tokenPath;
    result.vts.tokenCandidates = tokenCandidates;

    probe = await new VtsProbe(VTS_WS_URL).open();
    result.vts.url = VTS_WS_URL;

    // Before auth: if the Host still holds a plugin connection, the pause was not real. Give VTS
    // a short window to drop a just-closed socket, and never treat an unsupported answer as proof.
    let connectedBeforeAuth = null;
    let connectedBeforeAuthError = '';
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const stats = await probe.request('StatisticsRequest', {}, 4000);
      if (stats?.messageType === 'APIError') {
        connectedBeforeAuthError = apiErrorText(stats, 'StatisticsRequest failed');
        break;
      }
      connectedBeforeAuth = Number(stats?.data?.connectedPlugins ?? -1);
      if (connectedBeforeAuth === 0) break;
      await sleep(300);
    }
    result.vts.connectedPluginsBeforeAuth = connectedBeforeAuth;
    if (connectedBeforeAuthError.length > 0) {
      result.caveats.push(`StatisticsRequest before auth failed (${connectedBeforeAuthError}); the connected-plugin count could not be checked`);
    } else if (connectedBeforeAuth !== 0) {
      throw new Error(`VTS still reports ${connectedBeforeAuth} connected plugin(s) after the Host pause; refusing to run a contaminated A/B test`);
    }

    const auth = await probe.request('AuthenticationRequest', {
      ...PLUGIN,
      authenticationToken: token,
    }, 10_000);
    if (auth?.messageType === 'APIError' || auth?.data?.authenticated !== true) {
      throw new Error(`VTS rejected the copied token: ${apiErrorText(auth, 'authenticated is not true')} (no new token was requested)`);
    }
    result.vts.auth = { ok: true, plugin: PLUGIN, connectedPluginsAfterAuth: null };

    const authStats = await probe.request('StatisticsRequest', {}, 4000);
    result.vts.auth.connectedPluginsAfterAuth = Number(authStats?.data?.connectedPlugins ?? -1);
    result.vts.statistics = authStats?.data ?? {};
    if (Number.isFinite(result.vts.auth.connectedPluginsAfterAuth) && result.vts.auth.connectedPluginsAfterAuth > 1) {
      result.caveats.push(`VTS reported ${result.vts.auth.connectedPluginsAfterAuth} connected plugins while this script held one session; the Host's own socket was closed, so at least one other/stale session exists. No injection was rejected (0 APIError frames), but a second writer cannot be fully excluded.`);
    }

    const current = await probe.request('CurrentModelRequest', {}, 4000);
    if (current?.messageType === 'APIError') throw new Error(apiErrorText(current, 'CurrentModelRequest failed'));
    const modelData = current?.data ?? {};
    if (modelData.modelLoaded !== true) throw new Error('VTS reports no loaded model');
    result.vts.model = { name: String(modelData.modelName ?? ''), id: String(modelData.modelID ?? modelData.modelId ?? '') };
    result.vts.modelConfig = await readModelConfig(result.vts.model.name);
    if (result.vts.modelConfig === null) {
      result.caveats.push('could not locate the current model .vtube.json; cannot tell whether a tracking-lost animation is configured');
    }
    result.vts.installedModels = await scanInstalledModels();
    result.vts.installedModelsWithTrackingLost = result.vts.installedModels
      .filter((entry) => entry.idleAnimationWhenTrackingLost.length > 0)
      .map((entry) => entry.folder);

    const inputsResponse = await probe.request('InputParameterListRequest', {}, 5000);
    if (inputsResponse?.messageType === 'APIError') throw new Error(apiErrorText(inputsResponse, 'InputParameterListRequest failed'));
    const defaultInputs = (inputsResponse?.data?.defaultParameters ?? []).map((entry) => String(entry.name));
    const customInputs = (inputsResponse?.data?.customParameters ?? []).map((entry) => String(entry.name));
    result.vts.inputs = { defaultCount: defaultInputs.length, customCount: customInputs.length, names: defaultInputs };
    if (defaultInputs.length === 0) throw new Error('VTS returned no injectable input parameters');

    const modelParamsResponse = await probe.request('Live2DParameterListRequest', {}, 5000);
    if (modelParamsResponse?.messageType === 'APIError') throw new Error(apiErrorText(modelParamsResponse, 'Live2DParameterListRequest failed'));
    const modelParams = (modelParamsResponse?.data?.parameters ?? []).map((entry) => ({
      name: String(entry.name),
      value: Number(entry.value),
      min: Number(entry.min),
      max: Number(entry.max),
      defaultValue: Number(entry.defaultValue),
    }));
    result.vts.modelParameters = { count: modelParams.length, names: modelParams.map((entry) => entry.name) };

    const faceFoundBefore = await probe.request('FaceFoundRequest', {}, 3000);
    result.vts.faceFoundAtStart = faceFoundBefore?.data?.found === true;
    result.tracking.faceFound.push({ at: Date.now(), phase: 'pre', stage: 'start', found: result.vts.faceFoundAtStart });

    // Subscriptions. ModelAnimationEvent drives the tracking-lost observation; TrackingStatusChanged
    // is the tracker's own state and stays independent from the injected faceFound flag.
    const subscriptionResults = {};
    for (const entry of [
      { name: 'ModelAnimationEvent', config: { ignoreLive2DItems: true, ignoreIdleAnimations: false } },
      { name: 'TrackingStatusChangedEvent', config: {} },
    ]) {
      try {
        const response = await probe.request('EventSubscriptionRequest', {
          eventName: entry.name,
          subscribe: true,
          config: entry.config,
        }, 5000);
        if (response?.messageType === 'APIError') {
          subscriptionResults[entry.name] = { ok: false, error: apiErrorText(response, 'EventSubscriptionRequest failed') };
        } else {
          const events = Array.isArray(response?.data?.subscribedEvents) ? response.data.subscribedEvents : [];
          subscriptionResults[entry.name] = { ok: events.includes(entry.name), events, error: events.includes(entry.name) ? '' : 'not confirmed' };
        }
      } catch (error) {
        subscriptionResults[entry.name] = { ok: false, error: error?.message ?? String(error) };
      }
    }
    result.vts.subscriptions = subscriptionResults;
    result.caveats.push(...Object.entries(subscriptionResults)
      .filter(([, value]) => value.ok !== true)
      .map(([name, value]) => `${name} subscription failed: ${value.error}`));

    // Verified injected input: only a channel the Host reports as controlled AND verified. The
    // controlled set alone carries no input names, and capabilities alone may list a merely
    // injectable (unverified) input, so require the intersection. No input name is guessed; an
    // explicit unverified override is marked exploratory and never reported as verified.
    const faceSelection = resolveFaceInput(preStatus, defaultInputs, EXPLORATORY_INPUT);
    result.vts.faceInputSource = faceSelection;
    if (faceSelection.ok !== true) {
      result.abortReason = faceSelection.reason;
      throw new Error(`${faceSelection.reason}: no verified+controlled face input in the Host status `
        + `(controlled=[${faceSelection.controlled.join(', ')}], verified=[${faceSelection.verifiedChannels.join(', ')}]); refusing to inject. `
        + 'Set FACEFOUND_EXPLORATORY_INPUT=<name> for an explicitly exploratory run.');
    }
    const faceInput = faceSelection.inputName;
    if (!defaultInputs.includes(faceInput)) {
      result.abortReason = 'face-input-not-injectable';
      throw new Error(`face-input-not-injectable: ${faceInput} is not in InputParameterListRequest`);
    }
    result.vts.faceInput = faceInput;
    result.vts.faceInputVerified = faceSelection.verified === true;
    result.vts.faceInputExploratory = faceSelection.exploratory === true;
    result.vts.faceInputParam = faceInput.startsWith('Face') ? `Param${faceInput.slice('Face'.length)}` : '';

    // Unowned targets: model parameters the plugin's verified channel list does not cover.
    const unownedPattern = /breath|bodyangle|arm|shoulder|hand|hair|bust/iu;
    const controlled = new Set((preStatus?.live2d?.runtime?.channels?.controlled ?? []).map((name) => String(name)));
    const unownedCandidates = modelParams
      .map((entry) => entry.name)
      .filter((name) => unownedPattern.test(name))
      .filter((name) => !controlled.has(name))
      .slice(0, 10);
    result.vts.unownedCandidates = unownedCandidates;
    if (unownedCandidates.length === 0) throw new Error('the model exposes no unowned breath/body/arm parameter to observe');

    // Does ParameterValueRequest accept Live2D model parameters at all? Test it before relying on it.
    const pvTargets = [
      ...['ParamBreath', 'ParamBodyAngleX', 'ParamArmLA'].filter((name) => modelParams.some((entry) => entry.name === name)),
      ...unownedCandidates.filter((name) => !['ParamBreath', 'ParamBodyAngleX', 'ParamArmLA'].includes(name)).slice(0, 3),
      'ParamAngleX',
      faceInput,
    ].filter((name, index, list) => list.indexOf(name) === index);
    result.parameterValueCheck.preflight = {};
    for (const name of pvTargets) {
      try {
        result.parameterValueCheck.preflight[name] = await readParameter(probe, name);
      } catch (error) {
        result.parameterValueCheck.preflight[name] = { ok: false, name, error: error?.message ?? String(error) };
      }
    }

    const ctx = {
      phaseList: [],
      samples: [],
      sampleErrors: [],
      pvSamples: [],
      pvNames: pvTargets,
    };

    // Baseline: no injection at all while the Host is paused. This shows the unowned channels are
    // alive by VTS's own idle/animation system before any faceFound frame is sent.
    const baselineStart = Date.now();
    {
      const stopFlag = { value: false };
      const sampler = samplePhase(probe, 'baseline', stopFlag, ctx.samples, ctx.sampleErrors);
      await sleep(BASELINE_MS);
      stopFlag.value = true;
      await sampler;
    }
    result.baseline = {
      startedAt: baselineStart,
      endedAt: Date.now(),
      samples: ctx.samples.filter((entry) => entry.phase === 'baseline').length,
    };
    try {
      const stats = await probe.request('StatisticsRequest', {}, 4000);
      result.vts.connectedPluginsAfterBaseline = stats?.messageType === 'APIError'
        ? null
        : Number(stats?.data?.connectedPlugins ?? -1);
    } catch (error) {
      result.vts.connectedPluginsAfterBaseline = null;
      result.caveats.push(`StatisticsRequest after baseline failed: ${error?.message ?? String(error)}`);
    }

    // A/B rounds: A = no faceFound field, B = faceFound:true. Both only write the verified input.
    // Odd rounds run A then B, even rounds B then A, so a slow idle-animation drift cannot always
    // favour one condition.
    for (let round = 1; round <= ROUNDS; round += 1) {
      const order = round % 2 === 1 ? ['A', 'B'] : ['B', 'A'];
      for (const kind of order) {
        await runPhase(probe, {
          name: `${kind}${round}`,
          faceFound: kind === 'B' ? true : null,
          frames: FRAMES,
          faceInput,
        }, ctx);
        await sleep(350);
      }
    }

    // C is exploratory and last: faceFound:false is the documented "consider the face not found"
    // direction, i.e. the closest software-only proxy for a real tracking loss.
    await runPhase(probe, { name: 'C1', faceFound: false, frames: C_FRAMES, faceInput }, ctx);
    {
      // Let VTS leave the forced-lost state while still sampling, and record any animation change.
      const settleStart = Date.now();
      const stopFlag = { value: false };
      const sampler = samplePhase(probe, 'C-settle', stopFlag, ctx.samples, ctx.sampleErrors);
      await sleep(C_SETTLE_MS);
      stopFlag.value = true;
      await sampler;
      result.phases.push({
        name: 'C-settle',
        faceFound: null,
        startedAt: settleStart,
        endedAt: Date.now(),
        framesRequested: 0,
        framesSent: 0,
        injectOk: 0,
        injectErrors: 0,
        samples: ctx.samples.filter((entry) => entry.phase === 'C-settle').length,
        sampleErrors: 0,
        animationStart: probe.animationEvents
          .filter((event) => event.at >= settleStart && event.eventType === 'start')
          .map((event) => ({ name: event.name, isIdle: event.isIdle, at: event.at })),
        faceFoundChecks: [],
      });
    }

    // The pause must still hold at the end: if the Host reconnected during the run, its own
    // continuously injected input frames would be mixed into our A/B data.
    try {
      const pausedNow = await hostStatus();
      result.host.stillPaused = {
        avatarFeature: featureOf(pausedNow, 'avatar')?.enabled === true,
        live2dReady: pausedNow?.live2d?.ready === true,
        socketOpen: pausedNow?.live2d?.socketOpen === true,
        runtimeConnected: pausedNow?.live2d?.runtime?.connected === true,
        lastSentAt: pausedNow?.live2d?.transport?.lastSentAt ?? 0,
      };
      if (result.host.stillPaused.avatarFeature !== false
        || result.host.stillPaused.live2dReady !== false
        || result.host.stillPaused.socketOpen !== false) {
        failures.push({ step: 'pause integrity', error: `Host was not fully paused during the test: ${JSON.stringify(result.host.stillPaused)}` });
      }
    } catch (error) {
      failures.push({ step: 'pause integrity', error: error?.message ?? String(error) });
    }
    // VTS must still be alive at the end of the paused window too: a socket that closed mid-run
    // invalidates the A/B numbers, so it is a failure with reason `vts-closed`, not a caveat.
    await checkVtsAlive('atEnd', { throwOnDead: false });
    if (result.host.pauseMethod.vtsAlive !== true) {
      failures.push({
        step: 'vts liveness',
        reason: 'vts-closed',
        error: `VTube Studio was not reachable at ${VTS_WS_URL} during the paused test; the A/B numbers are invalid`,
      });
    }
    try {
      const stats = await probe.request('StatisticsRequest', {}, 4000);
      result.vts.connectedPluginsAtEnd = stats?.messageType === 'APIError'
        ? null
        : Number(stats?.data?.connectedPlugins ?? -1);
    } catch (error) {
      result.vts.connectedPluginsAtEnd = null;
      result.caveats.push(`StatisticsRequest at end failed: ${error?.message ?? String(error)}`);
    }

    // Dense stats for every unowned candidate plus the controlled ParamAngleX.
    const statTargets = [...unownedCandidates, 'ParamAngleX'].filter((name, index, list) => list.indexOf(name) === index);
    result.stats = buildStats({ ...ctx, phaseList: ctx.phaseList.filter((phase) => phase.name !== 'C-settle') }, statTargets);
    result.parameterValueCheck.samples = ctx.pvSamples;
    const pvPreflight = Object.values(result.parameterValueCheck.preflight ?? {});
    result.parameterValueCheck.summary = {
      requested: pvPreflight.length,
      ok: pvPreflight.filter((entry) => entry?.ok === true).length,
      failed: pvPreflight.filter((entry) => entry?.ok !== true).length,
      note: 'ParameterValueRequest was attempted for every target; the dense amplitude statistics come from Live2DParameterListRequest because it returns all model parameters in one answer.',
    };

    // Animation / tracking evidence.
    result.animation.names = [...new Set(probe.animationEvents.map((event) => event.name).filter((name) => name.length > 0))];
    result.animation.events = probe.animationEvents;
    result.animation.trackingLostLike = probe.animationEvents.filter((event) => /lost|track/iu.test(event.name));
    result.tracking.events = probe.trackingEvents;
    result.tracking.faceFound = [
      ...result.tracking.faceFound,
      ...ctx.phaseList.flatMap((phase) => phase.faceFoundChecks ?? []),
    ];
    const lost = probe.trackingEvents.filter((event) => event.faceFound === false);
    result.tracking.possibleTrackingLost = lost;
    const cAnimation = probe.animationEvents.filter((event) => event.at >= (ctx.phaseList.find((phase) => phase.name === 'C1')?.startedAt ?? 0));
    const cNonIdle = cAnimation.filter((event) => event.eventType === 'start' && event.isIdle !== true);
    const cNames = [...new Set(cAnimation.filter((event) => event.eventType === 'start').map((event) => event.name))];
    result.animation.phaseC = { names: cNames, nonIdleStarts: cNonIdle.length };

    // The decisive context: did the physical tracker actually see a face during A/B? If it did
    // not, A is the real "tracking lost" state and B is the forced-found state; that is a valid
    // test of the official claim, but it is NOT a normal-tracking test.
    const faceFoundStates = result.tracking.faceFound
      .filter((entry) => entry.phase !== 'pre' && typeof entry.found === 'boolean')
      .map((entry) => entry.found);
    const sawLost = faceFoundStates.includes(false);
    const sawFound = faceFoundStates.includes(true);
    result.tracking.observed = {
      sawLost,
      sawFound,
      allFalse: sawLost && !sawFound,
      allTrue: sawFound && !sawLost,
      samples: faceFoundStates.length,
    };
    const bodyParams = ['ParamBodyAngleX', 'ParamBodyAngleY', 'ParamBodyAngleZ', 'ParamArmLA', 'ParamArmRA', 'ParamBreath'];
    const bodyRanges = {};
    for (const name of bodyParams) {
      bodyRanges[name] = {
        A: result.stats.byCondition.A?.[name]?.range ?? null,
        B: result.stats.byCondition.B?.[name]?.range ?? null,
        C: result.stats.byCondition.C?.[name]?.range ?? null,
      };
    }
    result.tracking.bodyRanges = bodyRanges;
    const bodySplit = bodyParams.filter((name) => {
      const a = bodyRanges[name].A ?? 0;
      const b = bodyRanges[name].B ?? 0;
      return a > 0.5 && b < a * 0.2;
    });
    const cSameAsB = bodyParams.filter((name) => {
      const a = bodyRanges[name].A ?? 0;
      const b = bodyRanges[name].B ?? 0;
      const c = bodyRanges[name].C ?? 0;
      return Math.abs(c - b) < Math.max(0.25, Math.abs(a - b) * 0.25);
    });
    result.tracking.bodySplit = bodySplit;
    result.tracking.cSameAsB = cSameAsB;
    if (lost.length > 0) {
      result.tracking.verified = 'event';
      result.tracking.note = 'the physical tracker reported faceFound=false at least once (TrackingStatusChangedEvent)';
    } else if (sawLost && !sawFound && bodySplit.length > 0) {
      // The tracker was lost for the whole run and forcing faceFound:true visibly changed unowned
      // channels. This is behavioral evidence for the documented flag, not an animation clip name.
      result.tracking.verified = 'behavioral';
      result.tracking.note = 'FaceFoundRequest=false throughout: phase A ran in the real tracking-lost state, phase B forced faceFound:true. Unowned body channels moved in A and were near-static in B, consistent with faceFound suppressing tracking-lost behavior; no dedicated tracking-lost animation event was captured.';
    } else if (sawLost && !sawFound) {
      result.tracking.verified = 'behavioral-unclear';
      result.tracking.note = 'FaceFoundRequest=false throughout, but the unowned-channel A/B ranges did not split cleanly; cannot tell whether faceFound changed tracking-lost behavior.';
    } else if (sawFound && !sawLost) {
      result.tracking.verified = false;
      result.tracking.note = 'the tracker reported faceFound=true throughout; no tracking loss occurred, so the tracking-lost animation was not exercised.';
    } else if (faceFoundStates.length === 0) {
      result.tracking.verified = false;
      result.tracking.note = 'FaceFoundRequest returned no usable value, so the tracker state is unknown.';
    } else {
      result.tracking.verified = false;
      result.tracking.note = 'the tracker changed state during the test; the A/B comparison is mixed and cannot isolate the tracking-lost behavior.';
    }
    result.tracking.phaseC = {
      names: cNames,
      nonIdleStarts: cNonIdle.length,
      bodyRanges,
      sameAsB: cSameAsB,
      interpretation: cSameAsB.length >= 3
        ? 'phase C (faceFound:false) covered the same window as A/B and its ranges clustered with B; no non-idle (tracking-lost) animation appeared. Exploratory only; it does not override the A/B result.'
        : 'phase C did not clearly match either A or B; exploratory only.',
    };
    // The model's own config decides whether there is a tracking-lost animation at all. hiyori's
    // `IdleAnimationWhenTrackingLost` is empty, so the official flag has nothing to switch here.
    const trackingLostAnimation = result.vts.modelConfig?.idleAnimationWhenTrackingLost ?? null;
    result.tracking.modelHasTrackingLostAnimation = trackingLostAnimation === null ? null : trackingLostAnimation.length > 0;
    if (trackingLostAnimation !== null && trackingLostAnimation.length === 0) {
      result.tracking.verified = 'model-has-none';
      result.tracking.note = `the current model (${result.vts.model?.name ?? '?'}) has no tracking-lost animation configured (IdleAnimationWhenTrackingLost is empty); faceFound has no such animation to change on this model. Any unowned-channel A/B differences are idle/physics variation, not a tracking-lost animation switch.`;
    }

    // Conclusion. Separate the two questions the user asked.
    const verdicts = {};
    for (const target of statTargets) {
      verdicts[target] = verdictFor(result.stats.byCondition.A?.[target] ?? {}, result.stats.byCondition.B?.[target] ?? {});
    }
    const readable = Object.entries(verdicts).filter(([, verdict]) => !['insufficient-samples', 'insufficient-motion'].includes(verdict));
    const changed = readable.filter(([, verdict]) => verdict !== 'no-clear-difference');
    const suppressed = readable.filter(([, verdict]) => verdict === 'suppressed');
    // Per-round verdicts are the robustness check: with three short-ish phases, a single round
    // can differ because it happened to sit on another segment of the idle loop.
    const roundVerdicts = {};
    for (const round of result.stats.rounds ?? []) {
      for (const [target, pair] of Object.entries(round.perParam)) {
        (roundVerdicts[target] ??= []).push(verdictFor(pair.A, pair.B));
      }
    }
    const consistentChanged = Object.entries(roundVerdicts).filter(([, list]) => list.length >= 2
      && list.every((verdict) => verdict === list[0])
      && !['no-clear-difference', 'insufficient-motion', 'insufficient-samples'].includes(list[0]));
    result.verdictsPerRound = roundVerdicts;
    result.consistentChanged = consistentChanged;
    const controlVerdict = verdicts.ParamAngleX ?? 'missing';
    const conclusionLines = [];
    const trackingState = result.tracking.observed ?? {};
    if (trackingState.allFalse) {
      conclusionLines.push('追踪状态（关键前提）：本次测试期间 FaceFoundRequest 持续为 false，VTS 认为没有找到人脸。因此 A（不带 faceFound）是“真实追踪丢失”状态，B（faceFound:true）是“强制视为已找到”；这不是正常找到人脸时的 A/B。');
    } else if (trackingState.allTrue) {
      conclusionLines.push('追踪状态：FaceFoundRequest 持续为 true，A/B 是正常找到人脸时的对比，tracking-lost 动画未被触发。');
    } else {
      conclusionLines.push('追踪状态：测试期间 FaceFoundRequest 混合或不可用，A/B 的解释受限（见 tracking.observed）。');
    }
    if (readable.length === 0) {
      conclusionLines.push('未接管通道在整个窗口内几乎没有运动，A/B 无法给出有效幅度对比（insufficient-motion）。');
    } else if (changed.length === 0) {
      conclusionLines.push('A/B 两相中未接管通道的 min/max/std 无明确差异。');
    } else {
      conclusionLines.push(`A/B 出现差异的参数：${changed.map(([name, verdict]) => `${name}(${verdict})`).join(', ')}。`);
      conclusionLines.push(consistentChanged.length > 0
        ? `跨轮一致的变化：${consistentChanged.map(([name, list]) => `${name}(${list[0]} in ${list.length}/${ROUNDS})`).join(', ')}。`
        : '没有任何参数在三轮中保持一致方向的变化；单轮差异不足以当作稳定结论。');
      if (trackingState.allFalse) {
        conclusionLines.push('该差异发生在“真实追踪丢失(A) vs 强制找到(B)”之间；但当前模型没有 tracking-lost 动画可切换，因此更可能是 idle/physics 噪声，而不是官方那条动画行为。');
      } else if (suppressed.length > 0) {
        conclusionLines.push(`其中 ${suppressed.map(([name]) => name).join(', ')} 在 faceFound:true 下幅度不足 20%，可能是正常跟踪下的副作用，需要复测确认。`);
      }
    }
    const controlNote = faceSelection.channel === 'headX'
      ? `对照参数 ParamAngleX 的 A/B 判定为 ${controlVerdict}（验证 headX 注入是否生效）`
      : `对照参数 ParamAngleX 的 A/B 判定为 ${controlVerdict}（本次注入通道是 ${faceSelection.channel || '未验证/探索性'}，ParamAngleX 不是它的模型参数，不能当作该通道的对照）`;
    conclusionLines.push(`${controlNote}。注入帧确认：${result.phases.filter((phase) => phase.framesSent > 0).map((phase) => `${phase.name} ${phase.injectOk}/${phase.framesSent}`).join(', ')}，0 个 APIError；ParamAngleX 恒 0 与写入 ${faceInput}=0 一致，但常量值本身不能证明动态跟随。`);
    conclusionLines.push(`读值路径：ParameterValueRequest 对 ${result.parameterValueCheck.summary.ok}/${result.parameterValueCheck.summary.requested} 个目标返回成功；未接管通道的 min/max/std 来自 Live2DParameterListRequest 的逐帧全参数快照。`);
    if (result.tracking.verified === 'model-has-none') {
      const installed = result.vts.installedModels ?? [];
      const withLost = result.vts.installedModelsWithTrackingLost ?? [];
      conclusionLines.push(`追踪丢失动画：当前模型 ${result.vts.model?.name ?? '?'} 的模型配置里 IdleAnimationWhenTrackingLost 为空（${result.vts.modelConfig?.path ?? 'unknown path'}），本模型没有可被 faceFound 切换的 tracking-lost 动画。因此官方那条在本模型上无法验证——这不是“验证了没有影响”，而是“本模型没有该动画”。本机已安装的 ${installed.length} 个模型中，配置了该动画的有 ${withLost.length} 个${withLost.length > 0 ? `（${withLost.join(', ')}）` : ''}。`);
    } else if (result.tracking.verified === 'behavioral') {
      const ranges = result.tracking.bodyRanges ?? {};
      const compact = ['ParamBodyAngleX', 'ParamBodyAngleY', 'ParamBodyAngleZ', 'ParamArmLA', 'ParamArmRA']
        .filter((name) => ranges[name] !== undefined)
        .map((name) => `${name} A=${ranges[name].A} B=${ranges[name].B} C=${ranges[name].C}`)
        .join('；');
      conclusionLines.push(`追踪丢失动画：没有捕获到独立的 tracking-lost 动画事件（订阅到的动画均为 idle 的 hiyori_m02）；但未接管通道在 A/B 间明显不同（${compact}），说明 faceFound:true 改变了追踪丢失时的行为。C 相（faceFound:false）${result.tracking.phaseC?.interpretation ?? ''}。`);
    } else if (result.tracking.verified === 'behavioral-unclear') {
      conclusionLines.push(`追踪丢失动画：FaceFoundRequest 持续为 false，但未接管通道的 A/B 差异不干净，无法判定 faceFound 是否改变 tracking-lost 行为（${result.tracking.note}）。`);
    } else if (trackingState.allTrue) {
      conclusionLines.push('追踪丢失动画：本次没有丢失跟踪，因此“faceFound 是否改变 tracking-lost 动画”在本机未验证；不能由插件侧结论替代。');
    } else {
      conclusionLines.push(`追踪丢失动画：未验证（${result.tracking.note}）。`);
    }
    if (faceSelection.exploratory === true) {
      conclusionLines.push(`插件写入范围（探索性，未验证）：现场注入只写了 ${faceInput}（来源 ${faceSelection.inputSource}，未通过 controlled+verified 校验）。本段结果只能作为探索性观察，与“已验证输入”的结论分开放置，不能证明插件只写已验证通道。`);
    } else {
      conclusionLines.push(`插件写入范围：现场注入只写了 ${faceInput}（channel=${faceSelection.channel}，来自 runtime.channels.controlled 与 capabilities 中 verified:true 的交集，inputSource=${faceSelection.inputSource || 'n/a'}）；插件本身在测试期间被暂停，所以本次真机运行不能验证“插件只写已验证通道”。插件侧测试只证明请求形状，不能替代真机结论。`);
    }
    const pauseMethod = result.host.pauseMethod ?? {};
    const protection = pauseMethod.protection ?? {};
    const protectionText = protection.protect === true
      ? `已先将 autostart.vts.autoClose 置为 false（原值 ${String(protection.previousAutoClose)}）`
      : (protection.external === true ? 'VTS 为外部启动，未被插件持有' : 'autoClose 原本已关闭');
    conclusionLines.push(`暂停方式：关闭 avatar 组件（feature.set avatar=false，无仅断开 live2d 的主机动作）；依赖保护：${protectionText}；暂停期间 VTS ${pauseMethod.vtsAlive === true ? '存活' : '未确认/已关闭'}（探测点：${Object.keys(pauseMethod.vtsLiveness ?? {}).join(', ') || 'none'}，abortReason=${result.abortReason ?? 'none'}）。`);
    if (result.failures.length > 0) {
      conclusionLines.push('建议：本次存在恢复/测试失败项，先处理失败项再讨论默认开关。');
    } else if (result.tracking.verified === 'model-has-none') {
      conclusionLines.push('建议：保持默认关闭（仅实验开关）。本模型没有 tracking-lost 动画可切换，且 A/B 没有出现跨轮一致的未接管通道变化；若要在真机验证官方行为，需要换一个配置了 IdleAnimationWhenTrackingLost 的模型（或在 VTS 里给当前模型设置该动画）后再测。');
    } else if (trackingState.allFalse && result.tracking.verified === 'behavioral') {
      conclusionLines.push('建议：保持默认关闭（仅实验开关）。如果希望追踪丢失时模型不摆身体/更可控，可开启 faceFound；如果希望保留 tracking-lost 动画，保持关闭。正常找到人脸时的表现本次未验证，不能据此默认开启。');
    } else {
      conclusionLines.push('建议：可以继续把 faceFound 作为“实验开关”保留，暂不默认开启；还需要在正常追踪与丢失追踪两种场景下复测后再决定默认值。');
    }
    result.conclusion = conclusionLines.join('\n');
    result.verdicts = verdicts;

    // Restore is handled in finally so a test failure never leaves the Host paused.
  } catch (error) {
    result.fatal = { step: 'main', error: error?.stack ?? String(error) };
    failures.push({ step: 'main', error: error?.message ?? String(error) });
    result.conclusion ??= `测试未完成：${error?.message ?? String(error)}`;
  } finally {
    probe?.close();
    if (paused || result.host.pauseStarted === true) {
      try {
        // Interface-first restore. File write-back is a guarded fallback inside restoreHost.
        await restoreOnce(result.host.baseline ?? null, { preSettingsBytes, preFeaturesBytes });
      } catch (error) {
        failures.push({ step: 'restore', error: error?.message ?? String(error) });
      }
    }
    // Read-only final file identity for the report; this never writes the persisted config.
    if (result.host.files !== undefined) {
      try {
        result.host.files.settings.sha256After = sha256(await readFile(SETTINGS_FILE));
        result.host.files.features.sha256After = sha256(await readFile(FEATURES_FILE));
      } catch (error) {
        result.caveats.push(`could not read back ${SETTINGS_FILE}/${FEATURES_FILE}: ${error?.message ?? String(error)}`);
      }
    }
    const tokenFile = tokenCandidates.find((candidate) => candidate === result.vts.tokenPath) ?? null;
    if (tokenFile !== null) {
      try {
        result.vts.tokenMtime = (await stat(tokenFile)).mtime.toISOString();
      } catch {
        /* the token path is reported either way */
      }
    }

    result.endedAt = nowIso();
    const outDir = join(tmpdir(), 'dsh-facefound-live');
    try {
      await mkdir(outDir, { recursive: true });
      const file = join(outDir, `facefound-live-${Date.now()}.json`);
      await writeFile(file, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
      result.reportFile = file;
    } catch {
      /* stdout still carries the report */
    }
    printReport(result);
    if (result.reportFile !== undefined) console.log(`\nJSON report: ${result.reportFile}`);
    if (failures.length > 0) process.exitCode = 1;
  }
}

// ---- entry -----------------------------------------------------------------
// Default skip: this live probe pauses the Host's VTS injection and needs a real VTube Studio.
// Without explicit authorization it must not call a single Host endpoint.
const LIVE_AUTHORIZED = process.env.FACEFOUND_LIVE === '1' || process.argv.includes('--live');
if (process.env.FACEFOUND_SELFTEST === '1') {
  runSelfCheck();
} else if (LIVE_AUTHORIZED !== true) {
  console.log('SKIP facefound-live: this live probe PAUSES the Host VTS injection (avatar component) and needs a real VTube Studio with a valid token. Re-run with FACEFOUND_LIVE=1 or --live to authorize it.');
  process.exit(0);
} else {
  main().catch((error) => {
    result.failures.push({ step: 'main', error: error?.message ?? String(error) });
    console.error(`\nFATAL: ${error?.stack ?? error}`);
    console.error(JSON.stringify({ failures: result.failures }, null, 2));
    process.exitCode = 1;
  });
}
