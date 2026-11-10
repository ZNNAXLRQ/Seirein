/**
 * P-187 阶段 5 host fake-event path: 用注入的 understandingAnalyzer 走真实的
 * `onAdvance → proposeProactive → proactive.propose → evaluateProactive`，
 * 证明 `proposed` 能随“带 reaction 的宏观事件”增长，并用同一个状态把
 * “成功但无事件 / 无 reaction / propose 被 expired 拒绝”分开。
 *
 * 语音关闭（features.voice=false）时 speakLine 返回 null，因此宿主层只断言到
 * `passed` 并确认 `spoken=0`；`spoken` 的纯仲裁器覆盖在 test/proactive-two-stage.mjs。
 *
 * Run: node test/proactive-host.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { Readable } from 'node:stream';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { disposeAll } from './helpers/cleanup.mjs';

const state = {
  allowCapture: false,
  storyboardFactory: null,
  captures: 0,
  storyboardStarts: 0,
};
globalThis.__proactiveHostTest = state;

const sightUrl = new URL('../src/host/vision/sight.js', import.meta.url).href;
const hooks = registerHooks({
  load(url, context, next) {
    if (url === sightUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          const s = globalThis.__proactiveHostTest;
          export const resolveFfmpeg = () => (s.allowCapture === true ? 'ffmpeg' : null);
          export const resolveFfplay = () => null;
          export const capture = (options) => s.makeShot(options.dir);
          export const captureDesktop = capture;
          export const captureDevice = capture;
          export const startStoryboard = (options) => {
            if (typeof s.storyboardFactory === 'function') return s.storyboardFactory(options);
            s.storyboardStarts = (s.storyboardStarts ?? 0) + 1;
            throw new Error('real capture forbidden');
          };
          export const OBSERVATION_TTL_MS = 30000;
          export function readObservation(observation, { now = Date.now(), ttlMs = 30000 } = {}) {
            const value = observation ?? {};
            const at = Number(value.capturedAt ?? value.at);
            const ageMs = Number.isFinite(at) && at > 0 ? Math.max(0, now - at) : null;
            return { ...value, at: ageMs === null ? null : at, ageMs, stale: ageMs === null || ageMs >= ttlMs, hint: '' };
          }`,
      };
    }
    return next(url, context);
  },
});
const { apply, voiceSessionTarget } = await import('../src/host/index.js');
hooks.deregister();

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-proactive-host-fake-'));
  const routes = new Map();
  const tools = new Map();
  const listeners = new Map();
  const disposers = [];
  const effect = (fn) => {
    const cleanup = fn();
    if (typeof cleanup === 'function') disposers.push(cleanup);
    return cleanup;
  };
  const on = (type, handler) => {
    const list = listeners.get(type) ?? [];
    list.push(handler);
    listeners.set(type, list);
    return () => {
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    };
  };
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
  await mkdir(join(root, 'workspace'), { recursive: true });
  await mkdir(join(root, 'data'), { recursive: true });
  const features = options.features ?? {
    hearing: false,
    ambient: false,
    voice: false,
    vision: true,
    subtitle: false,
    avatar: false,
    memory: false,
    fastpath: false,
  };
  const settings = options.settings ?? { vision: { continuousView: true } };
  await writeFile(join(root, 'data', 'features.json'), `${JSON.stringify(features)}\n`, 'utf8');
  await writeFile(join(root, 'data', 'settings.json'), `${JSON.stringify(settings)}\n`, 'utf8');

  apply({
    effect,
    on,
    get: (service) => (service === 'attachments' ? attachments : service === 'llm' ? llm : undefined),
    tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name); } },
    inject: (_dependencies, register) => register({
      effect,
      systemPrompt: {
        section() { return () => {}; },
        context() { return () => {}; },
      },
      webServer: {
        register(route) {
          routes.set(route.path, route.handler);
          return () => routes.delete(route.path);
        },
      },
    }),
  }, {
    root,
    enabled: true,
    defaultDomain: 'chat',
    privacyScene: 'Privacy',
    evidenceCaptureEnabled: options.evidenceCaptureEnabled === true,
    allowCapture: options.allowCapture === true,
    dependencyBootDelayMs: 60_000,
    evidenceCaptureBootDelayMs: 60_000,
    evidenceCaptureTickMs: 25,
    understandingMinIntervalMs: 1,
    // 宿主层不播放真实语音；短句生成器只返回文本，speakLine 在 voice=false 时返回 null。
    proactiveLineGenerator: options.proactiveLineGenerator
      ?? (async () => ({ ok: true, text: '测试主动句', reason: 'ok' })),
    ...options,
  });

  state.captures = 0;
  state.storyboardStarts = 0;
  state.allowCapture = options.allowCapture === true;
  state.storyboardFactory = null;
  state.makeShot = async () => {
    throw new Error('no capture expected in the proactive host test');
  };

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
  const dispose = async () => disposeAll(disposers.splice(0));

  t.after(async () => {
    await dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  return { root, status, dispose, listeners };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, timeoutMs = 5_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > until) assert.fail('condition not met before timeout');
    await delay(10);
  }
}

/** 一张 fake 故事板，随后返回 null；不触碰真实屏幕。 */
function installStoryboard(root, name = 'sheet-proactive.png') {
  const screenDir = join(root, 'cache', 'screens');
  let takes = 0;
  state.storyboardFactory = () => ({
    engine: 'fake',
    sourceKind: 'screen',
    done: Promise.resolve(),
    stop: () => {},
    take: async () => {
      if (takes > 0) return null;
      takes += 1;
      return {
        file: join(screenDir, name),
        capturedAt: Date.now(),
        width: 2,
        height: 2,
        frames: 2,
      };
    },
  });
  return mkdir(screenDir, { recursive: true }).then(() => writeFile(
    join(screenDir, name),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x05]),
  ));
}

async function enterCompanionTurn(app) {
  const companionId = voiceSessionTarget({ root: app.root }).sessionId;
  const workspace = join(app.root, 'workspace');
  const companion = {
    id: companionId,
    session: { id: companionId, header: { cwd: workspace } },
  };
  const handlers = app.listeners.get('agent/pre-step') ?? [];
  assert.ok(handlers.length > 0, 'Host 注册了 agent/pre-step');
  await handlers[0]({
    agent: companion,
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
    messages: [{ id: 'u-proactive-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '嗨' }] }],
  }, async () => ({ kind: 'enter', messages: [] }));
}

/** 生成一条真实理解事件；`reaction` 为 null 表示立即事件（无 reaction）。 */
function reactionAnalyzer({ reaction = '像是在等人' } = {}) {
  return async (options) => {
    const frameId = options?.frames?.[0]?.id;
    const at = options?.interval?.to;
    const from = Math.max(options?.interval?.from ?? at, at - 500);
    const event = {
      from,
      to: at,
      description: '推门',
      evidenceFrameIds: frameId === undefined ? [] : [frameId],
      evidenceAudioIds: [],
      uncertainty: '',
    };
    if (reaction !== null) event.reaction = reaction;
    return {
      ok: true,
      reason: 'ok',
      images: Array.isArray(options?.frames) ? options.frames.length : 0,
      text: JSON.stringify({
        sceneSummary: '测试场景：画面里有人推门',
        events: frameId === undefined ? [] : [event],
        unresolved: '',
      }),
    };
  };
}

test('fake event 路径：带 reaction 的成功理解 → proposed>0，passed 到语音关闭为止', async (t) => {
  const generated = [];
  const app = await fixture(t, {
    allowCapture: true,
    evidenceCaptureEnabled: true,
    understandingAnalyzer: reactionAnalyzer(),
    proactiveLineGenerator: async ({ event, detail }) => {
      generated.push({ event, detail });
      return { ok: true, text: '你回来了', reason: 'ok' };
    },
  });
  await installStoryboard(app.root);
  await enterCompanionTurn(app);

  await waitFor(async () => {
    const view = (await app.status()).vision.proactive;
    return view.passed >= 1 && view.counts.canceled >= 1;
  });
  const snapshot = await app.status();
  const understanding = snapshot.vision.understanding;
  const view = snapshot.vision.proactive;

  assert.equal(understanding.lastReasonCode, 'ok');
  assert.equal(understanding.lastEventCount, 1);
  assert.ok(view.counts.proposed >= 1, '带 reaction 的事件必须真正登记候选');
  assert.ok(view.eventsWithReaction >= 1, '状态能看到 reaction 供给');
  assert.equal(typeof view.lastAdvanceAt, 'number');
  assert.match(view.lastReactionEventId, /^ue-[0-9a-f]{16}$/u);
  assert.equal(view.lastProposeRejectReason, null);
  assert.ok(view.proposeCalls >= 1);
  assert.equal(view.advanceStage, 'proposed');
  assert.ok(view.drawn >= 1, '候选进入过抽签');
  assert.ok(view.passed >= 1, '候选通过过门禁');
  assert.equal(view.counts.spoken, 0, 'voice off 时 speakLine 返回 null，不应记账 spoken');

  // 两阶段 detail 回查实际发生，但只查本地索引，没有模型调用。
  assert.ok(view.detail.detailCalls >= 1);
  assert.equal(view.detail.modelCalls, 0);
  assert.equal(view.detail.detailRejected, 0);
  assert.ok(generated.length >= 1, '短句生成在门禁之后才被调用');
  assert.ok(generated[0].detail, '生成器拿到本地回查细节');
  assert.ok(generated[0].detail.frameIds.length >= 1);

  // 安全面：状态里没有候选正文/路径/帧 id。
  const serialized = JSON.stringify(view);
  assert.equal(serialized.includes('推门'), false);
  assert.equal(serialized.includes(app.root), false);
  assert.equal(serialized.includes('frame-'), false);
});

test('fake event 路径：成功但事件无 reaction → advanceStage=no-reaction，proposed=0', async (t) => {
  const app = await fixture(t, {
    allowCapture: true,
    evidenceCaptureEnabled: true,
    understandingAnalyzer: reactionAnalyzer({ reaction: null }),
    proactiveLineGenerator: async () => {
      assert.fail('无 reaction 时不得生成主动句');
    },
  });
  await installStoryboard(app.root, 'sheet-no-reaction.png');
  await enterCompanionTurn(app);

  await waitFor(async () => {
    const view = (await app.status()).vision.proactive;
    return view.advances >= 1 && view.lastAdvanceAt !== null;
  });
  const view = (await app.status()).vision.proactive;
  assert.equal(view.advanceStage, 'no-reaction');
  assert.equal(view.eventsWithReaction, 0);
  assert.equal(view.counts.proposed, 0);
  assert.equal(view.proposeCalls, 0);
  assert.equal(view.lastProposeRejectReason, null);
  assert.equal(view.lastReactionEventId, null);
  assert.equal(view.counts.rejected, 0, '没有 reaction 不算 propose 拒绝');
});

test('fake event 路径：成功但 0 事件 → advanceStage=no-events，与无 reaction 可区分', async (t) => {
  const app = await fixture(t, {
    allowCapture: true,
    evidenceCaptureEnabled: true,
    understandingAnalyzer: async () => ({
      ok: true,
      reason: 'ok',
      images: 1,
      text: JSON.stringify({ sceneSummary: '只有场景摘要', events: [], unresolved: '' }),
    }),
    proactiveLineGenerator: async () => {
      assert.fail('没有事件时不得生成主动句');
    },
  });
  await installStoryboard(app.root, 'sheet-no-events.png');
  await enterCompanionTurn(app);

  await waitFor(async () => {
    const view = (await app.status()).vision.proactive;
    return view.advances >= 1 && view.lastAdvanceAt !== null;
  });
  const view = (await app.status()).vision.proactive;
  assert.equal(view.advanceStage, 'no-events');
  assert.equal(view.eventsSeen, 0);
  assert.equal(view.eventsWithReaction, 0);
  assert.equal(view.counts.proposed, 0);
});

test('fake event 路径：importantMaxAgeMs=0 → propose 被 expired 拒绝，分类可读', async (t) => {
  const app = await fixture(t, {
    allowCapture: true,
    evidenceCaptureEnabled: true,
    proactive: { importantMaxAgeMs: 0 },
    understandingAnalyzer: reactionAnalyzer(),
    proactiveLineGenerator: async () => {
      assert.fail('expired 候选不得生成主动句');
    },
  });
  await installStoryboard(app.root, 'sheet-expired.png');
  await enterCompanionTurn(app);

  await waitFor(async () => (await app.status()).vision.proactive.counts.rejected >= 1);
  const view = (await app.status()).vision.proactive;
  assert.equal(view.counts.proposed, 0);
  assert.ok(view.counts.rejected >= 1);
  assert.ok(view.counts.expired >= 1);
  assert.equal(view.lastProposeRejectReason, 'expired');
  assert.ok(view.proposeCalls >= 1);
  assert.ok(view.eventsWithReaction >= 1);
  assert.equal(view.advanceStage, 'propose-rejected');
});
