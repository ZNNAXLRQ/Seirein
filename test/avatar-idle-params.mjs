/**
 * Continuous idle parameter frames (P2/design deviation):
 *   - a discovered head/eye/gaze mapping makes the runtime publish and WRITE idle frames
 *     (`idleSource: 'param'`, transport writes > 0) through the single writer;
 *   - a channel without an input mapping is skipped and reported (`avatar.channel.skipped`);
 *   - without any mapping the runtime writes no parameter frame and reports the hotkey fallback
 *     as the idle source, never as a continuous behavior engine;
 *   - SPEECH NEVER PAUSES THE FRAME: a mouth only scales its amplitude (IDLE_SPEECH_SCALE), owns
 *     its own input and never cancels an explicit gesture. `flags.idle === false` is the one
 *     full pause; the idleMaxStep limiter still bounds every frame (no jitter).
 *   - ZERO AMPLITUDE IS STATIONARY: a zero gain/style amplitude, or idleAmplitude / idleMaxStep /
 *     idleSwayScale = 0, suppresses the "never frozen" motion floor entirely (reported as
 *     `avatar.idle.motion-floor.skipped {reason:'zero-amplitude'}`), so no ±0.81° nudge appears.
 *
 * Run: node --test test/avatar-idle-params.mjs
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  ALIVE_FALLBACK_GAIN,
  IDLE_SPEECH_SCALE,
  INTENT_IDLE_RATIO,
  SPEECH_HEAD_DAMP,
  createAvatarRuntime,
} from '../src/host/avatar/avatarRuntime.js';

function createFakeTransport() {
  const writes = [];
  const batches = [];
  const stats = { writeCalls: 0, frameCalls: 0 };
  return {
    writes,
    batches,
    get writeCalls() { return stats.writeCalls; },
    get frameCalls() { return stats.frameCalls; },
    transport: {
      connect: async () => {},
      disconnect: async () => {},
      write: async ({ input, value }) => {
        stats.writeCalls += 1;
        writes.push({ input, value });
        return { ok: true };
      },
      writeFrame: async (entries) => {
        stats.frameCalls += 1;
        batches.push(entries);
        writes.push(...entries.map((entry) => ({ input: entry.input, value: entry.value })));
        return { ok: true };
      },
    },
  };
}

/** Let the coalesced idle send settle between two ticks (the flush is async by design). */
const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

/** Drive one tick per timestamp, waiting for the pending idle frame to settle after each one. */
const tickAt = async (runtime, times) => {
  for (const at of times) {
    runtime.tick(at);
    await flushMicrotasks();
  }
};

const connectRuntime = async (options) => {
  const runtime = createAvatarRuntime(options);
  const result = await runtime.connect();
  assert.equal(result.ok, true, `runtime connects (${result.message ?? ''})`);
  return runtime;
};

test('1. 给定映射：运行时产出连续帧、idleSource=param、写入次数 > 0', async () => {
  const fake = createFakeTransport();
  const logs = [];
  const runtime = await connectRuntime({
    transport: fake.transport,
    log: (message, data = {}) => logs.push({ message, ...data }),
    config: {
      autoTickMs: 0,
      flushIntervalMs: 1,
      idleParams: {
        headX: { inputName: 'FaceAngleX', min: -30, max: 30 },
        eyeOpenL: { inputName: 'EyeOpenLeft', min: 0, max: 1 },
        gazeX: { inputName: 'EyeBallX', min: -1, max: 1 },
      },
    },
  });

  assert.equal(runtime.snapshot().idleSource, 'param');
  assert.deepEqual(runtime.snapshot().idleParams.mapped.sort(), ['eyeOpenL', 'gazeX', 'headX']);

  for (let step = 0; step < 4; step += 1) runtime.tick(1000 + step * 120);
  await new Promise((resolve) => setImmediate(resolve));

  const snapshot = runtime.snapshot();
  // The runtime keeps computing a full pose every tick; the flush consumed the pending frame.
  assert.ok(snapshot.inner.frames.computed >= 4, 'the runtime produced a frame on every tick');
  assert.equal(Number.isFinite(snapshot.inner.pose.headX), true, 'the produced pose carries the idle head angle');
  assert.ok(snapshot.idleParams.frames > 0, 'idle frames were flushed');
  assert.ok(snapshot.idleParams.writes > 0, 'idle parameter writes happened');
  assert.ok(fake.writes.length > 0, 'the transport received values');
  const head = fake.writes.filter((entry) => entry.input === 'FaceAngleX');
  assert.ok(head.length > 0, 'the mapped head input was written');
  for (const entry of head) assert.ok(Math.abs(entry.value) <= 30, 'value stays inside the input range');
  // Unmapped channels are skipped and recorded (throttled through the log hook).
  assert.ok(logs.some((entry) => entry.event === 'avatar.channel.skipped'), 'unmapped idle channels are recorded');
  console.log(`[avatar-idle] idleSource=param writes=${snapshot.idleParams.writes} frames=${snapshot.idleParams.frames} skipped=${snapshot.idleParams.skipped}`);
  runtime.dispose();
});

test('2. 无映射：不写参数帧，idleSource 退化为 hotkey/none', async () => {
  const fake = createFakeTransport();
  const runtime = await connectRuntime({
    transport: fake.transport,
    config: {
      autoTickMs: 0,
      flushIntervalMs: 1,
      idleParams: {
        headX: { inputName: '' },
        eyeOpenL: { inputName: '' },
        gazeX: { inputName: '' },
      },
      idleActions: ['sway', 'tilt'],
    },
  });

  assert.equal(runtime.snapshot().idleSource, 'hotkey', 'the fallback is reported as hotkey, not an engine');
  for (let step = 0; step < 4; step += 1) runtime.tick(2000 + step * 120);
  assert.equal(runtime.snapshot().idleParams.frames, 0);
  assert.equal(fake.writes.length, 0, 'nothing is written without a mapping');
  assert.equal(runtime.snapshot().idleParams.unmapped.length > 0, true);
  console.log('[avatar-idle] no-mapping idleSource=hotkey writes=0');
  runtime.dispose();

  const quiet = await connectRuntime({
    transport: createFakeTransport().transport,
    config: { autoTickMs: 0, idleActions: [], idleParams: null },
  });
  assert.equal(quiet.snapshot().idleSource, 'none');
  quiet.dispose();
});

// ---------------------------------------------------------------------------------------------
// Idle jitter fix: rate cap, amplitude cap, per-frame step cap, channel set
// ---------------------------------------------------------------------------------------------

const HEAD_RANGE = { min: -30, max: 30 };

/** Midpoint of a bipolar ±30 input: the neutral value every semantic 0 maps onto. */
const INPUT_MID = (HEAD_RANGE.min + HEAD_RANGE.max) / 2;

/** Sum of |value - midpoint| over one input: a phase-exact amplitude measure (no peak sampling). */
const amplitudeSum = (writes, input) => writes
  .filter((entry) => entry.input === input)
  .reduce((total, entry) => total + Math.abs(entry.value - INPUT_MID), 0);

const approx = (actual, expected, message = '', epsilon = 0.02) => {
  assert.ok(Math.abs(actual - expected) <= epsilon,
    `${message}: expected ${expected} ±${epsilon}, got ${actual}`);
};

test('3. 降频：1 秒内空闲写入帧 ≤ 4，状态暴露 writeHz/lastFrameAt，启动发 tuned 事件', async () => {
  const fake = createFakeTransport();
  const logs = [];
  const runtime = await connectRuntime({
    transport: fake.transport,
    log: (message, data = {}) => logs.push({ message, ...data }),
    config: {
      autoTickMs: 0,
      idleParams: { headX: { inputName: 'FaceAngleX', ...HEAD_RANGE } },
    },
  });

  const tuned = logs.find((entry) => entry.event === 'avatar.idle.tuned');
  assert.ok(tuned, 'avatar.idle.tuned is emitted once when the runtime starts');
  assert.equal(tuned.writeHz, 4, 'tuned reports the configured write rate');
  assert.equal(tuned.amplitude, 0.18, 'tuned reports the configured amplitude (raised default)');

  const before = runtime.snapshot().idleParams.frames;
  await tickAt(runtime, Array.from({ length: 20 }, (_, index) => 1000 + index * 50));
  const snapshot = runtime.snapshot();
  const frames = snapshot.idleParams.frames - before;
  assert.ok(frames <= 4, `one second must write at most 4 idle frames, got ${frames}`);
  assert.ok(fake.frameCalls <= 4, `the transport got at most 4 idle calls, got ${fake.frameCalls}`);
  assert.equal(snapshot.idleParams.writeHz, 4);
  assert.ok(Number.isFinite(snapshot.idleParams.lastFrameAt), 'lastFrameAt is exposed');
  console.log(
    `[idle] rate frames=${frames} transportCalls=${fake.frameCalls}`
    + ` writeHz=${snapshot.idleParams.writeHz} lastFrameAt=${snapshot.idleParams.lastFrameAt}`,
  );
  runtime.dispose();
});

test('4. 限幅：头部单轴空闲幅度不超过 idleAmplitude（0.05 → ±1.5°）', async () => {
  const fake = createFakeTransport();
  const runtime = await connectRuntime({
    transport: fake.transport,
    config: {
      autoTickMs: 0,
      idleParams: {
        headX: { inputName: 'FaceAngleX', ...HEAD_RANGE },
        headY: { inputName: 'FaceAngleY', ...HEAD_RANGE },
        headZ: { inputName: 'FaceAngleZ', ...HEAD_RANGE },
      },
      idleSwayScale: 10, // a deliberately huge curve: the cap, not the generator, must hold
      idleAmplitude: 0.05,
      idleMaxStep: 1,
    },
  });

  await tickAt(runtime, Array.from({ length: 40 }, (_, index) => 3000 + index * 250));
  const peaks = {};
  for (const input of ['FaceAngleX', 'FaceAngleY', 'FaceAngleZ']) {
    const values = fake.writes.filter((entry) => entry.input === input).map((entry) => entry.value);
    assert.ok(values.length >= 10, `${input} was written continuously (${values.length})`);
    peaks[input] = Math.max(...values.map((value) => Math.abs(value)));
    assert.ok(peaks[input] <= 1.5 + 1e-9, `${input} peak ${peaks[input]}° exceeds the ±1.5° cap`);
  }
  assert.equal(runtime.snapshot().idleParams.amplitude, 0.05);
  console.log(`[idle] amplitude peaks(deg)=${JSON.stringify(peaks)} cap=1.5 (idleAmplitude=0.05, ±30 input)`);
  runtime.dispose();
});

test('5. 平滑：相邻两帧的变化量不超过 idleMaxStep', async () => {
  const fake = createFakeTransport();
  const runtime = await connectRuntime({
    transport: fake.transport,
    config: {
      autoTickMs: 0,
      idleParams: { headX: { inputName: 'FaceAngleX', ...HEAD_RANGE } },
      idleSwayScale: 10,
      idleAmplitude: 0.5,
      idleMaxStep: 0.01,
    },
  });

  await tickAt(runtime, Array.from({ length: 40 }, (_, index) => 5000 + index * 250));
  const values = fake.writes.filter((entry) => entry.input === 'FaceAngleX').map((entry) => entry.value);
  assert.ok(values.length >= 10, `expected a series of head frames, got ${values.length}`);
  let maxDelta = 0;
  for (let index = 1; index < values.length; index += 1) {
    maxDelta = Math.max(maxDelta, Math.abs(values[index] - values[index - 1]));
  }
  // 0.01 semantic × 30 (half of the ±30 input range) = 0.3 input units per written frame.
  assert.ok(maxDelta <= 0.3 + 1e-9, `max frame delta ${maxDelta} exceeds idleMaxStep (0.3 input units)`);
  console.log(`[idle] maxStep delta=${maxDelta.toFixed(4)} cap=0.3 (idleMaxStep=0.01)`);
  runtime.dispose();
});

test('6. 不写无关通道：空闲只写 head 三轴（+可选 eye），绝不写 brow / gaze', async () => {
  const fake = createFakeTransport();
  const runtime = await connectRuntime({
    transport: fake.transport,
    config: {
      autoTickMs: 0,
      idleParams: {
        headX: { inputName: 'FaceAngleX', ...HEAD_RANGE },
        headY: { inputName: 'FaceAngleY', ...HEAD_RANGE },
        headZ: { inputName: 'FaceAngleZ', ...HEAD_RANGE },
        eyeOpenL: { inputName: 'EyeOpenLeft', min: 0, max: 1 },
        eyeOpenR: { inputName: 'EyeOpenRight', min: 0, max: 1 },
        gazeX: { inputName: 'EyeBallX', min: -1, max: 1 },
      },
      idleEye: true,
    },
  });

  await tickAt(runtime, Array.from({ length: 12 }, (_, index) => 7000 + index * 250));
  // An explicit gaze mapping is probe-verified once through write(); an *idle frame* must never
  // carry gaze/brow (idle batches are recorded separately from single writes).
  const idleInputs = fake.batches.flat().map((entry) => entry.input);
  const inputs = new Set(idleInputs);
  for (const forbidden of ['BrowL', 'BrowR', 'BrowLeft', 'BrowRight', 'EyeBallX', 'EyeBallY']) {
    assert.equal(inputs.has(forbidden), false, `${forbidden} must never be written by an idle frame`);
  }
  assert.deepEqual(
    [...inputs].sort(),
    ['EyeOpenLeft', 'EyeOpenRight', 'FaceAngleX', 'FaceAngleY', 'FaceAngleZ'],
  );
  // Optional eye is a tiny deviation from fully open, never a blink substitute.
  const eye = fake.batches.flat().filter((entry) => entry.input.startsWith('EyeOpen'));
  assert.ok(eye.length > 0, 'opt-in eye channels are written when idleEye=true');
  for (const entry of eye) {
    assert.ok(entry.value >= 0.975 - 1e-9 && entry.value <= 1 + 1e-9, `eye value ${entry.value} left the tiny band`);
  }
  assert.equal(fake.batches.some((batch) => batch.some((entry) => entry.input === 'EyeBallX')), false,
    'the gaze probe is not an idle frame');
  console.log(`[idle] channels=${[...inputs].sort().join(',')} eye=±0.025 brow=none gaze=none`);
  runtime.dispose();
});

// ---------------------------------------------------------------------------------------------
// Speech no longer pauses the idle frame: the mouth owns its input, the body keeps moving
// ---------------------------------------------------------------------------------------------

test('7. 说话期间仍写空闲帧（> 0），幅度按 IDLE_SPEECH_SCALE 降低，口型帧同时存在', async () => {
  const idleConfig = {
    autoTickMs: 0,
    flushIntervalMs: 1,
    idleWriteHz: 8,
    inputs: { mouth: { inputName: 'MouthOpen', min: 0, max: 1 } },
    channelMap: { mouth: 'MouthOpen' },
    idleParams: {
      headX: { inputName: 'FaceAngleX', ...HEAD_RANGE },
      headZ: { inputName: 'FaceAngleZ', ...HEAD_RANGE },
    },
  };
  const speakingFake = createFakeTransport();
  const quietFake = createFakeTransport();
  const speaking = await connectRuntime({ transport: speakingFake.transport, config: idleConfig });
  // Lockstep control on the SAME tick grid: the amplitude ratio is phase-exact, not peak-sampled.
  const quiet = await connectRuntime({ transport: quietFake.transport, config: idleConfig });
  speakingFake.writes.length = 0; // connect() probes are not idle frames
  quietFake.writes.length = 0;

  await tickAt(speaking, [10900]);
  await tickAt(quiet, [10900]);
  const baselineFrames = speaking.snapshot().idleParams.frames;
  assert.ok(baselineFrames >= 1, 'one idle frame before the line');

  const spoken = await speaking.speak({
    levels: Array.from({ length: 9 }, () => 0.7),
    stepMs: 100,
    startedAt: 11000,
  });
  assert.equal(spoken.ok, true, `speech starts (${spoken.message ?? ''})`);

  const duringStart = { speaking: speakingFake.writes.length, quiet: quietFake.writes.length };
  await tickAt(speaking, Array.from({ length: 18 }, (_, index) => 11000 + index * 50));
  await tickAt(quiet, Array.from({ length: 18 }, (_, index) => 11000 + index * 50));
  const during = speaking.snapshot();
  const framesDuring = during.idleParams.frames - baselineFrames;
  assert.ok(framesDuring > 0, `idle frames are written while speaking (${framesDuring})`);
  assert.equal(during.idleParams.reducedBySpeech, framesDuring, 'every speech frame is counted as reduced');
  approx(during.idleParams.speechScale, IDLE_SPEECH_SCALE, 'status exposes the speech scale', 1e-9);

  const ratioSince = (input) => amplitudeSum(speakingFake.writes.slice(duringStart.speaking), input)
    / amplitudeSum(quietFake.writes.slice(duringStart.quiet), input);
  // headZ is scaled by the facade speech factor alone; headX is damped further by the generator,
  // yet still moves (non-zero) — speech reduces the amplitude, it never stops the body.
  const ratioHeadZ = ratioSince('FaceAngleZ');
  const ratioHeadX = ratioSince('FaceAngleX');
  approx(ratioHeadZ, IDLE_SPEECH_SCALE, 'headZ amplitude follows IDLE_SPEECH_SCALE');
  approx(ratioHeadX, SPEECH_HEAD_DAMP * IDLE_SPEECH_SCALE, 'headX keeps its speech-damped motion');
  assert.ok(ratioHeadX < 1, 'the speaking amplitude is smaller than the quiet one');

  const mouthWrites = speakingFake.writes.slice(duringStart.speaking)
    .filter((entry) => entry.input === 'MouthOpen');
  assert.ok(mouthWrites.length > 0, 'mouth frames exist at the same time');
  assert.ok(mouthWrites.every((entry) => entry.value > 0), 'the mouth input carries the speech level');

  // Past the line + 200 ms release + 500 ms hold the amplitude returns to the quiet level. Ten
  // settle ticks first: the speaking run's springs still carry the reduced trajectory otherwise.
  await tickAt(speaking, Array.from({ length: 10 }, (_, index) => 13000 + index * 50));
  await tickAt(quiet, Array.from({ length: 10 }, (_, index) => 13000 + index * 50));
  const afterStart = { speaking: speakingFake.writes.length, quiet: quietFake.writes.length };
  await tickAt(speaking, Array.from({ length: 17 }, (_, index) => 13500 + index * 50));
  await tickAt(quiet, Array.from({ length: 17 }, (_, index) => 13500 + index * 50));
  const after = speaking.snapshot();
  assert.ok(after.idleParams.frames > during.idleParams.frames, 'idle frames resume after speech');
  const afterRatio = (input) => amplitudeSum(speakingFake.writes.slice(afterStart.speaking), input)
    / amplitudeSum(quietFake.writes.slice(afterStart.quiet), input);
  approx(afterRatio('FaceAngleX'), 1, 'the amplitude is back to the non-speaking level (headX)');
  approx(afterRatio('FaceAngleZ'), 1, 'the amplitude is back to the non-speaking level (headZ)');
  console.log(
    `[idle] speech frames=${framesDuring} reduced=${during.idleParams.reducedBySpeech}`
    + ` ratioHeadZ=${ratioHeadZ.toFixed(3)} ratioHeadX=${ratioHeadX.toFixed(3)}`
    + ` afterHeadX=${afterRatio('FaceAngleX').toFixed(3)}`,
  );
  speaking.dispose();
  quiet.dispose();
});

test('8. 同帧同 input：口型优先、每帧只写一次', async () => {
  const fake = createFakeTransport();
  const runtime = await connectRuntime({
    transport: fake.transport,
    config: {
      autoTickMs: 0,
      flushIntervalMs: 1,
      idleWriteHz: 8,
      inputs: { mouth: { inputName: 'MouthOpen', min: 0, max: 1 } },
      channelMap: { mouth: 'MouthOpen' },
      idleParams: {
        // A deliberately colliding mapping: one idle channel addresses the mouth input.
        headX: { inputName: 'MouthOpen', min: -30, max: 30 },
        headY: { inputName: 'FaceAngleY', ...HEAD_RANGE },
      },
    },
  });
  const controlled = runtime.snapshot().channels.controlled;
  assert.ok(controlled.includes('mouth'), 'the mouth input is verified');
  assert.ok(controlled.includes('headX'), 'the colliding idle channel is verified');
  fake.writes.length = 0;
  fake.batches.length = 0;

  const spoken = await runtime.speak({
    levels: Array.from({ length: 6 }, () => 0.9),
    stepMs: 100,
    startedAt: 0,
  });
  assert.equal(spoken.ok, true, `speech starts (${spoken.message ?? ''})`);

  const ticks = [];
  for (let at = 0; at < 600; at += 100) {
    const writeFrom = fake.writes.length;
    const batchFrom = fake.batches.length;
    runtime.tick(at);
    await flushMicrotasks();
    ticks.push({
      at,
      mouth: fake.writes.slice(writeFrom).filter((entry) => entry.input === 'MouthOpen'),
      frameInputs: fake.batches.slice(batchFrom).flat().map((entry) => entry.input),
    });
  }
  for (const tick of ticks) {
    assert.ok(tick.mouth.length <= 1, `the mouth input was written ${tick.mouth.length}× in one tick (${tick.at}ms)`);
    for (const entry of tick.mouth) {
      assert.equal(entry.value, 0.9, `the mouth value wins over the idle value (${tick.at}ms)`);
    }
    assert.equal(tick.frameInputs.includes('MouthOpen'), false,
      `no idle frame writes the mouth input (${tick.at}ms)`);
    assert.equal(new Set(tick.frameInputs).size, tick.frameInputs.length,
      `duplicate input in one frame: ${tick.frameInputs.join(',')}`);
  }
  assert.ok(ticks.some((tick) => tick.mouth.length === 1), 'the mouth was written while speaking');
  const snapshot = runtime.snapshot();
  assert.ok(snapshot.idleParams.frames > 0, 'idle frames keep flowing on the other channels');
  assert.ok(fake.batches.flat().some((entry) => entry.input === 'FaceAngleY'),
    'the non-conflicting idle channel is still written');
  console.log(
    `[idle] mouthPriority frames=${snapshot.idleParams.frames}`
    + ` mouthWrites=${ticks.reduce((total, tick) => total + tick.mouth.length, 0)}`
    + ` idleInputs=${[...new Set(fake.batches.flat().map((entry) => entry.input))].join(',')}`,
  );
  runtime.dispose();
});

test('9. flags.idle === false 是唯一完全暂停开关：空闲帧 0，恢复后继续写', async () => {
  const fake = createFakeTransport();
  const runtime = await connectRuntime({
    transport: fake.transport,
    config: {
      autoTickMs: 0,
      idleWriteHz: 8,
      idleParams: { headX: { inputName: 'FaceAngleX', ...HEAD_RANGE } },
    },
  });
  await tickAt(runtime, [0, 50, 100, 200, 300]);
  const before = runtime.snapshot().idleParams.frames;
  assert.ok(before > 0, 'idle frames before the pause');

  runtime.setIntent({ flags: { idle: false } });
  await tickAt(runtime, [400, 500, 600, 700, 800, 900]);
  const paused = runtime.snapshot();
  assert.equal(paused.idleParams.frames, before, 'no idle frame while flags.idle === false');
  assert.ok(paused.idleParams.suppressedByIdleOff > 0, 'the explicit pause is recorded');
  assert.equal(paused.idleParams.reducedBySpeech, 0, 'this is a pause, not a speech reduction');

  runtime.setIntent({ flags: { idle: true } });
  await tickAt(runtime, [1000, 1100, 1200]);
  const resumed = runtime.snapshot();
  assert.ok(resumed.idleParams.frames > paused.idleParams.frames, 'idle frames resume after the pause');
  console.log(
    `[idle] idleOff pausedAt=${paused.idleParams.frames} suppressedByIdleOff=${paused.idleParams.suppressedByIdleOff}`
    + ` resumed=${resumed.idleParams.frames - paused.idleParams.frames}`,
  );
  runtime.dispose();
});

test('10. 说话期间不抖动：相邻帧变化量不超过 idleMaxStep', async () => {
  const fake = createFakeTransport();
  const runtime = await connectRuntime({
    transport: fake.transport,
    config: {
      autoTickMs: 0,
      flushIntervalMs: 1,
      idleParams: { headX: { inputName: 'FaceAngleX', ...HEAD_RANGE } },
      idleSwayScale: 10,
      idleAmplitude: 0.5,
      idleMaxStep: 0.01,
    },
  });
  const spoken = await runtime.speak({
    levels: Array.from({ length: 10 }, () => 0.6),
    stepMs: 100,
    startedAt: 0,
  });
  assert.equal(spoken.ok, true, `speech starts (${spoken.message ?? ''})`);

  await tickAt(runtime, Array.from({ length: 40 }, (_, index) => index * 250));
  const values = fake.writes.filter((entry) => entry.input === 'FaceAngleX').map((entry) => entry.value);
  assert.ok(values.length >= 8, `expected a series of head frames while speaking, got ${values.length}`);
  let maxDelta = 0;
  for (let index = 1; index < values.length; index += 1) {
    maxDelta = Math.max(maxDelta, Math.abs(values[index] - values[index - 1]));
  }
  // 0.01 semantic × 30 (half of the ±30 input range) = 0.3 input units per written frame.
  assert.ok(maxDelta <= 0.3 + 1e-9, `max frame delta ${maxDelta} exceeds idleMaxStep (0.3 input units)`);
  assert.ok(runtime.snapshot().idleParams.frames > 0, 'speech frames were written');
  console.log(`[idle] speech jitter maxStep delta=${maxDelta.toFixed(4)} cap=0.3`);
  runtime.dispose();
});

test('11. 说话 + 显式 nod：headY 动作主导，微动叠加 ≤ INTENT_IDLE_RATIO', async () => {
  const config = {
    autoTickMs: 0,
    flushIntervalMs: 1,
    idleParams: { headY: { inputName: 'FaceAngleY', ...HEAD_RANGE } },
    style: { nodDurationMs: 900 },
  };
  let clock = 0;
  const speaking = await connectRuntime({
    transport: createFakeTransport().transport,
    now: () => clock,
    config,
  });
  const gestureOnly = await connectRuntime({
    transport: createFakeTransport().transport,
    now: () => clock,
    config,
  });
  // The control runtime has idle OFF, so its pose is the explicit gesture alone.
  gestureOnly.setIntent({ flags: { idle: false } });
  const spoken = await speaking.speak({
    levels: Array.from({ length: 20 }, () => 0.6),
    stepMs: 100,
    startedAt: 0,
  });
  assert.equal(spoken.ok, true, `speech starts (${spoken.message ?? ''})`);

  const micro = [];
  for (let at = 0; at <= 75; at += 25) {
    clock = at;
    gestureOnly.tick(at);
    micro.push(speaking.tick(at).headY);
  }
  const microSpread = Math.max(...micro) - Math.min(...micro);
  assert.ok(microSpread > 1e-4, `head micro-motion continues while speaking without a gesture (${microSpread})`);

  clock = 100;
  assert.equal(speaking.intent('nod').ok, true, 'the nod is accepted while speaking');
  assert.equal(gestureOnly.intent('nod').ok, true, 'the control nod is accepted');
  const series = { speaking: [], gesture: [] };
  for (let at = 100; at <= 1100; at += 25) {
    clock = at;
    series.speaking.push(speaking.tick(at).headY);
    series.gesture.push(gestureOnly.tick(at).headY);
  }
  const peakGesture = Math.max(...series.gesture.map((value) => Math.abs(value)));
  const peakSpeaking = Math.max(...series.speaking.map((value) => Math.abs(value)));
  const microOnAction = Math.max(...series.speaking.map(
    (value, index) => Math.abs(value - series.gesture[index]),
  ));
  assert.ok(peakGesture > 0.1, `the nod is visible (peak ${peakGesture})`);
  assert.ok(peakSpeaking >= peakGesture * 0.75,
    `the gesture is not cancelled by micro-motion (${peakSpeaking} vs ${peakGesture})`);
  assert.ok(microOnAction <= INTENT_IDLE_RATIO * peakGesture * 1.25,
    `micro-motion adds at most ${INTENT_IDLE_RATIO * 100}% of the gesture (${microOnAction} vs ${peakGesture})`);
  console.log(
    `[idle] nod+speech peak=${peakSpeaking.toFixed(4)} gesturePeak=${peakGesture.toFixed(4)}`
    + ` micro=${microOnAction.toFixed(4)} ratio=${(microOnAction / peakGesture).toFixed(3)}`
    + ` cap=${INTENT_IDLE_RATIO}`,
  );
  speaking.dispose();
  gestureOnly.dispose();
});

// ---------------------------------------------------------------------------------------------
// Discrete idle pool — unavailable actions leave the pool instead of being skipped every 9 s
// ---------------------------------------------------------------------------------------------
//
// Contract under test:
//   - the sampler only draws actions the verified channels can animate (complete or degraded);
//   - a degraded action runs here as one equivalent single-channel gesture, so the avatar is never
//     left with nothing but "frozen" micro-motion (and no per-interval channel.skipped stream);
//   - one taken-over channel raises the micro-motion to a perceptible level (gain ×1.5) while the
//     idleMaxStep limiter still bounds every written frame;
//   - with every channel mapped the pool is complete and nothing degrades (regression).

/** Record every structured log line; `event` is the structured name. */
const logsOf = (logs, event) => logs.filter((entry) => entry.event === event);

test('12. 只接管 headX：动作池非空（含降级动作），9 秒窗口内至少执行 1 次动作', async () => {
  const fake = createFakeTransport();
  const logs = [];
  let clock = 0;
  const runtime = await connectRuntime({
    transport: fake.transport,
    now: () => clock,
    log: (message, data = {}) => logs.push({ message, ...data }),
    config: {
      autoTickMs: 0,
      flushIntervalMs: 1,
      // A deterministic pick (0.99 → last entry) lands on "nod"; with only headX mapped every
      // one-channel gesture is degraded, so the sampled nod runs as its tilt substitute.
      random: () => 0.99,
      actionDurationMs: 600,
      idleParams: { headX: { inputName: 'FaceAngleX', ...HEAD_RANGE } },
    },
  });

  const poolEvents = logsOf(logs, 'avatar.idle.actions.pool');
  assert.equal(poolEvents.length, 1, 'avatar.idle.actions.pool is recorded once at startup');
  assert.deepEqual(poolEvents[0].available, ['sway', 'tilt', 'nod'], 'only runnable actions stay');
  assert.deepEqual(poolEvents[0].dropped, ['glance'], 'gaze-only action is dropped, never sampled');
  assert.equal(poolEvents[0].fallback, true, 'the pool runs in degraded mode');

  const status = runtime.snapshot();
  assert.deepEqual(status.idleActions.pool, ['sway', 'tilt', 'nod']);
  assert.deepEqual(status.idleActions.degraded, ['sway', 'tilt', 'nod'],
    'sway/tilt/nod all run as parameter gestures when only headX is mapped');
  assert.equal(status.idleActions.aliveFallback, true, 'one writable channel → alive fallback');

  for (clock = 0; clock <= 9600; clock += 30) runtime.tick(clock);
  const starts = logsOf(logs, 'avatar.action.start');
  assert.ok(starts.length >= 1, `at least one action ran inside the 9 s window (${starts.length})`);
  assert.equal(runtime.snapshot().actions.started >= 1, true);
  assert.equal(starts[0].degraded, true, 'the degraded action is executed by the runtime');
  assert.equal(starts[0].action, 'nod', 'it is the sampled nod, run as an equivalent gesture');
  assert.equal(starts[0].name, 'tilt', 'the tilt intent is the headX substitute for a nod');
  assert.deepEqual(runtime.takeActions(), [], 'the host is not asked for a hotkey it may not have');
  console.log(
    `[pool] headXOnly available=${status.idleActions.pool.join(',')}`
    + ` dropped=${status.idleActions.dropped.join(',')} degraded=${status.idleActions.degraded.join(',')}`
    + ` actionStarts=${starts.length} start=${starts[0].action}->${starts[0].name} alive=${status.idleActions.aliveFallback}`,
  );
  runtime.dispose();
});

test('12b. 只有 headX 且宿主没有热键：sway/tilt 由参数意图真正执行（不再依赖热键）', async () => {
  const fake = createFakeTransport();
  const logs = [];
  let clock = 0;
  const runtime = await connectRuntime({
    transport: fake.transport,
    now: () => clock,
    log: (message, data = {}) => logs.push({ message, ...data }),
    config: {
      autoTickMs: 0,
      flushIntervalMs: 1,
      // Deterministic: the first pool entry ("sway") is sampled on every interval.
      random: () => 0,
      actionDurationMs: 600,
      idleActionIntervalMs: 100,
      idleActionDedupeMs: 0,
      idleParams: { headX: { inputName: 'FaceAngleX', ...HEAD_RANGE } },
    },
  });
  fake.writes.length = 0; // connect() probes are not idle frames

  let intentTicks = 0;
  for (clock = 0; clock <= 9600; clock += 20) {
    runtime.tick(clock);
    if ((runtime.snapshot().inner.intents?.channels ?? []).includes('headX')) intentTicks += 1;
    await flushMicrotasks();
  }

  const starts = logsOf(logs, 'avatar.action.start');
  assert.ok(starts.length >= 1, `at least one action ran inside the 9 s window (${starts.length})`);
  assert.equal(starts[0].action, 'sway', 'the sampled one-channel action actually ran');
  assert.equal(starts[0].name, 'tilt', 'it runs as the headX/tilt parameter gesture');
  assert.equal(starts[0].degraded, true, 'the runtime executes it itself');
  assert.ok(intentTicks > 0, 'the tilt intent was live on headX while the action ran');
  const snapshot = runtime.snapshot();
  assert.ok(snapshot.idleParams.writes > 0, `parameter writes > 0 (${snapshot.idleParams.writes})`);
  assert.ok(fake.writes.length > 0, 'parameter frames reached the transport');
  assert.ok(fake.writes.some((entry) => entry.input === 'FaceAngleX'), 'headX was written');
  assert.deepEqual(runtime.takeActions(), [], 'no hotkey request is made for an action it can animate');
  console.log(
    `[pool] headXOnlyAction action=${starts[0].action}->${starts[0].name} starts=${starts.length}`
    + ` paramWrites=${snapshot.idleParams.writes} intentTicks=${intentTicks}`,
  );
  runtime.dispose();
});

test('13. 动作所需通道不可用：只记 1 条汇总跳过，不按 9 秒周期重复刷', async () => {
  const fake = createFakeTransport();
  const logs = [];
  let clock = 0;
  const runtime = await connectRuntime({
    transport: fake.transport,
    now: () => clock,
    log: (message, data = {}) => logs.push({ message, ...data }),
    config: {
      autoTickMs: 0,
      flushIntervalMs: 1,
      idleActionDedupeMs: 0,
      idleParams: { headX: { inputName: 'FaceAngleX', ...HEAD_RANGE } },
    },
  });

  const summary = () => logs.filter((entry) => entry.event === 'avatar.channel.skipped'
    && entry.reason === 'idle-action-unmapped');
  assert.equal(summary().length, 1, 'one summary skip at startup, not one per action');
  assert.deepEqual(summary()[0].actions, ['glance']);
  assert.deepEqual(summary()[0].channels, ['gazeX', 'gazeY'],
    'the summary names the channels that are missing');

  // Four sampling intervals: the dropped action must not be re-sampled or re-logged.
  for (clock = 0; clock <= 40000; clock += 30) runtime.tick(clock);
  const emitted = runtime.snapshot().inner.idleActions.emitted;
  assert.ok(emitted >= 4, `the rhythm really ran (${emitted} candidates)`);
  assert.equal(summary().length, 1, 'the skip is still a single summary after four intervals');
  assert.equal(logsOf(logs, 'avatar.channel.skipped')
    .filter((entry) => entry.reason === 'idle-action-unmapped').length, 1);
  console.log(
    `[pool] summarySkips=${summary().length} intervals=${emitted}`
    + ` dropped=${summary()[0].actions.join(',')} channels=${summary()[0].channels.join(',')}`,
  );
  runtime.dispose();
});

test('14. 单通道 aliveFallback：微动幅度 ×1.5，相邻帧变化仍 ≤ idleMaxStep', async () => {
  // Phase A — no step limiter: the written amplitude ratio is exactly the alive gain.
  const ratioConfig = { autoTickMs: 0, flushIntervalMs: 1, idleSwayScale: 1, idleAmplitude: 0.1, idleMaxStep: 1 };
  const single = createFakeTransport();
  const pair = createFakeTransport();
  const boosted = await connectRuntime({
    transport: single.transport,
    config: { ...ratioConfig, idleParams: { headX: { inputName: 'FaceAngleX', ...HEAD_RANGE } } },
  });
  const baseline = await connectRuntime({
    transport: pair.transport,
    config: {
      ...ratioConfig,
      idleParams: {
        headX: { inputName: 'FaceAngleX', ...HEAD_RANGE },
        headY: { inputName: 'FaceAngleY', ...HEAD_RANGE },
      },
    },
  });
  assert.equal(boosted.snapshot().idleActions.aliveFallback, true);
  assert.equal(baseline.snapshot().idleActions.aliveFallback, false);
  single.writes.length = 0;
  pair.writes.length = 0;
  for (let at = 1000; at <= 1000 + 39 * 250; at += 250) {
    boosted.tick(at);
    baseline.tick(at);
    await flushMicrotasks();
  }
  const valuesOf = (fake) => fake.writes
    .filter((entry) => entry.input === 'FaceAngleX')
    .map((entry) => entry.value);
  const peakOf = (list) => Math.max(...list.map((value) => Math.abs(value)));
  const boostedValues = valuesOf(single);
  const baselineValues = valuesOf(pair);
  assert.ok(boostedValues.length >= 10 && baselineValues.length >= 10, 'both runtimes wrote headX');
  const ratio = peakOf(boostedValues) / peakOf(baselineValues);
  approx(ratio, ALIVE_FALLBACK_GAIN, 'single-channel micro-motion is ×1.5 the baseline', 0.05);
  assert.ok(peakOf(boostedValues) > peakOf(baselineValues), 'the boosted motion is visibly larger');

  // Phase B — same boost with the production step limiter: bigger, never jittery.
  const stepped = createFakeTransport();
  const alive = await connectRuntime({
    transport: stepped.transport,
    config: {
      autoTickMs: 0,
      flushIntervalMs: 1,
      idleSwayScale: 10,
      idleAmplitude: 0.1,
      idleMaxStep: 0.02,
      idleParams: { headX: { inputName: 'FaceAngleX', ...HEAD_RANGE } },
    },
  });
  stepped.writes.length = 0;
  for (let at = 1000; at <= 1000 + 39 * 250; at += 250) {
    alive.tick(at);
    await flushMicrotasks();
  }
  const steppedValues = valuesOf(stepped);
  let maxDelta = 0;
  for (let index = 1; index < steppedValues.length; index += 1) {
    maxDelta = Math.max(maxDelta, Math.abs(steppedValues[index] - steppedValues[index - 1]));
  }
  // 0.02 semantic × 30 (half of the ±30 input range) = 0.6 input units per written frame.
  assert.ok(maxDelta <= 0.02 * 30 + 1e-9, `max frame delta ${maxDelta} exceeds idleMaxStep`);
  assert.ok(peakOf(steppedValues) > 2, `the single channel still moves visibly (peak ${peakOf(steppedValues)})`);
  assert.ok(peakOf(steppedValues) <= 0.1 * ALIVE_FALLBACK_GAIN * 30 + 1e-6,
    'the raised amplitude cap still holds');
  console.log(
    `[alive] gain=${(ratio).toFixed(3)} boostedPeak=${peakOf(boostedValues).toFixed(3)}`
    + ` baselinePeak=${peakOf(baselineValues).toFixed(3)} maxStepDelta=${maxDelta.toFixed(4)}`
    + ` steppedPeak=${peakOf(steppedValues).toFixed(3)} cap=${(0.1 * ALIVE_FALLBACK_GAIN * 30).toFixed(1)}`,
  );
  boosted.dispose();
  baseline.dispose();
  alive.dispose();
});

test('15. 全部通道可用：动作池完整、无降级（回归），动作仍交给 host 热键', async () => {
  const fake = createFakeTransport();
  const logs = [];
  let clock = 0;
  const runtime = await connectRuntime({
    transport: fake.transport,
    now: () => clock,
    log: (message, data = {}) => logs.push({ message, ...data }),
    config: {
      autoTickMs: 0,
      flushIntervalMs: 1,
      random: () => 0.99,
      actionDurationMs: 600,
      idleEye: true,
      // The host confirms its own hotkeys: a complete action must stay on the host path.
      hasHotkey: () => true,
      idleParams: {
        headX: { inputName: 'FaceAngleX', ...HEAD_RANGE },
        headY: { inputName: 'FaceAngleY', ...HEAD_RANGE },
        headZ: { inputName: 'FaceAngleZ', ...HEAD_RANGE },
        gazeX: { inputName: 'EyeBallX', min: -1, max: 1 },
        gazeY: { inputName: 'EyeBallY', min: -1, max: 1 },
        eyeOpenL: { inputName: 'EyeOpenLeft', min: 0, max: 1 },
        eyeOpenR: { inputName: 'EyeOpenRight', min: 0, max: 1 },
      },
    },
  });

  const status = runtime.snapshot();
  assert.deepEqual(status.idleActions.pool, ['sway', 'tilt', 'glance', 'nod'], 'the full pool is kept');
  assert.deepEqual(status.idleActions.degraded, [], 'no action degrades when every channel is mapped');
  assert.deepEqual(status.idleActions.dropped, []);
  assert.equal(status.idleActions.fallback, false);
  assert.equal(status.idleActions.aliveFallback, false, 'no single-channel fallback');
  const poolEvents = logsOf(logs, 'avatar.idle.actions.pool');
  assert.equal(poolEvents.length, 1);
  assert.equal(poolEvents[0].fallback, false);
  assert.deepEqual(poolEvents[0].dropped, []);

  for (clock = 0; clock <= 9600; clock += 30) runtime.tick(clock);
  const starts = logsOf(logs, 'avatar.action.start');
  assert.equal(starts.length, 1, 'one action ran in the 9 s window');
  assert.equal(starts[0].degraded, false, 'a complete action is not degraded');
  assert.equal(starts[0].name, 'nod');
  const delivered = runtime.takeActions();
  assert.equal(delivered.length, 1, 'the host still receives the hotkey to play');
  assert.equal(delivered[0].name, 'nod');
  console.log(
    `[pool] allChannels available=${status.idleActions.pool.join(',')}`
    + ` degraded=0 dropped=0 alive=false start=${starts[0].name} delivered=${delivered.length}`,
  );
  runtime.dispose();
});

test('16. 宿主确认热键存在：sway 仍走热键路径（回归），只有无热键的动作降级', async () => {
  const fake = createFakeTransport();
  const logs = [];
  let clock = 0;
  const runtime = await connectRuntime({
    transport: fake.transport,
    now: () => clock,
    log: (message, data = {}) => logs.push({ message, ...data }),
    config: {
      autoTickMs: 0,
      flushIntervalMs: 1,
      random: () => 0, // the first pool entry ("sway") is sampled
      actionDurationMs: 600,
      idleActionIntervalMs: 100,
      idleActionDedupeMs: 0,
      hasHotkey: (name) => name === 'sway',
      idleParams: { headX: { inputName: 'FaceAngleX', ...HEAD_RANGE } },
    },
  });

  const status = runtime.snapshot();
  assert.deepEqual(status.idleActions.degraded, ['tilt', 'nod'],
    'only the actions without a confirmed hotkey run as parameter gestures');
  for (clock = 0; clock <= 9600; clock += 30) runtime.tick(clock);
  const starts = logsOf(logs, 'avatar.action.start');
  assert.ok(starts.length >= 1, `an action ran inside the 9 s window (${starts.length})`);
  assert.equal(starts[0].action, 'sway');
  assert.equal(starts[0].degraded, false, 'a host-confirmed hotkey keeps the host path');
  const delivered = runtime.takeActions();
  assert.ok(delivered.length >= 1, 'the host receives the hotkey to play');
  assert.equal(delivered[0].name, 'sway');
  console.log(
    `[pool] hotkeyPath start=${starts[0].name} degraded=${starts[0].degraded} delivered=${delivered.length}`,
  );
  runtime.dispose();
});

// ---------------------------------------------------------------------------------------------
// Perceptible idle (defaults raised, smoothing unchanged)
// ---------------------------------------------------------------------------------------------
//
// The old defaults were idleAmplitude 0.1 / idleMaxStep 0.02 / idleSwayScale 1 /
// idleActionIntervalMs 9000 and a 0.06 head base swing — a head that read as frozen (±1.8°).
// The new defaults are 0.18 / 0.03 / 1.2 / 7000 with a 0.09 head base (±3.2°), and the smoothing
// contract is untouched: one writer, dedupe, mouth priority, explicit-action priority (≤20%) and
// the idleMaxStep limiter still bound every written frame.

/** Head values the transport received, in write order. */
const writtenHead = (fake, input = 'FaceAngleX') => fake.writes
  .filter((entry) => entry.input === input)
  .map((entry) => entry.value);

/** Total travelled distance between consecutive written frames: "how much motion was delivered". */
const travelOf = (values) => values.slice(1)
  .reduce((total, value, index) => total + Math.abs(value - values[index]), 0);

/** Mean |value| of a written series: phase-exact amplitude, independent of peak sampling. */
const meanMagnitude = (values) => values.reduce((sum, value) => sum + Math.abs(value), 0)
  / Math.max(1, values.length);

/** Largest change between two consecutive written frames. */
const maxStepOf = (values) => values.slice(1)
  .reduce((max, value, index) => Math.max(max, Math.abs(value - values[index])), 0);

/**
 * Run one idle-only runtime for `durationMs` on the same 30 ms tick grid and return the head
 * values it wrote. `config` overrides only the tuning knobs, never the helpers above.
 */
const recordHeadIdle = async (config, durationMs = 9000) => {
  const fake = createFakeTransport();
  const runtime = await connectRuntime({
    transport: fake.transport,
    config: {
      autoTickMs: 0,
      flushIntervalMs: 1,
      idleActions: [],
      idleParams: { headX: { inputName: 'FaceAngleX', ...HEAD_RANGE } },
      ...config,
    },
  });
  fake.writes.length = 0; // connect() probes are not idle frames
  for (let at = 0; at <= durationMs; at += 30) {
    runtime.tick(at);
    await flushMicrotasks();
  }
  const values = writtenHead(fake);
  runtime.dispose();
  return values;
};

test('17. 新默认值生效：amplitude=0.18、maxStep=0.03、swayScale=1.2、interval=7000，头部摆幅 ±3.2°', async () => {
  const fake = createFakeTransport();
  const runtime = await connectRuntime({
    transport: fake.transport,
    config: {
      autoTickMs: 0,
      flushIntervalMs: 1,
      idleActions: [],
      // Two head axes: no single-channel alive gain, so the numbers are the plain defaults.
      idleParams: {
        headX: { inputName: 'FaceAngleX', ...HEAD_RANGE },
        headY: { inputName: 'FaceAngleY', ...HEAD_RANGE },
      },
    },
  });

  const snap = runtime.snapshot();
  assert.equal(snap.idleParams.amplitude, 0.18, 'default idleAmplitude is 0.18');
  assert.equal(snap.idleParams.maxStep, 0.03, 'default idleMaxStep is 0.03');
  assert.equal(snap.idleParams.swayScale, 1.2, 'default idleSwayScale is 1.2');
  assert.equal(snap.inner.idleActions.intervalMs, 7000, 'default idle action interval is 7000 ms');
  // The host status projects these four values under live2d.runtime.idleActions (index.js wiring).
  const source = await readFile(new URL('../src/host/index.js', import.meta.url), 'utf8');
  for (const expression of [
    'amplitude: snap.idleParams?.amplitude',
    'maxStep: snap.idleParams?.maxStep',
    'swayScale: snap.idleParams?.swayScale',
    'intervalMs: inner.idleActions?.intervalMs',
  ]) {
    assert.ok(source.includes(expression), `index.js projects ${expression} into status.idleActions`);
  }

  fake.writes.length = 0;
  let peak = 0;
  for (let at = 1000; at <= 10_000; at += 30) {
    const pose = runtime.tick(at);
    peak = Math.max(peak, Math.abs(pose.headX));
    await flushMicrotasks();
  }
  // 0.09 head base × 1.2 default swing = 0.108 semantic → ±3.24° on a ±30° input.
  const degrees = peak * 30;
  assert.ok(degrees > 2.6, `the head really swings now (${degrees.toFixed(2)}°)`);
  assert.ok(degrees <= 0.18 * 30 + 1e-6, `the amplitude cap still holds (${degrees.toFixed(2)}° ≤ 5.4°)`);
  console.log(
    `[defaults] amplitude=${snap.idleParams.amplitude} maxStep=${snap.idleParams.maxStep}`
    + ` swayScale=${snap.idleParams.swayScale} intervalMs=${snap.inner.idleActions.intervalMs}`
    + ` headSwing=${degrees.toFixed(2)}° cap=${(0.18 * 30).toFixed(1)}°`,
  );
  runtime.dispose();
});

test('18. 单通道 9 秒窗口：写入次数不低于旧值，摆幅与行程比值 > 1.4（旧值 → 新默认）', async () => {
  // "旧默认" reproduces the old effective swing with today's code: the head base is a code
  // constant (0.06 → 0.09), and 0.09 × (2/3) restores the old 0.06 curve on the same generator.
  const oldValues = await recordHeadIdle({
    idleSwayScale: 2 / 3,
    idleAmplitude: 0.1,
    idleMaxStep: 0.02,
    idleActionIntervalMs: 9000,
  });
  const newValues = await recordHeadIdle({});
  assert.ok(oldValues.length >= 20 && newValues.length >= 20,
    `both windows wrote head frames (old ${oldValues.length}, new ${newValues.length})`);

  const writesRatio = newValues.length / oldValues.length;
  const amplitudeRatio = meanMagnitude(newValues) / meanMagnitude(oldValues);
  const travelRatio = travelOf(newValues) / travelOf(oldValues);
  // The write cadence (4 Hz) is a hard contract, so the count is equal by construction; the
  // perceptible gain is per-frame amplitude and delivered travel, both ~1.8× the old defaults.
  assert.ok(writesRatio >= 1, `the write count never drops below the old default (${writesRatio.toFixed(3)})`);
  assert.ok(amplitudeRatio > 1.4, `the written amplitude grew > 1.4× (${amplitudeRatio.toFixed(3)})`);
  assert.ok(travelRatio > 1.4, `the delivered travel grew > 1.4× (${travelRatio.toFixed(3)})`);
  console.log(
    `[gain] writes old=${oldValues.length} new=${newValues.length} ratio=${writesRatio.toFixed(3)}`
    + ` amplitudeRatio=${amplitudeRatio.toFixed(3)} travelRatio=${travelRatio.toFixed(3)}`,
  );
});

test('19. 默认步长平滑：相邻帧变化 ≤ idleMaxStep=0.03（更明显但不抖动）', async () => {
  // Natural defaults: the curve never needs the limiter, but stays under it anyway.
  const natural = await recordHeadIdle({});
  const naturalStep = maxStepOf(natural);
  assert.ok(naturalStep <= 0.03 * 30 + 1e-9,
    `natural max frame delta ${naturalStep.toFixed(4)} exceeds idleMaxStep (0.9 input units)`);

  // A deliberately huge curve: the limiter must clip every frame to exactly idleMaxStep.
  const capped = await recordHeadIdle({ idleSwayScale: 10 });
  const cappedStep = maxStepOf(capped);
  assert.ok(cappedStep <= 0.03 * 30 + 1e-9,
    `capped max frame delta ${cappedStep.toFixed(4)} exceeds idleMaxStep (0.9 input units)`);
  assert.ok(cappedStep > 0.8, `the limiter is really active on the huge curve (${cappedStep.toFixed(4)})`);
  console.log(
    `[smooth] naturalStep=${naturalStep.toFixed(4)} cappedStep=${cappedStep.toFixed(4)} cap=${(0.03 * 30).toFixed(1)}`,
  );
});

test('20. 新默认值下说话仍降幅：headZ ×0.9、headX ×0.54（口型帧同时存在）', async () => {
  const config = {
    autoTickMs: 0,
    flushIntervalMs: 1,
    idleWriteHz: 8,
    inputs: { mouth: { inputName: 'MouthOpen', min: 0, max: 1 } },
    channelMap: { mouth: 'MouthOpen' },
    idleParams: {
      headX: { inputName: 'FaceAngleX', ...HEAD_RANGE },
      headZ: { inputName: 'FaceAngleZ', ...HEAD_RANGE },
    },
  };
  const speakingFake = createFakeTransport();
  const quietFake = createFakeTransport();
  const speaking = await connectRuntime({ transport: speakingFake.transport, config });
  const quiet = await connectRuntime({ transport: quietFake.transport, config });
  speakingFake.writes.length = 0;
  quietFake.writes.length = 0;
  await tickAt(speaking, [10900]);
  await tickAt(quiet, [10900]);
  const from = { speaking: speakingFake.writes.length, quiet: quietFake.writes.length };

  const spoken = await speaking.speak({
    levels: Array.from({ length: 9 }, () => 0.7),
    stepMs: 100,
    startedAt: 11000,
  });
  assert.equal(spoken.ok, true, `speech starts (${spoken.message ?? ''})`);
  await tickAt(speaking, Array.from({ length: 18 }, (_, index) => 11000 + index * 50));
  await tickAt(quiet, Array.from({ length: 18 }, (_, index) => 11000 + index * 50));

  const ratioOf = (input) => amplitudeSum(speakingFake.writes.slice(from.speaking), input)
    / amplitudeSum(quietFake.writes.slice(from.quiet), input);
  const ratioHeadZ = ratioOf('FaceAngleZ');
  const ratioHeadX = ratioOf('FaceAngleX');
  approx(ratioHeadZ, IDLE_SPEECH_SCALE, 'headZ keeps the speech scale (×0.9) with the new defaults');
  approx(ratioHeadX, SPEECH_HEAD_DAMP * IDLE_SPEECH_SCALE, 'headX keeps its extra speech damp (×0.54)');
  assert.ok(ratioHeadX < ratioHeadZ, 'the head is damped further than the body channel');
  const mouthWrites = speakingFake.writes.slice(from.speaking)
    .filter((entry) => entry.input === 'MouthOpen');
  assert.ok(mouthWrites.length > 0, 'mouth frames exist at the same time');
  assert.ok(speaking.snapshot().idleParams.frames > 0, 'idle frames keep flowing while speaking');
  console.log(
    `[speech] ratioHeadZ=${ratioHeadZ.toFixed(3)} ratioHeadX=${ratioHeadX.toFixed(3)}`
    + ` expected=${IDLE_SPEECH_SCALE}/${(SPEECH_HEAD_DAMP * IDLE_SPEECH_SCALE).toFixed(2)} mouthWrites=${mouthWrites.length}`,
  );
  speaking.dispose();
  quiet.dispose();
});

test('21. 新默认值下显式动作仍优先：微动 ≤ 20%，运动地板不抢动作通道', async () => {
  const logs = [];
  let clock = 0;
  const config = {
    autoTickMs: 0,
    flushIntervalMs: 1,
    idleActions: [],
    idleParams: {
      headX: { inputName: 'FaceAngleX', ...HEAD_RANGE },
      headY: { inputName: 'FaceAngleY', ...HEAD_RANGE },
    },
    style: { nodDurationMs: 900 },
  };
  const speaking = await connectRuntime({
    transport: createFakeTransport().transport,
    log: (message, data = {}) => logs.push({ message, ...data }),
    now: () => clock,
    config,
  });
  // The control runtime has idle OFF, so its pose is the explicit gesture alone.
  const gestureOnly = await connectRuntime({
    transport: createFakeTransport().transport,
    now: () => clock,
    config,
  });
  gestureOnly.setIntent({ flags: { idle: false } });
  const spoken = await speaking.speak({
    levels: Array.from({ length: 20 }, () => 0.6),
    stepMs: 100,
    startedAt: 0,
  });
  assert.equal(spoken.ok, true, `speech starts (${spoken.message ?? ''})`);

  const micro = [];
  for (let at = 0; at <= 75; at += 25) {
    clock = at;
    gestureOnly.tick(at);
    micro.push(speaking.tick(at).headY);
  }
  const microSpread = Math.max(...micro) - Math.min(...micro);
  assert.ok(microSpread > 1e-4, `head micro-motion continues while speaking (${microSpread})`);

  clock = 100;
  assert.equal(speaking.intent('nod').ok, true, 'the nod is accepted while speaking');
  assert.equal(gestureOnly.intent('nod').ok, true, 'the control nod is accepted');
  const series = { speaking: [], gesture: [] };
  for (let at = 100; at <= 1100; at += 25) {
    clock = at;
    series.gesture.push(gestureOnly.tick(at).headY);
    series.speaking.push(speaking.tick(at).headY);
  }
  const peakGesture = Math.max(...series.gesture.map((value) => Math.abs(value)));
  const peakSpeaking = Math.max(...series.speaking.map((value) => Math.abs(value)));
  const microOnAction = Math.max(...series.speaking.map(
    (value, index) => Math.abs(value - series.gesture[index]),
  ));
  assert.ok(peakGesture > 0.1, `the nod is visible (peak ${peakGesture})`);
  assert.ok(peakSpeaking >= peakGesture * 0.75, 'the gesture is not cancelled by micro-motion');
  assert.ok(microOnAction <= INTENT_IDLE_RATIO * peakGesture * 1.25,
    `micro-motion adds at most ${INTENT_IDLE_RATIO * 100}% of the gesture (${microOnAction} vs ${peakGesture})`);
  // The floor only ever nudges idle-owned head channels: the gesture channel is exempt.
  const floorEvents = logsOf(logs, 'avatar.idle.motion-floor');
  assert.ok(floorEvents.every((entry) => entry.channel !== 'headY'),
    'the motion floor never nudges the gesturing channel');
  console.log(
    `[priority] peak=${peakSpeaking.toFixed(4)} gesturePeak=${peakGesture.toFixed(4)}`
    + ` micro=${microOnAction.toFixed(4)} ratio=${(microOnAction / peakGesture).toFixed(3)}`
    + ` cap=${INTENT_IDLE_RATIO} floor=${floorEvents.length}`,
  );
  speaking.dispose();
  gestureOnly.dispose();
});

test('22. 非零微幅（swayScale=1e-9）：连续 2 个采样周期无变化 → 最小呼吸式变化（≤ maxStep），motion-floor（节流）', async () => {
  // A curve with (almost) no motion reproduces the "frozen idle" case without disabling the
  // engine: zero is stationary (tests 23/24), but a NON-ZERO tiny amplitude still gets the floor.
  const fake = createFakeTransport();
  const logs = [];
  const runtime = await connectRuntime({
    transport: fake.transport,
    log: (message, data = {}) => logs.push({ message, ...data }),
    config: {
      autoTickMs: 0,
      flushIntervalMs: 1,
      idleActions: [],
      idleSwayScale: 1e-9,
      idleParams: { headX: { inputName: 'FaceAngleX', ...HEAD_RANGE } },
    },
  });
  fake.writes.length = 0;
  for (let at = 0; at <= 4000; at += 250) {
    runtime.tick(at);
    await flushMicrotasks();
  }
  const values = writtenHead(fake);
  assert.ok(values.length >= 8, `the idle frame kept writing (${values.length})`);
  const nudges = values.filter((value) => Math.abs(value) > 0.5);
  assert.ok(nudges.length >= 1, `a still curve is nudged back to life (${nudges.length} nudge frames)`);
  // 0.15 × idleAmplitude(0.18) = 0.027 semantic = 0.81 input units, below maxStep 0.03 (0.9).
  assert.ok(Math.abs(Math.abs(nudges[0]) - 0.027 * 30) < 1e-6,
    `the nudge is the minimal floor step (${nudges[0].toFixed(4)})`);
  const step = maxStepOf(values);
  assert.ok(step <= 0.03 * 30 + 1e-9, `the floor is still bounded by idleMaxStep (${step.toFixed(4)})`);
  const floorEvents = logsOf(logs, 'avatar.idle.motion-floor');
  assert.equal(floorEvents.length, 1, `avatar.idle.motion-floor is throttled (${floorEvents.length})`);
  assert.equal(floorEvents[0].channel, 'headX');
  approx(floorEvents[0].step, 0.027, 'the event reports the injected step');
  assert.ok(runtime.snapshot().idleParams.motionFloor.injected >= 1, 'the floor is visible in status');
  console.log(
    `[floor] frames=${values.length} nudges=${nudges.length} firstNudge=${nudges[0].toFixed(4)}`
    + ` maxDelta=${step.toFixed(4)} events=${floorEvents.length} channel=${floorEvents[0].channel}`,
  );
  runtime.dispose();

  // idleSwayScale: 0 stays an explicit opt-out: nothing is injected, the value stays neutral.
  const quietFake = createFakeTransport();
  const quietLogs = [];
  const quiet = await connectRuntime({
    transport: quietFake.transport,
    log: (message, data = {}) => quietLogs.push({ message, ...data }),
    config: {
      autoTickMs: 0,
      flushIntervalMs: 1,
      idleActions: [],
      idleSwayScale: 0,
      idleParams: { headX: { inputName: 'FaceAngleX', ...HEAD_RANGE } },
    },
  });
  quietFake.writes.length = 0;
  for (let at = 0; at <= 4000; at += 250) {
    quiet.tick(at);
    await flushMicrotasks();
  }
  const quietValues = writtenHead(quietFake);
  assert.ok(quietValues.every((value) => value === 0), 'swayScale 0 disables the floor as well');
  assert.equal(logsOf(quietLogs, 'avatar.idle.motion-floor').length, 0, 'no floor event on the opt-out');
  const quietSkips = logsOf(quietLogs, 'avatar.idle.motion-floor.skipped');
  assert.ok(quietSkips.length >= 1, 'the zero-amplitude opt-out is reported');
  assert.equal(quietSkips[0].reason, 'zero-amplitude', 'the opt-out is named zero-amplitude');
  console.log(
    `[floor] swayScale=0 writes=${quietValues.length} allNeutral=true events=0`
    + ` skipped=${quietSkips.length} reason=${quietSkips[0].reason}`,
  );
  quiet.dispose();
});

// ---------------------------------------------------------------------------------------------
// Motion floor must never override a zero-amplitude setting (P2)
// ---------------------------------------------------------------------------------------------
//
// Contract under test:
//   - zero amplitude IS a legal stationary pose: style amplitude 0 / gain 0 / idleAmplitude 0 /
//     idleMaxStep 0 / idleSwayScale 0 all mean "inject nothing", never a periodic ±0.81° nudge;
//   - a skipped floor is reported once per throttle window as `avatar.idle.motion-floor.skipped`;
//   - with a non-zero amplitude the floor still runs, but one displacement is bounded by the
//     channel's remaining amplitude and by idleMaxStep;
//   - during a posture hold the floor may only fine-tune by ≤15% of the channel amplitude and
//     never replaces the held posture (no posture switch).

/** Run one legacy idle path and return everything a floor assertion needs. */
const recordFloor = async (config, durationMs = 4000) => {
  const fake = createFakeTransport();
  const logs = [];
  let clock = 0;
  const runtime = await connectRuntime({
    transport: fake.transport,
    now: () => clock,
    log: (message, data = {}) => logs.push({ message, ...data }),
    config: {
      autoTickMs: 0,
      flushIntervalMs: 1,
      idleActions: [],
      idleParams: { headX: { inputName: 'FaceAngleX', ...HEAD_RANGE } },
      ...config,
    },
  });
  fake.writes.length = 0;
  for (clock = 0; clock <= durationMs; clock += 250) {
    runtime.tick(clock);
    await flushMicrotasks();
  }
  return { runtime, fake, logs, values: writtenHead(fake) };
};

test('23. 零幅度即静止：style amplitude=0 + gain=0 → 0 次 floor 注入，写入恒为 0', async () => {
  const { runtime, logs, values } = await recordFloor({
    idleSwayScale: 1,
    idleAmplitude: 0.18,
    idleMaxStep: 0.03,
    // The style channel range clamps 0 to its 0.2 minimum, so the explicit per-channel gain is
    // the zero that must win: a zero-gain channel is a legal stationary pose.
    style: { channels: { headX: { amplitude: 0 } } },
    idleParams: { headX: { inputName: 'FaceAngleX', ...HEAD_RANGE, gain: 0 } },
  }, 4000);
  assert.ok(values.length >= 8, `the idle frame kept writing (${values.length})`);
  assert.equal(Math.max(...values.map((value) => Math.abs(value))), 0,
    'zero amplitude writes the neutral value only (no ±0.81° floor pulse)');
  const snapshot = runtime.snapshot();
  assert.equal(snapshot.idleParams.motionFloor.injected, 0, 'no floor injection');
  assert.equal(logsOf(logs, 'avatar.idle.motion-floor').length, 0, 'no injection event');
  const skipped = logsOf(logs, 'avatar.idle.motion-floor.skipped');
  assert.equal(skipped.length, 1, 'the zero-amplitude skip is reported once per throttle window');
  assert.equal(skipped[0].reason, 'zero-amplitude', 'the skip names zero-amplitude');
  console.log(
    `[floor-zero] writes=${values.length} peak=0 injected=0`
    + ` skipped=${skipped.length} reason=${skipped[0].reason}`,
  );
  runtime.dispose();
});

test('24. 全局零调参：idleAmplitude/idleMaxStep/idleSwayScale 为 0 时同样不注入 floor', async () => {
  const cases = [
    { knob: 'idleAmplitude', config: { idleAmplitude: 0 } },
    { knob: 'idleMaxStep', config: { idleMaxStep: 0 } },
    { knob: 'idleSwayScale', config: { idleSwayScale: 0 } },
  ];
  for (const { knob, config } of cases) {
    const { runtime, logs, values } = await recordFloor({
      // A nearly-still curve keeps the floor DUE; the zero knob must still suppress it.
      idleSwayScale: knob === 'idleSwayScale' ? 0 : 1e-9,
      idleAmplitude: knob === 'idleAmplitude' ? 0 : 0.18,
      idleMaxStep: knob === 'idleMaxStep' ? 0 : 0.03,
    }, 4000);
    assert.ok(Math.max(...values.map((value) => Math.abs(value))) <= 1e-6,
      `${knob}=0 writes the neutral value only`);
    assert.equal(runtime.snapshot().idleParams.motionFloor.injected, 0, `${knob}=0 → no floor injection`);
    assert.equal(logsOf(logs, 'avatar.idle.motion-floor').length, 0, `${knob}=0 → no injection event`);
    const skipped = logsOf(logs, 'avatar.idle.motion-floor.skipped');
    assert.equal(skipped.length, 1, `${knob}=0 → the skip is reported once (throttled)`);
    assert.equal(skipped[0].reason, 'zero-amplitude', `${knob}=0 → reason is zero-amplitude`);
    console.log(
      `[floor-zero] ${knob}=0 writes=${values.length} peak=${Math.max(...values.map(Math.abs)).toFixed(6)}`
      + ` injected=0 skipped=${skipped.length}`,
    );
    runtime.dispose();
  }
});

test('25. 正常幅度：floor 仍生效，单次位移 ≤ idleMaxStep 且 ≤ 通道剩余幅度', async () => {
  const { runtime, logs, values } = await recordFloor({
    idleSwayScale: 1e-9, // still curve (the floor is due), but the gain/style are normal
    idleAmplitude: 0.18,
    idleMaxStep: 0.03,
  }, 4000);
  const nudges = values.filter((value) => Math.abs(value) > 0.5);
  assert.ok(nudges.length >= 1, `a still curve is nudged back to life (${nudges.length})`);
  const events = logsOf(logs, 'avatar.idle.motion-floor');
  assert.equal(events.length, 1, `the injection event is throttled (${events.length})`);
  assert.equal(events[0].channel, 'headX');
  assert.ok(events[0].step <= 0.03 + 1e-9, `step ${events[0].step} exceeds idleMaxStep`);
  assert.ok(events[0].step <= events[0].amplitude + 1e-9, 'step never exceeds the channel amplitude');
  assert.ok(events[0].amplitude > 0, 'the event reports the channel amplitude');
  assert.ok(typeof events[0].reason === 'string' && events[0].reason.length > 0,
    'the event reports why the floor ran');
  const step = maxStepOf(values);
  assert.ok(step <= 0.03 * 30 + 1e-9, `one displacement ${step} exceeds idleMaxStep (0.9 input units)`);
  console.log(
    `[floor-normal] frames=${values.length} nudges=${nudges.length}`
    + ` step=${events[0].step.toFixed(4)} amplitude=${events[0].amplitude.toFixed(4)}`
    + ` reason=${events[0].reason} maxDelta=${step.toFixed(4)}`,
  );
  runtime.dispose();
});

test('26. 姿态保持：floor 只做 ≤15% 微调，不打断保持（0 次 posture 切换）', async () => {
  const { runtime, logs, values } = await recordFloor({
    idleSwayScale: 1e-9,
    idleAmplitude: 0.18,
    idleMaxStep: 0.03,
    postureHoldMinMs: 1000,
    postureHoldMaxMs: 1000,
    postureHoldChance: 1, // every decision explicitly keeps the same posture
  }, 12_000);
  const motion = runtime.snapshot().motion;
  assert.equal(motion.postureSwitches, 0, 'the held posture was never replaced');
  assert.ok(motion.postureHolds >= 1, 'an explicit hold decision happened');
  const events = logsOf(logs, 'avatar.idle.motion-floor');
  assert.ok(events.length >= 1, 'the floor still runs during the hold');
  for (const event of events) {
    assert.ok(event.step <= 0.15 * event.amplitude + 1e-9,
      `hold fine-tune ${event.step} exceeds 15% of ${event.amplitude}`);
    assert.ok(event.step <= 0.03 + 1e-9, 'the hold fine-tune stays inside idleMaxStep');
  }
  const holdEvent = events.find((event) => event.reason === 'hold');
  assert.ok(holdEvent, 'an event reports the hold reason');
  const maxDelta = maxStepOf(values);
  assert.ok(maxDelta <= 0.15 * 0.18 * 30 + 1e-9,
    `the hold changed by ≤15% of the amplitude (${maxDelta.toFixed(4)}°)`);
  console.log(
    `[floor-hold] events=${events.length} holds=${motion.postureHolds}`
    + ` switches=${motion.postureSwitches} step=${holdEvent.step.toFixed(4)}`
    + ` amplitude=${holdEvent.amplitude.toFixed(4)} reason=${holdEvent.reason}`
    + ` maxDelta=${maxDelta.toFixed(4)}`,
  );
  runtime.dispose();
});

// ---------------------------------------------------------------------------------------------
// P-54 remainder — breath output is verified-only
// ---------------------------------------------------------------------------------------------
test('27. 呼吸无已验证映射：只记 avatar.breath.skipped，不写任何呼吸参数', async () => {
  const fake = createFakeTransport();
  const logs = [];
  let clock = 0;
  const runtime = await connectRuntime({
    transport: fake.transport,
    now: () => clock,
    log: (message, data = {}) => logs.push({ message, ...data }),
    config: {
      autoTickMs: 0,
      flushIntervalMs: 1,
      idleParams: { headX: { inputName: 'FaceAngleX', ...HEAD_RANGE } },
    },
  });
  fake.writes.length = 0; // connect() probes are not idle frames
  runtime.takeEvents();

  for (clock = 0; clock <= 1200; clock += 40) {
    runtime.tick(clock);
    await flushMicrotasks();
  }

  const skipped = runtime.takeEvents().filter((entry) => entry.type === 'avatar.breath.skipped');
  assert.ok(skipped.length >= 1, 'the missing breath channel was reported');
  assert.equal(skipped[0].reason, 'no-verified-channel', 'the skip names the missing proof');
  const breathWrites = fake.writes.filter((entry) => /breath/i.test(entry.input));
  assert.deepEqual(breathWrites, [], 'no breath input was ever written');
  const snap = runtime.snapshot();
  assert.equal(snap.breath.mapped, false, 'no verified breath channel');
  assert.equal(snap.breath.writes, 0, 'zero breath writes');
  assert.ok(snap.breath.skipped >= 1, 'the skip counter is observable');
  assert.equal(logsOf(logs, 'avatar.breath.skipped').length >= 1, true,
    'the skip is also in the structured host log');
  console.log(
    `[breath] mapped=${snap.breath.mapped} writes=${snap.breath.writes}`
    + ` skipped=${snap.breath.skipped} reason=${skipped[0].reason}`
    + ` headWrites=${fake.writes.filter((entry) => entry.input === 'FaceAngleX').length}`,
  );
  runtime.dispose();
});

test('28. 呼吸已验证：呼吸值随帧写入，且不再记 skipped', async () => {
  const fake = createFakeTransport();
  let clock = 0;
  const runtime = await connectRuntime({
    transport: fake.transport,
    now: () => clock,
    config: {
      autoTickMs: 0,
      flushIntervalMs: 1,
      idleParams: {
        headX: { inputName: 'FaceAngleX', ...HEAD_RANGE },
        breath: { inputName: 'Breath', min: 0, max: 1 },
      },
    },
  });
  fake.writes.length = 0; // drop the accepted probe rows
  runtime.takeEvents();

  const samples = [];
  for (clock = 0; clock <= 4000; clock += 40) {
    runtime.tick(clock);
    await flushMicrotasks();
    for (const write of fake.writes.splice(0)) {
      if (write.input === 'Breath') samples.push(write.value);
    }
  }

  assert.ok(samples.length > 10, `the verified breath channel was written (${samples.length})`);
  for (const value of samples) {
    assert.ok(value >= 0 && value <= 1, `the breath value stays inside 0..1 (${value})`);
  }
  const spread = Math.max(...samples) - Math.min(...samples);
  assert.ok(spread > 0.05, `the breath really moved across the window (spread ${spread.toFixed(3)})`);
  const skipped = runtime.takeEvents().filter((entry) => entry.type === 'avatar.breath.skipped');
  assert.deepEqual(skipped, [], 'a verified channel never reports the skip');
  const snap = runtime.snapshot();
  assert.equal(snap.breath.mapped, true);
  assert.equal(snap.breath.input, 'Breath');
  assert.ok(snap.breath.writes > 0, `settled breath writes are counted (${snap.breath.writes})`);
  console.log(
    `[breath] mapped=${snap.breath.mapped} input=${snap.breath.input}`
    + ` writes=${samples.length} spread=${spread.toFixed(3)} skipped=0`,
  );
  runtime.dispose();
});

