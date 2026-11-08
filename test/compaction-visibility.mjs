/**
 * Acceptance for the four "never silent" limits of the self-registered voice compaction preset:
 *
 *  1. a same-id declaration is reused only when its CONTENT is the compaction set (nothing else);
 *     an incompatible one is a reported conflict, not available compression;
 *  2. fail-open is degraded: `status` answers `enabled:false` + `reason`, and context pressure at
 *     the threshold sets `near-limit:true` and writes one throttled `voice.compaction.near-limit`;
 *  3. detach removes only the definition this plugin registered (a reused one survives), and
 *     repeated attach/detach never leaves two live definitions/hooks;
 *  4. a registered preset does not retro-assemble a running Agent: `registered` / `mounted` /
 *     `active` are separate and divergence says restart or `voice.session.recover`.
 *
 * The fake Host is deliberately minimal: it mirrors only the registry reads, the scoped binding
 * and the token meter that `status` depends on. Full wiring lives in `voice-compaction.mjs`.
 *
 * Run: node --test test/compaction-visibility.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  VOICE_COMPACTION_PRESET,
  VOICE_COMPACTION_PRESET_ID,
  assessVoiceCompactionPreset,
  createVoiceCompaction,
} from '../src/host/session/compaction/voice-compaction.js';

/** A compaction-only declaration with an extra row in its group. */
function withGroupRows(rows) {
  return {
    ...VOICE_COMPACTION_PRESET,
    plugins: [{
      id: 'compaction',
      name: 'cordis:group',
      group: true,
      isolate: { compaction: true },
      config: rows,
    }],
  };
}

const REQUIRED_ROWS = [
  { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
  { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
];

/** Minimal Host: registry reads, scoped binding, live Agents, token meter, event log. */
function createHost({
  declarations = null,
  registerError = null,
  mountError = null,
  tokensOf = () => 0,
} = {}) {
  const declared = new Map(
    declarations === null ? [[VOICE_COMPACTION_PRESET_ID, VOICE_COMPACTION_PRESET]] : Object.entries(declarations),
  );
  const events = [];
  const live = [];
  const bindings = new Map();
  let registerCalls = 0;
  const log = { emit: (type, payload) => { events.push({ type, payload }); return Promise.resolve(); } };

  const agentPresets = {
    definitions: declared,
    async register(definition) {
      registerCalls += 1;
      if (registerError !== null) throw registerError;
      if (declared.has(definition.id)) throw new Error(`Duplicate agent preset: ${definition.id}`);
      declared.set(definition.id, { ...definition, source: 'registered' });
      return async () => { declared.delete(definition.id); };
    },
    async mount(agentCtx, presetId) {
      if (!declared.has(presetId)) {
        throw Object.assign(new Error(`Unknown agent preset: ${presetId}`), { code: 'agent-preset/not-found' });
      }
      if (mountError !== null) throw mountError;
      bindings.set(agentCtx?.agent, { presetId, service: { measure: () => tokensOf() } });
      return { id: presetId };
    },
    composedPreset(agentCtx) { return bindings.get(agentCtx?.agent)?.presetId; },
    serviceFor(agent, name) {
      const binding = bindings.get(agent);
      return name === 'compaction' ? binding?.service : undefined;
    },
  };

  const services = {
    agentPresets,
    agents: { list: () => live.slice(), get: (id) => live.find((agent) => agent.id === id) },
    tokenMeter: { measure: () => ({ totalTokens: tokensOf() }) },
  };
  const getService = (name) => services[name];

  function start(sessionId) {
    const agent = { id: sessionId, session: { messages: [], append() {} } };
    agent.ctx = { key: {}, agent };
    live.push(agent);
    return agent;
  }

  const createdListeners = [];
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
    effect(fn) { return fn(); },
  };

  return {
    ctx, log, events, declared, bindings, start, agentPresets, getService,
    get registerCalls() { return registerCalls; },
    hookCount: () => createdListeners.length,
    nearLimitCount: () => events.filter((event) => event.type === 'voice.compaction.near-limit').length,
    async announce(agent) {
      for (const entry of createdListeners.slice()) await entry.handler({ agent, source: 'startup' });
    },
  };
}

test('1. fail-open is reported as unavailable, and pressure at the threshold warns once', async () => {
  let tokens = 900;
  const host = createHost({
    declarations: {},
    registerError: new Error('preset registry offline'),
    tokensOf: () => tokens,
  });
  const helper = createVoiceCompaction({
    getService: host.getService,
    log: host.log,
    windowTokens: 1000, // 900 / 1000 = 0.9 >= 0.8
  });
  const agent = host.start('seirein-2026-11-08');
  helper.attach(host.ctx);
  await helper.ensure(agent);
  assert.equal(host.registerCalls, 1);
  assert.equal(host.bindings.size, 0, 'fail-open mounts nothing');

  const status = helper.presetStatus();
  assert.equal(status.status, 'failed');
  assert.equal(status.enabled, false, 'registration failure is not functional compression');
  assert.match(status.reason, /自动压缩不可用/u);
  assert.match(status.reason, /offline/u);
  assert.equal(status.nearLimit, true);
  assert.equal(status['near-limit'], true, 'the status carries the literal near-limit flag');
  assert.equal(status.pressure.tokens, 900);
  assert.equal(status.pressure.windowTokens, 1000);
  assert.equal(host.nearLimitCount(), 1, 'exactly one pressure event');

  helper.presetStatus();
  assert.equal(host.nearLimitCount(), 1, 'the event is throttled');

  // Back below the threshold: no new warning, and the flag clears.
  tokens = 100;
  const calm = helper.presetStatus();
  assert.equal(calm.nearLimit, false);
  assert.equal(calm['near-limit'], false);
  assert.equal(host.nearLimitCount(), 1, 'normal pressure never warns');
  console.log(`[visibility 1] enabled=false near-limit=true tokens=900/1000 events=${host.nearLimitCount()} reason=${status.reason}`);
});

test('2. content audit: only the compaction set is compatible', () => {
  assert.equal(assessVoiceCompactionPreset(VOICE_COMPACTION_PRESET).compatible, true);

  const withFs = withGroupRows([...REQUIRED_ROWS, { id: 'fs', name: '@deepseek-ai/dsh-tool-fs' }]);
  const fsAudit = assessVoiceCompactionPreset(withFs);
  assert.equal(fsAudit.compatible, false, 'a tool row is not compaction');
  assert.match(fsAudit.reason, /fs/u);

  const missingCompact = withGroupRows([REQUIRED_ROWS[0]]);
  assert.equal(assessVoiceCompactionPreset(missingCompact).compatible, false);
  assert.match(assessVoiceCompactionPreset(missingCompact).reason, /command-compact/u);

  const persona = { ...VOICE_COMPACTION_PRESET, persona: { name: 'coder' } };
  const personaAudit = assessVoiceCompactionPreset(persona);
  assert.equal(personaAudit.compatible, false, 'a persona is not compaction');
  assert.match(personaAudit.reason, /persona/u);

  const unreadable = assessVoiceCompactionPreset({ id: VOICE_COMPACTION_PRESET_ID });
  assert.equal(unreadable.compatible, false, 'an unreadable declaration is a conflict, never "available"');
});

test('3. detach removes only our own definition; a reused one survives repeated cycles', async () => {
  // Reused (profile leftover): detach must not touch it.
  const reusedHost = createHost();
  const guest = createVoiceCompaction({ getService: reusedHost.getService, log: reusedHost.log });
  const guestDetach = guest.attach(reusedHost.ctx);
  await guest.ensurePreset();
  assert.equal(guest.presetStatus().status, 'reused');
  await guestDetach();
  assert.equal(reusedHost.declared.has(VOICE_COMPACTION_PRESET_ID), true, 'the user declaration survives');
  assert.equal(reusedHost.registerCalls, 0);

  // Owned registration: detach removes exactly the definition registered by this instance.
  const ownHost = createHost({ declarations: {} });
  const owner = createVoiceCompaction({ getService: ownHost.getService, log: ownHost.log });
  const detach = owner.attach(ownHost.ctx);
  assert.equal(owner.attach(ownHost.ctx), detach, 'a repeated attach reuses the same detach');
  assert.equal(ownHost.hookCount(), 1, 'no duplicate agent/created hook');
  await owner.ensurePreset();
  assert.equal(ownHost.declared.has(VOICE_COMPACTION_PRESET_ID), true);
  await detach();
  assert.equal(ownHost.declared.has(VOICE_COMPACTION_PRESET_ID), false, 'our definition is unregistered');
  assert.equal(owner.presetStatus().status, 'idle');

  // One more cycle: exactly one live definition and one hook.
  owner.attach(ownHost.ctx);
  await owner.ensurePreset();
  assert.equal(ownHost.declared.size, 1);
  assert.equal(ownHost.hookCount(), 1);
  assert.equal(ownHost.events.filter((event) => event.type === 'voice.compaction.preset.released').length, 1);
  console.log(`[visibility 3] reused survives=${reusedHost.declared.has(VOICE_COMPACTION_PRESET_ID)}; own declared=${ownHost.declared.size} hooks=${ownHost.hookCount()} released=1`);
});

test('4. a running Agent is registered-but-not-active until restart or recovery', async () => {
  const host = createHost({
    mountError: Object.assign(new Error('agent preset is locked after the first turn'), { code: 'agent-preset/locked' }),
  });
  // The Agent was already running when this plugin instance attached.
  host.start('seirein-2026-11-08');
  const helper = createVoiceCompaction({ getService: host.getService, log: host.log });
  helper.attach(host.ctx);
  await new Promise((resolve) => setImmediate(resolve));

  const status = helper.presetStatus();
  assert.equal(status.status, 'reused', 'the definition itself is registered/validated');
  assert.equal(status.running, 1);
  assert.equal(status.mounted, 0, 'the old Agent was not retro-assembled');
  assert.equal(status.active, 0);
  assert.equal(status.requiresRestart, true);
  assert.equal(status.enabled, false, 'registered is not active');
  assert.match(status.reason, /自动压缩不可用/u);
  assert.match(status.reason, /需重启|voice\.session\.recover/u);
  assert.match(status.note, /需重启/u);
  assert.equal(host.nearLimitCount(), 0, 'an empty session raises no pressure warning');
  console.log(`[visibility 4] status=${status.status} running/mounted/active=${status.running}/${status.mounted}/${status.active} requiresRestart=${status.requiresRestart} enabled=${status.enabled}`);
});
