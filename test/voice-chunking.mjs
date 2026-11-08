/**
 * P-65 host wiring: one reply sentence spoken as comma-sized blocks.
 *
 * `createReplySpeaker` takes `synthesize`/`play` seams, so this suite proves the sentence-level
 * pipeline keeps working while the blocks stream inside one sentence: block 0 starts playing
 * while block 1 is still being synthesized, every `play` call still receives the whole sentence
 * (the caption stays one line), and a barge-in stops the sounding block without starting the rest.
 *
 * Run: node --test test/voice-chunking.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createReplySpeaker } from '../src/host/index.js';
import { speechChunkTexts } from '../src/host/speech/tts.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
async function until(predicate, what = 'async boundary') {
  for (let i = 0; i < 500; i += 1) {
    if (predicate()) return;
    await sleep(2);
  }
  assert.fail(`timed out: ${what}`);
}

const LONG = '今天上海的天气有点凉，出门记得带一件外套，晚上回来的时候可能会下雨。';

/**
 * A speaker whose synthesis and player are controlled. `synthesize` uses the real block splitter
 * (like the host seam) and returns the prefetch-style `chunkTexts` + `synthesizeChunk`; `play`
 * blocks on a gate so a test can decide when a block really ends.
 */
function fixture({ signal, chunking = true, minChars = 8 } = {}) {
  const synth = [];
  const plays = [];
  const speaker = createReplySpeaker({
    signal,
    now: () => Date.now(),
    startedAt: 0,
    prefetchDepth: 1,
    synthesize: async ({ text, sentenceId }) => {
      const blocks = speechChunkTexts(text, { chunking, minChars });
      const planned = blocks.length > 1 ? blocks : null;
      const audio = { file: `${sentenceId}-0.mp3`, bytes: 8, durationMs: 1000 };
      synth.push({ text: blocks[0] ?? text, sentenceId, index: 0 });
      if (planned === null) return { ...audio, chunkTexts: null, synthesizeChunk: null };
      return {
        ...audio,
        chunkTexts: planned,
        synthesizeChunk: async ({ text: blockText, chunkId }) => {
          synth.push({ text: blockText, chunkId });
          await sleep(10);
          return { file: `blk-${chunkId}.mp3`, bytes: 8, durationMs: 1000 };
        },
      };
    },
    play: async ({ text, chunkIndex = 0, chunkCount = 1, chunkId, signal: lane }) => {
      const gate = deferred();
      const entry = { text, chunkIndex, chunkCount, chunkId, gate, done: false };
      plays.push(entry);
      const onAbort = () => gate.resolve();
      lane?.addEventListener?.('abort', onAbort, { once: true });
      const done = gate.promise.then(() => {
        lane?.removeEventListener?.('abort', onAbort);
        entry.done = true;
        if (lane?.aborted) throw lane.reason ?? new DOMException('cancelled', 'AbortError');
      });
      return { audioStartedAt: Date.now(), done };
    },
  });
  return { speaker, synth, plays };
}

/** End every block as it starts sounding until the speaker itself settles. */
async function playAll(fx, finished) {
  let settled = false;
  finished.then(() => { settled = true; }, () => { settled = true; });
  for (let i = 0; i < 200 && !settled; i += 1) {
    const next = fx.plays.find((entry) => entry.done === false);
    if (next !== undefined) next.gate.resolve();
    await sleep(5);
  }
  assert.equal(settled, true, 'the speaker finished all blocks');
}

// ---------------------------------------------------------------------------
// 1. ordered blocks, one sentence caption, synthesis overlapping playback
// ---------------------------------------------------------------------------

test('A) a long sentence streams as ordered blocks while each play still gets the whole sentence', async (t) => {
  const fx = fixture();
  fx.speaker.push(LONG);
  const finished = fx.speaker.finish({ fullText: LONG });
  finished.catch(() => {});

  await until(() => fx.plays.length === 1, 'block 0 reaches the player');
  assert.equal(fx.plays[0].chunkIndex, 0);
  assert.equal(fx.plays[0].chunkCount, 3);
  assert.equal(fx.plays[0].text, LONG, 'the play seam receives the whole sentence (caption)');
  // Block 1 is synthesized while block 0 is still sounding: that is the sentence-internal stream.
  await until(() => fx.synth.length >= 2, 'block 1 synthesis starts during block 0 playback');
  assert.equal(fx.plays[0].done, false, 'block 1 is not played before block 0 ends');
  assert.equal(fx.plays.length, 1);

  await playAll(fx, finished);
  const stats = await finished;
  assert.deepEqual(fx.plays.map((entry) => entry.chunkIndex), [0, 1, 2]);
  assert.ok(fx.plays.every((entry) => entry.text === LONG), 'every block keeps the whole-sentence caption');
  assert.ok(
    fx.plays.every((entry) => typeof entry.chunkId === 'string' && entry.chunkId.startsWith('0:')),
    'block ids carry the sentence id and the block index',
  );
  assert.equal(fx.synth.map((entry) => entry.text).join(''), LONG, 'blocks concatenate to the sentence');
  assert.equal(stats.played, 1, 'one sentence played although it had three blocks');
  assert.equal(stats.sentences, 1);
  assert.equal(stats.cancelled, false);
  assert.equal(stats.fallback, false);
  t.diagnostic(
    `blocks=${fx.plays.length} statsPlayed=${stats.played} captionWholeSentence=${fx.plays.every((entry) => entry.text === LONG)}`
    + ` joinEqualsOriginal=${fx.synth.map((entry) => entry.text).join('') === LONG}`,
  );
});

// ---------------------------------------------------------------------------
// 2. cancel inside the first block
// ---------------------------------------------------------------------------

test('B) a barge-in stops the sounding block and never starts the queued blocks', async () => {
  const controller = new AbortController();
  const fx = fixture({ signal: controller.signal });
  fx.speaker.push(LONG);
  const finished = fx.speaker.finish({ fullText: LONG });
  finished.catch(() => {});
  await until(() => fx.plays.length === 1, 'block 0 reaches the player');
  await until(() => fx.synth.length >= 2, 'block 1 is prefetched');

  controller.abort(new DOMException('barge-in', 'AbortError'));
  const stats = await finished;
  assert.equal(stats.cancelled, true);
  assert.equal(fx.plays.length, 1, 'block 1 never reaches the player');
  assert.equal(fx.plays[0].chunkIndex, 0);
  assert.equal(stats.played, 1, 'the block that reached the player counts as heard once, even when stopped');
});

// ---------------------------------------------------------------------------
// 3. switch off: one clip per sentence (old path)
// ---------------------------------------------------------------------------

test('C) chunking off speaks the sentence as one clip and one caption', async () => {
  const fx = fixture({ chunking: false });
  fx.speaker.push(LONG);
  const finished = fx.speaker.finish({ fullText: LONG });
  finished.catch(() => {});
  await until(() => fx.plays.length === 1, 'the single clip reaches the player');
  assert.equal(fx.plays[0].chunkIndex, 0);
  assert.equal(fx.plays[0].chunkCount, 1);
  assert.equal(fx.plays[0].text, LONG);
  assert.equal(fx.synth.length, 1, 'the whole sentence is synthesized once');
  assert.equal(fx.synth[0].text, LONG);
  fx.plays[0].gate.resolve();
  const stats = await finished;
  assert.equal(stats.played, 1);
  assert.equal(fx.plays.length, 1);
});
