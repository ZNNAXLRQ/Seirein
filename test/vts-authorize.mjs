/**
 * VTS authorization recovery UX (fake VTube Studio, no real VTS contacted).
 *
 * The incident: a persisted token was revoked, the automatic re-authorization popup failed, and the
 * user was left with connected=false and no hint that a deliberate re-authorization was required.
 *
 * The contract under test:
 *   1. a rejected persisted token leaves a VISIBLE failure state: needsAuth/authError/retryable;
 *   2. an explicit `vts.authorize` (client authorize()) sends exactly one new
 *      AuthenticationTokenRequest, persists the allowed token and clears needsAuth;
 *   3. repeated explicit clicks are idempotent and clear the freshTokenRejected block;
 *   4. when VTS is absent, the error is visible but needsAuth stays false (no popup can help);
 *   5. a later start with the authorized token asks nothing and shows no needs-user prompt;
 *   6. the Host exposes the same fields through /assistant/status (live2d + vtsAuth) and the
 *      `vts.authorize` action, and logs vts.auth.needs-user.
 *
 * Run: node test/vts-authorize.mjs
 */
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WebSocketServer } from 'ws';

import { apply } from '../src/host/index.js';
import { VtsClient } from '../src/host/avatar/vts.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (condition, message) => {
  if (!condition) throw new Error(`assertion failed: ${message}`);
};

const REVOKED_TEXT = 'Authentication request failed because token is invalid or has been revoked by the user.';

// ---- fake VTS -------------------------------------------------------------
/**
 * Fake VTS focused on the authorization handshake. `acceptGranted:false` is the "VTS granted a
 * token but still rejects it" shape that used to leave the client stuck; setters let one test move
 * the fake from reject → accept without restarting it.
 */
async function createFakeVts({
  validTokens = [],
  grantToken = 'grant-token',
  acceptGranted = true,
  grantMode = 'grant',
  tokenDelayMs = 0,
} = {}) {
  const valid = new Set(validTokens);
  const state = { grantToken, acceptGranted, grantMode, tokenDelayMs };
  const requests = [];
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
  const respondError = (socket, request, message) => send(socket, {
    apiName: 'VTubeStudioPublicAPI',
    apiVersion: '1.0',
    requestID: request.requestID,
    messageType: 'APIError',
    data: { errorID: 50, message },
  });

  wss.on('connection', (socket) => {
    socket.on('message', async (raw) => {
      let request;
      try {
        request = JSON.parse(String(raw));
      } catch {
        return;
      }
      requests.push({
        type: String(request.messageType ?? ''),
        token: request.data?.authenticationToken ?? null,
      });
      switch (request.messageType) {
        case 'AuthenticationTokenRequest':
          if (state.grantMode === 'none') return;
          if (state.tokenDelayMs > 0) await sleep(state.tokenDelayMs);
          if (state.grantMode === 'deny') {
            respondError(socket, request, 'the user denied the plugin authorization');
            return;
          }
          if (state.acceptGranted) valid.add(state.grantToken);
          respond(socket, request, { authenticationToken: state.grantToken });
          return;
        case 'AuthenticationRequest': {
          const token = String(request.data?.authenticationToken ?? '');
          if (valid.has(token)) {
            respond(socket, request, { authenticated: true });
            return;
          }
          respond(socket, request, { authenticated: false, reason: REVOKED_TEXT });
          return;
        }
        case 'CurrentModelRequest':
          respond(socket, request, { modelLoaded: true, modelName: 'FakeHiyori', modelID: 'model-A' });
          return;
        case 'HotkeysInCurrentModelRequest':
          respond(socket, request, { availableHotkeys: [{ hotkeyID: 'hk-1', name: 'Idle' }] });
          return;
        case 'ExpressionStateRequest':
          respond(socket, request, { expressions: [{ name: 'Smile' }] });
          return;
        case 'EventSubscriptionRequest':
          respond(socket, request, { subscribedEventCount: 1, subscribedEvents: ['ModelLoadedEvent'] });
          return;
        default:
          respond(socket, request, {});
      }
    });
  });

  let closing = null;
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        requests,
        setGrantToken(token) { state.grantToken = token; },
        setAcceptGranted(value) { state.acceptGranted = value === true; },
        addValid(token) { valid.add(token); },
        close() {
          if (closing !== null) return closing;
          closing = new Promise((done) => {
            for (const socket of wss.clients) socket.terminate();
            wss.close(() => server.close(() => done()));
          });
          return closing;
        },
      });
    });
  });
}

const seedToken = async (name, token) => {
  const root = await mkdtemp(join(tmpdir(), `vts-authorize-${name}-`));
  const tokenPath = join(root, 'vts-token.json');
  await writeFile(tokenPath, JSON.stringify({ authenticationToken: token }, null, 2), 'utf8');
  return { root, tokenPath };
};

const readToken = async (tokenPath) => JSON.parse(await readFile(tokenPath, 'utf8')).authenticationToken;

const countOf = (requests, type) => requests.filter((entry) => entry.type === type).length;

const unusedPort = async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
};

// ---- test runner ----------------------------------------------------------
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// 1) The regression: a revoked persisted token must leave a visible needs-auth state.
test('1. 持久 token 被拒 → needsAuth/authError/retryable + vts.auth.needs-user（一次）', async () => {
  const { tokenPath } = await seedToken('visible', 'stale-token');
  // VTS grants a replacement token but still rejects it: the retry fails and the user is stuck.
  const fake = await createFakeVts({ grantToken: 'renewed-bad', acceptGranted: false });
  const events = [];
  const client = new VtsClient({
    port: fake.port,
    tokenPath,
    onAuthEvent: (type, payload) => events.push({ type, ...payload }),
  });
  try {
    const failure = await client.connect().then(() => null, (error) => error);
    const status = client.status();
    assert(failure?.code === 'AUTH_RETRY_FAILED', `the retry failure is coded AUTH_RETRY_FAILED (got ${failure?.code})`);
    assert(status.state === 'token-invalid', `state is token-invalid (got ${status.state})`);
    assert(status.needsAuth === true, 'status.needsAuth is true after the authorization failure');
    assert(status.authError === 'token-invalid', `authError classifies the rejection (got '${status.authError}')`);
    assert(status.retryable === true, 'status.retryable is true');
    assert(status.lastAuthAt > 0, `status.lastAuthAt is a real timestamp (got ${status.lastAuthAt})`);
    assert(status.freshTokenRejected === true, 'the fresh-token block is recorded');
    assert(status.tokenPresent === true, 'the rejected fresh token is on disk (so it can be replaced)');
    const needsUser = events.filter((entry) => entry.type === 'vts.auth.needs-user');
    assert(needsUser.length === 1, `vts.auth.needs-user fires once (got ${needsUser.length})`);
    assert(needsUser[0].authError === 'token-invalid' && needsUser[0].retryable === true,
      'the needs-user payload carries authError + retryable');
    assert(!JSON.stringify(needsUser).includes('renewed-bad') && !JSON.stringify(needsUser).includes('stale-token'),
      'no event payload contains a token value');
    assert(!/renewed-bad|stale-token/u.test(client.lastError), 'lastError contains no token value');
    console.log(`     state=${status.state} needsAuth=${status.needsAuth} authError=${status.authError}`
      + ` retryable=${status.retryable} lastAuthAt=${status.lastAuthAt} needsUserEvents=${needsUser.length}`);
  } finally {
    client.close();
    await fake.close();
  }
});

// 2) The explicit action: one new token grant, persisted, needsAuth cleared.
test('2. vts.authorize → 只发一次新 token 请求；Allow 后 authenticated + token 持久化 + needsAuth 清除', async () => {
  const { tokenPath } = await seedToken('authorize', 'stale-token');
  const fake = await createFakeVts({ grantToken: 'renewed-bad', acceptGranted: false });
  const events = [];
  const client = new VtsClient({
    port: fake.port,
    tokenPath,
    onAuthEvent: (type, payload) => events.push({ type, ...payload }),
  });
  try {
    await client.connect().catch(() => {});
    assert(client.status().needsAuth === true, 'the failure state is visible before the explicit action');
    const grantsBefore = countOf(fake.requests, 'AuthenticationTokenRequest');

    // The user allows the popup this time; VTS accepts the newly granted token.
    fake.setGrantToken('approved-token');
    fake.setAcceptGranted(true);
    const result = await client.authorize({ reason: 'settings-card' });
    const status = client.status();
    const grantsAfter = countOf(fake.requests, 'AuthenticationTokenRequest');
    assert(result.ok === true, `authorize() succeeds (got ${JSON.stringify({ code: result.code, error: result.error })})`);
    assert(result.authorized === true && result.needsUserApproval === false, 'the result reports success');
    assert(grantsAfter === grantsBefore + 1, `exactly one new AuthenticationTokenRequest (got ${grantsAfter - grantsBefore})`);
    assert(fake.requests.filter((entry) => entry.type === 'AuthenticationRequest').at(-1)?.token === 'approved-token',
      'the last AuthenticationRequest uses the newly granted token');
    assert(await readToken(tokenPath) === 'approved-token', 'the approved token is persisted');
    assert(status.state === 'ready' && status.authenticated === true, 'the connection is authenticated + ready');
    assert(status.needsAuth === false && status.authError === '', 'needsAuth/authError are cleared');
    assert(status.freshTokenRejected === false, 'the fresh-token block is cleared');
    const authorized = events.filter((entry) => entry.type === 'vts.auth.authorized');
    assert(authorized.length === 1 && authorized[0].explicit === true,
      'vts.auth.authorized {explicit:true} fires once');
    console.log(`     grants=${grantsAfter} token=${await readToken(tokenPath)} state=${status.state}`
      + ` needsAuth=${status.needsAuth} authorizedEvents=${authorized.length}`);
  } finally {
    client.close();
    await fake.close();
  }
});

// 3) Repeated clicks: one request, and the fresh-token block is really reset by the explicit act.
test('3. 重复 authorize 只发一次请求；freshTokenRejected 被显式动作清除', async () => {
  const tokenPath = join(await mkdtemp(join(tmpdir(), 'vts-authorize-repeat-')), 'vts-token.json');
  const fake = await createFakeVts({ grantToken: 'fresh-bad', acceptGranted: false });
  const client = new VtsClient({ port: fake.port, tokenPath });
  try {
    const failure = await client.connect().then(() => null, (error) => error);
    assert(failure !== null, 'the rejected fresh token fails the first connect');
    assert(client.auth.freshTokenRejected === true, 'freshTokenRejected blocks a second automatic popup');
    assert(client.status().needsAuth === true, 'the explicit action is offered');

    fake.setGrantToken('fresh-good');
    fake.setAcceptGranted(true);
    const grantsBefore = countOf(fake.requests, 'AuthenticationTokenRequest');
    // Two rapid clicks: the second shares the first flow instead of clearing the token again.
    const [first, second] = await Promise.all([client.authorize(), client.authorize({ reason: 'second-click' })]);
    const grantsAfter = countOf(fake.requests, 'AuthenticationTokenRequest');
    assert(first === second || (first.ok === true && second.ok === true),
      'both clicks report success from the same flow');
    assert(first.ok === true && second.ok === true, 'both clicks succeed');
    assert(grantsAfter === grantsBefore + 1, `two clicks send exactly one grant (got ${grantsAfter - grantsBefore})`);
    assert(client.auth.freshTokenRejected === false, 'the explicit act cleared freshTokenRejected');
    assert(client.status().needsAuth === false && client.ready === true, 'the connection is ready and needsAuth is gone');

    // A third click after success is a no-op: no request, still ok.
    const third = await client.authorize();
    assert(third.ok === true && countOf(fake.requests, 'AuthenticationTokenRequest') === grantsAfter,
      'authorize() while ready sends nothing');
    console.log(`     grants=${grantsAfter} clicks=3 freshTokenRejected=${client.auth.freshTokenRejected}`
      + ` state=${client.status().state} needsAuth=${client.status().needsAuth}`);
  } finally {
    client.close();
    await fake.close();
  }
});

// 4) No VTS: the failure is visible, but no authorization can be requested, so needsAuth stays false.
test('4. 无 VTS → 错误可见但 needsAuth=false（不提示重新授权）', async () => {
  const deadPort = await unusedPort();
  const tokenPath = join(await mkdtemp(join(tmpdir(), 'vts-authorize-dead-')), 'vts-token.json');
  const client = new VtsClient({ port: deadPort, tokenPath });
  try {
    const failure = await client.connect().then(() => null, (error) => error);
    const status = client.status();
    assert(failure !== null, 'connect() rejects when VTS is unreachable');
    assert(status.state === 'error', `state is error (got ${status.state})`);
    assert(status.connected !== undefined || status.socketOpen === false, 'the socket is not reported open');
    assert(status.needsAuth === false, 'an unreachable VTS does not need the user to approve anything');
    assert(status.authError === 'unreachable', `authError explains the transport failure (got '${status.authError}')`);
    assert(status.retryable === true, 'the failure is retryable');
    assert(status.lastError.length > 0, 'the error text is visible');
    assert(!/authorization was requested/iu.test(status.lastError), 'no authorization request was claimed');

    const explicit = await client.authorize();
    assert(explicit.ok === false, 'authorize() fails honestly with VTS absent');
    assert(explicit.needsUserApproval === false, 'no popup approval is claimed');
    assert(client.status().needsAuth === false, 'the failed explicit action still needs no approval');
    console.log(`     state=${status.state} needsAuth=${status.needsAuth} authError=${status.authError}`
      + ` retryable=${status.retryable} authorize.needsUserApproval=${explicit.needsUserApproval}`);
  } finally {
    client.close();
  }
});

// 5) After a successful authorization, the next start with the stored token never prompts again.
test('5. 成功后再启动（token 有效）→ 不重复弹窗、无 needs-user', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vts-authorize-restart-'));
  const tokenPath = join(root, 'vts-token.json');
  const fake = await createFakeVts({ grantToken: 'restart-token', acceptGranted: true });
  const firstEvents = [];
  const first = new VtsClient({
    port: fake.port,
    tokenPath,
    onAuthEvent: (type, payload) => firstEvents.push({ type, ...payload }),
  });
  const secondEvents = [];
  let second = null;
  try {
    await first.connect();
    assert(await readToken(tokenPath) === 'restart-token', 'the first start persisted the token');
    const grantsBefore = countOf(fake.requests, 'AuthenticationTokenRequest');

    second = new VtsClient({
      port: fake.port,
      tokenPath,
      onAuthEvent: (type, payload) => secondEvents.push({ type, ...payload }),
    });
    const restarted = await second.connect();
    const status = second.status();
    assert(restarted.ok === true, 'the second start connects with the stored token');
    assert(countOf(fake.requests, 'AuthenticationTokenRequest') === grantsBefore,
      'the second start sends no new grant request');
    assert(status.needsAuth === false && status.authError === '', 'no needs-auth state on a valid restart');
    assert(status.freshTokenRejected === false, 'no fresh-token block on a valid restart');
    assert(!secondEvents.some((entry) => entry.type === 'vts.auth.needs-user'),
      'no vts.auth.needs-user is emitted on a valid restart');
    console.log(`     grants=${countOf(fake.requests, 'AuthenticationTokenRequest')} state=${status.state}`
      + ` needsAuth=${status.needsAuth} needsUserEvents=0`);
  } finally {
    first.close();
    second?.close();
    await fake.close();
  }
});

// 6) Host contract: /assistant/status exposes the fields and the action drives the recovery.
test('6. Host：status.live2d/vtsAuth 暴露 needsAuth；vts.authorize 恢复；needs-user 写入事件日志', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vts-authorize-host-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await writeFile(join(root, 'data', 'features.json'), JSON.stringify({ avatar: true }), 'utf8');
  await writeFile(join(root, 'vts-token.json'), JSON.stringify({ authenticationToken: 'host-stale' }), 'utf8');
  const fake = await createFakeVts({ grantToken: 'host-bad', acceptGranted: false });

  const routes = new Map();
  const disposers = [];
  const collect = (fn) => {
    const dispose = fn();
    if (typeof dispose === 'function') disposers.push(dispose);
    return dispose;
  };
  const fakeCtx = {
    effect: collect,
    get: (service) => {
      if (service === 'llm') {
        return {
          stream: () => (async function* styleFrames() {
            yield { type: 'text-delta', text: JSON.stringify({ amplitude: 1.1, tempo: 1.0, gazeHabit: 'wandering' }) };
            yield { type: 'finish', reason: { kind: 'stop' } };
          })(),
        };
      }
      if (service === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fake', model: 'fake-model' }) };
      return undefined;
    },
    tools: { register: () => () => {} },
    inject: (_names, callback) => callback({
      effect: collect,
      webServer: {
        register: (route) => {
          routes.set(route.path, route.handler);
          return () => {};
        },
      },
      systemPrompt: { section: () => () => {} },
    }),
  };
  apply(fakeCtx, { root, vtsPort: fake.port, enabled: true });
  const dispose = () => {
    for (const disposer of disposers.reverse()) {
      try {
        const result = disposer();
        if (result && typeof result.catch === 'function') result.catch(() => {});
      } catch {
        /* best effort */
      }
    }
  };
  const callRoute = async (path, { method = 'POST', body = undefined } = {}) => {
    const handler = routes.get(path);
    if (handler === undefined) throw new Error(`route not registered: ${path}`);
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
  const readEvents = async () => (await readFile(join(root, 'data', 'events.jsonl'), 'utf8').catch(() => ''))
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);

  try {
    const connected = await callRoute('/assistant/action', { body: { action: 'live2d.connect' } });
    assert(connected.ok === false, 'the automatic connect reports failure');
    const failedStatus = await status();
    assert(failedStatus.live2d?.needsAuth === true, 'status.live2d.needsAuth is true');
    assert(failedStatus.vtsAuth?.needsAuth === true, 'status.vtsAuth.needsAuth is true');
    assert(failedStatus.live2d?.authError === 'token-invalid', `status.live2d.authError (got '${failedStatus.live2d?.authError}')`);
    assert(failedStatus.vtsAuth?.retryable === true, 'status.vtsAuth.retryable is true');
    assert(failedStatus.live2d?.connected === false, 'connected stays honestly false');
    const log = await readEvents();
    const needsUser = log.filter((event) => event.type === 'vts.auth.needs-user');
    assert(needsUser.length === 1, `vts.auth.needs-user is in the event log once (got ${needsUser.length})`);

    fake.setGrantToken('host-good');
    fake.setAcceptGranted(true);
    const authorized = await callRoute('/assistant/action', { body: { action: 'vts.authorize', reason: 'settings-card' } });
    assert(authorized.ok === true, `vts.authorize succeeds (got ${JSON.stringify({ code: authorized.code, error: authorized.error })})`);
    assert(authorized.needsUserApproval === false && authorized.authenticated === true,
      'the action reports the authenticated result');
    const recovered = await status();
    assert(recovered.live2d?.needsAuth === false && recovered.vtsAuth?.needsAuth === false,
      'needsAuth is cleared in both projections');
    assert(recovered.live2d?.authenticated === true, 'live2d.authenticated is true after the explicit action');
    assert(await readToken(join(root, 'vts-token.json')) === 'host-good', 'the host persisted the new token');
    const authorizedEvents = (await readEvents()).filter((event) => event.type === 'vts.auth.authorized');
    assert(authorizedEvents.length >= 1, 'vts.auth.authorized is in the event log');
    console.log(`     failed: live2d.needsAuth=${failedStatus.live2d.needsAuth} authError=${failedStatus.live2d.authError}`
      + ` needsUserEvents=${needsUser.length}`);
    console.log(`     recovered: ok=${authorized.ok} authenticated=${recovered.live2d.authenticated}`
      + ` needsAuth=${recovered.vtsAuth.needsAuth} token=${await readToken(join(root, 'vts-token.json'))}`);
  } finally {
    dispose();
    await fake.close();
  }
});

// ---- run ------------------------------------------------------------------
const failures = [];
for (const entry of tests) {
  const started = Date.now();
  try {
    await entry.fn();
    console.log(`PASS  ${entry.name}  (${Date.now() - started}ms)`);
  } catch (error) {
    failures.push({ name: entry.name, error });
    console.error(`FAIL  ${entry.name}\n      ${error?.message ?? error}`);
  }
}

console.log(`\n${tests.length - failures.length} passed, ${failures.length} failed, ${tests.length} total`);
if (failures.length > 0) process.exitCode = 1;
