/**
 * Daily speaker-candidate HOST wiring + the hearing cold-start seam.
 *
 *   1. A microphone utterance heard while the speaker library has no enabled template still
 *      computes an embedding and offers exactly one candidate (the `no-speakers` shadow row keeps
 *      its old shape); delivery is unchanged.
 *   2. The host callback writes a 16 kHz mono 16-bit PCM WAV and admits one pending metadata row.
 *   3. A loopback-sourced callback is refused; nothing is written or stored.
 *   4. Privacy, capture stop, component disable, unload and a late callback from an old session
 *      never add a candidate.
 *   5. `status.speaker.candidates` reports counts/groups/instants only; an audio write failure
 *      records one reason event and stores nothing.
 *
 * No microphone, ffmpeg, sherpa model, speaker template, network or GUI is touched.
 *
 * Run: node --test test/speaker-candidate-host.mjs
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

import { cleanupRoot, disposeAll } from './helpers/cleanup.mjs';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SAMPLE_RATE = 16000;
const CANDIDATE_TEXT = '候选正文不可出现在状态或事件里';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `predicate()` is true; a missed deadline fails the test instead of hanging it. */
async function until(predicate, label, timeoutMs = 4000) {
  const startedAt = Date.now();
  while (!(await predicate())) {
    if (Date.now() - startedAt > timeoutMs) assert.fail(`timed out: ${label}`);
    await delay(10);
  }
}

// ---------------------------------------------------------------------------
// Module seam: a recording hearing stand-in for the HOST tests
// ---------------------------------------------------------------------------

const state = {
  starts: [],
  sessions: [],
  onUpdate: null,
  onEvent: null,
};
globalThis.__speakerCandidateHostTest = state;

const hearingUrl = new URL('../src/host/hearing/hearing.js', import.meta.url).href;
const hook = registerHooks({
  load(url, context, next) {
    if (url === hearingUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    const s = globalThis.__speakerCandidateHostTest;
    export const modelReady = () => true;
    export const finalModelReady = () => true;
    export const isLoopbackDevice = (name) => /CABLE|Stereo Mix|Virtual/i.test(String(name));
    export const selectMicrophoneDevice = (devices, requested) => ({
      device: requested || devices[0] || '', loopback: false, error: '',
    });
    export const listDevices = async () => ['Fake Mic'];
    export const startHearing = (options) => {
      s.starts.push(options);
      s.onUpdate = options.onUpdate;
      s.onEvent = options.onEvent;
      let doneResolve;
      const done = new Promise((resolve) => { doneResolve = resolve; });
      const session = {
        device: options.device,
        instanceId: 'mock-speaker-candidate-host',
        stats: () => ({ rmsDb: -20, peakDb: -10 }),
        stop() { doneResolve(); },
        done,
      };
      s.sessions.push(session);
      return session;
    };
    export const watchHearingExit = () => {};
    export const annotateTranscript = (text) => text;
    export const joinDetailFields = () => ({});
    export const mergeJoinFallback = () => ({});
    export const offlineLimitedNote = () => '';
    export const truncationNotice = () => '';`,
      };
    }
    return next(url, context);
  },
});
const { apply } = await import('../src/host/index.js');
hook.deregister();
after(() => { delete globalThis.__speakerCandidateHostTest; });

// ---------------------------------------------------------------------------
// Host mount (same fake scope shape as the other host suites)
// ---------------------------------------------------------------------------

async function mount(t, { config = {}, settings = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-speaker-candidate-host-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await mkdir(join(root, 'workspace'), { recursive: true });
  await writeFile(join(root, 'data', 'features.json'), JSON.stringify({
    hearing: true, ambient: false, voice: false, vision: false,
    subtitle: false, avatar: false, memory: false, fastpath: false,
  }));
  await writeFile(join(root, 'data', 'settings.json'), JSON.stringify({
    langs: { speech: 'zh', subtitle: 'zh' },
    autoMemory: { enabled: false },
    voice: { chunking: false, speakerShadow: true, ...(settings.voice ?? {}) },
    ...settings,
  }));

  state.starts = [];
  state.sessions = [];
  state.onUpdate = null;
  state.onEvent = null;

  const tools = new Map();
  const routes = new Map();
  const disposers = [];
  const effect = (fn) => {
    const cleanup = fn();
    if (typeof cleanup === 'function') disposers.push(cleanup);
    return cleanup;
  };
  const scope = {
    effect,
    on: () => () => {},
    systemPrompt: { section: () => () => {} },
    webServer: {
      register(route) {
        routes.set(route.path, route.handler);
        return () => routes.delete(route.path);
      },
    },
  };
  apply({
    effect,
    on: () => () => {},
    get: () => undefined,
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    inject: (_dependencies, registerScope) => registerScope(scope),
  }, {
    root,
    enabled: true,
    asrMergeWindowMs: 10,
    voice: { speakerShadow: true },
    // No network/model work: the test only needs the host callback seam.
    speakerModelStartup: false,
    speakerModelDownload: async () => ({ ok: false, reason: 'test-double' }),
    ...config,
  });

  const listen = tools.get('assistant_listen');
  assert.ok(listen !== undefined, 'assistant_listen is registered');

  const events = async () => {
    try {
      const text = await readFile(join(root, 'data', 'events.jsonl'), 'utf8');
      return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  const waitForEvent = async (type, predicate = () => true) => {
    let hit;
    await until(async () => {
      hit = (await events()).find((event) => event.type === type && predicate(event.payload ?? {}));
      return hit !== undefined;
    }, `${type} event`);
    return hit;
  };
  const action = async (body) => {
    const handler = routes.get('/assistant/action');
    assert.equal(typeof handler, 'function', 'the action route is registered');
    const { Readable } = await import('node:stream');
    let result;
    await handler(
      Object.assign(Readable.from([JSON.stringify(body)]), { method: 'POST' }),
      { writeHead() {}, end(value) { result = value; } },
    );
    return JSON.parse(result);
  };
  const status = async () => {
    const handler = routes.get('/assistant/status');
    assert.equal(typeof handler, 'function', 'the status route is registered');
    let result = '';
    await handler({ method: 'GET', url: '/assistant/status' }, {
      writeHead() {},
      end(value) { result = value; },
    });
    return JSON.parse(result);
  };
  const start = async () => listen.execute({ action: 'start' }, {});
  const stop = async () => listen.execute({ action: 'stop' }, {});
  const callback = () => state.starts.at(-1)?.onSpeakerSample;

  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    const failures = await disposeAll(disposers);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'dispose failed');
  };

  t.after(async () => {
    for (const session of state.sessions) session.stop();
    if (disposed) {
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } else {
      await cleanupRoot(root, disposers);
    }
  });

  return { root, start, stop, action, status, events, waitForEvent, callback, dispose };
}

const ofType = (events, type) => events.filter((event) => event.type === type);
const candidateStatusOf = (snapshot) => snapshot?.speaker?.candidates;
const candidateFile = (root) => join(root, 'data', 'speaker-candidates.json');
const candidateDir = (root) => join(root, 'cache', 'speaker-candidates');

function toneSamples(ms, amplitude = 0.25) {
  const samples = new Float32Array(Math.round((SAMPLE_RATE * ms) / 1000));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.sin((2 * Math.PI * 440 * index) / SAMPLE_RATE) * amplitude;
  }
  return samples;
}

function sampleOf(utteranceId, { durationMs = 1000, embedding = [1, 0, 0], ...overrides } = {}) {
  return {
    utteranceId,
    embedding: new Float32Array(embedding),
    samples: toneSamples(durationMs),
    sampleRate: 16000,
    durationMs,
    source: 'mic',
    quality: 'ok',
    decision: 'no-speakers',
    text: CANDIDATE_TEXT,
    ...overrides,
  };
}

/** Parse and assert the canonical 16 kHz mono 16-bit PCM WAV shape. */
function assertWav(buffer) {
  assert.equal(buffer.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buffer.readUInt32LE(4), buffer.length - 8, 'RIFF chunk size');
  assert.equal(buffer.toString('ascii', 8, 12), 'WAVE');
  assert.equal(buffer.toString('ascii', 12, 16), 'fmt ');
  assert.equal(buffer.readUInt32LE(16), 16, 'PCM fmt chunk size');
  assert.equal(buffer.readUInt16LE(20), 1, 'PCM format');
  assert.equal(buffer.readUInt16LE(22), 1, 'mono');
  assert.equal(buffer.readUInt32LE(24), SAMPLE_RATE, '16 kHz');
  assert.equal(buffer.readUInt32LE(28), SAMPLE_RATE * 2, 'byte rate');
  assert.equal(buffer.readUInt16LE(32), 2, 'block align');
  assert.equal(buffer.readUInt16LE(34), 16, '16 bit');
  assert.equal(buffer.toString('ascii', 36, 40), 'data');
  const dataSize = buffer.readUInt32LE(40);
  assert.equal(buffer.length, 44 + dataSize, 'data size matches the file');
  assert.equal(dataSize % 2, 0);
  let peak = 0;
  for (let offset = 44; offset < buffer.length; offset += 2) {
    peak = Math.max(peak, Math.abs(buffer.readInt16LE(offset)));
  }
  assert.ok(peak > 0, 'the written PCM is not all zeros');
  return { dataSize, samples: dataSize / 2 };
}

async function readCandidates(root) {
  try {
    const parsed = JSON.parse(await readFile(candidateFile(root), 'utf8'));
    return Array.isArray(parsed.candidates) ? parsed.candidates : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 1. Cold start: empty speaker library still produces a candidate
// ---------------------------------------------------------------------------

test('1) 空声纹库：hearing 仍算 embedding 并回调候选，no-speakers 影子保留', async (t) => {
  const realHearingUrl = `${hearingUrl}?real-speaker-candidates`;
  const { startHearing } = await import(realHearingUrl);
  const child = new FakeChild();
  const updates = [];
  const rows = [];
  const samples = [];
  let matchCalls = 0;
  const clip = tone(1000);
  const embedding = Float32Array.from([0.9, 0.3, 0.1, 0.2]);
  const embedCalls = [];
  const hearing = startHearing({
    ffmpegPath: 'ffmpeg-not-used',
    modelDir: 'models-not-used',
    finalModelDir: '',
    device: 'fake-device',
    recognizer: fakeStreaming({ endpointAtSamples: clip.length / 2, text: '好' }),
    spawnProcess: () => child,
    asrWorkerFactory: () => fakeWorker('好'),
    speakerShadow: true,
    speakerEmbedderFactory: () => ({
      embed(value) {
        embedCalls.push(value);
        return embedding;
      },
    }),
    speakerLibrary: {
      list: () => [],
      match: () => {
        matchCalls += 1;
        throw new Error('an empty library must never be matched');
      },
    },
    onSpeakerSample: (sample) => samples.push(sample),
    onUpdate: (event) => updates.push(event),
    onEvent: (type, payload) => rows.push({ type, payload }),
  });
  t.after(() => hearing.stop());

  child.stdout.write(clip);
  await until(() => updates.some((event) => typeof event.final === 'string'), 'the delivered final');
  await until(() => samples.length > 0, 'onSpeakerSample');
  await until(() => rows.some((event) => event.type === 'speaker.shadow'), 'speaker.shadow');
  await delay(30);

  assert.equal(matchCalls, 0, 'no template means no match call');
  assert.equal(embedCalls.length, 1, 'the cold-start candidate computed one embedding');
  assert.equal(samples.length, 1, 'exactly one candidate');
  const [sample] = samples;
  assert.equal(sample.source, 'mic');
  assert.equal(sample.quality, 'ok');
  assert.equal(sample.durationMs, 1000);
  assert.deepEqual([...sample.embedding], [...embedding]);
  assert.equal(sample.samples.length, SAMPLE_RATE, '1 s at 16 kHz');
  let peak = 0;
  for (const value of sample.samples) peak = Math.max(peak, Math.abs(value));
  assert.ok(peak > 0.24 && peak <= 0.26, `the callback PCM keeps the tone level: ${peak}`);
  assert.equal(sample.text, '好');

  const [shadow] = ofType(rows, 'speaker.shadow').map((event) => event.payload);
  assert.equal(typeof shadow.utteranceId, 'string');
  assert.equal(shadow.utteranceId.length > 0, true, 'the no-speakers row is citable');
  const { utteranceId: _shadowId, ...shadowRest } = shadow;
  assert.deepEqual(shadowRest, {
    decision: 'no-speakers',
    class: 'unknown-identity',
    quality: 'ok',
    source: 'mic',
    reason: 'no-speakers',
  }, 'the no-speakers row keeps its old semantic shape');
  assert.deepEqual(updates.filter((event) => typeof event.final === 'string').map((event) => event.final), ['好']);
  console.log(
    `[speaker-candidate-host 1] emptyLibrary embedCalls=${embedCalls.length} candidates=${samples.length} `
    + `shadow=${shadow.decision}/${shadow.reason} matchCalls=${matchCalls}`,
  );
});

// ---------------------------------------------------------------------------
// 2. Host callback writes a valid WAV and admits a pending row
// ---------------------------------------------------------------------------

test('2) 宿主回调：写合法 16k/mono/16bit WAV 并入库（pending、无身份）', async (t) => {
  const app = await mount(t);
  assert.equal((await app.start()).ok, true);
  const callback = app.callback();
  assert.equal(typeof callback, 'function', 'the mic startHearing received onSpeakerSample');

  callback(sampleOf('host-candidate:1', { durationMs: 1000 }));
  await until(async () => candidateStatusOf(await app.status())?.count === 1, 'candidate status count');

  const candidates = await readCandidates(app.root);
  assert.equal(candidates.length, 1);
  const [row] = candidates;
  assert.equal(row.utteranceId, 'host-candidate:1');
  assert.equal(row.source, 'mic');
  assert.equal(row.quality, 'ok');
  assert.equal(row.speakerId, null, 'a candidate never carries an identity');
  assert.equal(row.status, 'pending');
  assert.equal(row.durationMs, 1000);
  assert.equal(row.text, CANDIDATE_TEXT);
  assert.ok(row.audioPath.startsWith(candidateDir(app.root)), 'the audio lives in the candidate cache');

  const files = (await readdir(candidateDir(app.root))).filter((name) => name.endsWith('.wav'));
  assert.equal(files.length, 1, 'one WAV for one candidate');
  assert.match(files[0], /^candidate-[0-9a-f]+\.wav$/u, 'the file name is path-safe');
  const wav = assertWav(await readFile(row.audioPath));
  assert.equal(wav.samples, SAMPLE_RATE, '1 s at 16 kHz');
  assert.equal((await readdir(candidateDir(app.root))).some((name) => name.endsWith('.tmp')), false,
    'an atomic write leaves no temp file');

  const snapshot = await app.status();
  const status = candidateStatusOf(snapshot);
  assert.deepEqual(Object.keys(status).sort(), ['count', 'groups', 'newestAt', 'oldestAt', 'totalDurationMs']);
  assert.equal(status.count, 1);
  assert.equal(status.totalDurationMs, 1000);
  assert.equal(status.groups, 1);
  assert.ok(Number.isFinite(Date.parse(status.oldestAt)));
  assert.equal(status.oldestAt, status.newestAt);
  const serialized = JSON.stringify(status);
  assert.equal(serialized.includes(CANDIDATE_TEXT), false, 'status carries no transcript text');
  assert.equal(serialized.includes(row.audioPath), false, 'status carries no audio path');
  assert.equal(serialized.includes('embedding'), false);

  const events = await app.events();
  assert.ok(ofType(events, 'speaker.candidates.added').length >= 1);
  const addedPayload = JSON.stringify(ofType(events, 'speaker.candidates.added').map((event) => event.payload));
  assert.equal(addedPayload.includes(CANDIDATE_TEXT), false, 'events carry no transcript text');
  assert.equal(addedPayload.includes(row.audioPath), false, 'events carry no audio path');
  console.log(
    `[speaker-candidate-host 2] wav=${wav.samples}samples/${wav.dataSize}B statusCount=${status.count} `
    + `groups=${status.groups} pending=${row.status} speakerId=${row.speakerId}`,
  );
});

// ---------------------------------------------------------------------------
// 3. Loopback is never stored
// ---------------------------------------------------------------------------

test('3) loopback：回调被拒绝，不写音频、不入库', async (t) => {
  const app = await mount(t);
  assert.equal((await app.start()).ok, true);
  app.callback()(sampleOf('host-loopback:1', { source: 'loopback' }));

  await app.waitForEvent('speaker.candidates.skipped', (payload) => payload.reason === 'invalid-source');
  assert.deepEqual(await readCandidates(app.root), []);
  assert.equal(existsSync(candidateDir(app.root)), false, 'no audio directory is created');
  assert.equal(candidateStatusOf(await app.status()).count, 0);
  const events = await app.events();
  assert.equal(ofType(events, 'speaker.candidates.added').length, 0);
  console.log('[speaker-candidate-host 3] loopback=refused files=0 rows=0');
});

// ---------------------------------------------------------------------------
// 4. Privacy / close / unload / late callback
// ---------------------------------------------------------------------------

test('4) 隐私/关闭/卸载/迟到回调：都不新增候选', async (t) => {
  const app = await mount(t);
  assert.equal((await app.start()).ok, true);
  const first = app.callback();
  first(sampleOf('host-state:1'));
  await until(async () => candidateStatusOf(await app.status())?.count === 1, 'first candidate');

  // Late callback queued by a stopped session.
  await app.stop();
  first(sampleOf('host-state:2'));
  assert.equal(candidateStatusOf(await app.status()).count, 1, 'a stopped session cannot add');

  // Component enable again, add one, then close the component.
  assert.equal((await app.action({ action: 'feature.set', id: 'hearing', enabled: true })).ok, true);
  assert.equal((await app.start()).ok, true);
  const second = app.callback();
  second(sampleOf('host-state:3'));
  await until(async () => candidateStatusOf(await app.status())?.count === 2, 'second candidate');
  const closed = await app.action({ action: 'feature.set', id: 'hearing', enabled: false });
  assert.equal(closed.ok, true, closed.error);
  second(sampleOf('host-state:4'));
  assert.equal(candidateStatusOf(await app.status()).count, 2, 'a disabled component cannot add');

  // A new session, then privacy.
  assert.equal((await app.action({ action: 'feature.set', id: 'hearing', enabled: true })).ok, true);
  assert.equal((await app.start()).ok, true);
  const third = app.callback();
  const privacy = await app.action({ action: 'vision.mode', mode: 'privacy' });
  assert.equal(privacy.ok, true, privacy.error);
  third(sampleOf('host-state:5'));
  assert.equal(candidateStatusOf(await app.status()).count, 2, 'privacy refuses a candidate');
  // A callback queued by an even older session is dropped after the new generation too.
  first(sampleOf('host-state:6'));
  assert.equal(candidateStatusOf(await app.status()).count, 2, 'a stale generation cannot add');

  // Leave privacy, open a fresh generation, then unload.
  assert.equal((await app.action({ action: 'privacy.toggle' })).ok, true);
  await app.stop();
  assert.equal((await app.start()).ok, true);
  const fourth = app.callback();
  fourth(sampleOf('host-state:7'));
  await until(async () => candidateStatusOf(await app.status())?.count === 3, 'third candidate');
  await app.dispose();
  fourth(sampleOf('host-state:8'));
  assert.equal((await readCandidates(app.root)).length, 3, 'unload invalidates the queued callback');

  const events = await app.events();
  const skipped = ofType(events, 'speaker.candidates.skipped').map((event) => event.payload.reason);
  for (const reason of ['stale-generation', 'hearing-disabled', 'privacy']) {
    assert.ok(skipped.includes(reason), `expected a ${reason} skip row, got ${skipped.join(',')}`);
  }
  const added = ofType(events, 'speaker.candidates.added').length;
  assert.equal(added, 3, 'only the three accepted callbacks were counted');
  console.log(
    `[speaker-candidate-host 4] candidates=${await readCandidates(app.root).then((rows) => rows.length)} `
    + `skipped=${[...new Set(skipped)].join(',')} added=${added}`,
  );
});

// ---------------------------------------------------------------------------
// 5. Status counts/groups + audio write failure
// ---------------------------------------------------------------------------

test('5) status 计数/分组（无正文/路径/embedding）；音频写入失败只记事件', async (t) => {
  const app = await mount(t);
  assert.equal((await app.start()).ok, true);
  const callback = app.callback();
  callback(sampleOf('host-group:1', { durationMs: 1000, embedding: [1, 0, 0] }));
  callback(sampleOf('host-group:2', { durationMs: 1200, embedding: [0.8, 0.6, 0] }));
  callback(sampleOf('host-group:3', { durationMs: 1400, embedding: [0, 1, 0] }));
  await until(async () => candidateStatusOf(await app.status())?.count === 3, 'three candidates');

  const status = candidateStatusOf(await app.status());
  assert.equal(status.count, 3);
  assert.equal(status.totalDurationMs, 3600);
  assert.equal(status.groups, 2, '0.8-similar pair = one group; the orthogonal clip = another');
  assert.ok(Number.isFinite(Date.parse(status.oldestAt)) && Number.isFinite(Date.parse(status.newestAt)));
  assert.ok(Date.parse(status.oldestAt) <= Date.parse(status.newestAt));
  const serialized = JSON.stringify(status);
  assert.equal(serialized.includes(CANDIDATE_TEXT), false);
  assert.equal(serialized.includes(app.root), false);
  assert.equal(serialized.includes('embedding'), false);

  // A write failure: make `<root>/cache` a regular file, so the WAV directory cannot be created.
  const broken = await mount(t);
  assert.equal((await broken.start()).ok, true);
  await writeFile(join(broken.root, 'cache'), 'not a directory');
  broken.callback()(sampleOf('host-broken:1'));
  const failure = await broken.waitForEvent('speaker.candidates.write-failed');
  assert.equal(failure.payload.reason, 'write-failed');
  assert.equal(typeof failure.payload.code, 'string');
  assert.deepEqual(await readCandidates(broken.root), [], 'a failed audio write stores no metadata');
  assert.equal(candidateStatusOf(await broken.status()).count, 0);
  const brokenEvents = await broken.events();
  assert.equal(ofType(brokenEvents, 'speaker.candidates.added').length, 0);
  assert.equal(JSON.stringify(brokenEvents).includes(CANDIDATE_TEXT), false);
  console.log(
    `[speaker-candidate-host 5] groups=${status.groups} count=${status.count} totalMs=${status.totalDurationMs} `
    + `writeFailed=${failure.payload.code} rowsAfterFailure=0`,
  );
});

// ---- real-hearing clip helpers -------------------------------------------

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
  }

  kill() {}
}

function tone(ms) {
  const samples = new Int16Array(Math.round((SAMPLE_RATE * ms) / 1000));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.round(Math.sin((2 * Math.PI * 440 * index) / SAMPLE_RATE) * 0.25 * 32767);
  }
  const buffer = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) buffer.writeInt16LE(samples[index], index * 2);
  return buffer;
}

function fakeStreaming({ endpointAtSamples, text }) {
  return {
    createStream: () => ({
      samples: 0,
      acceptWaveform({ samples }) { this.samples += samples.length; },
    }),
    isReady: () => false,
    decode: () => {},
    getResult: (stream) => ({ text: stream.samples > 0 ? text : '' }),
    isEndpoint: (stream) => stream.samples >= endpointAtSamples,
    reset(stream) { stream.samples = 0; },
  };
}

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

// ---------------------------------------------------------------------------
// 6. Automatic training: weak match stays in the cache; reliable match trains once
// ---------------------------------------------------------------------------

test('6) reliable matched inputs update their own voiceprint; a second pool build coexists', async (t) => {
  const app = await mount(t);
  assert.equal((await app.start()).ok, true);
  const callback = app.callback();
  assert.equal(typeof callback, 'function');

  for (let index = 0; index < 3; index += 1) {
    callback(sampleOf(`auto-seed:${index}`, { durationMs: 1200, embedding: [1, 0, 0] }));
  }
  await until(async () => candidateStatusOf(await app.status())?.count === 3, 'seed candidates');
  const built = await app.action({ action: 'speaker.candidates.build', label: '声纹一' });
  assert.equal(built.ok, true, built.error ?? built.reason);
  const firstId = String(built.speakerId ?? '');
  assert.notEqual(firstId, '');
  assert.equal(candidateStatusOf(await app.status()).count, 0);

  const shortAnswer = sampleOf('auto-short:1', {
    decision: 'match', speakerId: firstId, score: 0.92, shadowQuality: 'ok',
    durationMs: 1000, embedding: [1, 0, 0],
  });
  callback(shortAnswer);
  await until(async () => ofType(await app.events(), 'speaker.auto.trained').length >= 1,
    'short reliable sample trains');
  assert.equal(candidateStatusOf(await app.status()).count, 0,
    'a trained short answer does not enter the candidate cache');

  const secondMatch = sampleOf('auto-good:2', {
    decision: 'match', speakerId: firstId, score: 0.91, shadowQuality: 'ok',
    durationMs: 5000, embedding: [1, 0, 0],
  });
  callback(secondMatch);
  await until(async () => ofType(await app.events(), 'speaker.auto.trained').length >= 2,
    'second matched input trains');
  let events = await app.events();
  assert.equal(ofType(events, 'speaker.auto.trained').map((event) => event.payload)
    .filter((row) => row.speakerId === firstId).length, 2);
  assert.equal(candidateStatusOf(await app.status()).count, 0);

  // A repeated callback for the same utterance is de-duplicated, not a second sample.
  callback(secondMatch);
  await new Promise((resolve) => setTimeout(resolve, 100));
  events = await app.events();
  assert.equal(ofType(events, 'speaker.auto.trained').length, 2, 'utterance de-dupe');

  // A matched clip below the reliability floor is review evidence, not training data.
  const weak = sampleOf('auto-weak:3', {
    decision: 'match', speakerId: firstId, score: 0.5, shadowQuality: 'ok',
    durationMs: 3000, embedding: [1, 0, 0],
  });
  callback(weak);
  await until(async () => candidateStatusOf(await app.status())?.count === 1, 'weak match cached');
  assert.equal(ofType(await app.events(), 'speaker.auto.trained').length, 2);
  await app.action({ action: 'speaker.candidates.clear' });

  // An existing voiceprint never blocks a second pool build.
  for (let index = 0; index < 3; index += 1) {
    callback(sampleOf(`auto-seed-b:${index}`, { durationMs: 1200, embedding: [0, 1, 0] }));
  }
  await until(async () => candidateStatusOf(await app.status())?.count === 3, 'second seed candidates');
  const secondBuild = await app.action({ action: 'speaker.candidates.build', label: '声纹二' });
  assert.equal(secondBuild.ok, true, secondBuild.error ?? secondBuild.reason);
  assert.notEqual(String(secondBuild.speakerId), firstId);
  const listed = await app.action({ action: 'speaker.candidates.list' });
  assert.equal(Array.isArray(listed.voiceprints) ? listed.voiceprints.length : 0, 2);

  // A match for the second row updates only that row.
  const secondOnly = sampleOf('auto-second-only', {
    decision: 'match', speakerId: String(secondBuild.speakerId), score: 0.93,
    shadowQuality: 'ok', durationMs: 3000, embedding: [0, 1, 0],
  });
  callback(secondOnly);
  await until(async () => ofType(await app.events(), 'speaker.auto.trained')
    .map((event) => event.payload)
    .some((row) => row.speakerId === String(secondBuild.speakerId)), 'second voiceprint trains');
  const finalList = await app.action({ action: 'speaker.candidates.list' });
  const firstRow = finalList.voiceprints.find((row) => row.speakerId === firstId);
  const secondRow = finalList.voiceprints.find((row) => row.speakerId === String(secondBuild.speakerId));
  assert.equal(firstRow.sampleCount, 5, 'first row unchanged by the second match');
  assert.equal(secondRow.sampleCount, 4, 'second row received exactly its own sample');
});
