/** A4: fake transports/players only; never contacts a TTS service or plays audio. */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
const state = { spawn: null, edge: null };
globalThis.__ttsAbort = state;
const hooks = registerHooks({
  load(url, context, next) {
    if (url === 'node:child_process') return {
      format: 'module', shortCircuit: true,
      source: `export const spawn = (...args) => globalThis.__ttsAbort.spawn(...args);
        export const execFile = () => { throw new Error('real exec forbidden'); };`,
    };
    if (url.endsWith('/msedge-tts/dist/index.js')) return {
      format: 'module', shortCircuit: true,
      source: `export default { MsEdgeTTS: class { constructor() { return globalThis.__ttsAbort.edge(); } } };`,
    };
    return next(url, context);
  },
});
const tts = await import('../src/host/speech/tts.js');
hooks.deregister();
after(() => { delete globalThis.__ttsAbort; });

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tts-abort-'));
  const controller = new AbortController();
  tts.configureTts();
  state.spawn = () => assert.fail('unexpected player');
  state.edge = () => assert.fail('unexpected Edge connection');
  t.after(async () => {
    tts.stopPlayback();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  return { dir, controller, signal: controller.signal };
}
const settings = () => ({ enabled: true, apiBase: 'http://fake', models: { gptModelPath: 'a', sovitsModelPath: 'b' } });
const wav = Buffer.from('RIFF0123456789WAVE');
const response = () => ({ ok: true, arrayBuffer: async () => wav });
function fetchDouble(t, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = fn;
  t.after(() => { globalThis.fetch = original; });
}
function child() {
  const value = new EventEmitter();
  value.stdin = new PassThrough();
  value.kills = 0;
  value.kill = () => { value.kills++; };
  return value;
}

test('pre-aborted synthesis never invokes a provider', async (t) => {
  const { dir, controller, signal } = await fixture(t);
  let calls = 0;
  tts.configureTts({ edgeSynthesize: async () => { calls++; return {}; } });
  controller.abort();
  await assert.rejects(tts.synthesize({ text: 'hello', dir, signal }), { name: 'AbortError' });
  assert.equal(calls, 0);
});

test('GPT cancellation is not a timeout/failure and never falls back to Edge', async (t) => {
  const { dir, controller, signal } = await fixture(t);
  const entered = deferred();
  let edge = 0;
  const failures = [];
  tts.configureTts({ gptSovits: settings, onGptSovitsFailed: (e) => failures.push(e),
    edgeSynthesize: async () => { edge++; return {}; } });
  fetchDouble(t, async (_url, options) => {
    entered.resolve();
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  });
  const pending = tts.synthesize({ text: 'hello', dir, signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await entered.promise;
  controller.abort();
  await rejected;
  assert.equal(edge, 0);
  assert.deepEqual(failures, []);
  assert.deepEqual(await readdir(dir), []);
});

test('a transport ignoring abort cannot publish late audio', async (t) => {
  const { dir, controller, signal } = await fixture(t);
  const entered = deferred();
  const gate = deferred();
  tts.configureTts({ gptSovits: settings });
  fetchDouble(t, async () => { entered.resolve(); await gate.promise; return response(); });
  const pending = tts.synthesize({ text: 'hello', dir, signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await entered.promise;
  controller.abort();
  gate.resolve();
  await rejected;
  assert.deepEqual(await readdir(dir), []);
});

test('Edge abort during metadata closes its own client, then rejects after late completion', async (t) => {
  const { dir, controller, signal } = await fixture(t);
  const entered = deferred();
  const gate = deferred();
  let closed = 0;
  let streams = 0;
  state.edge = () => ({
    async setMetadata() { entered.resolve(); await gate.promise; },
    async toStream() { streams++; return { audioStream: new PassThrough() }; },
    close() { closed++; },
  });
  const pending = tts.synthesize({ text: 'hello', dir, signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await entered.promise;
  controller.abort();
  assert.ok(closed > 0);
  gate.resolve();
  await rejected;
  assert.equal(streams, 0);
  assert.deepEqual(await readdir(dir), []);
});

test('Edge streaming file is destroyed and removed on abort', async (t) => {
  const { dir, controller, signal } = await fixture(t);
  const entered = deferred();
  const audioStream = new PassThrough();
  state.edge = () => ({ async setMetadata() {}, async toStream() { entered.resolve(); return { audioStream }; }, close() {} });
  const pending = tts.synthesize({ text: 'hello', dir, signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await entered.promise;
  audioStream.write(Buffer.alloc(16));
  await tick();
  controller.abort();
  await rejected;
  assert.equal(audioStream.destroyed, true);
  assert.deepEqual(await readdir(dir), []);
});

test('queued player abort never spawns; active cancellation waits for close before releasing', async (t) => {
  const { controller, signal } = await fixture(t);
  const first = child();
  const secondController = new AbortController();
  const commands = [];
  state.spawn = (command) => { commands.push(command); setImmediate(() => first.emit('spawn')); return first; };
  const playing = tts.play('first.wav', { ffplayPath: 'fake', signal });
  const rejected = assert.rejects(playing, { name: 'AbortError' });
  await tick();
  const queued = tts.play('second.wav', { ffplayPath: 'fake', signal: secondController.signal });
  const queuedRejected = assert.rejects(queued, { name: 'AbortError' });
  secondController.abort();
  await queuedRejected;
  controller.abort();
  assert.equal(first.kills, 1);
  let settled = false;
  playing.catch(() => { settled = true; });
  await tick();
  assert.equal(settled, false);
  first.emit('close', null, 'SIGTERM');
  await rejected;
  assert.deepEqual(commands, ['fake']);
});

test('cancelled ffplay failure never starts WPF; the next player still runs', async (t) => {
  const { controller, signal } = await fixture(t);
  const players = [];
  state.spawn = (command) => { assert.equal(command, 'fake'); const p = child(); players.push(p); return p; };
  const first = tts.play('first.wav', { ffplayPath: 'fake', signal });
  const rejected = assert.rejects(first, { name: 'AbortError' });
  await tick();
  controller.abort();
  players[0].emit('error', new Error('spawn failed'));
  players[0].emit('close');
  await rejected;
  const second = tts.play('second.wav', { ffplayPath: 'fake' });
  await tick();
  assert.equal(players.length, 2);
  players[0].emit('close');
  assert.equal(players[1].kills, 0);
  players[1].emit('close', 0);
  await second;
});

test('stopPlayback cancels waiting slots, not only the currently audible process', async (t) => {
  await fixture(t);
  const p = child();
  let calls = 0;
  state.spawn = () => { calls++; return p; };
  const first = tts.play('first.wav', { ffplayPath: 'fake' });
  const second = tts.play('second.wav', { ffplayPath: 'fake' });
  const results = Promise.allSettled([first, second]);
  await tick();
  assert.equal(tts.stopPlayback(), true);
  p.emit('close');
  await results;
  assert.equal(calls, 1);
});

test('synthesis is serialized and snapshots settings before waiting', async (t) => {
  const { dir } = await fixture(t);
  const entered = deferred();
  const gate = deferred();
  const current = settings();
  const urls = [];
  tts.configureTts({ gptSovits: () => current });
  fetchDouble(t, async (url) => { urls.push(url); if (urls.length === 1) { entered.resolve(); await gate.promise; } return response(); });
  const first = tts.synthesize({ text: 'one', dir });
  await entered.promise;
  const options = { text: 'two', lang: 'ja', dir };
  const second = tts.synthesize(options);
  options.text = 'changed'; options.lang = 'en';
  current.apiBase = 'http://changed';
  await tick();
  assert.equal(urls.length, 1);
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(urls.length, 2);
  assert.equal(urls.every((url) => url.startsWith('http://fake/')), true);
  assert.equal(new URL(urls[1]).searchParams.get('text'), 'two');
  assert.equal(new URL(urls[1]).searchParams.get('text_lang'), 'ja');
});

test('declared audio exceeding the byte limit is rejected before reading and without fallback', async (t) => {
  const { dir } = await fixture(t);
  let reads = 0;
  let edge = 0;
  tts.configureTts({ gptSovits: settings, edgeSynthesize: async () => { edge++; return {}; } });
  fetchDouble(t, async () => ({ ok: true, headers: new Headers({ 'content-length': '999' }),
    arrayBuffer: async () => { reads++; return wav; } }));
  await assert.rejects(tts.synthesize({ text: 'hello', dir, maxBytes: 32 }), { code: 'TTS_AUDIO_LIMIT' });
  assert.equal(reads, 0);
  assert.equal(edge, 0);
  assert.deepEqual(await readdir(dir), []);
});

test('unknown-length response is byte-checked during reading and cancels its reader on overflow', async (t) => {
  const { dir } = await fixture(t);
  let reads = 0;
  let cancelled = false;
  let edge = 0;
  tts.configureTts({ gptSovits: settings, edgeSynthesize: async () => { edge++; return {}; } });
  fetchDouble(t, async () => ({ ok: true, body: { getReader: () => ({
    async read() { reads++; return { done: false, value: Buffer.alloc(20) }; },
    async cancel() { cancelled = true; }, releaseLock() {},
  }) } }));
  await assert.rejects(tts.synthesize({ text: 'hello', dir, maxBytes: 32 }), { code: 'TTS_AUDIO_LIMIT' });
  assert.equal(reads, 2);
  assert.equal(cancelled, true);
  assert.equal(edge, 0);
  assert.deepEqual(await readdir(dir), []);
});

test('ordinary ffplay launch failure falls back once; cancellation during WPF kills only WPF', async (t) => {
  const { controller, signal } = await fixture(t);
  const commands = [];
  const wpf = child();
  state.spawn = (command) => {
    commands.push(command);
    if (command === 'fake') {
      const p = child();
      setImmediate(() => p.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' })));
      return p;
    }
    setImmediate(() => wpf.emit('spawn'));
    return wpf;
  };
  const pending = tts.play('file.wav', { ffplayPath: 'fake', signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await tick(); await tick();
  assert.deepEqual(commands, ['fake', 'powershell']);
  controller.abort();
  assert.equal(wpf.kills, 1);
  wpf.emit('close');
  await rejected;
});

test('Edge pipe streaming abort closes transport/writer/player without a later launch', async (t) => {
  const { dir, controller, signal } = await fixture(t);
  const entered = deferred();
  const audioStream = new PassThrough();
  const p = child();
  let closed = 0;
  state.edge = () => ({ async setMetadata() {}, async toStream() { return { audioStream }; }, close() { closed++; } });
  state.spawn = () => { entered.resolve(); setImmediate(() => p.emit('spawn')); return p; };
  const pending = tts.speakStreaming({ text: 'hello', dir, signal, ffplayPath: 'fake' });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await entered.promise;
  audioStream.write(Buffer.alloc(16));
  await tick();
  controller.abort();
  p.emit('close');
  await rejected;
  assert.ok(p.kills >= 1);
  assert.ok(closed >= 1);
  assert.equal(audioStream.destroyed, true);
  assert.deepEqual(await readdir(dir), []);
});

test('weight application waits for old synthesis and player cleanup, invalidating old snapshots', async (t) => {
  const { dir } = await fixture(t);
  const entered = deferred();
  const release = deferred();
  const current = settings();
  const p = child();
  const calls = [];
  state.spawn = () => p;
  tts.configureTts({ gptSovits: () => current });
  const oldSnapshot = tts.captureTtsSnapshot();
  fetchDouble(t, async (url) => {
    calls.push(url);
    if (calls.length === 1) { entered.resolve(); await release.promise; return response(); }
    return { ok: true, status: 200, text: async () => 'ok', arrayBuffer: async () => wav };
  });
  const synthesis = tts.synthesize({ text: 'old', dir });
  const playback = tts.play('old.wav', { ffplayPath: 'fake' });
  const settled = Promise.allSettled([synthesis, playback]);
  await entered.promise;
  const applying = tts.applyGptSovitsModels();
  release.resolve();
  await tick(); await tick();
  assert.equal(calls.length, 1, 'no weight request while player still owns its slot');
  p.emit('close');
  assert.equal((await applying).ok, true);
  assert.deepEqual((await settled).map(r => r.status), ['rejected', 'rejected']);
  await assert.rejects(tts.synthesize({ text: 'stale', dir, snapshot: oldSnapshot }), { name: 'AbortError' });
  assert.equal(calls.length, 4, 'old synthesis + GPT switch + SoVITS switch + warmup');
  assert.deepEqual(await readdir(dir), []);
});

test('warmup and regular synthesis share one provider slot', async (t) => {
  const { dir } = await fixture(t);
  const entered = deferred();
  const release = deferred();
  let calls = 0;
  tts.configureTts({ gptSovits: settings });
  fetchDouble(t, async () => { if (++calls === 1) { entered.resolve(); await release.promise; } return response(); });
  const warmup = tts.warmupGptSovits({ dir });
  await entered.promise;
  const synthesis = tts.synthesize({ text: 'regular', dir });
  await tick();
  assert.equal(calls, 1);
  release.resolve();
  await Promise.all([warmup, synthesis]);
  assert.equal(calls, 2);
});

test('new Edge streaming cannot deadlock the weight-application playback barrier', async (t) => {
  const { dir } = await fixture(t);
  const gate = deferred(), applyingStarted = deferred();
  const p = child();
  state.spawn = () => p;
  const playing = tts.play('old.wav', { ffplayPath: 'fake' });
  const cancelled = assert.rejects(playing, { name: 'AbortError' });
  fetchDouble(t, async () => { applyingStarted.resolve(); await gate.promise; return response(); });
  tts.configureTts({ gptSovits: settings });
  const applying = tts.applyGptSovitsModels();
  tts.configureTts();
  state.edge = () => ({
    async setMetadata() {},
    async toStream() { const audioStream = new PassThrough(); audioStream.end(wav); return { audioStream }; }, close() {},
  });
  const controller = new AbortController();
  const streaming = tts.speakStreaming({ text: 'new', dir, signal: controller.signal, ffplayPath: 'fake' });
  const streamingCancelled = assert.rejects(streaming, { name: 'AbortError' });
  p.emit('close');
  let timer;
  try {
    await Promise.race([applyingStarted.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('weight barrier deadlocked')), 1000); })]);
  } finally {
    clearTimeout(timer);
    controller.abort(); gate.resolve();
    await Promise.allSettled([applying, cancelled, streamingCancelled]);
  }
});

test('Edge pipe player failure closes a stalled source and retains playback until child close', async (t) => {
  const { dir } = await fixture(t);
  const entered = deferred(), audioStream = new PassThrough(), p = child();
  state.edge = () => ({ async setMetadata() {}, async toStream() { return { audioStream }; }, close() {} });
  state.spawn = () => { entered.resolve(); return p; };
  const streaming = tts.speakStreaming({ text: 'old', dir, ffplayPath: 'fake' });
  const rejected = assert.rejects(streaming);
  await entered.promise;
  p.emit('error', new Error('player failed'));
  const replacement = child();
  let launched = false;
  state.spawn = () => { launched = true; return replacement; };
  const next = tts.play('new.wav', { ffplayPath: 'fake' });
  await tick(); await tick();
  assert.equal(launched, false, 'old process cleanup retains playback ownership');
  assert.equal(audioStream.destroyed, true);
  p.emit('close', 1);
  await rejected;
  await tick();
  assert.equal(launched, true);
  replacement.emit('close', 0);
  await next;
  assert.deepEqual(await readdir(dir), []);
});

test('Edge pipe success publishes a complete file but holds its player slot until close', async (t) => {
  const { dir } = await fixture(t);
  const p = child(), audioStream = new PassThrough();
  state.edge = () => ({ async setMetadata() {}, async toStream() { setImmediate(() => audioStream.end(wav)); return { audioStream }; }, close() {} });
  let launches = 0;
  state.spawn = () => { launches++; return p; };
  const result = await tts.speakStreaming({ text: 'hello', dir, ffplayPath: 'fake' });
  assert.equal(result.bytes, wav.length);
  const controller = new AbortController();
  const queued = tts.play('next.wav', { ffplayPath: 'fake', signal: controller.signal });
  const rejected = assert.rejects(queued, { name: 'AbortError' });
  await tick();
  assert.equal(launches, 1);
  controller.abort();
  await rejected;
  tts.stopTts();
  p.emit('close', 0);
  for (let i = 0; i < 5; i++) await tick();
  assert.equal((await readdir(dir)).length, 1, 'a completed explicit output remains available after playback cancellation');
});

test('synthesis FIFO refuses overflow without invoking another provider', async (t) => {
  const { dir } = await fixture(t);
  const entered = deferred(), release = deferred();
  let calls = 0;
  tts.configureTts({ edgeSynthesize: async ({ signal }) => { calls++; entered.resolve(); await release.promise; signal.throwIfAborted(); return {}; } });
  const jobs = [tts.synthesize({ text: 'active', dir })];
  await entered.promise;
  for (let i = 0; i < 32; i++) jobs.push(tts.synthesize({ text: 'queued', dir }));
  const settled = Promise.allSettled(jobs);
  await assert.rejects(tts.synthesize({ text: 'overflow', dir }), { code: 'TTS_QUEUE_FULL' });
  tts.stopTts(); release.resolve();
  assert.equal((await settled).every(r => r.status === 'rejected'), true);
  assert.equal(calls, 1);
});

test('cancelling weight application while its playback barrier waits sends no remote request', async (t) => {
  await fixture(t);
  const p = child();
  state.spawn = () => p;
  tts.configureTts({ gptSovits: settings });
  let calls = 0;
  fetchDouble(t, async () => { calls++; return response(); });
  const playback = tts.play('old.wav', { ffplayPath: 'fake' });
  const playbackCancelled = assert.rejects(playback, { name: 'AbortError' });
  const applying = tts.applyGptSovitsModels();
  const rejected = assert.rejects(applying, { name: 'AbortError' });
  await tick();
  tts.stopTts();
  p.emit('close');
  await Promise.all([playbackCancelled, rejected]);
  assert.equal(calls, 0);
});

/** A fake provider that leaves its clip on disk, then aborts one microtask after reporting it. */
function lateAbortSynthesis({ file, controller }) {
  return () => {
    const written = writeFile(file, 'audio');
    return {
      then(resolve) {
        void written.then(() => {
          resolve({ file, bytes: 5, durationMs: 10, provider: 'fake' });
          // Resolves before the abort: the slot's hand-off check sees the cancellation, so the
          // consumer never receives this path and the producer still owns the file.
          queueMicrotask(() => controller.abort());
        });
      },
    };
  };
}

test('a) synthesize: a cancellation at hand-off deletes the clip the consumer never received', async (t) => {
  const { dir, controller, signal } = await fixture(t);
  const audio = join(dir, 'late.mp3');
  tts.configureTts({ edgeSynthesize: lateAbortSynthesis({ file: audio, controller }) });
  await assert.rejects(tts.synthesize({ text: 'hello', dir, signal }), { name: 'AbortError' });
  const left = await readdir(dir);
  t.diagnostic(`a) files after cancel: ${JSON.stringify(left)}`);
  assert.deepEqual(left, []);
});

test('b) speakSentences: the same hand-off cancellation rejects the queue and deletes the clip', async (t) => {
  const { dir, controller, signal } = await fixture(t);
  const audio = join(dir, 'sentence.mp3');
  tts.configureTts({ edgeSynthesize: lateAbortSynthesis({ file: audio, controller }) });
  await assert.rejects(tts.speakSentences(['第一句。'], { dir, signal }), { name: 'AbortError' });
  const left = await readdir(dir);
  t.diagnostic(`b) files after cancel: ${JSON.stringify(left)}`);
  assert.deepEqual(left, []);
});

test('c) a delivered synthesis keeps its clip on disk', async (t) => {
  const { dir } = await fixture(t);
  const audio = join(dir, 'kept.mp3');
  tts.configureTts({ edgeSynthesize: async () => {
    await writeFile(audio, 'audio');
    return { file: audio, bytes: 5, durationMs: 10, provider: 'fake' };
  } });
  const result = await tts.synthesize({ text: 'hello', dir });
  assert.equal(result.file, audio);
  const left = await readdir(dir);
  t.diagnostic(`c) files after normal completion: ${JSON.stringify(left)}`);
  assert.deepEqual(left, ['kept.mp3'], 'the consumer-owned clip must not be swept');
});

test('d) a failing cleanup still rejects AbortError and reports the file it could not delete', async (t) => {
  const { dir, controller, signal } = await fixture(t);
  const audio = join(dir, 'stuck.mp3');
  const failures = [];
  tts.configureTts({
    onAudioCleanupFailed: (event) => failures.push(event),
    removeAudioFile: async () => { throw new Error('rm denied'); },
    edgeSynthesize: lateAbortSynthesis({ file: audio, controller }),
  });
  await assert.rejects(tts.synthesize({ text: 'hello', dir, signal }), { name: 'AbortError' });
  assert.deepEqual(failures, [{ file: audio, error: 'rm denied' }]);
  t.diagnostic(`d) files after failed cleanup: ${JSON.stringify(await readdir(dir))}`);
  assert.deepEqual(await readdir(dir), ['stuck.mp3']);
});

/**
 * Leaves its clip on disk, then aborts two microtasks later: the synthesis slot has already
 * delivered the result to `speakStreaming`, but that caller has not run its post-await check,
 * so neither the producer nor the consumer owns the clip at that instant.
 */
function deliveredAbortSynthesis({ file, controller }) {
  return () => {
    const written = writeFile(file, 'audio');
    return {
      then(resolve) {
        void written.then(() => {
          resolve({ file, bytes: 5, durationMs: 10, provider: 'fake' });
          queueMicrotask(() => queueMicrotask(() => controller.abort()));
        });
      },
    };
  };
}

test('e) speakStreaming file path: a cancellation at the consumer hand-off deletes the clip', async (t) => {
  const { dir, controller, signal } = await fixture(t);
  const audio = join(dir, 'handoff.mp3');
  let spawned = 0;
  state.spawn = () => { spawned++; return child(); };
  tts.configureTts({ edgeSynthesize: deliveredAbortSynthesis({ file: audio, controller }) });
  await assert.rejects(tts.speakStreaming({ text: 'hello', dir, signal }), { name: 'AbortError' });
  const left = await readdir(dir);
  t.diagnostic(`e) files after cancel: ${JSON.stringify(left)}`);
  assert.equal(spawned, 0, 'the cancelled clip must never reach a player');
  assert.deepEqual(left, []);
});

test('f) speakStreaming file path: a delivered clip is kept for its consumer', async (t) => {
  const { dir } = await fixture(t);
  const audio = join(dir, 'kept.mp3');
  const players = [];
  state.spawn = () => { const p = child(); players.push(p); return p; };
  tts.configureTts({ edgeSynthesize: async () => {
    await writeFile(audio, 'audio');
    return { file: audio, bytes: 5, durationMs: 10, provider: 'fake' };
  } });
  const result = await tts.speakStreaming({ text: 'hello', dir });
  assert.equal(result.file, audio);
  const left = await readdir(dir);
  t.diagnostic(`f) files after normal completion: ${JSON.stringify(left)}`);
  assert.deepEqual(left, ['kept.mp3'], 'the consumer-owned clip must not be swept');
  for (const p of players) p.emit('close', 0);
  await tick();
});

test('g) speakStreaming file path: a failing cleanup still rejects AbortError and reports the file', async (t) => {
  const { dir, controller, signal } = await fixture(t);
  const audio = join(dir, 'stuck.mp3');
  const failures = [];
  tts.configureTts({
    onAudioCleanupFailed: (event) => failures.push(event),
    removeAudioFile: async () => { throw new Error('rm denied'); },
    edgeSynthesize: deliveredAbortSynthesis({ file: audio, controller }),
  });
  await assert.rejects(tts.speakStreaming({ text: 'hello', dir, signal }), { name: 'AbortError' });
  assert.deepEqual(failures, [{ file: audio, error: 'rm denied' }]);
  t.diagnostic(`g) files after failed cleanup: ${JSON.stringify(await readdir(dir))}`);
  assert.deepEqual(await readdir(dir), ['stuck.mp3']);
});