/** Optional AbortSignal contracts. All process/frame backends are test doubles. */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const state = { exec: null, frame: null, run: null, pushed: 0, stops: 0 };
globalThis.__sightAbortTest = state;
const hooks = registerHooks({
  load(url, context, next) {
    if (url === 'node:child_process') return {
      format: 'module', shortCircuit: true,
      source: `export const execFile = (...args) => globalThis.__sightAbortTest.exec(...args);
        export const spawn = () => { throw new Error('real spawn forbidden'); };`,
    };
    if (url.endsWith('/dsh-see-now/src/capture.js')) return {
      format: 'module', shortCircuit: true,
      source: `const s = globalThis.__sightAbortTest;
        export const pickScreenEngine = async () => 'ddagrab';
        export const captureArgs = () => ['fake', '-'];
        export const spawnFrames = (options) => { s.frame = options.onFrame; return s.run; };`,
    };
    if (url.endsWith('/dsh-see-now/src/pipeline.js')) return {
      format: 'module', shortCircuit: true,
      source: `export const createPipeline = () => ({
        push() { globalThis.__sightAbortTest.pushed++; },
        take: () => ({ png: Buffer.alloc(24), w: 1, h: 1, frames: [1] }),
      });`,
    };
    return next(url, context);
  },
});
const sight = await import('../src/host/vision/sight.js');
// Load the dynamic storyboard dependencies while these exact module doubles are active.
await Promise.all([import('dsh-see-now/capture'), import('dsh-see-now/pipeline')]);
hooks.deregister();
after(() => { delete globalThis.__sightAbortTest; });

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sight-abort-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const controller = new AbortController();
  return { dir, controller, signal: controller.signal };
}

for (const method of ['capture', 'captureDesktop', 'captureDevice']) {
  test(`${method}: cancellation kills writer and deletes its partial file before rejection`, async (t) => {
    const { dir, controller, signal } = await fixture(t);
    const entered = deferred();
    const closed = deferred();
    let calls = 0;
    let kills = 0;
    state.exec = (command, args, options, callback) => {
      calls++;
      const file = options.env?.ASSISTANT_SHOT_PATH ?? args.at(-1);
      void writeFile(file, 'partial').then(() => entered.resolve());
      return { kill(kind) {
        assert.equal(kind, 'SIGKILL');
        kills++;
        // Emulate an asynchronous process close. The file must not be removed until this.
        void closed.promise.then(() => callback(new Error('killed'), '', ''));
      } };
    };
    const pending = sight[method]({ dir, ffmpegPath: 'fake', signal });
    await entered.promise;
    const reason = new Error('test privacy boundary');
    controller.abort(reason);
    assert.equal(kills, 1);
    assert.equal((await readdir(dir)).length, 1);
    closed.resolve();
    await assert.rejects(pending, (error) => error === reason);
    assert.deepEqual(await readdir(dir), []);
    assert.equal(calls, 1, 'an aborted ddagrab must not retry gdigrab');
  });

  test(`${method}: pre-aborted calls never spawn`, async (t) => {
    const { dir, controller, signal } = await fixture(t);
    controller.abort();
    state.exec = () => assert.fail('must not spawn');
    await assert.rejects(sight[method]({ dir, ffmpegPath: 'fake', signal }), { name: 'AbortError' });
    assert.deepEqual(await readdir(dir), []);
  });
}

test('normal snapshot APIs still accept omitted signal', async (t) => {
  const { dir } = await fixture(t);
  state.exec = (command, args, options, callback) => {
    const file = options.env?.ASSISTANT_SHOT_PATH ?? args.at(-1);
    const png = Buffer.alloc(24);
    png.writeUInt32BE(800, 16); png.writeUInt32BE(450, 20);
    void writeFile(file, png).then(() => callback(null, '800x450', ''));
    return { kill() { assert.fail('normal operation must not kill'); } };
  };
  for (const method of ['capture', 'captureDesktop', 'captureDevice']) {
    const result = await sight[method]({ dir, ffmpegPath: 'fake' });
    assert.equal(result.width, 800);
    assert.equal(result.height, 450);
    await rm(result.file);
  }
  assert.deepEqual(await readdir(dir), []);
});

test('storyboard cancellation stops frames, releases buffer, and rejects future take', async (t) => {
  const { dir, controller, signal } = await fixture(t);
  state.pushed = state.stops = 0;
  const done = deferred();
  state.run = { done: done.promise, stop() { state.stops++; done.resolve(); } };
  const session = await sight.startStoryboard({ dir, ffmpegPath: 'fake', source: { kind: 'obs' }, signal });
  state.frame({});
  assert.equal(state.pushed, 1);
  const sheet = await session.take();
  await rm(sheet.file);
  controller.abort();
  state.frame({});
  assert.equal(state.pushed, 1, 'post-boundary frame is never pushed');
  assert.equal(state.stops, 1);
  assert.equal(session.running, false);
  await assert.rejects(session.take(), { name: 'AbortError' });
  assert.deepEqual(await readdir(dir), []);
});

test('storyboard screen-engine probe is cancellable and never starts frame stream after abort', async (t) => {
  const { dir, controller, signal } = await fixture(t);
  const entered = deferred();
  let killed = false;
  state.exec = (_command, _args, _options, callback) => {
    entered.resolve();
    return { kill() { killed = true; setImmediate(() => callback(new Error('killed'), '', '')); } };
  };
  state.run = null;
  const pending = sight.startStoryboard({ dir, ffmpegPath: 'fake', signal });
  await entered.promise;
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(killed, true);
  assert.deepEqual(await readdir(dir), []);
});

test('aborting an in-flight storyboard write cleans its output before take rejects', async (t) => {
  const { dir, controller, signal } = await fixture(t);
  const done = deferred();
  state.run = { done: done.promise, stop() { done.resolve(); } };
  const session = await sight.startStoryboard({ dir, ffmpegPath: 'fake', source: { kind: 'obs' }, signal });
  const pending = session.take();
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual(await readdir(dir), []);
});

test('review P1: Buffer stderr from a failed engine probe falls back without throwing in the callback', async (t) => {
  const { dir, controller, signal } = await fixture(t);
  const callbackReturned = deferred();
  const done = deferred();
  let probes = 0;
  let closeCallback;
  state.run = { done: done.promise, stop() { done.resolve(); } };
  state.exec = (_command, _args, options, callback) => {
    closeCallback = callback;
    probes++;
    assert.equal(options.encoding, 'buffer');
    setImmediate(() => {
      try {
        callback(new Error('ffmpeg exit 1'), Buffer.alloc(0), Buffer.from('  ddagrab unavailable\n'));
        callbackReturned.resolve(null);
      } catch (error) {
        // Observe the asynchronous callback defect without letting it poison the test runner.
        callbackReturned.resolve(error);
      }
    });
    return { kill() { setImmediate(() => callback(new Error('killed'), Buffer.alloc(0), Buffer.alloc(0))); } };
  };
  const pending = sight.startStoryboard({ dir, ffmpegPath: 'fake', signal });
  const callbackError = await callbackReturned.promise;
  if (callbackError !== null) {
    controller.abort();
    closeCallback(new Error('killed'), '', '');
    await assert.rejects(pending);
  }
  assert.equal(callbackError, null, 'Buffer stderr must not throw from the execFile callback');
  const session = await pending;
  try {
    assert.equal(session.engine, 'gdigrab');
    assert.equal(session.running, true);
    assert.equal(probes, 1);
  } finally {
    session.stop();
  }
  assert.deepEqual(await readdir(dir), []);
});

test('review P1: failed device capture reports trimmed Buffer stderr through rejection', async (t) => {
  const { dir, controller, signal } = await fixture(t);
  const callbackReturned = deferred();
  let closeCallback;
  state.exec = (_command, _args, _options, callback) => {
    closeCallback = callback;
    setImmediate(() => {
      try {
        callback(new Error('ffmpeg exit 1'), Buffer.alloc(0), Buffer.from('  device unavailable\n'));
        callbackReturned.resolve(null);
      } catch (error) {
        callbackReturned.resolve(error);
      }
    });
    return { kill() { setImmediate(() => callback(new Error('killed'), '', '')); } };
  };
  const pending = sight.captureDevice({ dir, ffmpegPath: 'fake', signal });
  const rejected = assert.rejects(pending, { message: 'device unavailable' });
  const callbackError = await callbackReturned.promise;
  if (callbackError !== null) {
    controller.abort(new Error('device unavailable'));
    closeCallback(new Error('killed'), '', '');
  }
  await rejected;
  assert.equal(callbackError, null, 'the failed process must reject, not throw out of its callback');
  assert.deepEqual(await readdir(dir), []);
});