/**
 * T1 speaker-model startup: the CAM++ model is fetched in the background once the plugin is
 * mounted, independently of the `voice.speakerShadow` switch (still default OFF). The download
 * must never be awaited by mount/startup, must not start capture or turn the shadow on, must
 * survive a failure as `speaker.status.model = missing`, and must still be cancelled by the
 * existing plugin-unload disposer.
 *
 * The download layer is a local double: no network, no real model file and no microphone.
 *
 *   1. mount with the shadow OFF → exactly one ensureSpeakerModel call, status `downloading`,
 *      mount/status still responsive, a second trigger joins the in-flight task (no duplicate);
 *   2. a failed startup download leaves `missing` + errors, logs `speaker.model.failed`, and does
 *      not start capture;
 *   3. disposing the plugin mount aborts the host subscription with reason `unload` and logs
 *      `speaker.download.cancelled`;
 *   4. a test mount without the explicit opt-in starts no download at all, while the manual
 *      enable path still reaches the downloader (the startup gate never weakens explicit use);
 *   5. README states the T1/T2/T3 split, CAM++ as a startup download, and no longer claims the
 *      shadow switch starts the download.
 *
 * Run: node --test test/speaker-model-startup.mjs
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

import { cleanupRoot, disposeAll } from './helpers/cleanup.mjs';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SPEAKER_FILE = '3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx';
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
// Module seams: recording hearing + a controllable, never-online speaker download
// ---------------------------------------------------------------------------

const state = {
  starts: [],
  downloads: [],
  aborts: [],
  download: null,
};
globalThis.__speakerStartupTest = state;

const hearingUrl = new URL('../src/host/hearing/hearing.js', import.meta.url).href;
const modelDownloadUrl = new URL('../src/host/platform/modelDownload.js', import.meta.url).href;

const hook = registerHooks({
  load(url, context, next) {
    if (url === hearingUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    const s = globalThis.__speakerStartupTest;
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
    if (url === modelDownloadUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
    export const SPEAKER_MODEL_FILE = '${SPEAKER_FILE}';
    export function speakerModelTarget({ modelDir = '', finalModelDir = '' } = {}) {
      const base = finalModelDir || modelDir;
      return base ? join(dirname(base), SPEAKER_MODEL_FILE) : '';
    }
    export function isSharedModelTarget(targetPath) {
      return typeof targetPath === 'string' && targetPath.length > 0 && basename(dirname(resolve(targetPath))) === 'models';
    }
    export function vadModelTarget() { return ''; }
    export function ensureVadModel() { return Promise.reject(new Error('vad download forbidden')); }
    export function ensureSpeakerModel(options) {
      const s = globalThis.__speakerStartupTest;
      s.downloads.push(options);
      return new Promise((resolve, reject) => {
        const signal = options.signal;
        const finish = { options, resolve, reject };
        s.download = finish;
        const onAbort = () => {
          const reason = typeof signal?.reason === 'string' ? signal.reason : 'unknown';
          s.aborts.push(reason);
          // The shared download layer calls this caller's onDetach with 0 when the last subscriber
          // leaves, exactly like modelDownload.js does for its own controller.
          options.onDetach?.(0, reason);
          reject(Object.assign(new Error('aborted'), { name: 'AbortError', reason: 'cancelled' }));
        };
        if (signal?.aborted === true) onAbort();
        else signal?.addEventListener?.('abort', onAbort, { once: true });
      });
    }`,
      };
    }
    return next(url, context);
  },
});
const { apply } = await import('../src/host/index.js');
hook.deregister();

after(() => { delete globalThis.__speakerStartupTest; });

// ---------------------------------------------------------------------------
// Host mount (same double shape as the other speaker host tests)
// ---------------------------------------------------------------------------

async function mount(t, { config = {}, settings = {}, startup = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-speaker-startup-'));
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
  state.downloads = [];
  state.aborts = [];
  state.download = null;

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
    tools: { register: () => () => {} },
    inject: (_dependencies, registerScope) => registerScope(scope),
  }, {
    root,
    enabled: true,
    asrMergeWindowMs: 10,
    ...(startup ? { speakerModelStartup: true } : {}),
    ...config,
  });

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

  t.after(async () => { await cleanupRoot(root, disposers); });

  return { root, action, status, events, waitForEvent, dispose };
}

// ---------------------------------------------------------------------------
// 1. Mount starts T1 even while the shadow is OFF (and does not await it)
// ---------------------------------------------------------------------------

test('1) 挂载后无条件启动一次 CAM++ 下载：影子关闭也下载、非阻塞、不并发重复', async (t) => {
  const app = await mount(t, { config: { voice: { speakerShadow: false } } });

  // apply() already returned; the mount-time start is queued for the next event-loop turn.
  await until(() => state.downloads.length === 1, 'mount-time T1 download starts');
  assert.equal(state.downloads.length, 1, 'mount started exactly one T1 download');
  assert.equal(typeof state.download?.resolve, 'function', 'the double download is still in flight');
  assert.equal(state.starts.length, 0, 'startup download never starts microphone capture');

  const target = join(app.root, 'models', SPEAKER_FILE);
  assert.equal(state.downloads[0].targetPath, target, 'the pinned CAM++ target under <root>/models');
  assert.equal(state.downloads[0].cancelReason, 'listener-left');

  let snapshot = await app.status();
  assert.equal(snapshot.speaker.model, 'downloading', 'status reports the background download');
  assert.equal(snapshot.speaker.enabled, false, 'the shadow stays default OFF; nothing is auto-enabled');
  assert.equal(state.starts.length, 0, 'status remains usable without waking capture');

  // Enabling the shadow while T1 is already in flight must join it, not start a second task.
  const enabled = await app.action({ action: 'voice.speakerShadow', enabled: true });
  assert.equal(enabled.ok, true, enabled.error);
  assert.equal(enabled.model, 'downloading');
  assert.equal(state.downloads.length, 1, 'the existing in-flight download is reused');
  snapshot = await app.status();
  assert.equal(snapshot.speaker.enabled, true);

  console.log(`[speaker-startup 1] downloads=${state.downloads.length} target=<root>/models/${SPEAKER_FILE} `
    + `model=downloading shadowAutoEnabled=false captureStarts=0`);
});

// ---------------------------------------------------------------------------
// 2. Failure degrades the model, never startup/capture
// ---------------------------------------------------------------------------

test('2) 启动下载失败：状态回 missing、事件留证，不阻止挂载/启动', async (t) => {
  const app = await mount(t, { config: { voice: { speakerShadow: false } } });
  await until(() => state.downloads.length === 1, 'mount-time T1 download starts');
  assert.equal(state.downloads.length, 1);

  // The download layer emits the failure, then rejects the shared promise (order is not important).
  state.download.options.onEvent?.('speaker.model.failed', { reason: 'network' });
  state.download.reject(Object.assign(new Error('network'), { reason: 'network' }));

  await until(async () => (await app.status()).speaker.model === 'missing', 'model settles to missing');
  const snapshot = await app.status();
  assert.equal(snapshot.speaker.model, 'missing');
  assert.equal(snapshot.speaker.enabled, false, 'a failed download does not enable the shadow');
  assert.equal(snapshot.speaker.errors, 1, 'the failure is counted');
  assert.equal(state.starts.length, 0, 'a failed download does not start capture');

  await app.waitForEvent('speaker.model.failed', (payload) => payload.reason === 'network');
  const rows = await app.events();
  assert.ok(rows.some((event) => event.type === 'speaker.status'), 'the status change is logged');

  // A later explicit enable is the retry path: it starts a fresh task instead of staying stuck.
  const enabled = await app.action({ action: 'voice.speakerShadow', enabled: true });
  assert.equal(enabled.ok, true);
  assert.equal(enabled.model, 'downloading');
  assert.equal(state.downloads.length, 2, 'enabling after a failure retries once');

  console.log(`[speaker-startup 2] model=missing errors=1 failedEvent=1 captureStarts=0 retryDownloads=${state.downloads.length}`);
});

// ---------------------------------------------------------------------------
// 3. The existing unload disposer still cancels the host subscription
// ---------------------------------------------------------------------------

test('3) 组件卸载：仍取消下载，理由 unload，状态不再声称 downloading', async (t) => {
  const app = await mount(t, { config: { voice: { speakerShadow: false } } });
  await until(() => state.downloads.length === 1, 'mount-time T1 download starts');
  assert.equal(state.downloads.length, 1);
  assert.equal((await app.status()).speaker.model, 'downloading');

  const failures = await app.dispose();
  assert.deepEqual(failures, [], 'every mount disposer settled');

  assert.deepEqual(state.aborts, ['unload'], 'the shared download received the unload abort');
  await app.waitForEvent('speaker.download.cancelled', (payload) => payload.reason === 'unload');
  // The route table is owned by the same scope and is gone after dispose; the cancellation path
  // itself clears `speakerDownloading` (covered by the `speaker.status` rows below), so assert the
  // settlement instead of reading a route that no longer exists.
  await delay(20);
  assert.equal(state.downloads.length, 1, 'unload does not start a replacement download');

  console.log('[speaker-startup 3] abortReason=unload cancelledEvent=1 replacementDownloads=0');
});

// ---------------------------------------------------------------------------
// 4. Test mounts stay offline unless they opt in; the manual path is not gated
// ---------------------------------------------------------------------------

test('4) 未显式 opt-in 的测试挂载不自动下载；手动开启仍会下载', async (t) => {
  const app = await mount(t, { config: { voice: { speakerShadow: false } }, startup: false });
  // Give the next event-loop turn a chance to run: a leaky startup gate would call the double here.
  await delay(40);
  assert.equal(state.downloads.length, 0, 'a test mount without opt-in never requests the model');
  assert.equal((await app.status()).speaker.model, 'missing');

  const enabled = await app.action({ action: 'voice.speakerShadow', enabled: true });
  assert.equal(enabled.ok, true, enabled.error);
  assert.equal(enabled.model, 'downloading', 'the explicit enable path still downloads');
  assert.equal(state.downloads.length, 1, 'exactly one manual download task');

  // The explicit `config.speakerModelDownload` seam replaces the module downloader, so a host double
  // can exercise the startup path without touching the real network layer at all.
  let injected = 0;
  const injectedApp = await mount(t, {
    startup: false,
    config: {
      voice: { speakerShadow: false },
      speakerModelDownload: () => {
        injected += 1;
        return new Promise(() => {});
      },
    },
  });
  await delay(20);
  assert.equal(injected, 0, 'the injected downloader is not called by an opt-out mount either');
  const injectedEnable = await injectedApp.action({ action: 'voice.speakerShadow', enabled: true });
  assert.equal(injectedEnable.model, 'downloading');
  assert.equal(injected, 1, 'the manual path uses the injected downloader');
  assert.equal(state.downloads.length, 0, 'the module downloader is bypassed by the injection');

  console.log(`[speaker-startup 4] startupOptOut=true startupDownloads=0 manualDownloads=1 injectedManual=${injected}`);
});

// ---------------------------------------------------------------------------
// 5. README is the user-facing contract for the T1/T2/T3 split
// ---------------------------------------------------------------------------

test('5) README：T1/T2/T3 分级、CAM++ 启动下载，不再说“打开声纹影子后下载”', async () => {
  const readme = await readFile(join(PROJECT_ROOT, 'README.md'), 'utf8');
  assert.match(readme, /T1 启动后台下载/u, 'T1 is labelled as a startup background download');
  assert.match(readme, /T2 首次使用下载/u, 'T2 is labelled as first-use download');
  assert.match(readme, /T3 手动准备/u, 'T3 is labelled as manual preparation');

  const t1Row = readme.split('\n').find((line) => line.includes('T1 启动后台下载'));
  assert.ok(t1Row !== undefined, 'the T1 table row exists');
  assert.match(t1Row, /CAM\+\+/u, 'T1 names CAM++');
  assert.match(t1Row, /DSH 启动/u, 'T1 says the download starts with DSH startup');
  assert.match(t1Row, /28 MB/u, 'T1 states the approximate size');

  assert.match(readme, /Silero VAD/u);
  assert.match(readme, /FFmpeg/u);
  assert.match(readme, /speaker\.model\.failed/u, 'the failure state is documented');

  assert.doesNotMatch(readme, /打开「声纹影子」后[^。\n]*下载/u,
    'the old “open the shadow, then download” claim is gone');
  assert.doesNotMatch(readme, /第一次开启会自动下载/u,
    'the old “first enable downloads” claim is gone');

  console.log('[speaker-startup 5] T1=CAM++/startup T2=Silero/first-use T3=manual oldClaim=false');
});
