/**
 * Call mode persistence (settings.voice.callMode).
 *
 * The mode used to be runtime-only, so every restart silently fell back to normal. These tests
 * mount the real Host against a temporary root, drive the shipped settings action and then mount a
 * SECOND Host on the same root, which is the restart the user actually performs:
 *
 *   1. enter -> settings.voice.callMode = 'call'; a fresh mount on the same root reports call;
 *   2. exit -> 'normal'; a fresh mount reports normal (an explicit normal save sticks);
 *   3. a persisted 'call' with no enabled assistant name mounts normal, records
 *      `call.mode.refused {source:'startup', persisted:true}` and status shows the reason;
 *   4. writing the mode keeps every other voice field (callNames, chunking, ...) and top-level key;
 *   5. an old settings file without `callMode`, and an illegal value, both mount normal.
 *
 * No capture, TTS, model download or GUI is used.
 *
 * Run: node --test test/call-mode-persist.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { cleanupRoot, disposeAll } from './helpers/cleanup.mjs';

const hearingUrl = new URL('../src/host/hearing/hearing.js', import.meta.url).href;
const ttsUrl = new URL('../src/host/speech/tts.js', import.meta.url).href;
const sightUrl = new URL('../src/host/vision/sight.js', import.meta.url).href;
const subtitleUrl = new URL('../src/host/subtitle/subtitle.js', import.meta.url).href;

const hooks = registerHooks({
  load(url, context, next) {
    if (url === hearingUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    export const modelReady = () => true;
    export const finalModelReady = () => false;
    export const isLoopbackDevice = (name) => /CABLE|Stereo Mix|Virtual/i.test(String(name));
    export const listDevices = async () => ['Fake Mic'];
    export const startHearing = (options) => ({ device: options.device, stop() {}, stats: () => ({ rmsDb: -20 }) });
    export const watchHearingExit = () => {};
    export const annotateTranscript = (text) => text;
    export const joinDetailFields = () => ({});
    export const mergeJoinFallback = () => ({});
    export const offlineLimitedNote = () => '';
    export const truncationNotice = () => '';`,
      };
    }
    if (url === ttsUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    export { resolveGptLangs, resolveGptSovitsTimeout } from '${ttsUrl}?call-mode-persist-helpers';
    export const configureTts = () => {};
    export const gptSovitsReferenceStatus = async () => ({ seconds: null, ok: false, readable: false });
    export const warmupGptSovits = async () => ({ ok: false, skipped: 'disabled' });
    export const applyGptSovitsModels = () => ({ ok: true });
    export const synthesize = async () => ({ file: 'call-mode-persist.mp3', bytes: 16, durationMs: 200 });
    export const speakStreaming = async () => { throw new Error('streaming forbidden'); };
    export const stopPlayback = () => true;
    export const stopTts = () => true;
    export const play = async () => {};`,
      };
    }
    if (url === sightUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    const forbidden = () => { throw new Error('real capture forbidden'); };
    export const resolveFfmpeg = () => 'ffmpeg-fake';
    export const resolveFfplay = () => null;
    export const capture = forbidden, captureDesktop = forbidden, captureDevice = forbidden, startStoryboard = forbidden;
    export const OBSERVATION_TTL_MS = 30000;
    export function readObservation(o, { now = Date.now(), ttlMs = 30000 } = {}) {
      const v = o ?? {}; const c = Number(v.capturedAt); const s = Number.isFinite(c) && c > 0 ? c : Number(v.at);
      const at = Number.isFinite(s) && s > 0 ? s : null; const ageMs = at === null ? null : Math.max(0, now - at);
      const stale = ageMs === null || ageMs >= ttlMs;
      return { ...v, at, ageMs, stale, hint: stale ? 'stale' : '' };
    }`,
      };
    }
    if (url === subtitleUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    export const averageColor = async () => null;
    export class SubtitleOverlay {
      constructor({ config }) { this.config = config; }
      async show() {}
      async hide() {}
      async stop() {}
    }`,
      };
    }
    if (url === 'node:child_process') {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    export const spawn = () => { throw new Error('real process forbidden'); };
    export const execFile = () => { throw new Error('real process forbidden'); };`,
      };
    }
    return next(url, context);
  },
});
const { apply } = await import('../src/host/index.js');
hooks.deregister();

/** A root with the same data files the real plugin reads at mount. */
async function makeRoot({ voice } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-call-mode-persist-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await mkdir(join(root, 'workspace'), { recursive: true });
  await writeFile(join(root, 'data', 'features.json'), JSON.stringify({
    hearing: true, ambient: false, voice: false, vision: false, subtitle: false,
    avatar: false, memory: false, fastpath: false,
  }));
  await writeFile(join(root, 'data', 'settings.json'), JSON.stringify({
    gptSovits: { enabled: false },
    langs: { speech: 'zh', subtitle: 'zh' },
    autoMemory: { enabled: false },
    ...(voice === undefined ? {} : { voice }),
  }));
  return root;
}

async function readSettings(root) {
  return JSON.parse(await readFile(join(root, 'data', 'settings.json'), 'utf8'));
}

async function readEvents(root) {
  try {
    const text = await readFile(join(root, 'data', 'events.jsonl'), 'utf8');
    return text.trim().split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/**
 * Mount one Host on `root`. The fake context mirrors the other Host tests; the root is not removed
 * here so the caller can mount a second Host on it and simulate a restart.
 */
async function mountAt(root) {
  const listeners = new Set();
  const cleanups = [];
  const routes = new Map();

  const bus = {
    on(type, fn) {
      const entry = { type, fn };
      listeners.add(entry);
      return () => listeners.delete(entry);
    },
    fire(type, ...args) {
      for (const entry of [...listeners]) {
        if (entry.type !== type) continue;
        try { entry.fn(...args); } catch { /* isolate a listener like the real bus */ }
      }
    },
  };
  const services = new Map([
    ['agentDefaultModel', { currentSelection: () => ({ provider: 'fake-provider', model: 'fake-model' }) }],
    ['sessionTitle', { get: () => undefined, rename: (_session, title) => ({ title, source: { kind: 'user' } }) }],
    ['workspaceRegistry', {
      async create(path) { return { id: 'ws-call-mode-persist', path }; },
      get() { return { id: 'ws-call-mode-persist', async attachSession() {} }; },
    }],
  ]);

  const effect = (fn) => {
    const cleanup = fn();
    if (typeof cleanup === 'function') cleanups.push(cleanup);
    return cleanup;
  };
  const scope = {
    effect,
    on: bus.on,
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
    on: bus.on,
    get: (name) => services.get(name),
    tools: { register: () => () => {} },
    webServer: {
      register(route) {
        routes.set(route.path, route.handler);
        return () => routes.delete(route.path);
      },
    },
    inject: (_deps, registerScope) => registerScope(scope),
  }, { root, enabled: true, speakerModelStartup: false });

  const action = async (body) => {
    const handler = routes.get('/assistant/action');
    assert.equal(typeof handler, 'function', 'the action route is registered');
    let result;
    await handler(
      Object.assign(Readable.from([JSON.stringify(body)]), { method: 'POST' }),
      { writeHead() {}, end(value) { result = JSON.parse(value); } },
    );
    return result;
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

  return {
    action,
    status,
    async dispose() {
      await disposeAll(cleanups.splice(0));
    },
  };
}

/** Wait for one event row; startup logging is fire-and-forget. */
async function waitForEvent(root, type, predicate = () => true) {
  const startedAt = Date.now();
  for (;;) {
    const row = (await readEvents(root)).find((event) => event.type === type
      && predicate(event.payload ?? {}));
    if (row !== undefined) return row.payload ?? {};
    if (Date.now() - startedAt > 4000) throw new Error(`timed out waiting for ${type}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const NAMES = [{ id: 'call-1', text: '小满', enabled: true }];

// ---------------------------------------------------------------------------
// 1. enter persists call and a second mount on the same root restores it
// ---------------------------------------------------------------------------

test('1. enter 写 call；同 root 重建 Host 后 status.call.mode=call', async (t) => {
  const root = await makeRoot({
    voice: { chunking: false, marker: 'keep-me', callNames: NAMES },
  });
  let host = await mountAt(root);
  t.after(async () => {
    await host?.dispose();
    await cleanupRoot(root);
  });

  const entered = await host.action({ action: 'call.mode', mode: 'call' });
  assert.equal(entered.ok, true);
  assert.equal(entered.mode, 'call');

  const saved = await readSettings(root);
  assert.equal(saved.voice.callMode, 'call', 'the settings action persists the mode');
  assert.deepEqual(saved.voice.callNames, NAMES, 'the existing names stay in the same voice object');
  assert.equal(saved.voice.chunking, false, 'other voice fields are preserved');
  assert.equal(saved.voice.marker, 'keep-me', 'unknown voice fields are preserved too');

  await host.dispose();
  host = await mountAt(root);
  const status = await host.status();
  assert.equal(status.call.mode, 'call', 'a reboot restores the saved call mode');
  assert.equal(status.call.persistedCallRefused, null, 'a successful restore is not a refusal');
  assert.deepEqual(status.call.enabledNames, ['小满']);
  assert.equal((await readSettings(root)).voice.callMode, 'call',
    'startup reconciliation does not erase the saved mode');
  console.log(`[1] persisted=${saved.voice.callMode} rebooted=${status.call.mode}`);
});

// ---------------------------------------------------------------------------
// 2. exit persists normal and a second mount stays normal
// ---------------------------------------------------------------------------

test('2. exit 写 normal；同 root 重建 Host 后仍是 normal', async (t) => {
  const root = await makeRoot({ voice: { callNames: NAMES } });
  let host = await mountAt(root);
  t.after(async () => {
    await host?.dispose();
    await cleanupRoot(root);
  });

  assert.equal((await host.action({ action: 'call.mode', mode: 'call' })).mode, 'call');
  const exited = await host.action({ action: 'call.mode', mode: 'normal' });
  assert.equal(exited.ok, true);
  assert.equal(exited.mode, 'normal');
  assert.equal((await readSettings(root)).voice.callMode, 'normal', 'an explicit normal save sticks');

  await host.dispose();
  host = await mountAt(root);
  const status = await host.status();
  assert.equal(status.call.mode, 'normal', 'the next mount does not re-enter call');
  assert.equal(status.call.persistedCallRefused, null);
  console.log('[2] persisted=normal rebooted=normal');
});

// ---------------------------------------------------------------------------
// 3. persisted call + no enabled name: normal at mount, reason visible
// ---------------------------------------------------------------------------

test('3. 持久化 call 但称呼全停用 → 启动 normal，status 显示 no-address-name', async (t) => {
  const root = await makeRoot({
    voice: {
      callMode: 'call',
      callNames: [
        { id: 'call-1', text: '小满', enabled: false },
        { id: 'call-2', text: '阿明', enabled: false },
      ],
    },
  });
  let host = await mountAt(root);
  t.after(async () => {
    await host?.dispose();
    await cleanupRoot(root);
  });

  const status = await host.status();
  assert.equal(status.call.mode, 'normal', 'an unusable persisted call never enters call mode');
  assert.equal(status.call.persistedCallRefused, 'no-address-name');
  assert.deepEqual(status.call.enabledNames, [], 'all names stay stored but disabled');

  const refused = await waitForEvent(root, 'call.mode.refused',
    (payload) => payload.reason === 'no-address-name' && payload.source === 'startup');
  assert.equal(refused.persisted, true, 'the startup refusal is distinguishable in the log');

  // The refusal is a status/log fact, not a blocking failure: the host and its actions still work.
  const added = await host.action({ action: 'call.names.add', text: '新名字' });
  assert.equal(added.ok, true);
  const entered = await host.action({ action: 'call.mode', mode: 'call' });
  assert.equal(entered.mode, 'call', 'after enabling a name the mode can be entered normally');
  console.log(`[3] mode=${status.call.mode} refused=${status.call.persistedCallRefused}`);
});

// ---------------------------------------------------------------------------
// 4. mode writes keep callNames and every other field
// ---------------------------------------------------------------------------

test('4. 写 callMode 保留 callNames 等 voice 字段与顶层设置', async (t) => {
  const voiceBefore = {
    chunking: false,
    inputInterruptsReply: false,
    speechMaxChars: 1234,
    callNames: NAMES,
  };
  const root = await makeRoot({ voice: voiceBefore });
  let host = await mountAt(root);
  t.after(async () => {
    await host?.dispose();
    await cleanupRoot(root);
  });

  const assertVoiceKept = (saved, mode) => {
    assert.equal(saved.voice.callMode, mode);
    assert.deepEqual(saved.voice.callNames, NAMES, 'callNames survives the mode write');
    assert.equal(saved.voice.chunking, false, 'chunking survives the mode write');
    assert.equal(saved.voice.inputInterruptsReply, false);
    assert.equal(saved.voice.speechMaxChars, 1234);
    assert.deepEqual(saved.langs, { speech: 'zh', subtitle: 'zh' }, 'unrelated top-level blocks survive');
    assert.equal(saved.autoMemory.enabled, false);
  };

  assert.equal((await host.action({ action: 'call.mode', mode: 'call' })).mode, 'call');
  let saved = await readSettings(root);
  assertVoiceKept(saved, 'call');
  assert.deepEqual(saved.voice.callNames, voiceBefore.callNames);

  assert.equal((await host.action({ action: 'call.mode', mode: 'normal' })).mode, 'normal');
  saved = await readSettings(root);
  assertVoiceKept(saved, 'normal');
  console.log(`[4] voiceKeys=${Object.keys(saved.voice).sort().join(',')}`);
});

// ---------------------------------------------------------------------------
// 5. old settings without the field stay normal, and an illegal value is ignored
// ---------------------------------------------------------------------------

test('5. 旧 settings 无 callMode、非法值 → 启动 normal', async (t) => {
  const oldRoot = await makeRoot({ voice: { callNames: NAMES } });
  let oldHost = await mountAt(oldRoot);
  t.after(async () => {
    await oldHost?.dispose();
    await cleanupRoot(oldRoot);
  });
  const oldStatus = await oldHost.status();
  assert.equal(oldStatus.call.mode, 'normal', 'an old settings file has no persisted call');
  assert.equal(oldStatus.call.persistedCallRefused, null);
  assert.equal(Object.hasOwn((await readSettings(oldRoot)).voice, 'callMode'), false,
    'reading the old file never fabricates the key');
  await oldHost.dispose();
  oldHost = null;

  const illegalRoot = await makeRoot({ voice: { callMode: 'CALL', callNames: NAMES } });
  let illegalHost = await mountAt(illegalRoot);
  t.after(async () => {
    await illegalHost?.dispose();
    await cleanupRoot(illegalRoot);
  });
  const illegalStatus = await illegalHost.status();
  assert.equal(illegalStatus.call.mode, 'normal', 'an illegal value is treated as normal');
  assert.equal(illegalStatus.call.persistedCallRefused, null);
  await illegalHost.dispose();
  illegalHost = null;
  console.log(`[5] old=${oldStatus.call.mode} illegal=${illegalStatus.call.mode}`);
});
