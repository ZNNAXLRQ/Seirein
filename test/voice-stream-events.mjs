/**
 * A2 gap 1: live assistant text before the step commit.
 *
 * The listener subscribes to `session/event` once and understands two text feeds: the committed
 * `assistant/message` (the old path) and a streaming event that carries incremental text. The
 * streaming feed is probed rather than assumed: every event type this round produced is reported
 * through `voice.stream.probe`, so a renamed event can be confirmed from the log and added to
 * `STREAM_EVENT_TYPE`. No real model, TTS, player or network is used.
 *
 * Run: node --test test/voice-stream-events.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createReplySpeaker } from '../src/host/index.js';
import { awaitSessionResult } from '../src/host/session/delivery/dispatch.js';
import { prepareVoiceTurn } from '../src/host/index.js';

const SESSION_ID = 'seirein-a2-stream';
const tick = () => new Promise((resolve) => setImmediate(resolve));
const session = () => ({ id: SESSION_ID });

/** Cordis-like ctx: `on` records listeners and returns the unsubscribe handle. */
function fakeCtx() {
  const listeners = new Set();
  return {
    ctx: {
      get: () => undefined,
      on(type, fn) {
        const entry = { type, fn };
        listeners.add(entry);
        return () => listeners.delete(entry);
      },
    },
    emit(target, event) {
      for (const entry of [...listeners]) entry.fn(target, event);
    },
    /** Push onto the separate channel only (the session feed is not involved). */
    emitStream(...args) {
      for (const entry of [...listeners]) {
        if (entry.type === 'agent/assistant-stream') entry.fn(...args);
      }
    },
  };
}

function feed(agent) {
  let seq = 1;
  return (event) => agent.emit(session(), { seq: seq++, ...event });
}

const userMessage = (id) => ({ type: 'user/message', data: { id, role: 'user', content: [{ type: 'text', text: '测试' }] } });

/** A speaker whose synthesis and playback are recorded; playback starts immediately. */
function speechSpy() {
  const synth = [];
  const plays = [];
  const speaker = createReplySpeaker({
    now: () => 0,
    startedAt: 0,
    synthesize: async ({ text }) => {
      synth.push(text);
      return { file: `${text}.mp3`, bytes: 8, durationMs: 100 };
    },
    play: async ({ text }) => {
      plays.push(text);
      return { audioStartedAt: 1, done: Promise.resolve() };
    },
  });
  return { synth, plays, speaker };
}

// ---------------------------------------------------------------------------
// A) streaming path: frames are buffered and released when the step commits
// ---------------------------------------------------------------------------

test('stream: buffered deltas are released by the committed step, never before it', async (t) => {
  const agent = fakeCtx();
  const emit = feed(agent);
  const fx = speechSpy();
  const probes = [];
  const wait = awaitSessionResult({
    ctx: agent.ctx,
    sessionId: SESSION_ID,
    baselineSeq: 0,
    deliveryMessageId: 'req-stream',
    timeoutMs: 5_000,
    onAssistantText: (info) => fx.speaker.push(info.delta),
    onProbe: (info) => probes.push(info),
  });
  t.after(() => {
    fx.speaker.cancel('test-teardown');
    wait.cancel();
  });

  emit({ type: 'turn/start', data: { turn: 2 } });
  emit(userMessage('req-stream'));
  // The strict protocol: start -> text-delta chunks. Both chunks land before the commit.
  emit({ type: 'agent/assistant-stream', data: { type: 'start', turn: 2, step: 0, attemptId: 'a1', revision: 0, index: 0 } });
  emit({
    type: 'agent/assistant-stream',
    data: { type: 'text-delta', turn: 2, step: 0, attemptId: 'a1', revision: 0, index: 1, delta: '第一句话。' },
  });
  emit({
    type: 'agent/assistant-stream',
    data: { type: 'text-delta', turn: 2, step: 0, attemptId: 'a1', revision: 0, index: 2, delta: '第二句话。' },
  });
  await tick();
  assert.deepEqual(fx.synth, [], 'streamed text is buffered, not synthesized before the commit');
  assert.deepEqual(fx.plays, []);

  // The committed step is the release point; the buffered text is spoken at once, still before
  // turn/end, so a multi-step turn can start talking early.
  emit({
    type: 'assistant/message',
    data: { turn: 2, step: 0, message: { content: [{ type: 'text', text: '第一句话。第二句话。' }] } },
  });
  await tick();
  await tick();
  assert.deepEqual(fx.synth, ['第一句话。', '第二句话。'], 'the whole step is released on commit');
  assert.deepEqual(fx.plays, ['第一句话。', '第二句话。']);

  emit({ type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } });
  const result = await wait;
  assert.equal(result.ok, true);
  assert.equal(result.text, '第一句话。第二句话。');
  const stats = await fx.speaker.finish({ fullText: result.text });
  assert.equal(stats.played, 2);
  assert.equal(stats.fallback, false);
  assert.ok(probes[0].types.includes('agent/assistant-stream'), 'probe lists the streaming event');
  assert.equal(probes[0].streaming, true);
  assert.equal(probes[0].attempts, 1, 'one attempt was opened by the start frame');
  assert.equal(probes[0].streamFrames, 0, 'a session-event stream is not a channel frame');
});

// ---------------------------------------------------------------------------
// B) fallback path: with no streaming event the old message feed is unchanged
// ---------------------------------------------------------------------------

test('fallback: without a streaming event assistant/message still drives speech', async (t) => {
  const agent = fakeCtx();
  const emit = feed(agent);
  const fx = speechSpy();
  const deltas = [];
  const wait = awaitSessionResult({
    ctx: agent.ctx,
    sessionId: SESSION_ID,
    baselineSeq: 0,
    deliveryMessageId: 'req-commit',
    timeoutMs: 5_000,
    onAssistantText: (info) => {
      deltas.push(info.delta);
      fx.speaker.push(info.delta);
    },
  });
  t.after(() => {
    fx.speaker.cancel('test-teardown');
    wait.cancel();
  });

  emit({ type: 'turn/start', data: { turn: 3 } });
  emit(userMessage('req-commit'));
  emit({ type: 'assistant/message', data: { turn: 3, step: 0, message: { content: [{ type: 'text', text: '完整回答。' }] } } });
  emit({ type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } });
  const result = await wait;
  assert.deepEqual(result, { ok: true, text: '完整回答。', error: '', status: 'completed' }, 'result shape is unchanged');
  assert.deepEqual(deltas, ['完整回答。']);
  const stats = await fx.speaker.finish({ fullText: result.text });
  assert.equal(stats.played, 1);
});

// ---------------------------------------------------------------------------
// C) probe: one event per round with the deduplicated types it produced
// ---------------------------------------------------------------------------

test('probe: voice.stream.probe lists every session event type and the stream counters', async () => {
  const agent = fakeCtx();
  const emit = feed(agent);
  const log = { events: [], emit: async (type, payload) => { log.events.push({ type, payload }); } };
  const prepared = await prepareVoiceTurn({
    ctx: agent.ctx,
    sessionId: SESSION_ID,
    text: '测试探测',
    log,
    speakLine: async () => {},
    timeoutMs: 5_000,
  });
  assert.equal(prepared.refused, false);

  emit({ type: 'turn/start', data: { turn: 4 } });
  emit(userMessage(prepared.request.id));
  // An unknown type that also carries incremental text: recorded, but it must not drive speech.
  emit({ type: 'agent/partial', data: { turn: 4, delta: '不该播。' } });
  emit({ type: 'agent/assistant-stream', data: { type: 'start', turn: 4, step: 0, attemptId: 'p1' } });
  emit({
    type: 'agent/assistant-stream',
    data: { type: 'text-delta', turn: 4, step: 0, attemptId: 'p1', index: 1, delta: '好的。' },
  });
  emit({
    type: 'assistant/message',
    data: { turn: 4, step: 0, message: { content: [{ type: 'text', text: '好的。' }] } },
  });
  emit({ type: 'turn/end', data: { turn: 4, reason: { kind: 'completed' } } });
  const result = await prepared.resultPromise;
  await tick();

  assert.equal(result.ok, true);
  const probe = log.events.find((entry) => entry.type === 'voice.stream.probe');
  assert.ok(probe, 'the round emits one voice.stream.probe event');
  assert.equal(probe.payload.sessionId, SESSION_ID);
  assert.equal(probe.payload.streaming, true);
  assert.deepEqual(
    [...probe.payload.types].sort(),
    ['agent/assistant-stream', 'agent/partial', 'assistant/message', 'turn/end', 'turn/start', 'user/message'],
    'deduplicated types, including the unknown event and the streaming event',
  );
  assert.equal(probe.payload.attempts, 1);
  assert.equal(probe.payload.reasoningFrames, 0);
  assert.equal(probe.payload.skippedUnbound, 0);
  // This round never used the separate channel, so its probe counter stays at zero.
  assert.equal(probe.payload.streamFrames, 0);
  assert.deepEqual(probe.payload.channels, [{ channel: 'agent/assistant-stream', streamFrames: 0 }]);

  // The shape sample is recorded once and never contains reply text.
  const sample = log.events.find((entry) => entry.type === 'voice.stream.sample');
  assert.ok(sample, 'the first real frames are sampled once');
  assert.equal(sample.payload.frames.length, 2);
  const serialized = JSON.stringify(sample.payload);
  assert.ok(!serialized.includes('好的。'), 'the sample carries field names and types, not text');
  assert.ok(serialized.includes('start'), 'the frame type is visible in the sample');
});

// ---------------------------------------------------------------------------
// D) Gap B: the separate `agent/assistant-stream` channel
// ---------------------------------------------------------------------------

test('channel: a {agent, frame} push is buffered until the step commits', async (t) => {
  const agent = fakeCtx();
  const emit = feed(agent);
  const fx = speechSpy();
  const deltas = [];
  const probes = [];
  const wait = awaitSessionResult({
    ctx: agent.ctx,
    sessionId: SESSION_ID,
    baselineSeq: 0,
    deliveryMessageId: 'req-channel',
    timeoutMs: 5_000,
    onAssistantText: (info) => {
      deltas.push(info.delta);
      fx.speaker.push(info.delta);
    },
    onProbe: (info) => probes.push(info),
  });
  t.after(() => {
    fx.speaker.cancel('test-teardown');
    wait.cancel();
  });

  emit({ type: 'turn/start', data: { turn: 2 } });
  emit(userMessage('req-channel'));
  // No `session/event` carries the text: the bundle pushes the strict protocol on its channel.
  agent.emitStream({ agent: { session: session() }, frame: { type: 'start', turn: 2, step: 0, attemptId: 'c1', revision: 0, index: 0 } });
  agent.emitStream({
    agent: { session: session() },
    frame: { type: 'text-delta', turn: 2, step: 0, attemptId: 'c1', revision: 0, index: 1, text: '第一句话。' },
  });
  await tick();
  assert.deepEqual(deltas, [], 'the chunk is buffered, not reported before the commit');
  assert.deepEqual(fx.synth, []);

  // The other signature, `(agent, frame)`, is accepted too.
  agent.emitStream({ session: session() }, {
    frame: { type: 'text-delta', turn: 2, step: 0, attemptId: 'c1', revision: 0, index: 2, text: '第二句话。' },
  });
  await tick();
  assert.deepEqual(deltas, []);

  // Commit releases the whole buffered step at once.
  emit({
    type: 'assistant/message',
    data: { turn: 2, step: 0, message: { content: [{ type: 'text', text: '第一句话。第二句话。' }] } },
  });
  await tick();
  await tick();
  assert.deepEqual(deltas, ['第一句话。第二句话。'], 'one release for the committed step');
  assert.deepEqual(fx.synth, ['第一句话。', '第二句话。']);
  assert.deepEqual(fx.plays, ['第一句话。', '第二句话。']);

  emit({ type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } });
  const result = await wait;
  assert.equal(result.ok, true);
  assert.equal(result.text, '第一句话。第二句话。');
  const stats = await fx.speaker.finish({ fullText: result.text });
  assert.equal(stats.played, 2);
  assert.equal(probes[0].streamFrames, 3, 'start + two chunks arrived on the channel');
  assert.equal(probes[0].attempts, 1);
  assert.deepEqual(probes[0].channels, [{ channel: 'agent/assistant-stream', streamFrames: 3 }]);
});

test('channel: frames for another session or with no session are ignored', async (t) => {
  const agent = fakeCtx();
  const emit = feed(agent);
  const fx = speechSpy();
  const deltas = [];
  const probes = [];
  const wait = awaitSessionResult({
    ctx: agent.ctx,
    sessionId: SESSION_ID,
    baselineSeq: 0,
    deliveryMessageId: 'req-foreign',
    timeoutMs: 5_000,
    onAssistantText: (info) => {
      deltas.push(info.delta);
      fx.speaker.push(info.delta);
    },
    onProbe: (info) => probes.push(info),
  });
  t.after(() => {
    fx.speaker.cancel('test-teardown');
    wait.cancel();
  });

  emit({ type: 'turn/start', data: { turn: 2 } });
  emit(userMessage('req-foreign'));
  const frame = (text) => ({ type: 'text-delta', turn: 2, step: 0, attemptId: 'f1', index: 1, text });
  agent.emitStream({ agent: { session: { id: 'another-session' } } }, { frame: frame('别人的话。') });
  agent.emitStream({ frame: frame('没有归属的话。') });
  await tick();
  assert.deepEqual(deltas, [], 'another session never speaks here');

  // With no channel frame accepted, the committed-message path is exactly as before.
  emit({
    type: 'assistant/message',
    data: { turn: 2, step: 0, message: { content: [{ type: 'text', text: '本会话的正文。' }] } },
  });
  await tick();
  assert.deepEqual(deltas, ['本会话的正文。']);
  assert.deepEqual(fx.plays, ['本会话的正文。']);

  emit({ type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } });
  await wait;
  assert.equal(probes[0].streamFrames, 0, 'no frame counted for this session');
  assert.deepEqual(probes[0].channels, [{ channel: 'agent/assistant-stream', streamFrames: 0 }]);
  assert.equal(probes[0].streaming, false);
});
