/**
 * Voice stream state machine: strict `start -> chunk -> end`, with playback released only by the
 * step's committed `assistant/message`.
 *
 * These tests use frames close to the real protocol shape: `{agent, frame}` on the
 * `agent/assistant-stream` channel, where the frame carries `type`, `turn`, `step`, `attemptId`,
 * `revision`, `index` and `text`. No model, TTS, player, network or child process is used.
 *
 * Run: node --test test/voice-stream-state.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { awaitSessionResult } from '../src/host/session/delivery/dispatch.js';
import { replySpeechText } from '../src/host/index.js';

const SESSION_ID = 'seirein-stream-state';
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
    emitStream(...args) {
      for (const entry of [...listeners]) {
        if (entry.type === 'agent/assistant-stream') entry.fn(...args);
      }
    },
  };
}

/** Session-event feed with increasing sequence numbers after the delivery baseline. */
function feed(agent) {
  let seq = 1;
  return (event) => agent.emit(session(), { seq: seq++, ...event });
}

/**
 * One delivery plus a fake clock. `spoken` records the fake clock at the exact instant
 * `onAssistantText` fired, and `afterTurnEnd` proves whether that was before `turn/end`.
 */
function createHarness() {
  const agent = fakeCtx();
  const emit = feed(agent);
  const spoken = [];
  const probes = [];
  const mismatches = [];
  const clock = { t: 0 };
  let turnEnded = false;
  const wait = awaitSessionResult({
    ctx: agent.ctx,
    sessionId: SESSION_ID,
    baselineSeq: 0,
    deliveryMessageId: 'req-state',
    timeoutMs: 5_000,
    onAssistantText: (info) => {
      spoken.push({ text: info.delta, full: info.text, at: clock.t, afterTurnEnd: turnEnded });
    },
    onCommitMismatch: (info) => mismatches.push(info),
    onProbe: (info) => probes.push(info),
  });
  return {
    agent,
    emit,
    wait,
    spoken,
    probes,
    mismatches,
    clock,
    /** Push one strict-protocol frame onto the independent channel. */
    push(frame) {
      agent.emitStream({ agent: { session: session() }, frame });
    },
    /** Bind the delivery's own user message (identity mode requires this before frames). */
    bind(turn = 2) {
      emit({ type: 'turn/start', data: { turn } });
      emit({ type: 'user/message', data: { id: 'req-state', role: 'user', content: [{ type: 'text', text: '测试' }] } });
    },
    commit(turn, step, text, extraBlocks = []) {
      emit({
        type: 'assistant/message',
        data: { turn, step, message: { content: [{ type: 'text', text }, ...extraBlocks] } },
      });
    },
    endTurn(turn = 2) {
      turnEnded = true;
      emit({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });
    },
  };
}

// ---------------------------------------------------------------------------
// 1) the previous round's frames arrive before this delivery is bound
// ---------------------------------------------------------------------------

test('unbound: frames of the previous round are dropped and never spoken', async (t) => {
  const h = createHarness();
  t.after(() => h.wait.cancel());

  h.emit({ type: 'turn/start', data: { turn: 1 } });
  h.push({ type: 'start', turn: 1, step: 0, attemptId: 'old', revision: 0, index: 0 });
  h.push({ type: 'text-delta', turn: 1, step: 0, attemptId: 'old', revision: 0, index: 1, text: '上一轮的话。' });
  h.push({ type: 'end', turn: 1, step: 0, attemptId: 'old' });
  await tick();
  assert.deepEqual(h.spoken, [], 'no text reaches the callback before the user message is bound');

  // Only now does the delivery's own user message bind the target turn.
  h.bind(1);
  h.endTurn(1);
  await h.wait;

  const probe = h.probes[0];
  assert.ok(probe.skippedUnbound > 0, 'the unbound frames are counted');
  assert.equal(probe.attempts, 0, 'no attempt was opened before binding');
});

// ---------------------------------------------------------------------------
// 2) reasoning frames carry text too, and must never become body text
// ---------------------------------------------------------------------------

test('reasoning: reasoning-delta frames never enter the body (0 speech)', async (t) => {
  const h = createHarness();
  t.after(() => h.wait.cancel());

  h.bind(2);
  h.push({ type: 'start', turn: 2, step: 0, attemptId: 'r1', revision: 0, index: 0 });
  h.push({ type: 'reasoning-delta', turn: 2, step: 0, attemptId: 'r1', index: 1, text: '这段推理不该被播报。' });
  h.push({ type: 'thinking', turn: 2, step: 0, attemptId: 'r1', index: 2, text: '思考。' });
  h.push({ type: 'end', turn: 2, step: 0, attemptId: 'r1' });
  h.endTurn(2);
  const result = await h.wait;

  assert.deepEqual(h.spoken, [], 'reasoning never reaches the callback');
  assert.equal(result.text, '');
  const probe = h.probes[0];
  assert.ok(probe.reasoningFrames >= 2, 'the reasoning frames are counted');
  assert.equal(probe.streamFrames, 4, 'start + two reasoning frames + end');
});

// ---------------------------------------------------------------------------
// 3) protocol deltas: repeated fragments are appended, never prefix-deduped
// ---------------------------------------------------------------------------

test('deltas: 非常 / 非常 (same revision+index) / 重要。 append to 非常重要。 exactly once', async (t) => {
  const h = createHarness();
  t.after(() => h.wait.cancel());

  h.bind(2);
  h.push({ type: 'start', turn: 2, step: 0, attemptId: 'd1', revision: 0, index: 0 });
  h.push({ type: 'text-delta', turn: 2, step: 0, attemptId: 'd1', revision: 0, index: 1, text: '非常' });
  // A legitimate retransmission of the very same protocol frame: the same revision+index must
  // be deduplicated instead of being eaten by a prefix guess.
  h.push({ type: 'text-delta', turn: 2, step: 0, attemptId: 'd1', revision: 0, index: 1, text: '非常' });
  h.push({ type: 'text-delta', turn: 2, step: 0, attemptId: 'd1', revision: 0, index: 2, text: '重要。' });
  await tick();
  assert.deepEqual(h.spoken, [], 'nothing is spoken while the step is still streaming');

  h.commit(2, 0, '非常重要。');
  await tick();
  assert.deepEqual(h.spoken.map((row) => row.text), ['非常重要。'], 'the repeated frame is not charged twice');
  assert.equal(h.mismatches.length, 0, 'the buffer equals the committed text');

  h.endTurn(2);
  const result = await h.wait;
  assert.equal(result.text, '非常重要。');
});

// ---------------------------------------------------------------------------
// 4) a step with a tool call is discarded; the next step's commit speaks
// ---------------------------------------------------------------------------

test('tool step: buffered pre-tool commentary is discarded, the next step plays', async (t) => {
  const h = createHarness();
  t.after(() => h.wait.cancel());

  h.bind(2);
  // Step 0 calls a tool: the stream cannot know that, only the commit reveals it.
  h.push({ type: 'start', turn: 2, step: 0, attemptId: 't0', revision: 0, index: 0 });
  h.push({ type: 'text-delta', turn: 2, step: 0, attemptId: 't0', revision: 0, index: 1, text: '我先查询资料。' });
  h.push({ type: 'end', turn: 2, step: 0, attemptId: 't0' });
  await tick();
  assert.deepEqual(h.spoken, [], 'the probe text is buffered, not spoken early');

  h.commit(2, 0, '我先查询资料。', [{ type: 'tool-call', id: 'call-1', name: 'web_search', arguments: {} }]);
  h.emit({ type: 'tool/call', data: { turn: 2, step: 0, callId: 'call-1', name: 'web_search' } });
  h.emit({ type: 'tool/result', data: { turn: 2, step: 0, callId: 'call-1' } });
  await tick();
  assert.deepEqual(h.spoken, [], 'a step that calls a tool is never spoken');

  // The post-tool step is the reply body and is released by its own commit. Its buffer is a
  // little shorter than the commit: the committed text wins and the mismatch is recorded.
  h.push({ type: 'start', turn: 2, step: 1, attemptId: 't1', revision: 0, index: 0 });
  h.push({ type: 'text-delta', turn: 2, step: 1, attemptId: 't1', revision: 0, index: 1, text: '查到了。' });
  h.push({ type: 'end', turn: 2, step: 1, attemptId: 't1' });
  h.commit(2, 1, '查到了，今天下雨。');
  await tick();

  assert.deepEqual(h.spoken.map((row) => row.text), ['查到了，今天下雨。'], 'the commit text wins');
  assert.equal(h.mismatches.length, 1, 'stream.commitMismatch is recorded for the differing step');
  h.endTurn(2);
  const result = await h.wait;
  assert.equal(result.text, '查到了，今天下雨。');
});

// ---------------------------------------------------------------------------
// 5) multi-step: step 1 is released at its commit, strictly before turn/end
// ---------------------------------------------------------------------------

test('multi-step: step 1 is spoken before turn/end (fake clock)', async (t) => {
  const h = createHarness();
  t.after(() => h.wait.cancel());

  h.bind(2);
  h.push({ type: 'start', turn: 2, step: 0, attemptId: 'm0', revision: 0, index: 0 });
  h.push({ type: 'text-delta', turn: 2, step: 0, attemptId: 'm0', revision: 0, index: 1, text: '第一步。' });
  h.push({ type: 'end', turn: 2, step: 0, attemptId: 'm0' });
  h.clock.t = 100;
  h.commit(2, 0, '第一步。');
  assert.equal(h.spoken.length, 1, 'release is synchronous with the step commit');
  assert.equal(h.spoken[0].at, 100, 'step 0 commit happens at fake t=100');
  assert.equal(h.spoken[0].afterTurnEnd, false, 'and it is before turn/end');

  h.clock.t = 200;
  h.push({ type: 'start', turn: 2, step: 1, attemptId: 'm1', revision: 0, index: 0 });
  h.push({ type: 'text-delta', turn: 2, step: 1, attemptId: 'm1', revision: 0, index: 1, text: '第二步。' });
  h.push({ type: 'end', turn: 2, step: 1, attemptId: 'm1' });
  h.commit(2, 1, '第二步。');
  assert.equal(h.spoken.length, 2, 'step 1 is released at its own commit');
  assert.equal(h.spoken[1].at, 200);

  h.clock.t = 900;
  h.endTurn(2);
  await h.wait;
  console.log('[evidence] step1 commit t=100ms / step2 commit t=200ms < turn/end t=900ms');
  assert.ok(h.spoken[0].at < 900 && h.spoken[1].at < 900);
  assert.ok(h.spoken.every((row) => row.afterTurnEnd === false));
});

// ---------------------------------------------------------------------------
// 6) wrong attemptId and out-of-order revisions are dropped
// ---------------------------------------------------------------------------

test('identity: another attemptId and a backwards revision are dropped', async (t) => {
  const h = createHarness();
  t.after(() => h.wait.cancel());

  h.bind(2);
  h.push({ type: 'start', turn: 2, step: 0, attemptId: 'a1', revision: 1, index: 0 });
  // Belongs to a different attempt: never appended.
  h.push({ type: 'text-delta', turn: 2, step: 0, attemptId: 'b2', revision: 1, index: 1, text: '别的尝试。' });
  h.push({ type: 'text-delta', turn: 2, step: 0, attemptId: 'a1', revision: 1, index: 1, text: '正确' });
  // The revision went backwards: dropped even though its index is newer.
  h.push({ type: 'text-delta', turn: 2, step: 0, attemptId: 'a1', revision: 0, index: 2, text: '乱序' });
  h.push({ type: 'text-delta', turn: 2, step: 0, attemptId: 'a1', revision: 1, index: 2, text: '。' });
  h.push({ type: 'end', turn: 2, step: 0, attemptId: 'a1' });

  h.commit(2, 0, '正确。');
  assert.deepEqual(h.spoken.map((row) => row.text), ['正确。'], 'only the matching attempt, in order');
  assert.equal(h.probes.length, 0, 'probe is reported when the wait settles');

  h.endTurn(2);
  await h.wait;
  assert.equal(h.probes[0].attempts, 1);
  assert.equal(h.mismatches.length, 0);
});

// ---------------------------------------------------------------------------
// 7) cancellation drops the buffer, no replay
// ---------------------------------------------------------------------------

test('cancel: an unreleased buffer is dropped and never replayed', async (t) => {
  const h = createHarness();
  t.after(() => h.wait.cancel());

  h.bind(2);
  h.push({ type: 'start', turn: 2, step: 0, attemptId: 'c1', revision: 0, index: 0 });
  h.push({ type: 'text-delta', turn: 2, step: 0, attemptId: 'c1', revision: 0, index: 1, text: '别播这一句。' });
  await tick();
  h.push({ type: 'end', turn: 2, step: 0, attemptId: 'c1' });

  h.wait.cancel();
  const result = await h.wait;
  assert.equal(result.status, 'cancelled');
  // Whatever lands after the cancel must not resurrect the dropped buffer.
  h.commit(2, 0, '别播这一句。');
  h.endTurn(2);
  await tick();
  assert.deepEqual(h.spoken, []);
});

// ---------------------------------------------------------------------------
// 8) an abandoned end drops its buffer; a synchronous empty commit stays empty
// ---------------------------------------------------------------------------

test('abandoned: an empty commit never promotes the discarded buffer', async (t) => {
  const h = createHarness();
  t.after(() => h.wait.cancel());

  h.bind(2);
  h.push({ type: 'start', turn: 2, step: 0, attemptId: 'x1', revision: 0, index: 0 });
  h.push({ type: 'text-delta', turn: 2, step: 0, attemptId: 'x1', revision: 0, index: 1, text: '废弃片段。' });
  // The protocol reports this attempt ended without a committable reply.
  h.push({ type: 'end', turn: 2, step: 0, attemptId: 'x1', outcome: { kind: 'abandoned' } });
  await tick();
  assert.deepEqual(h.spoken, [], 'an abandoned attempt stays buffered until its commit decides');

  // Same turn and step, committed synchronously with no body text: empty means empty.
  h.commit(2, 0, '');
  await tick();
  const played = h.spoken.length;
  console.log(`[evidence] abandoned-buffer speech count = ${played}`);
  assert.equal(played, 0, 'an empty commit must not reuse the abandoned buffer');
  assert.equal(h.mismatches.length, 0, 'there is no committed body text to mismatch');

  h.endTurn(2);
  const result = await h.wait;
  assert.equal(result.ok, false);
  assert.equal(result.status, 'empty');
  assert.equal(result.text, '');
  assert.equal(replySpeechText(result), '', 'the whole-reply fallback has nothing body-eligible to play');
  assert.equal(h.probes[0].commitMismatch, 0);
  assert.equal(h.probes[0].attempts, 1);
});
