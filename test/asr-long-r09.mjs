/**
 * R09 regression: the ASR final pass must cover the whole utterance, not the first
 * `decodeCapSec` seconds. Long audio is decoded in fixed-size pieces and concatenated;
 * buffering stays memory-bounded and an over-cap tail is flagged as truncated.
 *
 * No microphone, ffmpeg or sherpa model is used: the recognizers and the child process are
 * injected, and the audio is a synthetic 440 Hz tone.
 *
 * Run: node --test test/asr-long-r09.mjs
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { annotateTranscript, DEFAULT_SEGMENT_OVERLAP_MS, joinSegmentTexts, planSegmentedDecodes, segmentOverlapSamples, startHearing, truncationNotice } from '../src/host/hearing/hearing.js';

const SAMPLE_RATE = 16000;
const TONE = (() => {
  const samples = new Int16Array(SAMPLE_RATE);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.round(Math.sin((2 * Math.PI * 440 * index) / SAMPLE_RATE) * 0.25 * 32767);
  }
  const buffer = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) buffer.writeInt16LE(samples[index], index * 2);
  return buffer;
})();

/** ffmpeg stand-in: the test writes PCM into `stdout` and the hearing loop treats it as capture. */
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

/** Streaming stand-in: endpoint fires only once the configured amount of audio arrived. */
function fakeStreaming(endpointAtSamples, text = '流式草稿') {
  return {
    createStream: () => ({
      samples: 0,
      acceptWaveform({ samples }) {
        this.samples += samples.length;
      },
    }),
    isReady: () => false,
    decode: () => {},
    getResult: (stream) => ({ text: stream.samples > 0 ? text : '' }),
    isEndpoint: (stream) => stream.samples >= endpointAtSamples,
    reset(stream) {
      stream.samples = 0;
    },
  };
}

/** Offline stand-in: records one entry per decode call and returns the scripted text. */
function fakeFinal(texts) {
  const calls = [];
  return {
    calls,
    createStream: () => ({
      samples: 0,
      acceptWaveform({ samples }) {
        this.samples = samples.length;
      },
    }),
    decode: () => {},
    getResult(stream) {
      calls.push(stream.samples);
      return { text: texts[calls.length - 1] ?? `段${calls.length}` };
    },
  };
}

function harness({ endpointAtSamples, finalTexts, streamingText, maxUtteranceSec = 90 }) {
  const child = new FakeChild();
  const final = fakeFinal(finalTexts);
  const updates = [];
  const hearing = startHearing({
    ffmpegPath: 'ffmpeg-not-used',
    modelDir: 'models-not-used',
    finalModelDir: '',
    device: 'fake-device',
    recognizer: fakeStreaming(endpointAtSamples, streamingText),
    finalRecognizer: final,
    spawnProcess: () => child,
    maxUtteranceSec,
    onUpdate: (event) => updates.push(event),
  });
  return { child, final, updates, hearing };
}

/** Feed `seconds` of 1 s tone chunks through the fake capture pipe, then let callbacks drain. */
async function feedSeconds(child, seconds) {
  for (let index = 0; index < seconds; index += 1) child.stdout.write(TONE);
  await new Promise((resolve) => setTimeout(resolve, 30));
}

const finalEvents = (updates) => updates.filter((event) => typeof event.final === 'string');

/**
 * The decode plan the final pass must follow. Overlapping pieces share audio with their
 * neighbours and each joint gets its own referee decode, so "every sample decoded exactly once"
 * is no longer the contract; the contract is that the union of the decoded ranges covers every
 * sample of the utterance at least once.
 */
function expectedPlan(totalSamples, { segmentSec = 15, overlapMs = DEFAULT_SEGMENT_OVERLAP_MS } = {}) {
  return planSegmentedDecodes(totalSamples, segmentSec * SAMPLE_RATE, segmentOverlapSamples(overlapMs));
}

const jobRange = (job) => (job.kind === 'segment' ? job.piece : job.joint);
const jobLength = (job) => jobRange(job).endSample - jobRange(job).startSample;

/** Union of [startSample, endSample) ranges: how far it reaches and which audio nobody decoded. */
function coverage(ranges) {
  const sorted = [...ranges].sort((left, right) => left.startSample - right.startSample);
  let reached = 0;
  const gaps = [];
  for (const range of sorted) {
    if (range.startSample > reached) gaps.push([reached, range.startSample]);
    reached = Math.max(reached, range.endSample);
  }
  return { reached, gaps };
}

test('a) 20 s input is decoded in pieces covering the whole sentence', async () => {
  const { child, final, updates } = harness({
    endpointAtSamples: 20 * SAMPLE_RATE,
    // One scripted text per planned decode, in plan order: piece 0, the referee of the joint
    // between them, then piece 1. The referee confirms the shared boundary text.
    finalTexts: ['这是第一段', '一段第二段', '第二段续写'],
  });
  await feedSeconds(child, 20);

  const events = finalEvents(updates);
  assert.equal(events.length, 1, 'one utterance yields one final update');
  const plan = expectedPlan(20 * SAMPLE_RATE);
  assert.ok(plan.jobs.length >= 3, `20 s spans two pieces plus a referee (got ${plan.jobs.length})`);
  assert.deepEqual(
    final.calls,
    plan.jobs.map(jobLength),
    'every planned decode ran once, in plan order, with the planned audio range',
  );
  const covered = coverage(plan.jobs.map(jobRange));
  assert.equal(covered.reached, 20 * SAMPLE_RATE, 'the decoded ranges reach the end of the utterance');
  assert.deepEqual(covered.gaps, [], 'no stretch of audio is left undecoded');
  assert.equal(events[0].final, '这是第一段第二段续写', 'joined text keeps both halves in order');
  assert.ok(!events[0].final.includes('第一段第一段'), 'no overlap is invented or removed');
  assert.equal(events[0].refined, true, 'the offline pass is still marked refined');
});

test('b) 3 s input keeps the old single-piece behavior', async () => {
  const { child, final, updates } = harness({
    endpointAtSamples: 3 * SAMPLE_RATE,
    finalTexts: ['短句结果'],
  });
  await feedSeconds(child, 3);

  const events = finalEvents(updates);
  assert.equal(final.calls.length, 1, 'a short utterance is one offline decode');
  assert.equal(final.calls[0], 3 * SAMPLE_RATE, 'the single piece is the complete utterance');
  assert.equal(events.length, 1);
  assert.equal(events[0].final, '短句结果');
  assert.equal(events[0].refined, true);
  assert.equal(events[0].truncated, undefined, 'short audio is never truncated');
});

test('c) durationMs reports the complete utterance, not the decoded-prefix length', async () => {
  const { child, updates } = harness({
    endpointAtSamples: 20 * SAMPLE_RATE,
    finalTexts: ['前半句', '后半句'],
  });
  await feedSeconds(child, 20);

  const events = finalEvents(updates);
  assert.equal(events[0].durationMs, 20_000, '20 s of audio reports 20 s, not 15 s');
});

test('d) audio beyond the 90 s hard cap is flagged truncated and the buffer stays bounded', async () => {
  const { child, final, updates, hearing } = harness({
    endpointAtSamples: 100 * SAMPLE_RATE,
    // The online pass heard nothing here, so the capped offline result is the only text and the
    // update is a real truncation (the online-complete case is covered by test f).
    streamingText: '',
    finalTexts: [],
    maxUtteranceSec: 90,
  });
  await feedSeconds(child, 100);

  const events = finalEvents(updates);
  assert.equal(events.length, 1);
  assert.equal(events[0].truncated, true, 'the final update marks the dropped tail');
  assert.equal(events[0].durationMs, 100_000, 'duration still reflects the full 100 s of audio');
  // Overlapping pieces decode shared audio more than once; the cap guarantees that no decode
  // reaches past the buffered prefix and that the prefix itself is fully covered.
  const plan = expectedPlan(90 * SAMPLE_RATE);
  assert.deepEqual(
    final.calls,
    plan.jobs.map(jobLength),
    'only the 90 s buffered prefix is decoded, following the plan',
  );
  assert.ok(
    Math.max(...final.calls) <= 90 * SAMPLE_RATE,
    'no single decode piece is longer than the 90 s buffer cap',
  );
  const covered = coverage(plan.jobs.map(jobRange));
  assert.equal(covered.reached, 90 * SAMPLE_RATE, 'the buffered prefix is covered end to end');
  assert.deepEqual(covered.gaps, [], 'no stretch of the prefix is left undecoded');
  assert.equal(hearing.stats().truncations, 1, 'the truncation is counted once per utterance');
  assert.equal(hearing.stats().bufferedSamples, 0, 'the buffer is released after finalizing');
  assert.equal(events[0].bufferedSamples, 90 * SAMPLE_RATE, 'the update reports the buffered prefix');
  assert.equal(events[0].maxUtteranceSec, 90, 'the update reports the cap that was hit');
  assert.equal(events[0].truncations, 1, 'the cumulative truncation counter rides along');
});

test('e) joinSegmentTexts concatenates non-overlapping segments without guessing', () => {
  // Audio ranges never overlap, so a repeated prefix is real speech, not a duplicate.
  assert.equal(joinSegmentTexts(['非常', '非常重要']), '非常非常重要');
  assert.equal(joinSegmentTexts(['test', 'testing']), 'test testing');
  assert.equal(joinSegmentTexts(['这是第一段', '第一段第二段']), '这是第一段第一段第二段');
  assert.equal(joinSegmentTexts(['  前半句 ', '', '后半句  ']), '前半句后半句');
});

test('f) a truncated offline pass never replaces the complete streaming text', async () => {
  const { child, updates } = harness({
    endpointAtSamples: 100 * SAMPLE_RATE,
    finalTexts: ['离线'],
    maxUtteranceSec: 90,
  });
  await feedSeconds(child, 100);

  const events = finalEvents(updates);
  assert.equal(events.length, 1);
  assert.equal(events[0].final, '流式草稿', 'the streaming pass heard the dropped tail');
  assert.equal(events[0].refined, false, 'the truncated offline result was not used');
  assert.equal(events[0].truncated, false, 'the complete online text is not truncated');
  assert.equal(events[0].offlineLimited, true, 'only the accurate pass lost audio');
  assert.equal(events[0].note, '离线精修仅覆盖前 90 秒', 'the limitation is logged, not spoken');
});

test('g) the truncation note is prefixed only for a truncated transcript', () => {
  assert.equal(annotateTranscript('内容', {}), '内容');
  assert.equal(
    annotateTranscript('内容', { truncated: true, maxUtteranceSec: 90 }),
    '（语音过长，已截断至 90 秒）\n内容',
  );
  assert.equal(truncationNotice(90), '（语音过长，已截断至 90 秒）');
});
