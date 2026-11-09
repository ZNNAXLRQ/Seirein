/**
 * P-187 阶段 1 host wiring：回环转写的 partial 也写进媒体台词时间线。
 *
 * 这段接线只在「环境声（回环）采集」里存在，真实触发要有虚拟声卡、ffmpeg 与 ASR 模型。这里
 * 把 hearing/sight/hardware 换成替身，只保留宿主自己的回环 onUpdate：`ambient.start` 动作
 * 走真实路由，拿到宿主交给 startHearing 的 onUpdate 后手动投递 partial 与终稿。这样不需要
 * 任何设备，也能证明宿主把「同一段的 partial 与终稿」用同一个 id 送进时间线。
 *
 * 媒体时间线本身通过一个薄的加载器包装拿到宿主创建的那个实例（仍调用真实模块），因此可以
 * 直接断言条数、终稿文本与区间并集，而不是只看事件日志里的计数。
 *
 * 覆盖：
 *   1. 模块契约：同一 id 的 partial→final 只有一条，文本为终稿，区间取并集
 *   2. 宿主接线：partial 与终稿同 id → 时间线一条、final 状态；status 只报 1 条
 *   3. 兜底与空文本：没有 utteranceId 时才合成 `loopback-partial-<n>`；纯空白 partial 不写
 *
 * Run: node --test test/hearing-media-partial-host.mjs
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { Readable } from 'node:stream';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cleanupRoot } from './helpers/cleanup.mjs';
// `?real` keeps this import on the real module while the host's plain import is wrapped below.
import { createMediaTimeline } from '../src/host/hearing/media-timeline.js?real';

const NOW = Date.now();
const state = {
  /** The live timeline instance the host created (captured by the wrapper). */
  timeline: null,
  /** The loopback session's onUpdate, handed over by the host at `startHearing`. */
  onUpdate: null,
  events: [],
  sessions: 0,
};
globalThis.__visionMediaPartialHost = state;

const moduleUrl = (path) => new URL(path, import.meta.url).href;
const hearingUrl = moduleUrl('../src/host/hearing/hearing.js');
const sightUrl = moduleUrl('../src/host/vision/sight.js');
const hardwareUrl = moduleUrl('../src/host/platform/hardware.js');
const mediaTimelineUrl = moduleUrl('../src/host/hearing/media-timeline.js');

const hooks = registerHooks({
  load(href, context, next) {
    if (href === hearingUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          const s = globalThis.__visionMediaPartialHost;
          export const modelReady = () => true;
          export const finalModelReady = () => false;
          // ambient.js imports this classifier at module load, even when no session starts.
          export const isLoopbackDevice = (name) => /CABLE|Stereo Mix|Virtual/i.test(String(name));
          export const listDevices = async () => ['CABLE Output (VB-Audio Virtual Cable)'];
          export const startHearing = (options) => {
            s.sessions += 1;
            s.onUpdate = options.onUpdate;
            return {
              device: options.device,
              source: 'loopback',
              done: Promise.resolve(),
              stop() {},
              stats: () => null,
            };
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
          const forbidden = async () => { throw new Error('capture forbidden'); };
          export const resolveFfmpeg = () => 'ffmpeg-fake';
          export const resolveFfplay = () => null;
          export const capture = forbidden;
          export const captureDesktop = forbidden;
          export const captureDevice = forbidden;
          export const startStoryboard = forbidden;
          export const OBSERVATION_TTL_MS = 30000;
          export function readObservation(o, { now = Date.now(), ttlMs = 30000 } = {}) {
            const v = o ?? {};
            const c = Number(v.capturedAt);
            const s = Number.isFinite(c) && c > 0 ? c : Number(v.at);
            const at = Number.isFinite(s) && s > 0 ? s : null;
            const ageMs = at === null ? null : Math.max(0, now - at);
            const stale = ageMs === null || ageMs >= ttlMs;
            return { ...v, at, ageMs, stale, hint: stale ? 'stale' : '' };
          }
        `,
      };
    }
    if (href === hardwareUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        // Never let the test machine's core count turn ambient capture off as the "low" tier.
        source: `
          export const detectTuning = () => ({
            cores: 8, memoryGb: 16, streamThreads: 2, finalThreads: 3, decodeCapSec: 10, tier: 'mid',
          });`,
      };
    }
    if (href === mediaTimelineUrl) {
      // Wrap the real factory so the test can read the exact instance the host owns. The real
      // module is loaded under `?real`, so this hook never intercepts it recursively.
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          import { createMediaTimeline as realCreate } from '${mediaTimelineUrl}?real';
          export { MEDIA_TIMELINE_DEFAULTS } from '${mediaTimelineUrl}?real';
          export function createMediaTimeline(options) {
            const timeline = realCreate(options);
            globalThis.__visionMediaPartialHost.timeline = timeline;
            return timeline;
          }
        `,
      };
    }
    return next(href, context);
  },
});

const { apply } = await import('../src/host/index.js');
const { EventLog } = await import('../src/host/memory/store.js');
hooks.deregister();

// Event log writes are in-memory here: the test is not about the file, and no disk I/O is needed.
const originalEmit = EventLog.prototype.emit;
EventLog.prototype.emit = async function emit(type, payload) {
  state.events.push({ type, payload });
  return { id: 'hearing-media-partial-host', ts: new Date().toISOString(), type, payload };
};

after(() => {
  EventLog.prototype.emit = originalEmit;
  delete globalThis.__visionMediaPartialHost;
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

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
        if (entry.type === type) entry.fn(...args);
      }
    },
  };
}

/** Mount the host with fake hardware/hearing; no device, ffmpeg, ASR model or network is touched. */
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-vision-media-partial-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await writeFile(join(root, 'data', 'features.json'), JSON.stringify({ ambient: true, voice: false }), 'utf8');
  await writeFile(join(root, 'data', 'settings.json'), '{}', 'utf8');

  state.timeline = null;
  state.onUpdate = null;
  state.events = [];
  state.sessions = 0;

  const routes = new Map();
  const tools = new Map();
  const promptSections = new Map();
  const promptContexts = new Map();
  const disposers = [];
  const effect = (fn) => {
    const cleanup = fn();
    if (typeof cleanup === 'function') disposers.push(cleanup);
    return cleanup;
  };
  const bus = createBus();
  const attachments = {
    async saveImage({ data, mediaType, name }) {
      return { id: 'att-1', mediaType, name, bytes: data.length };
    },
    async deleteImage() {},
  };
  const llm = {
    async resolveModelInfo(provider, model) {
      return { provider, id: model, name: model, inputModalities: ['text', 'image'] };
    },
  };
  const ctx = {
    effect,
    on: bus.on,
    get: (service) => (service === 'attachments' ? attachments : service === 'llm' ? llm : undefined),
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    inject: (_dependencies, register) => register({
      effect,
      systemPrompt: {
        section(definition) {
          promptSections.set(definition.name, definition);
          return () => {};
        },
        context(definition) {
          promptContexts.set(definition.name, definition);
          return () => {};
        },
      },
      webServer: {
        register(route) {
          routes.set(route.path, route.handler);
          return () => routes.delete(route.path);
        },
      },
    }),
  };
  apply(ctx, {
    root,
    enabled: true,
    defaultDomain: 'chat',
    privacyScene: 'Privacy',
    // No capture, no boot: this test only drives the loopback onUpdate by hand.
    evidenceCaptureEnabled: false,
    dependencyBootDelayMs: 60_000,
    evidenceCaptureBootDelayMs: 60_000,
  });

  t.after(async () => {
    await cleanupRoot(root, disposers.splice(0));
  });

  const route = async (path, body, method = 'POST') => {
    const req = method === 'GET'
      ? { method: 'GET', url: path }
      : Object.assign(Readable.from([JSON.stringify(body)]), { method: 'POST', url: path });
    const handler = routes.get(path.split('?')[0]);
    assert.ok(handler !== undefined, `route ${path} is registered`);
    let payload = '';
    await handler(req, {
      writeHead() {},
      end(data) { payload = data ?? ''; },
    });
    return JSON.parse(payload);
  };
  const status = () => route('/assistant/status', undefined, 'GET');
  const action = (body) => route('/assistant/action', body);
  const startAmbient = async () => {
    const started = await action({ action: 'ambient.start' });
    assert.equal(started.ok, true, `ambient.start failed: ${started.error ?? ''}`);
    assert.equal(state.sessions, 1, 'the loopback session was started once');
    assert.equal(typeof state.onUpdate, 'function', 'the loopback session exposes onUpdate');
    return state.onUpdate;
  };

  return { root, status, action, startAmbient, tools, promptSections, promptContexts };
}

// ---------------------------------------------------------------------------
// 1. 模块契约：同一 id 的 partial→final 是一条，终稿文本，区间并集
// ---------------------------------------------------------------------------

test('媒体时间线契约：同 id partial→final 后只有一条、文本为终稿、区间取并集', () => {
  const timeline = createMediaTimeline({ now: () => NOW + 1_000 });
  timeline.upsert({
    id: 'h-test:1',
    audioStartAt: NOW,
    audioEndAt: NOW + 120,
    text: '今天',
    status: 'partial',
    sourceEpoch: 7,
  });
  const final = timeline.upsert({
    id: 'h-test:1',
    audioStartAt: NOW + 40,
    audioEndAt: NOW + 500,
    text: '今天啊',
    status: 'final',
    sourceEpoch: 7,
  });
  assert.equal(final.status, 'final');
  assert.equal(final.text, '今天啊');
  assert.equal(final.audioStartAt, NOW, '并集保留更早的开始');
  assert.equal(final.audioEndAt, NOW + 500, '并集取更晚的结束');
  assert.equal(timeline.state().entries, 1);
  assert.equal(timeline.state().finals, 1);
});

// ---------------------------------------------------------------------------
// 2. 宿主接线：partial 与终稿同 id，final 原地覆盖
// ---------------------------------------------------------------------------

test('回环 partial 与终稿同 id：宿主先写 partial，终稿到达后更新同一条为 final', async (t) => {
  const app = await fixture(t);
  const onUpdate = await app.startAmbient();
  assert.ok(state.timeline !== null, 'the host created its media timeline');

  const id = 'h1-host-test:1';
  onUpdate({
    partial: '今天',
    utteranceId: id,
    audioStartAt: NOW,
    audioEndAt: NOW + 120,
  });
  let entries = state.timeline.between(NOW, NOW + 10_000);
  assert.equal(entries.length, 1, 'partial 已经作为证据写入');
  assert.equal(entries[0].id, id, 'partial 使用听觉层给的 utteranceId');
  assert.equal(entries[0].status, 'partial');
  assert.equal(entries[0].text, '今天');
  assert.equal(entries[0].audioStartAt, NOW);
  assert.equal(entries[0].audioEndAt, NOW + 120);

  onUpdate({
    final: '今天啊',
    durationMs: 500,
    at: NOW + 500,
    utteranceId: id,
    audioStartAt: NOW,
    audioEndAt: NOW + 500,
  });
  entries = state.timeline.between(NOW, NOW + 10_000);
  assert.equal(entries.length, 1, '同一 id 只有一条，终稿不是追加');
  assert.equal(entries[0].id, id, '终稿与 partial 同 id');
  assert.equal(entries[0].status, 'final');
  assert.equal(entries[0].text, '今天啊', '文本被终稿覆盖');
  assert.equal(entries[0].audioStartAt, NOW, '开始时间取并集');
  assert.equal(entries[0].audioEndAt, NOW + 500, '结束时间取并集');

  const snapshot = await app.status();
  assert.equal(snapshot.hearing.media.entries, 1);
  assert.equal(snapshot.hearing.media.finals, 1);
});

// ---------------------------------------------------------------------------
// 3. 兜底与空文本：合成 id 只在没有 utteranceId 时使用；纯空白不写
// ---------------------------------------------------------------------------

test('没有 utteranceId 时才合成 loopback-partial-<n>；纯空白 partial 不写', async (t) => {
  const app = await fixture(t);
  const onUpdate = await app.startAmbient();

  onUpdate({ partial: '   ', utteranceId: 'h1-host-test:2', audioStartAt: NOW, audioEndAt: NOW + 10 });
  assert.equal(state.timeline.state().entries, 0, '纯空白 partial 不写证据');

  // 旧事件没有 utteranceId：同一段内的多个 partial 共享一个稳定的合成 id。
  onUpdate({ partial: '无编号', audioStartAt: NOW, audioEndAt: NOW + 100 });
  onUpdate({ partial: '无编号的', audioStartAt: NOW, audioEndAt: NOW + 200 });
  const entries = state.timeline.between(NOW, NOW + 10_000);
  assert.equal(entries.length, 1, '同一兜底段仍是一条');
  assert.match(entries[0].id, /^loopback-partial-\d+$/u, '合成 id 只在事件没有 utteranceId 时使用');
  assert.equal(entries[0].status, 'partial');
  assert.equal(entries[0].text, '无编号的');
  assert.equal(entries[0].audioStartAt, NOW);
  assert.equal(entries[0].audioEndAt, NOW + 200);
});
