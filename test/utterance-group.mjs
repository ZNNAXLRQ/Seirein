/**
 * Continuous-speech batch 1: delivery-side `utteranceGroup`.
 *
 * A natural-silence endpoint opens a 300 ms commit buffer. Audio or a new streaming partial inside
 * that window is the same turn continuing: the timer is cancelled and the next fragment joins the
 * group. An internal length cut (`max-duration`, offline segmentation, capture anomaly) never
 * delivers on its own. With no continuation, the fragments' text is concatenated in capture order
 * and delivered exactly once. Cancellation/stop drops the buffered group; nothing arrives late.
 *
 * All tests drive the worker path (the same path every `hearing.*` observation is emitted on). No
 * microphone, ffmpeg, sherpa model or real decode thread is used: the child process, streaming
 * recognizer and worker thread are injected fakes.
 *
 * Run: node --test test/utterance-group.mjs
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import test from 'node:test';

import {
  DEFAULT_GROUP_COMMIT_MS,
  DEFAULT_GROUP_RESUME_GRACE_MS,
  GROUP_RESUME_MIN_VOICE_MS,
  parseUtteranceId,
  startHearing,
} from '../src/host/hearing/hearing.js';

const SAMPLE_RATE = 16000;
const execFileAsync = promisify(execFile);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `predicate()` is true; a missed deadline fails the test instead of hanging it. */
async function until(predicate, label, timeoutMs = 2500) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await delay(5);
  }
}

/** ffmpeg stand-in: the test writes PCM into `stdout`. */
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

/** A 440 Hz tone at -12 dBFS: loud enough to pass the RMS gate. */
function tone(ms) {
  const samples = new Int16Array(Math.round((SAMPLE_RATE * ms) / 1000));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.round(Math.sin((2 * Math.PI * 440 * index) / SAMPLE_RATE) * 0.25 * 32767);
  }
  const buffer = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) buffer.writeInt16LE(samples[index], index * 2);
  return buffer;
}

/** The same tone at -60 dBFS: too quiet for the audio continuation signal, still a streaming text. */
function quietTone(ms) {
  const samples = new Int16Array(Math.round((SAMPLE_RATE * ms) / 1000));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.round(Math.sin((2 * Math.PI * 440 * index) / SAMPLE_RATE) * 0.001 * 32767);
  }
  const buffer = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) buffer.writeInt16LE(samples[index], index * 2);
  return buffer;
}

/** One capture-sized chunk: a short loud blip followed by silence (the reported counterexample). */
function blipChunk(blipMs, totalMs) {
  const blip = tone(blipMs);
  const totalBytes = Math.round((SAMPLE_RATE * totalMs) / 1000) * 2;
  return Buffer.concat([blip, Buffer.alloc(Math.max(0, totalBytes - blip.length))]);
}

/**
 * Scripted streaming pass: `script[i]` is how many samples fragment `i` must reach before its
 * endpoint, and what streaming text it produced. `reset()` moves to the next fragment.
 */
function scriptedStreaming(script) {
  return {
    createStream: () => ({
      samples: 0,
      epoch: 0,
      acceptWaveform({ samples }) {
        this.samples += samples.length;
      },
    }),
    isReady: () => false,
    decode: () => {},
    getResult: (stream) => ({ text: stream.samples > 0 ? (script[stream.epoch]?.text ?? '') : '' }),
    isEndpoint: (stream) => {
      const entry = script[stream.epoch];
      return entry !== undefined && stream.samples >= entry.samples;
    },
    reset(stream) {
      stream.samples = 0;
      stream.epoch += 1;
    },
  };
}

/** Worker stand-in: one scripted refined text per decode request, echoed with a decode task id. */
function fakeWorker(texts) {
  const queue = [...texts];
  const worker = new EventEmitter();
  worker.messages = [];
  worker.unref = () => {};
  worker.terminate = () => {
    worker.emit('exit', null);
  };
  worker.postMessage = (message) => {
    worker.messages.push(message);
    const text = queue.length > 0 ? queue.shift() : '';
    const utteranceId = message.utteranceId ?? null;
    setImmediate(() => worker.emit('message', {
      type: 'result',
      id: message.id,
      utteranceId,
      segmentIds: utteranceId === null ? ['s0'] : [`${utteranceId}:s0`],
      text,
      joinFallback: false,
    }));
  };
  return worker;
}

/** Start one fake hearing session on the worker path. */
function startSession({ script, texts, commitMs = undefined, resumeGraceMs = undefined } = {}) {
  const child = new FakeChild();
  const updates = [];
  const events = [];
  const worker = fakeWorker(texts);
  const hearing = startHearing({
    ffmpegPath: 'ffmpeg-not-used',
    modelDir: 'models-not-used',
    finalModelDir: '',
    device: 'fake-device',
    recognizer: scriptedStreaming(script),
    asrWorkerFactory: () => worker,
    spawnProcess: () => child,
    ...(commitMs === undefined ? {} : { asrGroupCommitMs: commitMs }),
    ...(resumeGraceMs === undefined ? {} : { resumeGraceMs }),
    onUpdate: (event) => updates.push(event),
    onEvent: (type, payload) => events.push({ type, payload }),
  });
  const finals = () => updates.filter((event) => typeof event.final === 'string');
  const ofType = (type) => events.filter((event) => event.type === type);
  const details = () => ofType('hearing.endpoint.detail').map((event) => event.payload);
  return { child, hearing, updates, events, finals, ofType, details };
}

const ENDPOINT = (ms) => Math.round((SAMPLE_RATE * ms) / 1000);

// ---------------------------------------------------------------------------
// 1. One fragment, natural end → delivered once, 300 ms later
// ---------------------------------------------------------------------------

test('1. 单片段自然结束：300ms 后投递一次，只发一条 group.committed', async () => {
  assert.equal(DEFAULT_GROUP_COMMIT_MS, 300, 'the shipping buffer is 300 ms');
  const session = startSession({
    script: [{ samples: ENDPOINT(900), text: '第一句' }],
    texts: ['第一句'],
  });

  session.child.stdout.write(tone(900));
  await until(() => session.details().length === 1, 'the natural endpoint');
  const [endpoint] = session.details();
  assert.equal(endpoint.endpointReason, 'silence', 'streaming words then trailing silence = natural end');
  assert.equal(endpoint.audioMs, 900);
  assert.equal(session.finals().length, 0, 'nothing is delivered on the endpoint itself');

  await delay(120);
  assert.equal(session.finals().length, 0, 'still inside the 300 ms commit buffer');

  await until(() => session.finals().length === 1, 'the buffered delivery');
  const [final] = session.finals();
  assert.equal(final.final, '第一句', 'the delivery text is unchanged');
  assert.equal(parseUtteranceId(final.utteranceId).seq, 1);

  const committed = session.ofType('hearing.group.committed');
  assert.equal(committed.length, 1, 'exactly one commit for one group');
  assert.equal(committed[0].payload.chars, '第一句'.length);
  assert.ok(committed[0].payload.bufferedMs >= 250, `buffer elapsed (${committed[0].payload.bufferedMs} ms)`);
  assert.ok(committed[0].payload.bufferedMs <= 1000, 'no seconds-level wait was added');
  assert.equal(session.ofType('hearing.group.formed').length, 1);

  const group = session.hearing.stats().group;
  assert.equal(group.id, committed[0].payload.groupId);
  assert.deepEqual(group.segmentIds, ['seg-1']);
  assert.deepEqual(group.taskIds, [1], 'the worker decode task id is kept on the group');
  assert.equal(group.deliveryId, 1, 'one delivery id was assigned');
  assert.equal(group.state, 'committed');
  session.hearing.stop();
});

// ---------------------------------------------------------------------------
// 2. max-duration internal cut → keep collecting, merge later, deliver once
// ---------------------------------------------------------------------------

test('2. max-duration 内部切段：不投递，继续收集，最终合并投递一次', async () => {
  const session = startSession({
    script: [
      { samples: ENDPOINT(20_000), text: '前半句' },
      { samples: ENDPOINT(600), text: '后半句' },
    ],
    texts: ['前半句', '后半句'],
  });

  session.child.stdout.write(tone(20_000));
  await until(() => session.details().length === 1, 'the length-cut endpoint');
  const [cut] = session.details();
  assert.equal(cut.endpointReason, 'max-duration', 'the 20 s rule ended this fragment');
  assert.equal(cut.audioMs, 20_000);

  await delay(400);
  assert.equal(session.finals().length, 0, 'an internal length cut never delivers on its own');
  assert.equal(session.ofType('hearing.group.committed').length, 0);
  assert.deepEqual(session.hearing.stats().group.segmentIds, ['seg-1'], 'the same group is still collecting');

  session.child.stdout.write(tone(600));
  await until(() => session.details().length === 2, 'the natural endpoint of the second fragment');
  assert.equal(session.details()[1].endpointReason, 'silence');

  await until(() => session.finals().length === 1, 'the merged delivery');
  assert.equal(session.finals().length, 1, 'one delivery for both fragments');
  assert.equal(session.finals()[0].final, '前半句后半句', 'text is concatenated in capture order');

  const committed = session.ofType('hearing.group.committed');
  assert.equal(committed.length, 1);
  assert.equal(committed[0].payload.chars, '前半句后半句'.length);
  const group = session.hearing.stats().group;
  assert.deepEqual(group.segmentIds, ['seg-1', 'seg-2']);
  assert.deepEqual(group.taskIds, [1, 2], 'both decode tasks belong to the group');
  session.hearing.stop();
});

// ---------------------------------------------------------------------------
// 3. Continuation inside the buffer → two fragments, one delivery
// ---------------------------------------------------------------------------

test('3. 缓冲内续说：取消计时，合并两段，只投递一次', async () => {
  const session = startSession({
    script: [
      { samples: ENDPOINT(600), text: '前半句' },
      { samples: ENDPOINT(600), text: '后半句' },
    ],
    texts: ['前半句', '后半句'],
  });

  session.child.stdout.write(tone(600));
  await until(() => session.details().length === 1, 'the first natural endpoint');
  await delay(100);
  assert.equal(session.finals().length, 0, 'the buffer is still open');

  // The continuation arrives before 300 ms: the audio itself cancels the timer.
  session.child.stdout.write(tone(600));
  await until(() => session.details().length === 2, 'the second endpoint');
  assert.equal(session.finals().length, 0, 'the first fragment was not delivered early');

  await until(() => session.finals().length === 1, 'the single merged delivery');
  assert.equal(session.finals().length, 1);
  assert.equal(session.finals()[0].final, '前半句后半句');
  const committed = session.ofType('hearing.group.committed');
  assert.equal(committed.length, 1, 'one group, one commit');
  assert.equal(session.ofType('hearing.group.formed').length, 1, 'the continuation did not form a second group');
  assert.deepEqual(session.hearing.stats().group.segmentIds, ['seg-1', 'seg-2']);
  session.hearing.stop();

  // The other signal: a quiet continuation (below the audio floor) is detected from the streaming
  // partial alone. Without it the 300 ms timer would fire during the 350 ms wait and deliver A.
  const quiet = startSession({
    script: [
      { samples: ENDPOINT(600), text: 'A' },
      { samples: ENDPOINT(1000), text: 'B' },
    ],
    texts: ['A', 'B'],
  });
  quiet.child.stdout.write(tone(600));
  await until(() => quiet.details().length === 1, 'the audio endpoint');
  quiet.child.stdout.write(quietTone(400));
  await delay(350);
  assert.equal(quiet.finals().length, 0, 'the streaming partial cancelled the timer while audio was quiet');
  quiet.child.stdout.write(quietTone(600));
  await until(() => quiet.details().length === 2, 'the quiet fragment endpoint');
  await until(() => quiet.finals().length === 1, 'the merged quiet delivery');
  assert.equal(quiet.finals()[0].final, 'AB');
  assert.equal(quiet.ofType('hearing.group.committed').length, 1);
  quiet.hearing.stop();
});

// ---------------------------------------------------------------------------
// 4. A gap longer than the buffer → two deliveries, never a false merge
// ---------------------------------------------------------------------------

test('4. 两段相隔 >300ms 且无续说：两次投递，不误合并', async () => {
  const session = startSession({
    script: [
      { samples: ENDPOINT(600), text: '第一段' },
      { samples: ENDPOINT(600), text: '第二段' },
    ],
    texts: ['第一段', '第二段'],
  });

  session.child.stdout.write(tone(600));
  await until(() => session.finals().length === 1, 'the first delivery');
  assert.equal(session.finals()[0].final, '第一段');
  const firstGroup = session.hearing.stats().group.id;

  session.child.stdout.write(tone(600));
  await until(() => session.finals().length === 2, 'the second delivery');
  assert.deepEqual(session.finals().map((event) => event.final), ['第一段', '第二段']);
  assert.equal(session.ofType('hearing.group.committed').length, 2, 'two commits, two turns');
  const secondGroup = session.hearing.stats().group.id;
  assert.notEqual(firstGroup, secondGroup, 'the second fragment opened its own group');
  assert.deepEqual(session.hearing.stats().group.segmentIds, ['seg-2']);
  session.hearing.stop();
});

// ---------------------------------------------------------------------------
// 5. Cancel / stop / session switch → buffered text is dropped, never late
// ---------------------------------------------------------------------------

test('5. 取消/停止听觉/切换会话：缓冲丢弃，无迟到投递', async () => {
  for (const reason of ['stopped', 'cancelled', 'session-switch']) {
    const session = startSession({
      script: [{ samples: ENDPOINT(600), text: '不该迟到的一句话' }],
      texts: ['不该迟到的一句话'],
    });
    session.child.stdout.write(tone(600));
    await until(() => session.details().length === 1, `${reason}: the buffered endpoint`);
    assert.equal(session.finals().length, 0);

    session.hearing.stop(reason);
    await delay(450);
    assert.equal(session.finals().length, 0, `${reason}: no late delivery after the buffer was dropped`);
    const dropped = session.ofType('hearing.group.dropped');
    assert.equal(dropped.length, 1, `${reason}: one group.dropped row`);
    assert.equal(dropped[0].payload.reason, reason);
    assert.equal(session.ofType('hearing.group.committed').length, 0);
  }
});

// ---------------------------------------------------------------------------
// 6. Every observation carries the required fields; unmeasured silence is null
// ---------------------------------------------------------------------------

test('6. 观测字段齐全；trailingSilenceMs 未测量时为 null（不编造）', async () => {
  const session = startSession({
    script: [
      { samples: ENDPOINT(20_000), text: '前半句' },
      { samples: ENDPOINT(600), text: '后半句' },
      { samples: ENDPOINT(600), text: '第三段' },
    ],
    texts: ['前半句', '后半句', '第三段'],
  });

  session.child.stdout.write(tone(20_000));
  await until(() => session.details().length === 1, 'the first endpoint');
  session.child.stdout.write(tone(600));
  await until(() => session.finals().length === 1, 'the merged delivery');

  const [cut, natural] = session.details();
  for (const detail of [cut, natural]) {
    for (const key of ['utteranceId', 'endpointReason', 'audioMs', 'trailingSilenceMs', 'segmentId', 'groupId']) {
      assert.ok(Object.hasOwn(detail, key), `endpoint.detail has ${key}`);
    }
    assert.equal(detail.level, 'debug');
    // No VAD model in this fixture: the value is not measured, so it is null — never a fabricated 0.
    assert.equal(detail.trailingSilenceMs, null);
    assert.equal(typeof detail.audioMs, 'number');
    assert.equal(typeof detail.segmentId, 'string');
    assert.match(detail.groupId, /^ug-\d+$/u);
    assert.equal(typeof detail.offlineSplit, 'boolean', 'offline segmentation is observable on its own');
  }
  assert.equal(cut.endpointReason, 'max-duration');
  assert.equal(cut.audioMs, 20_000);
  assert.equal(cut.offlineSplit, true, '20 s exceeds the 15 s offline piece cap');
  assert.equal(natural.endpointReason, 'silence');
  assert.equal(natural.audioMs, 600);
  assert.equal(natural.offlineSplit, false, 'a 600 ms fragment is one offline piece');
  assert.equal(cut.groupId, natural.groupId, 'both fragments name the same group');

  const formed = session.ofType('hearing.group.formed')[0]?.payload;
  assert.deepEqual(Object.keys(formed ?? {}).sort(), ['chars', 'groupId', 'level', 'segmentIds']);
  assert.deepEqual(formed.segmentIds, ['seg-1']);
  assert.equal(formed.chars, '前半句'.length);

  const committed = session.ofType('hearing.group.committed')[0]?.payload;
  assert.deepEqual(Object.keys(committed ?? {}).sort(), ['bufferedMs', 'chars', 'groupId', 'level', 'reason']);
  assert.equal(committed.chars, '前半句后半句'.length);
  assert.equal(committed.reason, 'silence');
  assert.ok(Number.isFinite(committed.bufferedMs));

  // A final buffered fragment dropped by stop completes the observation set.
  session.child.stdout.write(tone(600));
  await until(() => session.details().length === 3, 'the third endpoint');
  session.hearing.stop();
  const dropped = session.ofType('hearing.group.dropped')[0]?.payload;
  assert.deepEqual(Object.keys(dropped ?? {}).sort(), ['groupId', 'level', 'reason']);
  assert.equal(dropped.reason, 'stopped');
});

// ---------------------------------------------------------------------------
// 7. A 20 ms blip with no text → the commit timer is NOT cancelled
// ---------------------------------------------------------------------------

test('7. 20ms 无文字 blip：不撤销提交计时，300ms 后按原文本提交', async () => {
  const session = startSession({
    script: [{ samples: ENDPOINT(600), text: '第一句' }],
    texts: ['第一句'],
  });

  session.child.stdout.write(tone(600));
  await until(() => session.details().length === 1, 'the natural endpoint');
  assert.equal(session.details()[0].endpointReason, 'silence');

  // One 128 ms capture chunk whose only loud part is a 20 ms blip with no decoded text: a per-chunk
  // RMS gate (the old signal) sees this chunk above the floor, a per-frame gate does not.
  session.child.stdout.write(blipChunk(20, 128));
  await delay(40);

  const cancelled = session.ofType('hearing.group.resume-cancelled');
  assert.equal(cancelled.length, 1, 'the rejected continuation is reported');
  assert.equal(cancelled[0].payload.reason, 'blip');
  assert.equal(typeof cancelled[0].payload.afterMs, 'number');
  assert.ok(cancelled[0].payload.afterMs >= 0 && cancelled[0].payload.afterMs <= 300,
    `blip judged inside the buffer (${cancelled[0].payload.afterMs} ms)`);
  assert.equal(session.hearing.stats().group.state, 'buffering', 'the blip did not cancel the timer');
  assert.equal(session.finals().length, 0);

  await until(() => session.finals().length === 1, 'the normal buffered delivery');
  assert.equal(session.finals()[0].final, '第一句', 'the original text is delivered unchanged');
  assert.equal(session.ofType('hearing.group.committed').length, 1);
  assert.equal(session.ofType('hearing.group.rearmed').length, 0, 'never re-entered collecting');
  assert.equal(session.hearing.stats().group.state, 'committed');
  session.hearing.stop();
});

// ---------------------------------------------------------------------------
// 8. Sustained voice + a new partial → buffer cancelled, continuation merged
// ---------------------------------------------------------------------------

test('8. 持续语音 ≥120ms + partial：撤销计时并等待续说，随后合并两段一次投递', async () => {
  const session = startSession({
    script: [
      { samples: ENDPOINT(600), text: '前半句' },
      { samples: ENDPOINT(600), text: '后半句' },
    ],
    texts: ['前半句', '后半句'],
  });

  session.child.stdout.write(tone(600));
  await until(() => session.details().length === 1, 'the first endpoint');

  // 7 × 20 ms of speech: the partial arrives at once and the sustained run confirms at 120 ms.
  for (let index = 0; index < 7; index += 1) session.child.stdout.write(tone(20));
  await delay(200); // past the 300 ms commit buffer, so only a cancelled timer can be waiting
  assert.equal(session.finals().length, 0, 'the commit timer was cancelled, not fired');
  assert.equal(session.hearing.stats().group.state, 'collecting', 'the group waits for the continuation');
  assert.equal(session.ofType('hearing.group.rearmed').length, 0, 'the confirmed resume needs no rearm');
  assert.equal(session.ofType('hearing.group.committed').length, 0);

  // The rest of the continuation reaches its endpoint inside the grace window.
  session.child.stdout.write(tone(460));
  await until(() => session.details().length === 2, 'the continuation endpoint');
  await until(() => session.finals().length === 1, 'the single merged delivery');
  assert.equal(session.finals().length, 1);
  assert.equal(session.finals()[0].final, '前半句后半句', 'capture order is preserved');
  assert.equal(session.ofType('hearing.group.committed').length, 1);
  assert.equal(session.ofType('hearing.group.formed').length, 1, 'no second group was formed');
  assert.deepEqual(session.hearing.stats().group.segmentIds, ['seg-1', 'seg-2']);
  assert.deepEqual(session.hearing.stats().group.taskIds, [1, 2]);
  session.hearing.stop();
});

// ---------------------------------------------------------------------------
// 9. Cancelled buffer + 500 ms of no continuation → re-arm, deliver the original text
// ---------------------------------------------------------------------------

test('9. 撤销后 500ms 无续说：重新武装并提交原文本，事件 rearmed', async () => {
  assert.equal(DEFAULT_GROUP_RESUME_GRACE_MS, 500, 'the shipping recovery window is 500 ms');
  assert.equal(GROUP_RESUME_MIN_VOICE_MS, 120, 'a single frame is never sustained evidence');
  // No second script entry: the post-endpoint speech decodes to no text, so only the sustained
  // audio can confirm the (cancelled) resume.
  const session = startSession({
    script: [{ samples: ENDPOINT(600), text: '第一句' }],
    texts: ['第一句'],
  });

  session.child.stdout.write(tone(600));
  await until(() => session.details().length === 1, 'the natural endpoint');

  // 7 × 20 ms = 140 ms of speech confirms a resume, then it stops.
  for (let index = 0; index < 7; index += 1) session.child.stdout.write(tone(20));
  await delay(250);
  assert.equal(session.finals().length, 0, 'a cancelled buffer never delivers early');
  assert.equal(session.hearing.stats().group.state, 'collecting');
  assert.equal(session.ofType('hearing.group.rearmed').length, 0, 'still inside the 500 ms grace');

  await until(() => session.ofType('hearing.group.rearmed').length === 1, 'the bounded re-arm', 1500);
  const rearmed = session.ofType('hearing.group.rearmed')[0].payload;
  assert.equal(rearmed.reason, 'unconfirmed-resume');
  assert.equal(rearmed.chars, '第一句'.length);
  assert.match(rearmed.groupId, /^ug-\d+$/u);
  const unconfirmed = session.ofType('hearing.group.resume-cancelled')
    .filter((event) => event.payload.reason === 'unconfirmed');
  assert.equal(unconfirmed.length, 1, 'the unconfirmed resume is reported before the re-arm');
  assert.ok(unconfirmed[0].payload.afterMs >= 450,
    `the grace window really elapsed (${unconfirmed[0].payload.afterMs} ms)`);

  // The re-armed commit timer delivers the original text on its own, no next endpoint needed.
  await until(() => session.finals().length === 1, 'the re-armed delivery');
  assert.equal(session.finals()[0].final, '第一句');
  assert.equal(session.ofType('hearing.group.committed').length, 1);
  assert.equal(session.hearing.stats().group.state, 'committed');
  session.hearing.stop();
});

// ---------------------------------------------------------------------------
// 10. Cancelled buffer + a real continuation → merged, one delivery
// ---------------------------------------------------------------------------

test('10. 撤销后确有续说：合并两段，一次投递', async () => {
  const session = startSession({
    script: [
      { samples: ENDPOINT(600), text: '前半句' },
      { samples: ENDPOINT(1000), text: '后半句' },
    ],
    texts: ['前半句', '后半句'],
  });

  session.child.stdout.write(tone(600));
  await until(() => session.details().length === 1, 'the first endpoint');

  // Below-floor audio: only the new streaming partial confirms the continuation.
  session.child.stdout.write(quietTone(300));
  await delay(200);
  assert.equal(session.finals().length, 0, 'the cancelled buffer did not deliver early');
  assert.equal(session.hearing.stats().group.state, 'collecting');

  // The continuation arrives inside the grace window and reaches its own endpoint.
  session.child.stdout.write(quietTone(700));
  await until(() => session.details().length === 2, 'the continuation endpoint');
  await until(() => session.finals().length === 1, 'the single merged delivery');
  assert.equal(session.finals().length, 1, 'one delivery for the whole turn');
  assert.equal(session.finals()[0].final, '前半句后半句');
  assert.equal(session.ofType('hearing.group.committed').length, 1);
  assert.equal(session.ofType('hearing.group.rearmed').length, 0, 'the resume was confirmed in time');
  assert.deepEqual(session.hearing.stats().group.segmentIds, ['seg-1', 'seg-2']);
  session.hearing.stop();
});

// ---------------------------------------------------------------------------
// 11. Regression: the hearing/ASR/dialogue suites this batch must not disturb
// ---------------------------------------------------------------------------

test('11. 回归：hearing-*、asr-worker、asr-tags、noise-shadow、dialogue-capture', async () => {
  const files = [
    'test/hearing-exit.mjs',
    'test/hearing-routing.mjs',
    'test/hearing-short-utterance.mjs',
    'test/hearing-ui.mjs',
    'test/asr-worker.mjs',
    'test/asr-tags.mjs',
    'test/noise-shadow.mjs',
    'test/dialogue-capture.mjs',
  ];
  // Strip the parent runner's marker: otherwise the nested `node --test` runs as a test-worker child.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const { stdout } = await execFileAsync(process.execPath, ['--test', ...files], {
    cwd: process.cwd(),
    env,
    maxBuffer: 8 * 1024 * 1024,
    timeout: 180_000,
  });
  assert.match(stdout, /ℹ fail 0/u, 'the regression suite reported zero failures');
  const passed = Number(stdout.match(/ℹ pass (\d+)/u)?.[1] ?? Number.NaN);
  assert.ok(Number.isFinite(passed) && passed >= 50, `all regression tests ran and passed (${passed})`);
}, { timeout: 200_000 });
