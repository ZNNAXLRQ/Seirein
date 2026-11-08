/**
 * Rollover digest injection: the day background is context for the target assistant session's
 * FIRST request, never a turn of its own.
 *
 * The regression this locks down: the host used to `followup(digest)` before `followup(request)`
 * on a freshly created session, so the digest opened turn 1, the model answered it (the observed
 * run took 124 s) and the user's request only started on turn 2 — minutes of silence.
 *
 * Covered:
 *   1. the first user message's request carries the digest; exactly one followup (no digest turn)
 *   2. the digest is not written to memory and triggers no waiting line / TTS / typed speech
 *   3. a retry or a later turn never appends it twice (and the key survives a reload)
 *   4. a subagent or a non-target session is never injected
 *   5. an unready digest degrades immediately (stale summary / bounded fallback / truncation)
 *      without blocking the first request
 *   6. every original rollover duty still exists (generation, stamp, title, session creation,
 *      force action, self-check)
 *
 * Run: node --test test/rollover-digest-injection.mjs
 * Regression batch: node --test test/session-*.mjs test/voice-lanes.mjs test/response-group.mjs
 *   test/perception-*.mjs test/c2-injection.mjs test/memory-pipeline.mjs
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  apply,
  dayStampFor,
  deliverVoiceRequest,
  voiceSessionTarget,
} from '../src/host/index.js';
import { ensureSession } from '../src/host/session/delivery/dispatch.js';
import { createSpeechTurnObserver } from '../src/host/speech/events.js';
import {
  ROLLOVER_DIGEST_HEADING,
  ROLLOVER_DIGEST_MAX_CHARS,
  ROLLOVER_DIGEST_SOURCE,
  createRolloverDigest,
  isRolloverDigestMessage,
} from '../src/host/session/conversation/rollover-digest.js';
import { cleanupRoot } from './helpers/cleanup.mjs';

/**
 * The mounted plugin uses rollover hour 0 so the day stamp is the calendar day: the suite must
 * behave the same at 02:00 and at 15:00, and the digest date is then deterministic.
 */
const ROLLOVER_HOUR = 0;
const INJECTION_TIME_LIMIT_MS = 500;
const DIGEST_DECISION_TIME_LIMIT_MS = 100;

const tick = (ms) => new Promise((resolveTick) => setTimeout(resolveTick, ms));
const sleep = (ms) => tick(ms);

function todayStamp() {
  return dayStampFor(new Date(), ROLLOVER_HOUR);
}

/** One genuine user message, the shape the Harness logs and the inbox carries. */
function userMessage(text, id = `u-${Math.random().toString(36).slice(2)}`) {
  return { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] };
}

function defaultDecision(messages) {
  return { kind: 'enter', messages: [...messages] };
}

const nextFor = (messages) => async () => defaultDecision(messages);

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
function agentFor(sessionId, root, header = {}) {
  return {
    id: `agent-${sessionId}`,
    options: {},
    session: { id: sessionId, header: { cwd: join(root, 'workspace'), ...header } },
  };
}

/**
 * Create a temp root and mount the plugin on it. The teardown closes every store BEFORE the
 * directory is removed: on Windows a still-open SQLite WAL makes `rm` fail with EBUSY.
 */
async function mountApp(t, { prepare = null, config = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-rollover-digest-'));
  if (typeof prepare === 'function') await prepare(root);
  const app = mount(root, config);
  t.after(async () => {
    app.close();
    await sleep(80);
    await cleanupRoot(root);
  });
  return { root, app };
}

async function writeJson(root, name, value) {
  await mkdir(join(root, 'data'), { recursive: true });
  await writeFile(join(root, 'data', name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readJson(root, name) {
  try {
    return JSON.parse(await readFile(join(root, 'data', name), 'utf8'));
  } catch {
    return {};
  }
}

/** Seed a stored digest and mark the day as already rolled over, so boot never regenerates it. */
async function seedDigest(root, { date, digest, lastRollover = date }) {
  await writeJson(root, 'settings.json', { dayDigest: { date, digest } });
  await writeJson(root, 'memory-state.json', { lastRollover });
}

/** In-memory stand-in for the real event log. */
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

async function readEvents(root) {
  try {
    const raw = await readFile(join(root, 'data', 'events.jsonl'), 'utf8');
    return raw.trim().split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function waitForEvent(root, type, predicate = () => true, timeoutMs = 3000) {
  const startedAt = Date.now();
  for (;;) {
    const row = (await readEvents(root)).find((event) => event.type === type && predicate(event.payload ?? {}));
    if (row !== undefined) return row.payload ?? {};
    if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out waiting for ${type}`);
    await tick(10);
  }
}

/** Mount the real plugin with a fake context; the pre-step waterfall and the routes are real. */
function mount(root, config = {}) {
  const tools = new Map();
  const routes = new Map();
  const listenerMap = new Map();
  const sections = [];
  const cleanups = [];
  const services = new Map();
  const workspacePath = join(root, 'workspace');
  const registered = [];
  const attached = [];
  const renamed = [];
  const createdAgents = [];
  const deliveries = [];

  const registry = {
    async create(path, title) {
      registered.push({ path, title });
      return { id: 'ws-rollover-digest', path, title };
    },
    get(id) {
      if (id !== 'ws-rollover-digest') return undefined;
      return {
        id,
        path: workspacePath,
        async attachSession(sessionId) {
          attached.push(sessionId);
        },
      };
    },
  };
  const sessionTitle = {
    get: () => undefined,
    rename(_session, title) {
      renamed.push(title);
      return { title, source: { kind: 'user' } };
    },
  };
  services.set('workspaceRegistry', registry);
  services.set('sessionTitle', sessionTitle);
  services.set('agentDefaultModel', { currentSelection: () => ({ provider: 'fake-provider', model: 'fake-model' }) });
  services.set('agentLoop', {
    async resume() {
      throw new Error('not persisted yet');
    },
    async createAgent(_ownerCtx, options) {
      createdAgents.push(options);
      const session = { id: options.sessionId, header: { cwd: options.meta?.cwd ?? '' }, append() {} };
      const agent = {
        id: options.sessionId,
        session,
        followup(message) {
          deliveries.push({ message, sessionId: options.sessionId });
        },
      };
      return { agent };
    },
  });

  const effect = (fn) => {
    const dispose = fn();
    if (typeof dispose === 'function') cleanups.push(dispose);
    return dispose;
  };
  const on = (event, handler) => {
    const list = listenerMap.get(event) ?? [];
    list.push(handler);
    listenerMap.set(event, list);
    return () => {
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    };
  };
  const registerRoute = (route) => {
    routes.set(route.path, route.handler);
    return () => routes.delete(route.path);
  };
  const ctx = {
    effect,
    on,
    get: (name) => services.get(name),
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    inject: (_deps, registerScope) => {
      registerScope({
        effect,
        on,
        get: (name) => services.get(name),
        workspaceRegistry: registry,
        systemPrompt: {
          section(definition) {
            sections.push(definition);
            return () => {};
          },
        },
        webServer: { register: registerRoute },
      });
    },
    webServer: { register: registerRoute },
  };
  apply(ctx, { root, enabled: true, sessionRolloverHour: ROLLOVER_HOUR, ...config });

  /** Run the whole `agent/pre-step` waterfall exactly like the loop does. */
  const preStep = async (payload, next) => {
    const handlers = listenerMap.get('agent/pre-step') ?? [];
    assert.equal(handlers.length, 2, 'two pre-step listeners: memory block + conversation context');
    assert.match(String(handlers[0]), /memoryPreStep\.handle/u, 'listener 1 is the memory injector');
    assert.match(String(handlers[1]), /takePendingInternal/u, 'listener 2 is the conversation context lane');
    let index = 0;
    const run = async (base) => {
      if (index >= handlers.length) return base();
      const handler = handlers[index];
      index += 1;
      return handler(payload, () => run(base));
    };
    return run(next);
  };

  /** Dispatch one session event to every listener the plugin registered. */
  const fire = async (session, event) => {
    for (const handler of listenerMap.get('session/event') ?? []) await handler(session, event);
  };

  const status = async () => {
    const handler = routes.get('/assistant/status');
    assert.ok(handler !== undefined, 'status route registered');
    return new Promise((resolveStatus, rejectStatus) => {
      const res = {
        writeHead() {},
        end(body) {
          try {
            resolveStatus(JSON.parse(body));
          } catch (error) {
            rejectStatus(error);
          }
        },
      };
      Promise.resolve(handler({}, res)).catch(rejectStatus);
    });
  };

  const action = async (body) => {
    const handler = routes.get('/assistant/action');
    assert.ok(handler !== undefined, 'action route registered');
    const payload = JSON.stringify(body);
    const req = {
      method: 'POST',
      setEncoding() {},
      on(type, fn) {
        if (type === 'data') setImmediate(() => fn(payload));
        if (type === 'end') setImmediate(() => fn());
      },
    };
    return new Promise((resolveAction, rejectAction) => {
      const res = {
        writeHead() {},
        end(raw) {
          try {
            resolveAction(JSON.parse(raw));
          } catch (error) {
            rejectAction(error);
          }
        },
      };
      Promise.resolve(handler(req, res)).catch(rejectAction);
    });
  };

  return {
    root,
    ctx,
    status,
    action,
    preStep,
    fire,
    createdAgents,
    attached,
    registered,
    renamed,
    deliveries,
    sections,
    close: () => {
      for (const dispose of cleanups.reverse()) {
        try {
          dispose();
        } catch {
          /* already torn down */
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 1. The first request carries the digest; there is no separate digest turn
// ---------------------------------------------------------------------------

test('1) the first user message carries the day digest in its own request', async (t) => {
  const stamp = todayStamp();
  const { root, app } = await mountApp(t, {
    prepare: (dir) => seedDigest(dir, {
      date: stamp.date,
      digest: `【${stamp.title}】以下内容作为长期约束与背景，不需要逐条复述。\n昨天的重要记忆：\n- [chat] 用户说今天要把报告写完`,
    }),
  });

  const target = voiceSessionTarget({ root, rolloverHour: ROLLOVER_HOUR });
  const agent = agentFor(target.sessionId, root);
  const request = userMessage('帮我列一下今天的先后顺序');
  const payload = preStepPayload({ agent, turn: 1, messages: [request] });

  const startedAt = Date.now();
  const decision = await app.preStep(payload, nextFor(payload.messages));
  const elapsed = Date.now() - startedAt;

  // The user's own message is untouched and the digest rides the SAME decision: one request.
  assert.equal(decision.kind, 'enter', 'the host decision kind is preserved');
  assert.equal(decision.messages[0], request, 'the delivered request is the first message');
  const digest = decision.messages.find((message) => isRolloverDigestMessage(message));
  assert.ok(digest !== undefined, 'the first request carries the digest');
  assert.equal(digest.source.kind, ROLLOVER_DIGEST_SOURCE);
  assert.notEqual(digest.source.kind, 'user', 'the block is not a user message');
  assert.notEqual(digest.id, request.id, 'the block is not the delivery message');

  const text = digest.content[0].text;
  assert.ok(text.startsWith(ROLLOVER_DIGEST_HEADING), `starts with the label: ${text.slice(0, 40)}`);
  assert.ok(text.includes(stamp.date), 'the date is named');
  assert.ok(text.includes('昨天的重要记忆'), 'the stored digest body is carried');
  assert.ok(text.includes('用户说今天要把报告写完'), 'the memory line survives');
  assert.ok(!text.includes('以下内容作为长期约束与背景'), 'the legacy message preamble is not repeated');
  assert.ok(text.includes('不是用户发言'), 'the block says it is background, not the user');
  assert.ok(text.length <= ROLLOVER_DIGEST_MAX_CHARS, `within the cap: ${text.length}`);

  // One injected row, no degradation, with the measured duration.
  const injected = await waitForEvent(root, 'rollover.digest.injected', (row) => row.sessionId === target.sessionId);
  assert.equal(injected.chars, text.length);
  assert.equal(injected.version, stamp.date);
  assert.ok(Number.isInteger(injected.ms) && injected.ms >= 0, 'the injection duration is recorded');
  assert.equal((await readEvents(root)).filter((row) => row.type === 'rollover.digest.degraded').length, 0);

  // No separate digest turn: exactly one followup, and it is the user's own request.
  const sent = [];
  const delivered = await deliverVoiceRequest({
    resultPromise: { busy: false },
    session: { created: true, agent: { followup: (message) => sent.push(message) } },
    sessionId: target.sessionId,
    request,
    log: eventLog(),
    speakLine: async () => {},
  });
  assert.equal(delivered, true);
  assert.equal(sent.length, 1, 'exactly one followup: the request itself');
  assert.equal(sent[0].id, request.id);
  assert.equal(
    sent.some((message) => JSON.stringify(message).includes(ROLLOVER_DIGEST_HEADING)),
    false,
    'no digest message is ever delivered as a turn',
  );

  t.diagnostic(`first request: user+digest in one decision (${elapsed}ms), followups=1, `
    + `digest=${text.length} chars, version=${injected.version}, ms=${injected.ms}`);
});

// ---------------------------------------------------------------------------
// 2. Never written to memory; never triggers a waiting line or speech
// ---------------------------------------------------------------------------

test('2) the injected digest is not recorded and triggers no ack / TTS / typed speech', async (t) => {
  const stamp = todayStamp();
  const { root, app } = await mountApp(t, {
    prepare: (dir) => seedDigest(dir, {
      date: stamp.date,
      digest: `【${stamp.title}】以下内容作为长期约束与背景，不需要逐条复述。\n昨天的重要记忆：\n- [chat] 用户昨天说想养一只猫`,
    }),
  });

  const target = voiceSessionTarget({ root, rolloverHour: ROLLOVER_HOUR });
  const request = userMessage('我们随便聊聊');
  const payload = preStepPayload({
    agent: agentFor(target.sessionId, root), turn: 1, messages: [request],
  });
  const decision = await app.preStep(payload, nextFor(payload.messages));
  const digest = decision.messages.find((message) => isRolloverDigestMessage(message));
  assert.ok(digest !== undefined, 'the digest is injected once');

  // The real waiting-line observer: the block must not begin a turn, the user's own message does.
  const ackCalls = [];
  const observer = createSpeechTurnObserver({
    nonverbalCue: { noteSession() {}, noteUserText() {} },
    currentTurnBySession: new Map(),
    ackWarmTurns: { start: () => false, end: () => false },
    logAckWarmTurn() {},
    logAckSkip() {},
    autoMemoryScope: () => 'in-scope',
    ackLane: { beginTurn: (info) => ackCalls.push(info), cancelSuperseded() {} },
    stopSpeechForUserInput() {},
    noteAckWarmActivity() {},
  });
  const session = { id: target.sessionId, header: { cwd: join(root, 'workspace') } };
  observer(session, { type: 'user/message', time: Date.now(), data: { ...digest, turn: 1 } });
  assert.equal(ackCalls.length, 0, 'the block never triggers 候音');
  observer(session, { type: 'user/message', time: Date.now(), data: { ...request, turn: 1 } });
  assert.equal(ackCalls.length, 1, 'control: a genuine user message does trigger it');

  // Host recorder: the injected message is logged and its turn ends exactly as in a real run.
  const before = (await app.status()).memory.usage.records;
  await app.fire(session, { type: 'user/message', time: Date.now(), data: { ...digest, turn: 1 } });
  await sleep(40);
  const afterDigest = (await app.status()).memory.usage.records;
  assert.equal(afterDigest, before, 'the digest never becomes a memory record');
  assert.equal(
    (await readEvents(root)).filter((event) => event.type === 'memory.auto').length,
    0,
    'the auto recorder skipped the block',
  );

  // No speech lane reacted: no TTS/speech event and no ack trigger (warm-turn bookkeeping is the
  // only voice event a bare turn/end can produce, and it is not a waiting line).
  await app.fire(session, { type: 'turn/end', time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } });
  await sleep(80);
  const events = await readEvents(root);
  const reacting = events.filter((event) => {
    const type = String(event.type);
    if (type.startsWith('tts.') || type.startsWith('speech.')) return true;
    return type.startsWith('voice.') && !type.startsWith('voice.ack.warm.');
  });
  assert.deepEqual(reacting, [], 'no waiting line, TTS or typed speech event is caused by the block');

  // Positive control: the user's own next message IS recorded, so the check above is meaningful.
  await app.fire(session, { type: 'user/message', time: Date.now(), data: { ...request, turn: 2 } });
  await sleep(120);
  const afterUser = (await app.status()).memory.usage.records;
  assert.equal(afterUser, before + 1, 'control: the user message is recorded');

  t.diagnostic(`digest → records ${before}→${afterDigest}, ack begin calls=0 (control=1), `
    + `reacting events=${reacting.length}, control records=${afterUser}`);
});

// ---------------------------------------------------------------------------
// 3. Retries and later turns never append a second copy
// ---------------------------------------------------------------------------

test('3) a retry, a later turn or a reloaded lane never injects the digest twice', async (t) => {
  const stamp = todayStamp();
  const { root, app } = await mountApp(t, {
    prepare: (dir) => seedDigest(dir, {
      date: stamp.date,
      digest: `【${stamp.title}】以下内容作为长期约束与背景，不需要逐条复述。\n昨天的重要记忆：\n- [chat] 只注入一次的背景`,
    }),
  });

  const target = voiceSessionTarget({ root, rolloverHour: ROLLOVER_HOUR });
  const agent = agentFor(target.sessionId, root);
  const count = (decision) => decision.messages.filter((message) => isRolloverDigestMessage(message)).length;

  // First request → injected.
  const first = userMessage('第一句请求');
  const firstPayload = preStepPayload({ agent, turn: 1, messages: [first] });
  const firstDecision = await app.preStep(firstPayload, nextFor(firstPayload.messages));
  assert.equal(count(firstDecision), 1, 'the first request carries it');

  // The loop retries the same first step (same turn, same claimed message) → no second copy.
  const retry = await app.preStep(firstPayload, nextFor(firstPayload.messages));
  assert.equal(count(retry), 0, 'a retry of the same request appends nothing');

  // The next turn of the same session → still nothing.
  const second = userMessage('第二句请求');
  const secondPayload = preStepPayload({ agent, turn: 2, messages: [second] });
  const secondDecision = await app.preStep(secondPayload, nextFor(secondPayload.messages));
  assert.equal(count(secondDecision), 0, 'a later turn appends nothing');

  const events = await readEvents(root);
  assert.equal(events.filter((row) => row.type === 'rollover.digest.injected').length, 1,
    'exactly one injected row for the whole session');
  const duplicate = events.filter((row) => row.type === 'rollover.digest.skipped'
    && row.payload.reason === 'duplicate');
  assert.equal(duplicate.length, 2, 'both repeats are reported as duplicates');
  assert.equal(duplicate[0].payload.version, stamp.date);

  // The key is persisted, so a reloaded lane (new instance, same file) starts deduped.
  await sleep(120);
  const state = await readJson(root, 'memory-state.json');
  assert.deepEqual(state.digestInjected, [`${target.sessionId}\u0000${stamp.date}`]);
  const reloaded = createRolloverDigest({
    log: eventLog(),
    readDayDigest: () => ({ date: stamp.date, digest: '任意内容' }),
    today: todayStamp,
    isTarget: (sessionId) => sessionId === target.sessionId,
    injected: new Set(state.digestInjected),
  });
  assert.equal(
    reloaded.take({ agent, sessionId: target.sessionId }),
    null,
    'a lane rebuilt from the persisted keys injects nothing',
  );

  t.diagnostic(`injected rows=1, skipped-duplicate=2, persisted="${state.digestInjected[0]}", reload → null`);
});

// ---------------------------------------------------------------------------
// 4. Only the target assistant session; subagents and other sessions are refused
// ---------------------------------------------------------------------------

test('4) a subagent or a non-target session is never injected', async (t) => {
  const stamp = todayStamp();
  const { root, app } = await mountApp(t, {
    prepare: (dir) => seedDigest(dir, {
      date: stamp.date,
      digest: `【${stamp.title}】以下内容作为长期约束与背景，不需要逐条复述。\n昨天的重要记忆：\n- [chat] 只给目标会话`,
    }),
  });

  const target = voiceSessionTarget({ root, rolloverHour: ROLLOVER_HOUR });
  const hasDigest = (decision) => decision.messages.some((message) => isRolloverDigestMessage(message));

  // Delegated child that happens to carry the target id: the subagent marker wins.
  const childAgent = agentFor(target.sessionId, root, { origin: 'subagent' });
  const childRequest = userMessage('子代理自己的请求');
  const childPayload = preStepPayload({ agent: childAgent, turn: 1, messages: [childRequest] });
  const childDecision = await app.preStep(childPayload, nextFor(childPayload.messages));
  assert.equal(hasDigest(childDecision), false, 'a subagent never receives the digest');

  // A normal assistant session that is not today's dated voice session.
  const otherAgent = agentFor('session-elsewhere', root);
  const otherRequest = userMessage('别的会话');
  const otherPayload = preStepPayload({ agent: otherAgent, turn: 1, messages: [otherRequest] });
  const otherDecision = await app.preStep(otherPayload, nextFor(otherPayload.messages));
  assert.equal(hasDigest(otherDecision), false, 'a non-target session never receives the digest');

  const events = await readEvents(root);
  const skipped = events.filter((row) => row.type === 'rollover.digest.skipped').map((row) => row.payload);
  assert.ok(skipped.some((row) => row.reason === 'subagent' && row.sessionId === target.sessionId));
  assert.ok(skipped.some((row) => row.reason === 'non-target-session' && row.sessionId === 'session-elsewhere'));
  assert.equal(events.filter((row) => row.type === 'rollover.digest.injected').length, 0,
    'nothing was injected anywhere');
  assert.equal(events.filter((row) => row.type === 'rollover.digest.degraded').length, 0);

  t.diagnostic(`subagent→skipped, other→skipped; injected=0, skipped=${JSON.stringify(skipped.map((row) => row.reason))}`);
});

// ---------------------------------------------------------------------------
// 5. Unready digest: degrade immediately, the first request is never blocked
// ---------------------------------------------------------------------------

test('5a) a stale digest is used as-is and labelled, immediately', async (t) => {
  const stamp = todayStamp();
  const yesterday = new Date(Date.now() - 2 * 86_400_000);
  const staleDate = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
  // Only yesterday's digest exists; today's generation has not run yet.
  const { root, app } = await mountApp(t, {
    prepare: (dir) => seedDigest(dir, {
      date: staleDate,
      digest: `【${staleDate}】以下内容作为长期约束与背景，不需要逐条复述。\n昨天的重要记忆：\n- [chat] 前一天的摘要内容`,
      // The day itself is marked as rolled over: only the digest came too early to exist.
      lastRollover: stamp.date,
    }),
  });

  const target = voiceSessionTarget({ root, rolloverHour: ROLLOVER_HOUR });
  const request = userMessage('今天还没生成摘要，先聊吧');
  const payload = preStepPayload({ agent: agentFor(target.sessionId, root), turn: 1, messages: [request] });

  const startedAt = Date.now();
  const decision = await app.preStep(payload, nextFor(payload.messages));
  const elapsed = Date.now() - startedAt;
  const digest = decision.messages.find((message) => isRolloverDigestMessage(message));
  assert.ok(digest !== undefined, 'the stale summary still reaches the request');
  const text = digest.content[0].text;
  assert.ok(text.includes('今日摘要尚未生成'), 'the block says the summary is not ready');
  assert.ok(text.includes(staleDate), 'the reused summary keeps its own date');
  assert.ok(text.includes('前一天的摘要内容'), 'the available summary is used');

  const degraded = await waitForEvent(root, 'rollover.digest.degraded', (row) => row.sessionId === target.sessionId);
  assert.equal(degraded.reason, 'stale');
  assert.equal(degraded.chars, text.length);
  assert.equal((await readEvents(root)).filter((row) => row.type === 'rollover.digest.injected').length, 0);

  assert.ok(elapsed < INJECTION_TIME_LIMIT_MS,
    `the first request stayed fast: ${elapsed}ms < ${INJECTION_TIME_LIMIT_MS}ms`);
  t.diagnostic(`stale → degraded reason=${degraded.reason} chars=${degraded.chars} elapsed=${elapsed}ms`);
});

test('5b) no digest at all degrades to a bounded fallback immediately', async (t) => {
  const stamp = todayStamp();
  // Generation never ran and there is no previous summary; only the bookkeeping mark exists.
  const { root, app } = await mountApp(t, {
    prepare: (dir) => writeJson(dir, 'memory-state.json', { lastRollover: stamp.date }),
  });

  const target = voiceSessionTarget({ root, rolloverHour: ROLLOVER_HOUR });
  const request = userMessage('完全没有摘要的时候');
  const payload = preStepPayload({ agent: agentFor(target.sessionId, root), turn: 1, messages: [request] });

  const startedAt = Date.now();
  const decision = await app.preStep(payload, nextFor(payload.messages));
  const elapsed = Date.now() - startedAt;
  const digest = decision.messages.find((message) => isRolloverDigestMessage(message));
  assert.ok(digest !== undefined, 'a bounded placeholder is injected, never a wait');
  const text = digest.content[0].text;
  assert.ok(text.includes(ROLLOVER_DIGEST_HEADING) && text.includes(stamp.date), 'the label and date are present');
  assert.ok(text.includes('今日摘要尚未生成'), 'the missing state is stated');
  assert.ok(text.includes('不要编造'), 'the block forbids inventing yesterday');
  assert.ok(text.length < 300, `the fallback is bounded: ${text.length} chars`);

  const degraded = await waitForEvent(root, 'rollover.digest.degraded', (row) => row.sessionId === target.sessionId);
  assert.equal(degraded.reason, 'missing');
  assert.equal(degraded.chars, text.length);
  assert.ok(elapsed < INJECTION_TIME_LIMIT_MS,
    `the first request stayed fast: ${elapsed}ms < ${INJECTION_TIME_LIMIT_MS}ms`);
  t.diagnostic(`missing → degraded reason=${degraded.reason} chars=${degraded.chars} elapsed=${elapsed}ms`);
});

test('5c) an oversized digest is cut at the explicit cap and reported as degraded', async (t) => {
  const stamp = todayStamp();
  const body = `昨天的重要记忆：\n${'- [chat] '.concat('很长的摘要内容'.repeat(400))}`;
  const { root, app } = await mountApp(t, {
    prepare: (dir) => seedDigest(dir, {
      date: stamp.date,
      digest: `【${stamp.title}】以下内容作为长期约束与背景，不需要逐条复述。\n${body}`,
    }),
  });

  const target = voiceSessionTarget({ root, rolloverHour: ROLLOVER_HOUR });
  const request = userMessage('摘要超长时也要有上限');
  const payload = preStepPayload({ agent: agentFor(target.sessionId, root), turn: 1, messages: [request] });
  const decision = await app.preStep(payload, nextFor(payload.messages));
  const digest = decision.messages.find((message) => isRolloverDigestMessage(message));
  assert.ok(digest !== undefined);
  const text = digest.content[0].text;
  assert.ok(text.length <= ROLLOVER_DIGEST_MAX_CHARS,
    `the injected block respects ${ROLLOVER_DIGEST_MAX_CHARS} chars: ${text.length}`);
  assert.ok(text.endsWith('…'), 'the tail is cut, the heading is kept');
  assert.ok(text.includes('已截断'), 'the block says it was truncated');

  const degraded = await waitForEvent(root, 'rollover.digest.degraded', (row) => row.sessionId === target.sessionId);
  assert.equal(degraded.reason, 'truncated');
  t.diagnostic(`oversized → ${degraded.chars} chars (cap ${ROLLOVER_DIGEST_MAX_CHARS}), reason=${degraded.reason}`);
});

// The digest decision itself is synchronous: no generation and no await in the request path.
test('5d) the digest decision never generates or awaits', (t) => {
  const log = eventLog();
  const lane = createRolloverDigest({
    log,
    readDayDigest: () => null,
    today: todayStamp,
    isTarget: () => true,
  });
  const startedAt = Date.now();
  const message = lane.take({ agent: { session: { id: 'target', header: {} } }, sessionId: 'target' });
  const elapsed = Date.now() - startedAt;
  assert.ok(message !== null, 'a bounded placeholder is returned');
  assert.ok(elapsed < DIGEST_DECISION_TIME_LIMIT_MS, `decision took ${elapsed}ms`);
  assert.equal(log.events.filter((event) => event.type === 'rollover.digest.degraded').length, 1);
  assert.equal(typeof log.events[0].payload.ms, 'number', 'the duration is part of the event');
  t.diagnostic(`missing digest decision: ${elapsed}ms, chars=${message.content[0].text.length}`);
});

// ---------------------------------------------------------------------------
// 6. Every original rollover duty still exists
// ---------------------------------------------------------------------------

test('6) the rollover flow keeps every original initialization duty', async (t) => {
  // No seeded digest and no lastRollover: the boot check generates today's digest itself.
  const { root, app } = await mountApp(t);
  const stamp = todayStamp();

  // 1. Background generation writes today's digest and records `session.rollover`.
  const rollover = await waitForEvent(root, 'session.rollover', (row) => row.date === stamp.date);
  assert.equal(rollover.mode, 'prompt');
  assert.ok(rollover.chars > 0, 'the generated digest is non-empty');
  const stored = (await readJson(root, 'settings.json')).dayDigest;
  assert.equal(stored.date, stamp.date, 'today\'s digest is stored');
  assert.ok(String(stored.digest).startsWith(`【${stamp.title}】`), 'it leads with the day stamp');

  // 2. The dated target and its title stamp are unchanged.
  const target = voiceSessionTarget({ root, rolloverHour: ROLLOVER_HOUR });
  assert.equal(target.sessionId, `seirein-${stamp.date}`);
  assert.equal(resolve(target.cwd), resolve(join(root, 'workspace')));
  assert.equal(target.title, stamp.title);

  // 3. Session creation still pins the title, binds the workspace and reports the sandbox step.
  const session = await ensureSession({
    sessionId: target.sessionId,
    cwd: target.cwd,
    title: target.title,
    workspaceId: 'ws-rollover-digest',
    ownerCtx: app.ctx,
    getService: app.ctx.get,
    scopePath: join(root, 'workspace'),
    log: eventLog(),
  });
  assert.equal(session.ok, true);
  assert.equal(session.created, true, 'the dated session is created on first use');
  assert.equal(session.title, stamp.title, 'the day-stamp title is pinned');
  assert.deepEqual(app.renamed, [stamp.title], 'the title service was asked for the stamp');
  assert.deepEqual(app.attached, [target.sessionId], 'the session is attached to the workspace');
  assert.equal(resolve(app.createdAgents[0].meta.cwd), resolve(target.cwd));
  assert.equal(session.sandbox?.skipped, 'switch-unavailable', 'the sandbox step still runs and reports');

  // 4. `rollover.force` still rebuilds the digest and clears the pending mark.
  const forced = await app.action({ action: 'rollover.force' });
  assert.equal(forced.ok, true);
  assert.equal(forced.date, stamp.date);
  assert.equal(forced.sessionId, target.sessionId);
  assert.equal(forced.title, stamp.title);
  assert.ok(forced.chars > 0);
  assert.equal((await readJson(root, 'settings.json')).pendingRollover, null);
  assert.equal((await readJson(root, 'memory-state.json')).lastRollover, stamp.date);

  // 5. The self-check still reports the digest it can inject, and the injection is wired to the
  //    conversation pre-step (the same `agent/pre-step` lane the continuation context uses).
  const source = await readFile(new URL('../src/host/index.js', import.meta.url), 'utf8');
  assert.ok(/digest: todaysDigest\(\),/u.test(source), 'voice.session.ready reports digest readiness');
  assert.ok(/get rolloverDigest\(\) \{ return rolloverDigest; \}/u.test(source),
    'the digest lane is wired into the conversation pre-step');
  assert.equal(/\bdigestMessage\b/u.test(source), false, 'no digest message is built or delivered any more');

  t.diagnostic(`rollover duties: generation=${rollover.chars} chars, title="${session.title}", `
    + `created=${session.created}, attached=${app.attached.length}, force=${forced.ok}, `
    + `sandbox=${session.sandbox?.skipped}`);
});
