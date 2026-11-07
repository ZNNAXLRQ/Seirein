/**
 * Waiter-leak regression: `prepareVoiceTurn` acquires the one-per-session listener. The voice lane
 * no longer touches memory (C2 injects at `agent/pre-step`; 语音不再注入，改由 C2), so nothing
 * between acquiring the waiter and returning may silently keep it. A prepared turn that is
 * cancelled — or whose delivery fails — must release both subscriptions, otherwise it keeps the
 * session until timeout and the very next utterance is refused as busy (`nextRefused=true`, the
 * exact symptom this file pins down).
 *
 * The leak is observed through the real `awaitSessionResult` registry: a cancelled wait calls
 * its `ctx.on` unsubscribes (session feed + `agent/assistant-stream` channel), and an
 * un-cancelled one leaves `listenerCount` at 2. No promise is mocked; the busy state is
 * produced by two overlapping waits, as in production.
 *
 * Run: node --test test/voice-prepare-leak.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { awaitSessionResult } from '../src/host/session/delivery/dispatch.js';
import { deliverVoiceRequest, prepareVoiceTurn } from '../src/host/index.js';

/** A Cordis-like ctx: `on` records listeners, counts unsubscribes and returns the handle. */
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
    get listenerCount() {
      return listeners.size;
    },
    get offCalls() {
      return offCalls;
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

const HIT = { matched: [{ id: 'm-1', text: '用户喜欢冰美式' }], mode: 'keyword', roles: ['user', 'assistant'], window: 0 };

/** A memory that would both retrieve and throw if touched: any call is a contract violation. */
function failingMemory() {
  const calls = { brief: 0, restore: 0 };
  return {
    calls,
    brief() {
      calls.brief += 1;
      return HIT;
    },
    restore() {
      calls.restore += 1;
      throw new Error('restore exploded');
    },
  };
}

/** A memory spy: C2 owns these calls now, so the voice lane must leave both counters at 0. */
function workingMemory() {
  const calls = { brief: 0, restore: 0 };
  return {
    calls,
    memory: {
      brief() {
        calls.brief += 1;
        return HIT;
      },
      restore() {
        calls.restore += 1;
      },
    },
  };
}

/** One prepared turn against a fresh session; `text` keeps each utterance distinguishable. */
function prepareOptions(ctx, sessionId, memory, log, text) {
  return {
    ctx: ctx.ctx,
    sessionId,
    text,
    spoken: text,
    memory,
    log,
    speakLine: async () => {},
    inScope: true,
    enabled: true,
    timeoutMs: 5_000,
  };
}

test('a) prepare never recalls/restores memory, and cancelling releases its waiter', async () => {
  const sessionId = 'voice-prepare-memory-free';
  const ctx = fakeCtx();
  const log = fakeLog();
  const memory = failingMemory();

  // 语音不再注入，改由 C2：准备阶段 0 次 brief、0 次 restore，即使 memory 一碰就炸。
  const prepared = await prepareVoiceTurn(prepareOptions(ctx, sessionId, memory, log, '这句话不该检索'));

  assert.equal(prepared.refused, false, 'a free session still prepares');
  assert.equal(memory.calls.brief, 0, 'prepareVoiceTurn never calls memory.brief');
  assert.equal(memory.calls.restore, 0, 'prepareVoiceTurn never calls memory.restore');
  assert.deepEqual(prepared.recall, { text: '', hits: 0, injected: false }, 'the voice lane recalls nothing');
  assert.deepEqual(prepared.request.content, [{ type: 'text', text: '这句话不该检索' }], 'the transcript is untouched');
  assert.equal(ctx.listenerCount, 2, 'the waiter owns the session feed and the stream channel');

  // The waiter acquired by prepare is still released exactly once, so the next turn is not busy.
  prepared.resultPromise.cancel();
  await prepared.resultPromise;

  assert.equal(ctx.offCalls, 2, 'cancel() released both subscriptions: session feed + stream channel');
  assert.equal(ctx.listenerCount, 0, 'no session listener survives the cancelled prepare');
  assert.equal(log.events.filter((entry) => entry.type === 'voice.prepare.failed').length, 0, 'nothing failed');

  console.log(JSON.stringify({
    test: 'a',
    briefCalls: memory.calls.brief,
    restoreCalls: memory.calls.restore,
    listenersAfterCancel: ctx.listenerCount,
    cancelCalls: ctx.offCalls,
  }));
});

test('b) after a cancelled prepare the very next turn is accepted (nextRefused=false)', async () => {
  const sessionId = 'voice-prepare-next-turn';
  const ctx = fakeCtx();
  const log = fakeLog();

  // Round 1: prepare owns the waiter, then the caller releases it (mute/barge-in).
  const first = await prepareVoiceTurn(prepareOptions(ctx, sessionId, failingMemory(), log, '第一句'));
  assert.equal(first.refused, false);
  first.resultPromise.cancel();
  await first.resultPromise;
  assert.equal(ctx.listenerCount, 0, 'round 1 released the waiter before returning');

  // Round 2: same session id, immediately after the cancellation. It must NOT be busy.
  const working = workingMemory();
  const next = await prepareVoiceTurn(prepareOptions(ctx, sessionId, working.memory, log, '第二句'));

  assert.equal(next.refused, false, 'nextRefused must be false after a cancelled prepare');
  assert.notEqual(next.resultPromise.busy, true, 'the next wait is a real listener, not a busy refusal');
  // 语音不再注入，改由 C2：normal preparation still performs no recall/restore.
  assert.equal(working.calls.brief, 0, 'the next prepare does not recall');
  assert.equal(working.calls.restore, 0, 'the next prepare does not reinforce');
  assert.equal(ctx.listenerCount, 2, 'the next turn owns the session feed and the stream channel');
  assert.deepEqual(next.request.content, [{ type: 'text', text: '第二句' }], 'the next utterance is intact');

  console.log(JSON.stringify({ test: 'b', nextRefused: next.refused, busy: next.resultPromise.busy === true }));

  next.resultPromise.cancel();
  await next.resultPromise;
  assert.equal(ctx.listenerCount, 0, 'the next turn cleans up too');
});

test('c) a throwing followup cancels the wait and the next turn is accepted', async () => {
  const sessionId = 'voice-prepare-followup-fails';
  const ctx = fakeCtx();
  const log = fakeLog();
  const { memory } = workingMemory();

  const prepared = await prepareVoiceTurn(prepareOptions(ctx, sessionId, memory, log, '投递会失败的一句'));
  assert.equal(prepared.refused, false);
  assert.equal(ctx.listenerCount, 2, 'the waiter owns the session feed and the stream channel before delivery');

  const failingSession = {
    created: false,
    agent: {
      followup() {
        throw new Error('followup exploded');
      },
    },
  };
  await assert.rejects(
    deliverVoiceRequest({
      resultPromise: prepared.resultPromise,
      session: failingSession,
      sessionId,
      request: prepared.request,
      log,
      speakLine: async () => {},
    }),
    /followup exploded/,
    'the delivery error still reaches the caller',
  );

  assert.equal(ctx.offCalls, 2, 'cancel() released the waiter the delivery owned (both subscriptions)');
  assert.equal(ctx.listenerCount, 0, 'a failed followup leaves no listener behind');
  // A cancelled wait resolves as `cancelled`: direct proof that `cancel()` was the cause.
  assert.deepEqual(await prepared.resultPromise, {
    ok: false,
    text: '',
    error: 'cancelled',
    status: 'cancelled',
  });

  // Same session id, immediately after: must not be refused as busy.
  const next = await prepareVoiceTurn(prepareOptions(ctx, sessionId, memory, log, '下一句'));
  assert.equal(next.refused, false, 'nextRefused must be false after a failed followup');
  console.log(JSON.stringify({ test: 'c', nextRefused: next.refused }));

  next.resultPromise.cancel();
  await next.resultPromise;
  assert.equal(ctx.listenerCount, 0);
});

test('d) the busy branch registers no listener, so the next free turn is not busy', async () => {
  const sessionId = 'voice-prepare-busy';
  const ctx = fakeCtx();
  const log = fakeLog();
  const { memory } = workingMemory();

  // The owner holds the session; the voice turn becomes the second waiter and is refused.
  const owner = awaitSessionResult({ ctx: ctx.ctx, sessionId, deliveryMessageId: 'owner', timeoutMs: 5_000 });
  const busyTurn = await prepareVoiceTurn(prepareOptions(ctx, sessionId, memory, log, '这句会被拒收'));

  assert.equal(busyTurn.refused, true, 'the busy gate refuses the utterance');
  assert.equal(busyTurn.resultPromise.busy, true);
  assert.deepEqual(await busyTurn.resultPromise, {
    ok: false,
    text: '',
    error: 'session-listener-busy',
    status: 'busy',
  });
  // `awaitSessionResult` returns the busy promise before it reserves the registry slot and
  // before `ctx.on(...)`; only the owner's two subscriptions (session feed + stream channel)
  // may exist here.
  const listenersDuringBusy = ctx.listenerCount;
  assert.equal(listenersDuringBusy, 2, 'the busy branch added no listener (only the owner remains)');

  owner.cancel();
  await owner;
  const listenersAfterOwnerReleased = ctx.listenerCount;
  assert.equal(listenersAfterOwnerReleased, 0);

  // If the busy branch had leaked, this next call would be refused as busy. It is not.
  const next = await prepareVoiceTurn(prepareOptions(ctx, sessionId, memory, log, '正常的一句'));
  assert.equal(next.refused, false, 'the next call after a busy refusal is not busy');
  assert.equal(ctx.listenerCount, 2, 'the next call owns exactly two listeners');
  console.log(JSON.stringify({
    test: 'd',
    listenersDuringBusy,
    listenersAfterOwnerReleased,
    nextRefused: next.refused,
  }));

  next.resultPromise.cancel();
  await next.resultPromise;
  assert.equal(ctx.listenerCount, 0);
});
