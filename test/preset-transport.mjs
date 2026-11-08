/**
 * Motion preset transport acceptance — "the preset really reached the ONE writer".
 *
 * These tests use a fake transport and assert on the rows it actually received, not on the
 * controller's computed pose. They cover the historical gap where a preset was reported as
 * executed/committed while gaze/brow/body channels were never in the send set.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createAvatarRuntime } from '../src/host/avatar/avatarRuntime.js';

const ROWS = Object.freeze({
  gazeX: { channel: 'gazeX', inputName: 'P_gazeX', min: -1, max: 1, injectable: true, verified: true },
  gazeY: { channel: 'gazeY', inputName: 'P_gazeY', min: -1, max: 1, injectable: true, verified: true },
  headX: { channel: 'headX', inputName: 'P_headX', min: -30, max: 30, injectable: true, verified: true },
  headY: { channel: 'headY', inputName: 'P_headY', min: -30, max: 30, injectable: true, verified: true },
  headZ: { channel: 'headZ', inputName: 'P_headZ', min: -30, max: 30, injectable: true, verified: true },
  browL: { channel: 'browL', inputName: 'P_browL', min: -1, max: 1, injectable: true, verified: true },
  browR: { channel: 'browR', inputName: 'P_browR', min: -1, max: 1, injectable: true, verified: true },
  bodyX: { channel: 'bodyX', inputName: 'P_bodyX', min: -1, max: 1, injectable: true, verified: true },
});

function rowsFor(names, overrides = {}) {
  return names.map((name) => ({ ...ROWS[name], ...(overrides[name] ?? {}) }));
}

/** Fake transport: every frame the ONE writer builds is captured with the tick time. */
function makeRig({ motionWrites = false } = {}) {
  let clock = 0;
  const frames = [];
  const transport = {
    connect: async () => {},
    disconnect: async () => {},
    write: async () => ({ ok: true }),
    writeFrame: async (entries) => {
      frames.push({ at: clock, entries: entries.map((entry) => ({ ...entry })) });
      return { ok: true };
    },
    writeMotion: async (payload) => {
      frames.push({ at: clock, entries: payload.entries.map((entry) => ({ ...entry })) });
      return { ok: true };
    },
  };
  const runtime = createAvatarRuntime({
    transport,
    now: () => clock,
    config: {
      autoTickMs: 0,
      flushIntervalMs: 1,
      idleWriteHz: 8,
      idleActions: [],
      idleSwayScale: 0,
      motionWrites,
      motionOutputHz: 30,
      presetExecution: true,
    },
  });
  const poses = new Map();
  return {
    runtime,
    frames,
    poses,
    setClock(at) {
      clock = at;
    },
    tick(at) {
      clock = at;
      const pose = runtime.tick(at);
      poses.set(at, { ...pose });
      return pose;
    },
  };
}

async function connect(rig, rows) {
  assert.equal((await rig.runtime.connect()).ok, true);
  const result = await rig.runtime.setChannelMappings(rows, { channelMap: {} });
  assert.equal(result.ok, true);
  // Status speaking keeps the autonomous preset boundary out of these deterministic tests.
  rig.runtime.setStatus('speaking', 'preset-transport-test');
}

async function run(rig, from, to, stepMs = 33) {
  for (let at = from; at <= to; at += stepMs) {
    rig.tick(at);
    // Let the single-flight writer settle before the next tick stages another frame.
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Draw a preset of one recipe; a hold draw is retried with the next deterministic seed. */
function startPreset(runtime, context) {
  for (let seed = 0; seed < 160; seed += 1) {
    const result = runtime.preset({ ...context, seed });
    if (result.started === true) return result;
  }
  throw new Error(`no preset started for ${JSON.stringify(context)}`);
}

const channelFrames = (frames, channel) => frames
  .filter((frame) => frame.entries.some((entry) => entry.channel === channel))
  .map((frame) => ({
    at: frame.at,
    entry: frame.entries.find((entry) => entry.channel === channel),
  }));

const presetSnapshot = (runtime) => runtime.snapshot().motion.presets;

test('1. 纯视线预设真的写到 transport，且方向与计算姿态一致', async () => {
  const rig = makeRig();
  await connect(rig, rowsFor(['gazeX']));
  const started = startPreset(rig.runtime, { state: 'idle', event: 'idle', recipe: 'idle-eye-side' });
  assert.deepEqual(started.channels, ['gazeX']);
  await run(rig, 0, 1600);

  const gazeFrames = channelFrames(rig.frames, 'gazeX');
  assert.ok(gazeFrames.length > 0, `GAZE_WRITES=${gazeFrames.length} must be > 0`);

  // The payload direction must follow the computed gaze pose at that same tick. Gaze maps onto
  // -1..1, so a positive semantic value is a positive payload (0 is neutral).
  const peak = gazeFrames.reduce((best, item) => (
    Math.abs(item.entry.value) > Math.abs(best.entry.value) ? item : best
  ), gazeFrames[0]);
  const peakPose = rig.poses.get(peak.at);
  assert.ok(Math.abs(peak.entry.value) > 0.01, 'a real gaze excursion was written');
  assert.ok(peakPose !== undefined && Number.isFinite(peakPose.gazeX));
  assert.equal(Math.sign(peak.entry.value), Math.sign(peakPose.gazeX),
    'the transport value points the same way as the computed gaze');

  const trace = presetSnapshot(rig.runtime).currentTrace ?? presetSnapshot(rig.runtime).lastTrace;
  assert.ok(Number.isFinite(trace.output.computed.gazeX));
  assert.ok(Number.isFinite(trace.output.committed.gazeX), 'gazeX was committed through the writer');
  assert.deepEqual(trace.output.skippedByTransport, {});
  console.log(`[transport] gazeWrites=${gazeFrames.length} peakPayload=${peak.entry.value.toFixed(4)} `
    + `poseAtPeak=${peakPose.gazeX.toFixed(4)} committed.gazeX=${trace.output.committed.gazeX.toFixed(4)}`);
});

test('2. 纯眉毛预设真的写到 transport', async () => {
  const rig = makeRig();
  await connect(rig, rowsFor(['browL', 'browR']));
  const started = startPreset(rig.runtime, { state: 'speaking', event: 'emphasize', recipe: 'emphasis-brow' });
  assert.deepEqual([...started.channels].sort(), ['browL', 'browR']);
  await run(rig, 0, 1600);

  const browFrames = rig.frames.filter((frame) => frame.entries
    .some((entry) => entry.channel === 'browL' || entry.channel === 'browR'));
  assert.ok(browFrames.length > 0, `BROW_WRITES=${browFrames.length} must be > 0`);
  const trace = presetSnapshot(rig.runtime).currentTrace ?? presetSnapshot(rig.runtime).lastTrace;
  assert.ok(Number.isFinite(trace.output.committed.browL) || Number.isFinite(trace.output.committed.browR));
  const brow = rig.frames.flatMap((frame) => frame.entries
    .filter((entry) => entry.channel === 'browL' || entry.channel === 'browR'));
  console.log(`[transport] browWrites=${browFrames.length} browRows=${brow.length} `
    + `committed=${JSON.stringify(trace.output.committed)}`);
});

test('3. 身体预设保持 native-owned：可映射也 hold，零 BODY 写入', async () => {
  const rig = makeRig();
  // bodyX IS available on this model, and the executor still refuses to drive it.
  await connect(rig, rowsFor(['headX', 'bodyX']));
  const started = rig.runtime.preset({ state: 'idle', event: 'idle', recipe: 'idle-lean', seed: 0 });
  assert.equal(started.started, false);
  assert.equal(started.kind, 'hold');
  const capabilities = presetSnapshot(rig.runtime).capabilities;
  assert.ok(capabilities.nativeOwned.includes('bodyX'),
    `bodyX must stay native-owned (nativeOwned=${capabilities.nativeOwned.join(',')})`);
  await run(rig, 0, 2000);
  const bodyWrites = rig.frames.reduce((count, frame) => count
    + frame.entries.filter((entry) => entry.channel.startsWith('body')).length, 0);
  assert.equal(bodyWrites, 0, 'body stays VTS-native: zero transport writes');
  assert.equal(presetSnapshot(rig.runtime).starts, 0);
  console.log(`[transport] bodyWrites=${bodyWrites} started=${started.started} nativeOwned=${capabilities.nativeOwned.join('|')}`);
});

test('4. 多通道预设：每个通道都出现在 transport 写集合', async () => {
  const rig = makeRig();
  await connect(rig, rowsFor(['headZ', 'browL', 'browR']));
  const started = startPreset(rig.runtime, { state: 'thinking', event: 'confused', recipe: 'confused-combo' });
  assert.deepEqual([...started.channels].sort(), ['browL', 'browR', 'headZ']);
  await run(rig, 0, 1500);

  const written = new Set(rig.frames.flatMap((frame) => frame.entries.map((entry) => entry.channel)));
  for (const channel of ['headZ', 'browL', 'browR']) {
    assert.ok(written.has(channel), `${channel} must appear in the transport write set`);
  }
  const trace = presetSnapshot(rig.runtime).currentTrace ?? presetSnapshot(rig.runtime).lastTrace;
  for (const channel of ['headZ', 'browL', 'browR']) {
    assert.ok(Number.isFinite(trace.output.committed[channel]), `${channel} must be committed`);
  }
  console.log(`[transport] multiWrites=${[...written].join('|')} committed=${JSON.stringify(trace.output.committed)}`);
});

test('5. 结束后回位：release 继续写，最后写入接近基线，然后释放', async () => {
  const rig = makeRig();
  await connect(rig, rowsFor(['gazeX']));
  const started = startPreset(rig.runtime, { state: 'idle', event: 'idle', recipe: 'idle-eye-side' });
  const endAt = started.durationMs;
  await run(rig, 0, endAt + 1600);

  const gazeFrames = channelFrames(rig.frames, 'gazeX');
  const releaseFrames = gazeFrames.filter((frame) => frame.at > endAt);
  assert.ok(releaseFrames.length > 0,
    `release must keep writing after the end (last=${gazeFrames.at(-1)?.at}, end=${endAt})`);

  const last = gazeFrames[gazeFrames.length - 1];
  assert.ok(Math.abs(last.entry.value) <= 0.03,
    `the last write must be back near the baseline, got ${last.entry.value}`);
  assert.equal(presetSnapshot(rig.runtime).active.length, 0);
  assert.deepEqual(presetSnapshot(rig.runtime).releasing, [], 'the release window is freed');

  const after = rig.frames.filter((frame) => frame.at > last.at + 300
    && frame.entries.some((entry) => entry.channel === 'gazeX'));
  assert.deepEqual(after, [], 'nothing is written after the release completed');
  console.log(`[release] endAt=${Math.round(endAt)}ms totalGazeWrites=${gazeFrames.length} `
    + `releaseWrites=${releaseFrames.length} lastAt=${Math.round(last.at)}ms lastPayload=${last.entry.value.toFixed(4)} after=0`);
});

test('6. 打断：平滑退出期间仍写，退出并回位后不再写', async () => {
  const rig = makeRig();
  await connect(rig, rowsFor(['gazeX']));
  startPreset(rig.runtime, { state: 'idle', event: 'idle', recipe: 'idle-eye-side' });
  await run(rig, 0, 300);
  rig.setClock(300);
  rig.runtime.interrupt({ reason: 'interrupt' });
  await run(rig, 333, 2600);

  const gazeFrames = channelFrames(rig.frames, 'gazeX');
  const duringFade = gazeFrames.filter((frame) => frame.at >= 300 && frame.at <= 600);
  assert.ok(duringFade.length > 0, 'the cancelled trajectory keeps writing while it fades');
  const last = gazeFrames[gazeFrames.length - 1];
  const after = rig.frames.filter((frame) => frame.at > last.at + 300
    && frame.entries.some((entry) => entry.channel === 'gazeX'));
  assert.deepEqual(after, [], 'after the smooth exit nothing more is written');
  assert.equal(presetSnapshot(rig.runtime).active.length, 0);
  assert.deepEqual(presetSnapshot(rig.runtime).releasing, []);
  console.log(`[interrupt] totalGazeWrites=${gazeFrames.length} fadeWrites=${duringFade.length} `
    + `lastAt=${Math.round(last.at)}ms after=0`);
});

test('7. computed ≠ committed：被发送层丢弃的通道记 skippedByTransport', async () => {
  const rig = makeRig();
  // gazeX and headX share one input: the ONE-writer-per-input rule drops gazeX (headX owns it).
  await connect(rig, rowsFor(['gazeX', 'headX'], {
    gazeX: { inputName: 'P_shared' },
    headX: { inputName: 'P_shared' },
  }));
  const started = startPreset(rig.runtime, { state: 'idle', event: 'idle', recipe: 'idle-eye-head' });
  assert.deepEqual([...started.channels].sort(), ['gazeX', 'headX']);
  await run(rig, 0, 1000);

  const gazeFrames = channelFrames(rig.frames, 'gazeX');
  assert.deepEqual(gazeFrames, [], 'the sender never built a gazeX row');

  const trace = presetSnapshot(rig.runtime).currentTrace;
  assert.ok(trace !== null, 'the trace is live');
  assert.ok(Number.isFinite(trace.output.computed.gazeX), 'the pose WAS computed for gazeX');
  assert.equal(Number.isFinite(trace.output.committed.gazeX), false,
    'computed is not committed: no gazeX commit without a transport row');
  assert.equal(trace.output.skippedByTransport.gazeX, 'shared-input');
  assert.ok(Number.isFinite(trace.output.committed.headX), 'headX really was written');
  console.log(`[skip] committed=${JSON.stringify(trace.output.committed)} `
    + `skippedByTransport=${JSON.stringify(trace.output.skippedByTransport)} `
    + `computed.gazeX=${trace.output.computed.gazeX?.toFixed(4)}`);
});
