/**
 * Overlap decoding + referee-anchored join (the fix for words split at a decode cut).
 *
 * Two layers:
 *  - pure unit tests for `planSegmentedDecodes()` / `alignJointTexts()` / `joinSegmentedTexts()`;
 *  - an end-to-end test through `startHearing()` with a *fake* final recognizer that simulates the
 *    real failure mode: a word that straddles a piece edge is returned as two garbled halves. No
 *    microphone, ffmpeg, sherpa model or network is used.
 *
 * Run: node --test test/asr-overlap-join.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_SEGMENT_OVERLAP_MS,
  alignJointTexts,
  joinDetailFields,
  joinSegmentTexts,
  joinSegmentedTexts,
  mergeJoinFallback,
  planSegmentedDecodes,
  segmentOverlapSamples,
  startHearing,
} from '../src/host/hearing/hearing.js';
import { buildChecks, evaluateVersion } from '../tools/asr-cutpoint-check.mjs';

const SAMPLE_RATE = 16000;

// ---------------------------------------------------------------------------------------------
// planning
// ---------------------------------------------------------------------------------------------
test('a short utterance stays exactly one decode with no referee', () => {
  const plan = planSegmentedDecodes(3 * SAMPLE_RATE, 15 * SAMPLE_RATE, segmentOverlapSamples(800));
  assert.equal(plan.pieces.length, 1);
  assert.deepEqual(plan.pieces[0], { index: 0, startSample: 0, endSample: 3 * SAMPLE_RATE });
  assert.equal(plan.joints.length, 0, 'nothing to referee on a single piece');
  assert.deepEqual(plan.jobs.map((job) => job.kind), ['segment']);
});

test('overlap 0 reproduces the old fixed-size split exactly', () => {
  const total = 40 * SAMPLE_RATE;
  const plan = planSegmentedDecodes(total, 15 * SAMPLE_RATE, 0);
  assert.deepEqual(plan.pieces.map((piece) => [piece.startSample, piece.endSample]), [
    [0, 15 * SAMPLE_RATE],
    [15 * SAMPLE_RATE, 30 * SAMPLE_RATE],
    [30 * SAMPLE_RATE, total],
  ]);
  assert.equal(plan.joints.length, 0, 'the old path has no referee decodes');
  assert.equal(plan.jobs.length, 3);
});

test('every cut point sits inside both neighbours, first/last stay in bounds', () => {
  const total = 40526 * 16; // 40.526 s, the fixture length
  const seg = 15 * SAMPLE_RATE;
  const overlap = segmentOverlapSamples(800);
  const plan = planSegmentedDecodes(total, seg, overlap);

  assert.equal(plan.pieces.length, 3);
  assert.deepEqual(plan.pieces.map((piece) => [piece.startSample, piece.endSample]), [
    [0, 15 * SAMPLE_RATE + overlap],
    [15 * SAMPLE_RATE - overlap, 30 * SAMPLE_RATE + overlap],
    [30 * SAMPLE_RATE - overlap, total],
  ]);
  assert.equal(plan.pieces[0].startSample, 0, 'the first piece never reaches before the audio');
  assert.equal(plan.pieces.at(-1).endSample, total, 'the last piece never reaches past the audio');
  for (const piece of plan.pieces) {
    assert.ok(piece.startSample >= 0 && piece.endSample <= total);
    assert.ok(piece.endSample > piece.startSample);
  }

  // The 15 s cut and the 30 s cut both get 2*overlap of shared audio plus one pad of clean context.
  assert.deepEqual(plan.joints.map((joint) => [joint.startSample, joint.endSample]), [
    [15 * SAMPLE_RATE - overlap, 15 * SAMPLE_RATE + 2 * overlap],
    [30 * SAMPLE_RATE - overlap, 30 * SAMPLE_RATE + 2 * overlap],
  ]);
  assert.deepEqual(plan.jobs.map((job) => job.kind), ['segment', 'joint', 'segment', 'joint', 'segment']);

  // The referee starts exactly where the next piece starts and still covers the whole shared audio.
  for (const [index, joint] of plan.joints.entries()) {
    assert.equal(joint.startSample, plan.pieces[index + 1].startSample);
    assert.ok(joint.startSample < plan.pieces[index].endSample, 'shared audio is inside the referee');
    assert.ok(joint.endSample <= total);
  }
});

test('overlap larger than a piece is clamped so every piece still makes progress', () => {
  const total = 10 * SAMPLE_RATE;
  const plan = planSegmentedDecodes(total, 2 * SAMPLE_RATE, segmentOverlapSamples(5000));
  assert.ok(plan.pieces.length > 1);
  for (const piece of plan.pieces) assert.ok(piece.endSample > piece.startSample);
  assert.equal(plan.pieces.at(-1).endSample, total);
});

// ---------------------------------------------------------------------------------------------
// referee-anchored trimming
// ---------------------------------------------------------------------------------------------
test('the referee anchor trims the duplicated next head, keeping both halves once', () => {
  const aligned = alignJointTexts({
    previousText: '这里需要一点耐心橙子',
    nextText: '橙子接下来我们确认后面的内容',
    refereeText: '橙子。',
  });
  assert.equal(aligned.fallback, false);
  assert.equal(aligned.path, 'referee');
  assert.equal(aligned.trimChars, 2);
  assert.equal(aligned.headTrimmed, '接下来我们确认后面的内容');
});

test('a fully duplicated joint is cut whole', () => {
  const aligned = alignJointTexts({
    previousText: '很快就好了雷达',
    nextText: '雷达最后重复一遍',
    refereeText: '雷达',
  });
  assert.equal(aligned.fallback, false);
  assert.equal(aligned.trimChars, 2);
  assert.equal(aligned.headTrimmed, '最后重复一遍');
});

test('a genuine repeat inside the shared audio is cut once, not twice', () => {
  // Both pieces decoded the same shared "非常非常"; the next piece repeats it and continues.
  const aligned = alignJointTexts({
    previousText: '前面非常非常',
    nextText: '非常非常重要',
    refereeText: '非常非常',
  });
  assert.equal(aligned.fallback, false);
  assert.equal(aligned.trimChars, 4, 'exactly one copy of the shared phrase is removed');
  assert.equal(aligned.headTrimmed, '重要');
});

test('a poor referee clip still trims when both sides agree exactly', () => {
  // SenseVoice really returns things like "橙eng子" for ~1.6 s clips: the exact boundary overlap is
  // used when the referee confirms it as a subsequence.
  const aligned = alignJointTexts({
    previousText: '这里需要一点耐心橙子',
    nextText: '橙子接下来我们确认',
    refereeText: '橙eng子。',
  });
  assert.equal(aligned.fallback, false);
  assert.equal(aligned.path, 'verified-overlap');
  assert.equal(aligned.headTrimmed, '接下来我们确认');
});

test('a one-character referee falls back instead of guessing', () => {
  const aligned = alignJointTexts({ previousText: '前半句橙', nextText: '橙子后半句', refereeText: '橙' });
  assert.equal(aligned.fallback, true);
  assert.equal(aligned.reason, 'referee-too-short');
  assert.equal(aligned.trimChars, 0);
  assert.equal(aligned.headTrimmed, '橙子后半句', 'nothing is removed on a fallback');
});

test('an ambiguous referee (seen twice near the boundary) falls back', () => {
  const aligned = alignJointTexts({
    previousText: '非常非常重要非常非常',
    nextText: '非常非常重要，这一点',
    refereeText: '非常非常',
  });
  assert.equal(aligned.fallback, true);
  assert.equal(aligned.reason, 'referee-ambiguous');
  assert.equal(aligned.headTrimmed, '非常非常重要，这一点');
});

test('a coincidental text overlap the referee cannot confirm falls back (no char deleted)', () => {
  // The old rejected heuristic deleted "非常" here and lost a real repetition.
  const aligned = alignJointTexts({
    previousText: '这句话非常',
    nextText: '非常重要',
    refereeText: '完全没有这段音频',
  });
  assert.equal(aligned.fallback, true, 'kept both texts: duplication is preferred over loss');
  assert.equal(aligned.trimChars, 0);
  assert.equal(aligned.headTrimmed, '非常重要');
});

test('a totally unrelated referee falls back', () => {
  const aligned = alignJointTexts({ previousText: '橙子结尾', nextText: '开头别的', refereeText: '一点关系都没有' });
  assert.equal(aligned.fallback, true);
  assert.ok(['anchor-mismatch', 'unverified-overlap'].includes(aligned.reason));
  assert.equal(aligned.headTrimmed, '开头别的');
});

// ---------------------------------------------------------------------------------------------
// joining decoded pieces
// ---------------------------------------------------------------------------------------------
test('joinSegmentedTexts keeps one copy per piece and reports no fallback', () => {
  const joined = joinSegmentedTexts([
    { kind: 'segment', index: 0, text: '甲乙橙子' },
    { kind: 'joint', index: 0, text: '橙子' },
    { kind: 'segment', index: 1, text: '橙子丙丁' },
  ]);
  assert.equal(joined.text, '甲乙橙子丙丁');
  assert.equal(joined.joinFallback, false);
  assert.deepEqual(joined.joints.map((joint) => joint.trimChars), [2]);
});

test('a fallback keeps both pieces and flags the join', () => {
  const joined = joinSegmentedTexts([
    { kind: 'segment', index: 0, text: '甲乙橙子' },
    { kind: 'joint', index: 0, text: '无关' },
    { kind: 'segment', index: 1, text: '橙子丙丁' },
  ]);
  assert.equal(joined.joinFallback, true);
  assert.equal(joined.text, '甲乙橙子橙子丙丁', 'nothing lost, duplication accepted and flagged');
  assert.equal(joined.joints[0].fallback, true);
});

test('pieces without a kind are still joined the old way (backward compatible)', () => {
  const joined = joinSegmentedTexts([{ index: 0, text: '前半句' }, { index: 1, text: '后半句' }]);
  assert.equal(joined.text, '前半句后半句');
  assert.equal(joined.joinFallback, false);
  assert.equal(joined.joints.length, 0);
  assert.equal(joined.text, joinSegmentTexts(['前半句', '后半句']), 'the no-overlap path is unchanged');
  assert.equal(joinSegmentTexts(['非常', '非常重要']), '非常非常重要', 'no suffix/prefix guessing');
});

// ---------------------------------------------------------------------------------------------
// counter-examples: the edge tolerance must never delete a real negation
// ---------------------------------------------------------------------------------------------
const joinPieces = (previousText, nextText, refereeText) => joinSegmentedTexts([
  { kind: 'segment', index: 0, text: previousText },
  { kind: 'joint', index: 0, text: refereeText },
  { kind: 'segment', index: 1, text: nextText },
]);

test('a) the reported case: 我们可以 / 不可以继续 / 裁判 不可以继续 keeps the whole 不可以继续', () => {
  const aligned = alignJointTexts({ previousText: '我们可以', nextText: '不可以继续', refereeText: '不可以继续' });
  assert.equal(aligned.fallback, true, 'an unverifiable head alignment is reported, never silent');
  assert.equal(aligned.reason, 'head-char-kept');
  assert.equal(aligned.trimChars, 0, 'a join that needs a head skip cuts nothing');
  assert.equal(aligned.headTrimmed, '不可以继续', 'the next piece is kept verbatim');
  assert.notEqual(aligned.headTrimmed, '不继续', 'the 不 must not become the only surviving negation');

  const joined = joinPieces('我们可以', '不可以继续', '不可以继续');
  assert.ok(
    joined.text.includes('不可以继续'),
    `the complete negation must survive, got ${JSON.stringify(joined.text)}`,
  );
  assert.notEqual(joined.text, '我们可以不继续', 'the old bug reversed 不可以 into 可以不');
  assert.equal(joined.text, '我们可以不可以继续', 'the whole next piece is kept: duplication over loss');
  assert.equal(joined.joinFallback, true, 'the join is flagged for the host log');
  assert.equal(joined.joints[0].trimChars, 0, 'nothing is cut when the head had to be skipped');
});

test('b) other negations (没 / 别 / 未) survive whole: no text after a skipped head is cut', () => {
  const cases = [
    { previous: '这个方案', next: '没问题的', referee: '没问题', negation: '没' },
    { previous: '我想去', next: '别去了吧', referee: '别去了', negation: '别' },
    { previous: '他应该', next: '未完成作业', referee: '未完成', negation: '未' },
  ];
  for (const item of cases) {
    const joined = joinPieces(item.previous, item.next, item.referee);
    assert.ok(
      joined.text.includes(item.next),
      `「${item.next}」must survive whole, got ${JSON.stringify(joined.text)}`,
    );
    assert.ok(
      joined.text.includes(item.negation),
      `「${item.negation}」must survive ${JSON.stringify(item)}, got ${JSON.stringify(joined.text)}`,
    );
    assert.equal(joined.text, `${item.previous}${item.next}`, `${item.negation}: nothing is trimmed`);
    assert.equal(joined.joinFallback, true, `${item.negation}: the head alignment is flagged`);
    assert.equal(joined.joints[0].trimChars, 0, `${item.negation}: no unverified cut`);
  }
});

test('c) a referee whose head disagrees with the next piece keeps the whole next text', () => {
  // The referee lost the 不 ("可以继续"), so nothing about the next head can be verified.
  const aligned = alignJointTexts({ previousText: '我们可以', nextText: '不可以继续', refereeText: '可以继续' });
  assert.equal(aligned.fallback, true);
  assert.equal(aligned.trimChars, 0, 'nothing is cut when the referee and the next head disagree');
  assert.equal(aligned.headTrimmed, '不可以继续', 'the next text is delivered verbatim');

  const joined = joinPieces('我们可以', '不可以继续', '可以继续');
  assert.equal(joined.text, '我们可以不可以继续', 'both texts kept: duplication is preferred over loss');
  assert.equal(joined.joinFallback, true);
});

test('a same-sample edge artifact keeps the whole next text instead of trimming after it', () => {
  // The next piece opens with an extra 新 (it starts mid-syllable) and the referee renders the same
  // 新. That head skip is exactly the unproven case: no char after it may be cut, so the whole piece
  // survives and the join is flagged. Duplication is accepted; dropping 橙子 would be text loss.
  const aligned = alignJointTexts({
    previousText: '这里需要一点耐心橙子。',
    nextText: '新橙子接下来我们确认',
    refereeText: '新橙子。',
  });
  assert.equal(aligned.fallback, true);
  assert.equal(aligned.reason, 'head-char-kept');
  assert.equal(aligned.trimChars, 0);
  assert.equal(aligned.headTrimmed, '新橙子接下来我们确认');
  const joined = joinPieces('这里需要一点耐心橙子。', '新橙子接下来我们确认', '新橙子。');
  assert.equal(joined.text, '这里需要一点耐心橙子。新橙子接下来我们确认');
  assert.equal(joined.text.split('橙子').length - 1, 2, 'the unverified duplicate stays instead of a cut');
  assert.equal(joined.joinFallback, true);
});

// ---------------------------------------------------------------------------------------------
// joinFallback reaches the host log
// ---------------------------------------------------------------------------------------------
test('merging finals ORs joinFallback: one flagged final flags the merged transcript', () => {
  const merge = (finals) => finals.reduce(
    (meta, incoming) => Object.assign(meta, mergeJoinFallback(meta, incoming)),
    { joinFallback: false, joinFallbacks: 0 },
  );
  // The `voice.transcript` payload: production `mergeJoinFallback` + production `joinDetailFields`.
  const eventOf = (finals) => {
    const meta = merge(finals);
    return { durationMs: 0, ...joinDetailFields(meta) };
  };

  assert.deepEqual(eventOf([false, true]), { durationMs: 0, joinFallback: true, joinFallbacks: 1 });
  assert.deepEqual(eventOf([true, false]), { durationMs: 0, joinFallback: true, joinFallbacks: 1 });
  assert.deepEqual(eventOf([false, false]), { durationMs: 0, joinFallback: false, joinFallbacks: 0 });
  assert.deepEqual(eventOf([true, true]), { durationMs: 0, joinFallback: true, joinFallbacks: 2 });
  assert.deepEqual(eventOf([false]), { durationMs: 0, joinFallback: false, joinFallbacks: 0 });
  // Shape of the line that lands in data/events.jsonl ("payload" holds exactly these fields).
  assert.equal(
    JSON.stringify(joinDetailFields(merge([false, true]))),
    '{"joinFallback":true,"joinFallbacks":1}',
  );
});

test('the host wires joinFallback into voice.transcript and ambient.utterance', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'host', 'index.js'),
    'utf8',
  );
  const toolSource = readFileSync(new URL('../src/host/runtime/tools.js', import.meta.url), 'utf8');
  // final → merge metadata (logical OR through the shared helper)
  assert.match(source, /Object\.assign\(mergeMeta, mergeJoinFallback\(mergeMeta, meta\.joinFallback === true\)\)/u);
  // hearing final → acceptFinal
  assert.match(source, /joinFallback: event\.joinFallback === true,/u);
  // voice.transcript event
  assert.match(source, /\.\.\.joinDetailFields\(meta\),/u);
  // ambient.utterance event and the ambient poll result
  assert.match(source, /joinFallback: entry\.joinFallback,/u);
  assert.match(source, /joinFallbacks: entry\.joinFallback \? 1 : 0,/u);
  assert.match(toolSource, /const joinFallbacks = recent\.filter\(\(entry\) => entry\.joinFallback === true\)\.length;/u);
  assert.match(toolSource, /joinFallback: joinFallbacks > 0,/u);
});

// ---------------------------------------------------------------------------------------------
// end-to-end through startHearing() with a scripted, position-aware recognizer
// ---------------------------------------------------------------------------------------------
class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.killed = false;
  }

  kill() {
    this.killed = true;
  }
}

function fakeStreaming(endpointAtSamples, streamText = '') {
  return {
    createStream: () => ({
      samples: 0,
      acceptWaveform({ samples }) {
        this.samples += samples.length;
      },
    }),
    isReady: () => false,
    decode: () => {},
    getResult: () => ({ text: streamText }),
    isEndpoint: (stream) => stream.samples >= endpointAtSamples,
    reset(stream) {
      stream.samples = 0;
    },
  };
}

/**
 * Position-aware offline stand-in. `audio.samples` carries its own absolute index in `byteOffset`
 * (`index % 1000`), which is how a decode recovers the sample range it was given.
 *
 * `words` are absolute ranges with their real text and the two halves a cut produces (`stub`), which
 * is exactly what the real model did to 橙子 at 15.000 s: "成" + "字".
 */
function scriptedFinal({ totalSamples, words, garbled = [] }) {
  const calls = [];
  const audio = new Float32Array(totalSamples);
  for (let index = 0; index < totalSamples; index += 1) audio[index] = (index % 1000) / 1000;
  return {
    audio,
    calls,
    createStream: () => ({
      chunk: null,
      acceptWaveform({ samples }) {
        this.chunk = samples;
      },
    }),
    decode: () => {},
    getResult(stream) {
      const chunk = stream.chunk;
      const start = chunk.byteOffset / 4;
      const end = start + chunk.length;
      calls.push([start, end]);
      const override = garbled.find((entry) => entry.start === start && entry.end === end);
      if (override) return { text: override.text };
      const parts = [];
      for (const word of words) {
        if (word.end <= start || word.start >= end) continue;
        if (word.start >= start && word.end <= end) parts.push(word.text);
        else if (word.end > start && word.start < start) parts.push(word.stub[1]); // left part lost
        else parts.push(word.stub[0]); // right part lost
      }
      return { text: parts.join('') };
    },
  };
}

/** 4 s of audio; 橙子 straddles the 2.000 s cut. */
const CROSS_WORDS = [
  { start: 1600, end: 4800, text: '甲乙', stub: ['甲', '乙'] },
  { start: 8000, end: 11000, text: '丙丁', stub: ['丙', '丁'] },
  { start: 29600, end: 34400, text: '橙子', stub: ['成', '字'] }, // straddles 32000 (2.000 s)
  { start: 41000, end: 45000, text: '戊己', stub: ['戊', '己'] },
];
const TOTAL = 64000; // 4 s

function harness({ finalRecognizer, asrSegmentOverlapMs, endpointAtSamples = TOTAL, maxUtteranceSec, streamText = '' }) {
  const child = new FakeChild();
  const updates = [];
  const hearing = startHearing({
    ffmpegPath: 'ffmpeg-not-used',
    modelDir: 'models-not-used',
    finalModelDir: '',
    device: 'fake-device',
    decodeCapSec: 2,
    asrSegmentOverlapMs,
    maxUtteranceSec,
    recognizer: fakeStreaming(endpointAtSamples, streamText),
    finalRecognizer,
    spawnProcess: () => child,
    onUpdate: (event) => updates.push(event),
  });
  return { child, updates, hearing, fake: finalRecognizer };
}

async function feed(child, samples) {
  const pcm = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) {
    pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[index])) * 32767), index * 2);
  }
  child.stdout.write(pcm);
  await new Promise((resolve) => setTimeout(resolve, 40));
}

test('a word straddling the cut is lost with overlap 0 and kept once with the default overlap', async () => {
  // Before: exactly the reported failure — "成" + "字".
  const broken = scriptedFinal({ totalSamples: TOTAL, words: CROSS_WORDS });
  const before = harness({ finalRecognizer: broken, asrSegmentOverlapMs: 0 });
  await feed(before.child, broken.audio);
  const beforeFinal = before.updates.find((event) => typeof event.final === 'string');
  assert.ok(beforeFinal, 'the endpoint produced a final');
  assert.equal(beforeFinal.final.includes('橙子'), false, 'the old hard cut splits the word');
  assert.equal(beforeFinal.final.includes('成'), true);
  assert.equal(beforeFinal.final.includes('字'), true);

  // After: the word is fully inside both neighbours, the referee cuts one copy.
  const fixed = scriptedFinal({ totalSamples: TOTAL, words: CROSS_WORDS });
  const after = harness({ finalRecognizer: fixed, asrSegmentOverlapMs: DEFAULT_SEGMENT_OVERLAP_MS });
  await feed(after.child, fixed.audio);
  const afterFinal = after.updates.find((event) => typeof event.final === 'string');
  assert.ok(afterFinal, 'the endpoint produced a final');
  const occurrences = afterFinal.final.split('橙子').length - 1;
  assert.equal(occurrences, 1, `橙子 must appear exactly once, got ${JSON.stringify(afterFinal.final)}`);
  assert.equal(afterFinal.final, '甲乙丙丁橙子戊己');
  assert.equal(afterFinal.joinFallback, undefined, 'the referee confirmed the joint');
  assert.equal(afterFinal.refined, true);

  // 4 s of audio with 2 s pieces = 2 pieces + 1 referee decode.
  assert.equal(after.fake.calls.length, 3);
  assert.equal(before.fake.calls.length, 2, 'the old path decoded no referee audio');
});

test('a referee that cannot confirm the joint keeps both texts and reports joinFallback', async () => {
  const overlap = segmentOverlapSamples(DEFAULT_SEGMENT_OVERLAP_MS);
  const fake = scriptedFinal({
    totalSamples: TOTAL,
    words: CROSS_WORDS,
    // The joint decode of [2.000-0.8 s, 2.000+1.6 s] hears something unrelated.
    garbled: [{ start: 32000 - overlap, end: 32000 + 2 * overlap, text: '完全无关' }],
  });
  const { child, updates } = harness({ finalRecognizer: fake, asrSegmentOverlapMs: DEFAULT_SEGMENT_OVERLAP_MS });
  await feed(child, fake.audio);
  const finalEvent = updates.find((event) => typeof event.final === 'string');
  assert.ok(finalEvent);
  assert.equal(finalEvent.joinFallback, true, 'the unsafe join is reported, not hidden');
  assert.equal(finalEvent.final, '甲乙丙丁橙子戊橙子戊己', 'fallback duplicates instead of losing text');
  assert.equal(finalEvent.final.split('橙子').length - 1, 2, 'both copies are kept: duplication, never loss');
  assert.equal(finalEvent.refined, true, 'the offline text is still delivered');
});

test('a short utterance still uses one decode and the unchanged text', async () => {
  const total = SAMPLE_RATE; // 1 s < decodeCapSec
  const fake = scriptedFinal({ totalSamples: total, words: [{ start: 2000, end: 9000, text: '短句结果', stub: ['短', '果'] }] });
  const { child, updates } = harness({ finalRecognizer: fake, asrSegmentOverlapMs: DEFAULT_SEGMENT_OVERLAP_MS, endpointAtSamples: total });
  await feed(child, fake.audio);
  const finalEvent = updates.find((event) => typeof event.final === 'string');
  assert.ok(finalEvent);
  assert.equal(fake.calls.length, 1, 'a short utterance is one offline decode');
  assert.equal(fake.calls[0][0], 0);
  assert.equal(fake.calls[0][1], total);
  assert.equal(finalEvent.final, '短句结果');
  assert.equal(finalEvent.joinFallback, undefined);
  assert.equal(finalEvent.truncated, undefined);
});

test('joinFallback only rides along when the joined text is the one delivered', async () => {
  const total = 100 * SAMPLE_RATE; // beyond the 90 s accurate-pass cap
  const overlap = segmentOverlapSamples(DEFAULT_SEGMENT_OVERLAP_MS);
  const words = [{ start: 29600, end: 34400, text: '橙子', stub: ['成', '字'] }];
  // An unrelated referee forces a fallback join at the first joint.
  const build = () => scriptedFinal({
    totalSamples: total,
    words,
    garbled: [{ start: 32000 - overlap, end: 32000 + 2 * overlap, text: '完全无关' }],
  });

  // Capped at 90 s: the streaming text is authoritative, so the join detail must not leak out.
  const capped = build();
  const cappedHarness = harness({
    finalRecognizer: capped,
    asrSegmentOverlapMs: DEFAULT_SEGMENT_OVERLAP_MS,
    endpointAtSamples: total,
    streamText: '流式草稿',
  });
  await feed(cappedHarness.child, capped.audio);
  const cappedFinal = cappedHarness.updates.find((event) => typeof event.final === 'string');
  assert.ok(cappedFinal);
  assert.equal(cappedFinal.refined, false, 'the offline pass only saw the capped prefix');
  assert.equal(cappedFinal.joinFallback, undefined, 'no join detail on a text that was not joined');
  assert.ok(
    cappedFinal.truncated === true || cappedFinal.offlineLimited === true,
    'the cap itself is still reported, independently of the join fields',
  );

  // Same audio with a big enough cap: the fallback join is delivered and must be reported.
  const adopted = build();
  const adoptedHarness = harness({
    finalRecognizer: adopted,
    asrSegmentOverlapMs: DEFAULT_SEGMENT_OVERLAP_MS,
    endpointAtSamples: total,
    maxUtteranceSec: 120,
  });
  await feed(adoptedHarness.child, adopted.audio);
  const adoptedFinal = adoptedHarness.updates.find((event) => typeof event.final === 'string');
  assert.ok(adoptedFinal);
  assert.equal(adoptedFinal.refined, true);
  assert.equal(adoptedFinal.joinFallback, true, 'the fallback join is reported');
  assert.equal(adoptedFinal.truncated, undefined, 'the two features do not overwrite each other');
});

// ---------------------------------------------------------------------------------------------
// the checker's own verdict must catch duplication (counter-examples)
// ---------------------------------------------------------------------------------------------
const MANIFEST = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'asr-cutpoint', 'manifest.json'), 'utf8'),
);
const CHECKS = buildChecks(MANIFEST.checks);
const EXPECTED = MANIFEST.expectedText;

function verdictOf(segmentedText, fallbackCount = 0) {
  return evaluateVersion({
    baselineText: EXPECTED,
    segmentedText,
    legacyText: segmentedText,
    checks: CHECKS,
    expectedText: EXPECTED,
    fallbackCount,
  });
}

test('the counter-example set is judged PASS before any damage is injected', () => {
  const evaluation = verdictOf(EXPECTED);
  assert.equal(evaluation.verdict, 'PASS');
  assert.equal(evaluation.markerHit, evaluation.markerTotal);
  assert.deepEqual(evaluation.duplication, { checked: true, blocks: [] });
});

test('a duplicated tail (the seam pasted in twice) is judged FAIL', () => {
  const damaged = `${EXPECTED}${EXPECTED.slice(-24)}`;
  const evaluation = verdictOf(damaged);
  assert.equal(evaluation.verdict, 'FAIL');
  assert.ok(evaluation.duplication.blocks.length > 0, 'the repeated block is detected');
  assert.ok(evaluation.failures.some((item) => item.key === 'tail'), 'the closing phrase appears twice');
});

test('a duplicated head (the next piece pasted in twice) is judged FAIL', () => {
  const damaged = `${EXPECTED.slice(0, 24)}${EXPECTED}`;
  const evaluation = verdictOf(damaged);
  assert.equal(evaluation.verdict, 'FAIL');
  assert.ok(evaluation.duplication.blocks.length > 0);
  assert.ok(evaluation.failures.some((item) => item.key === 'numbers'), 'the numbers repeat too');
});

test('a marker that survives twice is judged FAIL, not "found"', () => {
  // Not adjacent, so the duplicate-block detector cannot see it: only the exact count can.
  const damaged = `${EXPECTED}橙子`;
  const evaluation = verdictOf(damaged);
  assert.equal(evaluation.verdict, 'FAIL');
  const marker = evaluation.failures.find((item) => item.key === 'marker:橙子');
  assert.ok(marker, 'the marker check fails');
  assert.equal(marker.actual, 2);
  assert.equal(marker.wanted, 1);
  // The old "contains" rule would have passed it: that is exactly why the count is exact now.
  assert.equal(MANIFEST.checks.markers.every((text) => damaged.includes(text)), true);
});

test('one extra 非常 is judged FAIL', () => {
  const damaged = EXPECTED.replace('这一点非常关键', '这一点非常非常关键');
  assert.notEqual(damaged, EXPECTED, 'the fixture text is unchanged');
  const evaluation = verdictOf(damaged);
  assert.equal(evaluation.verdict, 'FAIL');
  assert.equal(evaluation.failures.find((item) => item.key === 'repetition')?.actual, 6);
});

test('a fallback join without damage is reported as PASS(回退), not as a real fix', () => {
  assert.equal(verdictOf(EXPECTED, 0).verdict, 'PASS');
  assert.equal(verdictOf(EXPECTED, 1).verdict, 'PASS(回退)');
});
