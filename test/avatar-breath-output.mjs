/**
 * P-54 剩余项 — 呼吸输出：呼吸只在 discovery 给出「已验证」的 breath 输入时才经传输层写出。
 *
 * 约束（与 PLAN P-54 / P-139 硬约束一致）：
 *   1. 参数名只能来自 discovery 的 `inputName`（本测试故意用 `Breath`，而不是模型参数
 *      `ParamBreath`；运行时不硬编码任何参数名）；
 *   2. 没有已验证输入时零呼吸写入，其他通道照常；
 *   3. 隐私锁 / 断连 / dispose 后不再产生新的呼吸写入，旧帧被帧代次作废、不会复活；
 *   4. 呼吸与头部通道在同一帧（同一次 `writeFrame` 批次）里写出，一个批次最多一条 breath，
 *      不存在第二个呼吸写入者；
 *   5. 30 Hz 输出沿用运行时既有的单槽/单飞发送，测试不额外增加发送频率。
 *
 * Run: node --test test/avatar-breath-output.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createAvatarRuntime } from '../src/host/avatar/avatarRuntime.js';
import { discoverCapabilities, resetCapabilities } from '../src/host/avatar/avatarMotion.js';

/** Let a coalesced/settled transport promise run its `.then`/`.finally` chain. */
const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));
const flushTwice = async () => {
  await flushMicrotasks();
  await flushMicrotasks();
};

const HEAD_INPUT = { name: 'FaceAngleX', min: -30, max: 30, defaultValue: 0 };
const BREATH_INPUT = { name: 'Breath', min: 0, max: 1, defaultValue: 0 };
const MODEL_PARAMS = [{ name: 'ParamAngleX' }, { name: 'ParamBreath' }];

/**
 * Discovery through the real name→model-parameter rule; no hand-written channel row.
 * `verifyBreath:false` keeps the injectable `Breath` input but removes `ParamBreath` from the
 * model parameter list, which is exactly the "candidate, not verified" boundary.
 */
async function discoverModel({ withBreath = true, verifyBreath = withBreath } = {}) {
  resetCapabilities();
  const identity = {
    modelId: verifyBreath ? 'breath-model' : withBreath ? 'unverified-breath-model' : 'no-breath-model',
    modelGeneration: 1,
    connectionGeneration: 1,
  };
  return discoverCapabilities({
    identity,
    currentIdentity: () => identity,
    listInputParameters: async () => ({
      defaultParameters: withBreath ? [HEAD_INPUT, BREATH_INPUT] : [HEAD_INPUT],
      customParameters: [],
    }),
    listModelParameters: async () => ({
      ok: true,
      source: 'avatar-breath-output-fixture',
      parameters: verifyBreath ? MODEL_PARAMS : [{ name: 'ParamAngleX' }],
    }),
  });
}

function createRecordingTransport() {
  const frames = [];
  const singles = [];
  let clock = 0;
  return {
    frames,
    singles,
    setClock(value) { clock = value; },
    transport: {
      connect: async () => {},
      disconnect: async () => {},
      write: async ({ input, value }) => {
        singles.push({ input, value, at: clock });
        return { ok: true };
      },
      writeFrame: async (entries) => {
        frames.push({ at: clock, entries: entries.map((entry) => ({ ...entry })) });
        return { ok: true };
      },
    },
  };
}

/** One manually released send: lets the test hold the single-flight gate open on purpose. */
function createHeldTransport() {
  const frames = [];
  const gates = [];
  let clock = 0;
  return {
    frames,
    gates,
    setClock(value) { clock = value; },
    transport: {
      connect: async () => {},
      disconnect: async () => {},
      write: async ({ input, value }) => {
        frames.push({ at: clock, entries: [{ input, value }] });
        return { ok: true };
      },
      writeFrame: (entries) => {
        frames.push({ at: clock, entries: entries.map((entry) => ({ ...entry })) });
        let release;
        const promise = new Promise((resolve) => { release = resolve; });
        gates.push({ release, entries });
        return promise.then(() => ({ ok: true }));
      },
    },
  };
}

async function connectRuntime({ transport, channels, config = {} }) {
  const runtime = createAvatarRuntime({
    transport,
    config: {
      autoTickMs: 0,
      motionWrites: true,
      motionOutputHz: 30,
      motionSendTimeoutMs: 60_000,
      ...config,
    },
  });
  const connected = await runtime.connect();
  assert.equal(connected.ok, true, `runtime connects (${connected.message ?? ''})`);
  const applied = await runtime.setChannelMappings(channels);
  assert.equal(applied.ok, true, 'discovered channel mappings apply');
  return runtime;
}

/** Drive the existing 30 Hz path; the transport records one batch per sent frame. */
async function drive(runtime, recorder, { from = 0, to = 3000, step = 34 } = {}) {
  for (let at = from; at <= to; at += step) {
    recorder.setClock(at);
    runtime.tick(at);
    await flushMicrotasks();
  }
}

const breathRows = (frames) => frames
  .flatMap((frame) => frame.entries)
  .filter((entry) => entry.channel === 'breath');

test('1. discovery 有已验证 breath 输入：写出该参数，值随呼吸变化且在范围内', async () => {
  const discovered = await discoverModel({ withBreath: true });
  const breath = discovered.channels.find((entry) => entry.channel === 'breath');
  const head = discovered.channels.find((entry) => entry.channel === 'headX');
  assert.ok(breath, 'discovery returns a breath channel row');
  assert.equal(breath.verified, true, 'breath is verified by input name + model parameter');
  assert.equal(breath.inputName, 'Breath', 'the input name comes from discovery, never ParamBreath');
  assert.equal(head?.verified, true, 'the head channel is independently verified');

  const recorder = createRecordingTransport();
  const runtime = await connectRuntime({ transport: recorder.transport, channels: discovered.channels });
  const snapshotBefore = runtime.snapshot();
  assert.equal(snapshotBefore.breath.mapped, true, 'the runtime reports the verified breath mapping');
  assert.equal(snapshotBefore.breath.input, 'Breath');

  await drive(runtime, recorder, { from: 0, to: 6000, step: 34 });

  const rows = breathRows(recorder.frames);
  assert.ok(rows.length >= 40, `breath was written across the window (${rows.length} rows)`);
  for (const row of rows) {
    assert.equal(row.input, 'Breath', 'every row targets the discovered input name');
    assert.equal(row.value >= 0 && row.value <= 1, true,
      `breath value ${row.value} stays inside the discovered input range`);
  }
  const values = rows.map((row) => row.value);
  const spread = Math.max(...values) - Math.min(...values);
  assert.ok(spread > 0.05, `the breath value really moves (spread ${spread.toFixed(3)})`);
  assert.equal(recorder.frames.some((frame) => frame.entries
    .some((entry) => entry.input === 'ParamBreath')), false,
  'the model parameter ParamBreath is never used as an injectable input');

  const snapshot = runtime.snapshot();
  assert.ok(snapshot.breath.writes > 0, `settled breath writes are counted (${snapshot.breath.writes})`);
  assert.equal(snapshot.breath.skipped, 0, 'a verified channel never reports a skip');
  console.log(`[breath-output] discovered input=${breath.inputName} rows=${rows.length}`
    + ` spread=${spread.toFixed(3)} writes=${snapshot.breath.writes}`);
  runtime.dispose();
});

test('2. 无 breath 输入：不写呼吸参数，其他通道照常输出', async () => {
  const discovered = await discoverModel({ withBreath: false });
  const breath = discovered.channels.find((entry) => entry.channel === 'breath');
  const head = discovered.channels.find((entry) => entry.channel === 'headX');
  assert.equal(breath?.injectable, false, 'the model has no injectable breath input');
  assert.equal(breath?.verified, false, 'an absent input cannot be verified');
  assert.equal(head?.verified, true, 'the head channel still verifies');

  const recorder = createRecordingTransport();
  const runtime = await connectRuntime({ transport: recorder.transport, channels: discovered.channels });
  await drive(runtime, recorder, { from: 0, to: 2200, step: 34 });

  const allRows = recorder.frames.flatMap((frame) => frame.entries);
  assert.equal(allRows.some((entry) => entry.channel === 'breath'), false,
    'no breath row is ever added without a verified binding');
  assert.equal(allRows.some((entry) => /breath/i.test(entry.input)), false,
    'no guessed breath input name is written');
  const headRows = allRows.filter((entry) => entry.input === 'FaceAngleX');
  assert.ok(headRows.length > 0, `the other verified channels still output (${headRows.length} head rows)`);
  assert.ok(recorder.frames.length > 0, 'the frame writer still runs');

  const snapshot = runtime.snapshot();
  assert.equal(snapshot.breath.mapped, false);
  assert.equal(snapshot.breath.writes, 0);
  assert.ok(snapshot.breath.skipped >= 1, 'the missing proof is reported, not silently guessed');
  console.log(`[breath-output] no-input rows=${allRows.length} headRows=${headRows.length}`
    + ` skipped=${snapshot.breath.skipped}`);
  runtime.dispose();
});

test('2b. breath 输入存在但未验证：同样不写，也不使用模型参数名', async () => {
  const discovered = await discoverModel({ withBreath: true, verifyBreath: false });
  const breath = discovered.channels.find((entry) => entry.channel === 'breath');
  assert.equal(breath?.injectable, true, 'the Breath input exists in the injectable list');
  assert.equal(breath?.verified, false, 'a name match without ParamBreath is only a candidate');
  assert.equal(breath?.inputName, 'Breath');

  const recorder = createRecordingTransport();
  const runtime = await connectRuntime({ transport: recorder.transport, channels: discovered.channels });
  await drive(runtime, recorder, { from: 0, to: 1800, step: 34 });

  const allRows = recorder.frames.flatMap((frame) => frame.entries);
  assert.equal(allRows.some((entry) => entry.channel === 'breath'), false,
    'an unverified candidate is never written');
  assert.equal(allRows.some((entry) => /breath/i.test(entry.input)), false,
    'neither Breath nor ParamBreath is written');
  const snapshot = runtime.snapshot();
  assert.equal(snapshot.breath.mapped, false);
  assert.equal(snapshot.channels.unverified.includes('breath'), true,
    'the candidate is reported as unverified, not silently dropped');
  console.log(`[breath-output] unverified candidate rows=${allRows.length}`
    + ` mapped=${snapshot.breath.mapped}`);
  runtime.dispose();
});

test('3. 隐私锁/断连/dispose：零迟到呼吸写入，旧在途帧不复活', async () => {
  const discovered = await discoverModel({ withBreath: true });

  // --- privacy lock: hold one send, stage a newer frame, lock, then release the old send. ---
  {
    const held = createHeldTransport();
    const runtime = await connectRuntime({ transport: held.transport, channels: discovered.channels });
    held.setClock(0);
    runtime.tick(0);
    await flushMicrotasks();
    assert.equal(held.frames.length, 1, 'the first 30 Hz frame is sent');
    held.setClock(100);
    runtime.tick(100);
    await flushMicrotasks();
    assert.equal(held.frames.length, 1, 'the newer frame waits in the single slot (single flight)');

    const locked = runtime.setMotionEnabled(false, { reason: 'privacy' });
    assert.equal(locked.ok, true);
    const afterLock = held.frames.length;
    held.gates[0].release();
    await flushTwice();
    assert.equal(held.frames.length, afterLock, 'a late settle after the privacy lock sends nothing');

    for (let at = 200; at <= 800; at += 34) {
      held.setClock(at);
      runtime.tick(at);
      await flushMicrotasks();
    }
    assert.equal(held.frames.length, afterLock, 'no breath/head frame leaves while the gate is locked');
    assert.equal(breathRows(held.frames.slice(afterLock)).length, 0, 'zero late breath writes');

    runtime.setMotionEnabled(true);
    held.setClock(900);
    runtime.tick(900);
    await flushMicrotasks();
    assert.equal(held.frames.length, afterLock + 1, 'unlocking starts a fresh generation');
    assert.equal(held.frames[afterLock].at, 900, 'the old staged frame did not come back');
    runtime.dispose();
  }

  // --- disconnect: the pending send is invalidated and later ticks write nothing. ---
  {
    const held = createHeldTransport();
    const runtime = await connectRuntime({ transport: held.transport, channels: discovered.channels });
    held.setClock(0);
    runtime.tick(0);
    await flushMicrotasks();
    const before = held.frames.length;
    await runtime.disconnect();
    held.gates[0].release();
    await flushTwice();
    held.setClock(100);
    runtime.tick(100);
    await flushMicrotasks();
    assert.equal(runtime.snapshot().connected, false);
    assert.equal(held.frames.length, before, 'no frame (and no breath write) after disconnect');
    assert.equal(breathRows(held.frames.slice(before)).length, 0);
    runtime.dispose();
  }

  // --- dispose: terminal teardown leaves no late writer behind. ---
  {
    const held = createHeldTransport();
    const runtime = await connectRuntime({ transport: held.transport, channels: discovered.channels });
    held.setClock(0);
    runtime.tick(0);
    await flushMicrotasks();
    const before = held.frames.length;
    runtime.dispose();
    held.gates[0].release();
    await flushTwice();
    held.setClock(100);
    runtime.tick(100);
    await flushMicrotasks();
    assert.equal(runtime.snapshot().disposed, true);
    assert.equal(held.frames.length, before, 'no frame (and no breath write) after dispose');
    assert.equal(breathRows(held.frames.slice(before)).length, 0);
  }
  console.log('[breath-output] lock/disconnect/dispose: zero late breath writes');
});

test('4. 同一帧写入：呼吸与头部共享一个批次，一个输入只有一个写入者', async () => {
  const discovered = await discoverModel({ withBreath: true });
  const recorder = createRecordingTransport();
  const runtime = await connectRuntime({ transport: recorder.transport, channels: discovered.channels });
  await drive(runtime, recorder, { from: 0, to: 2600, step: 34 });

  assert.ok(recorder.frames.length >= 20, `the 30 Hz writer produced frames (${recorder.frames.length})`);
  let breathBatches = 0;
  for (const frame of recorder.frames) {
    const breath = frame.entries.filter((entry) => entry.channel === 'breath');
    const head = frame.entries.filter((entry) => entry.channel === 'headX');
    assert.ok(breath.length <= 1, `at most one breath row per frame (${breath.length})`);
    if (breath.length === 0) continue;
    breathBatches += 1;
    assert.equal(head.length, 1, 'the breath row travels in the same batch as the head channel');
    const inputs = frame.entries.map((entry) => entry.input);
    assert.equal(new Set(inputs).size, inputs.length, 'one final value per input per frame');
    assert.equal(frame.entries.filter((entry) => entry.input === 'Breath').length, 1,
      'exactly one writer owns the breath input in this frame');
  }
  assert.equal(breathBatches, recorder.frames.length, 'every frame carries exactly one breath row');
  // The mouth path (a separate transport call) is never used to smuggle a second breath writer in.
  assert.equal(recorder.singles.some((entry) => /breath/i.test(entry.input)), false,
    'no separate breath write exists outside the batch');
  const snapshot = runtime.snapshot();
  assert.equal(snapshot.breath.writes, breathBatches,
    `settled breath writes match the batches (${snapshot.breath.writes}/${breathBatches})`);
  console.log(`[breath-output] batches=${recorder.frames.length}`
    + ` breathBatches=${breathBatches} singleWrites=${recorder.singles.length}`);
  runtime.dispose();
});
