/**
 * 组件总控 ↔ 容器/外部程序同步 regression.
 *
 * Contract under test:
 *   1. component off → resources stop first, then containers/autostart/autoClose turn off;
 *   2. component on → containers/autostart/autoClose turn on, dependencies start once, but no
 *      capture/playback starts just because the component opened;
 *   3. opening a container alone opens its component first, then runs the container action;
 *   4. startup reconciles settings to features (components are the source of truth) and only
 *      enabled components may start a dependency;
 *   5. DSH exit closes what this plugin spawned by recorded ownership, even after a switch was
 *      cleared; user-started programs are never adopted or closed;
 *   6. shared dependencies are reference-counted and concurrent starts are merged;
 *   7. provider switches (GPT-SoVITS / Edge TTS) are children of voice, not the component.
 *
 * No real process, network, microphone, subtitle overlay or TTS is used: modules are replaced at
 * import time and child_process only records spawn/taskkill calls.
 *
 * Run: node --test test/feature-container-sync.mjs
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { Readable } from 'node:stream';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cleanupRoot, disposeAll } from './helpers/cleanup.mjs';
import { DEFAULT_FEATURES, FeatureStore } from '../src/host/runtime/features.js';

const moduleUrl = (path) => new URL(path, import.meta.url).href;
const hearingUrl = moduleUrl('../src/host/hearing/hearing.js');
const sightUrl = moduleUrl('../src/host/vision/sight.js');
const subtitleUrl = moduleUrl('../src/host/subtitle/subtitle.js');
const hardwareUrl = moduleUrl('../src/host/platform/hardware.js');
const ttsUrl = moduleUrl('../src/host/speech/tts.js');

const state = {
  sessions: [], stops: 0, spawns: [], execFiles: [],
  subtitle: { shown: [], hidden: 0, stopped: 0, selects: 0, region: { x: 10, y: 20, w: 400, h: 120 } },
  playbackStops: 0,
};
globalThis.__featureContainerSync = state;

const hooks = registerHooks({
  load(href, context, next) {
    if (href === hearingUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          const s = globalThis.__featureContainerSync;
          export const modelReady = () => true;
          export const finalModelReady = () => false;
          export const isLoopbackDevice = (name) => /CABLE|Stereo Mix|Virtual/i.test(String(name));
          export const selectMicrophoneDevice = (devices, requested) => ({
            device: devices.includes(requested) ? requested : (devices[0] ?? ''),
            devices,
          });
          export const listDevices = async () => ['Fake Mic', 'CABLE Output (VB-Audio Virtual Cable)'];
          export const startHearing = (options) => {
            const session = {
              device: options.device,
              options,
              done: Promise.resolve(),
              stopCount: 0,
              stats: () => ({ rmsDb: -30, peakDb: -20 }),
              stop() {
                if (this.stopCount > 0) return;
                this.stopCount += 1;
                s.stops += 1;
              },
            };
            s.sessions.push(session);
            return session;
          };
          export const watchHearingExit = () => {};
          export const annotateTranscript = (text) => text;
          export const joinDetailFields = () => ({});
          export const mergeJoinFallback = () => ({});
          export const offlineLimitedNote = () => '';
          export const truncationNotice = () => '';
        `,
      };
    }
    if (href === sightUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          const forbidden = async () => { throw new Error('capture forbidden in feature sync test'); };
          export const resolveFfmpeg = () => 'ffmpeg-fake';
          export const resolveFfplay = () => null;
          export const capture = forbidden, captureDesktop = forbidden, captureDevice = forbidden, startStoryboard = forbidden;
          export const OBSERVATION_TTL_MS = 30000;
          export function readObservation(observation, { now = Date.now(), ttlMs = 30000 } = {}) {
            const value = observation ?? {};
            const captured = Number(value.capturedAt);
            const stored = Number.isFinite(captured) && captured > 0 ? captured : Number(value.at);
            const at = Number.isFinite(stored) && stored > 0 ? stored : null;
            const ageMs = at === null ? null : Math.max(0, now - at);
            const stale = ageMs === null || ageMs >= ttlMs;
            return { ...value, at, ageMs, stale, hint: stale ? 'stale' : '' };
          }`,
      };
    }
    if (href === subtitleUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          const s = globalThis.__featureContainerSync;
          export const averageColor = async () => null;
          export class SubtitleOverlay {
            constructor({ config }) { this.config = config; this.child = null; }
            get running() { return this.child !== null; }
            async show(text, region) { s.subtitle.shown.push({ text, region }); this.child = this.child ?? { pid: 1 }; }
            async hide() { s.subtitle.hidden += 1; }
            async select() { s.subtitle.selects += 1; return s.subtitle.region; }
            async stop() { s.subtitle.stopped += 1; this.child = null; }
          }`,
      };
    }
    if (href === hardwareUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `export const detectTuning = () => ({
          cores: 8, memoryGb: 16, streamThreads: 2, finalThreads: 3, decodeCapSec: 10, tier: 'mid',
        });`,
      };
    }
    if (href === ttsUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          const s = globalThis.__featureContainerSync;
          export { resolveGptLangs, resolveGptSovitsTimeout } from '${ttsUrl}?feature-sync-helpers';
          export const configureTts = () => {};
          export const gptSovitsReferenceStatus = async () => ({ seconds: null, ok: false, readable: false });
          export const warmupGptSovits = async () => ({ ok: false, skipped: 'test' });
          export const applyGptSovitsModels = async () => ({ ok: true, gpt: { ok: true }, sovits: { ok: true } });
          export const synthesize = async () => { throw new Error('synthesis forbidden in feature sync test'); };
          export const speakStreaming = async () => { throw new Error('streaming forbidden in feature sync test'); };
          export const play = async () => { throw new Error('play forbidden in feature sync test'); };
          export const stopPlayback = () => { s.playbackStops += 1; return true; };
          export const stopTts = () => { s.playbackStops += 1; return true; };`,
      };
    }
    if (href === 'node:child_process') {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          import { EventEmitter } from 'node:events';
          const s = globalThis.__featureContainerSync;
          let seq = 0;
          const fakeChild = (cmd, args) => {
            const child = new EventEmitter();
            child.pid = 40_000 + (++seq);
            child.exitCode = null;
            child.signalCode = null;
            child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
            child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
            child.unref = () => {};
            child.kill = () => {
              if (child.exitCode === null) {
                child.exitCode = 0;
                queueMicrotask(() => { child.emit('exit', 0, null); child.emit('close', 0, null); });
              }
              return true;
            };
            return child;
          };
          export const spawn = (cmd, args = [], options = {}) => {
            const child = fakeChild(cmd, args);
            s.spawns.push({ cmd: String(cmd), args, options, pid: child.pid });
            if (String(cmd).toLowerCase() === 'taskkill') queueMicrotask(() => child.emit('close', 0, null));
            return child;
          };
          export const execFile = (cmd, args, options, callback) => {
            const cb = typeof options === 'function' ? options : callback;
            s.execFiles.push({ cmd: String(cmd), args });
            if (typeof cb === 'function') queueMicrotask(() => cb(null, '', ''));
            return fakeChild(cmd, args);
          };`,
      };
    }
    return next(href, context);
  },
});

const { apply, createDependencyRegistry } = await import('../src/host/index.js');
hooks.deregister();
after(() => { delete globalThis.__featureContainerSync; });

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, timeoutMs = 3000) {
  const startedAt = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - startedAt > timeoutMs) assert.fail(`timed out: ${label}`);
    await tick(10);
  }
}

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const readEvents = async (root) => {
  try {
    const text = await readFile(join(root, 'data', 'events.jsonl'), 'utf8');
    return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
};
const eventIndex = (rows, type) => rows.findIndex((row) => row.type === type);

async function mount(t, { features = {}, settings = {}, bootDelay = 5 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-feature-sync-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await writeFile(join(root, 'data', 'features.json'), JSON.stringify(features), 'utf8');
  await writeFile(join(root, 'data', 'settings.json'), JSON.stringify(settings), 'utf8');
  state.sessions = [];
  state.stops = 0;
  state.spawns = [];
  state.execFiles = [];
  state.subtitle = { shown: [], hidden: 0, stopped: 0, selects: 0, region: { x: 10, y: 20, w: 400, h: 120 } };
  state.playbackStops = 0;

  const tools = new Map();
  const routes = new Map();
  const cleanups = [];
  const effect = (fn) => {
    const cleanup = fn();
    if (typeof cleanup === 'function') cleanups.push(cleanup);
    return cleanup;
  };
  const webServer = {
    register(route) {
      routes.set(route.path, route.handler);
      return () => routes.delete(route.path);
    },
  };
  const ctx = {
    effect,
    get: () => undefined,
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    inject: (_deps, registerScope) => {
      registerScope({
        effect,
        systemPrompt: { section: () => () => {} },
        webServer,
      });
    },
  };
  apply(ctx, { root, enabled: true, asrMergeWindowMs: 10, dependencyBootDelayMs: bootDelay });
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    const failures = await disposeAll(cleanups.splice(0));
    assert.deepEqual(failures, []);
  };
  t.after(async () => {
    await dispose();
    await cleanupRoot(root);
  });

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
  const settingsNow = () => readJson(join(root, 'data', 'settings.json'));
  const featuresNow = () => readJson(join(root, 'data', 'features.json'));
  const events = () => readEvents(root);
  return { root, action, settingsNow, featuresNow, events, tools, dispose };
}

const gptSettings = (overrides = {}) => ({
  gptSovits: {
    enabled: true,
    apiBase: 'http://127.0.0.1:19880',
    ...(overrides.gptSovits ?? {}),
  },
  autostart: {
    gptsovits: {
      enabled: true,
      autoClose: true,
      pythonPath: process.execPath,
      scriptPath: join(process.cwd(), 'api_v2.py'),
      workDir: process.cwd(),
      port: 19880,
      ...(overrides.autostart?.gptsovits ?? {}),
    },
  },
  ...(overrides.rest ?? {}),
});

const gptSpawns = () => state.spawns.filter((row) => /api_v2\.py/u.test(row.args.join(' ')));
const taskkills = () => state.spawns.filter((row) => String(row.cmd).toLowerCase() === 'taskkill');

// ---------------------------------------------------------------------------
// 0. defaults: every component but fastpath is on for a fresh root; a saved choice always wins
// ---------------------------------------------------------------------------
test('0a. 全新 root（无 features.json）：七个组件默认开启，fastpath 默认关闭', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-feature-defaults-'));
  t.after(async () => {
    await cleanupRoot(root);
  });
  const expected = ['hearing', 'ambient', 'voice', 'vision', 'subtitle', 'avatar', 'memory', 'fastpath'];
  const autoOn = expected.filter((id) => id !== 'fastpath');
  assert.deepEqual(DEFAULT_FEATURES.map((entry) => entry.id), expected);
  assert.deepEqual(
    DEFAULT_FEATURES.filter((entry) => entry.id !== 'fastpath').map((entry) => entry.default),
    autoOn.map(() => true),
  );
  assert.equal(DEFAULT_FEATURES.find((entry) => entry.id === 'fastpath').default, false, 'fastpath is a voice-routing switch, not an accelerator');
  const store = new FeatureStore(root);
  assert.deepEqual(store.list().map((row) => [row.id, row.enabled]), expected.map((id) => [id, id !== 'fastpath']));
});

test('0b. 已有 features.json 的 ambient:false：读取后仍关闭，不被新默认覆盖也不迁移', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-feature-defaults-saved-'));
  await mkdir(join(root, 'data'), { recursive: true });
  const file = join(root, 'data', 'features.json');
  const saved = { ambient: false };
  await writeFile(file, JSON.stringify(saved), 'utf8');
  t.after(async () => {
    await cleanupRoot(root);
  });
  const store = new FeatureStore(root);
  assert.equal(store.enabled('ambient'), false, 'the saved off switch survives');
  assert.equal(store.enabled('hearing'), true, 'an id missing from the file keeps its default');
  assert.equal(store.enabled('fastpath'), false, 'the fastpath default stays off for a missing id');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), saved, 'reading never rewrites the user choice');
});

test('0c. 已有 features.json 的 fastpath:true：读取后仍开启，默认关闭不覆盖用户显式选择', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-feature-defaults-fastpath-'));
  await mkdir(join(root, 'data'), { recursive: true });
  const file = join(root, 'data', 'features.json');
  const saved = { fastpath: true };
  await writeFile(file, JSON.stringify(saved), 'utf8');
  t.after(async () => {
    await cleanupRoot(root);
  });
  const store = new FeatureStore(root);
  assert.equal(store.enabled('fastpath'), true, 'the explicit fastpath on switch survives the off default');
  assert.equal(store.enabled('hearing'), true, 'other components keep their on default');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), saved, 'reading never rewrites the user choice');
});

// ---------------------------------------------------------------------------
// 1. component off: settings container turns off and the overlay resource stops
// ---------------------------------------------------------------------------
test('1. 关组件 subtitle：先隐藏字幕并停浮层，随后 settings.subtitle.enabled=false', async (t) => {
  const app = await mount(t, {
    features: { subtitle: true },
    settings: { subtitle: { enabled: true, mode: 'region', region: { x: 0, y: 0, w: 320, h: 100 } } },
  });
  assert.equal((await app.settingsNow()).subtitle.enabled, true);
  // Materialize the overlay through the real path first; then the close must hide and stop it.
  const preview = await app.action({ action: 'subtitle.preview' });
  assert.equal(preview.ok, true);
  assert.equal(state.subtitle.shown.length, 1);
  const result = await app.action({ action: 'feature.set', id: 'subtitle', enabled: false });
  assert.equal(result.ok, true);
  const settings = await app.settingsNow();
  assert.equal(settings.subtitle.enabled, false, 'container switch follows the component off');
  assert.equal((await app.featuresNow()).subtitle, false);
  assert.ok(state.subtitle.hidden >= 1, 'the visible subtitle was hidden');
  assert.equal(state.subtitle.stopped, 1, 'the overlay process was stopped as a resource');
});

// ---------------------------------------------------------------------------
// 2. close order: resources → owned dependency → config
// ---------------------------------------------------------------------------
test('2. 关组件 voice：先停资源/按归属关闭 GPT-SoVITS，再关 provider/播报/自启动配置', async (t) => {
  const app = await mount(t, { features: { voice: true }, settings: gptSettings(), bootDelay: 5 });
  await until(() => gptSpawns().length === 1, 'startup started GPT-SoVITS once');
  const pid = gptSpawns()[0].pid;
  await app.action({ action: 'feature.set', id: 'voice', enabled: false });
  const settings = await app.settingsNow();
  assert.equal(settings.gptSovits.enabled, false, 'provider switch is off with its parent');
  assert.equal(settings.voice.enabled, false, 'playback switch is off with its parent');
  assert.equal(settings.autostart.gptsovits.enabled, false, 'autostart binding is off');
  assert.equal(settings.autostart.gptsovits.autoClose, false, 'autoClose is cleared last');
  assert.ok(taskkills().some((row) => row.args.includes(String(pid))), 'plugin-owned GPT-SoVITS is closed by recorded pid');
  const rows = await app.events();
  const begin = eventIndex(rows, 'feature.disable.begin');
  const resources = eventIndex(rows, 'feature.resources.stopped');
  const closed = eventIndex(rows, 'dependency.closed');
  const config = eventIndex(rows, 'feature.disable.config');
  assert.ok(begin >= 0 && resources > begin, 'resources stop after the component blocks new work');
  assert.ok(closed > resources, 'the dependency is closed before its switch is cleared');
  assert.ok(config > closed, 'autostart/autoClose config is written last');
});

// ---------------------------------------------------------------------------
// 3. provider-only close is not a component close
// ---------------------------------------------------------------------------
test('3. 关闭 gptsovits provider：voice 组件与播报仍开，且按归属关闭插件启动的服务', async (t) => {
  const app = await mount(t, { features: { voice: true }, settings: gptSettings(), bootDelay: 5 });
  await until(() => gptSpawns().length === 1, 'startup started GPT-SoVITS once');
  const pid = gptSpawns()[0].pid;
  const result = await app.action({ action: 'tts.config', enabled: false });
  assert.equal(result.ok, true);
  assert.equal(result.gptSovits.enabled, false);
  const features = await app.featuresNow();
  const settings = await app.settingsNow();
  assert.equal(features.voice, true, 'provider switch never writes the component off');
  assert.notEqual(settings.voice?.enabled, false, 'playback stays on');
  assert.equal(settings.autostart.gptsovits.enabled, true, 'the component binding is still recorded');
  assert.ok(taskkills().some((row) => row.args.includes(String(pid))), 'the provider-only close releases its own process');
  const rows = await app.events();
  assert.ok(rows.some((row) => row.type === 'voice.provider.set' && row.payload.enabled === false), 'provider event is distinct');
  assert.equal(rows.some((row) => row.type === 'feature.set' && row.payload.id === 'voice'), false, 'no feature.set voice event');
});

// ---------------------------------------------------------------------------
// 4. component on: containers on, but no capture / playback / OBS
// ---------------------------------------------------------------------------
test('4. 开组件 hearing/subtitle：容器开关连带打开，但不会立即开始采集', async (t) => {
  const app = await mount(t, { features: { hearing: false, subtitle: false } });
  await app.action({ action: 'feature.set', id: 'hearing', enabled: true });
  let settings = await app.settingsNow();
  assert.equal(settings.hearing.enabled, true, 'hearing container switch follows the parent on');
  assert.equal(state.sessions.length, 0, 'opening hearing never starts microphone capture');
  await app.action({ action: 'feature.set', id: 'subtitle', enabled: true });
  settings = await app.settingsNow();
  assert.equal(settings.subtitle.enabled, true, 'subtitle container switch follows the parent on');
  assert.equal(state.subtitle.shown.length, 0, 'opening subtitle does not publish a preview');
});

// ---------------------------------------------------------------------------
// 5. container action opens the component first
// ---------------------------------------------------------------------------
test('5. 单独点听觉开始：先启用 hearing 组件，再启动采集（顺序断言）', async (t) => {
  const app = await mount(t, { features: { hearing: false } });
  const result = await app.action({ action: 'hearing.start' });
  assert.equal(result.ok, true, result.error ?? 'hearing should start');
  assert.equal((await app.featuresNow()).hearing, true);
  assert.equal((await app.settingsNow()).hearing.enabled, true);
  assert.equal(state.sessions.length, 1, 'the container action actually ran');
  const rows = await app.events();
  const enabled = eventIndex(rows, 'feature.set');
  const started = eventIndex(rows, 'hearing.start');
  assert.ok(enabled >= 0 && started > enabled, 'feature.set is emitted before the container start');
});

// ---------------------------------------------------------------------------
// 6. subtitle.select / region bypass enables the component atomically
// ---------------------------------------------------------------------------
test('6. subtitle.select 旁路：先启用字幕组件，再写区域，不再出现“容器开而组件关”', async (t) => {
  const app = await mount(t, { features: { subtitle: false } });
  const result = await app.action({ action: 'subtitle.select' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.region, state.subtitle.region);
  assert.equal((await app.featuresNow()).subtitle, true);
  const settings = await app.settingsNow();
  assert.equal(settings.subtitle.enabled, true);
  assert.deepEqual(settings.subtitle.region, state.subtitle.region);
  const rows = await app.events();
  const enabled = eventIndex(rows, 'feature.set');
  const region = eventIndex(rows, 'subtitle.region');
  assert.ok(enabled >= 0 && region > enabled, 'component enable precedes the region write');
});

// ---------------------------------------------------------------------------
// 7. startup reconciliation: features win over stale settings
// ---------------------------------------------------------------------------
test('7. 启动对账：features.subtitle=false 与 settings.subtitle.enabled=true → 启动后统一为 false', async (t) => {
  const app = await mount(t, {
    features: { subtitle: false },
    settings: { subtitle: { enabled: true, mode: 'region', region: { x: 0, y: 0, w: 320, h: 100 } } },
  });
  const settings = await app.settingsNow();
  assert.equal(settings.subtitle.enabled, false, 'stale container is converged to the disabled component');
});

// ---------------------------------------------------------------------------
// 8. hearing/ambient capture stops on component close
// ---------------------------------------------------------------------------
test('8. 关组件 ambient：回环采集资源停止（stop 调用）且容器开关置为关', async (t) => {
  const app = await mount(t, { features: { ambient: true }, settings: { ambient: { enabled: true } } });
  const started = await app.action({ action: 'ambient.start' });
  assert.equal(started.ok, true, started.error ?? 'ambient should start');
  assert.equal(state.sessions.length, 1);
  const session = state.sessions[0];
  const result = await app.action({ action: 'feature.set', id: 'ambient', enabled: false });
  assert.equal(result.ok, true);
  assert.equal(session.stopCount, 1, 'the loopback ASR session was stopped');
  assert.equal((await app.settingsNow()).ambient.enabled, false);
});

// ---------------------------------------------------------------------------
// 9. client: container buttons stay clickable while the component is off
// ---------------------------------------------------------------------------
test('9. 客户端：组件关闭时容器按钮仍可点，并提示会先启用组件', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  assert.equal(source.includes("disabled: hearingOn || busy !== '' || !feature('hearing')"), false);
  assert.equal(source.includes("disabled: ambientOn || busy !== '' || missing || !feature('ambient')"), false);
  assert.equal(source.includes("disabled: busy !== '' || !feature('vision')"), false);
  assert.match(source, /点上面的按钮会先启用组件/);
  assert.match(source, /会先启用组件，再开始采集/);
  assert.match(source, /上面的按钮仍可点，会先启用「字幕显示」组件/);
  assert.match(source, /视觉 ↔ OBS；语音合成 ↔ GPT-SoVITS；形象 ↔ VTube Studio/);
});

// ---------------------------------------------------------------------------
// 10. host gate keeps a machine-readable refusal
// ---------------------------------------------------------------------------
test('10. 宿主门禁：形象组件关闭时拒绝能力刷新，返回 FEATURE_DISABLED', async (t) => {
  const app = await mount(t, { features: { avatar: false } });
  const result = await app.action({ action: 'avatar.capabilities.refresh' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'FEATURE_DISABLED');
  assert.equal(result.feature, 'avatar');
  assert.match(result.error, /形象组件已关闭/);
});

// ---------------------------------------------------------------------------
// 11. shared dependency reference counting
// ---------------------------------------------------------------------------
test('11. 共享依赖引用计数：两个组件用一个服务，先释放不断，最后一个才断', async () => {
  const registry = createDependencyRegistry();
  let starts = 0;
  let stops = 0;
  // A real probe reports the process state: the second acquire must see "still running" instead of
  // trusting a stale cache. (A probe that always said false would legitimately restart.)
  let running = false;
  registry.register('shared', {
    probe: async () => running,
    configured: () => true,
    start: async () => { starts += 1; running = true; return { started: true, running: true, owned: true }; },
    stop: async () => { stops += 1; running = false; },
  });
  await registry.acquire('vision', 'shared');
  await registry.acquire('avatar', 'shared');
  assert.equal(starts, 1, 'the second user reuses the service');
  assert.deepEqual(registry.usersOf('shared').sort(), ['avatar', 'vision']);
  await registry.release('vision', 'shared', { autoClose: true });
  assert.equal(stops, 0, 'one user leaving does not stop a shared service');
  await registry.release('avatar', 'shared', { autoClose: true });
  assert.equal(stops, 1, 'the last user stops it');
});

// ---------------------------------------------------------------------------
// 12. concurrent starts are merged
// ---------------------------------------------------------------------------
test('12. 并发打开两个容器：同一依赖只启动一次', async () => {
  const registry = createDependencyRegistry();
  let starts = 0;
  let releaseStart;
  const gate = new Promise((resolve) => { releaseStart = resolve; });
  registry.register('shared', {
    probe: async () => false,
    configured: () => true,
    start: async () => {
      starts += 1;
      await gate;
      return { started: true, running: true, owned: true };
    },
    stop: async () => {},
  });
  const first = registry.acquire('vision', 'shared');
  const second = registry.acquire('avatar', 'shared');
  releaseStart();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(starts, 1, 'two concurrent acquires share one start task');
  assert.equal(a.started, true);
  assert.equal(b.started, true);
  assert.equal(registry.usersOf('shared').length, 2);
});

// ---------------------------------------------------------------------------
// 13. user-started programs are reused, never adopted
// ---------------------------------------------------------------------------
test('13. 用户手动启动的程序：发现已运行可复用，释放时不关闭、不取得关闭权', async () => {
  const registry = createDependencyRegistry();
  let starts = 0;
  let stops = 0;
  registry.register('obs', {
    probe: async () => true,
    configured: () => true,
    start: async () => { starts += 1; return { started: true, running: true, owned: true }; },
    stop: async () => { stops += 1; },
  });
  const result = await registry.acquire('vision', 'obs');
  assert.equal(result.started, false);
  assert.equal(result.owned, false);
  assert.equal(starts, 0);
  await registry.release('vision', 'obs', { autoClose: true });
  assert.equal(stops, 0, 'a user-started OBS is never closed');
  assert.equal(registry.isOwned('obs'), false);
});

// ---------------------------------------------------------------------------
// 13b. release during an in-flight start must close the late process
// ---------------------------------------------------------------------------
test('13b. 在途启动中 release：启动完成后立即停止一次，归属清空', async () => {
  const registry = createDependencyRegistry();
  let stops = 0;
  let releaseStart;
  const gate = new Promise((resolve) => { releaseStart = resolve; });
  registry.register('slow', {
    probe: async () => false,
    configured: () => true,
    start: async () => {
      await gate;
      return { started: true, running: true, owned: true };
    },
    stop: async () => { stops += 1; },
  });
  const acquiring = registry.acquire('voice', 'slow');
  const releasing = registry.release('voice', 'slow', { autoClose: true });
  releaseStart();
  await acquiring;
  const released = await releasing;
  assert.equal(stops, 1, 'the late spawn is stopped after its start settles');
  assert.equal(released.ok, true);
  assert.equal(released.closed, true);
  assert.equal(registry.isOwned('slow'), false);
  assert.deepEqual(registry.usersOf('slow'), []);
});

// ---------------------------------------------------------------------------
// 13c. a failed stop is reported and keeps ownership for a retry
// ---------------------------------------------------------------------------
test('13c. stop 抛错：返回 ok:false 且保留归属，二次 stop 可重试成功', async () => {
  const registry = createDependencyRegistry();
  let attempts = 0;
  registry.register('flaky', {
    probe: async () => false,
    configured: () => true,
    start: async () => ({ started: true, running: true, owned: true }),
    stop: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('taskkill failed');
    },
  });
  await registry.acquire('voice', 'flaky');
  const first = await registry.release('voice', 'flaky', { autoClose: true });
  assert.equal(first.ok, false);
  assert.equal(first.closed, false);
  assert.equal(first.code, 'DEPENDENCY_STOP_FAILED');
  assert.equal(registry.isOwned('flaky'), true, 'ownership survives a failed stop');
  const second = await registry.release('voice', 'flaky', { autoClose: true });
  assert.equal(second.ok, true);
  assert.equal(second.closed, true);
  assert.equal(attempts, 2);
  assert.equal(registry.isOwned('flaky'), false);
});

// ---------------------------------------------------------------------------
// 13d. shutdown retries a failed close instead of dropping the record
// ---------------------------------------------------------------------------
test('13d. 退出路径 stop 失败仍会再尝试：归属不丢，第二次成功', async () => {
  const registry = createDependencyRegistry();
  let attempts = 0;
  registry.register('flaky', {
    probe: async () => false,
    configured: () => true,
    start: async () => ({ started: true, running: true, owned: true }),
    stop: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('first close failed');
    },
  });
  await registry.acquire('voice', 'flaky');
  const results = await registry.shutdown();
  assert.equal(attempts, 2, 'shutdown retries the still-owned dependency');
  assert.equal(results[0].ok, false);
  assert.equal(results[1].ok, true);
  assert.equal(registry.isOwned('flaky'), false);
});

// ---------------------------------------------------------------------------
// 14. provider/backend choice does not launch unneeded dependencies
// ---------------------------------------------------------------------------
test('14. 选 Edge TTS 不启 GPT-SoVITS；直接截图（watch）不为视觉启 OBS', async (t) => {
  const app = await mount(t, {
    features: { voice: false, vision: false },
    settings: { gptSovits: { enabled: false }, vision: { mode: 'watch' } },
  });
  await app.action({ action: 'feature.set', id: 'voice', enabled: true });
  await app.action({ action: 'feature.set', id: 'vision', enabled: true });
  assert.equal(gptSpawns().length, 0, 'Edge TTS provider never launches GPT-SoVITS');
  assert.equal(state.spawns.some((row) => /obs64\.exe|obs-studio/iu.test(row.cmd)), false, 'watch mode never launches OBS');
  const settings = await app.settingsNow();
  assert.equal(settings.autostart.gptsovits.enabled, true, 'the voice binding is restored even without a launch');
  assert.equal(settings.autostart.obs.enabled, true, 'the vision binding is restored even without a launch');
});

// ---------------------------------------------------------------------------
// 15. provider off → on restores and starts exactly once
// ---------------------------------------------------------------------------
test('15. provider 关→开：组件不动，GPT-SoVITS 重新启动一次', async (t) => {
  const app = await mount(t, { features: { voice: true }, settings: gptSettings(), bootDelay: 5 });
  await until(() => gptSpawns().length === 1, 'startup started GPT-SoVITS once');
  await app.action({ action: 'tts.config', enabled: false });
  assert.equal(gptSpawns().length, 1);
  state.spawns = [];
  const reopened = await app.action({ action: 'tts.config', enabled: true });
  assert.equal(reopened.ok, true);
  assert.equal(gptSpawns().length, 1, 'reopening the provider starts the dependency once');
  const features = await app.featuresNow();
  const settings = await app.settingsNow();
  assert.equal(features.voice, true);
  assert.equal(settings.gptSovits.enabled, true);
});

// ---------------------------------------------------------------------------
// 16. voice component off snapshots and restores its children
// ---------------------------------------------------------------------------
test('16. voice 组件关→开：provider/播报按原设置恢复，子级开关不擅自改变 provider', async (t) => {
  const app = await mount(t, { features: { voice: true }, settings: gptSettings(), bootDelay: 5 });
  await until(() => gptSpawns().length === 1, 'startup started GPT-SoVITS once');
  await app.action({ action: 'feature.set', id: 'voice', enabled: false });
  let settings = await app.settingsNow();
  assert.equal(settings.gptSovits.enabled, false);
  assert.equal(settings.voice.enabled, false);
  state.spawns = [];
  await app.action({ action: 'feature.set', id: 'voice', enabled: true });
  settings = await app.settingsNow();
  assert.equal(settings.gptSovits.enabled, true, 'the provider restores the user value, not a default');
  assert.equal(settings.voice.enabled, true, 'playback restores');
  assert.equal(gptSpawns().length, 1, 'dependency starts once after reopening the component');
});

// ---------------------------------------------------------------------------
// 17. voice close does not disturb other components
// ---------------------------------------------------------------------------
test('17. 关闭 voice 不影响 vision/avatar/hearing 的组件与子级/自启动开关', async (t) => {
  const app = await mount(t, {
    features: { voice: true, vision: true, avatar: true, hearing: true },
    settings: gptSettings(),
  });
  const before = await app.settingsNow();
  await app.action({ action: 'feature.set', id: 'voice', enabled: false });
  const after = await app.settingsNow();
  const features = await app.featuresNow();
  for (const id of ['vision', 'avatar', 'hearing']) assert.equal(features[id], true);
  assert.deepEqual(after.vision, before.vision);
  assert.equal(after.autostart.obs.enabled, true);
  assert.equal(after.autostart.vts.enabled, true);
  assert.equal(after.hearing.enabled, true);
  assert.equal(after.autostart.gptsovits.enabled, false);
});

// ---------------------------------------------------------------------------
// 18. startup: disabled components never start their dependency
// ---------------------------------------------------------------------------
test('18. 启动 DSH：关闭的组件不启动依赖，开启的组件只启动一次', async (t) => {
  const app = await mount(t, {
    features: { voice: false, vision: false, avatar: false },
    settings: gptSettings(),
    bootDelay: 5,
  });
  await tick(40);
  assert.equal(gptSpawns().length, 0, 'a disabled voice component never starts GPT-SoVITS');
  assert.equal(state.spawns.length, 0, 'no disabled dependency is launched at boot');
  const settings = await app.settingsNow();
  assert.equal(settings.gptSovits.enabled, false, 'the disabled component turns its provider off');
  assert.equal(settings.autostart.gptsovits.enabled, false);
});

// ---------------------------------------------------------------------------
// 19. DSH exit closes by ownership even after the switch was cleared
// ---------------------------------------------------------------------------
test('19. 退出 DSH：自关闭开关已被清零，仍按记录关闭插件启动的依赖', async (t) => {
  const app = await mount(t, { features: { voice: true }, settings: gptSettings(), bootDelay: 5 });
  await until(() => gptSpawns().length === 1, 'startup started GPT-SoVITS once');
  const pid = gptSpawns()[0].pid;
  // Clear the recorded switch the way a component close would; ownership must survive it.
  await app.action({ action: 'autostart.set', target: 'gptsovits', autoClose: false, enabled: false });
  assert.equal(taskkills().length, 0, 'changing the switch alone closes nothing');
  await app.dispose();
  assert.ok(taskkills().some((row) => row.args.includes(String(pid))), 'DSH exit closed the recorded pid anyway');
});
