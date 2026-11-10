/**
 * P-188 typed 陪伴归属：显式登记表 + 宿主注入门禁 + 设置页/status 投影。
 *
 * 目标：普通文字会话不再因为“没有 coding 标记”被反推为陪伴。只有
 * `settings.companion.typedSessions` 里的 session/agent id 才能接收画面理解/评论证据；
 * 子代理、编码、后台/压缩/摘要等用途即使被登记也不放行；`companion.typedEnabled=false`
 * 只关闭已登记会话的文字能力，不清空登记表。
 *
 * 覆盖：
 *  1. 已登记 typed → 注入；未登记普通 typed（无 purpose）→ 不注入；
 *  2. 已登记但 subagent/coding/background → 不注入；
 *  3. 开关 off → 已登记也不注入，登记列表保留；重新开启后恢复；
 *  4. 移除登记 → 不再注入；重复移除返回 removed:false；
 *  5. 语音行为不变：voice lane 仍只认当天陪伴会话；陪伴会话里的 typed 轮沿用同一正向身份；
 *  6. status 显示开关/登记列表/最近一次会话，设置页有显式登记/移除入口；
 *  7. 登记表本身：默认开关、去重、有界、非法值拒绝、畸形设置读取安全。
 *
 * 不碰屏幕、麦克风、ffmpeg、OBS 或真实模型：sight 用注册钩子替换，理解用注入 analyzer。
 *
 * Run: node --test test/typed-companion-ownership.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

import { disposeAll } from './helpers/cleanup.mjs';
import { COMMENT_EVIDENCE_DEFAULTS, createCommentEvidence } from '../src/host/vision/comment-evidence.js';
import {
  COMPANION_TYPED_SESSION_LIMIT,
  createCompanionSessionRegistry,
} from '../src/host/companion/session-registry.js';

const here = dirname(fileURLToPath(import.meta.url));
const state = {
  allowCapture: false,
  storyboardFactory: null,
};
globalThis.__typedCompanionOwnershipTest = state;

const sightUrl = new URL('../src/host/vision/sight.js', import.meta.url).href;
const hooks = registerHooks({
  load(url, context, next) {
    if (url === sightUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          const s = globalThis.__typedCompanionOwnershipTest;
          export const resolveFfmpeg = () => (s.allowCapture === true ? 'ffmpeg' : null);
          export const resolveFfplay = () => null;
          export const capture = async () => { throw new Error('real capture forbidden'); };
          export const captureDesktop = capture;
          export const captureDevice = capture;
          export const startStoryboard = (options) => {
            if (typeof s.storyboardFactory === 'function') return s.storyboardFactory(options);
            throw new Error('real storyboard forbidden');
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
const {
  apply,
  voiceSessionTarget,
  understandingBlockAllowed,
} = await import('../src/host/index.js');
hooks.deregister();

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, label, timeoutMs = 5_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > until) assert.fail(`condition not met before timeout: ${label}`);
    await delay(20);
  }
}

function voiceAlignment(at) {
  return {
    confidence: 'high',
    reason: 'window',
    window: { from: at - 8_000, to: at },
    cues: { retrospective: false, current: false },
    relatedFrameIds: ['ev-voice'],
    afterSpeechFrameIds: [],
    latestFrameId: 'ev-voice',
    timeSource: 'audio',
  };
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-typed-ownership-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  await mkdir(join(root, 'data'), { recursive: true });
  const visionEnabled = options.visionEnabled !== false;
  await writeFile(join(root, 'data', 'features.json'), `${JSON.stringify({
    hearing: false,
    ambient: false,
    voice: false,
    vision: visionEnabled,
    subtitle: false,
    avatar: false,
    memory: false,
    fastpath: false,
  })}\n`, 'utf8');
  const visionSettings = { continuousView: options.continuousView === true };
  if (options.privacy === true) visionSettings.mode = 'privacy';
  await writeFile(join(root, 'data', 'settings.json'), `${JSON.stringify({
    vision: visionSettings,
    companion: {
      typedEnabled: options.typedEnabled !== false,
      typedSessions: Array.isArray(options.typedSessions) ? options.typedSessions : [],
    },
  })}\n`, 'utf8');

  const tools = new Map();
  const routes = new Map();
  const promptSections = new Map();
  const promptContexts = new Map();
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
    async saveImage() { return { id: 'att-1', mediaType: 'image/png', name: 'x', bytes: 1 }; },
    async deleteImage() {},
  };
  const llm = {
    async resolveModelInfo(provider, model) {
      return { provider, id: model, name: model, inputModalities: ['text', 'image'] };
    },
  };
  const commentEvidence = createCommentEvidence({
    ttlMs: COMMENT_EVIDENCE_DEFAULTS.turnTtlMs,
  });
  apply({
    effect,
    on,
    get: (service) => (service === 'attachments'
      ? attachments
      : (service === 'llm' ? llm : undefined)),
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
  }, {
    root,
    enabled: true,
    defaultDomain: 'chat',
    privacyScene: 'Privacy',
    commentEvidence,
    understandingAnalyzer: typeof options.analyzer === 'function'
      ? options.analyzer
      : async () => ({ ok: false, text: '', reason: 'test', images: 0 }),
    understandingMinIntervalMs: 1,
    evidenceCaptureEnabled: true,
    evidenceCaptureTickMs: 25,
    evidenceCaptureBootDelayMs: 60_000,
  });

  state.allowCapture = options.allowCapture === true;
  state.storyboardFactory = null;

  t.after(async () => {
    state.storyboardFactory = null;
    await disposeAll(disposers.splice(0));
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
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

  const agentFor = (id, {
    purpose = '', background = false, origin = '', depth = 0, cwd = workspace,
  } = {}) => ({
    id,
    options: {
      ...(purpose.length > 0 ? { purpose } : {}),
      ...(background === true ? { background: true } : {}),
    },
    session: {
      id,
      header: {
        cwd,
        ...(origin.length > 0 ? { origin } : {}),
        ...(depth > 0 ? { delegationDepth: depth } : {}),
      },
    },
  });

  const preStep = async (agent, turn, text) => {
    const handler = listeners.get('agent/pre-step')?.[0];
    assert.ok(handler !== undefined, 'Host 注册了 agent/pre-step');
    await handler({
      agent,
      turn,
      step: 1,
      signal: new AbortController().signal,
      messages: [{
        id: `u-${agent.id}-${turn}`,
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text }],
      }],
    }, async () => ({ kind: 'enter', messages: [] }));
  };

  const eventsFile = join(root, 'data', 'events.jsonl');
  const readEvents = async () => {
    try {
      const text = await readFile(eventsFile, 'utf8');
      return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  const waitForEvent = async (type, predicate = () => true, label = type) => {
    for (let i = 0; i < 250; i += 1) {
      const hit = (await readEvents()).find(
        (event) => event.type === type && predicate(event.payload ?? {}),
      );
      if (hit !== undefined) return hit;
      await delay(10);
    }
    assert.fail(`timed out waiting for ${label}`);
  };

  return {
    root,
    workspace,
    commentEvidence,
    promptSections,
    promptContexts,
    listeners,
    agentFor,
    preStep,
    status,
    action,
    readEvents,
    waitForEvent,
  };
}

/** 装一份假故事板：第一帧立即返回，之后返回 null。 */
async function seedStoryboard(root) {
  const screenDir = join(root, 'cache', 'screens');
  await mkdir(screenDir, { recursive: true });
  await writeFile(join(screenDir, 'sheet.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]));
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
        file: join(screenDir, 'sheet.png'),
        capturedAt: Date.now(),
        width: 2,
        height: 2,
        frames: 2,
      };
    },
  });
  return screenDir;
}

const analyzer = async () => ({
  ok: true,
  text: JSON.stringify({
    sceneSummary: '测试场景：桌面上有一个打开的窗口',
    events: [],
    unresolved: '',
  }),
  reason: 'ok',
  images: 1,
});

/** 给某个 id 直接放一条 typed 记录，用来单独验证“渲染门禁”，而不是 pre-step 行为。 */
function attachTyped(commentEvidence, sessionId, turn) {
  const now = Date.now();
  commentEvidence.attach({
    sessionId,
    turnId: String(turn),
    sentAt: now,
    timeSource: 'typed-sent',
    startedAt: now,
    endedAt: now,
    alignment: {
      confidence: 'low',
      reason: 'no-window-evidence',
      window: { from: now - 8_000, to: now },
      cues: { retrospective: false, current: false },
      relatedFrameIds: [],
    },
    latestId: null,
    latestAt: null,
    frameCount: 0,
  });
}

// ---------------------------------------------------------------------------
// 1. 登记 → 注入；未登记 → 不注入
// ---------------------------------------------------------------------------

test('1. 已登记 typed 注入；未登记普通 typed（无 purpose）不注入', async (t) => {
  const app = await fixture(t, {
    continuousView: true,
    allowCapture: true,
    analyzer,
    typedSessions: ['registered-typed'],
  });
  await seedStoryboard(app.root);
  const audiovisual = app.promptContexts.get('assistant:audiovisual');
  const understanding = app.promptContexts.get('assistant:understanding');
  assert.ok(audiovisual !== undefined && understanding !== undefined);

  const registered = app.agentFor('registered-typed');
  await app.preStep(registered, 1, '这个表情好搞笑');
  const record = app.commentEvidence.take('registered-typed', { turnId: 1 });
  assert.ok(record !== null, '已登记 typed 轮应产生评论证据');
  assert.equal(record.timeSource, 'typed-sent');
  assert.equal(record.turnId, '1');
  assert.match(
    audiovisual.text({ agent: registered }),
    /【视听证据｜本轮文字发送】/u,
    '已登记 typed 注入评论证据',
  );
  await waitFor(
    () => understanding.text({ agent: registered }).includes('测试场景'),
    '已登记 typed 拿到 understanding 块',
  );

  // 未登记、没有 coding purpose 的普通会话：不能因为“没有排除标记”被反推为陪伴。
  const unregistered = app.agentFor('unregistered-typed');
  await app.preStep(unregistered, 2, '这个表情好搞笑');
  assert.equal(
    app.commentEvidence.take('unregistered-typed', { turnId: 2 }),
    null,
    '未登记 typed 不得产生评论证据',
  );
  assert.equal(audiovisual.text({ agent: unregistered }), '', '未登记 typed 不得注入评论证据');
  assert.equal(understanding.text({ agent: unregistered }), '', '未登记 typed 不得注入 understanding');
  const skipped = await app.waitForEvent(
    'vision.comment.skipped',
    (payload) => payload.reason === 'not-companion' && payload.turnId === 2,
    'unregistered typed skip',
  );
  assert.equal(skipped.payload.timeSource, 'typed-sent');
});

// ---------------------------------------------------------------------------
// 2. 已登记也不能绕过排除用途
// ---------------------------------------------------------------------------

test('2. 已登记但 subagent/coding/background 不注入', async (t) => {
  const app = await fixture(t, {
    typedSessions: [
      'sub-origin', 'sub-depth', 'bg-1', 'code-1', 'sum-1', 'agent-1', 'maintenance-1',
    ],
  });
  const audiovisual = app.promptContexts.get('assistant:audiovisual');
  const understanding = app.promptContexts.get('assistant:understanding');
  const blocked = [
    ['subagent origin', app.agentFor('sub-origin', { origin: 'subagent' }), 1],
    ['subagent depth', app.agentFor('sub-depth', { depth: 1 }), 2],
    ['background option', app.agentFor('bg-1', { background: true }), 3],
    ['coding purpose', app.agentFor('code-1', { purpose: 'coding' }), 4],
    ['summary purpose', app.agentFor('sum-1', { purpose: 'summary' }), 5],
    ['agent purpose', app.agentFor('agent-1', { purpose: 'agent:review' }), 6],
    ['maintenance purpose', app.agentFor('maintenance-1', { purpose: 'maintenance' }), 7],
  ];
  for (const [label, agent, turn] of blocked) {
    await app.preStep(agent, turn, '这个表情好搞笑');
    assert.equal(
      app.commentEvidence.take(agent.id, { turnId: turn }),
      null,
      `${label} 不得产生评论证据（登记不能绕过排除）`,
    );
    // 即使手工放进一条 typed 记录，渲染门禁也必须靠身份挡住它。
    attachTyped(app.commentEvidence, agent.id, turn);
    assert.equal(audiovisual.text({ agent }), '', `${label} 不得注入评论证据`);
    assert.equal(understanding.text({ agent }), '', `${label} 不得注入 understanding`);
  }

  // 排除轮报 not-companion，而不是 typed-disabled：登记不是问题，用途才是。
  const skipped = await app.waitForEvent(
    'vision.comment.skipped',
    (payload) => payload.reason === 'not-companion' && payload.turnId === 4,
    'registered coding typed skip',
  );
  assert.equal(skipped.payload.timeSource, 'typed-sent');
});

// ---------------------------------------------------------------------------
// 3. 开关只关能力，不取消登记
// ---------------------------------------------------------------------------

test('3. 开关 off → 已登记也不注入；登记列表保留，重新开启恢复', async (t) => {
  const app = await fixture(t, { typedSessions: ['registered-typed'] });
  const agent = app.agentFor('registered-typed');
  const audiovisual = app.promptContexts.get('assistant:audiovisual');

  await app.preStep(agent, 1, '这个表情好搞笑');
  assert.ok(app.commentEvidence.take('registered-typed', { turnId: 1 }) !== null);
  assert.match(audiovisual.text({ agent }), /【视听证据｜本轮文字发送】/u);

  const off = await app.action({ action: 'companion.typedEnabled.set', enabled: false });
  assert.equal(off.ok, true, off.error);
  assert.equal(off.typedEnabled, false);
  assert.deepEqual(off.typedSessions, ['registered-typed'], '关闭开关不取消登记');
  let status = await app.status();
  assert.equal(status.companion.typedEnabled, false, 'status 显示开关已关闭');
  assert.deepEqual(status.companion.typedSessions, ['registered-typed'], 'status 保留登记列表');

  await app.preStep(agent, 2, '这个表情好搞笑');
  assert.equal(
    app.commentEvidence.take('registered-typed', { turnId: 2 }),
    null,
    '开关关闭时已登记也不产生评论证据',
  );
  assert.equal(audiovisual.text({ agent }), '', '开关关闭时已登记也不注入');
  const skipped = await app.waitForEvent(
    'vision.comment.skipped',
    (payload) => payload.reason === 'typed-disabled' && payload.turnId === 2,
    'registered typed disabled skip',
  );
  assert.equal(skipped.payload.timeSource, 'typed-sent');

  assert.equal((await app.action({ action: 'companion.typedEnabled.set', enabled: 'false' })).ok, false,
    '非布尔开关被拒绝');
  const on = await app.action({ action: 'companion.typedEnabled.set', enabled: true });
  assert.equal(on.ok, true, on.error);
  assert.deepEqual(on.typedSessions, ['registered-typed']);
  status = await app.status();
  assert.equal(status.companion.typedEnabled, true);
  await app.preStep(agent, 3, '这个表情好搞笑');
  assert.ok(app.commentEvidence.take('registered-typed', { turnId: 3 }) !== null,
    '重新开启后恢复注入');
});

// ---------------------------------------------------------------------------
// 4. 移除登记
// ---------------------------------------------------------------------------

test('4. 移除登记 → 不再注入；重复移除返回 removed:false', async (t) => {
  const app = await fixture(t);
  const agent = app.agentFor('removable-typed');
  const audiovisual = app.promptContexts.get('assistant:audiovisual');

  const added = await app.action({ action: 'companion.typed.register', sessionId: 'removable-typed' });
  assert.equal(added.ok, true, added.error);
  assert.deepEqual(added.typedSessions, ['removable-typed']);
  await app.preStep(agent, 1, '这个表情好搞笑');
  assert.ok(app.commentEvidence.take('removable-typed', { turnId: 1 }) !== null,
    '登记后立即生效');

  const removed = await app.action({ action: 'companion.typed.remove', sessionId: 'removable-typed' });
  assert.equal(removed.ok, true, removed.error);
  assert.equal(removed.removed, true);
  assert.deepEqual(removed.typedSessions, []);
  assert.deepEqual((await app.status()).companion.typedSessions, []);

  await app.preStep(agent, 2, '这个表情好搞笑');
  assert.equal(
    app.commentEvidence.take('removable-typed', { turnId: 2 }),
    null,
    '移除登记后不再产生评论证据',
  );
  assert.equal(audiovisual.text({ agent }), '', '移除登记后不再注入');

  const again = await app.action({ action: 'companion.typed.remove', sessionId: 'removable-typed' });
  assert.equal(again.ok, true);
  assert.equal(again.removed, false, '重复移除不伪装成删除');
});

// ---------------------------------------------------------------------------
// 5. 语音行为不变
// ---------------------------------------------------------------------------

test('5. 语音行为不变：voice lane 仍只认当天陪伴会话', async (t) => {
  const app = await fixture(t);
  const companionId = voiceSessionTarget({ root: app.root }).sessionId;
  const companion = app.agentFor(companionId);
  const gui = app.agentFor('plain-typed');
  const now = Date.now();
  app.commentEvidence.attach({
    sessionId: companionId,
    utteranceId: 'u-voice',
    sentAt: now - 3_000,
    timeSource: 'audio',
    startedAt: now - 3_000,
    endedAt: now,
    alignment: voiceAlignment(now),
    latestId: 'ev-voice',
    latestAt: now - 1_000,
    frameCount: 1,
  });
  app.commentEvidence.attach({
    sessionId: 'plain-typed',
    utteranceId: 'u-gui-voice',
    sentAt: now - 3_000,
    timeSource: 'audio',
    startedAt: now - 3_000,
    endedAt: now,
    alignment: voiceAlignment(now),
    latestId: 'ev-voice',
    latestAt: now - 1_000,
    frameCount: 1,
  });

  const audiovisual = app.promptContexts.get('assistant:audiovisual');
  const companionText = audiovisual.text({ agent: companion });
  assert.match(companionText, /【视听证据｜本轮评论对齐】/u, companionText);
  assert.match(companionText, /用户开口/u, companionText);
  assert.equal(audiovisual.text({ agent: gui }), '',
    '未登记的普通 typed 身份不能用语音记录');

  assert.equal(understandingBlockAllowed({
    lane: 'voice', inScope: true, companion: true, typedCompanion: false,
    subagent: false, visionEnabled: true, privacy: false, hasState: true,
  }), true);
  assert.equal(understandingBlockAllowed({
    lane: 'typed', inScope: true, companion: false, typedCompanion: false,
    subagent: false, visionEnabled: true, privacy: false, hasState: true,
  }), false, 'typed 不再靠“没有 coding 标记”放行');
  assert.equal(understandingBlockAllowed({
    lane: 'typed', inScope: true, companion: true, typedCompanion: false,
    subagent: false, visionEnabled: true, privacy: false, hasState: true,
  }), false, 'typed lane 不借用 voice companion');
  assert.equal(understandingBlockAllowed({
    lane: 'voice', inScope: true, companion: false, typedCompanion: true,
    subagent: false, visionEnabled: true, privacy: false, hasState: true,
  }), false, 'voice lane 不借用 typed companion');

  // 当天语音陪伴会话里的文字轮仍是同一陪伴身份（正向身份，不是“没有 coding 标记”反推），
  // 继续绑定本轮 sentAt；这条路径不需要额外登记。
  await app.preStep(companion, 7, '这个表情好搞笑');
  const typedInCompanion = app.commentEvidence.take(companionId, { turnId: 7 });
  assert.ok(typedInCompanion !== null, '陪伴会话里的 typed 轮仍产生本轮证据');
  assert.equal(typedInCompanion.timeSource, 'typed-sent');
  assert.match(audiovisual.text({ agent: companion }), /【视听证据｜本轮文字发送】/u);
});

// ---------------------------------------------------------------------------
// 6. status + 设置页入口
// ---------------------------------------------------------------------------

test('6. status 显示登记列表与开关；设置页有显式登记/移除/最近一次入口', async (t) => {
  const app = await fixture(t, { typedEnabled: false, typedSessions: ['status-registered'] });
  let status = await app.status();
  assert.equal(status.companion.typedEnabled, false);
  assert.deepEqual(status.companion.typedSessions, ['status-registered']);
  assert.equal(status.companion.registered, 1);
  assert.equal(status.companion.limit, COMPANION_TYPED_SESSION_LIMIT);
  assert.equal(status.companion.lastSessionId, '', '没有 pre-step 时没有“最近一次”提示');

  const added = await app.action({ action: 'companion.typed.register', sessionId: 'second-typed' });
  assert.equal(added.ok, true, added.error);
  status = await app.status();
  assert.deepEqual(status.companion.typedSessions, ['second-typed', 'status-registered'],
    '最近登记的在最前');
  const invalid = await app.action({ action: 'companion.typed.register', sessionId: '   ' });
  assert.equal(invalid.ok, false, '空 ID 被动作入口拒绝');
  assert.deepEqual((await app.status()).companion.typedSessions,
    ['second-typed', 'status-registered'], '非法登记不改列表');

  // pre-step 只更新“最近一次”提示，绝不自动登记。
  const agent = app.agentFor('recent-typed');
  await app.preStep(agent, 1, '这个表情好搞笑');
  status = await app.status();
  assert.equal(status.companion.lastSessionId, 'recent-typed');
  assert.equal(status.companion.typedSessions.includes('recent-typed'), false,
    'pre-step 不会静默登记普通会话');

  const clientSource = await readFile(join(here, '..', 'client.js'), 'utf8');
  assert.ok(clientSource.includes("settingsGroup(h, 'typed-companion', '文字陪伴归属'"),
    '设置页有文字陪伴归属子容器');
  assert.ok(clientSource.includes("'data-settings-toggle': 'companion-typed-enabled'"),
    '设置页有文字能力开关');
  assert.ok(clientSource.includes("'data-settings-list': 'companion-typed-sessions'"),
    '设置页显示登记列表');
  assert.ok(clientSource.includes("'data-settings-input': 'companion-typed-session-id'"),
    '设置页有手动登记输入');
  assert.ok(clientSource.includes("'data-companion-action': 'register-last'"),
    '设置页可显式登记最近一次会话');
  for (const action of [
    'companion.typed.register', 'companion.typed.remove', 'companion.typedEnabled.set',
  ]) {
    assert.ok(clientSource.includes(`action: '${action}'`), `设置页走 ${action}`);
  }
});

// ---------------------------------------------------------------------------
// 7. 登记表本身：默认值、去重、有界、非法值
// ---------------------------------------------------------------------------

test('7. 登记表：默认开关 true、去重、有界、非法值拒绝、畸形设置安全读取', () => {
  let settings = { extra: 1, companion: { note: 'keep' } };
  const writes = [];
  const registry = createCompanionSessionRegistry({
    readSettings: () => settings,
    writeSettings: (patch) => { writes.push(patch); settings = { ...settings, ...patch }; },
  });
  assert.equal(registry.typedEnabled(), true, '缺失 typedEnabled 默认开启');
  assert.deepEqual(registry.typedSessions(), []);
  assert.deepEqual(registry.status(), {
    typedEnabled: true, typedSessions: [], registered: 0, limit: COMPANION_TYPED_SESSION_LIMIT,
  });

  const first = registry.register('  session-a  ');
  assert.equal(first.ok, true);
  assert.deepEqual(first.typedSessions, ['session-a'], 'id 去首尾空白后保存');
  assert.equal(registry.isRegistered('session-a'), true);
  assert.equal(registry.isRegistered('session-b'), false);
  assert.equal(settings.extra, 1, '写回不丢其它顶层设置');
  assert.equal(settings.companion.note, 'keep', '写回保留 companion 下的其它字段');

  registry.register('session-b');
  registry.register('session-a');
  assert.deepEqual(registry.typedSessions(), ['session-a', 'session-b'],
    '重复登记移到最前且不产生重复项');

  for (const bad of ['', '   ', null, 42, 'a'.repeat(300), `bad\u0000id`]) {
    const result = registry.register(bad);
    assert.equal(result.ok, false, `非法 id 被拒绝：${String(bad).slice(0, 12)}`);
  }
  assert.deepEqual(registry.typedSessions(), ['session-a', 'session-b'], '非法写入不改登记表');

  for (let index = 0; index <= COMPANION_TYPED_SESSION_LIMIT + 4; index += 1) {
    registry.register(`bulk-${index}`);
  }
  const bounded = registry.typedSessions();
  assert.equal(bounded.length, COMPANION_TYPED_SESSION_LIMIT, '登记表有界');
  assert.equal(bounded[0], `bulk-${COMPANION_TYPED_SESSION_LIMIT + 4}`, '最新的在最前');
  assert.equal(bounded.includes('session-a'), false, '超出上限时丢弃最旧的');

  const off = registry.setEnabled(false);
  assert.equal(off.ok, true);
  assert.equal(off.typedEnabled, false);
  assert.equal(registry.typedSessions().length, COMPANION_TYPED_SESSION_LIMIT, '关闭不取消登记');
  assert.equal(registry.setEnabled('false').ok, false, '非布尔开关被拒绝');
  assert.equal(registry.typedEnabled(), false);

  // 畸形设置：只接受合法字符串；重复/空串/超长/控制字符在读取时被丢弃；
  // typedEnabled 只有显式布尔 false 才关闭。
  settings = {
    companion: {
      typedEnabled: 'false',
      typedSessions: ['ok', 'ok', '', '   ', 42, 'a'.repeat(300), 'bad\u0007id', 'second'],
    },
  };
  const next = createCompanionSessionRegistry({
    readSettings: () => settings,
    writeSettings: () => {},
  });
  assert.equal(next.typedEnabled(), true, '非布尔值按默认 true');
  assert.deepEqual(next.typedSessions(), ['ok', 'second'], '畸形条目被丢弃且去重');
  assert.ok(writes.length > 0, '每次写操作都走宿主 writeSettings');
  assert.equal(writes.at(-1).companion.note, 'keep', '连续写回仍保留 companion 的其它字段');
});
