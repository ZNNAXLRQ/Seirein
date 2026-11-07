/**
 * P-55 end-to-end: a model switch while a discovery request is still in flight.
 *
 * The unit-level tests in test/avatar-discovery.mjs pin the identity rules in avatarMotion.js. This
 * file proves the *host wiring* uses them: model A's InputParameterListRequest is deliberately held
 * open, model B is loaded from inside VTube Studio, and only B's map may reach status/runtime.
 *
 * Pinned:
 *   - A's late answer emits `avatar.discovery.dropped {reason:'stale-identity', modelId:'model-A'}`
 *     and never emits `avatar.capabilities` with A's mapped channels;
 *   - B's map is adopted (status capabilities = B, no headX) and emits `avatar.discovery.done`;
 *   - the switch really started a second probe (`model-A` + `model-B` requests), i.e. force/no-cache
 *     across identities;
 *   - a later non-forced connect for B hits the identity-keyed cache (no third request, no start).
 *
 * Run: node --test test/avatar-discovery-host.mjs
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { WebSocketServer } from 'ws';

import { apply } from '../src/host/index.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (check, timeoutMs = 5000, stepMs = 25) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await sleep(stepMs);
  }
  return false;
};

const MOUTH = { name: 'MouthOpen', min: 0, max: 1, defaultValue: 0 };
const HEAD = { name: 'FaceAngleX', min: -30, max: 30, defaultValue: 0 };

/**
 * Fake VTS that answers InputParameterListRequest with the parameters of the model that was
 * current *when the request arrived*, after a per-request delay. That is what a slow VTS does when
 * the user switches models while the answer is still on the wire.
 */
async function createFakeVts() {
  const state = {
    model: { modelName: 'ModelA', modelID: 'model-A' },
    parameters: [MOUTH, HEAD],
    listDelayMs: 350,
  };
  /** Every InputParameterListRequest, with the model and parameters it was answered with. */
  const listRequests = [];
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
          respond(socket, request, { modelLoaded: true, ...state.model });
          return;
        case 'HotkeysInCurrentModelRequest':
          respond(socket, request, { availableHotkeys: [] });
          return;
        case 'ExpressionStateRequest':
          respond(socket, request, { expressions: [] });
          return;
        case 'InputParameterListRequest': {
          // Bind the answer to the model/parameters that exist right now, then delay the reply.
          const entry = {
            modelID: state.model.modelID,
            parameters: state.parameters,
            delayMs: state.listDelayMs,
          };
          listRequests.push(entry);
          const reply = () => respond(socket, request, {
            defaultParameters: entry.parameters,
            customParameters: [],
          });
          if (entry.delayMs > 0) setTimeout(reply, entry.delayMs);
          else reply();
          return;
        }
        case 'Live2DParameterListRequest':
          // The model parameter list is what turns an input into a verified binding: an empty
          // list makes every input merely injectable, which is no longer good enough.
          respond(socket, request, {
            live2DModelParameters: state.parameters.map((entry) => ({
              name: entry.name === 'MouthOpen' ? 'ParamMouthOpenY' : 'ParamAngleX',
            })),
          });
          return;
        case 'EventSubscriptionRequest':
          respond(socket, request, { subscribedEventCount: 1, subscribedEvents: ['ModelLoadedEvent'] });
          return;
        case 'InjectParameterDataRequest':
          respond(socket, request, {});
          return;
        default:
          respond(socket, request, {});
      }
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    listRequests,
    /** Load a new model inside VTS and let the host observe ModelLoadedEvent. */
    emitModelLoaded(nextModel, { parameters = [] } = {}) {
      state.model = nextModel;
      state.parameters = parameters;
      state.listDelayMs = 0;
      for (const socket of wss.clients) {
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
    },
    async close() {
      for (const socket of wss.clients) socket.terminate();
      await new Promise((done) => wss.close(() => server.close(() => done())));
    },
  };
}

async function startHost(fake) {
  const root = await mkdtemp(join(tmpdir(), 'avatar-discovery-host-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await writeFile(join(root, 'data', 'features.json'), JSON.stringify({ avatar: true }), 'utf8');
  const routes = new Map();
  const disposers = [];
  const collect = (fn) => {
    const dispose = fn();
    if (typeof dispose === 'function') disposers.push(dispose);
    return dispose;
  };
  const fakeCtx = {
    effect: collect,
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
  return { root, callRoute, status, events, dispose };
}

test('a model switch while A is in flight drops A and adopts B', async (t) => {
  const fake = await createFakeVts();
  const host = await startHost(fake);
  t.after(async () => {
    host.dispose();
    await fake.close();
  });

  const connected = await host.callRoute('/assistant/action', { body: { action: 'live2d.connect' } });
  assert.equal(connected.ok, true, `connect succeeds (${connected.error ?? ''})`);
  assert.equal(connected.modelId, 'model-A');

  // A's InputParameterListRequest is on the wire and will not be answered for ~350 ms.
  const requested = await waitFor(() => fake.listRequests.length >= 1);
  assert.equal(requested, true, 'discovery A sent InputParameterListRequest');
  assert.equal(fake.listRequests[0].modelID, 'model-A');
  assert.ok(fake.listRequests[0].parameters.includes(HEAD), 'A exposes head + mouth');

  // Switch models inside VTS while A's answer is still pending. B is answered immediately.
  fake.emitModelLoaded({ modelName: 'ModelB', modelID: 'model-B' }, { parameters: [MOUTH] });

  // B lands in two async steps: the discovery commit, then the model-changed reconnect. Wait for
  // both under one bounded poll (3 s), and fail with the status snapshot when the budget is spent.
  const adopted = await waitFor(async () => {
    const snapshot = await host.status();
    const caps = snapshot.live2d?.capabilities ?? {};
    return snapshot.live2d?.modelId === 'model-B' && caps.discovered === true
      && caps.mapped?.join(',') === 'mouth'
      && (snapshot.live2d?.runtime?.mouthInput ?? '') !== '';
  }, 3000, 50);
  if (!adopted) assert.fail(`B not adopted with runtime mouth after 3s: ${JSON.stringify((await host.status()).live2d)}`);
  assert.equal(adopted, true, 'B\'s capability map and the runtime mouth input are both adopted');

  const finalStatus = await host.status();
  assert.deepEqual(finalStatus.live2d.capabilities.mapped, ['mouth'], 'A\'s headX did not survive the switch');
  assert.equal(finalStatus.live2d.capabilities.unmapped.includes('headX'), true);
  assert.equal(finalStatus.live2d.runtime?.mouthInput, 'MouthOpen', 'the runtime took B\'s mouth mapping');

  // A late answer for A must not appear as a committed capability map.
  const settled = await waitFor(async () => {
    const list = await host.events();
    return list.some((event) => event.type === 'avatar.discovery.dropped')
      && fake.listRequests.length >= 2;
  });
  assert.equal(settled, true, 'A\'s late answer settles as dropped');
  await sleep(200);

  const events = await host.events();
  const dropped = events.filter((event) => event.type === 'avatar.discovery.dropped');
  const starts = events.filter((event) => event.type === 'avatar.discovery.start');
  const dones = events.filter((event) => event.type === 'avatar.discovery.done');
  const capabilities = events.filter((event) => event.type === 'avatar.capabilities');

  assert.deepEqual(
    dropped.map((event) => [event.payload.reason, event.payload.modelId]),
    [['stale-identity', 'model-A']],
    'exactly one dropped record, naming the stale model',
  );
  assert.deepEqual(starts.map((event) => event.payload.modelId), ['model-A', 'model-B'], 'both probes started');
  assert.deepEqual(dones.map((event) => event.payload.modelId), ['model-B'], 'only B completed');
  assert.equal(capabilities.some((event) => (event.payload.mapped ?? []).includes('headX')), false,
    'no avatar.capabilities event ever carried A\'s map');
  assert.deepEqual(capabilities.at(-1)?.payload.mapped, ['mouth'], 'the last committed map is B\'s');

  // A second, non-forced connect for the same identity must reuse B's cache: no third probe, no
  // new start event. This is the identity-keyed cache, observed end to end.
  const before = fake.listRequests.length;
  const startCount = starts.length;
  await host.callRoute('/assistant/action', { body: { action: 'live2d.connect' } });
  await sleep(250);
  assert.equal(fake.listRequests.length, before, 'the non-forced connect did not re-probe VTS');
  assert.equal((await host.events()).filter((event) => event.type === 'avatar.discovery.start').length,
    startCount, 'a cache hit emits no avatar.discovery.start');

  assert.deepEqual(fake.listRequests.map((entry) => entry.modelID).slice(0, 2), ['model-A', 'model-B'],
    'A and B were probed under their own identities');
  console.log(
    `[discovery] requests=${fake.listRequests.map((entry) => entry.modelID).join(',')}`
    + ` dropped=${dropped.length}(${dropped[0]?.payload.modelId}) done=${dones.length}`
    + ` adopted=${finalStatus.live2d.capabilities.mapped.join(',')}`
    + ` cachedRequests=${fake.listRequests.length - before}`,
  );
});
