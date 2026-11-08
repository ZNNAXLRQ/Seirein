/**
 * P0 regression: Seirein's dated voice agent mounts compaction in its OWN scope.
 *
 * These tests use a fake Host that mirrors the shipped contracts the wiring depends on, not the
 * real Harness:
 *  - `agentPresets.mount(agentCtx, id)` binds the Agent scope to a retained preset revision;
 *  - the preset's plugins register scoped `agent/pre-step` listeners and a scoped `/compact`
 *    command, visible only to Agents bound to that preset;
 *  - `composedPreset`/`serviceFor` read the binding back (the success evidence), while
 *    `presetForSession` only reads the recorded marker.
 *
 * The fake compaction backend is deliberately minimal (threshold -> summarize head -> shorter
 * surface) so the suite proves the WIRING: exactly one instance, one trigger, scoped command and
 * a request-token drop. Real compaction semantics live in `@deepseek-ai/dsh-compaction-basic` and
 * are covered by its own package tests.
 *
 * Run: node --test test/voice-compaction.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  VOICE_COMPACTION_PRESET,
  VOICE_COMPACTION_PRESET_ID,
  createVoiceCompaction,
  dailyAgentMeta,
  isVoiceSessionId,
} from '../src/host/session/compaction/voice-compaction.js';
import { apply } from '../src/host/index.js';
import { cleanupRoot } from './helpers/cleanup.mjs';

/** Four characters per token, like the shipped heuristic. */
function createMeter() {
  const count = (message) => Math.ceil((typeof message?.text === 'string' ? message.text.length : 0) / 4);
  return { count, measure: (messages) => messages.reduce((sum, message) => sum + count(message), 0) };
}

function createMessage(text) {
  return { role: 'user', text };
}

/** One fake Host: preset registry, scoped event bus, scoped command registry, live Agent list. */
function createHost({ definitions = { [VOICE_COMPACTION_PRESET_ID]: VOICE_COMPACTION_PRESET } } = {}) {
  const declared = new Map(Object.entries(definitions));
  const meter = createMeter();
  const mounts = [];
  const bindings = new Map(); // agent -> binding
  const scopeParents = new Map(); // agent scope key -> preset scope key
  const listeners = []; // { scope, type, handler }
  const commands = new Map(); // scope -> Map(name -> handler)
  const createdListeners = [];
  const liveAgents = [];
  const events = [];
  const cleanups = [];

  const log = { emit: (type, payload) => { events.push({ type, payload }); return Promise.resolve(); } };
  const chainOf = (key) => {
    const chain = [];
    for (let cursor = key; cursor !== undefined; cursor = scopeParents.get(cursor)) chain.push(cursor);
    return chain;
  };
  const admitted = (scope, agent) => chainOf(agent.ctx.key).includes(scope);

  const listen = (scope, type, handler) => {
    const entry = { scope, type, handler };
    listeners.push(entry);
    return () => {
      const index = listeners.indexOf(entry);
      if (index >= 0) listeners.splice(index, 1);
    };
  };
  const registerCommand = (scope, name, handler) => {
    const layer = commands.get(scope) ?? new Map();
    commands.set(scope, layer);
    layer.set(name, handler);
    return () => {
      layer.delete(name);
      if (layer.size === 0) commands.delete(scope);
    };
  };

  /** Minimal compaction backend: threshold -> summarize the head, keep the newest tail verbatim. */
  function createCompactionEngine(agent) {
    const policy = { thresholdTokens: 1200, retainTokens: 200 };
    let runs = 0;
    let summaryCalls = 0;
    const measure = () => meter.measure(agent.session.messages);
    const compact = async () => {
      const messages = agent.session.messages;
      const before = measure();
      let keep = 0;
      let kept = 0;
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const size = meter.count(messages[index]);
        if (kept + size > policy.retainTokens && keep > 0) break;
        kept += size;
        keep += 1;
      }
      const head = messages.slice(0, messages.length - keep);
      if (head.length === 0) return null;
      runs += 1;
      summaryCalls += 1;
      const summary = createMessage(`<compacted-summary>${head.map((message) => message.text).join(' ').slice(0, 40)}</compacted-summary>`);
      agent.session.messages = [summary, ...messages.slice(messages.length - keep)];
      agent.session.compactions.push({ shadowed: head.length, before, after: measure() });
      return { shadowedSeqs: head, summarySeq: 0 };
    };
    return {
      get runs() { return runs; },
      get summaryCalls() { return summaryCalls; },
      thresholdTokens: policy.thresholdTokens,
      measure,
      compactNow: compact,
      async preStep(payload, next) {
        if (meter.measure(payload.agent.session.messages) > policy.thresholdTokens) await compact();
        return next();
      },
    };
  }

  function disposeBinding(agent) {
    const binding = bindings.get(agent);
    if (binding === undefined) return;
    for (const off of binding.disposers) off();
    bindings.delete(agent);
    scopeParents.delete(agent.ctx.key);
  }

  function mountPreset(agentCtx, presetId) {
    const definition = declared.get(presetId);
    if (definition === undefined) {
      throw Object.assign(new Error(`Unknown agent preset: ${presetId}`), { code: 'agent-preset/not-found' });
    }
    const agent = agentCtx?.agent;
    if (agent === undefined) throw new Error('mount requires an Agent context');
    mounts.push({ agentId: agent.id, presetId });
    const existing = bindings.get(agent);
    if (existing?.presetId === presetId) return { id: presetId };
    if (existing !== undefined) disposeBinding(agent);

    const scope = { presetId, agentId: agent.id };
    scopeParents.set(agent.ctx.key, scope);
    const binding = { presetId, scope, disposers: [], services: new Map() };
    const group = definition.plugins.find((row) => row.id === 'compaction');
    if (group !== undefined && group.group === true) {
      const engine = createCompactionEngine(agent);
      binding.services.set('compaction', engine);
      for (const row of group.config) {
        if (row.id === 'compaction-basic') {
          binding.disposers.push(listen(scope, 'agent/pre-step', (payload, next) => engine.preStep(payload, next)));
        } else if (row.id === 'command-compact') {
          binding.disposers.push(registerCommand(scope, 'compact', () => engine.compactNow()));
        } else if (row.id === 'tool-result-pruner') {
          binding.services.set('toolResultPruner', { config: row.config });
        }
      }
    }
    bindings.set(agent, binding);
    return { id: presetId };
  }

  const agentPresets = {
    async mount(agentCtx, presetId) { return mountPreset(agentCtx, presetId); },
    async resolve(presetId) {
      const wanted = presetId ?? VOICE_COMPACTION_PRESET_ID;
      if (!declared.has(wanted)) {
        throw Object.assign(new Error(`Unknown agent preset: ${wanted}`), { code: 'agent-preset/not-found' });
      }
      return { id: wanted };
    },
    composedPreset(agentCtx) { return bindings.get(agentCtx?.agent)?.presetId; },
    serviceFor(agent, name) { return bindings.get(agent)?.services.get(name); },
    presetForSession(session) { return session?.agentPresetRecorded ?? null; },
  };

  const getService = (name) => ({ agentPresets, agents: { list: () => liveAgents.slice() } })[name];

  function createAgent(sessionId) {
    const session = {
      id: sessionId,
      messages: [],
      compactions: [],
      agentPresetRecorded: null,
      append(type, data) {
        if (type === 'agent-preset/selected') this.agentPresetRecorded = data.agentPreset;
      },
    };
    const agent = { id: sessionId, session };
    agent.ctx = { key: {}, agent };
    liveAgents.push(agent);
    return agent;
  }

  async function announce(agent, source = 'startup') {
    for (const entry of createdListeners.slice()) await entry.handler({ agent, source });
  }

  async function createAndAnnounce(sessionId, options = {}) {
    const agent = createAgent(sessionId);
    await announce(agent, options.source ?? 'startup');
    return agent;
  }

  const ctx = {
    get: getService,
    on(type, handler) {
      const entry = { type, handler };
      createdListeners.push(entry);
      return () => {
        const index = createdListeners.indexOf(entry);
        if (index >= 0) createdListeners.splice(index, 1);
      };
    },
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === 'function') cleanups.push(dispose);
      return dispose;
    },
  };

  const listenersFor = (agent, type) => listeners.filter((entry) => entry.type === type && admitted(entry.scope, agent));
  const commandFor = (agent, name) => {
    for (const key of chainOf(agent.ctx.key)) {
      const handler = commands.get(key)?.get(name);
      if (handler !== undefined) return handler;
    }
    return undefined;
  };
  const compactionFor = (agent) => agentPresets.serviceFor(agent, 'compaction');

  async function emit(agent, type, payload = {}) {
    const handlers = listenersFor(agent, type).map((entry) => entry.handler);
    let index = 0;
    const next = async () => {
      const handler = handlers[index];
      index += 1;
      return handler === undefined ? undefined : handler({ ...payload, agent }, next);
    };
    return next();
  }

  return {
    meter, log, events, mounts, liveAgents, ctx, agentPresets,
    createAgent, createAndAnnounce, announce, emit,
    listenersFor, commandFor, compactionFor, getService, cleanups,
    listenerCount: (agent, type) => listenersFor(agent, type).length,
    commandCount: (agent, name) => (commandFor(agent, name) === undefined ? 0 : 1),
  };
}

/** 20 x 800-char messages = 4000 fake tokens, far above the fake 1200-token threshold. */
function fillHistory(agent) {
  for (let index = 0; index < 20; index += 1) agent.session.messages.push(createMessage(String(index).repeat(800)));
}

test('1. setup mounts the preset once, and a repeated setup adds no second instance', async () => {
  const host = createHost();
  const helper = createVoiceCompaction({ getService: host.getService, log: host.log });
  const agent = host.createAgent('seirein-2026-11-08');

  const first = await helper.setup(agent.ctx, agent);
  assert.equal(first.ok, true, 'setup reports a verified mount');
  assert.equal(first.presetId, VOICE_COMPACTION_PRESET_ID);
  assert.equal(first.reused, false);
  assert.equal(host.mounts.length, 1, 'exactly one mount call');
  assert.equal(host.listenerCount(agent, 'agent/pre-step'), 1, 'exactly one compaction listener');
  assert.equal(host.commandCount(agent, 'compact'), 1, 'exactly one scoped /compact registration');

  const second = await helper.setup(agent.ctx, agent);
  assert.deepEqual(second, first, 'the second setup returns the same evidence');
  assert.equal(host.mounts.length, 1, 'no second mount call');
  assert.equal(host.listenerCount(agent, 'agent/pre-step'), 1, 'no second compaction listener');
});

test('2. success evidence is mount + composedPreset + realm service, not the recorded marker', async () => {
  const host = createHost();
  const helper = createVoiceCompaction({ getService: host.getService, log: host.log });
  const agent = host.createAgent('seirein-2026-11-08');

  const record = await helper.setup(agent.ctx, agent);
  assert.equal(record.ok, true);
  assert.equal(record.composed, VOICE_COMPACTION_PRESET_ID, 'registry reads the bound preset back');
  assert.equal(record.service, true);
  assert.ok(host.compactionFor(agent) !== undefined, 'the compaction service exists in the Agent realm');
  assert.equal(host.listenerCount(agent, 'agent/pre-step'), 1);
  assert.equal(agent.session.agentPresetRecorded, VOICE_COMPACTION_PRESET_ID, 'the marker is recorded too');

  // The marker is NOT the proof: erase it and the mount/service/listener evidence still stands.
  agent.session.agentPresetRecorded = null;
  assert.equal(host.listenerCount(agent, 'agent/pre-step'), 1);
  assert.equal(host.compactionFor(agent) !== undefined, true);

  // The daily-agent header marker is written only when the declaration resolves.
  assert.deepEqual(dailyAgentMeta({ cwd: 'C:/s/workspace', presetReady: true }), {
    cwd: 'C:/s/workspace',
    agentPreset: VOICE_COMPACTION_PRESET_ID,
  });
  assert.deepEqual(dailyAgentMeta({ cwd: 'C:/s/workspace', presetReady: false }), { cwd: 'C:/s/workspace' });

  // The daily-agent create options couple the marker to the verified setup: driving them mounts.
  const daily = helper.dailyCreateOptions({
    sessionId: 'seirein-2026-11-11',
    cwd: 'C:/s/workspace',
    presetReady: true,
  });
  assert.equal(daily.sessionId, 'seirein-2026-11-11');
  assert.equal(daily.meta.agentPreset, VOICE_COMPACTION_PRESET_ID);
  const dailyAgent = host.createAgent(daily.sessionId);
  const dailyRecord = await daily.setup(dailyAgent.ctx, dailyAgent);
  assert.equal(dailyRecord.ok, true);
  assert.equal(dailyRecord.service, true);
  assert.equal(host.mounts.length, 2, 'the daily create path mounts through its own setup');
  assert.equal(host.listenerCount(dailyAgent, 'agent/pre-step'), 1);
  assert.equal(dailyAgent.session.agentPresetRecorded, VOICE_COMPACTION_PRESET_ID);

  const mountedEvent = host.events.find((event) => event.type === 'voice.compaction.mounted');
  assert.ok(mountedEvent !== undefined, 'the mount is observable');
  assert.equal(mountedEvent.payload.service, true);
});

test('3. new, resumed and reload-swept Agents all bind; a reload adds no second instance', async () => {
  const host = createHost();
  const firstRun = createVoiceCompaction({ getService: host.getService, log: host.log });
  firstRun.attach(host.ctx);

  const fresh = await host.createAndAnnounce('seirein-2026-11-08');
  assert.equal(host.listenerCount(fresh, 'agent/pre-step'), 1, 'new Agent: bound before its first step');
  assert.equal(host.mounts.length, 1);

  const resumed = await host.createAndAnnounce('seirein-2026-11-09', { source: 'resume' });
  assert.equal(host.listenerCount(resumed, 'agent/pre-step'), 1, 'resumed Agent: bound by agent/created');
  assert.equal(host.mounts.length, 2);

  // Component reload: a NEW plugin instance sweeps the live Agents it did not create.
  const secondRun = createVoiceCompaction({ getService: host.getService, log: host.log });
  secondRun.attach(host.ctx);
  assert.equal(host.mounts.length, 2, 'already-bound Agents are verified/reused, never remounted');
  assert.equal(host.listenerCount(fresh, 'agent/pre-step'), 1);
  assert.equal(host.listenerCount(resumed, 'agent/pre-step'), 1);
  assert.equal(secondRun.evidenceOf(fresh).reused, true, 'the sweep reports reuse');

  // A second announcement of the same Agent must not create another listener either.
  await host.announce(fresh, 'resume');
  assert.equal(host.listenerCount(fresh, 'agent/pre-step'), 1);
  assert.equal(host.mounts.length, 2);
});

test('4. Seirein scope: a pre-step over threshold compacts exactly once; other Agents are untouched', async () => {
  const host = createHost();
  const helper = createVoiceCompaction({ getService: host.getService, log: host.log });
  const agent = host.createAgent('seirein-2026-11-08');
  fillHistory(agent);
  await helper.setup(agent.ctx, agent);

  const engine = host.compactionFor(agent);
  assert.ok(engine !== undefined);
  assert.ok(engine.measure() > engine.thresholdTokens, 'history starts above the threshold');

  await host.emit(agent, 'agent/pre-step');
  assert.equal(engine.runs, 1, 'one condensation call');
  assert.equal(engine.summaryCalls, 1);
  assert.ok(engine.measure() < engine.thresholdTokens, 'the surface now sits below the threshold');
  console.log(`[4] pre-step: ${engine.measure()} tokens after 1 condensation; runs=${engine.runs}; listener=${host.listenerCount(agent, 'agent/pre-step')}`);

  // The second step is below pressure: the same listener must not summarize again.
  await host.emit(agent, 'agent/pre-step');
  assert.equal(engine.runs, 1, 'no duplicate summarization on the next step');
  assert.equal(engine.summaryCalls, 1);
  assert.equal(host.listenerCount(agent, 'agent/pre-step'), 1);

  // A non-Seirein Agent receives no listener and no mount.
  const other = host.createAgent('session-2faa7245');
  const skipped = await helper.ensure(other);
  assert.equal(skipped.ok, false);
  assert.equal(skipped.reason, 'not-voice-session');
  assert.equal(host.listenerCount(other, 'agent/pre-step'), 0);
  assert.equal(host.mounts.length, 1);
});

test('5. /compact is registered in the Seirein scope only, and runs the same backend', async () => {
  const host = createHost({
    definitions: {
      [VOICE_COMPACTION_PRESET_ID]: VOICE_COMPACTION_PRESET,
      standard: { id: 'standard', plugins: [] },
    },
  });
  const helper = createVoiceCompaction({ getService: host.getService, log: host.log });
  const agent = host.createAgent('seirein-2026-11-08');
  fillHistory(agent);
  await helper.setup(agent.ctx, agent);

  const engine = host.compactionFor(agent);
  const compact = host.commandFor(agent, 'compact');
  assert.equal(typeof compact, 'function', 'the command is visible to the bound Agent');
  const before = engine.measure();
  await compact();
  assert.equal(engine.runs, 1, 'the command drives the same compaction engine');
  assert.ok(engine.measure() < before);

  // A non-Seirein Agent has neither the command nor a new instance.
  const other = host.createAgent('session-2faa7245');
  assert.equal(host.commandFor(other, 'compact'), undefined);
  assert.equal(host.listenerCount(other, 'agent/pre-step'), 0);

  // A Seirein-dated Agent already composed by another preset is left alone.
  const busy = host.createAgent('seirein-2026-11-10');
  host.agentPresets.mount(busy.ctx, 'standard');
  const skipped = await helper.ensure(busy);
  assert.equal(skipped.ok, false);
  assert.equal(skipped.reason, 'other-preset');
  assert.equal(host.mounts.filter((mount) => mount.agentId === busy.id).length, 1, 'no second mount for the Agent');
});

test('6. compaction lowers the measured request size', async () => {
  const host = createHost();
  const helper = createVoiceCompaction({ getService: host.getService, log: host.log });
  const agent = host.createAgent('seirein-2026-11-08');
  fillHistory(agent);
  await helper.setup(agent.ctx, agent);

  const engine = host.compactionFor(agent);
  const before = engine.measure();
  const result = await host.commandFor(agent, 'compact')();
  const after = engine.measure();
  assert.ok(result !== null, 'a compactable span exists');
  assert.ok(after < before, `request tokens drop (${before} -> ${after})`);
  console.log(`[6] request tokens ${before} -> ${after} (shadowed=${agent.session.compactions[0].shadowed})`);
  assert.equal(agent.session.compactions.length, 1);
  assert.deepEqual(agent.session.compactions[0].before, before);
  assert.deepEqual(agent.session.compactions[0].after, after);
});

test('7. no declared preset: the voice agent keeps running and reports an actionable skip', async () => {
  const host = createHost({ definitions: {} });
  const helper = createVoiceCompaction({ getService: host.getService, log: host.log });
  const agent = host.createAgent('seirein-2026-11-08');

  const record = await helper.setup(agent.ctx, agent);
  assert.equal(record.ok, false);
  assert.equal(record.reason, 'preset-missing');
  assert.equal(host.mounts.length, 0, 'nothing was mounted');
  assert.equal(host.listenerCount(agent, 'agent/pre-step'), 0);
  assert.equal(await helper.presetReady(), false);
  const skipped = host.events.find((event) => event.type === 'voice.compaction.skipped');
  assert.equal(skipped.payload.reason, 'preset-missing');
});

test('8. apply() installs the binding for real voice Agents through agent/created', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-voice-compaction-'));
  const disposers = [];
  t.after(() => cleanupRoot(root, disposers));

  const host = createHost();
  const handlers = new Map();
  const effect = (fn) => {
    const dispose = fn();
    if (typeof dispose === 'function') disposers.push(dispose);
    return dispose;
  };
  const ctx = {
    effect,
    on(type, handler) {
      const list = handlers.get(type) ?? [];
      list.push(handler);
      handlers.set(type, list);
      return () => {
        const index = list.indexOf(handler);
        if (index >= 0) list.splice(index, 1);
      };
    },
    tools: { register: () => () => {} },
    get: host.getService,
    inject: (deps, register) => {
      if (deps.includes('workspaceRegistry')) {
        register({ effect, get: host.getService, workspaceRegistry: { async create() { return { id: 'ws' }; } } });
      } else if (deps.includes('systemPrompt')) {
        register({ effect, systemPrompt: { section: () => () => {} } });
      }
    },
    webServer: { register: () => () => {} },
  };
  apply(ctx, { root, enabled: true });

  const created = handlers.get('agent/created') ?? [];
  assert.ok(created.length >= 1, 'apply registers the agent/created binding');
  const agent = host.createAgent('seirein-2026-11-08');
  for (const handler of created) await handler({ agent, source: 'startup' });
  assert.equal(host.mounts.length, 1, 'a newly announced voice Agent is bound by apply()');
  assert.equal(host.listenerCount(agent, 'agent/pre-step'), 1);

  // The identity predicate is what keeps other Sessions out of Seirein's scope.
  assert.equal(isVoiceSessionId('seirein-2026-11-08'), true);
  assert.equal(isVoiceSessionId('session-2faa7245'), false);
  assert.equal(isVoiceSessionId('seirein-notes'), false);
});
