/**
 * R03 regression: `awaitSessionResult` must bind to the delivery point, not to any
 * `session/event` the resumed session happens to replay.
 *
 * The fake ctx/session feed reproduces the bug's shape: a resumed session first emits an
 * older turn's `assistant/message` + `turn/end` (history), then the real delivered turn.
 *
 * Run: node --test test/session-result-r03.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { awaitSessionResult } from '../src/host/session/delivery/dispatch.js';

const SESSION_ID = 'seirein-r03';

/** A Cordis-like ctx: `on` records listeners and returns the unsubscribe handle. */
function fakeCtx() {
  const listeners = new Set();
  let offCalls = 0;
  return {
    ctx: {
      get: () => undefined,
      on(type, fn) {
        const entry = { type, fn };
        listeners.add(entry);
        return () => {
          offCalls += 1;
          listeners.delete(entry);
        };
      },
    },
    emit(session, event) {
      for (const entry of [...listeners]) entry.fn(session, event);
    },
    get listenerCount() {
      return listeners.size;
    },
    get offCalls() {
      return offCalls;
    },
  };
}

const textMessage = (text) => ({ message: { content: [{ type: 'text', text }] } });
const session = () => ({ id: SESSION_ID });
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('a) replayed history (old assistant/message + old turn/end) never finishes the wait', async () => {
  const fake = fakeCtx();
  const { ctx, emit } = fake;
  const promise = awaitSessionResult({ ctx, sessionId: SESSION_ID, baselineSeq: 10, timeoutMs: 5_000 });
  let outcome;
  promise.then((value) => {
    outcome = value;
  });

  // A resumed session replays the previous answer: seq below the delivery baseline.
  emit(session(), { type: 'assistant/message', seq: 4, time: 1, data: textMessage('上一轮回答') });
  emit(session(), { type: 'turn/end', seq: 5, time: 2, data: { turn: 1, reason: { kind: 'completed' } } });
  await tick();
  assert.equal(outcome, undefined, 'history must not finish the wait');

  // Still listening: the real delivery can now resolve it.
  emit(session(), { type: 'turn/start', seq: 11, data: { turn: 2 } });
  emit(session(), { type: 'assistant/message', seq: 12, data: { turn: 2, ...textMessage('本轮回答') } });
  emit(session(), { type: 'turn/end', seq: 13, data: { turn: 2, reason: { kind: 'completed' } } });

  assert.deepEqual(await promise, { ok: true, text: '本轮回答', error: '', status: 'completed' });
  assert.equal(fake.offCalls, 2, 'session listener + stream channel removed after finishing');
});

test("b) this turn's assistant text + this turn's end returns this turn's last text", async () => {
  const fake = fakeCtx();
  const { ctx, emit } = fake;
  const promise = awaitSessionResult({ ctx, sessionId: SESSION_ID, baselineSeq: 0, timeoutMs: 5_000 });

  emit(session(), { type: 'turn/start', seq: 0, data: { turn: 7 } });
  emit(session(), { type: 'assistant/message', seq: 1, data: { turn: 7, ...textMessage('第一步') } });
  emit(session(), { type: 'assistant/message', seq: 2, data: { turn: 7, ...textMessage('最终回答') } });
  // Another session's event must be ignored even with the right seq.
  emit({ id: 'other-session' }, { type: 'turn/end', seq: 3, data: { turn: 7 } });
  emit(session(), { type: 'turn/end', seq: 4, data: { turn: 7, reason: { kind: 'completed' } } });

  assert.deepEqual(await promise, { ok: true, text: '最终回答', error: '', status: 'completed' });
});

test('c) cancel() removes the listener, clears the timer, and no later turn can finish it', async () => {
  const fake = fakeCtx();
  const { ctx, emit } = fake;
  const created = [];
  const cleared = [];
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = function trackedSetTimeout(fn, ms, ...args) {
    const handle = realSetTimeout(fn, ms, ...args);
    if (ms === 12_345) created.push(handle);
    return handle;
  };
  globalThis.clearTimeout = function trackedClearTimeout(handle) {
    if (created.includes(handle)) cleared.push(handle);
    return realClearTimeout(handle);
  };
  try {
    const promise = awaitSessionResult({ ctx, sessionId: SESSION_ID, baselineSeq: 20, timeoutMs: 12_345 });
    assert.equal(created.length, 1, 'the wait owns exactly one timer');
    promise.cancel();
    assert.deepEqual(await promise, { ok: false, text: '', error: 'cancelled', status: 'cancelled' });
    assert.deepEqual(cleared, created, 'cancel cleared the timeout');
    assert.equal(fake.offCalls, 2, 'cancel removed the session listener and the stream channel');
    assert.equal(fake.listenerCount, 0, 'no listener stays attached');

    // Events arriving after cancel must not restart or re-settle the wait.
    emit(session(), { type: 'turn/start', seq: 21, data: { turn: 3 } });
    emit(session(), { type: 'assistant/message', seq: 22, data: { turn: 3, ...textMessage('太晚了') } });
    emit(session(), { type: 'turn/end', seq: 23, data: { turn: 3 } });
    await tick();
    assert.equal(fake.offCalls, 2, 'finish happened once (both subscriptions)');
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});

test('d) timeout still resolves {ok:false, text, error:"timeout"}', async () => {
  const fake = fakeCtx();
  const { ctx, emit } = fake;
  const promise = awaitSessionResult({ ctx, sessionId: SESSION_ID, baselineSeq: 0, timeoutMs: 20 });
  // Partial text from the delivered turn is preserved in the timeout result.
  emit(session(), { type: 'turn/start', seq: 0, data: { turn: 4 } });
  emit(session(), { type: 'assistant/message', seq: 1, data: { turn: 4, ...textMessage('还没说完') } });

  assert.deepEqual(await promise, { ok: false, text: '还没说完', error: 'timeout', status: 'timeout' });
  assert.equal(fake.offCalls, 2, 'timeout removed the listener and the stream channel');
});
