/**
 * Manual recovery of an EXISTING dated voice session (`voice.session.recover`).
 *
 * The fake host mirrors the shipped `initializeAgent` order that the recovery depends on
 * (`@deepseek-ai/dsh-agent-loop/lib/index.js#initializeAgent`):
 *
 *   sessions.enter/announce -> await setup(agent.ctx, agent) -> agents.enter
 *   -> await serial agent/created -> resolve handle
 *
 * `agentLoop.resume(ownerCtx, { resumeSessionId, setup })` is the only loading entry: it reads the
 * persisted log of that SAME id, runs the setup (which mounts the compaction preset), and resolves
 * only after the announce is complete. `agents.get(id)` is the live-Agent lookup; a still-live
 * Agent is refused (the real loop would throw `SessionAlreadyOwnedError`).
 *
 * Run: node --test test/session-recovery.mjs
 */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  VOICE_COMPACTION_PRESET,
  VOICE_COMPACTION_PRESET_ID,
  VOICE_SESSION_AGENT_OWNED_REASON,
  VOICE_SESSION_RECOVER_ACTION,
  createVoiceCompaction,
  createVoiceSessionRecovery,
} from '../src/host/session/compaction/voice-compaction.js';

const HOST_ROOT = fileURLToPath(new URL('../src/host/', import.meta.url));

/** Four characters per token, like the shipped heuristic. */
const count = (message) => Math.ceil((typeof message?.text === 'string' ? message.text.length : 0) / 4);

/** 20 x 800-char messages = 4000 tokens, far above the fake 1200-token threshold. */
function history() {
  const messages = [];
  for (let index = 0; index < 20; index += 1) messages.push({ role: 'user', text: String(index).repeat(800) });
  return messages;
}

/**
 * One fake Host: persisted sessions, the live-Agent registry, preset registry, token meter and the
 * fake compaction backend the preset mounts. Option knobs model the refusal paths.
 */
function createHost({
  definitions = { [VOICE_COMPACTION_PRESET_ID]: VOICE_COMPACTION_PRESET },
  resumeError = null,
  compactionError = null,
} = {}) {
  const declared = new Map(Object.entries(definitions));
  const persisted = new Map(); // sessionId -> messages (the durable log)
  const live = new Map(); // sessionId -> live agent
  const mounts = []; // { agentId, presetId }
  const bindings = new Map(); // agent -> { presetId, engine }
  const compactionRuns = [];
  const resumes = [];
  const creates = [];
  const announces = [];
  const resolveCalls = [];
  const events = [];

  const log = { emit: (type, payload) => { events.push({ type, payload }); return Promise.resolve(); } };
  const tokenMeter = { measure: (session) => ({ totalTokens: session.messages.reduce((sum, message) => sum + count(message), 0) }) };

  function createEngine(agent) {
    const measure = () => tokenMeter.measure(agent.session).totalTokens;
    const compact = async () => {
      if (compactionError !== null) throw compactionError;
      const messages = agent.session.messages;
      const before = measure();
      const keep = 2; // newest tail stays verbatim
      const head = messages.slice(0, messages.length - keep);
      if (head.length === 0) return null;
      const summary = { role: 'user', text: '<compacted-summary>summary of the shadowed head</compacted-summary>' };
      agent.session.messages = [summary, ...messages.slice(messages.length - keep)];
      const after = measure();
      agent.session.compactions.push({ shadowed: head.length, before, after });
      compactionRuns.push({ before, after });
      return { shadowedSeqs: head.map((_message, index) => index), summarySeq: 0 };
    };
    return { measure, compactNow: compact };
  }

  const agentPresets = {
    async mount(agentCtx, presetId) {
      const definition = declared.get(presetId);
      if (definition === undefined) {
        throw Object.assign(new Error(`Unknown agent preset: ${presetId}`), { code: 'agent-preset/not-found' });
      }
      const agent = agentCtx?.agent;
      if (agent === undefined) throw new Error('mount requires an Agent context');
      mounts.push({ agentId: agent.id, presetId });
      const binding = { presetId, engine: createEngine(agent) };
      bindings.set(agent, binding);
      return { id: presetId };
    },
    async resolve(presetId) {
      resolveCalls.push(presetId);
      if (!declared.has(presetId)) {
        throw Object.assign(new Error(`Unknown agent preset: ${presetId}`), { code: 'agent-preset/not-found' });
      }
      return { id: presetId };
    },
    composedPreset(agentCtx) { return bindings.get(agentCtx?.agent)?.presetId; },
    serviceFor(agent, name) { return name === 'compaction' ? bindings.get(agent)?.engine : undefined; },
    presetForSession(session) { return session?.agentPresetRecorded ?? null; },
  };

  const services = { agentPresets, tokenMeter, agents: { get: (id) => live.get(id), list: () => [...live.values()] } };

  function createSession(sessionId) {
    const source = persisted.get(sessionId) ?? [];
    const session = {
      id: sessionId,
      seq: 0,
      messages: source.map((message) => ({ ...message })),
      compactions: [],
      agentPresetRecorded: null,
      append(type, data) {
        this.seq += 1;
        if (type === 'agent-preset/selected') this.agentPresetRecorded = data.agentPreset;
      },
    };
    return session;
  }

  /** The shipped creation order: session entry, setup (awaited), then Agent publish + announce. */
  const agentLoop = {
    async resume(ownerCtx, options) {
      resumes.push(options);
      if (resumeError !== null) throw resumeError;
      const id = options.resumeSessionId;
      if (!persisted.has(id)) throw new Error(`session "${id}" is not persisted`);
      if (live.has(id)) {
        throw Object.assign(new Error(`session "${id}" is already owned`), { code: 'SessionAlreadyOwnedError' });
      }
      const session = createSession(id);
      const agent = { id, session };
      agent.ctx = { key: {}, agent };
      const setupCommit = await options.setup?.(agent.ctx, agent);
      assert.equal(setupCommit?.commit, undefined, 'recovery setup resolves void (no commit call)');
      live.set(id, agent);
      announces.push({ id, source: 'resume' });
      return { agent, dispose: async () => { live.delete(id); } };
    },
    // A create path exists only to prove recovery never uses it.
    async createAgent(_ownerCtx, options) {
      creates.push(options);
      const agent = { id: options.sessionId, session: createSession(options.sessionId) };
      agent.ctx = { key: {}, agent };
      live.set(agent.id, agent);
      return { agent };
    },
  };
  services.agentLoop = agentLoop;
  const ownerCtx = { get: (name) => services[name], effect: (fn) => fn() };

  const getService = (name) => services[name];
  const engine = createVoiceCompaction({ getService, log });
  const recover = createVoiceSessionRecovery({
    getService,
    log,
    ownerCtx,
    compaction: engine,
    defaultSessionId: () => 'seirein-2026-11-08',
  });

  return {
    log, events, mounts, compactionRuns, resumes, creates, announces, resolveCalls,
    persisted, live, ownerCtx, getService, recover,
    addLiveAgent(sessionId) {
      const agent = { id: sessionId, session: createSession(sessionId) };
      agent.ctx = { key: {}, agent };
      live.set(sessionId, agent);
      return agent;
    },
  };
}

test('1. no live agent + preset available: resume once, mount once, compactNow once, id unchanged', async () => {
  const host = createHost();
  host.persisted.set('seirein-2026-11-08', history());

  // No argument: the action falls back to today's voice session id.
  const result = await host.recover({});

  assert.equal(result.ok, true);
  assert.equal(result.sessionId, 'seirein-2026-11-08', 'the original session id is preserved');
  assert.equal(result.mounted, true);
  assert.equal(result.compacted, true);
  assert.equal(host.resumes.length, 1, 'agentLoop.resume called exactly once');
  assert.equal(host.resumes[0].resumeSessionId, 'seirein-2026-11-08');
  assert.equal(typeof host.resumes[0].setup, 'function', 'the preset is mounted from the setup callback');
  assert.equal(host.creates.length, 0, 'recovery never creates a session');
  assert.equal(host.mounts.length, 1, 'preset mounted once');
  assert.equal(host.mounts[0].presetId, VOICE_COMPACTION_PRESET_ID);
  assert.equal(host.compactionRuns.length, 1, 'compactNow called exactly once');
  assert.equal(typeof result.before, 'number');
  assert.equal(typeof result.after, 'number');
  assert.ok(result.before > result.after, `request tokens drop (${result.before} -> ${result.after})`);
  assert.equal(result.freed, result.before - result.after);
  assert.equal(host.persisted.has('seirein-2026-11-08'), true, 'history stays under the same id');
  assert.equal(host.persisted.get('seirein-2026-11-08').length, 20, 'the persisted log is not rewritten');
  assert.equal(host.announces.length, 1, 'announce finished before resume resolved');
  assert.equal(host.announces[0].source, 'resume');

  const event = host.events.filter((entry) => entry.type === VOICE_SESSION_RECOVER_ACTION).at(-1);
  assert.equal(event.payload.ok, true);
  assert.equal(event.payload.mounted, true);
  assert.equal(event.payload.sessionId, 'seirein-2026-11-08');
  assert.equal(typeof event.payload.before, 'number');
  assert.equal(typeof event.payload.freed, 'number');
  console.log(`[1] resume=1 mount=1 compactNow=1 ${result.before} -> ${result.after} (freed=${result.freed})`);
});

test('2. a live agent is refused: no resume, no preset lookup, no compaction', async () => {
  const host = createHost();
  host.persisted.set('seirein-2026-11-08', history());
  host.addLiveAgent('seirein-2026-11-08');

  const result = await host.recover({ sessionId: 'seirein-2026-11-08' });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'agent-owned');
  assert.equal(result.reason, VOICE_SESSION_AGENT_OWNED_REASON);
  assert.match(result.reason, /重启 DSH/u);
  assert.equal(host.resumes.length, 0, 'no resume attempt');
  assert.equal(host.resolveCalls.length, 0, 'refused before touching the preset registry');
  assert.equal(host.mounts.length, 0);
  assert.equal(host.compactionRuns.length, 0, 'no compaction');
  const event = host.events.filter((entry) => entry.type === VOICE_SESSION_RECOVER_ACTION).at(-1);
  assert.equal(event.payload.ok, false);
  assert.equal(event.payload.reason, 'agent-owned');

  // The live Agent and its session object were not touched.
  assert.equal(host.live.size, 1);
  assert.equal(host.live.get('seirein-2026-11-08').session.messages.length, 20);
});

test('3. an undeclared preset is refused before any resume', async () => {
  const host = createHost({ definitions: {} });
  host.persisted.set('seirein-2026-11-08', history());

  const result = await host.recover({ sessionId: 'seirein-2026-11-08' });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'preset-missing');
  assert.equal(host.resumes.length, 0, 'nothing was resumed');
  assert.equal(host.creates.length, 0);
  assert.equal(host.mounts.length, 0, 'nothing was mounted');
  assert.equal(host.compactionRuns.length, 0);
  assert.equal(host.persisted.get('seirein-2026-11-08').length, 20, 'history untouched');
  const event = host.events.filter((entry) => entry.type === VOICE_SESSION_RECOVER_ACTION).at(-1);
  assert.equal(event.payload.ok, false);
  assert.equal(event.payload.reason, 'preset-missing');
  console.log('[3] refused: code=preset-missing resumes=0 mounts=0');
});

test('4. a resume failure is returned verbatim: one attempt, no new session, no history change', async () => {
  const failure = Object.assign(new Error('session log is corrupt'), { code: 'session/load-failed' });
  const host = createHost({ resumeError: failure });
  host.persisted.set('seirein-2026-11-08', history());

  const result = await host.recover({ sessionId: 'seirein-2026-11-08' });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'session/load-failed', 'the host error code passes through');
  assert.equal(result.error, 'session log is corrupt');
  assert.equal(host.resumes.length, 1, 'exactly one attempt: never retried');
  assert.equal(host.creates.length, 0, 'no new session was created');
  assert.equal(host.persisted.size, 1, 'the store still has only the original session');
  assert.equal(host.persisted.get('seirein-2026-11-08').length, 20, 'no history rewritten');
  assert.equal(host.mounts.length, 0, 'setup never ran');
  assert.equal(host.compactionRuns.length, 0);
  const event = host.events.filter((entry) => entry.type === VOICE_SESSION_RECOVER_ACTION).at(-1);
  assert.equal(event.payload.ok, false);
  assert.equal(event.payload.reason, 'session/load-failed');
});

test('5. a compaction failure reports ok:false while the mount stays recorded and history is kept', async () => {
  const host = createHost({ compactionError: Object.assign(new Error('manual compaction: summary failed'), { code: 'summary' }) });
  host.persisted.set('seirein-2026-11-08', history());

  const result = await host.recover({ sessionId: 'seirein-2026-11-08' });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'compaction-failed');
  assert.equal(result.mounted, true, 'the preset really mounted; only compaction failed');
  assert.equal(result.compacted, false);
  assert.equal(typeof result.before, 'number');
  assert.equal(result.after, null);
  assert.equal(result.freed, null);
  assert.equal(host.resumes.length, 1);
  assert.equal(host.mounts.length, 1);
  assert.equal(host.compactionRuns.length, 0);
  assert.deepEqual(host.persisted.get('seirein-2026-11-08').map((message) => message.text), history().map((message) => message.text), 'no message was removed');
  assert.equal(host.live.get('seirein-2026-11-08').session.messages.length, 20, 'the live session still holds every message');
  const event = host.events.filter((entry) => entry.type === VOICE_SESSION_RECOVER_ACTION).at(-1);
  assert.equal(event.payload.ok, false);
  assert.equal(event.payload.mounted, true);
  assert.equal(event.payload.reason, 'compaction-failed');
});

test('6. the action is manual only: no timer, listener or delivery path can run it', async () => {
  const indexSource = await readFile(join(HOST_ROOT, 'index.js'), 'utf8');
  const moduleSource = await readFile(join(HOST_ROOT, 'session/compaction/voice-compaction.js'), 'utf8');

  // The recovery handler exists in exactly TWO places: its creation and the one route entry.
  const indexLines = indexSource.split('\n').filter((line) => line.includes('recoverVoiceSession'));
  assert.equal(indexLines.length, 2, `one creation + one route registration, got: ${JSON.stringify(indexLines)}`);
  assert.match(indexLines[0], /const recoverVoiceSession = createVoiceSessionRecovery\(/u);
  assert.match(indexLines[1], /actions: \[VOICE_SESSION_RECOVER_ACTION\], handle: recoverVoiceSession/u);
  for (const line of indexLines) {
    assert.doesNotMatch(line, /setTimeout|setInterval|\.on\(|addEventListener|schedule|queueMicrotask/iu);
  }

  // The action name itself is declared once in the module and its handler is only a factory.
  assert.equal(moduleSource.match(/'voice\.session\.recover'/gu).length, 1, 'one action name literal');
  assert.equal(moduleSource.match(/createVoiceSessionRecovery\(/gu).length, 1, 'the module only declares the factory');
  assert.doesNotMatch(moduleSource, /setTimeout|setInterval/iu, 'no timer inside the compaction module');

  // Nothing else in the Host source builds or calls the recovery handler.
  const owners = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = join(directory, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.name.endsWith('.js') && (await readFile(target, 'utf8')).includes('createVoiceSessionRecovery(')) owners.push(target);
    }
  };
  await walk(HOST_ROOT);
  const callers = owners.map((path) => path.slice(HOST_ROOT.length).replaceAll('\\', '/')).sort();
  assert.deepEqual(callers, ['index.js', 'session/compaction/voice-compaction.js'], 'only the module and the index register it');
  console.log(`[6] static: index occurrences=2, action-name constants=1, timer hits=0, callers=${callers.length}`);
});
