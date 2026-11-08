/**
 * P0 regression: Seirein's dated voice agent mounts compaction in its OWN scope.
 *
 * These tests use a fake Host that mirrors the shipped contracts the wiring depends on, not the
 * real Harness:
 *  - the shipped `initializeAgent` awaits `setup(agent.ctx, agent)` and then runs
 *    `setupCommit?.commit()`, so a valid setup returns void or `{ commit() }` — never a state object;
 *  - `agentPresets.mount(agentCtx, id)` binds the Agent scope to a retained preset revision;
 *  - `agentPresets.register(definition)` installs the plugin-owned declaration, and a duplicate id
 *    is rejected (the real registry throws `Duplicate agent preset: <id>`);
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
  VOICE_COMPACTION_STILL_NEAR_LIMIT_ACTION,
  assessVoiceCompactionPreset,
  createVoiceCompaction,
  isVoiceSessionId,
} from '../src/host/session/compaction/voice-compaction.js';
import { apply } from '../src/host/index.js';
import { ensureSession } from '../src/host/session/delivery/dispatch.js';
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
function createHost({
  definitions = { [VOICE_COMPACTION_PRESET_ID]: VOICE_COMPACTION_PRESET },
  registerError = null,
  mountError = null,
} = {}) {
  const declared = new Map(Object.entries(definitions));
  let registerCalls = 0;
  let mountAttempts = 0;
  const meter = createMeter();
  const mounts = [];
  const bindings = new Map(); // agent -> binding
  const scopeParents = new Map(); // agent scope key -> preset scope key
  const listeners = []; // { scope, type, handler }
  const commands = new Map(); // scope -> Map(name -> handler)
  const createdListeners = [];
  const liveAgents = [];
  const liveById = new Map();
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
    mountAttempts += 1;
    const record = declared.get(presetId);
    if (record === undefined) {
      throw Object.assign(new Error(`Unknown agent preset: ${presetId}`), { code: 'agent-preset/not-found' });
    }
    if (mountError !== null) throw mountError;
    // The shipped registry stores `{ config, context, ready }`: mount reads the config, never the
    // wrapper. The fake accepts both shapes so a test can exercise the real record shape.
    const definition = record.config !== null && typeof record.config === 'object'
      && !Array.isArray(record.config) && record.plugins === undefined
      ? record.config
      : record;
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
    // Mirrors the shipped registry's own definition map: a same-id declaration is readable
    // without an audit, so a plugin can reuse it instead of calling register().
    definitions: declared,
    async register(definition) {
      registerCalls += 1;
      if (registerError !== null) throw registerError;
      if (declared.has(definition.id)) throw new Error(`Duplicate agent preset: ${definition.id}`);
      // The fake marks plugin-installed declarations, like the plugin's own provenance record.
      declared.set(definition.id, { ...definition, source: 'registered' });
      return async () => { declared.delete(definition.id); };
    },
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

  // The Harness services the dispatch entry reads. `agentLoop` is installed by a test that drives
  // the real `ensureSession` path; `agents.get` is the live-Agent lookup (`ownerCtx.get`).
  const services = {
    agentPresets,
    agents: {
      list: () => liveAgents.slice(),
      get: (id) => liveById.get(id),
    },
    // The same contract the recovery path uses: `measure(session)` -> tokens (number or object).
    tokenMeter: { measure: (session) => ({ totalTokens: meter.measure(session?.messages ?? []) }) },
  };
  const getService = (name) => services[name];

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
    liveById.set(sessionId, agent);
    return agent;
  }

  async function announce(agent, source = 'startup') {
    for (const entry of createdListeners.filter((item) => item.type === 'agent/created').slice()) {
      await entry.handler({ agent, source });
    }
  }

  /** Deliver one durable session event to host-level `session/event` listeners (as DSH does). */
  function sessionEmit(session, event) {
    for (const entry of createdListeners.filter((item) => item.type === 'session/event').slice()) {
      entry.handler(session, event);
    }
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
    meter, log, events, mounts, liveAgents, services, ctx, agentPresets, declared,
    get registerCalls() { return registerCalls; },
    get mountAttempts() { return mountAttempts; },
    createAgent, createAndAnnounce, announce, emit, sessionEmit,
    listenersFor, commandFor, compactionFor, getService, cleanups,
    listenerCount: (agent, type) => listenersFor(agent, type).length,
    commandCount: (agent, name) => (commandFor(agent, name) === undefined ? 0 : 1),
    createdCount: () => createdListeners.filter((item) => item.type === 'agent/created').length,
  };
}

/**
 * Fake Harness loop for the REAL delivery entry (`dispatch.js#ensureSession`).
 *
 * It mirrors the shipped ordering (`@deepseek-ai/dsh-agent-loop/lib/index.js#initializeAgent`):
 * the session enters the store, optional setup runs, the Agent enters the registry, and only then
 * are the serial `agent/created` listeners awaited before the handle resolves. `source` is
 * `startup` for create and `resume` for resume (`createAgent`/`resumeWith` pass their own source).
 * A still-live Agent is reused as-is on the second delivery: the real loop refuses a second
 * resume/create for the same id, and `ensureSession` falls back to `agents.get(sessionId)`.
 */
function createDispatchLoop(host) {
  const state = { persisted: false, creates: [], resumes: [], announces: [] };

  const announce = async (agent, source) => {
    state.announces.push({ agentId: agent.id, source });
    await host.announce(agent, source);
  };

  const agentLoop = {
    async resume(_ownerCtx, options) {
      state.resumes.push(options);
      if (!state.persisted) throw new Error('not persisted yet');
      const live = host.getService('agents').get(options.resumeSessionId);
      // A live Agent is reused without a new announcement/realm.
      if (live !== undefined) return { agent: live };
      const agent = host.createAgent(options.resumeSessionId);
      await announce(agent, 'resume');
      return { agent };
    },
    async createAgent(_ownerCtx, options) {
      state.creates.push(options);
      const agent = host.createAgent(options.sessionId);
      await announce(agent, 'startup');
      state.persisted = true;
      return { agent };
    },
  };
  const ownerCtx = { get: (name) => host.getService(name) };
  host.services.agentLoop = agentLoop;
  return { state, agentLoop, ownerCtx };
}

/** Drive the real delivery entry for one session. */
async function deliverTo(host, loop, sessionId) {
  return await ensureSession({
    sessionId,
    cwd: '',
    ownerCtx: loop.ownerCtx,
    getService: host.getService,
    log: host.log,
  });
}

/** 20 x 800-char messages = 4000 fake tokens, far above the fake 1200-token threshold. */
function fillHistory(agent) {
  for (let index = 0; index < 20; index += 1) agent.session.messages.push(createMessage(String(index).repeat(800)));
}

/**
 * The shipped `initializeAgent` consumption of an Agent setup callback, verbatim:
 * `const setupCommit = await setup(agent.ctx, agent); setupCommit?.commit();`.
 * A void result and a `{ commit() }` handle are the only legal shapes; returning a state object
 * makes the optional call throw `setupCommit?.commit is not a function` and the creation fails.
 */
async function consumeSetupLikeHost(setup, agent) {
  const setupCommit = await setup(agent.ctx, agent);
  assert.doesNotThrow(() => setupCommit?.commit(), 'the host commit call must not throw');
  return setupCommit;
}

/** The shipped creation order: construct, await setup + commit, then announce `agent/created`. */
async function createLikeHost(host, helper, sessionId, source = 'startup') {
  const agent = host.createAgent(sessionId);
  const setupCommit = await consumeSetupLikeHost(helper.setup, agent);
  await host.announce(agent, source);
  return { agent, setupCommit };
}

test('1. setup mounts the preset once, and a repeated setup adds no second instance', async () => {
  const host = createHost();
  const helper = createVoiceCompaction({ getService: host.getService, log: host.log });
  const agent = host.createAgent('seirein-2026-11-08');

  const first = await consumeSetupLikeHost(helper.setup, agent);
  assert.equal(first, undefined, 'AgentSetup resolves void: the mount is already applied');
  const record = helper.evidenceOf(agent);
  assert.equal(record.ok, true, 'setup reports a verified mount through evidence');
  assert.equal(record.presetId, VOICE_COMPACTION_PRESET_ID);
  assert.equal(record.reused, false);
  assert.equal(record.presetSource, 'profile', 'the pre-existing declaration is reused');
  assert.equal(host.registerCalls, 0, 'an existing declaration is never registered again');
  assert.equal(helper.presetStatus().status, 'reused');
  assert.equal(helper.presetStatus().source, 'profile');
  assert.equal(host.mounts.length, 1, 'exactly one mount call');
  assert.equal(host.listenerCount(agent, 'agent/pre-step'), 1, 'exactly one compaction listener');
  assert.equal(host.commandCount(agent, 'compact'), 1, 'exactly one scoped /compact registration');

  const second = await consumeSetupLikeHost(helper.setup, agent);
  assert.equal(second, undefined, 'a repeated setup is still void');
  assert.equal(helper.evidenceOf(agent), record, 'the second setup returns the same evidence');
  assert.equal(host.mounts.length, 1, 'no second mount call');
  assert.equal(host.listenerCount(agent, 'agent/pre-step'), 1, 'no second compaction listener');
});

test('2. success evidence is mount + composedPreset + realm service, not the recorded marker', async () => {
  const host = createHost();
  const helper = createVoiceCompaction({ getService: host.getService, log: host.log });
  const agent = host.createAgent('seirein-2026-11-08');

  await consumeSetupLikeHost(helper.setup, agent);
  const record = helper.evidenceOf(agent);
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

  // The dead `ensureDailyAgent` path and its marker-only helper were removed; the header marker
  // is never evidence here — only the mount/service/listener facts above.
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
  // The reload sweep is deliberately asynchronous (it never blocks mount); let it settle.
  await new Promise((resolve) => setImmediate(resolve));
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

test('7. a registration failure is logged once, fails open, and leaves the voice agent running', async () => {
  const host = createHost({ definitions: {}, registerError: new Error('preset registry offline') });
  const helper = createVoiceCompaction({ getService: host.getService, log: host.log });
  helper.attach(host.ctx);
  const agent = host.createAgent('seirein-2026-11-08');

  const setupCommit = await consumeSetupLikeHost(helper.setup, agent);
  assert.equal(setupCommit, undefined, 'a failed registration still resolves the setup callback void');
  assert.equal(host.registerCalls, 1, 'the plugin tried to register the declaration once');
  assert.equal(host.mounts.length, 0, 'nothing was mounted');
  assert.equal(host.listenerCount(agent, 'agent/pre-step'), 0);
  const failed = host.events.find((event) => event.type === 'voice.compaction.preset.register-failed');
  assert.ok(failed !== undefined, 'the failure is observable');
  assert.equal(failed.payload.presetId, VOICE_COMPACTION_PRESET_ID);
  assert.match(failed.payload.error, /offline/u);
  assert.equal(helper.presetStatus().status, 'failed');
  assert.equal(helper.presetStatus().registered, false);
  const skipped = host.events.find((event) => event.type === 'voice.compaction.skipped');
  assert.equal(skipped.payload.reason, 'preset-register-failed');
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

test('9. the real dispatch entry creates the voice Agent and mounts compaction exactly once', async () => {
  const host = createHost();
  const helper = createVoiceCompaction({ getService: host.getService, log: host.log });
  // P0's only production coverage on this path: attach() registers the serial agent/created hook.
  helper.attach(host.ctx);
  const loop = createDispatchLoop(host);

  const first = await deliverTo(host, loop, 'seirein-2026-11-08');
  assert.equal(first.ok, true, 'the delivery entry resolved a live Agent');
  assert.equal(first.created, true);
  assert.equal(loop.state.resumes.length, 1, 'resume is attempted first and fails before create');
  assert.equal(loop.state.creates.length, 1);
  // The delivery path passes NO setup: the mount above can only have come from agent/created.
  assert.equal(loop.state.resumes[0].setup, undefined, 'ensureSession passes no setup on resume');
  assert.equal(loop.state.creates[0].setup, undefined, 'ensureSession passes no setup on create');
  assert.deepEqual(loop.state.announces, [{ agentId: 'seirein-2026-11-08', source: 'startup' }]);
  assert.equal(host.mounts.length, 1, 'mount called exactly once on the real entry');
  assert.equal(host.listenerCount(first.agent, 'agent/pre-step'), 1, 'the compaction listener exists');
  assert.equal(host.commandCount(first.agent, 'compact'), 1, 'the scoped command is registered');
  assert.ok(host.compactionFor(first.agent) !== undefined, 'the compaction service exists in the realm');

  // A second delivery to the same live Agent resumes/reuses it; the realm is not mounted again.
  const second = await deliverTo(host, loop, 'seirein-2026-11-08');
  assert.equal(second.ok, true);
  assert.equal(second.resumed, true);
  assert.equal(second.agent, first.agent, 'the same live Agent is reused');
  assert.equal(loop.state.announces.length, 1, 'a reused Agent is not re-announced');
  assert.equal(host.mounts.length, 1, 'no second mount for the same session');
  assert.equal(host.listenerCount(first.agent, 'agent/pre-step'), 1);
  assert.equal(host.commandCount(first.agent, 'compact'), 1);
});

test('10. a cold resume through the same dispatch entry still mounts exactly once', async () => {
  const host = createHost();
  const helper = createVoiceCompaction({ getService: host.getService, log: host.log });
  helper.attach(host.ctx);
  const loop = createDispatchLoop(host);
  // The session exists on disk but no Agent for it is live in this process: resume must announce.
  loop.state.persisted = true;

  const result = await deliverTo(host, loop, 'seirein-2026-11-09');
  assert.equal(result.ok, true);
  assert.equal(result.resumed, true);
  assert.equal(loop.state.creates.length, 0, 'resume did not fall through to create');
  assert.deepEqual(loop.state.announces, [{ agentId: 'seirein-2026-11-09', source: 'resume' }]);
  assert.equal(host.mounts.length, 1, 'a resumed voice Agent is mounted exactly once');
  assert.equal(host.listenerCount(result.agent, 'agent/pre-step'), 1);
  assert.equal(host.commandCount(result.agent, 'compact'), 1);
});

test('11. a non-Seirein Session delivered through the same entry is never mounted', async () => {
  const host = createHost();
  const helper = createVoiceCompaction({ getService: host.getService, log: host.log });
  helper.attach(host.ctx);
  const loop = createDispatchLoop(host);

  const result = await deliverTo(host, loop, 'session-2faa7245');
  assert.equal(result.ok, true);
  assert.equal(host.mounts.length, 0, 'no preset mount for a non-Seirein Session');
  assert.equal(host.listenerCount(result.agent, 'agent/pre-step'), 0);
  assert.equal(host.commandCount(result.agent, 'compact'), 0);
  assert.equal(helper.evidenceOf(result.agent), undefined);
});

test('12. host protocol with a preset: setup resolves void, creation completes, repeat stays single-instance', async () => {
  const host = createHost();
  const helper = createVoiceCompaction({ getService: host.getService, log: host.log });
  helper.attach(host.ctx);

  // The exact shipped order: construct, await setup, run `setupCommit?.commit()`, announce.
  const first = await createLikeHost(host, helper, 'seirein-2026-11-08');
  assert.equal(first.setupCommit, undefined, 'void is a legal AgentSetup result');
  assert.equal(host.mounts.length, 1, 'creation mounted the preset once');
  assert.equal(host.listenerCount(first.agent, 'agent/pre-step'), 1);
  assert.equal(host.commandCount(first.agent, 'compact'), 1);
  assert.equal(helper.evidenceOf(first.agent).ok, true, 'the composition is verified');

  // Another creation path for the same live Agent (the resume fallback) must neither throw at the
  // host commit call nor add a second listener/mount.
  const second = await consumeSetupLikeHost(helper.setup, first.agent);
  assert.equal(second, undefined);
  assert.equal(host.mounts.length, 1, 'no second mount');
  assert.equal(host.listenerCount(first.agent, 'agent/pre-step'), 1, 'no second listener');
  assert.equal(host.commandCount(first.agent, 'compact'), 1, 'no second command');
});

test('13. host protocol without a preset registry: fail-open, creation completes, setup never rejects', async () => {
  const host = createHost();
  // A build that does not mount `agentPresets` at all: registration is unavailable, not an error.
  host.services.agentPresets = undefined;
  const helper = createVoiceCompaction({ getService: host.getService, log: host.log });
  helper.attach(host.ctx);

  const created = await createLikeHost(host, helper, 'seirein-2026-11-08');
  assert.equal(created.setupCommit, undefined, 'the setup callback still resolves void');
  assert.equal(created.agent.id, 'seirein-2026-11-08', 'the Agent was still created');
  assert.equal(host.mounts.length, 0, 'no preset was mounted');
  assert.equal(host.listenerCount(created.agent, 'agent/pre-step'), 0);
  assert.equal(host.commandCount(created.agent, 'compact'), 0);

  // A broken service lookup is contained too: setup must not reject and roll creation back.
  const broken = createVoiceCompaction({
    getService: () => { throw new Error('service registry unavailable'); },
    log: host.log,
  });
  const agent = host.createAgent('seirein-2026-11-10');
  const setupCommit = await consumeSetupLikeHost(broken.setup, agent);
  assert.equal(setupCommit, undefined);
  const failed = host.events.find((event) => event.type === 'voice.compaction.failed');
  assert.equal(failed.payload.reason, 'setup');
});

test('14. no profile declaration: the plugin registers the preset, then agent/created mounts it', async () => {
  const host = createHost({ definitions: {} });
  const helper = createVoiceCompaction({ getService: host.getService, log: host.log });
  helper.attach(host.ctx);

  const agent = await host.createAndAnnounce('seirein-2026-11-08');
  assert.equal(host.registerCalls, 1, 'the plugin registered the declaration exactly once');
  const state = helper.presetStatus();
  assert.equal(state.status, 'registered');
  assert.equal(state.source, 'registered');
  assert.equal(state.registered, true);
  assert.equal(state.error, null);
  assert.equal(host.mounts.length, 1, 'the newly registered preset was mounted');
  assert.equal(host.listenerCount(agent, 'agent/pre-step'), 1, 'the compaction listener exists');
  assert.equal(host.commandCount(agent, 'compact'), 1, 'the scoped /compact command exists');
  assert.equal(helper.evidenceOf(agent).presetSource, 'registered');

  const registered = host.events.find((event) => event.type === 'voice.compaction.preset.registered');
  assert.ok(registered !== undefined, 'the registration is observable');
  assert.equal(registered.payload.source, 'registered');

  // The definition content is the compaction-only composition the profile used to carry.
  const stored = host.agentPresets.definitions.get(VOICE_COMPACTION_PRESET_ID);
  const group = stored.plugins[0];
  assert.equal(group.id, 'compaction');
  assert.equal(group.name, 'cordis:group');
  assert.equal(group.group, true);
  assert.deepEqual(group.isolate, { compaction: true, toolResultPruner: true });
  assert.deepEqual(group.config.map((row) => row.id), [
    'compaction-basic',
    'command-compact',
    'tool-result-pruner',
  ]);
  assert.deepEqual(group.config[2].config, { thresholdChars: 8192, headChars: 4096, tailChars: 1024 });
});

test('15. a leftover profile declaration is reused: zero register calls and a profile source', async () => {
  const host = createHost();
  const helper = createVoiceCompaction({ getService: host.getService, log: host.log });
  helper.attach(host.ctx);

  const agent = await host.createAndAnnounce('seirein-2026-11-08');
  assert.equal(host.registerCalls, 0, 'the existing declaration is never registered again');
  const state = helper.presetStatus();
  assert.equal(state.status, 'reused');
  assert.equal(state.source, 'profile');
  assert.equal(state.registered, false);
  assert.equal(host.mounts.length, 1, 'the reused preset still mounts for the Agent');
  assert.equal(host.listenerCount(agent, 'agent/pre-step'), 1);

  const reused = host.events.find((event) => event.type === 'voice.compaction.preset.reused');
  assert.ok(reused !== undefined, 'the reuse is observable');
  assert.equal(reused.payload.source, 'profile');
});

test('16. repeated attach (component reload) keeps registration and mount idempotent', async () => {
  const host = createHost({ definitions: {} });
  const first = createVoiceCompaction({ getService: host.getService, log: host.log });
  first.attach(host.ctx);
  const agent1 = await host.createAndAnnounce('seirein-2026-11-08');
  assert.equal(host.registerCalls, 1);

  // Component reload: a NEW plugin instance attaches while the first registration and Agent live.
  const second = createVoiceCompaction({ getService: host.getService, log: host.log });
  second.attach(host.ctx);
  const agent2 = await host.createAndAnnounce('seirein-2026-11-09');

  assert.equal(host.registerCalls, 1, 'the reload reused the existing registration');
  assert.equal(second.presetStatus().status, 'reused');
  assert.equal(second.presetStatus().source, 'registered');
  assert.equal(host.mounts.filter((mount) => mount.agentId === agent1.id).length, 1, 'agent 1 mounted once');
  assert.equal(host.mounts.filter((mount) => mount.agentId === agent2.id).length, 1, 'agent 2 mounted once');
  assert.equal(host.listenerCount(agent1, 'agent/pre-step'), 1);
  assert.equal(host.listenerCount(agent2, 'agent/pre-step'), 1);
  assert.equal(second.evidenceOf(agent1).reused, true, 'the live Agent is verified, not remounted');
});

test('17. status classifies a builtin declaration separately from a profile one', async () => {
  const host = createHost({
    definitions: { [VOICE_COMPACTION_PRESET_ID]: { ...VOICE_COMPACTION_PRESET, builtin: true } },
  });
  const helper = createVoiceCompaction({ getService: host.getService, log: host.log });
  const agent = host.createAgent('seirein-2026-11-08');

  await helper.setup(agent.ctx, agent);
  assert.equal(host.registerCalls, 0);
  assert.equal(helper.presetStatus().status, 'reused');
  assert.equal(helper.presetStatus().source, 'builtin');
});

test('18. a compatible same-id declaration is audited, reused and mounted', async () => {
  const compatible = {
    id: VOICE_COMPACTION_PRESET_ID,
    name: 'hand-written compaction only',
    plugins: [{
      id: 'compaction',
      name: 'cordis:group',
      group: true,
      isolate: { compaction: true },
      config: [
        { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
        { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
      ],
    }],
  };
  assert.equal(assessVoiceCompactionPreset(compatible).compatible, true, 'the compaction-only shape is compatible');
  const host = createHost({ definitions: { [VOICE_COMPACTION_PRESET_ID]: compatible } });
  const helper = createVoiceCompaction({ getService: host.getService, log: host.log });
  helper.attach(host.ctx);

  const agent = await host.createAndAnnounce('seirein-2026-11-08');
  assert.equal(host.registerCalls, 0, 'the compatible declaration is never registered again');
  const status = helper.presetStatus();
  assert.equal(status.status, 'reused');
  assert.equal(status.source, 'profile');
  assert.equal(status.enabled, true);
  assert.equal(status.reason, '');
  assert.equal(status.running, 1);
  assert.equal(status.mounted, 1, 'the compatibly-reused preset is mounted');
  assert.equal(status.active, 1, 'its compaction service resolves for the live Agent');
  assert.equal(status.requiresRestart, false);
  assert.equal(host.mounts.length, 1);
  assert.equal(host.listenerCount(agent, 'agent/pre-step'), 1);
  assert.equal(host.commandCount(agent, 'compact'), 1);
  assert.equal(host.events.find((event) => event.type === 'voice.compaction.preset.reused').payload.source, 'profile');
  console.log(`[18] status=${status.status} source=${status.source} enabled=${status.enabled} mounted=${status.mounted} active=${status.active} registerCalls=${host.registerCalls}`);
});

test('19. an incompatible same-id declaration is a conflict: not reused, not mounted, not overwritten', async () => {
  const incompatible = {
    id: VOICE_COMPACTION_PRESET_ID,
    name: 'accidental standard preset',
    plugins: [{
      id: 'compaction',
      name: 'cordis:group',
      group: true,
      config: [
        { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
        { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
        { id: 'fs', name: '@deepseek-ai/dsh-tool-fs' },
      ],
    }],
  };
  const audit = assessVoiceCompactionPreset(incompatible);
  assert.equal(audit.compatible, false, 'an extra fs tool makes the definition incompatible');
  assert.match(audit.reason, /fs/u);

  const host = createHost({ definitions: { [VOICE_COMPACTION_PRESET_ID]: incompatible } });
  const helper = createVoiceCompaction({ getService: host.getService, log: host.log });
  helper.attach(host.ctx);
  const agent = await host.createAndAnnounce('seirein-2026-11-08');

  assert.equal(helper.evidenceOf(agent), undefined, 'nothing was mounted for the Agent');
  assert.equal(host.mounts.length, 0);
  assert.equal(host.listenerCount(agent, 'agent/pre-step'), 0);
  assert.equal(host.commandCount(agent, 'compact'), 0);
  assert.equal(host.registerCalls, 0, 'conflict never falls through to overwrite/register');
  assert.equal(host.declared.get(VOICE_COMPACTION_PRESET_ID), incompatible, 'the user definition is untouched');

  const status = helper.presetStatus();
  assert.equal(status.status, 'conflict');
  assert.equal(status.enabled, false, 'a conflict is never reported as available');
  assert.match(status.reason, /自动压缩不可用/u);
  assert.match(status.reason, /fs/u);
  assert.equal(status.registered, false);
  assert.equal(status.mounted, 0);
  assert.equal(status.active, 0);

  const conflict = host.events.find((event) => event.type === 'voice.compaction.preset.conflict');
  assert.ok(conflict !== undefined, 'the conflict is observable');
  assert.match(conflict.payload.reason, /fs/u);
  const skipped = host.events.find((event) => event.type === 'voice.compaction.skipped');
  assert.equal(skipped.payload.reason, 'preset-conflict');
  assert.match(skipped.payload.conflict, /fs/u);
  console.log(`[19] status=${status.status} enabled=${status.enabled} mounts=${host.mounts.length} declaredIntact=${host.declared.get(VOICE_COMPACTION_PRESET_ID) === incompatible} reason=${status.reason}`);
});

test('20. register failure is degraded, not normal: enabled:false + reason, and near-limit warns', async () => {
  let clock = 1_000_000;
  const host = createHost({ definitions: {}, registerError: new Error('preset registry offline') });
  const helper = createVoiceCompaction({
    getService: host.getService,
    log: host.log,
    windowTokens: 1000,
    now: () => clock,
  });
  helper.attach(host.ctx);
  const agent = host.createAgent('seirein-2026-11-08');
  fillHistory(agent);
  await consumeSetupLikeHost(helper.setup, agent);
  assert.equal(host.mounts.length, 0, 'fail-open: no compression mounted');

  const expected = host.meter.measure(agent.session.messages);
  const first = helper.presetStatus();
  assert.equal(first.status, 'failed');
  assert.equal(first.enabled, false, 'fail-open must not look like a working compressor');
  assert.match(first.reason, /自动压缩不可用/u);
  assert.match(first.reason, /offline/u);
  assert.equal(first.nearLimit, true, `${expected} tokens against a 1000-token window is near the limit`);
  assert.equal(first['near-limit'], true);
  assert.equal(first.pressure.windowTokens, 1000);
  assert.equal(first.pressure.tokens, expected);
  assert.ok(first.pressure.ratio > 0.8);

  const nearLimit = () => host.events.filter((event) => event.type === 'voice.compaction.near-limit');
  assert.equal(nearLimit().length, 1, 'the pressure warning is written');
  assert.equal(nearLimit()[0].payload.sessionId, 'seirein-2026-11-08');
  helper.presetStatus();
  assert.equal(nearLimit().length, 1, 'repeated samples are throttled');
  clock += 60_000;
  helper.presetStatus();
  assert.equal(nearLimit().length, 2, 'a sample past the throttle reports again');
  console.log(`[20] status=${first.status} enabled=${first.enabled} near-limit=${first['near-limit']} tokens=${first.pressure.tokens}/${first.pressure.windowTokens} events=${nearLimit().length} reason=${first.reason}`);
});

test('21. normal pressure raises no warning', async () => {
  const host = createHost();
  const helper = createVoiceCompaction({ getService: host.getService, log: host.log, windowTokens: 100_000 });
  helper.attach(host.ctx);
  const agent = host.createAgent('seirein-2026-11-08');
  fillHistory(agent);
  await consumeSetupLikeHost(helper.setup, agent);

  const status = helper.presetStatus();
  assert.equal(status.nearLimit, false);
  assert.equal(status['near-limit'], false);
  assert.equal(status.enabled, true);
  assert.equal(status.mounted, 1);
  assert.equal(status.active, 1);
  assert.equal(host.events.filter((event) => event.type === 'voice.compaction.near-limit').length, 0);
  console.log(`[21] near-limit=${status['near-limit']} tokens=${status.pressure.tokens}/${status.pressure.windowTokens} ratio=${status.pressure.ratio} events=0`);
});

test('22. detach unregisters only the definition this instance registered; reused survives', async () => {
  // Own registration: attach -> detach removes exactly our definition.
  const own = createHost({ definitions: {} });
  const owner = createVoiceCompaction({ getService: own.getService, log: own.log });
  const detach = owner.attach(own.ctx);
  assert.equal(owner.attach(own.ctx), detach, 'a repeated attach returns the same detach');
  assert.equal(own.createdCount(), 1, 'no duplicate agent/created hook');
  await owner.ensurePreset();
  assert.equal(own.declared.has(VOICE_COMPACTION_PRESET_ID), true);
  assert.equal(own.registerCalls, 1);

  await detach();
  assert.equal(own.declared.has(VOICE_COMPACTION_PRESET_ID), false, 'detach removed only our own definition');
  assert.equal(owner.presetStatus().status, 'idle');
  const released = own.events.find((event) => event.type === 'voice.compaction.preset.released');
  assert.ok(released !== undefined, 'the release is observable');
  assert.equal(released.payload.owned, true);

  // Repeated attach/detach: one net definition and one hook, never two.
  owner.attach(own.ctx);
  await owner.ensurePreset();
  assert.equal(own.declared.size, 1);
  assert.equal(own.registerCalls, 2, 're-registered after our disposal; one live definition');
  assert.equal(own.createdCount(), 1);
  const agent = await own.createAndAnnounce('seirein-2026-11-08');
  assert.equal(own.mounts.length, 1);
  assert.equal(own.listenerCount(agent, 'agent/pre-step'), 1);

  // Reused declaration: detach must never unregister the user's definition.
  const user = createHost();
  const guest = createVoiceCompaction({ getService: user.getService, log: user.log });
  const userDetach = guest.attach(user.ctx);
  await guest.ensurePreset();
  assert.equal(guest.presetStatus().status, 'reused');
  await userDetach();
  assert.equal(user.declared.has(VOICE_COMPACTION_PRESET_ID), true, 'a reused definition is never removed');
  assert.equal(user.registerCalls, 0);
  assert.equal(guest.presetStatus().status, 'idle');
  assert.equal(user.events.some((event) => event.type === 'voice.compaction.preset.released'), false);
  console.log(`[22] own registerCalls=${own.registerCalls} declared=${own.declared.size} hooks=${own.createdCount()} | reused declared=${user.declared.has(VOICE_COMPACTION_PRESET_ID)} registerCalls=${user.registerCalls}`);
});

test('23. a real registry record is audited through config: compatible reuse, no re-registration', async () => {
  // The shipped `definitions` map stores `{ config, context, ready, ... }`, not the bare preset.
  const record = {
    config: { ...VOICE_COMPACTION_PRESET },
    context: { baseUrl: '' },
    ready: Promise.resolve(),
    generation: {},
  };
  const host = createHost({ definitions: { [VOICE_COMPACTION_PRESET_ID]: record } });
  const helper = createVoiceCompaction({ getService: host.getService, log: host.log });
  helper.attach(host.ctx);

  const agent = await host.createAndAnnounce('seirein-2026-11-08');
  const status = helper.presetStatus();
  assert.equal(status.status, 'reused', 'the wrapped compatible declaration is reused, not misread as a conflict');
  assert.equal(status.source, 'profile', 'a record without a provenance marker stays profile');
  assert.equal(status.enabled, true);
  assert.equal(status.mounted, 1);
  assert.equal(status.active, 1);
  assert.equal(host.registerCalls, 0, 'the wrapped declaration is never registered again');
  assert.equal(host.declared.get(VOICE_COMPACTION_PRESET_ID), record, 'the registry record is untouched');
  assert.equal(host.mounts.length, 1);
  assert.equal(host.listenerCount(agent, 'agent/pre-step'), 1);
  assert.equal(host.commandCount(agent, 'compact'), 1);
  const reused = host.events.find((event) => event.type === 'voice.compaction.preset.reused');
  assert.ok(reused !== undefined, 'the reuse is observable');
  assert.equal(reused.payload.source, 'profile');
  assert.deepEqual(reused.payload.plugins, [
    '@deepseek-ai/dsh-compaction-basic',
    '@deepseek-ai/dsh-command-compact',
    '@deepseek-ai/dsh-compaction-tool-result-pruner',
  ]);
  console.log(`[23] wrapped status=${status.status} source=${status.source} enabled=${status.enabled} registerCalls=${host.registerCalls} mounted=${status.mounted}`);
});

test('24. an incompatible config inside a real registry record is a conflict, never mounted', async () => {
  const incompatible = {
    id: VOICE_COMPACTION_PRESET_ID,
    name: 'wrapped standard preset',
    plugins: [{
      id: 'compaction',
      name: 'cordis:group',
      group: true,
      config: [
        { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
        { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
        { id: 'fs', name: '@deepseek-ai/dsh-tool-fs' },
      ],
    }],
  };
  const record = { config: incompatible, context: { baseUrl: '' }, ready: Promise.resolve() };
  const host = createHost({ definitions: { [VOICE_COMPACTION_PRESET_ID]: record } });
  const helper = createVoiceCompaction({ getService: host.getService, log: host.log });
  helper.attach(host.ctx);

  const agent = await host.createAndAnnounce('seirein-2026-11-08');
  assert.equal(helper.evidenceOf(agent), undefined, 'nothing was mounted for the Agent');
  assert.equal(host.mounts.length, 0);
  assert.equal(host.listenerCount(agent, 'agent/pre-step'), 0);
  assert.equal(host.commandCount(agent, 'compact'), 0);
  assert.equal(host.registerCalls, 0, 'conflict never falls through to register/overwrite');
  assert.equal(host.declared.get(VOICE_COMPACTION_PRESET_ID), record, 'the wrapped record is untouched');

  const status = helper.presetStatus();
  assert.equal(status.status, 'conflict');
  assert.equal(status.enabled, false);
  assert.equal(status.registered, false);
  assert.equal(status.mounted, 0);
  assert.equal(status.active, 0);
  assert.match(status.reason, /自动压缩不可用/u);
  assert.match(status.reason, /dsh-tool-fs/u);
  const conflict = host.events.find((event) => event.type === 'voice.compaction.preset.conflict');
  assert.ok(conflict !== undefined, 'the conflict is observable');
  assert.match(conflict.payload.reason, /fs/u);
  const skipped = host.events.find((event) => event.type === 'voice.compaction.skipped');
  assert.equal(skipped.payload.reason, 'preset-conflict');
  console.log(`[24] wrapped status=${status.status} enabled=${status.enabled} mounts=${host.mounts.length} declaredIntact=${host.declared.get(VOICE_COMPACTION_PRESET_ID) === record} reason=${status.reason}`);
});

test('25. a running Agent is not retro-assembled: registered / mounted / active are separate', async () => {
  const host = createHost({
    mountError: Object.assign(new Error('agent preset is locked after the first turn'), { code: 'agent-preset/locked' }),
  });
  // The Agent was already running before this plugin instance attached (the old-session case).
  host.createAgent('seirein-2026-11-08');
  const helper = createVoiceCompaction({ getService: host.getService, log: host.log });
  helper.attach(host.ctx);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(host.mountAttempts, 1, 'the reload sweep tried and was refused');

  const status = helper.presetStatus();
  assert.equal(status.status, 'reused', 'the definition is registered/validated');
  assert.equal(status.registered, false);
  assert.equal(status.running, 1);
  assert.equal(status.mounted, 0, 'the already-running Agent was not assembled');
  assert.equal(status.active, 0, 'no compaction service exists for it right now');
  assert.equal(status.requiresRestart, true);
  assert.equal(status.enabled, false);
  assert.match(status.reason, /自动压缩不可用/u);
  assert.match(status.reason, /需重启|voice\.session\.recover/u);
  assert.match(status.note, /需重启/u);
  const failed = host.events.find((event) => event.type === 'voice.compaction.failed');
  assert.equal(failed.payload.reason, 'mount');
  console.log(`[25] status=${status.status} registered=${status.registered} running/mounted/active=${status.running}/${status.mounted}/${status.active} requiresRestart=${status.requiresRestart} enabled=${status.enabled}`);
});

test('26. an automatic compaction that stays above the threshold writes exactly one event', async () => {
  const host = createHost();
  const helper = createVoiceCompaction({
    getService: host.getService,
    log: host.log,
    windowTokens: 1000, // 900 / 1000 = 0.9 after compaction
  });
  helper.attach(host.ctx);
  const agent = await host.createAndAnnounce('seirein-2026-11-08');
  agent.session.messages = Array.from({ length: 10 }, () => createMessage('x'.repeat(400))); // 1000 tokens

  // The automatic path encloses the run in an open turn; the close sees the shorter surface.
  host.sessionEmit(agent.session, { type: 'compaction/start', data: { compactionId: 'auto-1', turn: 'turn-1' } });
  agent.session.messages = Array.from({ length: 9 }, () => createMessage('x'.repeat(400))); // 900 tokens
  const end = { type: 'compaction/end', data: { compactionId: 'auto-1', turn: 'turn-1' } };
  host.sessionEmit(agent.session, end);

  const events = host.events.filter((event) => event.type === VOICE_COMPACTION_STILL_NEAR_LIMIT_ACTION);
  assert.equal(events.length, 1, 'one event per completed automatic compaction');
  assert.deepEqual(events[0].payload, {
    sessionId: 'seirein-2026-11-08',
    before: 1000,
    after: 900,
    ratio: 0.9,
    recommendation: 'new-session',
  });

  // A repeated close is not a second completion, and the idle/manual path (`turn:null`, which
  // includes `voice.session.recover`'s `compactNow`) reports itself -- never this observer.
  host.sessionEmit(agent.session, end);
  host.sessionEmit(agent.session, { type: 'compaction/start', data: { compactionId: 'manual-1', turn: null } });
  host.sessionEmit(agent.session, { type: 'compaction/end', data: { compactionId: 'manual-1', turn: null } });
  assert.equal(
    host.events.filter((event) => event.type === VOICE_COMPACTION_STILL_NEAR_LIMIT_ACTION).length,
    1,
  );
  console.log(`[26] auto: 1000 -> 900 ratio=0.9 recommendation=new-session events=${events.length}; manual/idle adds 0`);
});
