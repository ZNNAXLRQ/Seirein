/**
 * C2 phase 1: memory injection at `agent/pre-step`.
 *
 * Acceptance list:
 *   1. in-scope hit → the decision carries exactly one extra message, tagged `assistant-memory`,
 *      and the user's own message is untouched;
 *   2. a miss appends nothing but still records `memory.recall {injected:false, sources}`;
 *   3. a time-range question with no active hit spends the leftover budget on the archive
 *      (candidates capped at 200) and reports `archive: 'ok' | 'timeout'`;
 *   4. the whole preparation shares ONE 1500 ms budget: a 3 s slow query is released in <= ~1.7 s,
 *      marks `sources.active = 'timeout'`, and its late rows are discarded;
 *   5. only the first step of a turn injects; a retry of the same (session, turn, agent) is a
 *      no-op; `turn/end` clears the key;
 *   6. a cancelled turn injects nothing and reinforces nothing;
 *   7. the 1200-char budget keeps the fixed layer first and reports `memory.budget.overflow`;
 *   8. the injected block is isolated from auto-recording, voice/TTS and the next query;
 *   9. `restore()` runs once, only for the records that actually entered the request.
 *
 * Run: node --test test/c2-injection.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  apply,
  ASSISTANT_MEMORY_SOURCE,
  composeInjectionBlock,
  composeMemoryStatus,
  createAutoMemoryRecorder,
  createMemoryPreStep,
  createMemoryTurnLedger,
  detectArchiveRange,
  formatInjectionLine,
  isAssistantMemoryMessage,
  MEMORY_INJECTION_DEFAULTS,
  MEMORY_INJECTION_FOOTER,
  MEMORY_INJECTION_HEADING,
  memoryInjectionMessage,
  memoryQueryText,
  prepareMemoryInjection,
  prepareVoiceTurn,
} from '../src/host/index.js';
import { MemoryStore, UNRESOLVED_MARK } from '../src/host/memory/store.js';

// ---- helpers ----------------------------------------------------------------

async function tempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-c2-injection-'));
  // `close()` stops the plugin's timers but a boot-time `void log.emit(...)` can still be in
  // flight; give it a tick before the directory disappears so the cleanup itself is quiet.
  t.after(async () => {
    await sleep(80);
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });
  return root;
}

/** In-memory stand-in for `data/events.jsonl`, with the same async `emit` shape. */
function eventLog() {
  const events = [];
  return {
    events,
    async emit(type, payload) {
      events.push({ type, payload });
      return { type, payload };
    },
  };
}

/** Read the real event log; a missing file simply means "no event yet". */
async function readEvents(root) {
  try {
    const raw = await readFile(join(root, 'data', 'events.jsonl'), 'utf8');
    return raw.trim().split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One genuine user message, the shape the Harness logs and the inbox carries. */
function userMessage(text, id = `u-${Math.random().toString(36).slice(2)}`) {
  return { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] };
}

/** The default decision the host's own waterfall callback would produce. */
function defaultDecision(messages) {
  return { kind: 'enter', messages: [...messages] };
}

const nextFor = (messages) => async () => defaultDecision(messages);

/** A pre-step payload: the fused `{agent, turn, step, signal, messages}` the loop dispatches. */
function preStepPayload({ agent, turn = 1, step = 1, messages = [], signal = null }) {
  return {
    agent,
    turn,
    step,
    signal: signal ?? new AbortController().signal,
    messages,
  };
}

/** An agent whose session cwd is inside `<root>/workspace` (the default scope). */
function agentFor(root, { sessionId = 'c2-session', header = {}, options = {} } = {}) {
  return {
    id: `agent-${sessionId}`,
    options,
    session: { id: sessionId, header: { cwd: join(root, 'workspace'), ...header } },
  };
}

/** Seed records through the real store (the writer's public API). */
function seed(root, rows) {
  const store = new MemoryStore(root);
  store.open();
  const ids = [];
  for (const row of rows) {
    const { record } = store.addMessage({
      sessionId: 'c2-seed',
      turnId: 1,
      role: 'user',
      clarity: 'vivid',
      importance: 60,
      ...row,
    });
    ids.push(record?.id ?? '');
  }
  store.close();
  return ids;
}

/** Mount the real plugin with a fake context that captures the event listeners. */
function mount(root, config = {}) {
  const tools = new Map();
  const cleanups = [];
  const listeners = new Map();
  const sections = [];
  const effect = (fn) => {
    const value = fn();
    if (typeof value === 'function') cleanups.push(value);
    return value;
  };
  const ctx = {
    effect,
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
    inject: (_deps, register) => {
      register({
        effect,
        systemPrompt: {
          section(definition) {
            sections.push(definition);
            return () => {};
          },
        },
        webServer: { register() { return () => {}; } },
      });
    },
  };
  apply(ctx, { root, enabled: true, ...config });
  return {
    listeners,
    sections,
    ctx,
    tool: (name) => tools.get(name),
    /**
     * Run the plugin's `agent/pre-step` waterfall the way the loop does: every registered listener
     * in order, each receiving `(payload, next)`.
     *
     * The plugin registers TWO listeners (commit c4ce02e added the second): [0] the C2 memory
     * block (`memoryPreStep.handle`), [1] the pending response-group continuation context. This
     * replaced the old "exactly one listener" assumption. The memory assertions below are
     * unchanged: the continuation listener appends nothing while no response group is pending
     * (`test/response-group.mjs` drives a real voice round for its context payload), and the
     * memory lane still receives the same untouched base decision. This helper therefore proves
     * the registration count, that BOTH listeners run for one pre-step, and which lane each is.
     */
    preStep: async (payload, next) => {
      const handlers = listeners.get('agent/pre-step') ?? [];
      assert.equal(handlers.length, 2, 'two agent/pre-step listeners: memory + continuation context');
      assert.match(String(handlers[0]), /memoryPreStep\.handle/u, 'listener 1 is the memory injector');
      assert.match(String(handlers[1]), /takePendingInternal/u, 'listener 2 is the continuation-context injector');
      let index = 0;
      let invoked = 0;
      const run = async (base) => {
        if (index >= handlers.length) return base();
        const handler = handlers[index];
        index += 1;
        invoked += 1;
        return handler(payload, () => run(base));
      };
      const result = await run(next);
      assert.equal(invoked, 2, 'both registered pre-step listeners were invoked for this payload');
      return result;
    },
    /** Dispatch a session event to every listener the plugin registered. */
    fire: async (session, event) => {
      for (const handler of listeners.get('session/event') ?? []) await handler(session, event);
    },
    /** Call one registered tool with the same fake `exec` a real call would carry. */
    call: async (name, args = {}, exec = {}) => {
      const tool = tools.get(name);
      assert.ok(tool !== undefined, `tool registered: ${name}`);
      return tool.execute(args, exec);
    },
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

/** Capture `MemoryStore.prototype.restore` calls (the real reinforcement path). */
function captureRestore(t) {
  const calls = [];
  const original = MemoryStore.prototype.restore;
  MemoryStore.prototype.restore = function patched(ids) {
    calls.push([...(ids ?? [])]);
    return original.call(this, ids);
  };
  t.after(() => {
    MemoryStore.prototype.restore = original;
  });
  return calls;
}

/** A fake memory exposing just the C2 surface, so every call can be asserted. */
function fakeMemory({ fixed = [], hits = [], archive = null, restore = null } = {}) {
  const memory = {
    fixedMemories: () => fixed,
    recall: () => ({ hits, mode: 'keyword', roles: ['user', 'assistant'], window: 1, from: null, to: null, relaxed: false }),
    listArchive: () => [],
    restore: (ids) => restore?.([...ids]),
  };
  if (archive !== null) memory.listArchive = archive;
  return memory;
}

const inScope = () => true;
const notSubagent = () => false;

// ---- 1. hit -----------------------------------------------------------------

test('1) in-scope hit appends exactly one assistant-memory message', async (t) => {
  const root = await tempRoot(t);
  seed(root, [{ messageId: 'c2-hit', text: '我很喜欢月光下的散步，昨晚也是' }]);
  const app = mount(root);
  t.after(() => app.close());

  const original = userMessage('月光下的散步你还记得吗');
  const payload = preStepPayload({ agent: agentFor(root), messages: [original] });
  const base = defaultDecision(payload.messages);
  const result = await app.preStep(payload, async () => base);

  assert.equal(result.kind, 'enter', 'the decision kind is preserved');
  assert.equal(result.messages.length, base.messages.length + 1, 'exactly one message appended');
  const injected = result.messages[result.messages.length - 1];
  assert.equal(injected.role, 'user');
  assert.equal(injected.source.kind, ASSISTANT_MEMORY_SOURCE);
  assert.notEqual(injected.id, original.id, 'the block is not the delivery message');
  const body = injected.content[0].text;
  assert.ok(body.startsWith(MEMORY_INJECTION_HEADING), 'starts with the heading');
  assert.match(body, /- \[[^\]]+ · 原文·user\]/u, 'carries a date + original-utterance label');
  assert.ok(body.includes('月光下的散步'), 'carries the matched memory');
  assert.ok(body.trimEnd().endsWith(MEMORY_INJECTION_FOOTER), 'ends with the reference-only note');
  assert.equal(original.content[0].text, '月光下的散步你还记得吗', 'the user message is untouched');
  assert.equal(result.messages[0], original, 'the original message object is kept');

  console.log(`[1] hit → messages ${base.messages.length}→${result.messages.length}, `
    + `source=${injected.source.kind}, injected=${body.length} chars`);
});

// ---- 2. miss ----------------------------------------------------------------

test('2) a miss injects only the short status message and records {injected:false, sources}', async (t) => {
  const root = await tempRoot(t);
  seed(root, [{ messageId: 'c2-miss', text: '我喜欢在深夜写代码，喝冰美式' }]);
  const app = mount(root);
  t.after(() => app.close());

  const original = userMessage('天气怎么样');
  const payload = preStepPayload({ agent: agentFor(root), messages: [original] });
  const base = defaultDecision(payload.messages);
  const result = await app.preStep(payload, async () => base);

  assert.equal(result.messages.length, base.messages.length + 1, 'exactly one status message appended');
  const status = result.messages.at(-1);
  assert.equal(status.source.kind, ASSISTANT_MEMORY_SOURCE, 'the status is assistant-memory, not a hit');
  const body = status.content[0].text;
  assert.ok(body.startsWith('## 记忆检索状态'), 'status heading');
  assert.ok(body.includes('活跃库：无命中'), 'active source reported');
  assert.ok(body.includes('归档：未查'), 'archive source reported');
  assert.ok(body.includes('完整性：complete'), 'completeness reported');
  assert.ok(body.length <= 120, `status stays short: ${body.length} chars`);
  assert.equal(original.content[0].text, '天气怎么样', 'the user message is untouched');

  const events = await readEvents(root);
  const recall = events.filter((event) => event.type === 'memory.recall').at(-1);
  assert.ok(recall !== undefined, 'memory.recall recorded');
  assert.equal(recall.payload.injected, false, 'a status message is not a hit');
  assert.equal(recall.payload.status, true);
  assert.equal(recall.payload.sources.active, 'ok');
  assert.equal(recall.payload.sources.archive, 'not-run', 'no archive pass for a plain question');
  assert.equal(recall.payload.archiveReason, 'no-range', 'unparseable time → no-range fallback');
  assert.equal(recall.payload.injectedChars, 0);

  console.log(`[2] miss → status ${body.length} chars, injected=false sources=${JSON.stringify(recall.payload.sources)} `
    + `archiveReason=${recall.payload.archiveReason}`);
});

// ---- 3. archive -------------------------------------------------------------

test('3) time-range miss falls back to the archive (candidates capped at 200)', async (t) => {
  const calls = [];
  const archiveRow = (index) => ({
    id: `arc-${index}`,
    ts: '2026-10-30T10:00:00.000Z',
    role: 'user',
    text: `上周我们讨论了第${index}件事`,
    importance: 60,
    clarity: 'clear',
  });
  const memory = {
    fixedMemories: () => [],
    recall: () => ({
      hits: [],
      mode: 'time',
      roles: ['user', 'assistant'],
      window: 1,
      from: '2026-10-26T00:00:00.000Z',
      to: '2026-11-02T00:00:00.000Z',
      relaxed: false,
    }),
    listArchive: ({ query, fromIso, toIso, limit, offset }) => {
      calls.push({ query, fromIso, toIso, limit, offset });
      return Array.from({ length: limit }, (_, index) => archiveRow(offset + index));
    },
    restore: () => {},
  };
  const log = eventLog();
  const prep = createMemoryPreStep({
    memory, log, inScope, isSubagent: notSubagent, featureEnabled: () => true,
  });
  const agent = { id: 'a3', session: { id: 's3', header: { cwd: 'C:/x' } } };
  const original = userMessage('上周我们聊了什么');
  const payload = preStepPayload({ agent, messages: [original] });
  const result = await prep.handle(payload, nextFor(payload.messages));

  assert.equal(result.messages.length, 2, 'archive hit is injected');
  assert.ok(calls.length >= 1, 'the archive was queried');
  assert.ok(calls.every((call) => call.query === undefined), 'the archive is not searched by the question text');
  assert.ok(calls.every((call) => /^\d{4}-\d{2}-\d{2}T/u.test(call.fromIso) && /^\d{4}-\d{2}-\d{2}T/u.test(call.toIso)),
    'candidates are selected by an explicit from/to window');
  const fetched = calls.reduce((total, call) => total + call.limit, 0);
  assert.ok(fetched <= MEMORY_INJECTION_DEFAULTS.archiveCandidates,
    `candidates capped at ${MEMORY_INJECTION_DEFAULTS.archiveCandidates}, fetched ${fetched}`);
  const recall = log.events.find((event) => event.type === 'memory.recall' && event.payload.injected === true);
  assert.ok(recall !== undefined);
  assert.equal(recall.payload.sources.archive, 'ok');
  assert.equal(recall.payload.archiveReason, 'queried');
  const body = result.messages.at(-1).content[0].text;
  assert.ok(body.includes('第0件事'), 'archive rows reach the block');

  console.log(`[3] archive calls=${calls.length} `
    + `(from=${calls[0].fromIso} to=${calls[0].toIso}), fetched=${fetched}, `
    + `sources=${JSON.stringify(recall.payload.sources)}`);
});

test('3b) archive timeout is reported as archive:timeout and injects nothing (budget exhausted)', async (t) => {
  const memory = {
    fixedMemories: () => [],
    recall: () => ({ hits: [], mode: 'time' }),
    listArchive: () => new Promise((resolve) => {
      setTimeout(() => resolve([]), 2000).unref?.();
    }),
    restore: () => {},
  };
  const log = eventLog();
  const prep = createMemoryPreStep({
    memory, log, settings: () => ({ prepareBudgetMs: 300 }), inScope, isSubagent: notSubagent,
    featureEnabled: () => true,
  });
  const agent = { id: 'a3b', session: { id: 's3b', header: { cwd: 'C:/x' } } };
  const original = userMessage('上周我们聊了什么');
  const payload = preStepPayload({ agent, messages: [original] });
  const started = performance.now();
  const result = await prep.handle(payload, nextFor(payload.messages));
  const elapsed = performance.now() - started;

  assert.equal(result.messages.length, 1, 'a timed-out archive consumes the budget: nothing can be injected');
  assert.ok(elapsed < 700, `archive timeout released in ${elapsed.toFixed(0)} ms`);
  const recall = log.events.find((event) => event.type === 'memory.recall');
  assert.equal(recall.payload.sources.archive, 'timeout');
  assert.equal(recall.payload.injected, false);
  assert.equal(recall.payload.completeness, 'timeout');

  console.log(`[3b] archive 2000 ms / budget 300 ms → released in ${elapsed.toFixed(0)} ms, `
    + `sources=${JSON.stringify(recall.payload.sources)}, messages=${result.messages.length}`);
});

test('3c) a fixed hit is not injected once the shared deadline is exhausted', async () => {
  const memory = {
    fixedMemories: () => [{ id: 'fixed-1', ts: '2026-11-01T00:00:00.000Z', text: '固定事实', importance: 90 }],
    recall: () => ({ hits: [], mode: 'time' }),
    listArchive: () => new Promise((resolve) => {
      setTimeout(() => resolve([]), 2000).unref?.();
    }),
    restore: () => {},
  };
  const log = eventLog();
  const prep = createMemoryPreStep({
    memory, log, settings: () => ({ prepareBudgetMs: 200 }), inScope, isSubagent: notSubagent,
    featureEnabled: () => true,
  });
  const agent = { id: 'a3c', session: { id: 's3c', header: { cwd: 'C:/x' } } };
  const original = userMessage('上周我们聊了什么');
  const payload = preStepPayload({ agent, messages: [original] });
  const result = await prep.handle(payload, nextFor(payload.messages));

  assert.equal(result.messages.length, 1, 'the budget expired → nothing is injected, not even a partial block');
  const recall = log.events.find((event) => event.type === 'memory.recall');
  assert.equal(recall.payload.sources.archive, 'timeout');
  assert.equal(recall.payload.injected, false);
  assert.equal(recall.payload.completeness, 'timeout');

  console.log(`[3c] archive timeout + fixed hit + expired deadline → injected=false, `
    + `sources=${JSON.stringify(recall.payload.sources)}`);
});

// ---- 4. one shared budget ---------------------------------------------------

test('4) a 3 s slow query is released within the 1500 ms budget and its late rows are dropped', async (t) => {
  let lateResolved = 0;
  const restoreCalls = [];
  const lateRow = {
    id: 'late', ts: '2026-11-01T00:00:00.000Z', role: 'user', text: '月光下的散步',
    importance: 60, clarity: 'clear',
  };
  const memory = {
    fixedMemories: () => [],
    recall: () => new Promise((resolve) => {
      setTimeout(() => {
        lateResolved += 1;
        resolve({ hits: [lateRow], mode: 'keyword' });
      }, 3000).unref?.();
    }),
    listArchive: () => [],
    restore: (ids) => restoreCalls.push([...ids]),
  };
  const log = eventLog();
  const prep = createMemoryPreStep({
    memory, log, settings: () => ({ prepareBudgetMs: 1500 }), inScope, isSubagent: notSubagent,
    featureEnabled: () => true,
  });
  const agent = { id: 'a4', session: { id: 's4', header: { cwd: 'C:/x' } } };
  const original = userMessage('月光下的散步');
  const payload = preStepPayload({ agent, messages: [original] });

  const started = performance.now();
  const result = await prep.handle(payload, nextFor(payload.messages));
  const elapsed = performance.now() - started;

  assert.ok(elapsed <= 1700, `slow query blocked ${elapsed.toFixed(0)} ms (budget 1500 ms)`);
  assert.equal(result.messages.length, 1, 'a timed-out lookup injects nothing (the budget is spent)');
  const recall = log.events.find((event) => event.type === 'memory.recall');
  assert.equal(recall.payload.sources.active, 'timeout');
  assert.equal(recall.payload.injected, false);
  assert.equal(recall.payload.completeness, 'timeout');
  const eventsAtRelease = log.events.length;

  // Let the slow query finish: its rows are late and must not modify this (or any) request.
  await sleep(Math.max(0, 3300 - (performance.now() - started)));
  assert.equal(lateResolved, 1, 'the slow query did complete');
  assert.equal(log.events.length, eventsAtRelease, 'late rows emit no further event');
  assert.equal(restoreCalls.length, 0, 'late rows are never reinforced');
  assert.equal(prep.seenCount(), 1, 'the key survives until turn/end');
  prep.observe({ id: 's4' }, { type: 'turn/end', data: { turn: 1 } });
  assert.equal(prep.seenCount(), 0, 'turn/end clears the key');

  console.log(`[4] slow query 3000 ms → released in ${elapsed.toFixed(0)} ms (budget 1500 ms), `
    + `sources.active=${recall.payload.sources.active}, late rows injected=0, restore calls=0`);
});

// ---- 5. once per turn -------------------------------------------------------

test('5) multi-step / retry inject once; turn/end clears the dedup key', async (t) => {
  const root = await tempRoot(t);
  seed(root, [{ messageId: 'c2-once', text: '月光下的散步，我很喜欢' }]);
  const store = new MemoryStore(root);
  store.open();
  t.after(() => store.close());
  const prep = createMemoryPreStep({
    memory: store, log: eventLog(), inScope, isSubagent: notSubagent, featureEnabled: () => true,
    displayChars: 400,
  });
  const agent = agentFor(root, { sessionId: 'c2-once' });
  const signal = new AbortController().signal;
  const first = userMessage('月光下的散步');
  const stepOne = preStepPayload({ agent, turn: 1, step: 1, messages: [first], signal });
  const continued = userMessage('继续');
  const stepTwo = preStepPayload({ agent, turn: 1, step: 2, messages: [continued], signal });

  const r1 = await prep.handle(stepOne, nextFor(stepOne.messages));
  const r2 = await prep.handle(stepTwo, nextFor(stepTwo.messages));
  const r3 = await prep.handle(stepOne, nextFor(stepOne.messages));

  assert.equal(r1.messages.length, 2, 'first step injects');
  assert.equal(r2.messages.length, 1, 'a later step never injects');
  assert.equal(r3.messages.length, 1, 'a retry of the same step/turn is a no-op');
  assert.equal(prep.seenCount(), 1);
  prep.observe({ id: 'c2-once' }, { type: 'turn/end', data: { turn: 1 } });
  assert.equal(prep.seenCount(), 0, 'turn/end clears the key');
  const r4 = await prep.handle(stepOne, nextFor(stepOne.messages));
  assert.equal(r4.messages.length, 2, 'a new turn lifecycle may inject again');

  console.log('[5] step1=+1, step2=+0, retry=+0, seen 1→0 after turn/end, new lifecycle=+1');
});

// ---- 6. cancel --------------------------------------------------------------

test('6) a cancelled turn injects nothing and reinforces nothing', async (t) => {
  const root = await tempRoot(t);
  seed(root, [{ messageId: 'c2-cancel', text: '月光下的散步，我很喜欢' }]);
  const app = mount(root);
  t.after(() => app.close());
  const restoreCalls = captureRestore(t);

  const controller = new AbortController();
  controller.abort();
  const original = userMessage('月光下的散步');
  const payload = preStepPayload({ agent: agentFor(root), messages: [original], signal: controller.signal });
  const result = await app.preStep(payload, nextFor(payload.messages));

  assert.equal(result.messages.length, 1, 'cancelled → no injection');
  assert.equal(restoreCalls.length, 0, 'cancelled → no reinforcement');
  const events = await readEvents(root);
  assert.equal(events.filter((event) => event.type === 'memory.recall').length, 0, 'no recall event');

  console.log('[6] aborted signal → messages=1, restore calls=0, memory.recall events=0');
});

test('6b) cancelling while the lookup runs still injects and reinforces nothing', async () => {
  const restoreCalls = [];
  const lateRow = {
    id: 'mid', ts: '2026-11-01T00:00:00.000Z', role: 'user', text: '月光下的散步',
    importance: 60, clarity: 'clear',
  };
  const memory = {
    fixedMemories: () => [],
    recall: () => new Promise((resolve) => {
      setTimeout(() => resolve({ hits: [lateRow], mode: 'keyword' }), 200).unref?.();
    }),
    listArchive: () => [],
    restore: (ids) => restoreCalls.push([...ids]),
  };
  const log = eventLog();
  const prep = createMemoryPreStep({
    memory, log, inScope, isSubagent: notSubagent, featureEnabled: () => true,
  });
  const controller = new AbortController();
  const agent = { id: 'a6b', session: { id: 's6b', header: { cwd: 'C:/x' } } };
  const original = userMessage('月光下的散步');
  const payload = preStepPayload({ agent, messages: [original], signal: controller.signal });
  const running = prep.handle(payload, nextFor(payload.messages));
  setTimeout(() => controller.abort(), 50).unref?.();
  const result = await running;

  assert.equal(result.messages.length, 1, 'cancel mid-flight → no injection');
  assert.equal(restoreCalls.length, 0, 'cancel mid-flight → no reinforcement');
  assert.equal(log.events.filter((event) => event.type === 'memory.recall').length, 0,
    'the cancelled preparation claims no injection');

  console.log('[6b] cancel at 50 ms while recall ran → messages=1, restore calls=0, events=0');
});

// ---- 7. budget --------------------------------------------------------------

test('7) fixed memories win the budget; overflow is reported, never claimed as complete', async () => {
  const body = '长'.repeat(700);
  const fixed = [0, 1, 2].map((index) => ({
    id: `fixed-${index}`,
    ts: '2026-11-01T00:00:00.000Z',
    text: `固定记忆${index}${body}`,
    importance: 90,
  }));
  const memory = fakeMemory({
    fixed,
    hits: [{
      id: 'rel-1', ts: '2026-11-02T00:00:00.000Z', role: 'user', text: '相关记忆一',
      importance: 60, clarity: 'clear',
    }],
  });
  const log = eventLog();
  const prep = createMemoryPreStep({
    memory, log, inScope, isSubagent: notSubagent, featureEnabled: () => true, displayChars: 800,
  });
  const agent = { id: 'a7', session: { id: 's7', header: { cwd: 'C:/x' } } };
  const original = userMessage('月光下的散步');
  const payload = preStepPayload({ agent, messages: [original] });
  const result = await prep.handle(payload, nextFor(payload.messages));

  assert.equal(result.messages.length, 2, 'what fits is still injected');
  const text = result.messages.at(-1).content[0].text;
  assert.ok(text.length <= MEMORY_INJECTION_DEFAULTS.maxChars,
    `injected ${text.length} chars, cap ${MEMORY_INJECTION_DEFAULTS.maxChars}`);
  assert.ok(text.includes('固定记忆0'), 'the first fixed record is kept');
  assert.ok(!text.includes('固定记忆2'), 'the oversized tail is dropped');

  const overflow = log.events.find((event) => event.type === 'memory.budget.overflow');
  assert.ok(overflow !== undefined, 'overflow event recorded');
  assert.ok(overflow.payload.requestedChars > overflow.payload.injectedChars);
  assert.equal(overflow.payload.injectedChars, text.length);
  const recall = log.events.find((event) => event.type === 'memory.recall');
  assert.ok(recall.payload.injectedChars <= MEMORY_INJECTION_DEFAULTS.maxChars);
  assert.equal(recall.payload.injected, true);

  console.log(`[7] requested=${overflow.payload.requestedChars} chars → injected=`
    + `${overflow.payload.injectedChars} (cap ${MEMORY_INJECTION_DEFAULTS.maxChars}), `
    + `records ${overflow.payload.requestedRecords}→${overflow.payload.injectedRecords}`);
});

// ---- 8. isolation -----------------------------------------------------------

test('8a) the injected block is never auto-recorded back into memory', async (t) => {
  const root = await tempRoot(t);
  const store = new MemoryStore(root);
  store.open();
  t.after(() => store.close());
  const log = eventLog();
  const recorder = createAutoMemoryRecorder({
    memory: store,
    log,
    settings: { enabled: true, includeReply: true },
    featureEnabled: () => true,
    scopeOf: () => 'in-scope',
  });
  const injected = memoryInjectionMessage(`${MEMORY_INJECTION_HEADING}\n- [2026-11-05 · 原文·user] 月光\n${MEMORY_INJECTION_FOOTER}`);
  const session = { id: 'c2-iso-record' };
  await recorder.handle(session, { type: 'turn/start', time: Date.now(), data: { turn: 1 } });
  await recorder.handle(session, { type: 'user/message', time: Date.now(), data: injected });
  await recorder.handle(session, { type: 'turn/end', time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } });
  await recorder.flush('c2-iso-record', 1);

  assert.equal(store.usage().records, 0, 'no record written for the block');
  assert.equal(log.events.filter((event) => event.type === 'memory.auto').length, 0);
  assert.equal(isAssistantMemoryMessage(injected), true);
  console.log(`[8a] injected user/message → records=${store.usage().records}, memory.auto events=0`);
});

test('8b) the injected block triggers no voice/TTS event', async (t) => {
  const root = await tempRoot(t);
  const app = mount(root);
  t.after(() => app.close());
  const injected = memoryInjectionMessage(`${MEMORY_INJECTION_HEADING}\n- [2026-11-05 · 原文·user] 月光\n${MEMORY_INJECTION_FOOTER}`);

  await app.fire({ id: 'c2-iso-voice' }, { type: 'user/message', time: Date.now(), data: injected });
  await sleep(40);
  const events = await readEvents(root);
  const spoken = events.filter((event) => /^(tts|voice)\./u.test(String(event.type)));
  assert.equal(spoken.length, 0, 'no TTS/voice event may be caused by the block');
  assert.equal(events.filter((event) => event.type === 'memory.auto').length, 0);

  console.log(`[8b] injected user/message → tts/voice events=${spoken.length}, memory.auto=0`);
});

test('8c) the injected block never becomes the next query', async (t) => {
  const root = await tempRoot(t);
  seed(root, [{ messageId: 'c2-iso-query', text: '月光下的散步，我很喜欢' }]);
  const app = mount(root);
  t.after(() => app.close());
  const injected = memoryInjectionMessage(`${MEMORY_INJECTION_HEADING}\n- [2026-11-05 · 原文·user] 月光\n${MEMORY_INJECTION_FOOTER}`);
  const genuine = userMessage('月光下的散步');

  // Query construction ignores the marker, whether alone or mixed with a real user message.
  assert.equal(memoryQueryText([injected]), '');
  assert.equal(memoryQueryText([injected, genuine]), '月光下的散步');

  const agent = agentFor(root, { sessionId: 'c2-iso-query' });
  const turn1 = preStepPayload({ agent, turn: 1, step: 1, messages: [genuine] });
  const r1 = await app.preStep(turn1, nextFor(turn1.messages));
  assert.equal(r1.messages.length, 2, 'turn 1 injected once');
  const block = r1.messages.at(-1);

  // Even if a feed ever re-presented the block as the only claimed message, it is not a query.
  const turn2 = preStepPayload({ agent, turn: 2, step: 1, messages: [block] });
  const r2 = await app.preStep(turn2, nextFor(turn2.messages));
  assert.equal(r2.messages.length, 1, 'the block cannot seed another injection');

  console.log('[8c] query(block)="" query(block+user)="月光下的散步" turn2 with only the block → +0');
});

test('8d) the injected block is never the correction sourceMessageId', async (t) => {
  const root = await tempRoot(t);
  seed(root, [{ messageId: 'c2-iso-correct', text: '记忆库放在 E 盘，很重要' }]);
  const app = mount(root);
  t.after(() => app.close());
  const injected = memoryInjectionMessage(`${MEMORY_INJECTION_HEADING}\n- [2026-11-05 · 原文·user] 记忆库放在 E 盘\n${MEMORY_INJECTION_FOOTER}`);
  const genuine = userMessage('不是 E 盘，是 F 盘', 'genuine-correction');
  const agent = agentFor(root, { sessionId: 'c2-iso-correct' });
  // The newest user-role message is the injected block, the genuine correction sits before it.
  agent.session.deriveMessages = () => [genuine, injected];

  const found = await app.call('assistant_recall', { query: '记忆库' });
  const hit = found.hits[0];
  assert.ok(hit !== undefined, 'the seeded record is recallable');
  const result = await app.call('assistant_memory_correct', {
    targetId: hit.id,
    expectedVersion: hit.version,
    expectedText: 'E 盘',
    replacement: 'F 盘',
  }, { agent });

  assert.equal(result.ok, true, 'the correction applies');
  assert.equal(result.sourceMessageId, genuine.id, 'the genuine user message is the correction source');
  assert.notEqual(result.sourceMessageId, injected.id, 'the injected block is never the source');

  console.log(`[8d] correction sourceMessageId=${result.sourceMessageId === genuine.id ? 'genuine' : 'WRONG'} `
    + `(block skipped)`);
});

// ---- 9. reinforcement -------------------------------------------------------

test('9) restore runs once only after the host logs the injected message; dropped/late ids never', async () => {
  const restoreCalls = [];
  const long = '相'.repeat(1100);
  const hits = [
    { id: 'keep', ts: '2026-11-01T00:00:00.000Z', role: 'user', text: long, importance: 60, clarity: 'clear' },
    { id: 'drop', ts: '2026-11-02T00:00:00.000Z', role: 'assistant', text: '相'.repeat(200), importance: 60, clarity: 'clear' },
  ];
  const memory = fakeMemory({ hits, restore: (ids) => restoreCalls.push(ids) });
  const log = eventLog();
  const prep = createMemoryPreStep({
    memory, log, inScope, isSubagent: notSubagent, featureEnabled: () => true,
  });
  const agent = { id: 'a9', session: { id: 's9', header: { cwd: 'C:/x' } } };
  const original = userMessage('相');
  const payload = preStepPayload({ agent, messages: [original] });
  const result = await prep.handle(payload, nextFor(payload.messages));

  assert.equal(result.messages.length, 2);
  assert.equal(restoreCalls.length, 0, 'the hook returns before the host accepts anything');
  const injected = result.messages.at(-1);

  // Host logs the injected message → exactly one reinforcement for the delivered id.
  await prep.observe({ id: 's9' }, { type: 'user/message', data: injected });
  assert.equal(restoreCalls.length, 1, 'restore is called exactly once after acceptance');
  assert.deepEqual(restoreCalls[0], ['keep'], 'only the delivered record is reinforced');
  const delivered = log.events.find((event) => event.type === 'memory.restore.delivered');
  assert.deepEqual(delivered.payload, { ids: ['keep'], turn: 1 });
  // A duplicate host event for the same message must not strengthen it twice.
  await prep.observe({ id: 's9' }, { type: 'user/message', data: injected });
  assert.equal(restoreCalls.length, 1, 'duplicate event → no second reinforcement');

  // Replaced/cancelled turn: the message never arrives, turn/end drops the pending ids.
  const restoreCancelled = [];
  const cancelMemory = fakeMemory({ hits: [hits[0]], restore: (ids) => restoreCancelled.push(ids) });
  const cancelPrep = createMemoryPreStep({
    memory: cancelMemory, log: eventLog(), inScope, isSubagent: notSubagent, featureEnabled: () => true,
  });
  const cancelResult = await cancelPrep.handle(payload, nextFor(payload.messages));
  assert.equal(cancelResult.messages.length, 2);
  cancelPrep.observe({ id: 's9' }, { type: 'turn/end', data: { turn: 1 } });
  assert.equal(restoreCancelled.length, 0, 'a cancelled turn never reinforces');

  // A timed-out preparation has no delivered record to reinforce.
  const timedOut = [];
  const slow = {
    fixedMemories: () => [],
    recall: () => new Promise((resolve) => {
      setTimeout(() => resolve({ hits, mode: 'keyword' }), 2000).unref?.();
    }),
    listArchive: () => [],
    restore: (ids) => timedOut.push([...ids]),
  };
  const slowPrep = createMemoryPreStep({
    memory: slow, log: eventLog(), settings: () => ({ prepareBudgetMs: 200 }), inScope,
    isSubagent: notSubagent, featureEnabled: () => true,
  });
  const slowResult = await slowPrep.handle(payload, nextFor(payload.messages));
  assert.equal(slowResult.messages.length, 1);
  assert.equal(timedOut.length, 0, 'timeout → no reinforcement');

  console.log(`[9] before accept=0, after accept=1 (${restoreCalls[0].join(',')}), duplicate=0, `
    + `cancelled=0, timeout=0`);
});

// ---- Phase-2 additions: one injection lane, time windows, budgets, delivery, time zone ----

// #1 voice path no longer recalls or splices memory; C2 injects once and restores on acceptance.

test('10) a voice turn keeps the transcript verbatim: brief 0, C2 recall 1, restore 1', async (t) => {
  const root = await tempRoot(t);
  seed(root, [{ messageId: 'voice-memory', text: '月光下的散步，我很喜欢' }]);
  const store = new MemoryStore(root);
  store.open();
  t.after(() => store.close());
  const app = mount(root);
  t.after(() => app.close());
  const restoreCalls = captureRestore(t);
  let briefCalls = 0;
  let recallCalls = 0;
  const originalRecall = MemoryStore.prototype.recall;
  MemoryStore.prototype.recall = function patchedRecall(...args) {
    recallCalls += 1;
    return originalRecall.apply(this, args);
  };
  t.after(() => { MemoryStore.prototype.recall = originalRecall; });

  // The voice lane's own memory handle counts any legacy `brief()` call.
  const memory = {
    fixedMemories: (...args) => store.fixedMemories(...args),
    recall: (...args) => store.recall(...args),
    brief: (...args) => { briefCalls += 1; return store.brief(...args); },
    listArchive: (...args) => store.listArchive(...args),
    restore: (ids) => store.restore(ids),
  };
  const log = eventLog();
  const transcript = '月光下的散步';
  const prepared = await prepareVoiceTurn({
    ctx: app.ctx,
    sessionId: 'voice-c2',
    text: transcript,
    spoken: transcript,
    memory,
    log,
    speakLine: async () => {},
    inScope: true,
    enabled: true,
    timeoutMs: 3000,
  });
  t.after(() => { prepared.resultPromise.cancel(); });

  assert.equal(prepared.refused, false);
  assert.equal(prepared.request.content[0].text, transcript, 'the delivered text is the bare transcript');
  assert.equal(briefCalls, 0, 'no memory.brief on the voice path');

  const agent = agentFor(root, { sessionId: 'voice-c2' });
  const payload = preStepPayload({ agent, messages: [prepared.request] });
  const result = await app.preStep(payload, nextFor(payload.messages));
  assert.equal(recallCalls, 1, 'C2 recalled exactly once');
  assert.equal(result.messages.length, 2, 'C2 appended one block');
  const injected = result.messages.at(-1);
  assert.ok(injected.content[0].text.startsWith(MEMORY_INJECTION_HEADING));
  assert.equal(restoreCalls.length, 0, 'nothing is reinforced before the host accepts it');

  await app.fire({ id: 'voice-c2' }, { type: 'user/message', data: injected });
  assert.equal(restoreCalls.length, 1, 'accepted → one restore');
  assert.ok(!prepared.request.content[0].text.includes('## 相关记忆'), 'no legacy heading in the delivered text');

  prepared.resultPromise.cancel();
  await prepared.resultPromise;
  console.log(`[10] voice: brief=0, C2 recall=1, restore=${restoreCalls.length}, `
    + `delivered=${JSON.stringify(prepared.request.content[0].text)}`);
});

// #2 time-window parsing is by date range, never by asking the archive for the question text.

test('11) archive fallback resolves 昨天 and 模糊表达 to explicit Beijing-day windows', async () => {
  const NOW = Date.parse('2026-11-04T17:30:00Z'); // Beijing 2026-11-05 01:30
  const calls = [];
  const memory = {
    fixedMemories: () => [],
    recall: () => ({ hits: [], mode: 'time', roles: ['user', 'assistant'], window: 1 }),
    listArchive: (options) => {
      calls.push(options);
      return [{ id: 'arc-cat', ts: '2026-11-04T02:00:00.000Z', role: 'user', text: '昨天聊猫咪', importance: 60, clarity: 'clear' }];
    },
    restore: () => {},
  };
  const log = eventLog();
  const prep = createMemoryPreStep({
    memory,
    log,
    settings: () => ({ prepareBudgetMs: 1500, timeZone: 'Asia/Shanghai', fuzzyDays: 3 }),
    inScope,
    isSubagent: notSubagent,
    featureEnabled: () => true,
    now: () => NOW,
  });
  const agent = { id: 'a11', session: { id: 's11', header: { cwd: 'C:/x' } } };

  const yesterday = userMessage('昨天我们聊了什么');
  const p1 = preStepPayload({ agent, turn: 1, messages: [yesterday] });
  const r1 = await prep.handle(p1, nextFor(p1.messages));
  assert.equal(r1.messages.length, 2, 'yesterday archive hit injected');
  assert.ok(r1.messages.at(-1).content[0].text.includes('昨天聊猫咪'), 'the archived original was found');
  assert.equal(calls[0].query, undefined, 'the question sentence is not the lookup key');
  assert.equal(calls[0].fromIso, '2026-11-03T16:00:00.000Z', 'yesterday starts at Beijing 00:00');
  assert.equal(calls[0].toIso, '2026-11-04T16:00:00.000Z', 'yesterday ends at Beijing 24:00');
  const ev1 = log.events.find((event) => event.type === 'memory.recall' && event.payload.injected === true);
  assert.equal(ev1.payload.timeRange.label, '昨天');
  assert.equal(ev1.payload.timeRange.from, '2026-11-03T16:00:00.000Z');

  const fuzzy = userMessage('几天前做了什么来着，一时间想不起来了');
  const p2 = preStepPayload({ agent, turn: 2, messages: [fuzzy] });
  const r2 = await prep.handle(p2, nextFor(p2.messages));
  assert.equal(r2.messages.length, 2, 'fuzzy archive hit injected');
  assert.equal(calls[1].fromIso, '2026-11-02T16:00:00.000Z', '最近 3 天 starts at Beijing 00:00 two days back');
  assert.equal(calls[1].toIso, '2026-11-04T17:30:00.000Z', 'fuzzy window ends at the request instant');
  const ev2 = log.events.filter((event) => event.type === 'memory.recall').at(-1);
  assert.equal(ev2.payload.timeRange.label, '最近 3 天');
  assert.equal(ev2.payload.archiveReason, 'queried');

  const range = detectArchiveRange('最近 3 天', { now: NOW, timeZone: 'Asia/Shanghai' });
  assert.equal(range.fromIso, '2026-11-02T16:00:00.000Z');
  assert.equal(range.toIso, '2026-11-04T17:30:00.000Z');

  // Other required expressions resolve on the same Beijing midnight grid.
  const wednesday = detectArchiveRange('上周三', { now: NOW, timeZone: 'Asia/Shanghai' });
  assert.equal(wednesday.fromIso, '2026-10-27T16:00:00.000Z', '上周三 = Beijing 2026-10-28 all day');
  assert.equal(wednesday.toIso, '2026-10-28T16:00:00.000Z');
  const thisMonday = detectArchiveRange('本周一', { now: NOW, timeZone: 'Asia/Shanghai' });
  assert.equal(thisMonday.fromIso, '2026-11-01T16:00:00.000Z', '本周一 = Beijing 2026-11-02 all day');
  const lastWeek = detectArchiveRange('上周', { now: NOW, timeZone: 'Asia/Shanghai' });
  assert.equal(lastWeek.fromIso, '2026-10-25T16:00:00.000Z', '上周 starts Monday Beijing 00:00');
  assert.equal(lastWeek.toIso, '2026-11-01T16:00:00.000Z');
  const fuzzyWord = detectArchiveRange('前段时间', { now: NOW, timeZone: 'Asia/Shanghai' });
  assert.equal(fuzzyWord.kind, 'fuzzy');
  assert.equal(fuzzyWord.days, 3);
  console.log(`[11] 昨天=[${calls[0].fromIso}, ${calls[0].toIso}) 最近3天=[${calls[1].fromIso}, ${calls[1].toIso}) `
    + `上周三=[${wednesday.fromIso}, ${wednesday.toIso})`);
});

// #3 every await, including the log write, shares the deadline.

test('12) a 30 ms budget releases a 150 ms log wait without injecting', async () => {
  let logFinished = false;
  const memory = {
    fixedMemories: () => [],
    recall: () => ({
      hits: [{ id: 'budget-hit', ts: '2026-11-01T00:00:00.000Z', role: 'user', text: '月光下的散步', importance: 60, clarity: 'clear' }],
      mode: 'keyword',
    }),
    listArchive: () => [],
    restore: () => {},
  };
  const log = {
    async emit() {
      await sleep(150);
      logFinished = true;
    },
  };
  const started = performance.now();
  const result = await prepareMemoryInjection({
    memory,
    log,
    sessionId: 's12',
    turn: 1,
    query: '月光下的散步',
    budgetMs: 30,
    now: () => Date.now(),
  });
  const elapsed = performance.now() - started;

  assert.equal(result.injected, false, 'the log wait exceeded the deadline → no injection');
  assert.equal(result.text, '');
  assert.equal(result.reason, 'timeout');
  assert.equal(result.sources.active, 'ok');
  assert.ok(elapsed <= 80, `released in ${elapsed.toFixed(1)} ms with a 30 ms budget`);
  assert.equal(logFinished, false, 'the late log did not extend the return');
  console.log(`[12] budget 30 ms + log 150 ms → released in ${elapsed.toFixed(1)} ms, injected=${result.injected}`);
});

// #5 date labels use the C2 zone, not UTC.

test('13) injection date labels use Asia/Shanghai across midnight', () => {
  const first = formatInjectionLine(
    { ts: '2026-11-04T17:30:00Z', role: 'user', text: '凌晨的话' },
    { timeZone: 'Asia/Shanghai' },
  );
  const second = formatInjectionLine(
    { ts: '2026-11-03T16:30:00Z', role: 'user', text: '刚过零点' },
    { timeZone: 'Asia/Shanghai' },
  );
  assert.ok(first.startsWith('- [2026-11-05 ·'), first);
  assert.ok(second.startsWith('- [2026-11-04 ·'), second);
  console.log(`[13] 2026-11-04T17:30Z → ${first.slice(3, 13)}, 2026-11-03T16:30Z → ${second.slice(3, 13)}`);
});

// B: the status block reports window, sources and completeness.

test('14) the status block names the window, both sources and completeness', () => {
  const range = detectArchiveRange('昨天', { now: Date.parse('2026-11-05T02:00:00Z'), timeZone: 'Asia/Shanghai' });
  const complete = composeMemoryStatus({ sources: { active: 'ok', archive: 'not-run' }, range, timeZone: 'Asia/Shanghai' });
  assert.ok(complete.includes('时间范围：2026-11-04 全天（北京时间）'), complete);
  assert.ok(complete.includes('活跃库：无命中'));
  assert.ok(complete.includes('归档：未查'));
  assert.ok(complete.includes('完整性：complete'));
  assert.ok(complete.length <= 120, `status ${complete.length} chars`);

  const timeout = composeMemoryStatus({
    sources: { active: 'ok', archive: 'timeout' }, range, timeZone: 'Asia/Shanghai', complete: 'timeout',
  });
  assert.ok(timeout.includes('完整性：timeout（结果不完整，可能还有更多）'), timeout);
  const truncated = composeMemoryStatus({
    sources: { active: 'ok', archive: 'ok' }, range, timeZone: 'Asia/Shanghai', complete: 'budget-truncated',
  });
  assert.ok(truncated.includes('完整性：budget-truncated（结果不完整，可能还有更多）'), truncated);
  console.log(`[14] complete=${complete.length} chars, timeout=${timeout.length} chars, truncated=${truncated.length} chars`);
});

// A: the budget is an upper bound; a fast hit returns far earlier.

test('15) a fast hit returns far below the 1.5 s budget', async () => {
  const memory = {
    fixedMemories: () => [],
    recall: () => ({
      hits: [{ id: 'fast', ts: '2026-11-01T00:00:00.000Z', role: 'user', text: '月光下的散步', importance: 60, clarity: 'clear' }],
      mode: 'keyword',
    }),
    listArchive: () => [],
    restore: () => {},
  };
  const started = performance.now();
  const result = await prepareMemoryInjection({
    memory,
    log: eventLog(),
    sessionId: 's15',
    turn: 1,
    query: '月光下的散步',
    budgetMs: MEMORY_INJECTION_DEFAULTS.prepareBudgetMs,
    now: () => Date.now(),
  });
  const elapsed = performance.now() - started;
  assert.equal(result.injected, true);
  assert.ok(elapsed < 200, `fast hit took ${elapsed.toFixed(1)} ms of a 1500 ms budget`);
  console.log(`[15] fast hit in ${elapsed.toFixed(1)} ms (budget ${MEMORY_INJECTION_DEFAULTS.prepareBudgetMs} ms)`);
});

// C: the same query from a tool reuses C2's result; a different/deeper query re-queries.

test('16) assistant_recall reuses the C2 result for the same turn/query and only re-queries when deeper', async (t) => {
  const root = await tempRoot(t);
  seed(root, [
    { messageId: 'reuse-a', sessionId: 'seed-a', turnId: 1, text: '月光下的散步，我很喜欢' },
    { messageId: 'reuse-b', sessionId: 'seed-b', turnId: 2, text: '我喜欢喝冰美式' },
  ]);
  const app = mount(root);
  t.after(() => app.close());
  let recallCalls = 0;
  const originalRecall = MemoryStore.prototype.recall;
  MemoryStore.prototype.recall = function patchedRecall(...args) {
    recallCalls += 1;
    return originalRecall.apply(this, args);
  };
  t.after(() => { MemoryStore.prototype.recall = originalRecall; });

  const agent = agentFor(root, { sessionId: 'c2-reuse' });
  await app.fire({ id: 'c2-reuse' }, { type: 'turn/start', data: { turn: 1 } });
  const user = userMessage('月光下的散步');
  const payload = preStepPayload({ agent, turn: 1, messages: [user] });
  await app.preStep(payload, nextFor(payload.messages));
  assert.equal(recallCalls, 1, 'C2 ran the query once');

  const exec = { agent };
  const same = await app.call('assistant_recall', { query: '月光下的散步', limit: 6 }, exec);
  assert.equal(recallCalls, 1, 'the tool reused the C2 result instead of querying again');
  assert.ok(same.hits.length >= 1);
  const events = await readEvents(root);
  const reused = events.filter((event) => event.type === 'memory.query.reused');
  assert.equal(reused.length, 1);
  assert.equal(reused[0].payload.source, 'c2');
  assert.ok(typeof reused[0].payload.key === 'string' && reused[0].payload.key.length > 0);

  const deeper = await app.call('assistant_recall', { query: '月光下的散步', limit: 20 }, exec);
  assert.ok(deeper.hits.length >= 1);
  assert.equal(recallCalls, 2, 'a deeper page (limit 20) forces a real query');

  const other = await app.call('assistant_recall', { query: '冰美式', limit: 6 }, exec);
  assert.ok(other.hits.length >= 1);
  assert.equal(recallCalls, 3, 'a different query is not reused');
  console.log('[16] C2 recall=1, same tool query=1 (reused), deeper=2, different=3');
});

// D: one turn + one id is strengthened once across C2 and tools; new hits still get their turn.

test('17) the reinforcement ledger dedupes C2/tool overlap but still strengthens new hits', async (t) => {
  const root = await tempRoot(t);
  seed(root, [
    { messageId: 'ledger-a', sessionId: 'seed-la', turnId: 1, text: '月光下的散步，我很喜欢' },
    { messageId: 'ledger-b', sessionId: 'seed-lb', turnId: 2, text: '我喜欢喝冰美式' },
  ]);
  const app = mount(root);
  t.after(() => app.close());
  const restoreCalls = captureRestore(t);
  const agent = agentFor(root, { sessionId: 'c2-ledger' });
  await app.fire({ id: 'c2-ledger' }, { type: 'turn/start', data: { turn: 1 } });

  const user = userMessage('月光下的散步');
  const payload = preStepPayload({ agent, turn: 1, messages: [user] });
  const decision = await app.preStep(payload, nextFor(payload.messages));
  await app.fire({ id: 'c2-ledger' }, { type: 'user/message', data: decision.messages.at(-1) });
  const afterC2 = restoreCalls.length;
  assert.equal(afterC2, 1, 'C2 acceptance strengthened the delivered id once');

  const exec = { agent };
  await app.call('assistant_recall', { query: '月光下的散步', limit: 6 }, exec);
  assert.equal(restoreCalls.length, afterC2, 'the same id delivered by the tool is not strengthened again');

  const fresh = await app.call('assistant_recall', { query: '冰美式', limit: 6 }, exec);
  assert.ok(fresh.hits.length >= 1);
  assert.ok(restoreCalls.length > afterC2, 'a new hit from the same turn is still strengthened');
  console.log(`[17] C2 restore=${afterC2}, tool same query=${afterC2}, new hit=${restoreCalls.length}`);
});

// Parent-requested intent rule: the prompt itself must tell the model to search proactively.

test('19) the memory prompt tells the model to search proactively and convert fuzzy times', async (t) => {
  const root = await tempRoot(t);
  const app = mount(root);
  t.after(() => app.close());
  const section = app.sections.find((entry) => entry.name === 'assistant:memory-usage');
  assert.ok(section !== undefined, 'memory-usage section registered');
  const context = { agent: { session: { header: { cwd: join(root, 'workspace') } } } };
  const text = section.text(context);
  assert.ok(text.includes('主动用 `assistant_recall` / `assistant_archive_search` 查一次'), 'proactive tool rule');
  assert.ok(text.includes('不要反问「要我去翻吗」'), 'do not ask back');
  assert.ok(text.includes('北京时间'), 'Beijing time conversion rule');
  assert.ok(text.includes('默认最近 3 天'), 'fuzzy default');
  assert.ok(text.includes('最近 7 天'), 'fallback range');
  console.log('[19] memory prompt carries the proactive-search and Beijing-range rule');
});

// E: a same-turn correction invalidates the cached copy and is shown as the new version.

test('18) a same-turn correction is not hidden by reuse and is flagged as updated', async (t) => {
  const root = await tempRoot(t);
  seed(root, [{ messageId: 'corr-e', sessionId: 'seed-e', turnId: 1, text: '记忆库放在 E 盘，很重要' }]);
  const app = mount(root);
  t.after(() => app.close());
  const restoreCalls = captureRestore(t);
  const agent = agentFor(root, { sessionId: 'c2-correct' });
  await app.fire({ id: 'c2-correct' }, { type: 'turn/start', data: { turn: 1 } });

  const user = userMessage('记忆库放在哪个盘');
  const payload = preStepPayload({ agent, turn: 1, messages: [user] });
  const decision = await app.preStep(payload, nextFor(payload.messages));
  await app.fire({ id: 'c2-correct' }, { type: 'user/message', data: decision.messages.at(-1) });
  const restoreBefore = restoreCalls.length;

  const exec = { agent };
  const before = await app.call('assistant_recall', { query: '记忆库放在哪个盘', limit: 6 }, exec);
  const hit = before.hits.find((row) => row.text.includes('E 盘'));
  assert.ok(hit !== undefined, 'the original record is retrieved');
  assert.equal(hit.version, 1);

  const corrected = await app.call('assistant_memory_correct', {
    targetId: hit.id,
    expectedVersion: hit.version,
    expectedText: 'E 盘',
    replacement: 'F 盘',
    sourceMessageId: 'corr-source',
  }, exec);
  assert.equal(corrected.ok, true, 'the correction applies');
  assert.equal(corrected.version, 2);

  // Same query again: the cached (v1) result must not be reused after a same-turn correction.
  const after = await app.call('assistant_recall', { query: '记忆库放在哪个盘', limit: 6 }, exec);
  const current = after.hits.find((row) => row.id === hit.id);
  assert.ok(current !== undefined, 'the corrected record is still retrievable');
  assert.equal(current.version, 2, 'the new version is returned');
  assert.ok(current.text.includes('F 盘') && !current.text.includes('E 盘'), current.text);
  assert.equal(current.turnUpdated, true, 'the row is flagged as updated this turn');
  const rendered = app.tool('assistant_recall').output.render({}, after)[0].text;
  assert.ok(rendered.includes('该记录已于本轮更新'), 'the model-facing text carries the update marker');
  assert.equal(restoreCalls.length, restoreBefore, 'the version bump adds no extra reinforcement');
  console.log(`[18] v${hit.version}→v${current.version}, text="${current.text}", `
    + `restore ${restoreBefore}→${restoreCalls.length}`);
});

// F: a correction changes WHICH records match, so an empty cached result has no version to
// compare and a non-empty page can miss the newly matching record. The whole turn's query cache
// is dropped; the once-per-turn reinforcement ledger is kept.

/** Count real store queries so "reused" vs "re-queried" is observable, not assumed. */
function captureRecall(t) {
  const counter = { calls: 0 };
  const original = MemoryStore.prototype.recall;
  MemoryStore.prototype.recall = function patchedRecall(...args) {
    counter.calls += 1;
    return original.apply(this, args);
  };
  t.after(() => {
    MemoryStore.prototype.recall = original;
  });
  return counter;
}

test('20) an empty cached result is invalidated by a same-turn correction and the new match appears', async (t) => {
  const root = await tempRoot(t);
  const [targetId] = seed(root, [
    { messageId: 'inv-empty', sessionId: 'seed-inv-empty', turnId: 1, text: '项目代号 VegaProject 的里程碑' },
  ]);
  const app = mount(root);
  t.after(() => app.close());
  const restoreCalls = captureRestore(t);
  const recall = captureRecall(t);

  const agent = agentFor(root, { sessionId: 'c2-invalidate' });
  await app.fire({ id: 'c2-invalidate' }, { type: 'turn/start', data: { turn: 1 } });
  const payload = preStepPayload({ agent, turn: 1, messages: [userMessage('OrionProject')] });
  await app.preStep(payload, nextFor(payload.messages));
  assert.equal(recall.calls, 1, 'C2 ran the query once');

  const exec = { agent };
  const miss = await app.call('assistant_recall', { query: 'OrionProject', limit: 6 }, exec);
  assert.equal(miss.hits.length, 0, 'the empty result is cached before the correction');
  assert.equal(recall.calls, 1, 'the cached empty result is reused instead of re-queried');
  assert.equal(restoreCalls.length, 0, 'an empty result strengthens nothing');

  const corrected = await app.call('assistant_memory_correct', {
    targetId,
    expectedVersion: 1,
    expectedText: 'VegaProject',
    replacement: 'OrionProject',
    sourceMessageId: 'inv-source-1',
  }, exec);
  assert.equal(corrected.ok, true, 'the correction applies');
  assert.equal(corrected.version, 2);

  const events = await readEvents(root);
  const invalidated = events.filter((event) => event.type === 'memory.cache.invalidated');
  assert.equal(invalidated.length, 1, 'one invalidation event for the turn');
  assert.deepEqual(invalidated[0].payload, { sessionId: 'c2-invalidate', turn: 1, reason: 'correction' });

  const hit = await app.call('assistant_recall', { query: 'OrionProject', limit: 6 }, exec);
  assert.equal(recall.calls, 2, 'the invalidated query hits the database again');
  assert.equal(hit.hits.length, 1, 'the corrected body now falls inside the match set');
  assert.equal(hit.hits[0].id, targetId);
  assert.equal(hit.hits[0].version, 2);
  assert.ok(hit.hits[0].text.includes('OrionProject') && !hit.hits[0].text.includes('VegaProject'));
  assert.equal(restoreCalls.length, 1, 'the newly appearing id is strengthened once');
  assert.deepEqual(restoreCalls[0], [targetId]);
  console.log(`[20] miss=0, invalidated=${invalidated.length}, hit=${hit.hits.length} `
    + `v${hit.hits[0].version}, restore=${restoreCalls.length}`);
});

test('21) a correction that adds a matching record refills a non-empty cached page', async (t) => {
  const root = await tempRoot(t);
  const ids = seed(root, [
    { messageId: 'inv-add-a', sessionId: 'seed-inv-a', turnId: 1, text: 'Project Alpha 的里程碑' },
    { messageId: 'inv-add-b', sessionId: 'seed-inv-b', turnId: 1, text: '升级发布会安排' },
  ]);
  const app = mount(root);
  t.after(() => app.close());
  const recall = captureRecall(t);

  const agent = agentFor(root, { sessionId: 'c2-invalidate-add' });
  await app.fire({ id: 'c2-invalidate-add' }, { type: 'turn/start', data: { turn: 1 } });
  const payload = preStepPayload({ agent, turn: 1, messages: [userMessage('Project')] });
  await app.preStep(payload, nextFor(payload.messages));
  assert.equal(recall.calls, 1, 'C2 ran the query once');

  const exec = { agent };
  const first = await app.call('assistant_recall', { query: 'Project', limit: 6 }, exec);
  assert.equal(recall.calls, 1, 'the cached one-hit page is reused');
  assert.deepEqual(first.hits.map((row) => row.id), [ids[0]], 'only the first record matches before the correction');

  const corrected = await app.call('assistant_memory_correct', {
    targetId: ids[1],
    expectedVersion: 1,
    expectedText: '发布会',
    replacement: 'Project 发布会',
    sourceMessageId: 'inv-source-2',
  }, exec);
  assert.equal(corrected.ok, true, 'the correction applies');
  assert.equal(corrected.version, 2);

  const events = await readEvents(root);
  const invalidated = events.filter((event) => event.type === 'memory.cache.invalidated');
  assert.equal(invalidated.length, 1, 'one invalidation event for the turn');

  const second = await app.call('assistant_recall', { query: 'Project', limit: 6 }, exec);
  assert.equal(recall.calls, 2, 'the non-empty page is re-queried after the correction');
  assert.equal(second.hits.length, 2, 'the corrected record joined the match set');
  assert.deepEqual(second.hits.map((row) => row.id).sort(), [...ids].sort());
  const added = second.hits.find((row) => row.id === ids[1]);
  assert.equal(added.version, 2);
  assert.ok(added.text.includes('Project'));
  assert.equal(added.turnUpdated, true, 'the new match is flagged as updated this turn');
  console.log(`[21] hits 1→${second.hits.length}, recalled=${recall.calls}, invalidated=${invalidated.length}`);
});

test('22) a correction keeps the reinforcement ledger: known ids stay once, the new id strengthens once', async (t) => {
  const root = await tempRoot(t);
  const ids = seed(root, [
    { messageId: 'dedup-a', sessionId: 'seed-dedup-a', turnId: 1, text: 'Project Alpha 的里程碑' },
    { messageId: 'dedup-b', sessionId: 'seed-dedup-b', turnId: 1, text: '升级发布会安排' },
  ]);
  const app = mount(root);
  t.after(() => app.close());
  const restoreCalls = captureRestore(t);

  const agent = agentFor(root, { sessionId: 'c2-invalidate-dedup' });
  await app.fire({ id: 'c2-invalidate-dedup' }, { type: 'turn/start', data: { turn: 1 } });
  const user = userMessage('Project');
  const payload = preStepPayload({ agent, turn: 1, messages: [user] });
  const decision = await app.preStep(payload, nextFor(payload.messages));
  await app.fire({ id: 'c2-invalidate-dedup' }, { type: 'user/message', data: decision.messages.at(-1) });
  const afterC2 = restoreCalls.length;
  assert.equal(afterC2, 1, 'C2 acceptance strengthened the delivered id once');

  const exec = { agent };
  const reuse = await app.call('assistant_recall', { query: 'Project', limit: 6 }, exec);
  assert.equal(reuse.hits.length, 1);
  assert.equal(restoreCalls.length, afterC2, 'the reused id is not strengthened again');

  const correctedA = await app.call('assistant_memory_correct', {
    targetId: ids[0],
    expectedVersion: 1,
    expectedText: 'Alpha',
    replacement: 'Alpha 二期',
    sourceMessageId: 'dedup-source-a',
  }, exec);
  assert.equal(correctedA.ok, true);
  const afterCorrectionA = await app.call('assistant_recall', { query: 'Project', limit: 6 }, exec);
  assert.equal(afterCorrectionA.hits.length, 1, 'the corrected known record still matches');
  assert.equal(afterCorrectionA.hits[0].version, 2);
  assert.equal(restoreCalls.length, afterC2, 'the already strengthened id is not strengthened after invalidation');

  const correctedB = await app.call('assistant_memory_correct', {
    targetId: ids[1],
    expectedVersion: 1,
    expectedText: '发布会',
    replacement: 'Project 发布会',
    sourceMessageId: 'dedup-source-b',
  }, exec);
  assert.equal(correctedB.ok, true);
  const afterCorrectionB = await app.call('assistant_recall', { query: 'Project', limit: 6 }, exec);
  assert.equal(afterCorrectionB.hits.length, 2);
  assert.equal(restoreCalls.length, afterC2 + 1, 'only the newly appearing id is strengthened');
  assert.deepEqual(restoreCalls.at(-1), [ids[1]], 'the new id is the one strengthened, exactly once');
  console.log(`[22] restore C2=${afterC2}, known id after correction=${afterC2}, `
    + `new id adds=${restoreCalls.length - afterC2}`);
});

test('23) invalidation is scoped to one (sessionId, turn) and keeps its reinforcement ledger', () => {
  const ledger = createMemoryTurnLedger();
  const turnOne = { sessionId: 'scope', turn: 1 };
  const turnTwo = { sessionId: 'scope', turn: 2 };
  ledger.remember({ ...turnOne, query: 'OrionProject', limit: 6, value: { hits: [] } });
  ledger.remember({ ...turnOne, query: 'Project', limit: 6, value: { hits: [{ id: 'a', version: 1 }] }, versions: { a: 1 } });
  ledger.remember({
    ...turnTwo,
    query: 'VegaProject',
    limit: 6,
    value: { hits: [{ id: 'b', version: 1 }] },
    versions: { b: 1 },
  });
  ledger.markStrengthened({ ...turnOne, ids: ['a'] });
  assert.notEqual(ledger.lookup({ ...turnOne, query: 'OrionProject', limit: 6 }), null, 'fresh before invalidation');

  ledger.invalidateQueries(turnOne);
  assert.equal(ledger.lookup({ ...turnOne, query: 'OrionProject', limit: 6 }), null, 'the empty page is dropped');
  assert.equal(ledger.lookup({ ...turnOne, query: 'Project', limit: 6 }), null, 'the non-empty page is dropped too');
  assert.notEqual(
    ledger.lookup({ ...turnTwo, query: 'VegaProject', limit: 6 }),
    null,
    'the other turn cache is still reusable',
  );
  assert.equal(ledger.hasStrengthened({ ...turnOne, id: 'a' }), true, 'the reinforcement ledger is not cleared');
  console.log('[23] turn 1 dropped=2, turn 2 cache reused=1, strengthened kept=1');
});

// ---- Phase-3: injection order and the real rendered budget ------------------

test('24) two direct hits both survive when the first hit owns long context', async (t) => {
  const root = await tempRoot(t);
  const filler = (subject) => `${subject}${'，我们聊了很多细节和安排'.repeat(80)}`;
  seed(root, [
    {
      messageId: 'order-hit-a', sessionId: 'order-a', turnId: 2, role: 'user', importance: 80,
      ts: '2026-11-05T10:00:00.000Z', text: filler('月光下的散步真舒服'),
    },
    {
      messageId: 'order-pair-a', sessionId: 'order-a', turnId: 2, role: 'assistant', importance: 60,
      ts: '2026-11-05T10:00:05.000Z', text: filler('那段对话的后续是工作和吃饭'),
    },
    {
      messageId: 'order-hit-b', sessionId: 'order-b', turnId: 1, role: 'user', importance: 60,
      ts: '2026-11-01T10:00:00.000Z', text: '月光下的散步让我想起童年',
    },
    {
      messageId: 'order-fixed', sessionId: 'order-f', turnId: 1, role: 'user', importance: 90,
      ts: '2026-11-05T12:00:00.000Z', text: filler('用户长期偏好是早睡早起'),
    },
  ]);
  const store = new MemoryStore(root);
  store.open();
  t.after(() => store.close());
  const log = eventLog();
  const result = await prepareMemoryInjection({
    memory: store,
    log,
    sessionId: 'order-session',
    turn: 1,
    query: '月光下的散步',
    budgetMs: MEMORY_INJECTION_DEFAULTS.prepareBudgetMs,
  });

  assert.equal(result.injected, true);
  assert.ok(result.text.length <= MEMORY_INJECTION_DEFAULTS.maxChars,
    `injected ${result.text.length} chars, cap ${MEMORY_INJECTION_DEFAULTS.maxChars}`);
  assert.ok(result.text.includes('月光下的散步真舒服'), 'first direct hit is present');
  assert.ok(result.text.includes('月光下的散步让我想起童年'),
    `the second direct hit is not pushed out by the first hit's context: ${result.text}`);
  assert.ok(result.text.indexOf('固定') < result.text.indexOf('月光下的散步真舒服'),
    'fixed layer still spends the budget first');
  console.log(`[24] injected=${result.text.length} chars, hitA=`
    + `${result.text.includes('月光下的散步真舒服')}, hitB=${result.text.includes('月光下的散步让我想起童年')}`);
});

test('25) the char budget charges heading, labels and separators against the rendered text', () => {
  const cap = MEMORY_INJECTION_DEFAULTS.maxChars;
  const base = MEMORY_INJECTION_HEADING.length + 1 + MEMORY_INJECTION_FOOTER.length;
  const labelChars = formatInjectionLine(
    { ts: '2026-11-01T00:00:00.000Z', role: 'user', text: '' },
    { timeZone: 'Asia/Shanghai' },
  ).length;
  const half = cap - base;
  const bodyA = Math.floor(half / 2) - labelChars - 1;
  const bodyB = bodyA + (half - 2 * (labelChars + 1 + bodyA));
  const row = (id, body) => ({ id, ts: '2026-11-01T00:00:00.000Z', role: 'user', text: body });
  const rows = [row('edge-a', '甲'.repeat(bodyA)), row('edge-b', '乙'.repeat(bodyB))];

  // Two bodies alone are far below the cap: only heading + labels + newlines bring it to 1200.
  assert.ok(bodyA + bodyB < cap, `body-only ${bodyA + bodyB} < ${cap}`);
  const exact = composeInjectionBlock({ matched: rows });
  assert.equal(exact.text.length, cap, 'the two lines land exactly on the cap, labels included');
  assert.equal(exact.injectedRecords, 2);
  assert.equal(exact.overflow, false);

  const tight = composeInjectionBlock({ matched: [...rows, row('edge-c', '丙'.repeat(100))] });
  assert.ok(tight.text.length <= cap, `still within the cap: ${tight.text.length}`);
  assert.equal(tight.injectedRecords, 2, 'no room is left for a third line once the real overhead is charged');
  assert.equal(tight.skippedByChars, 1, 'the third line is reported as char-budget');
  assert.deepEqual(tight.skipped.map((item) => item.reason), ['char-budget']);
  console.log(`[25] two bodies=${bodyA + bodyB} chars → rendered=${exact.text.length}/${cap} (label=${labelChars}, `
    + `frame=${base}), third line skipped=${tight.skippedByChars}`);
});

test('26) an over-long hit is compressed around its evidence; the rest is skipped as char-budget', async () => {
  const hits = [
    {
      id: 'long-evidence', kind: 'hit', ts: '2026-11-01T00:00:00.000Z', role: 'user', clarity: 'clear',
      text: `${'垫'.repeat(2000)}月光${'尾'.repeat(1500)}`,
    },
    {
      id: 'long-plain', kind: 'hit', ts: '2026-11-02T00:00:00.000Z', role: 'user', clarity: 'clear',
      text: `${'另一个很长的记忆'}${'长'.repeat(3000)}`,
    },
    {
      id: 'long-tail', kind: 'hit', ts: '2026-11-03T00:00:00.000Z', role: 'user', clarity: 'clear',
      text: `${'第三个很长的记忆'}${'久'.repeat(3000)}`,
    },
  ];
  const memory = fakeMemory({ hits });
  const log = eventLog();
  const result = await prepareMemoryInjection({
    memory, log, sessionId: 'long-session', turn: 1, query: '月光', budgetMs: 1500,
  });

  assert.equal(result.injected, true);
  assert.ok(result.text.length <= MEMORY_INJECTION_DEFAULTS.maxChars,
    `injected ${result.text.length} chars, cap ${MEMORY_INJECTION_DEFAULTS.maxChars}`);
  assert.ok(result.text.includes('月光'), 'the evidence word survives compression');
  const injection = log.events.find((event) => event.type === 'memory.injection');
  assert.ok(injection !== undefined, 'memory.injection recorded');
  assert.equal(injection.payload.injectedChars, result.text.length);
  assert.ok(injection.payload.skippedByChars >= 1, 'at least one record was skipped on characters');
  assert.ok(injection.payload.hits >= 1, 'the delivered rows are counted by kind');
  console.log(`[26] ${hits.length} oversized hits → injected=${result.text.length} chars, `
    + `hits=${injection.payload.hits}, skippedByChars=${injection.payload.skippedByChars}`);
});

test('27) the fixed layer keeps what fits, reports overflow, and never claims a full injection', async () => {
  const fixed = [0, 1, 2].map((index) => ({
    id: `fixed-over-${index}`,
    ts: '2026-11-01T00:00:00.000Z',
    text: `固定记忆${index}${'固'.repeat(700)}`,
    importance: 90,
  }));
  const memory = fakeMemory({
    fixed,
    hits: [{
      id: 'rel-after-fixed', ts: '2026-11-02T00:00:00.000Z', role: 'user', text: '相关记忆一',
      importance: 60, clarity: 'clear',
    }],
  });
  const log = eventLog();
  const result = await prepareMemoryInjection({
    memory, log, sessionId: 'fixed-over-session', turn: 1, query: '相关记忆',
    budgetMs: 1500, displayChars: 800,
  });

  assert.equal(result.injected, true, 'the part that fits is still injected');
  const text = result.text;
  assert.ok(text.length <= MEMORY_INJECTION_DEFAULTS.maxChars,
    `injected ${text.length} chars, cap ${MEMORY_INJECTION_DEFAULTS.maxChars}`);
  assert.ok(text.includes('固定记忆0'), 'the first fixed record is kept');
  assert.ok(!text.includes('固定记忆2'), 'the oversized fixed tail is dropped');
  const overflow = log.events.find((event) => event.type === 'memory.budget.overflow');
  assert.ok(overflow !== undefined, 'overflow event recorded');
  assert.ok(overflow.payload.requestedRecords > overflow.payload.injectedRecords,
    'not all requested records were injected');
  assert.equal(overflow.payload.injectedChars, text.length);
  const recall = log.events.find((event) => event.type === 'memory.recall');
  assert.equal(recall.payload.injected, true);
  assert.equal(recall.payload.records, overflow.payload.injectedRecords);
  assert.ok(recall.payload.fixedRecords < fixed.length, 'the claim never covers every fixed record');
  const injection = log.events.find((event) => event.type === 'memory.injection');
  assert.ok(injection.payload.skippedByChars >= 1, 'the dropped fixed rows are reported');
  console.log(`[27] fixed ${fixed.length}→${recall.payload.fixedRecords}, `
    + `records ${overflow.payload.requestedRecords}→${overflow.payload.injectedRecords}, `
    + `injected=${text.length} chars, overflow=true`);
});

// ---- unresolved marker: never trimmed away ----------------------------------

test('28) a long unresolved record keeps [待核验] in front of the trimmed body under 240 chars', async () => {
  // The query term sits past the head window on purpose: the old trimmer opened its snippet
  // around it and clipped the marker off the front. The disclosure must survive that.
  const body = `${'很长的旧事实'.repeat(50)}一起看电影${'后续补充'.repeat(20)}`;
  const hits = [{
    id: 'unresolved-long', kind: 'hit', ts: '2026-11-01T00:00:00.000Z', role: 'user',
    clarity: 'clear', unresolved: 1, staleLink: false, text: `${UNRESOLVED_MARK} ${body}`,
  }];
  const memory = fakeMemory({ hits });
  const log = eventLog();
  const result = await prepareMemoryInjection({
    memory, log, sessionId: 'unresolved-long-session', turn: 1, query: '电影', budgetMs: 1500,
    limits: { maxChars: 240, maxRecords: 6 },
  });

  assert.equal(result.injected, true, 'the row is still injected, just compressed');
  assert.ok(result.text.length <= 240, `injected ${result.text.length} chars, cap 240`);
  const line = result.text.split('\n').find((entry) => entry.startsWith('- ['));
  assert.ok(line !== undefined, `one record line:\n${result.text}`);
  assert.ok(line.includes(`] ${UNRESOLVED_MARK} `), `the marker sits directly after the label: ${line}`);
  assert.ok(line.includes('…'), `the body around the evidence was clipped: ${line}`);
  assert.ok(!result.text.includes(body), 'the long body never appears whole');
  const injection = log.events.find((event) => event.type === 'memory.injection');
  assert.ok(injection !== undefined, 'memory.injection recorded');
  assert.equal(injection.payload.unresolvedRows, 1, 'the event counts the disclosed row');
  assert.ok(injection.payload.injectedChars <= 240);
  console.log(`[28] injected=${result.text.length}/240, line="${line.slice(0, 52)}…", `
    + `unresolvedRows=${injection.payload.unresolvedRows}`);
});

test('29) a short unresolved record keeps the marker and the complete body', () => {
  const row = {
    id: 'unresolved-short', kind: 'hit', ts: '2026-11-01T00:00:00.000Z', role: 'user',
    clarity: 'clear', unresolved: 1, text: `${UNRESOLVED_MARK} 团子最近不爱吃饭`,
  };
  const composed = composeInjectionBlock({ matched: [row] });
  const line = composed.text.split('\n').find((entry) => entry.startsWith('- ['));
  assert.equal(line, `- [2026-11-01 · 原文·user] ${UNRESOLVED_MARK} 团子最近不爱吃饭`,
    'marker first, then the whole body');
  assert.equal(composed.unresolvedRows, 1);
  assert.equal(composed.skippedByChars, 0);
  assert.equal(composed.injectedChars, composed.text.length);
  console.log(`[29] line="${line}" chars=${composed.injectedChars} unresolvedRows=${composed.unresolvedRows}`);
});

test('30) an unresolved row that cannot afford its marker is skipped whole, never shown bare', () => {
  const body = '旧的约定是每周三晚上一起看电影';
  const row = {
    id: 'unresolved-tight', kind: 'hit', ts: '2026-11-01T00:00:00.000Z', role: 'user',
    clarity: 'clear', unresolved: 1, text: `${UNRESOLVED_MARK} ${body}`,
  };
  const composed = composeInjectionBlock({ matched: [row], limits: { maxChars: 30, maxRecords: 6 } });
  assert.equal(composed.text, '', 'nothing can be rendered under 30 chars');
  assert.ok(composed.skippedByChars > 0, `skippedByChars=${composed.skippedByChars}`);
  assert.deepEqual(composed.skipped.map((item) => item.reason), ['char-budget']);
  assert.equal(composed.unresolvedRows, 0);
  assert.ok(!composed.text.includes(body), 'the old fact is not injected without its marker');
  console.log(`[30] tight=30 chars → skipped=${composed.skippedByChars}, unresolvedRows=0, text=""`);
});

test('31) a healthy row stays unchanged and the event counts zero unresolved rows', async () => {
  const hits = [{
    id: 'healthy-injection', kind: 'hit', ts: '2026-11-01T00:00:00.000Z', role: 'user',
    clarity: 'clear', unresolved: 0, text: '月光下的散步真舒服',
  }];
  const memory = fakeMemory({ hits });
  const log = eventLog();
  const result = await prepareMemoryInjection({
    memory, log, sessionId: 'healthy-injection-session', turn: 1, query: '月光', budgetMs: 1500,
  });
  assert.equal(result.injected, true);
  assert.ok(result.text.includes('月光下的散步真舒服'), 'the healthy body is untouched');
  assert.equal(result.text.includes(UNRESOLVED_MARK), false, 'no marker is invented');
  const injection = log.events.find((event) => event.type === 'memory.injection');
  assert.equal(injection.payload.unresolvedRows, 0);
  assert.equal(injection.payload.skippedByChars, 0);
  console.log(`[31] healthy line kept, unresolvedRows=0, chars=${result.text.length}`);
});
