/**
 * VTS token recovery checks (fake VTS, no real VTube Studio contacted).
 *
 * The bug: a persisted authenticationToken that VTS rejected made connect() throw forever, so the
 * user saw "token is invalid or has been revoked" and had to delete the file by hand. The fixed
 * contract is: reject → clear token → AuthenticationTokenRequest (VTS popup) → persist → retry
 * exactly once → either connect or AUTH_RETRY_FAILED.
 *
 * Run: node test/vts-auth-recovery.mjs
 */
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WebSocketServer } from 'ws';

import { VtsClient } from '../src/host/avatar/vts.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (condition, message) => {
  if (!condition) throw new Error(`assertion failed: ${message}`);
};

const REVOKED_TEXT = 'Authentication request failed because token is invalid or has been revoked by the user.';

/**
 * Fake VTS focused on the auth handshake. `state.requests` records every message in arrival order,
 * which is what the recovery contract is judged on. `tokenDelayMs` keeps the grant window open so
 * `authPending` is observable; `rejectMode` covers both rejection shapes VTS uses.
 */
async function createFakeVts({
  validTokens = [],
  grantToken = 'new-token',
  acceptRenewed = true,
  rejectMode = 'reason',
  tokenDelayMs = 0,
  onTokenRequest = null,
} = {}) {
  const valid = new Set(validTokens);
  const state = { requests: [], grantToken, acceptRenewed, rejectMode, tokenDelayMs };
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
    socket.on('message', async (raw) => {
      let request;
      try {
        request = JSON.parse(String(raw));
      } catch {
        return;
      }
      state.requests.push({
        type: String(request.messageType ?? ''),
        token: request.data?.authenticationToken ?? null,
      });
      switch (request.messageType) {
        case 'AuthenticationTokenRequest':
          if (typeof onTokenRequest === 'function') await onTokenRequest();
          if (state.tokenDelayMs > 0) await sleep(state.tokenDelayMs);
          if (state.acceptRenewed) valid.add(state.grantToken);
          respond(socket, request, { authenticationToken: state.grantToken });
          return;
        case 'AuthenticationRequest': {
          const token = String(request.data?.authenticationToken ?? '');
          if (valid.has(token)) {
            respond(socket, request, { authenticated: true });
            return;
          }
          if (state.rejectMode === 'apiError') {
            send(socket, {
              apiName: 'VTubeStudioPublicAPI',
              apiVersion: '1.0',
              requestID: request.requestID,
              messageType: 'APIError',
              data: { errorID: 50, message: REVOKED_TEXT },
            });
            return;
          }
          respond(socket, request, {
            authenticated: false,
            reason: 'token is invalid or has been revoked by the user',
          });
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

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        state,
        requests: state.requests,
        addValid(token) {
          valid.add(token);
        },
        close() {
          for (const socket of wss.clients) socket.terminate();
          return new Promise((done) => wss.close(() => server.close(() => done())));
        },
      });
    });
  });
}

const seedToken = async (name, token) => {
  const root = await mkdtemp(join(tmpdir(), `vts-auth-${name}-`));
  const tokenPath = join(root, 'vts-token.json');
  await writeFile(tokenPath, JSON.stringify({ authenticationToken: token }, null, 2), 'utf8');
  return { root, tokenPath };
};

const readToken = async (tokenPath) => JSON.parse(await readFile(tokenPath, 'utf8')).authenticationToken;

const authOrder = (requests) => requests
  .filter((entry) => entry.type === 'AuthenticationRequest' || entry.type === 'AuthenticationTokenRequest')
  .map((entry) => entry.type);

const countOf = (requests, type) => requests.filter((entry) => entry.type === type).length;

// ---- test runner ----------------------------------------------------------
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// 1) The core bug: a revoked saved token is replaced, not just reported.
test('1. 失效旧 token → 清空 → 重新授权 → 新 token 持久化并连接成功', async () => {
  const { tokenPath } = await seedToken('recover', 'stale-token');
  const tokenFileAtGrant = [];
  const fake = await createFakeVts({
    grantToken: 'fresh-token',
    tokenDelayMs: 120,
    onTokenRequest: async () => { tokenFileAtGrant.push(await readToken(tokenPath)); },
  });
  const events = [];
  const client = new VtsClient({
    port: fake.port,
    tokenPath,
    onEvent: (type, payload) => events.push({ type, ...payload }),
  });
  try {
    const pending = client.connect();
    await sleep(30);
    assert(client.authPending === true, 'authPending is true while the re-authorization is pending');
    await pending;

    const order = authOrder(fake.requests);
    assert(
      order.join(' > ') === 'AuthenticationRequest > AuthenticationTokenRequest > AuthenticationRequest',
      `auth order is reject → grant → retry (got ${order.join(' > ')})`,
    );
    assert(await readToken(tokenPath) === 'fresh-token', 'the new token is persisted to tokenPath');
    assert(
      tokenFileAtGrant.length === 1 && tokenFileAtGrant[0] === '',
      `the old token was cleared before AuthenticationTokenRequest (saw ${JSON.stringify(tokenFileAtGrant)})`,
    );
    assert(client.token === 'fresh-token', 'the in-memory token is the new one');
    assert(client.authPending === false, 'authPending is false after the connect settles');
    assert(client.authRenewed === true, 'the client records that the token was renewed');
    assert(client.ready === true && client.connected === true, 'the renewed connection is usable');
    assert(client.lastError === '', 'a successful renewal leaves no error');
    assert(events.map((entry) => entry.type).join(',') === 'vts.auth.renew,vts.auth.ok', 'renew + ok events fired');
    console.log(`     order: ${order.join(' > ')}`);
    console.log(`     token file at grant: '${tokenFileAtGrant[0] ?? '(not observed)'}' → now: '${await readToken(tokenPath)}'`);
  } finally {
    client.close();
    await fake.close();
  }
});

// 2) One retry only: a fresh token that is also rejected must surface AUTH_RETRY_FAILED.
test('2. 新 token 仍被拒 → 只重试一次 → AUTH_RETRY_FAILED（不无限循环）', async () => {
  const { tokenPath } = await seedToken('retry-fail', 'stale-token');
  const fake = await createFakeVts({
    grantToken: 'renewed-token',
    acceptRenewed: false,
    rejectMode: 'apiError',
  });
  const events = [];
  const client = new VtsClient({
    port: fake.port,
    tokenPath,
    onEvent: (type, payload) => events.push({ type, ...payload }),
  });
  try {
    const failure = await client.connect().then(() => null, (error) => error);
    assert(failure !== null, 'connect() rejects');
    assert(failure.code === 'AUTH_RETRY_FAILED', `the error carries AUTH_RETRY_FAILED (got ${failure.code})`);
    assert(/AUTH_RETRY_FAILED/u.test(failure.message), 'the message contains the AUTH_RETRY_FAILED code');
    assert(/invalid or has been revoked/u.test(failure.message), 'the message keeps the VTS rejection reason');
    assert(countOf(fake.requests, 'AuthenticationRequest') === 2, 'exactly two AuthenticationRequests (one retry)');
    assert(countOf(fake.requests, 'AuthenticationTokenRequest') === 1, 'exactly one re-authorization request');
    assert(
      authOrder(fake.requests).join(' > ') === 'AuthenticationRequest > AuthenticationTokenRequest > AuthenticationRequest',
      'still one ordered retry',
    );
    const failed = events.filter((entry) => entry.type === 'vts.auth.failed');
    assert(failed.length === 1 && failed[0].code === 'AUTH_RETRY_FAILED', 'vts.auth.failed carries the code');
    assert(client.authPending === false, 'authPending settles to false');
    assert(client.ready === false && client.authenticated === false && client.connected === false,
      'the failed connection is not reported as usable');
    assert(/authorization was requested/u.test(client.lastError), 'lastError records that the popup was triggered');
    assert(/no further retry/u.test(client.lastError), 'lastError records that the retry limit was reached');
    console.log(`     auth requests: ${countOf(fake.requests, 'AuthenticationRequest')}`
      + `, token requests: ${countOf(fake.requests, 'AuthenticationTokenRequest')}`);
    console.log(`     code: ${failure.code}; lastError: ${client.lastError}`);
  } finally {
    client.close();
    await fake.close();
  }
});

// 3) Regression: a valid token must never trigger a popup.
test('3. 正常 token → 不触发重新授权（回归）', async () => {
  const { tokenPath } = await seedToken('valid', 'good-token');
  const fake = await createFakeVts({ validTokens: ['good-token'] });
  const events = [];
  const client = new VtsClient({
    port: fake.port,
    tokenPath,
    onEvent: (type, payload) => events.push({ type, ...payload }),
  });
  try {
    await client.connect();
    assert(countOf(fake.requests, 'AuthenticationRequest') === 1, 'one AuthenticationRequest');
    assert(countOf(fake.requests, 'AuthenticationTokenRequest') === 0, 'no AuthenticationTokenRequest');
    assert(events.length === 0, `no auth events (got ${events.map((entry) => entry.type).join(',')})`);
    assert(await readToken(tokenPath) === 'good-token', 'the valid token file is untouched');
    assert(client.authRenewed === false && client.authPending === false, 'no renewal is reported');
    assert(client.ready === true, 'the normal connection is ready');
    console.log(`     auth requests: 1, token requests: 0, token file: ${await readToken(tokenPath)}`);
  } finally {
    client.close();
    await fake.close();
  }
});

// 4) The APIError rejection shape and the observable event/state fields.
test('4. APIError 文本/响应码路径 → 事件与 authPending / renewed 字段正确', async () => {
  const { tokenPath } = await seedToken('events', 'revoked-token');
  const fake = await createFakeVts({ grantToken: 'event-token', rejectMode: 'apiError', tokenDelayMs: 80 });
  const events = [];
  const client = new VtsClient({
    port: fake.port,
    tokenPath,
    onEvent: (type, payload) => events.push({ type, ...payload }),
  });
  try {
    const pending = client.connect();
    await sleep(30);
    assert(client.authPending === true, 'authPending is readable during the authorization wait');
    await pending;

    assert(events.length === 2, `exactly two auth events (got ${events.length})`);
    assert(events[0].type === 'vts.auth.renew', 'the first event is vts.auth.renew');
    assert(/invalid or has been revoked/u.test(events[0].reason), 'the renew event carries the VTS reason');
    assert(events[1].type === 'vts.auth.ok', 'the second event is vts.auth.ok');
    assert(events[1].renewed === true, 'the ok event reports renewed:true');
    assert(client.authPending === false, 'authPending is false after success');
    assert(client.authRenewed === true, 'renewed state is true');
    assert(/event-token/u.test(await readToken(tokenPath)), 'the renewed token is on disk');
    console.log(`     events: ${events.map((entry) => `${entry.type}${entry.renewed === true ? '(renewed:true)' : ''}`).join(' → ')}`);
    console.log(`     authPending: ${client.authPending}, renewed: ${client.authRenewed}`);
  } finally {
    client.close();
    await fake.close();
  }
});

// 5) First install: no token at all still asks once and connects, without a renew event.
test('5. 首次安装无 token → 只申请一次授权，不产生 renew 事件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vts-auth-install-'));
  const tokenPath = join(root, 'vts-token.json');
  const fake = await createFakeVts({ grantToken: 'install-token' });
  const events = [];
  const client = new VtsClient({
    port: fake.port,
    tokenPath,
    onEvent: (type, payload) => events.push({ type, ...payload }),
  });
  try {
    await client.connect();
    assert(countOf(fake.requests, 'AuthenticationTokenRequest') === 1, 'one authorization request');
    assert(countOf(fake.requests, 'AuthenticationRequest') === 1, 'one authentication request');
    assert(events.length === 0, 'no renew/failed event on a first install');
    assert(await readToken(tokenPath) === 'install-token', 'the granted token is persisted');
    assert(client.ready === true, 'the first connection is ready');
    console.log(`     token requests: 1, auth requests: 1, token file: ${await readToken(tokenPath)}`);
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
