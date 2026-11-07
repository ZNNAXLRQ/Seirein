/**
 * P-51: reasoning effort is a PER-REQUEST parameter, isolated per call.
 *
 * What this proves (deterministic fakes only, no real provider):
 *  1. every auxiliary request carries the shared `off` policy while the main chat request carries
 *     no reasoning control at all (the model default), and neither changes any other field;
 *  2. two requests with different efforts issued at the same time keep their own value — the
 *     effort is turn-local, never a channel/instance-wide switch;
 *  3. a provider that refuses `off` is retried ONCE without the control, the call succeeds, and
 *     `reasoning.downgraded {requested, fallback, reason}` is recorded;
 *  4. the downgrade happens exactly once: a second refusal fails the call instead of looping;
 *  5. the main chat path honors a per-request effort / configured default and downgrades the same
 *     way, so the two request purposes share one rule.
 *
 * Run: node --test test/reasoning-isolation.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AUXILIARY_REASONING_EFFORT, FastPath } from '../src/host/session/inference/fastpath.js';
import { createLightweightChannel } from '../src/host/session/inference/lightweight.js';

const RESPONSE = '答复';
const textOf = (request) => String(request?.messages?.[0]?.content?.[0]?.text ?? '');

/**
 * A FastPath over a temporary root whose only model access is the captured fake stream.
 * `refuse(call, options)` decides per dispatch whether the provider throws the unsupported-effort
 * error; `hold` keeps every stream open until `release()` so concurrent calls really overlap.
 */
async function fixture({ efforts = ['off', 'low', 'high'], refuse = null, hold = false, config = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-reasoning-isolation-'));
  await mkdir(join(root, 'data'), { recursive: true });
  const requests = [];
  const events = [];
  let calls = 0;
  let releaseGate = () => {};
  const gate = hold ? new Promise((resolve) => { releaseGate = resolve; }) : null;
  const llm = {
    resolveModelInfo: async () => ({
      provider: 'fake-provider',
      id: 'fake-model',
      reasoning: { efforts: efforts.map((id) => ({ id })) },
    }),
    stream(options) {
      requests.push(options);
      calls += 1;
      const call = calls;
      if (typeof refuse === 'function' && refuse(call, options)) {
        return (async function* refused() {
          throw Object.assign(
            new Error('DeepSeek Messages does not support reasoning effort'),
            { code: 'UNSUPPORTED_REASONING_EFFORT' },
          );
        })();
      }
      return (async function* answer() {
        if (gate !== null) await gate;
        yield { type: 'text-delta', text: RESPONSE };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  };
  const fastpath = new FastPath({
    root,
    getLlm: () => llm,
    getSelection: () => ({ currentSelection: () => ({ provider: 'fake-provider', model: 'fake-model' }) }),
    persona: { read: (which) => (which === 'agent' ? '人设ABC' : '画像DEF') },
    memory: { brief: () => ({ text: '记忆片段XYZ' }) },
    log: { emit: (type, payload) => { events.push({ type, ...payload }); } },
    config,
  });
  const waitForRequests = async (count, timeoutMs = 3000) => {
    const startedAt = Date.now();
    while (requests.length < count) {
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`timed out waiting for ${count} requests; got ${requests.length}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  return {
    root,
    fastpath,
    requests,
    events,
    waitForRequests,
    release: () => releaseGate(),
    cleanup: () => rm(root, { recursive: true, force: true }).catch(() => {}),
  };
}

function channelOver(fx, events = []) {
  return createLightweightChannel({
    fastpath: fx.fastpath,
    emit: (type, payload) => { events.push({ type, ...payload }); },
  });
}

// ---------------------------------------------------------------------------
// 1) Auxiliary request = off; main chat request = no control (model default)
// ---------------------------------------------------------------------------

test('P-51 auxiliary requests carry off, the main chat request carries no reasoning control', async (t) => {
  const fx = await fixture();
  t.after(fx.cleanup);
  const channel = channelOver(fx);

  const auxiliary = await channel.ask({
    task: 'translate',
    input: { text: '今天天气很好。', targetLang: 'ja' },
    maxTokens: 256,
  });
  const main = await fx.fastpath.askStream('你好');

  assert.equal(auxiliary.text, RESPONSE);
  assert.equal(main.reply, RESPONSE);
  assert.equal(fx.requests.length, 2, 'one probe has no request; one request per purpose');

  const auxiliaryRequest = fx.requests.find((request) => textOf(request).includes('今天天气很好'));
  const mainRequest = fx.requests.find((request) => textOf(request) === '你好');
  assert.ok(auxiliaryRequest !== undefined, 'the auxiliary request was captured');
  assert.ok(mainRequest !== undefined, 'the main chat request was captured');

  assert.equal(AUXILIARY_REASONING_EFFORT, 'off');
  assert.equal(auxiliaryRequest.reasoningEffort, 'off', 'the auxiliary request explicitly sends off');
  assert.equal(Object.hasOwn(mainRequest, 'reasoningEffort'), false,
    'the main chat request omits the control and lets the model use its default');

  // Requirement: the control must not change any other request field.
  for (const request of [auxiliaryRequest, mainRequest]) {
    assert.equal(request.provider, 'fake-provider');
    assert.equal(request.model, 'fake-model');
    assert.equal(typeof request.maxTokens, 'number');
    assert.equal(Array.isArray(request.messages), true);
    assert.equal(typeof request.system, 'string');
    assert.equal(Object.hasOwn(request, 'thinking'), false, 'no separate thinking object');
    assert.equal(Object.hasOwn(request, 'reasoning'), false, 'no separate reasoning object');
  }
  assert.equal(auxiliaryRequest.maxTokens, 256, 'the auxiliary output budget is unchanged');
  assert.notEqual(auxiliaryRequest.system, mainRequest.system, 'the two prompts stay their own');
  t.diagnostic(`auxReasons=${auxiliaryRequest.reasoningEffort} mainHasReasoningEffort=${Object.hasOwn(mainRequest, 'reasoningEffort')} requests=${fx.requests.length}`);
});

// ---------------------------------------------------------------------------
// 2) Concurrent requests with different efforts do not contaminate each other
// ---------------------------------------------------------------------------

test('P-51 concurrent requests keep their own effort, no cross-request contamination', async (t) => {
  const fx = await fixture({ hold: true });
  t.after(fx.cleanup);
  const channel = channelOver(fx);

  const mainPromise = fx.fastpath.askStream('主对话正文', { reasoningEffort: 'low' });
  const auxiliaryPromise = channel.ask({
    task: 'kana',
    input: { text: '今日はいい天気ですね。' },
  });
  // Both requests are dispatched before either stream is allowed to answer.
  await fx.waitForRequests(2);
  fx.release();
  const [main, auxiliary] = await Promise.all([mainPromise, auxiliaryPromise]);

  assert.equal(main.reply, RESPONSE);
  assert.equal(auxiliary.text, RESPONSE);
  assert.equal(fx.requests.length, 2, 'no hidden retry and no extra request');

  const mainRequest = fx.requests.find((request) => textOf(request) === '主对话正文');
  const auxiliaryRequest = fx.requests.find((request) => textOf(request).includes('今日はいい天気'));
  assert.ok(mainRequest !== undefined);
  assert.ok(auxiliaryRequest !== undefined);

  assert.equal(mainRequest.reasoningEffort, 'low', 'the chat request keeps its own low effort');
  assert.equal(auxiliaryRequest.reasoningEffort, 'off', 'the auxiliary request keeps the off policy');
  assert.equal(fx.requests.filter((request) => request.reasoningEffort === 'low').length, 1);
  assert.equal(fx.requests.filter((request) => request.reasoningEffort === 'off').length, 1);
  // No leak in the other direction either: the auxiliary prompt is context-free, the chat is not.
  assert.match(mainRequest.system, /人设ABC/u);
  assert.doesNotMatch(auxiliaryRequest.system, /人设ABC|画像DEF|记忆片段XYZ|最近一句/iu);
  t.diagnostic(`concurrent main=${mainRequest.reasoningEffort} auxiliary=${auxiliaryRequest.reasoningEffort} requests=${fx.requests.length}`);
});

// ---------------------------------------------------------------------------
// 3) A refused off is retried once without the control and reported as downgraded
// ---------------------------------------------------------------------------

test('P-51 a refused off retries once without the control, succeeds and logs reasoning.downgraded', async (t) => {
  const fx = await fixture({ refuse: (call, options) => call === 1 && options.reasoningEffort === 'off' });
  t.after(fx.cleanup);
  const events = [];
  const channel = channelOver(fx, events);

  const result = await channel.ask({
    task: 'translate',
    input: { text: '目标正文', targetLang: 'ja' },
    timeoutMs: 5000,
  });

  assert.equal(result.text, RESPONSE, 'the downgraded request still answers normally');
  assert.equal(result.retries, 1);
  assert.equal(fx.requests.length, 2, 'exactly one fallback attempt');
  assert.equal(fx.requests[0].reasoningEffort, 'off', 'the first attempt carried the requested off');
  assert.equal(Object.hasOwn(fx.requests[1], 'reasoningEffort'), false, 'the retry carries no control');

  const downgraded = events.filter((event) => event.type === 'reasoning.downgraded');
  assert.equal(downgraded.length, 1, 'the downgrade is recorded exactly once');
  assert.equal(downgraded[0].requested, 'off');
  assert.equal(downgraded[0].fallback, 'default');
  assert.match(String(downgraded[0].reason), /unsupported|UNSUPPORTED/u);
  t.diagnostic(`requests=${fx.requests.length} first=${fx.requests[0].reasoningEffort} retryHasEffort=${Object.hasOwn(fx.requests[1], 'reasoningEffort')} retries=${result.retries} downgraded=${downgraded.length} requested=${downgraded[0].requested} fallback=${downgraded[0].fallback} reason=${downgraded[0].reason}`);
});

// ---------------------------------------------------------------------------
// 4) The downgrade is terminal: never a loop
// ---------------------------------------------------------------------------

test('P-51 the downgrade happens once; a second refusal fails instead of looping', async (t) => {
  const fx = await fixture({ refuse: () => true });
  t.after(fx.cleanup);
  const events = [];
  const channel = channelOver(fx, events);

  await assert.rejects(
    () => channel.ask({ task: 'translate', input: { text: '目标正文', targetLang: 'ja' }, timeoutMs: 5000 }),
    (error) => error?.code === 'UNSUPPORTED_REASONING_EFFORT',
  );

  assert.equal(fx.requests.length, 2, 'one attempt + exactly one downgrade retry, never a third');
  assert.equal(fx.requests.filter((request) => request.reasoningEffort === 'off').length, 1);
  assert.equal(channel.stats().retries, 1, 'the retry counter stops at one');
  assert.equal(events.filter((event) => event.type === 'reasoning.downgraded').length, 1);
  t.diagnostic(`requests=${fx.requests.length} offRequests=${fx.requests.filter((request) => request.reasoningEffort === 'off').length} retries=${channel.stats().retries} downgraded=${events.filter((event) => event.type === 'reasoning.downgraded').length}`);
});

// ---------------------------------------------------------------------------
// 5) The same rule on the main chat path (per-request / configured default)
// ---------------------------------------------------------------------------

test('P-51 the main chat honors per-request and configured efforts, and downgrades once', async (t) => {
  const configured = await fixture({ config: { reasoningEffort: 'high' } });
  t.after(configured.cleanup);
  await configured.fastpath.askStream('配置档位');
  assert.equal(configured.requests.length, 1);
  assert.equal(configured.requests[0].reasoningEffort, 'high', 'the configured default is the request default');

  const fx = await fixture({ refuse: (call, options) => call === 1 && options.reasoningEffort === 'high' });
  t.after(fx.cleanup);
  const main = await fx.fastpath.askStream('主对话正文', { reasoningEffort: 'high' });

  assert.equal(main.reply, RESPONSE);
  assert.equal(fx.requests.length, 2);
  assert.equal(fx.requests[0].reasoningEffort, 'high');
  assert.equal(Object.hasOwn(fx.requests[1], 'reasoningEffort'), false, 'the chat retry drops the control');
  const downgraded = fx.events.filter((event) => event.type === 'reasoning.downgraded');
  assert.equal(downgraded.length, 1);
  assert.equal(downgraded[0].requested, 'high');
  assert.equal(downgraded[0].fallback, 'default');
  t.diagnostic(`configured=${configured.requests[0].reasoningEffort} chatFirst=${fx.requests[0].reasoningEffort} chatRetryHasEffort=${Object.hasOwn(fx.requests[1], 'reasoningEffort')} downgraded=${downgraded.length}`);
});

// ---------------------------------------------------------------------------
// 6) The streamed auxiliary rewrite uses the same one-shot downgrade, without replay
// ---------------------------------------------------------------------------

test('P-51 the streamed rewrite downgrades once before any delta and never replays output', async (t) => {
  const fx = await fixture({ refuse: (call, options) => call === 1 && options.reasoningEffort === 'off' });
  t.after(fx.cleanup);
  const deltas = [];
  for await (const chunk of fx.fastpath.taskStream({ system: '只输出口语版。', user: '完整答复' })) {
    if (chunk?.type === 'text-delta') deltas.push(chunk.text);
  }

  assert.deepEqual(deltas, [RESPONSE], 'the restarted stream yields the answer exactly once');
  assert.equal(fx.requests.length, 2);
  assert.equal(fx.requests[0].reasoningEffort, 'off');
  assert.equal(Object.hasOwn(fx.requests[1], 'reasoningEffort'), false);
  const downgraded = fx.events.filter((event) => event.type === 'reasoning.downgraded');
  assert.equal(downgraded.length, 1);
  assert.equal(downgraded[0].requested, 'off');
  t.diagnostic(`streams=${fx.requests.length} first=${fx.requests[0].reasoningEffort} retryHasEffort=${Object.hasOwn(fx.requests[1], 'reasoningEffort')} deltas=${deltas.length} downgraded=${downgraded.length}`);
});
