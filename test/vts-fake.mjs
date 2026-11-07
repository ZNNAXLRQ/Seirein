/**
 * Fake VTube Studio WebSocket check for the v0.91.0 avatar fixes.
 *
 * Covers the four things that could not be verified against a real VTS here:
 *   a) only FacePositionX available → gazeX is no longer reported as injectable;
 *   b) injectInputs rejects unknown names, clamps values and surfaces APIError;
 *   c) real-time frames coalesce: 100 pushes drop frames and never replay a backlog;
 *   d) a ModelLoadedEvent with a new model ID resets the capability cache, re-discovers and
 *      updates live2d.modelId / the avatar.model.changed event.
 *
 * Run: node test/vts-fake.mjs
 */
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WebSocketServer } from 'ws';

import { apply } from '../src/host/index.js';
import { discoverCapabilities, snapshot as avatarMotionSnapshot } from '../src/host/avatar/avatarMotion.js';
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

const results = {};
const assert = (condition, message) => {
  if (!condition) throw new Error(`assertion failed: ${message}`);
};

// ---- fake VTS -------------------------------------------------------------
function createFakeVts({
  defaultParameters,
  customParameters = [],
  modelParams = [],
  authOk = true,
  model = { modelName: 'FakeHiyori', modelID: 'model-A' },
} = {}) {
  const state = {
    defaultParameters: defaultParameters ?? [],
    customParameters,
    modelParams,
    authOk,
    model,
    inputListDelayMs: 0,
  };
  const frames = [];
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
      switch (request.messageType) {
        case 'AuthenticationTokenRequest':
          respond(socket, request, { authenticationToken: 'fake-token' });
          return;
        case 'AuthenticationRequest':
          respond(socket, request, state.authOk
            ? { authenticated: true }
            : { authenticated: false, reason: 'token not valid' });
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
          if (state.inputListDelayMs > 0) await sleep(state.inputListDelayMs);
          respond(socket, request, {
            defaultParameters: state.defaultParameters,
            customParameters: state.customParameters,
          });
          return;
        case 'Live2DParameterListRequest':
          respond(socket, request, { live2DModelParameters: state.modelParams });
          return;
        case 'InjectParameterDataRequest': {
          const values = request.data?.parameterValues ?? [];
          frames.push({ at: Date.now(), values });
          if (values.some((entry) => entry?.id === 'RejectMe')) {
            send(socket, {
              apiName: 'VTubeStudioPublicAPI',
              apiVersion: '1.0',
              requestID: request.requestID,
              messageType: 'APIError',
              data: { errorID: 300, message: 'Parameter id not allowed' },
            });
            return;
          }
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
        state,
        setDefaultParameters(list) {
          state.defaultParameters = list;
        },
        emitModelLoaded(nextModel, { delayInputListMs = 0 } = {}) {
          state.model = nextModel;
          state.inputListDelayMs = delayInputListMs;
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
        close() {
          for (const socket of wss.clients) socket.terminate();
          return new Promise((done) => wss.close(() => server.close(() => done())));
        },
      });
    });
  });
}

const tmp = (name) => mkdtemp(join(tmpdir(), `vts-fake-${name}-`));

// Every standard tracking input except eye direction: gaze must not be inferred from face position.
const FACE_ONLY_INPUTS = [
  { name: 'FacePositionX', min: -1, max: 1, defaultValue: 0 },
  { name: 'FacePositionY', min: -1, max: 1, defaultValue: 0 },
  { name: 'FaceAngleX', min: -30, max: 30, defaultValue: 0 },
  { name: 'MouthOpen', min: 0, max: 1, defaultValue: 0 },
  { name: 'RejectMe', min: 0, max: 1, defaultValue: 0 },
];
const FACE_ONLY_MODEL = [
  { name: 'ParamAngleX', min: -30, max: 30, defaultValue: 0 },
  { name: 'ParamMouthOpenY', min: 0, max: 1, defaultValue: 0 },
];

const fake = await createFakeVts({
  defaultParameters: FACE_ONLY_INPUTS,
  modelParams: FACE_ONLY_MODEL,
});

try {
  // ---- a) gaze semantics --------------------------------------------------
  const rootA = await tmp('a');
  const clientA = new VtsClient({ port: fake.port, tokenPath: join(rootA, 'token.json') });
  const connected = await clientA.connect();
  assert(connected.ok === true, 'fake VTS accepts the client');
  assert(clientA.ready === true && clientA.connected === true, 'connect sets ready + connected');
  assert(clientA.authenticated === true, 'connect authenticates');
  assert(clientA.modelId === 'model-A', 'model id is read from CurrentModelRequest');

  const caps = await discoverCapabilities({
    listInputParameters: () => clientA.listInputParameters(),
    listModelParameters: () => clientA.listModelParameters(),
    log: { emit: async () => {} },
  });
  results.faceOnly = {
    mapped: caps.mapped,
    verified: caps.verified,
    unmapped: caps.unmapped,
    gazeX: caps.inputs.gazeX,
    headX: caps.inputs.headX,
    mouth: caps.inputs.mouth,
  };
  assert(caps.ok === true, 'discovery succeeds');
  assert(!caps.mapped.includes('gazeX'), 'FacePositionX alone does not make gazeX injectable');
  assert(!caps.mapped.includes('gazeY'), 'FacePositionY alone does not make gazeY injectable');
  assert(caps.unmapped.includes('gazeX') && caps.unmapped.includes('gazeY'), 'gaze is explicitly unmapped');
  assert(caps.inputs.gazeX === null && caps.inputs.gazeY === null, 'no input entry for unmapped gaze');
  assert(caps.mapped.includes('headX'), 'FaceAngleX still drives headX');
  assert(caps.verified.includes('headX'), 'headX is verified by the input→model parameter rule');
  assert(caps.verified.includes('mouth'), 'mouth is verified by MouthOpen→ParamMouthOpenY');
  assert(caps.inputs.headX.injectable === true && caps.inputs.headX.verified === true, 'head entry carries both flags');
  assert(Array.isArray(caps.inputs.headX.modelParams) && caps.inputs.headX.modelParams.includes('ParamAngleX'), 'entry lists the target model parameter');
  assert(caps.inputs.headX.inputName === 'FaceAngleX', 'entry reports the input name');
  assert(caps.inputs.headX.notes.length > 0, 'entry carries evidence notes');

  // An explicit user declaration is the only other way into gaze.
  const declared = await discoverCapabilities({
    listInputParameters: async () => ({
      defaultParameters: FACE_ONLY_INPUTS,
      customParameters: [{ name: 'MyGazeX', min: -1, max: 1, defaultValue: 0 }],
    }),
    listModelParameters: async () => ({ ok: true, source: 'Live2DParameterListRequest', parameters: [] }),
    channelMap: { gazeX: 'MyGazeX' },
  });
  results.declaredGaze = { gazeX: declared.inputs.gazeX };
  assert(declared.mapped.includes('gazeX'), 'declared custom input makes gazeX injectable');
  assert(declared.verified.includes('gazeX'), 'declared custom input is verified, not merely a candidate');
  assert(declared.inputs.gazeX?.inputSource === 'declared', 'entry records the declaration as its source');

  // ---- b) injectInputs ----------------------------------------------------
  const unknown = await clientA.injectInputs([{ name: 'NoSuchInput', value: 0.5 }]);
  results.unknownInput = unknown;
  assert(unknown.ok === false, 'unknown input name is rejected');
  assert(unknown.rejected.includes('NoSuchInput'), 'rejection names the input');
  assert(/不在可注入列表/u.test(unknown.error), 'rejection explains why');
  assert(unknown.sent === false, 'nothing is sent for a rejected name');

  const framesBefore = fake.frames.length;
  const accepted = await clientA.injectInputs([
    { name: 'mouthopen', value: 5, weight: 0.5 },
    { name: 'NoSuchInput', value: 0.2 },
  ]);
  await sleep(120);
  results.acceptedInput = accepted;
  const sentFrame = fake.frames[fake.frames.length - 1];
  assert(accepted.ok === true, 'mixing a valid and an invalid name still sends the valid one');
  assert(accepted.rejected.includes('NoSuchInput'), 'partial rejection is reported');
  assert(fake.frames.length === framesBefore + 1, 'exactly one frame reached the server');
  assert(sentFrame.values[0].id === 'MouthOpen', 'the id is the canonical VTS spelling');
  assert(sentFrame.values[0].value === 1, 'value is clamped to the input maximum');
  assert(sentFrame.values[0].weight === 0.5, 'weight is forwarded');
  assert(sentFrame.values.length === 1, 'the rejected name is not sent');

  const apiError = await clientA.injectInputs([{ name: 'RejectMe', value: 0.5 }]);
  results.apiError = apiError;
  assert(apiError.ok === false, 'APIError makes injectInputs fail');
  assert(/APIError|Parameter id not allowed/u.test(apiError.error), 'APIError detail is surfaced');

  // ---- c) frame coalescing ------------------------------------------------
  const rootC = await tmp('c');
  const clientC = new VtsClient({ port: fake.port, tokenPath: join(rootC, 'token.json') });
  await clientC.connect();
  const before = fake.frames.length;
  const pushes = [];
  for (let index = 0; index < 100; index += 1) {
    pushes.push(clientC.injectInputs([{ name: 'MouthOpen', value: (index % 100) / 100 }]));
  }
  const outcomes = await Promise.all(pushes);
  const transport = clientC.getTransportStats();
  const settled = fake.frames.length;
  await sleep(600);
  const afterIdle = fake.frames.length;
  results.transport = {
    ...transport,
    framesReceived: settled - before,
    framesAfterIdle: afterIdle - before,
    superseded: outcomes.filter((entry) => entry.superseded === true).length,
  };
  assert(transport.dropped > 0, 'a rapid push drops frames instead of queueing them');
  assert(transport.sent >= 1 && transport.sent <= 12, `only the newest frames are sent (sent=${transport.sent})`);
  assert(settled - before <= 12, 'no backlog is replayed right after the burst');
  assert(afterIdle === settled, 'no late catch-up frames arrive afterwards');
  assert(transport.computedHz > 0 && transport.computedHz <= 31, 'computedHz reflects the frame path');
  assert(outcomes.some((entry) => entry.superseded === true), 'dropped frames resolve as superseded, not as errors');

  // ---- d) model switch (through the host, not the client alone) -----------
  const rootD = await mkdtemp(join(tmpdir(), 'vts-fake-d-'));
  await mkdir(join(rootD, 'data'), { recursive: true });
  await writeFile(join(rootD, 'data', 'features.json'), JSON.stringify({ avatar: true }), 'utf8');
  const routes = new Map();
  const fakeScope = () => ({
    effect: (fn) => fn(),
    webServer: {
      register: (route) => {
        routes.set(route.path, route.handler);
        return () => {};
      },
    },
    systemPrompt: { section: () => () => {} },
  });
  const fakeCtx = {
    effect: (fn) => fn(),
    tools: { register: () => () => {} },
    inject: (_names, callback) => callback(fakeScope()),
  };
  apply(fakeCtx, { root: rootD, vtsPort: fake.port, enabled: true });

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

  const connectResult = await callRoute('/assistant/action', { body: { action: 'live2d.connect' } });
  results.hostConnect = connectResult;
  assert(connectResult.ok === true, 'host connects to the fake VTS');
  assert(connectResult.ready === true && connectResult.modelId === 'model-A', 'host reports ready + model id');

  const statusBefore = await callRoute('/assistant/status', { method: 'GET' });
  const capsBefore = statusBefore.live2d?.capabilities ?? {};
  results.statusBefore = {
    ready: statusBefore.live2d?.ready,
    modelId: statusBefore.live2d?.modelId,
    mapped: capsBefore.mapped,
    verified: capsBefore.verified,
    transport: statusBefore.live2d?.transport,
  };
  assert(statusBefore.live2d?.ready === true, 'status exposes live2d.ready');
  assert(statusBefore.live2d?.socketOpen === true, 'status exposes the socket state separately');
  assert(statusBefore.live2d?.authenticated === true, 'status exposes the auth state');
  assert(statusBefore.live2d?.modelId === 'model-A', 'status exposes live2d.modelId');
  assert(typeof statusBefore.live2d?.transport?.computedHz === 'number', 'status carries live2d.transport');
  assert(capsBefore.verified.includes('headX'), 'status separates verified channels from merely injectable ones');

  // The new model exposes one unrelated input; a 250 ms delay keeps the reset window observable.
  fake.setDefaultParameters([{ name: 'SomeOtherInput', min: 0, max: 1, defaultValue: 0 }]);
  fake.emitModelLoaded({ modelName: 'FakeMiku', modelID: 'model-B' }, { delayInputListMs: 250 });

  const resetObserved = await waitFor(() => avatarMotionSnapshot().discovered === false, 2000, 10);
  results.resetObserved = resetObserved;
  assert(resetObserved === true, 'a model change resets the capability cache');

  const settledStatus = await waitFor(async () => {
    const status = await callRoute('/assistant/status', { method: 'GET' });
    return status.live2d?.modelId === 'model-B' && status.live2d?.capabilities?.discovered === true;
  }, 5000, 100);
  assert(settledStatus === true, 'capabilities are re-discovered after the model change');

  const statusAfter = await callRoute('/assistant/status', { method: 'GET' });
  results.statusAfter = {
    modelId: statusAfter.live2d?.modelId,
    model: statusAfter.live2d?.model,
    mapped: statusAfter.live2d?.capabilities?.mapped,
    unmapped: statusAfter.live2d?.capabilities?.unmapped,
    parameterCount: statusAfter.live2d?.capabilities?.parameterCount,
  };
  assert(statusAfter.live2d?.model === 'FakeMiku', 'the new model name is reported');
  assert(statusAfter.live2d?.capabilities?.parameterCount?.default === 1, 'discovery ran against the new input list');
  assert(statusAfter.live2d?.capabilities?.mapped?.length === 0, 'no channel survives from the old model');

  const events = (await readFile(join(rootD, 'data', 'events.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  results.modelChangedEvent = events
    .filter((event) => event.type === 'avatar.model.changed')
    .map((event) => event.payload);
  assert(results.modelChangedEvent.some((data) => data.modelId === 'model-B'), 'avatar.model.changed is logged with the new model id');

  // ---- auth failure must not look like a connection -----------------------
  const rejectServer = await createFakeVts({ defaultParameters: FACE_ONLY_INPUTS, authOk: false });
  try {
    const rootE = await tmp('e');
    const clientE = new VtsClient({ port: rejectServer.port, tokenPath: join(rootE, 'token.json') });
    const failure = await clientE.connect().then(() => null, (error) => error);
    results.authFailure = {
      error: failure?.message ?? '',
      ready: clientE.ready,
      connected: clientE.connected,
      authenticated: clientE.authenticated,
    };
    assert(failure !== null, 'a rejected authentication throws');
    assert(/VTS auth failed/u.test(failure.message), 'the auth failure explains itself');
    assert(clientE.ready === false, 'a rejected authentication is not ready');
    assert(clientE.authenticated === false, 'a rejected authentication is not authenticated');
    assert(clientE.connected === false, 'a rejected authentication does not keep a socket that looks connected');

    // A second connect() must authenticate again, not return early because a socket was opened.
    const retry = await clientE.connect().then(() => null, (error) => error);
    results.authRetry = { error: retry?.message ?? '', tokenRequests: rejectServer.frames.length };
    assert(retry !== null, 'a retry after a failed auth authenticates again');
  } finally {
    await rejectServer.close();
  }
} finally {
  await fake.close();
}

console.log(JSON.stringify(results, null, 2));
console.log('\nFAKE VTS TEST PASSED');
process.exit(0);
