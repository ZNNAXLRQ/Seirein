/**
 * P2: cancel must be able to interrupt the whole-reply fallback.
 *
 * The fallback is entered BECAUSE a split/synthesis/play failure aborted the speaker's lane, so the
 * old `lane.aborted ? await fallback : await abortable(fallback)` had to wait for the fallback
 * directly — a user barge-in then left `finish()` (and the turn's closing) pinned on a fallback that
 * might never settle. The fix separates the two: an INTERNAL failure still awaits the fallback for
 * its real stats (A1), while an EXTERNAL cancel (user cancel, a newer reply, the caller's signal
 * aborting) races that wait and lets finish() return at once. A late fallback is then adopted: it
 * never revives the speaker, an unplayed clip is deleted, and it is counted only if it really played.
 *
 * Covered:
 *   1. internal failure -> fallback hangs -> user cancels: finish() returns < 1000 ms, inactive
 *   2. internal failure -> fallback completes: its real playback stats are recorded (A1)
 *   3. internal failure -> fallback lands 300 ms after the cancel: unplayed, deleted, no revival
 *   4. an external cancel BEFORE the fallback: the fallback is never entered
 *   5. the caller's signal aborting DURING the fallback: finish() returns at once
 *
 * Run: node --test test/reply-speaker-fallback-cancel.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import {
  SPEECH_LIFECYCLE_EVENT,
  createReplySpeaker,
} from '../src/host/speech/reply-speaker.js';

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  promise.catch(() => {});
  return { promise, resolve, reject };
};

const waitUntil = async (check, message, timeoutMs = 3000) => {
  const started = Date.now();
  for (;;) {
    if (await check()) return;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out: ${message}`);
    await tick(5);
  }
};

/** Reject if `promise` has not settled within `ms` (a stuck finish() is the P2 symptom). */
const within = (promise, ms, message) => {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
};

const exists = (file) => access(file).then(() => true, () => false);

const playing = (events) => events.filter(
  (event) => event.type === SPEECH_LIFECYCLE_EVENT && event.state === 'playing',
);

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'seirein-fallback-cancel-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** The failure that aborts the lane internally: a synthesis that throws before anything played. */
const failingSynthesize = async () => { throw new Error('tts down'); };

const failingPlay = async () => assert.fail('nothing may play after a synthesis failure');

// ---------------------------------------------------------------------------
// 1. Internal failure + hanging fallback + user cancel: finish() must return
// ---------------------------------------------------------------------------

test('1. a user cancel interrupts the hanging fallback and finish() returns under 1000 ms', async (t) => {
  const events = [];
  const fallbackGate = deferred();
  const wholeStarted = deferred();
  let wholeCalls = 0;
  const speaker = createReplySpeaker({
    startedAt: Date.now(),
    onEvent: (event) => events.push(event),
    synthesize: failingSynthesize,
    play: failingPlay,
    speakWhole: () => { wholeCalls += 1; wholeStarted.resolve(); return fallbackGate.promise; },
  });
  t.after(() => speaker.cancel('test-teardown'));

  speaker.push('第一句。第二句。');
  const finishing = speaker.finish({ fullText: '第一句。第二句。' });
  await wholeStarted.promise;
  assert.equal(wholeCalls, 1, 'the internal failure entered the whole-reply fallback');
  // The run (and its release) is already over; only the fallback is still pending. Exactly the P2
  // state: `isActive() === false`, but the old code kept awaiting the fallback inside finish().
  assert.equal(speaker.isActive(), false, 'the failed run released ownership while the fallback waits');

  const cancelledAt = Date.now();
  assert.equal(speaker.cancel('barge-in'), true);
  const stats = await within(finishing, 500, 'finish() waited for the hanging fallback');
  const elapsed = Date.now() - cancelledAt;

  assert.ok(elapsed < 1_000, `finish() returned promptly after the cancel (${elapsed}ms)`);
  assert.equal(stats.cancelled, true, 'a cancelled fallback is a cancellation, not a finished answer');
  assert.equal(stats.played, 0);
  assert.equal(stats.firstPlayStartedAt, 0);
  assert.match(stats.error, /tts down/u, 'the internal failure is still reported as the error');
  assert.equal(speaker.isActive(), false, 'the cancelled speaker never revives');
  assert.equal(playing(events).length, 0, 'no clip ever reached the player');
  t.diagnostic(`wholeCalls=${wholeCalls} finishMs=${elapsed} cancelled=${stats.cancelled} active=${speaker.isActive()}`);
});

// ---------------------------------------------------------------------------
// 2. Internal failure + normal fallback: A1 stats stay correct
// ---------------------------------------------------------------------------

test('2. a normally completing fallback is still awaited and its real stats are recorded', async (t) => {
  const events = [];
  const session = { owner: { speechId: 'speech-42' }, spawnAt: 1, playerReadyAt: 2, playerReadyMs: 1 };
  let wholeCalls = 0;
  const speaker = createReplySpeaker({
    startedAt: Date.now(),
    onEvent: (event) => events.push(event),
    synthesize: failingSynthesize,
    play: failingPlay,
    speakWhole: async () => {
      wholeCalls += 1;
      await tick(30); // the fallback takes real time: finish() must wait for it
      return { audioStartedAt: 4_242, session };
    },
  });
  t.after(() => speaker.cancel('test-teardown'));

  speaker.push('第一句。第二句。');
  const stats = await speaker.finish({ fullText: '第一句。第二句。' });

  assert.equal(wholeCalls, 1, 'the whole reply is spoken exactly once');
  assert.equal(stats.fallback, true);
  assert.equal(stats.cancelled, false, 'an internal failure is not a cancellation');
  assert.equal(stats.played, 0, 'the fallback is one clip, not a per-sentence play');
  assert.equal(stats.firstPlayStartedAt, 4_242, 'A1: the fallback start is recorded after it settles');
  assert.equal(stats.lastPlayStartedAt, 4_242, 'one clip is also the last start');
  assert.equal(stats.firstStartSession, session, 'the fallback session is readable at finish()');
  assert.match(stats.error, /tts down/u);
  t.diagnostic(`fallback=${stats.fallback} firstPlayStartedAt=${stats.firstPlayStartedAt} played=${stats.played} cancelled=${stats.cancelled}`);
});

// ---------------------------------------------------------------------------
// 3. Late fallback after a cancel: never plays, audio deleted, no revival
// ---------------------------------------------------------------------------

test('3. a fallback landing 300 ms after the cancel is unplayed, deleted and never revived', async (t) => {
  const dir = await tempDir(t);
  const lateFile = join(dir, 'fallback.mp3');
  const events = [];
  const fallbackGate = deferred();
  const wholeStarted = deferred();
  const speaker = createReplySpeaker({
    startedAt: Date.now(),
    onEvent: (event) => events.push(event),
    synthesize: failingSynthesize,
    play: failingPlay,
    speakWhole: () => { wholeStarted.resolve(); return fallbackGate.promise; },
  });
  t.after(() => speaker.cancel('test-teardown'));

  speaker.push('第一句。第二句。');
  const finishing = speaker.finish({ fullText: '第一句。第二句。' });
  await wholeStarted.promise;

  const cancelledAt = Date.now();
  speaker.cancel('barge-in');
  const stats = await within(finishing, 500, 'finish() waited for the hanging fallback');
  assert.ok(Date.now() - cancelledAt < 1_000, 'finish() returned promptly');
  assert.equal(stats.cancelled, true);

  // Requirement: the fallback settles 300 ms after the cancel, and it never reached the player.
  await writeFile(lateFile, 'late');
  await tick(300);
  assert.equal(await exists(lateFile), true, 'the late file is still owned by the fallback at this point');
  fallbackGate.resolve({ file: lateFile, audioStartedAt: 0, session: { owner: { speechId: 'late' } } });
  await waitUntil(async () => !(await exists(lateFile)), 'the unplayed late fallback audio was deleted');

  assert.equal(stats.firstPlayStartedAt, 0, 'an unplayed fallback is not counted');
  assert.equal(stats.lastPlayStartedAt, 0);
  assert.equal(stats.played, 0);
  assert.equal(stats.cancelled, true);
  assert.equal(speaker.isActive(), false, 'the cancelled speaker never revives');
  assert.equal(playing(events).length, 0, 'not one clip played, including the late fallback');
  t.diagnostic(`played=${stats.played} firstPlayStartedAt=${stats.firstPlayStartedAt} lateDeleted=true active=${speaker.isActive()}`);
});

// ---------------------------------------------------------------------------
// 4. External cancel before the fallback: it is never entered
// ---------------------------------------------------------------------------

test('4. an external cancel before the fallback stops it from ever being waited on', async (t) => {
  // (a) the caller's signal aborts after the internal failure but before finish().
  const external = new AbortController();
  const spokenA = [];
  const speakerA = createReplySpeaker({
    signal: external.signal,
    startedAt: Date.now(),
    synthesize: failingSynthesize,
    play: failingPlay,
    speakWhole: async (text) => { spokenA.push(text); return { audioStartedAt: 11 }; },
  });
  t.after(() => speakerA.cancel('test-teardown'));
  speakerA.push('第一句。');
  // The internal failure is what aborted `lane`; wait for it, then cancel from the outside.
  await waitUntil(() => speakerA.signal.aborted === true, 'the internal failure aborted the lane');
  external.abort();
  await tick(5);

  const startedA = Date.now();
  const statsA = await within(speakerA.finish({ fullText: '第一句。' }), 500, 'finish() waited on a signal-cancelled fallback');
  assert.ok(Date.now() - startedA < 1_000, 'finish() returned promptly');
  assert.deepEqual(spokenA, [], 'a cancelled turn never enters the fallback wait');
  assert.equal(statsA.fallback, false, 'no fallback was attempted');
  assert.equal(statsA.cancelled, true);
  assert.equal(speakerA.isActive(), false);

  // (b) `cancel()` arrives after the internal failure but before finish().
  const spokenB = [];
  const speakerB = createReplySpeaker({
    startedAt: Date.now(),
    synthesize: failingSynthesize,
    play: failingPlay,
    speakWhole: async (text) => { spokenB.push(text); return { audioStartedAt: 12 }; },
  });
  t.after(() => speakerB.cancel('test-teardown'));
  speakerB.push('第一句。');
  await waitUntil(() => speakerB.signal.aborted === true, 'the internal failure aborted the lane');
  assert.equal(speakerB.cancel('barge-in'), true);

  const startedB = Date.now();
  const statsB = await within(speakerB.finish({ fullText: '第一句。' }), 500, 'finish() waited on a cancelled fallback');
  assert.ok(Date.now() - startedB < 1_000, 'finish() returned promptly');
  assert.deepEqual(spokenB, [], 'an explicit cancel also never enters the fallback');
  assert.equal(statsB.cancelled, true);
  assert.equal(statsB.fallback, false);
  t.diagnostic(`signalAbort: spoken=${spokenA.length} cancelled=${statsA.cancelled} | cancel(): spoken=${spokenB.length} cancelled=${statsB.cancelled}`);
});

// ---------------------------------------------------------------------------
// 5. The caller's signal aborting DURING the fallback: finish() returns at once
// ---------------------------------------------------------------------------

test('5. a signal abort during the fallback also releases finish() at once', async (t) => {
  const external = new AbortController();
  const fallbackGate = deferred();
  const wholeStarted = deferred();
  let wholeCalls = 0;
  const speaker = createReplySpeaker({
    signal: external.signal,
    startedAt: Date.now(),
    synthesize: failingSynthesize,
    play: failingPlay,
    speakWhole: () => { wholeCalls += 1; wholeStarted.resolve(); return fallbackGate.promise; },
  });
  t.after(() => speaker.cancel('test-teardown'));

  speaker.push('第一句。');
  const finishing = speaker.finish({ fullText: '第一句。' });
  await wholeStarted.promise;
  assert.equal(wholeCalls, 1, 'the fallback was entered after the internal failure');

  const abortedAt = Date.now();
  external.abort();
  const stats = await within(finishing, 500, 'finish() waited for the fallback after the signal abort');
  const elapsed = Date.now() - abortedAt;

  assert.ok(elapsed < 1_000, `finish() returned promptly after the signal abort (${elapsed}ms)`);
  assert.equal(stats.cancelled, true, 'the signal abort is an external cancellation');
  assert.equal(stats.fallback, true, 'the fallback had already been entered before the abort');
  assert.equal(speaker.isActive(), false);
  t.diagnostic(`wholeCalls=${wholeCalls} finishMs=${elapsed} cancelled=${stats.cancelled} active=${speaker.isActive()}`);
});
