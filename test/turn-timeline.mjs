/**
 * P-46: one turn's real timeline (`voice.turn.timeline`) and its tool phases.
 *
 * The pure builder is tested first: interval union (parallel tools are never added together),
 * null vs. an explicit 0, a negative residual, the phase cap and the reason vocabulary. Then the
 * GOLDEN fixture replays the 2026-11-04 turn 16 sequence shape (15 model rounds, 14 tool calls,
 * first body text at ~58.5 s, residual ~341 ms): the real session log for that turn is not in this
 * checkout, so the sequence is rebuilt with exactly the numbers that round is known by and the
 * same event shapes (`assistant/message` with tool-call blocks, `tool/result.data.message.toolCallId`).
 *
 * The host feed tests mount the real plugin with a fake hearing/TTS/player and a synthetic agent
 * that commits one turn per delivery, so `handleVoiceTask` really emits the row: a no-body round
 * still logs one row, a `turn/end` error becomes `failed` + its kind, and a refused (busy) delivery
 * emits nothing. No microphone, ffmpeg, TTS service, network or GUI is used.
 *
 * Run: node --test test/turn-timeline.mjs
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildTurnTimeline,
  classifyToolKind,
  MAX_TURN_TIMELINE_PHASES,
  parallelGroups,
  timelineObservation,
  timelineOrigin,
  timelineReason,
  TURN_TIMELINE_STATUSES,
  turnTimelineStats,
  unionIntervalMs,
  VOICE_LATENCY_TIMELINE_FIELDS,
} from '../src/host/session/timeline/turn-timeline.js';
import { awaitSessionResult, VOICE_LATENCY_FIELDS } from '../src/host/session/delivery/dispatch.js';

const T0 = 1_760_000_000_000;
const SESSION = 'seirein-2026-11-04';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// helpers: build observations from event-shaped rows, exactly like the host feed
// ---------------------------------------------------------------------------

/** One session-event-shaped row at absolute time `at` (ms). */
const event = (type, at, data = {}) => ({ type, time: at, seq: at, data });

/** Reduce a list of event-shaped rows to observations (the real normalizer). */
const observe = (rows) => rows
  .map((row) => timelineObservation(row, row.time))
  .filter((row) => row !== null);

/**
 * The GOLDEN sequence: the shape of the 2026-11-04 turn 16 (14 tool calls before the answer).
 * Model and tool durations are chosen so the known aggregates hold exactly:
 *   modelMs 37381 (15 rounds), toolWallMs 20805 (14 calls), gaps 341, first text at 58527.
 * `originAt` is the silence endpoint; every `time` is absolute.
 */
function goldenSequence() {
  const modelDurations = [];
  for (let round = 1; round <= 14; round += 1) modelDurations.push(2_000 + round * 50);
  modelDurations.push(37_381 - modelDurations.reduce((total, value) => total + value, 0));
  const toolDurations = new Array(13).fill(1_500);
  toolDurations.push(20_805 - toolDurations.reduce((total, value) => total + value, 0));
  const rows = [];
  let at = T0;
  rows.push(event('turn/start', at, { turn: 16 }));
  at += 5;
  for (let round = 1; round <= 15; round += 1) {
    rows.push(event('step/start', at, { turn: 16, step: round }));
    rows.push(event('assistant/attempt', at, { turn: 16, step: round }));
    at += modelDurations[round - 1];
    const blocks = round < 15
      ? [
        { type: 'text', text: `第 ${round} 步的说明。` },
        { type: 'tool-call', name: round % 2 === 1 ? 'assistant_see' : 'session_search', callId: `call-${round}` },
      ]
      : [{ type: 'text', text: '这是最后的回答正文。' }];
    rows.push(event('assistant/message', at, {
      turn: 16,
      step: round,
      message: { id: `a-${round}`, role: 'assistant', content: blocks },
    }));
    if (round === 15) break;
    at += 12;
    rows.push(event('tool/call', at, {
      turn: 16,
      step: round,
      callId: `call-${round}`,
      name: round % 2 === 1 ? 'assistant_see' : 'session_search',
    }));
    at += toolDurations[round - 1];
    // The REAL call id of a result is on the committed message; the flat shape is tolerated too.
    rows.push(event('tool/result', at, {
      turn: 16,
      step: round,
      message: { toolCallId: `call-${round}`, isError: false },
    }));
    at += 12;
  }
  const firstTextAt = at;
  rows.push(event('turn/end', firstTextAt, { turn: 16, reason: { kind: 'completed', message: '' } }));
  return { rows, firstTextAt, originAt: T0 };
}

const GOLDEN = Object.freeze({
  modelRounds: 15,
  modelMs: 37_381,
  toolCalls: 14,
  toolWallMs: 20_805,
  firstTextMs: 58_526,
  residualMs: 341,
});

// ---------------------------------------------------------------------------
// 1) the pure builder: union, parallel groups, null vs 0, residual, cap, reason
// ---------------------------------------------------------------------------

test('toolMs is the interval UNION: parallel tools are never added together', () => {
  const rows = [
    event('turn/start', T0, { turn: 3 }),
    event('step/start', T0 + 10, { turn: 3, step: 1 }),
    event('assistant/message', T0 + 110, { turn: 3, step: 1, message: { content: [{ type: 'text', text: '并行查。' }] } }),
    event('tool/call', T0 + 120, { turn: 3, step: 1, callId: 'c1', name: 'assistant_see' }),
    event('tool/call', T0 + 130, { turn: 3, step: 1, callId: 'c2', name: 'session_search' }),
    event('tool/result', T0 + 220, { turn: 3, step: 1, message: { toolCallId: 'c1', isError: false } }),
    event('tool/result', T0 + 320, { turn: 3, step: 1, message: { toolCallId: 'c2', isError: false } }),
    event('tool/call', T0 + 400, { turn: 3, step: 1, callId: 'c3', name: 'assistant_say' }),
    event('tool/result', T0 + 450, { turn: 3, step: 1, message: { toolCallId: 'c3', isError: false } }),
    event('turn/end', T0 + 460, { turn: 3, reason: { kind: 'completed' } }),
  ];
  const payload = buildTurnTimeline({
    sessionId: SESSION,
    turn: 3,
    origin: { at: T0, source: 'endpoint' },
    observations: observe(rows),
  });
  const tools = payload.phases.filter((phase) => phase.name === 'tool');
  assert.equal(tools.length, 3);
  // c1 100 ms (120..220), c2 190 ms (130..320), c3 50 ms (400..450).
  assert.equal(payload.overlaps.toolMsSum, 340, 'the additive sum keeps every phase');
  assert.equal(payload.overlaps.toolWallMs, 250, 'the union counts the c1/c2 overlap once');
  assert.ok(payload.overlaps.toolWallMs < payload.overlaps.toolMsSum, 'parallel overlap is visible');
  assert.equal(payload.overlaps.parallelTools, 2, 'two phases really overlapped');
  assert.equal(tools[0].tool.kind, 'perception');
  assert.equal(tools[0].tool.parallelGroup, tools[1].tool.parallelGroup, 'overlapping tools share a group');
  assert.equal(tools[2].tool.parallelGroup, null, 'a serial tool has no group');
  assert.equal(tools[2].tool.kind, 'self-speech');
  assert.equal(classifyToolKind('wait_agent'), 'self-wait');
  assert.deepEqual(parallelGroups([{ startAt: 0, endAt: 10 }, { startAt: 5, endAt: 20 }]), [[0, 1]]);
  assert.equal(unionIntervalMs([{ startAt: 0, endAt: 100 }, { startAt: 50, endAt: 150 }]), 150);
  assert.equal(unionIntervalMs([]), 0);
});

test('an unobserved boundary is null, never a fabricated 0; an explicit 0 is kept', () => {
  const pending = buildTurnTimeline({
    sessionId: SESSION,
    turn: 4,
    origin: { at: T0, source: 'transcript' },
    observations: observe([
      event('turn/start', T0, { turn: 4 }),
      event('step/start', T0 + 100, { turn: 4, step: 1 }),
      // No assistant/message: the model round's end was never observed.
      event('turn/end', T0 + 900, { turn: 4, reason: { kind: 'error' } }),
    ]),
    status: 'failed',
    reason: 'error',
  });
  const model = pending.phases.find((phase) => phase.name === 'model');
  assert.equal(model.durMs, null, 'an open round has no duration');
  assert.equal(model.endMs, null);
  assert.equal(model.startMs, 100, 'the observed side keeps its relative stamp');
  assert.equal(model.status, 'pending');
  assert.equal(model.reason, 'no-result');
  const pendingStats = turnTimelineStats(pending, { collected: 3 });
  assert.equal(pendingStats.modelMs, null, 'a partial model sum is null, not a smaller number');
  assert.equal(pendingStats.residualMs, null, 'a phase without a duration makes the residual unknown');
  assert.equal(pendingStats.toolMs, 0, 'a round with no tool call measured 0 ms of tool time');
  assert.equal(pendingStats.toolCalls, 0);

  // An explicit measured 0 duration keeps 0 for both the phase and the aggregate.
  const zero = buildTurnTimeline({
    sessionId: SESSION,
    turn: 5,
    origin: { at: T0, source: 'injected' },
    observations: observe([
      event('step/start', T0 + 50, { turn: 5, step: 1 }),
      event('assistant/message', T0 + 50, { turn: 5, step: 1, message: { content: [{ type: 'text', text: '好。' }] } }),
    ]),
  });
  assert.equal(zero.phases[0].durMs, 0);
  const zeroStats = turnTimelineStats(zero, { collected: 2 });
  assert.equal(zeroStats.modelMs, 0, 'an explicit 0 is a measurement');
  assert.equal(zeroStats.modelRounds, 1);

  // Events that were never collected: every derived number is null (not 0).
  const uncollected = buildTurnTimeline({ sessionId: SESSION, turn: 6, origin: { at: T0, source: 'endpoint' } });
  const uncollectedStats = turnTimelineStats(uncollected, { collected: null });
  for (const field of VOICE_LATENCY_TIMELINE_FIELDS) {
    assert.equal(uncollectedStats[field], null, `${field} is null when nothing was collected`);
  }
  assert.equal(uncollected.counts.modelRounds, null);
  assert.equal(uncollected.counts.toolCalls, null);
});

test('residualMs is total - Σphases and a negative residual is preserved', () => {
  const rows = [
    event('step/start', T0, { turn: 7, step: 1 }),
    event('assistant/message', T0 + 100, { turn: 7, step: 1, message: { content: [{ type: 'text', text: '开始。' }] } }),
    // Two tools that both run 1100..1300: each 200 ms, so Σphases exceeds the round span.
    event('tool/call', T0 + 1100, { turn: 7, step: 1, callId: 'p1', name: 'assistant_see' }),
    event('tool/call', T0 + 1100, { turn: 7, step: 1, callId: 'p2', name: 'session_search' }),
    event('tool/result', T0 + 1300, { turn: 7, step: 1, message: { toolCallId: 'p1', isError: false } }),
    event('tool/result', T0 + 1300, { turn: 7, step: 1, message: { toolCallId: 'p2', isError: false } }),
    event('turn/end', T0 + 1200, { turn: 7, reason: { kind: 'completed' } }),
  ];
  const payload = buildTurnTimeline({
    sessionId: SESSION,
    turn: 7,
    origin: { at: T0, source: 'endpoint' },
    observations: observe(rows),
  });
  // total = max(turn/end 1200, last observed 1300) = 1300; Σ = 100 + 200 + 200 = 500.
  assert.equal(payload.residualMs, 800, 'the union-free residual subtracts every phase');
  // With the union the same round would look full: 1300 - (100 + 200) = 1000.
  assert.equal(payload.overlaps.toolWallMs, 200, 'the overlap is counted once in the union');

  const overlap = buildTurnTimeline({
    sessionId: SESSION,
    turn: 8,
    origin: { at: T0, source: 'endpoint' },
    observations: observe([
      event('turn/start', T0, { turn: 8 }),
      event('tool/call', T0 + 100, { turn: 8, step: 1, callId: 'a', name: 'assistant_see' }),
      event('tool/call', T0 + 100, { turn: 8, step: 1, callId: 'b', name: 'session_search' }),
      event('tool/result', T0 + 900, { turn: 8, step: 1, message: { toolCallId: 'a', isError: false } }),
      event('tool/result', T0 + 900, { turn: 8, step: 1, message: { toolCallId: 'b', isError: false } }),
      event('turn/end', T0 + 900, { turn: 8, reason: { kind: 'completed' } }),
    ]),
  });
  // total = 900 (origin T0), Σ = 800 + 800 = 1600 -> residual -700, never clamped to 0.
  assert.equal(overlap.residualMs, -700, 'a negative residual is information, not an error');
});

test('additive first-chunk boundaries never join the phase sum; overlap is still counted once', () => {
  // The 23.5 s investigation adds process-local first-chunk fields beside the timeline. They are
  // NOT phases: a new boundary must not be added to Σphases (which would double-count the same
  // wall interval) and must not change the residual definition.
  const rows = [
    event('turn/start', T0, { turn: 12 }),
    event('step/start', T0 + 10, { turn: 12, step: 1 }),
    event('assistant/message', T0 + 110, {
      turn: 12, step: 1, message: { content: [{ type: 'text', text: '并行查。' }] },
    }),
    event('tool/call', T0 + 120, { turn: 12, step: 1, callId: 'a', name: 'assistant_see' }),
    event('tool/call', T0 + 120, { turn: 12, step: 1, callId: 'b', name: 'session_search' }),
    event('tool/result', T0 + 320, { turn: 12, step: 1, message: { toolCallId: 'a', isError: false } }),
    event('tool/result', T0 + 420, { turn: 12, step: 1, message: { toolCallId: 'b', isError: false } }),
    event('turn/end', T0 + 520, { turn: 12, reason: { kind: 'completed' } }),
  ];
  const plain = observe(rows);
  // Same observations, plus the new pipeline fields a future feed may attach. They must be ignored
  // by this event-time builder instead of becoming extra phases.
  const additive = plain.map((row) => ({
    ...row,
    firstChunkSlotWaitMs: 5_000,
    firstChunkRequestMs: 200,
    firstChunkAudioReadyMs: 800,
  }));
  const anchors = { replyAt: T0 + 500, audioAt: T0 + 900 };
  const without = buildTurnTimeline({
    sessionId: SESSION, turn: 12, origin: { at: T0, source: 'endpoint' },
    observations: plain, anchors,
  });
  const withAdditive = buildTurnTimeline({
    sessionId: SESSION, turn: 12, origin: { at: T0, source: 'endpoint' },
    observations: additive, anchors,
  });

  assert.equal(withAdditive.residualMs, without.residualMs, 'the residual definition is untouched');
  assert.equal(withAdditive.overlaps.toolWallMs, 300, 'the 120..420 union is counted once');
  assert.equal(withAdditive.overlaps.toolMsSum, 500, 'the additive tool sum keeps the overlap visible');
  assert.equal(withAdditive.phases.length, without.phases.length, 'no shadow phase is invented');
  assert.ok(!JSON.stringify(withAdditive).includes('firstChunkRequestMs'),
    'the first-chunk fields stay in voice.pipeline.timeline, not in the phase payload');
  // Old and new coexist: every phase keeps exactly the documented, backward-compatible key set.
  for (const phase of withAdditive.phases) {
    assert.deepEqual(Object.keys(phase), ['name', 'actionId', 'startAt', 'endAt', 'startMs', 'endMs',
      'durMs', 'source', 'status', 'reason', 'wait', 'tool', 'extra']);
  }
  const statsWithout = turnTimelineStats(without, { firstTextAt: T0 + 520, audioAt: T0 + 900, collected: plain.length });
  const statsWith = turnTimelineStats(withAdditive, { firstTextAt: T0 + 520, audioAt: T0 + 900, collected: additive.length });
  assert.deepEqual(statsWith, statsWithout, 'the derived numbers are identical');

  // Missing boundaries stay null on both shapes (never a fabricated 0).
  const empty = buildTurnTimeline({ sessionId: SESSION, turn: 13, origin: { at: T0, source: 'injected' } });
  for (const field of VOICE_LATENCY_TIMELINE_FIELDS) {
    assert.equal(turnTimelineStats(empty, { collected: null })[field], null, `${field} is null when unobserved`);
  }
  assert.equal(empty.residualMs, null);
});

test('phases are capped at 64 and the dropped count is reported', () => {
  const rows = [];
  for (let round = 1; round <= 40; round += 1) {
    rows.push(event('step/start', T0 + round * 10, { turn: 9, step: round }));
    rows.push(event('assistant/message', T0 + round * 10 + 5, {
      turn: 9,
      step: round,
      message: { content: [{ type: 'text', text: '好。' }] },
    }));
    rows.push(event('tool/call', T0 + round * 10 + 6, { turn: 9, step: round, callId: `c${round}`, name: 'assistant_see' }));
    rows.push(event('tool/result', T0 + round * 10 + 7, {
      turn: 9,
      step: round,
      message: { toolCallId: `c${round}`, isError: false },
    }));
  }
  rows.push(event('turn/end', T0 + 500, { turn: 9, reason: { kind: 'completed' } }));
  const payload = buildTurnTimeline({
    sessionId: SESSION,
    turn: 9,
    origin: { at: T0, source: 'endpoint' },
    observations: observe(rows),
  });
  assert.equal(MAX_TURN_TIMELINE_PHASES, 64);
  assert.equal(payload.phases.length, 64);
  assert.equal(payload.droppedPhases, 80 - 64, '80 model/tool phases were produced');
  assert.equal(payload.counts.toolCalls, 40, 'the counts still describe the whole round');
});

test('reason is an enum or a short error code, and status is a closed set', () => {
  assert.equal(timelineReason('error'), 'error');
  assert.equal(timelineReason('Timeout'), 'timeout', 'an enum value is normalized to lowercase');
  assert.equal(timelineReason('PROVIDER_TIMEOUT'), 'PROVIDER_TIMEOUT', 'an error code passes');
  assert.equal(timelineReason('a provider failed with a long message'), 'unknown');
  assert.equal(timelineReason('x'.repeat(40)), 'unknown');
  assert.equal(timelineReason(''), null);
  assert.equal(timelineReason(null), null);
  for (const status of TURN_TIMELINE_STATUSES) {
    const payload = buildTurnTimeline({
      sessionId: SESSION,
      status,
      reason: status === 'ok' ? 'must-be-null' : 'error',
    });
    assert.ok(TURN_TIMELINE_STATUSES.includes(payload.status), `${status} is a documented status`);
    assert.equal(payload.reason, status === 'ok' ? null : 'error', `${status} keeps its reason`);
  }
  const unknownStatus = buildTurnTimeline({ sessionId: SESSION, status: 'not-a-status', reason: 'error' });
  assert.equal(unknownStatus.status, 'failed', 'an unknown status degrades to failed');
});

test('origin picks the earliest measured stamp; a missing stamp stays null', () => {
  assert.deepEqual(timelineOrigin({ endpointAt: 100, transcriptAt: 200, injectedAt: 300 }), {
    at: 100, source: 'endpoint',
  });
  assert.deepEqual(timelineOrigin({ transcriptAt: 200, injectedAt: 300 }), { at: 200, source: 'transcript' });
  assert.deepEqual(timelineOrigin({ injectedAt: 300 }), { at: 300, source: 'injected' });
  assert.deepEqual(timelineOrigin({}), { at: null, source: 'injected' });
});

test('step 0 and answerVersion 0 are real values; an absent turn is null, never 0', () => {
  const observation = timelineObservation({ type: 'step/start', time: T0 + 1, data: { turn: 2, step: 0 } });
  assert.equal(observation.step, 0, 'step 0 is the first step, not "unobserved"');
  const payload = buildTurnTimeline({
    sessionId: SESSION,
    turn: 2,
    answerVersion: 0,
    origin: { at: T0, source: 'injected' },
    observations: [
      observation,
      { type: 'assistant/message', at: T0 + 30, turn: 2, step: 0, hasTool: false, chars: 1 },
    ],
  });
  assert.equal(payload.turn, 2);
  assert.equal(payload.answerVersion, 0);
  assert.equal(payload.phases[0].actionId, 'step:0');
  assert.equal(payload.phases[0].extra.step, 0);
  assert.equal(payload.phases[0].durMs, 29);
  const missing = buildTurnTimeline({ sessionId: SESSION });
  assert.equal(missing.turn, null, 'an absent turn is null, not 0');
  assert.equal(missing.acceptTurn, null);
  assert.equal(missing.answerVersion, null);
});

// ---------------------------------------------------------------------------
// 2) GOLDEN: the 2026-11-04 turn 16 shape
// ---------------------------------------------------------------------------

test('GOLDEN 2026-11-04 turn 16: 15 model rounds, 14 tools, 58.5 s first text, 341 ms residual', () => {
  const golden = goldenSequence();
  const observations = observe(golden.rows);
  const payload = buildTurnTimeline({
    sessionId: SESSION,
    turn: 16,
    acceptTurn: 16,
    deliveryMessageId: 'msg-2026-11-04-t16',
    groupId: 'group-golden',
    answerVersion: 1,
    // The golden sequence is the SESSION-EVENT timeline: no host anchors, so the phase sum is
    // exactly the model + tool time and the residual is exactly the unmeasured gap.
    origin: { at: golden.originAt, source: 'endpoint' },
    observations,
  });
  const stats = turnTimelineStats(payload, {
    firstTextAt: golden.firstTextAt,
    audioAt: golden.firstTextAt + 120,
    transcriptAt: golden.originAt + 6,
    injectedAt: golden.originAt + 12,
    collected: observations.length,
  });

  assert.equal(payload.counts.modelRounds, GOLDEN.modelRounds, 'modelRounds');
  assert.equal(stats.modelMs, GOLDEN.modelMs, 'modelMs = Σ(assistant/message - step/start)');
  assert.equal(payload.counts.toolCalls, GOLDEN.toolCalls, 'toolCalls');
  assert.equal(payload.overlaps.toolWallMs, GOLDEN.toolWallMs, 'toolWallMs (union, no parallelism)');
  assert.equal(payload.overlaps.toolMsSum, GOLDEN.toolWallMs, 'no parallel tools here, so sum == union');
  assert.equal(payload.overlaps.parallelTools, 0);
  assert.equal(payload.counts.toolFailures, 0);
  assert.equal(payload.counts.attempts, 15);
  assert.equal(payload.counts.retries, 0);
  const firstTextMs = golden.firstTextAt - golden.originAt;
  assert.ok(Math.abs(firstTextMs - GOLDEN.firstTextMs) <= 50, `firstTextMs ${firstTextMs}`);
  assert.ok(Math.abs(payload.residualMs - GOLDEN.residualMs) <= 50, `residualMs ${payload.residualMs}`);
  // Deterministic nested numbers: the residual is exactly 341 ms in this fixture.
  assert.equal(payload.residualMs, GOLDEN.residualMs);
  assert.equal(stats.residualMs, GOLDEN.residualMs);
  assert.equal(payload.origin.source, 'endpoint');
  assert.equal(payload.status, 'ok');
  // The model phases alternate with the tool phases (a tool round is never the final model round).
  const names = payload.phases.map((phase) => phase.name);
  assert.equal(names.filter((name) => name === 'model').length, 15);
  assert.equal(names.filter((name) => name === 'tool').length, 14);
  // Phase durations add up to the measured model + tool time, and the residual is the rest.
  const phaseSum = payload.phases.reduce((total, phase) => total + (phase.durMs ?? 0), 0);
  assert.equal(phaseSum, 37_381 + 20_805);
  assert.equal(payload.phases[0].name, 'model', 'the round opens with its first model request');
  console.log(`ℹ GOLDEN: modelRounds=${payload.counts.modelRounds} modelMs=${stats.modelMs} `
    + `toolCalls=${payload.counts.toolCalls} toolWallMs=${payload.overlaps.toolWallMs} `
    + `firstTextMs=${firstTextMs} residualMs=${payload.residualMs} `
    + `phases=${payload.phases.length} dropped=${payload.droppedPhases} collected=${stats.collected}`);
});

// ---------------------------------------------------------------------------
// 3) privacy: no text, tool arguments/output, or error message in the payload
// ---------------------------------------------------------------------------

test('the serialized payload leaks no reply text, tool arguments/output or error message', () => {
  const rows = [
    event('turn/start', T0, { turn: 11 }),
    event('step/start', T0 + 5, { turn: 11, step: 1 }),
    event('assistant/message', T0 + 105, {
      turn: 11,
      step: 1,
      message: {
        content: [
          { type: 'text', text: 'SECRET-REPLY-TEXT' },
          { type: 'tool-call', name: 'session_search', callId: 'leaky-1', arguments: { query: 'SECRET-TOOL-ARGUMENT' } },
        ],
      },
    }),
    event('tool/call', T0 + 110, {
      turn: 11,
      step: 1,
      callId: 'leaky-1',
      name: 'session_search',
      arguments: { query: 'SECRET-TOOL-ARGUMENT' },
    }),
    event('tool/result', T0 + 310, {
      turn: 11,
      step: 1,
      // The result body and the tool error message must never enter the row.
      message: {
        toolCallId: 'leaky-1',
        isError: true,
        errorCode: 'TOOL_FAILED',
        error: { message: 'SECRET-TOOL-ERROR-MESSAGE' },
        content: [{ type: 'tool-result', output: 'SECRET-TOOL-OUTPUT' }],
      },
    }),
    event('assistant/attempt', T0 + 320, { turn: 11, step: 2, status: 'failed', error: { message: 'SECRET-ATTEMPT-ERROR' } }),
    event('turn/end', T0 + 400, {
      turn: 11,
      reason: { kind: 'error', message: 'SECRET-TURN-ERROR-MESSAGE', error: { message: 'SECRET-TURN-ERROR-MESSAGE' } },
    }),
  ];
  const observations = observe(rows);
  // Even the intermediate observations are desensitized.
  const raw = JSON.stringify(observations);
  for (const secret of ['SECRET-REPLY-TEXT', 'SECRET-TOOL-ARGUMENT', 'SECRET-TOOL-OUTPUT',
    'SECRET-TOOL-ERROR-MESSAGE', 'SECRET-ATTEMPT-ERROR', 'SECRET-TURN-ERROR-MESSAGE']) {
    assert.ok(!raw.includes(secret), `observation leaks ${secret}`);
  }
  const payload = buildTurnTimeline({
    sessionId: SESSION,
    turn: 11,
    origin: { at: T0, source: 'endpoint' },
    observations,
    status: 'failed',
    reason: 'TOOL_FAILED',
  });
  const serialized = JSON.stringify(payload);
  for (const secret of ['SECRET-REPLY-TEXT', 'SECRET-TOOL-ARGUMENT', 'SECRET-TOOL-OUTPUT',
    'SECRET-TOOL-ERROR-MESSAGE', 'SECRET-ATTEMPT-ERROR', 'SECRET-TURN-ERROR-MESSAGE']) {
    assert.ok(!serialized.includes(secret), `payload leaks ${secret}`);
  }
  // The failure is still explained: by an enum/code only.
  assert.equal(payload.status, 'failed');
  assert.equal(payload.reason, 'TOOL_FAILED');
  const tool = payload.phases.find((phase) => phase.name === 'tool');
  assert.equal(tool.status, 'failed');
  assert.equal(tool.reason, 'TOOL_FAILED');
  assert.equal(tool.tool.name, 'session_search');
  assert.equal(tool.tool.kind, 'work');
  // No phase carries a free-text field at all.
  for (const phase of payload.phases) {
    assert.deepEqual(Object.keys(phase), ['name', 'actionId', 'startAt', 'endAt', 'startMs', 'endMs',
      'durMs', 'source', 'status', 'reason', 'wait', 'tool', 'extra']);
    assert.ok(typeof phase.reason !== 'string' || phase.reason.length <= 32, 'reason is short');
  }
});

// ---------------------------------------------------------------------------
// 4) host feed: no-body / turn-end error / busy
// ---------------------------------------------------------------------------

test('the pre-bind buffer keeps a turn/start that arrived before user/message', async () => {
  const listeners = new Set();
  const ctx = {
    get: () => undefined,
    on(type, fn) {
      const entry = { type, fn };
      listeners.add(entry);
      return () => listeners.delete(entry);
    },
  };
  const session = { id: 'seirein-pre-bind' };
  const fire = (row) => {
    for (const entry of [...listeners]) entry.fn(session, row);
  };
  const timelines = [];
  const wait = awaitSessionResult({
    ctx,
    sessionId: session.id,
    baselineSeq: 0,
    deliveryMessageId: 'req-pre-bind',
    timeoutMs: 5_000,
    onTimeline: (info) => timelines.push(info),
  });
  let seq = 1;
  // turn/start + step/start BEFORE the identity binding: the pre-bind buffer must keep them.
  fire({ type: 'turn/start', seq: seq++, time: T0, data: { turn: 21 } });
  fire({ type: 'step/start', seq: seq++, time: T0 + 20, data: { turn: 21, step: 1 } });
  fire({ type: 'user/message', seq: seq++, time: T0 + 30, data: { id: 'req-pre-bind', role: 'user', content: [] } });
  fire({
    type: 'assistant/message',
    seq: seq++,
    time: T0 + 120,
    data: { turn: 21, step: 1, message: { content: [{ type: 'text', text: '好。' }] } },
  });
  fire({ type: 'turn/end', seq: seq++, time: T0 + 130, data: { turn: 21, reason: { kind: 'completed' } } });
  await wait;
  assert.equal(timelines.length, 1);
  const observations = timelines[0].observations;
  assert.deepEqual(
    observations.map((row) => row.type),
    ['turn/start', 'step/start', 'assistant/message', 'turn/end'],
  );
  assert.equal(observations[0].type, 'turn/start', 'the pre-bind turn/start survived binding');
  assert.equal(observations[0].at, T0);
  assert.equal(timelines[0].turn, 21);
});

test('a busy delivery produces no timeline observations at all', async () => {
  const listeners = new Set();
  const ctx = {
    get: () => undefined,
    on(type, fn) {
      const entry = { type, fn };
      listeners.add(entry);
      return () => listeners.delete(entry);
    },
  };
  const first = awaitSessionResult({
    ctx,
    sessionId: 'seirein-busy',
    baselineSeq: 0,
    deliveryMessageId: 'req-busy-1',
    timeoutMs: 5_000,
    onTimeline: () => {},
  });
  let busyCalls = 0;
  const second = awaitSessionResult({
    ctx,
    sessionId: 'seirein-busy',
    baselineSeq: 0,
    deliveryMessageId: 'req-busy-2',
    timeoutMs: 5_000,
    onTimeline: () => { busyCalls += 1; },
  });
  assert.equal(second.busy, true, 'the second wait is refused as busy');
  const rejected = await second;
  assert.equal(rejected.status, 'busy');
  assert.equal(rejected.ok, false);
  first.cancel();
  await sleep(5);
  assert.equal(busyCalls, 0, 'a refused delivery never collects or emits a timeline row');
});

// ---------------------------------------------------------------------------
// 5) the real host emits one row per round (no body / turn-end error)
// ---------------------------------------------------------------------------

const state = {
  events: [],
  followups: [],
  onUpdate: null,
  players: [],
  synthesized: [],
  listenerErrors: [],
  behaviors: [],
};
globalThis.__turnTimelineHost = state;
const FAKE_REPLY = '好的。我这就去查。';

const moduleUrl = (path) => new URL(path, import.meta.url).href;
const hearingUrl = moduleUrl('../src/host/hearing/hearing.js');
const sightUrl = moduleUrl('../src/host/vision/sight.js');
const ttsUrl = moduleUrl('../src/host/speech/tts.js');

const hooks = registerHooks({
  load(href, context, next) {
    if (href === hearingUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          const s = globalThis.__turnTimelineHost;
          export const modelReady = () => true;
          export const finalModelReady = () => false;
          export const isLoopbackDevice = () => false;
          export const listDevices = async () => ['Fake Mic'];
          export const startHearing = (options) => {
            s.onUpdate = options.onUpdate;
            return { device: options.device, stop() {}, stats: () => null };
          };
          export const watchHearingExit = () => {};
          export const annotateTranscript = (text) => text;
          export const joinDetailFields = () => ({});
          export const mergeJoinFallback = () => ({});
          export const offlineLimitedNote = () => '';
          export const truncationNotice = () => '';
        `,
      };
    }
    if (href === sightUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          const forbidden = async () => { throw new Error('capture forbidden'); };
          export const resolveFfmpeg = () => 'ffmpeg-fake';
          export const resolveFfplay = () => null;
          export const capture = forbidden;
          export const captureDesktop = forbidden;
          export const captureDevice = forbidden;
          export const startStoryboard = forbidden;
          export const OBSERVATION_TTL_MS = 30000;
          export function readObservation(o, { now = Date.now(), ttlMs = 30000 } = {}) { const v = o ?? {}; const c = Number(v.capturedAt); const s = Number.isFinite(c) && c > 0 ? c : Number(v.at); const at = Number.isFinite(s) && s > 0 ? s : null; const ageMs = at === null ? null : Math.max(0, now - at); const stale = ageMs === null || ageMs >= ttlMs; return { ...v, at, ageMs, stale, hint: stale ? 'stale' : '' }; }
        `,
      };
    }
    if (href === ttsUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          const s = globalThis.__turnTimelineHost;
          export { resolveGptLangs, resolveGptSovitsTimeout } from '${ttsUrl}?turn-timeline-helpers';
          export const configureTts = () => {};
          export const gptSovitsReferenceStatus = async () => ({ seconds: null, ok: false, readable: false });
          export const warmupGptSovits = async () => ({ ok: false, skipped: 'disabled' });
          export const applyGptSovitsModels = () => ({ ok: true });
          export const synthesize = async ({ text }) => {
            s.synthesized.push(text);
            return { file: 'fake-' + s.synthesized.length + '.mp3', bytes: 16, durationMs: 120, provider: 'edge-tts' };
          };
          export const speakStreaming = async () => { throw new Error('streaming not expected'); };
          export const stopPlayback = () => true;
          export const stopTts = () => true;
          export const play = (file, options) => {
            let resolve;
            const done = new Promise((doneResolve) => { resolve = doneResolve; });
            s.players.push({ file, onStart: options?.onStart, resolve, settled: false });
            return done;
          };
        `,
      };
    }
    return next(href, context);
  },
});

const { apply } = await import('../src/host/index.js');
const { EventLog } = await import('../src/host/memory/store.js');
hooks.deregister();

const originalEmit = EventLog.prototype.emit;
EventLog.prototype.emit = async function emit(type, payload) {
  state.events.push({ type, payload });
  return { id: 'turn-timeline', ts: new Date().toISOString(), type, payload };
};

after(() => {
  EventLog.prototype.emit = originalEmit;
  delete globalThis.__turnTimelineHost;
});

function drainPlayers() {
  for (const player of state.players) {
    if (player.settled === true) continue;
    player.settled = true;
    try {
      player.onStart?.({ startedAt: Date.now() });
    } catch {
      /* the start callback is a caption hook */
    }
    player.resolve();
  }
}

async function until(predicate, label, timeoutMs = 8_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    drainPlayers();
    if (predicate()) return;
    await sleep(10);
  }
  assert.fail(`timed out: ${label}`);
}

/**
 * Mount the real plugin with one fake agent. Each delivery consumes the next behavior:
 *  - `no-body`: a commentary message with a tool-call block plus a real tool call/result, then a
 *    completed turn — the turn has text but no reply body, so nothing is spoken;
 *  - `error`: a normal body message, then `turn/end {kind:'error'}`.
 */
async function mount(t, behaviors = ['no-body']) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-turn-timeline-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await mkdir(join(root, 'workspace'), { recursive: true });
  await writeFile(join(root, 'data', 'features.json'), JSON.stringify({
    hearing: true, ambient: false, voice: true, vision: false,
    subtitle: false, avatar: false, memory: false, fastpath: false,
  }), 'utf8');
  await writeFile(join(root, 'data', 'settings.json'), JSON.stringify({
    gptSovits: { enabled: false },
    langs: { speech: 'zh', subtitle: 'zh' },
    autoMemory: { enabled: false },
  }), 'utf8');

  state.events = [];
  state.followups = [];
  state.onUpdate = null;
  state.players = [];
  state.synthesized = [];
  state.listenerErrors = [];
  state.behaviors = behaviors.slice();

  const listeners = new Set();
  const bus = {
    on(type, fn) {
      const entry = { type, fn };
      listeners.add(entry);
      return () => listeners.delete(entry);
    },
    fire(type, ...args) {
      for (const entry of [...listeners]) {
        if (entry.type !== type) continue;
        try {
          entry.fn(...args);
        } catch (error) {
          state.listenerErrors.push({ type, error: error?.message ?? String(error) });
        }
      }
    },
  };
  const agents = new Map();
  let persisted = false;
  let seq = 0;
  const makeAgent = (sessionId) => {
    let turn = 0;
    const agent = {
      id: sessionId,
      session: { id: sessionId, header: { cwd: join(root, 'workspace') }, append() {} },
      followup(message) {
        state.followups.push(message);
        turn += 1;
        const turnId = turn;
        const behavior = state.behaviors.shift() ?? 'no-body';
        const fire = (type, data) => bus.fire('session/event', agent.session, {
          type, seq: (seq += 1), time: Date.now(), data,
        });
        setTimeout(() => {
          fire('turn/start', { turn: turnId });
          fire('user/message', { ...message });
          setTimeout(() => {
            fire('step/start', { turn: turnId, step: 1 });
            if (behavior === 'no-body') {
              // Commentary + a tool call: text exists, but it is not reply body.
              fire('assistant/message', {
                turn: turnId,
                step: 1,
                message: {
                  id: `a-${turnId}-1`,
                  role: 'assistant',
                  content: [
                    { type: 'text', text: '我先查一下。' },
                    { type: 'tool-call', name: 'assistant_see', callId: 'call-1' },
                  ],
                },
              });
              setTimeout(() => {
                fire('tool/call', { turn: turnId, step: 1, callId: 'call-1', name: 'assistant_see' });
                setTimeout(() => {
                  fire('tool/result', {
                    turn: turnId, step: 1, message: { toolCallId: 'call-1', isError: false },
                  });
                  fire('turn/end', { turn: turnId, reason: { kind: 'completed' } });
                }, 15);
              }, 10);
              return;
            }
            fire('assistant/message', {
              turn: turnId,
              step: 1,
              message: { id: `a-${turnId}-1`, role: 'assistant', content: [{ type: 'text', text: FAKE_REPLY }] },
            });
            if (behavior === 'error') {
              fire('turn/end', { turn: turnId, reason: { kind: 'error', code: 'PROVIDER_ERROR' } });
              return;
            }
            fire('turn/end', { turn: turnId, reason: { kind: 'completed' } });
          }, 10);
        }, 5);
      },
    };
    return agent;
  };
  const services = new Map([
    ['agentDefaultModel', { currentSelection: () => ({ provider: 'fake-provider', model: 'fake-model' }) }],
    ['sessionTitle', { get: () => undefined, rename: (_session, title) => ({ title, source: { kind: 'user' } }) }],
    ['workspaceRegistry', {
      async create(path) { return { id: 'ws-turn-timeline', path }; },
      get() { return { id: 'ws-turn-timeline', async attachSession() {} }; },
    }],
    ['agentLoop', {
      async resume(_ownerCtx, options) {
        if (!persisted) throw new Error('not persisted yet');
        const id = options.resumeSessionId;
        if (!agents.has(id)) agents.set(id, makeAgent(id));
        return { agent: agents.get(id) };
      },
      async createAgent(_ownerCtx, options) {
        const agent = makeAgent(options.sessionId);
        agents.set(options.sessionId, agent);
        persisted = true;
        return { agent };
      },
    }],
  ]);
  const cleanups = [];
  const tools = new Map();
  const effect = (fn) => {
    const cleanup = fn();
    if (typeof cleanup === 'function') cleanups.push(cleanup);
    return cleanup;
  };
  const ctx = {
    effect,
    on: bus.on,
    get: (name) => services.get(name),
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    inject: (_deps, registerScope) => {
      registerScope({
        effect,
        on: bus.on,
        systemPrompt: { section: () => () => {} },
        webServer: { register: () => () => {} },
      });
    },
    webServer: { register: () => () => {} },
  };
  apply(ctx, { root, enabled: true, asrMergeWindowMs: 10 });
  t.after(async () => {
    drainPlayers();
    const { cleanupRoot } = await import('./helpers/cleanup.mjs');
    await cleanupRoot(root, cleanups.splice(0));
  });
  const listen = tools.get('assistant_listen');
  assert.ok(listen !== undefined, 'assistant_listen is registered');
  const started = await listen.execute({ action: 'start' });
  assert.equal(started.ok, true, `listening started: ${started.error ?? ''}`);
  const rows = (type) => state.events.filter((entry) => entry.type === type);
  return { root, rows, say: (text) => state.onUpdate({ final: text, durationMs: 100 }) };
}

test('host: a turn with no reply body still logs exactly one voice.turn.timeline row', async (t) => {
  const app = await mount(t, ['no-body']);
  app.say('帮我看看屏幕');
  await until(() => app.rows('voice.turn.timeline').length === 1, 'voice.turn.timeline');
  const rows = app.rows('voice.turn.timeline');
  assert.equal(rows.length, 1, 'exactly one row for the round');
  const payload = rows[0].payload;
  assert.equal(payload.status, 'no-body');
  assert.equal(payload.reason, 'no-body');
  assert.equal(payload.lane, 'voice');
  assert.equal(payload.v, 1);
  assert.equal(payload.turn, 1);
  assert.equal(payload.acceptTurn, 1);
  assert.equal(payload.deliveryMessageId, state.followups.at(-1).id);
  // The tool boundary really reached the row (perception tool, one model round).
  assert.equal(payload.counts.modelRounds, 1);
  assert.equal(payload.counts.toolCalls, 1);
  assert.equal(payload.counts.toolFailures, 0);
  const tool = payload.phases.find((phase) => phase.name === 'tool');
  assert.equal(tool.tool.kind, 'perception');
  assert.equal(tool.status, 'ok');
  assert.ok(payload.phases.some((phase) => phase.name === 'accept'), 'the host acceptance anchor is present');
  assert.equal(payload.origin.source, 'transcript', 'no endpoint stamp in this fixture');
  // No audio was ever played, so no voice.latency row exists; the timeline row still explains why.
  assert.equal(app.rows('voice.latency').length, 0);
  console.log(`ℹ host no-body: status=${payload.status} modelRounds=${payload.counts.modelRounds} `
    + `toolCalls=${payload.counts.toolCalls} phases=${payload.phases.length} `
    + `origin=${payload.origin.source}@${payload.origin.at}`);
});

test('host: a turn/end error becomes failed with its kind, and still has one row', async (t) => {
  const app = await mount(t, ['error']);
  app.say('帮我看看明天的天气');
  await until(() => app.rows('voice.turn.timeline').length === 1, 'voice.turn.timeline (error)');
  const payload = app.rows('voice.turn.timeline')[0].payload;
  assert.equal(payload.status, 'failed');
  assert.equal(payload.reason, 'error', 'the turn/end kind is the reason');
  assert.equal(payload.turn, 1);
  assert.equal(payload.counts.modelRounds, 1, 'the model round before the error is counted');
  const model = payload.phases.find((phase) => phase.name === 'model');
  assert.equal(model.status, 'ok', 'the committed round itself completed');
  assert.ok(Number.isInteger(model.durMs), 'its duration was measured');
  console.log(`ℹ host error: status=${payload.status} reason=${payload.reason} `
    + `modelMs=${turnTimelineStats(payload).modelMs} phases=${payload.phases.length}`);
});

test('host: voice.latency carries the timeline numbers beside the canonical stages', async (t) => {
  const app = await mount(t, ['body']);
  app.say('帮我看看明天的天气');
  await until(() => app.rows('voice.latency').length === 1, 'voice.latency (body)');
  const timelines = app.rows('voice.turn.timeline');
  const latency = app.rows('voice.latency')[0].payload;
  assert.equal(timelines.length, 1, 'the timeline row was emitted before the latency row');
  const timeline = timelines[0].payload;
  assert.equal(timeline.status, 'ok');
  // Every derived number is written beside the canonical stage set, with the same values.
  for (const field of VOICE_LATENCY_TIMELINE_FIELDS) {
    assert.ok(field in latency, `${field} rides on voice.latency`);
  }
  assert.equal(latency.modelRounds, timeline.counts.modelRounds);
  assert.equal(latency.toolCalls, 0, 'this round called no tool');
  assert.equal(latency.toolMs, 0, 'a tool-less round measured 0 ms of tool time');
  assert.equal(latency.residualMs, timeline.residualMs);
  assert.equal(Number.isInteger(latency.collected), true, 'collected counts the raw observations');
  // The canonical 8 stages keep their place and are all still present.
  for (const field of VOICE_LATENCY_FIELDS) assert.ok(field in latency, `${field} is still canonical`);
  assert.equal(Number.isInteger(latency.totalMs), true);
  // Join keys point at the same turn as the timeline row.
  assert.equal(latency.deliveryMessageId, timeline.deliveryMessageId);
  assert.equal(latency.turn, timeline.turn);
  console.log(`ℹ host body: status=${timeline.status} latency modelMs=${latency.modelMs} `
    + `modelRounds=${latency.modelRounds} toolMs=${latency.toolMs} toolCalls=${latency.toolCalls} `
    + `residualMs=${latency.residualMs} collected=${latency.collected} totalMs=${latency.totalMs}`);
});

test('host: the canonical voice.latency stage set gains the timeline numbers, not new stages', () => {
  // The mapping table is what `recordVoiceLatency` spreads: it must never collide with the 8 stages.
  for (const field of VOICE_LATENCY_TIMELINE_FIELDS) {
    assert.ok(!VOICE_LATENCY_FIELDS.includes(field), `${field} is not a canonical stage`);
  }
  assert.equal(VOICE_LATENCY_TIMELINE_FIELDS.length, 12);
});
