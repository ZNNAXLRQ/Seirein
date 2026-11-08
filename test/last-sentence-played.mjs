/**
 * The last sentence must never disappear from a spoken reply.
 *
 * The streamed spoken version hands the speaker one SEMANTIC UNIT at a time, and the speaker's
 * splitter turns each unit into one played sentence (the `\n` it appends is a terminator). A long
 * sentence cut at a comma is therefore TWO played units but ONE punctuation sentence. The response
 * group used to count its plan by punctuation, so a 7-unit plan (5 punctuation sentences, the last
 * one split into 3 units) was declared complete after unit 4: units 5 and 6 were then reported as
 * `skipped-stale` with `chars: 0` and never played. The plan recorded for the group must use the
 * same unit boundaries the speaker was fed.
 *
 * Covered:
 *   1. a 7-unit plan plays all 7 units and group.done comes after the last one
 *   2. empty / punctuation-only fragments never open a player (nor the whole-reply fallback)
 *   3. a final sentence pushed after close but before finish() returns is played
 *   4. a sentence pushed after finish() returned is reported as dropped, never silently lost
 *   5. budget truncation is reported (kept/dropped), never a fake "played"
 *
 * Run: node --test test/last-sentence-played.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createReplySpeaker } from '../src/host/index.js';
import { createResponseGroupStore } from '../src/host/session/conversation/responseGroup.js';
import { joinSpokenUnits } from '../src/host/speech/spokenPipeline.js';
import { speechCharCount } from '../src/host/shared/text.js';

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const waitUntil = async (check, message, timeoutMs = 3_000) => {
  const started = Date.now();
  for (;;) {
    if (await check()) return;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out: ${message}`);
    await tick(5);
  }
};

/** 7 semantic units, but only 5 punctuation sentences: the last sentence is cut into 3 units. */
const UNITS = ['第一句。', '第二句。', '第三句。', '第四句。', '第五句前半，', '第五句中间，', '第五句结尾。'];
const PLAN_TEXT = UNITS.join('');

/**
 * One response group plus a reply speaker, wired exactly like the host's play seam: a clip that
 * reaches the player publishes started/completed through the group, and a clip refused because the
 * group already closed is published as `skipped-stale`.
 */
function mountPlan({ units = UNITS, groupText = joinSpokenUnits(units) } = {}) {
  const clock = { t: 0 };
  const events = [];
  const plays = [];
  const skips = [];
  const store = createResponseGroupStore({
    now: () => clock.t,
    emit: (type, payload) => events.push({ type, payload }),
  });
  const input = store.beginInput({ sessionId: 'seirein-last-sentence', text: '测试问题', at: clock.t });
  const { group } = input;
  const version = input.answerVersion;
  store.noteAnswerPlan({
    group,
    version,
    text: groupText,
    feedText: PLAN_TEXT,
    source: 'condensed',
    chars: speechCharCount(PLAN_TEXT),
  });
  const speaker = createReplySpeaker({
    startedAt: clock.t,
    now: () => clock.t,
    synthesize: async ({ text, sentenceId }) => ({ file: `${sentenceId}.mp3`, bytes: 8, durationMs: 1, text }),
    play: async ({ text, sentenceId, chunkIndex = 0, chunkCount = 1 }) => {
      if (!store.isCurrentAnswer(group, version)) {
        skips.push({ sentenceId, text });
        store.notePlaybackSkipped({ group, version, sentenceId, chunkIndex, chunkCount });
        return { audioStartedAt: 0, skipped: true };
      }
      store.notePlaybackStart({
        group, version, sentenceId, chunkIndex, chunkCount, text, chars: speechCharCount(text),
      });
      plays.push({ sentenceId, text });
      return {
        audioStartedAt: clock.t + 1,
        done: Promise.resolve().then(() => {
          store.notePlaybackEnd({
            group, version, sentenceId, chunkIndex, chunkCount, status: 'completed', text,
          });
        }),
      };
    },
    speakWhole: async () => assert.fail('a plan with playable sentences must not fall back'),
  });
  return { clock, events, plays, skips, speaker, store, group, version };
}

// ---------------------------------------------------------------------------
// 1. The real 7-unit shape: every unit is played, then the group closes
// ---------------------------------------------------------------------------

test('1. a 7-unit plan plays 7 sentences and group.done follows the last playback', async (t) => {
  assert.equal(PLAN_TEXT.split('。').length - 1, 5, 'fixture: 5 punctuation sentences');
  assert.equal(UNITS.length, 7, 'fixture: 7 semantic units');
  const app = mountPlan();

  for (const unit of UNITS) app.speaker.push(`${unit}\n`);
  const stats = await app.speaker.finish({ fullText: PLAN_TEXT });

  assert.equal(stats.sentences, 7, 'all seven units entered the speaker');
  assert.equal(stats.played, 7, 'all seven units really played');
  assert.equal(stats.chars, speechCharCount(PLAN_TEXT), 'no spoken character was lost');
  assert.deepEqual(app.plays.map((row) => row.text), UNITS, 'playback order is unchanged');
  assert.deepEqual(app.skips, [], 'no unit was refused because the group closed early');
  assert.equal(app.store.get(app.group.id).state, 'done');

  const doneIndex = app.events.findIndex((row) => row.type === 'voice.response.group.done');
  const completed = app.events
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.type === 'voice.response.playback' && row.payload.status === 'completed');
  assert.equal(completed.length, 7, 'seven completed playback rows');
  assert.ok(doneIndex > completed.at(-1).index, 'group.done was published after the last completed clip');
  assert.equal(
    app.events.filter((row) => row.type === 'voice.response.playback' && row.payload.status === 'skipped-stale').length,
    0,
    'no skipped-stale unit',
  );
  const done = app.events[doneIndex].payload;
  assert.equal(done.playedSentences, 7, 'the group reports all seven played sentences');
  assert.equal(done.chars, speechCharCount(PLAN_TEXT));

  t.diagnostic(
    `units=${UNITS.length} planSentences=5 played=${stats.played} skipped=${app.skips.length} `
    + `doneAfterLast=true playedSentences=${done.playedSentences} chars=${done.chars}`,
  );
});

// ---------------------------------------------------------------------------
// 2. Empty and punctuation-only fragments are not sentences
// ---------------------------------------------------------------------------

test('2. empty / punctuation-only fragments never open a player and never block', async (t) => {
  const plays = [];
  const whole = [];
  const events = [];
  const speaker = createReplySpeaker({
    startedAt: 0,
    now: () => 0,
    synthesize: async ({ text }) => ({ file: `${text}.mp3`, bytes: 8, durationMs: 1, text }),
    play: async ({ text }) => {
      plays.push(text);
      return { audioStartedAt: 1, done: Promise.resolve() };
    },
    speakWhole: async (text) => { whole.push(text); return { audioStartedAt: 1 }; },
    onEvent: (event) => events.push(event),
  });
  speaker.push('。\n');
  speaker.push('！？\n');
  speaker.push('   \n');
  const emptyStats = await speaker.finish({ fullText: '。' });

  assert.deepEqual(plays, [], 'punctuation-only fragments produced no playback');
  assert.deepEqual(whole, [], 'punctuation-only text is not spoken through the fallback either');
  assert.equal(emptyStats.sentences, 0, 'no phantom sentence was counted');
  assert.equal(emptyStats.played, 0);
  assert.equal(emptyStats.fallback, false);
  assert.equal(
    events.filter((event) => event.type === 'voice.response.playback').length,
    0,
    'no playback event was emitted',
  );

  // A real sentence after punctuation-only fragments still plays, in order.
  const mixed = createReplySpeaker({
    startedAt: 0,
    now: () => 0,
    synthesize: async ({ text }) => ({ file: `${text}.mp3`, bytes: 8, durationMs: 1, text }),
    play: async ({ text }) => {
      plays.push(text);
      return { audioStartedAt: 1, done: Promise.resolve() };
    },
  });
  mixed.push('。\n实际要播出的一句。');
  const mixedStats = await mixed.finish({ fullText: '实际要播出的一句。' });
  assert.deepEqual(plays, ['实际要播出的一句。'], 'the real sentence was not blocked');
  assert.equal(mixedStats.played, 1);
  t.diagnostic(`emptyPlayed=${emptyStats.played} emptySentences=${emptyStats.sentences} mixedPlayed=${mixedStats.played}`);
});

// ---------------------------------------------------------------------------
// 3. A last sentence pushed after close but before finish() returns is played
// ---------------------------------------------------------------------------

test('3. a final sentence arriving before completion is played, not lost', async (t) => {
  const plays = [];
  const dropped = [];
  const speaker = createReplySpeaker({
    startedAt: 0,
    now: () => 0,
    synthesize: async ({ text }) => ({ file: `${text}.mp3`, bytes: 8, durationMs: 1, text }),
    play: async ({ text }) => {
      const gate = deferred();
      const entry = { text, gate, done: false };
      plays.push(entry);
      return {
        audioStartedAt: 1,
        done: gate.promise.then(() => { entry.done = true; }),
      };
    },
    onEvent: (event) => {
      if (event.type === 'voice.speech.dropped') dropped.push(event);
    },
  });

  speaker.push('第一句。');
  const finishing = speaker.finish({ fullText: '第一句。最后一句。' });
  await waitUntil(() => plays.length === 1, 'the first clip started');
  // The source is closed, but finish() is still draining the run: this is the real race.
  speaker.push('最后一句。');
  plays[0].gate.resolve();
  await waitUntil(() => plays.length === 2, 'the late sentence reached the player');
  plays[1].gate.resolve();
  const stats = await finishing;

  assert.deepEqual(plays.map((row) => row.text), ['第一句。', '最后一句。'], 'the late final sentence played');
  assert.equal(stats.played, 2, 'both sentences are counted');
  assert.deepEqual(dropped, [], 'nothing was dropped because the late sentence was spoken');
  t.diagnostic(`played=${stats.played} droppedEvents=${dropped.length} order=${plays.map((row) => row.text).join('|')}`);
});

// ---------------------------------------------------------------------------
// 4. A sentence pushed after finish() returned is reported, never silent
// ---------------------------------------------------------------------------

test('4. a sentence arriving after finish() returns is reported as dropped', async (t) => {
  const plays = [];
  const dropped = [];
  const speaker = createReplySpeaker({
    startedAt: 0,
    now: () => 0,
    synthesize: async ({ text }) => ({ file: `${text}.mp3`, bytes: 8, durationMs: 1, text }),
    play: async ({ text }) => {
      plays.push(text);
      return { audioStartedAt: 1, done: Promise.resolve() };
    },
    onEvent: (event) => {
      if (event.type === 'voice.speech.dropped') dropped.push(event);
    },
  });

  speaker.push('第一句。');
  const stats = await speaker.finish({ fullText: '第一句。' });
  assert.equal(stats.played, 1);

  speaker.push('迟到的最后一句。');
  assert.equal(plays.length, 1, 'the late sentence did not open a player after finish');
  assert.equal(dropped.length, 1, 'exactly one explicit dropped row');
  assert.equal(dropped[0].reason, 'late-after-finish');
  assert.match(dropped[0].text, /迟到的最后一句/u);
  assert.equal(dropped[0].chars, speechCharCount('迟到的最后一句。'));
  assert.equal(stats.droppedSentences, 1, 'the drop is counted, not silently swallowed');
  t.diagnostic(
    `playedBefore=${plays.length} dropped=${dropped.length} reason=${dropped[0].reason} `
    + `chars=${dropped[0].chars} statsDropped=${stats.droppedSentences}`,
  );
});

// ---------------------------------------------------------------------------
// 5. Budget truncation stays explicit: dropped sentences are never "played"
// ---------------------------------------------------------------------------

test('5. budget truncation reports kept/dropped and never fakes a completed answer', async (t) => {
  const text = '第一句很长很长。第二句。第三句。';
  const plays = [];
  let budget = null;
  const speaker = createReplySpeaker({
    startedAt: 0,
    now: () => 0,
    maxChars: 10,
    synthesize: async ({ text: value }) => ({ file: `${value}.mp3`, bytes: 8, durationMs: 1 }),
    play: async ({ text: value }) => {
      plays.push(value);
      return { audioStartedAt: 1, done: Promise.resolve() };
    },
    onBudget: (event) => { budget = event; },
  });
  speaker.push(text);
  const stats = await speaker.finish({ fullText: text });

  assert.deepEqual(plays, ['第一句很长很长。'], 'only the sentence that fits was spoken');
  assert.equal(stats.truncated, true);
  assert.equal(stats.keptSentences, 1);
  assert.equal(stats.droppedSentences, 2);
  assert.equal(stats.played, 1, 'a dropped sentence is never counted as played');
  assert.notEqual(budget, null, 'the budget row was reported');
  assert.equal(budget.droppedSentences, stats.droppedSentences);
  assert.equal(budget.keptSentences + budget.droppedSentences, 3);
  t.diagnostic(
    `played=${stats.played} kept=${budget.keptSentences} dropped=${budget.droppedSentences} `
    + `truncated=${budget.truncated} chars=${budget.spokenChars}/${budget.requestedChars}`,
  );
});
