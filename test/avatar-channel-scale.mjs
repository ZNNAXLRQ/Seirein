/**
 * Head-channel scale regression — the semantic → degrees → input conversion for HEAD angles.
 *
 * Run: `node --test test/avatar-channel-scale.mjs`
 *
 * A real-machine action trace showed `thinking` tilt `final.headZ ≈ 0.6957`, which became ≈62.6°
 * on the wire because FaceAngleZ's VTS range is ±90 while every head semantic value is expressed
 * with the "1 = 30°" convention. The writer used to spread the semantic value over the WHOLE range
 * (`0.6957 × 90`), so the roll was amplified 3× while the ±30 yaw/pitch axes were correct.
 *
 * The fix is a three-stage conversion, and these checks pin each stage:
 *   semantic (1 = 30°) → degrees (`× 30`) → input (that channel's own half-range)
 *
 * Checks:
 *   1. thinking tilt: final.headZ ≤ 14° and the write is degree-scale, not the 62° amplification;
 *   2. confused tilt: yaw stays in its 8–10° target band and the roll is on the same degree scale;
 *   3. idle sway: the roll amplitude falls back to ≤ 6°;
 *   4. nod: headY (pitch) is byte-identical and stays in 4–6°;
 *   5. gaze / brow / eye / mouth keep the unchanged normalized mapping;
 *   6. a missing/degenerate range falls back safely and never writes NaN / Infinity;
 *   7. the ±30 and ±90 declarations produce the SAME degrees — only the amplification disappears;
 *   8. a real-shaped discovery row (FaceAngleZ ±90) is what the runtime sees end to end.
 *
 * No timing/rhythm/style constant is asserted differently from the existing suites: this file only
 * measures where the value lands on the transport.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EXPRESSION_MOTION,
  HEAD_DEGREES_PER_POSE_UNIT,
  OCCASIONAL_ACTION,
  createAvatarRuntime,
  toHeadInputValue,
  toInputValue,
} from '../src/host/avatar/avatarRuntime.js';
import {
  discoverCapabilities,
  resetCapabilities,
} from '../src/host/avatar/avatarMotion.js';

const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

/** The 14° head ceiling in semantic units (the same conversion the writer uses). */
const HEAD_CAP = EXPRESSION_MOTION.MAX_HEAD_DEGREES / HEAD_DEGREES_PER_POSE_UNIT;
const degreesOf = (semantic) => semantic * HEAD_DEGREES_PER_POSE_UNIT;

/** Transport that records every single-write and every coalesced frame. */
function createFakeTransport() {
  const writes = [];
  const batches = [];
  return {
    writes,
    batches,
    transport: {
      connect: async () => {},
      disconnect: async () => {},
      write: async ({ input, value }) => {
        writes.push({ input, value });
        return { ok: true };
      },
      writeFrame: async (entries) => {
        batches.push(entries);
        writes.push(...entries.map((entry) => ({ input: entry.input, value: entry.value })));
        return { ok: true };
      },
    },
  };
}

const connectRuntime = async (options) => {
  const runtime = createAvatarRuntime(options);
  const result = await runtime.connect();
  assert.equal(result.ok, true, `runtime connects (${result.message ?? ''})`);
  return runtime;
};

/**
 * The REAL VTS ranges: FaceAngleX/Y are ±30, FaceAngleZ is ±90. Gaze/brow/eye/mouth are the
 * already-normalized channels the fix must not touch.
 */
const realConfig = (extra = {}) => ({
  autoTickMs: 0,
  flushIntervalMs: 1,
  idleActions: [],
  seed: 3,
  idleParams: {
    headX: { inputName: 'FaceAngleX', min: -30, max: 30 },
    headY: { inputName: 'FaceAngleY', min: -30, max: 30 },
    headZ: { inputName: 'FaceAngleZ', min: -90, max: 90 },
  },
  inputs: {
    gazeX: { inputName: 'EyeRightX', min: -1, max: 1, injectable: true },
    gazeY: { inputName: 'EyeRightY', min: -1, max: 1, injectable: true },
    browL: { inputName: 'ParamBrowLY', min: -1, max: 1, injectable: true },
    browR: { inputName: 'ParamBrowRY', min: -1, max: 1, injectable: true },
    eyeOpenL: { inputName: 'EyeOpenLeft', min: 0, max: 1, injectable: true },
    eyeOpenR: { inputName: 'EyeOpenRight', min: 0, max: 1, injectable: true },
    mouth: { inputName: 'MouthOpen', min: 0, max: 1, injectable: true },
  },
  channelMap: {
    gazeX: 'EyeRightX',
    gazeY: 'EyeRightY',
    browL: 'ParamBrowLY',
    browR: 'ParamBrowRY',
    eyeOpenL: 'EyeOpenLeft',
    eyeOpenR: 'EyeOpenRight',
    mouth: 'MouthOpen',
  },
  ...extra,
});

/** The SAME semantic motion declared with the old ±30 roll range (must now match ±90 exactly). */
const narrowRollConfig = (extra = {}) => realConfig({
  idleParams: {
    headX: { inputName: 'FaceAngleX', min: -30, max: 30 },
    headY: { inputName: 'FaceAngleY', min: -30, max: 30 },
    headZ: { inputName: 'FaceAngleZ', min: -30, max: 30 },
  },
  ...extra,
});

/**
 * Run ONE shot to completion. `event` goes through the communication table; `intent` calls the
 * one-shot API directly (surprise is not a communication event). Returns the trace + raw writes.
 */
async function runShot({ event = null, intent = null, profile = null, config = {}, before = null, runMs = 4200 }) {
  const fake = createFakeTransport();
  let clock = 0;
  const runtime = await connectRuntime({
    transport: fake.transport,
    now: () => clock,
    config: realConfig(config),
  });
  if (before !== null) await before(runtime, fake);
  runtime.takeEvents();
  fake.writes.length = 0;
  fake.batches.length = 0;
  for (clock = 0; clock <= 200; clock += 20) {
    runtime.tick(clock);
    await flushMicrotasks();
  }
  clock = 300;
  const reported = event !== null
    ? runtime.intentEvent(event, { at: clock })
    : runtime.intent(intent, { at: clock, profile });
  const posePeak = { headX: 0, headY: 0, headZ: 0 };
  for (clock = 300; clock <= 300 + runMs; clock += 20) {
    const pose = runtime.tick(clock);
    for (const channel of Object.keys(posePeak)) {
      posePeak[channel] = Math.max(posePeak[channel], Math.abs(pose[channel]));
    }
    await flushMicrotasks();
  }
  const events = runtime.takeEvents();
  const trace = events
    .filter((entry) => entry.type === 'avatar.action.trace' && entry.channels.length > 0)
    .at(-1);
  const start = events.filter((entry) => entry.type === 'avatar.intent.start').at(-1);
  const result = { reported, trace, start, posePeak, writes: fake.writes, snapshot: runtime.snapshot() };
  runtime.dispose();
  return result;
}

/** Every transport value written for one input name. */
const valuesFor = (writes, input) => writes
  .filter((entry) => entry.input === input && Number.isFinite(entry.value))
  .map((entry) => entry.value);

/** The largest-|value| write (the trace `final` is the reached extreme, not the settling tail). */
const peakWrite = (writes, input) => {
  let peak = null;
  for (const value of valuesFor(writes, input)) {
    if (peak === null || Math.abs(value) > Math.abs(peak)) peak = value;
  }
  return peak;
};

const traceFor = (result) => {
  assert.ok(result.trace, 'the gesture emitted an action trace');
  return result.trace;
};

// ---------------------------------------------------------------------------------------------
// 1. thinking tilt — the real-machine 62.6° case
// ---------------------------------------------------------------------------------------------
test('1. thinking tilt：headZ 语义→角度→输入 ≤14°，不再是 62° 量级', async () => {
  assert.equal(HEAD_DEGREES_PER_POSE_UNIT, OCCASIONAL_ACTION.DEGREES_PER_POSE_UNIT,
    'the writer and the motion controller share the 30°/unit head convention');
  // A lively, long-nod persona: the UNCAPPED intent reports 16.9°, so the 14° semantic cap must bind.
  const lively = { amplitude: 1.5, tempo: 1, nodAmplitude: 1.5, expressiveness: 1.5, nodDurationMs: 1200 };
  const result = await runShot({ event: 'thinking', config: { style: lively } });
  const trace = traceFor(result);
  assert.equal(result.reported.ok, true, 'thinking released its tilt');
  assert.equal(result.reported.intent, 'tilt', 'thinking still selects the tilt');

  const semantic = trace.final.headZ;
  const declared = degreesOf(semantic);
  const wire = peakWrite(result.writes, 'FaceAngleZ');
  assert.ok(Number.isFinite(wire), 'FaceAngleZ was written');

  // 1) the semantic layer is capped at 14°, never left to the input layer.
  assert.ok(Math.abs(semantic) <= HEAD_CAP + 1e-9,
    `final.headZ ${semantic.toFixed(4)} ≤ ${HEAD_CAP.toFixed(4)} (${EXPRESSION_MOTION.MAX_HEAD_DEGREES}°)`);
  assert.ok(result.start.peakDegrees > EXPRESSION_MOTION.MAX_HEAD_DEGREES,
    `the uncapped intent target ${result.start.peakDegrees}° shows the cap really bound`);
  assert.ok(result.posePeak.headZ <= HEAD_CAP + 1e-9,
    `the posed headZ ${degreesOf(result.posePeak.headZ).toFixed(2)}° is capped at 14°`);
  // 2) the write is the DEGREE value, not semantic × 90 (the old 62.6° amplification).
  assert.ok(Math.abs(wire) <= EXPRESSION_MOTION.MAX_HEAD_DEGREES + 1e-6,
    `FaceAngleZ wrote ${wire.toFixed(3)}° ≤ 14°`);
  assert.ok(Math.abs(wire - declared) <= 0.75,
    `wire ${wire.toFixed(3)}° ≈ degrees ${declared.toFixed(3)}° (sampled frames may differ)`);
  // 3) it can no longer be the 62°-class value the trace showed.
  assert.ok(Math.abs(wire) < 20, `the roll is no longer 62°-scale (${wire.toFixed(2)}°)`);
  // 4) the intent still reached a visible roll (not silently zeroed).
  assert.ok(Math.abs(semantic) > 0.2, `the capped roll is still visible (${declared.toFixed(2)}°)`);

  console.log(
    `[headZ] thinking semantic=${semantic.toFixed(4)} → degrees=${declared.toFixed(2)}°`
    + ` → FaceAngleZ=${wire.toFixed(2)}° (old would be ${(semantic * 90).toFixed(2)}°)`
    + ` cap=${EXPRESSION_MOTION.MAX_HEAD_DEGREES}° target=${result.start.peakDegrees}°`
    + ` posePeak=${degreesOf(result.posePeak.headZ).toFixed(2)}°`,
  );
});

// ---------------------------------------------------------------------------------------------
// 2. confused tilt — the yaw target stays 8–10°, the roll shares the degree scale
// ---------------------------------------------------------------------------------------------
test('2. confused 歪头：headX 目标 8–10°，headZ 与 headX 同一角度刻度', async () => {
  const quiet = { amplitude: 0.2, tempo: 0.9, nodAmplitude: 0.2, expressiveness: 0.3, nodDurationMs: 500 };
  const result = await runShot({ event: 'confused', config: { style: quiet, idleSwayScale: 0 } });
  const trace = traceFor(result);
  assert.equal(result.reported.profile, 'confused', 'the confused profile is carried');

  const yaw = degreesOf(trace.final.headX);
  const rollSemantic = trace.final.headZ ?? 0;
  const roll = degreesOf(rollSemantic);
  const rollWire = peakWrite(result.writes, 'FaceAngleZ');
  const yawWire = peakWrite(result.writes, 'FaceAngleX');

  // The documented confused target is the YAW band 8–10°; the fix must not disturb it.
  assert.ok(yaw >= 8 && yaw <= 10, `confused headX ${yaw.toFixed(2)}° is in the 8–10° band`);
  assert.ok(Math.abs(yawWire) >= 8 && Math.abs(yawWire) <= 10,
    `the yaw WRITE itself is ${Math.abs(yawWire).toFixed(2)}°`);
  // The roll is now converted on the SAME 30°/unit scale (before the fix it was ×90).
  assert.ok(Math.abs(rollWire) <= EXPRESSION_MOTION.MAX_HEAD_DEGREES + 1e-6,
    `confused roll ${Math.abs(rollWire).toFixed(2)}° stays inside the 14° ceiling`);
  assert.ok(Math.abs(rollWire - roll) <= 0.75,
    `confused roll wire ${Math.abs(rollWire).toFixed(2)}° ≈ semantic degrees ${roll.toFixed(2)}°`);
  // Composed head deviation: yaw + roll on the same degree scale, bounded by the C ceiling.
  const composed = Math.hypot(yaw, rollWire);
  assert.ok(composed >= 8 && composed <= 16,
    `composed head angle ${composed.toFixed(2)}° ≈ the 8–10° target plus the bounded roll (≤14°)`);
  // And it is NOT the old 62°-class amplification of the same semantic roll.
  assert.ok(Math.abs(rollWire) <= Math.abs(rollSemantic * 90) / 2,
    'the roll can no longer be 3× amplified by the declared range');

  const browPeak = Math.max(Math.abs(trace.final.browL ?? 0), Math.abs(trace.final.browR ?? 0));
  console.log(
    `[headZ] confused headX=${yaw.toFixed(2)}° (wire ${Math.abs(yawWire).toFixed(2)}°)`
    + ` roll=${roll.toFixed(2)}° (wire ${Math.abs(rollWire).toFixed(2)}°; old on ±90`
    + ` ${(Math.abs(rollSemantic) * 90).toFixed(2)}°) composed=${composed.toFixed(2)}° brow=${browPeak.toFixed(2)}`,
  );
});

// ---------------------------------------------------------------------------------------------
// 3. idle sway — the roll amplitude falls back with the range
// ---------------------------------------------------------------------------------------------
async function runIdleRoll(extra = {}) {
  const fake = createFakeTransport();
  let clock = 0;
  const runtime = await connectRuntime({
    transport: fake.transport,
    now: () => clock,
    config: realConfig(extra),
  });
  runtime.takeEvents();
  fake.writes.length = 0;
  let posePeak = 0;
  for (clock = 0; clock <= 20_000; clock += 50) {
    const pose = runtime.tick(clock);
    posePeak = Math.max(posePeak, Math.abs(pose.headZ));
    await flushMicrotasks();
  }
  const roll = valuesFor(fake.writes, 'FaceAngleZ');
  runtime.dispose();
  return {
    samples: roll.length,
    peakDegrees: roll.length > 0 ? Math.max(...roll.map(Math.abs)) : 0,
    posePeakDegrees: degreesOf(posePeak),
  };
}

test('3. 待机 sway：headZ 幅度回落到 ≤5–6°（而不是原来的 3×）', async () => {
  const idle = await runIdleRoll();
  assert.ok(idle.samples > 20, `idle headZ was written continuously (${idle.samples} frames)`);
  assert.ok(idle.peakDegrees > 0.5, `the idle roll still moves (${idle.peakDegrees.toFixed(2)}°)`);
  assert.ok(idle.peakDegrees <= 6,
    `idle roll peak ${idle.peakDegrees.toFixed(2)}° ≤ 6° (the old ±90 mapping gave 3×)`);
  assert.ok(idle.posePeakDegrees <= 6,
    `idle pose peak ${idle.posePeakDegrees.toFixed(2)}° ≤ 6°`);

  // Re-declaring the SAME roll channel as ±30 must not change the degree value anymore.
  const narrow = await runIdleRoll({
    idleParams: {
      headX: { inputName: 'FaceAngleX', min: -30, max: 30 },
      headY: { inputName: 'FaceAngleY', min: -30, max: 30 },
      headZ: { inputName: 'FaceAngleZ', min: -30, max: 30 },
    },
  });
  assert.ok(Math.abs(narrow.peakDegrees - idle.peakDegrees) <= 1e-6,
    `the ±30 and ±90 declarations now produce the same degrees (${narrow.peakDegrees.toFixed(3)}`
    + ` vs ${idle.peakDegrees.toFixed(3)})`);
  console.log(
    `[headZ] idle peak=${idle.peakDegrees.toFixed(2)}° (±90) / ${narrow.peakDegrees.toFixed(2)}° (±30)`
    + ` samples=${idle.samples}`,
  );
});

// ---------------------------------------------------------------------------------------------
// 4. nod — headY pitch is untouched and keeps its 4–6° band
// ---------------------------------------------------------------------------------------------
test('4. 点头 headY：4–6° 不变，且 ±30/±90 的 headZ 声明不影响 pitch', async () => {
  const quiet = { amplitude: 0.2, tempo: 0.9, nodAmplitude: 0.2, expressiveness: 0.3, nodDurationMs: 500 };
  const modern = await runShot({ event: 'answer-start', config: { style: quiet, idleSwayScale: 0 } });
  const legacy = await runShot({
    event: 'answer-start',
    config: narrowRollConfig({ style: quiet, idleSwayScale: 0 }),
  });

  const modernTrace = traceFor(modern);
  const legacyTrace = traceFor(legacy);
  const pitch = degreesOf(modernTrace.final.headY);
  // The documented answer-start band is 4–6°; the visible floor lands on its lower edge, so the
  // assertion keeps a sampling tolerance of one hundredth of a degree.
  assert.ok(pitch >= 3.9 && pitch <= 6,
    `answer-start headY ${pitch.toFixed(3)}° is in 4–6° (sampling tolerance)`);
  const wire = peakWrite(modern.writes, 'FaceAngleY');
  assert.ok(Math.abs(wire - pitch) <= 0.75,
    `FaceAngleY wrote ${wire.toFixed(2)}° ≈ headY ${pitch.toFixed(2)}°`);
  // The pitch channel is byte-identical no matter how the ROLL channel's range is declared.
  assert.equal(modernTrace.final.headY, legacyTrace.final.headY,
    'headY is unchanged by the headZ range declaration');
  assert.equal(modern.start.durationMs, legacy.start.durationMs,
    'the nod duration is unchanged');
  console.log(
    `[headZ] nod headY=${pitch.toFixed(2)}° wire=${wire.toFixed(2)}°`
    + ` duration=${modern.start.durationMs}ms (±90) / ${legacy.start.durationMs}ms (±30)`,
  );
});

// ---------------------------------------------------------------------------------------------
// 5. gaze / brow / eye / mouth — non-angle mappings stay exactly as before
// ---------------------------------------------------------------------------------------------
test('5. gaze/brow/eye/mouth 映射不变（回归）', async () => {
  // gaze: a verified target is a ±1 channel, so the written value IS the semantic value.
  const glance = await runShot({
    event: 'turn-start',
    config: { idleSwayScale: 0 },
    before: (runtime) => runtime.setAttention({ x: 0.4, y: -0.2 }, { verified: true, source: 'test' }),
  });
  const gazeTrace = traceFor(glance);
  assert.ok(Math.abs(gazeTrace.final.gazeX) > 0.2, 'the look-at-user gesture reached gazeX');
  const gazeWrites = valuesFor(glance.writes, 'EyeRightX');
  const expectedGaze = toInputValue({ min: -1, max: 1 }, gazeTrace.final.gazeX, { bidirectional: true });
  assert.ok(gazeWrites.some((value) => Math.abs(value - expectedGaze) <= 0.02),
    `gazeX wire (${expectedGaze.toFixed(3)}) still uses the normalized mapping`);
  assert.ok(gazeWrites.every((value) => Math.abs(value) <= 1), 'gaze stays inside its ±1 range');

  // brow: the confused profile writes both brows with the unchanged bipolar mapping.
  const confused = await runShot({
    event: 'confused',
    config: { style: { amplitude: 0.2, tempo: 0.9, nodAmplitude: 0.2, expressiveness: 0.3 }, idleSwayScale: 0 },
  });
  const confusedTrace = traceFor(confused);
  const browWrites = valuesFor(confused.writes, 'ParamBrowLY');
  assert.ok(browWrites.length > 0, 'the confused gesture wrote browL');
  const browSemantic = confusedTrace.final.browL;
  const expectedBrow = toInputValue({ min: -1, max: 1 }, browSemantic, { bidirectional: true });
  assert.ok(browWrites.some((value) => Math.abs(value - expectedBrow) <= 0.02),
    `browL wire (${expectedBrow.toFixed(3)}) still uses toInputValue(${browSemantic.toFixed(3)})`);

  // eye: surprise forces the eye open; the unipolar 0..1 mapping still lands on 1.
  const surprise = await runShot({ intent: 'surprise', config: { idleSwayScale: 0 } });
  const eyeWrites = valuesFor(surprise.writes, 'EyeOpenLeft');
  assert.ok(eyeWrites.length > 0, 'surprise wrote the eye channel');
  assert.ok(eyeWrites.every((value) => value >= 0 && value <= 1), 'the eye stays inside 0..1');
  assert.equal(Math.max(...eyeWrites), 1, 'a wide-open eye is still exactly 1');

  // mouth: a live lip-sync level is written raw (0..1), never angle-normalized.
  const fake = createFakeTransport();
  let clock = 0;
  const runtime = await connectRuntime({
    transport: fake.transport,
    now: () => clock,
    config: realConfig({ idleSwayScale: 0 }),
  });
  fake.writes.length = 0;
  const spoken = await runtime.writeMouth(0.42, { owner: 'test' });
  assert.equal(spoken.ok, true, 'the mouth session accepted the level');
  const mouthWire = valuesFor(fake.writes, 'MouthOpen').at(-1);
  assert.equal(mouthWire, 0.42, 'mouth still writes the raw 0..1 level');
  runtime.dispose();

  console.log(
    `[headZ] unchanged gazeX=${expectedGaze.toFixed(3)} browL=${browSemantic.toFixed(3)}`
    + ` eye max=${Math.max(...eyeWrites)} mouth=${mouthWire}`,
  );
});

// ---------------------------------------------------------------------------------------------
// 6. missing / degenerate range — safe fallback, no NaN or Infinity on the wire
// ---------------------------------------------------------------------------------------------
test('6. 量程缺失/异常（max<=min）时安全回退，不写坏值', async () => {
  // Unit level: no usable range → the documented toInputValue fallback, never NaN/Infinity.
  for (const entry of [
    { inputName: 'FaceAngleZ' },
    { inputName: 'FaceAngleZ', min: 90, max: -90 },
    { inputName: 'FaceAngleZ', min: 0, max: 0 },
  ]) {
    const fallback = toInputValue(entry, 0.6, { bidirectional: true });
    const value = toHeadInputValue(entry, 0.6);
    assert.equal(value, fallback, `degenerate ${JSON.stringify(entry)} falls back to toInputValue`);
    assert.ok(Number.isFinite(value), 'the fallback is a finite number');
  }
  // A NaN semantic value must not poison the input either.
  assert.ok(Number.isFinite(toHeadInputValue({ min: -90, max: 90 }, Number.NaN)));

  // Runtime level: an inverted range with a neutral default keeps writing that neutral value.
  const fake = createFakeTransport();
  let clock = 0;
  const runtime = await connectRuntime({
    transport: fake.transport,
    now: () => clock,
    config: realConfig({
      idleParams: {
        headX: { inputName: 'FaceAngleX', min: -30, max: 30 },
        headY: { inputName: 'FaceAngleY', min: -30, max: 30 },
        // Inverted range: the writer must NOT compute a negative span / NaN value.
        headZ: { inputName: 'FaceAngleZ', min: 90, max: -90, defaultValue: 0 },
      },
    }),
  });
  fake.writes.length = 0;
  for (clock = 0; clock <= 4000; clock += 50) {
    runtime.tick(clock);
    await flushMicrotasks();
  }
  const roll = valuesFor(fake.writes, 'FaceAngleZ');
  assert.ok(roll.length > 0, 'the degenerate headZ channel was still processed');
  assert.ok(roll.every((value) => Number.isFinite(value)), 'no NaN/Infinity reached the transport');
  assert.ok(roll.every((value) => value === 0), 'the neutral default (0) is what gets written');
  runtime.dispose();
  console.log(`[headZ] degenerate range writes=${[...new Set(roll)].join(',')} count=${roll.length}`);
});

// ---------------------------------------------------------------------------------------------
// 7. the ±30 and ±90 declarations now describe the SAME motion (only the amplification is gone)
// ---------------------------------------------------------------------------------------------
test('7. ±30 与 ±90 声明产生相同角度：只有放大消失，动作本身不变', async () => {
  const lively = { amplitude: 1.2, tempo: 1.1, nodAmplitude: 1.1, expressiveness: 1.2 };
  const wide = await runShot({ event: 'thinking', config: { style: lively } });
  const narrow = await runShot({ event: 'thinking', config: narrowRollConfig({ style: lively }) });
  const wideTrace = traceFor(wide);
  const narrowTrace = traceFor(narrow);
  assert.equal(wideTrace.final.headZ, narrowTrace.final.headZ,
    'the semantic roll is identical under both range declarations');
  assert.equal(wide.start.durationMs, narrow.start.durationMs,
    'the gesture duration is identical under both range declarations');
  assert.equal(wideTrace.final.headX, narrowTrace.final.headX,
    'the yaw is identical under both range declarations');

  // The wire value tracks the semantic degrees, not the declared range.
  const wideWire = Math.abs(peakWrite(wide.writes, 'FaceAngleZ'));
  const narrowWire = Math.abs(peakWrite(narrow.writes, 'FaceAngleZ'));
  assert.ok(Math.abs(wideWire - narrowWire) <= 1e-9,
    `wire degrees are range-independent (${wideWire.toFixed(3)} vs ${narrowWire.toFixed(3)})`);
  console.log(
    `[headZ] range-independence headZ=${wideTrace.final.headZ.toFixed(4)}`
    + ` wire ±90=${wideWire.toFixed(3)}° / ±30=${narrowWire.toFixed(3)}°`
    + ` duration=${wide.start.durationMs}ms`,
  );
});

// ---------------------------------------------------------------------------------------------
// 8. discovery-shaped end-to-end: the runtime consumes the real VTS FaceAngleZ row (±90)
// ---------------------------------------------------------------------------------------------
test('8. 真实 FaceAngleZ（±90）发现行：映射后仍按 30°/单位书写', async () => {
  resetCapabilities();
  const discovery = await discoverCapabilities({
    identity: { modelId: 'channel-scale-model', modelGeneration: 1, connectionGeneration: 1 },
    force: true,
    listInputParameters: async () => ({
      defaultParameters: [
        { name: 'FaceAngleX', min: -30, max: 30, defaultValue: 0 },
        { name: 'FaceAngleY', min: -30, max: 30, defaultValue: 0 },
        { name: 'FaceAngleZ', min: -90, max: 90, defaultValue: 0 },
      ],
      customParameters: [],
    }),
    listModelParameters: async () => ({
      ok: true,
      source: 'test',
      parameters: ['ParamAngleX', 'ParamAngleY', 'ParamAngleZ'].map((name) => ({ name })),
    }),
  });
  const headZ = discovery.channels.find((entry) => entry.channel === 'headZ');
  assert.equal(headZ.min, -90);
  assert.equal(headZ.max, 90);
  assert.equal(headZ.verified, true);
  // A 20.87° semantic request (the real trace's 0.6957) now maps to 20.87 on the wire, not 62.6.
  assert.ok(Math.abs(toHeadInputValue(headZ, 0.6957) - 20.871) < 1e-6);

  const fake = createFakeTransport();
  let clock = 0;
  const runtime = await connectRuntime({
    transport: fake.transport,
    now: () => clock,
    config: { autoTickMs: 0, flushIntervalMs: 1, idleActions: [], idleSwayScale: 0 },
  });
  await runtime.setChannelMappings(discovery.channels, { channelMap: {} });
  fake.writes.length = 0;
  const started = runtime.intent('tilt', { at: 300 });
  assert.equal(started.ok, true, 'the tilt started on the discovered channels');
  for (clock = 300; clock <= 2000; clock += 20) {
    runtime.tick(clock);
    await flushMicrotasks();
  }
  const roll = valuesFor(fake.writes, 'FaceAngleZ');
  assert.ok(roll.length > 0, 'the discovered headZ channel was written');
  const peak = Math.max(...roll.map(Math.abs));
  assert.ok(peak <= OCCASIONAL_ACTION.MAX_DEGREES + 1e-6,
    `discovered roll writes stay ≤14° (${peak.toFixed(2)}°)`);
  runtime.dispose();
  console.log(
    `[headZ] discovery ±90 → tilt wire max=${peak.toFixed(2)}°`
    + ` (semantic 0.6957 maps to ${toHeadInputValue(headZ, 0.6957).toFixed(3)}°, old 62.6°)`,
  );
});
