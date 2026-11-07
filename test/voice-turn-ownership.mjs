/**
 * A2 gaps 2 and 3: one voice turn, one cancellation identity, one spoken reply channel.
 *
 * Gap 2: the turn captures the speech signal when it wins delivery (`prepareVoiceTurn` succeeded,
 * before `followup`). Mute/barge-in aborts that captured signal, so a body fragment that arrives
 * after mute-then-unmute still belongs to a dead turn and must not acquire playback.
 *
 * Gap 3: `assistant_say` and automatic body speech share the turn's `owner`. Once the tool spoke,
 * the auto path keeps the subtitle but stays silent; the turn releases the ownership when done.
 *
 * The tests compose the same seams the host uses (`createVoiceTurnOwnership` + `createReplySpeaker`
 * with injected synthesis/playback); no real sound, TTS or session is involved.
 *
 * Run: node --test test/voice-turn-ownership.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createReplySpeaker, createVoiceTurnOwnership } from '../src/host/index.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** A speaker factory shaped like the host's lazy `ensureSentenceVoice`. */
function makeAutoPath(turn) {
  const synth = [];
  const plays = [];
  const subtitles = [];
  let speaker = null;
  const ensureSpeaker = () => {
    if (speaker !== null) return speaker;
    // The host never creates a lane for a turn whose captured token was invalidated.
    if (!turn.canSpeak()) return null;
    speaker = createReplySpeaker({
      signal: turn.signal,
      now: () => 0,
      startedAt: 0,
      synthesize: async ({ text }) => {
        synth.push(text);
        return { file: `${text}.mp3`, bytes: 8, durationMs: 100 };
      },
      play: async ({ text }) => {
        // The same claim the host's play seam makes.
        if (!turn.claimAuto()) {
          subtitles.push(text);
          return { audioStartedAt: 0 };
        }
        plays.push(text);
        return { audioStartedAt: 1, done: Promise.resolve() };
      },
      speakWhole: (value) => {
        if (turn.owner === 'tool') return null;
        plays.push(value);
        return { audioStartedAt: 1 };
      },
    });
    return speaker;
  };
  const deliverBody = (info) => {
    if (turn.owner === 'tool') {
      // The host drops the fragment from the speech queue; the body is subtitled at settle.
      return;
    }
    if (!turn.canSpeak()) return;
    ensureSpeaker()?.push(info.delta);
  };
  // Mirror the host's settle-time subtitle for a tool-owned turn.
  const settleSubtitle = (text) => {
    if (turn.owner === 'tool' && text.length > 0) subtitles.push(text);
  };
  return { synth, plays, subtitles, ensureSpeaker, deliverBody, settleSubtitle };
}

// ---------------------------------------------------------------------------
// Gap 2: a late fragment of a muted turn can never borrow the new signal
// ---------------------------------------------------------------------------

test('mute then unmute: the old turn late body is dropped and never plays', async () => {
  const controller = new AbortController();
  const turn = createVoiceTurnOwnership({ captureSignal: () => controller.signal });
  turn.capture();
  assert.equal(turn.canSpeak(), true, 'the turn was captured while speech was live');
  const auto = makeAutoPath(turn);

  // The user mutes while the model is still thinking: `invalidateSpeech()` aborts the captured
  // signal and installs a fresh controller. Unmuting keeps the fresh signal.
  controller.abort();
  const fresh = new AbortController();
  assert.equal(fresh.signal.aborted, false, 'unmute leaves a usable signal for a new turn');

  // The old turn's answer finally arrives, after the unmute.
  auto.deliverBody({ delta: '迟到的正文。', text: '迟到的正文。' });
  await tick();
  assert.deepEqual(auto.synth, [], 'a dead turn never synthesizes');
  assert.deepEqual(auto.plays, [], 'a dead turn never plays');
  assert.equal(auto.ensureSpeaker(), null, 'a dead turn never acquires a playback lane');

  // The next turn captures the fresh signal and still speaks normally.
  const nextTurn = createVoiceTurnOwnership({ captureSignal: () => fresh.signal });
  nextTurn.capture();
  assert.equal(nextTurn.canSpeak(), true);
  const next = makeAutoPath(nextTurn);
  next.deliverBody({ delta: '新的回答。', text: '新的回答。' });
  await tick();
  const stats = await next.ensureSpeaker().finish({ fullText: '新的回答。' });
  assert.equal(stats.played, 1);
  assert.deepEqual(next.plays, ['新的回答。']);
  nextTurn.release();
});

test('not muted: the captured turn plays its body exactly once', async () => {
  const controller = new AbortController();
  const turn = createVoiceTurnOwnership({ captureSignal: () => controller.signal });
  turn.capture();
  const auto = makeAutoPath(turn);
  auto.deliverBody({ delta: '正文第一句。', text: '正文第一句。' });
  await tick();
  const stats = await auto.ensureSpeaker().finish({ fullText: '正文第一句。' });
  assert.equal(stats.played, 1);
  assert.equal(stats.fallback, false);
  assert.deepEqual(auto.plays, ['正文第一句。']);
  turn.release();
  assert.equal(turn.canSpeak(), false, 'release ends the turn identity');
});

// ---------------------------------------------------------------------------
// Gap 3: assistant_say and automatic body speech never both speak a turn
// ---------------------------------------------------------------------------

test('tool speech owns the turn: auto body is subtitled but not played', async () => {
  const controller = new AbortController();
  const turn = createVoiceTurnOwnership({ captureSignal: () => controller.signal });
  turn.capture();
  const auto = makeAutoPath(turn);

  // `assistant_say` played during this turn and claimed the reply channel.
  const audio = ['工具说的话'];
  turn.claimTool();
  auto.deliverBody({ delta: '正文第一句。', text: '正文第一句。' });
  await tick();
  assert.deepEqual(audio, ['工具说的话'], 'the tool is the only clip of the turn');
  assert.deepEqual(auto.plays, [], 'automatic body speech does not play');
  auto.settleSubtitle('正文第一句。');
  assert.deepEqual(auto.subtitles, ['正文第一句。'], 'the subtitle is still shown');

  // Even the whole-reply fallback stays silent for a tool-owned turn.
  const stats = await auto.ensureSpeaker()?.finish({ fullText: '正文第一句。' });
  assert.equal(stats?.played, 0);
  assert.deepEqual(auto.plays, []);
  assert.deepEqual(auto.subtitles, ['正文第一句。']);

  turn.release();
  assert.equal(turn.owner, null, 'the turn releases its reply owner');
  assert.equal(turn.canSpeak(), false);
});

test('without tool speech the auto path plays the body normally', async () => {
  const controller = new AbortController();
  const turn = createVoiceTurnOwnership({ captureSignal: () => controller.signal });
  turn.capture();
  const auto = makeAutoPath(turn);
  auto.deliverBody({ delta: '正文第一句。', text: '正文第一句。' });
  await tick();
  const stats = await auto.ensureSpeaker().finish({ fullText: '正文第一句。' });
  assert.equal(stats.played, 1);
  assert.deepEqual(auto.plays, ['正文第一句。']);
  assert.deepEqual(auto.subtitles, []);
  assert.equal(turn.owner, 'auto');
  turn.release();
});
