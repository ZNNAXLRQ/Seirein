/**
 * P-48: visual preparation reuses one pre-request channel.
 *
 * The pre-step lane is driven for real (`agent/pre-step` waterfall), while sight.js / OBS /
 * attachments are doubles: no screen, ffmpeg, OBS process, virtual camera or real attachment store
 * is touched.
 *
 *   ① one preparation + assistant_see -> ONE capture; a watch take still packs a real
 *     storyboard (a single prepared frame is never served as a time sequence);
 *   ①b a late tool call names its own turn and never borrows the newer turn's frame;
 *   ② a new turn / an expired snapshot -> miss + a real re-capture;
 *   ③ a source/scene switch or privacy -> the cache is never reused (and privacy never captures);
 *   ④ a non-reuse delivery keeps the exact same result shape and image block;
 *   ⑤ a failed preparation leaves the turn running (fail-open) and the read still delivers.
 *
 * P2-1 owner binding, driven on a bare channel (no sight.js/OBS at all), ⑥-⑩:
 *   ⑥ a late capture from the old turn is discarded and never overwrites the new turn;
 *   ⑦ a late failure clears only its own entry and keeps the new turn's frame;
 *   ⑧ two sessions preparing concurrently keep one frame each;
 *   ⑨ take() with a mismatched session/turn/source/scene is a miss and returns null;
 *   ⑩ same-turn reuse still holds (attributed and unattributed callers);
 *   ⑪ `kind` separates a one-shot frame from a packed storyboard.
 *
 * Run: node --test test/vision-pre-request.mjs
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { registerHooks } from 'node:module';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cleanupRoot } from './helpers/cleanup.mjs';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const state = {
  captures: 0,
  captureImpl: null,
  implCalls: 0,
  starts: 0,
  takeCalls: 0,
  saves: [],
  obsScene: 'Main',
  virtualCamActive: true,
  obsRequests: [],
};
globalThis.__visionPreRequestTest = state;

const sightUrl = new URL('../src/host/vision/sight.js', import.meta.url).href;
const obsUrl = new URL('../src/host/vision/obs.js', import.meta.url).href;
const hooks = registerHooks({
  load(url, context, next) {
    if (url === sightUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `const s = globalThis.__visionPreRequestTest;
          const captureOnce = (o) => { s.captures += 1; s.implCalls += 1; return s.captureImpl(o); };
          export const resolveFfmpeg = () => 'fake-ffmpeg';
          export const resolveFfplay = () => null;
          export const capture = captureOnce;
          export const captureDesktop = captureOnce;
          export const captureDevice = captureOnce;
          export const startStoryboard = (o) => { s.starts += 1; return s.start(o); };
          export const shrinkShot = async () => null;
          export const OBSERVATION_TTL_MS = 30000;
          export function freshnessOf(at, now = Date.now(), ttlMs = OBSERVATION_TTL_MS) {
            const stamp = Number(at);
            if (!Number.isFinite(stamp) || stamp <= 0) return { at: null, ageMs: null, stale: true };
            const ageMs = Math.max(0, now - stamp);
            return { at: stamp, ageMs, stale: ageMs >= ttlMs };
          }
          export function readObservation(observation, { now = Date.now(), ttlMs = OBSERVATION_TTL_MS } = {}) {
            const value = observation ?? {};
            const captured = Number(value.capturedAt);
            const stored = Number.isFinite(captured) && captured > 0 ? captured : value.at;
            const freshness = freshnessOf(stored, now, ttlMs);
            return { ...value, ...freshness, hint: freshness.stale ? 'stale' : '' };
          }`,
      };
    }
    if (url === obsUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `export async function connectObs() {
          const s = globalThis.__visionPreRequestTest;
          return {
            async request(type, data) {
              s.obsRequests.push({ type, data: data ?? null });
              if (type === 'GetSceneList') {
                return { currentProgramSceneName: s.obsScene, scenes: [{ sceneName: 'Main' }, { sceneName: 'Other' }] };
              }
              if (type === 'SetCurrentProgramScene') { s.obsScene = String(data?.sceneName ?? ''); return {}; }
              if (type === 'GetVirtualCamStatus') return { outputActive: s.virtualCamActive };
              if (type === 'StartVirtualCam') { s.virtualCamActive = true; return {}; }
              if (type === 'StopVirtualCam') { s.virtualCamActive = false; return {}; }
              return {};
            },
            close() {},
          };
        }`,
      };
    }
    return next(url, context);
  },
});
const { apply } = await import('../src/host/index.js');
hooks.deregister();
// Already loaded by index.js inside the hook window, so this is the same module instance (the
// sight.js double above, not the real capture stack).
const { createPreRequestVision } = await import('../src/host/vision/pre-request.js');

const server = createServer((socket) => socket.end());
before(async () => { await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); });
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  delete globalThis.__visionPreRequestTest;
});

function resetState() {
  state.captures = 0;
  state.implCalls = 0;
  state.captureImpl = null;
  state.starts = 0;
  state.takeCalls = 0;
  state.saves = [];
  state.obsScene = 'Main';
  state.virtualCamActive = true;
  state.obsRequests = [];
}

/** Write one PNG-shaped file; the bytes are intentionally not a real PNG (assessFrame: unknown). */
async function writeShot(dir, data = Buffer.from('PNGDATA-PRE-REQUEST'), name = `${randomUUID()}.png`) {
  await mkdir(dir, { recursive: true });
  const file = join(dir, name);
  await writeFile(file, data);
  return { file, bytes: data.length, width: 320, height: 200, engine: 'fake', at: Date.now(), capturedAt: Date.now() };
}

function fakeSession({ dir, source }) {
  const done = deferred();
  let stopped = false;
  return {
    engine: source?.kind === 'obs' ? 'fake-obs' : 'fake-desktop',
    sourceKind: source?.kind ?? 'screen',
    async take() {
      state.takeCalls += 1;
      const shot = await writeShot(dir, Buffer.from('PNGDATA-STORYBOARD'), 'sheet.png');
      // A real storyboard packs the frames its buffer collected; the test keeps that shape so
      // `framesInSheet` can prove the pack really happened.
      return { ...shot, frames: 6, from: 1, to: 6 };
    },
    stats: () => ({ frames: 12, sheets: state.takeCalls, engine: 'fake' }),
    stop() { if (!stopped) { stopped = true; done.resolve(); } },
    done: done.promise,
  };
}

async function fixture(t, { preRequestTtlMs = 30_000 } = {}) {
  resetState();
  const root = await mkdtemp(join(tmpdir(), 'dsh-vision-pre-request-'));
  // The test session has no cwd; disable the workspace scope in settings.json (runtime state).
  await mkdir(join(root, 'data'), { recursive: true });
  await writeFile(join(root, 'data', 'settings.json'), JSON.stringify({
    workspaceScope: { enabled: false },
  }));
  const tools = new Map();
  const listeners = new Map();
  const disposers = [];
  const effect = (fn) => {
    const dispose = fn();
    if (typeof dispose === 'function') disposers.push(dispose);
    return dispose;
  };
  const on = (type, handler) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(handler);
    return () => {
      const entries = listeners.get(type) ?? [];
      const index = entries.indexOf(handler);
      if (index >= 0) entries.splice(index, 1);
    };
  };
  const attachments = {
    async saveImage({ data, mediaType, name }) {
      const attachment = { id: `att-${state.saves.length + 1}`, mediaType, name, bytes: data.length };
      state.saves.push({ data, mediaType, name, attachment });
      return attachment;
    },
  };
  const llm = {
    async resolveModelInfo(provider, model) {
      return { provider, id: model, name: model, inputModalities: ['text', 'image'] };
    },
  };
  state.captureImpl = (options) => writeShot(options.dir);
  state.start = (options) => fakeSession(options);

  apply({
    effect,
    on,
    get: (service) => {
      if (service === 'attachments') return attachments;
      if (service === 'llm') return llm;
      return undefined;
    },
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } },
    inject: (_dependencies, register) => register({
      effect,
      systemPrompt: { section: () => () => {} },
      webServer: { register: () => () => {} },
    }),
  }, {
    root,
    enabled: true,
    defaultDomain: 'chat',
    obsPort: server.address().port,
    privacyScene: 'Privacy',
    dependencyBootDelayMs: 8000,
    // 本测试只验证 pre-request preparation；关闭持续证据采集，避免首轮 pre-step 后的
    // 后台故事板把 `state.starts` 计成“preparation 自己开故事板”。
    evidenceCaptureEnabled: false,
    vision: { preRequestTtlMs },
  });
  t.after(() => cleanupRoot(root, disposers));

  const exec = (overrides = {}) => ({
    ...overrides,
    agent: overrides.agent ?? {
      session: {
        id: 'vision-session',
        header: {},
        requestHeader: () => ({ config: { provider: 'fake', model: 'vision-model' } }),
      },
      options: {},
    },
  });
  const call = async (name, args = {}, overrides = {}) => {
    const tool = tools.get(name);
    assert.ok(tool !== undefined, `${name} is registered`);
    return { tool, value: await tool.execute(args, exec(overrides)) };
  };
  const agent = () => ({
    session: { id: 'vision-session', header: {}, requestHeader: () => ({ config: {} }) },
    options: {},
  });
  /** One real `agent/pre-step` waterfall: every registered listener in registration order. */
  const runPreStep = async ({ turn, text, step = 1, signal = undefined }) => {
    const payload = {
      step,
      turn,
      agent: agent(),
      signal,
      messages: [{ id: 'msg-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }],
    };
    const handlers = listeners.get('agent/pre-step') ?? [];
    let index = 0;
    const next = async () => {
      if (index >= handlers.length) return { kind: 'ok', messages: [] };
      const handler = handlers[index];
      index += 1;
      return handler(payload, next);
    };
    return next();
  };
  const events = async () => {
    const text = await readFile(join(root, 'data', 'events.jsonl'), 'utf8').catch(() => '');
    return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  };
  const waitForEvent = async (type, predicate = () => true) => {
    for (let i = 0; i < 300; i += 1) {
      const hit = (await events()).find((event) => event.type === type && predicate(event));
      if (hit !== undefined) return hit;
      await sleep(5);
    }
    return undefined;
  };
  return { root, call, runPreStep, events, waitForEvent };
}

test('① 同轮预取：see 复用单帧，watch take 不拿单帧冒充故事板，仍打包时序故事板', async (t) => {
  const app = await fixture(t);
  const decision = await app.runPreStep({ turn: 1, text: '帮我看看这个画面' });
  assert.notEqual(decision?.kind, 'reject', 'pre-step returns the base decision untouched');
  assert.equal(state.captures, 1, 'preparation captured once before the first request');
  assert.equal(state.starts, 0, 'preparation never starts a persistent storyboard by itself');

  // assistant_see is the ONE consumer of the prepared single frame: it reuses it.
  const look = await app.call('assistant_see', { reason: 'same turn' });
  assert.equal(look.value.ok, true, look.value.reason);
  assert.equal(state.captures, 1, 'see reused the one preparation capture');

  assert.equal((await app.call('assistant_watch', { action: 'start' })).value.ok, true);
  const take = await app.call('assistant_watch', { action: 'take' });
  assert.equal(take.value.ok, true, take.value.error);
  assert.equal(take.value.ready, true);
  // P2-2 regression: a prepared single frame is a `shot`, never a storyboard. watch must pack.
  assert.ok(take.value.framesInSheet > 0, `watch packed a storyboard (framesInSheet=${take.value.framesInSheet})`);
  assert.ok(state.takeCalls > 0, `storyboard packing ran (takeCalls=${state.takeCalls})`);
  assert.notEqual(take.value.file, look.value.file, 'watch delivered a packed sheet, not the one-shot frame');
  assert.equal(take.value.framesInSheet, 6);
  assert.equal(state.captures, 1, 'watch packing is not a second one-shot capture');
  assert.equal(state.saves.length, 2, 'each read still delivers its own attachment');

  const reused = await app.waitForEvent('vision.pre-request.reused', (event) => event.payload?.turn === 1);
  assert.ok(reused !== undefined, 'vision.pre-request.reused is recorded');
  assert.equal(reused.payload.source, 'desktop');
  assert.equal(reused.payload.scene, '');
  assert.equal(typeof reused.payload.ageMs, 'number');
  assert.ok(reused.payload.ageMs >= 0 && reused.payload.ageMs < 30_000);
  t.diagnostic(`reuse: turn=${reused.payload.turn} ageMs=${reused.payload.ageMs} `
    + `source=${reused.payload.source} captures=${state.captures} takeCalls=${state.takeCalls} `
    + `framesInSheet=${take.value.framesInSheet}`);
});

test('①b P2-1 迟到的工具轮以自己 turn 归属：不复用新轮缓存', async (t) => {
  const app = await fixture(t);
  await app.runPreStep({ turn: 1, text: '看看屏幕上是什么' });
  assert.equal(state.captures, 1);
  // Turn 2 opens its own scope (no eager capture: it did not ask to look).
  await app.runPreStep({ turn: 2, text: '今天聊点别的' });
  await sleep(600); // leave the 500 ms same-source capture window

  // A real turn-2 read captures and publishes turn 2's frame.
  const current = await app.call('assistant_see', {}, { turn: 2 });
  assert.equal(current.value.ok, true, current.value.reason);
  assert.equal(state.captures, 2, 'turn 2 paid for its own frame');
  await sleep(600);

  // A tool call that still names turn 1 must not be served turn 2's frame. It reports the
  // turn mismatch and takes its own capture (which cannot overwrite turn 2 either).
  const late = await app.call('assistant_see', {}, { turn: 1 });
  assert.equal(late.value.ok, true, late.value.reason);
  assert.equal(state.captures, 3, 'the late turn-1 read paid for its own capture');
  assert.notEqual(late.value.file, current.value.file, 'the late read did not receive turn 2 frame');
  const miss = await app.waitForEvent('vision.pre-request.miss',
    (event) => event.payload?.reason === 'turn-changed');
  assert.ok(miss !== undefined, 'the late call is a turn-changed miss, not a cache hit');
  t.diagnostic(`late-tool-call: turn1Late=${late.value.file !== current.value.file} `
    + `captures=${state.captures} miss=${miss.payload.reason}`);
});

test('② 跨轮 / 过期不复用：miss + 真实重新采集', async (t) => {
  const app = await fixture(t, { preRequestTtlMs: 50 });
  await app.runPreStep({ turn: 1, text: '看看屏幕上是什么' });
  assert.equal(state.captures, 1);
  assert.equal((await app.call('assistant_see', {})).value.ok, true);
  assert.equal(state.captures, 1, 'turn 1 reused its preparation');

  // Step past the 500 ms same-source capture-coalescing window so a miss really re-captures.
  await sleep(600);
  // A new turn that does not ask to look still opens a new scope: the old snapshot is a miss.
  await app.runPreStep({ turn: 2, text: '今天聊点别的' });
  const crossTurn = await app.call('assistant_see', {});
  assert.equal(crossTurn.value.ok, true, crossTurn.value.reason);
  assert.equal(state.captures, 2, 'the cross-turn read paid for a real capture');
  const missedTurn = await app.waitForEvent('vision.pre-request.miss',
    (event) => event.payload?.reason === 'turn-changed');
  assert.ok(missedTurn !== undefined, 'cross-turn miss says turn-changed');

  // Same turn, but the snapshot must not outlive the freshness window.
  await sleep(600); // also clears the 500 ms same-source capture-coalescing window
  const expired = await app.call('assistant_see', {});
  assert.equal(expired.value.ok, true, expired.value.reason);
  assert.equal(state.captures, 3, 'the expired read paid for a real re-capture');
  const missedExpired = await app.waitForEvent('vision.pre-request.miss',
    (event) => event.payload?.reason === 'expired');
  assert.ok(missedExpired !== undefined, 'expired miss says expired');
  t.diagnostic(`cross-turn/expired: captures=${state.captures} `
    + `misses=${(await app.events()).filter((event) => event.type === 'vision.pre-request.miss').map((event) => event.payload.reason).join(',')}`);
});

test('③ 场景切换 / 隐私：不复用且不读缓存', async (t) => {
  const app = await fixture(t);
  await app.runPreStep({ turn: 1, text: '看一下屏幕' });
  assert.equal(state.captures, 1);

  // Switch desktop -> OBS scene: invalidation must drop the prepared snapshot.
  const switched = await app.call('assistant_vision', { action: 'set', source: 'obs', scene: 'Main' });
  assert.equal(switched.value.ok, true, switched.value.error);
  const reusedBefore = (await app.events()).filter((event) => event.type === 'vision.pre-request.reused').length;
  const sceneLook = await app.call('assistant_see', { reason: 'after scene switch' });
  assert.equal(sceneLook.value.ok, true, sceneLook.value.reason);
  assert.equal(state.captures, 2, 'the new source captured a new frame');
  assert.equal(sceneLook.value.mode, 'scene');
  const reusedAfter = (await app.events()).filter((event) => event.type === 'vision.pre-request.reused').length;
  assert.equal(reusedAfter, reusedBefore, 'the old desktop snapshot was not reused after the switch');

  // Privacy must neither prepare nor reuse a cached frame.
  const privacy = await app.call('assistant_vision', { action: 'set', mode: 'privacy' });
  assert.equal(privacy.value.ok, true, privacy.value.error);
  const beforePrivacy = state.captures;
  await app.runPreStep({ turn: 2, text: '看看现在屏幕' });
  assert.equal(state.captures, beforePrivacy, 'privacy preparation never touches a capture');
  const beforeRead = state.captures;
  const blocked = await app.call('assistant_see', {});
  assert.equal(blocked.value.ok, false);
  assert.match(blocked.value.reason, /隐私/u);
  assert.equal(state.captures, beforeRead, 'privacy refused before any cache read or capture');
  assert.equal((await app.call('assistant_watch', { action: 'take' })).value.ok, false);
  t.diagnostic(`scene/privacy: captures=${state.captures} reused=${reusedAfter} `
    + `privacyReads=${blocked.value.ok} reason=${blocked.value.reason}`);
});

test('④ 不复用时的交付内容不变（文件/字节/尺寸/来源/图像块）', async (t) => {
  const data = Buffer.from('PNGDATA-DELIVERY-UNCHANGED');
  const app = await fixture(t);
  state.captureImpl = (options) => writeShot(options.dir, data);

  // No pre-step: this is the ordinary single-look path (no cache may change it).
  const normal = await app.call('assistant_see', {});
  assert.equal(normal.value.ok, true, normal.value.reason);
  assert.equal(state.captures, 1);
  assert.equal(normal.value.bytes, data.length);
  assert.equal(normal.value.width, 320);
  assert.equal(normal.value.height, 200);
  assert.equal(normal.value.mode, 'watch');
  const normalBlocks = normal.tool.output.render({}, normal.value);
  assert.deepEqual(normalBlocks.map((block) => block.type), ['text', 'image']);
  assert.equal(normalBlocks[1].attachment.id, normal.value.attachmentId);

  // A prepared turn reuses its frame but keeps exactly the same delivery contract. Wait out the
  // 500 ms coalescing window first, so the preparation is a genuinely new capture.
  await sleep(600);
  await app.runPreStep({ turn: 1, text: '看看这个' });
  assert.equal(state.captures, 2);
  const reused = await app.call('assistant_see', {});
  assert.equal(reused.value.ok, true, reused.value.reason);
  assert.equal(state.captures, 2, 'the read reused the preparation capture');
  assert.equal(reused.value.bytes, data.length);
  assert.equal(reused.value.width, 320);
  assert.equal(reused.value.height, 200);
  assert.equal(reused.value.mode, 'watch');
  assert.equal(reused.value.stale, false);
  assert.equal(reused.value.current, true);
  const reusedBlocks = reused.tool.output.render({}, reused.value);
  assert.deepEqual(reusedBlocks.map((block) => block.type), ['text', 'image']);
  assert.equal(reusedBlocks[1].attachment.id, reused.value.attachmentId);
  const delivered = (await app.waitForEvent('vision.delivered')).payload;
  assert.deepEqual(
    { bytes: delivered.bytes, width: delivered.width, height: delivered.height },
    { bytes: data.length, width: 320, height: 200 },
  );
  t.diagnostic(`delivery-unchanged: normal=${normal.value.bytes}B/${normal.value.width}x${normal.value.height} `
    + `reused=${reused.value.bytes}B/${reused.value.width}x${reused.value.height} mode=${reused.value.mode}`);
});

test('⑤ 准备失败 fail-open：本轮照常运行，视觉读取自行采集成功', async (t) => {
  const app = await fixture(t);
  state.implCalls = 0;
  state.captureImpl = async (options) => {
    // captureForAgent tries captureDesktop first, then the PowerShell fallback; fail both so the
    // preparation itself fails. The later tool capture (third call) succeeds.
    if (state.implCalls <= 2) throw new Error('preparation capture failed');
    return writeShot(options.dir);
  };

  const decision = await app.runPreStep({ turn: 1, text: '看看屏幕，马上' });
  assert.notEqual(decision?.kind, 'reject', 'a failed preparation does not reject the turn');
  const missed = await app.waitForEvent('vision.pre-request.miss',
    (event) => event.payload?.reason === 'prepare-failed');
  assert.ok(missed !== undefined, 'the preparation failure is recorded as a miss');

  const look = await app.call('assistant_see', {});
  assert.equal(look.value.ok, true, look.value.reason);
  assert.equal(state.implCalls, 3, 'the read fell through to its own capture and succeeded');
  assert.equal(look.value.attachment !== null, true);
  t.diagnostic(`fail-open: decision=${decision?.kind} misses=prepare-failed implCalls=${state.implCalls} `
    + `delivered=${look.value.ok}`);
});

/* -------------------------------------------------------------------------------------------- *
 * P2-1: owner binding. These drive `createPreRequestVision` directly, so a "capture" is a
 * deferred the test settles at the exact moment it wants: no screen, ffmpeg, OBS or attachment
 * store is involved, and the clock is frozen.
 * -------------------------------------------------------------------------------------------- */

/** A bare channel: one controllable capture per call, a frozen clock and a recorded event log. */
function unitChannel({ ttlMs = 30_000, start = 1_000_000 } = {}) {
  const events = [];
  let stamp = start;
  const shotOf = (name, at = stamp) => ({
    file: `/fake/${name}.png`,
    bytes: 8,
    width: 32,
    height: 20,
    engine: 'fake',
    at,
    capturedAt: at,
  });
  const channel = createPreRequestVision({
    now: () => stamp,
    ttlMs,
    emit: (type, payload) => events.push({ type, payload }),
  });
  return {
    channel,
    events,
    shotOf,
    advance: (ms) => { stamp += ms; },
    misses: () => events
      .filter((event) => event.type === 'vision.pre-request.miss')
      .map((event) => event.payload.reason),
    stales: () => events
      .filter((event) => event.type === 'vision.pre-request.stale')
      .map((event) => event.payload.reason),
    reused: () => events.filter((event) => event.type === 'vision.pre-request.reused'),
  };
}

test('⑥ P2-1 迟到成功：旧轮结果被丢弃，不覆盖新轮缓存', async (t) => {
  const app = unitChannel();
  const slow = deferred();
  // Turn 1 starts a capture that will not settle yet.
  const oldTurn = app.channel.prepare({ sessionId: 's', turn: 1, capture: () => slow.promise });
  // Turn 2 arrives, prepares and publishes its own frame.
  const shotB = app.shotOf('b');
  const newTurn = app.channel.prepare({ sessionId: 's', turn: 2, capture: async () => shotB });
  assert.equal(await newTurn, shotB);
  assert.equal(app.channel.take({ sessionId: 's', turn: 2 })?.file, shotB.file);

  // Turn 1's capture finally lands AFTER turn 2 published: it must be dropped, not published.
  const shotA = app.shotOf('a');
  slow.resolve(shotA);
  assert.equal(await oldTurn, null, 'the late capture result is discarded, not returned');
  assert.deepEqual(app.stales(), ['turn-changed'], 'the discard is recorded with its reason');
  assert.equal(app.misses().includes('prepare-failed'), false, 'a discard is not a failure');

  const after = app.channel.take({ sessionId: 's', turn: 2 });
  assert.equal(after?.file, shotB.file, 'turn 2 still reads turn 2 frame');
  assert.equal(app.channel.state().snapshot.turn, 2);
  assert.equal(app.channel.take({ sessionId: 's', turn: 1 }) === null, true, 'turn 1 has no frame');
  t.diagnostic(`late-success: discarded=stale:${app.stales().join(',')} `
    + `turn2=${after.file} state.turn=${app.channel.state().snapshot.turn} misses=${app.misses().join(',')}`);
});

test('⑦ P2-1 迟到失败：只清理入口自身状态，不清空新轮缓存', async (t) => {
  const app = unitChannel();
  const slow = deferred();
  const oldTurn = app.channel.prepare({ sessionId: 's', turn: 1, capture: () => slow.promise });
  const shotB = app.shotOf('b');
  const newTurn = app.channel.prepare({ sessionId: 's', turn: 2, capture: async () => shotB });
  assert.equal(await newTurn, shotB);

  slow.reject(new Error('late capture failed'));
  assert.equal(await oldTurn, null, 'the late failure resolves as a fail-open null');
  assert.deepEqual(app.stales(), ['turn-changed']);
  assert.equal(app.misses().includes('prepare-failed'), false,
    'the old turn failure is not reported against the new turn');
  assert.equal(app.channel.take({ sessionId: 's', turn: 2 })?.file, shotB.file,
    'turn 2 frame survived the late failure');
  assert.equal(app.misses().length, 0);
  t.diagnostic(`late-failure: stales=${app.stales().join(',')} turn2=${shotB.file} `
    + `misses=${app.misses().join(',')} delivered=${app.reused().length}`);
});

test('⑧ P2-1 不同会话并发：各自缓存、互不驱逐', async (t) => {
  const app = unitChannel();
  const slowA = deferred();
  const fastB = deferred();
  const shotA = app.shotOf('a');
  const shotB = app.shotOf('b');
  const sessionA = app.channel.prepare({ sessionId: 'A', turn: 1, capture: () => slowA.promise });
  const sessionB = app.channel.prepare({ sessionId: 'B', turn: 1, capture: () => fastB.promise });

  fastB.resolve(shotB);
  assert.equal(await sessionB, shotB);
  // B published first: A has no frame of its own yet and never borrows B's.
  assert.equal(app.channel.take({ sessionId: 'A', turn: 1 }), null);
  assert.deepEqual(app.misses(), ['no-snapshot'], 'A misses without touching B');
  assert.equal(app.channel.take({ sessionId: 'B', turn: 1 })?.file, shotB.file);

  slowA.resolve(shotA);
  assert.equal(await sessionA, shotA);
  // A publishing after B must not evict B, and B's earlier read must not have evicted A.
  assert.equal(app.channel.take({ sessionId: 'A', turn: 1 })?.file, shotA.file);
  assert.equal(app.channel.take({ sessionId: 'B', turn: 1 })?.file, shotB.file);
  assert.equal(app.channel.take({ sessionId: 'C', turn: 1 }) === null, true, 'a third session borrows nothing');
  assert.deepEqual(app.stales(), [], 'no capture was discarded');
  t.diagnostic(`sessions: A=${shotA.file} B=${shotB.file} C=miss:${app.misses().at(-1)} `
    + `stales=${app.stales().length}`);
});

test('⑨ P2-1 take 归属不匹配：session/turn/source/scene 均 miss 且返回 null', async (t) => {
  const cases = [
    { name: 'session', query: { sessionId: 'other', turn: 1 }, reason: 'session-changed' },
    { name: 'turn', query: { sessionId: 's', turn: 9 }, reason: 'turn-changed' },
    { name: 'source', query: { sessionId: 's', turn: 1, source: 'obs' }, reason: 'source-changed' },
    { name: 'scene', query: { sessionId: 's', turn: 1, source: 'desktop', scene: 'Other' }, reason: 'scene-changed' },
  ];
  const seen = [];
  for (const entry of cases) {
    const app = unitChannel();
    const shot = app.shotOf('shot');
    assert.equal(await app.channel.prepare({ sessionId: 's', turn: 1, capture: async () => shot }), shot);
    const value = app.channel.take(entry.query);
    assert.equal(value, null, `${entry.name} mismatch returns null`);
    assert.deepEqual(app.misses(), [entry.reason], `${entry.name} mismatch reason`);
    assert.equal(app.reused().length, 0, `${entry.name} mismatch never reports a reuse`);
    seen.push(`${entry.name}->${app.misses()[0]}`);
  }
  // The exact owner still hits after each independent case (the frame is never served to a
  // mismatched caller, but it is also never handed out under a wrong identity).
  const app = unitChannel();
  const shot = app.shotOf('owner');
  await app.channel.prepare({ sessionId: 's', turn: 1, capture: async () => shot });
  assert.equal(app.channel.take({ sessionId: 's', turn: 1, source: 'desktop', scene: '' })?.file, shot.file);
  t.diagnostic(`attribution-miss: ${seen.join(' ')}`);
});

test('⑩ P2-1 同轮复用回归：同一 owner 的读取命中同一帧', async (t) => {
  const app = unitChannel();
  const shot = app.shotOf('keep');
  assert.equal(await app.channel.prepare({ sessionId: 's', turn: 3, capture: async () => shot }), shot);
  assert.equal(app.channel.take({ sessionId: 's', turn: 3, source: 'desktop', scene: '' }), shot);
  assert.equal(app.channel.take({ sessionId: 's', turn: 3, source: 'desktop', scene: '' }), shot);
  // Unattributed callers (today's index wiring) still read the last begun scope.
  assert.equal(app.channel.take({ source: 'desktop', scene: '' }), shot);
  assert.equal(app.reused().length, 3);
  assert.equal(app.reused()[0].payload.turn, 3);
  assert.equal(app.reused()[0].payload.sessionId, 's');
  assert.equal(app.channel.peek({ sessionId: 's', turn: 3 })?.shot, shot);
  // Preparing the same turn again reuses the frame instead of capturing a second one.
  const again = await app.channel.prepare({
    sessionId: 's',
    turn: 3,
    capture: async () => { throw new Error('must not capture twice in one turn'); },
  });
  assert.equal(again, shot);
  assert.equal(app.misses().length, 0);
  t.diagnostic(`same-turn: reused=${app.reused().length} turn=${app.reused()[0].payload.turn} `
    + `ageMs=${app.reused().map((event) => event.payload.ageMs).join('/')} misses=${app.misses().length}`);
});

test('⑪ P2-2 kind 过滤：单帧不是故事板，kind 不匹配 miss 且不吞掉单帧', async (t) => {
  const app = unitChannel();
  const shot = app.shotOf('shot');
  assert.equal(await app.channel.prepare({ sessionId: 's', turn: 1, capture: async () => shot }), shot);

  // assistant_watch asks for a storyboard: the prepared shot must not be served as one.
  assert.equal(app.channel.take({ sessionId: 's', turn: 1, kind: 'storyboard' }), null);
  assert.deepEqual(app.misses(), ['kind-mismatch']);
  assert.equal(app.reused().length, 0);

  // A kind mismatch does not delete the shot: assistant_see still reuses it.
  assert.equal(app.channel.take({ sessionId: 's', turn: 1, kind: 'shot' })?.file, shot.file);
  assert.equal(app.reused().length, 1);

  // A storyboard published for the turn is only served to a storyboard reader.
  const sheet = { ...shot, file: '/fake/sheet.png', frames: 6, from: 1, to: 6 };
  const entry = app.channel.remember(sheet, {
    kind: 'storyboard', owner: { sessionId: 's', turn: 1 },
  });
  assert.notEqual(entry, null, 'a caller attribution resolves to the live turn scope');
  assert.equal(app.channel.state().snapshot.kind, 'storyboard');
  assert.equal(
    app.channel.take({ sessionId: 's', turn: 1, kind: 'storyboard' })?.file,
    sheet.file,
    'watch reuses a storyboard it packed in the same turn',
  );
  assert.equal(
    app.channel.take({ sessionId: 's', turn: 1, kind: 'shot' }),
    null,
    'a storyboard is never served as a one-shot frame',
  );
  t.diagnostic(`kind: mismatch=${app.misses().join(',')} shotReuse=${app.reused().length} `
    + `storyboardReuse=1 state.kind=${app.channel.state().snapshot.kind}`);
});

