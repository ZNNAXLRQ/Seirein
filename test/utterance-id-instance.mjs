/**
 * Utterance identity is scoped to its capture instance: `<instanceId>:<seq>`.
 *
 * Why: two capture instances (a restart, or the mic lane and the loopback lane) both count from 1,
 * so the same plain number identified two different utterances. A log reader that joined rows by
 * `utteranceId` mixed a mic clip with a loopback clip and every per-utterance statistic was wrong.
 * The local sequence stays the internal order/Map key; only the outward id carries the instance.
 *
 * This suite pins:
 *  1. two launches with the same local seq produce different ids;
 *  2. the id format, a numeric `seq`, and the `parseUtteranceId` round trip;
 *  3. legacy plain-number ids still parse (`instanceId: null`) and invalid input returns null;
 *  4. every event that writes `utteranceId` writes the scoped format, in one instance;
 *  5. inside one instance the seq increments and never repeats; the existing dedupe is unchanged;
 *  6. two concurrent instances produce disjoint id sets while the delivered payload is unchanged.
 *
 * No microphone, ffmpeg, sherpa model or real thread is used: the child process, the streaming
 * recognizer, the VAD and the worker are fakes.
 *
 * Run: node --test test/utterance-id-instance.mjs
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { parseUtteranceId, startHearing } from '../src/host/hearing/hearing.js';

const SAMPLE_RATE = 16000;
/** `h<launch>-<short hash>:<seq>`: the outward form every new row must use. */
const ID_PATTERN = /^h\d+-[a-z0-9]{4}:\d+$/u;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `predicate()` is true; a missed deadline fails the test instead of hanging it. */
async function until(predicate, timeoutMs = 4000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('timed out waiting for the delivery');
    await delay(5);
  }
}

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

/** Streaming pass: the endpoint fires at the end of the constructed clip. */
function fakeStreaming({ endpointAtSamples, text }) {
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

/** Fake Silero detector: fixed speech ranges become available once their end is covered. */
function fakeVad({ segments = [] } = {}) {
  let fedSamples = 0;
  const pending = [];
  const queue = segments.map((segment) => ({ ...segment }));
  return {
    acceptWaveform(samples) {
      fedSamples += samples.length;
      const fedMs = (fedSamples * 1000) / SAMPLE_RATE;
      while (queue.length > 0 && queue[0].endMs <= fedMs) {
        const segment = queue.shift();
        const start = Math.round((segment.startMs * SAMPLE_RATE) / 1000);
        const length = Math.max(0, Math.round(((segment.endMs - segment.startMs) * SAMPLE_RATE) / 1000));
        pending.push({ start, samples: new Float32Array(length) });
      }
    },
    isEmpty: () => pending.length === 0,
    front: () => pending[0],
    pop: () => {
      pending.shift();
    },
    isDetected: () => false,
    reset: () => {
      pending.length = 0;
      queue.length = 0;
      fedSamples = 0;
    },
  };
}

/** Worker stand-in that echoes the request's utterance id, like `asr-worker.js` does. */
function fakeWorker(text) {
  const worker = new EventEmitter();
  worker.unref = () => {};
  worker.terminate = () => {
    worker.emit('exit', null);
  };
  worker.postMessage = (message) => {
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

/** Start one capture instance with every external dependency faked. */
function startSession({
  text = '', workerText = '', vadSegments = null, extra = {},
} = {}) {
  const child = new FakeChild();
  const events = [];
  const updates = [];
  const clip = tone(600);
  const hearing = startHearing({
    ffmpegPath: 'ffmpeg-not-used',
    modelDir: 'models-not-used',
    finalModelDir: '',
    device: 'fake-device',
    recognizer: fakeStreaming({ endpointAtSamples: clip.length / 2, text }),
    asrWorkerFactory: () => fakeWorker(workerText),
    spawnProcess: () => child,
    ...(vadSegments === null ? {} : { vadFactory: () => fakeVad({ segments: vadSegments }) }),
    onUpdate: (event) => updates.push(event),
    onEvent: (type, payload) => events.push({ type, payload }),
    ...extra,
  });
  return { hearing, child, clip, events, updates };
}

const finals = (session) => session.updates.filter((event) => typeof event.final === 'string');
const payloads = (session, type) => session.events
  .filter((event) => event.type === type)
  .map((event) => event.payload);

/** Every supplied row's `utteranceId` is a scoped id of `hearing.instanceId`. */
function assertScopedIds(rows, hearing, label) {
  assert.ok(rows.length > 0, `${label}: expected rows carrying utteranceId`);
  for (const { type, payload } of rows) {
    assert.equal(typeof payload.utteranceId, 'string', `${label}/${type}: id must be a string`);
    assert.match(payload.utteranceId, ID_PATTERN, `${label}/${type}: ${payload.utteranceId}`);
    const parsed = parseUtteranceId(payload.utteranceId);
    assert.equal(parsed.instanceId, hearing.instanceId, `${label}/${type}: wrong instance`);
    assert.ok(Number.isInteger(parsed.seq) && parsed.seq >= 1, `${label}/${type}: seq is a number`);
  }
}

const withId = (session) => session.events
  .filter((event) => event.payload !== null && typeof event.payload === 'object'
    && Object.hasOwn(event.payload, 'utteranceId'));

test('1) 启动两次、同一本地 seq：utteranceId 不同', async (t) => {
  const first = startSession({ text: '好', workerText: '好' });
  const ids = [];
  try {
    first.child.stdout.write(first.clip);
    await until(() => finals(first).length === 1);
    ids.push(finals(first)[0].utteranceId);
    first.hearing.stop();

    // A second launch: a brand-new instance whose local sequence starts over at 1.
    const second = startSession({ text: '好', workerText: '好' });
    try {
      second.child.stdout.write(second.clip);
      await until(() => finals(second).length === 1);
      ids.push(finals(second)[0].utteranceId);
      assert.notEqual(first.hearing.instanceId, second.hearing.instanceId);
    } finally {
      second.hearing.stop();
    }

    const [a, b] = ids.map((id) => parseUtteranceId(id));
    assert.equal(a.seq, 1);
    assert.equal(b.seq, 1, 'both launches count from 1');
    assert.notEqual(a.instanceId, b.instanceId);
    assert.notEqual(ids[0], ids[1], 'the same seq is not the same id across instances');
    t.diagnostic(`first=${ids[0]} second=${ids[1]} sameSeq=${a.seq}`);
  } finally {
    first.hearing.stop();
  }
});

test('2) 新格式 `<instanceId>:<seq>`：seq 是数字，parse 往返一致', async () => {
  const session = startSession({ text: '好', workerText: '好' });
  try {
    session.child.stdout.write(session.clip);
    await until(() => finals(session).length === 1);
    const delivered = finals(session)[0];
    const id = delivered.utteranceId;

    assert.match(id, ID_PATTERN);
    assert.equal(id, `${session.hearing.instanceId}:1`);

    const parsed = parseUtteranceId(id);
    assert.deepEqual(parsed, { instanceId: session.hearing.instanceId, seq: 1 });
    assert.equal(typeof parsed.seq, 'number');
    assert.equal(`${parsed.instanceId}:${parsed.seq}`, id, 'generation and parsing round-trip');

    // The shadow row and the delivery row name the same utterance with the same id.
    const [shadow] = payloads(session, 'hearing.noise.shadow');
    assert.equal(shadow.utteranceId, id);
    const [deliveryRow] = payloads(session, 'hearing.delivery');
    assert.equal(deliveryRow.utteranceId, id);
    assert.equal(deliveryRow.id, 1, 'the internal delivery slot stays the numeric seq');
  } finally {
    session.hearing.stop();
  }
});

test('3) 旧纯数字格式仍可解析；非法值返回 null', () => {
  // Current form, parsed back to its two parts.
  assert.deepEqual(parseUtteranceId('h3-141s:696'), { instanceId: 'h3-141s', seq: 696 });
  // Legacy data: a plain decimal id, as a string or as the number old logs hold.
  assert.deepEqual(parseUtteranceId('696'), { instanceId: null, seq: 696 });
  assert.deepEqual(parseUtteranceId(696), { instanceId: null, seq: 696 });
  assert.deepEqual(parseUtteranceId('0007'), { instanceId: null, seq: 7 });

  for (const bad of ['', '   ', 'abc', 'h3-141s', 'h3-141s:', ':696', 'h3-141s:6x6',
    'h3-141s:-1', 'h3-141s:1.5', '1.5', null, undefined, {}, []]) {
    assert.equal(parseUtteranceId(bad), null, `invalid id ${JSON.stringify(bad)} is not guessed`);
  }
});

test('4) 事件里所有 utteranceId 都是带实例前缀的格式', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'seirein-utterance-id-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // A "low evidence" clip (real VAD 0, empty streaming text, non-empty offline text, silence end):
  // it writes the noise / VAD / low-evidence / mic-shadow / retention rows in one utterance.
  const low = startSession({
    text: '',
    workerText: '还有。',
    vadSegments: [],
    extra: { retentionRoot: root, audioRetention: true },
  });
  try {
    low.child.stdout.write(low.clip);
    await until(() => finals(low).length === 1);
    await low.hearing.retention.flush();
    await delay(10);

    const types = new Set(low.events.map((event) => event.type));
    for (const type of ['hearing.endpoint.detail', 'hearing.vad.shadow', 'hearing.noise.shadow',
      'hearing.low-evidence.shadow', 'hearing.low-evidence.mic-shadow', 'hearing.audio.retained',
      'hearing.delivery']) {
      assert.ok(types.has(type), `expected a ${type} row`);
    }
    assertScopedIds(withId(low), low.hearing, 'low-evidence');
    assert.equal(finals(low)[0].utteranceId, `${low.hearing.instanceId}:1`);
  } finally {
    low.hearing.stop();
  }

  // The echo family: playback state + matching sounding text + zero real speech is a drop row.
  const echo = startSession({
    text: 'The.',
    workerText: 'The.',
    vadSegments: [],
    extra: {
      isVoicePlaying: () => true,
      playingText: () => ({ speechText: 'The.', subtitle: '' }),
    },
  });
  try {
    echo.child.stdout.write(echo.clip);
    await until(() => payloads(echo, 'hearing.echo.dropped').length > 0
      || payloads(echo, 'hearing.echo.candidate').length > 0);
    const echoRows = [...payloads(echo, 'hearing.echo.dropped'), ...payloads(echo, 'hearing.echo.candidate')];
    assert.ok(echoRows.length > 0, 'the echo row is written');
    assertScopedIds(echoRows.map((payload) => ({ type: 'hearing.echo', payload })), echo.hearing, 'echo');
    assertScopedIds(withId(echo), echo.hearing, 'echo-session');
  } finally {
    echo.hearing.stop();
  }
});

test('5) 同一实例内 seq 递增且不重复；既有去重行为不变', async () => {
  // Per-fragment delivery (grouping disabled) so two clips are two utterances, not one merged group.
  const session = startSession({ text: '第一句', workerText: '第一句', extra: { asrGroupCommitMs: 0 } });
  try {
    session.child.stdout.write(session.clip);
    await until(() => finals(session).length === 1);
    session.child.stdout.write(session.clip);
    await until(() => finals(session).length === 2);

    const ids = finals(session).map((event) => event.utteranceId);
    assert.deepEqual(ids, [`${session.hearing.instanceId}:1`, `${session.hearing.instanceId}:2`]);
    assert.equal(new Set(ids).size, 2, 'no repeated seq inside one instance');
    assert.deepEqual(ids.map((id) => parseUtteranceId(id).seq), [1, 2]);

    // Two identical finals inside the shadow window: one full row + one suppressed count, as before.
    assert.equal(payloads(session, 'hearing.noise.shadow').length, 1);
    assert.equal(payloads(session, 'hearing.noise.shadow.suppressed').length, 1);
    // Delivery order is untouched: two settled slots, the next one is 3.
    assert.equal(session.hearing.stats().delivery.next, 3);
    assert.equal(session.hearing.stats().finals, 2);
  } finally {
    session.hearing.stop();
  }
});

test('6) 两个并发实例的事件 id 集合不相交；投递内容不变', async () => {
  const mic = startSession({ text: '好', workerText: '好' });
  const loop = startSession({ text: '好', workerText: '好' });
  try {
    mic.child.stdout.write(mic.clip);
    loop.child.stdout.write(loop.clip);
    await until(() => finals(mic).length === 1 && finals(loop).length === 1);

    const idsOf = (session) => withId(session).map((event) => event.payload.utteranceId);
    const micIds = idsOf(mic);
    const loopIds = idsOf(loop);
    assert.ok(micIds.length > 0 && loopIds.length > 0);
    const overlap = micIds.filter((id) => loopIds.includes(id));
    assert.deepEqual(overlap, [], 'no id is shared across capture instances');
    assertScopedIds(withId(mic), mic.hearing, 'concurrent-mic');
    assertScopedIds(withId(loop), loop.hearing, 'concurrent-loopback');

    // Delivery itself is unchanged: same text, same refined flag, same source.
    for (const session of [mic, loop]) {
      const [final] = finals(session);
      assert.equal(final.final, '好');
      assert.equal(final.refined, true);
      assert.equal(final.source, 'mic');
      assert.equal(final.durationMs, 600);
      assert.equal(parseUtteranceId(final.utteranceId).seq, 1);
    }
  } finally {
    mic.hearing.stop();
    loop.hearing.stop();
  }
});
