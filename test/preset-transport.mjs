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
function makeRig({ motionWrites = false, idleSwayScale = 0 } = {}) {
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
      idleSwayScale,
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

const FRAME_MS = 1000 / 30;

async function run(rig, from, to, stepMs = FRAME_MS) {
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

test('3. 身体预设仍 native-owned；自动身体基础层只在开启待机摆动时写入', async () => {
  // (a) The rig runs with `idleSwayScale: 0` (explicit "no automatic idle sway"). bodyX IS
  // available and verified, and the body preset still holds (the executor never drives it), but
  // the automatic body/arm base layer is OFF by the same switch as the head idle writer.
  const rig = makeRig();
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
  assert.equal(bodyWrites, 0,
    'idleSwayScale:0 stops the automatic body layer (the preset itself writes no body channel)');
  assert.equal(presetSnapshot(rig.runtime).starts, 0,
    'the body preset itself remains native-owned');

  // (b) With automatic idle sway enabled, a verified body channel is a real continuous writer:
  // the phase-4 base/component layer participates without any preset starting.
  const swayRig = makeRig({ idleSwayScale: 1.2 });
  await connect(swayRig, rowsFor(['headX', 'bodyX']));
  await run(swayRig, 0, 2000);
  const swayBodyWrites = swayRig.frames.reduce((count, frame) => count
    + frame.entries.filter((entry) => entry.channel.startsWith('body')).length, 0);
  assert.ok(swayBodyWrites > 0,
    'a verified body channel participates in the automatic base activity when idle sway is on');
  assert.equal(presetSnapshot(swayRig.runtime).starts, 0,
    'the automatic base layer is not a preset action');
  console.log(`[transport] bodyWrites(off)=${bodyWrites} bodyWrites(on)=${swayBodyWrites}`
    + ` started=${started.started} nativeOwned=${capabilities.nativeOwned.join('|')}`);
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

// ---------------------------------------------------------------------------------------------
// Evidence timing — a send only becomes `committed` after the transport said ok:true.
// ---------------------------------------------------------------------------------------------

const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Fake transport with an explicit outcome per send call: 'ok' → `{ok:true}`, 'reject' →
 * `{ok:false, code}`, 'throw' → a SYNCHRONOUS throw, 'pending' → a promise the test resolves by
 * hand (the late-settle case). Every payload is captured with the tick time it was handed over.
 */
function makeEvidenceRig({ motionWrites = false, outcomes = null } = {}) {
  let clock = 0;
  const calls = [];
  const resolvers = [];
  function deliver(entries, motion) {
    const index = calls.length;
    calls.push({
      at: clock,
      motion,
      entries: entries.map((entry) => ({ ...entry })),
    });
    const outcome = Array.isArray(outcomes) ? (outcomes[index] ?? 'ok') : 'ok';
    if (outcome === 'throw') throw new Error(`transport exploded at #${index}`);
    if (outcome === 'reject') return { ok: false, code: 'VTS_REJECTED', reason: 'transport rejected' };
    if (outcome === 'pending') {
      return new Promise((resolve) => resolvers.push(() => resolve({ ok: true })));
    }
    return { ok: true };
  }
  const transport = {
    connect: async () => {},
    disconnect: async () => {},
    write: () => ({ ok: true }),
    writeFrame: (entries) => deliver(entries, false),
    writeMotion: (payload) => deliver(payload.entries, true),
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
    calls,
    poses,
    setClock(at) { clock = at; },
    tick(at) {
      clock = at;
      const pose = runtime.tick(at);
      poses.set(at, { ...pose });
      return pose;
    },
    resolveNext() {
      const next = resolvers.shift();
      if (next) next();
    },
  };
}

const evidenceStatus = (runtime) => runtime.snapshot().motion.transport;

test('8. 传输全部 ok:false（19 次）：prepared>0、attempted=failed=19、committed 零增长', async () => {
  const rig = makeEvidenceRig({ motionWrites: true, outcomes: new Array(19).fill('reject') });
  await connect(rig, rowsFor(['gazeX']));
  const started = startPreset(rig.runtime, { state: 'idle', event: 'idle', recipe: 'idle-eye-side' });
  assert.deepEqual(started.channels, ['gazeX']);
  for (let index = 0; index < 19; index += 1) {
    rig.tick(index * FRAME_MS);
    await flush();
  }

  const status = evidenceStatus(rig.runtime);
  const presets = presetSnapshot(rig.runtime);
  const trace = presets.currentTrace ?? presets.lastTrace;
  assert.equal(rig.calls.length, 19, 'every tick really attempted exactly one send');
  assert.equal(status.attempted, 19, 'attempted counts the real transport calls');
  assert.equal(status.failed, 19, 'every ok:false send is a failed send');
  assert.equal(status.committed, 0, 'a rejected send is never a commit');
  assert.equal(status.committedRows, 0);
  assert.ok(status.prepared >= status.attempted, `prepared (${status.prepared}) >= attempted`);
  assert.deepEqual(trace.output.committed, {}, 'no channel was committed');
  assert.deepEqual(trace.output.committedAt, {}, 'no acknowledgement time exists');
  assert.equal(trace.output.failed.count, 19, 'the trace keeps its own failed count');
  assert.equal(trace.output.failed.lastCode, 'VTS_REJECTED');
  assert.equal(trace.output.failed.codes.VTS_REJECTED, 19);
  assert.ok(trace.output.preparedFrames > 0, 'frames were prepared');
  assert.equal(trace.output.attemptedFrames, 19);
  assert.equal(trace.visible.verifiable, false, 'no pixel verification is claimed');
  console.log(`[fail19] prepared=${status.prepared} attempted=${status.attempted} failed=${status.failed} `
    + `committed=${status.committed} committedRows=${status.committedRows} `
    + `traceFailed=${trace.output.failed.count} committedAt=${JSON.stringify(trace.output.committedAt)}`);
});

test('9. 传输抛异常：failed（带 errorCode），绝不 committed', async () => {
  const rig = makeEvidenceRig({ motionWrites: true, outcomes: ['throw', 'throw', 'throw'] });
  await connect(rig, rowsFor(['gazeX']));
  startPreset(rig.runtime, { state: 'idle', event: 'idle', recipe: 'idle-eye-side' });
  for (let index = 0; index < 3; index += 1) {
    rig.tick(index * FRAME_MS);
    await flush();
  }

  const status = evidenceStatus(rig.runtime);
  const trace = presetSnapshot(rig.runtime).currentTrace;
  assert.equal(rig.calls.length, 3);
  assert.equal(status.attempted, 3);
  assert.equal(status.failed, 3, 'a thrown send is a failed send');
  assert.equal(status.committed, 0);
  assert.equal(status.lastErrorCode, 'WRITE_FAILED', 'a thrown send has no transport code');
  assert.match(status.lastError, /transport exploded/);
  assert.deepEqual(trace.output.committed, {});
  assert.equal(trace.output.failed.count, 3);
  assert.equal(trace.output.failed.codes.WRITE_FAILED, 3);
  console.log(`[throw] attempted=${status.attempted} failed=${status.failed} committed=${status.committed} `
    + `code=${status.lastErrorCode} error="${status.lastError}"`);
});

test('10. 成功：committed 值 == 实际发送值，带 at；visible 仍不可验证', async () => {
  const rig = makeEvidenceRig({ motionWrites: true, outcomes: null });
  await connect(rig, rowsFor(['gazeX']));
  startPreset(rig.runtime, { state: 'idle', event: 'idle', recipe: 'idle-eye-side' });
  for (let index = 0; index < 12; index += 1) {
    rig.tick(index * FRAME_MS);
    await flush();
  }

  const lastCall = rig.calls.at(-1);
  const sentGaze = lastCall.entries.find((entry) => entry.channel === 'gazeX');
  assert.ok(sentGaze !== undefined, 'gazeX was really handed to the transport');
  assert.ok(Math.abs(sentGaze.value) > 0.01, `a real (non-zero) gaze excursion was sent (${sentGaze.value})`);
  const trace = presetSnapshot(rig.runtime).currentTrace;
  const status = evidenceStatus(rig.runtime);
  assert.equal(trace.output.committed.gazeX, sentGaze.value, 'committed IS the sent payload value');
  assert.equal(trace.output.committedAt.gazeX, lastCall.at, 'the acknowledgement carries `at`');
  assert.ok(Number.isFinite(trace.output.committedAt.gazeX));
  assert.equal(status.committed, rig.calls.length, 'one commit per acknowledged send');
  assert.ok(status.committedRows >= 1);
  assert.equal(status.failed, 0);
  assert.equal(status.stale, 0);
  assert.equal(trace.output.failed.count, 0);
  assert.equal(trace.visible.verifiable, false);
  assert.equal(trace.visible.reason, 'render-not-observable');
  console.log(`[ok] calls=${rig.calls.length} sent.gazeX=${sentGaze.value.toFixed(4)} `
    + `committed.gazeX=${trace.output.committed.gazeX.toFixed(4)} committedAt=${trace.output.committedAt.gazeX} `
    + `committedRows=${status.committedRows} visible=${trace.visible.verifiable}`);
});

test('11. 发送中作废（invalidate）：迟到成功不记 committed，记 stale', async () => {
  const rig = makeEvidenceRig({ motionWrites: true, outcomes: ['pending'] });
  await connect(rig, rowsFor(['gazeX']));
  startPreset(rig.runtime, { state: 'idle', event: 'idle', recipe: 'idle-eye-side' });
  rig.tick(0);
  assert.equal(rig.calls.length, 1, 'the only send is still in flight');

  const locked = rig.runtime.lock('privacy');
  assert.equal(locked.ok, true, 'the output gate closed and the old generation was invalidated');
  rig.resolveNext(); // the OLD send settles ok:true AFTER the invalidation
  await flush();
  await flush();

  const status = evidenceStatus(rig.runtime);
  const presets = presetSnapshot(rig.runtime);
  const trace = presets.currentTrace ?? presets.lastTrace;
  assert.equal(status.committed, 0, 'an invalidated send is never a commit');
  assert.ok(status.stale >= 1, `the late success was discarded as stale (${status.stale})`);
  assert.equal(status.lastStaleReason, 'generation');
  assert.deepEqual(trace.output.committed, {});
  assert.deepEqual(trace.output.committedAt, {});
  console.log(`[stale:generation] calls=${rig.calls.length} committed=${status.committed} `
    + `stale=${status.stale} reason=${status.lastStaleReason}`);
});

test('12. 迟到成功属于旧动作：不记到新动作，记 stale', async () => {
  // 11 acknowledged sends, then a send of the old action that stays in flight.
  const rig = makeEvidenceRig({
    motionWrites: true,
    outcomes: [...new Array(11).fill('ok'), 'pending', 'pending'],
  });
  await connect(rig, rowsFor(['gazeX']));
  startPreset(rig.runtime, { state: 'idle', event: 'idle', recipe: 'idle-eye-side' });
  for (let index = 0; index < 12; index += 1) {
    rig.tick(index * FRAME_MS);
    await flush();
  }
  assert.equal(rig.calls.length, 12);
  const oldSentGaze = rig.calls[11].entries.find((entry) => entry.channel === 'gazeX');
  assert.ok(oldSentGaze !== undefined);
  assert.ok(Math.abs(oldSentGaze.value) > 0.01, `the old action really sent a gaze (${oldSentGaze.value})`);
  const committedBefore = evidenceStatus(rig.runtime).committed;
  assert.equal(committedBefore, 11, 'the earlier sends of the old action were acknowledged');

  // The old trajectory ends (no generation switch, no lock) and a NEW preset owns gazeX.
  rig.setClock(3000);
  rig.tick(3000);
  const replacement = startPreset(rig.runtime, { state: 'idle', event: 'idle', recipe: 'idle-eye-side' });
  assert.equal(replacement.started, true);
  assert.ok(presetSnapshot(rig.runtime).currentTrace !== null, 'the new action is live');
  rig.resolveNext(); // the OLD action's send succeeds late
  await flush();
  await flush();

  const status = evidenceStatus(rig.runtime);
  const liveTrace = presetSnapshot(rig.runtime).currentTrace;
  assert.equal(status.committed, committedBefore, 'the late success is NOT a new commit');
  assert.ok(status.stale >= 1);
  assert.equal(status.lastStaleReason, 'action-changed');
  assert.deepEqual(liveTrace.output.committed, {}, 'the new action has no committed value yet');
  assert.deepEqual(liveTrace.output.committedAt, {});
  assert.equal(Object.values(liveTrace.output.committed).includes(oldSentGaze.value), false);
  console.log(`[stale:action] oldGaze=${oldSentGaze.value.toFixed(4)} committedBefore=${committedBefore} `
    + `committedAfter=${status.committed} stale=${status.stale} reason=${status.lastStaleReason} `
    + `newCommitted=${JSON.stringify(liveTrace.output.committed)}`);
});

test('13. 旧发送路径（idle flush）同样：失败不记 committed、成功记实际发送值、作废记 stale', async () => {
  // (a) every coalesced idle frame is rejected: prepared > 0, no commit at all.
  const failing = makeEvidenceRig({ motionWrites: false, outcomes: new Array(64).fill('reject') });
  await connect(failing, rowsFor(['gazeX']));
  startPreset(failing.runtime, { state: 'idle', event: 'idle', recipe: 'idle-eye-side' });
  await run(failing, 0, 400);
  const failStatus = evidenceStatus(failing.runtime);
  const failTrace = presetSnapshot(failing.runtime).currentTrace ?? presetSnapshot(failing.runtime).lastTrace;
  assert.ok(failing.calls.length >= 3, `the legacy path attempted ${failing.calls.length} sends`);
  assert.equal(failStatus.attempted, failing.calls.length);
  assert.equal(failStatus.failed, failing.calls.length);
  assert.equal(failStatus.committed, 0);
  assert.equal(failStatus.committedRows, 0);
  assert.ok(failStatus.prepared >= failStatus.attempted);
  assert.deepEqual(failTrace.output.committed, {});
  assert.equal(failTrace.output.failed.count, failing.calls.length);

  // (b) a successful coalesced idle frame commits its ACTUAL payload value with `at`.
  const success = makeEvidenceRig({ motionWrites: false });
  await connect(success, rowsFor(['gazeX']));
  startPreset(success.runtime, { state: 'idle', event: 'idle', recipe: 'idle-eye-side' });
  await run(success, 0, 300);
  const lastCall = success.calls.at(-1);
  const lastGaze = lastCall.entries.find((entry) => entry.channel === 'gazeX');
  const okTrace = presetSnapshot(success.runtime).currentTrace ?? presetSnapshot(success.runtime).lastTrace;
  const okStatus = evidenceStatus(success.runtime);
  assert.ok(lastGaze !== undefined);
  assert.equal(okTrace.output.committed.gazeX, lastGaze.value);
  assert.ok(Number.isFinite(okTrace.output.committedAt.gazeX));
  assert.equal(okStatus.committed, success.calls.length, 'one commit per acknowledged idle frame');
  assert.equal(okStatus.failed, 0);

  // (c) an idle frame invalidated while in flight is stale, never committed.
  const slow = makeEvidenceRig({ motionWrites: false, outcomes: ['pending'] });
  await connect(slow, rowsFor(['gazeX']));
  startPreset(slow.runtime, { state: 'idle', event: 'idle', recipe: 'idle-eye-side' });
  slow.tick(0);
  assert.equal(slow.calls.length, 1);
  slow.runtime.lock('privacy');
  slow.resolveNext();
  await flush();
  await flush();
  const slowStatus = evidenceStatus(slow.runtime);
  assert.equal(slowStatus.committed, 0);
  assert.ok(slowStatus.stale >= 1);
  assert.equal(slowStatus.lastStaleReason, 'generation');

  console.log(`[legacy] failAttempts=${failStatus.attempted} failCommitted=${failStatus.committed} `
    + `okCalls=${success.calls.length} okCommitted=${okStatus.committed} okValue=${okTrace.output.committed.gazeX.toFixed(4)} `
    + `slowStale=${slowStatus.stale}`);
});
