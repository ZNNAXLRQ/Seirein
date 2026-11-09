/**
 * P2 回归：无命中时的「记忆检索状态」块同样是记忆内容，必须整块占用 `layerBudgets.memory`。
 *
 * 旧实现只在记忆额度为 0 时禁止状态块；额度只剩 1 字时仍注入约 80 字的状态，绕过总预算，
 * 而 `context.budget` 仍报记忆 0。这里覆盖四个边界：
 *
 *   1. 额度 0：不注入；
 *   2. 额度 1（小于状态块）：整块不注入，返回 text=''；
 *   3. 额度恰好等于状态块长度：完整注入；
 *   4. 额度大于状态块：正常注入。
 *
 * 每个用例同时断言「返回给请求的文本长度」与「contextLayers / memory.recall / context.budget
 * 报告的字符数」，避免只验证分支不验证口径。
 *
 * Run: node --test test/memory-status-budget.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { MEMORY_INJECTION_DEFAULTS, composeMemoryStatus } from '../src/host/memory/memory-injection.js';
import { createMemoryPreStep, prepareMemoryInjection } from '../src/host/memory/pre-step.js';

const MISS_QUERY = '这是一次没有时间词的普通闲聊';

/** 与无命中状态块的实际入参一致：活跃库已完成、归档未查、无时间窗、结果完整。 */
function expectedStatusText() {
  return composeMemoryStatus({
    sources: { active: 'ok', archive: 'not-run' },
    range: null,
    complete: 'complete',
  });
}

/** 无命中的最小记忆库：固定层为空，召回零命中，归档不会被查询。 */
function emptyMemory() {
  return {
    fixedMemories: () => [],
    recall: () => ({ hits: [], mode: 'keyword', roles: ['user', 'assistant'], window: 1 }),
    listArchive: () => [],
    restore: () => {},
  };
}

function eventLog() {
  const events = [];
  return {
    events,
    log: { emit: async (type, payload) => { events.push({ type, payload }); } },
  };
}

/** 直接调用 pre-step 的导出，拿到返回文本、contextLayers 与 memory.recall 日志。 */
async function prepareWithBudget(memoryBudget) {
  const { events, log } = eventLog();
  const layerBudgets = {
    fixed: MEMORY_INJECTION_DEFAULTS.maxChars,
    memory: memoryBudget,
    totalChars: MEMORY_INJECTION_DEFAULTS.maxChars + memoryBudget,
  };
  const result = await prepareMemoryInjection({
    memory: emptyMemory(),
    log,
    sessionId: 'memory-status-budget',
    turn: 1,
    query: MISS_QUERY,
    budgetMs: 1_000,
    layerBudgets,
  });
  const recall = events.find((event) => event.type === 'memory.recall')?.payload;
  assert.ok(recall !== undefined, 'memory.recall 已记录');
  return { result, recall };
}

/** 走宿主接线：确认 context.budget 与真正追加进决策的文本使用同一口径。 */
async function preStepWithBudget(memoryBudget) {
  const { events, log } = eventLog();
  const budgetRows = [];
  const stat = (chars) => ({ chars, items: chars > 0 ? 1 : 0, dropped: 0, dropReasons: {} });
  // 模拟真实提示词计划：本轮只给记忆层预留 memoryBudget 字，其余层为空，这样 context.budget
  // 走的是与缺陷现场相同的 plan 分支（记忆层 chars 取 contextLayers.total）。
  const plan = {
    lane: 'typed',
    layers: {
      persona: stat(0),
      fixed: stat(0),
      memory: { ...stat(memoryBudget), budget: memoryBudget, reserved: true },
      recent: stat(0),
      ephemeral: stat(0),
    },
    truncated: false,
    protectedOverflow: false,
    totalChars: memoryBudget,
  };
  const prep = createMemoryPreStep({
    memory: emptyMemory(),
    log,
    inScope: () => true,
    isSubagent: () => false,
    featureEnabled: () => true,
    contextBudgets: () => ({ typed: { memory: memoryBudget, totalChars: 100_000 } }),
    laneForSession: () => 'typed',
    measureLayers: () => ({ plan }),
    onContextBudget: (payload) => budgetRows.push(payload),
  });
  const agent = { id: 'status-agent', session: { id: 'status-session', header: { cwd: 'C:/x' } } };
  const message = {
    id: 'u-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: MISS_QUERY }],
  };
  const decision = await prep.handle(
    { agent, turn: 1, step: 1, signal: new AbortController().signal, messages: [message] },
    async () => ({ kind: 'enter', messages: [message] }),
  );
  const injected = (Array.isArray(decision.messages) ? decision.messages : [])
    .find((item) => item?.source?.kind === 'assistant-memory');
  const text = injected?.content?.[0]?.text ?? '';
  assert.equal(budgetRows.length, 1, '每轮只写一行 context.budget');
  return { text, contextBudget: budgetRows[0], events };
}

/** 返回文本、contextLayers、memory.recall、context.budget 四处字数必须一致。 */
function assertCharsAgree(actual, expectedChars, label) {
  assert.equal(actual.result.text.length, expectedChars, `${label}: 返回文本长度`);
  assert.equal(actual.result.contextLayers.memory.chars, expectedChars, `${label}: contextLayers 记忆层`);
  assert.equal(actual.result.contextLayers.total, expectedChars, `${label}: contextLayers 总计`);
  assert.equal(actual.recall.statusChars, expectedChars, `${label}: memory.recall.statusChars`);
  assert.equal(actual.preStep.text.length, expectedChars, `${label}: 决策里的状态文本长度`);
  assert.equal(actual.preStep.contextBudget.layers.memory.chars, expectedChars,
    `${label}: context.budget 记忆层`);
  assert.equal(actual.preStep.contextBudget.totalChars, expectedChars,
    `${label}: context.budget 总计`);
}

async function observe(memoryBudget) {
  const result = await prepareWithBudget(memoryBudget);
  const preStep = await preStepWithBudget(memoryBudget);
  return { ...result, preStep };
}

test('1. 记忆额度 0：无命中时不注入状态块，日志也报 0', async () => {
  const status = expectedStatusText();
  assert.ok(status.length > 0, '状态块本身非空');
  const actual = await observe(0);

  assert.equal(actual.result.text, '', '返回 text 为空');
  assert.equal(actual.result.reason, 'no-hit');
  assert.equal(actual.result.injected, false, '状态不是命中');
  assert.equal(actual.result.status, true, '仍标记为检索状态');
  assert.equal(actual.result.statusChars, 0);
  assert.equal(actual.recall.status, true);
  assert.equal(actual.recall.injectedChars, 0, 'injectedChars 仍表示命中记忆行，状态不是命中');
  assertCharsAgree(actual, 0, '额度 0');
  console.log(`1. 额度 0：statusBlock=${status.length} 未注入，text=0 contextLayers=0 recall.statusChars=0`);
});

test('2. 记忆额度 1（小于状态块）：整块不注入，返回 text=""，日志总计为 0', async () => {
  const status = expectedStatusText();
  assert.ok(status.length > 1, `状态块 ${status.length} 字大于 1 字额度`);
  const actual = await observe(1);

  assert.equal(actual.result.text, '', '放不下就不注入');
  assert.equal(actual.result.reason, 'no-hit');
  assert.equal(actual.result.status, true, 'status 语义保持不变');
  assert.equal(actual.result.statusChars, 0);
  assert.equal(actual.recall.statusChars, 0);
  assert.equal(actual.recall.injectedChars, 0);
  assertCharsAgree(actual, 0, '额度 1');
  console.log(`2. 额度 1 < 状态块 ${status.length}：整块不注入，text=0 contextLayers=0 context.budget=0`);
});

test('3. 记忆额度刚好等于状态块长度：完整注入并计入记忆层与总计', async () => {
  const status = expectedStatusText();
  const actual = await observe(status.length);

  assert.equal(actual.result.text, status, '恰好等于额度时注入完整状态块');
  assert.equal(actual.result.reason, 'no-hit');
  assert.equal(actual.result.injected, false, '状态不是命中');
  assert.equal(actual.result.statusChars, status.length);
  assert.equal(actual.recall.status, true);
  assert.equal(actual.recall.statusChars, status.length, '日志明确记录状态字符数');
  assert.equal(actual.recall.injectedChars, 0, 'injectedChars 语义不变：没有命中行被注入');
  assertCharsAgree(actual, status.length, '额度等于状态块');
  console.log(`3. 额度=${status.length}：完整注入，contextLayers 记忆层/总计=${status.length}，context.budget.totalChars=${status.length}`);
});

test('4. 记忆额度大于状态块：正常注入，实际长度与各处日志一致', async () => {
  const status = expectedStatusText();
  const budget = status.length + 50;
  const actual = await observe(budget);

  assert.equal(actual.result.text, status, '额度充足时注入完整状态块');
  assert.equal(actual.result.reason, 'no-hit');
  assert.equal(actual.result.injected, false);
  assert.equal(actual.result.statusChars, status.length);
  assert.equal(actual.recall.statusChars, status.length);
  assert.equal(actual.recall.injectedChars, 0);
  assertCharsAgree(actual, status.length, '额度大于状态块');
  assert.ok(actual.preStep.contextBudget.layers.memory.chars <= budget, '记忆层不超过额度');
  console.log(`4. 额度=${budget} > 状态块 ${status.length}：完整注入，实际=${actual.result.text.length}，日志一致`);
});
