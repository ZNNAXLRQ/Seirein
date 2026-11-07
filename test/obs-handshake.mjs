/**
 * R12 regression: OBS handshake deadline and disconnect settlement.
 *
 * Before this fix `connectObs()` had no handshake timer, and `close()` cleared the pending map
 * without rejecting its entries, so every in-flight request could stay pending forever. The
 * fake WebSocket below drives the exact wire events (Hello, Identified, response, close) without
 * a real OBS instance; `socketFactory` is the documented test seam.
 *
 * Run: node --test test/obs-handshake.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { connectObs, ObsError } from '../src/host/vision/obs.js';

class FakeSocket {
  constructor() {
    this.sent = [];
    this.closed = false;
    this.handlers = new Map();
  }

  on(event, handler) {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  emit(event, ...args) {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }

  send(text) {
    this.sent.push(JSON.parse(text));
  }

  /** Like `ws`: the local close only emits `close` asynchronously afterwards. */
  close() {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.emit('close', 1006, Buffer.from('')));
  }

  message(object) {
    this.emit('message', Buffer.from(JSON.stringify(object)));
  }

  hello() {
    this.message({ op: 0, d: { obsWebSocketVersion: '5.5.0', rpcVersion: 1 } });
  }

  identified() {
    this.message({ op: 2, d: { negotiatedRpcVersion: 1 } });
  }

  respond(requestId, responseData = {}) {
    this.message({ op: 7, d: { requestId, requestStatus: { result: true }, responseData } });
  }

  /** The server side drops the connection (OBS restart, network reset, ...). */
  serverClose() {
    this.emit('close', 1006, Buffer.from(''));
  }
}

/** Connect a fake socket through the real handshake and return both sides. */
async function connectedClient(overrides = {}) {
  let socket;
  const connecting = connectObs({ socketFactory: () => (socket = new FakeSocket()), ...overrides });
  socket.hello();
  socket.identified();
  const client = await connecting;
  return { client, socket };
}

test('R12a 不回应 Hello：握手超时失败并关闭连接', async () => {
  let socket;
  const connecting = connectObs({
    handshakeTimeoutMs: 30,
    socketFactory: () => (socket = new FakeSocket()),
  });
  const error = await connecting.then(
    () => assert.fail('握手超时时不应成功连接'),
    (reason) => reason,
  );
  assert.ok(error instanceof ObsError);
  assert.equal(error.code, 'ObsHandshakeTimeout');
  assert.equal(socket.closed, true, '超时后应主动关闭 socket');
});

test('R12b 已连接后 socket 断开：进行中的请求以 ObsDisconnected reject', async () => {
  const { client, socket } = await connectedClient();
  const inflight = client.request('GetSceneList');
  assert.equal(socket.sent.at(-1).op, 6);

  socket.serverClose();
  const error = await inflight.then(
    () => assert.fail('断开后请求不应成功'),
    (reason) => reason,
  );
  assert.ok(error instanceof ObsError);
  assert.equal(error.code, 'ObsDisconnected');
});

test('R12c 正常 Hello：请求成功', async () => {
  const { client, socket } = await connectedClient();
  const request = client.request('GetSceneList');
  const sent = socket.sent.at(-1);
  assert.equal(sent.op, 6);
  assert.equal(sent.d.requestType, 'GetSceneList');

  socket.respond(sent.d.requestId, { currentProgramSceneName: 'Main' });
  assert.deepEqual(await request, { currentProgramSceneName: 'Main' });
  client.close();
  assert.equal(socket.closed, true);
});

test('R12d 断开后再次请求：立即以 ObsDisconnected 失败而不是挂起', async () => {
  const { client, socket } = await connectedClient();
  socket.serverClose();
  const sentBefore = socket.sent.length;

  const outcome = await Promise.race([
    client.request('GetSceneList').then(
      () => assert.fail('断开后请求不应成功'),
      (reason) => reason,
    ),
    new Promise((resolve) => setTimeout(() => resolve(new Error('请求挂起')), 500)),
  ]);
  assert.ok(outcome instanceof ObsError, `应得到 ObsError，实际：${outcome?.message}`);
  assert.equal(outcome.code, 'ObsDisconnected');
  assert.equal(socket.sent.length, sentBefore, '断开后不应再向 socket 发送请求');
});

test('R12f 收到 Hello 后不发 Identified：认证期限内以 ObsIdentifyTimeout reject，不挂起', async () => {
  let socket;
  const connecting = connectObs({
    handshakeTimeoutMs: 20,
    socketFactory: () => (socket = new FakeSocket()),
  });
  socket.hello();
  assert.equal(socket.sent.at(-1).op, 1, '收到 Hello 后应发送 Identify');

  const outcome = await Promise.race([
    connecting.then(
      () => ({ connected: true }),
      (error) => ({ error }),
    ),
    // The pre-fix code cleared the only timer here, so this branch is the regression.
    new Promise((resolve) => setTimeout(() => resolve({ hung: true }), 250)),
  ]);

  assert.equal(outcome.hung, undefined, 'Hello 后无 Identified 时连接不能永久挂起');
  assert.ok(outcome.error instanceof ObsError);
  assert.equal(outcome.error.code, 'ObsIdentifyTimeout');
  assert.equal(socket.closed, true, '认证超时后应主动关闭 socket');
});

test('R12e 请求自身超时使用 ObsTimeout，与断线的 ObsDisconnected 区分', async () => {
  const { client } = await connectedClient({ requestTimeoutMs: 30 });
  const error = await client.request('GetSceneList').then(
    () => assert.fail('无响应时请求不应成功'),
    (reason) => reason,
  );
  assert.ok(error instanceof ObsError);
  assert.equal(error.code, 'ObsTimeout');
  client.close();
});
