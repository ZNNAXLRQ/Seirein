/**
 * Assistant-session sandbox regression: the plugin's own dated session is switched to DSH
 * `danger-full-access` exactly once on create and on resume, and no other session is touched.
 *
 * Run: node --test test/session-sandbox.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { apply } from '../src/host/index.js';
import { ensureSession, observeSessionSandbox, switchToFullAccess } from '../src/host/session/delivery/dispatch.js';
import { cleanupRoot } from './helpers/cleanup.mjs';

const SCOPE = resolve('C:\\seirein-test\\workspace');
// One id per case: the in-process switch memo is keyed by session id, so reusing one id across
// independent cases would make them observe each other's switch.
const CREATED = 'seirein-2026-11-01';
const RESUMED = 'seirein-2026-11-02';
const ALREADY = 'seirein-2026-11-03';
const MISSING = 'seirein-2026-11-04';
const REPEATED = 'seirein-2026-11-05';
const FOREIGN_RESUMED = 'seirein-2026-11-06';
const REAL_SCOPE = 'seirein-2026-11-07';
const UNKNOWN_CWD = 'seirein-2026-11-08';
const SERVICE_CWD = 'seirein-2026-11-09';
const OBSERVE_FOREIGN = 'existing-foreign-session';
const NORMALIZE = 'seirein-normalize';

function makeAgent(id, cwd = '') {
  const header = typeof cwd === 'string' && cwd.length > 0 ? { cwd } : {};
  return { id, session: { id, header } };
}

/**
 * Fake Harness: one agentLoop, one sandboxPolicy projection. The fake `setSandboxMode` records
 * every call and folds the new mode into the projection, exactly like the real event does.
 * `resumedCwd` is the persisted session's own header (what resume returns), independent of the
 * request cwd passed to ensureSession.
 */
function harness({ mode = null, persisted = false, resumedCwd = undefined, serviceCwd = undefined } = {}) {
  const state = { mode, persisted, resumedCwd, serviceCwd, creates: [], resumes: [], calls: [] };
  const events = [];
  const agentLoop = {
    async resume(_ownerCtx, options) {
      state.resumes.push(options);
      // `persisted` decides resume vs create; both paths must switch the session.
      if (!state.persisted) throw new Error('not persisted yet');
      return { agent: makeAgent(options.resumeSessionId, state.resumedCwd) };
    },
    async createAgent(_ownerCtx, options) {
      state.creates.push(options);
      // The real registry records meta.cwd in the session header before publishing it.
      return { agent: makeAgent(options.sessionId, options.meta?.cwd) };
    },
  };
  const services = {
    agentLoop,
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
    sandboxPolicy: { overrideOf: () => state.mode },
    // Sessions without a header cwd are resolved through this service, like the real one.
    workingDirectory: { get: () => state.serviceCwd },
  };
  const setSandboxMode = async (session, next) => {
    state.calls.push({ sessionId: session.id, mode: next });
    state.mode = next;
  };
  return {
    state,
    events,
    getService: (name) => services[name],
    setSandboxMode,
    log: { async emit(type, payload) { events.push({ type, payload }); } },
    types: () => events.map((event) => event.type),
  };
}

test('new assistant session is switched to danger-full-access once', async () => {
  const app = harness();
  const result = await ensureSession({
    sessionId: CREATED,
    cwd: SCOPE,
    scopePath: SCOPE,
    ownerCtx: {},
    getService: app.getService,
    setSandboxMode: app.setSandboxMode,
    log: app.log,
  });

  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.equal(result.sandbox.switched, true);
  assert.equal(app.state.calls.length, 1);
  assert.deepEqual(app.state.calls[0], { sessionId: CREATED, mode: 'danger-full-access' });
  const switched = app.events.filter((event) => event.type === 'sandbox.switched');
  assert.equal(switched.length, 1);
  assert.deepEqual(switched[0].payload, { sessionId: CREATED, from: null, to: 'danger-full-access', trigger: 'ensure' });
});

test('resumed assistant session is switched to danger-full-access once', async () => {
  const app = harness({ persisted: true, resumedCwd: SCOPE });
  const result = await ensureSession({
    sessionId: RESUMED,
    cwd: SCOPE,
    scopePath: SCOPE,
    ownerCtx: {},
    getService: app.getService,
    setSandboxMode: app.setSandboxMode,
    log: app.log,
  });

  assert.equal(result.ok, true);
  assert.equal(result.resumed, true);
  assert.equal(app.state.resumes.length, 1);
  assert.equal(app.state.creates.length, 0);
  assert.equal(app.state.calls.length, 1);
  assert.equal(app.state.calls[0].mode, 'danger-full-access');
  assert.ok(app.types().includes('sandbox.switched'));
});

test('a session already in full access is skipped and reports already-full', async () => {
  const app = harness({ mode: 'danger-full-access', persisted: true, resumedCwd: SCOPE });
  const result = await ensureSession({
    sessionId: ALREADY,
    cwd: SCOPE,
    scopePath: SCOPE,
    ownerCtx: {},
    getService: app.getService,
    setSandboxMode: app.setSandboxMode,
    log: app.log,
  });

  assert.equal(result.ok, true);
  assert.equal(result.sandbox.skipped, 'already-full');
  assert.equal(app.state.calls.length, 0, 'no second switch');
  assert.ok(app.types().includes('sandbox.already-full'));
  assert.ok(!app.types().includes('sandbox.switched'));
});

test('a session outside the assistant workspace is never switched', async () => {
  const app = harness();
  const result = await ensureSession({
    sessionId: 'someone-elses-session',
    cwd: resolve('C:\\other-project'),
    scopePath: SCOPE,
    ownerCtx: {},
    getService: app.getService,
    setSandboxMode: app.setSandboxMode,
    log: app.log,
  });

  assert.equal(result.ok, true);
  assert.equal(app.state.calls.length, 0);
  assert.equal(result.sandbox.skipped, 'cwd-mismatch');
  assert.deepEqual(app.types(), ['sandbox.skipped']);
});

test('a missing setSandboxMode logs switch-unavailable and still creates the session', async () => {
  const app = harness();
  const result = await ensureSession({
    sessionId: MISSING,
    cwd: SCOPE,
    scopePath: SCOPE,
    ownerCtx: {},
    getService: app.getService,
    log: app.log,
  });

  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.equal(result.sandbox.skipped, 'switch-unavailable');
  assert.equal(app.state.creates.length, 1);
  assert.ok(app.types().includes('sandbox.switch-unavailable'));
});

test('repeated ensure on the same session switches only once', async () => {
  const app = harness({ persisted: true, resumedCwd: SCOPE });
  const options = {
    sessionId: REPEATED,
    cwd: SCOPE,
    scopePath: SCOPE,
    ownerCtx: {},
    getService: app.getService,
    setSandboxMode: app.setSandboxMode,
    log: app.log,
  };

  const first = await ensureSession(options);
  const second = await ensureSession(options);

  assert.equal(first.sandbox.switched, true);
  assert.equal(second.sandbox.skipped, 'already-full');
  assert.equal(app.state.calls.length, 1, 'the session is switched exactly once');
  assert.equal(app.events.filter((event) => event.type === 'sandbox.switched').length, 1);
});

test('an existing assistant session is switched on its first session/event', async () => {
  const app = harness();
  const listeners = [];
  const ctx = {
    on(name, fn) {
      if (name === 'session/event') listeners.push(fn);
      return () => {};
    },
  };
  const session = { id: 'existing-gui-session', header: { cwd: SCOPE } };
  const off = observeSessionSandbox({
    ctx,
    cwdOf: (value) => value?.header?.cwd ?? '',
    scopePathOf: () => SCOPE,
    getService: app.getService,
    setSandboxMode: app.setSandboxMode,
    log: app.log,
  });
  assert.equal(typeof off, 'function');
  assert.equal(listeners.length, 1);

  // The plugin did not create or resume this session: only the committed event triggers it.
  for (const listener of listeners) listener(session, { type: 'turn/start', data: { turn: 1 } });
  await new Promise((done) => setTimeout(done, 30));

  assert.equal(app.state.calls.length, 1);
  assert.deepEqual(app.state.calls[0], { sessionId: 'existing-gui-session', mode: 'danger-full-access' });
  const switched = app.events.filter((event) => event.type === 'sandbox.switched');
  assert.equal(switched.length, 1);
  assert.equal(switched[0].payload.trigger, 'observe');
});

test('later session/event on the same session does not switch again', async () => {
  const listeners = [];
  const ctx = {
    on(name, fn) {
      if (name === 'session/event') listeners.push(fn);
      return () => {};
    },
  };
  const calls = [];
  const events = [];
  const session = { id: 'existing-gui-repeat', header: { cwd: SCOPE } };
  observeSessionSandbox({
    ctx,
    cwdOf: (value) => value?.header?.cwd ?? '',
    scopePathOf: () => SCOPE,
    // No readable projection: the in-process Set is the only thing that can dedupe.
    getService: () => undefined,
    setSandboxMode: async (target) => { calls.push(target.id); },
    log: { async emit(type, payload) { events.push({ type, payload }); } },
  });

  for (const listener of listeners) listener(session, { type: 'turn/start', data: { turn: 1 } });
  await new Promise((done) => setTimeout(done, 30));
  const afterFirst = calls.length;
  for (const listener of listeners) listener(session, { type: 'turn/end', data: {} });
  await new Promise((done) => setTimeout(done, 30));

  assert.equal(afterFirst, 1);
  assert.equal(calls.length, 1, 'later events never switch the same session again');
  assert.equal(events.filter((event) => event.type === 'sandbox.switched').length, 1);
});

test('startup no longer auto-grants workspace access', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-sandbox-'));
  const disposers = [];
  t.after(() => cleanupRoot(root, disposers));

  const ctx = {
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
      return dispose;
    },
    get: () => undefined,
    inject: () => {},
    tools: { register: () => () => {} },
  };
  apply(ctx, { root, enabled: true });

  // The old build ran `securityAuto.autoEnsure()` 2.5 s after apply; give that window time to
  // pass and prove nothing security-related was attempted.
  await new Promise((done) => setTimeout(done, 2700));

  let events = [];
  try {
    const text = await readFile(join(root, 'data', 'events.jsonl'), 'utf8');
    events = text.split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line));
  } catch {
    events = [];
  }
  assert.deepEqual(events.filter((event) => String(event.type).startsWith('security.')), []);
  assert.equal(events.some((event) => event.type === 'security.grant'), false);
});

// ---- P2: ownership is the session's real cwd, never the request cwd ------------------------

test('a resumed session living elsewhere is never switched, even when the request cwd is the scope', async () => {
  const elsewhere = resolve('D:\\another-project');
  // The request claims the assistant workspace; the persisted session says otherwise.
  const app = harness({ persisted: true, resumedCwd: elsewhere });
  const result = await ensureSession({
    sessionId: FOREIGN_RESUMED,
    cwd: SCOPE,
    scopePath: SCOPE,
    ownerCtx: {},
    getService: app.getService,
    setSandboxMode: app.setSandboxMode,
    log: app.log,
  });

  assert.equal(result.ok, true);
  assert.equal(result.resumed, true);
  assert.equal(result.sandbox.skipped, 'cwd-mismatch');
  assert.equal(app.state.calls.length, 0, 'no sandbox/mode append for a foreign session');
  assert.ok(!app.types().includes('sandbox.switched'));
  assert.deepEqual(app.types(), ['sandbox.skipped']);
  assert.deepEqual(app.events[0].payload, { reason: 'cwd-mismatch', sessionCwd: elsewhere, scopePath: SCOPE });
});

test('a session whose real cwd is the scope is switched regardless of the request cwd', async () => {
  const app = harness({ persisted: true, resumedCwd: SCOPE });
  const result = await ensureSession({
    sessionId: REAL_SCOPE,
    // The request cwd is unrelated; only the resumed session's own cwd may decide.
    cwd: resolve('D:\\somewhere-else'),
    scopePath: SCOPE,
    ownerCtx: {},
    getService: app.getService,
    setSandboxMode: app.setSandboxMode,
    log: app.log,
  });

  assert.equal(result.ok, true);
  assert.equal(result.sandbox.switched, true);
  assert.deepEqual(app.state.calls, [{ sessionId: REAL_SCOPE, mode: 'danger-full-access' }]);
  assert.deepEqual(app.types(), ['sandbox.switched']);
});

test('a session whose real cwd is unknown is never switched', async () => {
  // Neither a header cwd nor a working-directory answer exists.
  const app = harness({ persisted: true });
  const result = await ensureSession({
    sessionId: UNKNOWN_CWD,
    cwd: SCOPE,
    scopePath: SCOPE,
    ownerCtx: {},
    getService: app.getService,
    setSandboxMode: app.setSandboxMode,
    log: app.log,
  });

  assert.equal(result.ok, true);
  assert.equal(result.sandbox.skipped, 'cwd-unknown');
  assert.equal(app.state.calls.length, 0);
  assert.deepEqual(app.types(), ['sandbox.skipped']);
  assert.deepEqual(app.events[0].payload, { reason: 'cwd-unknown' });
});

test('a session without a header cwd is resolved through the working-directory service', async () => {
  const app = harness({ persisted: true, serviceCwd: SCOPE });
  const result = await ensureSession({
    sessionId: SERVICE_CWD,
    cwd: SCOPE,
    scopePath: SCOPE,
    ownerCtx: {},
    getService: app.getService,
    setSandboxMode: app.setSandboxMode,
    log: app.log,
  });

  assert.equal(result.sandbox.switched, true);
  assert.deepEqual(app.state.calls, [{ sessionId: SERVICE_CWD, mode: 'danger-full-access' }]);
});

test('cwd comparison normalizes case, trailing separators and `..`, but not child directories', async () => {
  const scope = 'D:\\Projects\\dsh-assistant\\workspace';
  const cases = [
    ['D:\\Projects\\dsh-assistant\\workspace\\', true],
    ['d:\\projects\\dsh-assistant\\workspace', true],
    ['D:\\Projects\\dsh-assistant\\workspace\\..\\workspace', true],
    ['D:\\Projects\\dsh-assistant\\workspace\\sub', false],
  ];
  for (const [cwd, expected] of cases) {
    const app = harness();
    const result = await switchToFullAccess({
      session: makeAgent(`${NORMALIZE}-${expected ? 'same' : 'child'}-${cwd}`, cwd).session,
      scopePath: scope,
      getService: app.getService,
      setSandboxMode: app.setSandboxMode,
      log: app.log,
    });
    if (expected) {
      assert.equal(result.switched, true, `${cwd} must be treated as the scope`);
      assert.equal(app.state.calls.length, 1);
    } else {
      assert.equal(result.skipped, 'cwd-mismatch', `${cwd} is a child directory, not the scope`);
      assert.equal(app.state.calls.length, 0);
      assert.deepEqual(app.events[0].payload, { reason: 'cwd-mismatch', sessionCwd: cwd, scopePath: scope });
    }
  }
});

test('session/event observation ignores the request directory and uses the session real cwd', async () => {
  const elsewhere = resolve('D:\\another-project');
  const app = harness({ persisted: true, resumedCwd: elsewhere });
  const listeners = [];
  const ctx = {
    on(name, fn) {
      if (name === 'session/event') listeners.push(fn);
      return () => {};
    },
  };
  const session = { id: OBSERVE_FOREIGN, header: { cwd: elsewhere } };
  const off = observeSessionSandbox({
    ctx,
    // A stale caller reporting the assistant workspace must not lend it to this session.
    cwdOf: () => SCOPE,
    scopePathOf: () => SCOPE,
    getService: app.getService,
    setSandboxMode: app.setSandboxMode,
    log: app.log,
  });
  assert.equal(typeof off, 'function');

  // The event also carries the assistant directory: it must not be read as the session's.
  for (const listener of listeners) listener(session, { type: 'turn/start', data: { turn: 1, cwd: SCOPE } });
  await new Promise((done) => setTimeout(done, 30));

  assert.equal(app.state.calls.length, 0);
  assert.ok(!app.types().includes('sandbox.switched'));
  // The observer-entry pre-filter drops the known-foreign mismatch instead of writing one
  // `sandbox.skipped` per event; the aggregate summary is covered by `event-log-noise.mjs`.
  assert.deepEqual(app.events, [], 'a foreign session writes no per-event sandbox.skipped line');
});

// ---- observe path: append is deferred past the event dispatch ------------------------------

/** Collect the observer callback, like `ctx.on('session/event')` in the Host. */
function observerContext() {
  const listeners = [];
  return {
    listeners,
    ctx: {
      on(name, fn) {
        if (name === 'session/event') listeners.push(fn);
        return () => {};
      },
    },
    publish(session, event) {
      for (const listener of listeners) listener(session, event);
    },
  };
}

/** Wait for deferred work (setImmediate plus any bounded retry gap) to settle. */
const settle = (ms = 150) => new Promise((done) => setTimeout(done, ms));

/**
 * A fake live session whose `append` behaves like the Harness: appending publishes the new event
 * synchronously, and a nested append during that publish is refused with the production error.
 */
function appendableSession({ id, listeners = [] }) {
  const state = { publishing: false, nestedAppends: 0, appends: [], mode: null };
  const session = {
    id,
    header: { cwd: SCOPE },
    append(type, payload) {
      if (state.publishing) {
        state.nestedAppends += 1;
        throw new Error('session append cannot reenter while another append is being published');
      }
      state.appends.push({ type, payload });
      if (type === 'sandbox/mode') state.mode = payload?.mode ?? null;
      // The Host publishes the committed event while the append is still in flight.
      state.publishing = true;
      try {
        for (const listener of listeners) listener(session, { type, data: payload ?? {} });
      } finally {
        state.publishing = false;
      }
    },
  };
  return { session, state };
}

test('an event delivered during an append is switched only after that dispatch ends', async () => {
  const io = observerContext();
  const { session, state } = appendableSession({ id: 'existing-reentrant-session', listeners: io.listeners });
  const events = [];
  const off = observeSessionSandbox({
    ctx: io.ctx,
    cwdOf: (value) => value?.header?.cwd ?? '',
    scopePathOf: () => SCOPE,
    getService: () => undefined,
    setSandboxMode: async (target, mode) => target.append('sandbox/mode', { mode }),
    log: { async emit(type, payload) { events.push({ type, payload }); } },
  });
  assert.equal(typeof off, 'function');

  // The Host is still publishing this event: a synchronous append is refused with the exact
  // `session append cannot reenter ...` error reproduced in production.
  state.publishing = true;
  try {
    io.publish(session, { type: 'turn/start', data: { turn: 1 } });
  } finally {
    state.publishing = false;
  }
  assert.equal(state.nestedAppends, 0, 'the observer never appends inside the dispatch');
  await settle();

  assert.equal(state.nestedAppends, 0, 'the append ran only after the publish had ended');
  assert.equal(state.mode, 'danger-full-access');
  assert.deepEqual(
    state.appends.filter((entry) => entry.type === 'sandbox/mode').map((entry) => entry.payload),
    [{ mode: 'danger-full-access' }],
  );
  assert.equal(events.filter((event) => event.type === 'sandbox.switched').length, 1);
  assert.equal(events.filter((event) => event.type === 'sandbox.switch-failed').length, 0);
});

test('repeated observed events append sandbox/mode exactly once', async () => {
  const io = observerContext();
  const appends = [];
  const events = [];
  const session = { id: 'observed-idempotent', header: { cwd: SCOPE } };
  observeSessionSandbox({
    ctx: io.ctx,
    cwdOf: (value) => value?.header?.cwd ?? '',
    scopePathOf: () => SCOPE,
    getService: () => undefined,
    setSandboxMode: async (target, mode) => { appends.push({ sessionId: target.id, mode }); },
    log: { async emit(type, payload) { events.push({ type, payload }); } },
  });

  io.publish(session, { type: 'turn/start', data: { turn: 1 } });
  io.publish(session, { type: 'assistant/message', data: { turn: 1 } });
  io.publish(session, { type: 'turn/end', data: { turn: 1 } });
  await settle();

  assert.deepEqual(appends, [{ sessionId: 'observed-idempotent', mode: 'danger-full-access' }]);
  assert.equal(events.filter((event) => event.type === 'sandbox.switched').length, 1);
  assert.equal(events.filter((event) => event.type === 'sandbox.switch-failed').length, 0);
});

test('an append failing twice and succeeding on the third attempt logs one success', async () => {
  const io = observerContext();
  const events = [];
  const attempts = [];
  let mode = null;
  const session = { id: 'observed-retry', header: { cwd: SCOPE } };
  observeSessionSandbox({
    ctx: io.ctx,
    cwdOf: (value) => value?.header?.cwd ?? '',
    scopePathOf: () => SCOPE,
    getService: () => undefined,
    setSandboxMode: async (_target, next) => {
      attempts.push(next);
      if (attempts.length < 3) throw new Error(`append-busy-${attempts.length}`);
      mode = next;
    },
    log: { async emit(type, payload) { events.push({ type, payload }); } },
  });

  io.publish(session, { type: 'turn/start', data: { turn: 1 } });
  await settle(400);

  assert.equal(attempts.length, 3, 'the switch retried with the same bounded budget');
  assert.equal(mode, 'danger-full-access');
  assert.equal(events.filter((event) => event.type === 'sandbox.switch-failed').length, 0);
  const switched = events.filter((event) => event.type === 'sandbox.switched');
  assert.equal(switched.length, 1);
  assert.equal(switched[0].payload.trigger, 'observe');
});

test('an append that keeps failing stops after three attempts and reports one switch-failed', async () => {
  const io = observerContext();
  const events = [];
  const attempts = [];
  const ERROR = 'session append cannot reenter while another append is being published';
  const session = { id: 'observed-give-up', header: { cwd: SCOPE } };
  observeSessionSandbox({
    ctx: io.ctx,
    cwdOf: (value) => value?.header?.cwd ?? '',
    scopePathOf: () => SCOPE,
    getService: () => undefined,
    setSandboxMode: async () => { attempts.push('attempt'); throw new Error(ERROR); },
    log: { async emit(type, payload) { events.push({ type, payload }); } },
  });

  io.publish(session, { type: 'turn/start', data: { turn: 1 } });
  await settle(400);

  assert.equal(attempts.length, 3, 'the retry budget is exactly three attempts');
  const failed = events.filter((event) => event.type === 'sandbox.switch-failed');
  assert.equal(failed.length, 1);
  assert.deepEqual(failed[0].payload, { sessionId: 'observed-give-up', trigger: 'observe', error: ERROR });

  // Later events must not restart the exhausted budget.
  io.publish(session, { type: 'turn/end', data: { turn: 1 } });
  io.publish(session, { type: 'turn/start', data: { turn: 2 } });
  await settle(400);
  assert.equal(attempts.length, 3, 'the observed session is not retried forever');
  assert.equal(events.filter((event) => event.type === 'sandbox.switch-failed').length, 1);
});

test('the ensure path still switches in a single attempt and never defers', async () => {
  // Success: ensureSession awaits the switch on the spot (no scheduling involved).
  const ok = harness({ persisted: true, resumedCwd: SCOPE });
  const okCalls = [];
  const okResult = await ensureSession({
    sessionId: 'seirein-ensure-after-observe-fix',
    cwd: SCOPE,
    scopePath: SCOPE,
    ownerCtx: {},
    getService: ok.getService,
    setSandboxMode: async (session, mode) => { okCalls.push({ sessionId: session.id, mode }); },
    log: ok.log,
  });
  assert.equal(okResult.sandbox.switched, true);
  assert.deepEqual(okCalls, [{ sessionId: 'seirein-ensure-after-observe-fix', mode: 'danger-full-access' }]);
  assert.deepEqual(ok.types(), ['sandbox.switched']);

  // Failure: ensure keeps its old single attempt; the retry budget belongs to observe only.
  const bad = harness({ persisted: true, resumedCwd: SCOPE });
  let badAttempts = 0;
  const badResult = await ensureSession({
    sessionId: 'seirein-ensure-single-failure',
    cwd: SCOPE,
    scopePath: SCOPE,
    ownerCtx: {},
    getService: bad.getService,
    setSandboxMode: async () => { badAttempts += 1; throw new Error('append rejected'); },
    log: bad.log,
  });
  assert.equal(badResult.sandbox.skipped, 'switch-failed');
  assert.equal(badAttempts, 1, 'ensure does not inherit the observe retry budget');
  assert.equal(bad.events.filter((event) => event.type === 'sandbox.switch-failed').length, 1);
});
