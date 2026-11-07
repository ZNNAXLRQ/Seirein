/**
 * R03 delivery regression: `awaitSessionResult` must bind to the user message it delivered,
 * not to the first turn that happens to start after the baseline.
 *
 * The fake feed follows the real Harness event shape: `turn/start` opens a turn, the
 * `user/message` event carries the delivered message under `data` (with its `id`), then the
 * assistant output and `turn/end` belong to that same turn. A new session first runs a
 * standalone continuity-digest turn, exactly like `index.js` does.
 *
 * Run: node --test test/session-result-delivery-r03.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { awaitSessionResult } from '../src/host/session/delivery/dispatch.js';

/** A Cordis-like ctx: `on` records listeners and returns the unsubscribe handle. */
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
    emit(session, event) {
      for (const entry of [...listeners]) entry.fn(session, event);
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

const textMessage = (text) => ({ message: { content: [{ type: 'text', text }] } });
const userMessage = (id, text) => ({
  id,
  role: 'user',
  source: { kind: 'user' },
  content: [{ type: 'text', text }],
});
const session = (id) => ({ id });
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('a) a digest turn before the delivery turn never supplies the answer', async () => {
  const sessionId = 'seirein-delivery-digest';
  const fake = fakeCtx();
  const { ctx, emit } = fake;
  const promise = awaitSessionResult({
    ctx,
    sessionId,
    baselineSeq: 10,
    deliveryMessageId: 'request-a',
    timeoutMs: 5_000,
  });
  let outcome;
  promise.then((value) => {
    outcome = value;
  });

  // New session: the host first sends its continuity digest as its own turn.
  emit(session(sessionId), { type: 'turn/start', seq: 10, data: { turn: 1 } });
  emit(session(sessionId), {
    type: 'user/message',
    seq: 11,
    data: userMessage('digest-1', '今天也请多关照'),
  });
  emit(session(sessionId), { type: 'assistant/message', seq: 12, data: { turn: 1, ...textMessage('收到每日摘要') } });
  emit(session(sessionId), { type: 'turn/end', seq: 13, data: { turn: 1, reason: { kind: 'completed' } } });
  await tick();
  assert.equal(outcome, undefined, 'the digest turn must not finish the wait');

  // The delivered request is a later turn with its own user message id.
  emit(session(sessionId), { type: 'turn/start', seq: 14, data: { turn: 2 } });
  emit(session(sessionId), {
    type: 'user/message',
    seq: 15,
    data: userMessage('request-a', '帮我查一下今天的日程'),
  });
  emit(session(sessionId), { type: 'assistant/message', seq: 16, data: { turn: 2, ...textMessage('只属于请求A的答案') } });
  emit(session(sessionId), { type: 'turn/end', seq: 17, data: { turn: 2, reason: { kind: 'completed' } } });

  assert.deepEqual(await promise, {
    ok: true,
    text: '只属于请求A的答案',
    error: '',
    status: 'completed',
  });
  assert.equal(fake.listenerCount, 0, 'listener removed after finishing');
});

test('b) two overlapping waits cannot both consume the same turn', async () => {
  const sessionId = 'seirein-delivery-overlap';
  const fake = fakeCtx();
  const { ctx, emit } = fake;
  const first = awaitSessionResult({
    ctx,
    sessionId,
    baselineSeq: 20,
    deliveryMessageId: 'request-a',
    timeoutMs: 5_000,
  });
  const second = awaitSessionResult({
    ctx,
    sessionId,
    baselineSeq: 20,
    deliveryMessageId: 'request-b',
    timeoutMs: 5_000,
  });
  assert.equal(second.busy, true, 'the second waiter is refused explicitly');

  const secondResult = await second;
  assert.deepEqual(secondResult, {
    ok: false,
    text: '',
    error: 'session-listener-busy',
    status: 'busy',
  });

  emit(session(sessionId), { type: 'turn/start', seq: 20, data: { turn: 1 } });
  emit(session(sessionId), {
    type: 'user/message',
    seq: 21,
    data: userMessage('request-a', '第一个请求'),
  });
  emit(session(sessionId), { type: 'assistant/message', seq: 22, data: { turn: 1, ...textMessage('只属于请求A的答案') } });
  emit(session(sessionId), { type: 'turn/end', seq: 23, data: { turn: 1, reason: { kind: 'completed' } } });

  assert.deepEqual(await first, {
    ok: true,
    text: '只属于请求A的答案',
    error: '',
    status: 'completed',
  });
  assert.notEqual(secondResult.text, '只属于请求A的答案', 'the refused waiter never sees request A text');
  assert.equal(fake.listenerCount, 0, 'the winner removed its listener');
});

test('c) an aborted turn is not reported as success', async () => {
  const sessionId = 'seirein-delivery-abort';
  const fake = fakeCtx();
  const { ctx, emit } = fake;
  const promise = awaitSessionResult({
    ctx,
    sessionId,
    baselineSeq: 30,
    deliveryMessageId: 'request-c',
    timeoutMs: 5_000,
  });

  emit(session(sessionId), { type: 'turn/start', seq: 30, data: { turn: 3 } });
  emit(session(sessionId), {
    type: 'user/message',
    seq: 31,
    data: userMessage('request-c', '做一半被取消'),
  });
  emit(session(sessionId), { type: 'assistant/message', seq: 32, data: { turn: 3, ...textMessage('还没执行完成') } });
  emit(session(sessionId), { type: 'turn/end', seq: 33, data: { turn: 3, reason: { kind: 'aborted' } } });

  assert.deepEqual(await promise, {
    ok: false,
    text: '还没执行完成',
    error: 'aborted',
    status: 'aborted',
  });
});
