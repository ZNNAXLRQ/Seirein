/**
 * F3 会话隔离验收：交流观察只属于当天陪伴会话；环境事实（机器状态）所有会话共享。
 *
 * 被验收的实现是 `src/host/index.js` 的观察门与环境 section：
 *  - `assistant:dialogue` / `assistant:nonverbal` 的 text 回调先过 `isCompanionAgent`：
 *    只有 `agent.id === voiceSessionTarget({root, rolloverHour}).sessionId` 的会话才渲染，
 *    且子代理 / 编码代理 / 身份缺失 / 身份读取异常一律为空（fail closed，空文本不产生快照）；
 *  - 新增 `assistant:environment`（order 95）只放底层机器事实：OBS 当前场景、采集来源、
 *    虚拟摄像头/设备连接状态；每条都带「来源：」与「观察于：」，取不到时间写「未知」。
 *    它不受陪伴身份限制（同 workspace 的普通会话也可见），但不放进任何观察快照。
 *
 * 假宿主与 `context-isolation.mjs` 同形：真 `apply()` + 假 `systemPrompt`（section/context 与
 * 已安装契约一致，空贡献被过滤）；hearing 只替换设备/进程层，Host 的 onUpdate → 线索路径是真的。
 * 断言一律以渲染文本、快照贡献与提交消息为准。
 *
 * 覆盖（与任务条目一一对应）：
 *   1. 同 workspace 不同 id 的普通 Web 会话 → dialogue/nonverbal 文本为空；
 *   2. 子代理 / 编码代理（origin:'subagent'、delegationDepth>0、purpose:'compaction'）→ 空；
 *   3. 身份缺失 / 读取异常 → 空且不抛；
 *   4. 旧日 `seirein-2026-11-07` → 空；
 *   5. 当天陪伴会话 → 正常文本，且与迁移前逐字一致（dialogue = buffer.render().trim()）；
 *   6. 环境事实：所有会话可见、内容一致，且含来源与观察时间（有观察时是 ISO 时间，否则「未知」）；
 *   7. 空缓冲 → 没有空贡献、没有空快照（回归）。
 *
 * Run: node --test test/observation-isolation.mjs
 * Regression: node --test test/context-isolation.mjs test/prompt-stability.mjs
 *             node --test test/dialogue-injection.mjs test/nonverbal-cue.mjs
 *             node --test test/c2-injection.mjs test/voice-lanes.mjs
 *             node test/smoke.mjs
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

import { cleanupRoot } from './helpers/cleanup.mjs';

const HEARING_URL = new URL('../src/host/hearing/hearing.js', import.meta.url).href;
const REAL_HEARING_URL = new URL('../src/host/hearing/hearing.js?observation-isolation-real', import.meta.url).href;

globalThis.__observationIsolationHearing = { onUpdate: null };

const hooks = registerHooks({
  load(url, context, next) {
    if (url !== HEARING_URL) return next(url, context);
    return {
      format: 'module',
      shortCircuit: true,
      source: `
    import * as real from ${JSON.stringify(REAL_HEARING_URL)};
    const s = globalThis.__observationIsolationHearing;
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

const { apply, voiceSessionTarget } = await import('../src/host/index.js');
const { createDialogueContext } = await import('../src/host/session/conversation/dialogueContext.js');
hooks.deregister();

after(() => {
  delete globalThis.__observationIsolationHearing;
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const WORKSPACE = (root) => join(root, 'workspace');
/** 已安装 `joinContextSections` 的固定抬头（逐字）。 */
const RUNTIME_CONTEXT_HEADER = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.';
/** Host 自己渲染的两个观察块抬头。 */
const DIALOGUE_HEADER = '【连续台词上下文｜系统观察，不是用户发言】';
const NONVERBAL_HEADER = '【系统观察·非语言线索】';
const ENVIRONMENT_HEADER = '【环境事实｜机器状态，不是对话内容';

const FEATURES = Object.freeze({
  hearing: true,
  ambient: false,
  voice: false,
  vision: true,
  subtitle: false,
  avatar: false,
  memory: false,
  fastpath: false,
});

async function tempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-observation-isolation-'));
  for (const dir of ['data', 'memory', 'workspace']) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, 'data', 'features.json'), `${JSON.stringify(FEATURES)}\n`, 'utf8');
  writeFileSync(join(root, 'data', 'settings.json'), `${JSON.stringify({
    gptSovits: { enabled: false },
    autoMemory: { enabled: false },
    // 线索位默认关闭：本套件显式打开，才能验证陪伴会话看得到、其它会话看不到。
    voice: { nonverbalCue: true },
  })}\n`, 'utf8');
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

/** 挂真 `apply()`；假 systemPrompt 与已安装契约同序装配，空贡献被过滤。 */
function mountHost(root, { dialogueContext } = {}) {
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
    asrMergeWindowMs: 10,
    ffmpegPath: process.execPath,
    ...(dialogueContext === undefined ? {} : { dialogueContext }),
  });

  const orderOf = (left, right) => left.order - right.order || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  /** 与 `SystemPrompt.assemble()` 同序：section 进 prompt，context 形成独立快照（空贡献不出现）。 */
  const assemble = (entry) => {
    const prompt = [...sections.values()]
      .sort(orderOf)
      .map((section) => (typeof section.text === 'function' ? section.text(entry) : section.text))
      .filter((text) => typeof text === 'string' && text.length > 0)
      .join('\n\n');
    const parts = [...contexts.values()]
      .sort(orderOf)
      .map((context) => ({
        name: context.name,
        text: typeof context.text === 'function' ? context.text(entry) : context.text,
      }))
      .filter((part) => typeof part.text === 'string' && part.text.length > 0);
    return {
      prompt,
      parts,
      contextText: (name) => parts.find((part) => part.name === name)?.text ?? '',
      snapshot: parts.length === 0
        ? ''
        : `${RUNTIME_CONTEXT_HEADER}\n\n${parts.map((part) => part.text).join('\n\n')}`,
    };
  };

  return {
    sections,
    contexts,
    tools,
    assemble,
    close: () => cleanupRoot(root, disposers),
  };
}

/** 当天陪伴会话：voiceSessionTarget 给出的日期 id。 */
const companionEntry = (root) => ({
  agent: { id: voiceSessionTarget({ root }).sessionId, session: { header: { cwd: WORKSPACE(root) } } },
});
/** 同 workspace 的另一个会话：id 不同，但工作目录相同。 */
const otherSessionEntry = (root, id = 'session-web-typing') => ({
  agent: { id, session: { header: { cwd: WORKSPACE(root) } } },
});
const entryWith = (root, { id, header = {} } = {}) => ({
  agent: { ...(id === undefined ? {} : { id }), session: { header: { cwd: WORKSPACE(root), ...header } } },
});

// ---------------------------------------------------------------------------
// 1. 同 workspace 不同 id 的普通会话
// ---------------------------------------------------------------------------

test('1. 同 workspace 的不同 id（普通 Web 会话）→ dialogue/nonverbal 文本为空', async (t) => {
  const root = await tempRoot(t);
  const clock = { now: 1_000_000 };
  const buffer = createDialogueContext({ now: () => clock.now });
  buffer.push({ text: '第一段：门是开着的。', at: clock.now, utteranceId: 'u1' });
  const host = mountHost(root, { dialogueContext: buffer });
  t.after(() => host.close());

  const companion = host.assemble(companionEntry(root));
  const web = host.assemble(otherSessionEntry(root));
  assert.ok(companion.contextText('assistant:dialogue').includes('门是开着的'), '陪伴会话看得到观察');
  assert.equal(web.contextText('assistant:dialogue'), '', '普通 Web 会话看不到交流观察');
  assert.equal(web.contextText('assistant:nonverbal'), '', '普通 Web 会话也看不到非语言线索');
  assert.deepEqual(web.parts, [], '普通 Web 会话不产生观察快照贡献');
  assert.equal(web.snapshot, '', '普通 Web 会话没有观察快照');
  assert.equal(web.prompt.includes('门是开着的'), false, '观察文本也不在系统提示里');

  console.log(`[1] companionDialogueChars=${Array.from(companion.contextText('assistant:dialogue')).length} `
    + `webDialogueChars=0 webParts=0 webSnapshotChars=0`);
});

// ---------------------------------------------------------------------------
// 2. 子代理 / 编码代理
// ---------------------------------------------------------------------------

test('2. 子代理 / 编码代理即使 id 等于当天陪伴 id 也不参与观察', async (t) => {
  const root = await tempRoot(t);
  const clock = { now: 2_000_000 };
  const buffer = createDialogueContext({ now: () => clock.now });
  buffer.push({ text: '第一段：门是开着的。', at: clock.now, utteranceId: 'u1' });
  const host = mountHost(root, { dialogueContext: buffer });
  t.after(() => host.close());

  const id = voiceSessionTarget({ root }).sessionId;
  const entries = {
    'origin:subagent': entryWith(root, { id, header: { origin: 'subagent' } }),
    'delegationDepth:2': entryWith(root, { id, header: { delegationDepth: 2 } }),
    'purpose:compaction': { agent: { id, options: { purpose: 'compaction' }, session: { header: { cwd: WORKSPACE(root) } } } },
  };
  for (const [label, entry] of Object.entries(entries)) {
    const assembly = host.assemble(entry);
    assert.equal(assembly.contextText('assistant:dialogue'), '', `${label} 看不到交流观察`);
    assert.equal(assembly.contextText('assistant:nonverbal'), '', `${label} 看不到非语言线索`);
    assert.deepEqual(assembly.parts, [], `${label} 不产生观察快照`);
    assert.equal(assembly.snapshot, '');
  }

  // 对照：同一 id、没有子代理标记的陪伴会话仍然正常。
  const companion = host.assemble(entryWith(root, { id }));
  assert.ok(companion.contextText('assistant:dialogue').includes('门是开着的'));

  console.log(`[2] subagentEmpty=true delegationEmpty=true compactionEmpty=true companionControl=${companion.contextText('assistant:dialogue').length > 0}`);
});

// ---------------------------------------------------------------------------
// 3. 身份缺失 / 异常
// ---------------------------------------------------------------------------

test('3. agent 身份缺失或读取异常 → 空且不抛', async (t) => {
  const root = await tempRoot(t);
  const clock = { now: 3_000_000 };
  const buffer = createDialogueContext({ now: () => clock.now });
  buffer.push({ text: '第一段：门是开着的。', at: clock.now, utteranceId: 'u1' });
  const host = mountHost(root, { dialogueContext: buffer });
  t.after(() => host.close());

  const entries = {
    'context:{}': {},
    'agent:undefined': { agent: undefined },
    'session-only (no id)': { agent: { session: { header: { cwd: WORKSPACE(root) } } } },
    'id:number': { agent: { id: 42, session: { header: { cwd: WORKSPACE(root) } } } },
  };
  for (const [label, entry] of Object.entries(entries)) {
    let assembly;
    assert.doesNotThrow(() => { assembly = host.assemble(entry); }, `${label} 不抛`);
    assert.equal(assembly.contextText('assistant:dialogue'), '', `${label} 没有交流观察`);
    assert.equal(assembly.contextText('assistant:nonverbal'), '', `${label} 没有非语言线索`);
    assert.deepEqual(assembly.parts, [], `${label} 不产生观察快照`);
  }

  // A throwing identity accessor must fail closed in the observation wrappers themselves (the
  // pre-existing `scopedText` used by other sections is not part of this gate).
  const throwing = { get agent() { throw new Error('boom'); } };
  for (const name of ['assistant:dialogue', 'assistant:nonverbal']) {
    const declaration = host.contexts.get(name);
    assert.ok(declaration !== undefined, `${name} is registered`);
    let value;
    assert.doesNotThrow(() => { value = declaration.text(throwing); }, `${name} 读取异常身份不抛`);
    assert.equal(value, '', `${name} 读取异常身份渲染空`);
  }

  console.log('[3] missingIdentityEmpty=true throwingIdentityEmpty=true noThrow=true');
});

// ---------------------------------------------------------------------------
// 4. 旧日 dated session
// ---------------------------------------------------------------------------

test('4. 旧日 seirein-*（2026-11-07）→ 空；换日只认当天 id', async (t) => {
  const root = await tempRoot(t);
  const clock = { now: 4_000_000 };
  const buffer = createDialogueContext({ now: () => clock.now });
  buffer.push({ text: '第一段：门是开着的。', at: clock.now, utteranceId: 'u1' });
  const host = mountHost(root, { dialogueContext: buffer });
  t.after(() => host.close());

  const today = voiceSessionTarget({ root }).sessionId;
  const oldDay = 'seirein-2026-11-07';
  assert.notEqual(oldDay, today, '夹具：旧日 id 不是今天');
  const old = host.assemble(entryWith(root, { id: oldDay }));
  assert.equal(old.contextText('assistant:dialogue'), '', '旧日会话看不到今天的观察');
  assert.equal(old.contextText('assistant:nonverbal'), '');
  assert.deepEqual(old.parts, [], '旧日会话不产生观察快照');
  assert.equal(old.snapshot, '');

  const companion = host.assemble(entryWith(root, { id: today }));
  assert.ok(companion.contextText('assistant:dialogue').includes('门是开着的'), '当天会话仍然正常');

  console.log(`[4] today=${today} oldDay=${oldDay} oldEmpty=true companionChars=${Array.from(companion.contextText('assistant:dialogue')).length}`);
});

// ---------------------------------------------------------------------------
// 5. 当天陪伴会话：正常文本，逐字一致
// ---------------------------------------------------------------------------

test('5. 当天陪伴会话 → dialogue 与迁移前逐字一致；非语言线索正常', async (t) => {
  const root = await tempRoot(t);
  const clock = { now: 5_000_000 };
  const buffer = createDialogueContext({ now: () => clock.now });
  buffer.push({ text: '钥匙在柜子里，', at: clock.now, utteranceId: 'u1' });
  clock.now += 1_000;
  buffer.push({ text: '你去拿吧。', at: clock.now, utteranceId: 'u2' });
  const host = mountHost(root, { dialogueContext: buffer });
  t.after(() => host.close());

  const entry = companionEntry(root);
  const before = host.assemble(entry);
  // 迁移前 section 的正文就是 `dialogueSummary.render()`，即 buffer.render().trim()；现在被门包裹，
  // 但对陪伴会话必须逐字不变。
  const expected = buffer.render().trim();
  assert.equal(before.contextText('assistant:dialogue'), expected, 'dialogue 文本逐字一致');
  assert.ok(before.contextText('assistant:dialogue').startsWith(DIALOGUE_HEADER));
  assert.equal(before.prompt.includes(expected), false, '观察仍不进系统提示');

  // 真 Host 的听觉入口（假 hearing 只替换设备层）：Laughter 标签 → cue → 陪伴会话可见。
  const listen = host.tools.get('assistant_listen');
  assert.ok(listen !== undefined, 'assistant_listen 已注册');
  const started = await listen.execute({ action: 'start' });
  assert.equal(started.ok, true, `listening started: ${started.error ?? ''}`);
  const hearingState = globalThis.__observationIsolationHearing;
  assert.equal(typeof hearingState.onUpdate, 'function', 'hearing 暴露 onUpdate');
  hearingState.onUpdate({
    durationMs: 100,
    final: '哈哈',
    event: '<|Laughter|>',
    eventClean: 'Laughter',
    source: 'mic',
    utteranceId: 11,
  });
  await untilEvents(root, (all) => all.some((event) => event.type === 'voice.nonverbal.cue'), 'voice.nonverbal.cue');

  const withCue = host.assemble(entry);
  const nonverbal = withCue.contextText('assistant:nonverbal');
  assert.ok(nonverbal.startsWith(NONVERBAL_HEADER), '线索块以固定抬头开始');
  assert.match(nonverbal, /麦克风/u, '线索自述来源是麦克风');
  assert.equal(withCue.contextText('assistant:dialogue'), expected, '线索出现不影响 dialogue 文本');
  assert.equal(withCue.parts.some((part) => part.name === 'assistant:nonverbal'), true);

  await listen.execute({ action: 'stop' });
  console.log(`[5] dialogueChars=${Array.from(expected).length} sameAsBefore=true nonverbalChars=${Array.from(nonverbal).length} cueSource=mic`);
});

// ---------------------------------------------------------------------------
// 6. 环境事实：所有会话共享，带来源与观察时间
// ---------------------------------------------------------------------------

test('6. 环境事实：所有会话可见、内容一致，且每条带来源与观察时间', async (t) => {
  const root = await tempRoot(t);
  const host = mountHost(root, { dialogueContext: createDialogueContext({ now: () => 6_000_000 }) });
  t.after(() => host.close());

  const companion = host.assemble(companionEntry(root));
  const other = host.assemble(otherSessionEntry(root));
  const id = voiceSessionTarget({ root }).sessionId;
  const subagent = host.assemble(entryWith(root, { id, header: { origin: 'subagent' } }));
  const noIdentity = host.assemble({ agent: { session: { header: { cwd: WORKSPACE(root) } } } });

  const envOf = (assembly) => {
    const start = assembly.prompt.indexOf(ENVIRONMENT_HEADER);
    assert.ok(start >= 0, '环境事实出现在系统提示里');
    return assembly.prompt.slice(start).split('\n\n')[0];
  };
  const companionEnv = envOf(companion);
  assert.equal(envOf(other), companionEnv, '普通会话看到同一份环境事实');
  assert.equal(envOf(subagent), companionEnv, '子代理也看到同一份环境事实');
  assert.equal(envOf(noIdentity), companionEnv, '身份缺失的会话也看到同一份环境事实');
  assert.ok(companionEnv.includes('OBS 当前场景：'), 'OBS 当前场景');
  assert.ok(companionEnv.includes('采集来源：'), '采集来源');
  assert.ok(companionEnv.includes('虚拟摄像头：'), '虚拟摄像头/设备连接状态');

  // 每条事实都带「来源：」与「观察于：」；取不到时间写「未知」。
  const facts = companionEnv.split('\n').filter((line) => line.startsWith('- '));
  assert.equal(facts.length, 3, '三条底层环境事实');
  for (const line of facts) {
    assert.match(line, /来源：/u, `缺少来源：${line}`);
    assert.match(line, /观察于：/u, `缺少观察时间：${line}`);
  }

  // 有观察时写入 ISO 时间：切换采集来源会让「采集来源」带上一秒级时间戳。
  const vision = host.tools.get('assistant_vision');
  assert.ok(vision !== undefined, 'assistant_vision 已注册');
  const set = await vision.execute({ action: 'set', source: 'desktop' });
  assert.equal(set.ok, true, `vision set: ${set.error ?? ''}`);
  const afterObserve = host.assemble(otherSessionEntry(root));
  const observedLine = envOf(afterObserve).split('\n').find((line) => line.startsWith('- 采集来源：'));
  assert.match(observedLine, /观察于：\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/u, '有观察时记录 ISO 时间');
  assert.equal(envOf(afterObserve), envOf(host.assemble(companionEntry(root))), '时间戳也共享');

  // 环境事实是 section，不进入观察快照。
  assert.equal(afterObserve.snapshot.includes(ENVIRONMENT_HEADER), false, '环境事实不进快照');
  assert.equal(afterObserve.snapshot, '', '没有交流观察时也没有快照');

  console.log(`[6] envChars=${Array.from(companionEnv).length} facts=3 shared=4 sessions `
    + `observedAtFormat=ISO sourceLine="${observedLine.slice(0, 60)}…"`);
});

// ---------------------------------------------------------------------------
// 7. 空缓冲 → 无空快照
// ---------------------------------------------------------------------------

test('7. 空缓冲 → 没有空贡献、没有空快照（回归）', async (t) => {
  const root = await tempRoot(t);
  const clock = { now: 7_000_000 };
  const buffer = createDialogueContext({ now: () => clock.now });
  const host = mountHost(root, { dialogueContext: buffer });
  t.after(() => host.close());
  const entry = companionEntry(root);

  const empty = host.assemble(entry);
  assert.equal(empty.contextText('assistant:dialogue'), '', '空缓冲 renders empty');
  assert.equal(empty.contextText('assistant:nonverbal'), '', '没有线索');
  assert.deepEqual(empty.parts, [], '不产生任何 context 贡献');
  assert.equal(empty.snapshot, '', '不产生空快照');
  assert.equal(empty.prompt.includes(RUNTIME_CONTEXT_HEADER), false);

  // 有文本 → 有快照；清空后快照消失（不是空块）。
  buffer.push({ text: '第一段：门是开着的。', at: clock.now, utteranceId: 'u1' });
  const filled = host.assemble(entry);
  assert.notEqual(filled.snapshot, '');
  buffer.clear();
  const cleared = host.assemble(entry);
  assert.equal(cleared.contextText('assistant:dialogue'), '');
  assert.deepEqual(cleared.parts, [], '清空后没有空贡献');
  assert.equal(cleared.snapshot, '');
  assert.equal(cleared.prompt, empty.prompt, '观察的来去不改写系统提示');

  console.log(`[7] emptyParts=0 emptySnapshotChars=0 filledChars=${Array.from(filled.snapshot).length} clearedSnapshotChars=0`);
});
