/**
 * P-57 · C3 环境音来源与状态区分。
 *
 * 1. 环境音条目在三处统一带 `source:'ambient'`：`ambientState.recent`（经 poll 的 `entries`
 *    投影）、`ambient.utterance` 事件、`assistant_ambient poll` 返回条目；端点分类保留在
 *    `endpoint`（loopback/mic），不覆盖旧字段语义。
 * 2. `/assistant/status` 在既有 `hearing` 块里并列暴露 `hearing.mic` 与 `hearing.ambient`
 *    （运行状态/设备/来源），旧的 `hearing.running`/`ambient.running`/`ambient.source` 语义不变。
 * 3. 环境音终稿只进上下文，不触发回复/不产生麦克风投递。
 * 4. ambient ffmpeg 退出后 3 秒内 `running:false` 且有 `ambient.exit`；之后不会自动恢复，
 *    只有显式 start 才重新开流。
 *
 * 宿主是真实 `apply()`，听觉/视觉/OBS/硬件模块用 test double 短路；不启动真实设备、ffmpeg、
 * ASR 模型或子进程。
 *
 * Run: node --test test/ambient-source-state.mjs
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { cleanupRoot } from './helpers/cleanup.mjs';

const LOOPBACK = 'CABLE Output (VB-Audio Virtual Cable)';
const MIC = 'Fake Microphone';
const NOW = 1_700_000_000_000;

const state = {
  events: [],
  followups: [],
  starts: [],
  ambientOptions: null,
  micOptions: null,
  listenerErrors: [],
};
globalThis.__ambientSourceState = state;

const moduleUrl = (path) => new URL(path, import.meta.url).href;
const hearingUrl = moduleUrl('../src/host/hearing/hearing.js');
const sightUrl = moduleUrl('../src/host/vision/sight.js');
const obsUrl = moduleUrl('../src/host/vision/obs.js');
const hardwareUrl = moduleUrl('../src/host/platform/hardware.js');

const hooks = registerHooks({
  load(href, context, next) {
    if (href === hearingUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          const s = globalThis.__ambientSourceState;
          const isLoopback = (name) => /CABLE|Stereo Mix|Virtual|立体声混音/i.test(String(name));
          export const modelReady = () => true;
          export const finalModelReady = () => false;
          export const isLoopbackDevice = (name) => isLoopback(name);
          export const listDevices = async () => ['${LOOPBACK}', '${MIC}'];
          export const selectMicrophoneDevice = (devices, requested) => {
            const wanted = typeof requested === 'string' ? requested : '';
            if (wanted !== '' && isLoopback(wanted)) return { device: '', loopback: true, error: 'MIC_LOOPBACK_REJECTED' };
            if (wanted !== '' && devices.includes(wanted)) return { device: wanted, loopback: false, error: '' };
            return { device: devices.find((name) => !isLoopback(name)) ?? '', loopback: false, error: '' };
          };
          export const startHearing = (options) => {
            let resolveExit;
            const done = new Promise((resolve) => { resolveExit = resolve; });
            const session = {
              device: options.device,
              instanceId: 'fake-' + s.starts.length,
              done,
              stop() {},
              stats: () => null,
              resolveExit(exit) { resolveExit(exit); },
            };
            s.starts.push({ device: options.device, options, session });
            if (isLoopback(options.device)) s.ambientOptions = options;
            else s.micOptions = options;
            return session;
          };
          // Mirrors hearing.js: only the current slot reports an exit, and both resolve and
          // reject settle as one exit report.
          export const watchHearingExit = (session, { isCurrent = () => true, onExit } = {}) => session.done.then(
            (exit) => {
              if (!isCurrent()) return null;
              onExit?.({ code: exit?.code ?? null, signal: exit?.signal ?? null, error: exit?.error ?? null });
              return exit;
            },
            (error) => {
              if (!isCurrent()) return null;
              onExit?.({ code: null, signal: null, error: error?.message ?? String(error) });
              return null;
            },
          );
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
          const forbidden = async () => { throw new Error('real capture forbidden'); };
          export const resolveFfmpeg = () => 'fake-ffmpeg';
          export const resolveFfplay = () => null;
          export const capture = forbidden;
          export const captureDesktop = forbidden;
          export const captureDevice = forbidden;
          export const startStoryboard = forbidden;
          export const shrinkShot = async () => null;
          export const OBSERVATION_TTL_MS = 30000;
          export function readObservation(o, { now = Date.now(), ttlMs = 30000 } = {}) {
            const v = o ?? {};
            const at = Number(v.at) > 0 ? Number(v.at) : null;
            const ageMs = at === null ? null : Math.max(0, now - at);
            return { ...v, at, ageMs, stale: ageMs === null || ageMs >= ttlMs, hint: '' };
          }
        `,
      };
    }
    if (href === obsUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          export const connectObs = async () => ({
            request: async (type) => {
              if (type === 'GetSceneList') {
                return { currentProgramSceneName: 'Main', scenes: [{ sceneName: 'Main' }] };
              }
              if (type === 'GetCurrentProgramScene') return { currentProgramSceneName: 'Main' };
              return {};
            },
            close() {},
          });
        `,
      };
    }
    if (href === hardwareUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          export const detectTuning = () => ({
            cores: 8, memoryGb: 16, streamThreads: 2, finalThreads: 3, decodeCapSec: 10, tier: 'mid',
          });
        `,
      };
    }
    return next(href, context);
  },
});

const { apply } = await import('../src/host/index.js');
const { EventLog } = await import('../src/host/memory/store.js');
hooks.deregister();

const originalEmit = EventLog.prototype.emit;
EventLog.prototype.emit = async function emit(type, payload) {
  state.events.push({ type, payload });
  return { id: 'ambient-source-state', ts: new Date().toISOString(), type, payload };
};

after(() => {
  EventLog.prototype.emit = originalEmit;
  delete globalThis.__ambientSourceState;
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, label, timeoutMs = 3_000) {
  const startedAt = Date.now();
  for (;;) {
    if (await check()) return Date.now() - startedAt;
    if (Date.now() - startedAt >= timeoutMs) assert.fail(`timed out: ${label}`);
    await sleep(10);
  }
}

function createBus() {
  const listeners = new Set();
  return {
    on(type, fn) {
      const entry = { type, fn };
      listeners.add(entry);
      return () => listeners.delete(entry);
    },
    fire(type, ...args) {
      for (const entry of [...listeners]) {
        if (entry.type !== type) continue;
        try {
          entry.fn(...args);
        } catch (error) {
          state.listenerErrors.push({ type, error: error?.message ?? String(error) });
        }
      }
    },
  };
}

/** One mount: real apply() with the capture modules supplied by the loader hooks above. */
async function mount(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ambient-source-state-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await mkdir(join(root, 'workspace'), { recursive: true });
  await writeFile(join(root, 'data', 'features.json'), JSON.stringify({
    hearing: true,
    ambient: true,
    voice: false,
    fastpath: false,
  }), 'utf8');
  await writeFile(join(root, 'data', 'settings.json'), JSON.stringify({
    hearing: { enabled: true, autoListen: false },
    ambient: { enabled: true, autoListen: false },
  }), 'utf8');

  state.events = [];
  state.followups = [];
  state.starts = [];
  state.ambientOptions = null;
  state.micOptions = null;
  state.listenerErrors = [];

  const bus = createBus();
  const tools = new Map();
  const routes = new Map();
  const cleanups = [];
  const agents = new Map();
  let persisted = false;

  const effect = (fn) => {
    const cleanup = fn();
    if (typeof cleanup === 'function') cleanups.push(cleanup);
    return cleanup;
  };
  const registerRoute = (route) => {
    routes.set(route.path, route.handler);
    return () => routes.delete(route.path);
  };
  const on = bus.on;

  /** One synthetic turn per microphone delivery so a spoken final settles instead of hanging. */
  const makeAgent = (sessionId) => {
    const session = { id: sessionId, header: { cwd: join(root, 'workspace') }, append() {} };
    let turn = 0;
    return {
      id: sessionId,
      session,
      followup(message) {
        state.followups.push(message);
        turn += 1;
        const fire = (type, data) => bus.fire('session/event', session, {
          type,
          seq: state.events.length + turn,
          time: Date.now(),
          data,
        });
        fire('turn/start', { turn });
        fire('user/message', message);
        fire('assistant/message', {
          turn,
          message: { role: 'assistant', content: [{ type: 'text', text: '好的' }] },
        });
        fire('turn/end', { turn, reason: { kind: 'completed' } });
      },
    };
  };

  const services = {
    agentLoop: {
      async resume(_ownerCtx, options) {
        if (!persisted) throw new Error('not persisted yet');
        if (!agents.has(options.resumeSessionId)) agents.set(options.resumeSessionId, makeAgent(options.resumeSessionId));
        return { agent: agents.get(options.resumeSessionId) };
      },
      async createAgent(_ownerCtx, options) {
        const agent = makeAgent(options.sessionId);
        agents.set(options.sessionId, agent);
        persisted = true;
        return { agent };
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
    sessionTitle: {
      get: () => undefined,
      rename: (_session, title) => ({ title, source: { kind: 'user' } }),
    },
    workspaceRegistry: {
      async create(path) {
        return { id: 'ws-ambient-source-state', path };
      },
      get() {
        return { id: 'ws-ambient-source-state', async attachSession() {} };
      },
    },
  };

  const scope = {
    effect,
    on,
    systemPrompt: { section: () => () => {} },
    webServer: { register: registerRoute },
  };
  apply({
    effect,
    on,
    get: (serviceName) => services[serviceName],
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    inject: (_deps, register) => register(scope),
    systemPrompt: { section: () => () => {} },
    webServer: { register: registerRoute },
  }, { root, enabled: true, asrMergeWindowMs: 10 });

  t.after(async () => {
    await cleanupRoot(root, cleanups.splice(0));
  });

  const route = async (path, { method = 'POST', body = undefined } = {}) => {
    const handler = routes.get(path);
    assert.equal(typeof handler, 'function', `route ${path} is registered`);
    let payload;
    await handler(
      method === 'GET'
        ? { method: 'GET', url: path }
        : Object.assign(Readable.from([JSON.stringify(body ?? {})]), { method: 'POST', url: path }),
      { writeHead() {}, end(value) { payload = value; } },
    );
    return typeof payload === 'string' ? JSON.parse(payload) : payload;
  };
  const action = (body) => route('/assistant/action', { body });
  const status = () => route('/assistant/status', { method: 'GET' });
  const call = (name, args = {}) => {
    const tool = tools.get(name);
    assert.ok(tool !== undefined, `${name} is registered`);
    return tool.execute(args, {});
  };
  const rows = (type) => state.events.filter((entry) => entry.type === type);
  const waitForEvent = (type, predicate = () => true) => until(
    () => rows(type).some((entry) => predicate(entry.payload)),
    `${type} event`,
  ).then(() => rows(type).find((entry) => predicate(entry.payload)));
  const startAmbient = async () => {
    const result = await action({ action: 'ambient.start' });
    assert.equal(result.ok, true, `ambient.start succeeded: ${result.error ?? ''}`);
    assert.ok(state.ambientOptions !== null, 'the fake ambient session captured its options');
    return result;
  };

  return {
    root, tools, action, status, call, rows, waitForEvent, startAmbient,
    ambientSession: () => state.starts.filter((entry) => entry.device === LOOPBACK).at(-1)?.session,
    ambientOptions: () => state.ambientOptions,
    micOptions: () => state.micOptions,
    followups: () => state.followups,
  };
}

test('1. 环境音条目统一 source=ambient：recent / ambient.utterance / poll entries', async (t) => {
  const app = await mount(t);
  await app.startAmbient();

  app.ambientOptions().onUpdate({
    final: '电影里的台词', durationMs: 800, at: NOW, utteranceId: 'ambient-1',
    audioStartAt: NOW - 800, audioEndAt: NOW,
  });
  await app.waitForEvent('ambient.utterance', (payload) => payload.text === '电影里的台词');

  const event = app.rows('ambient.utterance').at(-1).payload;
  assert.equal(event.source, 'ambient', 'ambient.utterance 标记环境音来源');
  assert.equal(event.endpoint, 'loopback', '端点分类保留在 endpoint');

  const poll = await app.call('assistant_ambient', { action: 'poll' });
  assert.equal(poll.ok, true);
  assert.deepEqual(poll.lines, ['电影里的台词'], '现有纯文本行不变');
  assert.equal(poll.entries.length, 1, 'poll 返回结构化条目');
  assert.deepEqual(poll.entries[0], {
    text: '电影里的台词',
    at: NOW,
    durationMs: 800,
    source: 'ambient',
    endpoint: 'loopback',
  }, '条目带 lane 来源与端点分类');

  const snapshot = await app.status();
  assert.deepEqual(snapshot.ambient.recent, ['电影里的台词'], 'status.ambient.recent 仍是纯文本');
  assert.equal(snapshot.ambient.source, 'loopback', '既有 ambient.source 仍是端点分类');
});

test('2. status 并列区分麦克风与回环会话，麦克风路径不被改标', async (t) => {
  const app = await mount(t);
  await app.startAmbient();

  const beforeMic = await app.status();
  assert.equal(beforeMic.hearing.mic.running, false);
  assert.equal(beforeMic.hearing.ambient.running, true);
  assert.equal(beforeMic.hearing.ambient.source, 'ambient');
  assert.equal(beforeMic.hearing.ambient.endpoint, 'loopback');
  assert.equal(beforeMic.hearing.ambient.device, LOOPBACK);
  assert.equal(beforeMic.hearing.running, false, '旧 hearing.running 仍只表示麦克风');

  const listened = await app.call('assistant_listen', { action: 'start' });
  assert.equal(listened.ok, true, `microphone started: ${listened.error ?? ''}`);
  assert.ok(app.micOptions() !== null);

  const both = await app.status();
  assert.equal(both.hearing.mic.running, true);
  assert.equal(both.hearing.mic.device, MIC);
  assert.equal(both.hearing.mic.source, 'mic');
  assert.equal(both.hearing.ambient.running, true, '两路可同时运行');
  assert.equal(both.hearing.running, true, '旧 hearing.running 与 hearing.mic.running 一致');
  assert.equal(both.ambient.running, true);
  assert.equal(both.ambient.device, LOOPBACK);
  assert.equal(both.ambient.source, 'loopback');

  app.micOptions().onUpdate({ final: '麦克风测试', durationMs: 120, utteranceId: 'mic-1' });
  await app.waitForEvent('hearing.utterance', (payload) => payload.text === '麦克风测试');
  await app.waitForEvent('voice.transcript', (payload) => payload.text.includes('麦克风测试'));

  const micUtterance = app.rows('hearing.utterance').at(-1).payload;
  assert.equal(Object.hasOwn(micUtterance, 'source'), false, 'hearing.utterance 不被标成 ambient');
  const micTranscript = app.rows('voice.transcript').at(-1).payload;
  assert.equal(micTranscript.source, undefined, 'voice.transcript 不被标成 ambient');
  assert.equal(app.rows('ambient.utterance').length, 0, '麦克风终稿不进入环境音事件');

  const stopped = await app.call('assistant_listen', { action: 'stop' });
  assert.equal(stopped.ok, true);
  await until(async () => (await app.status()).hearing.mic.running === false, 'mic stopped');
  const afterStop = await app.status();
  assert.equal(afterStop.hearing.mic.running, false);
  assert.equal(afterStop.hearing.ambient.running, true, '停麦不影响回环会话');
});

test('3. ambient 退出：3 秒内 running:false + ambient.exit，恢复必须显式 start', async (t) => {
  const app = await mount(t);
  await app.startAmbient();
  const session = app.ambientSession();
  assert.ok(session !== undefined);

  const killedAt = Date.now();
  session.resolveExit({ code: 0, signal: 'SIGKILL', error: null });
  const elapsed = await until(
    async () => (await app.status()).hearing.ambient.running === false,
    'ambient running:false',
    3_000,
  );
  assert.ok(elapsed < 3_000, `running:false within 3 s (took ${elapsed} ms)`);
  assert.ok(Date.now() - killedAt < 3_000);

  const exit = await app.waitForEvent('ambient.exit');
  assert.deepEqual(
    { code: exit.payload.code, signal: exit.payload.signal, error: exit.payload.error },
    { code: 0, signal: 'SIGKILL', error: null },
    'ambient.exit 携带真实退出信息',
  );
  const dead = await app.status();
  assert.equal(dead.ambient.running, false);
  assert.equal(dead.hearing.ambient.running, false);
  assert.equal(dead.hearing.ambient.endpoint, '');

  // No autostart retry: autoListen is off, so only an explicit start may reopen the lane.
  await sleep(250);
  assert.equal(app.rows('ambient.start').length, 1, '退出后没有自动重连');
  assert.equal((await app.status()).hearing.ambient.running, false, '静止时保持未运行');

  const restarted = await app.action({ action: 'ambient.start' });
  assert.equal(restarted.ok, true, `explicit restart succeeded: ${restarted.error ?? ''}`);
  const live = await app.status();
  assert.equal(live.hearing.ambient.running, true, '显式 start 后恢复');
  assert.equal(live.hearing.ambient.endpoint, 'loopback');
  assert.equal(app.rows('ambient.start').length, 2);
  assert.equal(app.rows('ambient.exit').length, 1);
});

test('4. 环境音只更新上下文：不投递、不触发回复', async (t) => {
  const app = await mount(t);
  await app.startAmbient();

  app.ambientOptions().onUpdate({
    final: '视频里说的话', durationMs: 600, utteranceId: 'ambient-only',
    audioStartAt: NOW - 600, audioEndAt: NOW,
  });
  await app.waitForEvent('ambient.utterance', (payload) => payload.text === '视频里说的话');
  await sleep(50);

  assert.equal(app.rows('voice.transcript').length, 0, '环境音不产生语音转写投递');
  assert.equal(app.rows('voice.injected').length, 0, '环境音不注入会话');
  assert.equal(app.rows('hearing.utterance').length, 0, '环境音不进入麦克风事件');
  assert.deepEqual(app.followups(), [], '环境音不触发任何回复回合');

  const listenPoll = await app.call('assistant_listen', { action: 'poll' });
  assert.deepEqual(listenPoll.finals, [], '麦克风 poll 没有拿到环境音文本');

  const ambientPoll = await app.call('assistant_ambient', { action: 'poll' });
  assert.deepEqual(ambientPoll.entries.map((entry) => entry.text), ['视频里说的话']);
  assert.ok(ambientPoll.entries.every((entry) => entry.source === 'ambient'));
});
