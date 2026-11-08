/**
 * Busy-delivery regression: when a voice utterance arrives while another listener still owns
 * the session, `awaitSessionResult` resolves immediately as busy. That promise must never be
 * followed by `followup`, otherwise the text queues behind the previous turn and the previous
 * turn's answer is spoken as if it belonged to the new utterance.
 *
 * The busy state is produced by the real `awaitSessionResult` (two overlapping waits on one
 * session id), so this test covers the exact production condition, not a hand-built stub.
 *
 * Run: node --test test/voice-delivery-busy.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { awaitSessionResult } from '../src/host/session/delivery/dispatch.js';
import { deliverVoiceRequest } from '../src/host/index.js';

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

/** Session stand-in: counts every followup so a refused delivery must leave the count at 0. */
function fakeSession({ created = false } = {}) {
  const followups = [];
  return {
    followups,
    created,
    agent: {
      followup(message) {
        followups.push(message);
      },
    },
  };
}

function fakeLog() {
  const events = [];
  return {
    events,
    emit: async (type, payload) => {
      events.push({ type, payload });
    },
  };
}

/** Own one session with a live listener, then hand out the busy second waiter. */
async function busyWaiters(sessionId) {
  const fake = fakeCtx();
  const first = awaitSessionResult({
    ctx: fake.ctx,
    sessionId,
    baselineSeq: 100,
    deliveryMessageId: 'request-a',
    timeoutMs: 5_000,
  });
  const second = awaitSessionResult({
    ctx: fake.ctx,
    sessionId,
    baselineSeq: 100,
    deliveryMessageId: 'request-b',
    timeoutMs: 5_000,
  });
  assert.equal(second.busy, true, 'the second waiter reports busy');
  return { fake, first, second };
}

test('a) a busy delivery never calls followup, logs the refusal and speaks no result', async () => {
  const sessionId = 'voice-busy-refused';
  const { fake, first, second } = await busyWaiters(sessionId);
  const target = fakeSession({ created: true });
  const log = fakeLog();
  const spoken = [];

  const delivered = await deliverVoiceRequest({
    resultPromise: second,
    session: target,
    sessionId,
    request: userMessage('request-b', '第二个请求'),
    log,
    speakLine: async (line, subtitle = '') => {
      spoken.push({ line, subtitle });
    },
  });

  assert.equal(delivered, false, 'the request is refused, not delivered');
  assert.equal(target.followups.length, 0, 'followup call count stays 0 on the busy path');
  const busyEvents = log.events.filter((entry) => entry.type === 'voice.delivery.busy');
  assert.equal(busyEvents.length, 1, 'exactly one busy event');
  assert.deepEqual(busyEvents[0].payload, { sessionId });
  assert.equal(spoken.length, 1, 'only the refusal line is spoken');
  assert.ok(spoken[0].line.includes('上一条还在处理'), 'the user hears why it was refused');
  // The implementation refuses and drops the utterance; it does not keep a queue. The spoken
  // line must not promise storage or a later replay it cannot deliver.
  for (const promiseWord of ['记下', '稍后再说', '稍后', '稍等', '排队', '保存']) {
    assert.ok(
      !spoken[0].line.includes(promiseWord),
      `the busy line must not promise a queue (found "${promiseWord}" in "${spoken[0].line}")`,
    );
  }
  assert.ok(spoken[0].line.includes('再说一次'), 'the user is told to repeat the request instead');
  assert.ok(
    !spoken.some((entry) => entry.line.includes('只属于请求A的答案')),
    'no result text of any kind is spoken',
  );
  assert.ok(
    !log.events.some((entry) => entry.type === 'voice.injected'),
    'a refused utterance is never reported as injected',
  );

  // The winner still resolves normally, and the refused waiter never sees its text.
  fake.emit(session(sessionId), { type: 'turn/start', seq: 100, data: { turn: 1 } });
  fake.emit(session(sessionId), {
    type: 'user/message',
    seq: 101,
    data: userMessage('request-a', '第一个请求'),
  });
  fake.emit(session(sessionId), {
    type: 'assistant/message',
    seq: 102,
    data: { turn: 1, ...textMessage('只属于请求A的答案') },
  });
  fake.emit(session(sessionId), { type: 'turn/end', seq: 103, data: { turn: 1, reason: { kind: 'completed' } } });

  assert.equal((await first).text, '只属于请求A的答案');
  assert.deepEqual(await second, {
    ok: false,
    text: '',
    error: 'session-listener-busy',
    status: 'busy',
  });
  assert.equal(fake.listenerCount, 0, 'the winner removed its listener');
});

test('b) a free session delivers exactly one followup: the request itself', async () => {
  const sessionId = 'voice-busy-free';
  const fake = fakeCtx();
  const promise = awaitSessionResult({
    ctx: fake.ctx,
    sessionId,
    baselineSeq: 200,
    deliveryMessageId: 'request-c',
    timeoutMs: 5_000,
  });
  const target = fakeSession({ created: true });
  const log = fakeLog();
  const spoken = [];
  const request = userMessage('request-c', '普通请求');

  const delivered = await deliverVoiceRequest({
    resultPromise: promise,
    session: target,
    sessionId,
    request,
    log,
    speakLine: async (line) => spoken.push(line),
  });

  assert.equal(delivered, true);
  // The day background is no longer a message: it rides the request at `agent/pre-step`, so a
  // newly created session opens its first turn with the user's own request.
  assert.equal(target.followups.length, 1, 'the request is the only followup');
  assert.equal(target.followups[0], request);
  assert.equal(log.events.filter((entry) => entry.type === 'voice.delivery.busy').length, 0);
  assert.equal(spoken.length, 0);

  promise.cancel();
  await promise;
});
