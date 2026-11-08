/**
 * Speaker-voice shadow, hearing side: score a DELIVERED utterance, record only.
 *
 * The embedder is a fake in these tests (no microphone, ffmpeg, sherpa model or ONNX session):
 *  1. default OFF — the embedder is never built and no `speaker.*` event exists;
 *  2. ON + audio shorter than 600 ms — `unsure/too-short` and no `embed()` call at all;
 *  3. ON + an enrolled voice + a fake embedder — `match` with score/speakerId/ms/utteranceId,
 *     while the delivered text is byte-identical;
 *  4. missing model — exactly one `speaker.model.failed`, delivery continues (explicit path and
 *     the background-download failure path);
 *  5. empty library — `no-speakers`, no error, no embedding call;
 *  6. the synchronous fallback keeps its event log empty and never builds the shadow;
 *  7. regression: `node --check`, the hearing/speaker/vad suites and `node test/smoke.mjs`.
 *
 * Run: node --test test/speaker-shadow.mjs
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { parseUtteranceId, startHearing } from '../src/host/hearing/hearing.js';
import { createSpeakerLibrary } from '../src/host/hearing/speakerVoice.js';

const run = promisify(execFile);
const SAMPLE_RATE = 16000;
const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `predicate()` is true; a missed deadline fails the test instead of hanging it. */
async function until(predicate, label, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) assert.fail(`timed out: ${label}`);
    await delay(5);
  }
}

/** ffmpeg stand-in: the test writes PCM into `stdout`; the hearing loop treats it as capture. */
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

/** Streaming pass: the endpoint fires once the clip reaches `endpointAtSamples`. */
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

/** Offline pass used by the synchronous fallback (there is no worker thread on that path). */
function fakeFinal(text) {
  return {
    createStream: () => ({ acceptWaveform: () => {} }),
    decode: () => {},
    getResult: () => ({ text }),
  };
}

/** Worker stand-in mirroring `asr-worker.js`'s reply shape. */
function fakeWorker(text) {
  const worker = new EventEmitter();
  worker.messages = [];
  worker.unref = () => {};
  worker.terminate = () => {
    worker.emit('exit', null);
  };
  worker.postMessage = (message) => {
    worker.messages.push(message);
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

const ofType = (events, type) => events.filter((event) => event.type === type);
const vector = (values) => Float32Array.from(values);

/** One temp library root closed/removed after the test. */
async function freshLibrary(t) {
  const root = await mkdtemp(join(tmpdir(), 'speaker-shadow-'));
  const library = createSpeakerLibrary({ root });
  t.after(async () => {
    try {
      library.close();
    } catch {
      /* already closed */
    }
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });
  return { root, library };
}

/** A fake embedder whose calls are inspectable; the factory count is the "was it built?" answer. */
function fakeEmbedderFactory(result = vector([0.9, 0.3, 0.1, 0.2])) {
  const state = { built: 0, calls: [] };
  state.factory = () => {
    state.built += 1;
    return {
      embed(samples) {
        state.calls.push(samples);
        return result;
      },
    };
  };
  return state;
}

/**
 * Start one fake hearing session, push one clip, wait for its final (and optionally one event).
 *
 * @param {import('node:test').TestContext} t
 * @param {{ms?: number, workerText?: string, speakerShadow?: *,
 *          speakerEmbedderFactory?: Function, speakerLibrary?: object,
 *          speakerModelPath?: string, speakerModelDownloader?: Function,
 *          modelDir?: string, syncFinal?: string|null, waitFor?: string|null,
 *          extra?: object}} [options]
 */
async function runClip(t, {
  ms = 1000,
  workerText = '好',
  speakerShadow,
  speakerEmbedderFactory,
  speakerLibrary,
  speakerModelPath,
  speakerModelDownloader,
  modelDir = 'models-not-used',
  syncFinal = null,
  waitFor = null,
  extra = {},
} = {}) {
  const child = new FakeChild();
  const updates = [];
  const events = [];
  const clip = tone(ms);
  const hearing = startHearing({
    ffmpegPath: 'ffmpeg-not-used',
    modelDir,
    finalModelDir: '',
    device: 'fake-device',
    recognizer: fakeStreaming({ endpointAtSamples: clip.length / 2, text: '好' }),
    spawnProcess: () => child,
    ...(syncFinal === null ? { asrWorkerFactory: () => fakeWorker(workerText) } : { finalRecognizer: fakeFinal(syncFinal) }),
    ...(speakerShadow === undefined ? {} : { speakerShadow }),
    ...(speakerEmbedderFactory === undefined ? {} : { speakerEmbedderFactory }),
    ...(speakerLibrary === undefined ? {} : { speakerLibrary }),
    ...(speakerModelPath === undefined ? {} : { speakerModelPath }),
    ...(speakerModelDownloader === undefined ? {} : { speakerModelDownloader }),
    ...extra,
    onUpdate: (event) => updates.push(event),
    onEvent: (type, payload) => events.push({ type, payload }),
  });
  t.after(() => hearing.stop());

  child.stdout.write(clip);
  await until(() => updates.some((event) => typeof event.final === 'string'), 'the delivered final');
  if (waitFor !== null) await until(() => ofType(events, waitFor).length > 0, waitFor);
  await delay(20);

  const finals = updates.filter((event) => typeof event.final === 'string');
  return { finals, final: finals[0], events, stats: hearing.stats() };
}

// ---------------------------------------------------------------------------
// 1. Default OFF
// ---------------------------------------------------------------------------

test('1) 默认关闭：embedder 不构建、无 speaker.* 事件、投递不变', async (t) => {
  const embedder = fakeEmbedderFactory();
  const { finals, events } = await runClip(t, { speakerEmbedderFactory: embedder.factory });

  assert.equal(embedder.built, 0, 'the embedder is never built while the shadow is off');
  assert.equal(embedder.calls.length, 0);
  assert.deepEqual(ofType(events, 'speaker.shadow'), [], 'no shadow row');
  assert.deepEqual(ofType(events, 'speaker.model.failed'), [], 'no model work at all');
  assert.deepEqual(finals.map((event) => event.final), ['好'], 'delivery is unchanged');
  console.log(`[speaker-shadow 1] shadow=off embedderBuilt=${embedder.built} speakerEvents=0 final=${finals[0].final}`);
});

// ---------------------------------------------------------------------------
// 2. Too short
// ---------------------------------------------------------------------------

test('2) 开启 + <0.6s：unsure/too-short，embed 不调用', async (t) => {
  const embedder = fakeEmbedderFactory();
  const { finals, events } = await runClip(t, {
    ms: 400,
    speakerShadow: true,
    speakerEmbedderFactory: embedder.factory,
    waitFor: 'speaker.shadow',
  });

  const [shadow] = ofType(events, 'speaker.shadow').map((event) => event.payload);
  assert.deepEqual(shadow, { decision: 'unsure', reason: 'too-short' });
  assert.equal(embedder.built, 0, 'a short clip never loads the model');
  assert.equal(embedder.calls.length, 0, 'and never computes an embedding');
  assert.deepEqual(finals.map((event) => event.final), ['好']);
  console.log(
    `[speaker-shadow 2] samples=${400 * 16} min=${600 * 16} decision=${shadow.decision} `
    + `reason=${shadow.reason} embedCalls=${embedder.calls.length} final=${finals[0].final}`,
  );
});

// ---------------------------------------------------------------------------
// 3. Enrolled voice + fake embedder → match
// ---------------------------------------------------------------------------

test('3) 开启 + 已注册声纹 + 假 embedder：match 含 score/speakerId，投递文本不变', async (t) => {
  const { library } = await freshLibrary(t);
  const alice = vector([0.9, 0.3, 0.1, 0.2]);
  assert.equal(library.register('alice', alice).ok, true);

  const embedder = fakeEmbedderFactory(alice);
  const { finals, events } = await runClip(t, {
    ms: 1000,
    speakerShadow: true,
    speakerEmbedderFactory: embedder.factory,
    speakerLibrary: library,
    waitFor: 'speaker.shadow',
  });

  const rows = ofType(events, 'speaker.shadow').map((event) => event.payload);
  assert.equal(rows.length, 1, 'one row per delivered utterance');
  const [shadow] = rows;
  assert.deepEqual(Object.keys(shadow).sort(), ['decision', 'ms', 'score', 'speakerId', 'utteranceId']);
  assert.equal(shadow.decision, 'match');
  assert.equal(shadow.score, 1, 'the enrolled direction scores 1.0');
  assert.equal(shadow.speakerId, 'alice');
  assert.equal(parseUtteranceId(shadow.utteranceId).seq, 1);
  assert.ok(Number.isFinite(shadow.ms) && shadow.ms >= 0, 'the row carries a measured ms');

  assert.equal(embedder.built, 1, 'the lazy embedder is built once');
  assert.equal(embedder.calls.length, 1);
  assert.ok(embedder.calls[0] instanceof Float32Array);
  assert.equal(embedder.calls[0].length, SAMPLE_RATE, 'the utterance’s own 1 s of 16 kHz PCM is used');
  assert.deepEqual(finals.map((event) => event.final), ['好'], 'the delivered text is byte-identical');
  console.log(
    `[speaker-shadow 3] decision=${shadow.decision} score=${shadow.score} speakerId=${shadow.speakerId} `
    + `ms=${shadow.ms} utteranceId=${shadow.utteranceId} embedSamples=${embedder.calls[0].length} `
    + `final=${finals[0].final}`,
  );
});

// ---------------------------------------------------------------------------
// 4. Model missing / download failure
// ---------------------------------------------------------------------------

test('4) 模型缺失：恰好一次 speaker.model.failed，投递继续', async (t) => {
  // (a) An explicit missing path is not auto-downloaded; it reports once and disables the shadow.
  const explicit = await runClip(t, {
    ms: 1000,
    speakerShadow: true,
    speakerModelPath: 'C:/definitely/missing/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx',
    waitFor: 'speaker.model.failed',
  });
  const failures = ofType(explicit.events, 'speaker.model.failed');
  assert.equal(failures.length, 1, 'one failure per session, never one per utterance');
  assert.equal(failures[0].payload.reason, 'missing');
  assert.deepEqual(explicit.finals.map((event) => event.final), ['好'], 'delivery continues');
  assert.equal(ofType(explicit.events, 'speaker.shadow').length, 0, 'no shadow row without a model');
  assert.equal(explicit.stats.finals, 1);

  // (b) The background download seam fails once; delivery still happens.
  const downloadRoot = await mkdtemp(join(tmpdir(), 'speaker-shadow-download-'));
  t.after(async () => {
    await rm(downloadRoot, { recursive: true, force: true }).catch(() => {});
  });
  let downloads = 0;
  const downloaded = await runClip(t, {
    ms: 1000,
    speakerShadow: true,
    modelDir: join(downloadRoot, 'models', 'stream'),
    speakerModelDownloader: async () => {
      downloads += 1;
      return { ok: false, reason: 'network' };
    },
    waitFor: 'speaker.model.failed',
  });
  const downloadFailures = ofType(downloaded.events, 'speaker.model.failed');
  assert.equal(downloads, 1, 'the model is downloaded in the background exactly once');
  assert.equal(downloadFailures.length, 1);
  assert.equal(downloadFailures[0].payload.reason, 'network');
  assert.deepEqual(downloaded.finals.map((event) => event.final), ['好']);
  console.log(
    `[speaker-shadow 4] explicit=${failures.length}:${failures[0].payload.reason} `
    + `download=${downloadFailures.length}:${downloadFailures[0].payload.reason} downloads=${downloads} `
    + `finals=${explicit.finals.length},${downloaded.finals.length}`,
  );
});

// ---------------------------------------------------------------------------
// 5. Empty library
// ---------------------------------------------------------------------------

test('5) 库为空：no-speakers，不报错、不计算 embedding', async (t) => {
  const { library } = await freshLibrary(t);
  const embedder = fakeEmbedderFactory();
  const { finals, events } = await runClip(t, {
    speakerShadow: true,
    speakerEmbedderFactory: embedder.factory,
    speakerLibrary: library,
    waitFor: 'speaker.shadow',
  });

  const [shadow] = ofType(events, 'speaker.shadow').map((event) => event.payload);
  assert.deepEqual(shadow, { decision: 'no-speakers' });
  assert.equal(embedder.calls.length, 0, 'an empty library is answered before embedding');
  assert.deepEqual(ofType(events, 'speaker.model.failed'), [], 'an empty library is not an error');
  assert.deepEqual(finals.map((event) => event.final), ['好']);
  console.log(
    `[speaker-shadow 5] decision=${shadow.decision} embedCalls=${embedder.calls.length} `
    + `modelFailed=${ofType(events, 'speaker.model.failed').length}`,
  );
});

// ---------------------------------------------------------------------------
// 6. Synchronous fallback
// ---------------------------------------------------------------------------

test('6) 同步回退：事件日志为空，且不构建声纹影子', async (t) => {
  const embedder = fakeEmbedderFactory();
  const { final, events } = await runClip(t, {
    syncFinal: '好',
    speakerShadow: true,
    speakerEmbedderFactory: embedder.factory,
  });

  assert.equal(final.final, '好');
  assert.equal(embedder.built, 0, 'the shadow is a worker-session feature');
  assert.deepEqual(events, [], 'the synchronous contract keeps the event log empty');
  console.log(`[speaker-shadow 6] events=${events.length} embedderBuilt=${embedder.built} final=${final.final}`);
});

// ---------------------------------------------------------------------------
// 7. Regression
// ---------------------------------------------------------------------------

test('7) 回归：node --check、hearing-*/vad-*/speaker-voice 套件、smoke', async (t) => {
  t.timeout = 300_000;

  await assert.doesNotReject(run(process.execPath, ['--check', join(PROJECT_ROOT, 'src', 'host', 'hearing', 'hearing.js')]));

  const testDir = join(PROJECT_ROOT, 'test');
  const names = await readdir(testDir);
  const suites = names
    .filter((name) => /^(hearing-|vad-).+\.mjs$/u.test(name) || name === 'speaker-voice.mjs')
    .sort()
    .map((name) => join(testDir, name));
  assert.ok(suites.length >= 5, `found the hearing/vad/speaker suites: ${suites.length}`);

  // Node's test runner refuses a recursive `--test` inside a test file, so each suite is run as a
  // plain `node <file>` (a `node:test` file runs itself) and its own exit code is the verdict.
  const suiteResults = [];
  for (const suite of suites) {
    const result = await run(process.execPath, [suite], {
      cwd: PROJECT_ROOT,
      maxBuffer: 32 * 1024 * 1024,
    });
    suiteResults.push({ suite, output: `${result.stdout}\n${result.stderr}` });
  }
  assert.equal(suiteResults.length, suites.length);
  for (const { suite, output } of suiteResults) {
    assert.match(output, /\bpass\b/u, `${suite} prints its summary`);
    assert.doesNotMatch(output, /\bfail [1-9]/u, `${suite} has no failures`);
  }

  const smoke = await run(process.execPath, [join(testDir, 'smoke.mjs')], {
    cwd: PROJECT_ROOT,
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.match(smoke.stdout, /SMOKE TEST PASSED/u);

  console.log(
    `[speaker-shadow 7] node --check=ok suites=${suites.length} `
    + `(hearing-*/vad-*/speaker-voice) smoke=ok`,
  );
});
