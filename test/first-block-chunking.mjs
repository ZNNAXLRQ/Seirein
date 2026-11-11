/**
 * P-148: first-block chunking of the FIRST semantic unit.
 *
 * The streamed spoken-version path sized a whole semantic unit as ONE TTS block (`chunking:false`),
 * so block 0 was 18–106 characters and the first sound waited for the whole unit. This suite covers
 * the replacement: the opening block of the first unit is cut near a target size, at a punctuation
 * boundary, while the rest of the unit stays one later block.
 *
 * Covered:
 *   1. an 80-character first unit is cut into >= 2 blocks; the opening block stays inside the
 *      target window and ends on a pause, and the join is the original text (lossless partition)
 *   2. a short first unit (< 40 characters) is never cut (1 block, the old behavior)
 *   3. a long unit without punctuation is not cut inside a word (whole unit)
 *   4. blocks play once, in order, and the played text concatenation is the whole sentence
 *   5. the first sound arrives earlier than a whole-unit synthesis would allow (same fake clock)
 *   6. the target resolution (explicit chars / measured ms/char / default) matches the event fields
 *
 * Run: node --test test/first-block-chunking.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_FIRST_BLOCK_TARGET_CHARS,
  DEFAULT_FIRST_BLOCK_TARGET_MS,
  DEFAULT_FIRST_BLOCK_SHORT_CHARS,
  splitFirstBlockChunks,
  resolveFirstBlockTarget,
  speakChunks,
  planSpeechBlocks,
} from '../src/host/speech/tts.js';

/** The unit every test starts from: 80 characters, pauses well inside the default target window. */
const LONG_UNIT = '今天先把桌面整理干净，把散落的纸张按用途分好类，再把用完的杯子收进水槽，'
  + '最后把明天的计划写在便签上，然后读十分钟书再早点休息，这样明天起床的时候就不会手忙脚乱。';
/** A short unit: nothing to gain from a cut, and the old path must be kept. */
const SHORT_UNIT = '短句不需要切块，直接整句合成。';
/** No punctuation at all: there is no safe boundary, so the unit must stay whole. */
const UNPUNCTUATED_UNIT = '这是一个没有任何标点符号的很长很长的句子我们不应该在词语中间把它切开否则听起来会非常奇怪';
/** A comma-level pause inside brackets is not a boundary (same rule as the existing splitter). */
const BRACKET_UNIT = '这是一句很长的话（里面有逗号，还有顿号、分号），后面继续说明今天要做的事情，最后再一起确认一遍结果有没有遗漏。';

const chars = (text) => [...String(text ?? '')].length;
/** The target window the splitter promises: the target plus the documented slack. */
const windowOf = (targetChars) => targetChars + Math.max(8, Math.round(targetChars / 4));

// ---------------------------------------------------------------------------
// 1. a long first unit is cut into an opening block plus the rest
// ---------------------------------------------------------------------------

test('1) an 80-character first unit becomes >= 2 blocks; block 0 fits the target window', (t) => {
  const plan = splitFirstBlockChunks(LONG_UNIT);
  assert.equal(chars(LONG_UNIT), 80, 'fixture is the 80-character case from the requirement');
  assert.ok(plan.chunked, 'a long opening unit really is chunked');
  assert.ok(plan.blocks.length >= 2, `at least two blocks (got ${plan.blocks.length})`);
  assert.ok(plan.firstBlockChars <= windowOf(plan.targetChars),
    `block 0 ${plan.firstBlockChars} <= target ${plan.targetChars} + slack`);
  assert.ok(plan.firstBlockChars < plan.chars, 'block 0 is smaller than the whole unit');
  // The cut is at a comma-level pause, never inside a word.
  assert.match(plan.blocks[0], /[，、,；;]$/u, 'block 0 ends on a pause');
  assert.equal(plan.blocks.join(''), LONG_UNIT, 'the blocks are a lossless partition of the unit');
  // Only the FIRST block is cut: the remainder of the unit stays one later block.
  assert.equal(plan.blocks.length, 2);
  t.diagnostic(
    `chars=${plan.chars} targetChars=${plan.targetChars} targetMs=${plan.targetMs}`
    + ` firstBlockChars=${plan.firstBlockChars} chunks=${plan.blocks.length}`,
  );
});

test('1b) a bracket/quote pause is never a cut point', (t) => {
  const plan = splitFirstBlockChunks(BRACKET_UNIT);
  assert.ok(plan.chunked);
  assert.equal(plan.blocks.join(''), BRACKET_UNIT, 'lossless');
  assert.ok(plan.blocks[0].includes('（里面有逗号，还有顿号、分号）'), 'the bracket content stays whole');
  assert.ok(!/[（(]$/u.test(plan.blocks[0]), 'the cut is not right after an opener');
  t.diagnostic(`firstBlockChars=${plan.firstBlockChars} blocks=${plan.blocks.map((block) => chars(block)).join(',')}`);
});

// ---------------------------------------------------------------------------
// 2. a short first unit keeps the old one-block path
// ---------------------------------------------------------------------------

test('2) a short first unit (< 32 characters) is not cut', (t) => {
  const plan = splitFirstBlockChunks(SHORT_UNIT);
  assert.ok(chars(SHORT_UNIT) < DEFAULT_FIRST_BLOCK_SHORT_CHARS);
  assert.equal(plan.chunked, false);
  assert.deepEqual(plan.blocks, [SHORT_UNIT], 'one block, exactly the old behavior');
  assert.equal(plan.firstBlockChars, chars(SHORT_UNIT));
  // The short rule is independent of an explicit target: a still-short unit stays whole.
  const nearly = '这句话里有逗号，但整体仍然很短，不应该切。';
  assert.ok(chars(nearly) < DEFAULT_FIRST_BLOCK_SHORT_CHARS, `fixture is ${chars(nearly)} characters`);
  const nearPlan = splitFirstBlockChunks(nearly, { targetChars: 12 });
  assert.deepEqual(nearPlan.blocks, [nearly], 'a short unit is whole even with a smaller target');
  t.diagnostic(`shortChars=${chars(SHORT_UNIT)} blocks=${plan.blocks.length} targetChars=${plan.targetChars}`);
});

// ---------------------------------------------------------------------------
// 3. no safe boundary -> whole unit, never a cut inside a word
// ---------------------------------------------------------------------------

test('3) a long unit without punctuation is not cut inside a word', (t) => {
  const plan = splitFirstBlockChunks(UNPUNCTUATED_UNIT);
  assert.ok(chars(UNPUNCTUATED_UNIT) > DEFAULT_FIRST_BLOCK_SHORT_CHARS, 'the fixture is long');
  assert.equal(plan.chunked, false, 'no punctuation means no cut point');
  assert.deepEqual(plan.blocks, [UNPUNCTUATED_UNIT], 'the whole unit is the single block');
  // English text without punctuation behaves the same: word boundaries alone are not enough.
  const english = 'This sentence has no punctuation at all and must never be split inside a word '
    + 'no matter how long it becomes because that would sound wrong';
  const englishPlan = splitFirstBlockChunks(english);
  assert.equal(englishPlan.chunked, false);
  assert.deepEqual(englishPlan.blocks, [english]);
  t.diagnostic(`chars=${plan.chars} blocks=${plan.blocks.length} englishChars=${chars(english)}`);
});

// ---------------------------------------------------------------------------
// 4. order, no repetition, no swallowed text
// ---------------------------------------------------------------------------

test('4) all blocks play once, in order, and join to the whole sentence', async (t) => {
  const plan = splitFirstBlockChunks(LONG_UNIT);
  const plays = [];
  const synthesized = [];
  const summary = await speakChunks({
    // The semantic-unit seam passes the split list as `chunks`; the caption/text stays the unit.
    text: LONG_UNIT,
    chunks: plan.blocks,
    sentenceId: 0,
    synthesize: async ({ text, index, chunkId }) => {
      synthesized.push({ text, index, chunkId });
      return { file: `blk-${index}-${chunkId}.mp3`, bytes: 4, durationMs: 10 };
    },
    play: async ({ text, index, chunkId, count }) => {
      plays.push({ text, index, chunkId, count });
      return { audioStartedAt: Date.now(), done: Promise.resolve() };
    },
  });
  assert.deepEqual(plays.map((play) => play.index), [0, 1], 'strictly serial block order');
  assert.deepEqual(plays.map((play) => play.chunkId), ['0:0', '0:1']);
  assert.ok(plays.every((play) => play.count === 2));
  assert.equal(plays.map((play) => play.text).join(''), LONG_UNIT, 'played text === the whole unit');
  assert.equal(summary.playedText, LONG_UNIT);
  assert.equal(summary.playedChunks, 2);
  assert.equal(summary.skipped, 0);
  // Nothing is duplicated: every block differs, and the synthesis used each block once.
  assert.equal(new Set(synthesized.map((entry) => entry.text)).size, 2);
  assert.deepEqual(synthesized.map((entry) => entry.text), plan.blocks);
  t.diagnostic(
    `playedBlocks=${plays.length} joinEqualsUnit=${plays.map((play) => play.text).join('') === LONG_UNIT}`
    + ` firstBlockChars=${plan.firstBlockChars} blockChars=${plan.blocks.map((block) => chars(block)).join(',')}`,
  );
});

// ---------------------------------------------------------------------------
// 5. the first sound comes earlier than whole-unit synthesis (same fake clock)
// ---------------------------------------------------------------------------

test('5) block 0 is synthesized (and audible) before the whole unit could be', async (t) => {
  const perCharMs = 133; // the measured GPT-SoVITS cost per character from the task evidence
  const plan = splitFirstBlockChunks(LONG_UNIT);
  assert.ok(plan.chunked);

  const run = async (chunks) => {
    const clock = { t: 0 };
    const plays = [];
    await speakChunks({
      text: LONG_UNIT,
      chunks,
      sentenceId: 0,
      synthesize: async ({ text }) => {
        clock.t += chars(text) * perCharMs;
        return { file: '', bytes: 4, durationMs: chars(text) * 4 };
      },
      play: async ({ text }) => {
        plays.push({ at: clock.t, chars: chars(text), text });
        return { audioStartedAt: Math.max(1, clock.t), done: Promise.resolve() };
      },
    });
    return plays;
  };

  const whole = await run([LONG_UNIT]); // the old path: one block for the whole unit
  const chunked = await run(plan.blocks);
  const wholeLetencyMs = whole[0].at;
  const chunkedLatencyMs = chunked[0].at;
  assert.equal(whole[0].chars, chars(LONG_UNIT), 'baseline synthesizes the whole unit');
  assert.equal(chunked[0].chars, plan.firstBlockChars, 'the new first block is the cut prefix');
  assert.ok(chunked[0].chars < chars(LONG_UNIT), 'block 0 synthesizes fewer characters than the unit');
  assert.ok(chunkedLatencyMs < wholeLetencyMs,
    `first audio ${chunkedLatencyMs}ms < baseline ${wholeLetencyMs}ms`);
  // Every block still played, in order, and the text is the whole unit.
  assert.equal(chunked.map((entry) => entry.text).join(''), LONG_UNIT);
  assert.equal(chunked.length, 2);
  t.diagnostic(
    `wholeFirstMs=${wholeLetencyMs} chunkedFirstMs=${chunkedLatencyMs}`
    + ` savedMs=${wholeLetencyMs - chunkedLatencyMs}`
    + ` block0Chars=${chunked[0].chars} wholeChars=${whole[0].chars}`,
  );
});

// ---------------------------------------------------------------------------
// 6. target resolution and the debug-event payload
// ---------------------------------------------------------------------------

test('6) the target is explicit chars, then measured ms/char, then the ~30-character default', (t) => {
  assert.deepEqual(resolveFirstBlockTarget(), {
    targetChars: DEFAULT_FIRST_BLOCK_TARGET_CHARS,
    targetMs: DEFAULT_FIRST_BLOCK_TARGET_MS,
  });
  // `voice.firstBlockTargetChars` wins over everything.
  assert.equal(resolveFirstBlockTarget({ targetChars: 20, targetMs: 900, msPerChar: 40, measured: true }).targetChars, 20);
  // `voice.firstBlockTargetMs` is honoured only with a MEASURED rate (a guessed rate never sizes it).
  assert.deepEqual(resolveFirstBlockTarget({ targetMs: 1500, msPerChar: 100, measured: true }), {
    targetChars: 15,
    targetMs: 1500,
  });
  assert.equal(resolveFirstBlockTarget({ targetMs: 1500, msPerChar: 100, measured: false }).targetChars, 30);
  // A configured target is clamped to a usable block size.
  assert.equal(resolveFirstBlockTarget({ targetChars: 1 }).targetChars, 4);
  assert.equal(resolveFirstBlockTarget({ targetChars: 999 }).targetChars, 120);

  // The plan carries exactly the fields of `voice.first-block.chunked`.
  const plan = splitFirstBlockChunks(LONG_UNIT);
  const event = {
    chars: plan.chars,
    targetChars: plan.targetChars,
    targetMs: plan.targetMs,
    chunks: plan.blocks.length,
    firstBlockChars: plan.firstBlockChars,
  };
  assert.deepEqual(event, {
    chars: 80,
    targetChars: DEFAULT_FIRST_BLOCK_TARGET_CHARS,
    targetMs: DEFAULT_FIRST_BLOCK_TARGET_MS,
    chunks: 2,
    firstBlockChars: plan.firstBlockChars,
  });
  // An explicit target changes the opening block, and the plan reports the configured values.
  const custom = splitFirstBlockChunks(LONG_UNIT, { targetChars: 80 });
  assert.equal(custom.targetChars, 80);
  assert.deepEqual(custom.blocks, [LONG_UNIT], 'a target >= the unit never cuts it');
  t.diagnostic(
    `default=${JSON.stringify(resolveFirstBlockTarget())}`
    + ` measured=${JSON.stringify(resolveFirstBlockTarget({ targetMs: 1500, msPerChar: 100, measured: true }))}`
    + ` event=${JSON.stringify(event)}`,
  );
});
