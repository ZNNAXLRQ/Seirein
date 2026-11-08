/**
 * P2: a cancelled reply speaker must stop leaking its unplayed prefetched audio.
 *
 * The old `discardAhead()` ran every prefetch through `abortable(task)`: once the lane aborted,
 * that rejected at once, so an already-completed prefetch was never awaited and its file stayed on
 * disk. `finish()` must still return promptly — so the fix cannot wait for a synthesizer; instead
 * each prefetch slot keeps its own delete-on-settle responsibility, including a late result that
 * arrives after `finish()`.
 *
 * Covered:
 *   1. three prefetched sentences, cancel during clip 1: clips 2 and 3 are deleted, clip 1 stays
 *   2. clip 2 is still synthesizing at cancel and returns 200 ms later: its file is deleted
 *   3. a normally finished reply keeps every played file (played audio is never cleanup)
 *   3b. an adopted prefetch that already reached the player is kept; only later spills are deleted
 *   4. a failed unlink is only a `level: 'debug'` row and never fails finish()
 *
 * Run: node --test test/reply-speaker-cleanup.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
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

const exists = (file) => access(file).then(() => true, () => false);

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'seirein-reply-cleanup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const playing = (events) => events.some(
  (event) => event.type === SPEECH_LIFECYCLE_EVENT && event.state === 'playing',
);

/** The real single-clip driver, with a player whose `done` the test controls. */
function speakerFixture({ events, synthesize }) {
  const plays = [];
  const speaker = createReplySpeaker({
    startedAt: Date.now(),
    onEvent: (event) => events.push(event),
    synthesize,
    play: async () => {
      const gate = deferred();
      plays.push(gate);
      return { audioStartedAt: Date.now(), done: gate.promise };
    },
  });
  return { speaker, plays };
}

// ---------------------------------------------------------------------------
// 1. Cancel during the first clip: completed prefetches must be deleted
// ---------------------------------------------------------------------------

test('1. cancelling during clip 1 deletes every completed, unplayed prefetched file', async (t) => {
  const dir = await tempDir(t);
  const files = [];
  const events = [];
  const app = speakerFixture({
    events,
    synthesize: async ({ text, sentenceId }) => {
      const file = join(dir, `${sentenceId}.mp3`);
      await writeFile(file, text);
      files.push(file);
      return { file, bytes: 8, durationMs: 60_000, provider: 'fake' };
    },
  });
  const text = '第一句。第二句。第三句。';
  app.speaker.push(text);
  const finishing = app.speaker.finish({ fullText: text });

  await waitUntil(() => files.length === 3, 'all three sentences were synthesized');
  await waitUntil(() => playing(events), 'clip 1 reached the player');
  // Let the two already-completed prefetch tasks settle into their slots before the cancel.
  await tick(20);

  const cancelledAt = Date.now();
  assert.equal(app.speaker.cancel('barge-in'), true);
  const stats = await finishing;
  const elapsed = Date.now() - cancelledAt;

  assert.equal(stats.cancelled, true);
  assert.ok(elapsed < 1_000, `finish() released promptly (${elapsed}ms)`);
  const remaining = (await readdir(dir)).sort();
  assert.deepEqual(
    remaining,
    ['0.mp3'],
    'only the clip that reached the player keeps its file; both prefetches are deleted',
  );
  const prefetchResidual = remaining.filter((name) => name !== '0.mp3').length;
  assert.equal(prefetchResidual, 0, 'no unplayed prefetched file survives finish()');
  t.diagnostic(`prefetched=2 prefetchResidual=${prefetchResidual} remaining=${remaining.join(',')} finishMs=${elapsed}`);
});

// ---------------------------------------------------------------------------
// 2. Late synthesis: the result lands after finish() and is still deleted
// ---------------------------------------------------------------------------

test('2. a prefetch that returns 200 ms after cancel is deleted when it arrives', async (t) => {
  const dir = await tempDir(t);
  const files = [0, 1, 2].map((index) => join(dir, `${index}.mp3`));
  await writeFile(files[0], 'first');
  await writeFile(files[1], 'second');
  await writeFile(files[2], 'third');
  const late = deferred();
  const events = [];
  const calls = [];
  const app = speakerFixture({
    events,
    synthesize: async ({ sentenceId }) => {
      calls.push(sentenceId);
      if (sentenceId === 1) return late.promise; // still synthesizing when cancel happens
      return { file: files[sentenceId], bytes: 8, durationMs: 60_000, provider: 'fake' };
    },
  });
  const text = '第一句。第二句。第三句。';
  app.speaker.push(text);
  const finishing = app.speaker.finish({ fullText: text });

  await waitUntil(() => playing(events), 'clip 1 reached the player');
  await waitUntil(() => calls.includes(1), 'sentence 2 synthesis started');
  await tick(20);

  app.speaker.cancel('barge-in');
  // A watchdog proves finish() did not wait for the late synthesis (it is still gated).
  const watchdog = deferred();
  const timer = setTimeout(() => watchdog.reject(new Error('finish() waited for a late synthesis')), 500);
  const stats = await Promise.race([finishing, watchdog.promise]);
  clearTimeout(timer);
  assert.equal(stats.cancelled, true, 'the cancel was reported, not a synthesized answer');
  await waitUntil(async () => !(await exists(files[2])), 'the ready prefetch was deleted');
  assert.equal(await exists(files[1]), true, 'the late clip is still owned by its synthesizer');

  // Requirement: the synthesizer returns 200 ms after the cancel.
  await tick(200);
  late.resolve({ file: files[1], bytes: 8, durationMs: 60_000, provider: 'fake' });
  await waitUntil(async () => !(await exists(files[1])), 'the late prefetched file was deleted');
  assert.equal(await exists(files[0]), true, 'the playing clip keeps its file');
  t.diagnostic('lateMs=200 lateDeleted=true residual=0');
});

// ---------------------------------------------------------------------------
// 3. Normal completion: played audio is never deleted by prefetch cleanup
// ---------------------------------------------------------------------------

test('3. a normally finished reply keeps every played file', async (t) => {
  const dir = await tempDir(t);
  const events = [];
  const app = createReplySpeaker({
    startedAt: Date.now(),
    onEvent: (event) => events.push(event),
    synthesize: async ({ text, sentenceId }) => {
      const file = join(dir, `${sentenceId}.mp3`);
      await writeFile(file, text);
      return { file, bytes: 8, durationMs: 10, provider: 'fake' };
    },
    play: async () => ({ audioStartedAt: Date.now(), done: Promise.resolve() }),
  });
  const text = '第一句。第二句。第三句。';
  app.push(text);
  const stats = await app.finish({ fullText: text });

  assert.equal(stats.played, 3);
  const remaining = (await readdir(dir)).sort();
  assert.deepEqual(remaining, ['0.mp3', '1.mp3', '2.mp3'], 'all played clips keep their files');
  t.diagnostic(`played=${stats.played} remaining=${remaining.length}`);
});

// ---------------------------------------------------------------------------
// 3b. Cancel while an adopted prefetch plays: that file is played audio, not a spill
// ---------------------------------------------------------------------------

test('3b. cancelling while an adopted prefetch plays keeps that clip and deletes only later ones', async (t) => {
  const dir = await tempDir(t);
  const files = [];
  const events = [];
  const app = speakerFixture({
    events,
    synthesize: async ({ text, sentenceId }) => {
      const file = join(dir, `${sentenceId}.mp3`);
      await writeFile(file, text);
      files.push(file);
      return { file, bytes: 8, durationMs: 60_000, provider: 'fake' };
    },
  });
  const text = '第一句。第二句。第三句。';
  app.speaker.push(text);
  const finishing = app.speaker.finish({ fullText: text });

  await waitUntil(() => app.plays.length === 1, 'clip 1 playing');
  app.plays[0].resolve(); // sentence 1 ends; sentence 2 (a prefetch) becomes current
  await waitUntil(() => app.plays.length === 2, 'the adopted prefetch reached the player');
  // Let the play seam's `onStart` commit `played` before the cancel (the second lifecycle row is
  // throttled, so the player call itself is the observable boundary).
  await tick(30);

  app.speaker.cancel('barge-in');
  const stats = await finishing;
  assert.equal(stats.cancelled, true);
  const remaining = (await readdir(dir)).sort();
  assert.deepEqual(remaining, ['0.mp3', '1.mp3'], 'played clips 1 and 2 stay; unplayed clip 3 is deleted');
  t.diagnostic(`remaining=${remaining.join(',')} deleted=2.mp3`);
});

// ---------------------------------------------------------------------------
// 4. Cleanup failure: one debug row, finish still resolves
// ---------------------------------------------------------------------------

test('4. a failing unlink only writes a debug row and never fails finish()', async (t) => {
  const dir = await tempDir(t);
  const playedFile = join(dir, '0.mp3');
  await writeFile(playedFile, 'first');
  const stuck = join(dir, '1.mp3');
  await mkdir(stuck); // rm(force) on a directory fails: the cleanup failure seam
  const events = [];
  const app = speakerFixture({
    events,
    synthesize: async ({ sentenceId }) => ({
      file: sentenceId === 0 ? playedFile : stuck,
      bytes: 8,
      durationMs: 60_000,
      provider: 'fake',
    }),
  });
  const text = '第一句。第二句。';
  app.speaker.push(text);
  const finishing = app.speaker.finish({ fullText: text });
  await waitUntil(() => playing(events), 'clip 1 reached the player');
  await waitUntil(() => events.some((event) => event.type === 'voice.prefetch'), 'the prefetch slot was filled');
  await tick(20);

  app.speaker.cancel('barge-in');
  const stats = await finishing;
  assert.equal(stats.cancelled, true, 'a cleanup failure cannot turn the cancel into a failure');
  const failures = events.filter((event) => event.type === 'voice.speech.cleanup.failed');
  assert.ok(failures.length >= 1, 'the failed unlink was reported');
  assert.equal(failures[0].level, 'debug', 'cleanup failures are debug rows');
  assert.equal(failures[0].file, stuck);
  t.diagnostic(`cleanupFailures=${failures.length} level=${failures[0].level}`);
});
