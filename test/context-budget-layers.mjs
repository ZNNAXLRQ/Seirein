/**
 * P-59: layered context budgets for the three entries (voice / typed / fast path).
 *
 * Acceptance:
 *   1. normal budget: all five layers present, nothing trimmed;
 *   2. tight budget: memory/recent are trimmed first, persona/fixed stay complete and dropped is
 *      observable per layer;
 *   3. extreme: only persona/fixed fit — memory/recent/ephemeral empty, the request still exists;
 *   4. each entry uses its own budget (different config → different rows/characters);
 *   5. fast path no longer slices the joined string: trimming happens inside a layer, persona is
 *      never cut even when it alone exceeds the lane total;
 *   6. `context.budget` has the complete count-only schema and never carries body text;
 *   7. regression commands are listed in the task report (`fastpath*`, `memory-*`, `voice-lanes`,
 *      `c2-injection`, `context-budget`, `smoke`).
 *
 * Run: node --test test/context-budget-layers.mjs
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  CONTEXT_LAYER_NAMES,
  DEFAULT_CONTEXT_BUDGETS,
  assembleLayerPlan,
  buildContextBudgetPayload,
  resolveContextBudget,
  trimLayerText,
} from '../src/host/memory/context-layers.js';
import { createMemoryPreStep } from '../src/host/memory/pre-step.js';
import { MemoryStore } from '../src/host/memory/store.js';
import { apply } from '../src/host/index.js';
import { FastPath } from '../src/host/session/inference/fastpath.js';

const PERSONA_MARKER = '人设正文必须完整保留';
const FIXED_MARKER = '固定约束：先给结论';
const MEMORY_MARKER = '相关记忆正文';
const EPHEMERAL_MARKER = '临时感知：光线较暗';
const RECENT_MARKER = '最近对话';

const personaText = `## 人设\n${PERSONA_MARKER}。${'人'.repeat(80)}`;
const fixedText = `## 重要记忆（按重要性，仅本次查询参考）\n- [2026-11-01 · 固定 · 提炼] ${FIXED_MARKER}`;
const memoryLines = Array.from({ length: 6 }, (_item, index) => (
  `- [2026-11-0${index + 1} · 原文·user] ${MEMORY_MARKER}第${index}条：${'记忆'.repeat(18)}`
));
const briefText = `${fixedText}\n## 相关记忆（与本次话题相关，按匹配度排序）\n${memoryLines.join('\n')}`;
const history = Array.from({ length: 8 }, (_item, index) => ({
  role: index % 2 === 0 ? 'user' : 'assistant',
  text: `${RECENT_MARKER}第${index}行：${'对话'.repeat(18)}`,
  domain: '',
}));

/** Five-layer fixture used by the pure planner tests. */
function layerFixture() {
  return {
    persona: { items: [personaText], separator: '\n' },
    fixed: { heading: '## 固定', items: [fixedText], separator: '\n' },
    memory: {
      heading: '## 相关记忆',
      items: memoryLines,
      separator: '\n',
      keep: 'head',
    },
    recent: {
      heading: `## ${RECENT_MARKER}`,
      items: history.map((turn) => `${turn.role === 'user' ? '用户' : '你'}：${turn.text}`),
      separator: '\n',
      keep: 'tail',
    },
    ephemeral: { heading: '## 临时感知', items: [`- ${EPHEMERAL_MARKER}`], separator: '\n', keep: 'head' },
  };
}

/** A fast-path instance with every layer fed from the fixture; no LLM is ever called. */
async function fastpathFixture({ config = {}, persona = personaText, memory = briefText } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-context-layers-'));
  await mkdir(join(root, 'data'), { recursive: true });
  const events = [];
  const fastPath = new FastPath({
    root,
    config,
    getLlm: () => null,
    getSelection: () => ({ currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-flash' }) }),
    persona: { read: (which) => (which === 'user' ? '' : persona) },
    memory: { brief: () => ({ text: memory }) },
    log: { emit: async (type, payload) => { events.push({ type, payload }); } },
  });
  fastPath.history = history.map((turn) => ({ ...turn }));
  return { fastPath, events, root };
}

function fastpathEvent(events) {
  const row = events.find((event) => event.type === 'context.budget');
  assert.ok(row !== undefined, 'context.budget was emitted');
  return row.payload;
}

function assertStatShape(stat, label) {
  const expected = ['chars', 'dropped', 'dropReasons', 'items'].sort();
  assert.deepEqual(Object.keys(stat).sort(), expected, `${label} has the four count fields`);
  assert.equal(Number.isInteger(stat.chars), true, `${label}.chars is an integer`);
  assert.equal(Number.isInteger(stat.items), true, `${label}.items is an integer`);
  assert.equal(Number.isInteger(stat.dropped), true, `${label}.dropped is an integer`);
  assert.equal(typeof stat.dropReasons, 'object', `${label}.dropReasons is an object`);
}

/** The planner's internal stat carries extra protected/budget metadata; the event does not. */
function assertCountFields(stat, label) {
  for (const key of ['chars', 'items', 'dropped', 'dropReasons']) {
    assert.equal(Object.hasOwn(stat, key), true, `${label}.${key} exists`);
  }
}

// ---------------------------------------------------------------------------
// 1. normal budget: all layers, no trimming
// ---------------------------------------------------------------------------

test('1. 正常预算：五层都在、无裁剪，persona/fixed 完整', async () => {
  const budget = resolveContextBudget({ contextBudgets: {
    voice: { persona: 600, fixed: 400, memory: 600, recent: 600, ephemeral: 200, totalChars: 2_400 },
  } }, 'voice');
  const plan = assembleLayerPlan({ lane: 'voice', layers: layerFixture(), budget });

  assert.equal(plan.lane, 'voice');
  assert.equal(plan.truncated, false, 'no layer was trimmed');
  assert.equal(plan.protectedOverflow, false);
  assert.equal(plan.totalChars, plan.text.length);
  for (const name of CONTEXT_LAYER_NAMES) {
    assert.equal(plan.layers[name].dropped, 0, `${name} dropped nothing`);
    assertCountFields(plan.layers[name], name);
  }
  assert.equal(plan.layers.persona.chars, personaText.length);
  assert.ok(plan.blocks.fixed.includes(FIXED_MARKER), 'fixed content present');
  assert.ok(plan.text.includes(MEMORY_MARKER), 'memory content present');
  assert.ok(plan.text.includes(RECENT_MARKER), 'recent content present');
  assert.ok(plan.text.includes(EPHEMERAL_MARKER), 'ephemeral content present');

  // The fast path uses the same five-layer plan end to end.
  const { fastPath, events } = await fastpathFixture();
  const system = fastPath.systemPrompt('今天怎么样');
  const payload = fastpathEvent(events);
  assert.ok(system.includes(PERSONA_MARKER), 'fast path includes the full persona');
  assert.ok(system.includes(FIXED_MARKER), 'fast path includes the fixed layer');
  assert.ok(system.includes(MEMORY_MARKER), 'fast path includes the memory layer');
  assert.ok(system.includes(RECENT_MARKER), 'fast path includes the recent layer');
  assert.equal(payload.lane, 'fastpath');
  assert.equal(payload.truncated, false);
  assert.deepEqual(Object.keys(payload.layers).sort(), [...CONTEXT_LAYER_NAMES].sort());

  console.log(`[1] lane=voice totalChars=${plan.totalChars} dropped=0; `
    + `fastpath totalChars=${system.length} truncated=${payload.truncated}`);
});

// ---------------------------------------------------------------------------
// 2. tight budget: memory/recent trimmed first, persona/fixed untouched
// ---------------------------------------------------------------------------

test('2. 预算吃紧：memory/recent 先裁，persona/fixed 完整保留；dropped 可观测', () => {
  const budget = {
    lane: 'voice',
    persona: 80,
    fixed: 30,
    memory: 60,
    recent: 60,
    ephemeral: 20,
    totalChars: 500,
    configured: true,
  };
  const content = layerFixture();
  const plan = assembleLayerPlan({ lane: 'voice', layers: content, budget });
  const personaRaw = content.persona.items[0];
  const fixedRaw = content.fixed.items[0];

  // Protected layers overflow their own quota but are still rendered whole.
  assert.equal(plan.layers.persona.chars, personaRaw.length);
  assert.ok(plan.layers.persona.chars > budget.persona, 'fixture: persona over its quota');
  assert.equal(plan.blocks.persona, personaRaw, 'persona is not cut');
  assert.ok(plan.layers.fixed.chars > budget.fixed, 'fixture: fixed over its quota');
  assert.ok(plan.blocks.fixed.includes(fixedRaw), 'fixed is not cut');

  // Allocatable layers were trimmed, in priority order, and report why.
  assert.ok(plan.layers.memory.dropped > 0, `memory dropped ${plan.layers.memory.dropped}`);
  assert.ok(plan.layers.recent.dropped > 0, `recent dropped ${plan.layers.recent.dropped}`);
  assert.ok(plan.layers.memory.chars <= budget.memory, 'memory within its quota');
  assert.ok(plan.layers.recent.chars <= Math.min(budget.recent, budget.totalChars - plan.layers.persona.chars - plan.layers.fixed.chars));
  assert.equal(plan.truncated, true);
  assert.equal(plan.protectedOverflow, true, 'the protected overflow is reported separately');
  for (const name of ['memory', 'recent']) {
    assert.ok(Object.keys(plan.layers[name].dropReasons).length > 0, `${name}.dropReasons non-empty`);
    assertCountFields(plan.layers[name], name);
  }

  console.log(`[2] persona=${plan.layers.persona.chars}/${budget.persona}(kept) `
    + `fixed=${plan.layers.fixed.chars}/${budget.fixed}(kept) `
    + `memory=${plan.layers.memory.chars}/${budget.memory} dropped=${plan.layers.memory.dropped} `
    + `recent=${plan.layers.recent.chars}/${budget.recent} dropped=${plan.layers.recent.dropped} `
    + `truncated=${plan.truncated}`);
});

// ---------------------------------------------------------------------------
// 3. extreme: only persona/fixed fit
// ---------------------------------------------------------------------------

test('3. 极端：只够 persona/fixed → memory/recent/ephemeral 全空但请求仍成立', async () => {
  const budget = {
    lane: 'typed',
    persona: 10,
    fixed: 10,
    memory: 100,
    recent: 100,
    ephemeral: 100,
    totalChars: 100,
    configured: true,
  };
  const plan = assembleLayerPlan({ lane: 'typed', layers: layerFixture(), budget });
  for (const name of ['memory', 'recent', 'ephemeral']) {
    assert.equal(plan.layers[name].chars, 0, `${name} renders empty`);
    assert.equal(plan.blocks[name], '', `${name} block empty`);
    assert.ok(plan.layers[name].dropped > 0, `${name} dropped its items`);
    assert.ok(Object.keys(plan.layers[name].dropReasons).length > 0, `${name} names the reason`);
  }
  assert.ok(plan.text.includes(PERSONA_MARKER), 'persona survives');
  assert.ok(plan.text.includes(FIXED_MARKER), 'fixed survives');
  assert.ok(!plan.text.includes(MEMORY_MARKER), 'no memory text');
  assert.ok(!plan.text.includes(RECENT_MARKER), 'no recent text');
  assert.ok(!plan.text.includes(EPHEMERAL_MARKER), 'no ephemeral text');

  // The fast path still builds a non-empty request from persona + fixed alone.
  const { fastPath, events } = await fastpathFixture({
    config: { contextBudgets: { fastpath: {
      persona: 10, fixed: 10, memory: 100, recent: 100, ephemeral: 100, totalChars: 100,
    } } },
  });
  const system = fastPath.systemPrompt('极端预算');
  assert.ok(system.includes(PERSONA_MARKER), 'fast path keeps persona');
  assert.ok(system.includes(FIXED_MARKER), 'fast path keeps fixed');
  assert.ok(system.length > 0, 'a valid request still exists');
  assert.equal(fastpathEvent(events).truncated, true);
  console.log(`[3] textChars=${plan.text.length} memory/recent/ephemeral chars=0; `
    + `fastpathChars=${system.length} requestNonEmpty=true`);
});

// ---------------------------------------------------------------------------
// 4. three entries, three budgets
// ---------------------------------------------------------------------------

test('4. 三入口各自预算：voice/typed/fastpath 配置不同 → 行数/字符不同', async () => {
  const config = {
    contextBudgets: {
      voice: { persona: 400, fixed: 200, memory: 140, recent: 70, ephemeral: 10, totalChars: 300 },
      typed: { persona: 400, fixed: 200, memory: 300, recent: 300, ephemeral: 10, totalChars: 600 },
      fastpath: { persona: 400, fixed: 200, memory: 140, recent: 140, ephemeral: 10, totalChars: 420 },
    },
  };
  const plans = Object.fromEntries(['voice', 'typed', 'fastpath'].map((lane) => [
    lane,
    assembleLayerPlan({ lane, layers: layerFixture(), budget: resolveContextBudget(config, lane) }),
  ]));
  assert.equal(plans.voice.lane, 'voice');
  assert.equal(plans.typed.lane, 'typed');
  assert.equal(plans.fastpath.lane, 'fastpath');
  assert.ok(plans.typed.layers.memory.chars > plans.voice.layers.memory.chars,
    `typed memory ${plans.typed.layers.memory.chars} > voice ${plans.voice.layers.memory.chars}`);
  assert.ok(plans.voice.layers.memory.chars <= 140);
  assert.ok(plans.fastpath.layers.memory.chars <= 140);
  assert.notEqual(plans.voice.totalChars, plans.typed.totalChars, 'different lane totals give different sizes');
  assert.equal(resolveContextBudget(config, 'voice').memory, 140);
  assert.equal(resolveContextBudget(config, 'typed').memory, 300);
  assert.equal(resolveContextBudget(config, 'fastpath').memory, 140);
  assert.equal(DEFAULT_CONTEXT_BUDGETS.fastpath.totalChars, 6_000, 'fast path default remains the old 6000 envelope');

  // The same lane difference is visible at the C2 pre-step: a voice row and a typed row use their
  // own configured memory layer cap and report their own lane.
  const rows = Array.from({ length: 4 }, (_item, index) => ({
    id: `lane-${index}`,
    ts: '2026-11-01T00:00:00.000Z',
    role: 'user',
    text: `分层预算命中${index}：${'正文'.repeat(30)}`,
    importance: 60,
    clarity: 'clear',
  }));
  const seen = [];
  const prep = createMemoryPreStep({
    memory: {
      fixedMemories: () => [],
      recall: () => ({ hits: rows, mode: 'keyword', roles: ['user', 'assistant'], window: 1 }),
      listArchive: () => [],
      restore: () => {},
    },
    log: null,
    inScope: () => true,
    isSubagent: () => false,
    featureEnabled: () => true,
    contextBudgets: () => config,
    laneForSession: (sessionId) => (sessionId.startsWith('seirein-') ? 'voice' : 'typed'),
    onContextBudget: (payload) => seen.push(payload),
  });
  const run = async (sessionId, turn) => {
    const agent = { id: sessionId, session: { id: sessionId, header: { cwd: 'C:/x' } } };
    const message = { id: `u-${turn}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '之前聊了什么' }] };
    await prep.handle({ agent, turn, step: 1, signal: new AbortController().signal, messages: [message] },
      async () => ({ kind: 'enter', messages: [message] }));
  };
  await run('seirein-2026-11-09', 1);
  await run('gui-typed', 2);
  assert.equal(seen.length, 2, 'one context.budget row per prepared turn');
  assert.equal(seen[0].lane, 'voice');
  assert.equal(seen[1].lane, 'typed');
  assert.ok(seen[0].layers.memory.chars <= 140, `voice memory ${seen[0].layers.memory.chars} <= 140`);
  assert.ok(seen[1].layers.memory.chars <= 300, `typed memory ${seen[1].layers.memory.chars} <= 300`);
  assert.ok(seen[1].layers.memory.chars > seen[0].layers.memory.chars,
    `typed ${seen[1].layers.memory.chars} > voice ${seen[0].layers.memory.chars}`);

  console.log(`[4] voice=${plans.voice.totalChars} typed=${plans.typed.totalChars} fastpath=${plans.fastpath.totalChars}; `
    + `c2 voiceMemory=${seen[0].layers.memory.chars}/140 `
    + `typedMemory=${seen[1].layers.memory.chars}/300`);
});

// ---------------------------------------------------------------------------
// 5. fast path: no final-string slice; trimming is inside the layer
// ---------------------------------------------------------------------------

test('5. fastpath 不再对拼接串 slice：裁剪在层内，persona/fixed 不被挤掉', async () => {
  const { fastPath, events } = await fastpathFixture({
    config: { contextBudgets: { fastpath: {
      persona: 400, fixed: 200, memory: 150, recent: 150, ephemeral: 10, totalChars: 1_100,
    } } },
  });
  const system = fastPath.systemPrompt('预算紧张时怎么办');
  const payload = fastpathEvent(events);

  assert.ok(system.includes(PERSONA_MARKER), 'persona present in full');
  assert.ok(system.includes(FIXED_MARKER), 'fixed present in full');
  assert.equal(payload.layers.persona.dropped, 0, 'persona never dropped');
  assert.equal(payload.layers.fixed.dropped, 0, 'fixed never dropped');
  assert.ok(payload.layers.memory.dropped > 0, `memory dropped ${payload.layers.memory.dropped}`);
  assert.ok(payload.layers.recent.dropped > 0, `recent dropped ${payload.layers.recent.dropped}`);
  assert.ok(payload.layers.memory.chars <= 150);
  assert.ok(payload.layers.recent.chars <= 150);
  assert.ok(system.length <= 1_100, `layered total ${system.length} <= 1100`);

  // Every surviving memory line is whole: a line that did not fit is absent, never cut.
  const surviving = memoryLines.filter((line) => system.includes(line));
  assert.ok(surviving.length > 0, 'at least one memory line survived');
  for (const line of surviving) assert.ok(system.includes(line), 'surviving line is complete');
  assert.ok(surviving.length < memoryLines.length, 'at least one memory line was dropped whole');
  const dropped = memoryLines.find((line) => !system.includes(line));
  assert.ok(dropped !== undefined, 'a dropped line exists');
  assert.equal(system.includes(dropped.slice(0, 20)), false, 'the dropped line was not sliced into the prompt');
  assert.equal(system.endsWith('…'), false, 'the joined prompt was not string-sliced');

  // Counter-proof: persona alone can exceed the lane total, and is still complete. The old
  // `text.slice(0, 6000)` would have cut it; the layered plan keeps it as a protected layer.
  const longPersona = `## 人设\n${'长'.repeat(7_000)}END-OF-PERSONA`;
  const huge = await fastpathFixture({
    persona: longPersona,
    config: { contextBudgets: { fastpath: {
      persona: 100, fixed: 100, memory: 100, recent: 100, ephemeral: 10, totalChars: 300,
    } } },
  });
  const hugeSystem = huge.fastPath.systemPrompt('人设超长');
  const hugePayload = fastpathEvent(huge.events);
  assert.ok(hugeSystem.includes('END-OF-PERSONA'), 'persona tail survives a budget smaller than it');
  assert.equal(hugePayload.layers.persona.dropped, 0);
  assert.equal(hugePayload.protectedOverflow, true, 'protected overflow is reported');
  assert.ok(hugePayload.layers.memory.chars === 0, 'memory got no room after the protected layers');
  console.log(`[5] total=${system.length}/1100 memoryDropped=${payload.layers.memory.dropped} `
    + `recentDropped=${payload.layers.recent.dropped} survivingMemory=${surviving.length}/${memoryLines.length}; `
    + `hugePersona=${hugeSystem.length} tailKept=${hugeSystem.includes('END-OF-PERSONA')} protectedOverflow=${hugePayload.protectedOverflow}`);
});

// ---------------------------------------------------------------------------
// 6. observability: complete schema, counts only
// ---------------------------------------------------------------------------

test('6. context.budget 字段完整、不含正文', async () => {
  const { fastPath, events } = await fastpathFixture({
    config: { contextBudgets: { fastpath: {
      persona: 400, fixed: 200, memory: 100, recent: 100, ephemeral: 10, totalChars: 600,
    } } },
  });
  fastPath.systemPrompt('观测字段');
  const payload = fastpathEvent(events);
  for (const key of ['lane', 'layers', 'totalChars', 'truncated', 'totalBudget', 'protectedOverflow']) {
    assert.equal(Object.hasOwn(payload, key), true, `payload has ${key}`);
  }
  assert.equal(payload.lane, 'fastpath');
  assert.equal(typeof payload.totalChars, 'number');
  assert.equal(typeof payload.truncated, 'boolean');
  assert.deepEqual(Object.keys(payload.layers).sort(), [...CONTEXT_LAYER_NAMES].sort());
  for (const name of CONTEXT_LAYER_NAMES) assertStatShape(payload.layers[name], name);
  const serialized = JSON.stringify(payload);
  for (const marker of [PERSONA_MARKER, FIXED_MARKER, MEMORY_MARKER, EPHEMERAL_MARKER, RECENT_MARKER, '观测字段']) {
    assert.equal(serialized.includes(marker), false, `event does not leak: ${marker}`);
  }

  // The generic builder used by voice/typed has the same count-only shape.
  const built = buildContextBudgetPayload({
    lane: 'voice',
    budget: resolveContextBudget(null, 'voice'),
    measured: { persona: personaText, fixed: '固定资源', recent: `${RECENT_MARKER}\n旧行`, ephemeral: EPHEMERAL_MARKER },
    memoryLayers: { fixed: { chars: 3, items: 1, dropped: 0, dropReasons: {} }, memory: { chars: 4, items: 1, dropped: 0, dropReasons: {} } },
  });
  assert.equal(built.lane, 'voice');
  assert.deepEqual(Object.keys(built.layers).sort(), [...CONTEXT_LAYER_NAMES].sort());
  for (const name of CONTEXT_LAYER_NAMES) assertStatShape(built.layers[name], name);
  assert.equal(JSON.stringify(built).includes(personaText), false, 'builder never returns body text');

  // A one-layer helper keeps the same counters when called directly.
  const trimmed = trimLayerText({ text: '标题\n一\n二\n三', headingLines: 1, keep: 'tail' }, 4);
  assert.equal(trimmed.text, '标题\n三');
  assert.equal(trimmed.dropped, 2);
  console.log(`[6] fields=${Object.keys(payload).join(',')} layerFields=chars,items,dropped,dropReasons `
    + `leaks=0 builtShape=ok`);
});

// ---------------------------------------------------------------------------
// 7. host wiring: the real pre-step writes one context.budget row per lane
// ---------------------------------------------------------------------------

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readEvents(root) {
  try {
    const raw = await readFile(join(root, 'data', 'events.jsonl'), 'utf8');
    return raw.split('\n').filter((line) => line.length > 0).flatMap((line) => {
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

/** Mount the real plugin with the same fake waterfall `c2-injection.mjs` uses. */
function mountHost(root, config = {}) {
  const listeners = new Map();
  const cleanups = [];
  const effect = (fn) => {
    const value = fn();
    if (typeof value === 'function') cleanups.push(value);
    return value;
  };
  const ctx = {
    effect,
    on(type, handler) {
      const list = listeners.get(type) ?? [];
      list.push(handler);
      listeners.set(type, list);
      return () => {
        const index = list.indexOf(handler);
        if (index >= 0) list.splice(index, 1);
      };
    },
    get: () => undefined,
    tools: { register: () => () => {} },
    inject: (_deps, register) => register({
      effect,
      systemPrompt: { section: () => () => {} },
      webServer: { register: () => () => {} },
    }),
    webServer: { register: () => () => {} },
  };
  apply(ctx, { root, enabled: true, ...config });
  return {
    close: () => {
      for (const dispose of [...cleanups].reverse()) {
        try {
          dispose();
        } catch {
          /* already torn down */
        }
      }
    },
    preStep: async (payload) => {
      const handlers = listeners.get('agent/pre-step') ?? [];
      let index = 0;
      let invoked = 0;
      const run = async (base) => {
        if (index >= handlers.length) return base();
        const handler = handlers[index];
        index += 1;
        invoked += 1;
        return handler(payload, () => run(base));
      };
      const result = await run(async () => ({ kind: 'enter', messages: [...payload.messages] }));
      assert.equal(invoked, handlers.length, 'the whole pre-step waterfall ran');
      return result;
    },
  };
}

test('7. 宿主接线：voice/typed 各写一行 context.budget，字段完整且不含正文', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-context-layers-host-'));
  for (const dir of ['data', 'memory', 'workspace']) await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, 'data', 'features.json'), `${JSON.stringify({
    hearing: false, ambient: false, voice: false, vision: false, subtitle: false, avatar: false,
    memory: true, fastpath: false,
  })}\n`, 'utf8');
  const store = new MemoryStore(root);
  store.open();
  for (let index = 0; index < 4; index += 1) {
    store.addMessage({
      sessionId: 'context-layers-seed', turnId: 1, role: 'user', clarity: 'vivid', importance: 60,
      messageId: `context-layers-seed-${index}`,
      text: `分层预算测试记忆第${index}条：${'正文'.repeat(40)}`,
    });
  }
  store.close();
  const host = mountHost(root, {
    contextBudgets: {
      voice: { persona: 100, fixed: 100, memory: 160, recent: 90, ephemeral: 20, totalChars: 370 },
      typed: { persona: 100, fixed: 100, memory: 320, recent: 320, ephemeral: 20, totalChars: 700 },
    },
  });
  try {
    const run = async (sessionId, turn) => {
      const message = { id: `u-${turn}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '分层预算测试记忆' }] };
      const agent = { id: sessionId, session: { id: sessionId, header: { cwd: join(root, 'workspace') } } };
      await host.preStep({
        agent, turn, step: 1, signal: new AbortController().signal, messages: [message],
      });
      const until = Date.now() + 2_000;
      for (;;) {
        const rows = (await readEvents(root)).filter((event) => event.type === 'context.budget');
        if (rows.length >= turn) return rows.at(-1).payload;
        if (Date.now() > until) assert.fail(`context.budget missing for ${sessionId}`);
        await delay(10);
      }
    };
    const voice = await run('seirein-2026-11-09', 1);
    const typed = await run('gui-typed-session', 2);

    assert.equal(voice.lane, 'voice');
    assert.equal(voice.sessionId, 'seirein-2026-11-09');
    assert.equal(typed.lane, 'typed');
    assert.equal(typed.sessionId, 'gui-typed-session');
    assert.equal(voice.source, 'config');
    assert.deepEqual(Object.keys(voice.layers).sort(), [...CONTEXT_LAYER_NAMES].sort());
    for (const name of CONTEXT_LAYER_NAMES) assertCountFields(voice.layers[name], `voice.${name}`);
    assert.ok(voice.layers.memory.chars <= 160, `voice memory ${voice.layers.memory.chars} <= 160`);
    assert.ok(typed.layers.memory.chars <= 320, `typed memory ${typed.layers.memory.chars} <= 320`);
    assert.ok(typed.layers.memory.chars > voice.layers.memory.chars,
      `typed ${typed.layers.memory.chars} > voice ${voice.layers.memory.chars}`);
    const serialized = JSON.stringify([voice, typed]);
    assert.equal(serialized.includes('分层预算测试记忆'), false, 'context.budget never carries memory body text');
    assert.equal(serialized.includes(PERSONA_MARKER), false, 'context.budget never carries persona text');
    console.log(`[7] voice lane=${voice.lane} memory=${voice.layers.memory.chars}/160; `
      + `typed lane=${typed.lane} memory=${typed.layers.memory.chars}/320; bodyLeak=false`);
  } finally {
    host.close();
  }
});
