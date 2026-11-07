/**
 * One socket at a time: duplicate-connection regression checks for the VTS client.
 *
 * The live symptom: VTS reported connectedPlugins=2 / allowedPlugins=1 with both TCP connections
 * owned by the Host PID. The cause: close() dropped its reference immediately but ws still had to
 * finish the close handshake, and the next connect() dialed straight away; a socket that never
 * answered the handshake therefore stayed registered on VTS forever.
 *
 * These tests use an in-process fake VTS that counts server-side connections (total, active,
 * concurrent peak) and can delay the HTTP upgrade or withhold the close handshake, so the
 * overlap window is deterministic instead of timing-dependent. No real VTS is contacted.
 *
 * Run: node test/vts-reconnect.mjs
 */
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
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

const tmp = (name) => mkdtemp(join(tmpdir(), `vts-reconnect-${name}-`));

// ---- fake VTS -------------------------------------------------------------
/**
 * Minimal fake VTube Studio. `handshakeDelayMs` makes the TCP connection exist while the client
 * still waits for 'open' (the close()-during-connect window). Connection accounting is server
 * side, i.e. exactly what VTS would count.
 */
async function createFakeVts({ authOk = true, handshakeDelayMs = 0 } = {}) {
  const state = { authOk, handshakeDelayMs };
  /** One record per accepted WebSocket, with the close the server actually observed. */
  const connections = [];
  let active = 0;
  let maxConcurrent = 0;
  let nextId = 0;

  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    const accept = () => {
      if (socket.destroyed) return;
      try {
        wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
      } catch {
        socket.destroy();
      }
    };
    if (state.handshakeDelayMs > 0) setTimeout(accept, state.handshakeDelayMs);
    else accept();
  });

  const send = (ws, message) => {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      /* socket already gone */
    }
  };
  const respond = (ws, request, data) => send(ws, {
    apiName: 'VTubeStudioPublicAPI',
    apiVersion: '1.0',
    requestID: request.requestID,
    messageType: `${String(request.messageType).replace(/Request$/u, '')}Response`,
    data,
  });

  wss.on('connection', (ws) => {
    const record = { id: ++nextId, at: Date.now(), closedAt: 0, closeCode: 0 };
    connections.push(record);
    active += 1;
    if (active > maxConcurrent) maxConcurrent = active;
    ws.on('close', (code) => {
      record.closedAt = Date.now();
      record.closeCode = code;
      active -= 1;
    });
    ws.on('message', (raw) => {
      let request;
      try {
        request = JSON.parse(String(raw));
      } catch {
        return;
      }
      switch (request.messageType) {
        case 'AuthenticationTokenRequest':
          respond(ws, request, { authenticationToken: 'fake-token' });
          return;
        case 'AuthenticationRequest':
          respond(ws, request, state.authOk
            ? { authenticated: true }
            : { authenticated: false, reason: 'token not valid' });
          return;
        case 'CurrentModelRequest':
          respond(ws, request, { modelLoaded: true, modelName: 'FakeHiyori', modelID: 'model-A' });
          return;
        case 'HotkeysInCurrentModelRequest':
          respond(ws, request, { availableHotkeys: [] });
          return;
        case 'ExpressionStateRequest':
          respond(ws, request, { expressions: [] });
          return;
        case 'EventSubscriptionRequest':
          respond(ws, request, { subscribedEventCount: 1, subscribedEvents: ['ModelLoadedEvent'] });
          return;
        default:
          respond(ws, request, {});
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        connections,
        get active() { return active; },
        get maxConcurrent() { return maxConcurrent; },
        get closeCount() { return connections.filter((entry) => entry.closedAt > 0).length; },
        setAuthOk(value) { state.authOk = value === true; },
        disconnect() {
          for (const ws of wss.clients) ws.terminate();
        },
        close() {
          for (const ws of wss.clients) ws.terminate();
          return new Promise((done) => wss.close(() => server.close(() => done())));
        },
      });
    });
  });
}

const newClient = async (fake, name, onEvent = null) => new VtsClient({
  port: fake.port,
  tokenPath: join(await tmp(name), 'token.json'),
  onEvent,
});

// ---- test runner ----------------------------------------------------------
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// 1) The core duplicate: a socket whose close handshake never completes must be terminated
//    BEFORE the next dial, and VTS must never observe two live connections from this client.
test('1. 替换旧 socket：先 close 并等待，超时后 terminate，服务端并发峰值始终为 1', async () => {
  const fake = await createFakeVts();
  const events = [];
  const client = await newClient(fake, 'replace', (type, payload) => events.push({ type, ...payload }));
  try {
    await client.connect();
    assert(fake.active === 1, `one connection after connect (got ${fake.active})`);
    assert(client.sockets.size === 1, `the client owns one socket (got ${client.sockets.size})`);

    const old = client.socket;
    let closes = 0;
    let terminates = 0;
    const realTerminate = old.terminate.bind(old);
    // VTS never answers the close frame in this test, so the handshake window is exactly the
    // failure mode seen on the real machine: the socket stays registered until terminate().
    old.close = () => { closes += 1; };
    old.terminate = (...args) => { terminates += 1; return realTerminate(...args); };

    const startedAt = Date.now();
    client.close();
    const result = await client.connect();
    const elapsed = Date.now() - startedAt;
    await waitFor(() => fake.connections[0]?.closedAt > 0, 2000, 10);

    const replaced = events.filter((entry) => entry.type === 'vts.socket.replaced');
    const staleClosed = events.filter((entry) => entry.type === 'vts.socket.stale-closed');
    const stats = client.getTransportStats();

    assert(result.ok === true, 'the replacement connect succeeds');
    assert(fake.connections.length === 2, `exactly two connections in total (got ${fake.connections.length})`);
    assert(fake.maxConcurrent === 1, `VTS never saw two live connections at once (peak ${fake.maxConcurrent})`);
    assert(fake.connections[0].closedAt > 0, 'the old server-side connection is closed');
    assert(closes >= 1, `the old socket received close() (got ${closes})`);
    assert(terminates === 1, `the hung close handshake was terminated exactly once (got ${terminates})`);
    assert(elapsed >= 900, `the dial waited for the close bound before terminate (waited ${elapsed}ms)`);
    assert(replaced.length === 1, `one vts.socket.replaced event (got ${replaced.length})`);
    assert(replaced[0].previous === 'open', `the event names the previous socket (got ${replaced[0].previous})`);
    assert(replaced[0].ms >= 900, `the event records the close wait (got ${replaced[0].ms}ms)`);
    assert(staleClosed.length === 1 && staleClosed[0].confirmed === true,
      `vts.socket.stale-closed confirms the retirement (got ${JSON.stringify(staleClosed)})`);
    assert(stats.socketReconnects === 1, `socketReconnects counts the replacement (got ${stats.socketReconnects})`);
    assert(stats.liveSockets === 1, `exactly one live socket after the replacement (got ${stats.liveSockets})`);
    assert(client.sockets.size === 1, 'the client holds only the new socket');
    assert(client.ready === true && client.connected === true, 'the new socket is the usable connection');
    assert(fake.active === 1, `VTS sees one connection at the end (got ${fake.active})`);
    console.log(`     old.closes=${closes} old.terminates=${terminates} peak=${fake.maxConcurrent}`
      + ` replaced=${replaced.length} stale-closed=${JSON.stringify(staleClosed[0])}`);
  } finally {
    client.close();
    await fake.close();
  }
});

// 2) A rejected authentication must leave no socket behind: the retry is the only connection.
test('2. 认证失败后再连：失败 socket 被关闭，重试后只有一条连接', async () => {
  const fake = await createFakeVts({ authOk: false });
  const client = await newClient(fake, 'authfail');
  try {
    const failure = await client.connect().then(() => null, (error) => error);
    assert(failure !== null, 'the rejected authentication throws');
    const settled = await waitFor(() => fake.active === 0 && client.sockets.size === 0, 3000, 10);
    assert(settled === true, `the failed socket is fully closed (active=${fake.active}, tracked=${client.sockets.size})`);
    assert(client.socket === null, 'no socket reference survives the failure');
    assert(fake.connections.length === 1 && fake.closeCount === 1,
      `the failed connection is closed on the server (total=${fake.connections.length}, closed=${fake.closeCount})`);

    fake.setAuthOk(true);
    const retried = await client.connect();
    assert(retried.ok === true, 'the retry connects');
    assert(fake.connections.length === 2, `the retry is the second and only extra connection (got ${fake.connections.length})`);
    assert(fake.maxConcurrent === 1, `no failed socket overlapped the retry (peak ${fake.maxConcurrent})`);
    assert(fake.active === 1, 'exactly one connection remains');
    assert(client.sockets.size === 1, 'the client holds exactly one socket');
    console.log(`     failed-close=${fake.closeCount} total=${fake.connections.length} peak=${fake.maxConcurrent} active=${fake.active}`);
  } finally {
    client.close();
    await fake.close();
  }
});

// 3) close() while the socket is still opening must not adopt it later, and must not dial again.
test('3. 建立中被 close()：候选 socket 不被采纳，之后不残留也不新开', async () => {
  const fake = await createFakeVts({ handshakeDelayMs: 300 });
  const client = await newClient(fake, 'close-during-connect');
  try {
    const pending = client.connect().then(() => null, (error) => error);
    const tracked = await waitFor(() => client.sockets.size === 1, 1000, 10);
    assert(tracked === true, 'the CONNECTING candidate is tracked');
    assert(client.socket === null, 'a socket that has not opened is never adopted');

    client.close();
    const failure = await pending;
    assert(failure instanceof Error, 'the in-flight connect is cancelled, not fulfilled');
    assert(/cancel|closed/iu.test(failure.message), `the failure explains the cancellation (got ${failure.message})`);
    await waitFor(() => client.sockets.size === 0, 3000, 10);
    await waitFor(() => fake.active === 0, 3000, 10);
    const afterClose = fake.connections.length;
    await sleep(500); // past handshakeDelayMs: a late handshake must not resurrect the socket
    assert(fake.connections.length === afterClose, 'close() caused no extra dial');
    assert(afterClose <= 1, `at most the cancelled candidate reached the server (got ${afterClose})`);
    assert(client.socket === null, 'no socket was adopted after close()');
    assert(client.sockets.size === 0, 'no socket reference survives close()');
    assert(client.connected === false && client.ready === false, 'the client reports a closed connection');
    assert(fake.active === 0, `VTS holds no connection after close() (got ${fake.active})`);

    const retried = await client.connect();
    assert(retried.ok === true, 'an explicit retry connects');
    assert(fake.connections.length === afterClose + 1, 'only the explicit retry dials');
    assert(client.sockets.size === 1 && fake.active === 1, 'exactly one live connection');
    console.log(`     cancelled-connections=${afterClose} retry-total=${fake.connections.length} active=${fake.active}`);
  } finally {
    client.close();
    await fake.close();
  }
});

// 4) Regression: concurrent callers share one dial, and a ready client never redials.
test('4. 并发 connect 仍只建立一条 socket；已就绪的 connect 不再拨号', async () => {
  const fake = await createFakeVts();
  const events = [];
  const client = await newClient(fake, 'concurrent', (type, payload) => events.push({ type, ...payload }));
  try {
    const results = await Promise.all(Array.from({ length: 5 }, () => client.connect()));
    assert(results.every((entry) => entry.ok === true), 'every concurrent connect succeeds');
    assert(fake.connections.length === 1, `concurrent connects dial once (got ${fake.connections.length})`);
    assert(fake.maxConcurrent === 1, `the server never saw an overlap (peak ${fake.maxConcurrent})`);
    assert(client.sockets.size === 1, 'one tracked socket');
    assert(client.getTransportStats().socketReconnects === 0, 'no replacement is counted');

    const again = await client.connect();
    assert(again.ok === true, 'connect() on a ready client still succeeds');
    assert(fake.connections.length === 1, 'connect() on a ready client opens no new socket');
    assert(events.filter((entry) => entry.type === 'vts.socket.replaced').length === 0,
      'no replacement event for a no-op connect');
    console.log(`     concurrent=5 connections=${fake.connections.length} peak=${fake.maxConcurrent} active=${fake.active}`);
  } finally {
    client.close();
    await fake.close();
  }
});

// 5) A normal reconnect after the peer closed cleanly is not a "replacement" and records no event.
test('5. 普通断线重连不记替换事件（仅真实替换才记录）', async () => {
  const fake = await createFakeVts();
  const events = [];
  const client = await newClient(fake, 'clean-reconnect', (type, payload) => events.push({ type, ...payload }));
  try {
    await client.connect();
    fake.disconnect();
    const disconnected = await waitFor(() => client.connected === false && client.sockets.size === 0, 3000, 10);
    assert(disconnected === true, 'the dead socket is fully cleaned up');
    await client.connect();
    assert(fake.connections.length === 2, 'the reconnect dials exactly once');
    assert(fake.maxConcurrent === 1, `no overlap (peak ${fake.maxConcurrent})`);
    assert(events.filter((entry) => entry.type === 'vts.socket.replaced').length === 0,
      'a clean reconnect is not reported as a replacement');
    assert(events.filter((entry) => entry.type === 'vts.socket.stale-closed').length === 0,
      'no stale socket was closed');
    assert(client.getTransportStats().socketReconnects === 0, 'socketReconnects stays 0');
    console.log(`     connections=${fake.connections.length} replaced=${events.filter((e) => e.type === 'vts.socket.replaced').length}`);
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
