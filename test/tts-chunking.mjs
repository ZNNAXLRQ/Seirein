/**
 * P-65 (A7-B/C): comma-level chunking and sentence-internal streaming.
 *
 * The splitter is pure; the driver takes `synthesize`/`play` seams, so ordering, the one-block
 * lookahead, cancellation and file ownership are exact without a real TTS server or player.
 *
 * Covered:
 *   1. a long sentence with two commas becomes three ordered blocks; join === the original
 *   2. a comma inside brackets/quotes is never a block boundary
 *   3. a short sentence (or a short prefix before the comma) is not split; minChars is configurable
 *   4. the first block starts playing before whole-sentence synthesis would have finished
 *   5. blocks are played once, in order: played text join === the original sentence
 *   6. cancel stops the sounding block, starts nothing after it and removes an unplayed block file
 *   7. `chunking:false` synthesizes/plays the sentence as one clip (old path)
 *
 * Run: node --test test/tts-chunking.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_CHUNK_MIN_CHARS,
  resolveChunkMinChars,
  speakChunks,
  speechChunkTexts,
  splitSpeechChunks,
} from '../src/host/speech/tts.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
async function until(predicate) {
  for (let i = 0; i < 1000; i += 1) {
    if (predicate()) return;
    await sleep(2);
  }
  assert.fail('async boundary did not arrive');
}

const LONG = '今天上海的天气有点凉，出门记得带一件外套，晚上回来的时候可能会下雨。';

// ---------------------------------------------------------------------------
// 1. order and lossless join
// ---------------------------------------------------------------------------

test('1) a long sentence is cut at both commas into three ordered blocks', (t) => {
  const blocks = splitSpeechChunks(LONG);
  assert.equal(blocks.length, 3);
  assert.deepEqual(blocks, [
    '今天上海的天气有点凉，',
    '出门记得带一件外套，',
    '晚上回来的时候可能会下雨。',
  ]);
  assert.equal(blocks.join(''), LONG, 'joining the blocks returns the original sentence');
  // The pause that closed a block stays on that block: no character is dropped or duplicated.
  assert.ok(blocks[0].endsWith('，') && blocks[1].endsWith('，'));
  assert.ok(blocks[2].endsWith('。'));
  t.diagnostic(`blocks=${blocks.length} joinEqualsOriginal=${blocks.join('') === LONG} lengths=${blocks.map((block) => [...block].length).join(',')}`);
});

test('1b) the same holds for 、 and ； pauses', () => {
  const text = '先准备材料清单和工具、再整理房间的每个角落；最后把今天的记录写完。';
  const blocks = splitSpeechChunks(text);
  assert.equal(blocks.length, 3);
  assert.equal(blocks.join(''), text);
  assert.deepEqual(blocks.map((block) => block.at(-1)), ['、', '；', '。']);
});

// ---------------------------------------------------------------------------
// 2. no cut inside brackets or quotes
// ---------------------------------------------------------------------------

test('2) a comma inside brackets is not a boundary', () => {
  const text = '这是一段很长的话（里面有逗号，还有顿号、分号），后面还有内容。';
  const blocks = splitSpeechChunks(text);
  assert.equal(blocks.length, 2, 'the inner pauses do not split');
  assert.equal(blocks.join(''), text);
  assert.ok(blocks[0].includes('（里面有逗号，还有顿号、分号）'), 'the bracket stays whole');
  assert.ok(blocks[0].endsWith('），'), 'the outside comma is the real boundary');
});

test('2b) a comma inside Chinese quotes is not a boundary', () => {
  const text = '她大声说“等一下，我还没准备好”，然后继续往前走。';
  const blocks = splitSpeechChunks(text);
  assert.equal(blocks.length, 2);
  assert.equal(blocks.join(''), text);
  assert.ok(blocks[0].includes('“等一下，我还没准备好”'), 'the quoted text stays whole');
});

// ---------------------------------------------------------------------------
// 3. short sentences / configurable minimum
// ---------------------------------------------------------------------------

test('3) a short sentence is never split; the minimum is configurable and clamped', () => {
  assert.deepEqual(splitSpeechChunks('好的，没问题。'), ['好的，没问题。']);
  assert.deepEqual(splitSpeechChunks('嗯。'), ['嗯。']);
  assert.deepEqual(splitSpeechChunks('   '), []);
  // The default only cuts once the pending block reached 8 characters.
  assert.equal(splitSpeechChunks(LONG).length, 3);
  assert.deepEqual(splitSpeechChunks('好的，没问题。', { minChars: 2 }), ['好的，', '没问题。']);
  // Invalid/clamped settings keep a usable minimum.
  assert.equal(resolveChunkMinChars(undefined), DEFAULT_CHUNK_MIN_CHARS);
  assert.equal(resolveChunkMinChars('not-a-number'), DEFAULT_CHUNK_MIN_CHARS);
  assert.equal(resolveChunkMinChars(1), 2);
  assert.equal(resolveChunkMinChars(999), 80);
  assert.deepEqual(speechChunkTexts(''), []);
});

// ---------------------------------------------------------------------------
// 4. first block starts before whole-sentence synthesis could finish
// ---------------------------------------------------------------------------

test('4) block 0 is audible before whole-sentence synthesis would have finished', async (t) => {
  const perCharMs = 4;
  const synthesizeFake = async ({ text }) => {
    await sleep(perCharMs * [...text].length);
    return { file: '', bytes: 4, durationMs: 100 };
  };
  // Baseline: how long the old one-clip path needs for this exact sentence.
  const wholeStartedAt = Date.now();
  await synthesizeFake({ text: LONG });
  const wholeSynthMs = Date.now() - wholeStartedAt;

  const startedAt = Date.now();
  const blocks = splitSpeechChunks(LONG);
  assert.equal(blocks.length, 3);
  const syntheses = [];
  const plays = [];
  const summary = await speakChunks({
    text: LONG,
    sentenceId: 7,
    synthesize: async ({ text, index }) => {
      const at = Date.now() - startedAt;
      syntheses.push({ index, at, doneAt: 0 });
      await sleep(perCharMs * [...text].length);
      syntheses.at(-1).doneAt = Date.now() - startedAt;
      return { file: '', bytes: 4, durationMs: 100 };
    },
    play: async ({ text, index }) => {
      plays.push({ index, at: Date.now() - startedAt, endedAt: 0 });
      const entry = plays.at(-1);
      const done = sleep(120).then(() => { entry.endedAt = Date.now() - startedAt; });
      return { audioStartedAt: Date.now(), done };
    },
  });
  const firstPlayMs = plays[0].at;
  assert.ok(
    firstPlayMs + 20 < wholeSynthMs,
    `block 0 started at ${firstPlayMs}ms, whole-sentence synthesis took ${wholeSynthMs}ms`,
  );
  // The second block was synthesized while the first one played, not after it ended.
  assert.equal(syntheses[1].index, 1);
  assert.ok(
    syntheses[1].doneAt < plays[0].endedAt,
    `block 1 synthesis finished at ${syntheses[1].doneAt}ms, block 0 ended at ${plays[0].endedAt}ms`,
  );
  assert.equal(summary.chunks, 3);
  assert.equal(summary.chunkIds.join(','), '7:0,7:1,7:2');
  assert.ok(summary.firstAudioAt >= startedAt, 'the report keeps a real transport clock');
  t.diagnostic(
    `wholeSynthMs=${wholeSynthMs} firstBlockPlayMs=${firstPlayMs} leadMs=${wholeSynthMs - firstPlayMs}`
    + ` block1SynthDoneMs=${syntheses[1].doneAt} block0EndMs=${plays[0].endedAt}`,
  );
});

// ---------------------------------------------------------------------------
// 5. no repeats, no swallowed text
// ---------------------------------------------------------------------------

test('5) every block plays once, in order, and the played text is the sentence', async (t) => {
  const plays = [];
  const summary = await speakChunks({
    text: LONG,
    sentenceId: 3,
    synthesize: async ({ text, index, chunkId }) => ({ file: `blk-${index}-${chunkId}.mp3`, bytes: 4, durationMs: 10 }),
    play: async ({ text, index, chunkId, count }) => {
      plays.push({ text, index, chunkId, count });
      return { audioStartedAt: Date.now(), done: Promise.resolve() };
    },
  });
  assert.equal(plays.length, 3);
  assert.deepEqual(plays.map((play) => play.index), [0, 1, 2]);
  assert.deepEqual(plays.map((play) => play.chunkId), ['3:0', '3:1', '3:2']);
  assert.ok(plays.every((play) => play.count === 3));
  assert.equal(plays.map((play) => play.text).join(''), LONG, 'played text concatenation === sentence');
  assert.equal(summary.playedText, LONG);
  assert.equal(summary.playedChunks, 3);
  assert.equal(new Set(summary.chunkIds).size, 3, 'block ids are unique per sentence');
  assert.equal(summary.skipped, 0);
  t.diagnostic(`playedBlocks=${plays.length} joinEqualsOriginal=${plays.map((play) => play.text).join('') === LONG} chunkIds=${summary.chunkIds.join(',')}`);
});

// ---------------------------------------------------------------------------
// 6. cancellation
// ---------------------------------------------------------------------------

test('6) cancel stops the sounding block, plays nothing after it and deletes an unplayed block', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tts-chunk-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const controller = new AbortController();
  const blocks = splitSpeechChunks(LONG);
  const plays = [];
  const synthesized = [];
  const pending = speakChunks({
    text: LONG,
    sentenceId: 9,
    signal: controller.signal,
    synthesize: async ({ text, index }) => {
      synthesized.push({ text, index });
      const file = join(dir, `block-${index}.mp3`);
      await writeFile(file, `fake audio ${index}`);
      return { file, bytes: 10, durationMs: 100 };
    },
    play: async ({ text, index, signal }) => {
      plays.push({ text, index });
      const done = new Promise((resolve, reject) => {
        if (signal.aborted) { reject(signal.reason); return; }
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      return { audioStartedAt: Date.now(), done };
    },
  });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await until(() => plays.length === 1);
  // The second block's synthesis is already in flight (lookahead), the third was never started.
  await until(() => synthesized.length >= 2);
  controller.abort(new DOMException('interrupted', 'AbortError'));
  await rejected;
  assert.equal(plays.length, 1, 'no block starts after the cancellation');
  assert.equal(plays[0].text, blocks[0]);
  assert.equal(synthesized.length, 2, 'block 2 was prefetched, block 3 was never synthesized');
  // The block that never reached the player is deleted; the played one stays with the player.
  const files = await readdir(dir);
  assert.deepEqual(files, ['block-0.mp3']);
  t.diagnostic(`playsAfterCancel=${plays.length} synthesized=${synthesized.length} remainingFiles=${files.join(',')}`);
});

// ---------------------------------------------------------------------------
// 7. switch off: one clip per sentence
// ---------------------------------------------------------------------------

test('7) chunking:false synthesizes and plays the sentence as one clip', async (t) => {
  const synthesized = [];
  const plays = [];
  const summary = await speakChunks({
    text: LONG,
    chunking: false,
    synthesize: async ({ text, index }) => {
      synthesized.push({ text, index });
      return { file: 'whole.mp3', bytes: 4, durationMs: 100 };
    },
    play: async ({ text, index, count }) => {
      plays.push({ text, index, count });
      return { audioStartedAt: Date.now(), done: Promise.resolve() };
    },
  });
  assert.deepEqual(speechChunkTexts(LONG, { chunking: false }), [LONG]);
  assert.deepEqual(synthesized, [{ text: LONG, index: 0 }], 'the whole sentence is synthesized once');
  assert.equal(plays.length, 1);
  assert.equal(plays[0].text, LONG);
  assert.equal(plays[0].count, 1);
  assert.equal(summary.chunks, 1);
  assert.equal(summary.playedText, LONG);
  t.diagnostic(`synthCalls=${synthesized.length} playCalls=${plays.length} expectedWholeSentence=${synthesized[0].text === LONG}`);
});
