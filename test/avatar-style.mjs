/**
 * Persona-driven motion style — stage 1 acceptance.
 *
 * Pins the contracts the feature exists for:
 *   1. persona → structured style is parsed/clamped lazily and CACHED by persona version;
 *   2. the cached style is the BASELINE; listening/thinking/waiting/tired only scale it temporarily;
 *   3. one-shot intents are composed into the same frame (single writer) and return to baseline,
 *      with the correct axis per intent (nod = pitch/headY, tilt = yaw+roll/headX+headZ);
 *   4. only verified channels are ever written; an unadapted channel is skipped and recorded;
 *   5. a late generation for an older persona version is dropped at commit (never installed);
 *   6. the style source is the persona actually injected: the settings box first, the library
 *      snapshot only while that box is empty, and never the user-profile section.
 *
 * Run: node --test test/avatar-style.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AVATAR_STYLE_CHANNEL_RANGES,
  AVATAR_STYLE_RANGES,
  DEFAULT_AVATAR_STYLE,
  HOLD_MICRO_DRIFT,
  IDLE_PARAM_CHANNELS,
  IDLE_SPEECH_SCALE,
  IDLE_WRITE_CHANNELS,
  INTENT_CHANNEL_TARGETS,
  OCCASIONAL_ACTION,
  buildAvatarStylePrompt,
  createAvatarStyleCache,
  createAvatarRuntime,
  createBehaviorRuntime,
  deriveAvatarStyleDimensions,
  parseAvatarStyle,
  personaStyleVersion,
} from '../src/host/avatar/avatarRuntime.js';
import {
  AVATAR_STYLE_SOURCE_EVENT,
  assistantPersonaFromSnapshot,
  createAvatarStyleTextSource,
  resolveAvatarStyleText,
} from '../src/host/index.js';

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

const approx = (actual, expected, message = '', epsilon = 1e-9) => {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${message} expected ${expected}, got ${actual}`);
};

const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

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

/** Drive one tick per clock value, letting each coalesced idle frame settle. */
const tickAt = async (runtime, times) => {
  for (const at of times) {
    runtime.tick(at);
    await flushMicrotasks();
  }
};

/** Peak |channel| over a fixed 30 Hz window (channel is semantic: headY = pitch, headX = yaw). */
const channelPeak = (runtime, channel, startMs, durationMs) => {
  let peak = 0;
  runtime.tick(startMs);
  for (let elapsed = 33; elapsed <= durationMs; elapsed += 33) {
    peak = Math.max(peak, Math.abs(runtime.tick(startMs + elapsed)[channel]));
  }
  return peak;
};

/** Peak |headX| over a fixed 30 Hz window. */
const headPeak = (runtime, startMs, durationMs) => channelPeak(runtime, 'headX', startMs, durationMs);

/** Manually resolvable promise, so a test can control the exact generation completion order. */
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

// ---------------------------------------------------------------------------------------------
// 1-2. style parsing
// ---------------------------------------------------------------------------------------------

test('1. 风格解析：数值 clamp、枚举校验、未知字段忽略', () => {
  const parsed = parseAvatarStyle(JSON.stringify({
    amplitude: 99,
    tempo: -3,
    gazeHabit: 'wandering',
    expressiveness: 0.1,
    nodDurationMs: 9999,
    tiltChance: 'nope',
    mystery: 1,
  }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.style.amplitude, AVATAR_STYLE_RANGES.amplitude.max, 'amplitude clamps high');
  assert.equal(parsed.style.tempo, AVATAR_STYLE_RANGES.tempo.min, 'tempo clamps low');
  assert.equal(parsed.style.expressiveness, AVATAR_STYLE_RANGES.expressiveness.min);
  assert.equal(parsed.style.nodDurationMs, AVATAR_STYLE_RANGES.nodDurationMs.max);
  assert.equal(parsed.style.gazeHabit, 'wandering', 'valid enum is applied');
  assert.equal(parsed.style.tiltChance, DEFAULT_AVATAR_STYLE.tiltChance, 'invalid value keeps the base');
  assert.deepEqual(parsed.ignored, ['mystery'], 'unknown fields are ignored');
  assert.deepEqual(parsed.invalid, ['tiltChance']);
  console.log(
    `[style] amplitude=${parsed.style.amplitude} tempo=${parsed.style.tempo}`
    + ` expressiveness=${parsed.style.expressiveness} nodDurationMs=${parsed.style.nodDurationMs}`
    + ` ignored=${parsed.ignored.join(',')} invalid=${parsed.invalid.join(',')}`,
  );
});

test('2. 解析失败：默认风格 + parse-failed 事件，且同一人设不再重试', async () => {
  const events = [];
  let generateCalls = 0;
  const cache = createAvatarStyleCache({
    generate: async () => {
      generateCalls += 1;
      return '这不是 JSON';
    },
    onEvent: (type, payload) => events.push({ type, payload }),
  });
  const first = await cache.refresh('一个沉稳的人设');
  assert.equal(first.ok, false);
  assert.deepEqual(first.style, DEFAULT_AVATAR_STYLE, 'a parse failure falls back to the default style');
  assert.equal(first.modelCalls, 1);
  const event = events.find((entry) => entry.type === 'avatar.style.parse-failed');
  assert.ok(event, 'avatar.style.parse-failed is recorded');
  assert.ok(event.payload.error.length > 0);

  const cached = await cache.refresh('一个沉稳的人设');
  assert.equal(cached.cached, true, 'the failed version is still cached');
  assert.equal(cached.callModelCalls, 0, 'the cached refresh made zero model calls');
  assert.equal(generateCalls, 1, 'the same persona never triggers a second generate()');
  assert.equal(cache.snapshot().modelCalls, 1, 'the total model call count is unchanged');
  console.log(`[style] parse-failed → default amplitude=${first.style.amplitude} modelCalls=${cache.snapshot().modelCalls}`);
});

// ---------------------------------------------------------------------------------------------
// 3-5. lazy merge + version cache
// ---------------------------------------------------------------------------------------------

test('3. 惰性：只改模型提及的字段，其余保持原值', async () => {
  let calls = 0;
  const cache = createAvatarStyleCache({
    generate: async () => {
      calls += 1;
      return calls === 1
        ? JSON.stringify({
          amplitude: 1.4, tempo: 1.3, gazeHabit: 'wandering', nodAmplitude: 1.2, nodDurationMs: 400,
        })
        : JSON.stringify({ nodAmplitude: 0.6 });
    },
  });
  const first = await cache.refresh('人设 A：活泼');
  assert.equal(first.style.amplitude, 1.4);

  const second = await cache.refresh('人设 B：微调');
  assert.deepEqual(second.changed, ['nodAmplitude']);
  assert.equal(second.style.nodAmplitude, 0.6, 'mentioned field changes');
  assert.equal(second.style.amplitude, 1.4, 'amplitude is untouched');
  assert.equal(second.style.tempo, 1.3, 'tempo is untouched');
  assert.equal(second.style.gazeHabit, 'wandering', 'gaze habit is untouched');
  assert.equal(second.style.nodDurationMs, 400, 'nod duration is untouched');
  console.log(
    `[style] lazy changed=${second.changed.join(',')} amplitude=${second.style.amplitude}`
    + ` tempo=${second.style.tempo} nodAmplitude=${second.style.nodAmplitude}`,
  );
});

test('4. 缓存：人设文本未变时不再生成（模型调用 0 次）', async () => {
  let calls = 0;
  const cache = createAvatarStyleCache({
    generate: async () => {
      calls += 1;
      return JSON.stringify({ amplitude: 1.2 });
    },
  });
  const persona = '温柔、沉稳的陪伴者';
  const first = await cache.refresh(persona);
  assert.equal(first.cached, false);
  assert.equal(first.modelCalls, 1);

  const hit = await cache.refresh(persona);
  assert.equal(hit.cached, true);
  assert.equal(hit.callModelCalls, 0, 'the cached refresh made zero model calls');
  assert.equal(hit.modelCalls, 1, 'the total model call count is unchanged by a cache hit');
  assert.equal(calls, 1, 'generate() ran exactly once');
  assert.equal(cache.snapshot().modelCalls, 1);
  console.log(`[style] cache-hit callModelCalls=${hit.callModelCalls} totalModelCalls=${hit.modelCalls} generateCalls=${calls}`);
});

test('5. 人设变化：重新生成一次，styleVersion 更新并持久化', async () => {
  let calls = 0;
  const persisted = [];
  const cache = createAvatarStyleCache({
    generate: async ({ personaText }) => {
      calls += 1;
      return JSON.stringify({ amplitude: calls === 1 ? 0.7 : 1.3, personaChars: personaText.length });
    },
    persist: (state) => persisted.push(state),
  });
  const first = await cache.refresh('人设 A');
  const second = await cache.refresh('人设 B：明显不同');
  assert.equal(second.cached, false);
  assert.equal(second.callModelCalls, 1, 'the changed-persona refresh made one model call');
  assert.equal(second.modelCalls, 2, 'the second generate is counted once');
  assert.equal(calls, 2);
  assert.notEqual(second.styleVersion, first.styleVersion, 'styleVersion changes with persona version');
  assert.equal(second.styleVersion, personaStyleVersion('人设 B：明显不同'));
  assert.equal(second.style.amplitude, 1.3);
  assert.equal(persisted.length, 2, 'each successful generate is persisted');
  assert.equal(persisted.at(-1).styleVersion, second.styleVersion);
  console.log(
    `[style] persona-change generateCalls=${calls} styleVersion=${second.styleVersion}`
    + ` persisted=${persisted.length}`,
  );
});

// ---------------------------------------------------------------------------------------------
// 6-7. style drives intents and temporary states
// ---------------------------------------------------------------------------------------------

test('6. 同一意图在三种风格下幅度/时长不同，实际峰值同序', () => {
  const variants = {
    gentle: { amplitude: 0.5, tempo: 0.7, nodAmplitude: 0.4, nodDurationMs: 800 },
    lively: { amplitude: 1.4, tempo: 1.5, nodAmplitude: 1.3, nodDurationMs: 400 },
    restrained: { amplitude: 0.9, tempo: 1.2, nodAmplitude: 0.6, nodDurationMs: 600 },
  };
  const measured = {};
  for (const [name, style] of Object.entries(variants)) {
    const runtime = createBehaviorRuntime({
      config: { style, random: () => 0.5, idleActions: [] },
    });
    // Isolate the intent: the held component is a separate visible layer and would otherwise add
    // its own pitch/roll to the measured nod peak. Initialise once, then pause the component.
    runtime.tick(0);
    runtime.interrupt({ reason: 'style-intent-isolation' });
    runtime.tick(1000);
    const info = runtime.intent('nod');
    assert.equal(info.ok, true, `${name} intent starts`);
    // A nod lives on the pitch axis (headY); headX is a left/right turn and must not carry it.
    const peak = channelPeak(runtime, 'headY', 1000, info.durationMs);
    measured[name] = { info, peak };
  }
  // Shorter nodDurationMs and higher tempo both shorten the gesture.
  assert.ok(measured.gentle.info.durationMs > measured.restrained.info.durationMs);
  assert.ok(measured.restrained.info.durationMs > measured.lively.info.durationMs);
  // nodAmplitude × amplitude orders the gesture size.
  assert.ok(measured.gentle.info.amplitude < measured.restrained.info.amplitude);
  assert.ok(measured.restrained.info.amplitude < measured.lively.info.amplitude);
  // gentle/restrained can land close together because both keep the visible gesture floor; the
  // ordering still must not invert, and lively must stay clearly above both.
  assert.ok(measured.gentle.peak <= measured.restrained.peak * 1.02,
    'gentle peak is the smallest (within the shared visible floor)');
  assert.ok(measured.restrained.peak < measured.lively.peak * 0.95, 'lively peak is the largest');
  console.log(
    `[style] intents gentle(d=${measured.gentle.info.durationMs},a=${measured.gentle.info.amplitude.toFixed(3)},peak=${measured.gentle.peak.toFixed(3)})`
    + ` restrained(d=${measured.restrained.info.durationMs},a=${measured.restrained.info.amplitude.toFixed(3)},peak=${measured.restrained.peak.toFixed(3)})`
    + ` lively(d=${measured.lively.info.durationMs},a=${measured.lively.info.amplitude.toFixed(3)},peak=${measured.lively.peak.toFixed(3)})`,
  );
});

test('7. 状态是临时缩放：聆听幅度 < 基线，等待/疲倦更慢更小，基线不变', () => {
  const style = { amplitude: 1.2, tempo: 1.15 };
  const idle = createBehaviorRuntime({ config: { style, random: () => 0.31, idleActions: [] } });
  const listening = createBehaviorRuntime({
    config: { style, status: 'listening', random: () => 0.31, idleActions: [] },
  });
  const idlePeak = headPeak(idle, 0, 12_000);
  const listeningPeak = headPeak(listening, 0, 12_000);
  // With the component layer active, a peak includes the held posture as well as the base sway.
  // The semantic style scaling is asserted above; the peak must not overflow it by a component band.
  assert.ok(listeningPeak <= idlePeak + 0.01,
    `listening peak ${listeningPeak} stays near baseline ${idlePeak} under the component layer`);
  assert.ok(listening.snapshot().style.effective.amplitude < listening.snapshot().style.baseline.amplitude);

  const sleeping = createBehaviorRuntime({
    config: { style, status: 'tired', random: () => 0.31, idleActions: [] },
  });
  sleeping.tick(0);
  const tired = sleeping.snapshot().style.effective;
  const waiting = createBehaviorRuntime({ config: { style, status: 'waiting', random: () => 0.31, idleActions: [] } });
  waiting.tick(0);
  const waitEff = waiting.snapshot().style.effective;
  assert.ok(tired.amplitude < waitEff.amplitude, 'tired is smaller than waiting');
  assert.ok(tired.tempo < waitEff.tempo, 'tired is slower than waiting');
  assert.deepEqual(sleeping.snapshot().style.baseline, { ...DEFAULT_AVATAR_STYLE, ...style },
    'a temporary state never rewrites the persona baseline');
  console.log(
    `[style] listeningPeak=${listeningPeak.toFixed(4)} basePeak=${idlePeak.toFixed(4)}`
    + ` tiredAmp=${tired.amplitude.toFixed(2)} waitAmp=${waitEff.amplitude.toFixed(2)}`
    + ` tiredTempo=${tired.tempo.toFixed(2)} waitTempo=${waitEff.tempo.toFixed(2)}`,
  );
});

// ---------------------------------------------------------------------------------------------
// 8-11. controller invariants through the host facade
// ---------------------------------------------------------------------------------------------

test('8. 说话期间空闲帧继续（幅度降低），结束后恢复', async () => {
  const fake = createFakeTransport();
  const quietFake = createFakeTransport();
  let clock = 1000;
  const idleConfig = {
    autoTickMs: 0,
    flushIntervalMs: 1,
    idleParams: { headX: { inputName: 'FaceAngleX', min: -30, max: 30 } },
  };
  const runtime = await connectRuntime({ transport: fake.transport, now: () => clock, config: idleConfig });
  // Same tick grid as the speaking runtime: the amplitude ratio is phase-exact, not peak-sampled.
  const quiet = await connectRuntime({ transport: quietFake.transport, now: () => 0, config: idleConfig });
  fake.writes.length = 0; // connect() probes are not idle frames
  quietFake.writes.length = 0;
  fake.batches.length = 0;
  quietFake.batches.length = 0;

  await tickAt(runtime, [clock]);
  await tickAt(quiet, [clock]);
  const baseline = runtime.snapshot().idleParams.frames;
  assert.ok(baseline >= 1, 'one idle frame before the line');

  const spoken = await runtime.speak({ text: '说话时空闲降低', durationMs: 900 });
  assert.equal(spoken.ok, true, `speech starts (${spoken.message ?? ''})`);
  runtime.setStatus('speaking', 'test');

  clock = 2000;
  const duringTimes = [2000, 2100, 2200, 2300, 2400, 2500];
  const duringStart = { speaking: fake.batches.length, quiet: quietFake.batches.length };
  await tickAt(runtime, duringTimes);
  await tickAt(quiet, duringTimes);
  const during = runtime.snapshot();
  const framesDuring = during.idleParams.frames - baseline;
  assert.ok(framesDuring > 0, `idle frames keep being written while speaking (${framesDuring})`);
  assert.ok(during.idleParams.reducedBySpeech > 0, 'those frames are written at the reduced speech scale');
  approx(during.idleParams.speechScale, IDLE_SPEECH_SCALE, 'the speaking modifier is the amplitude scale');
  const amplitude = (batches, from) => batches.slice(from).flat()
    .filter((entry) => entry.input === 'FaceAngleX')
    .reduce((total, entry) => total + Math.abs(entry.value), 0);
  const ratioDuring = amplitude(fake.batches, duringStart.speaking)
    / amplitude(quietFake.batches, duringStart.quiet);
  assert.ok(ratioDuring < 1, `speech reduces the idle amplitude (ratio ${ratioDuring.toFixed(3)})`);
  assert.equal(during.style.baseline.amplitude, DEFAULT_AVATAR_STYLE.amplitude, 'speaking did not rewrite style');

  clock = 3600;
  runtime.setStatus('idle', 'test');
  // Two settle ticks first: the speaking run's springs still carry the reduced trajectory.
  await tickAt(runtime, [3600, 3800, 4000]);
  await tickAt(quiet, [3600, 3800, 4000]);
  const afterTimes = [4200, 4400, 4600, 4800, 5000, 5200];
  const afterStart = { speaking: fake.batches.length, quiet: quietFake.batches.length };
  await tickAt(runtime, afterTimes);
  await tickAt(quiet, afterTimes);
  const after = runtime.snapshot();
  assert.ok(after.idleParams.frames > during.idleParams.frames, 'idle frames resume after speech');
  const ratioAfter = amplitude(fake.batches, afterStart.speaking)
    / amplitude(quietFake.batches, afterStart.quiet);
  assert.ok(ratioAfter > 0.9, `the amplitude recovers after the line (ratio ${ratioAfter.toFixed(3)})`);
  console.log(
    `[style] speech framesDuring=${framesDuring} reduced=${during.idleParams.reducedBySpeech}`
    + ` ratioDuring=${ratioDuring.toFixed(3)} ratioAfter=${ratioAfter.toFixed(3)}`,
  );
  runtime.dispose();
  quiet.dispose();
});

test('9. 意图结束后回到基线，基线风格不变', () => {
  const runtime = createBehaviorRuntime({
    config: { style: { amplitude: 0.8, nodAmplitude: 0.6 }, random: () => 0.42, idleActions: [] },
  });
  runtime.tick(1000);
  const baseline = structuredClone(runtime.snapshot().style.baseline);
  const info = runtime.intent('nod');
  assert.equal(info.ok, true);
  let peak = 0;
  for (let elapsed = 33; elapsed <= info.durationMs; elapsed += 33) {
    peak = Math.max(peak, Math.abs(runtime.tick(1000 + elapsed).headY));
  }
  assert.ok(peak > 0.1, `the nod is visible on the pitch axis (peak ${peak})`);

  const end = 1000 + info.durationMs + 1600 + 600;
  for (let at = 1000 + info.durationMs + 33; at <= end; at += 33) runtime.tick(at);
  const snapshot = runtime.snapshot();
  assert.deepEqual(snapshot.intents.channels, [], 'the settle window closed');
  assert.ok(Math.abs(snapshot.pose.headY) <= 0.1,
    `the pose returns to the idle baseline (headY=${snapshot.pose.headY})`);
  assert.deepEqual(snapshot.style.baseline, baseline, 'the intent did not change the baseline');
  console.log(
    `[style] intent peak=${peak.toFixed(3)} after=${snapshot.pose.headY.toFixed(3)}`
    + ` baselineAmplitude=${snapshot.style.baseline.amplitude} channels=${snapshot.intents.channels.length}`,
  );
});

test('10. 单写入者：每个空闲帧内同通道只出现一次写入', async () => {
  const fake = createFakeTransport();
  let clock = 1000;
  const runtime = await connectRuntime({
    transport: fake.transport,
    now: () => clock,
    config: {
      autoTickMs: 0,
      flushIntervalMs: 1,
      idleWriteHz: 8,
      idleParams: {
        headX: { inputName: 'FaceAngleX', min: -30, max: 30 },
        headY: { inputName: 'FaceAngleY', min: -30, max: 30 },
        headZ: { inputName: 'FaceAngleZ', min: -30, max: 30 },
      },
    },
  });
  // Drop the explicit-binding probe writes: only the composed frames below matter.
  fake.writes.length = 0;
  fake.batches.length = 0;
  const info = runtime.intent('nod');
  assert.equal(info.ok, true);

  const seen = [];
  for (let step = 1; step <= 12; step += 1) {
    clock = 1000 + step * 60;
    runtime.tick(clock);
    await flushMicrotasks();
  }
  for (const batch of fake.batches) {
    const inputs = batch.map((entry) => entry.input);
    assert.equal(new Set(inputs).size, inputs.length, `duplicate input inside one frame: ${inputs.join(',')}`);
    for (const channel of ['headX', 'headY', 'headZ']) {
      assert.ok(batch.filter((entry) => entry.channel === channel).length <= 1,
        `${channel} appears at most once in one frame`);
    }
    seen.push(...inputs);
  }
  assert.ok(fake.batches.length > 0, 'composed frames reached the transport');
  assert.equal(fake.writes.length, 0, 'an intent does not open a second, per-channel write path');
  assert.ok(fake.batches.some((batch) => batch.some((entry) => entry.channel === 'headY')),
    'the nod pitch channel reaches the transport');
  console.log(
    `[style] single-writer frames=${fake.batches.length} inputs=${[...new Set(seen)].join(',')}`
    + ` directWrites=${fake.writes.length}`,
  );
  runtime.dispose();
});

test('11. 未验证通道不发注入：未适配意图被跳过并记事件', async () => {
  const fake = createFakeTransport();
  const logs = [];
  let clock = 1000;
  const runtime = await connectRuntime({
    transport: fake.transport,
    now: () => clock,
    log: (message, data = {}) => logs.push({ message, ...data }),
    config: {
      autoTickMs: 0,
      flushIntervalMs: 1,
      idleParams: {
        headX: { inputName: 'FaceAngleX', min: -30, max: 30 },
        headY: { inputName: 'FaceAngleY', min: -30, max: 30 },
      },
    },
  });
  runtime.tick(1000);
  await flushMicrotasks();
  fake.writes.length = 0;
  fake.batches.length = 0;

  const skipped = runtime.intent('lookAtUser');
  assert.equal(skipped.ok, false);
  assert.equal(skipped.code, 'UNMAPPED');
  assert.deepEqual(skipped.skipped, [...INTENT_CHANNEL_TARGETS.lookAtUser]);
  const skipEvent = logs.find((entry) => entry.event === 'avatar.intent.skipped');
  assert.ok(skipEvent, 'avatar.intent.skipped is recorded');
  assert.equal(skipEvent.reason, 'unmapped');

  // nod targets headY + headZ; only headY is verified here, so headZ is skipped and recorded.
  const nod = runtime.intent('nod');
  assert.equal(nod.ok, true);
  assert.deepEqual(nod.channels, ['headY'], 'only the verified pitch channel participates');
  const channelSkip = logs.find((entry) => entry.event === 'avatar.intent.channel-skipped');
  assert.ok(channelSkip, 'the unadapted roll channel is recorded');
  assert.deepEqual(channelSkip.channels, ['headZ']);

  for (let step = 1; step <= 6; step += 1) {
    clock = 1000 + step * 120;
    runtime.tick(clock);
    await flushMicrotasks();
  }
  const injected = [...new Set(fake.batches.flat().map((entry) => entry.input))].sort();
  assert.ok(injected.length > 0);
  assert.deepEqual(injected, ['FaceAngleX', 'FaceAngleY'], 'no gaze/brow/body input is injected');
  console.log(
    `[style] unverified skip=${skipped.code} nodChannels=${nod.channels.join(',')}`
    + ` skipped=${channelSkip.channels.join(',')} injected=${injected.join(',')}`,
  );
  runtime.dispose();
});

// ---------------------------------------------------------------------------------------------
// 12. runtime-side lazy style application + status
// ---------------------------------------------------------------------------------------------

test('12. setStyle 惰性合并 + setStatus 只缩放不写回', () => {
  const runtime = createBehaviorRuntime({
    config: {
      style: { amplitude: 1.1, tempo: 1.0, gazeHabit: 'direct', nodAmplitude: 0.9 },
      random: () => 0.2,
      idleActions: [],
    },
  });
  const applied = runtime.setStyle({ amplitude: 0.6 });
  assert.equal(applied.ok, true);
  assert.deepEqual(applied.changed, ['amplitude']);
  assert.equal(applied.style.amplitude, 0.6, 'mentioned field changes');
  assert.equal(applied.style.tempo, 1.0, 'tempo is preserved');
  assert.equal(applied.style.gazeHabit, 'direct', 'gaze habit is preserved');
  assert.equal(applied.style.nodAmplitude, 0.9, 'nod amplitude is preserved');
  assert.equal(applied.styleVersion, '', 'no version is invented');

  runtime.tick(0);
  const status = runtime.setStatus('thinking', { reason: 'model-request' });
  assert.deepEqual(status, { ok: true, changed: true, status: 'thinking', previous: 'idle' });
  runtime.tick(50);
  const snapshot = runtime.snapshot();
  assert.equal(snapshot.status, 'thinking');
  assert.ok(snapshot.style.effective.amplitude < snapshot.style.baseline.amplitude);
  assert.deepEqual(snapshot.style.baseline, applied.style, 'state scaling never writes the baseline');
  const invalid = runtime.setStatus('dancing');
  assert.equal(invalid.ok, false);
  assert.equal(invalid.reason, 'invalid-status');
  const unknown = runtime.intent('dance');
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reason, 'unknown-intent');
  console.log(
    `[style] setStyle changed=${applied.changed.join(',')} amplitude=${applied.style.amplitude}`
    + ` status=${snapshot.status} effective=${snapshot.style.effective.amplitude.toFixed(2)}`,
  );
});

// ---------------------------------------------------------------------------------------------
// 13-19. per-channel independent enablement
// ---------------------------------------------------------------------------------------------

const ampMap = (channels) => JSON.stringify(channels.effectiveAmplitude ?? {});

test('13. 只接管 headX：仅 head 应用风格幅度，gaze/body/breath 跳过并记事件', async () => {
  const fake = createFakeTransport();
  const logs = [];
  const runtime = await connectRuntime({
    transport: fake.transport,
    log: (message, data = {}) => logs.push({ message, ...data }),
    config: {
      autoTickMs: 0,
      flushIntervalMs: 1,
      idleActions: [],
      idleParams: { headX: { inputName: 'FaceAngleX', min: -30, max: 30 } },
      style: {
        amplitude: 1.2,
        channels: {
          headX: { amplitude: 0.35 },
          gazeX: { amplitude: 1.4 },
          bodyX: { amplitude: 1.3 },
          breath: { amplitude: 0.4 },
        },
      },
    },
  });
  fake.writes.length = 0;
  fake.batches.length = 0;

  const status = runtime.snapshot();
  assert.deepEqual(status.channels.controlled, ['headX'], 'only headX is taken over');
  assert.deepEqual(status.channels.effectiveAmplitude, { headX: 0.35 },
    'only the controlled channel publishes an amplitude');
  for (const channel of ['gazeX', 'bodyX', 'breath']) {
    assert.equal(channel in status.channels.effectiveAmplitude, false, `${channel} is not style-active`);
    assert.ok(status.channels.skipped.includes(channel), `${channel} stays with VTS`);
  }
  const skipEvents = logs.filter((entry) => entry.event === 'avatar.channel.skipped');
  for (const channel of ['gazeX', 'bodyX', 'breath']) {
    assert.ok(skipEvents.some((entry) => entry.channel === channel), `${channel} skip is recorded`);
  }

  // Isolate the base curve from the held component (a separate visible layer).
  runtime.tick(0);
  runtime.interrupt({ reason: 'style-channel-isolation' });
  const peak = headPeak(runtime, 1000, 12_000);
  await flushMicrotasks();
  const inputs = [...new Set(fake.batches.flat().map((entry) => entry.input))];
  assert.deepEqual(inputs, ['FaceAngleX'], 'no gaze/body/breath input is injected');
  // 0.025 semantic head sway × the default 1.2 swing × the channel override (0.35), not global 1.2.
  assert.ok(peak > 0.008 && peak < 0.03, `head peak ${peak} follows the 0.35 override`);
  console.log(
    `[style] channel-only-head controlled=${status.channels.controlled.join(',')}`
    + ` effective=${ampMap(status.channels)} skipped=${status.channels.skipped.join(',')}`
    + ` peak=${peak.toFixed(4)} inputs=${inputs.join(',')}`,
  );
  runtime.dispose();
});

test('14. 追加接管 eyeOpenL：眼睛按自己的幅度，头部按头部幅度（不同值）', async () => {
  const fake = createFakeTransport();
  const logs = [];
  const runtime = await connectRuntime({
    transport: fake.transport,
    log: (message, data = {}) => logs.push({ message, ...data }),
    config: {
      autoTickMs: 0,
      flushIntervalMs: 1,
      idleActions: [],
      idleEye: true,
      blinkOwner: 'plugin',
      random: () => 0.99,
      // The head peak is measured while the slow tracker is still converging on its FIRST goal, so
      // pin the hold window: the stage-4 hold allocation (A) must not change what this channel
      // override test measures.
      postureHoldMinMs: 20_000,
      postureHoldMaxMs: 20_000,
      idleParams: {
        headX: { inputName: 'FaceAngleX', min: -30, max: 30 },
        eyeOpenL: { inputName: 'EyeOpenLeft', min: 0, max: 1 },
        eyeOpenR: { inputName: 'EyeOpenRight', min: 0, max: 1 },
      },
      style: {
        amplitude: 1.2,
        channels: {
          headX: { amplitude: 0.9 },
          eyeOpenL: { amplitude: 0.1 },
          eyeOpenR: { amplitude: 0.1 },
        },
      },
    },
  });
  fake.writes.length = 0;
  fake.batches.length = 0;
  // Isolate the base curve from the held component (a separate visible layer).
  runtime.tick(0);
  runtime.interrupt({ reason: 'style-head-eye-isolation' });

  const status = runtime.snapshot();
  assert.deepEqual(status.channels.controlled, ['headX', 'eyeOpenL', 'eyeOpenR']);
  assert.deepEqual(status.channels.effectiveAmplitude, { headX: 0.9, eyeOpenL: 0.1, eyeOpenR: 0.1 },
    'each taken-over channel carries its own effective amplitude');
  assert.notEqual(status.channels.effectiveAmplitude.headX, status.channels.effectiveAmplitude.eyeOpenL);

  const eyeValues = [];
  for (let step = 0; step <= 20; step += 1) {
    const pose = runtime.tick(1000 + step * 100);
    eyeValues.push(pose.eyeOpenL);
    await flushMicrotasks();
  }
  const headPeakValue = headPeak(runtime, 3000, 12_000);
  const inputs = [...new Set(fake.batches.flat().map((entry) => entry.input))];
  assert.deepEqual(inputs.sort(), ['EyeOpenLeft', 'EyeOpenRight', 'FaceAngleX'],
    'both eyes are explicitly assigned to the plugin');
  const minEye = Math.min(...eyeValues);
  const maxEye = Math.max(...eyeValues);
  // 0.02 semantic droop × eyeOpenL override 0.1 → at most 0.002 below fully open.
  assert.ok(maxEye <= 1 + 1e-9 && minEye >= 0.9979,
    `eye stays in its own narrow band (${minEye.toFixed(5)}..${maxEye.toFixed(5)})`);
  assert.ok(headPeakValue > 0.005 && headPeakValue < 0.06,
    `head uses its own 0.9 override and the light base band (peak ${headPeakValue.toFixed(4)})`);
  console.log(
    `[style] channel-head-eye controlled=${status.channels.controlled.join(',')}`
    + ` effective=${ampMap(status.channels)} eye=${minEye.toFixed(5)}..${maxEye.toFixed(5)}`
    + ` headPeak=${headPeakValue.toFixed(4)} inputs=${inputs.sort().join(',')}`,
  );
  runtime.dispose();
});

test('15. 探针确认 gazeX：gazeX 按自身幅度生效，bodyX 仍跳过', async () => {
  const fake = createFakeTransport();
  const logs = [];
  let clock = 1000;
  const runtime = await connectRuntime({
    transport: fake.transport,
    now: () => clock,
    log: (message, data = {}) => logs.push({ message, ...data }),
    config: {
      autoTickMs: 0,
      flushIntervalMs: 1,
      idleActions: [],
      idleParams: { headX: { inputName: 'FaceAngleX', min: -30, max: 30 } },
      inputs: { gazeX: { inputName: 'MyGazeX', min: -1, max: 1, injectable: true } },
      channelMap: { gazeX: 'MyGazeX' },
      style: {
        amplitude: 1.2,
        channels: {
          headX: { amplitude: 1.0 },
          gazeX: { amplitude: 1.4 },
          bodyX: { amplitude: 1.3 },
        },
      },
    },
  });
  fake.writes.length = 0;
  fake.batches.length = 0;

  const status = runtime.snapshot();
  assert.ok(status.channels.controlled.includes('gazeX'), 'an accepted probe promotes gazeX');
  assert.deepEqual(status.channels.effectiveAmplitude,
    { gazeX: 1.4, headX: 1.0 }, 'gazeX uses its own amplitude, headX its own');
  assert.equal('bodyX' in status.channels.effectiveAmplitude, false, 'bodyX is not taken over');
  assert.ok(status.channels.skipped.includes('bodyX'), 'bodyX stays with VTS');
  const gazeProbe = logs.find((entry) => entry.event === 'avatar.channel.verified'
    && entry.channel === 'gazeX');
  assert.ok(gazeProbe, 'avatar.channel.verified records the probe');

  const look = runtime.intent('lookAtUser');
  assert.equal(look.ok, true);
  assert.deepEqual(look.channels, ['gazeX'], 'only the verified gaze channel participates');
  // tilt targets headX (yaw) + headZ (roll); only headX is verified, so headZ is skipped.
  const tilt = runtime.intent('tilt');
  assert.equal(tilt.ok, true);
  assert.deepEqual(tilt.channels, ['headX'], 'tilt keeps the verified left/right axis');
  assert.ok(logs.some((entry) => entry.event === 'avatar.intent.channel-skipped'
    && entry.channels?.includes('headZ')), 'tilt records headZ as skipped');
  assert.ok(logs.some((entry) => entry.event === 'avatar.intent.channel-skipped'
    && entry.channels?.includes('gazeY')), 'lookAtUser records gazeY as skipped');

  for (let step = 1; step <= 8; step += 1) {
    runtime.tick(1000 + step * 120);
    await flushMicrotasks();
  }
  const injected = [...new Set(fake.batches.flat().map((entry) => entry.input))];
  assert.ok(injected.includes('MyGazeX'), 'gazeX is actually injected while the intent is active');
  assert.equal(injected.includes('BodyX'), false, 'bodyX is never injected');
  console.log(
    `[style] channel-gaze controlled=${status.channels.controlled.join(',')}`
    + ` effective=${ampMap(status.channels)} skipped=${status.channels.skipped.join(',')}`
    + ` injected=${injected.sort().join(',')} bodyX=skipped`,
  );
  runtime.dispose();
});

test('16. 惰性：未提及的通道沿用全局 amplitude，再次解析只合并提及的通道', async () => {
  const first = parseAvatarStyle(JSON.stringify({
    amplitude: 1.4,
    channels: { headX: { amplitude: 0.6 } },
  }));
  assert.equal(first.ok, true);
  const second = parseAvatarStyle(JSON.stringify({
    channels: { eyeOpenL: { amplitude: 0.3 } },
  }), { base: first.style });
  assert.equal(second.ok, true);
  assert.equal(second.style.amplitude, 1.4, 'the global amplitude is untouched');
  assert.equal(second.style.channels.headX.amplitude, 0.6, 'an unmentioned channel keeps its override');
  assert.equal(second.style.channels.eyeOpenL.amplitude, 0.3, 'the mentioned channel is merged');

  const fake = createFakeTransport();
  const runtime = await connectRuntime({
    transport: fake.transport,
    config: {
      autoTickMs: 0,
      flushIntervalMs: 1,
      idleActions: [],
      idleEye: true,
      idleParams: {
        headX: { inputName: 'FaceAngleX', min: -30, max: 30 },
        headY: { inputName: 'FaceAngleY', min: -30, max: 30 },
        eyeOpenL: { inputName: 'EyeOpenLeft', min: 0, max: 1 },
      },
      style: second.style,
    },
  });
  const status = runtime.snapshot();
  assert.deepEqual(status.channels.effectiveAmplitude,
    { headX: 0.6, headY: 1.4, eyeOpenL: 0.3 },
    'headY is unmentioned, so it inherits the global 1.4');
  const effective = runtime.snapshot().style.effective;
  assert.equal(effective.channels.headX.amplitude, 0.6);
  assert.equal(effective.channels.headY, undefined, 'no channel entry is invented for headY');
  console.log(
    `[style] channel-lazy baseline=${JSON.stringify(second.style.channels)}`
    + ` effective=${ampMap(status.channels)} global=${second.style.amplitude} headY=global`,
  );
  runtime.dispose();
});

test('17. 非法通道名/非法数值被忽略：只保留合法通道并 clamp', () => {
  const parsed = parseAvatarStyle(JSON.stringify({
    channels: {
      headX: { amplitude: 99 },
      eyeOpenL: { amplitude: 0 },
      bodyZ: { amplitude: 0.5 },
      headY: { amplitude: 'nope' },
      gazeX: 0.4,
      mystery: { amplitude: 0.5 },
    },
  }));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.style.channels, {
    headX: { amplitude: AVATAR_STYLE_CHANNEL_RANGES.headX.max },
    eyeOpenL: { amplitude: AVATAR_STYLE_CHANNEL_RANGES.eyeOpenL.min },
  }, 'only legal channels survive, clamped to their range');
  assert.deepEqual(parsed.ignored, ['channels.bodyZ', 'channels.mystery'],
    'unknown channel names are ignored');
  assert.deepEqual(parsed.invalid, ['channels.headY.amplitude', 'channels.gazeX'],
    'non-numeric values and non-object entries are invalid, not applied');
  assert.equal(parsed.style.amplitude, DEFAULT_AVATAR_STYLE.amplitude,
    'a broken channel override never changes the global style');
  console.log(
    `[style] channel-invalid kept=${JSON.stringify(parsed.style.channels)}`
    + ` ignored=${parsed.ignored.join(',')} invalid=${parsed.invalid.join(',')}`,
  );
});

test('18. 单写入者与去重：同帧同 input 只写一次（两个通道映射到同一 input）', async () => {
  const fake = createFakeTransport();
  const runtime = await connectRuntime({
    transport: fake.transport,
    config: {
      autoTickMs: 0,
      flushIntervalMs: 1,
      idleActions: [],
      idleParams: { headX: { inputName: 'SharedInput', min: -30, max: 30 } },
      inputs: { gazeX: { inputName: 'SharedInput', min: -30, max: 30, injectable: true } },
      channelMap: { gazeX: 'SharedInput' },
      style: {
        amplitude: 1.1,
        channels: { headX: { amplitude: 0.7 }, gazeX: { amplitude: 1.2 } },
      },
    },
  });
  const status = runtime.snapshot();
  assert.ok(status.channels.controlled.includes('headX') && status.channels.controlled.includes('gazeX'),
    'both channels are controlled');
  fake.writes.length = 0;
  fake.batches.length = 0;

  const look = runtime.intent('lookAtUser');
  assert.equal(look.ok, true);
  for (let step = 1; step <= 10; step += 1) {
    runtime.tick(1000 + step * 120);
    await flushMicrotasks();
  }
  assert.ok(fake.batches.length > 0, 'composed frames reached the transport');
  for (const batch of fake.batches) {
    const inputs = batch.map((entry) => entry.input);
    assert.equal(new Set(inputs).size, inputs.length, `duplicate input in one frame: ${inputs.join(',')}`);
    assert.ok(batch.length <= 1, 'the shared input is written once per frame');
  }
  assert.equal(fake.writes.length, 0, 'no second per-channel direct-write path');
  console.log(
    `[style] channel-dedupe frames=${fake.batches.length}`
    + ` entries=${fake.batches.map((batch) => batch.map((entry) => entry.channel).join('+')).join(',')}`
    + ` sharedInput=1 directWrites=${fake.writes.length} effective=${ampMap(status.channels)}`,
  );
  runtime.dispose();
});

test('19. 状态只缩放已接管通道：effectiveAmplitude 按通道各自计算', async () => {
  const fake = createFakeTransport();
  const runtime = await connectRuntime({
    transport: fake.transport,
    config: {
      autoTickMs: 0,
      flushIntervalMs: 1,
      idleActions: [],
      idleEye: true,
      idleParams: {
        headX: { inputName: 'FaceAngleX', min: -30, max: 30 },
        eyeOpenL: { inputName: 'EyeOpenLeft', min: 0, max: 1 },
      },
      style: {
        amplitude: 1.2,
        channels: {
          headX: { amplitude: 1 },
          eyeOpenL: { amplitude: 0.5 },
          bodyX: { amplitude: 0.4 },
        },
      },
    },
  });
  const before = runtime.snapshot().channels;
  assert.deepEqual(before.effectiveAmplitude, { headX: 1, eyeOpenL: 0.5 });
  assert.equal(runtime.setStatus('tired').ok, true);
  runtime.tick(1000);
  const after = runtime.snapshot();
  assert.deepEqual(Object.keys(after.channels.effectiveAmplitude), ['headX', 'eyeOpenL'],
    'bodyX is not taken over, so it is not scaled or reported');
  approx(after.channels.effectiveAmplitude.headX, 1 * 0.55, 'tired scales headX by 0.55');
  approx(after.channels.effectiveAmplitude.eyeOpenL, 0.5 * 0.55, 'the eye keeps its own 0.5 baseline');
  assert.deepEqual(after.style.baseline.channels,
    { headX: { amplitude: 1 }, eyeOpenL: { amplitude: 0.5 }, bodyX: { amplitude: 0.4 } },
    'state scaling never rewrites the persona baseline');
  console.log(
    `[style] channel-status tired=${ampMap(after.channels)} baseline=${JSON.stringify(after.style.baseline.channels)}`
    + ` bodyX=not-controlled`,
  );
  runtime.dispose();
});

// ---------------------------------------------------------------------------------------------
// 20-21. intent axis direction (P2: a nod is pitch, not yaw)
// ---------------------------------------------------------------------------------------------

test('20. nod 走俯仰轴：headY 非零、headX 恒为 0、headZ 仅轻微', () => {
  assert.deepEqual([...INTENT_CHANNEL_TARGETS.nod], ['headY', 'headZ'],
    'the nod mapping is pitch plus a trace of roll (never headX)');
  const runtime = createBehaviorRuntime({
    config: {
      style: { amplitude: 1, nodAmplitude: 1 },
      random: () => 0.5,
      idleActions: [],
      // Zero out the idle base so the measurement isolates the intent's own channel choice.
      idleSwayScale: 0,
    },
  });
  runtime.tick(1000);
  const info = runtime.intent('nod');
  assert.equal(info.ok, true);
  let peakX = 0;
  let peakY = 0;
  let peakZ = 0;
  const samples = [];
  for (let elapsed = 33; elapsed <= info.durationMs; elapsed += 33) {
    const pose = runtime.tick(1000 + elapsed);
    peakX = Math.max(peakX, Math.abs(pose.headX));
    peakY = Math.max(peakY, Math.abs(pose.headY));
    peakZ = Math.max(peakZ, Math.abs(pose.headZ));
    samples.push({ elapsed, headX: pose.headX, headY: pose.headY, headZ: pose.headZ });
  }
  assert.ok(peakY > 0.05, `the nod moves the pitch axis (headY peak ${peakY})`);
  assert.equal(peakX, 0, `a nod never turns the head left/right (headX peak ${peakX})`);
  assert.ok(peakZ > 0, 'the slight roll is present');
  assert.ok(peakZ < peakY * 0.3, `roll stays a trace (headZ ${peakZ} vs headY ${peakY})`);
  // Direction, not just size: at the envelope peak the pitch is positive (sign 1) and the trace
  // roll shares that sign.
  const mid = samples.reduce((best, sample) =>
    (Math.abs(sample.headY) > Math.abs(best.headY) ? sample : best), samples[0]);
  assert.ok(mid.headY > 0, `mid-nod pitch is positive (${mid.headY})`);
  assert.ok(mid.headZ > 0, 'the trace roll shares the nod direction');
  console.log(
    `[style] nod-axis headYPeak=${peakY.toFixed(4)} headXPeak=${peakX}`
    + ` headZPeak=${peakZ.toFixed(4)} mid=(y=${mid.headY.toFixed(4)},z=${mid.headZ.toFixed(4)})`,
  );
});

test('21. tilt 走左右+侧倾：headX/headZ 变化、headY 不动（回归）', () => {
  assert.deepEqual([...INTENT_CHANNEL_TARGETS.tilt], ['headX', 'headZ']);
  const runtime = createBehaviorRuntime({
    config: {
      style: { amplitude: 1, nodAmplitude: 1 },
      random: () => 0.5,
      idleActions: [],
      idleSwayScale: 0,
    },
  });
  runtime.tick(1000);
  const info = runtime.intent('tilt');
  assert.equal(info.ok, true);
  let peakX = 0;
  let peakY = 0;
  let peakZ = 0;
  const samples = [];
  for (let elapsed = 33; elapsed <= info.durationMs; elapsed += 33) {
    const pose = runtime.tick(1000 + elapsed);
    peakX = Math.max(peakX, Math.abs(pose.headX));
    peakY = Math.max(peakY, Math.abs(pose.headY));
    peakZ = Math.max(peakZ, Math.abs(pose.headZ));
    samples.push({ headX: pose.headX, headY: pose.headY, headZ: pose.headZ });
  }
  assert.ok(peakX > 0.02, `tilt turns the head sideways (headX peak ${peakX})`);
  assert.ok(peakZ > 0, 'tilt rolls the head');
  assert.ok(peakZ > peakX, `roll is the primary tilt axis (headZ ${peakZ} > headX ${peakX})`);
  assert.equal(peakY, 0, `tilt never touches the pitch axis (headY peak ${peakY})`);
  const mid = samples.reduce((best, sample) =>
    (Math.abs(sample.headZ) > Math.abs(best.headZ) ? sample : best), samples[0]);
  assert.ok(mid.headX > 0 && mid.headZ > 0, 'yaw and roll share the intent direction');
  console.log(
    `[style] tilt-axis headXPeak=${peakX.toFixed(4)} headYPeak=${peakY}`
    + ` headZPeak=${peakZ.toFixed(4)} mid=(x=${mid.headX.toFixed(4)},z=${mid.headZ.toFixed(4)})`,
  );
});

// ---------------------------------------------------------------------------------------------
// 22-24. style-cache version race (P2: a late old version must never win)
// ---------------------------------------------------------------------------------------------

test('22. 迟到结果：旧版本生成最后返回也不写库不安装，最新版本生效', async () => {
  const events = [];
  const persisted = [];
  const calls = [];
  const gates = new Map();
  const cache = createAvatarStyleCache({
    generate: async ({ personaText, version }) => {
      calls.push({ personaText, version });
      const gate = deferred();
      gates.set(version, gate);
      return gate.promise;
    },
    persist: (state) => persisted.push(JSON.parse(JSON.stringify(state))),
    onEvent: (type, payload) => events.push({ type, payload }),
  });
  const personaA = '人设 A：旧版本，活泼';
  const personaB = '人设 B：新版本，沉稳';
  const vA = personaStyleVersion(personaA);
  const vB = personaStyleVersion(personaB);

  const pendingA = cache.refresh(personaA);
  await flushMicrotasks();
  assert.deepEqual(calls.map((entry) => entry.version), [vA]);
  const pendingB = cache.refresh(personaB);
  await flushMicrotasks();
  assert.deepEqual(calls.map((entry) => entry.version), [vA, vB], 'the new version generates once');
  assert.equal(cache.snapshot().targetVersion, vB, 'the newest target version is recorded');

  // The new persona settles first and is installed.
  gates.get(vB).resolve(JSON.stringify({ amplitude: 1.4, nodAmplitude: 1.2 }));
  const resultB = await pendingB;
  assert.equal(resultB.generated, true);
  assert.equal(resultB.styleVersion, vB);
  assert.equal(cache.style.amplitude, 1.4);
  const installed = {
    style: JSON.stringify(cache.style),
    styleVersion: cache.snapshot().styleVersion,
    persistCalls: cache.snapshot().persistCalls,
  };

  // The old persona lands late: it must be dropped at commit.
  gates.get(vA).resolve(JSON.stringify({ amplitude: 0.3, tempo: 0.6 }));
  const resultA = await pendingA;
  assert.equal(resultA.dropped, true);
  assert.equal(resultA.reason, 'stale-persona');
  assert.equal(cache.snapshot().styleVersion, vB, 'the installed style version is untouched');
  assert.equal(cache.snapshot().personaVersion, vB);
  assert.equal(JSON.stringify(cache.style), installed.style, 'the late result never overwrites the style');
  assert.equal(cache.snapshot().persistCalls, installed.persistCalls, 'a dropped result is never persisted');
  assert.deepEqual(persisted.map((state) => state.styleVersion), [vB], 'storage holds only the new version');
  assert.equal(persisted[0].style.amplitude, 1.4);
  const dropped = events.find((entry) => entry.type === 'avatar.style.dropped'
    && entry.payload.version === vA);
  assert.ok(dropped, 'avatar.style.dropped is recorded for the stale result');
  assert.equal(dropped.payload.reason, 'stale-persona');
  assert.equal(dropped.payload.targetVersion, vB);
  assert.equal(cache.snapshot().modelCalls, 2, 'both generations were real model calls');
  console.log(
    `[style] late-drop vA=${vA} vB=${vB} dropped=${resultA.dropped}`
    + ` storedVersion=${cache.snapshot().styleVersion} storedAmplitude=${cache.style.amplitude}`
    + ` persistCalls=${cache.snapshot().persistCalls} modelCalls=${cache.snapshot().modelCalls}`,
  );
});

test('23. 提交前校验：安装前人设已变 → dropped 事件、不覆盖已安装风格', async () => {
  const events = [];
  const persisted = [];
  const gates = new Map();
  const persona0 = '人设 0：基线';
  const personaA = '人设 A：迟到版本';
  const personaB = '人设 B：最新版本';
  const v0 = personaStyleVersion(persona0);
  const vA = personaStyleVersion(personaA);
  const vB = personaStyleVersion(personaB);
  const cache = createAvatarStyleCache({
    generate: async ({ version }) => {
      if (version === v0) return JSON.stringify({ amplitude: 0.9 });
      const gate = deferred();
      gates.set(version, gate);
      return gate.promise;
    },
    persist: (state) => persisted.push(JSON.parse(JSON.stringify(state))),
    onEvent: (type, payload) => events.push({ type, payload }),
  });

  const base = await cache.refresh(persona0);
  assert.equal(base.styleVersion, v0);
  assert.equal(cache.style.amplitude, 0.9);
  const installed = {
    style: JSON.stringify(cache.style),
    styleVersion: cache.snapshot().styleVersion,
    persistCalls: cache.snapshot().persistCalls,
  };

  const pendingA = cache.refresh(personaA);
  await flushMicrotasks();
  const pendingB = cache.refresh(personaB);
  await flushMicrotasks();
  // The old persona finishes BEFORE the new one: the commit guard alone must reject it.
  gates.get(vA).resolve(JSON.stringify({ amplitude: 0.2 }));
  const resultA = await pendingA;
  assert.equal(resultA.dropped, true);
  assert.equal(resultA.reason, 'stale-persona');
  assert.equal(JSON.stringify(cache.style), installed.style, 'the installed style is not overwritten');
  assert.equal(cache.snapshot().styleVersion, installed.styleVersion, 'styleVersion is untouched');
  assert.equal(cache.snapshot().persistCalls, installed.persistCalls, 'no persist for the dropped run');
  assert.equal(persisted.length, 1, 'only the baseline has been stored so far');
  const dropped = events.find((entry) => entry.type === 'avatar.style.dropped'
    && entry.payload.version === vA);
  assert.ok(dropped, 'avatar.style.dropped is recorded before install');
  assert.equal(dropped.payload.reason, 'stale-persona');

  // The newest version still lands afterwards.
  gates.get(vB).resolve(JSON.stringify({ amplitude: 1.1 }));
  const resultB = await pendingB;
  assert.equal(resultB.generated, true);
  assert.equal(resultB.styleVersion, vB);
  assert.equal(cache.style.amplitude, 1.1);
  assert.deepEqual(persisted.map((state) => state.styleVersion), [v0, vB],
    'storage holds the baseline and the newest version only');
  console.log(
    `[style] commit-guard dropped=${resultA.dropped} reason=${resultA.reason}`
    + ` keptVersion=${installed.styleVersion} stored=${JSON.stringify(persisted.map((s) => s.styleVersion))}`
    + ` finalAmplitude=${cache.style.amplitude} droppedCount=${cache.snapshot().dropped}`,
  );
});

test('24. 同版本并发：共享在途生成，模型只调用一次', async () => {
  let calls = 0;
  let gate = null;
  const persisted = [];
  const cache = createAvatarStyleCache({
    generate: async () => {
      calls += 1;
      gate = deferred();
      return gate.promise;
    },
    persist: (state) => persisted.push(state),
  });
  const persona = '同一个活泼人设';
  const first = cache.refresh(persona);
  const second = cache.refresh(persona);
  await flushMicrotasks();
  assert.equal(calls, 1, 'two same-version refreshes share one generate() call');
  gate.resolve(JSON.stringify({ amplitude: 1.25 }));
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.styleVersion, personaStyleVersion(persona));
  assert.equal(a.styleVersion, b.styleVersion, 'both callers receive the same result');
  assert.equal(a.style.amplitude, 1.25);
  assert.equal(b.style.amplitude, 1.25);
  assert.equal(cache.snapshot().modelCalls, 1, 'the shared generation is counted once');
  assert.equal(cache.snapshot().persistCalls, 1, 'the shared generation persists once');
  console.log(
    `[style] same-version generateCalls=${calls} modelCalls=${cache.snapshot().modelCalls}`
    + ` persistCalls=${cache.snapshot().persistCalls} styleVersion=${a.styleVersion}`,
  );
});

test('25. surprise 映射：eyeOpen 全开 + headZ 侧倾（只写已接管通道）', async () => {
  const fake = createFakeTransport();
  let clock = 1000;
  const runtime = await connectRuntime({
    transport: fake.transport,
    now: () => clock,
    config: {
      autoTickMs: 0,
      flushIntervalMs: 1,
      idleActions: [],
      // Isolate the intent: no idle head/eye curve, and eye writes stay opt-out for idle.
      idleSwayScale: 0,
      idleParams: {
        eyeOpenL: { inputName: 'EyeOpenLeft', min: 0, max: 1 },
        headZ: { inputName: 'FaceAngleZ', min: -30, max: 30 },
      },
    },
  });
  const controlled = runtime.snapshot().channels.controlled;
  assert.ok(controlled.includes('eyeOpenL') && controlled.includes('headZ'),
    'both surprise channels are taken over');
  fake.writes.length = 0;
  fake.batches.length = 0;

  const info = runtime.intent('surprise');
  assert.equal(info.ok, true);
  assert.deepEqual([...info.channels].sort(), ['eyeOpenL', 'headZ'],
    'surprise maps to eyeOpen + headZ only');
  for (let step = 1; step <= 8; step += 1) {
    clock = 1000 + step * 100;
    runtime.tick(clock);
    await flushMicrotasks();
  }
  const entries = fake.batches.flat();
  const eyeWrites = entries.filter((entry) => entry.channel === 'eyeOpenL');
  const rollWrites = entries.filter((entry) => entry.channel === 'headZ');
  assert.ok(eyeWrites.length > 0, 'the verified eye channel is written');
  assert.ok(eyeWrites.every((entry) => entry.value === 1),
    `the eyes stay fully open (${eyeWrites.map((entry) => entry.value).join(',')})`);
  assert.ok(rollWrites.length > 0, 'the verified roll channel is written');
  assert.ok(rollWrites.some((entry) => entry.value < 0), 'the headZ recoil is negative');
  console.log(
    `[style] surprise channels=${info.channels.join(',')} eyeWrites=${eyeWrites.length}`
    + ` eyeValue=${eyeWrites[0]?.value} headZ=${Math.min(...rollWrites.map((entry) => entry.value)).toFixed(2)}`,
  );
  runtime.dispose();
});

// ---------------------------------------------------------------------------------------------
// 26-29. style source: the persona actually injected (box first, snapshot only as fallback)
// ---------------------------------------------------------------------------------------------

test('26. 风格来源=文本框：文本「活泼」优先于快照「沉稳」', () => {
  const snapshotText = '## 人设（自动整理）\n你是一个沉稳的助手。\n## 用户偏好（自动整理）\n用户喜欢茶。';
  const source = resolveAvatarStyleText({ boxText: '你是一个活泼的助手，说话轻快。', snapshotText });
  assert.equal(source.kind, 'box', 'a non-empty box is the source');
  assert.equal(source.text, '你是一个活泼的助手，说话轻快。');
  const prompt = buildAvatarStylePrompt({ personaText: source.text }).prompt;
  assert.ok(prompt.includes('活泼'), 'the style input carries the current box persona');
  assert.equal(prompt.includes('沉稳'), false, 'the old snapshot persona is ignored');
  assert.equal(prompt.includes('用户喜欢茶'), false, 'profile content never reaches the style input');
  console.log(
    `[style] source-wins kind=${source.kind} chars=${source.chars} input="${source.text}"`
    + ` hasLively=${prompt.includes('活泼')} hasCalm=${prompt.includes('沉稳')}`,
  );
});

test('27. 文本框为空时回退库快照，来源事件 kind=snapshot', () => {
  const events = [];
  const readSource = createAvatarStyleTextSource({
    readBox: () => '   ',
    readSnapshot: () => '## 人设（自动整理）\n你是一个沉稳的助手。',
    onEvent: (type, payload) => events.push({ type, payload }),
  });
  const source = readSource();
  assert.equal(source.kind, 'snapshot', 'an empty box falls back to the library snapshot');
  assert.equal(source.text, '你是一个沉稳的助手。');
  assert.deepEqual(events, [{ type: AVATAR_STYLE_SOURCE_EVENT, payload: { kind: 'snapshot', chars: source.chars } }],
    'the fallback is recorded with its source kind');
  readSource();
  assert.equal(events.length, 1, 'an unchanged source is not re-emitted on every tick');
  console.log(
    `[style] snapshot-fallback kind=${source.kind} chars=${source.chars}`
    + ` event=${events[0].type}/${events[0].payload.kind}/${events[0].payload.chars} emitted=${events.length}`,
  );
});

test('28. 快照回退排除用户画像内容', () => {
  const snapshotText = '## 人设（自动整理）\n你是一个活泼的助手。\n- 你说话像朋友。\n'
    + '## 用户偏好（自动整理）\n用户喜欢茶。\n- 用户周末爬山。';
  const source = resolveAvatarStyleText({ boxText: '', snapshotText });
  const prompt = buildAvatarStylePrompt({ personaText: source.text }).prompt;
  assert.equal(source.kind, 'snapshot');
  assert.ok(prompt.includes('活泼'), 'the assistant persona section survives');
  assert.ok(prompt.includes('你说话像朋友'), 'assistant persona lines survive');
  for (const userLine of ['用户喜欢茶', '用户周末爬山', '用户偏好']) {
    assert.equal(source.text.includes(userLine), false, `${userLine} is not style input`);
    assert.equal(prompt.includes(userLine), false, `${userLine} is not in the generation prompt`);
  }
  assert.equal(assistantPersonaFromSnapshot(snapshotText).includes('用户'), false);
  console.log(
    `[style] profile-excluded chars=${source.chars}`
    + ` input="${source.text.replace(/\n/gu, ' / ')}" hasProfile=${source.text.includes('用户')}`,
  );
});

test('29. 保存新人设后，下一次刷新使用最新文本框文本且版本随之变化', async () => {
  let boxText = '旧人设：沉稳寡言。';
  const snapshotText = '## 人设（自动整理）\n旧快照：沉稳。\n## 用户偏好（自动整理）\n用户喜欢茶。';
  const events = [];
  const readSource = createAvatarStyleTextSource({
    readBox: () => boxText,
    readSnapshot: () => snapshotText,
    onEvent: (type, payload) => events.push({ type, payload }),
  });
  const generated = [];
  const cache = createAvatarStyleCache({
    generate: async ({ personaText, version }) => {
      generated.push({ personaText, version });
      return '{"amplitude":1.0}';
    },
  });

  const before = readSource();
  await cache.refresh(before.text);
  const versionBefore = cache.snapshot().personaVersion;
  assert.equal(before.kind, 'box');
  assert.equal(generated.at(-1).personaText, boxText);

  // 「保存」 writes the new persona box; the next background refresh must read that, not the snapshot.
  boxText = '新人设：活泼爱笑。';
  const after = readSource();
  await cache.refresh(after.text);

  assert.equal(after.kind, 'box');
  assert.equal(generated.at(-1).personaText, boxText, 'the next generation receives the saved text');
  assert.ok(generated.at(-1).personaText.includes('活泼'));
  assert.equal(generated.at(-1).personaText.includes('沉稳'), false, 'the old snapshot never leaks in');
  assert.notEqual(cache.snapshot().personaVersion, versionBefore, 'the persona version changes with the text');
  assert.equal(cache.snapshot().personaVersion, personaStyleVersion(boxText));
  assert.equal(events.at(-1).payload.kind, 'box');
  assert.equal(events.at(-1).payload.chars, boxText.length);
  console.log(
    `[style] save-refresh version=${versionBefore} -> ${cache.snapshot().personaVersion}`
    + ` input="${generated.at(-1).personaText}" kind=${events.at(-1).payload.kind} chars=${events.at(-1).payload.chars}`,
  );
});

// ---------------------------------------------------------------------------------------------
// 30-35. voice never resets an action — speech only drives the mouth
// ---------------------------------------------------------------------------------------------
//
// Contract under test:
//   - a discrete action runs on its OWN clock: a new sentence can neither restart nor cut it;
//   - the idle rhythm keeps running while the mouth speaks (speech no longer zeroes it);
//   - actions are serial: one at a time, the next starts only after the previous one ended;
//   - `setStatus('speaking')` scales the pose, never the scheduler;
//   - only an explicit interrupt/cancel records `avatar.action.interrupted {by}`.

/**
 * Facade runtime with a deterministic clock and a fast action rhythm (100 ms interval, 600 ms per
 * action), so no test depends on wall time. `drive` steps 30 ms at a time like a 30 Hz ticker.
 */
const connectActionRuntime = async (config = {}) => {
  let clock = 0;
  const fake = createFakeTransport();
  const runtime = await connectRuntime({
    transport: fake.transport,
    now: () => clock,
    config: {
      autoTickMs: 0,
      flushIntervalMs: 100,
      idleActions: ['nod'],
      idleActionIntervalMs: 100,
      idleActionDedupeMs: 0,
      actionDurationMs: 600,
      ...config,
    },
  });
  const drive = (from, to, step = 30) => {
    for (let at = from; at <= to; at += step) {
      clock = at;
      runtime.tick(at);
    }
  };
  const driveAsync = async (from, to, step = 30) => {
    for (let at = from; at <= to; at += step) {
      clock = at;
      runtime.tick(at);
      await flushMicrotasks();
    }
  };
  return { runtime, fake, drive, driveAsync, setAt: (at) => { clock = at; } };
};

const actionEvents = (runtime) => runtime.takeEvents()
  .filter((event) => String(event.type).startsWith('avatar.action.'));

test('30. 连续两句：第一句期间启动的动作活到第二句之后，只 start 一次、不重启', async () => {
  const { runtime, drive } = await connectActionRuntime();
  drive(0, 120);
  const started = runtime.snapshot().actions;
  assert.equal(started.started, 1, 'one action started during the first sentence');
  assert.equal(started.current?.name, 'nod');
  const firstStartedAt = started.current.startedAt;
  assert.equal(runtime.takeActions().length, 1, 'the host is asked to play it exactly once');

  const sentence1 = await runtime.speak({ text: '第一句正在说话', durationMs: 300, startedAt: 130 });
  assert.equal(sentence1.ok, true);
  drive(120, 320);
  const sentence2 = await runtime.speak({ text: '第二句换句了', durationMs: 300, startedAt: 350 });
  assert.equal(sentence2.ok, true, 'the second sentence opens its own mouth session');
  drive(330, 660);

  const mid = runtime.snapshot();
  assert.equal(mid.actions.started, 1, 'the sentence switch did not start a second action');
  assert.equal(mid.actions.ended, 0, 'the action is still running');
  assert.equal(mid.actions.current.startedAt, firstStartedAt, 'it is the SAME action, not a restart');
  assert.equal(mid.actions.waiting, 1, 'the queued candidate survives the sentence switch');
  assert.equal(runtime.takeActions().length, 0, 'no second trigger was queued');
  const beforeEnd = actionEvents(runtime);
  assert.equal(beforeEnd.filter((event) => event.type === 'avatar.action.start').length, 1,
    'exactly one avatar.action.start before the end');

  drive(690, 700);
  const afterEnd = actionEvents(runtime);
  const end = afterEnd.find((event) => event.type === 'avatar.action.end');
  assert.ok(end !== undefined, 'the action ends on its own clock');
  assert.equal(end.name, 'nod');
  assert.equal(end.interrupted, false, 'a completed action is not "interrupted"');
  assert.ok(end.at > 350, `the end lands AFTER the second sentence started (end at ${end.at})`);
  assert.equal(afterEnd.some((event) => event.type === 'avatar.action.interrupted'), false);
  console.log(
    `[action] two-sentences start=${mid.actions.started} restart=${mid.actions.current.startedAt - firstStartedAt}`
    + ` endAt=${end.at} secondSentenceAt=350 interruptedEvents=${afterEnd.some((e) => e.type === 'avatar.action.interrupted')}`,
  );
  runtime.dispose();
});

test('31. 说话期间 idle 帧继续、口型帧同时存在，且口型写入优先', async () => {
  const { runtime, fake } = await connectActionRuntime({
    idleParams: {
      headX: { inputName: 'FaceAngleX', min: -30, max: 30 },
      mouth: { inputName: 'MouthOpen', min: 0, max: 1 },
    },
  });
  const spoken = await runtime.speak({ text: '说话期间也要有微动', durationMs: 900, startedAt: 0 });
  assert.equal(spoken.ok, true);
  const rows = [];
  for (let at = 0; at <= 900; at += 30) {
    const pose = runtime.tick(at);
    await flushMicrotasks();
    rows.push({ at, pose });
  }
  const idleFrames = rows.filter(({ pose }) => Math.abs(pose.headX) > 1e-4
    || Math.abs(pose.headY) > 1e-4 || Math.abs(pose.bodyX) > 1e-4);
  const mouthFrames = rows.filter(({ pose }) => pose.mouth > 0);
  const both = rows.filter(({ pose }) => pose.mouth > 0
    && (Math.abs(pose.headX) > 1e-4 || Math.abs(pose.bodyX) > 1e-4));
  assert.ok(idleFrames.length > 0, `idle micro-motion continues while speaking (${idleFrames.length})`);
  assert.ok(mouthFrames.length > 0, `lip-sync frames exist at the same time (${mouthFrames.length})`);
  assert.ok(both.length > 0, 'an idle frame and a mouth frame share the same tick');

  const snap = runtime.snapshot();
  assert.equal(snap.speech.speaking, true);
  assert.ok(snap.idleParams.frames > 0, 'idle PARAM frames keep being written while the mouth speaks');
  assert.ok(snap.idleParams.reducedBySpeech > 0, 'those frames are written at the reduced speech scale');
  for (const batch of fake.batches) {
    const inputs = batch.map((entry) => entry.input);
    assert.equal(new Set(inputs).size, inputs.length, `duplicate input in one frame: ${inputs.join(',')}`);
  }
  assert.ok(snap.inner.idleActions.emitted >= 1, 'the idle action rhythm keeps sampling while speaking');
  assert.ok(snap.actions.started >= 1, 'an action still starts during speech (micro-motion not zeroed)');
  console.log(
    `[idle] duringSpeech idleFrames=${idleFrames.length} mouthFrames=${mouthFrames.length}`
    + ` both=${both.length} idleParamFrames=${snap.idleParams.frames}`
    + ` reducedBySpeech=${snap.idleParams.reducedBySpeech} actions=${snap.actions.started}`,
  );
  runtime.dispose();
});

test('32. 动作串行：动作未结束不开始新动作，结束后才接上下一个', async () => {
  const { runtime, drive } = await connectActionRuntime();
  drive(0, 120);
  assert.equal(runtime.snapshot().actions.started, 1, 'one action is running');
  const first = runtime.snapshot().actions.current;

  const startedDuring = [];
  for (let at = 150; at <= 660; at += 30) {
    drive(at, at);
    startedDuring.push(runtime.snapshot().actions.started);
  }
  assert.deepEqual([...new Set(startedDuring)], [1], 'no second action starts while the first runs');
  assert.equal(runtime.snapshot().actions.ended, 0, 'the first action has not ended yet');
  assert.equal(runtime.snapshot().actions.waiting, 1, 'a candidate waits in the single slot');

  drive(690, 690);
  const after = runtime.snapshot().actions;
  assert.equal(after.started, 2, 'the next action starts only after the previous one ended');
  assert.equal(after.ended, 1);
  assert.ok(after.current.startedAt >= first.startedAt + first.durationMs,
    'the new action begins at/after the previous end, so the two can never overlap');
  const events = actionEvents(runtime);
  const endIndex = events.findIndex((event) => event.type === 'avatar.action.end');
  const secondStartIndex = events.findIndex((event) => event.type === 'avatar.action.start' && event.seq === 2);
  assert.ok(endIndex >= 0 && secondStartIndex > endIndex, 'event order proves serialization');
  assert.equal(events[endIndex].interrupted, false);
  console.log(
    `[action] serial started=${after.started} ended=${after.ended} overlapping=0`
    + ` waitBetween=${after.current.startedAt - (first.startedAt + first.durationMs)}ms`
    + ` order=end@${events[endIndex].at}->start@${events[secondStartIndex].at}`,
  );
  runtime.dispose();
});

test('33. 换句不改变基线风格与意图状态，setStatus 只缩放不重启调度', async () => {
  const { runtime, drive } = await connectActionRuntime({ style: { amplitude: 0.8, tempo: 1.2 } });
  const intent = { gaze: { x: 0.4, y: -0.25 }, flags: { idle: true } };
  runtime.setIntent(intent);
  const before = runtime.snapshot();
  await runtime.speak({ text: '第一句', durationMs: 300, startedAt: 130 });
  drive(120, 320);
  runtime.setStatus('speaking', 'playback.start');
  const afterStatus = runtime.snapshot();
  await runtime.speak({ text: '第二句换句', durationMs: 300, startedAt: 350 });
  drive(330, 660);
  const after = runtime.snapshot();

  assert.deepEqual(after.style.baseline, before.style.baseline, 'the persona baseline is untouched');
  assert.equal(after.style.version, before.style.version, 'the style version does not change per sentence');
  assert.deepEqual(after.inner.intent.gaze, intent.gaze, 'the intent survives the sentence switch');
  assert.deepEqual(after.inner.intent.flags, { idle: true, breathing: true });
  assert.equal(after.status, 'speaking', 'status is a temporary scale, never a style rewrite');
  assert.equal(after.actions.started, afterStatus.actions.started,
    'setStatus("speaking") neither restarts nor re-samples the action scheduler');
  assert.equal(after.actions.ended, afterStatus.actions.ended, 'and it ends nothing');
  console.log(
    `[action] switch baselineChanged=${JSON.stringify(after.style.baseline) !== JSON.stringify(before.style.baseline)}`
    + ` intent=${JSON.stringify(after.inner.intent.gaze)} status=${after.status}`
    + ` startedAtStatus=${afterStatus.actions.started} startedAtEnd=${after.actions.started}`
    + ` ended=${after.actions.ended}`,
  );
  runtime.dispose();
});

test('34. 显式打断：动作 interrupted + 事件，只有真正打断才记 interrupted', async () => {
  const { runtime, drive, setAt } = await connectActionRuntime();
  drive(0, 120);
  assert.equal(runtime.snapshot().actions.started, 1);
  setAt(150);
  const cut = runtime.interrupt({ reason: 'cancel-playback' });
  assert.equal(cut.ok, true);
  assert.equal(cut.interruptedAction, true, 'the running action was actually cut');

  const events = actionEvents(runtime);
  const end = events.find((event) => event.type === 'avatar.action.end');
  assert.ok(end !== undefined);
  assert.equal(end.name, 'nod');
  assert.equal(end.interrupted, true);
  const marker = events.find((event) => event.type === 'avatar.action.interrupted');
  assert.ok(marker !== undefined, 'the interruption is recorded');
  assert.equal(marker.by, 'cancel-playback');
  const after = runtime.snapshot().actions;
  assert.equal(after.current, null);
  assert.equal(after.waiting, 0, 'the waiting candidate is dropped with the cut');
  assert.equal(after.ended, 1);
  assert.equal(after.interrupted, 1);

  const idleCut = runtime.interrupt({ reason: 'nothing-running' });
  assert.equal(idleCut.interruptedAction, false, 'nothing running → nothing interrupted');
  assert.equal(actionEvents(runtime).filter((event) => event.type === 'avatar.action.interrupted').length, 0,
    'avatar.action.interrupted is never recorded without a real cut');
  console.log(
    `[action] interrupt cut=${cut.interruptedAction} by=${marker.by} ended=${after.ended}`
    + ` interrupted=${after.interrupted} secondCutMarker=0`,
  );
  runtime.dispose();
});

test('35. 回归契约：说话期间空闲节拍照常，idle:false 仍是唯一的暂停开关', () => {
  const runtime = createBehaviorRuntime({
    config: { random: () => 0, idleActions: ['wave'], idleActionIntervalMs: 100, idleActionDedupeMs: 0 },
  });
  runtime.beginTurn();
  const advance = (from, to) => {
    for (let now = from; now <= to; now += 30) runtime.tick(now);
  };
  advance(0, 120);
  assert.equal(runtime.takeActions().length, 1, 'one idle action before speech');
  const styleBefore = runtime.snapshot().style.baseline;
  const styleVersion = runtime.snapshot().style.version;
  const session = runtime.startSpeech({ text: '说话不影响空闲节拍', durationMs: 900, startedAt: 120 });
  assert.equal(session.ok, true);
  advance(150, 900);
  const during = runtime.takeActions();
  assert.ok(during.length > 0, 'the idle rhythm keeps emitting while the mouth is speaking');
  assert.deepEqual(runtime.snapshot().style.baseline, styleBefore, 'speech never rewrites the baseline style');
  assert.equal(runtime.snapshot().style.version, styleVersion);

  runtime.setIntent({ flags: { idle: false } });
  advance(930, 1500);
  assert.equal(runtime.takeActions().length, 0, 'idle:false still queues nothing (the only off switch)');
  console.log(
    `[regression] duringSpeechActions=${during.length} baselineChanged=false`
    + ` idleOffActions=0 styleVersion=${styleVersion || '(empty)'}`,
  );
});

// ---------------------------------------------------------------------------------------------
// P-139 阶段 1 — persona differences survive the larger posture
// ---------------------------------------------------------------------------------------------

/** |headX| p50 / max over a fixed 30 Hz idle window (semantic units, same seed/persona each run). */
const headStats = (style, durationMs = 120_000) => {
  const runtime = createBehaviorRuntime({ config: { seed: 4242, idleActions: [], style } });
  const values = [];
  const components = new Map();
  for (let at = 0; at <= durationMs; at += 1000 / 30) {
    values.push(Math.abs(runtime.tick(at).headX));
    const component = runtime.snapshot().motion.posture.component;
    if (component !== null) {
      const dominantDegrees = Math.max(...Object.values(component.targetDegrees ?? {})
        .map((value) => Math.abs(value)));
      components.set(component.id, Math.max(components.get(component.id) ?? 0, dominantDegrees));
    }
  }
  const sorted = values.slice().sort((a, b) => a - b);
  return {
    p50: sorted[Math.floor(sorted.length / 2)] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    components: Object.fromEntries(components),
    motion: runtime.snapshot().motion,
  };
};

test('36. P-139 人设差异：quiet 仍小于 lively，但两者都留在可见带内', () => {
  const lively = headStats({ amplitude: 1.4, tempo: 1.5, gazeHabit: 'wandering' });
  const quiet = headStats({ amplitude: 0.5, tempo: 0.7 });
  assert.ok(lively.p50 > 0 && lively.max > 0, 'the lively persona really moves');
  assert.ok(quiet.p50 <= lively.p50 * 0.6,
    `quiet p50 ${quiet.p50.toFixed(4)} ≤ 60% of lively ${lively.p50.toFixed(4)}`);
  // The held component gives every persona an explicit visible band, so max-frame pose is no
  // longer a valid persona ratio (a quiet persona holds one component for 20 s and reaches it,
  // while lively swaps every 4 s). Compare the SAME component id instead.
  const shared = Object.keys(quiet.components).filter((id) => id in lively.components);
  assert.ok(shared.length >= 2, `shared components are comparable (${shared.join(',')})`);
  for (const id of shared) {
    assert.ok(quiet.components[id] < lively.components[id],
      `${id}: quiet ${quiet.components[id].toFixed(2)}° < lively ${lively.components[id].toFixed(2)}°`);
    assert.ok(quiet.components[id] >= 5 - 1e-6,
      `${id}: quiet still reaches the visible 5° floor (${quiet.components[id].toFixed(2)}°)`);
  }
  assert.ok(quiet.max <= lively.max * 1.3,
    `quiet max ${quiet.max.toFixed(4)} stays in the same visible class as lively ${lively.max.toFixed(4)}`);
  // A quiet persona is also allowed to hold far longer: tempo stretches its window.
  assert.ok(quiet.motion.holdMs >= lively.motion.holdMs,
    `quiet hold ${quiet.motion.holdMs}ms ≥ lively ${lively.motion.holdMs}ms`);
  console.log(
    `[p139] quiet p50=${quiet.p50.toFixed(4)} max=${quiet.max.toFixed(4)}`
    + ` lively p50=${lively.p50.toFixed(4)} max=${lively.max.toFixed(4)}`
    + ` components=${shared.map((id) => `${id}:${quiet.components[id].toFixed(2)}<${lively.components[id].toFixed(2)}`).join(',')}`
    + ` holds=${Math.round(quiet.motion.holdMs)}/${Math.round(lively.motion.holdMs)}ms`,
  );
});

test('37. P-139 待机不皱眉：brow 不在空闲写入集合，30 s 内 brow 始终为 0', () => {
  for (const channel of ['browL', 'browR']) {
    assert.equal(IDLE_WRITE_CHANNELS.includes(channel), false, `${channel} is not an idle write channel`);
    assert.equal(IDLE_PARAM_CHANNELS.includes(channel), false, `${channel} is not an idle parameter`);
  }
  const runtime = createBehaviorRuntime({
    config: { seed: 5, idleActions: [], style: { amplitude: 1.3, tempo: 1.2 } },
  });
  let browWrites = 0;
  for (let at = 0; at <= 30_000; at += 1000 / 30) {
    const pose = runtime.tick(at);
    assert.equal(pose.browL, 0, `browL stayed neutral at ${at}ms`);
    assert.equal(pose.browR, 0, `browR stayed neutral at ${at}ms`);
    if (pose.browL !== 0 || pose.browR !== 0) browWrites += 1;
  }
  assert.equal(browWrites, 0, 'the idle controller produced no brow motion');
  console.log(`[p139] brow writes=0 (idle 30 s, amplitude 1.3), channels=${IDLE_WRITE_CHANNELS.join(',')}`);
});

// ---------------------------------------------------------------------------------------------
// P-139 stage 3 — persona-derived dimensions (stable seed, direction, snapshot/event)
// ---------------------------------------------------------------------------------------------

test('38. P-139 风格维度：同人设两次初始化一致，安静/活泼方向正确，事件与 snapshot 同值', () => {
  const quietStyle = {
    amplitude: 0.55, tempo: 0.8, nodAmplitude: 0.5, expressiveness: 0.6,
    tiltChance: 0.05, nodDurationMs: 700,
  };
  const livelyStyle = {
    amplitude: 1.35, tempo: 1.35, nodAmplitude: 1.3, expressiveness: 1.4,
    tiltChance: 0.4, nodDurationMs: 350,
  };
  const quietVersion = personaStyleVersion('安静、克制的人设');
  const livelyVersion = personaStyleVersion('活泼、爱笑的人设');
  const open = (style, styleVersion) => createBehaviorRuntime({
    config: { style, styleVersion, idleActions: [] },
  });

  const first = open(quietStyle, quietVersion);
  const second = open(quietStyle, quietVersion);
  const quiet = first.snapshot().style.dimensions;
  const again = second.snapshot().style.dimensions;
  assert.deepEqual(quiet, again, 'the same persona yields the exact same dimensions');
  assert.equal(quiet.seed, again.seed, 'the seed is stable for the same persona version');
  assert.equal(quiet.seed, deriveAvatarStyleDimensions(quietStyle, { styleVersion: quietVersion }).seed,
    'the snapshot seed is the pure derivation');
  // The initial dimensions are emitted before the first tick.
  const initial = first.takeEvents().filter((entry) => entry.type === 'avatar.style.dimensions');
  assert.equal(initial.length, 1, 'one dimensions event at initialisation');
  assert.deepEqual(
    { liveliness: initial[0].liveliness, softness: initial[0].softness, restraint: initial[0].restraint, seed: initial[0].seed },
    quiet,
    'the event carries exactly the snapshot dimensions',
  );

  const lively = open(livelyStyle, livelyVersion).snapshot().style.dimensions;
  assert.ok(lively.liveliness > quiet.liveliness,
    `liveliness is higher for the lively persona (${quiet.liveliness} < ${lively.liveliness})`);
  assert.ok(quiet.restraint > lively.restraint,
    `restraint is higher for the quiet persona (${lively.restraint} < ${quiet.restraint})`);
  assert.ok(quiet.softness > lively.softness,
    `the quiet persona is softer (${lively.softness} < ${quiet.softness})`);
  assert.notEqual(quiet.seed, lively.seed, 'different personas get different seeds');
  for (const value of [quiet.liveliness, quiet.softness, quiet.restraint,
    lively.liveliness, lively.softness, lively.restraint]) {
    assert.ok(value >= 0 && value <= 1, `every dimension stays in [0, 1] (${value})`);
  }

  // A style refresh re-derives and re-publishes the dimensions, not just the style.
  first.setStyle(livelyStyle, { styleVersion: livelyVersion });
  const refreshed = first.snapshot().style.dimensions;
  assert.deepEqual(refreshed, lively, 'setStyle installs the new persona dimensions');
  const applied = first.takeEvents().filter((entry) => entry.type === 'avatar.style.dimensions');
  assert.equal(applied.length, 1, 'the refresh emits one dimensions event');
  assert.equal(applied[0].seed, lively.seed, 'the event seed follows the new persona');
  console.log(
    `[p139] dimensions quiet(seed=${quiet.seed},live=${quiet.liveliness},soft=${quiet.softness},rest=${quiet.restraint})`
    + ` lively(seed=${lively.seed},live=${lively.liveliness},soft=${lively.softness},rest=${lively.restraint})`,
  );
});

// ---------------------------------------------------------------------------------------------
// P-139 stage 4 — C band: only the occasional actions reach 12–14°; the idle range is unchanged
// ---------------------------------------------------------------------------------------------
test('39. P-139 阶段 4 — C 幅度：结论/疑惑 ≤14°，普通动作与待机范围不变', () => {
  const livelyStyle = {
    amplitude: 1.4, tempo: 1.5, nodAmplitude: 1.3, expressiveness: 1.4, tiltChance: 0.4, nodDurationMs: 350,
  };
  // Idle sway is switched off so the measured peak is the gesture's own contribution.
  const run = (kind, profile) => {
    const runtime = createBehaviorRuntime({
      config: { seed: 3, idleActions: [], idleSwayScale: 0, style: livelyStyle },
    });
    runtime.tick(1000);
    const info = runtime.intent(kind, { at: 1000, profile });
    assert.equal(info.ok, true, `the ${kind}/${profile ?? 'plain'} gesture starts`);
    const peaks = { headX: 0, headY: 0, headZ: 0 };
    for (let elapsed = 33; elapsed <= info.durationMs; elapsed += 33) {
      const pose = runtime.tick(1000 + elapsed);
      for (const axis of Object.keys(peaks)) peaks[axis] = Math.max(peaks[axis], Math.abs(pose[axis]));
    }
    const degrees = Math.max(peaks.headX, peaks.headY, peaks.headZ) * 30;
    return { info, peaks, degrees };
  };

  const plainNod = run('nod', null);
  const conclusion = run('nod', 'conclusion');
  const confused = run('tilt', 'confused');

  // C is scoped: this lively persona's ORDINARY nod is bigger than the occasional ceiling, and the
  // occasional actions are the ones held inside it.
  assert.equal(plainNod.info.occasional, false, 'a plain gesture is not occasional');
  assert.ok(plainNod.info.peakDegrees > OCCASIONAL_ACTION.MAX_DEGREES,
    `the ordinary nod is not capped (${plainNod.info.peakDegrees}°)`);
  assert.equal(conclusion.info.occasional, true);
  assert.equal(conclusion.info.maxDegrees, OCCASIONAL_ACTION.MAX_DEGREES);
  assert.ok(conclusion.info.peakDegrees >= OCCASIONAL_ACTION.MIN_DEGREES
    && conclusion.info.peakDegrees <= OCCASIONAL_ACTION.MAX_DEGREES,
  `the conclusion nod reports ${conclusion.info.peakDegrees}° (12–14°)`);
  assert.ok(conclusion.degrees <= OCCASIONAL_ACTION.MAX_DEGREES + 1e-6,
    `the conclusion nod stays under the ceiling (${conclusion.degrees.toFixed(3)}°)`);
  assert.ok(confused.degrees <= OCCASIONAL_ACTION.MAX_DEGREES + 1e-6,
    `the confused tilt stays under the ceiling (${confused.degrees.toFixed(3)}°)`);
  // The sideways (yaw) part of the confused tilt is the moderate one — well below a nod's pitch.
  assert.ok(confused.peaks.headX * 30 < conclusion.degrees,
    `the confused yaw ${(confused.peaks.headX * 30).toFixed(2)}° is gentler than the nod`
    + ` ${conclusion.degrees.toFixed(2)}°`);

  // The base layer is deliberately a light 1–3° sway; the held posture component owns the
  // visually larger 5–12° offset on top.
  const idle = headStats({});
  assert.ok(idle.p50 > 0.015 && idle.p50 < 0.08,
    `the default idle head p50 ${idle.p50.toFixed(4)} stays in the light base range`);
  assert.ok(idle.max > 0.10 && idle.max <= 0.42,
    `the default idle head max ${idle.max.toFixed(4)} stays inside the idle+posture cap`);
  // No new channel mapping: the shipped intent targets are exactly the stage-3 table.
  assert.deepEqual({ ...INTENT_CHANNEL_TARGETS }, {
    nod: ['headY', 'headZ'],
    lookAtUser: ['gazeX', 'gazeY'],
    tilt: ['headX', 'headZ'],
    surprise: ['eyeOpenL', 'eyeOpenR', 'headZ'],
  }, 'the stage-3 channel targets are untouched');
  assert.ok(HOLD_MICRO_DRIFT.DEGREES >= 1 && HOLD_MICRO_DRIFT.DEGREES <= 3,
    `the hold drift stays in the 1–3° trial band (${HOLD_MICRO_DRIFT.DEGREES}°)`);
  console.log(
    `[p139] bandC plain=${plainNod.info.peakDegrees}° conclusion=${conclusion.info.peakDegrees}°`
    + ` confused=${confused.info.peakDegrees}° ceiling=${OCCASIONAL_ACTION.MAX_DEGREES}°`
    + ` posedMax=${Math.max(conclusion.degrees, confused.degrees).toFixed(2)}°`
    + ` idleP50=${idle.p50.toFixed(4)} idleMax=${idle.max.toFixed(4)}`,
  );
});
