/**
 * F1 验收：有条件接受运行上下文追加（2026-11-09，本轮补齐三个缺口：读时过期、渲染硬上限、丢弃可见）。
 *
 * 被验收的行为不是「快照应该 replace」——安装包 `@deepseek-ai/dsh-agent-loop` 的
 * `RuntimeContextProjection` 用 `surfaceOp:'append'` 提交快照，旧节点留在历史里；用户已改为
 * **有条件接受追加**，条件是：
 *   1. 单条快照有预算上限（此前实测约 3.5–3.6K 字符/条；本轮在渲染侧加硬上限，单条 ≤ 3700 字符）；
 *   2. 文本未变化时不追加，只有变化才新增快照；
 *   3. 过期观察不再注入：本轮在 `dialogueContext` 读时按 `now - at > maxWindowMs` 过期
 *      （recent 与 pending 同一语义，无定时器）；空闲后 `active:false, reason:'idle'` 可观测；
 *   4. 自动压缩已验证，旧快照可被压缩回收，不能只靠无限堆积；
 *   禁止：每轮追加整份系统提示；无上限堆积完整快照后全靠压缩。
 *
 * 本套件与 `context-isolation.mjs` / `prompt-stability.mjs` **不共享结论**：它自己挂一个
 * 按已安装 Harness 语义投影的假循环（追加 system 节点只在提示变化时发生；快照只在文本变化时
 * 追加；清空提交 CLEARED 标记），并把「当前快照」定义为请求时刻 `systemPrompt.context()`
 * 的渲染结果，而不是 status。
 *
 * 单位说明（重要）：源码与既有报告里的「3.5–3.6 KB」是**字符数**（`text.length` /
 * `Array.from(text).length`），不是 UTF-8 字节。中文在 UTF-8 下约 3 字节/字，所以同一条
 * 快照的字节数约为字符数的 2.6 倍。上下文预算按字符/ token 计，故断言用字符；字节数一并
 * 记录，避免把「3.6K 字符」误读成「3.6K 字节」。源码常量与注释已统一写「字符」。
 *
 * 硬上限的实现选择：**渲染侧**（`dialogueContext.render()`）。输入侧不切分台词，正常窗口/
 * pending/摘要的字符预算保持原样；渲染时整块按 `maxRenderChars`（默认 3600 字符，给 Harness
 * 固定抬头留余量）硬截断，旧台词被省略时块首出现「已省略 N 字符」标记，
 * `snapshot().truncated / truncatedChars` 与 `stats().truncatedChars` 报告丢弃量。这样单条
 * 超长台词与大量碎片行的行首标签开销都不能绕过预算。
 *
 * 覆盖：
 *   1.  饱和缓冲（最近窗口 + pending + 400 字摘要）的单条快照大小（原 3633 字符，硬上限不改变它）；
 *   1b. 硬上限：单条 5000 字台词 → 快照 ≤ 3700 字符，truncated/droppedChars 明确；
 *   1c. 硬上限：3000 条碎片行 → 快照 ≤ 3700 字符，碎片行不能绕过；
 *   2.  文本不变 → 不追加；新增一行 → 恰好 +1 条；
 *   3a. clear 后当前快照无旧内容，Harness 提交 CLEARED 标记；
 *   3b. 读时过期：空闲超过 maxWindowMs 后旧观察不再注入（未超时仍注入）；active/reason 可观测；
 *   3b2. pending 过期：过期 pending 不再进入快照或摘要请求（内部记录仍可保留）；
 *   3c. 非语言线索的五分钟 TTL（对照：已有过期机制）；
 *   4.  12 轮对话：系统提示哈希/文本/系统节点数不变；
 *   5.  旧 runtime-context 快照可被压缩 shadow（合成契约；真实 range 选择需宿主层验证）；
 *   6.  容量接近阈值时的告警条件（改用 `stats()` 的丢弃/截断/过期字段）。
 *
 * Run: node --test test/context-budget.mjs
 * Regression: node --test test/context-isolation.mjs test/prompt-stability.mjs test/dialogue-injection.mjs
 *             node --test test/dialogue-context.mjs test/dialogue-capture.mjs
 *             node test/smoke.mjs
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DIALOGUE_INJECTION_ORDER, apply, voiceSessionTarget } from '../src/host/index.js';
import { createDialogueContext, DIALOGUE_CONTEXT_DEFAULTS } from '../src/host/session/conversation/dialogueContext.js';
import { createNonverbalCue, NONVERBAL_CUE_TTL_MS } from '../src/host/hearing/nonverbal-cue.js';
import {
  VOICE_COMPACTION_PRESET,
  VOICE_COMPACTION_PRESET_ID,
  createVoiceCompaction,
} from '../src/host/session/compaction/voice-compaction.js';
import { cleanupRoot } from './helpers/cleanup.mjs';

/** 安装包里 `joinContextSections` 的固定抬头（逐字）。 */
const RUNTIME_CONTEXT_HEADER = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.';
/** 安装包里文本清空时提交的标记；不是空消息。 */
const RUNTIME_CONTEXT_CLEARED = 'Current runtime context: none. Earlier runtime-context snapshots no longer apply.';
/** Host 自己渲染的台词块抬头，用于确认观察来源可归因。 */
const DIALOGUE_HEADER = '【连续台词上下文｜系统观察，不是用户发言】';

/**
 * 单条快照的验收上限（字符）。用户口径「约 3.5–3.6K/条」，取 3700 作为硬上限，
 * 留约 70 字符余量；字节上限按中文 3 字节/字换算为 12K，仅作单位一致性保护。
 */
const SNAPSHOT_BUDGET_CHARS = 3_700;
const SNAPSHOT_BUDGET_UTF8_BYTES = 12_000;
/** 模块自己给单条观察块的上限（字符）：3700 验收预算里给 Harness 固定抬头留的余量。 */
const RENDER_BUDGET_CHARS = DIALOGUE_CONTEXT_DEFAULTS.maxRenderChars;
/** 告警骨架：接近上限 80% 预警、95% 严重。 */
const WARN_RATIO = 0.8;
const CRITICAL_RATIO = 0.95;

const FEATURES = Object.freeze({
  hearing: true,
  ambient: false,
  voice: false,
  vision: false,
  subtitle: false,
  avatar: false,
  memory: false,
  fastpath: false,
});

const sha1 = (text) => createHash('sha1').update(text).digest('hex');
const charsOf = (text) => Array.from(String(text ?? '')).length;
const bytesOf = (text) => Buffer.byteLength(String(text ?? ''), 'utf8');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const WORKSPACE = (root) => join(root, 'workspace');
const entryIn = (root) => ({
  agent: { id: voiceSessionTarget({ root }).sessionId, session: { header: { cwd: WORKSPACE(root) } } },
});

/** 临时 Host 根：features/settings 都是 JSON 文件，与真实 Host 的读取路径一致。 */
async function tempRoot(t, { features = {}, settings = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-context-budget-'));
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

async function untilEvents(root, predicate, label, timeoutMs = 4_000) {
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
 * 挂真实 `apply()`。假宿主只提供 systemPrompt（section + context）、tools 与一个会记录
 * session/event 的 `on`，与 `context-isolation.mjs` 的假宿主同形，但本文件独立实现。
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
    // 0 = 不节流：每轮的 stable/refreshed 事件都能被观察到。
    promptStabilityThrottleMs: 0,
    ffmpegPath: process.execPath,
    ...(dialogueContext === undefined ? {} : { dialogueContext }),
    ...config,
  });

  const orderOf = (left, right) => left.order - right.order
    || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  /** 与真实 `SystemPrompt.assemble()` 同序：先 section 拼 prompt，再 context 拼快照（空贡献不出现）。 */
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

  return {
    sections,
    contexts,
    tools,
    assemble,
    close: () => cleanupRoot(root, disposers),
  };
}

/** 已安装 `joinContextSections`：空贡献 → ''，否则固定抬头 + 各贡献空行分隔。 */
function joinSnapshot(parts) {
  const body = parts.map((part) => part.text).join('\n\n');
  return body.length === 0 ? '' : `${RUNTIME_CONTEXT_HEADER}\n\n${body}`;
}

/**
 * 假循环：只投影两条 surface 规则（见文件头）。它统计的是 Harness 真正写进历史的消息序列，
 * 不是 status。
 */
function createLoopDouble() {
  const state = {
    systemNodes: [],
    systemOps: [],
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
    state.systemNodes.push(prompt);
    return 'append';
  };
  const step = (atRequest) => {
    const systemOp = projectSystem(atRequest.prompt);
    state.systemOps.push(systemOp);
    const retained = state.snapshots.at(-1);
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

/**
 * 把默认缓冲推到饱和：
 *   - 最近窗口 ~1200 字、pending ~1200 字；
 *   - 写入一条 400 字摘要（`maxSummaryChars` 上限）；
 *   - 再推一轮，让「窗口 + pending + 摘要」同时非空。
 * 所有台词约 20–26 字，避免用极端碎片行放大行首标签。
 */
function saturateDialogue(buffer, clock, { at = 1_000_000, rounds = 200 } = {}) {
  let now = at;
  if (clock !== undefined) clock.now = at;
  const line = '这是一段用于填满最近原文窗口的连续台词。';
  for (let index = 0; index < rounds; index += 1) {
    now += 500;
    if (clock !== undefined) clock.now = now;
    buffer.push({ text: `第${index}段：${line}`, at: now, utteranceId: `u${index}` });
  }
  const before = buffer.snapshot();
  const summary = '摘要内容'.repeat(100); // 正好 400 字
  const applied = buffer.applySummary(summary, {
    through: before.pendingSerial,
    generation: before.generation,
  });
  assert.equal(applied.ok, true, '测试夹具：400 字摘要应被接受');
  for (let index = 0; index < rounds; index += 1) {
    now += 500;
    if (clock !== undefined) clock.now = now;
    buffer.push({ text: `新第${index}段：${line}`, at: now, utteranceId: `v${index}` });
  }
  return now;
}

/** 预算告警谓词（测试内）；src 已暴露 stats()/快照统计，但本轮不接线事件。 */
function budgetAlarm(input = {}) {
  const reasons = [];
  const snapshotChars = Number(input.snapshotChars ?? 0);
  const budgetChars = Number(input.budgetChars ?? SNAPSHOT_BUDGET_CHARS);
  const ratio = budgetChars > 0 ? snapshotChars / budgetChars : 0;
  if (ratio >= CRITICAL_RATIO) reasons.push('critical-snapshot-size');
  else if (ratio >= WARN_RATIO) reasons.push('warn-snapshot-size');
  if (Number(input.droppedPendingChars ?? 0) > 0) reasons.push('pending-dropped-without-summary');
  const maxPendingChars = Number(input.maxPendingChars ?? 0);
  const pendingChars = Number(input.pendingChars ?? 0);
  if (maxPendingChars > 0 && pendingChars >= maxPendingChars) reasons.push('pending-at-cap');
  const maxSummaryChars = Number(input.maxSummaryChars ?? 0);
  const summaryChars = Number(input.summaryChars ?? 0);
  if (maxSummaryChars > 0 && summaryChars >= maxSummaryChars) reasons.push('summary-at-cap');
  if (Number(input.consecutiveAtCap ?? 0) >= 3) reasons.push('sustained-at-cap');
  return reasons;
}

// ---------------------------------------------------------------------------
// 1. 单条快照预算
// ---------------------------------------------------------------------------

test('1. 单条快照预算：饱和缓冲下原值 3633 字符保持不变（同时记录 UTF-8 字节）', async (t) => {
  const root = await tempRoot(t);
  const clock = { now: 1_000_000 };
  const buffer = createDialogueContext({ now: () => clock.now });
  saturateDialogue(buffer, clock);
  const host = mountHost(root, { dialogueContext: buffer });
  t.after(() => host.close());

  const assembly = host.assemble(entryIn(root));
  const dialogue = assembly.contextText('assistant:dialogue');
  const snapshot = buffer.snapshot();
  const dialogueChars = charsOf(dialogue);
  const fullChars = charsOf(assembly.snapshot);
  const fullBytes = bytesOf(assembly.snapshot);

  // 夹具确实饱和：窗口、pending、摘要同时非空，且台词块已接近 3.5K。
  assert.ok(dialogueChars > 3_000, `夹具未饱和：dialogueChars=${dialogueChars}`);
  assert.equal(snapshot.summaryChars, 400, '摘要达到 400 字上限');
  assert.ok(snapshot.recentChars <= snapshot.limits.maxChars, '最近窗口不超过 maxChars');
  assert.ok(snapshot.pendingChars <= snapshot.limits.maxPendingChars, 'pending 不超过 maxPendingChars');
  assert.ok(snapshot.summaryChars <= snapshot.limits.maxSummaryChars, '摘要不超过 maxSummaryChars');
  assert.equal(snapshot.expired, 0, '饱和夹具没有过期项');
  assert.equal(snapshot.active, true);
  assert.equal(assembly.snapshot.startsWith(RUNTIME_CONTEXT_HEADER), true);
  assert.equal(dialogue.startsWith(DIALOGUE_HEADER), true, '观察块带来源抬头');
  assert.equal(dialogue.includes('摘要内容'), true, '摘要进入快照');

  // 正常饱和行为不因硬上限/读时过期而改变：仍是原来的 3633 字符，且未触发截断。
  assert.equal(fullChars, 3_633, '正常饱和快照仍为 3633 字符（原值，不被硬上限改写）');
  assert.equal(snapshot.truncated, false, '正常饱和不触发渲染硬上限');
  assert.equal(snapshot.truncatedChars, 0);
  assert.equal(snapshot.renderChars, dialogueChars, 'snapshot.renderChars 与实际渲染字符数一致');
  assert.ok(fullChars <= SNAPSHOT_BUDGET_CHARS,
    `单条快照 ${fullChars} 字符超过上限 ${SNAPSHOT_BUDGET_CHARS}`);
  assert.ok(fullBytes <= SNAPSHOT_BUDGET_UTF8_BYTES,
    `单条快照 ${fullBytes} UTF-8 字节超过同单位上限 ${SNAPSHOT_BUDGET_UTF8_BYTES}`);

  console.log(`[1] snapshotChars=${fullChars}/${SNAPSHOT_BUDGET_CHARS} snapshotUtf8Bytes=${fullBytes}/${SNAPSHOT_BUDGET_UTF8_BYTES} `
    + `dialogueChars=${dialogueChars} recentChars=${snapshot.recentChars}/${snapshot.limits.maxChars} `
    + `pendingChars=${snapshot.pendingChars}/${snapshot.limits.maxPendingChars} summaryChars=${snapshot.summaryChars}/${snapshot.limits.maxSummaryChars} `
    + `truncated=${snapshot.truncated} truncatedChars=${snapshot.truncatedChars} expired=${snapshot.expired} `
    + `droppedPendingChars=${snapshot.stats.droppedPendingChars} lines=${dialogue.split('\n').length} `
    + `contextOrder=${host.contexts.get('assistant:dialogue')?.order} expectedOrder=${DIALOGUE_INJECTION_ORDER}`);
});

// ---------------------------------------------------------------------------
// 1b/1c. 硬上限（渲染侧）：单条超长台词 / 大量碎片行都不能绕过预算
// ---------------------------------------------------------------------------

test('1b. 硬上限：单条 5000 字台词 → 快照 ≤ 3700 字符，truncated/droppedChars 明确', async (t) => {
  const root = await tempRoot(t);
  const clock = { now: 1_000_000 };
  const buffer = createDialogueContext({ now: () => clock.now });
  buffer.push({ text: '长'.repeat(5_000), at: clock.now, utteranceId: 'long-1' });
  const host = mountHost(root, { dialogueContext: buffer });
  t.after(() => host.close());

  const assembly = host.assemble(entryIn(root));
  const dialogue = assembly.contextText('assistant:dialogue');
  const dialogueChars = charsOf(dialogue);
  const fullChars = charsOf(assembly.snapshot);
  const snapshot = buffer.snapshot();

  assert.ok(fullChars <= SNAPSHOT_BUDGET_CHARS,
    `单条超长台词快照 ${fullChars} 字符超过上限 ${SNAPSHOT_BUDGET_CHARS}`);
  assert.ok(dialogueChars <= RENDER_BUDGET_CHARS,
    `观察块 ${dialogueChars} 字符超过渲染上限 ${RENDER_BUDGET_CHARS}`);
  assert.equal(snapshot.truncated, true, '超长单条必须标记 truncated');
  assert.ok(snapshot.truncatedChars > 0, 'truncatedChars 必须给出明确的丢弃字符数');
  assert.equal(snapshot.renderChars, dialogueChars, 'renderChars 与实际渲染字符数一致');
  assert.equal(snapshot.stats.truncatedChars, snapshot.truncatedChars, 'stats() 暴露同一丢弃量');
  assert.equal(buffer.stats().truncatedChars, snapshot.truncatedChars);
  assert.equal(dialogue.includes('已省略'), true, '截断标记必须出现在渲染文本里');
  assert.equal(dialogue.includes('字符上限截断'), true, '标记写明这是字符上限');
  // 渲染侧方案的语义：输入不切分，recent 仍保留完整一条；只是渲染不再全量注入。
  assert.equal(snapshot.recentChars, 5_000, '输入侧保持原样（硬上限在渲染侧）');
  assert.ok(snapshot.recentChars > snapshot.limits.maxChars, '设计：单条输入可以超过 maxChars');

  console.log(`[1b] snapshotChars=${fullChars}/${SNAPSHOT_BUDGET_CHARS} dialogueChars=${dialogueChars}/${RENDER_BUDGET_CHARS} `
    + `truncated=${snapshot.truncated} droppedChars=${snapshot.truncatedChars} recentChars=${snapshot.recentChars} `
    + `renderChars=${snapshot.renderChars}`);
});

test('1c. 硬上限：3000 条碎片行 → 快照 ≤ 3700 字符，行首标签不能绕过预算', async (t) => {
  const root = await tempRoot(t);
  const clock = { now: 2_000_000 };
  const buffer = createDialogueContext({ now: () => clock.now });
  for (let index = 0; index < 3_000; index += 1) {
    clock.now += 10;
    buffer.push({ text: '字。', at: clock.now, utteranceId: `t${index}` });
  }
  const host = mountHost(root, { dialogueContext: buffer });
  t.after(() => host.close());

  const assembly = host.assemble(entryIn(root));
  const dialogue = assembly.contextText('assistant:dialogue');
  const dialogueChars = charsOf(dialogue);
  const fullChars = charsOf(assembly.snapshot);
  const snapshot = buffer.snapshot();

  assert.ok(fullChars <= SNAPSHOT_BUDGET_CHARS,
    `碎片行快照 ${fullChars} 字符超过上限 ${SNAPSHOT_BUDGET_CHARS}`);
  assert.ok(dialogueChars <= RENDER_BUDGET_CHARS,
    `碎片行观察块 ${dialogueChars} 字符超过渲染上限 ${RENDER_BUDGET_CHARS}`);
  assert.equal(snapshot.truncated, true, '碎片行必须触发硬上限');
  assert.ok(snapshot.truncatedChars > 0);
  assert.equal(snapshot.renderChars, dialogueChars);
  assert.equal(dialogue.includes('已省略'), true);
  assert.equal(snapshot.expired, 0, '3000 条碎片全部在时间窗内（读时过期没有介入）');
  assert.ok(snapshot.recentChars <= snapshot.limits.maxChars, '正文仍受 maxChars 约束');
  assert.ok(snapshot.pendingChars <= snapshot.limits.maxPendingChars, 'pending 正文仍受约束');
  assert.ok(dialogue.split('\n').length > 100, '夹具确实是大量碎片行');

  console.log(`[1c] snapshotChars=${fullChars}/${SNAPSHOT_BUDGET_CHARS} dialogueChars=${dialogueChars}/${RENDER_BUDGET_CHARS} `
    + `truncated=${snapshot.truncated} droppedChars=${snapshot.truncatedChars} lines=${dialogue.split('\n').length} `
    + `recent=${snapshot.recentChars}/${snapshot.limits.maxChars} pending=${snapshot.pendingChars}/${snapshot.limits.maxPendingChars}`);
});

// ---------------------------------------------------------------------------
// 2. 未变化不追加
// ---------------------------------------------------------------------------

test('2. 文本未变化不追加；新增一行恰好 +1 条', async (t) => {
  const root = await tempRoot(t);
  const buffer = createDialogueContext({ now: () => 1_000 });
  buffer.push({ text: '第一段：门是开着的。', at: 1_000, utteranceId: 'u1' });
  const host = mountHost(root, { dialogueContext: buffer });
  t.after(() => host.close());
  const entry = entryIn(root);
  const loop = createLoopDouble();

  const first = host.assemble(entry);
  const firstCommit = loop.step(first);
  assert.ok(firstCommit.message, '首次装配提交一条快照');
  assert.equal(firstCommit.systemOp, 'first');
  const firstChars = charsOf(first.contextText('assistant:dialogue'));
  assert.ok(firstChars > 0);

  const initialEvents = await untilEvents(
    root,
    (all) => all.some((event) => event.type === 'assistant.context.refreshed'
      && event.payload?.name === 'assistant:dialogue'
      && event.payload?.chars === firstChars),
    'initial dialogue refreshed event',
  );
  const initialRefreshed = initialEvents.filter((event) => event.type === 'assistant.context.refreshed'
    && event.payload?.name === 'assistant:dialogue').length;

  // 同一缓冲连续两次装配：文本相同 → 不追加消息，也不产生新的 refreshed 事件。
  const secondCommit = loop.step(host.assemble(entry));
  const thirdCommit = loop.step(host.assemble(entry));
  assert.equal(secondCommit.message, null, '文本未变化 → 第二次不追加');
  assert.equal(thirdCommit.message, null, '文本未变化 → 第三次不追加');
  assert.equal(secondCommit.systemOp, 'none', '未变化不追加系统节点');
  assert.equal(thirdCommit.systemOp, 'none');
  assert.equal(loop.state.snapshots.length, 1, '历史里仍只有一条快照');
  assert.equal(loop.state.systemNodes.length, 1, '历史里仍只有一个系统节点');

  await delay(80);
  const afterRepeatRefreshed = readEvents(root).filter((event) => event.type === 'assistant.context.refreshed'
    && event.payload?.name === 'assistant:dialogue').length;
  assert.equal(afterRepeatRefreshed, initialRefreshed, '未变化的装配不产生额外 refreshed 事件');

  // 对照：缓冲增加一行 → 恰好新增 1 条快照，文本包含新行。
  buffer.push({ text: '第二段：屋里没有人。', at: 2_000, utteranceId: 'u2' });
  const changed = host.assemble(entry);
  const changedChars = charsOf(changed.contextText('assistant:dialogue'));
  const changedCommit = loop.step(changed);
  assert.ok(changedCommit.message, '文本变化 → 追加一条');
  assert.equal(changedCommit.systemOp, 'none', '快照变化不改写系统提示');
  assert.equal(loop.state.snapshots.length, 2, '恰好 +1 条');
  assert.ok(changedCommit.message.content[0].text.includes('第二段：屋里没有人。'));
  assert.ok(changedCommit.message.content[0].text.includes('第一段：门是开着的。'), '快照是累积窗口');
  assert.equal(changedCommit.message.source.kind, 'runtime-context');
  assert.deepEqual(changedCommit.message.source.sections.map((section) => section.name), ['assistant:dialogue']);

  const changedEvents = await untilEvents(
    root,
    (all) => all.some((event) => event.type === 'assistant.context.refreshed'
      && event.payload?.name === 'assistant:dialogue'
      && event.payload?.chars === changedChars),
    'changed dialogue refreshed event',
  );
  const finalRefreshed = changedEvents.filter((event) => event.type === 'assistant.context.refreshed'
    && event.payload?.name === 'assistant:dialogue').length;
  assert.equal(finalRefreshed, initialRefreshed + 1, '文本变化恰好 +1 个 refreshed 事件');
  assert.equal(loop.state.systemNodes.length, 1);

  console.log(`[2] unchangedAppends=0 changedAppends=1 snapshots=${loop.state.snapshots.length} `
    + `systemNodes=${loop.state.systemNodes.length} refreshedEvents=${initialRefreshed}→${finalRefreshed} `
    + `chars=${firstChars}→${changedChars}`);
});

// ---------------------------------------------------------------------------
// 3a. clear 后旧观察不进入当前快照
// ---------------------------------------------------------------------------

test('3a. clear 后当前快照无旧内容；Harness 提交 CLEARED 标记', async (t) => {
  const root = await tempRoot(t);
  const buffer = createDialogueContext({ now: () => 1_000 });
  buffer.push({ text: '第一段：门是开着的。', at: 1_000, utteranceId: 'u1' });
  const host = mountHost(root, { dialogueContext: buffer });
  t.after(() => host.close());
  const entry = entryIn(root);
  const loop = createLoopDouble();

  const before = host.assemble(entry);
  loop.step(before);
  assert.equal(loop.state.snapshots.length, 1);
  const oldText = before.contextText('assistant:dialogue');
  assert.ok(oldText.includes('门是开着的'));

  buffer.clear();
  const cleared = host.assemble(entry);
  assert.deepEqual(cleared.parts, [], '空缓冲不产生 context 贡献');
  assert.equal(cleared.snapshot, '', '空缓冲不产生快照文本');
  assert.equal(cleared.contextText('assistant:dialogue'), '');
  assert.equal(cleared.snapshot.includes('门是开着的'), false, '当前快照没有旧内容');
  assert.equal(cleared.prompt, before.prompt, '清空不改写系统提示');
  assert.equal(cleared.hash, before.hash);

  const clearedCommit = loop.step(cleared);
  assert.ok(clearedCommit.message, '已存在快照时清空提交一条标记消息');
  assert.equal(clearedCommit.message.content[0].text, RUNTIME_CONTEXT_CLEARED);
  assert.equal(clearedCommit.message.content[0].text.includes('门是开着的'), false);
  assert.equal(clearedCommit.message.source.kind, 'runtime-context');
  assert.equal(clearedCommit.message.source.sections, undefined, '清空标记没有可归因贡献');
  assert.equal(loop.state.cleared, 1);
  assert.equal(loop.state.snapshots.length, 2);
  assert.equal(loop.state.systemNodes.length, 1);

  console.log(`[3a] clearedMarkerChars=${charsOf(RUNTIME_CONTEXT_CLEARED)} oldTextInCurrent=false `
    + `snapshots=${loop.state.snapshots.length} cleared=${loop.state.cleared} promptStable=${cleared.hash === before.hash}`);
});

// ---------------------------------------------------------------------------
// 3b. 读时过期：空闲超过 maxWindowMs 后旧观察不再注入
// ---------------------------------------------------------------------------

test('3b. 读时过期：空闲超过 maxWindowMs 后旧台词不再进入快照；未超时仍进入', async (t) => {
  const root = await tempRoot(t);
  const clock = { now: 1_000_000 };
  const buffer = createDialogueContext({ now: () => clock.now, maxWindowMs: 5_000 });
  buffer.push({ text: '旧的一句：门是开着的。', at: clock.now, utteranceId: 'old-1' });
  const host = mountHost(root, { dialogueContext: buffer });
  t.after(() => host.close());
  const entry = entryIn(root);

  const before = host.assemble(entry);
  assert.ok(before.contextText('assistant:dialogue').includes('门是开着的'), '夹具：旧观察开始可见');
  assert.equal(buffer.snapshot().active, true);
  assert.equal(buffer.snapshot().expired, 0);

  // 未超时（4 s < 5 s）仍然注入：过期只发生在超过 maxWindowMs 之后。
  clock.now += 4_000;
  const within = host.assemble(entry);
  assert.ok(within.contextText('assistant:dialogue').includes('门是开着的'), 'maxWindowMs 内旧观察仍然可见');
  assert.equal(buffer.snapshot().expired, 0);
  assert.equal(buffer.snapshot().active, true);

  // 空闲 10 分钟，远超 maxWindowMs=5s；没有新台词，也没有 clear()。
  clock.now += 10 * 60_000;
  const after = host.assemble(entry);
  assert.equal(after.contextText('assistant:dialogue'), '', '空闲超过 maxWindowMs 后观察块不再注入');
  assert.equal(after.snapshot.includes('门是开着的'), false);
  const gone = buffer.snapshot();
  assert.equal(gone.recent.length, 0, '过期 recent 不再出现在快照里');
  assert.equal(gone.expired, 1, 'stats/快照暴露过期数量');
  assert.equal(gone.active, false, 'active:false 供上层发 idle 事件');
  assert.equal(gone.reason, 'idle', "reason:'idle'");
  assert.equal(gone.stats.expired, 1);
  assert.equal(gone.stats.active, false);
  assert.equal(gone.stats.reason, 'idle');
  assert.equal(buffer.stats().active, false);
  assert.equal(buffer.render(), '', 'render() 与 snapshot() 同语义：不再渲染旧观察');

  // 新台词到达后只注入新内容：旧记录仍被隐藏，不会被新 push 带回快照。
  clock.now += 1_000;
  buffer.push({ text: '新的一句：灯亮了。', at: clock.now, utteranceId: 'new-1' });
  const fresh = buffer.snapshot();
  assert.equal(fresh.active, true, '有新内容后重新 active');
  assert.equal(fresh.expired, 1, '旧记录仍计为过期（内部保留，但不注入）');
  assert.equal(buffer.render().includes('门是开着的'), false);
  assert.equal(buffer.render().includes('灯亮了'), true);

  console.log(`[3b] withinWindowKept=true idleHidden=true expired=${gone.expired} active=${gone.active} `
    + `reason=${gone.reason} afterIdleChars=${charsOf(after.snapshot)} freshExpired=${fresh.expired} `
    + `afterNewPushHasOld=${buffer.render().includes('门是开着的')}`);
});

// ---------------------------------------------------------------------------
// 3b2. pending 过期：已滚出窗口的 pending 同样不得注入
// ---------------------------------------------------------------------------

test('3b2. pending 过期：过期 pending 不再进入快照或摘要请求（内部记录可保留）', async () => {
  const clock = { now: 2_000_000 };
  const buffer = createDialogueContext({
    now: () => clock.now,
    maxWindowMs: 5_000,
    maxChars: 1,
    summaryEveryChars: 100,
  });
  buffer.push({ text: '先说的旧句。', at: clock.now, utteranceId: 'p-old' });
  clock.now += 1_000;
  buffer.push({ text: '后说的新句。', at: clock.now, utteranceId: 'p-new' });

  const before = buffer.snapshot();
  assert.deepEqual(before.pending.map((item) => item.text), ['先说的旧句。'], '夹具：旧句已滚进 pending');
  assert.deepEqual(before.recent.map((item) => item.text), ['后说的新句。']);
  assert.equal(before.expired, 0);
  assert.equal(before.active, true);

  // 旧句年龄 5.5 s > 5 s（过期）；新句年龄 4.5 s（仍在窗口内）。
  clock.now += 4_500;
  const after = buffer.snapshot();
  assert.equal(after.pending.length, 0, '过期 pending 不进入快照');
  assert.equal(after.pendingChars, 0);
  assert.equal(after.expired, 1);
  assert.equal(after.active, true, '仍有未过期的新句，所以不是 idle');
  assert.equal(after.needsSummary, false, '过期 pending 不再触发摘要');
  assert.equal(buffer.needsSummary(), false);
  assert.deepEqual(after.pendingBySource, [], '摘要请求读不到过期 pending');
  assert.equal(after.stats.expired, 1);
  assert.equal(after.stats.pendingChars, 0);
  assert.equal(after.pendingSerial, 1, '内部记录仍保留（版本号可观测），只是不注入');

  const rendered = buffer.render();
  assert.equal(rendered.includes('先说的旧句。'), false, '过期 pending 不得注入');
  assert.equal(rendered.includes('后说的新句。'), true, '未过期的新句仍然注入');

  console.log(`[3b2] pendingBefore=1 pendingAfter=${after.pending.length} expired=${after.expired} `
    + `active=${after.active} needsSummary=${after.needsSummary} pendingSerial=${after.pendingSerial} `
    + `oldInjected=${rendered.includes('先说的旧句。')} newInjected=${rendered.includes('后说的新句。')}`);
});

// ---------------------------------------------------------------------------
// 3c. 非语言线索 TTL（对照：已有过期机制）
// ---------------------------------------------------------------------------

test('3c. 非语言线索 TTL 到期后不再注入（对照：过期机制已存在）', async () => {
  let now = 1_000_000;
  const cue = createNonverbalCue({
    enabled: () => true,
    now: () => now,
    sessionId: () => 'sess-cue',
  });
  const observed = cue.observe({ tag: '<|Laughter|>', source: 'mic', audioKey: 'a1' });
  assert.ok(observed, '夹具：线索已建立');
  const before = cue.render();
  assert.ok(before.length > 0, 'TTL 内注入线索');

  now += NONVERBAL_CUE_TTL_MS;
  const after = cue.render();
  assert.equal(after, '', 'TTL 到期后不再注入');
  assert.equal(cue.cue, null, '过期时槽位被清空');

  console.log(`[3c] ttlMs=${NONVERBAL_CUE_TTL_MS} beforeChars=${charsOf(before)} afterChars=0 cueAfter=null`);
});

// ---------------------------------------------------------------------------
// 4. 不追加系统提示
// ---------------------------------------------------------------------------

test('4. 12 轮对话不追加系统提示：哈希/文本/系统节点数稳定', async (t) => {
  const root = await tempRoot(t);
  const clock = { now: 1_000 };
  const buffer = createDialogueContext({ now: () => clock.now });
  const host = mountHost(root, { dialogueContext: buffer });
  t.after(() => host.close());
  const entry = entryIn(root);
  const loop = createLoopDouble();
  const rounds = [];

  for (let index = 0; index < 12; index += 1) {
    clock.now = 1_000 + index * 1_000;
    buffer.push({ text: `第${index}轮：这是一句会改变观察但不改变系统提示的台词。`, at: clock.now, utteranceId: `u${index}` });
    const assembly = host.assemble(entry);
    const commit = loop.step(assembly);
    rounds.push({ assembly, commit });
  }

  const hashes = new Set(rounds.map((round) => round.assembly.hash));
  const prompts = new Set(rounds.map((round) => round.assembly.prompt));
  assert.equal(hashes.size, 1, '12 轮系统提示哈希相同');
  assert.equal(prompts.size, 1, '12 轮系统提示文本逐字相同');
  assert.equal(loop.state.systemNodes.length, 1, '历史里只有 1 个系统节点');
  assert.deepEqual(loop.state.systemOps, ['first', ...Array(11).fill('none')], '首轮之后零追加');
  assert.equal(rounds[0].assembly.prompt.includes('第0轮'), false, '台词不进入系统提示');
  assert.equal(rounds.every((round) => round.assembly.prompt === rounds[0].assembly.prompt), true);

  // 快照侧：每轮文本都变化，所以每轮 +1 条；这是条件 2 的对照，不是系统提示追加。
  assert.equal(loop.state.snapshots.length, 12, '12 轮 12 条快照（每轮文本都变化）');
  assert.equal(rounds.every((round) => round.commit.message !== null), true);
  assert.equal(loop.state.cleared, 0);

  const events = await untilEvents(
    root,
    (all) => all.filter((event) => event.type === 'assistant.prompt.changed').length >= 1
      && all.filter((event) => event.type === 'assistant.prompt.stable').length >= 11,
    'prompt changed once + stable 11 times',
  );
  const changed = events.filter((event) => event.type === 'assistant.prompt.changed').length;
  const stable = events.filter((event) => event.type === 'assistant.prompt.stable').length;
  assert.equal(changed, 1, 'prompt.changed 只出现一次');
  assert.ok(stable >= 11, `之后每轮 stable（实际 ${stable}）`);

  const snapshotChars = snapshotTexts(loop).map((text) => charsOf(text));
  const totalSnapshotChars = snapshotChars.reduce((total, chars) => total + chars, 0);
  console.log(`[4] promptChars=${charsOf(rounds[0].assembly.prompt)} promptHash=${rounds[0].assembly.hash} `
    + `systemNodes=1 appendedSystem=0 changed=${changed} stable=${stable} snapshots=12 `
    + `snapshotChars=${snapshotChars.join('+')} total=${totalSnapshotChars}`);
});

// ---------------------------------------------------------------------------
// 5. 压缩可回收：合成契约 + 宿主层验证缺口
// ---------------------------------------------------------------------------

/**
 * 合成 surface：只保留压缩测试需要的形状。真实 surface 的 append/replace fold 由
 * `@deepseek-ai/dsh-session` 提供，本测试不假装自己运行了它。
 */
function createSurfaceFixture() {
  const nodes = [
    { seq: 1, type: 'system/message', role: 'system', text: 'system' },
    { seq: 2, type: 'user/message', role: 'user', source: { kind: 'runtime-context', form: 'snapshot' }, text: 'snapshot-1' },
    { seq: 3, type: 'user/message', role: 'user', source: { kind: 'user' }, text: 'user-1' },
    { seq: 4, type: 'assistant/message', role: 'assistant', text: 'reply-1' },
    { seq: 5, type: 'user/message', role: 'user', source: { kind: 'runtime-context', form: 'snapshot' }, text: 'snapshot-2' },
    { seq: 6, type: 'user/message', role: 'user', source: { kind: 'user' }, text: 'user-2' },
    { seq: 7, type: 'assistant/message', role: 'assistant', text: 'reply-2' },
    { seq: 8, type: 'user/message', role: 'user', source: { kind: 'runtime-context', form: 'snapshot' }, text: 'snapshot-3' },
    { seq: 9, type: 'user/message', role: 'user', source: { kind: 'user' }, text: 'user-3' },
    { seq: 10, type: 'assistant/message', role: 'assistant', text: 'reply-3' },
  ];
  const session = {
    nodes,
    get surface() {
      return { nodes: nodes.map((node) => node.seq) };
    },
  };
  /**
   * 假压缩服务：按已安装 `selectCompactableRange` 的公开语义（首个非 system 节点到保留尾部
   * 之前，不按 source.kind 排除）选取区间，然后用一条 summary 节点替换。它只证明「旧快照
   * 不是被插件钉住的、可以被 shadow」，不证明宿主真压缩。
   */
  const service = {
    async compactNow() {
      const first = 1; // 跳过 system 节点 1
      const keepFrom = nodes.length - 3; // 保留最后 3 条（snapshot-3 / user-3 / reply-3）
      const shadowedSeqs = nodes.slice(first, keepFrom).map((node) => node.seq);
      const summary = {
        seq: nodes[first].seq,
        type: 'user/message',
        role: 'user',
        source: { kind: 'compact-checkpoint' },
        text: '<compacted-summary>',
      };
      nodes.splice(first, keepFrom - first, summary);
      return { shadowedSeqs, summarySeq: summary.seq };
    },
    measure: () => ({ totalTokens: 0, nodes: [] }),
  };
  const registry = {
    definitions: new Map([[VOICE_COMPACTION_PRESET_ID, VOICE_COMPACTION_PRESET]]),
    async register() {
      throw new Error('fixture already declares the preset');
    },
    async mount() {
      return { id: VOICE_COMPACTION_PRESET_ID };
    },
    composedPreset: () => VOICE_COMPACTION_PRESET_ID,
    serviceFor: () => service,
    presetForSession: () => VOICE_COMPACTION_PRESET_ID,
  };
  return { session, service, registry };
}

test('5. 旧快照可被压缩 shadow（合成契约；真实语义需宿主层验证）', async () => {
  const { session, service, registry } = createSurfaceFixture();
  const engine = createVoiceCompaction({
    getService: (name) => (name === 'agentPresets' ? registry : undefined),
    log: { emit: () => {} },
  });
  const agent = { id: 'seirein-2026-11-09', ctx: { key: 'agent-key' }, session };

  const evidence = await engine.ensure(agent, agent.ctx);
  assert.equal(evidence.ok, true, `voice agent 应挂载压缩 preset：${JSON.stringify(evidence)}`);
  assert.equal(evidence.service, true, 'serviceFor(agent, "compaction") 可读');
  assert.equal(registry.serviceFor(agent, 'compaction'), service);

  const snapshotSeqs = session.nodes
    .filter((node) => node.source?.kind === 'runtime-context')
    .map((node) => node.seq);
  assert.deepEqual(snapshotSeqs, [2, 5, 8], '快照是普通 surface 节点，未被插件特殊保留');

  const compacted = await service.compactNow(agent);
  assert.deepEqual(compacted.shadowedSeqs, [2, 3, 4, 5, 6, 7], '区间覆盖旧快照与旧对话');
  const remainingSnapshots = session.nodes
    .filter((node) => node.source?.kind === 'runtime-context')
    .map((node) => node.seq);
  assert.deepEqual(remainingSnapshots, [8], '最新快照留在保留尾部');
  assert.equal(session.nodes.find((node) => node.seq === 2)?.source.kind, 'compact-checkpoint',
    '原 snapshot-1 位置已被 summary 节点替换');
  assert.equal(session.nodes.some((node) => node.seq === 5 && node.source?.kind === 'runtime-context'), false,
    'snapshot-2 已被 shadow');
  assert.equal(session.nodes.some((node) => node.seq === 8 && node.source?.kind === 'runtime-context'), true,
    'snapshot-3 仍在');

  console.log(`[5] synthetic: shadowedSnapshots=2 keptSnapshots=1 shadowedSeqs=${compacted.shadowedSeqs.join(',')} `
    + `remainingSeqs=${session.nodes.map((node) => node.seq).join(',')} serviceReachable=true`);
});

test('5b. 真实压缩 range/shadow 语义需要宿主层验证（跳过，不伪造）', {
  skip: '本仓库只能读到 agentPresets.serviceFor()/compactNow() 接口；真实 selectCompactableRange + summary 替换在 @deepseek-ai/dsh-compaction-basic，需要 DSH 宿主层或该包的独立测试验证',
}, () => {});

// ---------------------------------------------------------------------------
// 6. 上限告警条件（消费 stats() 的可观测字段）
// ---------------------------------------------------------------------------

test('6. 容量接近阈值时的告警条件（stats() 暴露丢弃/截断/过期）', async (t) => {
  // -- 谓词本身的行为：80% 预警、95% 严重、丢弃/满 pending/满摘要/持续满仓。
  assert.deepEqual(budgetAlarm({ snapshotChars: 1_000 }), []);
  assert.deepEqual(budgetAlarm({ snapshotChars: Math.ceil(SNAPSHOT_BUDGET_CHARS * WARN_RATIO) }), ['warn-snapshot-size']);
  assert.deepEqual(budgetAlarm({ snapshotChars: Math.ceil(SNAPSHOT_BUDGET_CHARS * CRITICAL_RATIO) }), ['critical-snapshot-size']);
  assert.deepEqual(budgetAlarm({ snapshotChars: 1_000, droppedPendingChars: 1 }), ['pending-dropped-without-summary']);
  assert.deepEqual(
    budgetAlarm({ snapshotChars: 1_000, pendingChars: 1_200, maxPendingChars: 1_200, consecutiveAtCap: 3 }),
    ['pending-at-cap', 'sustained-at-cap'],
  );
  assert.deepEqual(
    budgetAlarm({ snapshotChars: 1_000, summaryChars: 400, maxSummaryChars: 400 }),
    ['summary-at-cap'],
  );

  // -- 可观测性前提：饱和缓冲的实际值能喂给上面的谓词。
  const root = await tempRoot(t);
  const clock = { now: 1_000_000 };
  const buffer = createDialogueContext({ now: () => clock.now });
  saturateDialogue(buffer, clock);
  const host = mountHost(root, { dialogueContext: buffer });
  t.after(() => host.close());
  const assembly = host.assemble(entryIn(root));
  const snapshot = buffer.snapshot();
  const snapshotChars = charsOf(assembly.snapshot);
  const actualAlarms = budgetAlarm({
    snapshotChars,
    budgetChars: SNAPSHOT_BUDGET_CHARS,
    droppedPendingChars: snapshot.stats.droppedPendingChars,
    pendingChars: snapshot.pendingChars,
    maxPendingChars: snapshot.limits.maxPendingChars,
    summaryChars: snapshot.summaryChars,
    maxSummaryChars: snapshot.limits.maxSummaryChars,
  });
  assert.ok(actualAlarms.length > 0, '饱和缓冲至少命中一个告警条件');
  assert.equal(typeof snapshot.limits.maxChars, 'number', 'limits 可读');
  assert.equal(Number.isInteger(snapshot.stats.droppedPendingChars), true, 'stats 可读');
  // 本轮新增的统计面：丢弃/截断/过期都能直接读到（本轮不做事件接线）。
  const stats = buffer.stats();
  for (const key of ['droppedPendingChars', 'truncatedChars', 'expired', 'active', 'reason', 'pendingChars', 'renderChars']) {
    assert.equal(Object.hasOwn(stats, key), true, `stats() 缺少 ${key}`);
  }
  assert.equal(stats.truncatedChars, snapshot.truncatedChars);
  assert.equal(stats.expired, 0);
  assert.equal(stats.active, true);

  // 事件面：`assistant.context.refreshed` 带 name/chars/active，可作为外部告警输入。
  const events = await untilEvents(
    root,
    (all) => all.some((event) => event.type === 'assistant.context.refreshed'
      && event.payload?.name === 'assistant:dialogue'),
    'dialogue refreshed event for alarm input',
  );
  const refreshed = events.find((event) => event.type === 'assistant.context.refreshed'
    && event.payload?.name === 'assistant:dialogue');
  assert.equal(typeof refreshed.payload.chars, 'number', 'refreshed 事件带字符数');
  assert.equal(refreshed.payload.active, true);

  console.log(`[6] alarms=${actualAlarms.join(',')} snapshotChars=${snapshotChars} budget=${SNAPSHOT_BUDGET_CHARS} `
    + `ratio=${(snapshotChars / SNAPSHOT_BUDGET_CHARS).toFixed(3)} dropped=${snapshot.stats.droppedPendingChars} `
    + `truncated=${stats.truncatedChars} expired=${stats.expired} active=${stats.active} `
    + `pending=${snapshot.pendingChars}/${snapshot.limits.maxPendingChars} summary=${snapshot.summaryChars}/${snapshot.limits.maxSummaryChars} `
    + `eventChars=${refreshed.payload.chars} statsExposed=true eventWiring=false`);
});
