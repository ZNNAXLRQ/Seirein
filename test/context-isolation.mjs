/**
 * 独立验收：动态观察迁移到运行时上下文（runtime context）。
 *
 * 只测不改（2026-11-08）。被验收的实现是 `src/host/index.js` 把「连续台词」与「非语言线索」
 * 从 system-prompt section 改为 `systemPrompt.context()` 的那次迁移（commit 8c0d639）。
 * 本套件**不复用** `prompt-stability.mjs` 的结论，而是另建三条独立的观测面：
 *
 *  A. 一个按已安装 Harness 语义投影的假循环（`createLoopDouble`）。语义取自安装包
 *     `app.asar`（desktop runtime 0.2.2-rc.1）里的两份实现：
 *       - `@deepseek-ai/dsh-system-prompt/lib/index.js`
 *         `section` 文本进 prompt；`context` 文本进独立快照，`joinContextSections` 在非空时
 *         前置「Current runtime context. This snapshot supersedes earlier runtime-context
 *         snapshots.」；空文本不产生快照。
 *       - `@deepseek-ai/dsh-agent-loop/lib/index.js`
 *         `SystemPromptProjection.project()`：`in-history` 路由下 prompt 变一次就 **追加** 一个
 *         system 节点；不变则不动。
 *         `RuntimeContextProjection.project()`（约 296–349 行）：快照文本与「retained」不同时
 *         产出一条 `user/message`，`source = {kind:'runtime-context', form:'snapshot', sections}`；
 *         `step()`（约 843–866 行）以 `surfaceOp:'append'` 提交，**不删除**上一条快照节点，
 *         文本清空时提交一条 CLEARED 标记而不是空消息。
 *         `@deepseek-ai/dsh-session` 的 surface fold 也印证：append 只 push，replace 才 shadow。
 *     「快照会以另一种消息形式累积」正是本套件要量化的事实；报告见
 *     `docs/reports/runtime-context-acceptance-2026-11-08.md`。
 *
 *  B. 真 `apply()` 挂载 + 假 `systemPrompt` 服务（`section` / `context` 与真实契约同形），
 *     用假时钟顺序驱动 ≥5 轮；断言一律以渲染文本、SHA-1、事件与提交的消息为准，不看 status。
 *
 *  C. 注入隔离：真 Host 的 `session/event` 观察者（自动记忆、语音回合、声音上下文）与真
 *     `MemoryStore`，喂一条与 Harness 同形的快照消息，验证它不被当作用户发言。
 *
 * 覆盖：
 *   1. 六轮对话：系统提示文本/哈希逐字不变、系统节点不增长；快照每轮追加一条（量化）。
 *   2. 台词 + 非语言线索同处一个快照：来源可归因、提示词不变、清空后无空快照。
 *   3. 时效与清除：本轮请求看得到本轮缓冲；clear 后快照消失（无空快照）。
 *   4. 注入隔离：不入自动记忆、不触发 ack/reply、不增加 responseGroup；surface 可区分。
 *   5. 旁证（非验收项）：声音上下文观察者不区分来源，快照会刷新噪声门窗口。
 *   6. 隐私：只锁视觉采集，不抑制语音观察快照（明确现状）。
 *   7. 切会话：消息不串台；同一 workspace 的观察内容共享，跨 workspace 不注入（现状）。
 *
 * Run: node --test test/context-isolation.mjs
 * Regression: node --test test/prompt-stability.mjs test/dialogue-injection.mjs test/nonverbal-cue.mjs
 *             node test/smoke.mjs
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

import { cleanupRoot } from './helpers/cleanup.mjs';

/** `voiceSessionTarget` 之外的 Host API 都在下面一次性取到；hearing 换成假实现（只替换设备层）。 */
const HEARING_URL = new URL('../src/host/hearing/hearing.js', import.meta.url).href;
const REAL_HEARING_URL = new URL('../src/host/hearing/hearing.js?context-isolation-real', import.meta.url).href;

globalThis.__contextIsolationHearing = { onUpdate: null };

const hooks = registerHooks({
  load(url, context, next) {
    if (url !== HEARING_URL) return next(url, context);
    return {
      format: 'module',
      shortCircuit: true,
      source: `
    import * as real from ${JSON.stringify(REAL_HEARING_URL)};
    const s = globalThis.__contextIsolationHearing;
    export const startHearing = (options) => {
      s.onUpdate = options.onUpdate;
      return { device: options.device, stop() {}, stats: () => ({ rmsDb: -20 }) };
    };
    export const listDevices = async () => ['Fake Mic'];
    export const modelReady = () => true;
    export const finalModelReady = () => false;
    export const watchHearingExit = () => {};
    export const isLoopbackDevice = real.isLoopbackDevice;
    export const selectMicrophoneDevice = real.selectMicrophoneDevice;
    export const annotateTranscript = real.annotateTranscript;
    export const joinDetailFields = real.joinDetailFields;
    export const mergeJoinFallback = real.mergeJoinFallback;
    export const offlineLimitedNote = real.offlineLimitedNote;
    export const truncationNotice = real.truncationNotice;`,
    };
  },
});

const { DIALOGUE_INJECTION_ORDER, apply, voiceSessionTarget } = await import('../src/host/index.js');
const { createDialogueContext } = await import('../src/host/session/conversation/dialogueContext.js');
const { createVoiceContextObserver } = await import('../src/host/session/events/voice-context.js');
hooks.deregister();

after(() => {
  delete globalThis.__contextIsolationHearing;
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha1 = (text) => createHash('sha1').update(text).digest('hex');

/** 安装包里 `joinContextSections` 的固定前缀（逐字，来自 app.asar 的 dsh-system-prompt）。 */
const RUNTIME_CONTEXT_HEADER = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.';
/** 安装包里 `RuntimeContextProjection` 的清空标记；清空时提交的是它，不是空消息。 */
const RUNTIME_CONTEXT_CLEARED = 'Current runtime context: none. Earlier runtime-context snapshots no longer apply.';
/** 台词块与非语言块的固定抬头（Host 自己渲染，来源可归因）。 */
const DIALOGUE_HEADER = '【连续台词上下文｜系统观察，不是用户发言】';
const NONVERBAL_HEADER = '【系统观察·非语言线索】';

const WORKSPACE = (root) => join(root, 'workspace');
const entryIn = (root) => ({ agent: { session: { header: { cwd: WORKSPACE(root) } } } });

const FEATURES = Object.freeze({
  hearing: false,
  ambient: false,
  voice: false,
  vision: false,
  subtitle: false,
  avatar: false,
  memory: false,
  fastpath: false,
});

/** 一个临时 Host 根：features / settings 都是 JSON 文件，和真实 Host 的读取路径一致。 */
async function tempRoot(t, { features = {}, settings = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-context-isolation-'));
  for (const dir of ['data', 'memory', 'workspace']) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, 'data', 'features.json'), `${JSON.stringify({ ...FEATURES, ...features })}\n`, 'utf8');
  if (settings !== null) {
    writeFileSync(join(root, 'data', 'settings.json'), `${JSON.stringify(settings)}\n`, 'utf8');
  }
  return root;
}

function readEvents(root) {
  try {
    return readFileSync(join(root, 'data', 'events.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

async function untilEvents(root, predicate, label, timeoutMs = 4000) {
  const startedAt = Date.now();
  let events = [];
  while (Date.now() - startedAt < timeoutMs) {
    events = readEvents(root);
    if (predicate(events)) return events;
    await delay(10);
  }
  assert.fail(`timed out: ${label}; events=${events.map((event) => event.type).join(',')}`);
}

/**
 * 挂真实 `apply()`。假宿主只提供 systemPrompt（section + context）与一个会记录 session/event
 * 处理器的 `on`：前者按已安装契约渲染，后者让测试把「Harness 会提交的那条快照消息」喂回 Host
 * 的真实观察者。
 */
function mountHost(root, { dialogueContext, config = {} } = {}) {
  const sections = new Map();
  const contexts = new Map();
  const tools = new Map();
  const handlers = [];
  const disposers = [];
  const effect = (fn) => {
    const value = fn();
    if (typeof value === 'function') disposers.push(value);
    return value;
  };
  const on = (type, handler) => {
    const entry = { type, handler };
    handlers.push(entry);
    return () => {
      const index = handlers.indexOf(entry);
      if (index >= 0) handlers.splice(index, 1);
    };
  };
  const scope = {
    effect,
    on,
    systemPrompt: {
      section(definition) {
        sections.set(definition.name, definition);
        return () => sections.delete(definition.name);
      },
      context(definition) {
        contexts.set(definition.name, definition);
        return () => contexts.delete(definition.name);
      },
    },
    webServer: { register: () => () => {} },
  };
  apply({
    effect,
    on,
    get: () => undefined,
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    inject: (_deps, register) => register(scope),
    webServer: { register: () => () => {} },
  }, {
    root,
    enabled: true,
    // 0 = 不节流：每一轮的 stable / refreshed 事件都能被观察到。
    promptStabilityThrottleMs: 0,
    ffmpegPath: process.execPath,
    ...(dialogueContext === undefined ? {} : { dialogueContext }),
    ...config,
  });

  const orderOf = (left, right) => left.order - right.order || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  /**
   * 与真实 `SystemPrompt.assemble()` 同序：先按 order 渲染全部 section 拼成 prompt，再按 order
   * 渲染全部 context 形成快照（空贡献不出现）。假装配不缓存，所以每次调用都读到当前缓冲。
   */
  const assemble = (contextArg) => {
    const prompt = [...sections.values()]
      .sort(orderOf)
      .map((section) => (typeof section.text === 'function' ? section.text(contextArg) : section.text))
      .filter((text) => typeof text === 'string' && text.length > 0)
      .join('\n\n');
    const parts = [...contexts.values()]
      .sort(orderOf)
      .map((context) => ({
        name: context.name,
        text: typeof context.text === 'function' ? context.text(contextArg) : context.text,
      }))
      .filter((part) => typeof part.text === 'string' && part.text.length > 0);
    const snapshot = joinSnapshot(parts);
    return {
      prompt,
      hash: sha1(prompt),
      parts,
      snapshot,
      contextText: (name) => parts.find((part) => part.name === name)?.text ?? '',
    };
  };

  /** 把一条 session/event 喂给 Host 已注册的全部观察者（与 Harness 的派发同形）。 */
  const dispatch = (session, event) => {
    for (const entry of [...handlers]) {
      if (entry.type === 'session/event') entry.handler(session, event);
    }
  };

  return {
    sections,
    contexts,
    tools,
    assemble,
    dispatch,
    disposers,
    close: () => cleanupRoot(root, disposers),
  };
}

/** 已安装 `joinContextSections`：空贡献 → ''，否则固定抬头 + 各贡献用空行分隔。 */
function joinSnapshot(parts) {
  const body = parts.map((part) => part.text).join('\n\n');
  return body.length === 0 ? '' : `${RUNTIME_CONTEXT_HEADER}\n\n${body}`;
}

/**
 * 假循环：只投影两条 surface 规则（见文件头）。它不是「status」，而是 Harness 真正写进历史的
 * 消息序列；测试统计的就是这个序列。
 */
function createLoopDouble({ inHistory = true } = {}) {
  const state = {
    systemNodes: [],
    snapshots: [],
    cleared: 0,
    seq: 0,
  };
  const projectSystem = (prompt) => {
    if (state.systemNodes.length === 0) {
      state.systemNodes.push(prompt);
      return 'first';
    }
    const latest = state.systemNodes.at(-1);
    if (prompt === latest) return 'none';
    if (inHistory) {
      state.systemNodes.push(prompt);
      return 'append';
    }
    state.systemNodes[state.systemNodes.length - 1] = prompt;
    return 'replace';
  };
  /**
   * @param {{prompt: string, parts: Array<{name: string, text: string}>, snapshot: string}} atRequest
   *        请求时刻（不是 pre-step 时刻）的装配；Harness 在 step 里会重新解析 context provider。
   */
  const step = (atRequest) => {
    const systemOp = projectSystem(atRequest.prompt);
    const retained = state.snapshots.at(-1);
    // Harness 的 `textOf(message)` 取的是 content[0].text（消息必须恰好一个 text 块）。
    const retainedText = retained === undefined ? undefined : retained.content[0]?.text;
    let message = null;
    if (!(retained === undefined && atRequest.snapshot === '')) {
      const text = atRequest.snapshot === '' ? RUNTIME_CONTEXT_CLEARED : atRequest.snapshot;
      if (retainedText !== text) {
        const sections = atRequest.parts.map((part) => ({ name: part.name, text: part.text }));
        message = {
          id: `runtime-context-${++state.seq}`,
          role: 'user',
          source: sections.length === 0
            ? { kind: 'runtime-context' }
            : { kind: 'runtime-context', form: 'snapshot', sections },
          content: [{ type: 'text', text }],
          // 已安装 Harness 的事实：surfaceOp 是 append，旧快照节点不删除。
          surfaceOp: 'append',
        };
        state.snapshots.push(message);
        if (atRequest.snapshot === '') state.cleared += 1;
      }
    }
    return { systemOp, message };
  };
  return { state, step };
}

const snapshotTexts = (loop) => loop.state.snapshots.map((message) => message.content[0].text);

/** 一条与 Harness 同形的快照消息（role=user，source 可归因，内容带固定抬头）。 */
function runtimeContextMessage({ id, body, sections }) {
  return {
    type: 'user/message',
    time: Date.now(),
    data: {
      turn: 1,
      id,
      role: 'user',
      source: { kind: 'runtime-context', form: 'snapshot', sections },
      content: [{ type: 'text', text: `${RUNTIME_CONTEXT_HEADER}\n\n${body}` }],
    },
  };
}

const userMessage = (id, text, turn = 1) => ({
  type: 'user/message',
  time: Date.now(),
  data: { turn, id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
});

const turnStart = (turn) => ({ type: 'turn/start', data: { turn } });
const turnEnd = (turn, kind = 'completed') => ({ type: 'turn/end', data: { turn, reason: { kind } } });

/** 真正会发声的 ack 行（`voice.ack.warm.*` / `cache.*` 是预热诊断，不是播报）。 */
const ACK_LINE = /^voice\.ack\.(spoken|skipped|silent|failed|cancelled|superseded|kept)$/u;

// ---------------------------------------------------------------------------
// 1. 六轮对话：系统提示不变，快照以 user 角色每轮 +1 条
// ---------------------------------------------------------------------------

test('1. 六轮对话：系统提示文本/哈希不变、系统节点不增长；快照每轮 +1 条（量化）', async (t) => {
  const root = await tempRoot(t, { features: { hearing: true } });
  const clock = { now: 1_000_000 };
  const buffer = createDialogueContext({ now: () => clock.now });
  const host = mountHost(root, { dialogueContext: buffer });
  t.after(() => host.close());

  const entry = entryIn(root);
  const loop = createLoopDouble();
  const utterances = [
    '第一段：门是开着的。',
    '第二段：屋里没有人。',
    '第三段：他拿走了钥匙。',
    '第四段：门外有人敲门。',
    '第五段：他走进门。',
    '第六段：桌上有一封信。',
  ];

  const rounds = [];
  for (const text of utterances) {
    clock.now += 3_000;
    buffer.push({ text, at: clock.now, utteranceId: `u-${rounds.length + 1}` });
    const assembly = host.assemble(entry);
    // 一轮一步：pre-step 装配与请求时刻装配相同，所以只提交一条快照。
    const commit = loop.step(assembly);
    rounds.push({ text, assembly, commit });
  }

  // -- 系统提示：文本与哈希逐字不变
  const hashes = new Set(rounds.map((round) => round.assembly.hash));
  const prompts = new Set(rounds.map((round) => round.assembly.prompt));
  assert.equal(prompts.size, 1, '六轮的系统提示文本逐字相同');
  assert.equal(hashes.size, 1, '六轮的系统提示哈希相同');
  assert.equal(rounds[0].assembly.prompt.includes(utterances[0]), false, '台词不进入系统提示');
  assert.equal(rounds.every((round) => round.assembly.prompt === rounds[0].assembly.prompt), true);

  // -- 历史里的系统节点：只保留第 1 个，六轮零追加
  assert.equal(loop.state.systemNodes.length, 1, '历史里只有 1 个系统节点');
  assert.deepEqual(rounds.map((round) => round.commit.systemOp), ['first', 'none', 'none', 'none', 'none', 'none']);

  // -- 对照：如果观察仍是 section，同一假循环会每轮追加一个系统节点
  const counterfactual = createLoopDouble();
  for (let index = 0; index < utterances.length; index += 1) {
    counterfactual.step({ prompt: `旧 section 版提示词 ${index}`, parts: [], snapshot: '' });
  }
  assert.equal(counterfactual.state.systemNodes.length, utterances.length, '旧写法每轮追加一个系统节点');

  // -- 动态快照：每轮刚好一条、内容是「当前全量快照」，不是增量
  assert.equal(loop.state.snapshots.length, utterances.length, '每轮追加一条快照（同一来源不替换）');
  assert.equal(rounds.every((round) => round.commit.message !== null), true);
  for (const [index, round] of rounds.entries()) {
    const message = round.commit.message;
    assert.equal(message.role, 'user', '快照以 user 角色进入历史');
    assert.equal(message.source.kind, 'runtime-context', '来源标记为 runtime-context');
    assert.equal(message.source.form, 'snapshot');
    assert.deepEqual(message.source.sections.map((section) => section.name), ['assistant:dialogue']);
    assert.equal(message.content.length, 1);
    assert.equal(message.content[0].type, 'text');
    assert.ok(message.content[0].text.startsWith(RUNTIME_CONTEXT_HEADER));
    assert.ok(message.content[0].text.includes(DIALOGUE_HEADER), '带来源标记的观察块');
    assert.ok(message.content[0].text.includes(round.text), `第 ${index + 1} 轮文本可见`);
    assert.equal(message.content[0].text, round.assembly.snapshot, '提交的是请求时刻的全量快照');
    if (index > 0) {
      assert.ok(message.content[0].text.includes(utterances[index - 1]), '快照是累积窗口，不是增量');
    }
  }
  // 同一来源的旧快照没有被替换：历史里 6 条，而不是 1 条。
  assert.equal(new Set(loop.state.snapshots.map((message) => message.id)).size, utterances.length);
  assert.equal(loop.state.cleared, 0);

  const snapshotChars = snapshotTexts(loop).map((text) => Array.from(text).length);
  const cumulative = snapshotChars.reduce((total, chars) => total + chars, 0);
  const promptChars = Array.from(rounds[0].assembly.prompt).length;
  console.log(`[1] promptChars=${promptChars} promptHash=${rounds[0].assembly.hash} hashCount=${hashes.size} `
    + `systemNodes=1 appendedSystem=0 snapshots=${snapshotChars.length} snapshotChars=${snapshotChars.join('+')} `
    + `snapshotTotalChars=${cumulative} growthPerRound=+1 (counterfactualSystemNodes=${counterfactual.state.systemNodes.length})`);

  // -- 事件面：prompt 只变更一次，之后每轮 stable；context 每轮 refreshed
  const events = await untilEvents(
    root,
    (all) => all.filter((event) => event.type === 'assistant.context.refreshed'
      && event.payload?.name === 'assistant:dialogue').length >= utterances.length
      && all.filter((event) => event.type === 'assistant.prompt.stable').length >= utterances.length - 1
      && all.some((event) => event.type === 'assistant.prompt.changed'),
    'six dialogue context.refreshed + five prompt.stable events',
  );
  const changed = events.filter((event) => event.type === 'assistant.prompt.changed').length;
  const stable = events.filter((event) => event.type === 'assistant.prompt.stable').length;
  const refreshed = events.filter((event) => event.type === 'assistant.context.refreshed'
    && event.payload?.name === 'assistant:dialogue');
  const nonverbalRefreshed = events.filter((event) => event.type === 'assistant.context.refreshed'
    && event.payload?.name === 'assistant:nonverbal');
  assert.equal(changed, 1, 'prompt.changed 只出现一次（首次装配）');
  assert.ok(stable >= utterances.length - 1, `之后每轮 stable（实际 ${stable}）`);
  assert.equal(events.find((event) => event.type === 'assistant.prompt.stable').payload.changed, false);
  assert.equal(refreshed.length >= utterances.length, true);
  // 事件写盘是异步 appendFile：并发 emit 落盘顺序不保证（prompt-stability.mjs 也按内容而非位置找）。
  // 因此比较「每轮都报告了本轮的 context 长度」这一多重集合，而不是依赖最后一条的位置。
  const expectedChars = rounds
    .map((round) => round.assembly.contextText('assistant:dialogue').length)
    .sort((left, right) => left - right);
  const reportedChars = refreshed.map((event) => event.payload.chars).sort((left, right) => left - right);
  assert.deepEqual(reportedChars, expectedChars, '每一轮的 context 长度都被报告一次');
  assert.equal(refreshed.every((event) => event.payload.active === true), true);
  assert.equal(nonverbalRefreshed.length, 1, '非语言 context 只有首次的空贡献被报告一次');
  assert.equal(nonverbalRefreshed[0].payload.active, false);
  assert.equal(events.some((event) => event.type === 'assistant.prompt.changed'
    && event.payload?.changed === true), true);

  console.log(`[1] events changed=${changed} stable=${stable} dialogueRefreshed=${refreshed.length} `
    + `nonverbalRefreshed=${nonverbalRefreshed.length} refreshedChars=${reportedChars.join(',')}`);

  // 记录给报告：每轮追加的正是「完整快照」，其长度由台词窗口（maxChars 1200）+ 摘要（400）约束。
  assert.equal(buffer.snapshot().limits.maxChars, 1_200);
  assert.equal(buffer.snapshot().limits.maxSummaryChars, 400);
});

// ---------------------------------------------------------------------------
// 2. 台词 + 非语言线索同处一个快照：可归因，提示词不变，清除后无空快照
// ---------------------------------------------------------------------------

test('2. 台词与非语言线索同处一个快照：来源可归因、提示词不变、清空后无空快照', async (t) => {
  const root = await tempRoot(t, {
    features: { hearing: true },
    settings: { gptSovits: { enabled: false }, autoMemory: { enabled: false }, voice: { nonverbalCue: true } },
  });
  const buffer = createDialogueContext();
  buffer.push({ text: '第一段：门是开着的。', at: 1_000, utteranceId: 'u1' });
  const host = mountHost(root, { dialogueContext: buffer, config: { asrMergeWindowMs: 10 } });
  t.after(() => host.close());

  const entry = entryIn(root);
  const loop = createLoopDouble();
  const before = host.assemble(entry);
  assert.equal(before.parts.some((part) => part.name === 'assistant:nonverbal'), false, '没有线索时没有该贡献');
  assert.equal(before.contextText('assistant:nonverbal'), '');

  // 真 Host 的听觉入口：假 hearing 只暴露 onUpdate，Host 的 onUpdate → cue 路径是真的。
  const listen = host.tools.get('assistant_listen');
  assert.ok(listen !== undefined, 'assistant_listen 已注册');
  const started = await listen.execute({ action: 'start' });
  assert.equal(started.ok, true, `listening started: ${started.error ?? ''}`);
  const hearingState = globalThis.__contextIsolationHearing;
  assert.equal(typeof hearingState.onUpdate, 'function', 'hearing 暴露 onUpdate');

  hearingState.onUpdate({
    durationMs: 100,
    final: '哈哈',
    event: '<|Laughter|>',
    eventClean: 'Laughter',
    source: 'mic',
    utteranceId: 7,
  });
  const cueEvents = await untilEvents(
    root,
    (all) => all.some((event) => event.type === 'voice.nonverbal.cue'),
    'voice.nonverbal.cue',
  );
  assert.equal(cueEvents.find((event) => event.type === 'voice.nonverbal.cue').payload.source, 'mic');

  const after = host.assemble(entry);
  assert.equal(after.prompt, before.prompt, '线索出现不改变系统提示文本');
  assert.equal(after.hash, before.hash, '线索出现不改变系统提示哈希');
  assert.equal(after.prompt.includes(NONVERBAL_HEADER), false, '线索块不在系统提示里');
  assert.equal(after.prompt.includes('哈哈'), false, '转写文本不在系统提示里');

  // 两个来源都在同一个快照里，顺序 105（线索）→ 110（台词）。
  assert.deepEqual(after.parts.map((part) => part.name), ['assistant:nonverbal', 'assistant:dialogue']);
  assert.ok(after.parts[0].text.startsWith(NONVERBAL_HEADER));
  assert.ok(after.parts[0].text.includes('麦克风'), '线索自述来源是麦克风');
  assert.ok(after.parts[1].text.startsWith(DIALOGUE_HEADER));
  assert.equal(after.contextText('assistant:nonverbal'), after.parts[0].text);
  assert.equal(host.contexts.get('assistant:nonverbal').order, 105);
  assert.equal(host.contexts.get('assistant:dialogue').order, DIALOGUE_INJECTION_ORDER);
  assert.equal(after.snapshot, joinSnapshot(after.parts));
  assert.equal(after.snapshot.split(RUNTIME_CONTEXT_HEADER).length - 1, 1, '固定抬头只出现一次');

  const commit = loop.step(after);
  assert.ok(commit.message !== null);
  assert.equal(commit.message.role, 'user');
  assert.equal(commit.message.source.kind, 'runtime-context');
  assert.deepEqual(commit.message.source.sections.map((section) => section.name),
    ['assistant:nonverbal', 'assistant:dialogue'], '来源标记可归因到两个子系统');
  assert.equal(commit.message.content[0].text, after.snapshot);

  // 用户明确否认 → 线索清除；下一次装配只有台词，快照里没有空块。
  host.dispatch(
    { id: voiceSessionTarget({ root }).sessionId, header: { cwd: WORKSPACE(root) } },
    userMessage('u-deny', '我没笑', 1),
  );
  const clearedEvents = await untilEvents(
    root,
    (all) => all.some((event) => event.type === 'voice.nonverbal.cleared'),
    'voice.nonverbal.cleared',
  );
  const cleared = clearedEvents.find((event) => event.type === 'voice.nonverbal.cleared');
  assert.equal(cleared.payload.reason, 'denied');

  const withoutCue = host.assemble(entry);
  assert.equal(withoutCue.contextText('assistant:nonverbal'), '', '清除后该贡献为空');
  assert.deepEqual(withoutCue.parts.map((part) => part.name), ['assistant:dialogue'], '不产生空贡献');
  assert.equal(withoutCue.prompt, before.prompt, '清除线索也不改写系统提示');
  assert.equal(withoutCue.snapshot.includes(NONVERBAL_HEADER), false);
  assert.ok(withoutCue.snapshot.length > 0, '快照仍然非空（台词还在）');

  const afterClear = loop.step(withoutCue);
  assert.ok(afterClear.message !== null, '文本变化 → 追加一条新快照');
  assert.equal(afterClear.message.content[0].text, withoutCue.snapshot);
  assert.deepEqual(afterClear.message.source.sections.map((section) => section.name), ['assistant:dialogue']);
  assert.equal(afterClear.message.content[0].text.includes(NONVERBAL_HEADER), false);
  assert.equal(loop.state.snapshots.length, 2, '两条快照：含线索 / 不含线索');

  await listen.execute({ action: 'stop' });
  console.log(`[2] parts=${after.parts.map((part) => part.name).join(',')} `
    + `promptHash=${after.hash.slice(0, 12)} sameAsBefore=${after.hash === before.hash} `
    + `snapshotChars=${Array.from(after.snapshot).length}→${Array.from(withoutCue.snapshot).length} `
    + `snapshots=${loop.state.snapshots.length}`);
});

// ---------------------------------------------------------------------------
// 3. 时效与清除
// ---------------------------------------------------------------------------

test('3. 时效与清除：本轮请求看得到本轮缓冲；清空后快照消失（无空快照）', async (t) => {
  const root = await tempRoot(t, { features: { hearing: true } });
  const clock = { now: 1_000_000 };
  const buffer = createDialogueContext({ now: () => clock.now });
  const host = mountHost(root, { dialogueContext: buffer });
  t.after(() => host.close());
  const entry = entryIn(root);

  // -- 3a. pre-step 之后到达的台词，本轮请求仍然看得到（Harness 在 step 里重新解析 context）
  clock.now += 1_000;
  buffer.push({ text: '第一段：门是开着的。', at: clock.now, utteranceId: 'u1' });
  const preStep = host.assemble(entry);
  assert.ok(preStep.contextText('assistant:dialogue').includes('门是开着的'));
  clock.now += 2_000;
  buffer.push({ text: '第二段：我进来了。', at: clock.now, utteranceId: 'u2' });
  assert.equal(preStep.contextText('assistant:dialogue').includes('我进来了'), false, 'pre-step 的渲染已经过期');

  const atRequest = host.assemble(entry);
  assert.ok(atRequest.contextText('assistant:dialogue').includes('我进来了'), '请求时刻重新解析，看得到最新台词');
  assert.equal(atRequest.prompt, preStep.prompt, '重新解析不改变系统提示');
  assert.equal(atRequest.hash, preStep.hash);

  const loop = createLoopDouble();
  const request = loop.step(atRequest);
  assert.equal(loop.state.snapshots.length, 1, '只提交一条快照（不是 pre-step 与请求时刻各一条）');
  assert.equal(request.message.content[0].text, atRequest.snapshot);
  assert.ok(request.message.content[0].text.includes('我进来了'));
  assert.ok(request.message.content[0].text.includes('门是开着的'));

  // -- 3b. clear：快照消失；Harness 提交 CLEARED 标记，而不是空消息
  const promptBeforeClear = atRequest.prompt;
  buffer.clear();
  const clearedAssembly = host.assemble(entry);
  assert.deepEqual(clearedAssembly.parts, [], '空缓冲不产生任何 context 贡献');
  assert.equal(clearedAssembly.snapshot, '', '空缓冲不产生快照文本');
  assert.equal(clearedAssembly.prompt, promptBeforeClear, '清空缓冲不改写系统提示');
  assert.equal(clearedAssembly.hash, atRequest.hash);

  const clearedCommit = loop.step(clearedAssembly);
  assert.ok(clearedCommit.message !== null, '已存在的快照被清空时提交一条标记消息');
  assert.equal(clearedCommit.message.content[0].text, RUNTIME_CONTEXT_CLEARED);
  assert.notEqual(clearedCommit.message.content[0].text, '', '不是空消息');
  assert.equal(clearedCommit.message.source.kind, 'runtime-context');
  assert.equal(clearedCommit.message.source.sections, undefined, '清空标记没有可归因贡献');
  assert.equal(loop.state.cleared, 1);
  assert.equal(loop.state.snapshots.length, 2);

  // -- 3c. 从未有过快照时清空：不产生任何消息（不是空快照）
  const freshRoot = await tempRoot(t, { features: { hearing: true } });
  const freshBuffer = createDialogueContext();
  const freshHost = mountHost(freshRoot, { dialogueContext: freshBuffer });
  t.after(() => freshHost.close());
  const freshLoop = createLoopDouble();
  freshBuffer.clear();
  const never = freshHost.assemble(entryIn(freshRoot));
  const neverCommit = freshLoop.step(never);
  assert.equal(neverCommit.message, null, '没有旧快照就不提交任何东西');
  assert.equal(freshLoop.state.snapshots.length, 0);

  // -- 3d. 时间流过但没人说话：缓冲不自行过期（设计：无定时器）；新台词把旧文本滚进 pending
  const windowRoot = await tempRoot(t, { features: { hearing: true } });
  const windowClock = { now: 10_000 };
  const windowBuffer = createDialogueContext({ now: () => windowClock.now, maxWindowMs: 1_000, maxChars: 40 });
  const windowHost = mountHost(windowRoot, { dialogueContext: windowBuffer });
  t.after(() => windowHost.close());
  windowBuffer.push({ text: '旧的一句。', at: windowClock.now, utteranceId: 'w1' });
  windowClock.now += 60_000;
  const quiet = windowHost.assemble(entryIn(windowRoot));
  assert.ok(quiet.contextText('assistant:dialogue').includes('旧的一句'), '安静 60 s 不会让缓冲自行过期');
  windowBuffer.push({ text: '新的一句。', at: windowClock.now, utteranceId: 'w2' });
  const rolled = windowHost.assemble(entryIn(windowRoot));
  assert.ok(rolled.contextText('assistant:dialogue').includes('旧的一句'), '滚出窗口的文本进入 pending，仍在快照里');
  assert.ok(rolled.contextText('assistant:dialogue').includes('新的一句'));
  assert.notEqual(rolled.snapshot, '');

  console.log(`[3] requestSeesLatest=true preStepSnapshotStale=true snapshotsAfterClear=${loop.state.snapshots.length} `
    + `clearedMarkerChars=${Array.from(RUNTIME_CONTEXT_CLEARED).length} neverSnapshot=${freshLoop.state.snapshots.length} `
    + `quietMinutesKept=true rolledTextKept=true`);
});

// ---------------------------------------------------------------------------
// 4. 注入隔离
// ---------------------------------------------------------------------------

test('4. 注入隔离：不写自动记忆、不触发 ack/reply、不增加 responseGroup，surface 可归属', async (t) => {
  const root = await tempRoot(t, { features: { memory: true } });
  const host = mountHost(root);
  t.after(() => host.close());
  const session = { id: 'sess-isolation', header: { cwd: WORKSPACE(root) } };
  const sessionId = session.id;

  // -- 六轮快照消息（与 Harness 提交的形态逐字段一致）
  const observations = [
    '【连续台词上下文｜系统观察，不是用户发言】\n[麦克风] 第一段：紫色雨伞放在门口。',
    '【连续台词上下文｜系统观察，不是用户发言】\n[麦克风] 第二段：紫色雨伞被人拿走了。',
    '【系统观察·非语言线索】麦克风在 3 秒前检测到疑似笑声，来源及情绪含义未确认。',
    '【连续台词上下文｜系统观察，不是用户发言】\n[麦克风] 第三段：外面在下雨。',
    '【连续台词上下文｜系统观察，不是用户发言】\n[麦克风] 第四段：窗户没有关。',
    '【连续台词上下文｜系统观察，不是用户发言】\n[麦克风] 第五段：地板湿了。',
  ];
  host.dispatch(session, turnStart(1));
  for (const [index, body] of observations.entries()) {
    const name = body.startsWith(NONVERBAL_HEADER) ? 'assistant:nonverbal' : 'assistant:dialogue';
    host.dispatch(session, runtimeContextMessage({
      id: `snapshot-${index + 1}`,
      body,
      sections: [{ name, text: body }],
    }));
  }
  host.dispatch(session, turnEnd(1));
  await delay(250);

  let events = readEvents(root);
  const eventsOf = (pattern) => events.filter((event) => pattern.test(event.type));
  assert.equal(events.filter((event) => event.type === 'memory.auto').length, 0, '快照不写自动记忆');
  assert.equal(eventsOf(ACK_LINE).length, 0, '快照不触发任何 ack 行');
  assert.equal(eventsOf(/^voice\.response\.group\./u).length, 0, '快照不创建回应组');

  // -- 对照：同一会话的一条真 user 消息会被记录并发起 ack 判定（证明观察链真的接上了）
  host.dispatch(session, turnStart(2));
  host.dispatch(session, userMessage('user-1', '我刚刚说钥匙在柜子里', 2));
  host.dispatch(session, turnEnd(2));
  const withUser = await untilEvents(
    root,
    (all) => all.some((event) => event.type === 'memory.auto' && event.payload?.role === 'user'),
    'memory.auto for the genuine user message',
  );
  events = withUser;
  const memoryAuto = events.filter((event) => event.type === 'memory.auto');
  assert.equal(memoryAuto.length, 1, '真 user 消息记录 1 条');
  assert.equal(memoryAuto[0].payload.records, 1);
  assert.equal(memoryAuto[0].payload.chars, Array.from('我刚刚说钥匙在柜子里').length);
  assert.ok(eventsOf(ACK_LINE).length >= 1, '真 user 消息触发 ack 判定（这里是 disabled skip）');
  assert.equal(eventsOf(/^voice\.response\.group\./u).length, 0, '回应组仍为 0（它只由语音轮次创建）');

  // -- 自动记忆的内容：只有真 user 的原话，没有任何观察块
  const recall = host.tools.get('assistant_recall');
  assert.ok(recall !== undefined, 'assistant_recall 已注册');
  const observedQuery = await recall.execute({ query: '紫色雨伞' });
  assert.equal(observedQuery.hits.length, 0, '快照文本不可被记忆召回');
  const userQuery = await recall.execute({ query: '钥匙在柜子里' });
  assert.equal(userQuery.hits.length, 1, '只召回真 user 原话');
  assert.equal(userQuery.hits[0].text, '我刚刚说钥匙在柜子里');

  // -- surface：快照以 user 角色出现，但 source 与真 user 可区分
  const loop = createLoopDouble();
  const assembly = {
    prompt: 'stable prompt',
    parts: [{ name: 'assistant:dialogue', text: observations[0] }],
    snapshot: `${RUNTIME_CONTEXT_HEADER}\n\n${observations[0]}`,
  };
  const committed = loop.step(assembly);
  assert.equal(committed.message.role, 'user', '模型看到的是一条 user 角色消息');
  assert.equal(committed.message.source.kind, 'runtime-context');
  assert.equal(committed.message.source.form, 'snapshot');
  assert.deepEqual(committed.message.source.sections.map((section) => section.name), ['assistant:dialogue']);
  assert.ok(committed.message.content[0].text.startsWith(RUNTIME_CONTEXT_HEADER));
  assert.notEqual(committed.message.source.kind, 'user', '它不是用户发言');

  console.log(`[4] snapshotMemoryAuto=0 snapshotAck=0 snapshotGroups=0 userMemoryAuto=${memoryAuto.length} `
    + `userAck=${eventsOf(ACK_LINE).length} recallObserved=${observedQuery.hits.length} `
    + `recallUser=${userQuery.hits.length} surface=${committed.message.role}/${committed.message.source.kind}`);
});

// ---------------------------------------------------------------------------
// 5. 旁证（非验收项）：声音上下文观察者对来源不敏感
// ---------------------------------------------------------------------------

test('5. 旁证：声音上下文观察者不区分来源，快照会刷新噪声门窗口', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-context-isolation-voice-'));
  const target = voiceSessionTarget({ root }).sessionId;
  const services = {
    root,
    ROLLOVER_HOUR: 4,
    voiceContextAt: 0,
    voiceSessionTarget,
    currentTurnBySession: new Map(),
    memoryTurnLedger: { forgetBefore: () => {} },
    forgetReplySpokeBefore: () => {},
    voiceRecallByTurn: new Map(),
    voiceRecallKey: (sessionId, turn) => `${sessionId}\u0000${turn}`,
  };
  const handler = createVoiceContextObserver(services);
  handler({ id: target }, {
    type: 'user/message',
    data: {
      turn: 1,
      id: 'snapshot-voice',
      role: 'user',
      source: { kind: 'runtime-context', form: 'snapshot', sections: [{ name: 'assistant:dialogue', text: 'x' }] },
      content: [{ type: 'text', text: `${RUNTIME_CONTEXT_HEADER}\n\n【连续台词上下文｜系统观察，不是用户发言】` }],
    },
  });
  // 现状：`voice-context.js` 只判断 event.type 与会话身份，不判断 source.kind，因此观察快照
  // 也会把噪声门的「对话窗口」续期。它不发声、不建回应组，但会改变下一句孤立语气词的投递判定。
  assert.ok(services.voiceContextAt > 0, '快照消息刷新了 voiceContextAt');
  services.voiceContextAt = 0;
  handler({ id: target }, userMessage('user-voice', '正常说话', 1));
  assert.ok(services.voiceContextAt > 0, '真 user 消息同样刷新（对照）');
  await delay(5);
  console.log(`[5] snapshotRefreshesVoiceContext=true reason=source-kind-not-checked`);
});

// ---------------------------------------------------------------------------
// 6. 隐私
// ---------------------------------------------------------------------------

test('6. 隐私：只锁视觉采集，不抑制语音观察快照（明确现状）', async (t) => {
  const root = await tempRoot(t, { features: { hearing: true, vision: true } });
  const buffer = createDialogueContext();
  buffer.push({ text: '第一段：门是开着的。', at: 1_000, utteranceId: 'u1' });
  const host = mountHost(root, { dialogueContext: buffer });
  t.after(() => host.close());
  const entry = entryIn(root);
  const loop = createLoopDouble();

  const before = host.assemble(entry);
  assert.ok(before.contextText('assistant:dialogue').includes('门是开着的'));
  loop.step(before);
  assert.equal(loop.state.snapshots.length, 1);

  const vision = host.tools.get('assistant_vision');
  assert.ok(vision !== undefined, 'assistant_vision 已注册');
  const set = await vision.execute({ action: 'set', mode: 'privacy' });
  assert.equal(set.ok, true, `privacy set: ${set.error ?? ''}`);
  assert.equal(set.mode, 'privacy');
  assert.equal(set.locked, true);

  // 隐私确实生效：截屏请求被拒绝。
  const see = await host.tools.get('assistant_see');
  const refused = await see.execute({ reason: 'probe' });
  assert.equal(refused.ok, false, '隐私下拒绝截屏');
  assert.match(refused.reason, /隐私/u);

  // 观察快照不受影响：同一文本、同一系统提示、快照原样保留。
  const after = host.assemble(entry);
  assert.equal(after.prompt, before.prompt, '隐私不改写系统提示');
  assert.equal(after.hash, before.hash);
  assert.equal(after.snapshot, before.snapshot, '隐私下携带同一份语音观察快照');
  assert.ok(after.contextText('assistant:dialogue').includes('门是开着的'), '语音观察仍在');
  assert.equal(after.snapshot.includes('隐私'), false, '快照不包含隐私态文本');
  assert.equal(loop.step(after).message, null, '文本未变化 → 不追加重复快照');
  assert.equal(loop.state.snapshots.length, 1);

  const events = readEvents(root);
  assert.equal(events.some((event) => event.type === 'vision.mode'
    && event.payload?.mode === 'privacy'), true, 'vision.mode 记录了隐私');

  console.log(`[6] privacyLocked=${set.locked} seeRefused=${refused.ok === false} `
    + `dialogueChars=${after.contextText('assistant:dialogue').length} snapshotKept=${after.snapshot === before.snapshot} `
    + `newSnapshots=0`);
});

// ---------------------------------------------------------------------------
// 7. 切会话
// ---------------------------------------------------------------------------

test('7. 切会话：消息不串台；同 workspace 共享观察内容，跨 workspace 不注入（现状）', async (t) => {
  const root = await tempRoot(t, { features: { hearing: true } });
  const clock = { now: 1_000_000 };
  const buffer = createDialogueContext({ now: () => clock.now });
  buffer.push({ text: '第一段：门是开着的。', at: clock.now, utteranceId: 'u1' });
  const host = mountHost(root, { dialogueContext: buffer });
  t.after(() => host.close());

  const entryA = entryIn(root);
  const entryB = entryIn(root);
  const entryOutside = { agent: { session: { header: { cwd: join(root, 'elsewhere') } } } };

  const a = host.assemble(entryA);
  const b = host.assemble(entryB);
  const c = host.assemble(entryOutside);
  assert.ok(a.contextText('assistant:dialogue').includes('门是开着的'));
  assert.equal(b.contextText('assistant:dialogue'), a.contextText('assistant:dialogue'),
    '同 workspace 的新会话看到同一份观察文本');
  assert.deepEqual(c.parts, [], '跨 workspace 不注入观察');
  assert.equal(c.snapshot, '');
  assert.equal(c.prompt.includes('门是开着的'), false);

  // 消息级：两个会话各自提交自己的快照消息，A 的消息对象不会出现在 B 的历史里。
  const loopA = createLoopDouble();
  const loopB = createLoopDouble();
  const commitA = loopA.step(a);
  const commitB = loopB.step(b);
  assert.notEqual(commitA.message, commitB.message, '各自的消息对象');
  assert.equal(loopA.state.snapshots.length, 1);
  assert.equal(loopB.state.snapshots.length, 1);
  assert.equal(commitB.message.content[0].text.includes('门是开着的'), true,
    '内容来自共享缓冲（设备连续观察的设计），不是消息串台');
  assert.equal(loopA.state.systemNodes.length, 1);
  assert.equal(loopB.state.systemNodes.length, 1);
  assert.equal(c.snapshot, '', '跨会话/跨 workspace 不产生快照消息');

  console.log(`[7] sameWorkspaceShared=${b.snapshot === a.snapshot} crossWorkspaceChars=${Array.from(c.snapshot).length} `
    + `snapshotMessagesA=${loopA.state.snapshots.length} snapshotMessagesB=${loopB.state.snapshots.length}`);
});
