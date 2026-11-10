/**
 * P1：typed 发送时间 + 评论证据按 turn 绑定。
 *
 * 覆盖：
 *   1. typed 用自己的 sentAt 建窗（sentAt-8s..sentAt+2s），不读上一条麦克风终稿；
 *   2. 评论证据按 turn/utterance/sentAt 绑定，typed 轮不会套上一条语音记录；
 *   3. 切镜后，当前窗口内上一镜头的事件仍按 shotId 命中；
 *   4. 无关闲聊不 attach，并留下机器可读的 skipped 原因；
 *   5. TTL/有界：30s 过期、每会话最多 N 条按轮记录；
 *   6. 语音轮保持 audioStartAt/audioEndAt 窗口语义；
 *   7. typed companion 门限制如实：普通 GUI typed 放行；编码用途（purpose:coding）等
 *      非陪伴 typed 只记 `vision.comment.skipped`，不注入。
 *
 * 纯模块用假时钟；Host 用注入的 commentEvidence/understandingAnalyzer + stub sight，
 * 不碰屏幕、麦克风、ffmpeg、OBS 或真实模型。
 *
 * Run: node --test test/vision-typed-comment-p1.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { disposeAll } from './helpers/cleanup.mjs';
import {
  ALIGNMENT_DEFAULTS,
  TYPED_TURN_DEFAULTS,
  alignComment,
  alignTypedTurn,
  typedTurnWindow,
} from '../src/host/vision/comment-alignment.js';
import {
  COMMENT_EVIDENCE_DEFAULTS,
  createCommentEvidence,
} from '../src/host/vision/comment-evidence.js';
import { createUnderstandingRuntime } from '../src/host/vision/understanding-runtime.js';

const BASE = 1_700_000_000_000;

function frame(id, capturedAt, shotId = null, over = {}) {
  return {
    id,
    capturedAt,
    startedAt: capturedAt,
    endedAt: capturedAt,
    shotId,
    file: `C:\\shots\\${id}.png`,
    source: 'desktop',
    sourceEpoch: 1,
    ...over,
  };
}

function typedAlignment(over = {}) {
  return {
    confidence: 'high',
    reason: 'window',
    window: { from: BASE - 8_000, to: BASE + 2_000 },
    cues: { retrospective: false, current: false },
    relatedFrameIds: ['ev-1'],
    afterSpeechFrameIds: [],
    latestFrameId: 'ev-2',
    timeSource: 'typed-sent',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 1. typed sentAt window / not the previous microphone
// ---------------------------------------------------------------------------

test('1. typed 用 sentAt 窗口选帧：不落在窗口里的上一条麦克风画面不会被选中', () => {
  const evidence = [
    frame('mic-old', BASE - 20_000),
    frame('pre-send', BASE - 2_000),
    frame('after-send', BASE + 1_000),
  ];
  const out = alignTypedTurn({
    text: '这个表情好搞笑',
    sentAt: BASE,
    evidence,
    now: () => BASE + 5_000,
  });

  assert.equal(out.ok, true);
  assert.equal(out.timeSource, 'typed-sent');
  assert.equal(out.sentAt, BASE);
  assert.deepEqual(out.window, { from: BASE - 8_000, to: BASE + 2_000 });
  assert.deepEqual(out.sentAtWindow, {
    from: BASE - 8_000, to: BASE + 2_000, sentAt: BASE, timeSource: 'typed-sent',
  });
  assert.deepEqual(out.relatedFrameIds, ['pre-send'], '发送前、窗口内的帧才是评论依据');
  assert.deepEqual(out.afterSpeechFrameIds, ['after-send'], '发送后的帧只能当“现在”');
  assert.equal(out.relatedFrameIds.includes('mic-old'), false, '上一条麦克风画面在窗口外，不能借用');
  assert.equal(out.latestFrameId, 'after-send');
  assert.equal(out.confidence, 'high');
  assert.equal(out.reason, 'window');

  // 文本线索仍参与窗口/候选选择：typed 的“刚才”同样扩到 16 秒，而不是固定 8 秒。
  const retro = alignTypedTurn({
    text: '刚才那个转身',
    sentAt: BASE,
    evidence: [frame('early', BASE - 12_000)],
    now: () => BASE + 1_000,
  });
  assert.equal(retro.reason, 'retrospective');
  assert.deepEqual(retro.window, { from: BASE - 16_000, to: BASE + 2_000 });
  assert.deepEqual(retro.relatedFrameIds, ['early'], '回溯词参与候选选择');

  // 没有发送时刻（例如旧调用）不猜：no-sent，而不是拿音频时间兜底。
  const missing = alignTypedTurn({ text: '这个', sentAt: null, evidence });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'no-sent');
  assert.deepEqual(missing.window, { from: null, to: null });
  assert.equal(typedTurnWindow({ sentAt: null }), null);
});

test('1b. understanding 按 typed 窗口选事件：麦克风窗口的旧事件不进入本轮块', async () => {
  const clock = { now: BASE + 30_000 };
  let run = 0;
  const runtime = createUnderstandingRuntime({
    now: () => clock.now,
    framesBetween: (from) => (from < BASE - 10_000
      ? [frame('mic-frame', BASE - 19_000, 'shot-old')]
      : [frame('a-frame', BASE - 2_000, 'shot-a'), frame('b-frame', BASE + 1_000, 'shot-b')]),
    audioBetween: () => [],
    maxFrames: 8,
    maxEventsShown: 3,
    analyze: async () => {
      run += 1;
      if (run === 1) {
        return JSON.stringify({
          sceneSummary: '麦克风窗口：旧镜头',
          events: [{
            from: BASE - 19_000,
            to: BASE - 18_500,
            description: '麦克风旧事件',
            evidenceFrameIds: ['mic-frame'],
            evidenceAudioIds: [],
            uncertainty: '',
          }],
          unresolved: '',
        });
      }
      return JSON.stringify({
        sceneSummary: 'typed 窗口：A/B 两个镜头',
        events: [
          {
            from: BASE - 2_000,
            to: BASE - 1_000,
            description: 'A镜头事件',
            evidenceFrameIds: ['a-frame'],
            evidenceAudioIds: [],
            uncertainty: '',
          },
          {
            from: BASE + 1_000,
            to: BASE + 1_500,
            description: 'B镜头事件',
            evidenceFrameIds: ['b-frame'],
            evidenceAudioIds: [],
            uncertainty: '',
          },
        ],
        unresolved: '',
      });
    },
  });

  await runtime.runNow({ from: BASE - 20_000, to: BASE - 18_000, reason: 'mic-legacy' });
  await runtime.runNow({ from: BASE - 8_000, to: BASE + 2_000, reason: 'typed' });
  assert.equal(runtime.current().events.length, 3);

  const typedText = runtime.render({ from: BASE - 8_000, to: BASE + 2_000 });
  assert.ok(typedText.includes('A镜头事件'), typedText);
  assert.ok(typedText.includes('B镜头事件'), typedText);
  assert.equal(typedText.includes('麦克风旧事件'), false, 'typed 窗口不包含麦克风窗口的旧事件');

  // 切镜后：窗口仍覆盖上一镜头时，按 shotId 显式取上一镜头事件，当前镜头事件不冒充它。
  const previousShot = runtime.render({
    from: BASE - 8_000,
    to: BASE + 2_000,
    shotId: 'shot-a',
    retrospective: true,
  });
  assert.ok(previousShot.includes('A镜头事件'), previousShot);
  assert.equal(previousShot.includes('B镜头事件'), false, previousShot);
  assert.equal(previousShot.includes('麦克风旧事件'), false, previousShot);
});

// ---------------------------------------------------------------------------
// 2. comment evidence turn binding
// ---------------------------------------------------------------------------

test('2. 评论证据按 turn 绑定：typed 轮查不到就用空，不套上一条语音记录', () => {
  let clock = BASE + 1_000;
  const evidence = createCommentEvidence({ now: () => clock, ttlMs: 60_000 });

  // 语音轮记录：finishSpeechEvidence 时还没有 turn，pre-step 再补绑。
  evidence.attach({
    sessionId: 'companion',
    utteranceId: 'u-voice',
    sentAt: BASE - 3_000,
    timeSource: 'audio',
    startedAt: BASE - 3_000,
    endedAt: BASE,
    alignment: {
      confidence: 'high',
      reason: 'window',
      window: { from: BASE - 8_000, to: BASE },
      cues: { retrospective: false, current: false },
      relatedFrameIds: ['ev-voice'],
      afterSpeechFrameIds: [],
      latestFrameId: 'ev-voice',
      timeSource: 'audio',
    },
    latestId: 'ev-voice',
    latestAt: BASE - 1_000,
    frameCount: 1,
  });

  assert.equal(evidence.take('companion', { turnId: 'turn-voice' }), null,
    '未绑定的语音记录不能靠“最近一条”命中 turn');
  const bound = evidence.bindTurn('companion', 'turn-voice');
  assert.equal(bound.turnId, 'turn-voice');
  const voiceText = evidence.render('companion', { turnId: 'turn-voice' });
  assert.ok(voiceText.includes('【视听证据｜本轮评论对齐】'), voiceText);
  assert.ok(voiceText.includes('用户开口'), voiceText);

  // typed 轮还没有自己的记录：查询必须是空，而不是回退到上一条语音记录。
  assert.equal(evidence.render('companion', { turnId: 'turn-typed' }), '');
  assert.equal(evidence.take('companion', { turnId: 'turn-typed' }), null);

  evidence.attach({
    sessionId: 'companion',
    turnId: 'turn-typed',
    sentAt: BASE + 10_000,
    timeSource: 'typed-sent',
    startedAt: BASE + 10_000,
    endedAt: BASE + 10_000,
    alignment: typedAlignment({
      window: { from: BASE + 2_000, to: BASE + 12_000 },
      relatedFrameIds: ['ev-typed'],
      latestFrameId: 'ev-typed',
    }),
    latestId: 'ev-typed',
    latestAt: BASE + 11_000,
    frameCount: 2,
  });

  const typedText = evidence.render('companion', { turnId: 'turn-typed' });
  assert.ok(typedText.includes('【视听证据｜本轮文字发送】'), typedText);
  assert.ok(typedText.includes('typed-sent'), typedText);
  assert.ok(typedText.includes('本轮无音频'), typedText);
  assert.equal(typedText.includes('用户开口'), false, 'typed 块不能出现语音开口');
  assert.equal(typedText.includes('语音结束'), false, 'typed 块不能出现语音端点');
  assert.equal(typedText.includes('识别完成'), false);

  // 两个 turn 各自可读；无查询的旧接口仍返回最近一条。
  assert.ok(evidence.render('companion', { turnId: 'turn-voice' }).includes('用户开口'));
  assert.equal(evidence.take('companion').turnId, 'turn-typed');
  // 旧式绑定字段也可查询：utteranceId / sentAt 指向同一条记录。
  assert.equal(evidence.take('companion', { utteranceId: 'u-voice' }).turnId, 'turn-voice');
  assert.equal(evidence.take('companion', { sentAt: BASE + 10_000 }).turnId, 'turn-typed');
});

// ---------------------------------------------------------------------------
// 4. unrelated chatter
// ---------------------------------------------------------------------------

test('4. 无关闲聊不产生画面指代（Host 侧进一步不 attach）', () => {
  assert.equal(alignTypedTurn({ text: '今天吃什么', sentAt: BASE }).timeSource, 'typed-sent');
  // 纯对齐函数不判断语义；相关性门在 Host。这里固定“无关”文本的规则结果，
  // Host 测试（第 7 节）断言它不 attach 且记录 skipped。
});

// ---------------------------------------------------------------------------
// 5. TTL / bounded
// ---------------------------------------------------------------------------

test('5. TTL 30s + 每会话按轮记录有界；过期/最旧记录不再可查', () => {
  assert.equal(COMMENT_EVIDENCE_DEFAULTS.turnTtlMs, 30_000);

  let clock = BASE;
  const bounded = createCommentEvidence({ now: () => clock, ttlMs: 60_000 });
  for (let turn = 1; turn <= 6; turn += 1) {
    bounded.attach({
      sessionId: 'bounded',
      turnId: String(turn),
      sentAt: BASE,
      timeSource: 'typed-sent',
      startedAt: BASE,
      endedAt: BASE,
      alignment: typedAlignment(),
    });
  }
  assert.equal(bounded.take('bounded', { turnId: '1' }), null, '超过每会话上限的最旧记录被淘汰');
  assert.equal(bounded.take('bounded', { turnId: '2' }), null);
  for (let turn = 3; turn <= 6; turn += 1) {
    assert.ok(bounded.take('bounded', { turnId: String(turn) }) !== null, `turn ${turn} 仍保留`);
  }
  assert.equal(bounded.state().evicted, 2, '淘汰计数可观测');

  clock = BASE;
  const ttl = createCommentEvidence({ now: () => clock, ttlMs: COMMENT_EVIDENCE_DEFAULTS.turnTtlMs });
  ttl.attach({
    sessionId: 'ttl',
    turnId: 't1',
    sentAt: BASE,
    timeSource: 'typed-sent',
    startedAt: BASE,
    endedAt: BASE,
    alignment: typedAlignment(),
  });
  clock = BASE + COMMENT_EVIDENCE_DEFAULTS.turnTtlMs - 1;
  assert.ok(ttl.take('ttl', { turnId: 't1' }) !== null, 'TTL 内仍有效');
  clock = BASE + COMMENT_EVIDENCE_DEFAULTS.turnTtlMs;
  assert.equal(ttl.take('ttl', { turnId: 't1' }), null, '到期即失效');
  assert.equal(ttl.render('ttl', { turnId: 't1' }), '');
  assert.ok(ttl.state().expired >= 1);
});

// ---------------------------------------------------------------------------
// 6. voice window unchanged
// ---------------------------------------------------------------------------

test('6. 语音轮保持原窗口：audioStartAt/audioEndAt，不被 typed +2s 规则改写', () => {
  const out = alignComment({
    text: '这个表情好搞笑',
    startedAt: BASE,
    endedAt: BASE + 3_000,
    evidence: [frame('voice-pre', BASE - 1_000), frame('voice-after', BASE + 2_000)],
    now: () => BASE + 5_000,
  });
  assert.deepEqual(out.window, { from: BASE - 8_000, to: BASE + 3_000 },
    '语音轮结束点仍是 audioEndAt，不是 sentAt+2s');
  assert.deepEqual(out.relatedFrameIds, ['voice-pre']);
  assert.deepEqual(out.afterSpeechFrameIds, ['voice-after']);

  // typed 的 +2s 只属于 typed 路径。
  assert.equal(TYPED_TURN_DEFAULTS.afterMs, 2_000);
  assert.equal(ALIGNMENT_DEFAULTS.lookbackMs, 8_000);
});

// ---------------------------------------------------------------------------
// 7. Host: typed companion pre-step, gate honesty, no cross-turn
// ---------------------------------------------------------------------------

const state = {
  makeShot: null,
  storyboardStarts: 0,
};
globalThis.__visionTypedCommentTest = state;

const sightUrl = new URL('../src/host/vision/sight.js', import.meta.url).href;
const hooks = registerHooks({
  load(url, context, next) {
    if (url === sightUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          export const resolveFfmpeg = () => null;
          export const resolveFfplay = () => null;
          export const capture = async () => { throw new Error('real capture forbidden'); };
          export const captureDesktop = capture;
          export const captureDevice = capture;
          export const startStoryboard = () => { throw new Error('real storyboard forbidden'); };
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
  const root = await mkdtemp(join(tmpdir(), 'dsh-typed-comment-p1-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  await mkdir(join(root, 'data'), { recursive: true });
  await writeFile(join(root, 'data', 'features.json'), `${JSON.stringify({
    hearing: false, ambient: false, voice: false, vision: true,
    subtitle: false, avatar: false, memory: false, fastpath: false,
  })}\n`, 'utf8');
  await writeFile(join(root, 'data', 'settings.json'), `${JSON.stringify({
    vision: { continuousView: false },
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
    tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name); } },
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
    // 注入 analyzer：避免能力探测；这里没有任何帧，分析不会真正调模型。
    understandingAnalyzer: async () => ({ ok: false, text: '', reason: 'test', images: 0 }),
    understandingMinIntervalMs: 60_000,
    evidenceCaptureBootDelayMs: 60_000,
    // 模拟“同一陪伴会话里的文字轮”：身份仍是 companion，lane 改为 typed。
    contextLaneOverride: () => 'typed',
    ...options,
  });

  t.after(async () => {
    await disposeAll(disposers.splice(0));
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
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
    for (let i = 0; i < 200; i += 1) {
      const hit = (await readEvents()).find((event) => event.type === type && predicate(event.payload ?? {}));
      if (hit !== undefined) return hit;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`timed out waiting for ${label}`);
  };
  return {
    root, workspace, promptSections, promptContexts, listeners, commentEvidence,
    readEvents, waitForEvent,
  };
}

test('7. typed companion pre-step：turn 绑定 + skipped not-companion 如实记录', async (t) => {
  const app = await fixture(t);
  const handler = app.listeners.get('agent/pre-step')?.[0];
  assert.ok(handler !== undefined, 'Host 注册了 agent/pre-step');
  const next = async () => ({ kind: 'enter', messages: [] });
  const companionId = voiceSessionTarget({ root: app.root }).sessionId;
  const agentFor = (id, options = {}) => ({
    id,
    options,
    session: { id, header: { cwd: app.workspace } },
  });
  const message = (id, text) => [{
    id,
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  }];

  // 编码用途 typed（purpose:coding）：即使文本在指画面，也不 attach；只留下真实原因。
  // 普通 GUI typed 已按新语义放行（见 test/vision-typed-companion.mjs），这里只固定排除用途。
  const outsiderId = 'coding-agent-p1';
  await handler({
    agent: agentFor(outsiderId, { purpose: 'coding' }),
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
    messages: message('typed-outsider-1', '这个表情好搞笑'),
  }, next);
  assert.equal(app.commentEvidence.take(outsiderId, { turnId: 1 }), null,
    '编码用途 typed 不得产生评论证据');
  const skipped = await app.waitForEvent('vision.comment.skipped',
    (payload) => payload.reason === 'not-companion', 'not-companion skip');
  assert.equal(skipped.payload.turnId, 1);
  assert.equal(skipped.payload.timeSource, 'typed-sent');

  // 陪伴 typed：用 Host 发送时刻建本轮窗口，并绑定 turnId。
  await handler({
    agent: agentFor(companionId),
    turn: 2,
    step: 1,
    signal: new AbortController().signal,
    messages: message('typed-companion-2', '这个表情好搞笑'),
  }, next);
  const record = app.commentEvidence.take(companionId, { turnId: 2 });
  assert.ok(record !== null, 'typed companion 轮应产生按 turn 绑定的记录');
  assert.equal(record.turnId, '2');
  assert.equal(record.timeSource, 'typed-sent');
  assert.ok(Number.isFinite(record.sentAt) && record.sentAt > 0, 'sentAt 是 Host 记录');
  assert.equal(record.startedAt, record.sentAt, 'typed 无音频：startedAt 就是发送时刻');
  assert.equal(record.endedAt, record.sentAt, 'typed 无音频：没有语音端点');
  assert.equal(record.alignment.timeSource, 'typed-sent');
  assert.deepEqual(record.alignment.window, {
    from: record.sentAt - 8_000,
    to: record.sentAt + 2_000,
  }, 'typed 窗口是 sentAt-8s..sentAt+2s');
  // 上一条/其他 turn 查不到这条记录。
  assert.equal(app.commentEvidence.take(companionId, { turnId: 3 }), null);

  // prompt context 只按本轮 turn 取块；companion + typed 可看到本轮 typed 证据。
  const audiovisual = app.promptContexts.get('assistant:audiovisual');
  assert.ok(audiovisual !== undefined);
  const companionAgent = agentFor(companionId);
  const typedText = audiovisual.text({ agent: companionAgent });
  assert.ok(typedText.includes('【视听证据｜本轮文字发送】'), typedText);
  assert.ok(typedText.includes('typed-sent'), typedText);
  assert.equal(typedText.includes('用户开口'), false);
  const outsiderText = audiovisual.text({ agent: agentFor(outsiderId, { purpose: 'coding' }) });
  assert.equal(outsiderText, '', '编码用途 typed 永远读不到评论证据');

  // 无关闲聊：同一 companion 的下一轮不 attach，也不复用上一轮记录。
  await handler({
    agent: agentFor(companionId),
    turn: 3,
    step: 1,
    signal: new AbortController().signal,
    messages: message('typed-companion-3', '今天吃什么'),
  }, next);
  assert.equal(app.commentEvidence.take(companionId, { turnId: 3 }), null,
    '无关闲聊不 attach');
  const unrelated = await app.waitForEvent('vision.comment.skipped',
    (payload) => payload.reason === 'unrelated', 'unrelated skip');
  assert.equal(unrelated.payload.turnId, 3);
  assert.equal(audiovisual.text({ agent: companionAgent }), '',
    '上一轮的 typed 证据不能被本轮借用');
});
