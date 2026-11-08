/**
 * 识别故障说明限频 — an internal notice may accompany a suspicious (very short) user turn at
 * most once per session per window.
 *
 * Contract:
 *  1. a very short input injects exactly one internal context message; a second suspicious input
 *     inside the window injects nothing and records `voice.fault-notice.skipped {reason:'throttled'}`;
 *  2. after the window the next suspicious input injects again (sinceLastMs >= throttleMs);
 *  3. a normal-length input (and a protected short answer) injects nothing;
 *  4. the notice never changes the user's text, is never recorded as a user utterance and never
 *     reaches memory;
 *  5. different sessions keep independent clocks;
 *  6. `voice.faultNoticeThrottleMs: 0` means every suspicious input may inject.
 *
 * Run: node --test test/fault-notice-throttle.mjs
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  apply,
  createAutoMemoryRecorder,
  isAssistantMemoryMessage,
} from '../src/host/index.js';

const NOTICE_TEXT = '如果本轮输入是识别残片：不要重复解释识别问题；若无新信息就简短回应或继续当前话题。';
const NOTICE_SOURCE = 'assistant-fault-notice';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function tempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-fault-notice-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await mkdir(join(root, 'workspace'), { recursive: true });
  // Only the lanes this suite drives: every capture/LLM/overlay component stays off.
  await writeFile(join(root, 'data', 'features.json'), JSON.stringify({
    hearing: false, ambient: false, voice: false, vision: false,
    subtitle: false, avatar: false, memory: false, fastpath: false,
  }));
  t.after(async () => {
    await sleep(80);
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });
  return root;
}

function userMessage(text, id = `u-${Math.random().toString(36).slice(2)}`) {
  return { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] };
}

function agentFor(root, sessionId) {
  return {
    id: `agent-${sessionId}`,
    session: { id: sessionId, header: { cwd: join(root, 'workspace') } },
  };
}

function payloadFor(root, sessionId, text, { step = 1, turn = 1 } = {}) {
  return {
    agent: agentFor(root, sessionId),
    turn,
    step,
    signal: new AbortController().signal,
    messages: [userMessage(text)],
  };
}

async function readEvents(root) {
  try {
    const raw = await readFile(join(root, 'data', 'events.jsonl'), 'utf8');
    return raw.trim().split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/** Mount the real plugin, capturing every registered event listener. */
function mount(root, config = {}) {
  const listeners = new Map();
  const cleanups = [];
  const tools = new Map();
  const effect = (fn) => {
    const value = fn();
    if (typeof value === 'function') cleanups.push(value);
    return value;
  };
  const ctx = {
    effect,
    get: () => undefined,
    on(event, handler) {
      const list = listeners.get(event) ?? [];
      list.push(handler);
      listeners.set(event, list);
      return () => {
        const index = list.indexOf(handler);
        if (index >= 0) list.splice(index, 1);
      };
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    inject(_deps, register) {
      register({
        effect,
        systemPrompt: { section: () => () => {} },
        webServer: { register: () => () => {} },
      });
    },
  };
  apply(ctx, { root, enabled: true, ...config });

  /** Run the whole `agent/pre-step` waterfall exactly as the loop does. */
  const preStep = async (payload) => {
    const handlers = listeners.get('agent/pre-step') ?? [];
    assert.equal(handlers.length, 2, 'two agent/pre-step listeners: memory wrapper + continuation context');
    assert.match(String(handlers[0]), /memoryPreStep\.handle/u, 'listener 1 keeps the memory injector call');
    assert.match(String(handlers[1]), /takePendingInternal/u, 'listener 2 is the continuation-context lane');
    let index = 0;
    const next = async () => {
      if (index >= handlers.length) return { kind: 'enter', messages: [...payload.messages] };
      const handler = handlers[index];
      index += 1;
      return handler(payload, () => next());
    };
    return next();
  };

  return {
    preStep,
    close: () => {
      for (const fn of cleanups.reverse()) {
        try { fn(); } catch { /* already torn down */ }
      }
    },
  };
}

const noticeEvents = (events, type) => events.filter((event) => event.type === type);

test('1) first suspicious input injects; another within the default window is throttled', async (t) => {
  const root = await tempRoot(t);
  const app = mount(root);
  t.after(() => app.close());

  const first = payloadFor(root, 'fault-session-a', '你');
  const original = first.messages[0];
  const firstResult = await app.preStep(first);
  assert.equal(firstResult.kind, 'enter', 'the base decision kind is preserved');
  assert.equal(firstResult.messages.length, 2, 'exactly one internal message appended');
  assert.equal(firstResult.messages[0], original, 'the user message object is kept');
  assert.equal(original.content[0].text, '你', 'the user input is untouched');
  const injected = firstResult.messages.at(-1);
  assert.equal(injected.role, 'user');
  assert.equal(injected.source.kind, NOTICE_SOURCE, 'the notice carries its own isolation marker');
  assert.equal(injected.content[0].text, NOTICE_TEXT, 'the exact internal instruction is used');
  assert.notEqual(injected.id, original.id, 'the notice is not the user message');

  await sleep(60);
  const firstEvents = await readEvents(root);
  const injectedEvents = noticeEvents(firstEvents, 'voice.fault-notice.injected');
  assert.equal(injectedEvents.length, 1, 'one injected event');
  assert.deepEqual(injectedEvents[0].payload, {
    sessionId: 'fault-session-a',
    reason: 'short-text',
    sinceLastMs: null,
  });

  const second = payloadFor(root, 'fault-session-a', '我');
  const secondResult = await app.preStep(second);
  assert.equal(secondResult.messages.length, 1, 'inside the window nothing is injected');

  await sleep(60);
  const secondEvents = await readEvents(root);
  const skipped = noticeEvents(secondEvents, 'voice.fault-notice.skipped');
  assert.equal(skipped.length, 1, 'one throttled skip');
  assert.equal(skipped[0].payload.reason, 'throttled');
  assert.equal(skipped[0].payload.level, 'debug', 'the skip is a debug row');

  console.log('[1] first=+1 injected (sinceLastMs=null), second=+0 skipped(throttled), '
    + `window=${600_000} ms default`);
});

test('2) after the throttle window the next suspicious input injects again', async (t) => {
  const root = await tempRoot(t);
  const app = mount(root, { voice: { faultNoticeThrottleMs: 40 } });
  t.after(() => app.close());

  const first = await app.preStep(payloadFor(root, 'fault-session-window', '你'));
  assert.equal(first.messages.length, 2, 'first suspicious input injects');
  await sleep(80);
  const second = await app.preStep(payloadFor(root, 'fault-session-window', '我'));
  assert.equal(second.messages.length, 2, 'a suspicious input after the window injects again');

  await sleep(60);
  const events = await readEvents(root);
  const injected = noticeEvents(events, 'voice.fault-notice.injected');
  assert.equal(injected.length, 2, 'two injections');
  assert.ok(Number(injected[1].payload.sinceLastMs) >= 40,
    `sinceLastMs (${injected[1].payload.sinceLastMs}) crosses the configured window`);
  assert.equal(noticeEvents(events, 'voice.fault-notice.skipped').length, 0, 'nothing was throttled');

  console.log(`[2] window=40 ms; sinceLastMs=${injected[1].payload.sinceLastMs} → injected again`);
});

test('3) normal input and a protected short answer never inject', async (t) => {
  const root = await tempRoot(t);
  const app = mount(root);
  t.after(() => app.close());

  const normal = await app.preStep(payloadFor(root, 'fault-session-normal', '今天天气怎么样'));
  assert.equal(normal.messages.length, 1, 'normal input is untouched');
  const protectedShort = await app.preStep(payloadFor(root, 'fault-session-normal', '好的'));
  assert.equal(protectedShort.messages.length, 1, 'a protected short answer is not a fault');
  const longer = await app.preStep(payloadFor(root, 'fault-session-normal', '你好呀'));
  assert.equal(longer.messages.length, 1, 'a three-character input is not suspicious');

  await sleep(60);
  const events = await readEvents(root);
  assert.equal(noticeEvents(events, 'voice.fault-notice.injected').length, 0);
  assert.equal(noticeEvents(events, 'voice.fault-notice.skipped').length, 0);

  console.log('[3] normal=+0, protected "好的"=+0, "你好呀"=+0, no notice events');
});

test('4) the notice is internal: the user text is unchanged and memory never receives it', async (t) => {
  const root = await tempRoot(t);
  const app = mount(root);
  t.after(() => app.close());

  const payload = payloadFor(root, 'fault-session-isolation', '你');
  const original = payload.messages[0];
  const result = await app.preStep(payload);
  const injected = result.messages.at(-1);
  assert.equal(original.content[0].text, '你', 'the delivered user text is exactly what the user said');
  assert.notEqual(injected.source.kind, 'user', 'the notice is not a user utterance');
  assert.equal(isAssistantMemoryMessage(injected), false, 'the notice is not the memory block either');

  // The real recorder gate: an internal source kind is ignored, a genuine user message is not.
  const writes = [];
  const recorder = createAutoMemoryRecorder({
    memory: {
      addMessage(input) {
        writes.push(input);
        return { record: { id: `r-${writes.length}` }, chars: input.text.length, deduped: false };
      },
    },
    settings: () => ({ enabled: true, includeReply: true }),
    featureEnabled: () => true,
    scopeOf: () => 'in-scope',
  });
  await recorder.handle({ id: 'fault-session-isolation' }, {
    type: 'user/message', data: injected, time: Date.now(),
  });
  assert.equal(writes.length, 0, 'the internal notice is never recorded as user speech');
  await recorder.handle({ id: 'fault-session-isolation' }, {
    type: 'user/message', data: userMessage('普通用户消息'), time: Date.now(),
  });
  assert.equal(writes.length, 1, 'a genuine user message still reaches memory (the gate is live)');
  assert.ok(!writes[0].text.includes('不要重复解释识别问题'), 'memory contains no notice text');

  // The throttle bookkeeping may persist a timestamp, never the instruction body.
  const stateFile = join(root, 'data', 'memory-state.json');
  if (existsSync(stateFile)) {
    const state = await readFile(stateFile, 'utf8');
    assert.ok(!state.includes('不要重复解释识别问题'), 'memory-state carries no notice text');
  }

  console.log('[4] user text unchanged; source=' + injected.source.kind
    + `; recorder writes: notice=0, genuine=1; notice body absent from memory`);
});

test('5) different sessions keep independent clocks', async (t) => {
  const root = await tempRoot(t);
  const app = mount(root, { voice: { faultNoticeThrottleMs: 40 } });
  t.after(() => app.close());

  assert.equal((await app.preStep(payloadFor(root, 'fault-session-a', '你'))).messages.length, 2,
    'session A first injects');
  assert.equal((await app.preStep(payloadFor(root, 'fault-session-b', '我'))).messages.length, 2,
    'session B first injects independently');
  assert.equal((await app.preStep(payloadFor(root, 'fault-session-a', '他'))).messages.length, 1,
    'session A is throttled');
  assert.equal((await app.preStep(payloadFor(root, 'fault-session-b', '她'))).messages.length, 1,
    'session B is throttled');

  await sleep(80);
  assert.equal((await app.preStep(payloadFor(root, 'fault-session-a', '它'))).messages.length, 2,
    'session A can inject after its own window');

  await sleep(60);
  const injected = noticeEvents(await readEvents(root), 'voice.fault-notice.injected');
  const bySession = new Map();
  for (const event of injected) {
    bySession.set(event.payload.sessionId, (bySession.get(event.payload.sessionId) ?? 0) + 1);
  }
  assert.deepEqual([...bySession.entries()].sort(), [['fault-session-a', 2], ['fault-session-b', 1]]);

  console.log(`[5] injected per session: A=${bySession.get('fault-session-a')}, B=${bySession.get('fault-session-b')}`);
});

test('6) faultNoticeThrottleMs: 0 injects on every suspicious input', async (t) => {
  const root = await tempRoot(t);
  const app = mount(root, { voice: { faultNoticeThrottleMs: 0 } });
  t.after(() => app.close());

  for (const text of ['你', '我', '他']) {
    const result = await app.preStep(payloadFor(root, 'fault-session-zero', text));
    assert.equal(result.messages.length, 2, `"${text}" injects with the throttle disabled`);
  }

  await sleep(60);
  const events = await readEvents(root);
  assert.equal(noticeEvents(events, 'voice.fault-notice.injected').length, 3, 'every input injected');
  assert.equal(noticeEvents(events, 'voice.fault-notice.skipped').length, 0, 'never throttled at 0');

  console.log('[6] throttle=0: three suspicious inputs → three injections, zero skips');
});
