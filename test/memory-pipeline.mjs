/**
 * Memory pipeline regression: one voice turn must (1) be titled with the day stamp, (2) record a
 * `voice.session.ready` self-check, and (3) inject only *relevant* memories in front of the
 * utterance, while an out-of-scope session neither retrieves nor writes anything.
 *
 * Runs against throwaway temp roots with a fake ctx; no DSH needed.
 *
 * Run: node --test test/memory-pipeline.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  announceVoiceSessionReady,
  apply,
  ASSISTANT_MEMORY_SOURCE,
  createMemoryPreStep,
  MEMORY_INJECTION_HEADING,
  publishVoiceInjected,
  voiceSessionReady,
  voiceSessionTarget,
} from '../src/host/index.js';
import { ensureSession } from '../src/host/session/delivery/dispatch.js';
import { MemoryStore } from '../src/host/memory/store.js';

/** In-memory stand-in for `data/events.jsonl`. */
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

/** One genuine user message, the shape `agent/pre-step` claims and the harness logs. */
function userMessage(text, id = `u-${Math.random().toString(36).slice(2)}`) {
  return { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] };
}

/** The fused payload the loop dispatches to `agent/pre-step`. */
function preStepPayload({ agent, turn = 1, step = 1, messages = [], signal = null }) {
  return {
    agent,
    turn,
    step,
    signal: signal ?? new AbortController().signal,
    messages,
  };
}

/** The decision the host's own waterfall callback would produce, untouched by the plugin. */
const enterDecision = (messages) => async () => ({ kind: 'enter', messages: [...messages] });

/**
 * Fake agentLoop + sessionTitle + workspaceRegistry. `titleState.current` mirrors the folded
 * title the real service would read back, so create/resume/repair paths are exercised exactly
 * as the live host exercises them.
 */
function sessionHarness({ root, withTitleService = true, titleState = { current: undefined } }) {
  const created = [];
  const resumed = [];
  const renamed = [];
  const attached = [];
  let persisted = false;
  const attachSession = async (sessionId) => {
    attached.push(sessionId);
  };
  const agentFor = (sessionId) => ({
    id: sessionId,
    session: { id: sessionId, header: { cwd: join(root, 'workspace') } },
  });
  const agentLoop = {
    async resume(_ctx, options) {
      if (!persisted) throw new Error('not persisted yet');
      resumed.push(options);
      return { agent: agentFor(options.resumeSessionId) };
    },
    async createAgent(_ctx, options) {
      created.push(options);
      persisted = true;
      return { agent: agentFor(options.sessionId) };
    },
  };
  const sessionTitle = {
    get() {
      return titleState.current;
    },
    rename(_session, value) {
      renamed.push(value);
      titleState.current = { title: value, source: { kind: 'user' } };
      return titleState.current;
    },
  };
  const services = {
    agentLoop,
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
    workspaceRegistry: {
      async create(path) {
        return { id: 'ws-fixed', path };
      },
      get() {
        return { id: 'ws-fixed', attachSession };
      },
    },
  };
  if (withTitleService) services.sessionTitle = sessionTitle;
  const ctx = { get: (name) => services[name] };
  return { ctx, getService: ctx.get, created, resumed, renamed, attached, titleState, services };
}

/** Mount the plugin against `root` and expose its tools plus the status route. */
function mount(root) {
  const tools = new Map();
  const routes = new Map();
  const cleanups = [];
  const effect = (fn) => {
    const value = fn();
    if (typeof value === 'function') cleanups.push(value);
    return value;
  };
  const ctx = {
    effect,
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    inject: (_deps, register) => {
      register({
        effect,
        systemPrompt: { section: () => () => {} },
        webServer: {
          register(route) {
            routes.set(route.path, route.handler);
            return () => routes.delete(route.path);
          },
        },
      });
    },
  };
  apply(ctx, { root, enabled: true });
  const call = async (toolName, args = {}, exec = {}) => {
    const tool = tools.get(toolName);
    assert.ok(tool !== undefined, `tool registered: ${toolName}`);
    return tool.execute(args, exec);
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
  return {
    call,
    status,
    close: () => {
      for (const fn of cleanups.reverse()) fn();
    },
  };
}

test('the voice session is pinned to the day-stamp title on create and repaired on resume', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-pipeline-title-'));
  t.after(() => rm(root, { recursive: true, force: true }).catch(() => {}));
  const target = voiceSessionTarget({ root });
  assert.match(target.title, /^\d{4}-\d{2}-\d{2} 周[一二三四五六日]$/u, 'the target carries the day stamp title');

  const harness = sessionHarness({ root });
  const created = await ensureSession({
    sessionId: target.sessionId,
    cwd: target.cwd,
    title: target.title,
    workspaceId: 'ws-fixed',
    ownerCtx: harness.ctx,
    getService: harness.getService,
  });
  assert.equal(created.ok, true);
  assert.equal(created.created, true);
  assert.equal(created.title, target.title, 'the created session carries the date title');
  assert.equal(created.titleChanged, true, 'the title was written, not merely reported');
  assert.deepEqual(harness.renamed, [target.title], 'the title service rename() pinned the date stamp');
  assert.equal(harness.attached.length, 1, 'the workspace attach still happens');

  // A model-generated title from an earlier run (what the live session actually shows) is repaired.
  harness.titleState.current = { title: 'dsh-assistant 项目背景约束', source: { kind: 'provider' } };
  const repaired = await ensureSession({
    sessionId: target.sessionId,
    cwd: target.cwd,
    title: target.title,
    workspaceId: 'ws-fixed',
    ownerCtx: harness.ctx,
    getService: harness.getService,
  });
  assert.equal(repaired.resumed, true);
  assert.equal(repaired.title, target.title);
  assert.equal(repaired.titleChanged, true);
  assert.deepEqual(harness.renamed, [target.title, target.title]);

  // An already-correct title is left alone: a plain resume must not append another title event.
  const stable = await ensureSession({
    sessionId: target.sessionId,
    cwd: target.cwd,
    title: target.title,
    workspaceId: 'ws-fixed',
    ownerCtx: harness.ctx,
    getService: harness.getService,
  });
  assert.equal(stable.titleChanged, false);
  assert.equal(harness.renamed.length, 2);

  // A deliberate user rename is never overwritten by the automatic repair.
  harness.titleState.current = { title: '我自己的会话名', source: { kind: 'user' } };
  const kept = await ensureSession({
    sessionId: target.sessionId,
    cwd: target.cwd,
    title: target.title,
    workspaceId: 'ws-fixed',
    ownerCtx: harness.ctx,
    getService: harness.getService,
  });
  assert.equal(kept.title, '我自己的会话名');
  assert.equal(kept.titleChanged, false);
  assert.equal(harness.renamed.length, 2, 'the user rename was respected');

  // Without the title service the turn still runs; the title is reported as unknown, not faked.
  const bare = sessionHarness({ root, withTitleService: false });
  const noService = await ensureSession({
    sessionId: target.sessionId,
    cwd: target.cwd,
    title: target.title,
    ownerCtx: bare.ctx,
    getService: bare.getService,
  });
  assert.equal(noService.ok, true);
  assert.equal(noService.title, '');
  assert.ok(noService.titleError.length > 0, 'the missing title service is reported, not silently invented');
});

test('voice.session.ready reports persona, fixed memory, digest and record count', async () => {
  const payload = voiceSessionReady({
    sessionId: 'seirein-2026-11-04',
    title: '2026-11-04 周三',
    cwd: 'D:\\Projects\\dsh-assistant\\workspace',
    personaText: '## 你的设定\n你是妹系角色。',
    fixedMemory: [{ id: 'a', text: '长期约束' }],
    digest: '【2026-11-04 周三】昨天的重要记忆：…',
    memoryRecords: 2,
  });
  assert.deepEqual(payload, {
    sessionId: 'seirein-2026-11-04',
    title: '2026-11-04 周三',
    cwd: 'D:\\Projects\\dsh-assistant\\workspace',
    hasPersona: true,
    hasFixedMemory: true,
    digestInjected: true,
    memoryRecords: 2,
  });

  const bare = voiceSessionReady({});
  assert.deepEqual(bare, {
    sessionId: '',
    title: '',
    cwd: '',
    hasPersona: false,
    hasFixedMemory: false,
    digestInjected: false,
    memoryRecords: 0,
  });

  // One event per distinct session state: a plain resume is not re-logged, a real change is.
  const log = eventLog();
  const seen = new Map();
  const fields = {
    sessionId: payload.sessionId,
    title: payload.title,
    cwd: payload.cwd,
    personaText: '你是妹系角色。',
    fixedMemory: [],
    digest: '',
    memoryRecords: 2,
  };
  await announceVoiceSessionReady({ log, seen, ...fields });
  await announceVoiceSessionReady({ log, seen, ...fields });
  const readyEvents = () => log.events.filter((event) => event.type === 'voice.session.ready');
  assert.equal(readyEvents().length, 1, 'the same session state is logged once');
  await announceVoiceSessionReady({ log, seen, ...fields, digest: '【2026-11-04 周三】新的摘要' });
  assert.equal(readyEvents().length, 2, 'a changed digest is logged');
  assert.equal(readyEvents()[1].payload.digestInjected, true);
});

test('a relevant memory is appended by C2 before the request and logged', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-pipeline-hit-'));
  const memory = new MemoryStore(root);
  t.after(async () => {
    memory.close();
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });
  memory.add('chat', '我们约好每周三一起看动画', 'preference');

  const log = eventLog();
  let recalls = 0;
  const realRecall = memory.recall.bind(memory);
  memory.recall = (options) => {
    recalls += 1;
    return realRecall(options);
  };

  // 语音不再注入，改由 C2：记忆在 agent/pre-step 追加，用户原话保持原样。
  const prep = createMemoryPreStep({ memory, log, inScope: () => true, featureEnabled: () => true });
  const agent = {
    id: 'voice-agent',
    session: { id: 'seirein-2026-11-04', header: { cwd: join(root, 'workspace') } },
  };
  const utterance = '这周三一起看动画好吗';
  const original = userMessage(utterance);
  const payload = preStepPayload({ agent, messages: [original] });
  const result = await prep.handle(payload, enterDecision(payload.messages));

  assert.equal(recalls, 1, 'C2 retrieval runs once at the pre-step');
  assert.equal(result.messages.length, 2, 'exactly one message is appended');
  const injected = result.messages.at(-1);
  assert.equal(injected.role, 'user');
  assert.equal(injected.source.kind, ASSISTANT_MEMORY_SOURCE, 'the block carries the assistant-memory marker');
  assert.notEqual(injected.id, original.id, 'the block is not the delivery message');
  const body = injected.content[0].text;
  assert.ok(body.startsWith(MEMORY_INJECTION_HEADING), 'the block starts with the C2 heading');
  assert.match(body, /每周三一起看动画/, 'the hit text reaches the injected block');
  assert.equal(result.messages[0], original, 'the original message object is kept');
  assert.equal(original.content[0].text, utterance, 'the user\'s own words are not rewritten');

  const events = log.events.filter((event) => event.type === 'memory.recall');
  assert.equal(events.length, 1, 'memory.recall is recorded');
  assert.equal(events[0].payload.query, utterance, 'the query is the user\'s own words');
  assert.ok(events[0].payload.hits > 0);
  assert.equal(events[0].payload.injected, true);
  assert.equal(events[0].payload.sessionId, 'seirein-2026-11-04');

  // The original join contract: `voice.injected` reuses exactly this same turn's recall payload
  // (never the voice lane's old fixed {hits:0}), so the two events cannot contradict each other.
  const joinLog = eventLog();
  await publishVoiceInjected({
    log: joinLog,
    row: { deliveryMessageId: 'm-hit' },
    turn: events[0].payload.turn,
    seen: events[0].payload,
  });
  const joined = joinLog.events[0].payload;
  assert.equal(joined.turn, events[0].payload.turn, 'the join is published under the recall turn');
  assert.equal(joined.memoryHits, events[0].payload.hits, 'memoryHits mirrors memory.recall.hits');
  assert.equal(joined.memoryInjected, events[0].payload.injected, 'memoryInjected mirrors memory.recall.injected');
  assert.equal(joined.deliveryMessageId, 'm-hit', 'the delivery join key rides along');

  // Nothing matched: C2 appends a short status message, never a hit, and the user text is intact.
  const missLog = log;
  const missUtterance = '量子退相干的物理图像是什么';
  const missOriginal = userMessage(missUtterance);
  const missPayload = preStepPayload({ agent, turn: 2, messages: [missOriginal] });
  const missResult = await prep.handle(missPayload, enterDecision(missPayload.messages));
  assert.equal(missResult.messages.length, 2, 'a miss still reports that a search happened');
  const status = missResult.messages.at(-1);
  assert.equal(status.source.kind, ASSISTANT_MEMORY_SOURCE);
  assert.ok(status.content[0].text.startsWith('## 记忆检索状态'));
  assert.equal(missOriginal.content[0].text, missUtterance, 'the miss leaves the user text unchanged');
  const missEvents = missLog.events.filter((event) => event.type === 'memory.recall');
  assert.equal(missEvents.length, 2);
  assert.equal(missEvents[1].payload.injected, false);
  assert.equal(missEvents[1].payload.hits, 0);
});

test('out of scope or disabled: no retrieval, no injection, no memory write', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-pipeline-scope-'));
  const memory = new MemoryStore(root);
  t.after(async () => {
    memory.close();
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });
  memory.add('chat', '我们约好每周三一起看动画', 'preference');

  let recalls = 0;
  const realRecall = memory.recall.bind(memory);
  memory.recall = (options) => {
    recalls += 1;
    return realRecall(options);
  };
  const seenLog = eventLog();
  const agent = { id: 'scope-agent', session: { id: 'session-elsewhere', header: { cwd: join(root, 'elsewhere') } } };
  const utterance = userMessage('这周三一起看动画好吗');
  // 语音不再注入，改由 C2：out-of-scope 的 pre-step 不查询、不追加、不记录。
  const outOfScopePayload = preStepPayload({ agent, turn: 1, messages: [utterance] });
  const outOfScope = await createMemoryPreStep({ memory, log: seenLog, inScope: () => false })
    .handle(outOfScopePayload, enterDecision(outOfScopePayload.messages));
  assert.equal(outOfScope.messages.length, 1, 'out of scope appends nothing');
  assert.equal(outOfScope.messages[0], utterance, 'the original message is returned untouched');
  assert.equal(recalls, 0, 'an out-of-scope session never even queries the memory table');
  assert.equal(seenLog.events.length, 0, 'no memory.recall event outside the scope');

  const disabledPayload = preStepPayload({ agent, turn: 2, messages: [userMessage('这周三一起看动画好吗')] });
  const disabled = await createMemoryPreStep({
    memory, log: seenLog, inScope: () => true, featureEnabled: () => false,
  }).handle(disabledPayload, enterDecision(disabledPayload.messages));
  assert.equal(disabled.messages.length, 1, 'a disabled memory lane appends nothing');
  assert.equal(recalls, 0);
  assert.equal(seenLog.events.length, 0);

  // The tool layer agrees: the voice session cwd is in scope, any other workspace is refused.
  const app = mount(root);
  t.after(() => app.close());
  const before = (await app.status()).memory.usage;
  const elsewhere = await app.call('assistant_remember', { text: '默认工作区里的一句话' }, {
    agent: { session: { header: { cwd: resolve(process.cwd()) } } },
  });
  assert.equal(elsewhere.ok, false);
  assert.equal(elsewhere.error, '当前工作区不在 Seirein 作用域内');
  assert.equal((await app.status()).memory.usage.records, before.records, 'a refused write changes nothing');

  const inScope = await app.call('assistant_remember', { text: '语音会话里值得长期记住的一件事' }, {
    agent: { session: { header: { cwd: join(root, 'workspace') } } },
  });
  assert.ok(typeof inScope.id === 'string' && inScope.id.length > 0, 'the voice session cwd passes the scope gate');
  assert.equal((await app.status()).memory.usage.records, before.records + 1, 'the memory table grew by one record');
});

test('the voice delivery path wires the ready event, the C2 pre-step and the date title', async () => {
  const source = await readFile(new URL('../src/host/index.js', import.meta.url), 'utf8');
  assert.ok(/title: target\.title,/u.test(source), 'ensureSession receives the day-stamp title');
  assert.ok(/announceVoiceSessionReady\(\{/u.test(source), 'the session self-check is emitted');
  assert.ok(/'voice\.session\.ready'/u.test(source) || /log\.emit\('voice\.session\.ready'/u.test(source));
  assert.ok(/memoryRecords: memory\.usage\(\)\.records,/u.test(source), 'the ready event reports the memory table size');
  assert.ok(/digest: todaysDigest\(\),/u.test(source), 'the ready event reports whether the day digest is injected');
  // 语音不再注入，改由 C2：the injector lives at agent/pre-step, not in the voice lane.
  assert.ok(/const memoryPreStep = createMemoryPreStep\(\{/u.test(source), 'C2 builds the pre-step injector');
  // The registered handler must delegate to that injector with the waterfall's own payload/next.
  // It is wrapped (the fault notice is appended after it) and async now, so assert the delegation
  // itself instead of the old one-line arrow shape.
  assert.ok(
    /ctx\.on\('agent\/pre-step',[\s\S]{0,600}?memoryPreStep\.handle\(payload, next\)/u.test(source),
    'C2 is wired to agent/pre-step',
  );
  assert.ok(/inScope: \(agent\) => inWorkspaceScope\(\{ agent \}\)/u.test(source), 'the C2 recall obeys the workspace scope');
  assert.ok(/recall: \{ text: '', hits: 0, injected: false \}/u.test(source), 'the voice lane reports an empty recall');
  assert.ok(
    !/if \(recall\.injected\) request\.content\[0\]\.text =/u.test(source),
    'the voice lane never prefixes a memory block to the transcript',
  );
  assert.ok(!/await recallVoiceMemory\(/u.test(source), 'the voice lane no longer calls the legacy recall helper');
  // Behaviour, not a source shape: the voice lane's own publisher is called once and its emitted
  // `voice.injected` fields are inspected. A real recall carries its integer/boolean, an
  // unobserved recall is null/null, and a malformed value is never published.
  const join = async (seen, turn = 7) => {
    const joinLog = eventLog();
    await publishVoiceInjected({ log: joinLog, row: { deliveryMessageId: 'msg-1' }, turn, seen });
    return joinLog.events.filter((event) => event.type === 'voice.injected').at(-1)?.payload;
  };
  const hit = await join({ hits: 4, injected: true });
  assert.equal(hit.deliveryMessageId, 'msg-1', 'voice.injected carries the delivery join key');
  assert.equal(hit.turn, 7, 'the recall is joined under the same turn');
  assert.equal(hit.memoryHits, 4, 'a real recall publishes its safe-integer hit count');
  assert.equal(hit.memoryInjected, true, 'a real recall publishes its boolean injected flag');
  const miss = await join(null);
  assert.equal(miss.memoryHits, null, 'no observed recall stays null, never 0');
  assert.equal(miss.memoryInjected, null, 'no observed recall stays null, never false');
  for (const hits of ['4', Number.NaN, 4.5, Number.POSITIVE_INFINITY, undefined]) {
    const malformed = await join({ hits, injected: true });
    assert.equal(malformed.memoryHits, null, `a malformed hit count (${String(hits)}) is never published`);
  }
  for (const injected of ['true', 1, 0, null, undefined]) {
    const malformed = await join({ hits: 4, injected });
    assert.equal(malformed.memoryInjected, null, `a non-boolean injected flag (${String(injected)}) is never published`);
  }
  assert.ok(/deliveryMessageId: request\.id,/u.test(source), 'voice.injected carries the delivery join key');
  // The memory convention names the writing tool, so the habit is not left to inference.
  assert.ok(
    /值得长期保留的事实[^\n]*assistant_remember/u.test(source),
    'the prompt names assistant_remember for durable facts',
  );
  const dispatch = await readFile(new URL('../src/host/session/delivery/dispatch.js', import.meta.url), 'utf8');
  assert.ok(/sessionTitle/u.test(dispatch), 'dispatch pins the title through the title service');
  assert.ok(/pinnedByUser/u.test(dispatch), 'a deliberate user rename is respected');
});
