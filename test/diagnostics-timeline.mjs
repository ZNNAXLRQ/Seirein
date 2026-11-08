/**
 * P-46 stage 3: the two read-only timeline probes of the controlled diagnostics channel.
 *
 *   turn.timeline     — the last N rounds, summarized (never the phases array by default)
 *   pipeline.timeline — the last N spoken pipeline rows, joined to their `voice.latency` stages
 *
 * Run: node --test test/diagnostics-timeline.mjs
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  DIAGNOSTICS_LIMITS,
  DIAGNOSTICS_PIPELINE_TIMELINE_FIELDS,
  DIAGNOSTICS_PROBES,
  DIAGNOSTICS_TIMELINE_LIMITS,
  DIAGNOSTICS_TIMELINE_PHASE_CAP,
  DIAGNOSTICS_TIMELINE_PHASE_FIELDS,
  DIAGNOSTICS_TURN_TIMELINE_FIELDS,
  createDiagnostics,
  readRecentEvents,
} from '../src/host/runtime/diagnostics/query.js';
import { buildTurnTimeline } from '../src/host/session/timeline/turn-timeline.js';

const at = (offsetMs = 0) => new Date(Date.now() - offsetMs).toISOString();
const event = (type, payload, offsetMs = 0) => ({
  id: `evt-${type}-${offsetMs}`,
  ts: at(offsetMs),
  type,
  corr_id: null,
  payload,
});

function fixture(events = []) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-diagnostics-timeline-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  writeLines(join(root, 'data', 'events.jsonl'), events);
  return {
    root,
    file: join(root, 'data', 'events.jsonl'),
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const writeLines = (file, rows) => writeFileSync(
  file,
  rows.map((row) => (typeof row === 'string' ? row : JSON.stringify(row))).join('\n') + (rows.length > 0 ? '\n' : ''),
  'utf8',
);

/** One projected phase as the timeline builder writes it (only the keys the probe may use). */
const phase = (name, durMs, extra = {}) => ({
  name,
  actionId: null,
  startAt: null,
  endAt: null,
  startMs: 0,
  endMs: durMs,
  durMs,
  source: 'host',
  status: 'ok',
  reason: null,
  wait: false,
  tool: null,
  extra: {},
  ...extra,
});

/** One `voice.turn.timeline` payload shaped like `buildTurnTimeline` output, with extra noise. */
const turnPayload = ({ turn, phases, counts = {}, overlaps = {}, ...rest }) => ({
  v: 1,
  timelineId: `session-a#msg-${turn}`,
  sessionId: 'session-a',
  turn,
  acceptTurn: turn,
  deliveryMessageId: `msg-${turn}`,
  groupId: `group-${turn}`,
  answerVersion: 1,
  lane: 'voice',
  status: 'ok',
  reason: null,
  origin: { at: 1_760_000_000_000, source: 'endpoint' },
  counts: {
    modelRounds: 1,
    attempts: 1,
    attemptFailures: 0,
    toolCalls: 0,
    toolFailures: 0,
    retries: 0,
    ...counts,
  },
  overlaps: { toolMsSum: 0, toolWallMs: 0, parallelTools: 0, ...overlaps },
  residualMs: 0,
  droppedPhases: 0,
  phases,
  ...rest,
});

function assertFields(row, fields, message) {
  assert.deepEqual(Object.keys(row).sort(), [...fields].sort(), `${message}: unexpected projection`);
}

test('1. turn.timeline: three rounds, summarized phases, no phases array', async () => {
  // The log is chronological: oldest round first, newest last.
  const f = fixture([
    event('voice.turn.timeline', turnPayload({
      turn: 1,
      phases: [],
      status: 'no-audio',
      reason: 'no-audio',
      counts: { modelRounds: 1, attempts: 1, attemptFailures: 0, toolCalls: 0, toolFailures: 0, retries: 0 },
    }), 3000),
    event('voice.turn.timeline', turnPayload({
      turn: 2,
      phases: [
        phase('model', 200),
        phase('tool', 400, { tool: { name: 'assistant_see', kind: 'perception', parallelGroup: 'p1' } }),
        phase('tool', 300, { status: 'failed', reason: 'tool-error', tool: { name: 'read_file', kind: 'work', parallelGroup: 'p1' } }),
        phase('audio', 60),
      ],
      counts: { modelRounds: 1, attempts: 1, attemptFailures: 0, toolCalls: 2, toolFailures: 1, retries: 0 },
      overlaps: { toolMsSum: 700, toolWallMs: 400, parallelTools: 2 },
    }), 2000),
    event('voice.turn.timeline', turnPayload({
      turn: 3,
      phases: [
        phase('prepare', 40),
        phase('model', 300),
        phase('tool', 500, {
          actionId: 'call-1',
          tool: { name: 'assistant_see', kind: 'perception', parallelGroup: null },
        }),
        phase('audio', 20),
      ],
      counts: { modelRounds: 1, attempts: 2, attemptFailures: 1, toolCalls: 1, toolFailures: 0, retries: 1 },
      overlaps: { toolMsSum: 500, toolWallMs: 500, parallelTools: 0 },
      residualMs: -12,
    }), 1000),
  ]);
  const diagnostics = createDiagnostics({ root: f.root, isEnabled: true });
  try {
    const result = await diagnostics.query({ probe: 'turn.timeline', limit: 10 });
    assert.equal(result.ok, true);
    assert.equal(result.probe, 'turn.timeline');
    assert.equal(result.truncated, false);
    assert.equal(result.rows.length, 3, 'one row per round');
    assert.deepEqual(result.rows.map((row) => row.turn), [3, 2, 1], 'newest round first');

    const newest = result.rows[0];
    assertFields(newest, DIAGNOSTICS_PROBES['turn.timeline'].fields, 'turn.timeline row');
    assert.equal(Object.hasOwn(newest, 'phases'), false, 'the phases array is not part of the default answer');
    assert.equal(newest.timelineId, 'session-a#msg-3');
    assert.equal(newest.sessionId, 'session-a');
    assert.equal(newest.acceptTurn, 3);
    assert.equal(newest.deliveryMessageId, 'msg-3');
    assert.equal(newest.groupId, 'group-3');
    assert.equal(newest.lane, 'voice');
    assert.equal(newest.status, 'ok');
    assert.equal(newest.reason, null);
    assert.deepEqual(newest.origin, { at: 1_760_000_000_000, source: 'endpoint' });
    assert.deepEqual(newest.counts, {
      modelRounds: 1, attempts: 2, attemptFailures: 1, toolCalls: 1, toolFailures: 0, retries: 1,
    });
    assert.deepEqual(newest.overlaps, { toolMsSum: 500, toolWallMs: 500, parallelTools: 0 });
    assert.equal(newest.residualMs, -12, 'a negative residual is information, not a zero');
    assert.equal(newest.droppedPhases, 0);
    assert.equal(newest.phaseCount, 4);
    assert.deepEqual(newest.phaseNames, ['prepare', 'model', 'tool', 'audio'], 'names are deduped, in walk order');
    assert.deepEqual(newest.longestPhase, { name: 'tool', durMs: 500 });
    assert.deepEqual(newest.toolKinds, { 'self-speech': 0, 'self-wait': 0, perception: 1, work: 0 });

    const second = result.rows[1];
    assert.equal(second.phaseCount, 4);
    assert.deepEqual(second.phaseNames, ['model', 'tool', 'audio'], 'a repeated phase name is deduped');
    assert.deepEqual(second.toolKinds, { 'self-speech': 0, 'self-wait': 0, perception: 1, work: 1 });
    assert.deepEqual(second.longestPhase, { name: 'tool', durMs: 400 });
    assert.deepEqual(second.overlaps, { toolMsSum: 700, toolWallMs: 400, parallelTools: 2 });

    const oldest = result.rows[2];
    assert.equal(oldest.status, 'no-audio');
    assert.equal(oldest.reason, 'no-audio');
    assert.equal(oldest.phaseCount, 0);
    assert.deepEqual(oldest.phaseNames, []);
    assert.equal(oldest.longestPhase, null);
    assert.deepEqual(oldest.toolKinds, { 'self-speech': 0, 'self-wait': 0, perception: 0, work: 0 });
  } finally {
    f.cleanup();
  }
});

test('2. includePhases=true: capped, per-field projection; default off', async () => {
  const phases = Array.from({ length: 80 }, (_value, index) => phase('model', index, { actionId: `step-${index}` }));
  phases[0] = phase('tool', 900, {
    tool: { name: 'assistant_see', kind: 'perception', parallelGroup: 'p1' },
    extra: { text: 'PRIVATE PHASE EXTRA', toolArgs: { query: 'PRIVATE TOOL ARGUMENT' } },
  });
  phases[1] = phase('tool', 100, { actionId: 'Bearer ABCDEFGHIJKLMNOPQRSTUV' });
  phases[2] = phase('model', 50, { reason: 'PRIVATE ERROR MESSAGE with spaces and a path C:/Users/x' });
  phases[3] = phase('model', 40, { reason: 'tool-error' });
  phases[4] = phase('tool', 30, {
    tool: { name: 'assistant_see', kind: 'perception', arguments: { query: 'PRIVATE TOOL ARG' } },
  });
  const f = fixture([event('voice.turn.timeline', turnPayload({ turn: 9, phases }), 1000)]);
  const diagnostics = createDiagnostics({ root: f.root, isEnabled: true });
  try {
    const plain = await diagnostics.query({ probe: 'turn.timeline', limit: 5 });
    assert.equal(Object.hasOwn(plain.rows[0], 'phases'), false);
    assert.equal(plain.rows[0].phaseCount, 80);

    const full = await diagnostics.query({ probe: 'turn.timeline', limit: 5, includePhases: true });
    const row = full.rows[0];
    assert.deepEqual(Object.keys(row).sort(), [...DIAGNOSTICS_TURN_TIMELINE_FIELDS].sort());
    assert.equal(row.phaseCount, 80, 'phaseCount reports the row, not the projection');
    assert.equal(row.phases.length, DIAGNOSTICS_TIMELINE_PHASE_CAP, 'the phase list is capped');
    for (const entry of row.phases) {
      assertFields(entry, DIAGNOSTICS_TIMELINE_PHASE_FIELDS, 'projected phase');
    }
    assert.equal(row.phases[0].toolName, 'assistant_see');
    assert.equal(row.phases[0].toolKind, 'perception');
    assert.equal(row.phases[0].parallelGroup, 'p1');
    assert.equal(row.phases[1].actionId, null, 'a credential-shaped action id never passes');
    assert.equal(row.phases[2].reason, null, 'a sentence is not a reason code');
    assert.equal(row.phases[3].reason, 'tool-error', 'a short code passes unchanged');
    assert.equal(row.phases[4].toolKind, 'perception');

    const serialized = JSON.stringify(full.rows);
    for (const forbidden of ['PRIVATE PHASE EXTRA', 'PRIVATE TOOL ARGUMENT', 'PRIVATE TOOL ARG',
      'PRIVATE ERROR MESSAGE', 'ABCDEFGHIJKLMNOPQRSTUV', 'C:/Users']) {
      assert.equal(serialized.includes(forbidden), false, `leaked ${forbidden}`);
    }
    assert.equal(serialized.includes('toolArgs'), false);
    assert.equal(serialized.includes('arguments'), false);

    // Only the literal boolean opts in; a truthy string must not widen the answer.
    const notBoolean = await diagnostics.query({ probe: 'turn.timeline', limit: 5, includePhases: 'yes' });
    assert.equal(Object.hasOwn(notBoolean.rows[0], 'phases'), false);

    // The pipeline probe ignores the flag entirely.
    const pipeline = await diagnostics.query({ probe: 'pipeline.timeline', limit: 5, includePhases: true });
    assert.deepEqual(pipeline.rows, []);
  } finally {
    f.cleanup();
  }
});

test('3. pipeline.timeline: joins voice.latency by delivery id and turn, missing stays null', async () => {
  const pipeline = (turn, offsetMs) => event('voice.pipeline.timeline', {
    sessionId: 'session-a',
    deliveryMessageId: `msg-${turn}`,
    turn,
    bodyReadyMs: 800 + turn,
    spokenStartedMs: 810 + turn,
    spokenFirstSentenceMs: 1200 + turn,
    translatedFirstMs: 1250 + turn,
    firstChunkSynthMs: 1500 + turn,
    firstAudioMs: 2100 + turn,
    spokenCompleteMs: 3000 + turn,
    skippedSpokenVersion: false,
    reusedTranslation: false,
  }, offsetMs);
  const f = fixture([
    pipeline(7, 3000),
    event('voice.latency', {
      sessionId: 'session-a', deliveryMessageId: 'msg-7', turn: 7, acceptTurn: 7,
      totalMs: 2600, asrMs: 400, injectToAckMs: 60, ackToFirstTextMs: 300, text: 'PRIVATE REPLY',
    }, 2900),
    pipeline(8, 2000),
    // No delivery id on the latency row: the turn is the only join left.
    event('voice.latency', { turn: 8, totalMs: 3000 }, 1900),
    pipeline(9, 1000),
  ]);
  const diagnostics = createDiagnostics({ root: f.root, isEnabled: true });
  try {
    const result = await diagnostics.query({ probe: 'pipeline.timeline', limit: 10 });
    assert.equal(result.ok, true);
    assert.equal(result.rows.length, 3);
    assert.deepEqual(result.rows.map((row) => row.turn), [9, 8, 7], 'newest round first');
    for (const row of result.rows) {
      assertFields(row, DIAGNOSTICS_PIPELINE_TIMELINE_FIELDS, 'pipeline.timeline row');
    }

    const joinedById = result.rows[2];
    assert.equal(joinedById.deliveryMessageId, 'msg-7');
    assert.equal(joinedById.sessionId, 'session-a');
    assert.equal(joinedById.bodyReadyMs, 807);
    assert.equal(joinedById.spokenFirstSentenceMs, 1207);
    assert.equal(joinedById.translatedFirstMs, 1257);
    assert.equal(joinedById.firstChunkSynthMs, 1507);
    assert.equal(joinedById.firstAudioMs, 2107);
    assert.equal(joinedById.totalMs, 2600);
    assert.equal(joinedById.asrMs, 400);
    assert.equal(joinedById.injectToAckMs, 60);
    assert.equal(joinedById.ackToFirstTextMs, 300);

    const joinedByTurn = result.rows[1];
    assert.equal(joinedByTurn.turn, 8);
    assert.equal(joinedByTurn.totalMs, 3000, 'the turn is the fallback join key');
    assert.equal(joinedByTurn.asrMs, null, 'a stage the latency row did not carry stays null');

    const unjoined = result.rows[0];
    assert.equal(unjoined.turn, 9);
    assert.equal(unjoined.totalMs, null);
    assert.equal(unjoined.asrMs, null);
    assert.equal(unjoined.injectToAckMs, null);
    assert.equal(unjoined.ackToFirstTextMs, null);
    assert.equal(unjoined.bodyReadyMs, 809, 'the pipeline stages do not depend on the join');

    const serialized = JSON.stringify(result.rows);
    assert.equal(serialized.includes('PRIVATE REPLY'), false, 'the latency text field is not projected');
    assert.equal(serialized.includes('spokenStartedMs'), false, 'only the documented stages are projected');
  } finally {
    f.cleanup();
  }
});

test('4. no events and a torn line: empty arrays, no throw', async () => {
  const emptyRoot = mkdtempSync(join(tmpdir(), 'dsh-diagnostics-empty-'));
  try {
    const diagnostics = createDiagnostics({ root: emptyRoot, isEnabled: true });
    for (const probe of ['turn.timeline', 'pipeline.timeline']) {
      const result = await diagnostics.query({ probe, limit: 5 });
      assert.equal(result.ok, true, `${probe} answers without a log`);
      assert.deepEqual(result.rows, []);
      assert.equal(result.truncated, false);
    }
  } finally {
    rmSync(emptyRoot, { recursive: true, force: true });
  }

  const f = fixture([]);
  const good = event('voice.turn.timeline', turnPayload({ turn: 2, phases: [phase('model', 100)] }), 2000);
  const goodTwo = event('voice.turn.timeline', turnPayload({ turn: 3, phases: [phase('model', 110)] }), 1000);
  writeLines(f.file, [
    JSON.stringify(good),
    '{ not json at all',
    'null',
    '[]',
    JSON.stringify(goodTwo),
    '',
  ]);
  const diagnostics = createDiagnostics({ root: f.root, isEnabled: true });
  try {
    const result = await diagnostics.query({ probe: 'turn.timeline', limit: 10 });
    assert.equal(result.ok, true);
    assert.deepEqual(result.rows.map((row) => row.turn), [3, 2], 'bad lines are skipped, good rows survive');
    const none = await diagnostics.query({ probe: 'pipeline.timeline', limit: 10 });
    assert.deepEqual(none.rows, [], 'a probe with no matching rows returns an empty array');
    assert.equal(none.truncated, false);
  } finally {
    f.cleanup();
  }

  // A row whose payload is not an object still answers: every projected value is null, no throw.
  const broken = fixture([
    { id: 'evt-broken', ts: at(1000), type: 'voice.turn.timeline', corr_id: null, payload: null },
    { id: 'evt-broken-2', ts: at(2000), type: 'voice.pipeline.timeline', corr_id: null, payload: 'not an object' },
  ]);
  const brokenDiagnostics = createDiagnostics({ root: broken.root, isEnabled: true });
  try {
    const turn = await brokenDiagnostics.query({ probe: 'turn.timeline', limit: 5 });
    assert.equal(turn.rows.length, 1);
    assert.equal(turn.rows[0].turn, null);
    assert.equal(turn.rows[0].phaseCount, null);
    assert.equal(turn.rows[0].counts.modelRounds, null);
    assert.deepEqual(turn.rows[0].toolKinds, { 'self-speech': 0, 'self-wait': 0, perception: 0, work: 0 });
    const pipeline = await brokenDiagnostics.query({ probe: 'pipeline.timeline', limit: 5 });
    assert.equal(pipeline.rows.length, 1);
    assert.equal(pipeline.rows[0].turn, null);
    assert.equal(pipeline.rows[0].totalMs, null);
  } finally {
    broken.cleanup();
  }
});

test('5. timeline probes: default 20 rows, hard cap 100', async () => {
  const events = Array.from({ length: 120 }, (_value, index) => event(
    'voice.turn.timeline',
    turnPayload({ turn: index + 1, phases: [phase('model', index)] }),
    (119 - index) * 1000,
  ));
  const f = fixture(events);
  const diagnostics = createDiagnostics({ root: f.root, isEnabled: true });
  try {
    const byDefault = await diagnostics.query({ probe: 'turn.timeline' });
    assert.equal(byDefault.rows.length, DIAGNOSTICS_TIMELINE_LIMITS.defaultLimit);
    assert.equal(byDefault.rows.length, 20);
    assert.equal(byDefault.truncated, true, 'more matching rows exist than the default window');
    assert.equal(byDefault.rows[0].turn, 120, 'the newest row is kept');

    const capped = await diagnostics.query({ probe: 'turn.timeline', limit: 999 });
    assert.equal(capped.rows.length, DIAGNOSTICS_TIMELINE_LIMITS.maxLimit);
    assert.equal(capped.rows.length, 100, 'a caller cannot ask past the hard cap');
    assert.equal(capped.rows[0].turn, 120);
    assert.equal(capped.rows[99].turn, 21);

    const exact = await diagnostics.query({ probe: 'turn.timeline', limit: 100 });
    assert.equal(exact.rows.length, 100);
    assert.equal(exact.truncated, true);

    const two = await diagnostics.query({ probe: 'turn.timeline', limit: 2 });
    assert.equal(two.rows.length, 2);
    assert.deepEqual(two.rows.map((row) => row.turn), [120, 119]);
  } finally {
    f.cleanup();
  }

  const pipelineEvents = Array.from({ length: 25 }, (_value, index) => event(
    'voice.pipeline.timeline',
    { turn: index + 1, deliveryMessageId: `msg-${index + 1}`, bodyReadyMs: index },
    (24 - index) * 1000,
  ));
  const p = fixture(pipelineEvents);
  const pipelineDiagnostics = createDiagnostics({ root: p.root, isEnabled: true });
  try {
    const byDefault = await pipelineDiagnostics.query({ probe: 'pipeline.timeline' });
    assert.equal(byDefault.rows.length, 20);
    assert.equal(byDefault.truncated, true);
    const capped = await pipelineDiagnostics.query({ probe: 'pipeline.timeline', limit: 999 });
    assert.equal(capped.rows.length, 25, 'fewer rows than the cap returns them all');
    assert.equal(capped.truncated, false);
  } finally {
    p.cleanup();
  }
});

test('6. a real buildTurnTimeline payload projects without shape drift', async () => {
  const payload = buildTurnTimeline({
    sessionId: 'session-real',
    turn: 4,
    acceptTurn: 4,
    deliveryMessageId: 'msg-real-4',
    groupId: 'group-real-4',
    origin: { at: 1000, source: 'endpoint' },
    observations: [
      { type: 'turn/start', at: 1100, turn: 4, step: null, seq: 1 },
      { type: 'step/start', at: 1200, turn: 4, step: 0, seq: 2 },
      { type: 'tool/call', at: 1300, turn: 4, step: 0, seq: 3, callId: 'call-1', toolName: 'assistant_see' },
      { type: 'tool/result', at: 1500, turn: 4, step: 0, seq: 4, callId: 'call-1', ok: true, reason: null },
      { type: 'assistant/message', at: 1900, turn: 4, step: 0, seq: 5, hasTool: false, chars: 42 },
      { type: 'turn/end', at: 2000, turn: 4, step: null, seq: 6, status: 'completed' },
    ],
    anchors: {
      roundOpenedAt: 900,
      sessionReadyAt: 1000,
      injectedAt: 1050,
      acceptedAt: 1080,
      replyAt: 1900,
      audioAt: 2100,
    },
  });
  assert.ok(payload.phases.length >= 5, 'the builder really produced phases');
  const f = fixture([event('voice.turn.timeline', payload, 1000)]);
  const diagnostics = createDiagnostics({ root: f.root, isEnabled: true });
  try {
    const result = await diagnostics.query({ probe: 'turn.timeline', limit: 5 });
    const row = result.rows[0];
    assert.equal(row.timelineId, payload.timelineId);
    assert.equal(row.sessionId, 'session-real');
    assert.equal(row.acceptTurn, 4);
    assert.equal(row.phaseCount, payload.phases.length);
    assert.deepEqual(row.counts, payload.counts);
    assert.deepEqual(row.overlaps, payload.overlaps);
    assert.equal(row.residualMs, payload.residualMs);
    assert.equal(row.droppedPhases, payload.droppedPhases);
    assert.equal(row.origin.source, 'endpoint');
    assert.equal(row.origin.at, 1000);
    const names = [...new Set(payload.phases.map((entry) => entry.name))];
    assert.deepEqual(row.phaseNames, names);
    const longest = payload.phases.reduce((best, entry) =>
      (entry.durMs !== null && (best === null || entry.durMs > best.durMs) ? entry : best), null);
    assert.deepEqual(row.longestPhase, { name: longest.name, durMs: longest.durMs });
    assert.deepEqual(row.toolKinds, { 'self-speech': 0, 'self-wait': 0, perception: 1, work: 0 });
    // Payload keys outside the projection (`v`, `answerVersion`, the phases array) never pass.
    assert.equal(Object.hasOwn(row, 'v'), false);
    assert.equal(Object.hasOwn(row, 'answerVersion'), false);
  } finally {
    f.cleanup();
  }
});

test('7. rotated generations are read oldest first, newest budget first', async () => {
  const f = fixture([]);
  const rotated = join(f.root, 'data', 'events.jsonl.1');
  writeLines(rotated, [
    event('voice.turn.timeline', turnPayload({ turn: 1, phases: [phase('model', 10)] }), 5000),
    event('voice.turn.timeline', turnPayload({ turn: 2, phases: [phase('model', 20)] }), 4000),
  ]);
  writeLines(f.file, [event('voice.turn.timeline', turnPayload({ turn: 3, phases: [phase('model', 30)] }), 3000)]);
  const diagnostics = createDiagnostics({ root: f.root, isEnabled: true });
  try {
    const result = await diagnostics.query({ probe: 'turn.timeline', limit: 10 });
    assert.deepEqual(result.rows.map((row) => row.turn), [3, 2, 1], 'the rotated file is older, not newer');
    assert.equal(result.rows[0].phaseNames[0], 'model');

    const narrow = readRecentEvents({ root: f.root, maxBytes: 120 });
    assert.equal(narrow.truncated, true, 'a narrower byte budget is reported');
  } finally {
    f.cleanup();
  }
});

test('8. regression: the existing event probes keep their cap and audit shape', async () => {
  const events = Array.from({ length: 60 }, (_value, index) =>
    event('voice.latency', { turn: index, totalMs: index }, (59 - index) * 1000));
  const f = fixture(events);
  const audits = [];
  const diagnostics = createDiagnostics({
    root: f.root,
    isEnabled: true,
    emit: (type, payload) => audits.push({ type, payload }),
  });
  try {
    const result = await diagnostics.query({ probe: 'voice.latency', limit: 999 });
    assert.equal(result.rows.length, DIAGNOSTICS_LIMITS.maxLimit, 'the shared probe path still clamps at 50');
    assert.equal(result.truncated, true);
    assert.equal(result.rows[0].turn, 59);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].type, 'diagnostics.query');
    assert.deepEqual(Object.keys(audits[0].payload).sort(), ['limit', 'ms', 'probe', 'truncated']);
    assert.equal(audits[0].payload.limit, DIAGNOSTICS_LIMITS.maxLimit);
    assert.equal(audits[0].payload.probe, 'voice.latency');

    const unknown = await diagnostics.query({ probe: 'timeline' });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.reason, 'invalid-probe');
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// The `voice.latency` join must never key on a bare turn alone.
// ---------------------------------------------------------------------------

const pipelineEvent = (sessionId, turn, deliveryMessageId, offsetMs) => event('voice.pipeline.timeline', {
  sessionId,
  deliveryMessageId,
  turn,
  bodyReadyMs: 100,
  firstAudioMs: 1000,
}, offsetMs);

const latencyEvent = (sessionId, turn, deliveryMessageId, stages, offsetMs) => event('voice.latency', {
  ...(sessionId === null ? {} : { sessionId }),
  ...(deliveryMessageId === null ? {} : { deliveryMessageId }),
  turn,
  ...stages,
}, offsetMs);

test('9. same turn in another session never lends its latency, missing stays null', async () => {
  const f = fixture([
    pipelineEvent('seirein-2026-11-09', 1, 'msg-09', 6000),
    latencyEvent('seirein-2026-11-09', 1, 'msg-09', { totalMs: 1111, asrMs: 111 }, 5900),
    pipelineEvent('seirein-2026-11-10', 1, 'msg-10', 4000),
    latencyEvent('seirein-2026-11-10', 1, 'msg-10', { totalMs: 2222, asrMs: 222 }, 3900),
    // Session 11 has no latency row of its own: it must not borrow either turn-1 row above.
    pipelineEvent('seirein-2026-11-11', 1, 'msg-11', 3000),
    // A new-format latency row of ANOTHER session for turn 2, and a legacy pipeline row without a
    // delivery id: the bare turn is ambiguous, so nothing may be joined.
    latencyEvent('seirein-2026-11-09', 2, null, { totalMs: 3333 }, 2500),
    pipelineEvent('seirein-2026-11-12', 2, null, 2000),
  ]);
  const diagnostics = createDiagnostics({ root: f.root, isEnabled: true });
  try {
    const result = await diagnostics.query({ probe: 'pipeline.timeline', limit: 10 });
    assert.equal(result.ok, true);
    assert.deepEqual(
      result.rows.map((row) => [row.sessionId, row.turn]),
      [
        ['seirein-2026-11-12', 2],
        ['seirein-2026-11-11', 1],
        ['seirein-2026-11-10', 1],
        ['seirein-2026-11-09', 1],
      ],
      'one row per session+turn, newest first',
    );
    const [turn2, missing, tenth, ninth] = result.rows;
    assert.equal(turn2.totalMs, null, 'another session\'s turn 2 latency is never borrowed');
    assert.equal(missing.totalMs, null, 'a round with no latency row stays null');
    assert.equal(missing.asrMs, null);
    assert.equal(missing.bodyReadyMs, 100, 'its own pipeline stages are untouched');
    assert.equal(tenth.totalMs, 2222, 'each same-turn row keeps its own value');
    assert.equal(tenth.asrMs, 222);
    assert.equal(ninth.totalMs, 1111);
    assert.equal(ninth.asrMs, 111);
    console.log(`[9] same-turn joins: 11-09=${ninth.totalMs} 11-10=${tenth.totalMs} `
      + `11-11=${JSON.stringify(missing.totalMs)} 11-12=${JSON.stringify(turn2.totalMs)} (no cross-session borrow)`);
  } finally {
    f.cleanup();
  }
});

test('10. a legacy latency row (no session id) joins only while its turn is globally unique', async () => {
  const f = fixture([
    pipelineEvent('session-a', 3, null, 9000),
    latencyEvent(null, 3, null, { totalMs: 3000 }, 8900),
    pipelineEvent('session-a', 4, null, 8000),
    latencyEvent(null, 4, null, { totalMs: 4001 }, 7900),
    latencyEvent(null, 4, null, { totalMs: 4002 }, 7800),
    pipelineEvent('session-a', 5, null, 7000),
    latencyEvent(null, 5, null, { totalMs: 5000 }, 6900),
    pipelineEvent('session-b', 5, null, 6800),
    pipelineEvent('session-a', 6, null, 6000),
    latencyEvent('session-b', 6, null, { totalMs: 6000 }, 5900),
    pipelineEvent('session-b', 6, null, 5800),
  ]);
  const diagnostics = createDiagnostics({ root: f.root, isEnabled: true });
  try {
    const result = await diagnostics.query({ probe: 'pipeline.timeline', limit: 10 });
    const byKey = new Map(result.rows.map((row) => [`${row.sessionId}#${row.turn}`, row]));
    assert.equal(byKey.get('session-a#3').totalMs, 3000, 'the only row for turn 3 may join');
    assert.equal(byKey.get('session-a#4').totalMs, null, 'two legacy rows for turn 4 are ambiguous');
    assert.equal(byKey.get('session-a#5').totalMs, null, 'one legacy row over two pipeline rows is ambiguous');
    assert.equal(byKey.get('session-b#5').totalMs, null);
    assert.equal(byKey.get('session-a#6').totalMs, null, 'a scoped turn-6 row is another session\'s');
    assert.equal(byKey.get('session-b#6').totalMs, 6000, 'the exact session+turn still joins');
    console.log(`[10] legacy turn3=${byKey.get('session-a#3').totalMs} turn4=${JSON.stringify(byKey.get('session-a#4').totalMs)} `
      + `turn5=${JSON.stringify(byKey.get('session-a#5').totalMs)} scopedTurn6 a=${JSON.stringify(byKey.get('session-a#6').totalMs)} `
      + `b=${byKey.get('session-b#6').totalMs}`);
  } finally {
    f.cleanup();
  }
});

test('11. the newest latency row is chosen by EVENT time, not by file/insertion order', async () => {
  const f = fixture([
    event('voice.pipeline.timeline', {
      sessionId: 'session-n', deliveryMessageId: 'msg-n7', turn: 7, bodyReadyMs: 100,
    }, 5000),
    // The newer event is written first; the older one is the last line of the file.
    latencyEvent('session-n', 7, 'msg-n7', { totalMs: 7001, asrMs: 71 }, 800),
    latencyEvent('session-n', 7, 'msg-n7', { totalMs: 7002, asrMs: 72 }, 4000),
  ]);
  const diagnostics = createDiagnostics({ root: f.root, isEnabled: true });
  try {
    const result = await diagnostics.query({ probe: 'pipeline.timeline', limit: 5 });
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].totalMs, 7001, 'event order decides, not the last line of the file');
    assert.equal(result.rows[0].asrMs, 71);
    console.log(`[11] newestByEventTime totalMs=${result.rows[0].totalMs} asrMs=${result.rows[0].asrMs} `
      + `(file-order value 7002 rejected)`);
  } finally {
    f.cleanup();
  }
});

test('12. both timeline probes project the event time and order by it, not by turn', async () => {
  // 昨天（更早）的第 100 轮写在日志更靠前，今天（更新）的第 1 轮写在后面。
  const older = at(6 * 60 * 60 * 1000);
  const newer = at(60 * 1000);
  const stamped = (type, payload, ts) => ({ id: `evt-${type}-${ts}`, ts, type, corr_id: null, payload });
  const f = fixture([
    stamped('voice.turn.timeline', turnPayload({ turn: 100, phases: [] }), older),
    stamped('voice.turn.timeline', turnPayload({ turn: 1, phases: [] }), newer),
    // 没有事件时间的旧行：at 保持 null，按扫描顺序排在带时间的行之后。
    { id: 'evt-legacy', type: 'voice.turn.timeline', corr_id: null, payload: turnPayload({ turn: 5, phases: [] }) },
    stamped('voice.pipeline.timeline', {
      turn: 100, sessionId: 'session-a', deliveryMessageId: 'msg-100', bodyReadyMs: 8100,
    }, older),
    stamped('voice.pipeline.timeline', {
      turn: 1, sessionId: 'session-a', deliveryMessageId: 'msg-1', bodyReadyMs: 8010,
    }, newer),
  ]);
  const diagnostics = createDiagnostics({ root: f.root, isEnabled: true });
  try {
    assert.ok(DIAGNOSTICS_PROBES['turn.timeline'].fields.includes('at'), 'turn.timeline projects at');
    assert.ok(DIAGNOSTICS_PIPELINE_TIMELINE_FIELDS.includes('at'), 'pipeline.timeline projects at');

    const turn = await diagnostics.query({ probe: 'turn.timeline', limit: 5 });
    assert.deepEqual(turn.rows.map((row) => row.turn), [1, 100, 5],
      'event time first; an undated row never outranks a dated one');
    assert.equal(turn.rows[0].at, newer);
    assert.equal(turn.rows[1].at, older);
    assert.equal(turn.rows[2].at, null, 'a row with no time keeps null, never a made-up stamp');
    assert.ok(Date.parse(turn.rows[0].at) > Date.parse(turn.rows[1].at));

    const pipeline = await diagnostics.query({ probe: 'pipeline.timeline', limit: 5 });
    assert.deepEqual(pipeline.rows.map((row) => row.turn), [1, 100], 'the pipeline window is time-ordered too');
    assert.equal(pipeline.rows[0].at, newer);
    assert.equal(pipeline.rows[1].at, older);
    assert.equal(pipeline.rows[0].bodyReadyMs, 8010, 'the join and the stages are untouched');

    // 载荷自带 ts 时优先用它（比日志行的写入时间更接近事件本身）。
    const payloadStamped = fixture([
      stamped('voice.turn.timeline', turnPayload({ turn: 2, phases: [], ts: newer }), older),
    ]);
    const fromPayload = await createDiagnostics({ root: payloadStamped.root, isEnabled: true })
      .query({ probe: 'turn.timeline', limit: 5 });
    try {
      assert.equal(fromPayload.rows[0].at, newer, 'payload.ts wins over the log row ts');
    } finally {
      payloadStamped.cleanup();
    }

    console.log(`[12] turnAtOrder=[${turn.rows.map((row) => row.turn).join(',')}] `
      + `at=[${turn.rows[0].at},${turn.rows[1].at},${JSON.stringify(turn.rows[2].at)}] `
      + `pipelineAtOrder=[${pipeline.rows.map((row) => row.turn).join(',')}] payloadTs=${fromPayload.rows[0].at}`);
  } finally {
    f.cleanup();
  }
});
