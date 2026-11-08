/**
 * P2-1 regression: voice/typed entries must spend ONE lane total.
 *
 * The old prompt path trimmed every observation block against its own layer quota, separately
 * from `context.budget`, so `totalChars: 0` still rendered environment facts (143 chars) and the
 * debug row could describe a different trim than the request. These tests mount the real `apply()`
 * with a prompt service that mirrors the shipped contract (section text → prompt, context text →
 * runtime snapshot) and run the real pre-step waterfall:
 *
 *   1. typed.totalChars=0 → persona/fixed stay, memory/recent/ephemeral are empty;
 *   2. voice.totalChars=0 → the same for the voice lane (with an active nonverbal cue);
 *   3. protected layers exceed the lane total → protectedOverflow, everything else is 0;
 *   4. environment facts + nonverbal cue share ONE ephemeral allowance;
 *   5. a normal config keeps every layer in quota and `context.budget` equals what was injected.
 *
 * Run: node --test test/context-budget-total.mjs
 * Regression: node --test test/context-budget-layers.mjs test/context-isolation.mjs
 *             test/prompt-stability.mjs test/c2-injection.mjs test/voice-lanes.mjs
 *             node test/smoke.mjs
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { cleanupRoot } from './helpers/cleanup.mjs';

/** A fake hearing entry: only `onUpdate` is used, so the real cue path stays under test. */
const HEARING_URL = new URL('../src/host/hearing/hearing.js', import.meta.url).href;
const REAL_HEARING_URL = new URL('../src/host/hearing/hearing.js?budget-total-real', import.meta.url).href;
globalThis.__budgetTotalHearing = { onUpdate: null };
const hooks = registerHooks({
  load(url, context, next) {
    if (url !== HEARING_URL) return next(url, context);
    return {
      format: 'module',
      shortCircuit: true,
      source: `
    import * as real from ${JSON.stringify(REAL_HEARING_URL)};
    const s = globalThis.__budgetTotalHearing;
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
const { MemoryStore } = await import('../src/host/memory/store.js');
hooks.deregister();

const WORKSPACE = (root) => join(root, 'workspace');
const FEATURES = Object.freeze({
  hearing: false,
  ambient: false,
  voice: false,
  vision: false,
  subtitle: false,
  avatar: false,
  memory: true,
  fastpath: false,
});

/** The prompt sections that make up the protected persona layer (plan and render use the same). */
const PERSONA_SECTIONS = Object.freeze([
  'assistant:persona',
  'assistant:profile',
  'assistant:memory-convention',
  'assistant:hearing',
  'assistant:languages',
  'assistant:voice-output',
  'assistant:expression',
  'assistant:summary',
  'assistant:memory-usage',
  'assistant:task-dispatch',
  'assistant:tool-selection',
  'assistant:ambient',
]);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function tempRoot(t, { features = {}, settings = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-context-total-'));
  for (const dir of ['data', 'memory', 'workspace']) await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, 'data', 'features.json'), `${JSON.stringify({ ...FEATURES, ...features })}\n`, 'utf8');
  if (settings !== null) await writeFile(join(root, 'data', 'settings.json'), `${JSON.stringify(settings)}\n`, 'utf8');
  return root;
}

async function seedMemory(root, texts = []) {
  const store = new MemoryStore(root);
  store.open();
  try {
    texts.forEach((text, index) => {
      store.addMessage({
        sessionId: 'context-total-seed',
        turnId: 1,
        role: 'user',
        clarity: 'vivid',
        importance: 60,
        messageId: `context-total-seed-${index}`,
        text,
      });
    });
  } finally {
    store.close();
  }
}

async function writePersona(root, body) {
  await writeFile(join(root, 'memory', 'persona.md'),
    `# 人设与用户画像\n\n> 由助手在对话中维护，用户不需要编辑本文件。\n\n${body}\n`, 'utf8');
}

function readEvents(root) {
  return readFile(join(root, 'data', 'events.jsonl'), 'utf8')
    .then((raw) => raw.split('\n').filter((line) => line.length > 0).flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    }))
    .catch(() => []);
}

async function untilBudget(root, sessionId, timeoutMs = 3_000) {
  const startedAt = Date.now();
  let rows = [];
  while (Date.now() - startedAt < timeoutMs) {
    rows = (await readEvents(root)).filter((event) => event.type === 'context.budget'
      && event.payload?.sessionId === sessionId);
    if (rows.length > 0) return rows.at(-1).payload;
    await delay(10);
  }
  assert.fail(`context.budget missing for ${sessionId}`);
}

/**
 * Mount the real plugin. The fake host provides the shipped `systemPrompt` contract, the tool
 * registry and the pre-step waterfall; the sections/contexts are rendered exactly once per
 * `assemble()` and their text is captured (a second render would not be the request).
 */
function mountHost(root, config = {}) {
  const sections = new Map();
  const contexts = new Map();
  const tools = new Map();
  const listeners = new Map();
  const disposers = [];
  const effect = (fn) => {
    const value = fn();
    if (typeof value === 'function') disposers.push(value);
    return value;
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
    promptStabilityThrottleMs: 0,
    ffmpegPath: process.execPath,
    ...config,
  });

  const orderOf = (left, right) => left.order - right.order
    || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  const render = (definition, entry) => {
    try {
      return typeof definition.text === 'function' ? definition.text(entry) : definition.text;
    } catch {
      return '';
    }
  };
  const assemble = (entry) => {
    const sectionTexts = {};
    const prompt = [...sections.values()]
      .sort(orderOf)
      .map((definition) => {
        const text = render(definition, entry);
        sectionTexts[definition.name] = typeof text === 'string' ? text : '';
        return sectionTexts[definition.name];
      })
      .filter((text) => text.length > 0)
      .join('\n\n');
    const contextTexts = {};
    const parts = [...contexts.values()]
      .sort(orderOf)
      .map((definition) => {
        const text = render(definition, entry);
        contextTexts[definition.name] = typeof text === 'string' ? text : '';
        return { name: definition.name, text: contextTexts[definition.name] };
      })
      .filter((part) => part.text.length > 0);
    return {
      prompt,
      parts,
      sectionTexts,
      contextTexts,
      sectionText: (name) => sectionTexts[name] ?? '',
      contextText: (name) => contextTexts[name] ?? '',
    };
  };
  const preStep = async (agent, turn, text) => {
    const message = {
      id: `u-${turn}`,
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text }],
    };
    const payload = {
      agent,
      turn,
      step: 1,
      signal: new AbortController().signal,
      messages: [message],
    };
    const handlers = listeners.get('agent/pre-step') ?? [];
    let index = 0;
    const run = async (base) => {
      if (index >= handlers.length) return base();
      const handler = handlers[index];
      index += 1;
      return handler(payload, () => run(base));
    };
    const decision = await run(async () => ({ kind: 'enter', messages: [...payload.messages] }));
    return { decision, message };
  };
  const entryFor = (id) => ({ agent: { id, session: { id, header: { cwd: WORKSPACE(root) } } } });
  return {
    sections,
    contexts,
    tools,
    assemble,
    preStep,
    entryFor,
    close: () => cleanupRoot(root, disposers),
  };
}

/** The assistant-memory message the pre-step actually appended (or '' when it injected none). */
function injectedMemory(decision) {
  const message = (Array.isArray(decision?.messages) ? decision.messages : [])
    .find((item) => item?.source?.kind === 'assistant-memory');
  return message?.content?.[0]?.text ?? '';
}

/** Actual rendered chars per layer, from the ONE assemble() that produced the request. */
function actualLayerChars(assembled, decision) {
  const persona = PERSONA_SECTIONS
    .map((name) => assembled.sectionText(name))
    .filter((text) => text.length > 0)
    .join('\n\n');
  return {
    persona: persona.length,
    fixed: assembled.sectionText('assistant:resources').length,
    memory: injectedMemory(decision).length,
    recent: assembled.contextText('assistant:dialogue').length,
    ephemeral: assembled.sectionText('assistant:environment').length
      + assembled.contextText('assistant:nonverbal').length,
  };
}

function assertBudgetMatches(payload, actual) {
  for (const [name, chars] of Object.entries(actual)) {
    assert.equal(payload.layers[name].chars, chars, `${name} chars match the rendered text`);
  }
  const sum = Object.values(actual).reduce((total, chars) => total + chars, 0);
  assert.equal(payload.totalChars, sum, 'totalChars is the sum of the injected layer chars');
}

async function setFixedMemory(host) {
  const tool = host.tools.get('assistant_resource_set');
  assert.ok(tool !== undefined, 'assistant_resource_set is registered');
  await tool.execute({ key: 'budget.fixed', value: '固定约束必须每轮保留', kind: 'note', title: '预算固定记忆' }, {});
}

async function startNonverbalCue(host) {
  const listen = host.tools.get('assistant_listen');
  assert.ok(listen !== undefined, 'assistant_listen is registered');
  const started = await listen.execute({ action: 'start' });
  assert.equal(started.ok, true, `listening started: ${started.error ?? ''}`);
  const hearing = globalThis.__budgetTotalHearing;
  assert.equal(typeof hearing.onUpdate, 'function', 'hearing exposes onUpdate');
  hearing.onUpdate({
    durationMs: 100,
    final: '哈哈',
    event: '<|Laughter|>',
    eventClean: 'Laughter',
    source: 'mic',
    utteranceId: 7,
  });
}

async function untilNonverbalCue(root) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 3_000) {
    const hit = (await readEvents(root)).find((event) => event.type === 'voice.nonverbal.cue');
    if (hit !== undefined) return hit;
    await delay(10);
  }
  assert.fail('voice.nonverbal.cue missing');
}

// ---------------------------------------------------------------------------
// 1. typed.totalChars = 0
// ---------------------------------------------------------------------------

test('1. typed.totalChars=0：环境事实/非语言/记忆/近期全空，persona/fixed 保留', async (t) => {
  const root = await tempRoot(t);
  await writePersona(root, '预算人设：无论预算多紧都完整保留。');
  await seedMemory(root, ['总预算零的记忆正文：这段不应进入请求。']);
  const host = mountHost(root, {
    contextBudgets: { typed: { totalChars: 0 } },
  });
  t.after(() => host.close());
  await setFixedMemory(host);

  const entry = host.entryFor('gui-typed-session');
  const assembled = host.assemble(entry);
  const { decision } = await host.preStep(entry.agent, 1, '总预算零的记忆');
  const payload = await untilBudget(root, 'gui-typed-session');
  const actual = actualLayerChars(assembled, decision);

  assert.ok(actual.persona > 0, 'persona is still rendered');
  assert.ok(assembled.sectionText('assistant:persona').includes('预算人设'), 'persona text is present');
  assert.ok(actual.fixed > 0, 'fixed memory is still rendered');
  assert.ok(assembled.sectionText('assistant:resources').includes('固定约束必须每轮保留'), 'fixed text is present');
  assert.equal(assembled.sectionText('assistant:environment'), '', 'environment facts are empty');
  assert.equal(assembled.contextText('assistant:nonverbal'), '', 'no nonverbal contribution');
  assert.equal(assembled.contextText('assistant:dialogue'), '', 'no recent dialogue');
  assert.equal(injectedMemory(decision), '', 'no memory block was injected');

  assert.equal(payload.layers.memory.chars, 0, 'memory is empty');
  assert.equal(payload.layers.recent.chars, 0, 'recent is empty');
  assert.equal(payload.layers.ephemeral.chars, 0, 'ephemeral is empty');
  assertBudgetMatches(payload, actual);
  assert.equal(payload.protectedOverflow, true, 'protected text exceeds the zero total');
  assert.equal(payload.totalBudget, 0);
  console.log(`[1] typed totalChars=0: env=0 memory=0 recent=0 ephemeral=0 `
    + `persona=${actual.persona} fixed=${actual.fixed} injected=${payload.totalChars} protectedOverflow=true`);
});

// ---------------------------------------------------------------------------
// 2. voice.totalChars = 0 (with an active nonverbal cue)
// ---------------------------------------------------------------------------

test('2. voice.totalChars=0：同样只剩 persona/fixed，非语言线索也不渲染', async (t) => {
  const root = await tempRoot(t, {
    features: { hearing: true },
    settings: { gptSovits: { enabled: false }, autoMemory: { enabled: false }, voice: { nonverbalCue: true } },
  });
  await seedMemory(root, ['语音总预算零的记忆正文：这段不应进入请求。']);
  await writePersona(root, '语音预算人设：无论预算多紧都完整保留。');
  const buffer = createDialogueContext({ now: () => 1_000 });
  buffer.push({ text: '这句台词也不应进入零预算请求。', at: 1_000, utteranceId: 'u1' });
  const host = mountHost(root, {
    dialogueContext: buffer,
    asrMergeWindowMs: 10,
    contextBudgets: { voice: { totalChars: 0 } },
  });
  t.after(() => host.close());
  await setFixedMemory(host);
  await startNonverbalCue(host);
  await untilNonverbalCue(root);

  const voiceId = voiceSessionTarget({ root }).sessionId;
  const entry = host.entryFor(voiceId);
  const assembled = host.assemble(entry);
  const { decision } = await host.preStep(entry.agent, 1, '语音总预算零的记忆');
  const payload = await untilBudget(root, voiceId);
  const actual = actualLayerChars(assembled, decision);

  assert.ok(actual.persona > 0, 'persona is still rendered');
  assert.ok(actual.fixed > 0, 'fixed memory is still rendered');
  assert.equal(assembled.sectionText('assistant:environment'), '', 'environment facts are empty');
  assert.equal(assembled.contextText('assistant:nonverbal'), '', 'the active cue is not rendered');
  assert.equal(assembled.contextText('assistant:dialogue'), '', 'recent dialogue is not rendered');
  assert.equal(injectedMemory(decision), '', 'no memory block was injected');
  assert.equal(payload.layers.memory.chars, 0);
  assert.equal(payload.layers.recent.chars, 0);
  assert.equal(payload.layers.ephemeral.chars, 0);
  assertBudgetMatches(payload, actual);
  console.log(`[2] voice totalChars=0: cueActive=true env=0 nonverbal=0 recent=0 memory=0 `
    + `persona=${actual.persona} fixed=${actual.fixed} injected=${payload.totalChars}`);
});

// ---------------------------------------------------------------------------
// 3. protected layers exceed the total
// ---------------------------------------------------------------------------

test('3. 受保护层超大：protectedOverflow、其余 0，persona 不被 slice', async (t) => {
  const root = await tempRoot(t);
  await seedMemory(root, ['受保护层超大的记忆正文：不应进入请求。']);
  await writePersona(root, `PERSONA-HEAD-MARKER ${'长'.repeat(6_000)}`);
  const host = mountHost(root, {
    contextBudgets: {
      typed: { persona: 100_000, fixed: 100_000, memory: 1_000, recent: 1_000, ephemeral: 1_000, totalChars: 500 },
    },
  });
  t.after(() => host.close());

  const entry = host.entryFor('gui-typed-huge-persona');
  const assembled = host.assemble(entry);
  const { decision } = await host.preStep(entry.agent, 1, '受保护层超大的记忆');
  const payload = await untilBudget(root, 'gui-typed-huge-persona');
  const actual = actualLayerChars(assembled, decision);

  assert.ok(actual.persona > 500, 'persona alone exceeds the lane total');
  const personaSection = assembled.sectionText('assistant:persona');
  assert.ok(personaSection.includes('PERSONA-HEAD-MARKER'), 'the persona body is rendered');
  assert.ok(personaSection.includes('…（已截断）'), 'the persona layer keeps its own rendered body whole');
  assert.ok(assembled.prompt.includes(personaSection), 'the whole persona section survived the lane budget');
  assert.equal(assembled.sectionText('assistant:environment'), '', 'no environment facts');
  assert.equal(injectedMemory(decision), '', 'no memory block');
  assert.equal(payload.protectedOverflow, true, 'protected overflow is reported');
  assert.equal(payload.layers.memory.chars, 0);
  assert.equal(payload.layers.recent.chars, 0);
  assert.equal(payload.layers.ephemeral.chars, 0);
  assertBudgetMatches(payload, actual);
  console.log(`[3] persona=${actual.persona}>total=500 protectedOverflow=true `
    + `memory/recent/ephemeral=0 tailKept=true injected=${payload.totalChars}`);
});

// ---------------------------------------------------------------------------
// 4. environment + nonverbal share one ephemeral allowance
// ---------------------------------------------------------------------------

test('4. 多个临时块共享 ephemeral：环境事实+非语言线索合计不超配额', async (t) => {
  const root = await tempRoot(t, {
    features: { hearing: true },
    settings: { gptSovits: { enabled: false }, autoMemory: { enabled: false }, voice: { nonverbalCue: true } },
  });
  const config = {
    asrMergeWindowMs: 10,
    contextBudgets: {
      voice: { persona: 100_000, fixed: 100_000, memory: 0, recent: 0, ephemeral: 100_000, totalChars: 100_000 },
    },
  };
  const host = mountHost(root, config);
  t.after(() => host.close());
  await startNonverbalCue(host);
  await untilNonverbalCue(root);

  const voiceId = voiceSessionTarget({ root }).sessionId;
  const entry = host.entryFor(voiceId);
  const full = host.assemble(entry);
  const envFull = full.sectionText('assistant:environment');
  const nonverbalFull = full.contextText('assistant:nonverbal');
  assert.ok(envFull.length > 0, 'environment facts exist');
  assert.ok(nonverbalFull.length > 0, 'the nonverbal cue exists');
  assert.ok(envFull.length + nonverbalFull.length > 10, 'both blocks are non-empty');
  // The two blocks together must not fit if each were given the whole quota separately.
  const quota = envFull.length + nonverbalFull.length - 10;
  assert.ok(quota > envFull.length, 'the quota leaves room for part of the cue');
  config.contextBudgets.voice.ephemeral = quota;

  // Same assembly key (same agent object) but a new render: the plan must be re-allocated.
  const shared = host.assemble(entry);
  const envShared = shared.sectionText('assistant:environment');
  const nonverbalShared = shared.contextText('assistant:nonverbal');
  const { decision } = await host.preStep(entry.agent, 1, '共享临时块预算');
  const payload = await untilBudget(root, voiceId);

  assert.equal(envShared, envFull, 'environment keeps its whole block');
  assert.ok(nonverbalShared.length > 0, 'the cue still keeps its first line');
  assert.ok(nonverbalShared.length < nonverbalFull.length, 'the cue was trimmed by the shared quota');
  assert.ok(envShared.length + nonverbalShared.length <= quota, 'both blocks fit the shared quota');
  assert.equal(payload.layers.ephemeral.chars, envShared.length + nonverbalShared.length,
    'the debug row reports the shared allocation');
  assertBudgetMatches(payload, actualLayerChars(shared, decision));
  console.log(`[4] ephemeral quota=${quota}: env=${envShared.length}+nonverbal=${nonverbalShared.length}`
    + `=${envShared.length + nonverbalShared.length}<=quota (independent would be ${envFull.length + nonverbalFull.length})`);
});

// ---------------------------------------------------------------------------
// 5. normal config: every layer in quota; context.budget == injected text
// ---------------------------------------------------------------------------

test('5. 正常配置各层符合配额，日志 context.budget 与实际注入一致', async (t) => {
  const root = await tempRoot(t, { features: { hearing: true } });
  await seedMemory(root, Array.from({ length: 4 }, (_item, index) => (
    `正常预算记忆第${index}条：${'正文'.repeat(24)}`
  )));
  const buffer = createDialogueContext({ now: () => 1_000 });
  for (let index = 0; index < 4; index += 1) {
    buffer.push({ text: `最近对话第${index}行：${'台词'.repeat(16)}`, at: 1_000, utteranceId: `u${index}` });
  }
  const budget = {
    persona: 5_000, fixed: 1_200, memory: 600, recent: 800, ephemeral: 300, totalChars: 8_000,
  };
  const host = mountHost(root, {
    dialogueContext: buffer,
    contextBudgets: { voice: budget },
  });
  t.after(() => host.close());
  await setFixedMemory(host);

  const voiceId = voiceSessionTarget({ root }).sessionId;
  const entry = host.entryFor(voiceId);
  const assembled = host.assemble(entry);
  const { decision } = await host.preStep(entry.agent, 1, '正常预算记忆');
  const payload = await untilBudget(root, voiceId);
  const actual = actualLayerChars(assembled, decision);

  assert.ok(actual.persona <= budget.persona, `persona ${actual.persona} <= ${budget.persona}`);
  assert.ok(actual.fixed <= budget.fixed, `fixed ${actual.fixed} <= ${budget.fixed}`);
  assert.ok(actual.memory > 0 && actual.memory <= budget.memory, `memory ${actual.memory} <= ${budget.memory}`);
  assert.ok(actual.recent > 0 && actual.recent <= budget.recent, `recent ${actual.recent} <= ${budget.recent}`);
  assert.ok(actual.ephemeral > 0 && actual.ephemeral <= budget.ephemeral,
    `ephemeral ${actual.ephemeral} <= ${budget.ephemeral}`);
  assert.equal(payload.layers.persona.chars, actual.persona);
  assert.equal(payload.layers.fixed.chars, actual.fixed);
  assert.equal(payload.layers.memory.chars, actual.memory);
  assert.equal(payload.layers.recent.chars, actual.recent);
  assert.equal(payload.layers.ephemeral.chars, actual.ephemeral);
  assertBudgetMatches(payload, actual);
  assert.equal(payload.protectedOverflow, false);
  assert.ok(payload.totalChars <= budget.totalChars, 'sum of layers respects the lane total');
  console.log(`[5] normal: persona=${actual.persona} fixed=${actual.fixed} memory=${actual.memory} `
    + `recent=${actual.recent} ephemeral=${actual.ephemeral} total=${payload.totalChars} `
    + `budget=${budget.totalChars} logMatchesInjected=true`);
});
