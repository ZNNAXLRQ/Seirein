/**
 * A2 first-sentence speech.
 *
 * The voice lane used to speak only after `awaitSessionResult` returned the whole turn. This
 * suite covers the replacement: body-only incremental text, sentence splitting, queueing the
 * first complete sentence immediately, prefetching the next one during playback, tool-call
 * gating, interruption, the closing flush (exactly once) and the whole-reply fallback.
 *
 * No real TTS, player, network, overlay or child process is used: `createReplySpeaker` takes
 * `synthesize`/`play` seams, and `awaitSessionResult` is driven by a fake `session/event` feed.
 *
 * Run: node --test test/voice-first-sentence.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createReplySpeaker, splitSentences, takeSentences } from '../src/host/index.js';
import { awaitSessionResult } from '../src/host/session/delivery/dispatch.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
/** Poll a real async boundary (file writes) without depending on a fixed tick count. */
async function until(predicate) {
  for (let i = 0; i < 500; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail('async boundary did not arrive');
}

// ---------------------------------------------------------------------------
// A) splitting: Chinese/English punctuation, quotes, ellipsis, unterminated tail
// ---------------------------------------------------------------------------

test('splitSentences: Chinese and English terminators', () => {
  assert.deepEqual(splitSentences('你好。今天下雨。'), ['你好。', '今天下雨。']);
  assert.deepEqual(splitSentences('真的吗？那就这样！'), ['真的吗？', '那就这样！']);
  assert.deepEqual(splitSentences('Hello. How are you? Fine!'), ['Hello.', 'How are you?', 'Fine!']);
  // A run of terminators stays with the sentence it closes.
  assert.deepEqual(splitSentences('什么？！好的；'), ['什么？！', '好的；']);
  // A decimal/version point is not a sentence boundary.
  assert.deepEqual(splitSentences('版本1.2发布了。'), ['版本1.2发布了。']);
});

test('splitSentences: closing quotes and brackets stay with their sentence', () => {
  assert.deepEqual(splitSentences('他说：“走吧。”然后离开了。'), ['他说：“走吧。”', '然后离开了。']);
  assert.deepEqual(splitSentences('（第一点。）第二点。'), ['（第一点。）', '第二点。']);
  assert.deepEqual(splitSentences('"Stop!" he said.'), ['"Stop!"', 'he said.']);
});

test('splitSentences: ellipsis and the unterminated tail', () => {
  // Two or more ellipsis marks close a sentence; one is a pause inside it.
  assert.deepEqual(splitSentences('等等……我想想。'), ['等等……', '我想想。']);
  assert.deepEqual(splitSentences('等等…我想想。'), ['等等…我想想。']);
  // No punctuation at all: the tail is still spoken once instead of being dropped.
  assert.deepEqual(splitSentences('这是一个没有标点符号的很长的句子'), ['这是一个没有标点符号的很长的句子']);
  assert.deepEqual(splitSentences('这是一个没有标点符号的很长的句子', { flush: false }), []);
  assert.deepEqual(takeSentences('你好。还没完'), { sentences: ['你好。'], rest: '还没完' });
  assert.deepEqual(takeSentences('还没完。'), { sentences: ['还没完。'], rest: '' });
  // Empty and whitespace-only input never produce a phantom sentence.
  assert.deepEqual(splitSentences(''), []);
  assert.deepEqual(splitSentences('   \n '), []);
});

// ---------------------------------------------------------------------------
// shared fixtures
// ---------------------------------------------------------------------------

const SESSION_ID = 'seirein-a2';
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
  };
}

/** Emit helper that numbers events after the delivery baseline. */
function feed(agent) {
  let seq = 1;
  return (event) => agent.emit(session(), { seq: seq++, ...event });
}

/**
 * A speaker whose clock, synthesis and player are fully controlled. `synthesize` records the
 * fake clock at call time (so a test can prove when it was triggered); `play` blocks on a gate
 * that the test releases, standing in for a clip's real duration.
 */
function speakerFixture({ signal, split, speakWhole, maxChars = 240, prefetchDepth = undefined } = {}) {
  const clock = { t: 0 };
  const synth = [];
  const plays = [];
  const events = [];
  const speaker = createReplySpeaker({
    signal,
    split,
    speakWhole,
    maxChars,
    prefetchDepth,
    onEvent: (event) => events.push(event),
    now: () => clock.t,
    startedAt: 0,
    synthesize: async ({ text }) => {
      synth.push({ text, at: clock.t });
      return { file: `${text}.mp3`, bytes: 8, durationMs: 1000 };
    },
    play: async ({ text, signal: lane }) => {
      const gate = deferred();
      const entry = { text, at: clock.t, gate, done: false };
      plays.push(entry);
      // A real player is killed by the lane abort; the fake gate is released the same way.
      const onAbort = () => gate.resolve();
      lane?.addEventListener?.('abort', onAbort, { once: true });
      const done = gate.promise.then(() => {
        lane?.removeEventListener?.('abort', onAbort);
        entry.done = true;
        if (lane?.aborted) throw lane.reason ?? new DOMException('cancelled', 'AbortError');
      });
      // Gap 5 contract: resolve when the player has started, with the start clock; `done` settles
      // when the clip ends, so the queue still serializes on playback.
      return { audioStartedAt: Math.max(1, clock.t), done };
    },
  });
  return { clock, synth, plays, events, speaker };
}

/** Release every blocked fake player until the speaker has nothing in flight. */
async function playAll(plays) {
  for (let i = 0; i < 20; i += 1) {
    const next = plays.find((entry) => entry.done === false);
    if (next === undefined) return;
    next.gate.resolve();
    await tick();
  }
  assert.fail('the speaker kept starting clips');
}

// ---------------------------------------------------------------------------
// B) timing: first segment -> synthesis; sentence 2 prefetched during playback
// ---------------------------------------------------------------------------

test('timing: the first sentence is synthesized when its segment arrives, not after the turn', async (t) => {
  const agent = fakeCtx();
  const fx = speakerFixture();
  const emit = feed(agent);
  const wait = awaitSessionResult({
    ctx: agent.ctx,
    sessionId: SESSION_ID,
    baselineSeq: 0,
    timeoutMs: 5_000,
    onAssistantText: (info) => fx.speaker.push(info.delta),
  });
  t.after(() => {
    fx.speaker.cancel('test-teardown');
    wait.cancel();
  });

  emit({ type: 'turn/start', data: { turn: 2 } });
  // Segment 1 arrives at t=100: one complete sentence.
  fx.clock.t = 100;
  emit({ type: 'assistant/message', data: { turn: 2, step: 0, message: { content: [{ type: 'text', text: '第一句话。' }] } } });
  await tick();
  assert.deepEqual(fx.synth, [{ text: '第一句话。', at: 100 }], 'synthesis started at t=100 with segment 1 only');
  assert.deepEqual(fx.plays.map((entry) => entry.text), ['第一句话。'], 'the first clip is already playing');
  assert.equal(fx.speaker.stats.firstQueuedAt, 100, 'first sentence queued at the arrival instant');
  assert.equal(fx.speaker.stats.firstSynthStartedAt, 100);

  // Segment 2 (cumulative, same step) at t=200 is not a complete sentence yet.
  fx.clock.t = 200;
  emit({ type: 'assistant/message', data: { turn: 2, step: 0, message: { content: [{ type: 'text', text: '第一句话。第二句话' }] } } });
  await tick();
  assert.equal(fx.synth.length, 1, 'an incomplete sentence is never synthesized');

  // Segment 3 arrives at t=300 while sentence 1 is still playing.
  fx.clock.t = 300;
  emit({ type: 'assistant/message', data: { turn: 2, step: 0, message: { content: [{ type: 'text', text: '第一句话。第二句话。第三句话。' }] } } });
  await tick();
  assert.deepEqual(
    fx.synth.map((entry) => ({ text: entry.text, at: entry.at })),
    [
      { text: '第一句话。', at: 100 },
      { text: '第二句话。', at: 300 },
      { text: '第三句话。', at: 300 },
    ],
    'with the default depth 2, sentences 2 and 3 start synthesizing at t=300 while sentence 1 still plays',
  );
  assert.equal(fx.plays.length, 1, 'later sentences must not start playing before sentence 1 ends');

  // Turn end: the closing flush must not repeat a sentence, and each clip plays once.
  emit({ type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } });
  const result = await wait;
  assert.equal(result.ok, true);
  const finished = fx.speaker.finish({ fullText: result.text });
  await playAll(fx.plays);
  const stats = await finished;
  assert.deepEqual(fx.plays.map((entry) => entry.text), ['第一句话。', '第二句话。', '第三句话。']);
  assert.equal(stats.played, 3);
  assert.equal(stats.sentences, 3);
});

test('timing: firstPlayStartedAt keeps the first clip, lastPlayStartedAt the last', async () => {
  // Three clips start at 1000 / 3000 / 6000: the first stage must not be overwritten by a later
  // clip, and the last start has its own stamp instead of sharing it.
  const starts = [1000, 3000, 6000];
  let index = 0;
  const speaker = createReplySpeaker({
    now: () => 1000,
    startedAt: 1000,
    synthesize: async ({ text }) => ({ file: `${text}.mp3`, durationMs: 1 }),
    play: async () => ({ audioStartedAt: starts[index++], done: Promise.resolve() }),
  });
  speaker.push('第一句话。第二句话。第三句话。');
  const stats = await speaker.finish({ fullText: '第一句话。第二句话。第三句话。' });
  assert.equal(stats.played, 3);
  assert.equal(stats.firstPlayStartedAt, 1000, 'the stage keeps the first clip, not the last');
  assert.equal(stats.lastPlayStartedAt, 6000, 'the last clip start is recorded separately');
});

test('timing: the four first-sentence stages are measured separately (fake clock)', async () => {
  // Queued at 800, synthesis starts at 1000 (200 ms wait), audio ready at 1200 (200 ms synth),
  // player starts at 1500 (300 ms queue wait). The audible instant is not reported -> 0/unknown.
  const clock = { t: 800 };
  const speaker = createReplySpeaker({
    now: () => clock.t,
    startedAt: 800,
    synthesize: async ({ text }) => {
      clock.t = 1200;
      return { file: `${text}.mp3`, durationMs: 100 };
    },
    play: async () => {
      clock.t = 1500;
      return { audioStartedAt: 1500, done: Promise.resolve() };
    },
  });
  speaker.push('第一句话。');
  clock.t = 1000;
  await tick();
  const stats = await speaker.finish({ fullText: '第一句话。' });
  assert.equal(stats.firstSynthWaitMs, 200, 'queued 800 -> synthesis start 1000');
  assert.equal(stats.firstSynthMs, 200, 'synthesis start 1000 -> audio ready 1200');
  assert.equal(stats.firstQueueWaitMs, 300, 'audio ready 1200 -> player start 1500');
  assert.equal(stats.firstPlayerStartMs, 0, 'the bottom player reports no audible instant');
  assert.equal(stats.firstPlayerStartUnknown, true, 'and the stage is flagged unknown');
});

test('timing: firstPlayerStartMs uses the audible instant when the player reports it', async () => {
  const clock = { t: 800 };
  const speaker = createReplySpeaker({
    now: () => clock.t,
    startedAt: 800,
    synthesize: async ({ text }) => {
      clock.t = 1200;
      return { file: `${text}.mp3`, durationMs: 100 };
    },
    play: async () => {
      clock.t = 1500;
      return { audioStartedAt: 1500, audioHeardAt: 1560, done: Promise.resolve() };
    },
  });
  speaker.push('第一句话。');
  clock.t = 1000;
  await tick();
  const stats = await speaker.finish({ fullText: '第一句话。' });
  assert.equal(stats.firstPlayerStartMs, 60, 'player start 1500 -> sound 1560');
  assert.equal(stats.firstPlayerStartUnknown, false);
});

test('timing: no segment -> no synthesis at all until the closing flush', async () => {
  // Nothing was pushed: finish() speaks the whole reply exactly once (the compatibility path).
  const whole = [];
  const plain = speakerFixture({ speakWhole: async (text) => { whole.push(text); return { audioStartedAt: 9 }; } });
  const stats = await plain.speaker.finish({ fullText: '完整回答。' });
  assert.deepEqual(whole, ['完整回答。']);
  assert.equal(stats.fallback, true);
  assert.equal(stats.firstPlayStartedAt, 9);
  assert.deepEqual(plain.synth, []);
});

// ---------------------------------------------------------------------------
// C) tool gate: nothing plays before the tool result and the post-tool body
// ---------------------------------------------------------------------------

test('tool gate: pre-tool commentary never plays; only post-tool body does', async (t) => {
  const agent = fakeCtx();
  const fx = speakerFixture();
  const emit = feed(agent);
  const wait = awaitSessionResult({
    ctx: agent.ctx,
    sessionId: SESSION_ID,
    baselineSeq: 0,
    timeoutMs: 5_000,
    onAssistantText: (info) => fx.speaker.push(info.delta),
  });
  t.after(() => {
    fx.speaker.cancel('test-teardown');
    wait.cancel();
  });

  emit({ type: 'turn/start', data: { turn: 2 } });
  // Step 0 calls a tool: its text is commentary about work that has not happened yet.
  emit({
    type: 'assistant/message',
    data: {
      turn: 2,
      step: 0,
      message: {
        content: [
          { type: 'text', text: '我先查一下。' },
          { type: 'tool-call', id: 'call-1', name: 'web_search', arguments: {} },
        ],
      },
    },
  });
  emit({ type: 'tool/call', data: { turn: 2, step: 0, callId: 'call-1', name: 'web_search' } });
  await tick();
  assert.deepEqual(fx.synth, [], 'nothing is synthesized before the tool result');
  assert.deepEqual(fx.plays, []);

  // The model's post-tool step is the reply body; only now may speech start.
  emit({ type: 'tool/result', data: { turn: 2, step: 0, callId: 'call-1' } });
  emit({ type: 'assistant/message', data: { turn: 2, step: 1, message: { content: [{ type: 'text', text: '查到了，今天下雨。' }] } } });
  await tick();
  assert.deepEqual(fx.synth.map((entry) => entry.text), ['查到了，今天下雨。']);
  assert.deepEqual(fx.plays.map((entry) => entry.text), ['查到了，今天下雨。']);
  assert.ok(!fx.synth.some((entry) => entry.text.includes('我先查一下')), 'pre-tool commentary never plays');

  emit({ type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } });
  await wait;
  const finished = fx.speaker.finish({ fullText: '查到了，今天下雨。' });
  await playAll(fx.plays);
  const stats = await finished;
  assert.equal(stats.played, 1);
  assert.equal(stats.fallback, false);
});

test('tool gate: a body message is held while a tool call is still outstanding', async (t) => {
  const agent = fakeCtx();
  const fx = speakerFixture();
  const emit = feed(agent);
  const wait = awaitSessionResult({
    ctx: agent.ctx,
    sessionId: SESSION_ID,
    baselineSeq: 0,
    timeoutMs: 5_000,
    onAssistantText: (info) => fx.speaker.push(info.delta),
  });
  t.after(() => {
    fx.speaker.cancel('test-teardown');
    wait.cancel();
  });

  emit({ type: 'turn/start', data: { turn: 2 } });
  emit({ type: 'tool/call', data: { turn: 2, step: 0, callId: 'call-1', name: 'web_search' } });
  emit({ type: 'assistant/message', data: { turn: 2, step: 0, message: { content: [{ type: 'text', text: '结论来了。' }] } } });
  await tick();
  assert.deepEqual(fx.synth, [], 'a text message while a tool call is pending is not body yet');
  emit({ type: 'tool/result', data: { turn: 2, step: 0, callId: 'call-1' } });
  emit({ type: 'assistant/message', data: { turn: 2, step: 1, message: { content: [{ type: 'text', text: '正文第一句。' }] } } });
  await tick();
  assert.deepEqual(fx.synth.map((entry) => entry.text), ['正文第一句。']);
});

// ---------------------------------------------------------------------------
// D) interruption: stop the clip, clear the queue, ignore later fragments
// ---------------------------------------------------------------------------

test('interrupt: cancelling stops the playing clip and clears the queued sentence', async (t) => {
  const abort = new AbortController();
  const fx = speakerFixture({ signal: abort.signal });
  t.after(() => fx.speaker.cancel('test-teardown'));

  fx.speaker.push('第一句。第二句。');
  await tick();
  assert.deepEqual(fx.plays.map((entry) => entry.text), ['第一句。']);
  assert.deepEqual(fx.synth.map((entry) => entry.text), ['第一句。', '第二句。'], 'second sentence was prefetched');

  // Barge-in: the speech lane is invalidated (the host's invalidateSpeech), which aborts the
  // speaker's lane; the player dies with it.
  abort.abort();
  await tick();
  assert.equal(fx.plays.length, 1, 'sentence 2 never starts after the interruption');

  // Later body fragments of the old turn are ignored, not queued and not played.
  fx.speaker.push('第三句。');
  await tick();
  assert.equal(fx.plays.length, 1);
  assert.equal(fx.synth.length, 2);

  const stats = await fx.speaker.finish({ fullText: '第一句。第二句。第三句。' });
  assert.equal(stats.cancelled, true, 'an interrupted turn is reported as cancelled');
  assert.equal(stats.fallback, false, 'an interruption must never replay the whole reply');
  assert.equal(fx.plays.length, 1);
});

test('interrupt: cancel() empties the queue and blocks the prefetched sentence', async (t) => {
  const fx = speakerFixture();
  t.after(() => fx.speaker.cancel('test-teardown'));
  fx.speaker.push('第一句。第二句。');
  await tick();
  assert.equal(fx.plays.length, 1);
  assert.equal(fx.synth.length, 2);
  assert.equal(fx.speaker.cancel('barge-in'), true);
  // Release the killed player; the loop must exit without starting sentence 2.
  fx.plays[0].gate.resolve();
  await tick();
  fx.speaker.push('第三句。');
  await tick();
  assert.equal(fx.plays.length, 1);
  assert.equal(fx.synth.length, 2);
  const stats = await fx.speaker.finish({ fullText: '第一句。第二句。' });
  assert.equal(stats.cancelled, true);
});

test('interrupt: a clip superseded by another voice path stops the queue without replay', async () => {
  const speaker = createReplySpeaker({
    now: () => 0,
    startedAt: 0,
    synthesize: async ({ text }) => ({ file: `${text}.mp3`, durationMs: 100 }),
    play: async () => {
      throw Object.assign(new Error('reply playback superseded'), { code: 'REPLY_SUPERSEDED' });
    },
    speakWhole: async () => assert.fail('a superseded reply must not be replayed'),
  });
  speaker.push('第一句。第二句。');
  const stats = await speaker.finish({ fullText: '第一句。第二句。' });
  assert.equal(stats.cancelled, true);
  // Gap 5: the player never confirmed a start, so nothing counts as played; the superseded
  // turn is cancelled and still must not replay.
  assert.equal(stats.played, 0);
  assert.equal(stats.fallback, false);
});

// ---------------------------------------------------------------------------
// E) closing flush: the last sentence plays once, nothing is replayed
// ---------------------------------------------------------------------------

test('closing flush: the unterminated tail is spoken exactly once and nothing repeats', async (t) => {
  const fx = speakerFixture();
  t.after(() => fx.speaker.cancel('test-teardown'));
  fx.speaker.push('第一句话。第二句话');
  await tick();
  assert.deepEqual(fx.synth.map((entry) => entry.text), ['第一句话。'], 'tail is held while unterminated');

  const finished = fx.speaker.finish({ fullText: '第一句话。第二句话' });
  await tick();
  assert.deepEqual(
    fx.synth.map((entry) => entry.text),
    ['第一句话。', '第二句话'],
    'the closing flush queues the tail once',
  );
  await playAll(fx.plays);
  const stats = await finished;
  assert.deepEqual(fx.plays.map((entry) => entry.text), ['第一句话。', '第二句话']);
  const counts = new Map();
  for (const entry of fx.plays) counts.set(entry.text, (counts.get(entry.text) ?? 0) + 1);
  for (const [text, count] of counts) assert.equal(count, 1, `"${text}" played once`);
  assert.equal(stats.played, 2);
  assert.equal(stats.fallback, false);
  assert.equal(stats.error, '');
});

test('closing flush: a repeated push of the same body cannot duplicate the last sentence', async (t) => {
  const agent = fakeCtx();
  const fx = speakerFixture();
  const emit = feed(agent);
  const wait = awaitSessionResult({
    ctx: agent.ctx,
    sessionId: SESSION_ID,
    baselineSeq: 0,
    timeoutMs: 5_000,
    onAssistantText: (info) => fx.speaker.push(info.delta),
  });
  t.after(() => {
    fx.speaker.cancel('test-teardown');
    wait.cancel();
  });
  emit({ type: 'turn/start', data: { turn: 2 } });
  const message = { turn: 2, step: 0, message: { content: [{ type: 'text', text: '只有这一句。' }] } };
  emit({ type: 'assistant/message', data: message });
  // A duplicated committed event (replay at the same seq) must not produce a second delta.
  agent.emit(session(), { type: 'assistant/message', seq: 2, data: message });
  await tick();
  emit({ type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } });
  const result = await wait;
  const finished = fx.speaker.finish({ fullText: result.text });
  await playAll(fx.plays);
  const stats = await finished;
  assert.deepEqual(fx.plays.map((entry) => entry.text), ['只有这一句。']);
  assert.equal(stats.played, 1);
});

// ---------------------------------------------------------------------------
// F) fallback: a failed split path still speaks the whole answer
// ---------------------------------------------------------------------------

test('fallback: a split failure falls back to the whole reply instead of dropping it', async (t) => {
  const spoken = [];
  const fx = speakerFixture({
    split: () => { throw new Error('split failed'); },
    speakWhole: async (text) => {
      spoken.push(text);
      return { audioStartedAt: 42 };
    },
  });
  t.after(() => fx.speaker.cancel('test-teardown'));
  fx.speaker.push('完整回答。');
  const stats = await fx.speaker.finish({ fullText: '完整回答。第二句。' });
  assert.deepEqual(spoken, ['完整回答。第二句。'], 'the whole answer is spoken, not dropped');
  assert.equal(stats.fallback, true);
  assert.equal(stats.played, 0);
  assert.match(stats.error, /split failed/u);
  assert.equal(stats.firstPlayStartedAt, 42);
  assert.deepEqual(fx.synth, []);
  assert.deepEqual(fx.plays, []);
});

test('fallback: a synthesis failure before any playback speaks the whole reply', async (t) => {
  const spoken = [];
  let calls = 0;
  const speaker = createReplySpeaker({
    now: () => 0,
    startedAt: 0,
    synthesize: async () => {
      calls += 1;
      throw new Error('tts down');
    },
    play: async () => assert.fail('nothing may play after a synthesis failure'),
    speakWhole: async (text) => {
      spoken.push(text);
      return { audioStartedAt: 7 };
    },
  });
  t.after(() => speaker.cancel('test-teardown'));
  speaker.push('第一句。第二句。');
  await tick();
  const stats = await speaker.finish({ fullText: '第一句。第二句。' });
  assert.equal(calls, 1);
  assert.deepEqual(spoken, ['第一句。第二句。']);
  assert.equal(stats.fallback, true);
  assert.equal(stats.played, 0);
  assert.match(stats.error, /tts down/u);
});

test('fallback: after a sentence was played a late failure is reported, never replayed', async () => {
  let calls = 0;
  const spoken = [];
  const gates = [];
  const speaker = createReplySpeaker({
    now: () => 0,
    startedAt: 0,
    synthesize: async () => {
      calls += 1;
      if (calls === 2) throw new Error('second sentence failed');
      return { file: 'a.mp3', durationMs: 100 };
    },
    play: async () => {
      const gate = deferred();
      gates.push(gate);
      return { audioStartedAt: 1, done: gate.promise };
    },
    speakWhole: async (text) => { spoken.push(text); return { audioStartedAt: 5 }; },
  });
  speaker.push('第一句。第二句。');
  await tick();
  gates[0].resolve();
  const stats = await speaker.finish({ fullText: '第一句。第二句。' });
  assert.deepEqual(spoken, [], 'no replay from the top after the user already heard a sentence');
  assert.equal(stats.played, 1);
  assert.equal(stats.partial, true);
  assert.equal(stats.fallback, false);
  assert.match(stats.error, /second sentence failed/u);
});

// ---------------------------------------------------------------------------
// G) A: deeper prefetch (depth 2 by default) — synthesis runs ahead, playback stays serial
// ---------------------------------------------------------------------------

test('prefetch: during sentence 1, sentences 2 and 3 are already synthesizing (depth 2)', async (t) => {
  const fx = speakerFixture();
  t.after(() => fx.speaker.cancel('test-teardown'));
  const full = '第一句话。第二句话。第三句话。';
  fx.speaker.push(full);
  await until(() => fx.synth.length === 3);
  assert.deepEqual(fx.synth.map((entry) => entry.text), ['第一句话。', '第二句话。', '第三句话。'],
    'all three sentences have been synthesized while sentence 1 is still playing');
  assert.deepEqual(fx.plays.map((entry) => entry.text), ['第一句话。'],
    'prefetch only synthesizes: sentence 2 must not start playing yet');
  assert.ok(fx.events.some((event) => event.type === 'voice.prefetch' && event.depth === 2
    && event.prepared === 2 && event.maxAhead === 2), 'voice.prefetch reports depth/prepared/maxAhead');

  const finished = fx.speaker.finish({ fullText: full });
  await playAll(fx.plays);
  const stats = await finished;
  assert.deepEqual(fx.plays.map((entry) => entry.text), ['第一句话。', '第二句话。', '第三句话。'],
    'playback order stays strictly 1 -> 2 -> 3');
  assert.equal(stats.played, 3);
  assert.equal(stats.sentences, 3);
});

test('prefetch: depth 2 never runs more than two synthesizers at once for five sentences', async (t) => {
  const gates = [];
  const plays = [];
  const events = [];
  let active = 0;
  let peak = 0;
  const speaker = createReplySpeaker({
    now: () => 0,
    startedAt: 0,
    prefetchDepth: 2,
    onEvent: (event) => events.push(event),
    synthesize: async ({ text }) => {
      active += 1;
      peak = Math.max(peak, active);
      const gate = deferred();
      gates.push(gate);
      try {
        await gate.promise;
      } finally {
        active -= 1;
      }
      return { file: `${text}.mp3`, bytes: 4, durationMs: 100 };
    },
    play: async ({ text }) => {
      const gate = deferred();
      const entry = { text, gate, done: false };
      plays.push(entry);
      return { audioStartedAt: 1, done: gate.promise.then(() => { entry.done = true; }) };
    },
  });
  t.after(() => speaker.cancel('test-teardown'));
  const full = '一。二。三。四。五。';
  speaker.push(full);
  await until(() => gates.length === 1);
  assert.equal(peak, 1, 'the first sentence synthesizes alone');
  gates[0].resolve();
  await until(() => gates.length === 3);
  assert.equal(peak, 2, 'two prefetched sentences synthesize at the same time');
  assert.equal(plays.length, 1, 'nothing else plays while sentence 1 plays');

  const finished = speaker.finish({ fullText: full });
  for (let i = 0; i < 200; i += 1) {
    for (const gate of gates) gate.resolve();
    for (const entry of plays) entry.gate.resolve();
    if (speaker.stats.played === 5 && plays.every((entry) => entry.done)) break;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  const stats = await finished;
  assert.ok(peak <= 2, `at most two synthesizers were ever running (peak ${peak})`);
  assert.equal(peak, 2, 'the prefetch window really was filled');
  assert.deepEqual(plays.map((entry) => entry.text), ['一。', '二。', '三。', '四。', '五。'],
    'serial playback order is preserved');
  assert.equal(stats.played, 5);
  // `onEvent` is the speaker's diagnostic stream and now also carries lifecycle rows
  // (`voice.speech.lifecycle`). This test owns the prefetch contract, so select those rows; every
  // other row must still be the known lifecycle diagnostic, never a malformed prefetch event.
  const prefetchEvents = events.filter((event) => event.type === 'voice.prefetch');
  assert.ok(prefetchEvents.length > 0, 'voice.prefetch was emitted');
  for (const event of prefetchEvents) {
    assert.equal(event.depth, 2);
    assert.ok(event.prepared <= 2, `prepared stays within the window (${event.prepared})`);
    assert.ok(event.maxAhead <= 2, `maxAhead stays within the window (${event.maxAhead})`);
  }
  const otherEvents = events.filter((event) => event.type !== 'voice.prefetch');
  assert.ok(otherEvents.every((event) => event.type === 'voice.speech.lifecycle'),
    'the only non-prefetch rows on this stream are lifecycle diagnostics');
  assert.equal(Math.max(...prefetchEvents.map((event) => event.maxAhead)), 2);
});

test('prefetch: the first sentence still starts synthesizing at the queue instant', async (t) => {
  const clock = { t: 0 };
  const synthAt = [];
  const speaker = createReplySpeaker({
    now: () => clock.t,
    startedAt: 0,
    prefetchDepth: 2,
    synthesize: async ({ text }) => {
      synthAt.push({ text, at: clock.t });
      return { file: `${text}.mp3`, bytes: 4, durationMs: 100 };
    },
    play: async () => ({ audioStartedAt: clock.t, done: Promise.resolve() }),
  });
  t.after(() => speaker.cancel('test-teardown'));
  clock.t = 500;
  speaker.push('第一句话。');
  await tick();
  assert.deepEqual(synthAt, [{ text: '第一句话。', at: 500 }],
    'synthesis starts at the arrival instant, before any prefetch slot exists');
  const stats = await speaker.finish({ fullText: '第一句话。' });
  assert.equal(stats.firstQueuedAt, 500);
  assert.equal(stats.firstSynthStartedAt, 500);
  assert.equal(stats.firstSynthWaitMs, 0, 'queue -> synthesis start adds no latency');
});

test('prefetch: cancelling discards and deletes every unplayed prefetched clip', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-prefetch-cancel-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const synth = [];
  const plays = [];
  const speaker = createReplySpeaker({
    now: () => 0,
    startedAt: 0,
    prefetchDepth: 2,
    synthesize: async ({ text }) => {
      const file = join(dir, `${synth.length + 1}.mp3`);
      await writeFile(file, 'fake audio');
      synth.push({ text, file });
      return { file, bytes: 10, durationMs: 1000 };
    },
    play: async ({ text }) => {
      const gate = deferred();
      const entry = { text, gate, done: false };
      plays.push(entry);
      return { audioStartedAt: 1, done: gate.promise.then(() => { entry.done = true; }) };
    },
  });
  t.after(() => speaker.cancel('test-teardown'));
  const full = '第一句话。第二句话。第三句话。';
  speaker.push(full);
  await until(() => synth.length === 3);
  assert.deepEqual(plays.map((entry) => entry.text), ['第一句话。'], 'sentence 1 is playing');
  assert.equal(speaker.cancel('barge-in'), true);

  plays[0].gate.resolve();
  const stats = await speaker.finish({ fullText: full });
  assert.equal(stats.cancelled, true);
  assert.equal(stats.played, 1, 'only the clip that reached the player counts');
  assert.deepEqual(plays.map((entry) => entry.text), ['第一句话。'], 'later sentences never play');
  assert.deepEqual(await readdir(dir), ['1.mp3'],
    'the two prefetched clips were deleted; the delivered clip is left to its owner');
});

