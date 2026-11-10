/**
 * Phase 4 — generic body / shoulder / arm / hand capability, tested against SIMULATED models.
 *
 * Run: node --test test/motion-body-arms.mjs
 *
 * What this suite proves (and what it deliberately does not):
 *   1. a FULL mapping gets continuous base micro-motion, three independent component holds and
 *      successful wave / spread / shrug expressions;
 *   2. a PARTIAL mapping executes only the verified limbs; a wave/spread without any arm and a
 *      shrug without any shoulder is reported `unsupported` instead of being faked with the head;
 *   3. asymmetric input ranges keep their own centre and direction, and the semantic value is
 *      clamped to the channel budget and the per-frame step;
 *   4. a model switch / disconnect invalidates the old gate and the old output generation: no
 *      stale arm input is written after the new model is mapped;
 *   5. body/arm rows travel through the SAME single writer (one frame, one row per input) and the
 *      frame values agree with the pose that produced them;
 *   6. the legacy nod still writes headY while the body base layer keeps running.
 *
 * It does NOT prove the visual result on a real VTS model: the channel/input mapping is simulated
 * and the real arm direction (which sign raises which arm) stays TRUE-MACHINE UNVERIFIED.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BODY_ARM_CHANNELS,
  BODY_ARM_CHANNEL_LIMITS,
  BODY_ARM_COMPONENT_MAX_MS,
  BODY_ARM_COMPONENT_MIN_MS,
  BODY_ARM_MAX_STEP,
  createAvatarRuntime,
} from '../src/host/avatar/avatarRuntime.js';
import {
  COMPONENT_SELECTION_WEIGHT_FLOOR,
} from '../src/host/avatar/motion-controller.js';

const DT = 1000 / 30;
const flush = () => new Promise((resolve) => setImmediate(resolve));

function createFakeTransport() {
  const frames = [];
  const writes = [];
  let clock = 0;
  const transport = {
    connect: async () => {},
    disconnect: async () => {},
    write: async (payload) => {
      writes.push({ ...payload });
      return { ok: true };
    },
    writeFrame: async (entries) => {
      frames.push({ at: clock, entries: entries.map((entry) => ({ ...entry })) });
      return { ok: true };
    },
  };
  return {
    frames,
    writes,
    transport,
    setClock(at) { clock = at; },
  };
}

const ROW_DEFS = Object.freeze({
  headX: { min: -30, max: 30 },
  headY: { min: -30, max: 30 },
  headZ: { min: -90, max: 90 },
  bodyX: { min: -30, max: 30 },
  bodyY: { min: -30, max: 30 },
  bodyZ: { min: -30, max: 30 },
  shoulderL: { min: -1, max: 1 },
  shoulderR: { min: -1, max: 1 },
  armL: { min: -1, max: 1 },
  armR: { min: -1, max: 1 },
  handL: { min: -1, max: 1 },
  handR: { min: -1, max: 1 },
});

function rowsFor(channels, overrides = {}) {
  return channels.map((channel) => ({
    channel,
    inputName: `P_${channel}`,
    min: ROW_DEFS[channel]?.min ?? -1,
    max: ROW_DEFS[channel]?.max ?? 1,
    injectable: true,
    verified: true,
    ...(overrides[channel] ?? {}),
  }));
}

async function makeRuntime({ channels = [], overrides = {}, config = {} } = {}) {
  const fake = createFakeTransport();
  let clock = 0;
  const runtime = createAvatarRuntime({
    transport: fake.transport,
    now: () => clock,
    config: {
      autoTickMs: 0,
      flushIntervalMs: 1,
      idleActions: [],
      motionWrites: true,
      motionOutputHz: 30,
      seed: 7,
      ...config,
    },
  });
  const connected = await runtime.connect();
  assert.equal(connected.ok, true, `runtime connects (${connected.message ?? ''})`);
  const mapped = await runtime.setChannelMappings(rowsFor(channels, overrides), { channelMap: {} });
  assert.equal(mapped.ok, true, 'channel mappings apply');
  return {
    runtime,
    fake,
    async tick(at) {
      clock = at;
      fake.setClock(at);
      const pose = runtime.tick(at);
      await flush();
      return pose;
    },
    async remap(nextChannels, nextOverrides = {}) {
      const result = await runtime.setChannelMappings(
        rowsFor(nextChannels, nextOverrides),
        { channelMap: {} },
      );
      assert.equal(result.ok, true, 'channel mappings re-apply');
      return result;
    },
  };
}

const frameRows = (frames, channel) => frames
  .flatMap((frame) => frame.entries.map((entry) => ({ ...entry, at: frame.at })))
  .filter((entry) => entry.channel === channel);

const hasRow = (frames, channel) => frameRows(frames, channel).length > 0;

const distinct = (values) => new Set(values.map((value) => value.toFixed(6))).size;

// ---------------------------------------------------------------------------------------------
// 1. full mapping: base + three independent components + expressions
// ---------------------------------------------------------------------------------------------
test('1. 完整映射：base body/arms 微动、三组组件独立保持、wave/spread/shrug 成功', async (t) => {
  const all = [
    'headX', 'headY', 'headZ',
    ...BODY_ARM_CHANNELS,
  ];
  const rig = await makeRuntime({ channels: all });
  t.after(() => rig.runtime.dispose());

  const baseSamples = Object.fromEntries(BODY_ARM_CHANNELS.map((channel) => [channel, []]));
  let sawAllComponents = false;
  for (let at = 0; at <= 4_000; at += DT) {
    await rig.tick(at);
    const snapshot = rig.runtime.snapshot();
    const components = snapshot.motion.posture.bodyArms.components;
    if (components.body !== null && components.shoulder !== null && components.arm !== null) {
      sawAllComponents = true;
      for (const category of ['body', 'shoulder', 'arm']) {
        const component = components[category];
        assert.ok(component.channels.length > 0, `${category} component has verified channels`);
        for (const channel of component.channels) {
          assert.ok(BODY_ARM_CHANNELS.includes(channel), `${category} only claims body/arm channels`);
          assert.ok(Math.abs(component.semantic[channel])
            <= (BODY_ARM_CHANNEL_LIMITS[channel] ?? 1) + 1e-9, `${channel} stays inside its limit`);
        }
      }
    }
    for (const channel of BODY_ARM_CHANNELS) baseSamples[channel].push(snapshot.motion.posture.bodyArms.base[channel]);
  }
  assert.equal(sawAllComponents, true, 'body, shoulder and arm components were all drawn');

  for (const channel of ['bodyY', 'bodyZ', 'shoulderL', 'armL', 'handL']) {
    assert.ok(hasRow(rig.fake.frames, channel), `${channel} has a continuous base row`);
    assert.ok(distinct(baseSamples[channel]) > 10, `${channel} base activity keeps changing`);
    assert.ok(Math.max(...baseSamples[channel]) - Math.min(...baseSamples[channel]) > 1e-6,
      `${channel} base activity is not frozen`);
  }
  // bodyX is the existing posture base: it stays continuous too.
  assert.ok(hasRow(rig.fake.frames, 'bodyX'), 'verified bodyX keeps its base row');

  // Wave: only the chosen side rises; the other arm may stay near its base.
  const beforeWave = frameRows(rig.fake.frames, 'armR').map((entry) => Math.abs(entry.value));
  const wave = rig.runtime.intent('wave', { at: 4_000 });
  assert.equal(wave.ok, true, 'wave starts on a full mapping');
  assert.equal(wave.supported, true);
  assert.equal(wave.partial, false);
  assert.ok(wave.channels.includes('armL') || wave.channels.includes('armR'));
  for (let at = 4_000; at <= 5_100; at += DT) await rig.tick(at);
  const duringWave = frameRows(rig.fake.frames, 'armR').map((entry) => Math.abs(entry.value));
  assert.ok(Math.max(...duringWave) > Math.max(...beforeWave) + 0.05,
    'the wave raises an arm clearly above the base micro-motion');

  // Spread: both arms open, hands follow.
  const spread = rig.runtime.intent('spread', { at: 5_200 });
  assert.equal(spread.ok, true);
  assert.equal(spread.partial, false);
  const armStart = rig.fake.frames.length;
  for (let at = 5_200; at <= 6_100; at += DT) await rig.tick(at);
  const spreadFrames = rig.fake.frames.slice(armStart);
  for (const channel of ['armL', 'armR']) {
    assert.ok(hasRow(spreadFrames, channel), `${channel} is written by spread`);
    assert.ok(Math.max(...frameRows(spreadFrames, channel).map((entry) => Math.abs(entry.value))) > 0.1,
      `${channel} visibly opens in spread`);
  }

  // Shrug: the shoulders are the core.
  const shrug = rig.runtime.intent('shrug', { at: 6_300 });
  assert.equal(shrug.ok, true);
  assert.ok(shrug.channels.includes('shoulderL') || shrug.channels.includes('shoulderR'));
  for (let at = 6_300; at <= 7_100; at += DT) await rig.tick(at);
  const shoulderPeak = Math.max(
    ...frameRows(rig.fake.frames, 'shoulderL').map((entry) => Math.abs(entry.value)),
    ...frameRows(rig.fake.frames, 'shoulderR').map((entry) => Math.abs(entry.value)),
  );
  assert.ok(shoulderPeak > 0.1, 'the shrug really moves a shoulder');

  const snapshot = rig.runtime.snapshot();
  assert.deepEqual(snapshot.motion.posture.bodyArms.verified.sort(), [...BODY_ARM_CHANNELS].sort(),
    'every verified body/arm channel is open');
  assert.equal(snapshot.channels.bodyArms.writeChannels.length, BODY_ARM_CHANNELS.length);
  assert.equal(snapshot.motion.posture.bodyArms.unsupported, 0,
    'no false unsupported report on a complete mapping');
});

// ---------------------------------------------------------------------------------------------
// 2. partial mapping: usable limbs run, missing core is unsupported (never a head substitute)
// ---------------------------------------------------------------------------------------------
test('2. 部分映射：缺手臂时 wave/spread unsupported，其他部位继续；单手/单肩仍执行并标 partial', async (t) => {
  const partial = await makeRuntime({
    channels: ['headX', 'headY', 'headZ', 'bodyZ', 'shoulderL', 'armL'],
  });
  t.after(() => partial.runtime.dispose());

  const wave = partial.runtime.intent('wave', { at: 0 });
  assert.equal(wave.ok, true, 'one arm is enough to wave');
  assert.deepEqual(wave.channels.sort(), ['armL', 'shoulderL'], 'only the mapped side participates');
  assert.equal(wave.partial, true, 'a missing side is reported, not claimed as full');
  assert.ok(wave.missingChannels.includes('armR'));

  const spread = partial.runtime.intent('spread', { at: 900 });
  assert.equal(spread.ok, true);
  assert.equal(spread.partial, true);

  const shrug = partial.runtime.intent('shrug', { at: 1_800 });
  assert.equal(shrug.ok, true);
  assert.deepEqual([...shrug.channels].sort(), ['armL', 'shoulderL'],
    'the mapped shoulder and its mapped arm companion participate');
  assert.equal(shrug.partial, true);

  for (let at = 0; at <= 2_800; at += DT) await partial.tick(at);
  assert.ok(hasRow(partial.fake.frames, 'armL'), 'the usable arm is really written');
  assert.equal(hasRow(partial.fake.frames, 'armR'), false, 'the missing arm is never guessed');

  // A model with NO arm and NO shoulder: both body expressions are unsupported.
  const noLimbs = await makeRuntime({ channels: ['headX', 'headY', 'headZ', 'bodyX', 'bodyY', 'bodyZ'] });
  t.after(() => noLimbs.runtime.dispose());
  const refusedWave = noLimbs.runtime.intent('wave', { at: 0 });
  assert.equal(refusedWave.ok, false, 'a wave without an arm is refused');
  assert.equal(refusedWave.reason, 'unsupported');
  assert.equal(refusedWave.supported, false);
  assert.ok(refusedWave.missingChannels.includes('armL'));
  const refusedSpread = noLimbs.runtime.intent('spread', { at: 10 });
  assert.equal(refusedSpread.reason, 'unsupported');
  const refusedShrug = noLimbs.runtime.intent('shrug', { at: 20 });
  assert.equal(refusedShrug.reason, 'unsupported');

  for (let at = 0; at <= 1_500; at += DT) await noLimbs.tick(at);
  const snapshot = noLimbs.runtime.snapshot();
  assert.ok(snapshot.intents.unsupported >= 3, 'every refusal is counted');
  assert.equal(snapshot.intents.lastUnsupported.kind, 'shrug');
  assert.deepEqual(snapshot.intents.lastUnsupported.missingChannels.sort(), ['shoulderL', 'shoulderR']);
  assert.equal(snapshot.intents.active.some((item) => ['wave', 'spread', 'shrug'].includes(item.kind)), false,
    'no unsupported action was started');
  assert.equal(hasRow(noLimbs.fake.frames, 'armL'), false);
  assert.equal(hasRow(noLimbs.fake.frames, 'shoulderL'), false);
  // Other layers keep running: the head and the verified body base are still written.
  for (const channel of ['headY', 'bodyX', 'bodyY']) {
    assert.ok(hasRow(noLimbs.fake.frames, channel), `${channel} continues while arms are unsupported`);
  }
});

// ---------------------------------------------------------------------------------------------
// 3. asymmetric ranges: centre/direction, clamp, per-frame step
// ---------------------------------------------------------------------------------------------
test('3. 方向/范围：非对称 min-max 保持符号与中心，语义 clamp 与每帧步长有效', async (t) => {
  const ranges = {
    armL: { min: -20, max: 5 },
    armR: { min: -5, max: 15 },
    bodyZ: { min: -10, max: 10 },
  };
  const rig = await makeRuntime({
    channels: ['bodyZ', 'shoulderL', 'shoulderR', 'armL', 'armR', 'handL', 'handR'],
    overrides: ranges,
  });
  t.after(() => rig.runtime.dispose());

  for (let at = 0; at <= 500; at += DT) await rig.tick(at);

  // First spread: sign +1 → both arms open on the POSITIVE side of each own centre.
  const start = rig.fake.frames.length;
  assert.equal(rig.runtime.intent('spread', { at: 600 }).ok, true);
  const poses = new Map();
  for (let at = 600; at <= 1_500; at += DT) {
    poses.set(at, { ...(await rig.tick(at)) });
  }
  const positive = rig.fake.frames.slice(start);
  // A coalesced frame may carry the pose from one tick earlier; the bound is tiny and the sign
  // during the active phase does not flip, so compare against the closest recorded frame ≤ at.
  const poseNear = (at) => {
    let best = null;
    for (const [key, pose] of poses) {
      if (key <= at + 1e-9 && (best === null || key > best.key)) best = { key, pose };
    }
    return best === null ? undefined : best.pose;
  };
  for (const channel of ['armL', 'armR']) {
    const centre = (ranges[channel].min + ranges[channel].max) / 2;
    const rows = frameRows(positive, channel);
    assert.ok(rows.length > 0, `${channel} is written`);
    assert.ok(rows.every((row) => row.value >= ranges[channel].min - 1e-9
      && row.value <= ranges[channel].max + 1e-9), `${channel} stays inside its own input range`);
    const peak = rows.reduce((best, row) => (row.value > best.value ? row : best), rows[0]);
    assert.ok(peak.value > centre, `${channel} positive semantic maps above the input centre`);
    const poseAtPeak = poseNear(peak.at);
    assert.ok(poseAtPeak !== undefined, `pose recorded at/before ${peak.at}`);
    assert.ok(Math.sign(peak.value - centre) === Math.sign(poseAtPeak[channel]),
      `${channel} payload direction matches the semantic sign`);
  }

  // Second spread: sign -1 → the same asymmetric inputs go BELOW their own centre.
  for (let at = 1_500; at <= 2_500; at += DT) await rig.tick(at);
  const negativeStart = rig.fake.frames.length;
  assert.equal(rig.runtime.intent('spread', { at: 2_600 }).ok, true);
  for (let at = 2_600; at <= 3_500; at += DT) await rig.tick(at);
  const negative = rig.fake.frames.slice(negativeStart);
  for (const channel of ['armL', 'armR']) {
    const centre = (ranges[channel].min + ranges[channel].max) / 2;
    const rows = frameRows(negative, channel);
    const trough = rows.reduce((best, row) => (row.value < best.value ? row : best), rows[0]);
    assert.ok(trough.value < centre, `${channel} negative semantic maps below the input centre`);
  }

  // Semantic clamp and per-frame step are enforced on the controller side.
  for (const channel of ['armL', 'armR', 'bodyZ']) {
    const limit = BODY_ARM_CHANNEL_LIMITS[channel];
    const semantic = [...poses.values()].map((pose) => pose[channel]);
    assert.ok(semantic.every((value) => Math.abs(value) <= limit + 1e-9),
      `${channel} semantic value stays ≤ ${limit}`);
    // Consecutive controller frames never jump more than the declared step budget.
    for (let index = 1; index < semantic.length; index += 1) {
      assert.ok(Math.abs(semantic[index] - semantic[index - 1]) <= BODY_ARM_MAX_STEP + 1e-6,
        `${channel} per-frame step stays within the budget`);
    }
  }
});

// ---------------------------------------------------------------------------------------------
// 4. model switch / disconnect: the old gate and old output generation are invalidated
// ---------------------------------------------------------------------------------------------
test('4. 切模型/断连：旧通道失效，旧臂输入不再写，新模型只用新映射', async (t) => {
  const full = [...BODY_ARM_CHANNELS];
  const rig = await makeRuntime({ channels: full });
  t.after(() => rig.runtime.dispose());

  for (let at = 0; at <= 300; at += DT) await rig.tick(at);
  assert.equal(rig.runtime.intent('wave', { at: 400 }).ok, true);
  for (let at = 400; at <= 900; at += DT) await rig.tick(at);

  // Switch to a model that maps only armL. The old wave and any pending frame must be dropped.
  await rig.remap(['headX', 'headY', 'headZ', ...BODY_ARM_CHANNELS.filter((channel) => channel !== 'armR')]);
  const switchAt = rig.fake.frames.length;
  assert.deepEqual(rig.runtime.snapshot().intents.active, [],
    'the old model action was invalidated by the mapping switch');
  assert.deepEqual(rig.runtime.snapshot().channels.bodyArms.writeChannels.includes('armR'), false);
  assert.deepEqual(rig.runtime.snapshot().motion.posture.bodyArms.verified.includes('armR'), false);

  for (let at = 1_000; at <= 2_200; at += DT) await rig.tick(at);
  const afterSwitch = rig.fake.frames.slice(switchAt);
  assert.equal(hasRow(afterSwitch, 'armR'), false, 'no stale armR row after the model switch');
  assert.ok(hasRow(afterSwitch, 'armL'), 'the new model arm still moves');

  // Disconnect: the gate closes and no further row is written.
  const beforeDisconnect = rig.fake.frames.length;
  await rig.runtime.disconnect();
  const disconnected = rig.runtime.snapshot();
  assert.deepEqual(disconnected.channels.bodyArms.writeChannels, []);
  await rig.tick(2_300);
  assert.equal(rig.fake.frames.length, beforeDisconnect, 'a disconnected runtime sends no body frame');

  // Reconnect with the OTHER arm. Only the new binding may be written.
  const connected = await rig.runtime.connect();
  assert.equal(connected.ok, true);
  await rig.remap(['headX', 'headY', 'headZ', 'armR', 'shoulderR', 'handR']);
  for (let at = 2_400; at <= 2_800; at += DT) await rig.tick(at);
  const reconnectStart = rig.fake.frames.length;
  const wave = rig.runtime.intent('wave', { at: 2_900 });
  assert.equal(wave.ok, true);
  assert.deepEqual(wave.channels.sort(), ['armR', 'handR', 'shoulderR'],
    'the wave uses only the model-2 arm side');
  for (let at = 2_900; at <= 3_700; at += DT) await rig.tick(at);
  const afterReconnect = rig.fake.frames.slice(reconnectStart);
  assert.ok(hasRow(afterReconnect, 'armR'), 'the new arm is written');
  assert.equal(hasRow(afterReconnect, 'armL'), false, 'the old arm binding is gone');
});

// ---------------------------------------------------------------------------------------------
// 5. single outlet: one frame, one row per input, latest frame agrees with the pose
// ---------------------------------------------------------------------------------------------
test('5. 单出口/最新帧：body/arm 走同一 writeFrame，无重复输入，帧值与姿态一致', async (t) => {
  const channels = ['headX', 'headY', 'headZ', ...BODY_ARM_CHANNELS];
  const rig = await makeRuntime({ channels });
  t.after(() => rig.runtime.dispose());

  const poses = new Map();
  for (let at = 0; at <= 1_500; at += DT) {
    poses.set(at, { ...(await rig.tick(at)) });
  }
  assert.ok(rig.fake.frames.length > 10, 'the one frame writer produced frames');
  assert.equal(rig.fake.writes.filter((entry) => BODY_ARM_CHANNELS.includes(entry.channel)).length, 0,
    'body/arm never use the single-value write path');

  for (const frame of rig.fake.frames) {
    const inputs = frame.entries.map((entry) => entry.input);
    assert.equal(new Set(inputs).size, inputs.length, `frame @${frame.at} has one row per input`);
    for (const entry of frame.entries) {
      if (!BODY_ARM_CHANNELS.includes(entry.channel)) continue;
      const pose = poses.get(frame.at);
      assert.ok(pose !== undefined, `a pose exists for frame @${frame.at}`);
      const def = ROW_DEFS[entry.channel];
      const semantic = Math.max(-1, Math.min(1, pose[entry.channel]));
      const expected = def.min + ((semantic + 1) / 2) * (def.max - def.min);
      assert.ok(Math.abs(entry.value - expected) <= 1e-9,
        `${entry.channel} @${frame.at} is the latest pose value, not a stale frame`);
    }
  }

  // The very last written body/arm value must be the latest frame's value.
  const lastFrame = rig.fake.frames[rig.fake.frames.length - 1];
  const lastPose = [...poses.values()][poses.size - 1];
  for (const entry of lastFrame.entries) {
    if (BODY_ARM_CHANNELS.includes(entry.channel)) {
      const def = ROW_DEFS[entry.channel];
      const semantic = Math.max(-1, Math.min(1, lastPose[entry.channel]));
      const expected = def.min + ((semantic + 1) / 2) * (def.max - def.min);
      assert.ok(Math.abs(entry.value - expected) <= 1e-9,
        `the last ${entry.channel} row is the newest frame, never superseded silently`);
    }
  }
});

// ---------------------------------------------------------------------------------------------
// 6. the legacy action path still works and coexists with the base body layer
// ---------------------------------------------------------------------------------------------
test('6. 现有 nod：headY 仍写，body 基础层同时继续（无二次通道抢占）', async (t) => {
  const rig = await makeRuntime({ channels: ['headX', 'headY', 'headZ', ...BODY_ARM_CHANNELS] });
  t.after(() => rig.runtime.dispose());
  for (let at = 0; at <= 300; at += DT) await rig.tick(at);
  const start = rig.fake.frames.length;
  const nod = rig.runtime.intent('nod', { at: 400 });
  assert.equal(nod.ok, true, 'nod still starts');
  assert.deepEqual(nod.channels.sort(), ['headY', 'headZ'], 'nod keeps its legacy channel set');
  for (let at = 400; at <= 1_300; at += DT) await rig.tick(at);
  const during = rig.fake.frames.slice(start);
  assert.ok(hasRow(during, 'headY'), 'nod writes headY');
  assert.ok(hasRow(during, 'bodyY') && hasRow(during, 'armL'),
    'the body/arm base layer keeps running during the nod');
  // A nod never smuggles an arm gesture: its channel set stays the legacy head pair.
  assert.equal(nod.channels.includes('armL') || nod.channels.includes('armR'), false,
    'the nod does not claim an arm channel');
});

// ---------------------------------------------------------------------------------------------
// 8. automatic body/arm output respects idleSwayScale:0 (explicit requests still run)
// ---------------------------------------------------------------------------------------------
test('8. idleSwayScale:0 停掉身体/手臂基础微动与自动组件，显式 spread 仍可执行', async (t) => {
  const rig = await makeRuntime({
    channels: ['headX', 'headY', 'headZ', 'bodyY', 'armL'],
    config: { idleSwayScale: 0 },
  });
  t.after(() => rig.runtime.dispose());

  for (let at = 0; at <= 18_000; at += DT) await rig.tick(at);
  assert.ok(rig.fake.frames.length > 100, 'the real writer kept producing frames for the mapped head');
  assert.equal(hasRow(rig.fake.frames, 'bodyY'), false, 'no automatic bodyY row with idleSwayScale:0');
  assert.equal(hasRow(rig.fake.frames, 'armL'), false, 'no automatic armL row with idleSwayScale:0');
  for (const channel of ['headX', 'headY', 'headZ']) {
    const values = frameRows(rig.fake.frames, channel).map((row) => row.value);
    assert.ok(values.length > 0, `${channel} is still written (as a still value)`);
    const span = Math.max(...values) - Math.min(...values);
    assert.ok(span <= 1e-9, `${channel} stays exactly still (span ${span})`);
  }
  const snap = rig.runtime.snapshot();
  for (const category of ['body', 'shoulder', 'arm']) {
    assert.equal(snap.motion.posture.bodyArms.components[category], null,
      `${category} automatic component is not installed`);
  }
  assert.equal(Math.abs(snap.motion.posture.bodyArms.base.bodyY), 0);
  assert.equal(Math.abs(snap.motion.posture.bodyArms.mixed.armL), 0);

  // An explicit request is not idle output: it must still reach the transport.
  const spread = rig.runtime.intent('spread', { at: 18_000 });
  assert.equal(spread.ok, true);
  const start = rig.fake.frames.length;
  for (let at = 18_000; at <= 19_100; at += DT) await rig.tick(at);
  const after = rig.fake.frames.slice(start);
  const arm = frameRows(after, 'armL');
  assert.ok(arm.length > 0, 'the explicit spread still writes armL');
  assert.ok(Math.max(...arm.map((row) => row.value)) - Math.min(...arm.map((row) => row.value)) > 0.05,
    'the explicit spread really moves the arm');
});

// ---------------------------------------------------------------------------------------------
// 9. automatic body/arm output respects idleAmplitude:0 (explicit requests still run)
// ---------------------------------------------------------------------------------------------
test('9. idleAmplitude:0 停掉自动待机输出，显式 spread/nod 不被误杀', async (t) => {
  const rig = await makeRuntime({
    channels: ['headX', 'headY', 'headZ', 'bodyY', 'armL'],
    config: { idleAmplitude: 0 },
  });
  t.after(() => rig.runtime.dispose());

  for (let at = 0; at <= 18_000; at += DT) await rig.tick(at);
  assert.ok(rig.fake.frames.length > 100, 'the real writer produced frames');
  assert.equal(hasRow(rig.fake.frames, 'bodyY'), false, 'no automatic bodyY row with idleAmplitude:0');
  assert.equal(hasRow(rig.fake.frames, 'armL'), false, 'no automatic armL row with idleAmplitude:0');
  for (const channel of ['headX', 'headY', 'headZ']) {
    const values = frameRows(rig.fake.frames, channel).map((row) => row.value);
    assert.ok(values.length > 0, `${channel} is still written (as a still value)`);
    const span = Math.max(...values) - Math.min(...values);
    assert.ok(span <= 1e-9, `${channel} stays exactly still (span ${span})`);
  }
  const snap = rig.runtime.snapshot();
  for (const category of ['body', 'shoulder', 'arm']) {
    assert.equal(snap.motion.posture.bodyArms.components[category], null,
      `${category} automatic component is not installed`);
  }

  // Explicit body/arm and head requests keep their own writer path.
  const spread = rig.runtime.intent('spread', { at: 18_000 });
  assert.equal(spread.ok, true);
  const nod = rig.runtime.intent('nod', { at: 18_000 });
  assert.equal(nod.ok, true);
  const start = rig.fake.frames.length;
  for (let at = 18_000; at <= 19_100; at += DT) await rig.tick(at);
  const after = rig.fake.frames.slice(start);
  const arm = frameRows(after, 'armL');
  assert.ok(arm.length > 0, 'the explicit spread still writes armL');
  assert.ok(Math.max(...arm.map((row) => row.value)) - Math.min(...arm.map((row) => row.value)) > 0.05,
    'the explicit spread really moves the arm');
  const head = frameRows(after, 'headY');
  assert.ok(head.length > 0, 'the explicit nod still writes headY');
  assert.ok(Math.max(...head.map((row) => Math.abs(row.value))) > 0,
    'the explicit nod reaches the transport');
});

// Keep the floor import meaningful: a persona draw never returns a zero-weight component.
test('7. 组件库仍使用软权重下限（没有不可达姿态）', () => {
  assert.ok(COMPONENT_SELECTION_WEIGHT_FLOOR > 0);
  assert.ok(BODY_ARM_COMPONENT_MIN_MS >= 1_000 && BODY_ARM_COMPONENT_MAX_MS > BODY_ARM_COMPONENT_MIN_MS);
});
