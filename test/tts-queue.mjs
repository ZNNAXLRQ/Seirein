/** A4 pull queue: controlled synthesis/player boundaries, no real sound. */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const state = { spawn: null };
globalThis.__ttsQueue = state;
const hooks = registerHooks({ load(url, context, next) {
  if (url === 'node:child_process') return { format: 'module', shortCircuit: true,
    source: `export const spawn = (...a) => globalThis.__ttsQueue.spawn(...a);
      export const execFile = () => { throw new Error('real exec forbidden'); };` };
  // The streaming transport opens a real Edge socket. A controlled double keeps this file offline
  // while still exercising speakStreaming's own first-data instrumentation.
  if (url.endsWith('/msedge-tts/dist/index.js')) return { format: 'module', shortCircuit: true,
    source: `import { Readable } from 'node:stream';
      class FakeMsEdgeTTS {
        async setMetadata() {}
        async toStream() {
          let sent = false;
          const audioStream = new Readable({
            read() {
              if (sent) return;
              sent = true;
              setTimeout(() => { this.push(Buffer.from('fake-audio-bytes')); this.push(null); }, 40);
            },
          });
          return { audioStream };
        }
        close() {}
      }
      export default { MsEdgeTTS: FakeMsEdgeTTS };` };
  return next(url, context);
} });
const tts = await import('../src/host/speech/tts.js');
hooks.deregister();
after(() => { delete globalThis.__ttsQueue; });

async function until(predicate) {
  for (let i = 0; i < 1000; i++) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 2)); }
  assert.fail('controlled async boundary did not arrive');
}
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tts-queue-'));
  const players = [];
  const synthesized = [];
  const events = [];
  const controller = new AbortController();
  state.spawn = (_command, args) => {
    const p = new EventEmitter();
    p.file = args.at(-1);
    p.kills = 0;
    p.kill = () => { p.kills++; setImmediate(() => p.emit('close')); };
    players.push(p);
    setImmediate(() => p.emit('spawn'));
    return p;
  };
  tts.configureTts({ edgeSynthesize: async ({ text, signal }) => {
    assert.equal(signal.aborted, false);
    synthesized.push(text);
    const file = join(dir, `${synthesized.length}.mp3`);
    await writeFile(file, 'fake audio');
    return { file, bytes: 10, durationMs: 1000, provider: 'edge-tts' };
  } });
  t.after(async () => {
    controller.abort(); tts.stopTts();
    for (const p of players) p.emit('close');
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  const options = { dir, signal: controller.signal, ffplayPath: 'fake', onEvent: (e) => events.push(e) };
  return { dir, players, synthesized, events, controller, options };
}

test('at most one playing plus one ready/prefetch; source is pulled in order', async (t) => {
  const app = await fixture(t);
  let pulls = 0;
  function* source() { for (const value of ['one', 'two', 'three']) { pulls++; yield value; } }
  const pending = tts.speakSentences(source(), app.options);
  await until(() => app.players.length === 1 && app.events.filter(e => e.type === 'ready').length === 2);
  await tick();
  assert.equal(pulls, 2);
  assert.equal(app.players.length, 1, 'prefetched audio does not start playing');
  assert.equal((await readdir(app.dir)).length, 2);
  app.players[0].emit('close', 0);
  await until(() => app.players.length === 2 && app.synthesized.length === 3);
  app.players[1].emit('close', 0);
  await until(() => app.players.length === 3);
  app.players[2].emit('close', 0);
  const result = await pending;
  assert.equal(result.sentences, 3);
  assert.equal(result.firstAudioAt, null, 'process start is not measured sound-card output');
  assert.deepEqual(app.players.map(p => p.file.split(/[\\/]/u).at(-1)), ['1.mp3', '2.mp3', '3.mp3']);
  assert.deepEqual(await readdir(app.dir), []);
});

test('abort kills current, removes ready file and never launches a queued old sentence', async (t) => {
  const app = await fixture(t);
  const pending = tts.speakSentences(['one', 'two', 'three'], app.options);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await until(() => app.events.filter(e => e.type === 'ready').length === 2);
  app.controller.abort();
  await rejected;
  assert.equal(app.players.length, 1);
  assert.equal(app.players[0].kills, 1);
  assert.deepEqual(app.synthesized, ['one', 'two']);
  assert.deepEqual(await readdir(app.dir), []);
});

test('late noncancellable prefetch is deleted before cancellation settles', async (t) => {
  const app = await fixture(t);
  const entered = deferred();
  const release = deferred();
  let calls = 0;
  tts.configureTts({ edgeSynthesize: async () => {
    calls++;
    if (calls === 2) { entered.resolve(); await release.promise; }
    const file = join(app.dir, `${calls}.mp3`);
    await writeFile(file, 'late');
    return { file, bytes: 4, durationMs: 100, provider: 'edge-tts' };
  } });
  const pending = tts.speakSentences(['one', 'two', 'three'], app.options);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await entered.promise;
  app.controller.abort();
  release.resolve();
  await rejected;
  assert.equal(app.players.length, 1);
  assert.deepEqual(await readdir(app.dir), []);
});

test('prefetch failure stops playback instead of skipping a failed sentence', async (t) => {
  const app = await fixture(t);
  const gate = deferred();
  let count = 0;
  tts.configureTts({ edgeSynthesize: async () => {
    count++;
    if (count === 2) { await gate.promise; throw new Error('synthesis failed'); }
    const file = join(app.dir, 'first.mp3'); await writeFile(file, 'first');
    return { file, bytes: 5, durationMs: 1000, provider: 'edge-tts' };
  } });
  const pending = tts.speakSentences(['one', 'two', 'three'], app.options);
  const rejected = assert.rejects(pending, /synthesis failed/u);
  await until(() => app.players.length === 1);
  gate.resolve();
  await rejected;
  assert.equal(app.players[0].kills, 1);
  assert.equal(count, 2);
  assert.deepEqual(await readdir(app.dir), []);
});

test('text bound is checked before synthesis and iterator closes on failure', async (t) => {
  const app = await fixture(t);
  let closed = false;
  function* source() { try { yield 'x'.repeat(1025); } finally { closed = true; } }
  await assert.rejects(tts.speakSentences(source(), app.options), { code: 'TTS_TEXT_LIMIT' });
  assert.equal(app.synthesized.length, 0);
  assert.equal(closed, true);
});

test('repeated legitimate sentences are not text-deduplicated', async (t) => {
  const app = await fixture(t);
  const pending = tts.speakSentences(['again', 'again'], app.options);
  await until(() => app.players.length === 1);
  app.players[0].emit('close', 0);
  await until(() => app.players.length === 2);
  app.players[1].emit('close', 0);
  await pending;
  assert.deepEqual(app.synthesized, ['again', 'again']);
});

test('stopTts cancels the sentence owner, not merely the player, including a ready prefetch', async (t) => {
  const app = await fixture(t);
  const pending = tts.speakSentences(['one', 'two', 'three'], app.options);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await until(() => app.events.filter(e => e.type === 'ready').length === 2);
  tts.stopTts();
  await rejected;
  assert.equal(app.players.length, 1);
  assert.deepEqual(await readdir(app.dir), []);
});

test('bounded producer counts Unicode code points and flushes its tail once', () => {
  assert.deepEqual([...tts.speechSentences('你好！再见。尾句')], ['你好！', '再见。', '尾句']);
  assert.deepEqual([...tts.speechSentences('😀'.repeat(1024))], ['😀'.repeat(1024)]);
  assert.throws(() => [...tts.speechSentences('😀'.repeat(1025))], { code: 'TTS_TEXT_LIMIT' });
  assert.throws(() => [...tts.speechSentences('a。'.repeat(2049))], { code: 'TTS_TEXT_LIMIT' });
});

test('playback nonzero exit stops rather than silently consuming remaining sentences', async (t) => {
  const app = await fixture(t);
  const pending = tts.speakSentences(['one', 'two', 'three'], app.options);
  const rejected = assert.rejects(pending, /Audio player exit/u);
  await until(() => app.events.filter(e => e.type === 'ready').length === 2);
  app.players[0].emit('close', 1);
  await rejected;
  assert.equal(app.players.length, 1);
  assert.deepEqual(await readdir(app.dir), []);
});

// ---------------------------------------------------------------------------
// spawn -> player-ready (process readiness, never PCM) and slot observations
// ---------------------------------------------------------------------------

test('player spawn -> player-ready is measured with a delayed transport; no PCM is claimed', async (t) => {
  const app = await fixture(t);
  // A fake transport that emits its spawn event 40ms after the process was created.
  state.spawn = () => {
    const child = new EventEmitter();
    child.kill = () => { setImmediate(() => child.emit('close')); };
    setTimeout(() => child.emit('spawn'), 40);
    setTimeout(() => child.emit('close', 0), 80);
    return child;
  };
  let startInfo = null;
  const playing = tts.play(join(app.dir, 'fake.mp3'), {
    ffplayPath: 'fake',
    onStart: (info) => { startInfo = info; },
  });
  await until(() => startInfo !== null);
  await playing;
  assert.ok(startInfo.spawnAt > 0, 'the spawn instant is stamped');
  assert.ok(startInfo.playerReadyAt >= startInfo.spawnAt, 'player-ready is not before spawn');
  assert.ok(startInfo.playerReadyMs >= 40, 'the 40ms transport delay is measured');
  assert.ok(startInfo.playerReadyMs < 1000, 'a sane value, not a clock jump');
  assert.equal(startInfo.startedAt, startInfo.playerReadyAt, 'the anchor is the player-ready instant');
  assert.equal(startInfo.firstPcmAt, null, 'spawn proves the process, not decoded PCM');
  assert.equal(startInfo.firstAudibleAt, null, 'nothing proves speaker sound');
  console.log(`ℹ file: playerReadyMs=${startInfo.playerReadyMs} firstPcmAt=${startInfo.firstPcmAt} firstAudibleAt=${startInfo.firstAudibleAt}`);
});

test('streamed first data is data arrival, never reported as audible PCM', async (t) => {
  const app = await fixture(t);
  // A player whose process is ready before the stream's first byte reaches its stdin.
  state.spawn = () => {
    const child = new EventEmitter();
    child.kill = () => { setImmediate(() => child.emit('close')); };
    child.stdin = new Writable({
      write(_chunk, _encoding, callback) { callback(); },
      final(callback) { callback(); setImmediate(() => child.emit('close', 0)); },
    });
    child.stdin.on('error', () => {});
    app.players.push(child);
    setImmediate(() => child.emit('spawn'));
    return child;
  };
  let startInfo = null;
  let transport = null;
  const pending = tts.speakStreaming({
    text: '你好。',
    dir: app.dir,
    ffplayPath: 'fake',
    onStart: (info) => { startInfo = info; },
    onTransport: (info) => { transport = info; },
  });
  await until(() => startInfo !== null);
  await pending;
  assert.equal(transport?.via, 'ffplay-stream', 'the player close stays the transport end');
  assert.ok(startInfo.spawnAt > 0, 'the spawn instant is stamped');
  assert.ok(startInfo.playerReadyAt > 0, 'the process reported readiness');
  assert.ok(startInfo.playerReadyMs >= 0, 'spawn -> player-ready is measured');
  assert.ok(startInfo.firstDataAt > 0, 'the first data arrival is stamped');
  assert.ok(startInfo.firstDataMs >= 40, 'the delayed arrival is measured from spawn');
  assert.equal(startInfo.firstDataIsAudible, false, 'data arrival is not proof of sound');
  assert.equal(startInfo.firstPcmAt, null, 'no PCM instant is invented from data');
  assert.equal(startInfo.firstAudibleAt, null, 'no audible instant is invented from data');
  assert.equal(startInfo.startedAt, startInfo.firstDataAt, 'the session anchor stays the data time');
  console.log(`ℹ stream: playerReadyMs=${startInfo.playerReadyMs} firstDataMs=${startInfo.firstDataMs} firstDataIsAudible=${startInfo.firstDataIsAudible} firstPcmAt=${startInfo.firstPcmAt} firstAudibleAt=${startInfo.firstAudibleAt}`);
});

test('3 concurrent synthesis calls: slotWaitMs grows and queueDepth is exact', async (t) => {
  const app = await fixture(t);
  const events = [];
  const gates = [deferred(), deferred(), deferred()];
  let calls = 0;
  tts.configureTts({
    onSlotWait: (payload) => events.push(payload),
    edgeSynthesize: async () => {
      const index = calls;
      calls += 1;
      await gates[index].promise;
      return { file: join(app.dir, `${index}.mp3`), bytes: 4, durationMs: 100, provider: 'edge-tts' };
    },
  });
  const synthesize = (text) => tts.synthesize({ text, dir: app.dir });
  const first = synthesize('one');
  await until(() => calls === 1);
  const second = synthesize('two');
  const third = synthesize('three');
  await tick();
  // Let the queued jobs wait long enough for a non-zero measurement, then release in FIFO order.
  await new Promise((resolve) => setTimeout(resolve, 15));
  gates[0].resolve();
  await until(() => calls === 2);
  await new Promise((resolve) => setTimeout(resolve, 15));
  gates[1].resolve();
  await until(() => calls === 3);
  gates[2].resolve();
  const results = await Promise.all([first, second, third]);

  assert.equal(results[0].slotWaitMs, 0, 'the first job got the slot immediately');
  assert.ok(results[1].slotWaitMs >= 15, 'the second job waited behind the first');
  assert.ok(results[2].slotWaitMs >= 15, 'the third job waited too');
  assert.ok(results[2].slotWaitMs >= results[1].slotWaitMs, 'the third waits at least as long');

  // Only a real queue wait is emitted (the throttle); both queued jobs report their position.
  assert.equal(events.length, 2, 'the immediate first job is not emitted');
  assert.deepEqual(events.map((event) => event.queueDepth), [1, 2], 'running + waiting ahead at enqueue');
  assert.deepEqual(events.map((event) => event.purpose), ['speech', 'speech']);
  assert.deepEqual(events.map((event) => event.running), [true, true]);
  assert.ok(events[1].slotWaitMs >= events[0].slotWaitMs);
});
