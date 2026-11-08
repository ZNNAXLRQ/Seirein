/**
 * VTS authorization state machine (pure client, fake VTS, no real VTube Studio contacted).
 *
 * The live bug: after the user clicked Allow, the authorization request/wait/failure was invisible,
 * and a rejected or missing token could make the plugin ask again on every connect. The contract
 * under test is:
 *
 *   - a valid stored token: connecting → ready, never requesting-grant;
 *   - no token / rejected token: requesting-grant, exactly one AuthenticationTokenRequest, and
 *     repeated connect()/timeout never sends another one;
 *   - a refused grant: token-invalid, no automatic reconnect; only retry() asks again;
 *   - a connection failure: error (never disguised as a grant wait); a lost socket: disconnected
 *     with backed-off automatic reconnect, but never while requesting-grant / token-invalid;
 *   - a granted token is written atomically and reused on the next start; a failed write is
 *     visible and never reported as ready.
 *
 * The state-machine events are delivered on `onAuthEvent` (not `onEvent`), because the legacy
 * vts-* suites assert the legacy onEvent auth sequence exactly. `mirrorAuthEvents: true` mirrors
 * them into onEvent as well.
 *
 * Run: node test/vts-auth-state.mjs
 */
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WebSocketServer } from 'ws';

import { VtsClient } from '../src/host/avatar/vts.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (check, timeoutMs = 3000, stepMs = 20) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await sleep(stepMs);
  }
  return false;
};

const assert = (condition, message) => {
  if (!condition) throw new Error(`assertion failed: ${message}`);
};

const tmp = (name) => mkdtemp(join(tmpdir(), `vts-auth-state-${name}-`));

const seedToken = async (name, token) => {
  const root = await tmp(name);
  const tokenPath = join(root, 'vts-token.json');
  await writeFile(tokenPath, JSON.stringify({ authenticationToken: token }, null, 2), 'utf8');
  return { root, tokenPath };
};

const countOf = (requests, type) => requests.filter((entry) => entry.type === type).length;

const stateTrace = (events) => events
  .filter((entry) => entry.type === 'vts.auth.state')
  .map((entry) => `${entry.from}>${entry.to}:${entry.reason}`);

const unusedPort = async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
};

// ---- fake VTS -------------------------------------------------------------
/**
 * Minimal fake VTube Studio focused on authorization. `grantMode` covers the three real answers
 * to AuthenticationTokenRequest: grant, explicit refusal (APIError), and an empty grant; 'none'
 * withholds the answer so the wait-timeout path is deterministic. `grantDelayMs` keeps the popup
 * window open long enough to observe requesting-grant and concurrent connects.
 */
async function createFakeVts({
  validTokens = [],
  grantToken = 'grant-token',
  grantDelayMs = 0,
  grantMode = 'grant',
  authMode = 'strict',
  autoAddGranted = true,
} = {}) {
  const valid = new Set(validTokens);
  const state = { grantToken, grantDelayMs, grantMode, authMode, autoAddGranted };
  const requests = [];
  const connections = [];
  let active = 0;
  let maxConcurrent = 0;

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
  const respondError = (socket, request, message, errorID = 50) => send(socket, {
    apiName: 'VTubeStudioPublicAPI',
    apiVersion: '1.0',
    requestID: request.requestID,
    messageType: 'APIError',
    data: { errorID, message },
  });

  wss.on('connection', (socket) => {
    connections.push({ at: Date.now() });
    active += 1;
    if (active > maxConcurrent) maxConcurrent = active;
    socket.on('close', () => { active -= 1; });
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
        pluginName: request.data?.pluginName ?? null,
        at: Date.now(),
      });
      switch (request.messageType) {
        case 'AuthenticationTokenRequest':
          if (state.grantMode === 'none') return;
          if (state.grantDelayMs > 0) await sleep(state.grantDelayMs);
          if (state.grantMode === 'deny') {
            respondError(socket, request, 'the user denied the plugin authorization');
            return;
          }
          if (state.grantMode === 'empty') {
            respond(socket, request, { authenticationToken: '' });
            return;
          }
          if (state.autoAddGranted) valid.add(state.grantToken);
          respond(socket, request, { authenticationToken: state.grantToken });
          return;
        case 'AuthenticationRequest': {
          const token = String(request.data?.authenticationToken ?? '');
          if (state.authMode === 'reject') {
            respond(socket, request, { authenticated: false, reason: 'token is invalid or has been revoked by the user' });
            return;
          }
          if (valid.has(token)) {
            respond(socket, request, { authenticated: true });
            return;
          }
          respond(socket, request, { authenticated: false, reason: 'token is invalid or has been revoked by the user' });
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
        state,
        get connections() { return connections.length; },
        get active() { return active; },
        get maxConcurrent() { return maxConcurrent; },
        setGrantMode(mode) { state.grantMode = mode; },
        setGrantToken(token) { state.grantToken = token; },
        disconnect() {
          for (const socket of wss.clients) socket.terminate();
        },
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

const newClient = (fake, tokenPath, options = {}) => new VtsClient({
  port: fake.port,
  tokenPath,
  ...options,
});

// ---- test runner ----------------------------------------------------------
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// 1) A valid token must go connecting → ready without ever entering requesting-grant.
test('1. 有有效 token → connecting→ready，不出现 requesting-grant', async () => {
  const { tokenPath } = await seedToken('valid', 'good-token');
  const fake = await createFakeVts({ validTokens: ['good-token'] });
  const events = [];
  const legacy = [];
  const client = newClient(fake, tokenPath, {
    onAuthEvent: (type, payload) => events.push({ type, ...payload }),
    onEvent: (type) => legacy.push(type),
  });
  try {
    const result = await client.connect();
    const status = client.status();
    const trace = stateTrace(events);
    assert(result.ok === true, 'connect succeeds with a stored valid token');
    assert(trace.includes('disconnected>connecting:connect'), `connecting is entered (got ${trace.join(' | ')})`);
    assert(trace.includes('connecting>ready:authenticated'), `ready is entered from connecting (got ${trace.join(' | ')})`);
    assert(!trace.some((entry) => entry.includes('>requesting-grant')), 'requesting-grant is never entered');
    assert(status.state === 'ready', `status.state is ready (got ${status.state})`);
    assert(status.tokenPresent === true, 'status.tokenPresent is true');
    assert(status.attempts === 0, `no grant attempt is counted (got ${status.attempts})`);
    assert(status.pluginName === 'DSH Companion', `status exposes the stable pluginName (got ${status.pluginName})`);
    assert(countOf(fake.requests, 'AuthenticationRequest') === 1, 'exactly one AuthenticationRequest');
    assert(countOf(fake.requests, 'AuthenticationTokenRequest') === 0, 'zero AuthenticationTokenRequest');
    assert(
      events.some((entry) => entry.type === 'vts.auth.token' && entry.ok === true && entry.action === 'read'),
      'the stored token read is reported as vts.auth.token {ok:true}',
    );
    assert(legacy.length === 0, `the legacy onEvent auth sequence is untouched (got ${legacy.join(',')})`);
    console.log(`     trace: ${trace.join(' | ')}`);
    console.log(`     state=${status.state} tokenPresent=${status.tokenPresent} attempts=${status.attempts}`
      + ` authRequests=${countOf(fake.requests, 'AuthenticationRequest')} tokenRequests=0`);
  } finally {
    client.close();
    await fake.close();
  }
});

// 2) No token: one grant request, then repeated connect() shares the wait instead of asking again.
test('2. 无 token → requesting-grant；重复 connect 不新增请求；身份变化不改状态', async () => {
  const tokenPath = join(await tmp('no-token'), 'vts-token.json');
  // A corrupt token file is the same "no usable token" path and must be visible, not silent.
  await writeFile(tokenPath, '{ this is not valid json', 'utf8');
  const fake = await createFakeVts({ grantDelayMs: 400, grantToken: 'granted-1' });
  const events = [];
  const client = newClient(fake, tokenPath, {
    grantTimeoutMs: 5000,
    onAuthEvent: (type, payload) => events.push({ type, ...payload }),
  });
  try {
    const first = client.connect();
    await waitFor(() => client.status().state === 'requesting-grant', 1000, 10);
    assert(client.status().state === 'requesting-grant', 'no token reaches requesting-grant');
    assert(client.status().tokenPresent === false, 'a corrupt token file does not count as a token');
    const readFailure = events.find((entry) => entry.type === 'vts.auth.token'
      && entry.ok === false && entry.action === 'read');
    assert(readFailure !== undefined && /token read failed/iu.test(readFailure.error),
      'the corrupt token read is reported as vts.auth.token {ok:false}');
    const second = client.connect();
    const third = client.connect();
    assert(second === first && third === first, 'repeated connect() shares the in-flight promise');
    assert(countOf(fake.requests, 'AuthenticationTokenRequest') === 1, 'only one grant request is sent');

    // A plugin-name change is visible in status but is never a reason to request again.
    const beforeIdentity = fake.requests.length;
    client.setPluginIdentity({ pluginName: 'Renamed Companion', pluginDeveloper: 'local' });
    const identityStatus = client.status();
    assert(identityStatus.pluginName === 'Renamed Companion', 'status reflects the new pluginName');
    assert(identityStatus.pluginChanged === true, 'status records pluginChanged');
    assert(fake.requests.length === beforeIdentity, 'identity change sends no new request');
    assert(identityStatus.attempts === 1, 'identity change keeps the attempt count');

    const results = await Promise.all([first, second, third]);
    assert(results.every((entry) => entry.ok === true), 'every concurrent connect succeeds');
    const status = client.status();
    assert(status.state === 'ready', `the shared wait ends ready (got ${status.state})`);
    assert(status.attempts === 1, `one grant attempt total (got ${status.attempts})`);
    assert(countOf(fake.requests, 'AuthenticationTokenRequest') === 1, 'still one grant request');
    assert(countOf(fake.requests, 'AuthenticationRequest') === 1, 'one AuthenticationRequest');
    console.log(`     tokenRequests=${countOf(fake.requests, 'AuthenticationTokenRequest')}`
      + ` authRequests=${countOf(fake.requests, 'AuthenticationRequest')} attempts=${status.attempts}`
      + ` pluginName=${status.pluginName} pluginChanged=${status.pluginChanged}`);
  } finally {
    client.close();
    await fake.close();
  }
});

// 3) A refused grant is token-invalid; only user retry() may ask again.
test('3. 用户拒绝 → token-invalid，不自动重连；retry() 才重新请求', async () => {
  const tokenPath = join(await tmp('denied'), 'vts-token.json');
  const fake = await createFakeVts({ grantMode: 'deny', grantToken: 'after-retry' });
  const events = [];
  const client = newClient(fake, tokenPath, {
    autoReconnect: true,
    reconnectBaseMs: 50,
    onAuthEvent: (type, payload) => events.push({ type, ...payload }),
  });
  try {
    const refusal = await client.connect().then(() => null, (error) => error);
    assert(refusal !== null, 'the refused grant rejects connect()');
    let status = client.status();
    assert(status.state === 'token-invalid', `state is token-invalid (got ${status.state})`);
    assert(countOf(fake.requests, 'AuthenticationTokenRequest') === 1, 'one grant request was sent');
    assert(status.reconnect.scheduled === 0, 'no automatic reconnect is scheduled');
    assert(status.autoReconnectAllowed === false, 'automatic reconnect is forbidden in token-invalid');

    const before = fake.requests.length;
    const gated = await client.connect().then(() => null, (error) => error);
    assert(gated?.code === 'TOKEN_INVALID', `a plain connect() is gated with TOKEN_INVALID (got ${gated?.code})`);
    assert(fake.requests.length === before, 'a gated connect() sends no request');
    assert(client.status().state === 'token-invalid', 'the gated connect() keeps token-invalid');

    fake.setGrantMode('grant');
    const retried = await client.retry();
    assert(retried.ok === true, 'retry() succeeds after the user allows the grant');
    status = client.status();
    assert(status.state === 'ready', `retry() reaches ready (got ${status.state})`);
    assert(countOf(fake.requests, 'AuthenticationTokenRequest') === 2, 'retry() is the second grant request');
    assert(status.retries === 1, 'one explicit retry is counted');
    const retryEvent = events.find((entry) => entry.type === 'vts.auth.retry');
    assert(retryEvent !== undefined && retryEvent.reason === 'user', 'vts.auth.retry {reason:user} is emitted');
    const trace = stateTrace(events);
    assert(trace.some((entry) => entry.includes('>token-invalid:')), `token-invalid is a visible transition (${trace.join(' | ')})`);
    assert(trace.includes('token-invalid>connecting:retry'), 'retry() leaves token-invalid explicitly');
    console.log(`     state=${status.state} tokenRequests=2 retries=${status.retries}`
      + ` trace=${trace.join(' | ')}`);
  } finally {
    client.close();
    await fake.close();
  }
});

// 4) Transport failure is error; a lost socket is disconnected with exponential backoff.
test('4. 连接失败 → error；断开 → disconnected 且有退避（不立即风暴）', async () => {
  const deadPort = await unusedPort();
  const deadClient = new VtsClient({
    port: deadPort,
    tokenPath: join(await tmp('connect-fail'), 'vts-token.json'),
  });
  try {
    const failure = await deadClient.connect().then(() => null, (error) => error);
    const status = deadClient.status();
    assert(failure !== null, 'connect() rejects when VTS is unreachable');
    assert(status.state === 'error', `connection failure is error (got ${status.state})`);
    assert(status.ready === false && status.socketOpen === false, 'a failed connection is not ready');
    assert(status.lastError.length > 0, 'the connection error is recorded');
    console.log(`     connect-failure state=${status.state} code=${failure?.code ?? '(none)'} lastError=${status.lastError.slice(0, 60)}`);
  } finally {
    deadClient.close();
  }

  const { tokenPath } = await seedToken('backoff', 'backoff-token');
  const fake = await createFakeVts({ validTokens: ['backoff-token'] });
  const client = new VtsClient({
    port: fake.port,
    tokenPath,
    autoReconnect: true,
    reconnectBaseMs: 150,
    reconnectMaxMs: 600,
  });
  try {
    await client.connect();
    assert(client.status().state === 'ready', 'the backoff client is ready first');
    const connectionsBefore = fake.connections;

    fake.disconnect();
    const disconnected = await waitFor(() => client.status().state === 'disconnected', 1000, 10);
    assert(disconnected === true, 'the lost socket moves to disconnected');
    const status = client.status();
    assert(status.reconnect.scheduled >= 1, 'a reconnect is scheduled');
    assert(status.reconnect.lastDelayMs === 150, `the first backoff is the base delay (got ${status.reconnect.lastDelayMs})`);
    await sleep(40);
    assert(fake.connections === connectionsBefore, 'no immediate dial inside the backoff window');

    // Take the listener away before the timer fires: the automatic attempt fails and must back off
    // again (150 → 300), never spin.
    await fake.close();
    const grew = await waitFor(() => client.status().reconnect.delays.length >= 2, 2000, 20);
    const after = client.status();
    assert(grew === true, `a failed automatic attempt schedules the next one (delays=${after.reconnect.delays.join(',')})`);
    assert(after.reconnect.delays[0] === 150 && after.reconnect.delays[1] === 300,
      `delays grow exponentially (got ${after.reconnect.delays.join(',')})`);
    assert(after.state === 'error', `a failed automatic attempt is error, not fake-ready (got ${after.state})`);
    console.log(`     disconnect→state=disconnected delay=${status.reconnect.lastDelayMs}`
      + ` then delays=${after.reconnect.delays.join(',')} state=${after.state}`);
  } finally {
    client.close();
    await fake.close();
  }
});

// 5) A granted token is written atomically and reused by the next client without a popup.
test('5. 授权成功 → token 原子写入；再次启动直接 ready', async () => {
  const root = await tmp('persist');
  const tokenPath = join(root, 'vts-token.json');
  const fake = await createFakeVts({ grantToken: 'persisted-token' });
  const firstEvents = [];
  const first = newClient(fake, tokenPath, {
    onAuthEvent: (type, payload) => firstEvents.push({ type, ...payload }),
  });
  const secondEvents = [];
  let second = null;
  try {
    const result = await first.connect();
    assert(result.ok === true, 'the first start connects');
    const saved = JSON.parse(await readFile(tokenPath, 'utf8'));
    assert(saved.authenticationToken === 'persisted-token', `the granted token is persisted (got ${saved.authenticationToken})`);
    const files = await readdir(root);
    assert(files.every((name) => !name.includes('.tmp-')), `no temp file is left behind (${files.join(',')})`);
    assert(files.includes('vts-token.json'), 'the token file itself exists');
    assert(first.status().tokenPresent === true, 'status reports the persisted token');
    const writes = firstEvents.filter((entry) => entry.type === 'vts.auth.token' && entry.action === 'write');
    assert(writes.length === 1 && writes[0].ok === true, 'one successful token write event');

    const grantsBefore = countOf(fake.requests, 'AuthenticationTokenRequest');
    second = newClient(fake, tokenPath, {
      onAuthEvent: (type, payload) => secondEvents.push({ type, ...payload }),
    });
    const restarted = await second.connect();
    const trace = stateTrace(secondEvents);
    assert(restarted.ok === true, 'the second start connects with the stored token');
    assert(countOf(fake.requests, 'AuthenticationTokenRequest') === grantsBefore,
      'the second start sends no new grant request');
    assert(second.status().state === 'ready', 'the second start is ready');
    assert(second.status().attempts === 0, 'the second start has zero grant attempts');
    assert(second.token === 'persisted-token', 'the second client loaded the same token');
    assert(!trace.some((entry) => entry.includes('>requesting-grant')), 'the second start never requests a grant');
    console.log(`     token=${saved.authenticationToken} files=${files.join(',')}`
      + ` grants=${countOf(fake.requests, 'AuthenticationTokenRequest')} secondState=${second.status().state}`);
  } finally {
    first.close();
    second?.close();
    await fake.close();
  }
});

// 6) A failed token write is recorded, visible, and never reported as ready.
test('6. token 写入失败 → 记录错误，状态不假装 ready', async () => {
  const root = await tmp('write-fail');
  // Point tokenPath at a directory: the atomic rename over it must fail, while the temp file is
  // still written and then cleaned up.
  const blockedPath = join(root, 'token-as-directory');
  await mkdir(blockedPath);
  const fake = await createFakeVts({ grantToken: 'cannot-persist' });
  const events = [];
  const client = newClient(fake, blockedPath, {
    onAuthEvent: (type, payload) => events.push({ type, ...payload }),
  });
  try {
    const failure = await client.connect().then(() => null, (error) => error);
    const status = client.status();
    assert(failure !== null, 'connect() rejects when the token cannot be written');
    assert(failure?.code === 'TOKEN_WRITE_FAILED', `the error is coded TOKEN_WRITE_FAILED (got ${failure?.code})`);
    assert(status.state === 'error', `state is error, never ready (got ${status.state})`);
    assert(status.ready === false && status.authenticated === false, 'ready/authenticated stay false');
    assert(/token write failed/iu.test(status.lastError), `lastError records the write failure (got ${status.lastError})`);
    assert(/token write failed/iu.test(status.tokenError), `tokenError records the write failure (got ${status.tokenError})`);
    assert(client.token === '', 'the unwritten token is not kept in memory as usable');
    const tokenFailure = events.find((entry) => entry.type === 'vts.auth.token'
      && entry.ok === false && entry.action === 'write');
    assert(tokenFailure !== undefined, 'a vts.auth.token {ok:false} event is emitted');
    assert((await stat(blockedPath)).isDirectory(), 'the token target was not corrupted');
    const leftovers = (await readdir(root)).filter((name) => name.includes('.tmp-'));
    assert(leftovers.length === 0, `the temp file is cleaned up (${leftovers.join(',')})`);
    console.log(`     state=${status.state} code=${failure.code} lastError=${status.lastError.slice(0, 70)}`);
  } finally {
    client.close();
    await fake.close();
  }
});

// 7) A slow grant keeps requesting-grant and never sends a second request by itself.
test('7. 等待授权超时 → 保持 requesting-grant，不重发', async () => {
  const tokenPath = join(await tmp('timeout'), 'vts-token.json');
  const fake = await createFakeVts({ grantMode: 'none' });
  const events = [];
  const client = newClient(fake, tokenPath, {
    grantTimeoutMs: 150,
    onAuthEvent: (type, payload) => events.push({ type, ...payload }),
  });
  try {
    const failure = await client.connect().then(() => null, (error) => error);
    let status = client.status();
    assert(failure?.code === 'AWAITING_GRANT', `the timeout is coded AWAITING_GRANT (got ${failure?.code})`);
    assert(status.state === 'requesting-grant', `the state stays requesting-grant (got ${status.state})`);
    assert(countOf(fake.requests, 'AuthenticationTokenRequest') === 1, 'exactly one grant request');
    const before = fake.requests.length;
    const again = await client.connect().then(() => null, (error) => error);
    assert(again?.code === 'AWAITING_GRANT', 'a repeated connect() is gated, not re-sent');
    assert(fake.requests.length === before, 'the repeated connect() sends nothing');
    await sleep(250);
    status = client.status();
    assert(status.state === 'requesting-grant', `the state is still requesting-grant (got ${status.state})`);
    assert(countOf(fake.requests, 'AuthenticationTokenRequest') === 1, 'no grant was re-sent after the timeout');
    assert(/timed out/iu.test(status.lastError), `lastError records the timeout (got ${status.lastError})`);
    const timeoutEvent = events.find((entry) => entry.type === 'vts.auth.timeout');
    assert(timeoutEvent !== undefined && timeoutEvent.timeoutMs === 150, 'vts.auth.timeout records the wait');
    const requested = events.filter((entry) => entry.type === 'vts.auth.requested');
    assert(requested.length === 1 && requested[0].attempt === 1, 'vts.auth.requested {attempt:1} was emitted once');
    console.log(`     state=${status.state} tokenRequests=1 timeoutMs=${timeoutEvent.timeoutMs}`
      + ` timeoutEvents=${events.filter((entry) => entry.type === 'vts.auth.timeout').length}`);
  } finally {
    client.close();
    await fake.close();
  }
});

// 8) Concurrent connect() must produce exactly one grant and one AuthenticationRequest.
test('8. 并发 connect 只发一次认证请求', async () => {
  const tokenPath = join(await tmp('concurrent'), 'vts-token.json');
  const fake = await createFakeVts({ grantDelayMs: 150, grantToken: 'concurrent-token' });
  const client = newClient(fake, tokenPath, { grantTimeoutMs: 3000 });
  try {
    const results = await Promise.all(Array.from({ length: 6 }, () => client.connect()));
    const status = client.status();
    assert(results.every((entry) => entry.ok === true), 'all concurrent connects succeed');
    assert(countOf(fake.requests, 'AuthenticationTokenRequest') === 1,
      `one grant request (got ${countOf(fake.requests, 'AuthenticationTokenRequest')})`);
    assert(countOf(fake.requests, 'AuthenticationRequest') === 1,
      `one AuthenticationRequest (got ${countOf(fake.requests, 'AuthenticationRequest')})`);
    assert(status.state === 'ready', 'the shared connection is ready');
    assert(status.attempts === 1, `status.attempts is 1 (got ${status.attempts})`);
    assert(fake.maxConcurrent === 1, `VTS never saw overlapping connections (peak ${fake.maxConcurrent})`);
    console.log(`     concurrent=6 tokenRequests=1 authRequests=1 attempts=${status.attempts} state=${status.state}`);
  } finally {
    client.close();
    await fake.close();
  }
});

// 9) close() while loadToken() is still reading: the late read must not dial or become ready.
test('9. 读取令牌期间 close → 不开连接、connect 返回 cancelled、状态非 ready', async () => {
  const tokenPath = join(await tmp('cancel-load'), 'vts-token.json');
  const fake = await createFakeVts({ grantToken: 'never-used' });
  const events = [];
  const client = newClient(fake, tokenPath, {
    onAuthEvent: (type, payload) => events.push({ type, ...payload }),
  });
  // Delay the real read so close() lands inside the await that used to escape every epoch check.
  const originalLoad = client.loadToken.bind(client);
  let reading = false;
  client.loadToken = async (epoch) => {
    reading = true;
    await sleep(120);
    return originalLoad(epoch);
  };
  try {
    const pending = client.connect();
    assert(await waitFor(() => reading, 1000, 5), 'loadToken() actually started');
    client.close();
    const outcome = await pending.then(() => null, (error) => error);
    const status = client.status();
    assert(outcome?.code === 'VTS_AUTH_CANCELLED', `connect() rejects with VTS_AUTH_CANCELLED (got ${outcome?.code})`);
    assert(status.state !== 'ready' && status.ready === false, `the cancelled connect is not ready (got ${status.state})`);
    assert(status.socketOpen === false && client.socket === null, 'no socket was adopted');
    assert(fake.connections === 0, `no socket was ever dialed (connections=${fake.connections})`);
    assert(countOf(fake.requests, 'AuthenticationTokenRequest') === 0, 'no grant was requested after close');
    const cancelled = events.filter((entry) => entry.type === 'vts.auth.cancelled');
    assert(cancelled.length === 1 && cancelled[0].reason === 'closed',
      `vts.auth.cancelled {reason:'closed'} is emitted once (got ${JSON.stringify(cancelled)})`);
    console.log(`     code=${outcome.code} state=${status.state} connections=${fake.connections}`
      + ` cancelled=${cancelled.length} reason=${cancelled[0].reason}`);
  } finally {
    client.close();
    await fake.close();
  }
});

// 10) close() while the grant is being persisted: cancel, never promote the write to state.
test('10. 授权持久化等待期间 close → 取消，写入不影响状态', async () => {
  const root = await tmp('cancel-write');
  const tokenPath = join(root, 'vts-token.json');
  const fake = await createFakeVts({ grantToken: 'late-token' });
  const events = [];
  const client = newClient(fake, tokenPath, {
    onAuthEvent: (type, payload) => events.push({ type, ...payload }),
  });
  // Delay the atomic write so close() lands between AuthenticationTokenRequest and saveToken().
  const originalWrite = client.writeTokenFile.bind(client);
  let writing = false;
  client.writeTokenFile = async (value) => {
    writing = true;
    await sleep(120);
    return originalWrite(value);
  };
  try {
    const pending = client.connect();
    assert(await waitFor(() => writing, 2000, 5), 'the granted token reached the write step');
    client.close();
    const outcome = await pending.then(() => null, (error) => error);
    const status = client.status();
    assert(outcome?.code === 'VTS_AUTH_CANCELLED', `connect() rejects with VTS_AUTH_CANCELLED (got ${outcome?.code})`);
    assert(status.state === 'disconnected', `the closed state survives the late write (got ${status.state})`);
    assert(status.ready === false && status.authenticated === false && status.socketOpen === false,
      'the cancelled grant is not reported as usable');
    assert(client.token === '', 'the late-persisted token is not adopted in memory');
    const writeOk = events.filter((entry) => entry.type === 'vts.auth.token'
      && entry.action === 'write' && entry.ok === true);
    assert(writeOk.length === 0, 'no successful token-write event leaks out of the cancelled flow');
    const cancelled = events.filter((entry) => entry.type === 'vts.auth.cancelled');
    assert(cancelled.length === 1 && cancelled[0].reason === 'closed',
      `vts.auth.cancelled {reason:'closed'} is emitted once (got ${JSON.stringify(cancelled)})`);
    let onDisk = '(absent)';
    try {
      onDisk = JSON.parse(await readFile(tokenPath, 'utf8')).authenticationToken;
    } catch {
      /* the write may have been abandoned; either outcome is fine as long as state is untouched */
    }
    console.log(`     code=${outcome.code} state=${status.state} memoryToken='${client.token}'`
      + ` diskToken='${onDisk}' writeEvents=${writeOk.length}`);
  } finally {
    client.close();
    await fake.close();
  }
});

// 11) After close(), an explicit connect() is a new epoch and must reach ready normally.
test('11. close 后显式 connect → 正常 ready（新代次）', async () => {
  const { tokenPath } = await seedToken('new-epoch', 'stable-token');
  const fake = await createFakeVts({ validTokens: ['stable-token'] });
  const events = [];
  const client = newClient(fake, tokenPath, {
    onAuthEvent: (type, payload) => events.push({ type, ...payload }),
  });
  // Only the first attempt is slow; the explicit reconnect reads normally and must not be blocked
  // by the old connectPromise or cleared by the first attempt settling late.
  const originalLoad = client.loadToken.bind(client);
  let loads = 0;
  client.loadToken = async (epoch) => {
    loads += 1;
    if (loads === 1) await sleep(150);
    return originalLoad(epoch);
  };
  try {
    const first = client.connect();
    // Attach the outcome handler now: the cancelled promise may reject while the reconnect runs.
    const firstOutcome = first.then(() => null, (error) => error);
    assert(await waitFor(() => loads === 1, 1000, 5), 'the first connect started reading the token');
    client.close();
    const second = client.connect();
    assert(second !== first, 'connect() after close() is a fresh attempt, not the cancelled promise');
    const secondResult = await second;
    assert(secondResult.ok === true, 'the explicit reconnect succeeds');
    assert(client.status().state === 'ready', `the new epoch is ready (got ${client.status().state})`);
    const firstError = await firstOutcome;
    assert(firstError?.code === 'VTS_AUTH_CANCELLED', `the old attempt is cancelled (got ${firstError?.code})`);
    assert(client.status().state === 'ready' && client.ready === true,
      'the old attempt settling does not clear the new ready state');
    assert(fake.connections === 1, `only the new connection was dialed (connections=${fake.connections})`);
    assert(countOf(fake.requests, 'AuthenticationRequest') === 1, 'the new connection authenticated once');
    const cancelled = events.filter((entry) => entry.type === 'vts.auth.cancelled');
    assert(cancelled.length === 1 && cancelled[0].reason === 'closed',
      `only the cancelled attempt reports cancellation (got ${JSON.stringify(cancelled)})`);
    console.log(`     first=${firstError.code} secondState=${client.status().state}`
      + ` connections=${fake.connections} authRequests=${countOf(fake.requests, 'AuthenticationRequest')}`);
  } finally {
    client.close();
    await fake.close();
  }
});

// 12) A late result from the cancelled attempt must not touch the newer socket or its state.
test('12. 旧调用迟到完成 → 不清理新 socket、不改状态', async () => {
  const { tokenPath } = await seedToken('late-old', 'stable-token');
  const fake = await createFakeVts({ validTokens: ['stable-token'] });
  const client = newClient(fake, tokenPath);
  // Hold the first attempt after its AuthenticationRequest answered: close() then replaces it, and
  // the late answer resumes exactly where a missing epoch check would have carried on to ready.
  const originalAttempt = client.attemptAuth.bind(client);
  let firstAnswer = null;
  let attemptCalls = 0;
  let holding = false;
  client.attemptAuth = async () => {
    attemptCalls += 1;
    const result = await originalAttempt();
    if (attemptCalls === 1) {
      holding = true;
      firstAnswer = result;
      await sleep(1200);
    }
    return result;
  };
  try {
    const first = client.connect();
    // Attach the outcome handler now: the cancelled promise may reject while the replacement runs.
    const firstOutcome = first.then(() => null, (error) => error);
    assert(await waitFor(() => holding, 3000, 5), 'the first attempt is holding its answered AuthenticationRequest');
    client.close();
    const secondResult = await client.connect();
    assert(secondResult.ok === true, 'the replacement connect succeeds');
    const newSocket = client.socket;
    assert(newSocket !== null && client.connected === true, 'the replacement socket is open');
    const stateBefore = client.status().state;
    // The first attempt's hold is longer than a whole connect: it settles only after the new epoch
    // is ready, which is exactly the late result that used to be able to disturb it.
    const firstResult = await firstOutcome;
    assert(firstResult?.code === 'VTS_AUTH_CANCELLED', `the late answer is cancelled (got ${firstResult?.code})`);
    assert(client.socket === newSocket, 'the late cancelled attempt did not replace the new socket');
    assert(client.connected === true && client.status().state === 'ready',
      `the new connection is still ready (state before=${stateBefore}, after=${client.status().state})`);
    assert(client.ready === true && client.authenticated === true, 'ready/authenticated stay true');
    assert(fake.active === 1, `only the new socket is still live (active=${fake.active})`);
    assert(firstAnswer?.ok === true, 'the first AuthenticationRequest really was answered before close');
    console.log(`     first=${firstResult.code} newSocketKept=${client.socket === newSocket}`
      + ` state=${client.status().state} activeSockets=${fake.active}`);
  } finally {
    client.close();
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
