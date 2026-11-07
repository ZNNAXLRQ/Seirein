/**
 * A6: the SenseVoice accurate pass runs in a worker thread.
 *
 * Measured on the real log (`<root>/data/events.jsonl`, 37 `voice.latency` samples), `asrMs`
 * was p50 209 ms, p95 495 ms, max 775 ms, with 9/37 utterances above 300 ms — every one of those
 * blocked the host's main thread (partials, barge-in, TTS and tool dispatch all run there). This
 * file pins the new contract:
 *  - a fake worker returning text feeds the transcript, and the capture loop keeps running while
 *    the decode is pending (a timer and the next utterance's partial prove it);
 *  - a crash retries exactly once, and a second crash degrades to synchronous decoding with the
 *    `asr.worker.*` events the host logs;
 *  - stopping drops the in-flight request, and a late/duplicate result is never delivered;
 *  - one utterance is delivered once, whatever the thread does;
 *  - without the worker (injected recognizer) the synchronous path and its timing are unchanged.
 *
 * No microphone, ffmpeg, sherpa model or real thread is used: the child process, the streaming
 * recognizer, the offline recognizer and the worker are all fakes.
 *
 * Run: node --test test/asr-worker.mjs
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  DEFAULT_ASR_DECODE_TIMEOUT_MS,
  DEFAULT_ASR_QUEUE_BYTES,
  DEFAULT_ASR_QUEUE_LIMIT,
  MAX_ASR_DECODE_TIMEOUT_MS,
  startHearing,
} from '../src/host/hearing/hearing.js';

const SAMPLE_RATE = 16000;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Flush microtasks in a test whose clock is mocked (so `delay()` would never resolve). */
async function flush(rounds = 12) {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Poll until `predicate()` is true; a missed deadline fails the test instead of hanging it. */
async function until(predicate, timeoutMs = 1000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('timed out waiting for condition');
    await delay(5);
  }
}

/** 1 s / 0.2 s of 440 Hz mono PCM: enough to pass the loudness gate and to set an endpoint. */
function tone(seconds) {
  const samples = new Int16Array(Math.round(SAMPLE_RATE * seconds));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.round(Math.sin((2 * Math.PI * 440 * index) / SAMPLE_RATE) * 0.25 * 32767);
  }
  const buffer = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) buffer.writeInt16LE(samples[index], index * 2);
  return buffer;
}

const TONE = tone(1);
const SHORT = tone(0.2);

/** ffmpeg stand-in: the test writes PCM into `stdout` and hearing treats it as capture. */
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

/** Streaming stand-in: endpoint once the configured amount of audio arrived. */
function fakeStreaming({ endpointAtSamples, text = '流式草稿' }) {
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

/** Offline stand-in (the synchronous fallback): scripted text, one entry per decode piece. */
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

/**
 * Worker stand-in with the exact surface `createAsrWorkerClient` uses (`on`, `postMessage`,
 * `unref`, `terminate`). `onDecode` decides when and what the thread answers.
 *
 * `terminate()` reports `exit` like a real Worker does. It is emitted synchronously on purpose:
 * the client must invalidate the generation before it terminates, otherwise the exit of the very
 * thread it just retired enters the restart path.
 */
function fakeWorker({ onDecode = null } = {}) {
  const worker = new EventEmitter();
  worker.messages = [];
  worker.terminated = 0;
  worker.exited = false;
  worker.unrefed = false;
  worker.unref = () => {
    worker.unrefed = true;
  };
  worker.terminate = () => {
    worker.terminated += 1;
    if (worker.exited) return;
    worker.exited = true;
    worker.emit('exit', null);
  };
  worker.postMessage = (message) => {
    worker.messages.push(message);
    onDecode?.(worker, message);
  };
  return worker;
}

function harness({
  updates,
  events,
  asrWorkerFactory,
  finalRecognizer,
  finalRecognizerFactory,
  endpointAtSamples = SAMPLE_RATE,
  text = '流式草稿',
  grouping = false,
  ...hearingOptions
} = {}) {
  const child = new FakeChild();
  const hearing = startHearing({
    ffmpegPath: 'ffmpeg-not-used',
    modelDir: 'models-not-used',
    finalModelDir: 'fake-final-model',
    device: 'fake-device',
    recognizer: fakeStreaming({ endpointAtSamples, text }),
    spawnProcess: () => child,
    asrWorkerFactory,
    finalRecognizer,
    finalRecognizerFactory,
    // Grouping is a product-level merge; this suite pins the worker decode path, so it opts out.
    ...(grouping ? {} : { asrGroupCommitMs: 0 }),
    onUpdate: (event) => updates.push(event),
    onEvent: (type, payload) => events.push({ type, payload }),
    ...hearingOptions,
  });
  return { child, hearing };
}

const finalEvents = (updates) => updates.filter((event) => typeof event.final === 'string');
const ofType = (events, type) => events.filter((event) => event.type === type);

test('a) 假 worker 返回文本：hearing 拿到结果，解码期间主线程继续运行', async () => {
  const updates = [];
  const events = [];
  const workers = [];
  // Grouping is a product-level merge; this suite pins the worker decode path, so it opts out.
  const { child, hearing } = harness({
    updates,
    events,
    asrWorkerFactory: () => {
      const worker = fakeWorker({
        onDecode: (self, message) => {
          setTimeout(() => {
            self.emit('message', {
              type: 'result',
              id: message.id,
              text: '离线精修结果',
              joinFallback: false,
            });
            // A wider margin than the test's ~35 ms observation window keeps this assertion
            // deterministic under load; the host still has to wait for the real answer.
          }, 250);
        },
      });
      workers.push(worker);
      return worker;
    },
  });

  const startedAt = Date.now();
  child.stdout.write(TONE); // 1 s → endpoint; the worker decode is now pending
  let timerFired = false;
  const tick = setTimeout(() => {
    timerFired = true;
  }, 15);
  await delay(10);
  // The capture loop did not wait for the decode: the next chunk already produced a partial.
  child.stdout.write(SHORT);
  await delay(25);
  clearTimeout(tick);

  // Both halves of the proof at the same moment: a 15 ms timer ran and the 250 ms decode has not
  // answered yet, so the host thread is free while the worker decodes.
  assert.equal(timerFired, true, 'timers keep running while the worker decodes');
  assert.equal(finalEvents(updates).length, 0, 'the decode is still pending, so no final yet');
  assert.ok(
    updates.some((event) => event.partial === '流式草稿'),
    'partials keep flowing while the worker decodes',
  );

  await until(() => finalEvents(updates).length === 1);
  assert.ok(Date.now() - startedAt >= 245, 'the transcript waits for the real decode, not a fake one');
  const [final] = finalEvents(updates);
  assert.equal(final.final, '离线精修结果', 'the worker text is the delivered transcript');
  assert.equal(final.refined, true, 'the accurate pass still marks the update refined');
  assert.ok(final.endpointAt > 0, 'the endpoint stamp still rides along for asrMs');

  const worker = workers[0];
  assert.equal(worker.messages.length, 1, 'one decode request');
  const [message] = worker.messages;
  assert.equal(message.type, 'decode');
  assert.equal(message.sampleRate, 16000);
  assert.equal(message.language, 'auto');
  assert.ok(message.audio instanceof Float32Array, 'the audio travels as samples');
  assert.equal(message.audio.length, SAMPLE_RATE, 'the whole utterance is sent');
  assert.equal(worker.unrefed, true, 'the thread is detached so it cannot hold the process open');

  assert.equal(ofType(events, 'asr.worker.started').length, 1);
  const [decode] = ofType(events, 'asr.decode');
  assert.ok(decode, 'asr.decode is reported');
  assert.ok(decode.payload.ms >= 40, `asr.decode.ms measures the decode (${decode.payload.ms})`);
  assert.equal(decode.payload.queued, 0);
  assert.equal(decode.payload.ok, true);

  hearing.stop();
  assert.equal(worker.terminated, 1, 'stop terminates the thread');
  assert.equal(ofType(events, 'asr.worker.stopped').length, 1);
});

test('b) worker 崩溃：重试一次；再崩溃则降级为同步解码，事件正确', async () => {
  const updates = [];
  const events = [];
  const workers = [];
  let syncRecognizerCreates = 0;
  // Grouping is a product-level merge; this suite pins the worker decode path, so it opts out.
  const { child, hearing } = harness({
    updates,
    events,
    asrWorkerFactory: () => {
      const worker = fakeWorker({
        onDecode: (self) => {
          queueMicrotask(() => self.emit('error', new Error('worker died')));
        },
      });
      workers.push(worker);
      return worker;
    },
    finalRecognizerFactory: () => {
      syncRecognizerCreates += 1;
      return fakeFinal(['同步兜底结果']);
    },
  });

  child.stdout.write(TONE);
  await until(() => finalEvents(updates).length === 1);

  const [final] = finalEvents(updates);
  assert.equal(final.final, '同步兜底结果', 'after the second crash the sync decoder produces the text');
  assert.equal(final.refined, true, 'the fallback is still an accurate pass');

  assert.equal(workers.length, 2, 'exactly one retry (initial thread + one respawn)');
  assert.equal(workers[0].terminated, 1, 'the dead thread is disposed');
  assert.equal(ofType(events, 'asr.worker.started').length, 2);
  const [degraded] = ofType(events, 'asr.worker.degraded');
  assert.ok(degraded, 'asr.worker.degraded is recorded');
  assert.match(degraded.payload.reason, /worker died/u);
  assert.equal(syncRecognizerCreates, 1, 'the sync recognizer is built once, on the first fallback');
  assert.equal(ofType(events, 'asr.decode').length, 0, 'no successful decode happened');
  assert.equal(hearing.stats().asrWorker.state, 'degraded', 'status reports the degradation');
  hearing.stop();
});

test('c) 停止时在途请求丢弃，迟到的结果不投递', async () => {
  const updates = [];
  const events = [];
  let worker = null;
  // Grouping is a product-level merge; this suite pins the worker decode path, so it opts out.
  const { child, hearing } = harness({
    updates,
    events,
    asrWorkerFactory: () => {
      worker = fakeWorker({
        onDecode: (self, message) => {
          // Answers well after the session stopped, like a thread racing its own terminate().
          setTimeout(() => {
            self.emit('message', { type: 'result', id: message.id, text: '迟到的结果' });
          }, 80);
        },
      });
      return worker;
    },
    finalRecognizerFactory: () => {
      throw new Error('a stopped session must not build the sync recognizer');
    },
  });

  child.stdout.write(TONE);
  await until(() => worker.messages.length === 1);
  hearing.stop();

  assert.equal(worker.terminated, 1, 'stop terminates the thread');
  assert.equal(ofType(events, 'asr.worker.stopped').length, 1);

  await delay(150);
  assert.equal(finalEvents(updates).length, 0, 'the in-flight request is dropped, never delivered');
  assert.equal(ofType(events, 'asr.decode').length, 0, 'no decode event for a dropped request');
});

test('d) 同一 utterance 只投递一次：重复和迟到的结果都被丢弃', async () => {
  const updates = [];
  const events = [];
  // Grouping is a product-level merge; this suite pins the worker decode path, so it opts out.
  const { child, hearing } = harness({
    updates,
    events,
    asrWorkerFactory: () => fakeWorker({
      onDecode: (self, message) => {
        setTimeout(() => {
          const result = { type: 'result', id: message.id, text: '只应出现一次', joinFallback: false };
          self.emit('message', result);
          self.emit('message', result); // duplicate answer for the same request
          self.emit('message', { type: 'error', id: message.id, error: 'late failure' });
        }, 10);
      },
    }),
  });

  child.stdout.write(TONE);
  await until(() => finalEvents(updates).length === 1);
  await delay(60);

  assert.equal(finalEvents(updates).length, 1, 'one utterance, one transcript');
  assert.equal(finalEvents(updates)[0].final, '只应出现一次');
  assert.equal(ofType(events, 'asr.decode').length, 1, 'one decode event: duplicates are ignored');
  hearing.stop();
});

test('e) 解码排队时 asr.decode 报告 queued，且投递顺序不变', async () => {
  const updates = [];
  const events = [];
  // Grouping is a product-level merge; this suite pins the worker decode path, so it opts out.
  const { child, hearing } = harness({
    updates,
    events,
    asrWorkerFactory: () => fakeWorker({
      onDecode: (self, message) => {
        setTimeout(() => {
          self.emit('message', { type: 'result', id: message.id, text: `结果${message.id}` });
        }, 60);
      },
    }),
  });

  child.stdout.write(TONE); // utterance 1
  child.stdout.write(TONE); // utterance 2: queued behind the first decode
  await until(() => finalEvents(updates).length === 2, 2000);

  const decodes = ofType(events, 'asr.decode');
  assert.equal(decodes.length, 2);
  assert.equal(decodes[0].payload.queued, 1, 'the second utterance waited in the queue');
  assert.equal(decodes[1].payload.queued, 0);
  assert.deepEqual(finalEvents(updates).map((event) => event.final), ['结果1', '结果2'], 'utterance order is kept');
  hearing.stop();
});

test('f) 注入同步识别器时不启动 worker，原同步路径与事件都不变', async () => {
  const updates = [];
  const events = [];
  let factoryCalls = 0;
  const final = fakeFinal(['同步路径结果']);
  // Grouping is a product-level merge; this suite pins the worker decode path, so it opts out.
  const { child, hearing } = harness({
    updates,
    events,
    finalRecognizer: final,
    asrWorkerFactory: () => {
      factoryCalls += 1;
      throw new Error('the worker must not start when a recognizer is injected');
    },
  });

  child.stdout.write(TONE);
  await until(() => finalEvents(updates).length === 1);

  const [event] = finalEvents(updates);
  assert.equal(event.final, '同步路径结果');
  assert.equal(event.refined, true);
  assert.equal(final.calls.length, 1, 'the injected recognizer decoded synchronously');
  assert.equal(factoryCalls, 0, 'no worker was spawned');
  assert.deepEqual(events, [], 'no asr.worker.* / asr.decode events on the synchronous path');
  assert.equal(hearing.stats().asrWorker, null);
  hearing.stop();
});

test('g) 假 worker 永不返回：8000 ms 假时钟后超时，同步解码一次并记录 asr.decode.timeout', async (t) => {
  // Fake time: the 8 s deadline fires immediately instead of making the suite wait.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const updates = [];
  const events = [];
  const workers = [];
  let syncCreates = 0;
  // Grouping is a product-level merge; this suite pins the worker decode path, so it opts out.
  const { child, hearing } = harness({
    updates,
    events,
    asrWorkerFactory: () => {
      const worker = fakeWorker(); // never answers
      workers.push(worker);
      return worker;
    },
    finalRecognizerFactory: () => {
      syncCreates += 1;
      return fakeFinal(['超时后的同步结果']);
    },
  });

  child.stdout.write(TONE);
  await flush();
  assert.equal(workers.length, 1);
  assert.equal(workers[0].messages.length, 1, 'the decode was posted');
  assert.equal(finalEvents(updates).length, 0, 'nothing is delivered yet');

  // 7999 ms is not a timeout; the 8000 ms deadline is.
  t.mock.timers.tick(7999);
  await flush(2);
  assert.equal(ofType(events, 'asr.decode.timeout').length, 0, 'no timeout before the deadline');
  assert.equal(finalEvents(updates).length, 0);

  t.mock.timers.tick(1);
  await flush();

  const [timeout] = ofType(events, 'asr.decode.timeout');
  assert.ok(timeout, 'asr.decode.timeout is recorded');
  assert.equal(timeout.payload.ms, DEFAULT_ASR_DECODE_TIMEOUT_MS, 'the base deadline is 8000 ms');
  assert.equal(timeout.payload.queued, 0);

  assert.equal(finalEvents(updates).length, 1, 'the utterance is still delivered exactly once');
  assert.equal(finalEvents(updates)[0].final, '超时后的同步结果');
  assert.equal(finalEvents(updates)[0].refined, true, 'the fallback is a real accurate pass');
  assert.equal(syncCreates, 1, 'the synchronous decode runs exactly once');

  assert.equal(workers.length, 2, 'the wedged thread is replaced for the next request');
  assert.equal(workers[0].terminated, 1, 'the timed-out thread is disposed');
  const status = hearing.stats().asrWorker;
  assert.equal(status.timeouts, 1);
  assert.equal(status.lastTimeoutMs, DEFAULT_ASR_DECODE_TIMEOUT_MS);
  hearing.stop();
});

test('h) 队列上限：100 个请求只保留 limit 条，超出部分拒绝新请求并记录 overflow', async () => {
  assert.equal(DEFAULT_ASR_QUEUE_LIMIT, 8);
  assert.equal(DEFAULT_ASR_QUEUE_BYTES, 240 * 16000 * 2, '240 s × 16 kHz × 2 B ≈ 7.7 MB');

  // Count cap (default policy: reject the newest request, never evict an older one).
  const updates = [];
  const events = [];
  // Grouping is a product-level merge; this suite pins the worker decode path, so it opts out.
  const { child, hearing } = harness({
    updates,
    events,
    asrWorkerFactory: () => fakeWorker(), // silent worker: the backlog cannot drain
  });

  for (let index = 0; index < 100; index += 1) child.stdout.write(TONE);
  await flush(40);

  const status = hearing.stats().asrWorker;
  assert.equal(status.inflight, true, 'one request is in flight');
  assert.equal(status.queued, DEFAULT_ASR_QUEUE_LIMIT, 'queued <= limit');
  assert.ok(status.queued <= DEFAULT_ASR_QUEUE_LIMIT);
  assert.equal(status.dropped, 100 - 1 - DEFAULT_ASR_QUEUE_LIMIT);
  assert.equal(status.queuedBytes, DEFAULT_ASR_QUEUE_LIMIT * SAMPLE_RATE * 2);

  const overflows = ofType(events, 'asr.queue.overflow');
  assert.equal(overflows.length, 91, 'every request beyond the cap is rejected');
  for (const overflow of overflows) {
    assert.equal(overflow.payload.dropped, 1);
    assert.equal(overflow.payload.reason, 'count');
    assert.equal(overflow.payload.queued, DEFAULT_ASR_QUEUE_LIMIT);
  }
  // A rejected accurate pass keeps the streaming text, but strict utterance order holds those
  // results behind utterance 1, which still waits on the silent worker: nothing jumps ahead.
  // Stop then drops the pending slots instead of flushing them.
  assert.equal(finalEvents(updates).length, 0, 'overflowed transcripts wait for the older utterance');
  assert.equal(ofType(events, 'asr.delivery.order').length, 0, 'no seq is delivered out of order');
  hearing.stop();
  assert.equal(hearing.stats().delivery.pending, 0, 'stop clears the pending slots');
  assert.equal(hearing.stats().delivery.closed, true, 'later results are refused');
  assert.equal(finalEvents(updates).length, 0);

  // Byte cap: a small configured budget rejects by `bytes` before the count cap is reached.
  const tinyUpdates = [];
  const tinyEvents = [];
  const tiny = harness({
    updates: tinyUpdates,
    events: tinyEvents,
    asrWorkerFactory: () => fakeWorker(),
    asrQueueLimit: 1000,
    asrQueueBytesLimit: 100_000,
  });
  for (let index = 0; index < 10; index += 1) tiny.child.stdout.write(TONE);
  await flush(40);

  const tinyStatus = tiny.hearing.stats().asrWorker;
  assert.equal(tinyStatus.queued, 3, '3 s of audio fit in the 100 000 B budget');
  assert.equal(tinyStatus.queuedBytes, 96_000);
  assert.equal(tinyStatus.dropped, 6);
  const byteOverflows = ofType(tinyEvents, 'asr.queue.overflow');
  assert.equal(byteOverflows.length, 6);
  assert.ok(byteOverflows.every((event) => event.payload.reason === 'bytes'));
  tiny.hearing.stop();
});

test('i) 连续 3 次超时熔断：degraded 后走同步路径，worker 不再 spawn', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const updates = [];
  const events = [];
  const workers = [];
  const texts = ['回退一', '回退二', '回退三', '回退四'];
  let syncCreates = 0;
  // Grouping is a product-level merge; this suite pins the worker decode path, so it opts out.
  const { child, hearing } = harness({
    updates,
    events,
    asrWorkerFactory: () => {
      const worker = fakeWorker(); // every generation never answers
      workers.push(worker);
      return worker;
    },
    finalRecognizerFactory: () => {
      syncCreates += 1;
      return fakeFinal(texts);
    },
  });

  child.stdout.write(TONE);
  child.stdout.write(TONE);
  child.stdout.write(TONE);
  await flush();
  assert.equal(workers.length, 1, 'one thread; the other two requests wait in the queue');
  assert.equal(hearing.stats().asrWorker.queued, 2);

  t.mock.timers.tick(8000);
  await flush();
  assert.equal(workers.length, 2, 'a timeout replaces the thread for the backlog');
  t.mock.timers.tick(8000);
  await flush();
  assert.equal(workers.length, 3, 'the second timeout replaces it again');
  t.mock.timers.tick(8000);
  await flush();

  const timeoutEvents = ofType(events, 'asr.decode.timeout');
  assert.deepEqual(timeoutEvents.map((event) => event.payload.queued), [2, 1, 0]);
  assert.deepEqual(timeoutEvents.map((event) => event.payload.ms), [8000, 8000, 8000]);

  const degraded = ofType(events, 'asr.worker.degraded');
  assert.equal(degraded.length, 1, 'the circuit breaker trips exactly once');
  assert.equal(degraded[0].payload.reason, 'decode-timeout');
  assert.equal(workers.length, 3, 'the third timeout does not respawn');
  assert.equal(syncCreates, 1, 'the synchronous recognizer is built once and reused');

  const status = hearing.stats().asrWorker;
  assert.equal(status.state, 'degraded');
  assert.equal(status.timeouts, 3);
  assert.deepEqual(finalEvents(updates).map((event) => event.final), ['回退一', '回退二', '回退三']);

  // After the degrade the session decodes synchronously; the degraded client never spawns again.
  const startedAtDegrade = ofType(events, 'asr.worker.started').length;
  child.stdout.write(TONE);
  await flush();
  assert.equal(ofType(events, 'asr.worker.started').length, startedAtDegrade, 'no spawn after degraded');
  assert.equal(workers.length, 3);
  assert.deepEqual(
    finalEvents(updates).map((event) => event.final),
    ['回退一', '回退二', '回退三', '回退四'],
  );
  hearing.stop();
});

test('j) 超长音频：期限按比例放宽，仍受 30000 ms 上限约束', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const updates = [];
  const events = [];
  const workers = [];
  const long = tone(60);
  // Grouping is a product-level merge; this suite pins the worker decode path, so it opts out.
  const { child, hearing } = harness({
    updates,
    events,
    asrWorkerFactory: () => {
      const worker = fakeWorker(); // never answers
      workers.push(worker);
      return worker;
    },
    finalRecognizerFactory: () => fakeFinal(['长音频同步结果']),
  });

  child.stdout.write(long);
  await flush(24);
  assert.equal(workers.length, 1);
  assert.equal(workers[0].messages.length, 1);
  assert.equal(workers[0].messages[0].audio.length, SAMPLE_RATE * 60, 'the whole 60 s utterance is sent');

  t.mock.timers.tick(8000);
  await flush(2);
  assert.equal(ofType(events, 'asr.decode.timeout').length, 0, 'a 60 s utterance gets more than the base 8 s');

  t.mock.timers.tick(21999); // 29 999 ms
  await flush(2);
  assert.equal(ofType(events, 'asr.decode.timeout').length, 0, 'still inside the widened deadline');

  t.mock.timers.tick(1); // 30 000 ms: the hard cap
  await flush();
  const [timeout] = ofType(events, 'asr.decode.timeout');
  assert.ok(timeout, 'the widened deadline still fires');
  assert.equal(timeout.payload.ms, MAX_ASR_DECODE_TIMEOUT_MS);
  assert.ok(Number.isFinite(timeout.payload.ms));
  assert.ok(timeout.payload.ms > DEFAULT_ASR_DECODE_TIMEOUT_MS);
  assert.equal(finalEvents(updates).length, 1);
  // The 60 s utterance is decoded as pieces; the fake returns a scripted first piece and `段N`
  // for the rest, joined by the same segmentation path as the worker.
  assert.match(finalEvents(updates)[0].final, /^长音频同步结果/u);
  assert.equal(finalEvents(updates)[0].refined, true);
  hearing.stop();
});

test('k) 三句乱序回归：第 1 句挂起、第 2 句超时、第 3 句溢出，交付仍严格 1→2→3', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const updates = [];
  const events = [];
  const workers = [];
  // Grouping is a product-level merge; this suite pins the worker decode path, so it opts out.
  const { child, hearing } = harness({
    updates,
    events,
    // One queued request is the limit, so the third utterance is rejected by the backlog.
    asrQueueLimit: 1,
    asrWorkerFactory: () => {
      const worker = fakeWorker(); // every generation stays silent
      workers.push(worker);
      return worker;
    },
    finalRecognizerFactory: () => fakeFinal(['第一句', '第二句', '第三句']),
  });

  child.stdout.write(TONE); // 1: in flight, then times out
  child.stdout.write(TONE); // 2: queued, then times out
  child.stdout.write(TONE); // 3: backlog full → overflow, streaming text kept
  await flush();

  assert.equal(ofType(events, 'asr.queue.overflow').length, 1, 'the third request is rejected by the count cap');
  // The overflowed transcript is ready long before the first two; the old implementation delivered
  // it right here (3 → 1 → 2). That is the out-of-order bug this test pins.
  assert.equal(finalEvents(updates).length, 0, 'the ready third result waits for 1 and 2');

  t.mock.timers.tick(8000); // utterance 1 times out → sync fallback
  await flush();
  assert.deepEqual(finalEvents(updates).map((event) => event.final), ['第一句']);

  t.mock.timers.tick(8000); // utterance 2 times out → sync fallback
  await flush();
  assert.deepEqual(
    finalEvents(updates).map((event) => event.final),
    ['第一句', '第二句', '流式草稿'],
    'order 1 → 2 → 3, with the overflowed utterance keeping its streaming text',
  );
  assert.equal(finalEvents(updates)[2].refined, false, 'the overflowed accurate pass was not backfilled');

  const order = ofType(events, 'asr.delivery.order').map((event) => event.payload);
  assert.deepEqual(order.map((entry) => entry.seq), [1, 2, 3], 'delivery follows the utterance sequence');
  assert.ok(order.every((entry) => entry.delivered === true && entry.skipped === false));
  assert.equal(workers.length, 3, 'one thread, replaced once per timeout');
  hearing.stop();
});

test('l) 被跳过的句子不阻塞后续：仍按序交付，不倒退', async () => {
  const updates = [];
  const events = [];
  // Grouping is a product-level merge; this suite pins the worker decode path, so it opts out.
  const { child, hearing } = harness({
    updates,
    events,
    asrWorkerFactory: () => fakeWorker({
      onDecode: (self, message) => {
        setTimeout(() => {
          self.emit('message', { type: 'result', id: message.id, text: `结果${message.id}`, joinFallback: false });
        }, 60);
      },
    }),
  });

  child.stdout.write(TONE); // 1: worker answers after 60 ms
  child.stdout.write(Buffer.alloc(SAMPLE_RATE * 2)); // 2: silence → no accurate pass, a skipped slot
  child.stdout.write(TONE); // 3: queued behind 1
  await flush();

  // The skipped sentence already settled, yet it still owns slot 2: nothing may pass it.
  assert.equal(finalEvents(updates).length, 0, 'no delivery before utterance 1 answers');
  assert.equal(hearing.stats().delivery.pending, 1, 'the settled slot 2 waits for slot 1');

  await until(() => finalEvents(updates).length === 2, 2000);
  assert.deepEqual(
    finalEvents(updates).map((event) => event.final),
    ['结果1', '结果2'],
    'the skipped sentence does not block the next one and nothing is reordered',
  );
  assert.equal(hearing.stats().dropped, 1, 'the silent sentence is still accounted as dropped');

  const order = ofType(events, 'asr.delivery.order').map((event) => event.payload);
  assert.deepEqual(order.map((entry) => entry.seq), [1, 2, 3], 'slots settle in utterance order');
  assert.deepEqual(
    order.map((entry) => [entry.delivered, entry.skipped]),
    [[true, false], [false, true], [true, false]],
    'the skipped slot is reported and the later utterance still delivers',
  );
  assert.equal(hearing.stats().delivery.pending, 0);
  hearing.stop();
});

test('m) 熔断后 terminate() 的 exit 不重启：spawn 停在 3，状态保持 degraded', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const updates = [];
  const events = [];
  const workers = [];
  // Grouping is a product-level merge; this suite pins the worker decode path, so it opts out.
  const { child, hearing } = harness({
    updates,
    events,
    asrWorkerFactory: () => {
      const worker = fakeWorker(); // silent; terminate() reports 'exit'
      workers.push(worker);
      return worker;
    },
    finalRecognizerFactory: () => fakeFinal(['回退一', '回退二', '回退三']),
  });

  child.stdout.write(TONE);
  child.stdout.write(TONE);
  child.stdout.write(TONE);
  await flush();
  assert.equal(workers.length, 1);

  t.mock.timers.tick(8000);
  await flush();
  assert.equal(workers.length, 2, 'a timeout replaces the thread for the backlog');
  t.mock.timers.tick(8000);
  await flush();
  assert.equal(workers.length, 3, 'the second timeout replaces it again');

  t.mock.timers.tick(8000); // third consecutive timeout trips the breaker
  await flush();
  assert.equal(ofType(events, 'asr.worker.degraded').length, 1, 'the circuit breaker trips once');
  assert.equal(workers[2].terminated, 1, 'the degraded thread is terminated');
  assert.equal(workers.length, 3, 'its synchronous exit does not spawn a fourth thread');
  assert.equal(ofType(events, 'asr.worker.started').length, 3, 'no started event after the degrade');
  assert.equal(hearing.stats().asrWorker.state, 'degraded');

  // Even a later utterance and a huge clock advance cannot revive the retired worker.
  child.stdout.write(TONE);
  t.mock.timers.tick(120000);
  await flush();
  assert.equal(workers.length, 3);
  assert.equal(ofType(events, 'asr.worker.started').length, 3);
  assert.equal(hearing.stats().asrWorker.state, 'degraded');
  assert.deepEqual(
    finalEvents(updates).map((event) => event.final),
    ['回退一', '回退二', '回退三', '段4'],
    'the session keeps decoding synchronously after the degrade',
  );
  hearing.stop();
});

test('n) 停止时清空 pending，迟到结果不交付', async () => {
  const updates = [];
  const events = [];
  const workers = [];
  // Grouping is a product-level merge; this suite pins the worker decode path, so it opts out.
  const { child, hearing } = harness({
    updates,
    events,
    asrQueueLimit: 1,
    asrWorkerFactory: () => {
      const worker = fakeWorker(); // the first request is never answered
      workers.push(worker);
      return worker;
    },
    finalRecognizerFactory: () => {
      throw new Error('a stopped session must not build the sync recognizer');
    },
  });

  child.stdout.write(TONE); // 1: in flight
  child.stdout.write(TONE); // 2: queued
  child.stdout.write(TONE); // 3: overflow → its result is pending behind 1
  await flush();
  assert.equal(hearing.stats().delivery.pending, 1, 'the overflowed result waits behind the older ones');
  assert.equal(finalEvents(updates).length, 0);

  hearing.stop();
  assert.equal(hearing.stats().delivery.pending, 0, 'stop clears the pending slots');
  assert.equal(hearing.stats().delivery.closed, true, 'later results are refused');

  workers[0].emit('message', { type: 'result', id: workers[0].messages[0].id, text: '迟到的结果' });
  await delay(20);
  assert.equal(finalEvents(updates).length, 0, 'a late worker result is not delivered');
  assert.equal(ofType(events, 'asr.delivery.order').length, 0, 'nothing was delivered after the stop');
});

test('o) 同步回退路径：cleaned 标签字段全 null、refined:false，并注明来自同步解码', async () => {
  const updates = [];
  const events = [];
  // Grouping is a product-level merge; this suite pins the worker decode path, so it opts out.
  const { child, hearing } = harness({
    updates,
    events,
    asrWorkerFactory: () => fakeWorker({
      onDecode: (self) => {
        queueMicrotask(() => self.emit('error', new Error('worker died')));
      },
    }),
    // The sync fallback decodes but yields no usable text, so the streaming text is delivered.
    finalRecognizerFactory: () => fakeFinal(['']),
  });

  child.stdout.write(TONE);
  await until(() => finalEvents(updates).length === 1);

  const [final] = finalEvents(updates);
  assert.equal(final.final, '流式草稿', 'the fallback keeps the pre-existing streaming text');
  assert.equal(final.refined, false, 'nothing was adopted from the sync decode');

  const cleaned = ofType(events, 'hearing.asr.cleaned')[0]?.payload;
  assert.ok(cleaned, 'the cleaned row is still reported on the fallback path');
  for (const key of ['lang', 'langClean', 'emotion', 'emotionClean', 'event', 'eventClean']) {
    assert.equal(cleaned[key], null, `${key} is null on the sync fallback path`);
  }
  assert.equal(cleaned.refined, false);
  assert.equal(cleaned.tagSource, 'sync', 'the row says which decode could have supplied the tags');
  // Same row shape as the worker path: every key exists, none is `undefined`.
  assert.ok(Object.values(cleaned).every((value) => value !== undefined));
  assert.equal(hearing.stats().asrWorker.state, 'degraded');
  hearing.stop();
});

test('p) 默认配置下 10 ms 间隔两段合并为一次投递，证明分组默认生效', async () => {
  const updates = [];
  const events = [];
  const { child, hearing } = harness({
    updates,
    events,
    grouping: true, // no asrGroupCommitMs override: the shipping 300 ms commit buffer is in force
    asrWorkerFactory: () => fakeWorker({
      onDecode: (self, message) => {
        setTimeout(() => {
          self.emit('message', {
            type: 'result', id: message.id, text: `段${message.utteranceId}`, joinFallback: false,
          });
        }, 5);
      },
    }),
  });

  child.stdout.write(TONE); // fragment 1: natural endpoint, the commit buffer opens
  await delay(10);
  child.stdout.write(TONE); // fragment 2 inside the buffer: the same turn continues
  await until(() => finalEvents(updates).length === 1, 2000);

  assert.equal(finalEvents(updates).length, 1, 'the two fragments are delivered as one utterance');
  assert.equal(finalEvents(updates)[0].final, '段1段2', 'text is concatenated in capture order');
  assert.equal(finalEvents(updates)[0].refined, true, 'the merged delivery is still an accurate pass');
  assert.equal(ofType(events, 'hearing.group.committed').length, 1, 'one group, one commit');
  assert.equal(ofType(events, 'asr.decode').length, 2, 'each fragment still got its own decode');
  await delay(50);
  assert.equal(finalEvents(updates).length, 1, 'no second delivery after the group committed');
  hearing.stop();
});
