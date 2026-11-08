/**
 * Expression rules: say each conclusion once, in the body AND in the spoken version.
 *
 * These tests mount the real plugin and prove three things:
 *  1. the functional `assistant:expression` prompt section carries the anti-repetition rule while
 *     the persona section keeps standing (two sections, neither overwrites the other);
 *  2. the typed-lane spoken-version request (condenseForSpeech) asks for a condensed, non-repeating
 *     rewrite — the captured request body carries the new constraints;
 *  3. a deliberately repetitive body produces `voice.reply.redundancy` with
 *     `body.simCandidates > 0`, while the body and the spoken version are byte-for-byte unchanged
 *     (the metric is read-only: no sentence is deleted).
 *
 * The settings-page threshold hint lives in test/hearing-ui.mjs; the echo residual fields live in
 * test/echo-filter.mjs.
 *
 * Run: node --test test/expression-rules.mjs
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupRoot, disposeAll } from './helpers/cleanup.mjs';

const state = { synth: null, texts: [], players: [], audioSeq: 0 };
globalThis.__expressionRules = state;

const ttsUrl = new URL('../src/host/speech/tts.js', import.meta.url).href;
const sightUrl = new URL('../src/host/vision/sight.js', import.meta.url).href;
const subtitleUrl = new URL('../src/host/subtitle/subtitle.js', import.meta.url).href;

const hooks = registerHooks({
  load(url, context, next) {
    if (url === ttsUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    const s = globalThis.__expressionRules;
    export { resolveGptLangs, resolveGptSovitsTimeout } from '${ttsUrl}?expression-helpers';
    export const configureTts = () => {};
    export const gptSovitsReferenceStatus = async () => ({ seconds: null, ok: false, readable: false });
    export const warmupGptSovits = async () => ({ ok: false, skipped: 'disabled' });
    export const applyGptSovitsModels = () => ({ ok: true });
    export const synthesize = (options) => s.synth(options);
    export const speakStreaming = async () => { throw new Error('streaming not expected'); };
    export const stopPlayback = () => true;
    export const stopTts = () => true;
    export const play = (file, options) => {
      let resolve;
      const done = new Promise((doneResolve) => { resolve = doneResolve; });
      const player = { file, ...options, resolve, resolveNow: () => resolve() };
      s.players.push(player);
      return done;
    };`,
      };
    }
    if (url === sightUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    const forbidden = () => { throw new Error('real capture forbidden'); };
    export const resolveFfmpeg = () => null;
    export const resolveFfplay = () => null;
    export const capture = forbidden, captureDesktop = forbidden, captureDevice = forbidden, startStoryboard = forbidden;
    export const OBSERVATION_TTL_MS = 30000;
    export function readObservation(o) { return { ...(o ?? {}), stale: false }; }`,
      };
    }
    if (url === subtitleUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    export const averageColor = async () => null;
    export class SubtitleOverlay {
      constructor({ config }) { this.config = config; }
      async show() { return true; }
      async hide() {}
      async stop() {}
    }`,
      };
    }
    if (url === 'node:child_process') {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    export const spawn = () => { throw new Error('real process forbidden'); };
    export const execFile = () => { throw new Error('real process forbidden'); };`,
      };
    }
    return next(url, context);
  },
});
const { apply } = await import('../src/host/index.js');
hooks.deregister();
after(() => { delete globalThis.__expressionRules; });

const PERSONA_HEADER = '# 人设与用户画像\n\n> 由助手在对话中维护，用户不需要编辑本文件。\n';
const PERSONA_LINE = '- 说话温柔';

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const waitUntil = async (check, message, timeoutMs = 6000) => {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out: ${message}`);
    await tick(5);
  }
};

const startEvent = (turn) => ({ type: 'turn/start', data: { turn } });
const userEvent = (turn, id) => ({
  type: 'user/message',
  data: { turn, id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '重复的一些话' }] },
});
const assistantEvent = (turn, text) => ({
  type: 'assistant/message',
  data: { turn, step: 1, message: { id: `a-${turn}`, role: 'assistant', content: [{ type: 'text', text }] } },
});
const endEvent = (turn) => ({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });

const readEvents = async (root) => {
  try {
    const text = await readFile(join(root, 'data', 'events.jsonl'), 'utf8');
    return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
};

/** A deliberately repetitive body: two exact restatements and two near restatements. */
const REPEATED_BODY = '明天出门要带伞。明天出门要带伞。下午有雨，记得带伞。另外下午有雨，记得带伞。';
const SPOKEN_ONLY = '结论：带伞，下午有雨。';

/**
 * Mount the real plugin with captured prompt sections + a fake lightweight channel. No audio is
 * touched: TTS is a stub, and the player promise is resolved by the test teardown.
 */
async function mount(t, { spokenText = SPOKEN_ONLY } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-expression-rules-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await mkdir(join(root, 'memory'), { recursive: true });
  await mkdir(join(root, 'workspace'), { recursive: true });
  await writeFile(join(root, 'data', 'features.json'), JSON.stringify({
    hearing: false, ambient: false, voice: true, vision: false,
    subtitle: false, avatar: false, memory: true, fastpath: false,
  }));
  await writeFile(join(root, 'memory', 'persona.md'), `${PERSONA_HEADER}\n${PERSONA_LINE}\n`);

  state.texts = [];
  state.players = [];
  state.audioSeq = 0;
  state.synth = async ({ text }) => {
    state.texts.push(text);
    return {
      file: join(root, 'tts', `${++state.audioSeq}.mp3`),
      bytes: 16,
      durationMs: 200,
      provider: 'edge-tts',
    };
  };

  const requests = [];
  const spokenRequests = [];
  const streamOf = (text) => (async function* generate() {
    yield { type: 'text-delta', text };
    yield { type: 'finish', reason: { kind: 'stop' } };
  })();
  const llm = {
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }] } }),
    stream(options) {
      requests.push(options);
      const system = String(options?.system ?? '');
      const user = String(options?.messages?.[0]?.content?.[0]?.text ?? '');
      const isSpoken = system.includes('可直接朗读的口语版') || user.includes('<完整答复>');
      if (isSpoken) {
        spokenRequests.push({ system, user });
        return streamOf(spokenText);
      }
      return streamOf('好的。');
    },
  };

  const sections = new Map();
  const handlers = [];
  const cleanups = [];
  const tools = new Map();
  const routes = new Map();
  const effect = (fn) => {
    const cleanup = fn();
    if (typeof cleanup === 'function') cleanups.push(cleanup);
    return cleanup;
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
        return () => {};
      },
    },
    webServer: {
      register(route) {
        routes.set(route.path, route.handler);
        return () => routes.delete(route.path);
      },
    },
  };
  apply({
    effect,
    on,
    get: (name) => {
      if (name === 'llm') return llm;
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'fake-provider', model: 'fake-model' }) };
      }
      return undefined;
    },
    tools: {
      register(tool) {
        tools.set(tool.name, tool);
        return () => tools.delete(tool.name);
      },
    },
    inject: (_deps, register) => register(scope),
  }, { root, enabled: true });

  const session = { id: 'expression-rules-session', header: { cwd: join(root, 'workspace') } };
  const emit = (target, event) => {
    for (const entry of [...handlers]) {
      if (entry.type === 'session/event') entry.handler(target, event);
    }
  };
  const driveTypedTurn = (turn, text) => {
    emit(session, startEvent(turn));
    emit(session, userEvent(turn, `u-${turn}`));
    emit(session, assistantEvent(turn, text));
    emit(session, endEvent(turn));
  };
  const events = () => readEvents(root);
  const waitForEvent = async (type, predicate = () => true) => {
    const started = Date.now();
    for (;;) {
      const row = (await events()).find((event) => event.type === type && predicate(event.payload ?? {}));
      if (row !== undefined) return row.payload ?? {};
      if (Date.now() - started > 6000) throw new Error(`timed out waiting for ${type}`);
      await tick(10);
    }
  };
  const context = { agent: { session: { header: { cwd: join(root, 'workspace') } } } };
  const render = (name) => sections.get(name)?.text(context) ?? '';
  const prompt = () => [...sections.values()]
    .sort((left, right) => left.order - right.order)
    .map((section) => section.text(context))
    .filter((text) => typeof text === 'string' && text.length > 0)
    .join('\n\n');

  t.after(async () => {
    for (const player of [...state.players]) player.resolveNow?.();
    await tick(20);
    await disposeAll(cleanups.splice(0));
    await cleanupRoot(root);
  });

  return {
    root,
    session,
    requests,
    spokenRequests,
    sections,
    render,
    prompt,
    driveTypedTurn,
    events,
    waitForEvent,
    texts: () => state.texts,
  };
}

// ---------------------------------------------------------------------------
// 1. The functional section carries the rule; the persona section still stands
// ---------------------------------------------------------------------------
test('1. 正文系统片段：表达规则与 persona 两段并存，互不覆盖', async (t) => {
  const app = await mount(t);
  const persona = app.render('assistant:persona');
  const expression = app.render('assistant:expression');

  assert.ok(expression.includes('同一结论通常表达一次。后续句子应补充新的事实、条件、理由或行动；'),
    'the rule text is in the functional system section');
  assert.ok(expression.includes('没有新增信息时，不换一种说法重述，也不在结尾再次总结。'));
  assert.ok(expression.includes('保留必要的强调、纠正和自然的情绪表达；若人设明确要求重复风格，以人设文本为准。'));
  assert.ok(persona.includes(PERSONA_LINE), 'the persona section is still rendered');
  assert.ok(!persona.includes('同一结论通常表达一次'), 'the rule never edits the persona text');
  assert.ok(expression.length > 0 && persona.length > 0, 'both sections render non-empty');
  assert.ok(app.render('assistant:persona') !== expression, 'two separate sections, never one overwriting the other');

  const all = app.prompt();
  assert.ok(all.includes(PERSONA_LINE) && all.includes('同一结论通常表达一次'), 'both survive in the assembled prompt');
  assert.ok(
    app.sections.get('assistant:expression').order > app.sections.get('assistant:persona').order,
    'the rule section follows the persona',
  );
  t.diagnostic(`persona=${persona.length}chars expression=${expression.length}chars order=${app.sections.get('assistant:expression').order}`);
});

// ---------------------------------------------------------------------------
// 2. condenseForSpeech asks for a condensed, non-repeating spoken version
// ---------------------------------------------------------------------------
test('2. 口语版请求体：包含提炼/不重复约束', async (t) => {
  const app = await mount(t);
  app.driveTypedTurn(1, REPEATED_BODY);
  await waitUntil(() => app.spokenRequests.length >= 1, 'the typed spoken-version request was made');
  const system = app.spokenRequests[0].system;
  assert.ok(system.includes('提炼核心回应，不逐段复述正文；不要重复正文里已经说过的铺陈与例子；'),
    'the condense request asks for a condensed rewrite');
  assert.ok(system.includes('输出一段连贯口语，一句话说清一个意思。'),
    'the condense request asks for one coherent spoken passage');
  assert.ok(system.includes('【人设】') && system.includes(PERSONA_LINE), 'persona is still passed to the rewrite');
  t.diagnostic(`spokenRequestSystemChars=${system.length} constraints=3/3`);
});

// ---------------------------------------------------------------------------
// 3. Redundancy is measured, never removed: repetitive body, unchanged text
// ---------------------------------------------------------------------------
test('3. 冗余度量：重复正文 body.simCandidates>0，正文与口语版逐字不变', async (t) => {
  const app = await mount(t);
  app.driveTypedTurn(1, REPEATED_BODY);
  const row = await app.waitForEvent('voice.reply.redundancy', (payload) => payload.turn === 1);

  assert.ok(row.body.simCandidates > 0, `repetitive body is detected: ${JSON.stringify(row.body)}`);
  assert.equal(row.body.sentences, 4, 'all four sentences are counted — none deleted before measuring');
  assert.equal(row.spoken.sentences, 1, 'the short spoken version has one sentence');
  assert.equal(row.spoken.simCandidates, 0, 'the spoken version itself is not repetitive');

  // The body really reached the rewrite verbatim: every repeated sentence is still there.
  const userText = app.spokenRequests[0].user;
  assert.ok(userText.includes(REPEATED_BODY), 'the body is unchanged: all repeated sentences reached the model');
  // The spoken version really is what was synthesized, character for character.
  await waitUntil(() => app.texts().length > 0, 'the spoken version is synthesized');
  await tick(20);
  assert.deepEqual(app.texts(), [SPOKEN_ONLY], 'the spoken version is played exactly as produced, not deduped');
  t.diagnostic(
    `body=${JSON.stringify(row.body)} spoken=${JSON.stringify(row.spoken)} `
    + `bodyChars=${[...REPEATED_BODY].length} synthesized=${JSON.stringify(app.texts())}`,
  );
});
