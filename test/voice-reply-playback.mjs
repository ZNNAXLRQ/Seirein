/**
 * A2 gaps 4 and 5: a fallback must speak only body-eligible text, and only a player that
 * confirmed its start counts as played.
 *
 * Gap 4: `awaitSessionResult` reports `speechText` when the body-eligible text differs from the
 * committed `text`. A max-tokens turn whose only words were pre-tool commentary therefore yields
 * '' (subtitle/log only) instead of the whole-reply fallback replaying that commentary.
 *
 * Gap 5: `createReplySpeaker` counts a clip only after the injected player resolves its start.
 * A player that throws immediately leaves `played` at 0, so `finish()` speaks the whole reply
 * once instead of the answer going silent.
 *
 * Run: node --test test/voice-reply-playback.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createReplySpeaker, replySpeechText } from '../src/host/index.js';
import { awaitSessionResult } from '../src/host/session/delivery/dispatch.js';

const SESSION_ID = 'seirein-a2-fallback';
const tick = () => new Promise((resolve) => setImmediate(resolve));

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
  };
}

function feed(agent) {
  let seq = 1;
  return (event) => agent.emit({ id: SESSION_ID }, { seq: seq++, ...event });
}

/** Mirror the host's fallback branch: speak only `replySpeechText(result)`. */
async function speakFallback(result) {
  const spoken = [];
  const speaker = createReplySpeaker({
    now: () => 0,
    startedAt: 0,
    synthesize: async ({ text }) => ({ file: `${text}.mp3`, bytes: 8, durationMs: 100 }),
    play: async () => assert.fail('the fallback plays through speakWhole, not a sentence clip'),
    speakWhole: async (text) => {
      spoken.push(text);
      return { audioStartedAt: 42 };
    },
  });
  const speechText = replySpeechText(result);
  const stats = speechText.length > 0 ? await speaker.finish({ fullText: speechText }) : null;
  return { speechText, spoken, stats };
}

// ---------------------------------------------------------------------------
// Gap 4: the whole-reply fallback never speaks pre-tool commentary
// ---------------------------------------------------------------------------

test('gap 4: max-tokens with only pre-tool commentary plays nothing', async (t) => {
  const agent = fakeCtx();
  const emit = feed(agent);
  const deltas = [];
  const wait = awaitSessionResult({
    ctx: agent.ctx,
    sessionId: SESSION_ID,
    baselineSeq: 0,
    deliveryMessageId: 'req-commentary',
    timeoutMs: 5_000,
    onAssistantText: (info) => deltas.push(info.delta),
  });
  t.after(() => wait.cancel());

  emit({ type: 'turn/start', data: { turn: 2 } });
  emit({
    type: 'user/message',
    data: { id: 'req-commentary', role: 'user', content: [{ type: 'text', text: '查一下' }] },
  });
  // The step talks about work and then calls a tool; the turn ends before any post-tool body.
  emit({
    type: 'assistant/message',
    data: {
      turn: 2,
      step: 0,
      message: {
        content: [
          { type: 'text', text: '我先查询一下。' },
          { type: 'tool-call', id: 'c1', name: 'web_search', arguments: {} },
        ],
      },
    },
  });
  emit({ type: 'tool/call', data: { turn: 2, step: 0, callId: 'c1', name: 'web_search' } });
  emit({ type: 'tool/result', data: { turn: 2, step: 0, callId: 'c1' } });
  emit({ type: 'turn/end', data: { turn: 2, reason: { kind: 'max-tokens' } } });

  const result = await wait;
  assert.equal(result.status, 'max-tokens');
  assert.equal(result.text, '我先查询一下。', 'the text is still reported for the log/subtitle');
  assert.equal(result.speechText, '', 'no body-eligible text is offered to the fallback');
  assert.equal(deltas.length, 0, 'the body callback never fired');

  const { speechText, spoken, stats } = await speakFallback(result);
  assert.equal(speechText, '');
  assert.deepEqual(spoken, [], 'the fallback speaks nothing');
  assert.equal(stats, null, 'finish() is not even called without body text');
});

test('gap 4: a pure body turn still falls back to the whole reply once', async (t) => {
  const agent = fakeCtx();
  const emit = feed(agent);
  const deltas = [];
  const wait = awaitSessionResult({
    ctx: agent.ctx,
    sessionId: SESSION_ID,
    baselineSeq: 0,
    deliveryMessageId: 'req-body',
    timeoutMs: 5_000,
    onAssistantText: (info) => deltas.push(info.delta),
  });
  t.after(() => wait.cancel());

  emit({ type: 'turn/start', data: { turn: 3 } });
  emit({
    type: 'user/message',
    data: { id: 'req-body', role: 'user', content: [{ type: 'text', text: '你好' }] },
  });
  emit({ type: 'assistant/message', data: { turn: 3, step: 0, message: { content: [{ type: 'text', text: '完整回答。' }] } } });
  emit({ type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } });

  const result = await wait;
  assert.equal(result.text, '完整回答。');
  assert.equal(Object.hasOwn(result, 'speechText'), false, 'no extra field when text is already body');
  assert.deepEqual(deltas, ['完整回答。']);
  const { speechText, spoken, stats } = await speakFallback(result);
  assert.equal(speechText, '完整回答。');
  assert.deepEqual(spoken, ['完整回答。'], 'the whole reply is spoken exactly once');
  assert.equal(stats.fallback, true);
  assert.equal(stats.played, 0);
});

// ---------------------------------------------------------------------------
// Gap 5: the player's start is the counting boundary
// ---------------------------------------------------------------------------

test('gap 5: a player that fails to start leaves played at 0 and the full reply is spoken once', async () => {
  let attempts = 0;
  const spoken = [];
  const speaker = createReplySpeaker({
    now: () => 0,
    startedAt: 0,
    synthesize: async ({ text }) => ({ file: `${text}.mp3`, bytes: 8, durationMs: 100 }),
    play: async () => {
      attempts += 1;
      throw new Error('player failed to start');
    },
    speakWhole: async (text) => {
      spoken.push(text);
      return { audioStartedAt: 42 };
    },
  });
  speaker.push('完整回答。');
  const stats = await speaker.finish({ fullText: '完整回答。' });
  assert.equal(attempts, 1, 'the player was attempted once');
  assert.equal(stats.played, 0, 'a throw before start is not a played clip');
  assert.equal(stats.fallback, true, 'the whole reply goes through the fallback');
  assert.deepEqual(spoken, ['完整回答。'], 'the user hears the full answer exactly once');
  assert.equal(stats.firstPlayStartedAt, 42, 'the fallback start is the first real audio');
});

test('gap 5: a confirmed start counts once and suppresses the fallback', async () => {
  const spoken = [];
  const speaker = createReplySpeaker({
    now: () => 0,
    startedAt: 0,
    synthesize: async ({ text }) => ({ file: `${text}.mp3`, bytes: 8, durationMs: 100 }),
    play: async () => ({ audioStartedAt: 7, done: Promise.resolve() }),
    speakWhole: async (text) => {
      spoken.push(text);
      return { audioStartedAt: 42 };
    },
  });
  speaker.push('完整回答。');
  const stats = await speaker.finish({ fullText: '完整回答。' });
  assert.equal(stats.played, 1);
  assert.equal(stats.fallback, false);
  assert.deepEqual(spoken, [], 'no duplicate whole-reply playback');
  assert.equal(stats.firstPlayStartedAt, 7);
});
