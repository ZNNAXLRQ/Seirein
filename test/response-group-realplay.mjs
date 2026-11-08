/**
 * C: real-playback lifecycle of one reply speaker.
 *
 * These tests use the real `createReplySpeaker` and the real chunk driver (`tts.js` `speakChunks`),
 * with only the synthesis and player seams faked. That driver waits for a clip's `done` promise, so
 * a player that never settles after a cancel/replace is exactly the long-lived "still playing"
 * state this file guards: the speaker must release its active ownership anyway, and a superseded
 * version must never look active beside its replacement.
 *
 * Covered:
 *   1. a completed clip reports queued -> synthesizing -> playing -> finished -> released and
 *      `isActive()` becomes false at finish
 *   2. a cancelled clip releases even though its player never ends (the long-play leak)
 *   3. a replaced version is immediately inactive and a late end cannot restart it; the newer
 *      version stays active until its own end
 *   4. B: a carried plan (old points already organized into the new answer) is played as ONE speech,
 *      every sentence exactly once — the player never learns about the carry
 *
 * Run: node --test test/response-group-realplay.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SPEECH_LIFECYCLE_EVENT,
  createReplySpeaker,
} from '../src/host/speech/reply-speaker.js';

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

const waitUntil = async (check, message, timeoutMs = 3000) => {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out: ${message}`);
    await tick(5);
  }
};

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  promise.catch(() => {});
  return { promise, resolve, reject };
};

/**
 * One speaker over the real chunk driver. `play` returns a session whose `done` is a deferred the
 * test controls, which is the only seam needed to simulate a long/never-settling player.
 */
function makeSpeaker({ events = [], ledgerSpeechId = 'speech-test-1', startedAt = Date.now() - 5_000 } = {}) {
  const state = { plays: [], synthesized: [] };
  const speaker = createReplySpeaker({
    startedAt,
    onEvent: (event) => events.push(event),
    synthesize: async ({ text }) => {
      state.synthesized.push(text);
      return {
        file: join(tmpdir(), 'dsh-response-group-realplay', `${state.synthesized.length}.mp3`),
        bytes: 16,
        durationMs: 60_000,
        provider: 'fake',
      };
    },
    play: async ({ text, chunkIndex = 0, chunkCount = 1 }) => {
      const gate = deferred();
      state.plays.push({ text, chunkIndex, chunkCount, gate });
      return {
        audioStartedAt: Date.now(),
        done: gate.promise,
        session: { owner: { speechId: ledgerSpeechId } },
      };
    },
  });
  return { speaker, state, events };
}

const lifecycleRows = (events) => events.filter((event) => event.type === SPEECH_LIFECYCLE_EVENT);

// ---------------------------------------------------------------------------
// 1. Finished clip: full lifecycle and released active ownership
// ---------------------------------------------------------------------------

test('1. a finished clip reports every lifecycle phase and releases active ownership', async (t) => {
  const events = [];
  const app = makeSpeaker({ events });
  app.speaker.push('这是要播放的第一句。');
  const finishing = app.speaker.finish({ fullText: '这是要播放的第一句。' });

  await waitUntil(() => app.state.plays.length === 1, 'the clip reached the player');
  assert.equal(app.speaker.isActive(), true, 'the speaker is active while its clip plays');
  app.state.plays[0].gate.resolve();

  const stats = await finishing;
  assert.equal(stats.played, 1);
  assert.equal(stats.cancelled, false);
  assert.equal(app.speaker.isActive(), false, 'finish() released the active ownership');

  const rows = lifecycleRows(events);
  const states = rows.map((row) => row.state);
  for (const state of ['queued', 'synthesizing', 'playing', 'finished', 'released']) {
    assert.ok(states.includes(state), `lifecycle reported ${state} (${states.join(' -> ')})`);
  }
  assert.equal(states.at(-1), 'released', 'the last lifecycle row is the release');
  for (const row of rows) {
    assert.equal(typeof row.speechId, 'string');
    assert.ok(row.speechId.length > 0, 'every lifecycle row carries a speechId');
    assert.equal(typeof row.ageMs, 'number');
    assert.ok(row.ageMs >= 0, `ageMs is not negative (${row.ageMs})`);
    assert.equal(typeof row.reason, 'string');
  }
  const playing = rows.find((row) => row.state === 'playing');
  assert.equal(playing.speechId, 'speech-test-1', 'the ledger speech id joins the playback phase');
  t.diagnostic(
    `states=${states.join('->')} speechId=${playing.speechId} ageMs=${rows.at(-1).ageMs} `
    + `active=${app.speaker.isActive()}`,
  );
});

// ---------------------------------------------------------------------------
// 2. Cancelled clip: release even when the player's done never settles
// ---------------------------------------------------------------------------

test('2. a cancelled clip releases promptly even when its player never ends', async (t) => {
  const events = [];
  const app = makeSpeaker({ events, ledgerSpeechId: 'speech-cancel-1' });
  app.speaker.push('会一直播放、播放器不结束的这一句。');
  const finishing = app.speaker.finish({ fullText: '会一直播放、播放器不结束的这一句。' });

  await waitUntil(() => app.state.plays.length === 1, 'the long clip reached the player');
  assert.equal(app.speaker.isActive(), true);
  const cancelledAt = Date.now();
  assert.equal(app.speaker.cancel('replaced'), true);
  assert.equal(app.speaker.isActive(), false, 'a cancelled version is inactive immediately');

  // The player's `done` is deliberately never resolved: finish() must still return.
  const stats = await finishing;
  assert.equal(stats.cancelled, true);
  assert.ok(Date.now() - cancelledAt < 1_000, 'finish() was released without waiting for the player');

  const rows = lifecycleRows(events);
  const states = rows.map((row) => row.state);
  assert.ok(states.includes('cancelled'), `cancel was reported (${states.join(' -> ')})`);
  assert.equal(states.at(-1), 'released');
  const cancelledRow = rows.find((row) => row.state === 'cancelled');
  assert.equal(cancelledRow.reason, 'replaced');

  // A late end of the old player cannot start anything or revive the speaker.
  app.state.plays[0].gate.resolve();
  await tick(30);
  assert.equal(app.state.plays.length, 1, 'no clip was replayed after the late end');
  assert.equal(app.speaker.isActive(), false);
  t.diagnostic(
    `reason=${cancelledRow.reason} finishMs=${Date.now() - cancelledAt} states=${states.join('->')} `
    + `playerNeverEnded=released`,
  );
});

// ---------------------------------------------------------------------------
// 3. Replaced version: inactive beside its replacement, late end is inert
// ---------------------------------------------------------------------------

test('3. a replaced version does not stay active and cannot restart on a late end', async (t) => {
  const oldEvents = [];
  const newEvents = [];
  const oldApp = makeSpeaker({ events: oldEvents, ledgerSpeechId: 'speech-old' });
  const newApp = makeSpeaker({ events: newEvents, ledgerSpeechId: 'speech-new' });

  oldApp.speaker.push('旧版本的第一句。');
  const oldFinishing = oldApp.speaker.finish({ fullText: '旧版本的第一句。' });
  await waitUntil(() => oldApp.state.plays.length === 1, 'the old version started playing');

  newApp.speaker.push('新版本的第一句。');
  const newFinishing = newApp.speaker.finish({ fullText: '新版本的第一句。' });
  await waitUntil(() => newApp.state.plays.length === 1, 'the new version started playing');
  assert.equal(oldApp.speaker.isActive(), true);
  assert.equal(newApp.speaker.isActive(), true);

  // New answer version takes over: the old speaker is cancelled but its player is still open.
  oldApp.speaker.cancel('superseded');
  assert.equal(oldApp.speaker.isActive(), false, 'the replaced version no longer owns playback');
  await oldFinishing;

  oldApp.state.plays[0].gate.resolve();
  await tick(30);
  assert.equal(oldApp.state.plays.length, 1, 'the replaced version never starts a second clip');
  assert.equal(oldApp.speaker.isActive(), false);
  assert.equal(newApp.speaker.isActive(), true, 'the replacement keeps its own active state');

  newApp.state.plays[0].gate.resolve();
  const newStats = await newFinishing;
  assert.equal(newStats.played, 1);
  assert.equal(newApp.speaker.isActive(), false, 'the replacement releases at its own end');

  const oldStates = lifecycleRows(oldEvents).map((row) => row.state);
  const newStates = lifecycleRows(newEvents).map((row) => row.state);
  assert.ok(oldStates.includes('cancelled'));
  assert.equal(oldStates.at(-1), 'released');
  assert.ok(newStates.includes('finished'));
  assert.equal(newStates.at(-1), 'released');
  t.diagnostic(
    `old=${oldStates.join('->')} new=${newStates.join('->')} oldActive=false newActiveAtEnd=false`,
  );
});

// ---------------------------------------------------------------------------
// 4. A carried plan is one speech: every organized sentence plays once
// ---------------------------------------------------------------------------

test('4. a carried plan is played as one speech, every sentence exactly once', async (t) => {
  const events = [];
  const app = makeSpeaker({ events, ledgerSpeechId: 'speech-carry' });
  // The host's organizer produced ONE text that already contains the old points and the new answer.
  const merged = '先补上上次没说完的：窗口采集要选中目标窗口。改成游戏采集就能看到画面。';
  app.speaker.push(merged);
  const finishing = app.speaker.finish({ fullText: merged });

  await waitUntil(() => app.state.plays.length === 1, 'the first sentence reached the player');
  app.state.plays[0].gate.resolve();
  await waitUntil(() => app.state.plays.length === 2, 'the second sentence reached the player');
  app.state.plays[1].gate.resolve();

  const stats = await finishing;
  assert.equal(stats.played, 2, 'each sentence of the organized plan played once');
  assert.deepEqual(
    app.state.plays.map((play) => play.text),
    ['先补上上次没说完的：窗口采集要选中目标窗口。', '改成游戏采集就能看到画面。'],
    'the player consumes the organized text as-is: no carry knowledge, no replayed old clip',
  );
  assert.equal(app.state.plays.length, 2, 'no third clip was synthesized or replayed');
  assert.equal(app.speaker.isActive(), false);
  const states = lifecycleRows(events).map((row) => row.state);
  assert.ok(states.includes('finished'));
  assert.equal(states.at(-1), 'released');
  t.diagnostic(
    `sentences=${app.state.plays.length} played=${stats.played} states=${states.join('->')} carryAware=false`,
  );
});
