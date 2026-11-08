/**
 * One voice turn's real timeline: model rounds, tool phases, tool overlap and the residual.
 *
 * The Harness session log already carries every boundary this needs (`turn/start`, `step/start`,
 * `assistant/message`, `tool/call`, `tool/result`, `turn/end`, `assistant/attempt`). This module is
 * the pure half of P-46:
 *
 *  1. `timelineObservation` reduces ONE session event to a small, desensitized observation. Text,
 *     tool arguments, tool output and `error.message` never enter an observation; only times, turn
 *     / step numbers, call ids, a tool name, and short enum/error-code tokens do.
 *  2. `buildTurnTimeline` turns the ordered observations plus the host's own anchors
 *     (round opened / session ready / injected / accepted / reply / audio) into the one
 *     `voice.turn.timeline` payload.
 *  3. `turnTimelineStats` derives the additive numbers written beside the canonical `voice.latency`
 *     stage set (modelMs, toolMs, toolCalls, firstTextAfterLastToolMs, residualMs, ...).
 *
 * Measurement discipline:
 *  - `toolMs` is the UNION of the tool intervals: parallel tools are never added together. The
 *    additive `toolMsSum` and `parallelTools` ride beside it.
 *  - `modelMs` is the sum of `assistant/message.time - step/start.time`.
 *  - `residualMs = totalMs - Σ(phase durations)`. It may be NEGATIVE (a negative value is
 *    information, not an error) and it is null when a boundary was never observed.
 *  - an explicitly measured 0 is preserved; an unobserved value is null (never a fabricated 0).
 *  - `reason` is an enum or an error CODE of at most 32 characters.
 *
 * Nothing here reads the clock, the session, the event log or `pendingTools`; every function is
 * pure, so a builder can never change what a turn does.
 */

/** Payload version of `voice.turn.timeline`. */
export const TURN_TIMELINE_VERSION = 1;

/** Hard cap on phases per row: a pathological turn cannot produce an unbounded event. */
export const MAX_TURN_TIMELINE_PHASES = 64;

/** Every status a round may end with. */
export const TURN_TIMELINE_STATUSES = Object.freeze([
  'ok',
  'failed',
  'cancelled',
  'timeout',
  'no-body',
  'no-audio',
  'refused',
]);

/** The reason vocabulary. Anything else must be an error code (see `timelineReason`). */
export const TURN_TIMELINE_REASONS = Object.freeze([
  'empty',
  'error',
  'timeout',
  'cancelled',
  'aborted',
  'blocked',
  'max-tokens',
  'unavailable',
  'delivery-busy',
  'delivery-failed',
  'session-unavailable',
  'no-body',
  'no-audio',
  'no-result',
  'tool-error',
  'attempt-error',
  'interrupted',
  'unknown',
]);

/** Phase names in the order a round walks them. */
export const TURN_TIMELINE_PHASE_NAMES = Object.freeze(['prepare', 'inject', 'accept', 'model', 'tool', 'audio']);

/** Tool buckets the host classifier reports. */
export const TOOL_KINDS = Object.freeze(['self-speech', 'self-wait', 'perception', 'work']);

/** The event types that may become an observation (everything else is ignored). */
export const TIMELINE_EVENT_TYPES = Object.freeze([
  'turn/start',
  'step/start',
  'assistant/attempt',
  'assistant/message',
  'tool/call',
  'tool/result',
  'turn/end',
]);

/** Origin sources: which stamp the round's relative times are measured from. */
export const TIMELINE_ORIGIN_SOURCES = Object.freeze(['endpoint', 'transcript', 'injected']);

/**
 * The additive numbers `voice.latency` gains from the timeline. They are NOT canonical stages:
 * the 8-field stage set and its p50/p95 card keep their shape.
 */
export const VOICE_LATENCY_TIMELINE_FIELDS = Object.freeze([
  'modelMs',
  'modelRounds',
  'preToolMs',
  'toolMs',
  'toolMsSum',
  'toolCalls',
  'toolFailures',
  'firstTextAfterLastToolMs',
  'firstAudioAfterLastToolMs',
  'prepareMs',
  'residualMs',
  'collected',
]);

/** A short protocol token: lowercase words, dots, colons, dashes. Never a message. */
const REASON_CODE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,31}$/u;

const TOOL_EVENT_TYPE = /^tool/iu;

const SELF_SPEECH_TOOLS = new Set(['assistant_say']);
const SELF_WAIT_TOOLS = new Set(['wait_agent']);
const PERCEPTION_TOOLS = new Set([
  'assistant_see',
  'assistant_watch',
  'assistant_vision',
  'assistant_obs',
  'assistant_obs_status',
  'assistant_listen',
  'assistant_ambient',
  'assistant_doctor',
  'assistant_live2d',
  'assistant_hotkeys',
]);

const safeInt = (value) => (Number.isSafeInteger(value) ? value : null);
/** An integer field or null; 0 is a real step/version, while null/'' is "not observed". */
const intOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null;
  return safeInt(Number(value));
};
const nonEmpty = (value) => (typeof value === 'string' && value.length > 0 ? value : '');
const stampOf = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : null;
};
/** Interval maths accepts any finite boundary (0 is a real offset, unlike "not measured"). */
const mathStamp = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

/**
 * Plain-text length of a committed message's text blocks. The text itself is never kept: only
 * its size is, and only for the status decision (a tool-call-only step has no reply body).
 */
function textCharsOf(message) {
  const content = message?.content;
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      chars += block.text.length;
    }
  }
  return chars;
}

/** Does the committed message call a tool (a `tool-*` block)? */
function hasToolBlock(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return false;
  return content.some((block) => typeof block?.type === 'string' && TOOL_EVENT_TYPE.test(block.type));
}

/** The tool name carried by a `tool/call` event, whichever shape the feed uses. */
function toolNameOf(data) {
  const direct = data?.name ?? data?.toolName ?? data?.message?.name;
  if (typeof direct === 'string' && direct.length > 0) return direct.trim();
  const content = data?.message?.content;
  if (!Array.isArray(content)) return '';
  const block = content.find((entry) => typeof entry?.type === 'string' && TOOL_EVENT_TYPE.test(entry.type));
  return typeof block?.name === 'string' ? block.name.trim() : '';
}

/** The tool call id carried by a `tool/call` / `tool/result` event. */
function toolCallIdOf(data) {
  // The REAL id of a result is on the committed message (`data.message.toolCallId`); `data.callId`
  // is the tolerated flat shape the rest of the log uses for a call.
  const direct = data?.message?.toolCallId
    ?? data?.callId
    ?? data?.toolCallId
    ?? data?.message?.id
    ?? data?.id;
  return typeof direct === 'string' && direct.trim().length > 0 ? direct.trim().slice(0, 96) : '';
}

/**
 * The token a tool result carries. Only codes/short tokens pass: `error.message` and the result
 * itself are never read, so a provider message cannot leak into the event.
 */
function toolResultToken(data) {
  const direct = data?.message?.errorCode
    ?? data?.errorCode
    ?? data?.message?.error?.code
    ?? data?.error?.code
    ?? data?.reason?.code
    ?? data?.reason?.kind
    ?? data?.status;
  return typeof direct === 'string' ? direct : '';
}

/** A tool result is a failure when its flag says so or its token is a failure kind. */
function toolResultFailed(data, token) {
  const flag = data?.message?.isError ?? data?.isError;
  if (typeof flag === 'boolean') return flag;
  if (typeof data?.ok === 'boolean') return data.ok !== true;
  return /^(?:error|failed|failure|timeout|aborted|cancelled|canceled|denied|refused)$/i.test(String(token ?? ''));
}

/**
 * Normalize one `turn/end` reason into a short status token. The reason object may carry a
 * `message`; only its `kind` is read.
 */
function turnEndToken(reason) {
  const kind = typeof reason?.kind === 'string' ? reason.kind.trim() : '';
  return kind.length > 0 ? kind : 'completed';
}

/** The token an `assistant/attempt` event carries. */
function attemptToken(data) {
  const value = data?.status
    ?? data?.outcome?.kind
    ?? data?.outcome
    ?? data?.kind
    ?? data?.reason?.kind;
  return typeof value === 'string' ? value : '';
}

/** Turn identity of one session event (explicit turn id first, then the loop's `data.turn`). */
function eventTurn(event) {
  const direct = event?.turnId ?? event?.turnID ?? event?.data?.turnId;
  if (direct !== undefined && direct !== null) return intOrNull(direct);
  return intOrNull(event?.data?.turn);
}

/**
 * Reduce ONE session event to a desensitized observation, or null when the event is not one of the
 * seven boundaries (or carries no usable time). `at` is the receive time used when the event has
 * no `time` field.
 *
 * @param {object} event
 * @param {number} [at] receive time (Date.now())
 * @returns {object|null} `{type, at, turn, step, seq, ...}`
 */
export function timelineObservation(event, at = 0) {
  const type = typeof event?.type === 'string' ? event.type : '';
  if (!TIMELINE_EVENT_TYPES.includes(type)) return null;
  const time = stampOf(event?.time) ?? stampOf(at);
  if (time === null) return null;
  const data = event?.data ?? {};
  const base = {
    type,
    at: time,
    turn: eventTurn(event),
    step: intOrNull(data?.step ?? event?.step),
    seq: intOrNull(event?.seq),
  };
  if (type === 'turn/start' || type === 'step/start') return base;
  if (type === 'assistant/message') {
    return {
      ...base,
      hasTool: hasToolBlock(data?.message),
      chars: textCharsOf(data?.message),
      interrupted: data?.interrupted === true,
    };
  }
  if (type === 'tool/call') {
    return { ...base, callId: toolCallIdOf(data), toolName: toolNameOf(data) };
  }
  if (type === 'tool/result') {
    const token = toolResultToken(data);
    return {
      ...base,
      callId: toolCallIdOf(data),
      ok: toolResultFailed(data, token) !== true,
      reason: token.length > 0 ? timelineReason(token) : null,
    };
  }
  if (type === 'turn/end') return { ...base, status: timelineReason(turnEndToken(data?.reason)) };
  return { ...base, attemptStatus: timelineReason(attemptToken(data)) };
}

/**
 * A reason is an enum value or a short error CODE. A full sentence (anything with spaces, quotes,
 * slashes or path characters) collapses to `unknown`, so no `error.message` can reach the payload.
 * @param {unknown} value
 * @returns {string|null} at most 32 characters
 */
export function timelineReason(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text.length === 0) return null;
  const lower = text.toLowerCase();
  if (TURN_TIMELINE_REASONS.includes(lower)) return lower;
  // Only an error code may pass unchanged (≤ 32 chars, no whitespace or message punctuation).
  return REASON_CODE.test(text) ? text.slice(0, 32) : 'unknown';
}

/**
 * Classify one tool by what its wait MEANS for the first sentence. The host may inject its own
 * classifier; this is the default vocabulary: the plugin's own speech/wait tools are not "work",
 * perception tools are the ones that may delay the first text, everything else is work.
 * @param {string} name
 * @returns {'self-speech'|'self-wait'|'perception'|'work'}
 */
export function classifyToolKind(name) {
  const tool = typeof name === 'string' ? name.trim() : '';
  if (SELF_SPEECH_TOOLS.has(tool)) return 'self-speech';
  if (SELF_WAIT_TOOLS.has(tool)) return 'self-wait';
  if (PERCEPTION_TOOLS.has(tool)) return 'perception';
  return 'work';
}

/**
 * Orient a round: the earliest stamp that was actually measured. `endpoint` (silence endpoint)
 * wins over the final transcript, which wins over the delivery instant.
 * @returns {{at: number|null, source: 'endpoint'|'transcript'|'injected'}}
 */
export function timelineOrigin({ endpointAt = 0, transcriptAt = 0, injectedAt = 0 } = {}) {
  const endpoint = stampOf(endpointAt);
  if (endpoint !== null) return { at: endpoint, source: 'endpoint' };
  const transcript = stampOf(transcriptAt);
  if (transcript !== null) return { at: transcript, source: 'transcript' };
  return { at: stampOf(injectedAt), source: 'injected' };
}

/** Stable id of one row: the delivery id (or the turn) inside its session. */
export function turnTimelineId({ sessionId = '', turn = null, deliveryMessageId = '' } = {}) {
  const session = nonEmpty(sessionId) || 'session';
  const suffix = nonEmpty(deliveryMessageId)
    || (Number.isSafeInteger(turn) ? `turn-${turn}` : 'turn-na');
  return `${session}#${suffix}`;
}

/**
 * Union length of measured intervals: parallel overlap counts ONCE.
 * @param {Array<{startAt: number, endAt: number}>} intervals
 * @returns {number} integer ms
 */
export function unionIntervalMs(intervals) {
  const rows = (Array.isArray(intervals) ? intervals : [])
    .map((row) => ({ startAt: mathStamp(row?.startAt), endAt: mathStamp(row?.endAt) }))
    .filter((row) => row.startAt !== null && row.endAt !== null && row.endAt >= row.startAt)
    .sort((a, b) => a.startAt - b.startAt || a.endAt - b.endAt);
  let total = 0;
  let openStart = null;
  let openEnd = null;
  for (const row of rows) {
    if (openStart === null) {
      openStart = row.startAt;
      openEnd = row.endAt;
      continue;
    }
    if (row.startAt <= openEnd) {
      openEnd = Math.max(openEnd, row.endAt);
      continue;
    }
    total += openEnd - openStart;
    openStart = row.startAt;
    openEnd = row.endAt;
  }
  if (openStart !== null) total += openEnd - openStart;
  return Math.round(total);
}

/**
 * Cluster measured intervals into overlapping groups. Returns one index array per cluster (ordered
 * by start); a cluster of one is a serial tool, a bigger cluster really ran in parallel.
 * @param {Array<{startAt: number|null, endAt: number|null}>} phases
 * @returns {number[][]}
 */
export function parallelGroups(phases) {
  const measured = [];
  (Array.isArray(phases) ? phases : []).forEach((phase, index) => {
    const startAt = mathStamp(phase?.startAt);
    const endAt = mathStamp(phase?.endAt);
    if (startAt !== null && endAt !== null && endAt >= startAt) measured.push({ index, startAt, endAt });
  });
  measured.sort((a, b) => a.startAt - b.startAt || a.endAt - b.endAt);
  const groups = [];
  let current = null;
  let openEnd = null;
  for (const row of measured) {
    if (current === null || row.startAt > openEnd) {
      current = [row.index];
      groups.push(current);
      openEnd = row.endAt;
      continue;
    }
    current.push(row.index);
    openEnd = Math.max(openEnd, row.endAt);
  }
  return groups;
}

/** Build one phase with a stable key set; an unobserved boundary stays null. */
function makePhase({
  name, actionId = null, startAt = null, endAt = null, originAt = null,
  source = '', status = 'ok', reason = null, wait = false, tool = null, extra = {},
}) {
  const start = stampOf(startAt);
  const end = stampOf(endAt);
  const relative = (stamp) => (stamp !== null && originAt !== null ? Math.round(stamp - originAt) : null);
  return {
    name,
    actionId,
    startAt: start,
    endAt: end,
    startMs: relative(start),
    endMs: relative(end),
    durMs: start !== null && end !== null ? Math.round(end - start) : null,
    source,
    status,
    reason: reason === null ? null : timelineReason(reason),
    wait: wait === true,
    tool,
    extra,
  };
}

/** Stable sort of phases by start time (unobserved starts last), then by the canonical walk order. */
function sortPhases(phases) {
  const rank = (phase) => {
    const index = TURN_TIMELINE_PHASE_NAMES.indexOf(phase.name);
    return index === -1 ? TURN_TIMELINE_PHASE_NAMES.length : index;
  };
  return phases.slice().sort((a, b) => {
    if (a.startAt === null && b.startAt === null) return rank(a) - rank(b) || a.name.localeCompare(b.name);
    if (a.startAt === null) return 1;
    if (b.startAt === null) return -1;
    if (a.startAt !== b.startAt) return a.startAt - b.startAt;
    return rank(a) - rank(b) || a.name.localeCompare(b.name);
  });
}

/** Sum that stays null when any addend is unknown. */
function sumOrNull(values) {
  if (values.length === 0) return null;
  let total = 0;
  for (const value of values) {
    if (value === null || value === undefined) return null;
    total += Number(value);
  }
  return Math.round(total);
}

/**
 * The one `voice.turn.timeline` payload.
 *
 * @param {object} [input]
 * @param {string} [input.sessionId]
 * @param {string} [input.timelineId] defaults to `turnTimelineId(...)`
 * @param {number|null} [input.turn]
 * @param {number|null} [input.acceptTurn]
 * @param {string} [input.deliveryMessageId]
 * @param {string} [input.groupId]
 * @param {number|null} [input.answerVersion]
 * @param {string} [input.lane] 'voice'
 * @param {string} [input.status] one of TURN_TIMELINE_STATUSES
 * @param {string|null} [input.reason] enum / error code (null for ok)
 * @param {{at: number|null, source: string}} [input.origin]
 * @param {Array<object>|null} [input.observations] null = the events were never collected
 * @param {{roundOpenedAt?: number, sessionReadyAt?: number, injectedAt?: number,
 *   acceptedAt?: number, replyAt?: number, audioAt?: number}} [input.anchors] host stamps
 * @param {(name: string) => string} [input.classifyTool]
 * @param {number} [input.maxPhases]
 * @returns {object}
 */
export function buildTurnTimeline({
  sessionId = '',
  timelineId = '',
  turn = null,
  acceptTurn = null,
  deliveryMessageId = '',
  groupId = '',
  answerVersion = null,
  lane = 'voice',
  status = 'ok',
  reason = null,
  origin = null,
  observations = null,
  anchors = {},
  classifyTool = classifyToolKind,
  maxPhases = MAX_TURN_TIMELINE_PHASES,
} = {}) {
  const collected = Array.isArray(observations);
  const originAt = stampOf(origin?.at);
  const originSource = TIMELINE_ORIGIN_SOURCES.includes(origin?.source) ? origin.source : 'injected';
  const classify = typeof classifyTool === 'function' ? classifyTool : classifyToolKind;
  const rows = collected
    ? observations
      .filter((row) => row !== null && typeof row === 'object' && stampOf(row.at) !== null)
      .slice()
      .sort((a, b) => stampOf(a.at) - stampOf(b.at))
    : [];

  /** One open model phase per (turn, step); a repeated start never opens a second one. */
  const openModel = new Map();
  const modelPhases = [];
  const toolPhases = [];
  const openTools = [];
  let attempts = null;
  let attemptFailures = 0;
  let turnStartAt = null;
  let turnEndAt = null;
  let lastObservedAt = null;

  for (const row of rows) {
    const at = stampOf(row.at);
    if (at === null) continue;
    lastObservedAt = at;
    const step = intOrNull(row.step);
    if (row.type === 'turn/start') {
      if (turnStartAt === null) turnStartAt = at;
      continue;
    }
    if (row.type === 'step/start') {
      const key = `${row.turn ?? ''}:${step ?? ''}`;
      const existing = openModel.get(key);
      // A repeated `step/start` for a step that is still open is the same round, not a new one.
      if (existing !== undefined && existing.endAt === null) continue;
      const phase = makePhase({
        name: 'model',
        actionId: step === null ? 'step' : `step:${step}`,
        startAt: at,
        endAt: null,
        originAt,
        source: 'step/start',
        status: 'pending',
        wait: true,
        extra: { step, turn: row.turn },
      });
      openModel.set(key, phase);
      modelPhases.push(phase);
      continue;
    }
    if (row.type === 'assistant/attempt') {
      attempts = (attempts ?? 0) + 1;
      if (/^(?:error|failed|failure|timeout|aborted|cancelled|canceled)$/i.test(String(row.attemptStatus ?? ''))) {
        attemptFailures += 1;
      }
      continue;
    }
    if (row.type === 'assistant/message') {
      const key = `${row.turn ?? ''}:${step ?? ''}`;
      let phase = openModel.get(key);
      if (phase === undefined || phase.endAt !== null) {
        // A commit without its `step/start` (a dropped boundary) still closes the last open round
        // of this turn; the delivery only listens to its own turn, so that round is this one.
        let fallback = null;
        for (const candidate of modelPhases) {
          if (candidate.endAt !== null) continue;
          const owner = candidate.extra?.turn ?? null;
          if (row.turn !== null && owner !== null && owner !== row.turn) continue;
          fallback = candidate;
        }
        phase = fallback;
      }
      if (phase === null || phase === undefined) {
        // No round was ever opened: record the commit as a boundary-only phase (duration unknown).
        modelPhases.push(makePhase({
          name: 'model',
          actionId: step === null ? 'commit' : `step:${step}`,
          startAt: null,
          endAt: at,
          originAt,
          source: 'assistant/message',
          status: row.interrupted === true ? 'failed' : 'partial',
          reason: row.interrupted === true ? 'interrupted' : 'no-result',
          wait: true,
          extra: { step },
        }));
        continue;
      }
      phase.endAt = at;
      phase.endMs = originAt !== null ? Math.round(at - originAt) : null;
      phase.durMs = phase.startAt !== null ? Math.round(at - phase.startAt) : null;
      phase.status = row.interrupted === true ? 'failed' : 'ok';
      phase.reason = row.interrupted === true ? 'interrupted' : null;
      // The committed message's shape only: was this step pre-tool commentary, and how many text
      // characters did it commit? Never the text itself.
      phase.extra = {
        ...(phase.extra ?? {}),
        toolStep: row.hasTool === true,
        textChars: Number.isSafeInteger(row.chars) ? row.chars : null,
      };
      continue;
    }
    if (row.type === 'tool/call') {
      const name = nonEmpty(row.toolName) || null;
      const kind = classify(name);
      const phase = makePhase({
        name: 'tool',
        actionId: nonEmpty(row.callId) || null,
        startAt: at,
        endAt: null,
        originAt,
        source: 'tool/call',
        status: 'pending',
        wait: true,
        tool: { name, kind: TOOL_KINDS.includes(kind) ? kind : 'work', parallelGroup: null },
        extra: { step },
      });
      toolPhases.push(phase);
      openTools.push(phase);
      continue;
    }
    if (row.type === 'tool/result') {
      const callId = nonEmpty(row.callId);
      let index = -1;
      if (callId.length > 0) index = openTools.findIndex((phase) => phase.actionId === callId);
      if (index === -1 && openTools.length === 1) index = 0;
      if (index === -1 && openTools.length > 1) index = 0;
      if (index === -1) continue;
      const phase = openTools[index];
      openTools.splice(index, 1);
      phase.endAt = at;
      phase.endMs = originAt !== null ? Math.round(at - originAt) : null;
      phase.durMs = phase.startAt !== null ? Math.round(at - phase.startAt) : null;
      phase.status = row.ok === false ? 'failed' : 'ok';
      phase.reason = row.ok === false ? (row.reason ?? 'tool-error') : null;
      continue;
    }
    if (row.type === 'turn/end') {
      if (turnEndAt === null) turnEndAt = at;
    }
  }

  // Every round that never got a commit/result keeps its start and reports why it has no duration.
  for (const phase of modelPhases) {
    if (phase.endAt !== null) continue;
    phase.status = 'pending';
    phase.reason = 'no-result';
  }
  for (const phase of toolPhases) {
    if (phase.endAt !== null) continue;
    phase.status = 'pending';
    phase.reason = 'no-result';
  }

  // Host anchors: the segments a session event cannot measure (before the turn, after the body).
  const sampled = (value) => stampOf(value) !== null;
  const anchorPhases = [];
  const addAnchor = (name, startAt, endAt) => {
    if (!sampled(startAt) || !sampled(endAt)) return;
    anchorPhases.push(makePhase({
      name,
      startAt,
      endAt,
      originAt,
      source: 'host',
      status: 'ok',
      wait: false,
    }));
  };
  addAnchor('prepare', anchors.roundOpenedAt, anchors.sessionReadyAt);
  addAnchor('inject', anchors.sessionReadyAt, anchors.injectedAt);
  addAnchor('accept', anchors.injectedAt, anchors.acceptedAt);
  addAnchor('audio', anchors.replyAt, anchors.audioAt);

  // Tool overlap: union (never a sum), the additive sum beside it, and the parallel clusters.
  // Nothing collected is NOT the same as "no tools": a collected round with no tool call really
  // measured 0 ms of tool time, while an uncollected round has no measurement at all.
  const measuredTool = toolPhases.filter((phase) => phase.durMs !== null);
  const toolMeasuredAll = toolPhases.length === measuredTool.length;
  const toolWallMs = !collected
    ? null
    : (toolPhases.length === 0 ? 0 : (toolMeasuredAll
      ? unionIntervalMs(measuredTool.map((phase) => ({ startAt: phase.startAt, endAt: phase.endAt })))
      : null));
  const toolMsSum = !collected
    ? null
    : (toolPhases.length === 0 ? 0 : (toolMeasuredAll
      ? Math.round(measuredTool.reduce((total, phase) => total + phase.durMs, 0))
      : null));
  const groups = parallelGroups(toolPhases);
  const groupOf = new Map();
  let parallelTools = 0;
  groups.forEach((group, index) => {
    if (group.length < 2) return;
    parallelTools += group.length;
    const id = `p${index + 1}`;
    for (const phaseIndex of group) groupOf.set(toolPhases[phaseIndex], id);
  });
  for (const phase of toolPhases) {
    const id = groupOf.get(phase) ?? null;
    if (id !== null) phase.tool = { ...(phase.tool ?? { name: null, kind: 'work' }), parallelGroup: id };
  }

  const allPhases = sortPhases([...anchorPhases, ...modelPhases, ...toolPhases]);
  const cap = Math.max(1, Math.floor(Number(maxPhases) || MAX_TURN_TIMELINE_PHASES));
  const phases = allPhases.slice(0, cap);
  const droppedPhases = allPhases.length - phases.length;

  // Total span: the farthest measured end of the round (turn/end, the reply instant or the first
  // audio). It may sit after the last session event, because speech continues after `turn/end`.
  const ends = [turnEndAt, stampOf(anchors.replyAt), stampOf(anchors.audioAt), lastObservedAt]
    .filter((value) => value !== null);
  const totalEnd = ends.length > 0 ? Math.max(...ends) : null;
  const totalMs = totalEnd !== null && originAt !== null ? Math.round(totalEnd - originAt) : null;
  const phaseSum = allPhases.length === 0 ? null : sumOrNull(allPhases.map((phase) => phase.durMs));
  // Negative residuals are preserved: an overlap or a clock skew is information, not a zero.
  const residualMs = totalMs !== null && phaseSum !== null && allPhases.length > 0
    ? totalMs - phaseSum
    : null;

  const modelRounds = collected ? modelPhases.length : null;
  const toolCalls = collected ? toolPhases.length : null;
  const toolFailures = collected ? toolPhases.filter((phase) => phase.status === 'failed').length : null;
  const retries = attempts === null || modelRounds === null ? null : Math.max(0, attempts - modelRounds);

  return {
    v: TURN_TIMELINE_VERSION,
    timelineId: nonEmpty(timelineId) || turnTimelineId({ sessionId, turn, deliveryMessageId }),
    sessionId: String(sessionId ?? ''),
    turn: intOrNull(turn),
    acceptTurn: intOrNull(acceptTurn),
    deliveryMessageId: nonEmpty(deliveryMessageId) || null,
    groupId: nonEmpty(groupId) || null,
    answerVersion: intOrNull(answerVersion),
    lane: nonEmpty(lane) || 'voice',
    status: TURN_TIMELINE_STATUSES.includes(status) ? status : 'failed',
    reason: status === 'ok' ? null : timelineReason(reason),
    origin: { at: originAt, source: originSource },
    counts: {
      modelRounds,
      attempts,
      attemptFailures: attempts === null ? null : attemptFailures,
      toolCalls,
      toolFailures,
      retries,
    },
    overlaps: { toolMsSum, toolWallMs, parallelTools: collected ? parallelTools : null },
    residualMs,
    droppedPhases,
    phases,
  };
}

/**
 * The additive numbers written beside the canonical `voice.latency` stage set.
 *
 * A value is null when its boundary was never observed; an explicit 0 (e.g. a round with no tool
 * calls) is kept. `collected` is how many raw observations fed the row (null when none were
 * collected at all).
 *
 * @param {object} payload a `buildTurnTimeline` payload
 * @param {{firstTextAt?: number, audioAt?: number, transcriptAt?: number, injectedAt?: number,
 *   collected?: number|null}} [input]
 * @returns {object} exactly VOICE_LATENCY_TIMELINE_FIELDS
 */
export function turnTimelineStats(payload, {
  firstTextAt = 0, audioAt = 0, transcriptAt = 0, injectedAt = 0, collected = null,
} = {}) {
  const phases = Array.isArray(payload?.phases) ? payload.phases : [];
  const models = phases.filter((phase) => phase.name === 'model');
  const tools = phases.filter((phase) => phase.name === 'tool');
  const durations = (list) => (list.length === 0 ? null : sumOrNull(list.map((phase) => phase.durMs)));
  const originAt = stampOf(payload?.origin?.at);
  const firstToolStart = tools.reduce((first, phase) => {
    const at = stampOf(phase.startAt);
    if (at === null) return first;
    return first === null || at < first ? at : first;
  }, null);
  const lastToolEnd = tools.reduce((last, phase) => {
    const at = stampOf(phase.endAt);
    if (at === null) return last;
    return last === null || at > last ? at : last;
  }, null);
  const textAt = stampOf(firstTextAt);
  const audioStart = stampOf(audioAt);
  const injected = stampOf(injectedAt);
  const transcript = stampOf(transcriptAt);
  const overlaps = payload?.overlaps ?? {};
  return {
    modelMs: durations(models),
    modelRounds: payload?.counts?.modelRounds ?? null,
    preToolMs: firstToolStart !== null && originAt !== null ? Math.max(0, firstToolStart - originAt) : null,
    toolMs: Number.isFinite(overlaps.toolWallMs) ? overlaps.toolWallMs : null,
    toolMsSum: Number.isFinite(overlaps.toolMsSum) ? overlaps.toolMsSum : null,
    toolCalls: payload?.counts?.toolCalls ?? null,
    toolFailures: payload?.counts?.toolFailures ?? null,
    firstTextAfterLastToolMs: textAt !== null && lastToolEnd !== null
      ? Math.max(0, textAt - lastToolEnd)
      : null,
    firstAudioAfterLastToolMs: audioStart !== null && lastToolEnd !== null
      ? Math.max(0, audioStart - lastToolEnd)
      : null,
    prepareMs: injected !== null && transcript !== null ? Math.max(0, injected - transcript) : null,
    residualMs: Number.isFinite(payload?.residualMs) ? payload.residualMs : null,
    collected: Number.isSafeInteger(collected) && collected >= 0 ? collected : null,
  };
}
