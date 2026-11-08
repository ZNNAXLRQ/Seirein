/**
 * Controlled, read-only diagnostics channel (P-111).
 *
 * This module is deliberately not a log tail: callers name one of a fixed set of probes, each
 * probe projects its rows through an explicit field whitelist, and every query is bounded by a
 * row limit, an age window and a byte budget. Raw event rows, free-form file contents and
 * credential-looking values never leave here. Querying never writes memory and never calls a
 * model; the only side effect is the `diagnostics.query` audit event.
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import {
  VOICE_LATENCY_FIELDS,
  VOICE_LATENCY_OBSERVATION_FIELDS,
  VOICE_LATENCY_OPTIONAL_FIELDS,
} from '../../session/delivery/dispatch.js';
import { TOOL_KINDS } from '../../session/timeline/turn-timeline.js';

/** Query defaults and hard caps. `limit` is clamped, never trusted. */
export const DIAGNOSTICS_LIMITS = Object.freeze({
  defaultLimit: 20,
  maxLimit: 50,
  scanBytes: 256 * 1024,
  maxAgeMs: 24 * 60 * 60 * 1000,
});

/**
 * The timeline probes are bounded deeper than the event probes (a row is a whole round, not one
 * stage), but a caller still cannot widen the window: `limit` is clamped to this hard cap.
 */
export const DIAGNOSTICS_TIMELINE_LIMITS = Object.freeze({ defaultLimit: 20, maxLimit: 100 });

/** Hard cap on phases a probe may return even when `includePhases` is requested. */
export const DIAGNOSTICS_TIMELINE_PHASE_CAP = 64;

/** Rotated generations of the event log (`events.jsonl.1` to `.5`, see runtime/event-log.js). */
export const DIAGNOSTICS_EVENT_GENERATIONS = 5;

/** The canonical event probes (aliases are resolved below and never add a new surface). */
const VOICE_FIELDS = Object.freeze([
  'ts',
  'turn',
  'deliveryMessageId',
  'acceptTurn',
  ...VOICE_LATENCY_FIELDS,
  ...VOICE_LATENCY_OPTIONAL_FIELDS,
  ...VOICE_LATENCY_OBSERVATION_FIELDS,
  'firstAudibleLane',
  'firstAudibleUnknown',
  'firstChunkToAudioMs',
  'textToFirstAudioMs',
  'spokenVersionMs',
  'spokenVersionUsed',
  'spokenSource',
]);

/**
 * Noise-shadow rows are metrics only. Transcript fields (`text`, `onlineText`, `offlineText`),
 * the audio device name and internal segment/decode ids are intentionally not projected.
 */
const NOISE_FIELDS = Object.freeze([
  'ts',
  'endpointReason',
  'durationMs',
  'maxDurationMs',
  'voicedMs',
  'voicedRatio',
  'onlineOfflineAgree',
  'playing',
  'rmsDb',
  'peakDb',
  'suspect',
  'delivered',
  'tags',
]);

/** The new probes' event types (one source for the registry and the projections below). */
const TURN_TIMELINE_EVENT = 'voice.turn.timeline';
const PIPELINE_TIMELINE_EVENT = 'voice.pipeline.timeline';

/**
 * `turn.timeline` projection: one summary row per round. The phases array is replaced by
 * `phaseNames` / `longestPhase` / `toolKinds` / `phaseCount`, so the default answer stays small.
 */
const TURN_TIMELINE_FIELDS = Object.freeze([
  'timelineId',
  'sessionId',
  'turn',
  'acceptTurn',
  'deliveryMessageId',
  'groupId',
  'lane',
  'status',
  'reason',
  'origin',
  'counts',
  'overlaps',
  'residualMs',
  'droppedPhases',
  'phaseCount',
  'phaseNames',
  'longestPhase',
  'toolKinds',
]);

/** The `turn.timeline` shape with `includePhases: true`: `phases` is the only added key. */
export const DIAGNOSTICS_TURN_TIMELINE_FIELDS = Object.freeze([...TURN_TIMELINE_FIELDS, 'phases']);

/** One projected phase: a fixed field set, never `extra`, tool arguments or a tool result. */
export const DIAGNOSTICS_TIMELINE_PHASE_FIELDS = Object.freeze([
  'name',
  'actionId',
  'startMs',
  'endMs',
  'durMs',
  'source',
  'status',
  'reason',
  'wait',
  'toolName',
  'toolKind',
  'parallelGroup',
]);

/** The `voice.latency` stages `pipeline.timeline` joins onto its own row. */
const PIPELINE_LATENCY_FIELDS = Object.freeze(['totalMs', 'asrMs', 'injectToAckMs', 'ackToFirstTextMs']);

/** `pipeline.timeline` projection: the five pipeline stages plus the four joined latency stages. */
export const DIAGNOSTICS_PIPELINE_TIMELINE_FIELDS = Object.freeze([
  'turn',
  'sessionId',
  'deliveryMessageId',
  'bodyReadyMs',
  'spokenFirstSentenceMs',
  'translatedFirstMs',
  'firstChunkSynthMs',
  'firstAudioMs',
  ...PIPELINE_LATENCY_FIELDS,
]);

/** Whitelisted probes. `fields` is the only projection for an event probe. */
export const DIAGNOSTICS_PROBES = Object.freeze({
  'voice.latency': Object.freeze({ kind: 'events', type: 'voice.latency', fields: VOICE_FIELDS }),
  'noise.shadow': Object.freeze({ kind: 'events', type: 'hearing.noise.shadow', fields: NOISE_FIELDS }),
  'hearing.noise.shadow': Object.freeze({ kind: 'events', type: 'hearing.noise.shadow', fields: NOISE_FIELDS }),
  // P-46 stage 3: a round's own timeline, summarized. The phases array is NOT part of the default
  // projection (it is the biggest part of the row); `includePhases: true` appends a capped,
  // per-field projection of it.
  'turn.timeline': Object.freeze({
    kind: 'timeline',
    type: TURN_TIMELINE_EVENT,
    fields: TURN_TIMELINE_FIELDS,
    limit: DIAGNOSTICS_TIMELINE_LIMITS,
  }),
  // P-46 stage 3: the spoken pipeline stages, joined to the same round's `voice.latency` stages.
  'pipeline.timeline': Object.freeze({
    kind: 'pipeline',
    type: PIPELINE_TIMELINE_EVENT,
    fields: DIAGNOSTICS_PIPELINE_TIMELINE_FIELDS,
    limit: DIAGNOSTICS_TIMELINE_LIMITS,
  }),
  hotkeys: Object.freeze({ kind: 'state', source: 'hotkeys' }),
  hotkey: Object.freeze({ kind: 'state', source: 'hotkeys' }),
  'memory.stats': Object.freeze({ kind: 'state', source: 'memory.stats' }),
  spout: Object.freeze({ kind: 'state', source: 'spout' }),
});

const PROBE_ALIASES = Object.freeze({
  'hearing.noise.shadow': 'noise.shadow',
  hotkey: 'hotkeys',
});

/**
 * Resolve the opt-in switch: an explicit boolean in settings.json is authoritative; otherwise
 * the plugin config is the baseline; absent both the channel is OFF. Exported so the host wiring
 * and the tests share one rule instead of a second copy.
 */
export function resolveDiagnosticsEnabled(settings = null, config = null) {
  const saved = settings?.diagnostics;
  if (saved !== null && typeof saved === 'object' && typeof saved.enabled === 'boolean') return saved.enabled;
  // Config spellings accepted for older hand-written patches: `diagnostics: true`, its nested
  // `enabled` flag, or the flat `diagnosticsEnabled` key. Absent all of them means OFF.
  return config?.diagnostics === true
    || config?.diagnostics?.enabled === true
    || config?.diagnosticsEnabled === true;
}

const SENSITIVE_KEY = /(?:token|secret|password|passwd|credential|authorization|cookie|api[_-]?key|access[_-]?key|private[_-]?key)/i;

/** Strip credential-shaped strings even when a whitelisted field happens to contain one. */
export function redactDiagnosticText(value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  return value
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, '$1 [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[redacted]')
    .replace(/\b(?:sk|pk|ghp|gho|ghs|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/gi, '[redacted]')
    .replace(/\b[a-f0-9]{32,}\b/gi, '[redacted]')
    .replace(/((?:token|secret|password|passwd|api[_-]?key|authorization)\s*[=:]\s*)(?!Bearer\b|Basic\b)[^\s,;]+/gi, '$1[redacted]');
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Bounded recursive sanitizer for state probes (never a raw passthrough). */
export function sanitizeDiagnosticValue(value, depth = 0) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return redactDiagnosticText(value).slice(0, 512);
  if (depth >= 3) return null;
  if (Array.isArray(value)) {
    return value.slice(0, 16).map((entry) => sanitizeDiagnosticValue(entry, depth + 1));
  }
  if (isPlainObject(value)) {
    const output = {};
    for (const [key, entry] of Object.entries(value).slice(0, 24)) {
      if (SENSITIVE_KEY.test(key) || entry === undefined) continue;
      output[key] = sanitizeDiagnosticValue(entry, depth + 1);
    }
    return output;
  }
  return null;
}

const finiteNumber = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);

/** A count/step/version: absent or empty stays null (a measured 0 is preserved). */
const intOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : null;
};

/** A duration or stamp: absent stays null (a measured 0 is preserved). */
const msOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : null;
};

/**
 * A short token: an id, an enum value or an error CODE. Anything that is not one (a sentence, a
 * path, a tool argument) collapses to null, so a projected phase or origin never carries free
 * text even when the raw event does.
 */
const TOKEN_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:#-]{0,159}$/u;
function tokenOf(value, max = 96) {
  if (typeof value !== 'string') return null;
  const text = redactDiagnosticText(value.trim()).slice(0, max);
  return text.length === 0 || !TOKEN_SHAPE.test(text) ? null : text;
}

/** State probes are built from named fields; unknown fields and sensitive keys never pass. */
const STATE_PROJECTORS = Object.freeze({
  hotkeys(raw) {
    const bindings = [];
    for (const [action, combo] of Object.entries(raw?.bindings ?? {}).slice(0, 32)) {
      if (SENSITIVE_KEY.test(action)) continue;
      bindings.push({ action, combo: sanitizeDiagnosticValue(combo) });
    }
    const last = raw?.lastTrigger ?? null;
    return [{
      bindings,
      lastAction: typeof last?.action === 'string' ? redactDiagnosticText(last.action) : '',
      lastCombo: typeof last?.combo === 'string' ? redactDiagnosticText(last.combo) : '',
      lastAt: typeof last?.ts === 'string' ? redactDiagnosticText(last.ts) : '',
    }];
  },
  'memory.stats'(raw) {
    const usage = raw?.usage ?? {};
    const states = raw?.states ?? {};
    return [{
      records: finiteNumber(usage.records),
      chars: finiteNumber(usage.chars),
      archived: finiteNumber(usage.archived),
      capacity: finiteNumber(usage.capacity),
      ratio: finiteNumber(usage.ratio),
      candidate: finiteNumber(states.candidate),
      delivered: finiteNumber(states.delivered),
      persisted: finiteNumber(states.persisted),
      total: finiteNumber(states.total),
    }];
  },
  spout(raw) {
    return [{
      running: raw?.running === true,
      pid: finiteNumber(raw?.pid),
      configured: raw?.configured === true,
      readyPhase: sanitizeDiagnosticValue(raw?.readyPhase),
      error: sanitizeDiagnosticValue(raw?.error),
      versions: sanitizeDiagnosticValue(raw?.versions),
      captureRect: sanitizeDiagnosticValue(raw?.captureRect),
      alphaSample: sanitizeDiagnosticValue(raw?.alphaSample),
      lastExit: sanitizeDiagnosticValue(raw?.lastExit),
    }];
  },
});

/** Project one event row through its whitelist; no other payload key can leak. */
function projectEventRow(definition, row) {
  const payload = isPlainObject(row?.payload) ? row.payload : {};
  const output = {};
  for (const field of definition.fields) {
    if (field === 'ts') {
      output.ts = typeof row?.ts === 'string' ? redactDiagnosticText(row.ts) : null;
      continue;
    }
    if (!Object.hasOwn(payload, field) || payload[field] === undefined) continue;
    if (SENSITIVE_KEY.test(field)) continue;
    output[field] = sanitizeDiagnosticValue(payload[field]);
  }
  return output;
}

/** Dedupe the names, count the tool kinds and keep the longest phase, never a phase itself. */
function summarizePhases(phases) {
  const names = [];
  const toolKinds = Object.fromEntries(TOOL_KINDS.map((kind) => [kind, 0]));
  let longest = null;
  for (const phase of Array.isArray(phases) ? phases : []) {
    if (!isPlainObject(phase)) continue;
    const name = tokenOf(phase.name, 32);
    if (name !== null && names.length < 12 && !names.includes(name)) names.push(name);
    const kind = isPlainObject(phase.tool) ? phase.tool.kind : null;
    if (name === 'tool' && Object.hasOwn(toolKinds, kind)) toolKinds[kind] += 1;
    const durMs = msOrNull(phase.durMs);
    if (durMs === null || durMs < 0) continue;
    if (longest === null || durMs > longest.durMs) longest = { name, durMs };
  }
  return { names, longest, toolKinds };
}

/** One phase, field by field: no `extra`, no tool arguments and no tool result ever pass. */
function projectPhase(phase) {
  if (!isPlainObject(phase)) return null;
  const tool = isPlainObject(phase.tool) ? phase.tool : {};
  return {
    name: tokenOf(phase.name, 32),
    actionId: tokenOf(phase.actionId, 96),
    startMs: msOrNull(phase.startMs),
    endMs: msOrNull(phase.endMs),
    durMs: msOrNull(phase.durMs),
    source: tokenOf(phase.source, 32),
    status: tokenOf(phase.status, 24),
    reason: tokenOf(phase.reason, 32),
    wait: phase.wait === true,
    toolName: tokenOf(tool.name, 64),
    toolKind: TOOL_KINDS.includes(tool.kind) ? tool.kind : null,
    parallelGroup: tokenOf(tool.parallelGroup, 12),
  };
}

/** `turn.timeline`: one row per round; the phases array is replaced by its summary. */
function projectTurnTimelineRow(row, includePhases) {
  const payload = isPlainObject(row?.payload) ? row.payload : {};
  const phases = Array.isArray(payload.phases) ? payload.phases : null;
  const summary = summarizePhases(phases);
  const output = {
    timelineId: tokenOf(payload.timelineId, 160),
    sessionId: tokenOf(payload.sessionId, 96),
    turn: intOrNull(payload.turn),
    acceptTurn: intOrNull(payload.acceptTurn),
    deliveryMessageId: tokenOf(payload.deliveryMessageId, 96),
    groupId: tokenOf(payload.groupId, 96),
    lane: tokenOf(payload.lane, 24),
    status: tokenOf(payload.status, 24),
    reason: tokenOf(payload.reason, 32),
    origin: {
      at: msOrNull(payload.origin?.at),
      source: tokenOf(payload.origin?.source, 16),
    },
    counts: {
      modelRounds: intOrNull(payload.counts?.modelRounds),
      attempts: intOrNull(payload.counts?.attempts),
      attemptFailures: intOrNull(payload.counts?.attemptFailures),
      toolCalls: intOrNull(payload.counts?.toolCalls),
      toolFailures: intOrNull(payload.counts?.toolFailures),
      retries: intOrNull(payload.counts?.retries),
    },
    overlaps: {
      toolMsSum: msOrNull(payload.overlaps?.toolMsSum),
      toolWallMs: msOrNull(payload.overlaps?.toolWallMs),
      parallelTools: intOrNull(payload.overlaps?.parallelTools),
    },
    residualMs: msOrNull(payload.residualMs),
    droppedPhases: intOrNull(payload.droppedPhases),
    phaseCount: phases === null ? null : phases.length,
    phaseNames: summary.names,
    longestPhase: summary.longest,
    toolKinds: summary.toolKinds,
  };
  // Opt-in only: a full phase list is the biggest part of the row, so it is capped and projected.
  if (includePhases === true && phases !== null) {
    output.phases = phases
      .slice(0, DIAGNOSTICS_TIMELINE_PHASE_CAP)
      .map(projectPhase)
      .filter((phase) => phase !== null);
  }
  return output;
}

/** The four joined `voice.latency` stages as one value object; an unmeasured stage stays null. */
function latencyStages(payload) {
  const stages = {};
  for (const field of PIPELINE_LATENCY_FIELDS) stages[field] = msOrNull(payload?.[field]);
  return stages;
}

const NO_LATENCY = Object.freeze(Object.fromEntries(PIPELINE_LATENCY_FIELDS.map((field) => [field, null])));

/**
 * Keep the newest candidate by EVENT time. A row with no usable stamp keeps insertion order as its
 * only tie-break, so "newest" never silently follows file order for stamped rows.
 */
function keepNewest(map, key, candidate) {
  const previous = map.get(key);
  if (previous === undefined || candidate.at > previous.at
    || (candidate.at === previous.at && candidate.seq > previous.seq)) {
    map.set(key, candidate);
  }
}

/**
 * Newest `voice.latency` stages per delivery id and per (session, turn). A row without a session id
 * is legacy and is indexed by turn only while that turn is globally unique (see `byTurn` below).
 */
function indexLatencyRows(rows, pipelineRows) {
  const byDelivery = new Map();
  const bySessionTurn = new Map();
  const legacyByTurn = new Map();
  const scopedTurns = new Set();
  const pipelineTurnCount = new Map();
  for (const pipelineRow of Array.isArray(pipelineRows) ? pipelineRows : []) {
    const turn = intOrNull(pipelineRow?.payload?.turn);
    if (turn !== null) pipelineTurnCount.set(turn, (pipelineTurnCount.get(turn) ?? 0) + 1);
  }
  let seq = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.type !== 'voice.latency') continue;
    const payload = isPlainObject(row?.payload) ? row.payload : {};
    const stamp = Date.parse(row?.ts);
    const candidate = { stages: latencyStages(payload), at: Number.isFinite(stamp) ? stamp : -Infinity, seq };
    seq += 1;
    const deliveryMessageId = tokenOf(payload.deliveryMessageId, 96);
    if (deliveryMessageId !== null) keepNewest(byDelivery, deliveryMessageId, candidate);
    const turn = intOrNull(payload.turn);
    if (turn === null) continue;
    const sessionId = tokenOf(payload.sessionId, 96);
    if (sessionId !== null) {
      keepNewest(bySessionTurn, `${sessionId}\u0000${turn}`, candidate);
      scopedTurns.add(turn);
      continue;
    }
    if (!legacyByTurn.has(turn)) legacyByTurn.set(turn, []);
    legacyByTurn.get(turn).push(candidate);
  }
  // A legacy row joins a turn only when the turn is unambiguous on BOTH sides: exactly one
  // session-less latency row and exactly one pipeline row. Otherwise the fields stay null.
  const byTurn = new Map();
  for (const [turn, candidates] of legacyByTurn) {
    if (candidates.length === 1 && !scopedTurns.has(turn) && pipelineTurnCount.get(turn) === 1) {
      byTurn.set(turn, candidates[0].stages);
    }
  }
  return { byDelivery, bySessionTurn, byTurn };
}

/** Exact delivery id first, then the verified (session, turn); a bare turn only when it is unique. */
function latencyFor(index, { turn, sessionId, deliveryMessageId }) {
  if (deliveryMessageId !== null && index.byDelivery.has(deliveryMessageId)) {
    return index.byDelivery.get(deliveryMessageId).stages;
  }
  if (turn === null) return NO_LATENCY;
  if (sessionId !== null) {
    const key = `${sessionId}\u0000${turn}`;
    if (index.bySessionTurn.has(key)) return index.bySessionTurn.get(key).stages;
  }
  return index.byTurn.get(turn) ?? NO_LATENCY;
}

/** `pipeline.timeline`: the five pipeline stages plus the latency stages of the same round. */
function projectPipelineTimelineRow(row, index) {
  const payload = isPlainObject(row?.payload) ? row.payload : {};
  const turn = intOrNull(payload.turn);
  const sessionId = tokenOf(payload.sessionId, 96);
  const deliveryMessageId = tokenOf(payload.deliveryMessageId, 96);
  const joined = latencyFor(index, { turn, sessionId, deliveryMessageId });
  return {
    turn,
    sessionId,
    deliveryMessageId,
    bodyReadyMs: msOrNull(payload.bodyReadyMs),
    spokenFirstSentenceMs: msOrNull(payload.spokenFirstSentenceMs),
    translatedFirstMs: msOrNull(payload.translatedFirstMs),
    firstChunkSynthMs: msOrNull(payload.firstChunkSynthMs),
    firstAudioMs: msOrNull(payload.firstAudioMs),
    totalMs: joined.totalMs,
    asrMs: joined.asrMs,
    injectToAckMs: joined.injectToAckMs,
    ackToFirstTextMs: joined.ackToFirstTextMs,
  };
}

/** Walk the tail newest-first and project up to `limit` matching rows. */
function collectProjected(tail, { matches, limit, nowMs, project }) {
  const rows = [];
  let extraMatches = 0;
  let ageTruncated = false;
  for (let index = tail.rows.length - 1; index >= 0; index -= 1) {
    const row = tail.rows[index];
    if (!matches(row)) continue;
    const at = Date.parse(row?.ts);
    if (Number.isFinite(at) && nowMs - at > DIAGNOSTICS_LIMITS.maxAgeMs) {
      ageTruncated = true;
      continue;
    }
    if (rows.length >= limit) {
      extraMatches += 1;
      continue;
    }
    rows.push(project(row));
  }
  return { rows, extraMatches, ageTruncated };
}

function collectTimelineRows(tail, { limit, nowMs, includePhases }) {
  return collectProjected(tail, {
    matches: (row) => row?.type === TURN_TIMELINE_EVENT,
    limit,
    nowMs,
    project: (row) => projectTurnTimelineRow(row, includePhases),
  });
}

function collectPipelineRows(tail, { limit, nowMs }) {
  const index = indexLatencyRows(
    tail.rows,
    tail.rows.filter((row) => row?.type === PIPELINE_TIMELINE_EVENT),
  );
  return collectProjected(tail, {
    matches: (row) => row?.type === PIPELINE_TIMELINE_EVENT,
    limit,
    nowMs,
    project: (row) => projectPipelineTimelineRow(row, index),
  });
}

/**
 * Read the current `events.jsonl` plus its rotated generations (`events.jsonl.1` to `.5`). The
 * budget is spent newest generation first, a partially read first line is dropped from each file,
 * and the returned rows are still chronological (oldest generation first, then the current file).
 * `truncated` says the byte budget omitted older bytes, not that the result is invalid.
 */
export function readRecentEvents({
  root,
  maxBytes = DIAGNOSTICS_LIMITS.scanBytes,
  generations = DIAGNOSTICS_EVENT_GENERATIONS,
} = {}) {
  const base = join(String(root ?? ''), 'data', 'events.jsonl');
  const depth = Math.max(0, Math.floor(Number(generations) || 0));
  let remaining = Math.max(1, Math.floor(Number(maxBytes) || DIAGNOSTICS_LIMITS.scanBytes));
  const chunks = [];
  let truncated = false;
  for (let index = 0; index <= depth; index += 1) {
    if (remaining <= 0) {
      // The budget is spent: older bytes (of this or an older generation) are not read.
      truncated = true;
      break;
    }
    const part = readFileTail(index === 0 ? base : `${base}.${index}`, remaining);
    if (part === null) continue; // that generation does not exist (yet)
    truncated = truncated || part.truncated;
    if (part.rows.length > 0) chunks.push({ index, rows: part.rows });
    remaining -= part.bytes;
  }
  // Generations were read newest first; the caller expects a chronological window.
  const rows = chunks.sort((a, b) => b.index - a.index).flatMap((chunk) => chunk.rows);
  return { rows, truncated };
}

/** Tail of one event-log file; null when it does not exist. A torn first line is dropped. */
function readFileTail(file, maxBytes) {
  let fd;
  try {
    fd = openSync(file, 'r');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - Math.max(1, Math.floor(Number(maxBytes) || DIAGNOSTICS_LIMITS.scanBytes)));
    const length = size - start;
    const buffer = Buffer.alloc(length);
    if (length > 0) readSync(fd, buffer, 0, length, start);
    let text = buffer.toString('utf8');
    if (start > 0) {
      const newline = text.indexOf('\n');
      text = newline >= 0 ? text.slice(newline + 1) : '';
    }
    const rows = [];
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        const row = JSON.parse(line);
        if (isPlainObject(row)) rows.push(row);
      } catch {
        // A torn line is skipped; the rest of the tail is still usable.
      }
    }
    return { rows, truncated: start > 0, bytes: length };
  } finally {
    closeSync(fd);
  }
}

/** Make a state provider safe: a throwing provider must not break the HTTP action. */
function readState(projector, provider) {
  try {
    const raw = typeof provider === 'function' ? provider() : provider;
    return { ok: true, rows: projector(raw) };
  } catch (error) {
    return { ok: false, error: redactDiagnosticText(error?.message ?? String(error)) };
  }
}

/**
 * Create the one diagnostics service for a host mount.
 *
 * @param {{root?: string, isEnabled?: (() => boolean)|boolean,
 *   sources?: Record<string, Function>, emit?: ((type: string, payload: object) => unknown)|null,
 *   readTail?: ((input: {root: string, maxBytes: number}) => {rows: object[], truncated: boolean})|null,
 *   now?: () => number}} [options]
 */
export function createDiagnostics({
  root = '',
  isEnabled = () => false,
  sources = {},
  emit = null,
  readTail = null,
  now = () => Date.now(),
} = {}) {
  const enabled = () => (typeof isEnabled === 'function' ? isEnabled() === true : isEnabled === true);
  const reader = typeof readTail === 'function' ? readTail : readRecentEvents;

  return {
    /**
     * @param {{probe?: string, limit?: number, includePhases?: boolean}} [input] `includePhases`
     *   only affects `turn.timeline`; it is opt-in because the phase list is the big part of a row.
     * @returns {Promise<{ok: boolean, probe?: string, rows?: object[], truncated?: boolean,
     *   ms?: number, reason?: string, error?: string}>}
     */
    async query(input = {}) {
      // Checked before anything is read: a disabled channel has no read side effect at all.
      if (!enabled()) return { ok: false, reason: 'disabled' };

      const probe = typeof input.probe === 'string' ? input.probe.trim() : '';
      const definition = Object.hasOwn(DIAGNOSTICS_PROBES, probe) ? DIAGNOSTICS_PROBES[probe] : null;
      if (definition === null) {
        return { ok: false, reason: 'invalid-probe', probe: probe.slice(0, 64), rows: [], truncated: false, ms: 0 };
      }

      const started = now();
      const bounds = definition.limit ?? DIAGNOSTICS_LIMITS;
      const requestedLimit = input.limit === undefined || input.limit === null ? null : Number(input.limit);
      let limit = requestedLimit === null || !Number.isFinite(requestedLimit)
        ? bounds.defaultLimit
        : Math.trunc(requestedLimit);
      limit = Math.min(bounds.maxLimit, Math.max(1, limit));

      if (definition.kind === 'state') {
        const canonical = PROBE_ALIASES[probe] ?? probe;
        const result = readState(STATE_PROJECTORS[canonical], sources[canonical]);
        const ms = Math.max(0, Math.round(now() - started));
        if (!result.ok) {
          audit(emit, { probe, limit, ms, truncated: false });
          return { ok: false, reason: 'source-failed', probe, rows: [], truncated: false, ms, error: result.error };
        }
        audit(emit, { probe, limit, ms, truncated: false });
        return { ok: true, probe, rows: result.rows, truncated: false, ms };
      }

      let tail;
      try {
        tail = reader({ root, maxBytes: DIAGNOSTICS_LIMITS.scanBytes });
      } catch (error) {
        const ms = Math.max(0, Math.round(now() - started));
        audit(emit, { probe, limit, ms, truncated: false });
        return {
          ok: false, reason: 'read-failed', probe, rows: [], truncated: false, ms,
          error: redactDiagnosticText(error?.message ?? String(error)),
        };
      }

      const nowMs = now();
      // Three projections over the same bounded tail: the flat event whitelist, the summarized
      // turn timeline and the pipeline timeline joined to its `voice.latency` row.
      let collected;
      if (definition.kind === 'timeline') {
        collected = collectTimelineRows(tail, { limit, nowMs, includePhases: input.includePhases === true });
      } else if (definition.kind === 'pipeline') {
        collected = collectPipelineRows(tail, { limit, nowMs });
      } else {
        collected = collectProjected(tail, {
          matches: (row) => row?.type === definition.type,
          limit,
          nowMs,
          project: (row) => projectEventRow(definition, row),
        });
      }

      const truncated = tail.truncated === true || collected.extraMatches > 0 || collected.ageTruncated;
      const ms = Math.max(0, Math.round(now() - started));
      audit(emit, { probe, limit, ms, truncated });
      return { ok: true, probe, rows: collected.rows, truncated, ms };
    },
  };
}

/**
 * The audit event is best-effort and never gates the answer. `emit` is invoked without awaiting:
 * a logger that never settles cannot hold the query, and a logger that throws (sync or async)
 * cannot change the result. A failed audit is reported as one non-blocking
 * `diagnostics.audit.failed {error}` through the same emitter; if that channel is broken too the
 * failure simply cannot be recorded, which is still better than blocking the read.
 */
function audit(emit, payload) {
  if (typeof emit !== 'function') return;
  const reportFailure = (error) => {
    try {
      const detail = redactDiagnosticText(error?.message ?? String(error));
      Promise.resolve(emit('diagnostics.audit.failed', { error: detail })).catch(() => {});
    } catch {
      /* a logger broken for the query is usually broken for its own failure record */
    }
  };
  try {
    // Rejections and never-settling promises are both absorbed here; nothing is awaited.
    Promise.resolve(emit('diagnostics.query', payload)).catch(reportFailure);
  } catch (error) {
    // Deferred so even a synchronous logger throw stays off the query's return path.
    queueMicrotask(() => reportFailure(error));
  }
}
