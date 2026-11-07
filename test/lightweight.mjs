/**
 * The lightweight task channel and the fast path's `assist` purpose.
 *
 * The real-host reasoning probe is a separate standalone script: test/reasoning-off-live.mjs.
 * It boots a real DSH host, calls the registered `llm.stream` service twice (off vs default),
 * and judges the provider's reasoning frames and first-text latency. This file keeps only the
 * deterministic contract tests and points at that script instead of treating an environment
 * variable as evidence.
 *
 * Run: node --test test/lightweight.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AUXILIARY_REASONING_EFFORT, FastPath } from '../src/host/session/inference/fastpath.js';
import {
  LIGHTWEIGHT_INPUT_TYPES,
  LIGHTWEIGHT_TASK_INPUT,
  LIGHTWEIGHT_TASKS,
  createLightweightChannel,
  estimateTokens,
  lightweightTimeout,
  renderLightweightInput,
} from '../src/host/session/inference/lightweight.js';

/** A FastPath over a temporary root whose only model access is the captured fake stream. */
async function assistFixture({ reasoningEfforts = ['off', 'low', 'high'], streamFactory = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lightweight-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await writeFile(join(root, 'data', 'conversation.jsonl'), [
    JSON.stringify({ ts: 1, role: 'user', text: '最近一句用户的话' }),
    JSON.stringify({ ts: 2, role: 'assistant', text: '最近一句助手的话' }),
  ].join('\n') + '\n', 'utf8');
  const requests = [];
  let clockMs = 1000;
  const llm = {
    resolveModelInfo: async () => ({
      provider: 'fake-provider',
      id: 'fake-model',
      reasoning: { efforts: reasoningEfforts.map((id) => ({ id })) },
    }),
    stream(options) {
      requests.push(options);
      return (streamFactory ?? (async function* generate() {
        clockMs += 10;
        yield { type: 'reasoning-delta', text: '先想一下' };
        clockMs += 20;
        yield { type: 'text-delta', text: '译文' };
        clockMs += 30;
        yield { type: 'finish', reason: { kind: 'stop' } };
      }))();
    },
  };
  const fastpath = new FastPath({
    root,
    getLlm: () => llm,
    getSelection: () => ({ currentSelection: () => ({ provider: 'fake-provider', model: 'fake-model' }) }),
    persona: { read: (which) => (which === 'agent' ? '人设ABC' : '画像DEF') },
    memory: { brief: () => ({ text: '记忆片段XYZ' }) },
    log: { emit: async () => {} },
    config: {},
    now: () => clockMs,
  });
  return {
    root, fastpath, requests, clock: () => clockMs, advance: (ms) => { clockMs += ms; },
    cleanup: () => rm(root, { recursive: true, force: true }).catch(() => {}),
  };
}

// ---------------------------------------------------------------------------
// A) assist uses the same context, the same selection and NO side effects
// ---------------------------------------------------------------------------

test('assist keeps the chat context (persona, profile, memory, recent turns) and adds the task rules', async (t) => {
  const fx = await assistFixture();
  t.after(fx.cleanup);
  const result = await fx.fastpath.assist({
    task: 'translate',
    system: '你是翻译器。只输出译文。',
    user: '<待译正文>今天天气很好。</待译正文>',
    instruction: '上下文只用于理解：只翻译目标正文。',
    reasoningEffort: 'off',
    maxTokens: 2048,
  });
  assert.equal(result.text, '译文');
  assert.equal(fx.requests.length, 1, 'one request, no retry');
  const request = fx.requests[0];
  assert.equal(request.provider, 'fake-provider');
  assert.equal(request.model, 'fake-model');
  assert.equal(request.maxTokens, 2048);
  // Same context assembly as FastPath.askStream: every part is present, nothing is trimmed.
  assert.match(request.system, /人设ABC/u);
  assert.match(request.system, /画像DEF/u);
  assert.match(request.system, /记忆片段XYZ/u);
  assert.match(request.system, /最近一句用户的话/u);
  assert.match(request.system, /最近一句助手的话/u);
  // The task prompt comes AFTER the context, so the last instruction is the task's.
  assert.ok(request.system.indexOf('人设ABC') < request.system.indexOf('你是翻译器'), 'task rules follow context');
  assert.match(request.system, /只翻译目标正文/u);
  assert.equal(fx.fastpath.history.length, 2, 'assist never appends to the fast-path chat history');
  const onDisk = await readFile(join(fx.root, 'data', 'conversation.jsonl'), 'utf8');
  assert.equal(onDisk.trim().split('\n').length, 2, 'nothing was written to the conversation file');
});

test('a context-free task sends only its own system + body and never touches memory', async (t) => {
  const fx = await assistFixture();
  t.after(fx.cleanup);
  let briefs = 0;
  fx.fastpath.memory = { brief: () => { briefs += 1; return { text: '记忆片段XYZ' }; } };
  fx.fastpath.assist = async () => { throw new Error('assist must not be used for context-free tasks'); };
  const channel = createLightweightChannel({ fastpath: fx.fastpath });
  const result = await channel.ask({
    task: 'spoken',
    context: 'none',
    system: '【人设】\n人设ABC\n\n只输出口语版。',
    user: '<完整答复>\n要读的正文\n</完整答复>',
  });
  assert.equal(result.text, '译文');
  assert.equal(briefs, 0, 'no memory retrieval for the spoken-version rewrite');
  assert.equal(result.context, '', 'no shared context block was assembled');
  assert.match(fx.requests[0].system, /人设ABC/u);
  assert.doesNotMatch(fx.requests[0].system, /记忆片段XYZ/u);
  assert.match(fx.requests[0].messages[0].content[0].text, /要读的正文/u);
});

test('assist reports first text, completion and reasoning frames from the actual stream', async (t) => {
  const fx = await assistFixture();
  t.after(fx.cleanup);
  const result = await fx.fastpath.assist({ task: 'ack', user: '帮我查一下天气' });
  assert.equal(result.text, '译文');
  assert.equal(result.reasoningChars, 4, 'reasoning frames are counted, never appended to the body');
  assert.equal(result.firstDeltaMs, 30, 'the first TEXT delta is the anchor (not the reasoning frame)');
  assert.equal(result.doneMs, 60, 'done is measured at the finish frame');
  assert.equal(result.complete, true);
  assert.equal(result.finishKind, 'stop');
  assert.equal(result.context.length > 0, true, 'the exact context block comes back for boundary checks');
});

// ---------------------------------------------------------------------------
// B) the reasoning control is the real per-request field
// ---------------------------------------------------------------------------

test('assist sends reasoningEffort exactly on the request when the route declares off', async (t) => {
  const fx = await assistFixture();
  t.after(fx.cleanup);
  assert.equal(await fx.fastpath.supportsReasoning('off'), true);
  await fx.fastpath.assist({ task: 'translate', user: '目标正文', reasoningEffort: 'off' });
  assert.equal(fx.requests[0].reasoningEffort, 'off', 'the top-level GenerateOptions field is set');
  assert.equal(fx.requests[0].thinking, undefined, 'there is no per-request thinking object to send');
  assert.equal(fx.requests[0].reasoning, undefined, 'there is no per-request reasoning object to send');
});

test('a route without off: channel sends no control and reports unsupported', async (t) => {
  const fx = await assistFixture({ reasoningEfforts: ['low', 'high'] });
  t.after(fx.cleanup);
  const channel = createLightweightChannel({ fastpath: fx.fastpath, options: { reasoning: 'off' } });
  const result = await channel.ask({ task: 'translate', user: '目标正文' });
  assert.equal(result.reasoning, 'unsupported');
  assert.equal(fx.requests[0].reasoningEffort, undefined, 'an unsupported effort is never sent');
});

test('a dispatch refusal is retried once without the control inside the same total budget', async (t) => {
  const fx = await assistFixture({ reasoningEfforts: ['off'] });
  t.after(fx.cleanup);
  // First dispatch refuses the effort; the route capability said it exists, so this is the
  // provider-level refusal path and the channel must retry without it.
  let calls = 0;
  // First dispatch refuses the effort; the route capability said it exists, so this is the
  // provider-level refusal path and the channel must retry without it.
  fx.fastpath.getLlm = () => ({
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }] } }),
    stream(options) {
      calls += 1;
      fx.requests.push(options);
      if (calls === 1) {
        return (async function* fail() {
          throw Object.assign(new Error('DeepSeek Messages does not support reasoning effort off'), { code: 'UNSUPPORTED_REASONING_EFFORT' });
        })();
      }
      return (async function* ok() {
        yield { type: 'text-delta', text: '译文' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  });
  const channel = createLightweightChannel({ fastpath: fx.fastpath, options: { reasoning: 'off' } });
  const result = await channel.ask({
    task: 'translate', input: { text: '目标正文', targetLang: 'ja' }, timeoutMs: 5000,
  });
  assert.equal(calls, 2, 'exactly one fallback attempt');
  assert.equal(result.retries, 1);
  assert.equal(result.reasoning, 'unsupported');
  assert.equal(fx.requests[0].reasoningEffort, 'off');
  assert.equal(fx.requests[1].reasoningEffort, undefined, 'the retry carries no control');
});

test('the retry cap stays one: a second unsupported refusal fails instead of looping', async (t) => {
  const fx = await assistFixture({ reasoningEfforts: ['off'] });
  t.after(fx.cleanup);
  let calls = 0;
  fx.fastpath.getLlm = () => ({
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }] } }),
    stream() {
      calls += 1;
      return (async function* refuse() {
        throw Object.assign(new Error('UNSUPPORTED_REASONING_EFFORT'), { code: 'UNSUPPORTED_REASONING_EFFORT' });
      })();
    },
  });
  const channel = createLightweightChannel({ fastpath: fx.fastpath, options: { reasoning: 'off' } });
  await assert.rejects(
    () => channel.ask({ task: 'translate', input: { text: '目标正文', targetLang: 'ja' }, timeoutMs: 5000 }),
    /UNSUPPORTED_REASONING_EFFORT/u,
  );
  assert.equal(calls, 2, 'one attempt + exactly one retry, never a third');
  assert.equal(channel.stats().retries, 1);
});

// ---------------------------------------------------------------------------
// C2) Explicit input packages: one type per auxiliary task, rendered by the channel
// ---------------------------------------------------------------------------

test('the exported package types match the task contract', () => {
  assert.deepEqual(Object.keys(LIGHTWEIGHT_INPUT_TYPES).sort(),
    ['ack', 'asrPost', 'kana', 'motion', 'quiz', 'spoken', 'tone', 'translate']);
  assert.deepEqual([...LIGHTWEIGHT_INPUT_TYPES.translate], ['text', 'targetLang', 'glossary?', 'tone?', 'neighbors?[]']);
  assert.deepEqual([...LIGHTWEIGHT_INPUT_TYPES.kana], ['text', 'names?[]']);
  assert.deepEqual([...LIGHTWEIGHT_INPUT_TYPES.spoken], ['answer', 'persona']);
  assert.deepEqual([...LIGHTWEIGHT_INPUT_TYPES.tone], ['fragments', 'side']);
  assert.deepEqual([...LIGHTWEIGHT_INPUT_TYPES.motion], ['personaText', 'schema']);
  assert.deepEqual([...LIGHTWEIGHT_INPUT_TYPES.quiz], ['answers', 'constraints']);
  assert.deepEqual([...LIGHTWEIGHT_INPUT_TYPES.asrPost], ['text', 'terms?[]', 'previous?[]']);
  assert.deepEqual([...LIGHTWEIGHT_INPUT_TYPES.ack], ['persona', 'userText', 'recent?[]']);
  assert.deepEqual(
    Object.fromEntries(Object.entries(LIGHTWEIGHT_TASK_INPUT).sort()),
    {
      ack: 'ack',
      'asr-post': 'asrPost',
      kana: 'kana',
      'motion-style': 'motion',
      'persona-quiz': 'quiz',
      spoken: 'spoken',
      'tone-repair': 'tone',
      translate: 'translate',
    },
  );
  assert.throws(() => renderLightweightInput('waiting-hint', {}), /no lightweight input package/u);
  assert.throws(() => renderLightweightInput('chat', {}), /no lightweight input package/u);
});

test('each input package renders only its own fields; unrelated memory/persona keys never leak', () => {
  const MEMORY = '记忆片段XYZ';
  const PROFILE = '画像DEF';
  const cases = [
    ['translate', {
      text: '待译正文甲', targetLang: 'ja', glossary: '术语甲', tone: '语气甲', neighbors: ['相邻句甲'],
      memory: MEMORY, profile: PROFILE, system: '人设ABC',
    }, ['待译正文甲', '术语甲', '语气甲', '相邻句甲']],
    ['kana', { text: '假名正文甲', names: ['专名甲'], memory: MEMORY }, ['假名正文甲', '专名甲']],
    ['tone-repair', { fragments: ['我喜欢安静'], side: 'user', memory: MEMORY }, ['我喜欢安静', '用户画像']],
    ['motion-style', { personaText: '人设甲', schema: '输出模式甲', memory: MEMORY }, ['人设甲', '输出模式甲']],
    ['persona-quiz', { answers: ['问卷回答甲'], constraints: '约束甲', memory: MEMORY }, ['问卷回答甲', '约束甲']],
    ['asr-post', { text: '识别文本甲', terms: ['术语甲'], previous: ['前文甲'], memory: MEMORY }, ['识别文本甲', '术语甲', '前文甲']],
    ['ack', { persona: '人设甲', userText: '当前消息甲', recent: ['近期候音甲'], memory: MEMORY }, ['人设甲', '当前消息甲', '近期候音甲']],
    ['spoken', { answer: '完整答复甲', persona: '人设甲', memory: MEMORY }, ['完整答复甲', '人设甲']],
  ];
  for (const [task, input, expected] of cases) {
    const rendered = renderLightweightInput(task, input);
    const text = `${rendered.system}\n${rendered.user}`;
    for (const value of expected) assert.ok(text.includes(value), `${task} keeps ${value}`);
    for (const unrelated of [MEMORY, PROFILE, '人设ABC']) {
      assert.ok(!text.includes(unrelated), `${task} never includes ${unrelated}`);
    }
    assert.equal(rendered.chars, [...rendered.system].length + [...rendered.user].length);
    assert.equal(rendered.tokensEstimate, estimateTokens(rendered.chars));
    assert.equal(rendered.tokensEstimate, Math.ceil(rendered.chars / 2));
  }
  // The target of a translation sits in its own block; neighbours stay outside it.
  const translate = renderLightweightInput('translate', { text: '待译正文甲', targetLang: 'ja', neighbors: ['相邻句甲'] });
  assert.ok(translate.user.includes('<待译正文>\n待译正文甲\n</待译正文>'));
  assert.ok(!translate.user.includes('相邻句甲'), 'neighbouring sentences are context, not target');
  console.log(`packages=${cases.map(([task]) => task).join(',')} chars=${cases.map(([task, input]) => `${task}:${renderLightweightInput(task, input).chars}`).join(' ')} leaked=0`);
});

test('a packaged task is a direct call: no memory, no context assembly, no fastpath.assist', async (t) => {
  const fx = await assistFixture();
  t.after(fx.cleanup);
  let briefs = 0;
  fx.fastpath.memory = { brief: () => { briefs += 1; return { text: '记忆片段XYZ' }; } };
  let assistCalls = 0;
  const original = fx.fastpath.assist.bind(fx.fastpath);
  fx.fastpath.assist = async (options) => { assistCalls += 1; return original(options); };
  const channel = createLightweightChannel({ fastpath: fx.fastpath });
  const result = await channel.ask({
    task: 'translate',
    input: { text: '今天天气很好。', targetLang: 'ja' },
    maxTokens: 256,
  });
  assert.equal(result.text, '译文');
  assert.equal(result.context, '', 'no shared context block was assembled');
  assert.equal(briefs, 0, 'memory retrieval is never consulted for a package');
  assert.equal(assistCalls, 0, 'a package never borrows the full-context assist purpose');
  assert.equal(fx.requests.length, 1);
  assert.doesNotMatch(fx.requests[0].system, /人设ABC|画像DEF|记忆片段XYZ|最近一句/iu,
    'the chat context is absent from the request');
  assert.match(fx.requests[0].system, /翻译/u, 'the channel rendered the translator prompt');
  assert.match(fx.requests[0].messages[0].content[0].text, /今天天气很好/u);
  console.log(`direct briefs=${briefs} assistCalls=${assistCalls} requests=${fx.requests.length} context="${result.context}"`);
});

test('a packaged task that times out fails; fastpath.assist is never called as a fallback', async (t) => {
  const fx = await assistFixture({
    streamFactory: () => (async function* hang() {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    })(),
  });
  t.after(fx.cleanup);
  let assistCalls = 0;
  fx.fastpath.assist = async () => { assistCalls += 1; throw new Error('assist must not be used'); };
  const events = [];
  const channel = createLightweightChannel({
    fastpath: fx.fastpath,
    emit: (type, payload) => { events.push({ type, ...payload }); },
  });
  const started = Date.now();
  await assert.rejects(
    () => channel.ask({
      task: 'kana', input: { text: '目标正文' }, timeoutMs: 120,
    }),
    (error) => error?.name === 'TimeoutError',
  );
  assert.ok(Date.now() - started < 2000, 'the deadline ended the call');
  assert.equal(assistCalls, 0, 'no implicit fallback to the full-context channel');
  assert.equal(channel.stats().failed, 1);
  const failed = events.find((event) => event.type === 'lightweight.request' && event.failed === true);
  assert.ok(failed !== undefined);
  assert.equal(failed.task, 'kana');
  assert.ok(failed.input.chars > 0, 'the failed row still reports the input size');
  assert.equal(failed.retries, 0);
  console.log(`timeout error=TimeoutError elapsed=${Date.now() - started}ms assistCalls=${assistCalls} failedRows=1 inputChars=${failed.input.chars}`);
});

test('a packaged request reports the rendered package size in one unified telemetry row', async (t) => {
  const fx = await assistFixture();
  t.after(fx.cleanup);
  const events = [];
  const channel = createLightweightChannel({
    fastpath: fx.fastpath,
    emit: (type, payload) => { events.push({ type, ...payload }); },
  });
  const input = { text: '今天天气很好。', targetLang: 'ja' };
  const rendered = renderLightweightInput('translate', input);
  const result = await channel.ask({ task: 'translate', input, maxTokens: 256 });
  const row = events.find((event) => event.type === 'lightweight.request');
  assert.equal(row.task, 'translate');
  assert.equal(row.input.chars, rendered.chars, 'the row carries the rendered package characters');
  assert.equal(row.input.tokensEstimate, rendered.tokensEstimate);
  assert.equal(result.inputChars, rendered.chars);
  assert.equal(row.failed, false);
  assert.equal(row.retries, 0);
  for (const field of ['firstTextMs', 'doneMs', 'reasoningChars']) {
    assert.equal(typeof row[field], 'number', `${field} is measured`);
  }
  console.log(`telemetry task=${row.task} inputChars=${row.input.chars} tokensEstimate=${row.input.tokensEstimate} firstTextMs=${row.firstTextMs} doneMs=${row.doneMs} reasoningChars=${row.reasoningChars} retries=${row.retries} failed=${row.failed}`);
});

// ---------------------------------------------------------------------------
// C) the task contract, metrics and one total deadline
// ---------------------------------------------------------------------------

test('every task name is accepted and an unknown name is a programming error', async (t) => {
  const fx = await assistFixture();
  t.after(fx.cleanup);
  const channel = createLightweightChannel({ fastpath: fx.fastpath });
  assert.deepEqual(LIGHTWEIGHT_TASKS, [
    'translate', 'kana', 'ack', 'waiting-hint', 'tone-repair',
    'persona-rewrite', 'persona-quiz', 'motion-style', 'asr-post', 'spoken',
  ]);
  for (const task of LIGHTWEIGHT_TASKS) {
    const result = await channel.ask({ task, user: '目标正文' });
    assert.equal(result.task, task);
  }
  await assert.rejects(() => channel.ask({ task: 'chat', user: 'x' }), /unknown lightweight task/u);
});

test('the lightweight.request event carries the measured fields', async (t) => {
  const fx = await assistFixture();
  t.after(fx.cleanup);
  const events = [];
  const channel = createLightweightChannel({
    fastpath: fx.fastpath,
    emit: (type, payload) => { events.push({ type, ...payload }); },
  });
  await channel.ask({ task: 'ack', user: '帮我查一下天气', maxTokens: 48 });
  const row = events.find((event) => event.type === 'lightweight.request');
  assert.ok(row !== undefined);
  assert.equal(row.task, 'ack');
  assert.equal(row.reasoning, 'off');
  assert.equal(row.firstTextMs, 30);
  assert.equal(row.firstDeltaMs, 30);
  assert.equal(row.doneMs, 60);
  assert.equal(row.reasoningChars, 4);
  assert.equal(row.retries, 0);
  assert.equal(row.failed, false);
  assert.equal(typeof row.contextChars, 'number');
  assert.equal(typeof row.targetChars, 'number');
  assert.equal(row.model, 'fake-model');
  // The unified input shape is on every row, including the legacy explicit-prompt path.
  assert.equal(row.input.chars, [...'帮我查一下天气'].length);
  assert.equal(row.input.tokensEstimate, Math.ceil(row.input.chars / 2));
});

test('one total deadline covers the call; a hang rejects as TimeoutError and increments failed', async (t) => {
  const fx = await assistFixture({
    streamFactory: () => (async function* slow() {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    })(),
  });
  t.after(fx.cleanup);
  const events = [];
  const channel = createLightweightChannel({
    fastpath: fx.fastpath,
    emit: (type, payload) => { events.push({ type, ...payload }); },
  });
  const started = Date.now();
  await assert.rejects(
    () => channel.ask({ task: 'waiting-hint', user: '目标正文', timeoutMs: 120 }),
    (error) => error?.name === 'TimeoutError',
  );
  assert.ok(Date.now() - started < 2000, 'the deadline ended the call instead of waiting for the stream');
  assert.equal(channel.stats().failed, 1);
  const failed = events.find((event) => event.type === 'lightweight.request' && event.failed === true);
  assert.ok(failed !== undefined, 'the failure is observable');
});

test('lightweightTimeout clamps into the shared range', () => {
  assert.equal(lightweightTimeout(undefined, 15000), 15000);
  assert.equal(lightweightTimeout(1, 15000), 100);
  assert.equal(lightweightTimeout(999999, 15000), 60000);
  assert.equal(lightweightTimeout('250', 15000), 250);
});

// ---------------------------------------------------------------------------
// D) the capability probe shares the ONE deadline and cancellation
// ---------------------------------------------------------------------------

test('a hung capability probe cannot outlive the total budget', async (t) => {
  const fx = await assistFixture();
  t.after(fx.cleanup);
  let probes = 0;
  fx.fastpath.supportsReasoning = () => { probes += 1; return new Promise(() => {}); };
  const events = [];
  const channel = createLightweightChannel({
    fastpath: fx.fastpath,
    emit: (type, payload) => { events.push({ type, ...payload }); },
  });
  const started = Date.now();
  await assert.rejects(
    () => channel.ask({ task: 'translate', user: '目标正文', timeoutMs: 100 }),
    (error) => error?.name === 'TimeoutError',
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 250, `returned in ${elapsed}ms instead of waiting for the probe`);
  assert.equal(probes, 1, 'the hung probe is attempted once');
  assert.equal(fx.requests.length, 0, 'a probe that consumes the budget never dispatches a request');
  const capability = events.find((event) => event.type === 'lightweight.capability');
  assert.equal(capability?.status, 'timeout');
  assert.equal(typeof capability?.ms, 'number');
  t.diagnostic(`budget=100ms elapsed=${elapsed}ms error=TimeoutError capability=${capability?.status}`);
});

test('a probe timeout is unknown capability: the request still runs and succeeds', async (t) => {
  const fx = await assistFixture();
  t.after(fx.cleanup);
  let probes = 0;
  fx.fastpath.supportsReasoning = () => { probes += 1; return new Promise(() => {}); };
  const events = [];
  const channel = createLightweightChannel({
    fastpath: fx.fastpath,
    emit: (type, payload) => { events.push({ type, ...payload }); },
  });
  const started = Date.now();
  const result = await channel.ask({ task: 'translate', user: '目标正文', timeoutMs: 500 });
  assert.equal(result.text, '译文');
  assert.ok(Date.now() - started < 500, 'the probe timeout leaves room for the request');
  assert.equal(probes, 1, 'the probe runs once, never again on the request path');
  assert.equal(fx.requests.length, 1, 'the request is dispatched exactly once');
  assert.equal(fx.requests[0].reasoningEffort, 'off', 'unknown capability applies the configured policy');
  assert.equal(result.reasoning, 'off');
  const capability = events.find((event) => event.type === 'lightweight.capability');
  assert.equal(capability?.status, 'timeout');
  t.diagnostic(`budget=500ms elapsed=${Date.now() - started}ms probes=${probes} requests=${fx.requests.length} capability=timeout`);
});

test('cancellation during the capability probe ends the call without a request', async (t) => {
  const fx = await assistFixture();
  t.after(fx.cleanup);
  let probes = 0;
  fx.fastpath.supportsReasoning = () => { probes += 1; return new Promise(() => {}); };
  const channel = createLightweightChannel({ fastpath: fx.fastpath });
  const controller = new AbortController();
  const started = Date.now();
  const pending = channel.ask({
    task: 'translate', user: '目标正文', timeoutMs: 5000, signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, (error) => error?.name === 'AbortError');
  assert.ok(Date.now() - started < 500, 'cancellation ends the probe immediately');
  assert.equal(probes, 1);
  assert.equal(fx.requests.length, 0, 'no request is dispatched after cancellation');
  t.diagnostic(`cancelled after 10ms elapsed=${Date.now() - started}ms requests=0 error=AbortError`);
});

test('the capability answer is cached briefly and the cache hit skips the probe', async (t) => {
  const fx = await assistFixture();
  t.after(fx.cleanup);
  let probes = 0;
  let clock = 1000;
  fx.fastpath.supportsReasoning = async () => { probes += 1; return true; };
  const events = [];
  const channel = createLightweightChannel({
    fastpath: fx.fastpath,
    emit: (type, payload) => { events.push({ type, ...payload }); },
    options: { now: () => clock },
  });
  await channel.ask({ task: 'ack', user: '帮我查一下天气' });
  clock += 1000;
  await channel.ask({ task: 'ack', user: '帮我查一下天气' });
  assert.equal(probes, 1, 'the second call is served from the cache');
  assert.equal(fx.requests.length, 2, 'both calls still dispatch their request');
  const statuses = events
    .filter((event) => event.type === 'lightweight.capability')
    .map((event) => event.status);
  assert.deepEqual(statuses, ['ok', 'cached']);
  clock += 30_000;
  await channel.ask({ task: 'ack', user: '帮我查一下天气' });
  assert.equal(probes, 2, 'the answer expires after 30s and is probed again');
  t.diagnostic(`probes=${probes} capability=${statuses.join(',')} expiredProbe=yes`);
});

// ---------------------------------------------------------------------------
// D2) The streamed task request shares ONE policy with the lightweight channel
// ---------------------------------------------------------------------------

test('taskStream sends the same reasoning-off policy as the lightweight channel, with no context', async (t) => {
  const fx = await assistFixture();
  t.after(fx.cleanup);
  assert.equal(AUXILIARY_REASONING_EFFORT, 'off', 'the shared policy constant is the reasoning control');
  let briefs = 0;
  fx.fastpath.memory = { brief: () => { briefs += 1; return { text: '记忆片段XYZ' }; } };
  const channel = createLightweightChannel({ fastpath: fx.fastpath, options: { reasoning: 'off' } });
  const prompt = {
    system: '【人设】\n人设ABC\n\n只输出一段可直接朗读的口语版。',
    user: '<完整答复>\n要读的正文\n</完整答复>',
  };
  const viaChannel = await channel.ask({ task: 'spoken', context: 'none', ...prompt, maxTokens: 512 });
  assert.equal(viaChannel.text, '译文');
  // The streamed caller (the spoken rewrite) consumes the RAW stream: the same request, not a
  // buffered channel result.
  const deltas = [];
  let finished = false;
  for await (const chunk of fx.fastpath.taskStream({ ...prompt, maxTokens: 512 })) {
    if (chunk?.type === 'text-delta') deltas.push(chunk.text);
    if (chunk?.type === 'finish') finished = true;
  }
  assert.deepEqual(deltas, ['译文'], 'the raw deltas reach the streaming caller');
  assert.equal(finished, true, 'the finish frame is forwarded, not swallowed');
  assert.equal(fx.requests.length, 2, 'one request per sender, no retry');
  const [light, direct] = fx.requests;
  assert.equal(light.reasoningEffort, 'off', 'the lightweight channel sends off');
  assert.equal(direct.reasoningEffort, 'off', 'the streamed task sends the SAME off policy');
  assert.equal(direct.provider, light.provider, 'same route');
  assert.equal(direct.model, light.model);
  assert.equal(direct.maxTokens, light.maxTokens, 'same output budget');
  assert.equal(direct.signal, undefined, 'no signal is invented when the caller passes none');
  assert.equal(briefs, 0, 'no memory retrieval on either sender');
  assert.doesNotMatch(String(direct.system), /记忆片段XYZ|最近一句/iu, 'the streamed task is context-free');
  assert.match(String(direct.system), /人设ABC/u);
  assert.equal(direct.messages[0].content[0].text, prompt.user);
  t.diagnostic(
    `channelReasoning=${light.reasoningEffort} streamReasoning=${direct.reasoningEffort} `
    + `sameRoute=${direct.provider === light.provider && direct.model === light.model} `
    + `maxTokens=${direct.maxTokens} deltas=${deltas.length} briefs=${briefs}`,
  );
});

test('the other lightweight requests keep their parameters: translate and kana still send off', async (t) => {
  const fx = await assistFixture();
  t.after(fx.cleanup);
  const channel = createLightweightChannel({ fastpath: fx.fastpath, options: { reasoning: 'off' } });
  const translate = await channel.ask({
    task: 'translate',
    input: { text: '今天天气很好。', targetLang: 'ja' },
    maxTokens: 256,
  });
  assert.equal(translate.text, '译文');
  const kana = await channel.ask({
    task: 'kana',
    input: { text: '今日はいい天気ですね。' },
    maxTokens: 128,
  });
  assert.equal(kana.text, '译文');
  assert.equal(fx.requests.length, 2);
  const [translation, script] = fx.requests;
  assert.equal(translation.reasoningEffort, 'off', 'translate still sends the reasoning control');
  assert.equal(script.reasoningEffort, 'off', 'kana still sends the reasoning control');
  assert.equal(translation.maxTokens, 256, 'translate keeps its own token budget');
  assert.equal(script.maxTokens, 128, 'kana keeps its own token budget');
  assert.ok(String(translation.system).includes('翻译'), 'the translator prompt is still the channel-rendered one');
  assert.doesNotMatch(String(translation.system), /人设ABC|画像DEF|记忆片段XYZ|最近一句/iu,
    'translate is still context-free');
  assert.match(String(translation.messages[0].content[0].text), /今天天气很好/u);
  assert.doesNotMatch(String(script.system), /人设ABC|画像DEF|记忆片段XYZ|最近一句/iu,
    'kana is still context-free');
  t.diagnostic(
    `translate=off/${translation.maxTokens} kana=off/${script.maxTokens} `
    + `reasoning=${[translation.reasoningEffort, script.reasoningEffort].join(',')}`,
  );
});

// ---------------------------------------------------------------------------
// E) Real-host probe lives in test/reasoning-off-live.mjs (always skipped here)
// ---------------------------------------------------------------------------

test('placeholder: the real reasoning off/default probe is test/reasoning-off-live.mjs', {
  skip: 'not a host-run case: the live probe is test/reasoning-off-live.mjs and must be run '
    + 'with REASONING_LIVE=1. It uses the registered llm.stream service, real credentials, '
    + 'and paid requests; merely setting an environment variable here proves no provider behavior.',
}, async () => {
  // Unreachable while the skip above exists. If it is ever removed, fail loudly instead of
  // pretending a plain test-runner process has the host's `llm` service and credentials.
  throw new Error('the live reasoning probe is test/reasoning-off-live.mjs; run it with REASONING_LIVE=1');
});
