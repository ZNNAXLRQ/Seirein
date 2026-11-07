/**
 * Isolated regression checks for the five VTS integration gaps fixed in this change.
 *
 * Each test reproduces the original failure condition against an in-process fake VTube Studio
 * (same shape as test/vts-fake.mjs), then asserts the fixed behavior. No real VTS is contacted.
 *
 * Run: node test/vts-gaps.mjs
 */
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import WebSocket, { WebSocketServer } from 'ws';

import { apply } from '../src/host/index.js';
import { VtsClient } from '../src/host/avatar/vts.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (check, timeoutMs = 3000, stepMs = 25) => {
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

const tmp = (name) => mkdtemp(join(tmpdir(), `vts-gaps-${name}-`));

// ---- fake VTS -------------------------------------------------------------
/**
 * Fake VTS API. `frameReply: 'none'` deliberately withholds the InjectParameterDataResponse so
 * the 400 ms window is observable; `subscriptionError: true` rejects EventSubscriptionRequest.
 *
 * The event subscription side is deliberately strict, because the real protocol is:
 *   - `subscribe` must be `true` for a subscription (missing/false means unsubscribe);
 *   - only events in a connection's own subscription set may be pushed to it;
 *   - `subscriptionReply` can answer with a pathological confirmation ('test-only' / 'empty')
 *     so the client's strict reading of the answer is testable.
 */
async function createFakeVts({
  defaultParameters = [],
  customParameters = [],
  modelParams = [],
  model = { modelName: 'FakeHiyori', modelID: 'model-A' },
  frameReply = 'reply',
  subscriptionError = false,
  subscriptionReply = 'ok',
  dropOnSubscription = false,
} = {}) {
  const state = {
    defaultParameters,
    customParameters,
    modelParams,
    model,
    frameReply,
    subscriptionError,
    subscriptionReply,
    dropOnSubscription,
  };
  const frames = [];
  /** Every EventSubscriptionRequest seen, with the fields the client actually sent. */
  const subscriptions = [];
  /** Every emitModelLoaded() call, with how many subscribed connections it reached. */
  const pushes = [];
  /** socket → Set<eventName> for that connection only. */
  const subscribedBySocket = new Map();
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
  const respondError = (socket, request, message, errorID = 300) => send(socket, {
    apiName: 'VTubeStudioPublicAPI',
    apiVersion: '1.0',
    requestID: request.requestID,
    messageType: 'APIError',
    data: { errorID, message },
  });

  wss.on('connection', (socket) => {
    const subscribed = new Set();
    subscribedBySocket.set(socket, subscribed);
    socket.on('close', () => subscribedBySocket.delete(socket));
    socket.on('message', async (raw) => {
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
          respond(socket, request, { modelLoaded: true, ...state.model });
          return;
        case 'HotkeysInCurrentModelRequest':
          respond(socket, request, { availableHotkeys: [{ hotkeyID: 'hk-1', name: 'Idle' }] });
          return;
        case 'ExpressionStateRequest':
          respond(socket, request, { expressions: [{ name: 'Smile' }] });
          return;
        case 'InputParameterListRequest':
          respond(socket, request, {
            defaultParameters: state.defaultParameters,
            customParameters: state.customParameters,
          });
          return;
        case 'Live2DParameterListRequest':
          respond(socket, request, { live2DModelParameters: state.modelParams });
          return;
        case 'EventSubscriptionRequest': {
          const data = request.data ?? {};
          const eventName = String(data.eventName ?? '');
          subscriptions.push({ eventName, subscribe: data.subscribe, config: data.config });
          // The socket dies right after the request was sent: no answer will ever arrive, which is
          // exactly the "authenticated, then disconnected during subscription" regression.
          if (state.dropOnSubscription) {
            socket.terminate();
            return;
          }
          // A subscription request without subscribe:true is a protocol error. Answer it and do
          // NOT register the event: a client that forgets the flag must never look subscribed.
          if (data.subscribe !== true) {
            respondError(
              socket,
              request,
              `event subscription rejected: subscribe must be true (eventName=${eventName || '?'}, subscribe=${JSON.stringify(data.subscribe)})`,
            );
            return;
          }
          if (eventName.length === 0) {
            respondError(socket, request, 'event subscription rejected: eventName is required');
            return;
          }
          if (state.subscriptionError) {
            respondError(socket, request, 'event subscription rejected');
            return;
          }
          subscribed.add(eventName);
          if (state.subscriptionReply === 'empty') {
            respond(socket, request, { subscribedEventCount: 0, subscribedEvents: [] });
            return;
          }
          if (state.subscriptionReply === 'test-only') {
            respond(socket, request, { subscribedEventCount: 1, subscribedEvents: ['TestEvent'] });
            return;
          }
          respond(socket, request, {
            subscribedEventCount: subscribed.size,
            subscribedEvents: [...subscribed],
          });
          return;
        }
        case 'InjectParameterDataRequest': {
          const values = request.data?.parameterValues ?? [];
          frames.push({ at: Date.now(), requestID: request.requestID, values });
          if (state.frameReply === 'none') return;
          respond(socket, request, { faceFound: true });
          return;
        }
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
        frames,
        subscriptions,
        pushes,
        state,
        setFrameReply(mode) {
          state.frameReply = mode;
        },
        replyApiError(requestID, message) {
          for (const socket of wss.clients) {
            send(socket, {
              apiName: 'VTubeStudioPublicAPI',
              apiVersion: '1.0',
              requestID,
              messageType: 'APIError',
              data: { errorID: 300, message },
            });
          }
        },
        /** Push ModelLoadedEvent only to connections that registered it; returns the recipient count. */
        emitModelLoaded(nextModel) {
          state.model = nextModel;
          let recipients = 0;
          for (const socket of wss.clients) {
            if (!(subscribedBySocket.get(socket)?.has('ModelLoadedEvent') ?? false)) continue;
            recipients += 1;
            send(socket, {
              apiName: 'VTubeStudioPublicAPI',
              apiVersion: '1.0',
              messageType: 'ModelLoadedEvent',
              data: {
                modelLoadedEvent: {
                  modelLoaded: true,
                  modelName: nextModel.modelName,
                  modelID: nextModel.modelID,
                },
              },
            });
          }
          pushes.push({ modelID: nextModel.modelID, recipients });
          return recipients;
        },
        disconnect() {
          for (const socket of wss.clients) socket.terminate();
        },
        close() {
          for (const socket of wss.clients) socket.terminate();
          return new Promise((done) => wss.close(() => server.close(() => done())));
        },
      });
    });
  });
}

/** Raw client, used to prove the fake itself rejects a subscription request without subscribe:true. */
const openRawSocket = (fake) => new Promise((resolve, reject) => {
  const socket = new WebSocket(`ws://127.0.0.1:${fake.port}`);
  socket.once('open', () => resolve(socket));
  socket.once('error', reject);
});

const MOUTH_INPUT = { name: 'MouthOpen', min: 0, max: 1, defaultValue: 0 };
const HEAD_INPUT = { name: 'FaceAngleX', min: -30, max: 30, defaultValue: 0 };

// ---- host harness (same technique as test/vts-fake.mjs) -------------------
async function startHost(fake) {
  const root = await mkdtemp(join(tmpdir(), 'vts-gaps-host-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await writeFile(join(root, 'data', 'features.json'), JSON.stringify({ avatar: true }), 'utf8');
  const routes = new Map();
  const tools = new Map();
  const fakeCtx = {
    effect: (fn) => fn(),
    tools: {
      register: (definition) => {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    inject: (_names, callback) => callback({
      effect: (fn) => fn(),
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
      writeHead(code) {
        this.code = code;
      },
      end(data) {
        this.body = String(data ?? '');
      },
    };
    await handler(req, res);
    try {
      return JSON.parse(res.body);
    } catch {
      return { raw: res.body };
    }
  };

  return { root, tools, callRoute };
}

// ---- test runner ----------------------------------------------------------
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// 1) 400 ms silence must not be reported as an acknowledged success.
test('1. 400ms 无应答 → ok:true + acknowledged:false，迟到 APIError 记入 lastFrameError', async () => {
  const fake = await createFakeVts({ defaultParameters: [MOUTH_INPUT], frameReply: 'none' });
  const client = new VtsClient({ port: fake.port, tokenPath: join(await tmp('g1'), 'token.json') });
  try {
    await client.connect();
    const started = Date.now();
    const outcome = await client.injectInputs([{ name: 'MouthOpen', value: 0.5 }]);
    const elapsed = Date.now() - started;
    assert(outcome.ok === true, 'ok stays "sent" after the reply window');
    assert(outcome.sent === true, 'the frame was really sent');
    assert(outcome.acknowledged === false, 'no answer means acknowledged:false');
    assert(elapsed >= 380, `the outcome waited for the 400ms window (waited ${elapsed}ms)`);
    assert(fake.frames.length === 1, 'exactly one frame reached the fake VTS');

    assert(client.lastFrameError === '', 'no error before the late answer');
    fake.replyApiError(fake.frames[0].requestID, 'late Parameter id not allowed');
    const recorded = await waitFor(() => client.lastFrameError.length > 0, 2000, 25);
    assert(recorded === true, 'the late APIError is recorded on the instance');
    assert(/late Parameter id not allowed/u.test(client.lastFrameError), 'the late APIError detail is kept');
  } finally {
    client.close();
    await fake.close();
  }
});

// 2) An unmapped mouth channel must send nothing and must be reported as a failure.
test('2. 未映射 mouth → 零帧 + ok:false（client 与 assistant_live2d 工具）', async () => {
  const fake = await createFakeVts({ defaultParameters: [HEAD_INPUT], modelParams: [] });
  const client = new VtsClient({ port: fake.port, tokenPath: join(await tmp('g2a'), 'token.json') });
  try {
    await client.connect();
    const framesBefore = fake.frames.length;
    const mouth = await client.setMouth(0.5);
    await sleep(120);
    assert(mouth.ok === false, 'setMouth reports failure');
    assert(mouth.fallback === true, 'the result is marked as a fallback failure');
    assert(/mouth channel not mapped/u.test(mouth.error), 'the reason names the missing mapping');
    assert(fake.frames.length === framesBefore, 'no InjectParameterDataRequest reaches the fake VTS');
  } finally {
    client.close();
    await fake.close();
  }

  const hostFake = await createFakeVts({ defaultParameters: [HEAD_INPUT], modelParams: [] });
  try {
    const host = await startHost(hostFake);
    const connected = await host.callRoute('/assistant/action', { body: { action: 'live2d.connect' } });
    assert(connected.ok === true, 'host connects');
    const status = await host.callRoute('/assistant/status', { method: 'GET' });
    assert(status.live2d?.eventsSubscribed === true, 'status reports eventsSubscribed after auth');
    assert(status.live2d?.subscribedEvents?.includes('ModelLoadedEvent'), 'status lists ModelLoadedEvent');
    assert(status.live2d?.subscriptionError === '', 'status reports an empty subscriptionError after a confirmed subscription');
    assert(
      typeof status.live2d?.subscriptionResponse === 'string' && status.live2d.subscriptionResponse.length > 0,
      'status exposes the raw subscription answer',
    );
    assert(status.live2d.subscriptionResponse.length <= 400, 'the raw subscription answer is clipped to 400 characters');
    const discovered = await waitFor(async () => {
      const next = await host.callRoute('/assistant/status', { method: 'GET' });
      return next.live2d?.capabilities?.discovered === true;
    }, 3000, 50);
    assert(discovered === true, 'capability discovery settles');

    const before = hostFake.frames.length;
    const tool = host.tools.get('assistant_live2d');
    assert(tool !== undefined, 'assistant_live2d is registered');
    const result = await tool.execute({ action: 'mouth', value: 0.5 });
    await sleep(120);
    assert(result.ok === false, 'the tool returns ok:false for an unmapped mouth');
    assert(/mouth channel not mapped/u.test(result.error), 'the tool surfaces the mapping error');
    assert(result.acknowledged === false, 'the tool surfaces acknowledged:false');
    const framesAfterTool = hostFake.frames.slice(before);
    // The host also drives its idle head/eye frame, so an unrelated frame may land in this window;
    // the contract under test is that the failed mouth action itself injects nothing.
    assert(
      framesAfterTool.every((frame) => !(frame.values ?? []).some((entry) => /mouth/iu.test(String(entry?.id ?? '')))),
      `the tool sends no mouth inject frame (got ${JSON.stringify(framesAfterTool)})`,
    );
  } finally {
    await hostFake.close();
  }
});

// 3) A model switch during the 33 ms frame gap must drop the in-flight frame as stale.
test('3. epoch 竞态 → 切模型后旧帧零发送，dropped 增加且 lastDropReason=stale', async () => {
  const fake = await createFakeVts({ defaultParameters: [MOUTH_INPUT] });
  const client = new VtsClient({ port: fake.port, tokenPath: join(await tmp('g3'), 'token.json') });
  try {
    await client.connect();
    // Warm the frame path and the capability cache.
    await client.injectInputs([{ name: 'MouthOpen', value: 0.1 }]);
    await sleep(40);

    const framesBefore = fake.frames.length;
    const droppedBefore = client.getTransportStats().dropped;
    // Force the next frame into the 33 ms sleep window, then switch models inside that window.
    client.lastFrameAt = Date.now();
    const pending = client.injectInputs([{ name: 'MouthOpen', value: 0.9 }]);
    await sleep(5);
    fake.emitModelLoaded({ modelName: 'FakeMiku', modelID: 'model-B' });
    const outcome = await pending;
    await sleep(120);

    const stats = client.getTransportStats();
    assert(fake.frames.length === framesBefore, `no InjectParameterDataRequest after the switch (saw ${fake.frames.length - framesBefore})`);
    assert(outcome.ok === false, 'the stale frame fails instead of pretending success');
    assert(outcome.sent === false, 'the stale frame was not sent');
    assert(stats.dropped > droppedBefore, 'the drop is counted');
    assert(stats.lastDropReason === 'stale', `the drop reason is stale (got ${stats.lastDropReason})`);
  } finally {
    client.close();
    await fake.close();
  }
});

// 4) Authentication must subscribe to ModelLoadedEvent, and a reconnect must subscribe again.
test('4. 认证后订阅 ModelLoadedEvent，断线重连后再次订阅', async () => {
  const fake = await createFakeVts({ defaultParameters: [MOUTH_INPUT] });
  const client = new VtsClient({ port: fake.port, tokenPath: join(await tmp('g4'), 'token.json') });
  try {
    await client.connect();
    assert(fake.subscriptions.length === 1, `one subscription after connect (got ${fake.subscriptions.length})`);
    assert(fake.subscriptions[0].eventName === 'ModelLoadedEvent', 'ModelLoadedEvent is requested');
    assert(fake.subscriptions[0].subscribe === true, 'the request carries subscribe:true');
    assert(fake.subscriptions[0].config !== undefined, 'the request carries a config object');
    assert(client.eventsSubscribed === true, 'the client records a successful subscription');
    assert(client.subscribedEvents.includes('ModelLoadedEvent'), 'the client lists ModelLoadedEvent');

    const recipients = fake.emitModelLoaded({ modelName: 'FakeMiku', modelID: 'model-B' });
    assert(recipients === 1, `a subscribed connection receives the model event (got ${recipients})`);
    const sawPush = await waitFor(() => client.modelId === 'model-B', 2000, 25);
    assert(sawPush === true, 'the subscribed client processes ModelLoadedEvent');

    fake.disconnect();
    const disconnected = await waitFor(() => client.connected === false, 2000, 25);
    assert(disconnected === true, 'the fake disconnect is observed');
    assert(client.eventsSubscribed === false, 'a dead socket is not reported as subscribed');
    await client.connect();
    assert(fake.subscriptions.length === 2, `a reconnect subscribes a second time (got ${fake.subscriptions.length})`);
    assert(fake.subscriptions[1].eventName === 'ModelLoadedEvent', 'the second subscription is ModelLoadedEvent');
    assert(fake.subscriptions[1].subscribe === true, 'the reconnected request also carries subscribe:true');
    assert(client.eventsSubscribed === true, 'the reconnected client is subscribed again');
    assert(fake.emitModelLoaded({ modelName: 'FakeRin', modelID: 'model-C' }) === 1, 'the reconnected socket is registered again');
  } finally {
    client.close();
    await fake.close();
  }
});

// 4b) A rejected subscription is recorded, not fatal.
test('4b. EventSubscriptionRequest 被拒 → 记录错误但连接仍可用', async () => {
  const fake = await createFakeVts({ defaultParameters: [MOUTH_INPUT], subscriptionError: true });
  let modelChanges = 0;
  const client = new VtsClient({
    port: fake.port,
    tokenPath: join(await tmp('g4b'), 'token.json'),
    onModelChanged: () => { modelChanges += 1; },
  });
  try {
    const connected = await client.connect();
    assert(connected.ok === true, 'connect succeeds despite the rejected subscription');
    assert(client.ready === true, 'the client is ready');
    assert(client.eventsSubscribed === false, 'the subscription is not claimed');
    assert(/event subscription rejected/u.test(client.lastEventError), 'the subscription error is recorded');
    assert(/event subscription rejected/u.test(client.subscriptionError), 'subscriptionError carries the reason');
    assert(fake.emitModelLoaded({ modelName: 'FakeMiku', modelID: 'model-B' }) === 0, 'no event is pushed to a rejected connection');
    await sleep(150);
    assert(modelChanges === 0, 'the unsubscribed client never sees a model change');
  } finally {
    client.close();
    await fake.close();
  }
});

// 5) subscribe:true is mandatory, and a request without it must never look subscribed.
test('5. 请求缺 subscribe:true → 假服务器 APIError、不登记、不推送（修前：误报已订阅）', async () => {
  const fake = await createFakeVts({ defaultParameters: [MOUTH_INPUT] });
  const client = new VtsClient({ port: fake.port, tokenPath: join(await tmp('g5'), 'token.json') });
  const raw = await openRawSocket(fake);
  try {
    const received = [];
    raw.on('message', (message) => {
      try {
        received.push(JSON.parse(String(message)));
      } catch {
        /* ignore non-JSON */
      }
    });
    raw.send(JSON.stringify({
      apiName: 'VTubeStudioPublicAPI',
      apiVersion: '1.0',
      requestID: 'raw-missing-subscribe',
      messageType: 'EventSubscriptionRequest',
      data: { eventName: 'ModelLoadedEvent' },
    }));
    const answered = await waitFor(() => received.some((m) => m.messageType === 'APIError'), 2000, 25);
    assert(answered === true, 'the fake answers a subscription request without subscribe:true with APIError');
    const apiError = received.find((m) => m.messageType === 'APIError');
    assert(/subscribe/u.test(apiError?.data?.message ?? ''), 'the APIError names the missing subscribe flag');
    assert(fake.subscriptions.at(-1)?.subscribe !== true, 'the fake saw the missing flag');

    assert(fake.emitModelLoaded({ modelName: 'Nope', modelID: 'model-X' }) === 0, 'the rejected connection is not in the push set');
    await sleep(150);
    assert(received.every((m) => m.messageType !== 'ModelLoadedEvent'), 'the raw socket receives no ModelLoadedEvent');

    await client.connect();
    assert(fake.subscriptions.at(-1)?.subscribe === true, 'the real client sends subscribe:true (the old code did not)');
    assert(client.eventsSubscribed === true, 'the real client is confirmed as subscribed');

    // Simulate the old request shape on an established connection: the rejection must be recorded
    // and must not leave eventsSubscribed true.
    const originalRequest = client.request.bind(client);
    client.request = (messageType, data, timeoutMs) => (messageType === 'EventSubscriptionRequest'
      ? originalRequest(messageType, { eventName: data?.eventName ?? '' }, timeoutMs)
      : originalRequest(messageType, data, timeoutMs));
    const rejected = await client.subscribeEvents();
    assert(rejected.ok === false, 'a confirmation is not invented for a request without subscribe:true');
    assert(client.eventsSubscribed === false, 'eventsSubscribed is false after the rejection');
    assert(/subscribe/u.test(client.subscriptionError), 'the rejection reason is kept in subscriptionError');
    assert(/APIError/u.test(client.subscriptionResponse), 'the raw answer is kept (truncated) in subscriptionResponse');
  } finally {
    raw.terminate();
    client.close();
    await fake.close();
  }
});

// 6) A confirmation that does not name ModelLoadedEvent is not a subscription to it.
test('6. 应答只含 TestEvent / 空列表 → eventsSubscribed:false（修前：true）', async () => {
  // Isolate the confirmation parser first: a well-formed answer that names some other event, or
  // none at all, must never be reported as ModelLoadedEvent. This is exactly the old count>0 bug.
  for (const [label, reply] of [
    ['只含 TestEvent', { subscribedEventCount: 1, subscribedEvents: ['TestEvent'] }],
    ['空列表', { subscribedEventCount: 0, subscribedEvents: [] }],
  ]) {
    const client = new VtsClient({ port: 1, tokenPath: join(await tmp(`g6-parser-${label}`), 'token.json') });
    client.request = async () => ({
      apiName: 'VTubeStudioPublicAPI',
      apiVersion: '1.0',
      requestID: 'stub',
      messageType: 'EventSubscriptionResponse',
      data: reply,
    });
    const outcome = await client.subscribeEvents();
    assert(client.eventsSubscribed === false, `[${label}] eventsSubscribed stays false`);
    assert(outcome.ok === false, `[${label}] the confirmation is not accepted as success`);
    assert(client.subscribedEvents.length === 0 || !client.subscribedEvents.includes('ModelLoadedEvent'), `[${label}] ModelLoadedEvent is not claimed`);
    assert(client.subscriptionError.length > 0, `[${label}] the rejection reason is recorded`);
    assert(client.subscriptionResponse.length > 0, `[${label}] the raw answer is kept (truncated)`);
    client.close();
  }

  // Then the same answers end-to-end through the fake server and a real socket.
  for (const mode of ['test-only', 'empty']) {
    const fake = await createFakeVts({ defaultParameters: [MOUTH_INPUT], subscriptionReply: mode });
    const client = new VtsClient({ port: fake.port, tokenPath: join(await tmp(`g6-${mode}`), 'token.json') });
    try {
      const connected = await client.connect();
      assert(connected.ok === true, `[${mode}] connect still succeeds`);
      assert(client.ready === true, `[${mode}] the connection stays usable`);
      assert(client.eventsSubscribed === false, `[${mode}] a confirmation without ModelLoadedEvent is not success`);
      assert(client.lastEventError.length > 0, `[${mode}] the rejection reason is recorded`);
      assert(client.subscriptionError.length > 0, `[${mode}] subscriptionError carries the reason`);
      assert(client.subscriptionResponse.length > 0, `[${mode}] the raw answer is kept for diagnosis`);
      assert(!client.subscribedEvents.includes('ModelLoadedEvent'), `[${mode}] ModelLoadedEvent is not claimed`);
      if (mode === 'test-only') {
        assert(client.subscribedEvents.includes('TestEvent'), `[${mode}] the answer's list is preserved as-is`);
        assert(/TestEvent/u.test(client.subscriptionError), `[${mode}] the reason names what was confirmed`);
      }
      assert(fake.emitModelLoaded({ modelName: 'StillHere', modelID: 'model-D' }) === 1, `[${mode}] the socket is registered on the fake side`);
    } finally {
      client.close();
      await fake.close();
    }
  }
});

// 7) A socket that dies during the subscription must fail the connect, not fake readiness.
test('7. 认证成功但订阅请求发出后服务器关连接 → connect() 失败，ready/connected 保持 false（修前：ready:true）', async () => {
  const fake = await createFakeVts({ defaultParameters: [MOUTH_INPUT], dropOnSubscription: true });
  const client = new VtsClient({ port: fake.port, tokenPath: join(await tmp('g7'), 'token.json') });
  try {
    let failure = null;
    try {
      await client.connect();
    } catch (error) {
      failure = error;
    }
    assert(failure !== null, 'connect() fails when the socket dies during the subscription');
    assert(
      /connection|closed/iu.test(failure?.message ?? ''),
      `the failure explains the lost connection (got ${failure?.message})`,
    );
    assert(fake.subscriptions.length === 1, 'the subscription request did reach the server');
    assert(client.ready === false, 'ready stays false');
    assert(client.connected === false, 'connected is false');
    assert(client.authenticated === false, 'authenticated is cleared during cleanup');
    assert(client.eventsSubscribed === false, 'no subscription is claimed on a dead socket');

    // The failed connect must not wedge the client: a retry against a healthy server works.
    fake.state.dropOnSubscription = false;
    const retried = await client.connect();
    assert(retried.ok === true, 'a retry succeeds after the failed connect cleaned up');
    assert(client.ready === true, 'the retried connection is ready');
    assert(client.connected === true, 'the retried connection is open');
    assert(fake.subscriptions.length === 2, 'the retry sends a second subscription request');
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
