/**
 * Cancel boundary of the block driver: `await started.done` must race the lane.
 *
 * A player/player-proxy can confirm its start and then never settle `done` (a killed process that
 * never emits `close`, a hung WPF fallback, a replaced player). Cancelling the lane must end that
 * wait at once instead of pinning the whole speech lane for minutes. Normal completion keeps the
 * old contract exactly, and a settlement that arrives after the cancellation is adopted nowhere:
 * it must not synthesize/cache another block, start another player, or emit an `end`.
 *
 * These tests inject the `synthesize` / `play` seams, so no TTS server, player or audio is used.
 *
 * Run: node --test test/tts-abort-start.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { speakChunks } from '../src/host/speech/tts.js';

const LONG = '今天上海的天气有点凉，出门记得带一件外套，晚上回来的时候可能会下雨。';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const now = () => performance.now();
async function until(predicate, what = 'async boundary') {
  for (let i = 0; i < 500; i += 1) {
    if (predicate()) return;
    await sleep(2);
  }
  assert.fail(`timed out: ${what}`);
}
const abortError = (message) => new DOMException(message, 'AbortError');
/** A seam result the driver can delete; `file` empty means "nothing to remove". */
const block = (index) => ({ file: '', bytes: 4, durationMs: 1000, index });

// ---------------------------------------------------------------------------
// 1. cancel while the player never settles its done
// ---------------------------------------------------------------------------

test('1. cancel ends a wait on a `done` that never settles (<100ms, TTS_ABORTED)', { timeout: 5000 }, async (t) => {
  const controller = new AbortController();
  const plays = [];
  let syntheses = 0;
  const pending = speakChunks({
    text: LONG,
    sentenceId: 1,
    signal: controller.signal,
    synthesize: async ({ index }) => { syntheses += 1; return block(index); },
    // The player confirmed its start; its `done` never settles. That is the defect: the driver
    // used to wait on this promise forever, so the cancel could not end the speech lane.
    play: async ({ index }) => {
      plays.push(index);
      return { audioStartedAt: now(), done: new Promise(() => {}) };
    },
  });
  const rejected = assert.rejects(pending, (error) => {
    assert.equal(error.name, 'AbortError');
    assert.equal(error.code, 'TTS_ABORTED', 'the cancel has an explicit code');
    return true;
  });
  await until(() => plays.length === 1, 'block 0 reaches the player');
  const abortAt = now();
  controller.abort(abortError('barge-in'));
  await rejected;
  const settleMs = now() - abortAt;

  assert.ok(settleMs < 100, `the driver settled ${settleMs.toFixed(1)}ms after the cancel`);
  assert.equal(plays.length, 1, 'no later block reached the player');
  assert.equal(syntheses, 2, 'only the lookahead block was prefetched');
  t.diagnostic(`neverSettlingDone: settled ${settleMs.toFixed(1)}ms after abort, code=TTS_ABORTED`
    + ` plays=${plays.length} syntheses=${syntheses}`);
});

// ---------------------------------------------------------------------------
// 2. normal completion is unchanged
// ---------------------------------------------------------------------------

test('2. a normal completion still waits for the player and reports the old summary', { timeout: 5000 }, async (t) => {
  const gate = deferred();
  const plays = [];
  const events = [];
  const startedAt = now();
  const pending = speakChunks({
    text: LONG,
    sentenceId: 2,
    onEvent: (event) => events.push(event),
    synthesize: async ({ index }) => block(index),
    play: async ({ index, text }) => {
      plays.push({ index, text });
      return { audioStartedAt: now(), done: index === 0 ? gate.promise : Promise.resolve() };
    },
  });
  await until(() => plays.length === 1, 'block 0 reaches the player');
  await sleep(30);
  assert.equal(plays.length, 1, 'block 1 cannot start before block 0 settles its done');

  gate.resolve();
  const summary = await pending;
  const elapsedMs = now() - startedAt;
  assert.deepEqual(plays.map((entry) => entry.index), [0, 1, 2]);
  assert.equal(summary.status, 'completed');
  assert.equal(summary.playedChunks, 3);
  assert.equal(summary.skipped, 0);
  assert.equal(summary.playedText, LONG);
  assert.equal(events.filter((event) => event.phase === 'end').length, 3);
  assert.equal(events.filter((event) => event.phase === 'cancel').length, 0);
  assert.ok(elapsedMs >= 25, 'the driver really waited for the deferred done');
  t.diagnostic(`normal: elapsed=${elapsedMs.toFixed(1)}ms status=${summary.status}`
    + ` playedChunks=${summary.playedChunks} plays=${plays.length} cancels=0`);
});

// ---------------------------------------------------------------------------
// 3. a late settlement after a cancel is inert
// ---------------------------------------------------------------------------

test('3. a late settle after cancel writes no cache, starts no player and revives nothing', { timeout: 5000 }, async (t) => {
  const controller = new AbortController();
  const late = deferred();
  const cache = new Map();
  const events = [];
  const plays = [];
  let syntheses = 0;
  const pending = speakChunks({
    text: LONG,
    sentenceId: 3,
    signal: controller.signal,
    onEvent: (event) => events.push(event),
    synthesize: async ({ index, chunkId }) => {
      syntheses += 1;
      // The seam's "cache write" happens when a block is produced; a revived driver would add one.
      cache.set(chunkId, { index });
      return block(index);
    },
    play: async ({ index }) => {
      plays.push(index);
      return { audioStartedAt: now(), done: index === 0 ? late.promise : Promise.resolve() };
    },
  });
  const rejected = assert.rejects(pending, (error) => error.code === 'TTS_ABORTED');
  await until(() => plays.length === 1, 'block 0 reaches the player');
  await until(() => syntheses >= 2, 'block 1 was prefetched during block 0');
  const cacheBefore = [...cache.keys()];
  const eventsBefore = events.length;

  controller.abort(abortError('barge-in'));
  await rejected;
  // The player settles LATE, long after the driver already returned this cancel.
  await sleep(20);
  late.resolve();
  await sleep(40);

  assert.deepEqual([...cache.keys()], cacheBefore, 'no block was synthesized or cached after the cancel');
  assert.equal(syntheses, cacheBefore.length, 'no synthesis happened after the cancel');
  assert.equal(plays.length, 1, 'no block was played after the cancel');
  assert.equal(events.filter((event) => event.phase === 'play').length, 1, 'nothing is replayed');
  assert.equal(events.filter((event) => event.phase === 'end').length, 0, 'the cancelled block never ends');
  assert.equal(events.filter((event) => event.phase === 'cancel').length, 1, 'exactly one cancel is reported');
  assert.equal(events.length, eventsBefore + 1, 'the late settle added no event');
  t.diagnostic(`lateSettle: cacheBlocks=${cacheBefore.length}->${cache.size} syntheses=${syntheses}`
    + ` plays=${plays.length} endRows=0 cancelRows=1`);
});

test('3b. a late REJECTION after cancel is consumed, never unhandled', { timeout: 5000 }, async (t) => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));

  const controller = new AbortController();
  const late = deferred();
  const pending = speakChunks({
    text: '只有这一块。',
    chunks: ['只有这一块。'],
    sentenceId: 3.5,
    signal: controller.signal,
    synthesize: async ({ index }) => block(index),
    play: async ({ index }) => {
      return { audioStartedAt: now(), done: index === 0 ? late.promise : Promise.resolve() };
    },
  });
  const rejected = assert.rejects(pending, (error) => error.code === 'TTS_ABORTED');
  await sleep(10);
  controller.abort(abortError('teardown'));
  await rejected;
  late.reject(new Error('player died after the cancel'));
  await sleep(40);

  assert.deepEqual(unhandled, [], 'the late rejection is handled inside the driver');
  t.diagnostic(`lateReject: unhandled=${unhandled.length}`);
});

// ---------------------------------------------------------------------------
// 4. an abort that lands between play() and the wait still settles at once
// ---------------------------------------------------------------------------

test('4. an abort delivered by play() itself is not missed', { timeout: 5000 }, async (t) => {
  const controller = new AbortController();
  const pending = speakChunks({
    text: '只有这一块。',
    chunks: ['只有这一块。'],
    sentenceId: 4,
    signal: controller.signal,
    synthesize: async ({ index }) => block(index),
    play: async ({ index }) => {
      // A replaced/unloaded lane can abort while play() is still returning: the wait must check
      // `lane.aborted` before attaching its listener, or the cancel would be missed.
      controller.abort(abortError('unload'));
      return { audioStartedAt: now(), done: new Promise(() => {}) };
    },
  });
  const rejected = assert.rejects(pending, (error) => {
    assert.equal(error.name, 'AbortError');
    assert.equal(error.code, 'TTS_ABORTED');
    return true;
  });
  const abortAt = now();
  await rejected;
  const settleMs = now() - abortAt;
  assert.ok(settleMs < 100, `settled ${settleMs.toFixed(1)}ms after the play-time abort`);
  t.diagnostic(`abortInsidePlay: settled ${settleMs.toFixed(1)}ms, code=TTS_ABORTED`);
});
