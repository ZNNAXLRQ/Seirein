/**
 * Busy-refusal must not retrieve, restore, inject or deliver anything.
 *
 * The voice lane no longer touches memory at all (C2 injects at `agent/pre-step`; nothing is
 * spliced into the transcript), so the busy gate only has to prove the refusal short-circuits
 * before delivery and that a free turn still delivers the user's own words.
 * This test builds a real busy session (two overlapping `awaitSessionResult` waits on one id),
 * then mirrors the production flow (prepare → return on refusal) exactly.
 *
 * Run: node --test test/voice-busy-memory.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { awaitSessionResult } from '../src/host/session/delivery/dispatch.js';
import { deliverVoiceRequest, prepareVoiceTurn } from '../src/host/index.js';

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
    get listenerCount() {
      return listeners.size;
    },
  };
}

/** Session stand-in: every followup is counted, so a refusal must leave the count at 0. */
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

/** Memory spy: `brief` would return a hit, so any call is visible as `briefCalls > 0`. */
function fakeMemory() {
  const calls = { brief: 0, restore: 0 };
  return {
    calls,
    memory: {
      brief() {
        calls.brief += 1;
        return { matched: [{ id: 'm-1', text: '用户喜欢冰美式' }], mode: 'keyword', roles: ['user', 'assistant'], window: 0 };
      },
      restore() {
        calls.restore += 1;
      },
    },
  };
}

test('a busy refusal never reaches recall: no brief, no restore, no recall event, no followup', async () => {
  const sessionId = 'voice-busy-memory';
  const ctx = fakeCtx();
  // Own the session with a live listener, then make the voice turn the second waiter.
  const owner = awaitSessionResult({
    ctx: ctx.ctx,
    sessionId,
    deliveryMessageId: 'owner-request',
    timeoutMs: 5_000,
  });
  const session = fakeSession();
  const log = fakeLog();
  const spoken = [];
  const { calls, memory } = fakeMemory();

  const prepared = await prepareVoiceTurn({
    ctx: ctx.ctx,
    sessionId,
    text: '这句话会被拒收',
    spoken: '这句话会被拒收',
    memory,
    log,
    speakLine: async (line) => spoken.push(line),
    inScope: true,
    enabled: true,
    timeoutMs: 5_000,
  });

  assert.equal(prepared.refused, true, 'the busy gate refuses the utterance');
  // handleVoiceTask returns right here; the rest of this test proves nothing else was hit.
  const delivered = prepared.refused
    ? false
    : await deliverVoiceRequest({
      resultPromise: prepared.resultPromise,
      session,
      sessionId,
      request: prepared.request,
      log,
      speakLine: async (line) => spoken.push(line),
    });

  assert.equal(delivered, false, 'a refused utterance is not delivered');
  assert.equal(calls.brief, 0, 'prepareVoiceTurn never ran recall: memory.brief call count is 0');
  assert.equal(calls.restore, 0, 'memory.restore call count is 0 (the refused sentence is not reinforced)');
  assert.equal(session.followups.length, 0, 'followup call count is 0');
  assert.equal(prepared.recall.injected, false);
  assert.equal(prepared.recall.hits, 0);
  // 语音不再注入，改由 C2：准备阶段根本不检索，recall 恒为空。
  assert.equal(prepared.recall.text, '', 'the ready path reports no recall text');
  assert.deepEqual(prepared.request.content, [{ type: 'text', text: '这句话会被拒收' }], 'no memory block is injected');

  assert.equal(log.events.filter((entry) => entry.type === 'memory.recall').length, 0, 'no memory.recall event');
  const busy = log.events.filter((entry) => entry.type === 'voice.delivery.busy');
  assert.equal(busy.length, 1, 'exactly one busy event');
  assert.deepEqual(busy[0].payload, { sessionId });
  assert.equal(spoken.length, 1, 'only the refusal line is spoken');
  assert.ok(spoken[0].includes('上一条还在处理'), 'the user hears why it was refused');

  owner.cancel();
  await owner;
  assert.equal(ctx.listenerCount, 0, 'the busy path leaves no session listener behind');
});

test('a free session delivers the bare transcript and never recalls (C2 injects)', async () => {
  const sessionId = 'voice-free-memory';
  const ctx = fakeCtx();
  const session = fakeSession();
  const log = fakeLog();
  const { calls, memory } = fakeMemory();

  const prepared = await prepareVoiceTurn({
    ctx: ctx.ctx,
    sessionId,
    text: '我想喝点什么',
    spoken: '我想喝点什么',
    memory,
    log,
    speakLine: async () => {},
    inScope: true,
    enabled: true,
    timeoutMs: 5_000,
  });

  assert.equal(prepared.refused, false);
  // 语音不再注入，改由 C2：准备阶段不 brief、不 restore，交付的只是转写原文。
  assert.equal(calls.brief, 0, 'the voice lane never calls memory.brief');
  assert.equal(calls.restore, 0, 'the voice lane never reinforces a memory');
  assert.deepEqual(prepared.recall, { text: '', hits: 0, injected: false });
  assert.deepEqual(prepared.request.content, [{ type: 'text', text: '我想喝点什么' }], 'the transcript is delivered verbatim');
  assert.equal(log.events.filter((entry) => entry.type === 'memory.recall').length, 0, 'no memory.recall event from the voice lane');

  const delivered = await deliverVoiceRequest({
    resultPromise: prepared.resultPromise,
    session,
    sessionId,
    request: prepared.request,
    log,
    speakLine: async () => {},
  });
  assert.equal(delivered, true);
  assert.equal(session.followups.length, 1, 'the free path delivers exactly once');

  prepared.resultPromise.cancel();
  await prepared.resultPromise;
  assert.equal(ctx.listenerCount, 0, 'the listener is released');
});
