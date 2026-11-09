/**
 * Tired is a bounded trial, not a latch.
 *
 * The regression pinned here: `tired` used to be reachable only from `waiting + 10 min idle` and
 * could be left only by ASR/hearing activity. A quiet host stayed tired for hours, narrowing the
 * idle preset pool to the four `tired` recipes. This suite pins the fix:
 *
 *   1. pure helpers: enter/recover thresholds, missing timestamps, malformed input never throw;
 *   2. the deadline is fixed on entry: repeated status reads and housekeeping ticks do not extend
 *      it (only a NEW waiting→tired transition creates a new deadline);
 *   3. expiry → waiting with `avatar.tired.recovered { reason, evidenceAgeMs, expiresInMs, afterMs,
 *      timeoutMs }` (reason is the one label; every measurement is a number);
 *   4. after recovery a full NEW idleTimeout is required before tired can return;
 *   5. user ASR activity releases tired immediately (no recovery-by-deadline event).
 *
 * The fake VTS speaks the real WebSocket protocol; the fake hearing module replaces device/ASR
 * capture. No real VTube Studio, microphone, screen or network (beyond loopback) is used.
 *
 * Run: node --test test/avatar-tired-timeout.mjs
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as realSetTimeout } from 'node:timers';
import test from 'node:test';

import { WebSocketServer } from 'ws';

import {
  TIRED_DEFAULTS,
  createTiredDeadline,
  resolveTiredTimeoutMs,
  shouldEnterTired,
  shouldExpireTired,
  shouldRecoverFromTired,
  tiredRecoveryEvidence,
} from '../src/host/avatar/idle-state.js';
import { cleanupRoot } from './helpers/cleanup.mjs';

/** Seam shared with the replaced hearing module (`load` replaces the real capture entry points). */
const state = { onUpdate: null, hearingStarts: 0 };
globalThis.__avatarTiredState = state;

const hearingUrl = new URL('../src/host/hearing/hearing.js', import.meta.url).href;
const hooks = registerHooks({
  load(url, context, next) {
    if (url !== hearingUrl) return next(url, context);
    return {
      format: 'module',
      shortCircuit: true,
      source: `
    const s = globalThis.__avatarTiredState;
    export const modelReady = () => true;
    export const finalModelReady = () => false;
    export const isLoopbackDevice = (name) => /CABLE|Stereo Mix|Virtual/i.test(String(name));
    export const listDevices = async () => ['Fake Mic'];
    export const startHearing = (options) => {
      s.hearingStarts += 1;
      s.onUpdate = options.onUpdate;
      return {
        device: options.device,
        instanceId: 'fake-hearing',
        stop() {},
        stats: () => ({ rmsDb: -20, peakDb: -10 }),
      };
    };
    export const watchHearingExit = () => {};
    export const annotateTranscript = (text) => text;
    export const joinDetailFields = () => ({});
    export const mergeJoinFallback = () => ({});
    export const offlineLimitedNote = () => '';
    export const truncationNotice = () => '';`,
    };
  },
});
const { apply } = await import('../src/host/index.js');
hooks.deregister();

const sleep = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms));

const waitFor = async (check, timeoutMs = 5000, stepMs = 20) => {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await check()) return true;
    await sleep(stepMs);
  }
  return false;
};

/** Minimal fake VTS: authentication, model discovery and parameter writes are accepted. */
async function createFakeVts() {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  const send = (socket, message) => {
    try {
      socket.send(JSON.stringify(message));
    } catch {
      /* socket already gone */
    }
  };
  const respond = (socket, request, data) => send(socket, {
    apiName: 'VTubeStudioPublicAPI',
    apiVersion: '1.0',
    requestID: request.requestID,
    messageType: `${String(request.messageType).replace(/Request$/u, '')}Response`,
    data,
  });
  wss.on('connection', (socket) => {
    socket.on('message', (raw) => {
      let request;
      try {
        request = JSON.parse(String(raw));
      } catch {
        return;
      }
      switch (request.messageType) {
        case 'AuthenticationTokenRequest':
          respond(socket, request, { authenticationToken: 'fake-token' });
          return;
        case 'AuthenticationRequest':
          respond(socket, request, { authenticated: true });
          return;
        case 'CurrentModelRequest':
          respond(socket, request, { modelLoaded: true, modelName: 'FakeHiyori', modelID: 'model-A' });
          return;
        case 'HotkeysInCurrentModelRequest':
          respond(socket, request, { availableHotkeys: [] });
          return;
        case 'ExpressionStateRequest':
          respond(socket, request, { expressions: [] });
          return;
        case 'InputParameterListRequest':
          respond(socket, request, {
            defaultParameters: [{ name: 'FaceAngleX', min: -30, max: 30, defaultValue: 0 }],
            customParameters: [],
          });
          return;
        case 'Live2DParameterListRequest':
          respond(socket, request, { live2DModelParameters: [{ name: 'ParamAngleX' }] });
          return;
        case 'EventSubscriptionRequest':
          respond(socket, request, { subscribedEvents: ['ModelLoadedEvent'], subscribedEventCount: 1 });
          return;
        default:
          respond(socket, request, {});
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    async close() {
      for (const socket of wss.clients) socket.terminate();
      await new Promise((done) => wss.close(() => server.close(() => done())));
    },
  };
}

/**
 * Mount the real `apply()` with the fake VTS (and the replaced hearing module). Only the services
 * the disabled components need are present; no agent loop is required for a partial ASR event.
 */
async function mount(t, fake, { config = {}, features = { avatar: true } } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'avatar-tired-timeout-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await mkdir(join(root, 'bin'), { recursive: true });
  await mkdir(join(root, 'workspace'), { recursive: true });
  await writeFile(join(root, 'data', 'features.json'), JSON.stringify(features), 'utf8');
  await writeFile(join(root, 'data', 'settings.json'), JSON.stringify({
    gptSovits: { enabled: false },
    voice: { chunking: false },
    autoMemory: { enabled: false },
  }), 'utf8');
  // Hearing only needs a non-null resolveFfmpeg(); the fake start never executes it.
  await writeFile(join(root, 'bin', 'ffmpeg.exe'), 'fake', 'utf8');

  state.onUpdate = null;
  state.hearingStarts = 0;

  const cleanups = [];
  const tools = new Map();
  const routes = new Map();
  const effect = (fn) => {
    const cleanup = fn();
    if (typeof cleanup === 'function') cleanups.push(cleanup);
    return cleanup;
  };
  const services = new Map([
    ['agentDefaultModel', { currentSelection: () => ({ provider: 'fake', model: 'fake-model' }) }],
    ['llm', {
      stream: () => (async function* styleFrames() {
        yield { type: 'text-delta', text: JSON.stringify({ amplitude: 1.1, tempo: 1.05 }) };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })(),
    }],
  ]);
  const getService = (name) => services.get(name);
  apply({
    effect,
    get: getService,
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    inject: (_deps, registerScope) => registerScope({
      effect,
      get: getService,
      webServer: {
        register(route) {
          routes.set(route.path, route.handler);
          return () => routes.delete(route.path);
        },
      },
      systemPrompt: { section: () => () => {} },
    }),
  }, { root, enabled: true, vtsPort: fake.port, ...config });

  const callRoute = async (path, { method = 'POST', body = undefined } = {}) => {
    const handler = routes.get(path);
    assert.equal(typeof handler, 'function', `route registered: ${path}`);
    const req = new EventEmitter();
    req.method = method;
    req.url = path;
    req.setEncoding = () => {};
    req.destroy = () => {};
    setImmediate(() => {
      if (body !== undefined) req.emit('data', JSON.stringify(body));
      req.emit('end');
    });
    const res = {
      code: 0,
      body: '',
      writeHead(code) { this.code = code; },
      end(data) { this.body = String(data ?? ''); },
    };
    await handler(req, res);
    try {
      return JSON.parse(res.body);
    } catch {
      return { raw: res.body };
    }
  };
  const status = () => callRoute('/assistant/status', { method: 'GET' });
  const action = (body) => callRoute('/assistant/action', { body });
  const events = async () => (await readFile(join(root, 'data', 'events.jsonl'), 'utf8').catch(() => ''))
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const waitEvent = async (type, predicate = () => true, timeoutMs = 5000) => {
    let found = null;
    const ok = await waitFor(async () => {
      found = (await events()).find((row) => row.type === type && predicate(row.payload ?? {})) ?? null;
      return found !== null;
    }, timeoutMs);
    assert.equal(ok, true, `timed out waiting for ${type}`);
    return found.payload ?? {};
  };
  const waitStatus = async (expected, timeoutMs = 5000) => {
    const ok = await waitFor(async () => (await status()).live2d?.runtime?.status === expected, timeoutMs);
    assert.equal(ok, true, `runtime status reaches ${expected} (last: ${(await status()).live2d?.runtime?.status})`);
    return status();
  };
  t.after(async () => {
    await fake.close();
    await cleanupRoot(root, cleanups.splice(0));
  });
  return {
    root,
    status,
    action,
    events,
    waitEvent,
    waitStatus,
    listen: (args = { action: 'start' }) => tools.get('assistant_listen').execute(args),
    feed: (event) => state.onUpdate(event),
  };
}

async function connectAvatar(host) {
  const connected = await host.action({ action: 'live2d.connect' });
  assert.equal(connected.ok, true, `live2d.connect succeeds (${connected.error ?? ''})`);
  assert.equal(await waitFor(async () => (
    (await host.status()).live2d?.capabilities?.discovered === true
  )), true, 'capability discovery settles');
}

// ---------------------------------------------------------------------------------------------
// 1. Pure helpers
// ---------------------------------------------------------------------------------------------

test('1. 纯助手：进入/恢复阈值、缺失与畸形输入（不抛错）', () => {
  const now = 1_700_000_000_000;
  const timeout = TIRED_DEFAULTS.idleTimeoutMs;

  assert.equal(TIRED_DEFAULTS.idleTimeoutMs, 10 * 60_000);
  assert.equal(TIRED_DEFAULTS.tiredTimeoutMs, 30 * 60_000);

  assert.equal(shouldEnterTired({ status: 'waiting', idleSince: now - timeout, now, timeoutMs: timeout }), true);
  assert.equal(shouldEnterTired({ status: 'waiting', idleSince: now - timeout + 1, now, timeoutMs: timeout }), false);
  assert.equal(shouldEnterTired({ status: 'tired', idleSince: now - timeout, now, timeoutMs: timeout }), false);
  assert.equal(shouldEnterTired({ status: 'waiting', idleSince: 0, now, timeoutMs: timeout }), false);
  assert.equal(shouldEnterTired({ status: 'waiting', idleSince: now - timeout, now, timeoutMs: 0 }), false);

  assert.equal(shouldRecoverFromTired({ status: 'tired', tiredSince: now - timeout, now, timeoutMs: timeout }), true);
  assert.equal(shouldRecoverFromTired({ status: 'tired', tiredSince: now - timeout + 1, now, timeoutMs: timeout }), false);
  assert.equal(shouldRecoverFromTired({ status: 'waiting', tiredSince: now - timeout, now, timeoutMs: timeout }), false);
  assert.equal(shouldRecoverFromTired({ status: 'tired', tiredSince: 0, now, timeoutMs: timeout }), false);
  assert.equal(shouldRecoverFromTired({ status: 'tired', now, timeoutMs: timeout }), false);
  assert.equal(shouldRecoverFromTired({ status: 'tired', tiredSince: now - timeout, now: NaN, timeoutMs: timeout }), false);

  const malformed = [undefined, null, {}, 'tired', 42, { status: 'tired', tiredSince: 'x', now, timeoutMs: timeout }];
  for (const input of malformed) {
    assert.doesNotThrow(() => shouldEnterTired(input));
    assert.doesNotThrow(() => shouldRecoverFromTired(input));
    assert.equal(shouldEnterTired(input), false);
    assert.equal(shouldRecoverFromTired(input), false);
  }
});

test('2. 纯助手：期限、过期判定与数字事件字段；配置优先级/回退', () => {
  const now = 1_700_000_000_000;
  const timeout = 20 * 60_000;
  const idleSince = now - TIRED_DEFAULTS.idleTimeoutMs;
  const deadline = createTiredDeadline({
    reason: 'idle-timeout', evidenceAt: idleSince, now, timeoutMs: timeout,
  });
  assert.deepEqual(deadline, {
    reason: 'idle-timeout',
    evidenceAt: idleSince,
    expiresAt: now + timeout,
    timeoutMs: timeout,
  });
  assert.equal(createTiredDeadline({ now: 0 }), null, 'no deadline without a real entry time');
  assert.equal(createTiredDeadline({ now, timeoutMs: 0 }).timeoutMs, TIRED_DEFAULTS.tiredTimeoutMs,
    '0 is not "disabled": it falls back to the default');
  assert.equal(createTiredDeadline({ now, evidenceAt: now + 1000, timeoutMs: timeout }).evidenceAt, now,
    'future evidence is clamped to the entry time');

  assert.equal(shouldExpireTired({ status: 'tired', expiresAt: now, now }), true);
  assert.equal(shouldExpireTired({ status: 'tired', expiresAt: now + 1, now }), false);
  assert.equal(shouldExpireTired({ status: 'waiting', expiresAt: now, now }), false);
  assert.equal(shouldExpireTired({ status: 'tired', expiresAt: 0, now }), false);
  assert.equal(shouldExpireTired(null), false);

  const evidence = tiredRecoveryEvidence({
    tiredSince: now - timeout, evidenceAt: now - timeout - 60_000, expiresAt: now - 1000, now,
  });
  assert.deepEqual(evidence, {
    afterMs: timeout,
    evidenceAgeMs: timeout + 60_000,
    expiresInMs: -1000,
  });
  for (const value of Object.values(evidence)) assert.equal(typeof value, 'number');
  assert.deepEqual(tiredRecoveryEvidence(null), { afterMs: 0, evidenceAgeMs: 0, expiresInMs: 0 });

  assert.equal(resolveTiredTimeoutMs({ avatar: { tiredTimeoutMs: 20 * 60_000 }, avatarTiredTimeoutMs: 99 }), 20 * 60_000);
  assert.equal(resolveTiredTimeoutMs({ avatarTiredTimeoutMs: 25 * 60_000 }), 25 * 60_000);
  assert.equal(resolveTiredTimeoutMs({ avatar: { tiredTimeoutMs: 0 } }), TIRED_DEFAULTS.tiredTimeoutMs);
  assert.equal(resolveTiredTimeoutMs({ avatar: { tiredTimeoutMs: -1 } }), TIRED_DEFAULTS.tiredTimeoutMs);
  assert.equal(resolveTiredTimeoutMs({ avatar: { tiredTimeoutMs: 'nope' } }), TIRED_DEFAULTS.tiredTimeoutMs);
  assert.equal(resolveTiredTimeoutMs(null), TIRED_DEFAULTS.tiredTimeoutMs);
});

// ---------------------------------------------------------------------------------------------
// 3. Host: deadline expiry, no polling refresh, no immediate relapse
// ---------------------------------------------------------------------------------------------

test('3. 宿主：到期回落 waiting；轮询不续期；回落后再等一个 idleTimeout 才重新 tired', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const fake = await createFakeVts();
  const host = await mount(t, fake, {
    // Nested config form (the primary key); the host resolves it through the pure helper.
    config: { avatarTickMs: 100, avatar: { tiredTimeoutMs: 20 * 60_000 } },
  });

  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  t.after(() => { Date.now = realNow; });

  await connectAvatar(host);
  await host.waitStatus('waiting');
  // One runtime tick establishes the runtime's idleSince before the fake clock jumps.
  t.mock.timers.tick(1000);

  offset = 11 * 60_000;
  t.mock.timers.tick(60_000);
  const tiredState = await host.waitEvent('avatar.state', (p) => p.status === 'tired');
  assert.equal(tiredState.reason, 'idle-timeout', 'the entry reason is unchanged');
  const first = (await host.status()).live2d.runtime;
  assert.equal(first.status, 'tired');
  assert.ok(first.tired !== null, 'status exposes the bounded trial');
  assert.equal(first.tired.reason, 'idle-timeout');
  assert.equal(first.tired.timeoutMs, 20 * 60_000);
  assert.ok(first.tired.expiresAt > first.tired.since, 'expiry is after entry');
  assert.ok(first.tired.evidenceAt <= first.tired.since, 'evidence is the idle span, never the poll');
  const { since, expiresAt, evidenceAt } = first.tired;

  // Repeated status reads are pure observation and must not move the deadline.
  for (let index = 0; index < 3; index += 1) {
    const read = (await host.status()).live2d.runtime.tired;
    assert.equal(read.since, since);
    assert.equal(read.expiresAt, expiresAt);
    assert.equal(read.evidenceAt, evidenceAt);
  }
  // Repeated housekeeping ticks do not refresh it either. A first tick at the same wall time and
  // then five real minutes both leave the deadline identical.
  t.mock.timers.tick(60_000);
  offset += 5 * 60_000;
  t.mock.timers.tick(60_000);
  const stillTired = (await host.status()).live2d.runtime;
  assert.equal(stillTired.status, 'tired', 'still inside the trial');
  assert.deepEqual(stillTired.tired, first.tired, 'polling never extends the deadline');

  // Deadline + one housekeeping interval: recover exactly once.
  offset = (expiresAt - realNow()) + 60_000;
  t.mock.timers.tick(60_000);
  const recovered = await host.waitEvent('avatar.tired.recovered');
  assert.equal(recovered.reason, 'idle-timeout', 'the event records the entry reason');
  assert.deepEqual(Object.keys(recovered).sort(), [
    'afterMs', 'evidenceAgeMs', 'expiresInMs', 'reason', 'timeoutMs',
  ], 'the payload has one reason label and only the documented measurements');
  for (const key of ['afterMs', 'evidenceAgeMs', 'expiresInMs', 'timeoutMs']) {
    assert.equal(typeof recovered[key], 'number', `${key} is numeric`);
  }
  assert.equal(recovered.timeoutMs, 20 * 60_000);
  assert.ok(recovered.afterMs >= 20 * 60_000, 'the trial really lasted its validity');
  assert.ok(recovered.evidenceAgeMs >= recovered.afterMs, 'the supporting idle span predates the trial');
  assert.ok(recovered.expiresInMs <= 0, 'recovery happened at/after the deadline');
  const eased = (await host.status()).live2d.runtime;
  assert.equal(eased.status, 'waiting');
  assert.equal(eased.tired, null, 'recovery clears the trial');
  const recoveredState = (await host.events()).find((row) => row.type === 'avatar.state'
    && row.payload?.status === 'waiting' && row.payload?.reason === 'tired-timeout');
  assert.ok(recoveredState !== undefined, 'the status transition is recorded as tired-timeout');

  // No immediate relapse: one more minute (and five more) are still inside the NEW idle window.
  const recoveryAt = Date.now();
  offset += 60_000;
  t.mock.timers.tick(60_000);
  assert.equal((await host.status()).live2d.runtime.status, 'waiting');
  offset = (recoveryAt - realNow()) + 5 * 60_000;
  t.mock.timers.tick(60_000);
  assert.equal((await host.status()).live2d.runtime.status, 'waiting', 'no tired relapse after recovery');

  // A full new idleTimeout is required: only then may tired return.
  offset = (recoveryAt - realNow()) + TIRED_DEFAULTS.idleTimeoutMs + 1000;
  t.mock.timers.tick(60_000);
  const tiredAgain = await waitFor(async () => (await host.events()).filter((row) => (
    row.type === 'avatar.state' && row.payload?.status === 'tired'
  )).length >= 2);
  assert.equal(tiredAgain, true, 'a full new idle span re-enters tired');
  assert.equal((await host.status()).live2d.runtime.status, 'tired');
});

// ---------------------------------------------------------------------------------------------
// 4. Host: real ASR activity releases tired immediately, before the deadline
// ---------------------------------------------------------------------------------------------

test('4. 宿主：ASR 活动提前解除 tired（清除期限，不发到期事件）', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const fake = await createFakeVts();
  const host = await mount(t, fake, {
    // Legacy config form: covered at the host level too.
    config: { avatarTickMs: 100, avatarTiredTimeoutMs: 20 * 60_000 },
    features: { avatar: true, hearing: true },
  });

  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  t.after(() => { Date.now = realNow; });

  await connectAvatar(host);
  await host.waitStatus('waiting');
  const started = await host.listen({ action: 'start' });
  assert.equal(started.ok, true, `the fake microphone starts (${started.error ?? ''})`);
  assert.equal(state.hearingStarts, 1);
  t.mock.timers.tick(1000);

  offset = 11 * 60_000;
  t.mock.timers.tick(60_000);
  await host.waitEvent('avatar.state', (p) => p.status === 'tired');
  assert.ok((await host.status()).live2d.runtime.tired !== null);

  // A real partial is user activity, not a supporting evidence refresh: it releases tired now.
  host.feed({ partial: '嗯' });
  assert.equal(await waitFor(async () => (await host.status()).live2d.runtime.status === 'listening'), true,
    'ASR activity claims listening from tired');
  const released = (await host.status()).live2d.runtime;
  assert.equal(released.tired, null, 'the trial is cleared immediately');
  // The state row is appended asynchronously: wait for the real file row instead of assuming it is
  // already flushed when the in-memory snapshot flipped.
  const transition = await host.waitEvent('avatar.state', (p) => (
    p.status === 'listening' && p.previous === 'tired'
  ));
  assert.equal(transition.reason, 'hearing.partial');
  assert.equal((await host.events()).some((row) => row.type === 'avatar.tired.recovered'), false,
    'an early release is not reported as deadline recovery');
});

// ---------------------------------------------------------------------------------------------
// 5. Wiring: the host uses the pure helpers and clears the trial on every exit
// ---------------------------------------------------------------------------------------------

test('5. 接线：housekeeping 使用纯判定；任何状态离开/销毁都清除期限', async () => {
  const source = await readFile(new URL('../src/host/index.js', import.meta.url), 'utf8');
  assert.ok(/const avatarTiredTimeoutMs = \(\) => resolveTiredTimeoutMs\(config\);/u.test(source),
    'the timeout is resolved through the pure helper');
  assert.ok(/shouldEnterTired\(\{ status: snap\.status, idleSince, now, timeoutMs: AVATAR_STYLE_IDLE_TIRED_MS \}\)/u.test(source),
    'entry uses the pure predicate with the host idle threshold');
  assert.ok(/shouldExpireTired\(\{ status: snap\.status, expiresAt: avatarTiredExpiresAt, now \}\)/u.test(source),
    'recovery uses the recorded deadline');
  assert.ok(/avatarStatusIf\(\['tired'\], 'waiting', 'tired-timeout', \{ at: now \}\)/u.test(source),
    'expiry transitions tired→waiting with the old reason');
  assert.ok(/if \(status === 'tired'\) \{\s*beginAvatarTired\(reason, at, timing\?\.evidenceAt\);/u.test(source),
    'only a changed tired transition records a new deadline');
  assert.ok(/else if \(result\.previous === 'tired'\) \{[\s\S]{0,200}clearAvatarTiredState\(at\);/u.test(source),
    'every real exit from tired clears the trial and restarts the idle floor');
  assert.ok(/disposeAvatarRuntime[\s\S]{0,500}clearAvatarTiredState\(\);/u.test(source),
    'dispose also clears the trial');
  assert.equal((source.match(/avatarStatus\('tired', 'idle-timeout'/gu) ?? []).length, 1,
    'there is exactly one tired entry call site');
});
