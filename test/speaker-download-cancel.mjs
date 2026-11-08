/**
 * Speaker-voice shadow, HOST download lifecycle: the host holds its OWN AbortController for the
 * shared speaker-model download and releases exactly that subscription when the switch closes, the
 * hearing component closes, the plugin unloads or the Host shuts down. The download layer is the
 * reference counter: while hearing (or any other caller) still waits, only the host detaches and
 * the shared task keeps running; the last caller leaving cancels it, removes its own `.part` and
 * reports `cancelled` (never `failed`).
 *
 *   1. switch OFF mid-download → underlying fetch aborted, `.part` removed, status back to missing;
 *   2. plugin unload (ctx.effect dispose) → same, reason `unload`;
 *   3. Host shutdown notification → same, reason `shutdown`, inside the shutdown deadline;
 *   4. hearing still subscribed → host only detaches (`speaker.download.detached {remaining:1}`),
 *      the shared fetch is NOT aborted and hearing finally gets the model;
 *   5. a late fetch result after cancellation is ignored: no write, no `.part`, no ready event;
 *   6. no cancellation at all → the host subscription completes normally and status is `ready`;
 *   7. regression: `speaker-*`, `model-download`, `voice-lanes`, `shutdown`, `node test/smoke.mjs`.
 *
 * No microphone, network, TTS or GUI is touched; the fetch is a local double.
 *
 * Run: node --test test/speaker-download-cancel.mjs
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { ensureModel } from '../src/host/platform/modelDownload.js';
import { cleanupRoot, disposeAll } from './helpers/cleanup.mjs';

const run = promisify(execFile);
const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SPEAKER_FILE = '3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const childEnv = { ...process.env };
delete childEnv.NODE_TEST_CONTEXT;
const runSuite = (file, args = []) => run(process.execPath, [...args, file], {
  cwd: PROJECT_ROOT,
  env: childEnv,
  maxBuffer: 64 * 1024 * 1024,
});

/** Poll until `predicate()` is true; a missed deadline fails the test instead of hanging it. */
async function until(predicate, label, timeoutMs = 8000) {
  const startedAt = Date.now();
  while (!(await predicate())) {
    if (Date.now() - startedAt > timeoutMs) assert.fail(`timed out: ${label}`);
    await delay(10);
  }
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const responseOf = (body) => ({
  ok: true,
  status: 200,
  arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
});

/**
 * A local fetch double. `abortable`: the request rejects with AbortError when its attempt signal
 * aborts (a real download). `ignoreSignal`: the attempt signal is observed but the body is still
 * released later — the "late result after cancellation" case. `release()` resolves a gated body.
 */
function controlledFetch({ body, ignoreSignal = false } = {}) {
  const stats = { fetches: 0, aborts: 0 };
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fetchImpl = async (_url, init = {}) => {
    stats.fetches += 1;
    const signal = init?.signal;
    if (ignoreSignal) {
      signal?.addEventListener('abort', () => { stats.aborts += 1; }, { once: true });
      await gate;
      return responseOf(body);
    }
    await new Promise((resolve, reject) => {
      const onAbort = () => {
        stats.aborts += 1;
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      };
      if (signal?.aborted === true) onAbort();
      else {
        signal?.addEventListener('abort', onAbort, { once: true });
        gate.then(() => {
          signal?.removeEventListener?.('abort', onAbort);
          resolve();
        });
      }
    });
    return responseOf(body);
  };
  return { fetchImpl, stats, release };
}

async function partFiles(dir) {
  let names = [];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  return names.filter((name) => name.endsWith('.part')).map((name) => join(dir, name)).sort();
}

// ---------------------------------------------------------------------------
// Module seam: recording hearing only (the real modelDownload is exercised)
// ---------------------------------------------------------------------------

const state = { starts: [], sessions: [] };
globalThis.__speakerDownloadTest = state;

const hearingUrl = new URL('../src/host/hearing/hearing.js', import.meta.url).href;

const hook = registerHooks({
  load(url, context, next) {
    if (url === hearingUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    const s = globalThis.__speakerDownloadTest;
    export const modelReady = () => true;
    export const finalModelReady = () => true;
    export const isLoopbackDevice = (name) => /CABLE|Stereo Mix|Virtual/i.test(String(name));
    export const selectMicrophoneDevice = (devices, requested) => ({
      device: requested || devices[0] || '', loopback: false, error: '',
    });
    export const listDevices = async () => ['Fake Mic'];
    export const startHearing = (options) => {
      s.starts.push(options);
      let doneResolve;
      const done = new Promise((resolve) => { doneResolve = resolve; });
      const session = { device: options.device, stats: () => ({ rmsDb: -20 }), stop() { doneResolve(); }, done };
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

after(() => { delete globalThis.__speakerDownloadTest; });

// ---------------------------------------------------------------------------
// Host mount
// ---------------------------------------------------------------------------

async function mount(t, { config = {}, settings = {}, connected = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-speaker-cancel-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await mkdir(join(root, 'workspace'), { recursive: true });
  await writeFile(join(root, 'data', 'features.json'), JSON.stringify({
    hearing: true, ambient: false, voice: false, vision: false,
    subtitle: false, avatar: false, memory: false, fastpath: false,
  }));
  await writeFile(join(root, 'data', 'settings.json'), JSON.stringify({
    langs: { speech: 'zh', subtitle: 'zh' },
    autoMemory: { enabled: false },
    voice: { chunking: false },
    ...settings,
  }));

  state.starts = [];
  state.sessions = [];

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
  const descriptor = Object.getOwnPropertyDescriptor(process, 'connected');
  if (connected) Object.defineProperty(process, 'connected', { configurable: true, get: () => true });
  try {
    apply({
      effect,
      on: () => () => {},
      get: () => undefined,
      tools: { register: () => () => {} },
      inject: (_dependencies, registerScope) => registerScope(scope),
    }, { root, enabled: true, asrMergeWindowMs: 10, ...config });
  } finally {
    if (connected) {
      if (descriptor === undefined) delete process.connected;
      else Object.defineProperty(process, 'connected', descriptor);
    }
  }

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
  const dispose = () => disposeAll(disposers);

  t.after(async () => {
    for (const session of state.sessions) session.stop();
    await cleanupRoot(root, disposers);
  });

  return { root, action, status, events, waitForEvent, dispose, modelDir: join(root, 'models') };
}

const ofType = (rows, type) => rows.filter((event) => event.type === type);
const count = (rows, type) => ofType(rows, type).length;

/** The pinned target the host would use, plus a one-attempt failure that leaves a real `.part`. */
function partLeavingFetch(body) {
  let calls = 0;
  const stats = { fetches: 0, aborts: 0 };
  const fetchImpl = (url, init = {}) => {
    calls += 1;
    stats.fetches += 1;
    if (calls % 2 === 1) {
      // Wrong bytes: the attempt writes its own `.part`, verification fails, the retry runs.
      return Promise.resolve(responseOf(body));
    }
    const signal = init?.signal;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        stats.aborts += 1;
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      };
      if (signal?.aborted === true) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    });
  };
  return { fetchImpl, stats };
}

// ---------------------------------------------------------------------------
// 1. switch OFF mid-download
// ---------------------------------------------------------------------------

test('1) 下载中关闭声纹开关 → 底层 abort、.part 清理、status 回 missing', async (t) => {
  const app = await mount(t, { config: { voice: { speakerShadow: false } } });
  const download = partLeavingFetch(Buffer.from('wrong-speaker-bytes'));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = download.fetchImpl;
  t.after(() => { globalThis.fetch = originalFetch; });

  const enabled = await app.action({ action: 'voice.speakerShadow', enabled: true });
  assert.equal(enabled.ok, true);
  assert.equal(enabled.model, 'downloading', 'enabling starts the T1 download');
  await until(() => download.stats.fetches === 2, 'first attempt failed, retry is in flight');
  await until(async () => (await partFiles(app.modelDir)).length === 1, 'the task own .part exists');
  assert.equal((await app.status()).speaker.model, 'downloading');

  const disabled = await app.action({ action: 'voice.speakerShadow', enabled: false });
  assert.equal(disabled.ok, true);
  const cancelled = await app.waitForEvent('speaker.download.cancelled', (payload) => payload.reason === 'disabled');
  assert.equal(cancelled.payload.reason, 'disabled');

  await until(async () => (await partFiles(app.modelDir)).length === 0, 'the cancelled task removes its .part');
  await delay(30);
  let rows = await app.events();
  let snapshot = await app.status();
  assert.equal(download.stats.aborts, 1, 'the in-flight fetch received the abort');
  assert.equal(snapshot.speaker.model, 'missing', 'status is no longer downloading');
  assert.equal(snapshot.speaker.enabled, false);
  assert.equal(count(rows, 'speaker.model.ready'), 0, 'nothing was mounted');
  assert.equal(count(rows, 'speaker.model.failed'), 0, 'a cancellation is not a failure');
  assert.equal(count(rows, 'speaker.download.detached'), 0, 'nobody else was waiting');
  assert.equal(count(rows, 'speaker.model.cancelled'), 1, 'the shared task reported exactly one cancellation');
  assert.equal(ofType(rows, 'speaker.model.cancelled')[0].payload.reason, 'disabled');
  assert.equal(existsSync(join(app.modelDir, SPEAKER_FILE)), false);

  // Closing the hearing component is the other trigger: same host subscription, same cancel reason.
  const again = await app.action({ action: 'voice.speakerShadow', enabled: true });
  assert.equal(again.model, 'downloading');
  await until(() => download.stats.fetches === 4, 'the second download reaches its retry');
  await until(async () => (await partFiles(app.modelDir)).length === 1, 'the second .part exists');
  const closed = await app.action({ action: 'feature.set', id: 'hearing', enabled: false });
  assert.equal(closed.ok, true, closed.error);
  await until(async () => (await partFiles(app.modelDir)).length === 0, 'component close removes the .part');
  await delay(30);
  rows = await app.events();
  snapshot = await app.status();
  assert.equal(download.stats.aborts, 2, 'each closed subscription aborted its own attempt');
  assert.equal(count(rows, 'speaker.download.cancelled'), 2, 'one cancelled row per closed subscription');
  assert.equal(ofType(rows, 'speaker.download.cancelled').at(-1).payload.reason, 'disabled');
  assert.equal(count(rows, 'speaker.model.ready'), 0);
  assert.equal(count(rows, 'speaker.model.failed'), 0);
  assert.notEqual(snapshot.speaker.model, 'downloading', 'component close never leaves status downloading');
  assert.equal(existsSync(join(app.modelDir, SPEAKER_FILE)), false);
  console.log(`[speaker-cancel 1] switchOff=disabled componentClose=disabled fetches=${download.stats.fetches} `
    + `fetchAborts=${download.stats.aborts} partRemoved=true model=${snapshot.speaker.model} `
    + `cancelled=${count(rows, 'speaker.download.cancelled')}/${count(rows, 'speaker.model.cancelled')} `
    + `ready=0 failed=0`);
});

// ---------------------------------------------------------------------------
// 2. plugin unload (ctx.effect dispose)
// ---------------------------------------------------------------------------

test('2) 下载中卸载插件（dispose）→ 取消、.part 清理、status 非 downloading', async (t) => {
  const app = await mount(t, { config: { voice: { speakerShadow: false } } });
  const download = partLeavingFetch(Buffer.from('wrong-speaker-bytes'));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = download.fetchImpl;
  t.after(() => { globalThis.fetch = originalFetch; });

  await app.action({ action: 'voice.speakerShadow', enabled: true });
  await until(() => download.stats.fetches === 2, 'retry in flight');
  await until(async () => (await partFiles(app.modelDir)).length === 1, 'a real .part exists before unload');

  const failures = await app.dispose();
  assert.deepEqual(failures, [], 'every disposer settled');

  const cancelled = await app.waitForEvent('speaker.download.cancelled', (payload) => payload.reason === 'unload');
  assert.equal(cancelled.payload.reason, 'unload');
  await until(async () => (await partFiles(app.modelDir)).length === 0, 'the .part is gone after unload');
  const rows = await app.events();
  assert.equal(download.stats.aborts, 1, 'the in-flight fetch received the abort');
  assert.equal(count(rows, 'speaker.model.ready'), 0);
  assert.equal(count(rows, 'speaker.model.failed'), 0);
  assert.equal(count(rows, 'speaker.download.detached'), 0);
  console.log(`[speaker-cancel 2] reason=unload fetches=${download.stats.fetches} `
    + `fetchAborts=${download.stats.aborts} partRemoved=true ready=0 failed=0`);
});

// ---------------------------------------------------------------------------
// 3. Host shutdown notification
// ---------------------------------------------------------------------------

test('3) 宿主关闭 → 取消（受 shutdown deadline 约束）、无 .part、不误报 downloading', async (t) => {
  const app = await mount(t, {
    config: { voice: { speakerShadow: false }, shutdown: { deadlineMs: 800 } },
    connected: true,
  });
  const download = partLeavingFetch(Buffer.from('wrong-speaker-bytes'));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = download.fetchImpl;
  t.after(() => { globalThis.fetch = originalFetch; });

  await app.action({ action: 'voice.speakerShadow', enabled: true });
  await until(() => download.stats.fetches === 2, 'retry in flight');
  await until(async () => (await partFiles(app.modelDir)).length === 1, 'a real .part exists before shutdown');

  const startedAt = Date.now();
  process.emit('message', { type: 'shutdown' });
  const cancelled = await app.waitForEvent('speaker.download.cancelled', (payload) => payload.reason === 'shutdown');
  const summary = await app.waitForEvent('shutdown.summary');
  const elapsed = Date.now() - startedAt;

  assert.equal(cancelled.payload.reason, 'shutdown');
  assert.ok(elapsed < 800 + 500, `teardown stayed bounded (${elapsed} ms)`);
  const item = summary.payload.items.find((row) => row.name === 'speakerDownload');
  assert.ok(item !== undefined, 'speakerDownload is part of the teardown plan');
  assert.equal(item.confirmed, true, 'the subscription left and its stop confirmed');
  await until(async () => (await partFiles(app.modelDir)).length === 0, 'the .part is gone after shutdown');
  const rows = await app.events();
  assert.equal(download.stats.aborts, 1);
  assert.equal(count(rows, 'speaker.model.ready'), 0);
  assert.equal(count(rows, 'speaker.model.failed'), 0);
  const snapshot = await app.status();
  assert.notEqual(snapshot.speaker.model, 'downloading', 'status never stays on downloading');
  console.log(`[speaker-cancel 3] reason=shutdown deadlineMs=800 elapsedMs=${elapsed} `
    + `itemConfirmed=${item.confirmed} fetchAborts=${download.stats.aborts} model=${snapshot.speaker.model} ready=0`);
});

// ---------------------------------------------------------------------------
// 4. hearing is still a subscriber: host only detaches
// ---------------------------------------------------------------------------

test('4) hearing 仍在等待 → 只退订宿主，下载继续并由 hearing 拿到模型', async (t) => {
  const app = await mount(t, { config: { voice: { speakerShadow: false } } });
  const body = Buffer.from('fake-shared-speaker-model');
  const download = controlledFetch({ body });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = download.fetchImpl;
  t.after(() => { globalThis.fetch = originalFetch; });

  // "hearing" started the shared task first with its own signal (the download layer keys by target).
  const target = join(app.modelDir, SPEAKER_FILE);
  const hearingController = new AbortController();
  const hearing = ensureModel({
    targetPath: target,
    url: 'https://example.invalid/spk.onnx',
    bytes: body.length,
    sha256: sha256(body),
    fetchImpl: download.fetchImpl,
    signal: hearingController.signal,
  });
  await until(() => download.stats.fetches === 1, 'the shared fetch started');

  const enabled = await app.action({ action: 'voice.speakerShadow', enabled: true });
  assert.equal(enabled.model, 'downloading');
  assert.equal(download.stats.fetches, 1, 'the host joined the running task instead of fetching again');

  await app.action({ action: 'voice.speakerShadow', enabled: false });
  const detached = await app.waitForEvent('speaker.download.detached');
  await delay(30);
  let rows = await app.events();
  assert.equal(detached.payload.remaining, 1, 'hearing is still waiting');
  assert.equal(count(rows, 'speaker.download.cancelled'), 0, 'a shared download is not cancelled');
  assert.equal(download.stats.aborts, 0, 'the underlying fetch keeps running');

  download.release();
  const result = await hearing;
  assert.equal(result.ok, true);
  assert.equal(result.path, target);
  assert.equal(result.downloaded, true);
  await until(() => existsSync(target), 'hearing wrote the model');
  const snapshot = await app.status();
  assert.equal(snapshot.speaker.model, 'ready', 'the landed shared model is visible as ready');
  rows = await app.events();
  assert.equal(count(rows, 'speaker.model.failed'), 0);
  assert.equal(count(rows, 'speaker.download.cancelled'), 0);
  console.log(`[speaker-cancel 4] remaining=${detached.payload.remaining} fetchAborts=0 `
    + `hearingResult=ready targetWrote=true model=${snapshot.speaker.model} cancelled=0`);
});

// ---------------------------------------------------------------------------
// 5. late result after cancellation
// ---------------------------------------------------------------------------

test('5) 取消后迟到结果 → 不落盘、不发 completed/ready 事件', async (t) => {
  const app = await mount(t, { config: { voice: { speakerShadow: false } } });
  const body = Buffer.from('late-speaker-model');
  const download = controlledFetch({ body, ignoreSignal: true });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = download.fetchImpl;
  t.after(() => { globalThis.fetch = originalFetch; });

  await app.action({ action: 'voice.speakerShadow', enabled: true });
  await until(() => download.stats.fetches === 1, 'the fetch is in flight');
  await app.action({ action: 'voice.speakerShadow', enabled: false });
  await app.waitForEvent('speaker.download.cancelled', (payload) => payload.reason === 'disabled');
  await delay(20);
  assert.equal(download.stats.aborts, 1, 'the attempt signal was aborted');

  // The body arrives only after the subscription left; the layer must ignore it.
  download.release();
  await delay(120);
  const target = join(app.modelDir, SPEAKER_FILE);
  const rows = await app.events();
  assert.equal(existsSync(target), false, 'the late body is never written');
  assert.deepEqual(await partFiles(app.modelDir), [], 'no half file survives');
  assert.equal(count(rows, 'speaker.model.ready'), 0, 'no completed event');
  assert.equal(count(rows, 'speaker.model.download'), 0, 'no download progress row');
  assert.equal(count(rows, 'speaker.model.failed'), 0, 'a cancellation is not a failure');
  assert.equal(count(rows, 'speaker.model.cancelled'), 1);
  assert.equal((await app.status()).speaker.model, 'missing');
  console.log(`[speaker-cancel 5] lateResult ignored=true wrote=${existsSync(target)} `
    + `ready=0 failed=0 cancelled=1 aborts=${download.stats.aborts}`);
});

// ---------------------------------------------------------------------------
// 6. success path unchanged
// ---------------------------------------------------------------------------

test('6) 无取消的成功路径不变：宿主订阅正常完成、status ready', async (t) => {
  const app = await mount(t, { config: { voice: { speakerShadow: false } } });
  const body = Buffer.from('fake-success-speaker-model');
  const download = controlledFetch({ body });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = download.fetchImpl;
  t.after(() => { globalThis.fetch = originalFetch; });

  const target = join(app.modelDir, SPEAKER_FILE);
  // Another caller starts the shared task with a tiny stand-in definition; the host joins it.
  const other = ensureModel({
    targetPath: target,
    url: 'https://example.invalid/spk.onnx',
    bytes: body.length,
    sha256: sha256(body),
    fetchImpl: download.fetchImpl,
    signal: new AbortController().signal,
  });
  await until(() => download.stats.fetches === 1, 'the shared fetch started');
  const enabled = await app.action({ action: 'voice.speakerShadow', enabled: true });
  assert.equal(enabled.model, 'downloading');
  download.release();
  const result = await other;
  assert.equal(result.ok, true);
  await until(async () => (await app.status()).speaker.model === 'ready', 'status becomes ready');
  await delay(30);
  const rows = await app.events();
  assert.equal(count(rows, 'speaker.download.cancelled'), 0, 'nothing was cancelled');
  assert.equal(count(rows, 'speaker.download.detached'), 0);
  assert.equal(count(rows, 'speaker.model.failed'), 0);
  assert.equal((await app.status()).speaker.enabled, true);
  console.log(`[speaker-cancel 6] completed=true model=ready cancelled=0 detached=0 failed=0`);
});

// ---------------------------------------------------------------------------
// 7. regression
// ---------------------------------------------------------------------------

test('7) 回归：node --check、speaker-* / model-download / voice-lanes / shutdown、smoke', async (t) => {
  for (const file of ['src/host/index.js', 'src/host/platform/modelDownload.js', 'test/speaker-download-cancel.mjs']) {
    await runSuite(file, ['--check']);
  }
  const testDir = fileURLToPath(new URL('.', import.meta.url));
  const names = (await readdir(testDir)).filter((name) => name.endsWith('.mjs'));
  const suites = names.filter((name) => name.startsWith('speaker-')
    || name === 'vad-download.mjs'
    || name === 'voice-lanes.mjs'
    || name === 'shutdown.mjs'
    || name === 'shutdown-diagnostics.mjs');
  assert.ok(suites.includes('speaker-download-cancel.mjs'), 'this suite is part of the regression set');
  assert.ok(suites.length >= 6, `found the speaker/download/shutdown suites: ${suites.length}`);
  for (const name of suites.filter((entry) => entry !== 'speaker-download-cancel.mjs')) {
    await runSuite(join(testDir, name));
  }
  await runSuite('test/smoke.mjs');
  console.log(`[speaker-cancel 7] node --check=ok suites=${suites.length - 1} smoke=ok`);
});
