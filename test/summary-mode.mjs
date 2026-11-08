/**
 * History summary mode + real recovery pressure.
 *
 * The compaction provider replays this session's own system prompt inside its summarization
 * request, so Seirein's persona/expression sections used to leak into the summary and the model
 * answered as the character instead of writing an objective history summary. The fix is a
 * functional `assistant:summary` section (order 331) that applies ONLY when the model is asked to
 * summarize, plus real `pressureBefore`/`pressureAfter` (tokens/window/ratio) on
 * `voice.session.recover` so a `before`/`after` pair is not mistaken for pressure.
 *
 * This suite proves:
 *  1. the summary mode paragraph is a system-prompt section next to the untouched persona, and the
 *     one `summary.mode.prompt` debug event confirms it is in place;
 *  2. recovery returns real pressure fields when the token meter and window are available;
 *  3. an unreadable meter yields NULL (never a guessed pressure);
 *  4. an unknown window also yields NULL while the raw token counts stay available;
 *  5. the existing `voice.session.recover` event contract is unchanged (before/after/freed/reason)
 *     and carries the pressure fields, including on a compaction failure.
 *
 * Run: node --test test/summary-mode.mjs
 * Regression: node --test test/expression-rules.mjs test/voice-compaction.mjs
 *             test/session-recovery.mjs test/prompt-stability.mjs
 *             node test/smoke.mjs
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { apply, voiceSessionTarget } from '../src/host/index.js';
import {
  VOICE_COMPACTION_PRESET,
  VOICE_COMPACTION_PRESET_ID,
  VOICE_SESSION_RECOVER_ACTION,
  createVoiceCompaction,
  createVoiceSessionRecovery,
} from '../src/host/session/compaction/voice-compaction.js';

const PERSONA_HEADER = '# 人设与用户画像\n\n> 由助手在对话中维护，用户不需要编辑本文件。\n';
const PERSONA_LINE = '- 说话温柔';
const SUMMARY_ORDER = 331;
const METER_WINDOW = 100_000;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const readEvents = (root) => {
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
};

const untilEvents = async (root, predicate, label, timeoutMs = 3000) => {
  const startedAt = Date.now();
  let events = [];
  while (Date.now() - startedAt < timeoutMs) {
    events = readEvents(root);
    if (predicate(events)) return events;
    await delay(10);
  }
  assert.fail(`timed out: ${label}; events=${events.map((event) => event.type).join(',')}`);
};

async function tempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-summary-mode-'));
  t.after(async () => {
    await delay(60);
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });
  for (const dir of ['data', 'memory', 'workspace']) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, 'data', 'features.json'), `${JSON.stringify({
    hearing: false, ambient: false, voice: false, vision: false,
    subtitle: false, avatar: false, memory: false, fastpath: false,
  })}\n`, 'utf8');
  writeFileSync(join(root, 'memory', 'persona.md'), `${PERSONA_HEADER}\n${PERSONA_LINE}\n`, 'utf8');
  return root;
}

/** Mount the real plugin with just the prompt service captured; no audio, no model calls. */
function mountPrompt(root) {
  const sections = new Map();
  const contexts = new Map();
  const cleanups = [];
  const effect = (fn) => {
    const value = fn();
    if (typeof value === 'function') cleanups.push(value);
    return value;
  };
  const on = () => () => {};
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
    tools: { register: () => () => {} },
    inject: (_deps, register) => register(scope),
    webServer: { register: () => () => {} },
  }, { root, enabled: true, promptStabilityThrottleMs: 0 });
  const entry = {
    agent: { id: voiceSessionTarget({ root }).sessionId, session: { header: { cwd: join(root, 'workspace') } } },
  };
  const render = (name) => {
    const section = sections.get(name);
    if (section === undefined) return '';
    return typeof section.text === 'function' ? section.text(entry) : section.text;
  };
  return {
    sections,
    contexts,
    render,
    prompt: () => [...sections.values()]
      .sort((left, right) => left.order - right.order)
      .map((section) => (typeof section.text === 'function' ? section.text(entry) : section.text))
      .filter((text) => typeof text === 'string' && text.length > 0)
      .join('\n\n'),
    close: () => {
      for (const fn of cleanups.reverse()) {
        try {
          fn();
        } catch {
          /* already torn down */
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 1. The summary mode paragraph is in the system prompt, persona untouched
// ---------------------------------------------------------------------------
test('1. 摘要模式段进入系统提示，persona 文本未被改写，并写出 summary.mode.prompt', async (t) => {
  const root = await tempRoot(t);
  const host = mountPrompt(root);
  t.after(() => host.close());

  const summary = host.render('assistant:summary');
  const persona = host.render('assistant:persona');
  const expression = host.render('assistant:expression');
  assert.equal(host.sections.get('assistant:summary')?.order, SUMMARY_ORDER, 'order 331, right after expression 330');
  assert.equal(host.contexts.has('assistant:summary'), false, 'the rule is a stable section, not runtime context');
  assert.ok(summary.includes('历史摘要模式'), 'the heading is present');
  assert.ok(summary.includes('当系统要求你总结、压缩或摘要对话历史时：'), 'it only constrains summarization');
  assert.ok(summary.includes('用第三人称、客观要点输出'), 'third-person objective output');
  assert.ok(summary.includes('当前话题、已确认结论、未完成事项、用户明确纠正、关键约束'), 'the required summary content');
  assert.ok(summary.includes('不要以角色口吻回复'), 'character voice is refused');
  assert.ok(summary.includes('不要添加铺垫/情绪/称呼，不要输出对话式回答。'), 'no framing/emotion/address/dialogue answer');
  assert.ok(summary.includes('此模式优先于人设中的表达风格。'), 'outranks the persona style');
  assert.ok(persona.includes(PERSONA_LINE), 'the persona section still renders its own text');
  assert.equal(persona.includes('历史摘要模式'), false, 'the persona file is never edited');
  assert.ok(expression.includes('同一结论通常表达一次'), 'normal expression rules still stand');
  const all = host.prompt();
  assert.ok(all.includes(PERSONA_LINE) && all.includes('历史摘要模式'), 'both survive in the assembled prompt');

  const events = await untilEvents(root, (list) => list.some((event) => event.type === 'summary.mode.prompt'),
    'summary.mode.prompt event');
  const row = events.find((event) => event.type === 'summary.mode.prompt').payload;
  assert.equal(row.name, 'assistant:summary');
  assert.equal(row.order, SUMMARY_ORDER);
  assert.equal(row.chars, summary.length);
  assert.equal(row.text, summary, 'the debug event carries exactly the section text');
  console.log(`1) summaryChars=${summary.length} order=${row.order} personaIntact=${persona.includes(PERSONA_LINE)} promptBoth=${all.includes(PERSONA_LINE) && all.includes('历史摘要模式')}`);
});

// ---------------------------------------------------------------------------
// Fake recovery host: persisted session + preset realm + optional token meter
// ---------------------------------------------------------------------------

const countTokens = (message) => Math.ceil(String(message?.text ?? '').length / 4);

/** 20 x 800-char messages = 4000 tokens, far above the fake 1200-token threshold. */
function history() {
  return Array.from({ length: 20 }, (_unused, index) => ({ role: 'user', text: String(index).repeat(800) }));
}

function bindPreset(host) {
  return async (agentCtx, presetId) => {
    const agent = agentCtx?.agent;
    if (agent === undefined) throw new Error('mount requires an Agent context');
    host.binding = {
      presetId,
      engine: {
        compactNow: async () => {
          if (host.compactionError !== null) throw host.compactionError;
          const messages = agent.session.messages;
          const head = messages.slice(0, Math.max(0, messages.length - 2));
          if (head.length === 0) return null;
          agent.session.messages = [
            { role: 'user', text: '<compacted-summary>fact list</compacted-summary>' },
            ...messages.slice(-2),
          ];
          return { shadowedSeqs: head, summarySeq: 0 };
        },
      },
    };
    return { id: presetId };
  };
}

/**
 * A minimal host for the real recovery factory. `meter:false` removes the token meter (and the
 * compaction backend's own measure) so every measurement honestly returns null.
 */
function createRecoveryHost({ meter = true, windowTokens = METER_WINDOW, compactionError = null } = {}) {
  const host = {
    binding: null,
    compactionError,
    events: [],
    persisted: new Map([['seirein-2026-11-08', history()]]),
    live: new Map(),
  };
  const log = { emit: (type, payload) => { host.events.push({ type, payload }); return Promise.resolve(); } };
  const declared = new Map([[VOICE_COMPACTION_PRESET_ID, VOICE_COMPACTION_PRESET]]);
  const tokenMeter = meter
    ? { measure: (session) => ({ totalTokens: (session?.messages ?? []).reduce((sum, message) => sum + countTokens(message), 0) }) }
    : undefined;

  const agentPresets = {
    definitions: declared,
    mount: bindPreset(host),
    async resolve(presetId) { return { id: presetId }; },
    composedPreset() { return host.binding?.presetId; },
    serviceFor(_agent, name) { return name === 'compaction' ? host.binding?.engine : undefined; },
    presetForSession() { return null; },
  };

  const services = {
    agentPresets,
    tokenMeter,
    agents: { get: (id) => host.live.get(id), list: () => [...host.live.values()] },
  };
  services.agentLoop = {
    async resume(_ownerCtx, options) {
      const id = options.resumeSessionId;
      const session = {
        id,
        messages: (host.persisted.get(id) ?? []).map((message) => ({ ...message })),
        append() {},
      };
      const agent = { id, session };
      agent.ctx = { key: {}, agent };
      await options.setup?.(agent.ctx, agent);
      host.live.set(id, agent);
      return { agent };
    },
  };
  const getService = (name) => services[name];
  const engine = createVoiceCompaction({ getService, log, windowTokens });
  host.recover = createVoiceSessionRecovery({
    getService,
    log,
    ownerCtx: { get: getService },
    compaction: engine,
    defaultSessionId: () => 'seirein-2026-11-08',
  });
  host.lastEvent = () => host.events.filter((entry) => entry.type === VOICE_SESSION_RECOVER_ACTION).at(-1);
  host.getService = getService;
  host.agentPresets = agentPresets;
  return host;
}

const roundRatio = (tokens, window) => Math.round((tokens / window) * 1000) / 1000;

// ---------------------------------------------------------------------------
// 2. Real pressure when the meter and window are available
// ---------------------------------------------------------------------------
test('2. recover 返回真实 pressureBefore/pressureAfter（tokens/window/ratio）', async () => {
  const host = createRecoveryHost();
  const result = await host.recover({});

  assert.equal(result.ok, true);
  assert.equal(typeof result.before, 'number');
  assert.equal(typeof result.after, 'number');
  assert.ok(result.before > result.after, `the summary shrinks the request (${result.before} -> ${result.after})`);
  assert.deepEqual(result.pressureBefore, {
    tokens: result.before,
    window: METER_WINDOW,
    ratio: roundRatio(result.before, METER_WINDOW),
  }, 'pressureBefore is the real measured tokens over the real window');
  assert.deepEqual(result.pressureAfter, {
    tokens: result.after,
    window: METER_WINDOW,
    ratio: roundRatio(result.after, METER_WINDOW),
  }, 'pressureAfter is re-measured AFTER compaction, not derived from before');
  assert.ok(result.pressureAfter.ratio < result.pressureBefore.ratio);

  const event = host.lastEvent();
  assert.equal(event.payload.ok, true);
  assert.equal(event.payload.sessionId, 'seirein-2026-11-08');
  assert.equal(typeof event.payload.before, 'number', 'existing before field still present');
  assert.equal(typeof event.payload.after, 'number', 'existing after field still present');
  assert.equal(event.payload.freed, result.freed, 'existing freed field still present');
  assert.equal(event.payload.reason, '');
  assert.deepEqual(event.payload.pressureBefore, result.pressureBefore, 'event carries the same pressure');
  assert.deepEqual(event.payload.pressureAfter, result.pressureAfter);
  console.log(`2) tokens ${result.before} -> ${result.after} pressure ${JSON.stringify(result.pressureBefore)} -> ${JSON.stringify(result.pressureAfter)}`);
});

// ---------------------------------------------------------------------------
// 3. Unreadable meter: null pressure, never a guess
// ---------------------------------------------------------------------------
test('3. 取不到 token meter 时 pressure 为 null（不伪造）', async () => {
  const host = createRecoveryHost({ meter: false });
  const result = await host.recover({});

  assert.equal(result.ok, true, 'recovery itself still succeeds');
  assert.equal(result.before, null, 'no measurement -> null');
  assert.equal(result.after, null);
  assert.equal(result.pressureBefore, null);
  assert.equal(result.pressureAfter, null);
  assert.equal(result.freed, null);

  const event = host.lastEvent();
  assert.equal(event.payload.ok, true);
  assert.equal(event.payload.pressureBefore, null, 'the event never invents a pressure');
  assert.equal(event.payload.pressureAfter, null);
  assert.equal(event.payload.before, null, 'existing contract keeps null measurements');
  console.log(`3) meter=absent before=${result.before} pressureBefore=${result.pressureBefore} pressureAfter=${result.pressureAfter}`);
});

// ---------------------------------------------------------------------------
// 4. Unknown window: raw counts stay, pressure stays null
// ---------------------------------------------------------------------------
test('4. 窗口未知时 pressure 为 null，原始 token 数仍保留', async () => {
  const host = createRecoveryHost();
  // A compaction engine that cannot name a window (no resolveWindowTokens): the recovery must not
  // fall back to a documented default and present it as this meter's window.
  const fakeEngine = {
    ensurePreset: async () => ({}),
    presetStatus: () => ({ status: 'reused' }),
    ensure: async (agent, agentCtx) => {
      await host.agentPresets.mount(agentCtx ?? agent.ctx, VOICE_COMPACTION_PRESET_ID);
      return { ok: true };
    },
  };
  const recover = createVoiceSessionRecovery({
    getService: host.getService,
    log: { emit: (type, payload) => { host.events.push({ type, payload }); return Promise.resolve(); } },
    ownerCtx: { get: host.getService },
    compaction: fakeEngine,
    defaultSessionId: () => 'seirein-2026-11-08',
  });
  const result = await recover({});

  assert.equal(result.ok, true);
  assert.equal(typeof result.before, 'number', 'the meter still measured tokens');
  assert.equal(typeof result.after, 'number');
  assert.equal(result.pressureBefore, null, 'without a window no ratio is fabricated');
  assert.equal(result.pressureAfter, null);
  const event = host.lastEvent();
  assert.equal(event.payload.pressureBefore, null);
  assert.equal(event.payload.pressureAfter, null);
  console.log(`4) window=unknown tokens ${result.before} -> ${result.after} pressure=null`);
});

// ---------------------------------------------------------------------------
// 5. Compaction failure: before-pressure recorded, after-pressure null, contract intact
// ---------------------------------------------------------------------------
test('5. 压缩失败时保留 pressureBefore，pressureAfter 为 null，事件契约不变', async () => {
  const host = createRecoveryHost({
    compactionError: Object.assign(new Error('manual compaction: summary failed'), { code: 'summary' }),
  });
  const result = await host.recover({});

  assert.equal(result.ok, false);
  assert.equal(result.code, 'compaction-failed');
  assert.equal(result.mounted, true);
  assert.equal(result.compacted, false);
  assert.deepEqual(result.pressureBefore, {
    tokens: result.before,
    window: METER_WINDOW,
    ratio: roundRatio(result.before, METER_WINDOW),
  });
  assert.equal(result.pressureAfter, null, 'nothing was re-measured after a failed compaction');
  assert.equal(result.freed, null);

  const event = host.lastEvent();
  assert.equal(event.payload.ok, false);
  assert.equal(event.payload.mounted, true);
  assert.equal(event.payload.reason, 'compaction-failed');
  assert.deepEqual(event.payload.pressureBefore, result.pressureBefore);
  assert.equal(event.payload.pressureAfter, null);
  assert.equal(event.payload.freed, null);
  console.log(`5) ok=false code=${result.code} pressureBefore=${JSON.stringify(result.pressureBefore)} pressureAfter=${result.pressureAfter}`);
});
