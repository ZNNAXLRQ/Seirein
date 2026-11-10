/**
 * 用户决定：普通 GUI 打字会话也算 companion，可接收画面理解/评论证据；但仍排除子代理、
 * Coding/后台/压缩/摘要等非陪伴用途。语音 lane 仍只认当天陪伴会话（`isCompanionAgent`），
 * 这次放宽只作用于 typed lane 的 `isTypedCompanionAgent`，不是全局 companion 语义。
 *
 * 覆盖：
 *  1. 普通主 GUI typed agent → 评论证据 + understanding 块注入；
 *  2. typed 子代理/background/coding/summary/agent 用途 → 不注入（即使理解状态已存在）；
 *  3. voice lane 行为不变：只认当天陪伴会话，非陪伴 agent 借不到 voice 证据；
 *  4. typed 非 vision / privacy / 跨 workspace → 不注入；
 *  5. `understandingBlockAllowed` 的 lane 身份分离与 ephemeral 块。
 *
 * 不碰屏幕、麦克风、ffmpeg、OBS 或真实模型：sight 用注册钩子替换，理解用注入 analyzer。
 *
 * Run: node --test test/vision-typed-companion.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { disposeAll } from './helpers/cleanup.mjs';
import {
  COMMENT_EVIDENCE_DEFAULTS,
  createCommentEvidence,
} from '../src/host/vision/comment-evidence.js';

const state = {
  allowCapture: false,
  storyboardFactory: null,
};
globalThis.__visionTypedCompanionTest = state;

const sightUrl = new URL('../src/host/vision/sight.js', import.meta.url).href;
const hooks = registerHooks({
  load(url, context, next) {
    if (url === sightUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          const s = globalThis.__visionTypedCompanionTest;
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
  understandingEphemeralBlock,
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
  const root = await mkdtemp(join(tmpdir(), 'dsh-typed-companion-'));
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
  const control = { lane: null };
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
    // 只用于测试“voice lane 不因 typed 放宽而放行”；生产 lane 仍由会话 id 推导。
    contextLaneOverride: (context) => {
      void context;
      return control.lane === 'voice' || control.lane === 'typed' ? control.lane : undefined;
    },
  });

  state.allowCapture = options.allowCapture === true;
  state.storyboardFactory = null;

  t.after(async () => {
    state.storyboardFactory = null;
    await disposeAll(disposers.splice(0));
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

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
    control,
    commentEvidence,
    promptSections,
    promptContexts,
    listeners,
    agentFor,
    preStep,
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

// ---------------------------------------------------------------------------
// 1. 普通 GUI typed 主会话
// ---------------------------------------------------------------------------

test('1. 普通 GUI typed 主会话：评论证据与画面理解块都注入', async (t) => {
  const app = await fixture(t, {
    continuousView: true,
    allowCapture: true,
    analyzer,
  });
  await seedStoryboard(app.root);

  const agent = app.agentFor('gui-main-typed');
  await app.preStep(agent, 1, '这个表情好搞笑');

  const record = app.commentEvidence.take('gui-main-typed', { turnId: 1 });
  assert.ok(record !== null, '普通 GUI typed 轮应产生按 turn 绑定的评论证据');
  assert.equal(record.turnId, '1');
  assert.equal(record.timeSource, 'typed-sent');
  assert.equal(record.startedAt, record.sentAt, 'typed 无音频：startedAt 就是发送时刻');
  assert.equal(record.endedAt, record.sentAt, 'typed 无音频：没有语音端点');

  const audiovisual = app.promptContexts.get('assistant:audiovisual');
  const understanding = app.promptContexts.get('assistant:understanding');
  assert.ok(audiovisual !== undefined);
  assert.ok(understanding !== undefined);
  const avText = audiovisual.text({ agent });
  assert.match(avText, /【视听证据｜本轮文字发送】/u, avText);
  assert.match(avText, /typed-sent/u, avText);
  assert.equal(avText.includes('用户开口'), false, 'typed 块不能出现语音开口');
  assert.equal(avText.includes('语音结束'), false);
  assert.equal(avText.includes('识别完成'), false);

  // 首轮正常 GUI typed 也置位 companionSessionSeen，持续采集可产出理解状态。
  await waitFor(
    () => understanding.text({ agent }).includes('测试场景'),
    '普通 GUI typed 轮拿到 understanding 块',
  );
  const understandingText = understanding.text({ agent });
  assert.match(understandingText, /测试场景/u);
  assert.equal(JSON.stringify(understandingText).includes('cache'), false, '块不泄露证据路径');
});

// ---------------------------------------------------------------------------
// 2. 排除用途
// ---------------------------------------------------------------------------

test('2. typed 子代理/background/coding/summary/agent 用途不注入，即使理解状态已存在', async (t) => {
  const app = await fixture(t, {
    continuousView: true,
    allowCapture: true,
    analyzer,
  });
  await seedStoryboard(app.root);

  const main = app.agentFor('gui-main-typed-2');
  await app.preStep(main, 1, '这个表情好搞笑');
  const audiovisual = app.promptContexts.get('assistant:audiovisual');
  const understanding = app.promptContexts.get('assistant:understanding');
  await waitFor(
    () => understanding.text({ agent: main }).includes('测试场景'),
    '先建立一份可注入的理解状态',
  );

  const blocked = [
    ['subagent origin', app.agentFor('sub-origin', { origin: 'subagent' }), 2],
    ['subagent depth', app.agentFor('sub-depth', { depth: 1 }), 3],
    ['background option', app.agentFor('bg-1', { background: true }), 4],
    ['coding purpose', app.agentFor('code-1', { purpose: 'coding' }), 5],
    ['summary purpose', app.agentFor('sum-1', { purpose: 'summary' }), 6],
    ['agent purpose', app.agentFor('agent-1', { purpose: 'agent:review' }), 7],
  ];
  for (const [label, agent, turn] of blocked) {
    await app.preStep(agent, turn, '这个表情好搞笑');
    assert.equal(
      app.commentEvidence.take(agent.id, { turnId: turn }),
      null,
      `${label} 不得产生评论证据`,
    );
    assert.equal(audiovisual.text({ agent }), '', `${label} 不得注入评论证据`);
    assert.equal(understanding.text({ agent }), '', `${label} 不得注入理解状态`);
  }

  // 编码/后台轮只留下真实原因，不伪造评论证据。
  const skipped = await app.waitForEvent(
    'vision.comment.skipped',
    (payload) => payload.reason === 'not-companion' && payload.turnId === 5,
    'coding typed skip',
  );
  assert.equal(skipped.payload.timeSource, 'typed-sent');
});

// ---------------------------------------------------------------------------
// 3. voice lane 不变
// ---------------------------------------------------------------------------

test('3. voice lane 行为不变：仍只认当天陪伴会话，不借 typed 的放宽', async (t) => {
  const app = await fixture(t);
  const companionId = voiceSessionTarget({ root: app.root }).sessionId;
  const companion = app.agentFor(companionId);
  const gui = app.agentFor('gui-main-voice');
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
  // 给普通 GUI 会话也放一条 voice 记录：voice lane 门禁必须靠身份挡住它，而不是靠“没记录”。
  app.commentEvidence.attach({
    sessionId: 'gui-main-voice',
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

  // 强制 voice lane：普通 GUI agent 不是当天陪伴会话，仍读不到。
  app.control.lane = 'voice';
  assert.equal(audiovisual.text({ agent: gui }), '', 'voice lane 不接受普通 typed 身份');
  app.control.lane = null;

  // 纯门禁：voice 只认 companion，typed 只认 typedCompanion。
  assert.equal(understandingBlockAllowed({
    lane: 'voice',
    inScope: true,
    companion: true,
    typedCompanion: false,
    subagent: false,
    visionEnabled: true,
    privacy: false,
    hasState: true,
  }), true);
  assert.equal(understandingBlockAllowed({
    lane: 'voice',
    inScope: true,
    companion: false,
    typedCompanion: true,
    subagent: false,
    visionEnabled: true,
    privacy: false,
    hasState: true,
  }), false, 'voice lane 不借用 typed companion');
  assert.equal(understandingBlockAllowed({
    lane: 'typed',
    inScope: true,
    companion: true,
    typedCompanion: false,
    subagent: false,
    visionEnabled: true,
    privacy: false,
    hasState: true,
  }), false, 'typed lane 不借用 voice companion');
});

// ---------------------------------------------------------------------------
// 4. 非 vision / privacy / 跨 workspace
// ---------------------------------------------------------------------------

test('4. typed 非 vision / privacy / 跨 workspace 不注入', async (t) => {
  // 视觉组件关闭。
  const off = await fixture(t, { visionEnabled: false });
  const offAgent = off.agentFor('gui-off');
  await off.preStep(offAgent, 1, '这个表情好搞笑');
  assert.equal(off.commentEvidence.take('gui-off', { turnId: 1 }), null);
  assert.equal(off.promptContexts.get('assistant:audiovisual').text({ agent: offAgent }), '');
  assert.equal(off.promptContexts.get('assistant:understanding').text({ agent: offAgent }), '');

  // 隐私锁：pre-step 不登记，渲染也不注入。
  const privacy = await fixture(t, { privacy: true });
  const privacyAgent = privacy.agentFor('gui-privacy');
  await privacy.preStep(privacyAgent, 1, '这个表情好搞笑');
  assert.equal(privacy.commentEvidence.take('gui-privacy', { turnId: 1 }), null);
  assert.equal(privacy.promptContexts.get('assistant:audiovisual').text({ agent: privacyAgent }), '');
  assert.equal(privacy.promptContexts.get('assistant:understanding').text({ agent: privacyAgent }), '');

  // 跨 workspace：agent 的 cwd 不在作用域内。
  const cross = await fixture(t);
  const outside = join(cross.root, 'elsewhere');
  await mkdir(outside, { recursive: true });
  const crossAgent = cross.agentFor('gui-cross', { cwd: outside });
  await cross.preStep(crossAgent, 1, '这个表情好搞笑');
  assert.equal(cross.commentEvidence.take('gui-cross', { turnId: 1 }), null);
  assert.equal(cross.promptContexts.get('assistant:audiovisual').text({ agent: crossAgent }), '');
  assert.equal(cross.promptContexts.get('assistant:understanding').text({ agent: crossAgent }), '');
});

// ---------------------------------------------------------------------------
// 5. 纯门禁 + ephemeral block
// ---------------------------------------------------------------------------

test('5. understandingBlockAllowed：typed 身份、其他门禁与 ephemeral block', () => {
  const eligible = {
    inScope: true,
    companion: false,
    typedCompanion: true,
    subagent: false,
    visionEnabled: true,
    privacy: false,
    hasState: true,
  };
  assert.equal(understandingBlockAllowed({ ...eligible, lane: 'typed' }), true);
  assert.equal(understandingBlockAllowed({ ...eligible, lane: null }), true,
    '不按 lane 限定的渲染路径接受 typed companion');
  assert.equal(understandingBlockAllowed({ ...eligible, lane: 'voice' }), false);
  assert.equal(understandingBlockAllowed({ ...eligible, lane: 'fastpath' }), false);
  assert.equal(understandingBlockAllowed({ ...eligible, lane: 'unknown' }), false);

  const denied = [
    ['outside workspace', { inScope: false }],
    ['no typed companion', { typedCompanion: false }],
    ['subagent', { subagent: true }],
    ['vision off', { visionEnabled: false }],
    ['privacy', { privacy: true }],
    ['no state', { hasState: false }],
  ];
  for (const [label, override] of denied) {
    assert.equal(
      understandingBlockAllowed({ ...eligible, lane: 'typed', ...override }),
      false,
      label,
    );
  }

  const block = understandingEphemeralBlock('【场景】桌面上有一个打开的窗口', {
    ...eligible, lane: 'typed',
  });
  assert.deepEqual(block, {
    name: 'understanding',
    text: '【场景】桌面上有一个打开的窗口',
    separator: '\n',
    keep: 'head',
  });
  assert.equal(understandingEphemeralBlock('', { ...eligible, lane: 'typed' }), null);
});
