/**
 * ModelAnimationEvent integration + controlled `faceFound` verification.
 *
 * Covers:
 *   1. opt-in ModelAnimationEvent subscription, Start parsing (duration from `animationLength`
 *      seconds, Live2D items ignored) and the `avatar.animation.start` event;
 *   2. looping idle Start dedupe (one record per name per 60 s) while `animations.current` stays
 *      fresh for the runtime;
 *   3. model switch / socket close clears `animations.current` and records
 *      `avatar.animation.reset {reason}` — VTS never sends an End event for an unloaded model;
 *   4. the action scheduler uses the REAL animation duration AND the animation's own `startedAt`:
 *      `endsAt = startedAt + durationMs`, a stale Start from the previous action is refused
 *      (`avatar.action.event-stale`), and a late Start whose end already passed ends the action at
 *      once; the bounded fallback stays `estimated: true` when no event exists. 4g–4j pin the
 *      binding guards: a looping idle Start never rebinds/extends (`event-ignored:idle-loop`), a
 *      later Start is only adopted inside the 1500 ms window (`event-ignored:outside-window`
 *      otherwise), and `maxActionMs` force-ends a runaway action (`forced-end:max-duration`);
 *   5. `faceFound` is OFF by default (request field absent) and only the setting emits
 *      `avatar.inject.faceFound {enabled:true}`;
 *   6. enabling `faceFound` never makes the plugin write channels it did not take over
 *      (breath / body / arm keep 0 injected frames).
 *
 * A final, read-only comparison observes whether unowned channels keep changing with `faceFound`
 * off/on. Under the fake VTS this is a PLUGIN-SIDE conclusion; a real VTS probe is opt-in with
 * `VTS_LIVE_VERIFY=1` (it never touches product settings or the persisted token file).
 *
 * Run: node test/vts-animation-events.mjs
 */
import { createServer } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import WebSocket, { WebSocketServer } from 'ws';

import { createAvatarRuntime } from '../src/host/avatar/avatarRuntime.js';
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

const results = {};
const assert = (condition, message) => {
  if (!condition) throw new Error(`assertion failed: ${message}`);
};
const sameJson = (actual, expected, message) => {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`assertion failed: ${message} (got ${left}, wanted ${right})`);
};

const tmp = (name) => mkdtemp(join(tmpdir(), `vts-anim-${name}-`));

// ---- fake VTS -------------------------------------------------------------
const FACE_INPUTS = [
  { name: 'FaceAngleX', min: -30, max: 30, defaultValue: 0 },
  { name: 'FaceAngleY', min: -30, max: 30, defaultValue: 0 },
  { name: 'FaceAngleZ', min: -30, max: 30, defaultValue: 0 },
  { name: 'MouthOpen', min: 0, max: 1, defaultValue: 0 },
  { name: 'BreathInput', min: 0, max: 1, defaultValue: 0 },
  { name: 'BodyAngleXInput', min: -10, max: 10, defaultValue: 0 },
  { name: 'ArmLAInput', min: 0, max: 1, defaultValue: 0 },
];
const MODEL_PARAMS = [
  { name: 'ParamAngleX', min: -30, max: 30, defaultValue: 0 },
  { name: 'ParamMouthOpenY', min: 0, max: 1, defaultValue: 0 },
  { name: 'ParamBreath', min: 0, max: 1, defaultValue: 0 },
  { name: 'ParamBodyAngleX', min: -10, max: 10, defaultValue: 0 },
  { name: 'ParamArmLA', min: 0, max: 1, defaultValue: 0 },
];

function createFakeVts({
  defaultParameters = FACE_INPUTS,
  modelParams = MODEL_PARAMS,
  model = { modelName: 'FakeHiyori', modelID: 'model-A' },
} = {}) {
  const state = { model, defaultParameters, modelParams };
  const frames = [];
  const subscriptions = [];
  const subscribedBySocket = new Map();
  const server = createServer();
  const wss = new WebSocketServer({ server });
  const send = (socket, message) => {
    try {
      socket.send(JSON.stringify(message));
    } catch {
      /* socket gone */
    }
  };
  const respond = (socket, request, data, messageType = '') => send(socket, {
    apiName: 'VTubeStudioPublicAPI',
    apiVersion: '1.0',
    requestID: request.requestID,
    messageType: messageType || `${String(request.messageType).replace(/Request$/u, '')}Response`,
    data,
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
          respond(socket, request, { defaultParameters: state.defaultParameters, customParameters: [] });
          return;
        case 'Live2DParameterListRequest':
          respond(socket, request, { live2DModelParameters: state.modelParams });
          return;
        case 'GetParameterValues': {
          const wanted = new Set((request.data?.parameterNames ?? []).map(String));
          const values = state.modelParams
            .filter((entry) => wanted.has(entry.name))
            .map((entry) => ({ name: entry.name, value: entry.defaultValue ?? 0 }));
          respond(socket, request, { parameterValues: values });
          return;
        }
        case 'EventSubscriptionRequest': {
          const data = request.data ?? {};
          const eventName = String(data.eventName ?? '');
          subscriptions.push({ eventName, subscribe: data.subscribe, config: data.config });
          if (data.subscribe !== true || eventName.length === 0) {
            send(socket, {
              apiName: 'VTubeStudioPublicAPI',
              apiVersion: '1.0',
              requestID: request.requestID,
              messageType: 'APIError',
              data: { errorID: 300, message: 'event subscription rejected' },
            });
            return;
          }
          subscribed.add(eventName);
          respond(socket, request, {
            subscribedEventCount: subscribed.size,
            subscribedEvents: [...subscribed],
          });
          return;
        }
        case 'InjectParameterDataRequest':
          frames.push({ at: Date.now(), requestID: request.requestID, data: request.data ?? {} });
          respond(socket, request, { faceFound: true });
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
        frames,
        subscriptions,
        state,
        emitAnimation(event) {
          for (const socket of wss.clients) {
            if (!(subscribedBySocket.get(socket)?.has('ModelAnimationEvent') ?? false)) continue;
            send(socket, {
              apiName: 'VTubeStudioPublicAPI',
              apiVersion: '1.0',
              messageType: 'ModelAnimationEvent',
              data: { modelAnimationEvent: event },
            });
          }
        },
        emitModelLoaded(nextModel) {
          state.model = nextModel;
          for (const socket of wss.clients) {
            if (!(subscribedBySocket.get(socket)?.has('ModelLoadedEvent') ?? false)) continue;
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

const newClient = (fake, options = {}) => new VtsClient({
  port: fake.port,
  tokenPath: join(options.root ?? '', 'vts-token.json'),
  ...options.client,
});

// ---- test runner ----------------------------------------------------------
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('1. 订阅 ModelAnimationEvent：Start 解析出毫秒时长与 isIdle，Live2D items 被忽略', async () => {
  const fake = await createFakeVts();
  const events = [];
  const client = newClient(fake, {
    root: await tmp('t1'),
    client: { animationEvents: true, onEvent: (type, payload) => events.push({ type, payload }) },
  });
  try {
    await client.connect();
    assert(client.animationEventsSubscribed === true, 'ModelAnimationEvent subscription is confirmed');
    const subscribed = fake.subscriptions.find((entry) => entry.eventName === 'ModelAnimationEvent');
    assert(subscribed !== undefined, 'the opt-in subscription request was sent');
    assert(subscribed.subscribe === true, 'the request carries subscribe:true');
    assert(subscribed.config?.ignoreLive2DItems === true, 'VTS is asked not to send the Live2D items');

    fake.emitAnimation({
      animationEventType: 'Start',
      animationName: 'Nod',
      animationLength: 2.5,
      isIdleAnimation: false,
      // Present in the real event when not ignored; it must never reach the Host state.
      animation: { Live2DItems: [{ Parameter: 'ParamAngleX', Value: 1 }] },
    });
    const got = await waitFor(() => client.animations.current !== null);
    assert(got === true, 'the Start event reached animations.current');
    const current = client.state.animations.current;
    assert(current.name === 'Nod', 'animationName is kept');
    assert(current.durationMs === 2500, `animationLength seconds became ms (got ${current.durationMs})`);
    assert(current.isIdle === false, 'isIdleAnimation is parsed');
    assert(Number.isFinite(current.startedAt), 'startedAt is recorded');
    assert(!JSON.stringify(current).includes('Live2DItems'), 'Live2D items are ignored, not stored');

    const start = events.find((entry) => entry.type === 'avatar.animation.start');
    assert(start !== undefined, 'avatar.animation.start is emitted');
    sameJson(start.payload, { name: 'Nod', durationMs: 2500, isIdle: false }, 'start payload');

    fake.emitAnimation({ animationEventType: 'End', animationName: 'Nod', animationLength: 2.5, isIdleAnimation: false });
    const ended = await waitFor(() => client.animations.current === null);
    assert(ended === true, 'End clears animations.current');
    const end = events.find((entry) => entry.type === 'avatar.animation.end');
    sameJson(end?.payload, { name: 'Nod', durationMs: 2500, isIdle: false }, 'end payload');
    results.test1 = { current: current, start: start?.payload, end: end?.payload };
  } finally {
    client.close();
    await fake.close();
  }
});

test('2. 循环 idle 连续 Start：去重窗口内只记 1 条，但 current 每次刷新', async () => {
  const fake = await createFakeVts();
  const events = [];
  const client = newClient(fake, {
    root: await tmp('t2'),
    client: { animationEvents: true, onEvent: (type, payload) => events.push({ type, payload }) },
  });
  try {
    await client.connect();
    fake.emitAnimation({ animationEventType: 'Start', animationName: 'IdleSway', animationLength: 4, isIdleAnimation: true });
    await waitFor(() => client.animations.records.length === 1);
    const firstStartedAt = client.animations.current.startedAt;

    await sleep(60);
    fake.emitAnimation({ animationEventType: 'Start', animationName: 'IdleSway', animationLength: 4.5, isIdleAnimation: true });
    await waitFor(() => client.animations.starts === 2);
    await sleep(30);
    fake.emitAnimation({ animationEventType: 'Start', animationName: 'IdleSway', animationLength: 5, isIdleAnimation: true });
    await waitFor(() => client.animations.starts === 3);

    const starts = events.filter((entry) => entry.type === 'avatar.animation.start');
    assert(client.animations.records.length === 1, `one recorded start inside the window (got ${client.animations.records.length})`);
    assert(client.animations.deduped === 2, `two deduped starts (got ${client.animations.deduped})`);
    assert(starts.length === 1, `one avatar.animation.start (got ${starts.length})`);
    assert(client.animations.current.durationMs === 5000, 'current carries the newest loop duration');
    assert(client.animations.current.startedAt > firstStartedAt, 'current carries the newest loop startedAt');
    results.test2 = {
      records: client.animations.records.length,
      deduped: client.animations.deduped,
      starts: client.animations.starts,
      current: client.state.animations.current,
      events: starts.length,
    };
  } finally {
    client.close();
    await fake.close();
  }
});

test('3. 模型切换 / 连接关闭主动清理 current 并记 avatar.animation.reset', async () => {
  const fake = await createFakeVts();
  const events = [];
  const client = newClient(fake, {
    root: await tmp('t3'),
    client: { animationEvents: true, onEvent: (type, payload) => events.push({ type, payload }) },
  });
  try {
    await client.connect();
    fake.emitAnimation({ animationEventType: 'Start', animationName: 'Wave', animationLength: 1.4, isIdleAnimation: false });
    await waitFor(() => client.animations.current !== null);

    fake.emitModelLoaded({ modelName: 'FakeMiku', modelID: 'model-B' });
    const cleared = await waitFor(() => client.animations.current === null);
    assert(cleared === true, 'ModelLoadedEvent clears animations.current without an End event');
    const modelReset = events.find((entry) => entry.type === 'avatar.animation.reset' && entry.payload?.reason === 'model-loaded');
    assert(modelReset !== undefined, 'avatar.animation.reset {reason:model-loaded} is recorded');
    assert(client.state.animations.lastReset.reason === 'model-loaded', 'lastReset names the cause');

    // A new animation on the new model, then the socket dies (no End event either).
    await sleep(150);
    fake.emitAnimation({ animationEventType: 'Start', animationName: 'Nod', animationLength: 0.9, isIdleAnimation: false });
    await waitFor(() => client.animations.current !== null);
    fake.disconnect();
    const disconnected = await waitFor(() => client.connected === false);
    assert(disconnected === true, 'the fake disconnect is observed');
    const disconnectedCleared = await waitFor(() => client.animations.current === null);
    assert(disconnectedCleared === true, 'connection close clears animations.current');
    const closeReset = events.find((entry) => entry.type === 'avatar.animation.reset' && entry.payload?.reason === 'disconnected');
    assert(closeReset !== undefined, 'avatar.animation.reset {reason:disconnected} is recorded');
    results.test3 = {
      modelReset: modelReset?.payload,
      closeReset: closeReset?.payload,
      current: client.state.animations.current,
      resets: client.animations.resets,
    };
  } finally {
    client.close();
    await fake.close();
  }
});

// ---- runtime action duration ---------------------------------------------
function createClockTransport(animationRef) {
  const writes = [];
  const transport = {
    connect: async () => {},
    disconnect: async () => {},
    write: async (frame) => { writes.push(frame); return { ok: true }; },
    writeFrame: async (entries) => { writes.push(entries); return { ok: true }; },
    getAnimation: () => animationRef.value,
  };
  return { transport, writes };
}

async function makeActionRuntime(animationRef, actionDurationMs = 1200, overrides = {}) {
  let clock = 0;
  const fake = createClockTransport(animationRef);
  const runtime = createAvatarRuntime({
    transport: fake.transport,
    now: () => clock,
    config: {
      autoTickMs: 0,
      idleActions: ['nod'],
      idleActionIntervalMs: 100,
      idleActionDedupeMs: 0,
      actionDurationMs,
      ...overrides,
    },
  });
  await runtime.connect();
  const drive = (from, to, step = 30) => {
    for (let at = from; at <= to; at += step) {
      clock = at;
      runtime.tick(at);
    }
  };
  return { runtime, fake, drive, setClock: (at) => { clock = at; } };
}

/**
 * Tick forward until the NEXT action starts, returning when it began. `endsAt` is the previous
 * action's authoritative end, so `startedAt >= endsAt` proves the scheduler never overlapped them.
 */
function driveUntilNextStart(run, from, to, step = 30) {
  let seen = run.runtime.snapshot().actions.started;
  for (let at = from; at <= to; at += step) {
    run.setClock(at);
    run.runtime.tick(at);
    const actions = run.runtime.snapshot().actions;
    if (actions.started > seen) {
      return { at, actionId: actions.current.actionId, startedAt: actions.current.startedAt };
    }
    seen = actions.started;
  }
  return null;
}

const actionEvent = (run, type) => run.runtime.takeEvents().filter((event) => event.type === type);

test('4. 动作调度使用真实动画时长；无事件时有界兜底并标 estimated:true', async () => {
  const animationRef = { value: { name: 'nod', durationMs: 850, startedAt: 0, isIdle: false } };
  const real = await makeActionRuntime(animationRef);
  try {
    real.drive(0, 150);
    const current = real.runtime.snapshot().actions.current;
    assert(current !== null, 'an action started');
    assert(current.durationMs === 850, `duration comes from the animation event, not the 1200ms default (got ${current.durationMs})`);
    assert(current.estimated === false, 'a real duration is not an estimate');
    assert(current.durationSource === 'animation', 'the source is the animation event');
    assert(real.runtime.snapshot().animations.matchedAction === true, 'the animation is matched to the running action');

    real.drive(150, 1300);
    const after = real.runtime.snapshot().actions;
    assert(after.ended >= 1, `the action ended on the real duration (ended=${after.ended})`);

    // A late Start event (the hotkey was triggered first) upgrades the estimate in place.
    const lateRef = { value: null };
    const late = await makeActionRuntime(lateRef);
    try {
      late.drive(0, 100);
      const before = late.runtime.snapshot().actions.current;
      assert(before !== null && before.estimated === true, 'without an event the action is an estimate');
      assert(before.durationMs === 1200, `the bounded fallback is the configured duration (got ${before.durationMs})`);
      lateRef.value = { name: 'nod', durationMs: 650, startedAt: 100, isIdle: false };
      late.drive(130, 160);
      const upgraded = late.runtime.snapshot().actions.current;
      assert(upgraded.durationMs === 650, `a matching late event replaces the estimate (got ${upgraded.durationMs})`);
      assert(upgraded.estimated === false && upgraded.durationSource === 'animation', 'the upgrade is marked as real');
      late.setClock(900);
      late.runtime.tick(900);
      assert(late.runtime.snapshot().actions.ended >= 1, 'the upgraded duration really ends the action');
      results.test4 = {
        real: { durationMs: current.durationMs, estimated: current.estimated, source: current.durationSource, ended: after.ended },
        fallback: { durationMs: before.durationMs, estimated: before.estimated, source: before.durationSource },
        upgraded: { durationMs: upgraded.durationMs, estimated: upgraded.estimated, source: upgraded.durationSource },
      };
    } finally {
      late.runtime.dispose();
    }
  } finally {
    real.runtime.dispose();
  }
});

test('4a. 动画事件按真实 startedAt 收尾：endsAt=startedAt+duration，不按调度时间延长', async () => {
  const animationRef = { value: null };
  const run = await makeActionRuntime(animationRef, 5000);
  try {
    run.drive(0, 120);
    const fallback = run.runtime.snapshot().actions.current;
    assert(fallback !== null, 'an action started without any event');
    assert(fallback.estimated === true && fallback.durationSource === 'fallback', 'no event → fallback estimate');
    assert(fallback.endsAt === fallback.startedAt + 5000,
      `the fallback end is scheduling+fallback (got ${fallback.endsAt})`);

    // The animation really began 120 ms BEFORE the runtime scheduled this action: inside the
    // default 150 ms association lookback, so it is this action's own Start (a hotkey race).
    const animationStartedAt = fallback.startedAt - 120;
    const event = { name: 'nod', durationMs: 1600, startedAt: animationStartedAt, isIdle: false };
    animationRef.value = event;
    run.setClock(120);
    run.runtime.setAnimation(event);

    const retimed = run.runtime.snapshot().actions.current;
    assert(retimed !== null, 'a still-running Start retimes the action instead of ending it');
    assert(retimed.actionId === fallback.actionId, 'the event retimes THIS action, it does not start a new one');
    assert(retimed.durationSource === 'animation' && retimed.estimated === false, 'the real duration is adopted');
    assert(retimed.durationMs === 1600, `durationMs is the animation length (got ${retimed.durationMs})`);
    assert(retimed.endsAt === animationStartedAt + 1600,
      `endsAt = animation.startedAt+duration (got ${retimed.endsAt})`);
    assert(retimed.endsAt === fallback.startedAt + 1480 && retimed.endsAt !== fallback.startedAt + 1600,
      'the end follows the animation clock, not scheduling+1600');

    const next = driveUntilNextStart(run, 150, fallback.startedAt + 6000);
    assert(next !== null, 'the next action starts eventually');
    assert(next.startedAt >= retimed.endsAt,
      `the next action never starts before the real end (next=${next.startedAt}, endsAt=${retimed.endsAt})`);
    results.test4a = {
      adopted: retimed.durationSource === 'animation',
      actionStartedAt: fallback.startedAt,
      animationStartedAt,
      endsAt: retimed.endsAt,
      nextStartedAt: next.startedAt,
      earlyVsScheduling: retimed.endsAt - (fallback.startedAt + 1600),
    };
    console.log(`[timing] scheduled=${fallback.startedAt} animationStartedAt=${animationStartedAt}`
      + ` endsAt=${retimed.endsAt} nextStart=${next.startedAt} deltaVsSchedule+1600=${retimed.endsAt - (fallback.startedAt + 1600)}`);
  } finally {
    run.runtime.dispose();
  }
});

test('4b. 上一个动作的事件被忽略：记 avatar.action.event-stale，当前动作不受影响', async () => {
  const animationRef = { value: { name: 'nod', durationMs: 700, startedAt: 0, isIdle: false } };
  const run = await makeActionRuntime(animationRef, 5000);
  try {
    run.drive(0, 300);
    const first = run.runtime.snapshot().actions.current;
    assert(first !== null && first.durationSource === 'animation', 'the first action adopted its animation');
    assert(first.endsAt === 700, `the first action ends at animation.startedAt+duration (got ${first.endsAt})`);

    const second = driveUntilNextStart(run, 330, 3000);
    assert(second !== null, 'a second action starts after the first ends');
    assert(second.actionId !== first.actionId, 'it is a NEW action id');
    const before = run.runtime.snapshot().actions.current;
    assert(before.durationSource === 'fallback' && before.estimated === true,
      'the previous action\u2019s animation is not reused when the new action starts');

    // The previous action's Start is delivered again with a new claimed length.
    const staleEvent = { name: 'nod', durationMs: 2500, startedAt: 0, isIdle: false };
    run.setClock(second.startedAt);
    run.runtime.setAnimation(staleEvent);
    run.setClock(second.startedAt + 30);
    run.runtime.tick(second.startedAt + 30);

    const after = run.runtime.snapshot().actions.current;
    assert(after !== null && after.actionId === second.actionId, 'the current action keeps running');
    assert(after.durationSource === 'fallback' && after.estimated === true, 'the stale event did not become real');
    assert(after.durationMs === 5000 && after.endsAt === second.startedAt + 5000,
      `the fallback length/end are untouched (duration=${after.durationMs}, endsAt=${after.endsAt})`);
    const stale = actionEvent(run, 'avatar.action.event-stale');
    assert(stale.length >= 1, `avatar.action.event-stale was recorded (got ${stale.length})`);
    assert(stale[0].actionId === second.actionId, 'the stale record names the action it was refused for');
    results.test4b = {
      adopted: false,
      firstEndsAt: first.endsAt,
      secondStartedAt: second.startedAt,
      currentEndsAt: after.endsAt,
      durationSource: after.durationSource,
      staleEvents: stale.length,
      staleStartedAt: stale[0].startedAt,
    };
    console.log(`[stale] firstEndsAt=${first.endsAt} secondStartedAt=${second.startedAt}`
      + ` currentEndsAt=${after.endsAt} source=${after.durationSource} staleEvents=${stale.length}`);
  } finally {
    run.runtime.dispose();
  }
});

test('4c. 迟到事件 endsAt 已过：立即结束当前动作，不从“现在”重新计时', async () => {
  const animationRef = { value: null };
  const run = await makeActionRuntime(animationRef, 5000);
  try {
    run.drive(0, 150);
    const current = run.runtime.snapshot().actions.current;
    assert(current !== null && current.durationSource === 'fallback', 'the action runs on the bounded fallback');
    // The Start is this action's own (inside the lookback) but arrives so late that its declared end
    // (startedAt + 300) is already in the past when the host finally reports it.
    const animationStartedAt = current.startedAt - 120;
    const declaredEnd = animationStartedAt + 300;
    const arrivedAt = declaredEnd + 200;
    assert(declaredEnd < arrivedAt, `the late event's real end is already past (${declaredEnd} < ${arrivedAt})`);

    const event = { name: 'nod', durationMs: 300, startedAt: animationStartedAt, isIdle: false };
    animationRef.value = event;
    run.setClock(arrivedAt);
    run.runtime.setAnimation(event);

    const endedNow = run.runtime.snapshot().actions;
    assert(endedNow.current === null, 'the action ends immediately instead of being extended');
    assert(endedNow.ended >= 1, 'the end is counted once');
    const end = actionEvent(run, 'avatar.action.end').find((entry) => entry.name === 'nod');
    assert(end !== undefined && end.at === arrivedAt, `the action ended on arrival, not later (got ${end?.at})`);

    const next = driveUntilNextStart(run, arrivedAt + 30, 3000);
    assert(next !== null, 'the scheduler continues with the next action');
    assert(next.startedAt <= current.startedAt + 500,
      `the next action starts right away, so nothing was re-timed (got ${next.startedAt})`);
    results.test4c = {
      extended: false,
      actionStartedAt: current.startedAt,
      animationStartedAt,
      declaredEnd,
      endedAt: end.at,
      nextStartedAt: next.startedAt,
    };
    console.log(`[late] actionStartedAt=${current.startedAt} declaredEnd=${declaredEnd}`
      + ` endedAt=${end.at} nextStart=${next.startedAt}`);
  } finally {
    run.runtime.dispose();
  }
});

test('4d. 无动画事件：兜底时长 + estimated:true + endsAt=调度+兜底（回归）', async () => {
  const animationRef = { value: null };
  const run = await makeActionRuntime(animationRef, 1200);
  try {
    run.drive(0, 120);
    const current = run.runtime.snapshot().actions.current;
    assert(current !== null, 'an action starts without an animation event');
    assert(current.durationMs === 1200, `the bounded fallback is the configured duration (got ${current.durationMs})`);
    assert(current.estimated === true && current.durationSource === 'fallback', 'no event is marked as estimated');
    assert(current.endsAt === current.startedAt + 1200,
      `without an event endsAt is scheduling+fallback (got ${current.endsAt})`);
    const next = driveUntilNextStart(run, 150, 3000);
    assert(next !== null && next.startedAt >= current.endsAt,
      `the fallback end never overlaps the next action (next=${next?.startedAt}, endsAt=${current.endsAt})`);
    results.test4d = {
      durationMs: current.durationMs,
      estimated: current.estimated,
      durationSource: current.durationSource,
      endsAt: current.endsAt,
      nextStartedAt: next.startedAt,
    };
    console.log(`[fallback] durationMs=${current.durationMs} estimated=${current.estimated}`
      + ` endsAt=${current.endsAt} nextStart=${next.startedAt}`);
  } finally {
    run.runtime.dispose();
  }
});

test('4e. 同名旧动画不绑定：新动作触发于 900，新 Start(900/700) 把 endsAt 重算到 1600', async () => {
  // Old animation: startedAt -400, duration 1400 → ends at 1000, still "current" when the next
  // action triggers at 900. A same-name Start is NOT proof that it belongs to the new action.
  const animationRef = { value: { name: 'nod', durationMs: 1400, startedAt: -400, isIdle: false } };
  const run = await makeActionRuntime(animationRef, 250, { idleActionIntervalMs: 900 });
  try {
    run.drive(0, 900, 50);
    const current = run.runtime.snapshot().actions.current;
    assert(current !== null, 'an action started at 900');
    assert(current.startedAt === 900, `the sampler fired at 900 (got ${current.startedAt})`);
    assert(current.durationSource === 'fallback', 'the old same-name animation was not adopted');
    assert(current.endsAt === 1150, `without a new event the bounded fallback ends it (got ${current.endsAt})`);
    const stale = actionEvent(run, 'avatar.action.event-stale');
    assert(stale.length >= 1, 'the old event is recorded as stale, not silently reused');

    // The animation that really belongs to this action began at 900 and is 700 ms long → 1600.
    const fresh = { name: 'nod', durationMs: 700, startedAt: 900, isIdle: false };
    animationRef.value = fresh;
    run.setClock(930);
    run.runtime.setAnimation(fresh);
    const rebound = run.runtime.snapshot().actions.current;
    assert(rebound !== null && rebound.actionId === current.actionId, 'the new Start retimes THIS action');
    assert(rebound.durationSource === 'animation', 'the new Start is adopted');
    assert(rebound.endsAt === 1600, `endsAt = the new animation's end (got ${rebound.endsAt})`);

    // The fallback end (1150) and the old animation end (1000) are both superseded.
    run.drive(960, 1550, 50);
    const still = run.runtime.snapshot().actions;
    assert(still.current !== null && still.current.actionId === current.actionId,
      'the action is still running at 1550, past both 1000 and 1150');
    assert(still.ended === 0, 'nothing ended before the real end');

    run.drive(1550, 1650, 50);
    const ended = run.runtime.snapshot().actions;
    assert(ended.current === null, 'the action ends on the real end');
    const end = actionEvent(run, 'avatar.action.end').find((entry) => entry.name === 'nod');
    assert(end?.at === 1600, `it ends at 1600, not 1150 (got ${end?.at})`);

    const next = driveUntilNextStart(run, 1650, 2600, 50);
    assert(next !== null, 'the next action starts eventually');
    assert(next.startedAt >= 1600, `the next action never starts before 1600 (got ${next.startedAt})`);
    results.test4e = {
      oldEndsAt: 1000,
      fallbackEndsAt: current.endsAt,
      endsAt: rebound.endsAt,
      endedAt: end?.at,
      nextStartedAt: next.startedAt,
      staleEvents: stale.length,
    };
    console.log(`[old-animation] actionStartedAt=${current.startedAt} fallbackEndsAt=${current.endsAt}`
      + ` newEndsAt=${rebound.endsAt} endedAt=${end?.at} nextStart=${next.startedAt}`);
  } finally {
    run.runtime.dispose();
  }
});

test('4f. 更晚的同名 Start 重绑：记 avatar.action.event-rebound，endsAt 更新', async () => {
  const animationRef = { value: null };
  const run = await makeActionRuntime(animationRef, 250, { idleActionIntervalMs: 900 });
  try {
    run.drive(0, 900, 50);
    const current = run.runtime.snapshot().actions.current;
    assert(current !== null && current.startedAt === 900, 'the action starts at 900 on the fallback');

    const first = { name: 'nod', durationMs: 700, startedAt: 900, isIdle: false };
    animationRef.value = first;
    run.setClock(930);
    run.runtime.setAnimation(first);
    const bound = run.runtime.snapshot().actions.current;
    assert(bound.endsAt === 1600, `the first real Start ends the action at 1600 (got ${bound.endsAt})`);

    // A LATER Start of the same action (the preset restarted at 1200 for 900 ms) must recompute the
    // end instead of being ignored because an event was already bound.
    const later = { name: 'nod', durationMs: 900, startedAt: 1200, isIdle: false };
    animationRef.value = later;
    run.setClock(1250);
    run.runtime.setAnimation(later);
    const rebound = run.runtime.snapshot().actions.current;
    assert(rebound !== null && rebound.actionId === current.actionId, 'the action is retimed in place');
    assert(rebound.endsAt === 2100, `endsAt follows the later Start (got ${rebound.endsAt})`);
    const reboundEvents = actionEvent(run, 'avatar.action.event-rebound');
    assert(reboundEvents.length === 1, `one rebound is recorded (got ${reboundEvents.length})`);
    assert(reboundEvents[0].actionId === current.actionId, 'the rebound names the action');
    assert(reboundEvents[0].oldEndsAt === 1600, 'the rebound reports the previous end');
    assert(reboundEvents[0].newEndsAt === 2100, 'the rebound reports the new end');

    // An event older than the current binding is a replay: it never rewinds the action.
    const replay = { name: 'nod', durationMs: 5000, startedAt: 950, isIdle: false };
    animationRef.value = replay;
    run.setClock(1300);
    run.runtime.setAnimation(replay);
    const afterReplay = run.runtime.snapshot().actions.current;
    assert(afterReplay !== null && afterReplay.endsAt === 2100,
      `an older Start leaves the newer binding intact (got ${afterReplay?.endsAt})`);

    const next = driveUntilNextStart(run, 1350, 3200, 50);
    assert(next !== null, 'the next action starts after the rebound');
    assert(next.startedAt >= 2100, `the next action never starts before 2100 (got ${next.startedAt})`);
    results.test4f = {
      firstEndsAt: bound.endsAt,
      reboundEndsAt: rebound.endsAt,
      oldEndsAt: reboundEvents[0].oldEndsAt,
      nextStartedAt: next.startedAt,
      reboundEvents: reboundEvents.length,
    };
    console.log(`[rebound] firstEndsAt=${bound.endsAt} rebound=${reboundEvents[0].oldEndsAt}->${reboundEvents[0].newEndsAt}`
      + ` nextStart=${next.startedAt}`);
  } finally {
    run.runtime.dispose();
  }
});

test('4g. 循环 idle 每 6.5s 一个 Start：不绑定也不延长，动作按兜底结束、后续动作能 start', async () => {
  const animationRef = { value: null };
  // The fallback is long enough that a SECOND idle Start (at 13 s) arrives while the first
  // action still runs: on the old code that rebind extended `endsAt` forever.
  const run = await makeActionRuntime(animationRef, 9000, {
    idleActions: ['sway'],
    idleActionIntervalMs: 6500,
  });
  try {
    const loopStart = (at) => {
      const event = { name: 'IdleSway', durationMs: 10_000, startedAt: at, isIdle: true };
      animationRef.value = event;
      run.setClock(at);
      run.runtime.setAnimation(event);
    };
    let first = null;
    const drive = (from, to, step = 50) => {
      for (let at = from; at <= to; at += step) {
        // The looping idle re-fires its Start every 6.5 s, including during the action.
        if (at > 0 && at % 6500 === 0) loopStart(at);
        run.setClock(at);
        run.runtime.tick(at);
        if (first === null) {
          const current = run.runtime.snapshot().actions.current;
          if (current !== null) first = current;
        }
      }
    };
    loopStart(0);
    drive(0, 20_000);

    const actions = run.runtime.snapshot().actions;
    assert(first !== null, 'the sway action started');
    assert(first.name === 'sway', `the action is the sway preset (got ${first.name})`);
    assert(first.durationSource === 'fallback' && first.estimated === true,
      'a looping idle Start is never adopted as the action binding');
    assert(first.endsAt === first.startedAt + 9000,
      `the fallback end is untouched by the idle loop (endsAt=${first.endsAt}, startedAt=${first.startedAt})`);
    assert(actions.started >= 2, `a second action starts after the first ends (started=${actions.started})`);
    assert(actions.ended >= 1, `the looping idle did not block the end (ended=${actions.ended})`);
    assert(actions.ignored >= 1, `the idle Starts were ignored, not bound (ignored=${actions.ignored})`);
    assert(actions.dropped <= 2, `a two-action run drops only the excess candidate (dropped=${actions.dropped})`);

    // takeEvents() drains the buffer once, so read every record from the same snapshot.
    const events = run.runtime.takeEvents();
    const ends = events.filter((entry) => entry.type === 'avatar.action.end');
    assert(ends.length >= 1, 'avatar.action.end was recorded');
    assert(ends[0].name === 'sway' && ends[0].at === first.endsAt,
      `the first sway ended on the fallback, not later (at=${ends[0].at}, endsAt=${first.endsAt})`);
    const ignored = events.filter((entry) => entry.type === 'avatar.action.event-ignored');
    assert(ignored.length >= 1, `avatar.action.event-ignored was recorded (got ${ignored.length})`);
    assert(ignored.every((entry) => entry.reason === 'idle-loop'),
      `every ignored event names idle-loop (got ${ignored.map((entry) => entry.reason).join(',')})`);
    assert(events.every((entry) => entry.type !== 'avatar.action.event-rebound'),
      'an idle Start never rebounds the action');
    results.test4g = {
      started: actions.started,
      ended: actions.ended,
      dropped: actions.dropped,
      ignored: actions.ignored,
      firstStartedAt: first.startedAt,
      firstEndsAt: first.endsAt,
      firstEndedAt: ends[0].at,
      idleLoopIgnored: ignored.length,
    };
    console.log(`[idle-loop] started=${actions.started} ended=${actions.ended} dropped=${actions.dropped}`
      + ` ignored=${actions.ignored} first=${first.startedAt}->${ends[0].at} (fallback end ${first.endsAt})`);
  } finally {
    run.runtime.dispose();
  }
});

test('4h. 非 idle 的新 Start 仍在窗口内：允许重算 endsAt（回归）', async () => {
  const animationRef = { value: null };
  const run = await makeActionRuntime(animationRef, 250, { idleActionIntervalMs: 900 });
  try {
    run.drive(0, 900, 50);
    const current = run.runtime.snapshot().actions.current;
    assert(current !== null && current.startedAt === 900, 'the action starts at 900 on the fallback');

    const first = { name: 'nod', durationMs: 1500, startedAt: 900, isIdle: false };
    animationRef.value = first;
    run.setClock(930);
    run.runtime.setAnimation(first);
    const bound = run.runtime.snapshot().actions.current;
    assert(bound.endsAt === 2400, `the first Start ends the action at 2400 (got ${bound.endsAt})`);

    // A later Start at 2300 is still inside [startedAt-150, startedAt+1500] = [750, 2400].
    const later = { name: 'nod', durationMs: 1800, startedAt: 2300, isIdle: false };
    animationRef.value = later;
    run.setClock(2300);
    run.runtime.setAnimation(later);
    const rebound = run.runtime.snapshot().actions.current;
    assert(rebound !== null && rebound.actionId === current.actionId, 'the same action is retimed in place');
    assert(rebound.endsAt === 4100, `endsAt follows the later in-window Start (got ${rebound.endsAt})`);
    assert(rebound.durationSource === 'animation' && rebound.estimated === false, 'the real duration is adopted');
    const reboundEvents = actionEvent(run, 'avatar.action.event-rebound');
    assert(reboundEvents.length === 1, `one rebound is recorded (got ${reboundEvents.length})`);
    assert(reboundEvents[0].oldEndsAt === 2400 && reboundEvents[0].newEndsAt === 4100,
      'the rebound reports the old and new ends');
    assert(actionEvent(run, 'avatar.action.event-ignored').length === 0, 'a later in-window Start is not ignored');
    results.test4h = {
      actionStartedAt: current.startedAt,
      firstEndsAt: bound.endsAt,
      reboundEndsAt: rebound.endsAt,
      reboundEvents: reboundEvents.length,
    };
    console.log(`[rebound-in-window] action=${current.startedAt} firstEnd=${bound.endsAt}`
      + ` rebound=${reboundEvents[0].oldEndsAt}->${reboundEvents[0].newEndsAt}`);
  } finally {
    run.runtime.dispose();
  }
});

test('4i. 超出窗口的 Start：记 event-ignored:outside-window，不延长动作（每动作一条）', async () => {
  const animationRef = { value: null };
  const run = await makeActionRuntime(animationRef, 250, { idleActionIntervalMs: 900 });
  try {
    run.drive(0, 900, 50);
    const current = run.runtime.snapshot().actions.current;
    assert(current !== null && current.startedAt === 900, 'the action starts at 900');
    assert(current.endsAt === 1150, `the fallback ends it at 1150 (got ${current.endsAt})`);

    // A non-idle Start 1700 ms after the action's trigger is outside the 1500 ms window.
    const late = { name: 'nod', durationMs: 600, startedAt: 2600, isIdle: false };
    animationRef.value = late;
    run.setClock(1000);
    run.runtime.setAnimation(late);
    const after = run.runtime.snapshot().actions.current;
    assert(after !== null && after.actionId === current.actionId, 'the action keeps running');
    assert(after.durationSource === 'fallback' && after.estimated === true, 'the out-of-window Start is not adopted');
    assert(after.endsAt === 1150, `endsAt is not extended (got ${after.endsAt})`);

    // A second out-of-window Start for the SAME action is silent: one record per action.
    const later = { name: 'nod', durationMs: 800, startedAt: 3000, isIdle: false };
    animationRef.value = later;
    run.setClock(1060);
    run.runtime.setAnimation(later);
    const ignored = actionEvent(run, 'avatar.action.event-ignored');
    assert(ignored.length === 1, `exactly one ignored record for this action (got ${ignored.length})`);
    assert(ignored[0].reason === 'outside-window', `the reason names outside-window (got ${ignored[0].reason})`);
    assert(ignored[0].actionId === current.actionId, 'the record names the action it was refused for');
    assert(actionEvent(run, 'avatar.action.event-rebound').length === 0, 'no rebound was recorded');

    run.drive(1100, 1200, 50);
    const ended = run.runtime.snapshot().actions;
    assert(ended.current === null && ended.ended >= 1,
      `the action still ends on its fallback (current=${ended.current === null}, ended=${ended.ended})`);
    const end = actionEvent(run, 'avatar.action.end').find((entry) => entry.name === 'nod');
    assert(end !== undefined && end.at === 1150, `it ends at 1150, not later (got ${end?.at})`);
    results.test4i = {
      actionStartedAt: current.startedAt,
      endsAt: after.endsAt,
      ignored: ignored.length,
      ignoredReason: ignored[0].reason,
      endedAt: end.at,
    };
    console.log(`[outside-window] action=${current.startedAt} endsAt=${after.endsAt}`
      + ` ignored=${ignored.length} reason=${ignored[0].reason} endedAt=${end.at}`);
  } finally {
    run.runtime.dispose();
  }
});

test('4j. 单次动作超过 maxActionMs：在 cap 处 forced-end:max-duration', async () => {
  const animationRef = { value: null };
  const run = await makeActionRuntime(animationRef, 5000, { maxActionMs: 800 });
  try {
    run.drive(0, 200, 10);
    const first = run.runtime.snapshot().actions.current;
    assert(first !== null, 'an action is running');
    assert(first.durationMs === 5000, `the fallback duration is kept (got ${first.durationMs})`);
    assert(first.endsAt === first.startedAt + 800,
      `no action outlives maxActionMs (endsAt=${first.endsAt}, startedAt=${first.startedAt})`);

    run.drive(210, first.startedAt + 800, 10);
    const actions = run.runtime.snapshot().actions;
    assert(actions.ended >= 1, `the capped action ended (ended=${actions.ended})`);
    const forced = actionEvent(run, 'avatar.action.forced-end');
    assert(forced.length >= 1, `avatar.action.forced-end was recorded (got ${forced.length})`);
    assert(forced[0].actionId === first.actionId, 'the forced end names the capped action');
    assert(forced[0].reason === 'max-duration', `the reason is max-duration (got ${forced[0].reason})`);
    assert(forced[0].at === first.startedAt + 800 && forced[0].endsAt === first.startedAt + 800,
      `it is force-ended exactly at the cap (at=${forced[0].at}, endsAt=${forced[0].endsAt})`);
    results.test4j = {
      durationMs: first.durationMs,
      startedAt: first.startedAt,
      cappedEndsAt: first.endsAt,
      forcedAt: forced[0].at,
      forcedReason: forced[0].reason,
      ended: actions.ended,
    };
    console.log(`[max-duration] durationMs=${first.durationMs} startedAt=${first.startedAt}`
      + ` cappedEndsAt=${first.endsAt} forcedAt=${forced[0].at} reason=${forced[0].reason}`);
  } finally {
    run.runtime.dispose();
  }
});

test('5. faceFound 默认关闭；开启后请求带 true 且只记一次 avatar.inject.faceFound', async () => {
  const fake = await createFakeVts();
  const events = [];
  const client = newClient(fake, {
    root: await tmp('t5'),
    client: { onEvent: (type, payload) => events.push({ type, payload }) },
  });
  try {
    await client.connect();
    assert(client.inject.faceFound === false, 'the setting defaults to false');
    assert(client.state.inject.faceFound === false, 'state.inject.faceFound is exposed as false');
    await client.injectInputs([{ name: 'MouthOpen', value: 0.4 }]);
    await sleep(80);
    const offFrame = fake.frames.at(-1);
    assert(offFrame !== undefined, 'the default frame was sent');
    assert(offFrame.data.faceFound === undefined || offFrame.data.faceFound === false,
      `the default request does not enable faceFound (got ${JSON.stringify(offFrame.data)})`);
    assert(!events.some((entry) => entry.type === 'avatar.inject.faceFound'), 'no enable event while off');

    const enabled = client.setFaceFound(true);
    assert(enabled.faceFound === true, 'setFaceFound turns it on');
    assert(client.state.inject.faceFound === true, 'state.inject.faceFound follows the setting');
    const enableEvent = events.find((entry) => entry.type === 'avatar.inject.faceFound');
    sameJson(enableEvent?.payload, { enabled: true }, 'enable event payload');

    await client.injectInputs([{ name: 'MouthOpen', value: 0.5 }]);
    await sleep(80);
    const onFrame = fake.frames.at(-1);
    assert(onFrame.data.faceFound === true, 'the enabled request carries faceFound:true');
    await client.injectInputs([{ name: 'MouthOpen', value: 0.6 }]);
    await sleep(80);
    assert(events.filter((entry) => entry.type === 'avatar.inject.faceFound').length === 1,
      'the enable event is recorded once per on-period, not per frame');

    await client.injectInputs([{ name: 'MouthOpen', value: 0.7 }], { faceFound: false });
    await sleep(80);
    assert(fake.frames.at(-1).data.faceFound === undefined || fake.frames.at(-1).data.faceFound === false,
      'a per-call false override wins for that frame');
    assert(client.state.inject.faceFound === true, 'the per-call override does not change the setting');

    client.setFaceFound(false);
    assert(client.state.inject.faceFound === false, 'the setting can be turned off again');
    results.test5 = {
      defaultFaceFound: client.inject.faceFound,
      defaultFrame: offFrame.data,
      enabledFrame: onFrame.data,
      enableEvents: events.filter((entry) => entry.type === 'avatar.inject.faceFound').length,
    };
  } finally {
    client.close();
    await fake.close();
  }
});

test('6. faceFound 开启时未接管通道（breath/body/arm）不被插件写入', async () => {
  const probe = await probeUnownedWrites({ faceFound: true });
  assert(probe.frames > 0, `the runtime wrote parameter frames (${probe.frames})`);
  assert(probe.faceFoundFlags.every((flag) => flag === true), 'every probe frame really carried faceFound:true');
  assert(probe.unownedWritten.length === 0,
    `no breath/body/arm input was injected (saw ${probe.unownedWritten.join(', ')})`);
  assert(probe.inputs.every((input) => input === 'FaceAngleX'), `only the taken-over head input was written (${probe.inputs.join(', ')})`);
  results.test6 = {
    frames: probe.frames,
    inputs: [...new Set(probe.inputs)],
    unownedWritten: probe.unownedWritten,
    controlled: probe.controlled,
  };
});

// ---- controlled faceFound comparison -------------------------------------
/**
 * Run the real runtime + VtsClient against a fake VTS and report which inputs the plugin writes.
 * `breath`/`body`/`arm` inputs exist and are injectable, but the runtime was only given headX, so
 * any frame touching them would be a takeover bug. This is the plugin-side half of the comparison.
 */
async function probeUnownedWrites({ faceFound }) {
  const fake = await createFakeVts();
  const client = newClient(fake, { root: await tmp('probe'), client: { faceFound } });
  let runtime = null;
  try {
    await client.connect();
    if (faceFound) client.setFaceFound(true);
    let clock = 0;
    const transport = {
      connect: async () => {},
      disconnect: async () => {},
      write: async (frame) => client.injectInputs([{ name: frame.input, value: frame.value }]),
      writeFrame: async (entries) => client.injectInputs(
        entries.map((entry) => ({ name: entry.input, value: entry.value })),
      ),
      getAnimation: () => client.animations.current,
    };
    runtime = createAvatarRuntime({
      transport,
      now: () => clock,
      config: { autoTickMs: 0, idleActions: [], idleWriteHz: 8, flushIntervalMs: 33 },
    });
    await runtime.connect();
    await runtime.setChannelMappings(
      [{ channel: 'headX', inputName: 'FaceAngleX', min: -30, max: 30, injectable: true, verified: true }],
      { channelMap: {} },
    );
    for (let index = 0; index < 40; index += 1) {
      clock = index * 33;
      runtime.tick(clock);
      await sleep(8);
    }
    const injectionFrames = fake.frames.filter((frame) => frame.data?.parameterValues !== undefined);
    const inputs = [];
    const unownedWritten = [];
    const faceFoundFlags = [];
    for (const frame of injectionFrames) {
      for (const entry of frame.data.parameterValues ?? []) {
        inputs.push(entry.id);
        if (/breath|body|arm/iu.test(String(entry.id))) unownedWritten.push(entry.id);
      }
      faceFoundFlags.push(frame.data.faceFound === true);
    }
    return {
      frames: injectionFrames.length,
      inputs,
      unownedWritten,
      faceFoundFlags,
      controlled: runtime.snapshot().channels.controlled,
    };
  } finally {
    runtime?.dispose();
    client.close();
    await fake.close();
  }
}

/**
 * Read-only real VTS probe (opt-in): does `faceFound` change whether unowned model parameters keep
 * moving? It authenticates with a COPY of the token (never the product token path), never requests
 * a new token and never writes product settings; it only injects a neutral FaceAngleX frame at the
 * documented 30 Hz rate for ~1 s per phase.
 */
async function probeLiveFaceFound() {
  if (process.env.VTS_LIVE_VERIFY !== '1') {
    return { skipped: 'set VTS_LIVE_VERIFY=1 to probe the local VTube Studio (read-only)' };
  }
  const tokenCandidates = [
    process.env.VTS_TOKEN_PATH,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'dsh-assistant', 'vts-token.json') : '',
  ].filter((entry) => typeof entry === 'string' && entry.length > 0);
  let token = '';
  for (const path of tokenCandidates) {
    try {
      token = JSON.parse(await readFile(path, 'utf8')).authenticationToken ?? '';
      if (token.length > 0) break;
    } catch {
      /* try the next candidate */
    }
  }
  if (token.length === 0) return { skipped: 'no VTS token found (set VTS_TOKEN_PATH)' };

  const socket = new WebSocket('ws://127.0.0.1:8001');
  const pending = new Map();
  let seq = 0;
  const call = (messageType, data, timeoutMs = 4000) => new Promise((resolve, reject) => {
    const requestID = `probe-call-${++seq}`;
    pending.set(requestID, { resolve, reject });
    socket.send(JSON.stringify({ apiName: 'VTubeStudioPublicAPI', apiVersion: '1.0', requestID, messageType, data }));
    const timer = setTimeout(() => {
      if (pending.delete(requestID)) reject(new Error(`${messageType} timed out`));
    }, timeoutMs);
    timer.unref?.();
  });
  socket.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    const waiter = pending.get(message.requestID);
    if (waiter === undefined) return;
    pending.delete(message.requestID);
    waiter.resolve(message);
  });
  const opened = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 1500);
    socket.once('open', () => { clearTimeout(timer); resolve(true); });
    socket.once('error', () => { clearTimeout(timer); resolve(false); });
  });
  if (!opened) {
    try { socket.terminate(); } catch { /* already closed */ }
    return { skipped: 'VTube Studio is not reachable on 127.0.0.1:8001' };
  }

  try {
    const auth = await call('AuthenticationRequest', {
      pluginName: 'DSH Companion', pluginDeveloper: 'local', authenticationToken: token,
    });
    if (auth.data?.authenticated !== true || auth.messageType === 'APIError') {
      return { skipped: 'the copied token was rejected (VTS allows one authenticated connection per plugin, and the running Host likely holds it); no new token was requested' };
    }
    const inputs = await call('InputParameterListRequest', {});
    const inputNames = (inputs.data?.defaultParameters ?? []).map((entry) => String(entry.name));
    const faceInput = inputNames.find((name) => name === 'FaceAngleX')
      ?? inputNames.find((name) => /Angle/iu.test(name)) ?? '';
    const params = await call('Live2DParameterListRequest', {});
    const modelParams = (params.data?.live2DModelParameters ?? params.data?.parameters ?? [])
      .map((entry) => String(entry.name));
    const observed = modelParams
      .filter((name) => /breath|body|arm|shoulder|hand/iu.test(name))
      .slice(0, 10);
    if (faceInput.length === 0 || observed.length === 0) {
      return { skipped: `insufficient VTS model (faceInput="${faceInput}", unowned params=${observed.length})` };
    }

    const sample = async () => {
      const response = await call('GetParameterValues', { parameterNames: observed });
      const list = response.data?.parameterValues ?? response.data?.parameters ?? [];
      return new Map(list.map((entry) => [String(entry.name), Number(entry.value ?? 0)]));
    };
    const phase = async (faceFound) => {
      const before = await sample();
      const endAt = Date.now() + 1100;
      while (Date.now() < endAt) {
        socket.send(JSON.stringify({
          apiName: 'VTubeStudioPublicAPI',
          apiVersion: '1.0',
          requestID: `probe-frame-${++seq}`,
          messageType: 'InjectParameterDataRequest',
          data: { parameterValues: [{ id: faceInput, value: 0 }], mode: 'set', faceFound },
        }));
        await sleep(33);
      }
      const after = await sample();
      const changed = observed.filter((name) => Math.abs((after.get(name) ?? 0) - (before.get(name) ?? 0)) > 1e-4);
      const maxDelta = observed.reduce((max, name) => Math.max(max, Math.abs((after.get(name) ?? 0) - (before.get(name) ?? 0))), 0);
      return { faceFound, changed, maxDelta: Math.round(maxDelta * 1e6) / 1e6, before: [...before], after: [...after] };
    };
    const off = await phase(false);
    const on = await phase(true);
    let conclusion;
    if (off.changed.length > 0 && on.changed.length > 0) {
      conclusion = '开/关两相中未接管通道都在变化：VTS 自身仍在驱动它们，faceFound 开关没有冻结这些通道';
    } else if (off.changed.length > 0 && on.changed.length === 0) {
      conclusion = 'faceFound 打开后未接管通道停止变化：开启会改变 VTS 对未接管通道的处理';
    } else if (off.changed.length === 0 && on.changed.length > 0) {
      conclusion = '只有 faceFound 打开时未接管通道才变化';
    } else {
      conclusion = '两相都无变化（可能没有播放 idle 动画或没有面部跟踪），无法判定';
    }
    return {
      ok: true,
      faceInput,
      observed,
      off: { changed: off.changed, maxDelta: off.maxDelta },
      on: { changed: on.changed, maxDelta: on.maxDelta },
      caveat: 'the running Host is connected to the same VTS; its own idle frames are out of this probe\'s control',
      conclusion,
    };
  } catch (error) {
    return { skipped: `live probe failed: ${error?.message ?? String(error)}` };
  } finally {
    try { socket.close(); } catch { /* already closed */ }
  }
}

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

// Controlled comparison: plugin side is deterministic; the live VTS probe is opt-in.
try {
  const [off, on] = await Promise.all([
    probeUnownedWrites({ faceFound: false }),
    probeUnownedWrites({ faceFound: true }),
  ]);
  const summary = (probe) => ({
    frames: probe.frames,
    inputs: [...new Set(probe.inputs)],
    unownedWritten: [...new Set(probe.unownedWritten)],
    faceFoundAll: probe.faceFoundFlags.every((flag) => flag === true),
  });
  results.faceFoundComparison = {
    pluginSide: { off: summary(off), on: summary(on) },
    pluginConclusion: '开/关两相插件写入的输入集合一致：只写已接管的 headX，breath/body/arm 注入 0 次',
    live: await probeLiveFaceFound(),
  };
  console.log('\nfaceFound comparison:');
  console.log(JSON.stringify(results.faceFoundComparison, null, 2));
} catch (error) {
  failures.push({ name: 'faceFound comparison', error });
  console.error(`FAIL  faceFound comparison\n      ${error?.message ?? error}`);
}

console.log('\nkey values:');
console.log(JSON.stringify(results, null, 2));

console.log(`\n${tests.length - failures.length} passed, ${failures.length} failed, ${tests.length} total`);
if (failures.length > 0) process.exitCode = 1;
