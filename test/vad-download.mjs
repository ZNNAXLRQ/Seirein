/**
 * VAD model download: fixed source/checksum, atomic placement and degradation.
 *
 * No test touches the network: every download is a fake `fetch` over a local byte buffer. A real
 * download is ~644 KB, so the checksum/size constants are pinned and the fake body is verified
 * against an override of the same two invariants.
 *
 *  1. missing model + fake success + checksum passes → ready, file in place;
 *  2. checksum mismatch → failed, `.part` deleted, no model file left;
 *  3. two concurrent requests → exactly one fetch;
 *  4. download failure → hearing reports unavailable and keeps recording energy metrics;
 *  5. an existing valid model is never downloaded again; a missing one makes createSileroVad null;
 *  6. (script) regressions: vad-shadow, hearing-*, smoke;
 *  7. stopping hearing aborts the in-flight download: no ready, one cancelled, `.part` removed;
 *  8. a shared download survives one caller's abort and still reaches ready;
 *  9. the last caller's abort cancels the task once: one event and one fetch abort;
 * 10. an aborted retry loop issues no further request and leaves no `.part`;
 * 11. a cancellation is reported as cancelled, never as failed;
 * 12. an old cancelled task finishing late never removes the new task's target;
 * 13. every task's `.part` carries its own id: the old task cleans only its own file, and its late
 *     cleanup cannot delete the new task's live `.part`;
 * 14. two concurrent successful downloads leave no `.part` residue;
 * 15. a target another task finished first is reused without a checksum-mismatch.
 *
 * Run: node --test test/vad-download.mjs
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { startHearing } from '../src/host/hearing/hearing.js';
import {
  VAD_MODEL_BYTES,
  VAD_MODEL_SHA256,
  VAD_MODEL_URL,
  ensureModel,
  isSharedModelTarget,
  vadModelTarget,
} from '../src/host/platform/modelDownload.js';
import { createSileroVad } from '../src/host/hearing/vad.js';

const SAMPLE_RATE = 16000;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

/** Poll until `predicate()` is true; a missed deadline fails the test instead of hanging it. */
async function until(predicate, timeoutMs = 2000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('timed out waiting for the event');
    await delay(5);
  }
}

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'vad-download-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Every `*.part` half file in a directory; a task's file is named with its own task id. */
async function partFiles(dir) {
  let names = [];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  return names.filter((name) => name.endsWith('.part')).map((name) => join(dir, name)).sort();
}

/** A manually released promise: lets a fake fetch end only when the test says so. */
function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

/** The model bytes this test pretends to download (the real ones are 643 KB, never fetched here). */
const fakeModel = (fill = 7) => Buffer.alloc(1024, fill);

const responseOf = (buffer) => ({
  ok: true,
  status: 200,
  arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
});

test('0) 固定来源与 sha256/字节数常量', () => {
  assert.equal(
    VAD_MODEL_URL,
    'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
  );
  assert.equal(VAD_MODEL_BYTES, 643854);
  assert.equal(VAD_MODEL_SHA256, '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6');
  assert.equal(vadModelTarget({ modelDir: '/tmp/root/models/stream' }), join('/tmp/root/models', 'silero_vad.onnx'));
  assert.equal(isSharedModelTarget(vadModelTarget({ modelDir: '/tmp/root/models/stream' })), true);
  assert.equal(isSharedModelTarget(join('relative', 'models', 'silero_vad.onnx')), false);
});

test('1) 模型不存在 + 假下载成功 + 校验通过 → ready，文件就位', async (t) => {
  const root = await tempDir(t);
  const target = join(root, 'models', 'silero_vad.onnx');
  const body = fakeModel();
  const events = [];
  let fetches = 0;

  const result = await ensureModel({
    targetPath: target,
    url: 'https://example.invalid/silero_vad.onnx',
    bytes: body.length,
    sha256: sha256(body),
    fetchImpl: async () => {
      fetches += 1;
      return responseOf(body);
    },
    onEvent: (type, payload) => events.push({ type, payload }),
  });

  assert.equal(fetches, 1);
  assert.deepEqual(result, { ok: true, path: target, downloaded: true, bytes: body.length, ms: result.ms });
  assert.ok(result.ms >= 0);
  assert.deepEqual(await readFile(target), body, 'the verified model is at the target path');
  assert.deepEqual(await partFiles(join(root, 'models')), [], 'no half file survives a success');
  assert.deepEqual(events.map((event) => event.type), ['vad.model.download', 'vad.model.ready']);
  assert.equal(events[0].payload.bytes, body.length);
  assert.ok(events[0].payload.ms >= 0);
  assert.equal(events[1].payload.path, target);
  console.log(`[vad-download 1] ready path=${target} bytes=${body.length} ms=${result.ms}`);
});

test('2) 校验失败（改字节）→ failed，.part 被删，最终没有模型文件', async (t) => {
  const root = await tempDir(t);
  const target = join(root, 'models', 'silero_vad.onnx');
  const good = fakeModel();
  const tampered = Buffer.from(good);
  tampered[tampered.length - 1] ^= 0xff;
  const events = [];

  await assert.rejects(
    ensureModel({
      targetPath: target,
      url: 'https://example.invalid/silero_vad.onnx',
      bytes: good.length,
      sha256: sha256(good),
      fetchImpl: async () => responseOf(tampered),
      onEvent: (type, payload) => events.push({ type, payload }),
    }),
    (error) => error.reason === 'checksum-mismatch',
  );

  assert.equal(existsSync(target), false, 'no model file after a bad digest');
  assert.deepEqual(await partFiles(join(root, 'models')), [], 'the task own .part file is removed');
  assert.deepEqual(events.map((event) => event.type), ['vad.model.failed']);
  assert.equal(events[0].payload.reason, 'checksum-mismatch');
  console.log(`[vad-download 2] failed reason=${events[0].payload.reason} partRemoved=true targetAbsent=true`);
});

test('3) 并发两次请求 → 只下载一次', async (t) => {
  const root = await tempDir(t);
  const target = join(root, 'models', 'silero_vad.onnx');
  const body = fakeModel(9);
  let fetches = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const options = {
    targetPath: target,
    url: 'https://example.invalid/silero_vad.onnx',
    bytes: body.length,
    sha256: sha256(body),
    fetchImpl: async () => {
      fetches += 1;
      await gate;
      return responseOf(body);
    },
  };

  const first = ensureModel(options);
  const second = ensureModel(options);
  release();
  const [left, right] = await Promise.all([first, second]);

  assert.equal(fetches, 1, 'the second request joins the in-flight task');
  assert.equal(left.path, target);
  assert.equal(right.path, target);
  assert.equal(left.downloaded, true);
  assert.deepEqual(await readFile(target), body);
  console.log(`[vad-download 3] fetches=${fetches} sharedTask=true`);
});

/** ffmpeg stand-in: the test writes PCM into `stdout`, hearing treats it as capture. */
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

/** A loud 440 Hz tone: passes the RMS gate and looks voiced to the energy meter. */
function tone(ms) {
  const samples = new Int16Array(Math.round((SAMPLE_RATE * ms) / 1000));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.round(Math.sin((2 * Math.PI * 440 * index) / SAMPLE_RATE) * 0.25 * 32767);
  }
  const buffer = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) buffer.writeInt16LE(samples[index], index * 2);
  return buffer;
}

/** Streaming pass that ends after half the clip. */
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

/** ASR worker stand-in mirroring `asr-worker.js`'s reply shape. */
function fakeWorker(text) {
  const worker = new EventEmitter();
  worker.unref = () => {};
  worker.terminate = () => worker.emit('exit', null);
  worker.postMessage = (message) => {
    setImmediate(() => worker.emit('message', {
      type: 'result',
      id: message.id,
      utteranceId: message.utteranceId ?? null,
      segmentIds: [`${message.utteranceId ?? 's'}:s0`],
      text,
    }));
  };
  return worker;
}

test('4) 下载失败 → unavailable(download-failed)，能量指标照常记录', async (t) => {
  const root = await tempDir(t);
  const modelDir = join(root, 'models', 'stream');
  await mkdir(modelDir, { recursive: true });
  const child = new FakeChild();
  const updates = [];
  const events = [];
  const clip = tone(600);

  const hearing = startHearing({
    ffmpegPath: 'ffmpeg-not-used',
    modelDir,
    finalModelDir: '',
    device: 'fake-device',
    recognizer: fakeStreaming({ endpointAtSamples: clip.length / 2, text: '好' }),
    asrWorkerFactory: () => fakeWorker('好'),
    vadModelDownloader: async () => {
      throw Object.assign(new Error('simulated offline'), { reason: 'network' });
    },
    spawnProcess: () => child,
    onUpdate: (event) => updates.push(event),
    onEvent: (type, payload) => events.push({ type, payload }),
  });
  t.after(() => hearing.stop());

  await until(() => events.some((event) => event.type === 'hearing.vad.unavailable'));
  child.stdout.write(clip);
  await until(() => updates.some((event) => typeof event.final === 'string'));
  await delay(10);

  const unavailable = events.filter((event) => event.type === 'hearing.vad.unavailable');
  assert.equal(unavailable.length, 1, 'one report per session');
  assert.equal(unavailable[0].payload.reason, 'download-failed');
  assert.equal(events.filter((event) => event.type === 'hearing.vad.shadow').length, 0, 'no shadow row');

  // The energy meter still runs and the transcript is delivered: a failed VAD is not "nobody spoke".
  const noise = events.filter((event) => event.type === 'hearing.noise.shadow').map((event) => event.payload);
  assert.equal(noise.length, 1);
  assert.equal(noise[0].voicedRatio, 1, 'energyVoicedRatio is still recorded');
  assert.equal(noise[0].voicedMs, 600);
  assert.equal(updates.filter((event) => event.final === '好').length, 1);

  const stats = hearing.stats();
  assert.equal(stats.diagnostics.vad.available, false);
  assert.equal(stats.diagnostics.vad.reason, 'download-failed');
  assert.equal(stats.diagnostics.vad.download, 'failed');
  assert.equal(stats.finals, 1);
  console.log(
    `[vad-download 4] unavailable=download-failed energyVoicedRatio=${noise[0].voicedRatio} `
    + `energyVoicedMs=${noise[0].voicedMs} finals=${stats.finals}`,
  );
});

test('5) 已有模型 → 不重复下载；缺模型 → createSileroVad 返回 null', async (t) => {
  const root = await tempDir(t);
  const target = join(root, 'models', 'silero_vad.onnx');
  const body = fakeModel(3);
  await mkdir(join(root, 'models'), { recursive: true });
  await writeFile(target, body);
  let fetches = 0;

  const result = await ensureModel({
    targetPath: target,
    url: 'https://example.invalid/silero_vad.onnx',
    bytes: body.length,
    sha256: sha256(body),
    fetchImpl: async () => {
      fetches += 1;
      return responseOf(body);
    },
  });

  assert.equal(fetches, 0, 'a valid model is reused, never downloaded again');
  assert.equal(result.downloaded, false);
  assert.equal(result.path, target);
  assert.equal(createSileroVad({ modelPath: join(root, 'missing.onnx') }), null, 'missing model degrades, no throw');
  console.log(`[vad-download 5] fetches=${fetches} reused=true createSileroVad(missing)=null`);
});

test('6) 下载成功后 hearing 自动挂载 VAD，采集不被下载阻塞', async (t) => {
  const root = await tempDir(t);
  const modelDir = join(root, 'models', 'stream');
  const target = join(root, 'models', 'silero_vad.onnx');
  await mkdir(modelDir, { recursive: true });
  const child = new FakeChild();
  const updates = [];
  const events = [];
  const clip = tone(600);
  let built = 0;

  const hearing = startHearing({
    ffmpegPath: 'ffmpeg-not-used',
    modelDir,
    finalModelDir: '',
    device: 'fake-device',
    recognizer: fakeStreaming({ endpointAtSamples: clip.length / 2, text: '好' }),
    asrWorkerFactory: () => fakeWorker('好'),
    vadModelDownloader: async ({ targetPath }) => {
      await writeFile(targetPath, 'fake-model');
      return { ok: true, path: targetPath, downloaded: true, bytes: 10, ms: 1 };
    },
    vadFactory: () => {
      built += 1;
      return {
        acceptWaveform: () => {},
        isEmpty: () => true,
        front: () => null,
        pop: () => {},
        reset: () => {},
      };
    },
    spawnProcess: () => child,
    onUpdate: (event) => updates.push(event),
    onEvent: (type, payload) => events.push({ type, payload }),
  });
  t.after(() => hearing.stop());

  await until(() => hearing.stats().diagnostics.vad.available === true);
  assert.equal(built, 1, 'the detector is built only after the model is ready');
  child.stdout.write(clip);
  await until(() => updates.some((event) => typeof event.final === 'string'));
  await delay(10);

  const vad = hearing.stats().diagnostics.vad;
  assert.equal(vad.download, 'ready');
  assert.equal(vad.modelPath, target);
  assert.equal(vad.available, true);
  assert.equal(existsSync(target), true, 'the downloaded file is on disk');
  assert.equal(events.filter((event) => event.type === 'hearing.vad.shadow').length, 1);
  assert.equal(updates.filter((event) => event.final === '好').length, 1, 'capture/delivery did not wait');
  console.log(`[vad-download 6] available=true download=ready built=${built} shadowRows=1 finals=1`);
});

/** A fetch that never answers on its own: only its request signal can end it. */
function abortableFetch() {
  const stats = { fetches: 0, aborts: 0 };
  const fetchImpl = (url, init = {}) => {
    stats.fetches += 1;
    const signal = init?.signal;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        stats.aborts += 1;
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    });
  };
  return { stats, fetchImpl };
}

test('7) 下载中 stopHearing → fetch 中止、无 ready、cancelled、.part 已删', async (t) => {
  const root = await tempDir(t);
  const modelDir = join(root, 'models', 'stream');
  const target = join(root, 'models', 'silero_vad.onnx');
  await mkdir(modelDir, { recursive: true });
  await mkdir(join(root, 'models'), { recursive: true });
  const child = new FakeChild();
  const events = [];
  const download = abortableFetch();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = download.fetchImpl;
  t.after(() => { globalThis.fetch = originalFetch; });

  const hearing = startHearing({
    ffmpegPath: 'ffmpeg-not-used',
    modelDir,
    finalModelDir: '',
    device: 'fake-device',
    recognizer: fakeStreaming({ endpointAtSamples: 1, text: '' }),
    asrWorkerFactory: () => fakeWorker(''),
    spawnProcess: () => child,
    onUpdate: () => {},
    onEvent: (type, payload) => events.push({ type, payload }),
  });
  t.after(() => hearing.stop());

  await until(() => download.stats.fetches === 1);
  assert.equal(hearing.stats().diagnostics.vad.download, 'downloading');
  hearing.stop();
  await until(() => hearing.stats().diagnostics.vad.download === 'cancelled');
  await until(() => events.some((event) => event.type === 'vad.model.cancelled'));

  const cancelled = events.filter((event) => event.type === 'vad.model.cancelled');
  assert.equal(download.stats.aborts, 1, 'the in-flight fetch received the abort');
  assert.equal(cancelled.length, 1, 'exactly one cancellation row');
  assert.equal(cancelled[0].payload.reason, 'stopped');
  assert.equal(events.filter((event) => event.type === 'vad.model.ready').length, 0, 'nothing is mounted');
  assert.equal(events.filter((event) => event.type === 'vad.model.failed').length, 0, 'a stop is not a failure');
  assert.deepEqual(await partFiles(join(root, 'models')), [], 'the cancelled task leaves no half file');
  console.log(
    `[vad-download 7] stopped fetches=${download.stats.fetches} fetchAborts=${download.stats.aborts} `
    + `cancelled=${cancelled[0].payload.reason} ready=0 failed=0 partRemoved=true`,
  );
});

test('8) 共享下载：一个使用者 abort 只解绑自己，另一个仍完成 ready', async (t) => {
  const root = await tempDir(t);
  const target = join(root, 'models', 'silero_vad.onnx');
  const body = fakeModel(5);
  const events = [];
  let fetches = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const options = {
    targetPath: target,
    url: 'https://example.invalid/silero_vad.onnx',
    bytes: body.length,
    sha256: sha256(body),
    fetchImpl: async () => {
      fetches += 1;
      await gate;
      return responseOf(body);
    },
    onEvent: (type, payload) => events.push({ type, payload }),
  };
  const first = new AbortController();
  const second = new AbortController();
  const aborted = ensureModel({ ...options, signal: first.signal });
  const survivor = ensureModel({ ...options, signal: second.signal });
  await until(() => fetches === 1);
  first.abort('stopped');
  await assert.rejects(
    aborted,
    (error) => error.name === 'AbortError' && error.cancelReason === 'stopped',
  );
  release();
  const result = await survivor;

  assert.equal(result.downloaded, true);
  assert.deepEqual(await readFile(target), body);
  assert.equal(fetches, 1, 'the survivor kept the single shared task');
  assert.equal(events.filter((event) => event.type === 'vad.model.ready').length, 1);
  assert.equal(events.filter((event) => event.type === 'vad.model.cancelled').length, 0, 'one caller leaving cancels nothing');
  console.log(`[vad-download 8] refs=2 aborted=1 fetches=${fetches} survivor=ready readyRows=1 cancelled=0`);
});

test('9) 两个使用者都 abort → 底层只取消一次、无重复事件', async (t) => {
  const root = await tempDir(t);
  const target = join(root, 'models', 'silero_vad.onnx');
  const body = fakeModel(6);
  const download = abortableFetch();
  const events = [];
  const options = {
    targetPath: target,
    url: 'https://example.invalid/silero_vad.onnx',
    bytes: body.length,
    sha256: sha256(body),
    fetchImpl: download.fetchImpl,
    onEvent: (type, payload) => events.push({ type, payload }),
  };
  const first = new AbortController();
  const second = new AbortController();
  const left = ensureModel({ ...options, signal: first.signal });
  const right = ensureModel({ ...options, signal: second.signal });
  await until(() => download.stats.fetches === 1);

  first.abort('stopped');
  await assert.rejects(left, (error) => error.name === 'AbortError');
  assert.equal(events.filter((event) => event.type === 'vad.model.cancelled').length, 0, 'the task still has a user');
  assert.equal(download.stats.aborts, 0, 'the fetch is still running for the remaining user');

  second.abort('shutdown');
  await assert.rejects(
    right,
    (error) => error.name === 'AbortError' && error.cancelReason === 'shutdown',
  );
  await until(() => events.some((event) => event.type === 'vad.model.cancelled'));
  await delay(20);

  const cancelled = events.filter((event) => event.type === 'vad.model.cancelled');
  assert.equal(cancelled.length, 1, 'the underlying task is cancelled once, with one row');
  assert.equal(cancelled[0].payload.reason, 'shutdown');
  assert.equal(download.stats.aborts, 1, 'the underlying fetch was aborted exactly once');
  assert.equal(download.stats.fetches, 1, 'no retry after the cancel');
  assert.equal(events.filter((event) => event.type === 'vad.model.failed').length, 0);
  assert.deepEqual(await partFiles(join(root, 'models')), [], 'the cancelled task owns no surviving part');
  console.log(
    `[vad-download 9] aborts=2 underlyingAborts=${download.stats.aborts} cancelled=${cancelled[0].payload.reason} `
    + `cancelledRows=1 fetches=${download.stats.fetches} failed=0`,
  );
});

test('10) abort 后重试循环不再发起请求，.part 已删', async (t) => {
  const root = await tempDir(t);
  const target = join(root, 'models', 'silero_vad.onnx');
  const good = fakeModel();
  const tampered = Buffer.from(good);
  tampered[tampered.length - 1] ^= 0xff;
  const events = [];
  let fetches = 0;
  let aborts = 0;
  const fetchImpl = (url, init = {}) => {
    fetches += 1;
    if (fetches === 1) return Promise.resolve(responseOf(tampered));
    const signal = init?.signal;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        aborts += 1;
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    });
  };

  const controller = new AbortController();
  const promise = ensureModel({
    targetPath: target,
    url: 'https://example.invalid/silero_vad.onnx',
    mirrors: ['https://example.invalid/mirror.onnx'],
    bytes: good.length,
    sha256: sha256(good),
    retries: 3,
    fetchImpl,
    signal: controller.signal,
    onEvent: (type, payload) => events.push({ type, payload }),
  });
  await until(() => fetches === 2);
  const [abortedPart] = await partFiles(join(root, 'models'));
  assert.ok(abortedPart !== undefined, 'the first attempt left its .part after a checksum mismatch');
  assert.match(basename(abortedPart), /^silero_vad\.onnx\.[0-9a-f]+\.part$/, 'the part carries the task id');
  assert.notEqual(abortedPart, `${target}.part`, 'no shared fixed .part is used');

  controller.abort('stopped');
  await assert.rejects(promise, (error) => error.name === 'AbortError');
  await until(() => !existsSync(abortedPart));
  assert.deepEqual(await partFiles(join(root, 'models')), []);
  const fixed = fetches;
  await delay(60);

  assert.equal(fetches, fixed, 'no fetch after abort across the remaining retries');
  assert.equal(fetches, 2);
  assert.equal(aborts, 1);
  assert.equal(events.filter((event) => event.type === 'vad.model.cancelled').length, 1);
  assert.equal(events.filter((event) => event.type === 'vad.model.failed').length, 0);
  console.log(
    `[vad-download 10] retries=3 fetches=${fetches} aborts=${aborts} cancelledRows=1 failed=0 partRemoved=true`,
  );
});

test('11) 取消只记 cancelled，不记 failed（reason 来自 signal）', async (t) => {
  const root = await tempDir(t);
  const target = join(root, 'models', 'silero_vad.onnx');
  const body = fakeModel(4);
  const download = abortableFetch();
  const events = [];
  const controller = new AbortController();
  const promise = ensureModel({
    targetPath: target,
    url: 'https://example.invalid/silero_vad.onnx',
    bytes: body.length,
    sha256: sha256(body),
    fetchImpl: download.fetchImpl,
    signal: controller.signal,
    onEvent: (type, payload) => events.push({ type, payload }),
  });
  await until(() => download.stats.fetches === 1);
  controller.abort('shutdown');

  const error = await promise.catch((reason) => reason);
  assert.equal(error.name, 'AbortError');
  assert.equal(error.cancelReason, 'shutdown');
  await until(() => events.length === 1);
  assert.deepEqual(events.map((event) => event.type), ['vad.model.cancelled']);
  assert.equal(events[0].payload.reason, 'shutdown');
  assert.equal(events.some((event) => event.type === 'vad.model.failed'), false, 'no failed row');
  console.log(`[vad-download 11] events=${events.map((event) => event.type).join(',')} reason=${events[0].payload.reason} failed=0`);
});

test('12) 旧任务取消后新任务成功；旧任务迟到结束不删新目标，新任务仍 ready', async (t) => {
  const root = await tempDir(t);
  const target = join(root, 'models', 'silero_vad.onnx');
  const body = fakeModel(12);
  const events = [];
  const lateOldFetch = deferred();
  let oldFetches = 0;

  const oldController = new AbortController();
  const oldTask = ensureModel({
    targetPath: target,
    url: 'https://example.invalid/old.onnx',
    bytes: body.length,
    sha256: sha256(body),
    // Ignores the abort: the old task only ends when the test releases it, after the new task.
    fetchImpl: async () => {
      oldFetches += 1;
      await lateOldFetch.promise;
      return responseOf(body);
    },
    signal: oldController.signal,
    onEvent: (type, payload) => events.push({ type, payload }),
  });
  await until(() => oldFetches === 1);
  oldController.abort('stopped');
  await assert.rejects(
    oldTask,
    (error) => error.name === 'AbortError' && error.cancelReason === 'stopped',
  );
  await until(() => events.some((event) => event.type === 'vad.model.cancelled'));

  const fresh = await ensureModel({
    targetPath: target,
    url: 'https://example.invalid/new.onnx',
    bytes: body.length,
    sha256: sha256(body),
    fetchImpl: async () => responseOf(body),
    onEvent: (type, payload) => events.push({ type, payload }),
  });
  assert.equal(fresh.downloaded, true);
  assert.equal(fresh.path, target);
  assert.deepEqual(await readFile(target), body, 'the new task placed its verified model');

  // The old task ends late, after the new task is already ready: it must leave the target alone.
  lateOldFetch.resolve();
  await delay(50);
  assert.deepEqual(await readFile(target), body, 'the old late cleanup does not remove the new target');
  assert.deepEqual(await partFiles(join(root, 'models')), [], 'no half file is left behind');
  assert.equal(events.filter((event) => event.type === 'vad.model.cancelled').length, 1);
  assert.equal(events.filter((event) => event.type === 'vad.model.ready').length, 1, 'the new task reached ready');
  assert.equal(events.filter((event) => event.type === 'vad.model.failed').length, 0);
  console.log('[vad-download 12] old=cancelled new=ready targetIntact=true parts=0');
});

test('13) 任务身份隔离：旧任务只清自己的 .part，迟到清理不删新任务的 .part', async (t) => {
  const root = await tempDir(t);
  const modelsDir = join(root, 'models');
  const target = join(modelsDir, 'silero_vad.onnx');
  const body = fakeModel(13);
  const tampered = Buffer.from(body);
  tampered[tampered.length - 1] ^= 0xff;
  const lateOld = deferred();
  const lateNew = deferred();
  let oldFetches = 0;
  let newFetches = 0;
  const oldEvents = [];
  const newEvents = [];

  // The old task writes its own part (first attempt), then hangs on a mirror that ignores aborts.
  const oldController = new AbortController();
  const oldTask = ensureModel({
    targetPath: target,
    url: 'https://example.invalid/old-1.onnx',
    mirrors: ['https://example.invalid/old-2.onnx'],
    bytes: body.length,
    sha256: sha256(body),
    retries: 0,
    fetchImpl: async () => {
      oldFetches += 1;
      if (oldFetches === 1) return responseOf(tampered);
      await lateOld.promise;
      return responseOf(body);
    },
    signal: oldController.signal,
    onEvent: (type, payload) => oldEvents.push({ type, payload }),
  });
  await until(() => oldFetches === 2);
  const oldParts = await partFiles(modelsDir);
  assert.equal(oldParts.length, 1, 'the suspended old task owns exactly one half file');
  const oldPart = oldParts[0];
  assert.match(basename(oldPart), /^silero_vad\.onnx\.[0-9a-f]+\.part$/, 'the part name contains the task id');
  assert.notEqual(oldPart, `${target}.part`, 'the old task never used a shared fixed .part');

  oldController.abort('stopped');
  await assert.rejects(oldTask, (error) => error.name === 'AbortError');
  await until(() => !existsSync(oldPart));
  assert.equal(oldEvents.filter((event) => event.type === 'vad.model.cancelled').length, 1);

  // A new task takes over the same target and is suspended with its own part on disk.
  const newTask = ensureModel({
    targetPath: target,
    url: 'https://example.invalid/new-1.onnx',
    mirrors: ['https://example.invalid/new-2.onnx'],
    bytes: body.length,
    sha256: sha256(body),
    retries: 0,
    fetchImpl: async () => {
      newFetches += 1;
      if (newFetches === 1) return responseOf(tampered);
      await lateNew.promise;
      return responseOf(body);
    },
    onEvent: (type, payload) => newEvents.push({ type, payload }),
  });
  await until(() => newFetches === 2);
  const newParts = await partFiles(modelsDir);
  assert.equal(newParts.length, 1, 'only the new task has a part now');
  const newPart = newParts[0];
  assert.notEqual(newPart, oldPart, 'the two tasks never share a half file name');

  // The old task ends late while the new task's part is live: the old cleanup must not touch it.
  lateOld.resolve();
  await delay(50);
  assert.equal(existsSync(newPart), true, 'the old late cleanup does not delete the new task .part');
  assert.equal(existsSync(oldPart), false, 'the old task cleaned only its own half file');

  lateNew.resolve();
  const result = await newTask;
  assert.equal(result.downloaded, true);
  assert.deepEqual(await readFile(target), body, 'the new task still reaches ready');
  assert.deepEqual(await partFiles(modelsDir), [], 'the directory has no residual .part');
  assert.equal(newEvents.filter((event) => event.type === 'vad.model.ready').length, 1);
  console.log('[vad-download 13] oldPartRemoved=true newPartSurvived=true newTask=ready parts=0');
});

test('14) 两个任务并发成功 → 目录里没有残留 .part', async (t) => {
  const root = await tempDir(t);
  const modelsDir = join(root, 'models');
  const firstBody = fakeModel(21);
  const secondBody = fakeModel(22);
  const firstTarget = join(modelsDir, 'silero_vad.onnx');
  const secondTarget = join(modelsDir, 'speaker.onnx');
  const options = (target, body) => ({
    targetPath: target,
    url: 'https://example.invalid/model.onnx',
    bytes: body.length,
    sha256: sha256(body),
    fetchImpl: async () => {
      await delay(10);
      return responseOf(body);
    },
  });

  const [first, second] = await Promise.all([
    ensureModel(options(firstTarget, firstBody)),
    ensureModel(options(secondTarget, secondBody)),
  ]);

  assert.equal(first.downloaded, true);
  assert.equal(second.downloaded, true);
  assert.deepEqual(await readFile(firstTarget), firstBody);
  assert.deepEqual(await readFile(secondTarget), secondBody);
  assert.deepEqual(await partFiles(modelsDir), [], 'two concurrent tasks leave no half file');
  assert.deepEqual((await readdir(modelsDir)).sort(), ['silero_vad.onnx', 'speaker.onnx']);
  console.log('[vad-download 14] tasks=2 ready=2 residualParts=0');
});

test('15) 目标已被另一任务写好 → 复用目标、清理自己的 .part、不报 checksum-mismatch', async (t) => {
  const root = await tempDir(t);
  const modelsDir = join(root, 'models');
  const target = join(modelsDir, 'silero_vad.onnx');
  const body = fakeModel(15);
  await mkdir(modelsDir, { recursive: true });
  const events = [];
  let fetches = 0;

  const result = await ensureModel({
    targetPath: target,
    url: 'https://example.invalid/silero_vad.onnx',
    bytes: body.length,
    sha256: sha256(body),
    // The other task finishes while this one is still downloading: the target appears mid-flight.
    fetchImpl: async () => {
      fetches += 1;
      await writeFile(target, body);
      return responseOf(body);
    },
    onEvent: (type, payload) => events.push({ type, payload }),
  });

  assert.equal(fetches, 1);
  assert.equal(result.ok, true);
  assert.equal(result.path, target);
  assert.equal(result.downloaded, false, 'an existing verified target is reused, not rewritten');
  assert.deepEqual(await readFile(target), body);
  assert.deepEqual(await partFiles(modelsDir), [], 'the reusing task removes its own .part');
  assert.equal(events.some((event) => event.type === 'vad.model.failed'), false, 'no checksum-mismatch failure');
  console.log('[vad-download 15] reused=true downloaded=false failed=0 parts=0');
});
