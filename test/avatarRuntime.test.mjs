/**
 * Unit tests for the pure behavior runtime (stage 1: no VTS, no I/O, no timers).
 *
 *   node --test test/avatarRuntime.test.mjs
 *
 * Covers the invariants the spec calls out in §F.5 plus the two structural ones this stage is
 * responsible for: the eye multiply chain (expression first, blink second) and the token-based
 * interrupt. Stage-1 completion adds the single mouth sender, per-session mouth tokens,
 * startSpeech/endSpeech zeroing, idle-action dedupe and isolated transport writes.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ARBITRATION,
  AVATAR_ERROR_CODES,
  BLINK,
  CHANNELS,
  LIMITS,
  TIMING,
  clamp01,
  composeChannels,
  createBlinkState,
  createAvatarRuntime,
  createBehaviorRuntime,
  smoothstep,
  springParams,
  stepBlink,
  stepSpringAxis,
  toInputValue,
} from '../src/host/avatar/avatarRuntime.js';

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

const approx = (actual, expected, message = '', epsilon = 1e-9) => {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `${message} expected ${expected}, got ${actual}`,
  );
};

/** Advance the blink machine in fixed sub-millisecond steps; returns the last `{factor, state}`. */
const advanceBlink = (state, milliseconds, { stepMs = 1, random = () => 0 } = {}) => {
  let current = state;
  let last = { factor: 1, state: current };
  const steps = Math.round(milliseconds / stepMs);
  for (let index = 0; index < steps; index += 1) {
    last = stepBlink(current, stepMs / 1000, { random });
    current = last.state;
  }
  return last;
};

/** Generators shaped like advanceGenerators() output, for direct composeChannels tests. */
const generatorsFor = (factor, extra = {}) => ({
  blink: { factor, baseline: 1 },
  eyeBase: { left: 1, right: 1 },
  idle: {},
  ...extra,
});

const eyeOf = (pose) => ({ left: pose.eyeOpenL, right: pose.eyeOpenR });
const frameValue = (runtime, channel) => runtime.pendingFrame.get(channel);

// ---------------------------------------------------------------------------------------------
// 1. blink state machine
// ---------------------------------------------------------------------------------------------

describe('stepBlink', () => {
  it('closes to 0 within the 75 ms closing phase and reopens to 1', () => {
    const random = () => 0;
    let state = createBlinkState({ delayMs: 0, baseline: 1, random });

    // First millisecond consumes the (zero) idle delay and starts closing at p ≈ 1/75.
    const start = stepBlink(state, 0.001, { random });
    assert.equal(start.state.phase, 'closing');
    state = start.state;

    const closing = [];
    for (let elapsed = 2; elapsed <= BLINK.CLOSE_MS; elapsed += 1) {
      const step = stepBlink(state, 0.001, { random });
      state = step.state;
      closing.push(step.factor);
    }

    // 1 + 74 = 75 ms of closing: factor reaches exactly 0 and the machine hands off to opening.
    assert.equal(state.phase, 'opening');
    assert.equal(closing.at(-1), 0, 'factor must be 0 at the end of CLOSE_MS');
    for (let index = 1; index < closing.length; index += 1) {
      assert.ok(closing[index] <= closing[index - 1] + 1e-12, 'closing factor is monotone non-increasing');
    }
    assert.ok(closing[20] > 0 && closing[20] < 1, 'mid-close factor is a real easing value');

    // Opening: 150 ms because random() = 0 selects OPEN_MIN_MS.
    const opening = advanceBlink(state, BLINK.OPEN_MIN_MS, { random });
    assert.equal(opening.factor, 1, 'fully open again');
    assert.equal(opening.state.phase, 'idle');
    assert.ok(opening.state.delayMs >= BLINK.DELAY_MIN_MS && opening.state.delayMs <= BLINK.DELAY_MAX_MS);
  });

  it('keeps the idle interval inside 3000–8000 ms', () => {
    assert.equal(createBlinkState({ random: () => 0 }).delayMs, BLINK.DELAY_MIN_MS);
    const upper = createBlinkState({ random: () => 0.9999999 }).delayMs;
    assert.ok(upper > BLINK.DELAY_MIN_MS && upper <= BLINK.DELAY_MAX_MS, `upper delay ${upper}`);
    for (let draw = 0; draw < 50; draw += 1) {
      const delayMs = createBlinkState().delayMs;
      assert.ok(delayMs >= BLINK.DELAY_MIN_MS && delayMs <= BLINK.DELAY_MAX_MS, `random delay ${delayMs}`);
    }

    // The opening duration is drawn in 150–300 ms as well.
    const random = () => 0.5;
    const closing = advanceBlink(stepBlink(createBlinkState({ delayMs: 0, random }), 0.001, { random }).state,
      BLINK.CLOSE_MS, { random });
    assert.equal(closing.state.phase, 'opening');
    assert.ok(
      closing.state.duration >= BLINK.OPEN_MIN_MS && closing.state.duration <= BLINK.OPEN_MAX_MS,
      `open duration ${closing.state.duration}`,
    );
  });

  it('does not start a blink on a baseline at or below the 0.15 threshold', () => {
    const random = () => 0;
    const closedByExpression = createBlinkState({ delayMs: 0, baseline: 0.1, random });
    // 200 ms is far beyond the zero delay, yet the idle phase must not begin closing.
    const suppressed = stepBlink(closedByExpression, 0.2, { random });
    assert.equal(suppressed.factor, 1);
    assert.equal(suppressed.state.phase, 'idle');

    // Once the expression opens the eye again the machine blinks normally.
    const recovered = stepBlink({ ...suppressed.state, baseline: 1 }, 0.001, { random });
    assert.equal(recovered.state.phase, 'closing');
  });
});

// ---------------------------------------------------------------------------------------------
// 2. the eye multiply chain
// ---------------------------------------------------------------------------------------------

describe('composeChannels — eye multiply chain', () => {
  it('keeps eyeOpen at 0 when the expression closes the eye (0 × factor = 0)', () => {
    for (const factor of [1, 0.9, 0.5, 0.2, 0]) {
      const pose = composeChannels({ pose: { eyeOpen: 0 } }, generatorsFor(factor));
      assert.deepEqual(eyeOf(pose), { left: 0, right: 0 }, `blink factor ${factor}`);
    }
    // A squint must not resurrect an eye the expression closed.
    const squinted = composeChannels({ pose: { eyeOpen: 0 }, squint: 0.8 }, generatorsFor(0.5));
    assert.deepEqual(eyeOf(squinted), { left: 0, right: 0 });
  });

  it('never lets a squint push the eye below the 0.2 floor', () => {
    const squinted = composeChannels({ squint: 1 }, generatorsFor(1));
    approx(squinted.eyeOpenL, LIMITS.MIN_EYE_OPEN, 'squint floor');
    approx(squinted.eyeOpenR, LIMITS.MIN_EYE_OPEN, 'squint floor');
    assert.equal(LIMITS.MIN_EYE_OPEN, 0.2);

    const half = composeChannels({ squint: 0.5 }, generatorsFor(1));
    approx(half.eyeOpenL, 0.5, 'half squint halves the base');

    const manual = composeChannels({ pose: { eyeSquint: 0.25 } }, generatorsFor(1));
    approx(manual.eyeOpenL, 0.75, 'manual squint multiplies too');

    // Without a squint the ordinary open eye is exactly 1 and never exceeds it.
    assert.equal(composeChannels({}, generatorsFor(1)).eyeOpenL, 1);
    assert.ok(composeChannels({ squint: 0.3 }, generatorsFor(1)).eyeOpenL <= 1);
  });
});

// ---------------------------------------------------------------------------------------------
// 3. springs
// ---------------------------------------------------------------------------------------------

describe('springParams / stepSpringAxis', () => {
  it('maps follow and inertia onto k, m and critical damping', () => {
    const tight = springParams({ follow: 1, inertia: 0 });
    assert.equal(tight.stiffness, 220);
    assert.equal(tight.mass, 0.75);
    approx(tight.damping, 2 * Math.sqrt(220 * 0.75), 'ζ = 1 → c = 2√(km)');

    const loose = springParams({ follow: 0, inertia: 1 });
    assert.equal(loose.stiffness, 30);
    assert.equal(loose.mass, 3);
    // ζ = 1 - 0.75·1 = 0.25 → c = 2 · 0.25 · √(30 · 3)
    approx(loose.damping, 0.5 * Math.sqrt(90), 'ζ = 0.25');

    const mid = springParams({ follow: 0.5, inertia: 0.5 });
    approx(mid.stiffness, 125, 'k = 30 + 190·follow');
    approx(mid.mass, 1.875, 'm = 0.75 + 2.25·inertia');
    approx(mid.damping, 2 * 0.625 * Math.sqrt(125 * 1.875), 'ζ = 0.625');
  });

  it('converges monotonically without overshoot when ζ = 1', () => {
    const params = springParams({ follow: 1, inertia: 0 });
    let axis = { current: 0, velocity: 0 };
    const trace = [];
    for (let index = 0; index < 30; index += 1) {
      axis = stepSpringAxis({ ...axis, target: 1, dt: 0.01, ...params });
      trace.push(axis.current);
    }
    assert.ok(trace.every((value) => value <= 1 + 1e-12), `no overshoot: max ${Math.max(...trace)}`);
    for (let index = 1; index < trace.length; index += 1) {
      assert.ok(trace[index] >= trace[index - 1] - 1e-12, 'monotone approach to the target');
    }
    // Critically damped motion is 96% settled after 300 ms for k=220/m=0.75; 500 ms is < 1%.
    assert.ok(1 - trace.at(-1) < 0.05, `settled within 300 ms (error ${(1 - trace.at(-1)).toFixed(4)})`);
    let settled = axis;
    for (let index = 0; index < 20; index += 1) {
      settled = stepSpringAxis({ ...settled, target: 1, dt: 0.01, ...params });
    }
    assert.ok(1 - settled.current < 0.01, `settled within 500 ms (error ${(1 - settled.current).toFixed(5)})`);

    // The same holds for every follow value (ζ = 1 for all of them while inertia is 0).
    for (const follow of [0, 0.25, 0.5, 0.75, 1]) {
      const axisParams = springParams({ follow, inertia: 0 });
      let current = { current: 0, velocity: 0 };
      let peak = 0;
      for (let index = 0; index < 100; index += 1) {
        current = stepSpringAxis({ ...current, target: 1, dt: 1 / 30, ...axisParams });
        peak = Math.max(peak, current.current);
      }
      assert.ok(peak <= 1 + 1e-12, `follow ${follow}: peak ${peak} must not overshoot`);
    }
  });

  it('clamps dt to 50 ms', () => {
    const params = springParams({ follow: 1, inertia: 0 });
    const huge = stepSpringAxis({ current: 0, target: 1, velocity: 0, dt: 0.5, ...params });
    const clamped = stepSpringAxis({ current: 0, target: 1, velocity: 0, dt: LIMITS.MAX_STEP_SECONDS, ...params });
    assert.deepEqual(huge, clamped);
    assert.equal(LIMITS.MAX_STEP_SECONDS, 0.05);

    // A zero / negative frame is a no-op and must not move the axis or the velocity.
    const still = stepSpringAxis({ current: 0.25, target: 1, velocity: 2, dt: -1, ...params });
    assert.deepEqual(still, { current: 0.25, velocity: 2 });
  });
});

// ---------------------------------------------------------------------------------------------
// 4. toInputValue
// ---------------------------------------------------------------------------------------------

describe('toInputValue', () => {
  it('maps a unipolar semantic value into the input range', () => {
    assert.equal(toInputValue({ min: 0, max: 1 }, 0), 0);
    approx(toInputValue({ min: 0, max: 1 }, 0.3), 0.3, 'pass-through');
    assert.equal(toInputValue({ min: 0, max: 1 }, 1), 1);
    assert.equal(toInputValue({ min: 0, max: 1 }, 2), 1, 'clamped above');
    assert.equal(toInputValue({ min: 0, max: 1 }, -3), 0, 'clamped below');
    approx(toInputValue({ min: 0.25, max: 1 }, 0.5), 0.625, 'non-trivial range');
  });

  it('maps a bipolar semantic value onto -1 / 0 / 1', () => {
    assert.equal(toInputValue({ min: -1, max: 1 }, -1, { bidirectional: true }), -1);
    assert.equal(toInputValue({ min: -1, max: 1 }, 0, { bidirectional: true }), 0);
    assert.equal(toInputValue({ min: -1, max: 1 }, 1, { bidirectional: true }), 1);

    assert.equal(toInputValue({ min: -30, max: 30 }, -1, { bidirectional: true }), -30);
    assert.equal(toInputValue({ min: -30, max: 30 }, 0, { bidirectional: true }), 0);
    assert.equal(toInputValue({ min: -30, max: 30 }, 1, { bidirectional: true }), 30);
    approx(toInputValue({ min: -30, max: 30 }, -0.5, { bidirectional: true }), -15, 'half way');
    assert.equal(toInputValue({ min: -30, max: 30 }, 5, { bidirectional: true }), 30, 'clamped');
  });

  it('falls back to defaultValue when max <= min', () => {
    assert.equal(toInputValue({ min: 5, max: 5, defaultValue: 2 }, 0.5), 2);
    assert.equal(toInputValue({ min: 5, max: 3, defaultValue: 1.5 }, 0.5), 1.5);
    assert.equal(toInputValue({ min: 5, max: 3 }, 0.5), 5, 'no defaultValue → min');
    assert.equal(toInputValue({ min: 5, max: 5 }, 0.5, { bidirectional: true }), 5);
    // Missing fields degrade to the documented defaults (min 0, max 1).
    assert.equal(toInputValue({}, 0.4), 0.4);
    assert.equal(toInputValue(null, 0.4), 0.4);
  });
});

// ---------------------------------------------------------------------------------------------
// 5. facade lifecycle
// ---------------------------------------------------------------------------------------------

describe('createBehaviorRuntime', () => {
  it('bumps the token on beginTurn', () => {
    const runtime = createBehaviorRuntime({ config: { random: () => 0 } });
    assert.equal(runtime.snapshot().turn.token, 0);
    assert.equal(runtime.snapshot().turn.turnId, 0);

    const first = runtime.beginTurn({ reason: 'assistant_say' });
    assert.equal(first.turnId, 1);
    assert.equal(first.token, 1);
    assert.equal(runtime.snapshot().turn.token, 1);

    runtime.beginTurn({ reason: 'assistant_say' });
    assert.equal(runtime.snapshot().turn.turnId, 2);
    assert.equal(runtime.snapshot().turn.token, 2, 'token advances per turn');

    // A producer from the previous turn cannot start speech on the new one.
    const stale = runtime.setSpeech({ turnId: 1, levels: [1], startedAt: 0, durationMs: 100 });
    assert.equal(stale.ok, false);
    assert.equal(stale.reason, 'stale turn');
  });

  it('indexes the speech levels by startedAt and nowMs', () => {
    const runtime = createBehaviorRuntime({ config: { random: () => 0 } });
    const { turnId } = runtime.beginTurn();
    const levels = [0, 0.25, 0.5, 1];
    const speech = runtime.setSpeech({ turnId, levels, startedAt: 1000, durationMs: 400 });
    assert.equal(speech.ok, true);
    assert.equal(speech.frames, levels.length);
    assert.equal(TIMING.MOUTH_STEP_MS, 100);

    runtime.tick(1000); // elapsed 0    → index 0
    approx(frameValue(runtime, 'mouth'), 0, 'mouth level 0');
    runtime.tick(1100); // elapsed 100  → index 1
    approx(frameValue(runtime, 'mouth'), 0.25, 'mouth level 1');
    runtime.tick(1250); // elapsed 250  → index 2
    approx(frameValue(runtime, 'mouth'), 0.5, 'mouth level 2');
    runtime.tick(1300); // elapsed 300  → index 3
    approx(frameValue(runtime, 'mouth'), 1, 'mouth level 3');
    assert.equal(runtime.snapshot().turn.speechIndex, 3);
    assert.equal(runtime.snapshot().turn.speaking, true);

    // Past durationMs the 200 ms smoothstep release takes over…
    runtime.tick(1450); // speech ends at 1400 → release elapsed 50 → gain 1 - smoothstep(0.25)
    approx(frameValue(runtime, 'mouth'), 1 - smoothstep(0.25), 'release cross-fade');
    // …then the 500 ms hand-off hold keeps the mouth shut.
    runtime.tick(1700); // release elapsed 300 → inside the hold window
    assert.equal(frameValue(runtime, 'mouth'), 0, 'held closed');
    runtime.tick(1950);
    assert.equal(frameValue(runtime, 'mouth'), 0, 'still held closed');
    // …and finally the idle mouth value takes over.
    runtime.tick(2200); // release elapsed 800 > 200 + 500
    assert.equal(frameValue(runtime, 'mouth'), 0, 'idle mouth');
    assert.equal(runtime.snapshot().turn.speaking, false);
  });

  it('zeroes the mouth and reopens the eyes on interrupt', () => {
    const runtime = createBehaviorRuntime({ config: { random: () => 0 } });
    const { turnId } = runtime.beginTurn();
    runtime.setSpeech({ turnId, levels: [1], startedAt: 2600, durationMs: 1000 });

    runtime.tick(2600);
    approx(frameValue(runtime, 'mouth'), 1, 'speaking at full level');
    runtime.setIntent({ pose: { eyeOpen: 0 } });
    runtime.tick(2610);
    assert.equal(frameValue(runtime, 'eyeOpenL'), 0, 'expression closed the eyes');
    assert.equal(frameValue(runtime, 'mouth'), 1, 'speech still owns the mouth');

    const tokenBefore = runtime.snapshot().turn.token;
    runtime.interrupt({ reason: 'user-barge-in' });
    const snapshot = runtime.snapshot();
    assert.ok(snapshot.turn.token > tokenBefore, 'interrupt advances the playback token');

    // The rest pose is published synchronously — no tick needed before the next flush.
    const pending = runtime.pendingFrame;
    assert.ok(pending instanceof Map, 'pendingFrame is a Map');
    assert.equal(pending.get('mouth'), 0, 'mouth is closed immediately');
    assert.ok(pending.get('eyeOpenL') > 0.99, `eyes fall back open (${pending.get('eyeOpenL')})`);
    assert.ok(pending.get('eyeOpenR') > 0.99, 'both eyes fall back open');
    assert.ok(snapshot.frames.dropped >= 1, 'the pending frame was dropped, not flushed');

    // …and stays at rest on the following ticks.
    runtime.tick(2700);
    assert.equal(frameValue(runtime, 'mouth'), 0);
    assert.equal(frameValue(runtime, 'eyeOpenL'), 1);
    assert.equal(runtime.snapshot().turn.speaking, false);

    // takePendingFrame() empties the slot; the next tick refills it.
    const taken = runtime.takePendingFrame();
    assert.equal(taken.size, CHANNELS.length);
    assert.equal(runtime.pendingFrame.size, 0);
    runtime.tick(2710);
    assert.equal(runtime.pendingFrame.size, CHANNELS.length);
    assert.ok(runtime.snapshot().frames.computed >= 4);
  });
});

// ---------------------------------------------------------------------------------------------
// 6. expression-before-blink ordering
// ---------------------------------------------------------------------------------------------

describe('expression before blink', () => {
  it('honours the order structurally at the compose level (0 × factor = 0)', () => {
    // Every blink factor multiplies an eye that the expression already closed.
    for (const factor of [1, 0.9, 0.5, 0.2]) {
      const pose = composeChannels(
        { pose: { eyeOpen: 0, eyeOpenL: 0 }, squint: 0.5 },
        generatorsFor(factor),
        ARBITRATION,
      );
      assert.equal(pose.eyeOpenL, 0);
      assert.equal(pose.eyeOpenR, 0);
    }
  });

  it('multiplies blink on top of a partially closed expression and never leaks past it', () => {
    const runtime = createBehaviorRuntime({ config: { random: () => 0 } });
    runtime.beginTurn();
    // 0.5 is above the 0.15 threshold, so the blink machine may still run.
    runtime.setIntent({ pose: { eyeOpen: 0.5 } });

    let minEye = 1;
    let maxEye = 0;
    let sawBlink = false;
    for (let now = 0; now <= 3300; now += 10) {
      runtime.tick(now);
      const eye = frameValue(runtime, 'eyeOpenL');
      minEye = Math.min(minEye, eye);
      maxEye = Math.max(maxEye, eye);
      if (runtime.snapshot().blink.factor < 0.5) sawBlink = true;
    }
    assert.ok(sawBlink, 'the blink actually ran during the window');
    // Blink factor is applied *after* the expression: the output dips towards 0…
    assert.ok(minEye < 0.05, `blink multiplies the expression base down (min ${minEye.toFixed(4)})`);
    // …and the eye returns to exactly the expression value, never to 1.
    approx(frameValue(runtime, 'eyeOpenL'), 0.5, 'back to the expression base, not 1');
    assert.ok(maxEye <= 0.5 + 1e-9, `never leaks past the expression base (max ${maxEye})`);

    // No compounding: another 50 frames keep the same value.
    for (let now = 3310; now <= 3800; now += 10) runtime.tick(now);
    approx(frameValue(runtime, 'eyeOpenL'), 0.5, 'stable after the blink');
  });

  it('suppresses the blink entirely for an expression that already keeps the eye shut', () => {
    const runtime = createBehaviorRuntime({ config: { random: () => 0 } });
    runtime.beginTurn();
    runtime.setIntent({ pose: { eyeOpen: 0 } });
    let minFactor = 1;
    for (let now = 0; now <= 4000; now += 10) {
      runtime.tick(now);
      minFactor = Math.min(minFactor, runtime.snapshot().blink.factor);
    }
    assert.equal(minFactor, 1, 'baseline ≤ 0.15 never starts a blink');
    assert.equal(frameValue(runtime, 'eyeOpenL'), 0);
  });

  it('clamps composed channels into their semantic domain', () => {
    const pose = composeChannels(
      { pose: { headX: 5, browL: -4, eyeOpen: 3 }, squint: 2 },
      generatorsFor(2, { idle: { headX: 0.5, gazeX: 2 } }),
    );
    assert.equal(pose.headX, 1);
    assert.equal(pose.browL, -1);
    // eyeOpen 3 clamps to a base of 1, an out-of-range blink factor of 2 clamps to 1, and
    // squint 2 clamps to 1 → the 0.2 floor is the only thing left.
    approx(pose.eyeOpenL, LIMITS.MIN_EYE_OPEN, 'eye floor after clamping');
    assert.equal(pose.gazeX, 1, 'idle gaze is clamped too');
    assert.ok(clamp01(pose.mouth) === pose.mouth);
    assert.ok(pose.breath >= 0 && pose.breath <= 1);
  });
});

// ---------------------------------------------------------------------------------------------
// 7. regressions — the three confirmed defects
// ---------------------------------------------------------------------------------------------

describe('regression: stale playback token (defect 1)', () => {
  it('rejects a late mouth frame carrying the pre-interrupt token', () => {
    const runtime = createBehaviorRuntime({ config: { random: () => 0 } });
    const turn = runtime.beginTurn({ reason: 'assistant_say' });
    const accepted = runtime.setSpeech({
      turnId: turn.turnId,
      token: turn.token,
      levels: [1],
      startedAt: 0,
      durationMs: 1000,
    });
    assert.equal(accepted.ok, true);
    runtime.tick(0);
    approx(frameValue(runtime, 'mouth'), 1, 'the legitimate envelope owns the mouth');

    // The interrupt keeps the turn number — the token is the only thing that distinguishes
    // the aborted audio from the next turn's frames.
    const interrupted = runtime.interrupt({ reason: 'barge-in' });
    assert.equal(interrupted.turnId, turn.turnId, 'interrupt does not change the turn number');
    assert.ok(interrupted.token > turn.token, 'interrupt advances the playback token');
    assert.equal(runtime.pendingFrame.get('mouth'), 0, 'the rest frame closes the mouth at once');

    const late = runtime.setSpeech({
      turnId: turn.turnId,
      token: turn.token,
      levels: [1],
      startedAt: 0,
      durationMs: 1000,
    });
    assert.equal(late.ok, false, 'an old token must never install a new envelope');
    assert.equal(late.reason, 'stale-token');
    runtime.tick(10); // same tick after the interrupt: the mouth must stay shut
    assert.equal(frameValue(runtime, 'mouth'), 0, 'the rejected frame never reaches the mouth');

    const fresh = runtime.setSpeech({
      turnId: turn.turnId,
      token: runtime.getPlaybackToken(),
      levels: [1],
      startedAt: 0,
      durationMs: 1000,
    });
    assert.equal(fresh.ok, true, 'the re-captured token is accepted');
    approx(fresh.token, interrupted.token);
    runtime.tick(20);
    approx(frameValue(runtime, 'mouth'), 1, 'the fresh envelope opens the mouth again');
  });

  it('drops a speech envelope that was already queued in its release tail', () => {
    const runtime = createBehaviorRuntime({ config: { random: () => 0 } });
    const turn = runtime.beginTurn();
    runtime.setSpeech({ turnId: turn.turnId, token: turn.token, levels: [1], startedAt: 0, durationMs: 100 });
    runtime.tick(150); // elapsed 150 ms → 200 ms release fade, mouth still partly open
    assert.ok(frameValue(runtime, 'mouth') > 0, 'release tail is queued');

    runtime.interrupt({ reason: 'barge-in' });
    runtime.tick(160);
    assert.equal(frameValue(runtime, 'mouth'), 0, 'the queued release tail is discarded');
  });
});

describe('regression: squint floor blocks the blink (defect 2)', () => {
  it('lets blinkFactor = 0 close the eye for squint 0 / 0.3 / 1', () => {
    for (const squint of [0, 0.3, 1]) {
      // The floor only constrains the squint baseline; blink is the last multiplication.
      const baseline = squint > 0
        ? Math.max(Math.min(1, LIMITS.MIN_EYE_OPEN), 1 - squint)
        : 1;
      for (const factor of [1, 0.5, 0]) {
        const pose = composeChannels({ squint }, generatorsFor(factor));
        approx(pose.eyeOpenL, baseline * factor, `squint ${squint} × blink ${factor}`);
        approx(pose.eyeOpenR, baseline * factor, `squint ${squint} × blink ${factor} (right)`);
      }
      const closed = composeChannels({ squint }, generatorsFor(0));
      assert.equal(closed.eyeOpenL, 0, `blink 0 must fully close the eye at squint ${squint}`);
    }

    // The floor itself still applies to the squint baseline.
    const fullSquint = composeChannels({ squint: 1 }, generatorsFor(1));
    approx(fullSquint.eyeOpenL, LIMITS.MIN_EYE_OPEN, 'squint 1 holds the 0.2 floor');
    assert.equal(LIMITS.MIN_EYE_OPEN, 0.2);
  });
});

describe('regression: flags.idle switch (defect 3)', () => {
  const IDLE_AXES = ['gazeX', 'gazeY', 'headX', 'headY', 'headZ', 'bodyX', 'bodyY', 'bodyZ'];
  const sampleIdleAxes = (runtime, ticks = 120) => {
    const series = Object.fromEntries(IDLE_AXES.map((axis) => [axis, []]));
    for (let index = 0; index < ticks; index += 1) {
      runtime.tick(index * (1000 / 30)); // 120 ticks ≈ 4 s at the 30 Hz compute rate
      for (const axis of IDLE_AXES) series[axis].push(runtime.pendingFrame.get(axis));
    }
    return series;
  };
  const spread = (values) => Math.max(...values) - Math.min(...values);

  it('produces no idle component at all when idle is false', () => {
    const runtime = createBehaviorRuntime({ config: { random: () => 0 } });
    runtime.beginTurn();
    runtime.setIntent({ flags: { idle: false } });
    const series = sampleIdleAxes(runtime);
    for (const axis of IDLE_AXES) {
      assert.equal(spread(series[axis]), 0, `${axis} variance must be 0 over 120 idle-off ticks`);
      assert.ok(series[axis].every((value) => value === 0), `${axis} stays exactly 0`);
    }
  });

  it('still produces idle motion when idle stays enabled', () => {
    const runtime = createBehaviorRuntime({ config: { random: () => 0 } });
    runtime.beginTurn();
    const series = sampleIdleAxes(runtime);
    for (const axis of ['gazeX', 'headX', 'bodyX']) {
      assert.ok(spread(series[axis]) > 1e-3, `${axis} must move when idle is on (spread ${spread(series[axis])})`);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 8. mouth ownership, speech/audio sync, interrupt, idle actions, write isolation
// ---------------------------------------------------------------------------------------------

describe('mouth ownership — exactly one sender holds the token', () => {
  it('sends only the current token holder’s writes', async () => {
    const runtime = createBehaviorRuntime({ config: { random: () => 0, mouthInput: 'MouthOpen' } });
    runtime.beginTurn();
    const speech = runtime.startSpeech({ owner: 'speech', live: true });
    assert.equal(speech.ok, true);
    assert.ok(speech.token > 0);

    // The second sender is refused outright while the first holds the mouth.
    const lipSync = runtime.startSpeech({ owner: 'lip-sync', live: true });
    assert.equal(lipSync.ok, false);
    assert.equal(lipSync.reason, 'mouth-busy');
    assert.equal(runtime.snapshot().mouth.busy, 1);

    const accepted = await runtime.writeMouth({ value: 0.7, token: speech.token, owner: 'speech' });
    assert.equal(accepted.ok, true);
    const ignored = await runtime.writeMouth({ value: 0.2, token: speech.token + 1, owner: 'lip-sync' });
    assert.equal(ignored.ok, false);
    assert.equal(ignored.reason, 'stale-token');

    const snapshot = runtime.snapshot();
    assert.equal(snapshot.mouth.writes, 1, 'only the token holder’s write was sent');
    assert.equal(snapshot.mouth.rejected, 1, 'the other sender’s write was dropped');
    assert.equal(snapshot.mouth.owner, 'speech');
    assert.equal(runtime.pendingFrame.get('mouth'), 0.7, 'the sent level belongs to the owner');
  });

  it('hands the mouth over only on an explicit takeover and drops the old writer', async () => {
    const runtime = createBehaviorRuntime({ config: { random: () => 0, mouthInput: 'MouthOpen' } });
    runtime.beginTurn();
    const speech = runtime.startSpeech({ owner: 'speech', live: true });
    assert.equal((await runtime.writeMouth({ value: 0.9, token: speech.token })).ok, true);
    assert.equal(runtime.pendingFrame.get('mouth'), 0.9);

    const lipSync = runtime.startSpeech({ owner: 'lip-sync', live: true, takeover: true });
    assert.equal(lipSync.ok, true);
    assert.ok(lipSync.token > speech.token, 'takeover allocates a fresh token');
    assert.equal(runtime.snapshot().mouth.takeovers, 1);
    assert.equal(runtime.pendingFrame.get('mouth'), 0, 'the old level is released before the transfer');

    const late = await runtime.writeMouth({ value: 0.9, token: speech.token });
    assert.equal(late.ok, false, 'the old sender’s token is dead');
    assert.equal(runtime.snapshot().mouth.writes, 1, 'no old-sender write was sent after the takeover');
    assert.equal(runtime.pendingFrame.get('mouth'), 0);

    assert.equal((await runtime.writeMouth({ value: 0.3, token: lipSync.token })).ok, true);
    assert.equal(runtime.pendingFrame.get('mouth'), 0.3);
    assert.equal(runtime.snapshot().mouth.writes, 2, 'the new owner writes normally');
  });
});

describe('speech lifecycle — envelope, zero on end, interrupt', () => {
  it('advances a text envelope by time and closes the mouth on endSpeech', async () => {
    const runtime = createBehaviorRuntime({ config: { random: () => 0 } });
    runtime.beginTurn();
    const session = runtime.startSpeech({ text: '你好，世界！', durationMs: 600, startedAt: 1000 });
    assert.equal(session.ok, true);
    assert.equal(session.mode, 'envelope');
    assert.equal(session.frames, 6, 'one 100 ms slice per envelope frame');

    runtime.tick(1000); // elapsed 0   → slice 0
    const first = frameValue(runtime, 'mouth');
    assert.ok(first > 0, 'the envelope opens the mouth');
    runtime.tick(1100); // elapsed 100 → slice 1
    const second = frameValue(runtime, 'mouth');
    assert.ok(second > 0);
    assert.notEqual(first, second, 'the level advances with time');
    runtime.tick(1400); // elapsed 400 → slice 4
    assert.ok(frameValue(runtime, 'mouth') > 0);
    assert.equal(runtime.snapshot().turn.speaking, true);

    const ended = runtime.endSpeech();
    assert.equal(ended.ok, true);
    assert.equal(ended.mouth, 0);
    assert.equal(frameValue(runtime, 'mouth'), 0, 'mouth is closed synchronously');

    const late = await runtime.writeMouth({ value: 0.8, token: session.token });
    assert.equal(late.ok, false, 'the ended token cannot write');
    runtime.tick(1500);
    assert.equal(frameValue(runtime, 'mouth'), 0, 'and it stays closed');
    assert.equal(runtime.snapshot().mouth.rejected, 1);
    assert.equal(runtime.snapshot().turn.speaking, false);
  });

  it('interrupt stops the writer at once and invalidates its token', async () => {
    const runtime = createBehaviorRuntime({ config: { random: () => 0, mouthInput: 'MouthOpen' } });
    const turn = runtime.beginTurn();
    const session = runtime.startSpeech({ owner: 'lip-sync', live: true });
    runtime.tick(0);
    assert.equal((await runtime.writeMouth({ value: 0.9, token: session.token })).ok, true);
    assert.equal(frameValue(runtime, 'mouth'), 0.9);

    const interrupted = runtime.interrupt({ reason: 'barge-in' });
    assert.equal(interrupted.turnId, turn.turnId, 'interrupt does not change the turn number');
    assert.equal(runtime.pendingFrame.get('mouth'), 0, 'mouth is closed synchronously');
    assert.ok(runtime.snapshot().mouth.token > session.token, 'the session token was revoked');
    assert.equal(runtime.snapshot().mouth.active, false);

    const late = await runtime.writeMouth({ value: 0.9, token: session.token });
    assert.equal(late.ok, false);
    assert.ok(runtime.snapshot().mouth.rejected >= 1);
    runtime.tick(50);
    assert.equal(frameValue(runtime, 'mouth'), 0, 'no late frame replays the interrupted line');

    const next = runtime.startSpeech({ owner: 'lip-sync', live: true });
    assert.ok(next.token > session.token, 'a new session never reuses the interrupted token');
    assert.equal(next.ok, true);
  });
});

describe('idle actions — off switch and dedupe window', () => {
  it('queues no action while idle is false and dedupes the same action on resume', () => {
    const runtime = createBehaviorRuntime({
      config: { random: () => 0, idleActions: ['wave'], idleActionIntervalMs: 100, idleActionDedupeMs: 5000 },
    });
    const advance = (from, to) => {
      for (let now = from; now <= to; now += 30) runtime.tick(now);
    };
    runtime.beginTurn();

    advance(0, 300);
    const first = runtime.takeActions();
    assert.equal(first.length, 1, 'one idle action while idle');
    assert.equal(first[0].name, 'wave');
    assert.ok(first[0].at >= 90 && first[0].at <= 180, `action fires after one interval (at ${first[0].at})`);

    runtime.setIntent({ flags: { idle: false } });
    advance(330, 1300);
    assert.equal(runtime.takeActions().length, 0, 'no action while idle is false');
    const suppressedBefore = runtime.snapshot().idleActions.suppressed;

    runtime.setIntent({ flags: { idle: true } });
    advance(1330, 2000);
    assert.equal(runtime.takeActions().length, 0, 'the same action is deduped inside the window');
    assert.ok(runtime.snapshot().idleActions.suppressed > suppressedBefore);

    advance(2010, 6200);
    const again = runtime.takeActions();
    assert.ok(again.length >= 1, 'the action returns after the dedupe window');
    assert.equal(again[0].name, 'wave');
    assert.ok(again[0].at >= first[0].at + 5000, 'only after the window elapsed');
  });
});

describe('mouth input mapping — no hard-coded VTS parameter', () => {
  it('refuses an unmapped mouth, never calls the writer and logs once per session', async () => {
    const calls = [];
    const runtime = createBehaviorRuntime({
      config: {
        random: () => 0,
        writer: ({ input, value }) => {
          calls.push({ input, value });
          return { ok: true };
        },
      },
    });
    runtime.beginTurn();
    const session = runtime.startSpeech({ owner: 'lip-sync', live: true });
    runtime.tick(0);

    const first = await runtime.writeMouth({ value: 0.6, token: session.token });
    const second = await runtime.writeMouth({ value: 0.8, token: session.token });
    for (const result of [first, second]) {
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'unmapped');
    }
    assert.equal(calls.length, 0, 'the writer must not be called without a mapped input');
    assert.equal(runtime.snapshot().mouth.writes, 0);
    assert.equal(runtime.snapshot().mouth.unmapped, 2);
    assert.equal(runtime.pendingFrame.get('mouth'), 0, 'the mouth stays closed');
    assert.equal(
      runtime.takeEvents().filter((event) => event.type === 'avatar.mouth.unmapped').length,
      1,
      'one unmapped event per session, not one per frame',
    );

    // A new session gets its own single diagnostic record.
    const fresh = runtime.startSpeech({ owner: 'lip-sync', live: true, takeover: true });
    assert.equal(fresh.ok, true);
    await runtime.writeMouth({ value: 0.5, token: fresh.token });
    assert.equal(
      runtime.takeEvents().filter((event) => event.type === 'avatar.mouth.unmapped').length,
      1,
    );
  });

  it('writes to the discovered inputs.mouth input name', async () => {
    const calls = [];
    const runtime = createBehaviorRuntime({
      config: {
        random: () => 0,
        inputs: { mouth: { inputName: 'MouthOpen', channel: 'mouth' } },
        writer: ({ input, value }) => {
          calls.push({ input, value });
          return { ok: true };
        },
      },
    });
    runtime.beginTurn();
    const session = runtime.startSpeech({ owner: 'lip-sync', live: true });
    const result = await runtime.writeMouth({ value: 0.4, token: session.token });
    assert.equal(result.ok, true);
    assert.deepEqual(calls, [{ input: 'MouthOpen', value: 0.4 }]);
    assert.equal(runtime.snapshot().mouth.writes, 1);
  });

  it('prefers an explicit mouthInput mapping over the discovered entry', async () => {
    const calls = [];
    const runtime = createBehaviorRuntime({
      config: {
        random: () => 0,
        mouthInput: 'CustomMouth',
        inputs: { mouth: { inputName: 'MouthOpen' } },
        writer: ({ input }) => {
          calls.push(input);
          return { ok: true };
        },
      },
    });
    runtime.beginTurn();
    const session = runtime.startSpeech({ owner: 'lip-sync', live: true });
    assert.equal((await runtime.writeMouth({ value: 0.3, token: session.token })).ok, true);
    assert.deepEqual(calls, ['CustomMouth']);
  });
});

describe('async transport writes', () => {
  it('treats a resolved {ok:false} as a failed write', async () => {
    const runtime = createBehaviorRuntime({
      config: {
        random: () => 0,
        mouthInput: 'MouthOpen',
        writer: () => Promise.resolve({ ok: false, reason: 'vts said no' }),
      },
    });
    runtime.beginTurn();
    const session = runtime.startSpeech({ owner: 'lip-sync', live: true });
    runtime.tick(0);

    const result = await runtime.writeMouth({ value: 0.5, token: session.token });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'write-failed');
    assert.equal(result.errors, 1);

    const snapshot = runtime.snapshot();
    assert.equal(snapshot.errors, 1);
    assert.equal(snapshot.mouth.failed, 1);
    assert.equal(snapshot.mouth.writes, 0, 'an async failure is not counted as a write');
    assert.equal(snapshot.lastError, 'vts said no');
    assert.ok(runtime.takeEvents().some((event) => event.type === 'avatar.write.error'));
    assert.equal(runtime.pendingFrame.get('mouth'), 0, 'a failed async write never opens the mouth');
  });

  it('treats a rejected writer promise as a failure and never throws', async () => {
    const runtime = createBehaviorRuntime({
      config: {
        random: () => 0,
        mouthInput: 'MouthOpen',
        writer: () => Promise.reject(new Error('socket closed')),
      },
    });
    runtime.beginTurn();
    const session = runtime.startSpeech({ owner: 'lip-sync', live: true });

    let result;
    await assert.doesNotReject(async () => {
      result = await runtime.writeMouth({ value: 0.5, token: session.token });
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'write-failed');

    const snapshot = runtime.snapshot();
    assert.equal(snapshot.errors, 1);
    assert.equal(snapshot.mouth.failed, 1);
    assert.equal(snapshot.mouth.writes, 0);
    assert.equal(snapshot.lastError, 'socket closed');
  });

  it('counts an asynchronous success once', async () => {
    let calls = 0;
    const runtime = createBehaviorRuntime({
      config: {
        random: () => 0,
        mouthInput: 'MouthOpen',
        writer: async () => {
          calls += 1;
          return { ok: true };
        },
      },
    });
    runtime.beginTurn();
    const session = runtime.startSpeech({ owner: 'lip-sync', live: true });

    const result = await runtime.writeMouth({ value: 0.7, token: session.token });
    assert.equal(result.ok, true);
    assert.equal(calls, 1);
    assert.equal(runtime.snapshot().mouth.writes, 1);
    assert.equal(runtime.snapshot().errors, 0);
    assert.equal(runtime.pendingFrame.get('mouth'), 0.7);
  });
});

describe('interrupt — queued idle actions are invalidated', () => {
  it('drops a queued look-away on interrupt and queues new actions afterwards', () => {
    const runtime = createBehaviorRuntime({
      config: {
        random: () => 0,
        idleActions: ['look-away'],
        idleActionIntervalMs: 100,
        idleActionDedupeMs: 0,
      },
    });
    runtime.beginTurn();
    for (let now = 0; now <= 200; now += 30) runtime.tick(now);
    assert.equal(runtime.snapshot().idleActions.queued, 1, 'a look-away is queued');

    runtime.interrupt({ reason: 'barge-in' });
    assert.equal(runtime.snapshot().idleActions.queued, 0, 'the queue is emptied by the interrupt');
    assert.deepEqual(runtime.takeActions(), [], 'the pre-interrupt action is never taken');

    // dt is clamped to 50 ms, so step by 30 ms to cross one fresh 100 ms interval.
    for (let now = 210; now <= 300; now += 30) runtime.tick(now);
    const fresh = runtime.takeActions();
    assert.equal(fresh.length, 1, 'the scheduler still queues new actions');
    assert.equal(fresh[0].name, 'look-away');
    assert.equal(fresh[0].at, 300);
  });
});

describe('transport write isolation', () => {
  it('records a failed write as an event instead of throwing to the caller', async () => {
    const runtime = createBehaviorRuntime({
      config: {
        random: () => 0,
        mouthInput: 'MouthOpen',
        writer: () => {
          throw new Error('MouthOpen is not registered');
        },
      },
    });
    runtime.beginTurn();
    const session = runtime.startSpeech({ owner: 'lip-sync', live: true });

    let result;
    await assert.doesNotReject(async () => {
      result = await runtime.writeMouth({ value: 0.6, token: session.token });
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'write-failed');
    assert.equal(result.errors, 1);

    const snapshot = runtime.snapshot();
    assert.equal(snapshot.mouth.failed, 1);
    assert.equal(snapshot.mouth.writes, 0, 'a failed write is not counted as sent');
    assert.equal(snapshot.errors, 1);
    assert.equal(snapshot.lastError, 'MouthOpen is not registered');
    const events = runtime.takeEvents();
    assert.ok(
      events.some((event) => event.type === 'avatar.write.error' && event.input === 'MouthOpen'),
      'the failure is recorded as an event',
    );

    runtime.tick(0);
    assert.equal(frameValue(runtime, 'mouth'), 0, 'a failed write never opens the mouth');
  });
});

// ---------------------------------------------------------------------------------------------
// 9. P1 — a write whose transport settles late must not reopen the mouth
// ---------------------------------------------------------------------------------------------

/** One writer call the test settles by hand, mimicking a slow VTS round-trip. */
const deferred = () => {
  let settle;
  const promise = new Promise((resolve) => { settle = resolve; });
  return { promise, resolve: settle };
};

/** A runtime whose writer stays pending until the test settles each call. */
const withPendingWrites = () => {
  const pending = [];
  const runtime = createBehaviorRuntime({
    config: {
      random: () => 0,
      mouthInput: 'MouthOpen',
      writer: () => {
        const slot = deferred();
        pending.push(slot);
        return slot.promise;
      },
    },
  });
  return { runtime, pending };
};

const staleEventsOf = (runtime) => runtime.takeEvents().filter((event) => event.type === 'avatar.mouth.stale');

describe('stale writes — ownership is re-checked after the transport settles', () => {
  it('drops a write that resolves after interrupt() and keeps the mouth closed', async () => {
    const { runtime, pending } = withPendingWrites();
    runtime.beginTurn();
    const session = runtime.startSpeech({ owner: 'lip-sync', live: true });
    runtime.tick(0);

    const first = runtime.writeMouth({ value: 0.8, token: session.token, owner: 'lip-sync' });
    const second = runtime.writeMouth({ value: 0.4, token: session.token, owner: 'lip-sync' });
    assert.equal(pending.length, 2, 'both writes are in flight when the interrupt happens');
    assert.equal(runtime.snapshot().mouth.writes, 0);

    runtime.interrupt({ reason: 'barge-in' });
    assert.equal(runtime.pendingFrame.get('mouth'), 0, 'interrupt closes the mouth first');

    for (const slot of pending) slot.resolve({ ok: true });
    for (const result of await Promise.all([first, second])) {
      assert.equal(result.ok, false, 'a late success is refused');
      assert.equal(result.reason, 'stale-write');
      assert.equal(result.writes, 0, 'the refused write reports the unchanged counter');
    }

    const snapshot = runtime.snapshot();
    assert.equal(snapshot.mouth.writes, 0, 'writes is only incremented after the re-check');
    assert.equal(snapshot.mouth.value, 0, 'mouth.level is untouched');
    assert.equal(snapshot.mouth.stale, 2, 'both late writes are counted as stale');
    assert.equal(snapshot.pose.mouth, 0, 'lastPose.mouth stays closed');
    assert.equal(runtime.pendingFrame.get('mouth'), 0, 'the pending frame stays closed');

    const events = staleEventsOf(runtime);
    assert.equal(events.length, 1, 'one avatar.mouth.stale per session and reason');
    assert.equal(events[0].reason, 'stale-write');
  });

  it('drops a write that resolves after a takeover opened a new session', async () => {
    const { runtime, pending } = withPendingWrites();
    runtime.beginTurn();
    const session = runtime.startSpeech({ owner: 'speech', live: true });
    runtime.tick(0);

    const inFlight = runtime.writeMouth({ value: 0.8, token: session.token, owner: 'speech' });
    const next = runtime.startSpeech({ owner: 'lip-sync', live: true, takeover: true });
    assert.equal(next.ok, true);
    assert.ok(next.token > session.token, 'the takeover allocates a fresh session token');
    assert.equal(runtime.pendingFrame.get('mouth'), 0);

    pending[0].resolve({ ok: true });
    const late = await inFlight;
    assert.equal(late.ok, false);
    assert.equal(late.reason, 'stale-write');
    assert.equal(late.writes, 0);

    const snapshot = runtime.snapshot();
    assert.equal(snapshot.mouth.writes, 0, 'the old sender never counts a write');
    assert.equal(snapshot.mouth.value, 0);
    assert.equal(snapshot.mouth.owner, 'lip-sync');
    assert.equal(snapshot.pose.mouth, 0);
    assert.equal(runtime.pendingFrame.get('mouth'), 0);

    // The new owner is unaffected: its own late-settling write still lands.
    const fresh = runtime.writeMouth({ value: 0.3, token: next.token, owner: 'lip-sync' });
    pending[1].resolve({ ok: true });
    const accepted = await fresh;
    assert.equal(accepted.ok, true);
    assert.equal(accepted.writes, 1);
    assert.equal(runtime.pendingFrame.get('mouth'), 0.3);
  });

  it('regression: an uninterrupted write still updates the mouth and counts once', async () => {
    const { runtime, pending } = withPendingWrites();
    runtime.beginTurn();
    const session = runtime.startSpeech({ owner: 'lip-sync', live: true });
    runtime.tick(0);

    const inFlight = runtime.writeMouth({ value: 0.6, token: session.token, owner: 'lip-sync' });
    pending[0].resolve({ ok: true });
    const result = await inFlight;

    assert.equal(result.ok, true);
    assert.equal(result.value, 0.6);
    const snapshot = runtime.snapshot();
    assert.equal(snapshot.mouth.writes, 1);
    assert.equal(snapshot.mouth.value, 0.6);
    assert.equal(snapshot.mouth.stale, 0, 'a normal write is never stale');
    assert.equal(snapshot.pose.mouth, 0.6, 'lastPose carries the new level');
    assert.equal(runtime.pendingFrame.get('mouth'), 0.6);
    assert.equal(staleEventsOf(runtime).length, 0);
  });

  it('drops a write that resolves while endSpeech is closing the session', async () => {
    const { runtime, pending } = withPendingWrites();
    runtime.beginTurn();
    const session = runtime.startSpeech({ owner: 'lip-sync', live: true });
    runtime.tick(0);

    const inFlight = runtime.writeMouth({ value: 0.8, token: session.token, owner: 'lip-sync' });
    const ended = runtime.endSpeech({ token: session.token });
    assert.equal(ended.ok, true);
    assert.equal(runtime.pendingFrame.get('mouth'), 0);

    pending[0].resolve({ ok: true });
    const late = await inFlight;
    assert.equal(late.ok, false);
    assert.equal(late.reason, 'stale-write');
    assert.equal(late.writes, 0);

    const snapshot = runtime.snapshot();
    assert.equal(snapshot.mouth.writes, 0);
    assert.equal(snapshot.mouth.value, 0);
    assert.equal(snapshot.pose.mouth, 0);
    assert.equal(runtime.pendingFrame.get('mouth'), 0);
    assert.equal(staleEventsOf(runtime).length, 1);
  });
});

// ---------------------------------------------------------------------------------------------
// 10. host facade — injected transport, owner seat, dispose
// ---------------------------------------------------------------------------------------------

/** Minimal fake VTS transport: no WebSocket, every call observable and every failure injectable. */
const createFakeTransport = ({ mouthInput = 'MouthOpen', connectError = null } = {}) => {
  const state = {
    connected: false,
    connectCalls: 0,
    disconnectCalls: 0,
    writes: [],
    failure: null,
    mouthInput,
    listeners: new Map(),
  };
  const transport = {
    async connect() {
      state.connectCalls += 1;
      if (connectError) throw connectError;
      state.connected = true;
    },
    async disconnect() {
      state.disconnectCalls += 1;
      state.connected = false;
    },
    async write({ input, value }) {
      if (state.failure !== null) {
        const error = state.failure;
        state.failure = null;
        throw error;
      }
      state.writes.push({ input, value });
      return { ok: true };
    },
    on(event, handler) {
      state.listeners.set(event, handler);
      return () => state.listeners.delete(event);
    },
    off(event) {
      state.listeners.delete(event);
    },
    failNextWrite(error) {
      state.failure = error;
    },
  };
  Object.defineProperties(transport, {
    writes: { get: () => state.writes },
    connectCalls: { get: () => state.connectCalls },
    disconnectCalls: { get: () => state.disconnectCalls },
    transportConnected: { get: () => state.connected },
    listenerCount: { get: () => state.listeners.size },
    mouthInput: {
      get: () => state.mouthInput,
      set: (value) => {
        state.mouthInput = value;
      },
    },
  });
  return transport;
};

describe('host facade — transport isolation and error codes', () => {
  it('isolates a throwing transport and keeps later calls working', async () => {
    const transport = createFakeTransport();
    const runtime = createAvatarRuntime({ transport, now: () => 0, config: { random: () => 0 } });
    assert.deepEqual(await runtime.connect(), {
      ok: true,
      code: null,
      connected: true,
      generation: 1,
      mouthInput: 'MouthOpen',
    });

    const seat = runtime.setMouthOwner('speech');
    assert.equal(seat.ok, true);
    assert.equal(seat.owner, 'speech');

    transport.failNextWrite(new Error('socket exploded'));
    const failed = await runtime.writeMouth(0.8, { owner: 'speech', token: seat.token });
    assert.equal(failed.ok, false);
    assert.equal(failed.code, AVATAR_ERROR_CODES.WRITE_FAILED);
    assert.equal(runtime.snapshot().lastError, 'socket exploded');
    assert.ok(runtime.snapshot().errorCount >= 1);

    // The failure is returned, never thrown, and the next write still reaches the transport.
    const recovered = await runtime.writeMouth(0.4, { owner: 'speech', token: seat.token });
    assert.equal(recovered.ok, true);
    assert.equal(recovered.value, 0.4);
    assert.deepEqual(transport.writes.at(-1), { input: 'MouthOpen', value: 0.4 });

    // An unmapped mouth is refused with its own code and never reaches the writer.
    const unmapped = createAvatarRuntime({
      transport: createFakeTransport({ mouthInput: null }),
      now: () => 0,
      config: { random: () => 0 },
    });
    await unmapped.connect();
    const unmappedSeat = unmapped.setMouthOwner('speech');
    const rejected = await unmapped.writeMouth(0.5, { owner: 'speech', token: unmappedSeat.token });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.code, AVATAR_ERROR_CODES.UNMAPPED);
    assert.equal(unmapped.snapshot().inner.mouth.writes, 0);
    unmapped.dispose();
  });

  it('rejects a second owner with an explicit OWNERSHIP_CONFLICT code', async () => {
    const transport = createFakeTransport();
    const runtime = createAvatarRuntime({ transport, now: () => 0, config: { random: () => 0 } });
    await runtime.connect();

    const first = runtime.setMouthOwner('speech');
    assert.equal(first.ok, true);
    const conflict = runtime.setMouthOwner('lip-sync');
    assert.equal(conflict.ok, false);
    assert.equal(conflict.code, AVATAR_ERROR_CODES.OWNERSHIP_CONFLICT);
    assert.equal(runtime.snapshot().owner, 'speech');

    const spoken = await runtime.speak('你好', { owner: 'lip-sync' });
    assert.equal(spoken.ok, false);
    assert.equal(spoken.code, AVATAR_ERROR_CODES.OWNERSHIP_CONFLICT);

    // An explicit takeover is the only way to move the seat; it invalidates the old token.
    const takeover = runtime.setMouthOwner('lip-sync', { takeover: true });
    assert.equal(takeover.ok, true);
    assert.ok(takeover.token > first.token);
    assert.equal(runtime.snapshot().owner, 'lip-sync');
    assert.equal(
      (await runtime.writeMouth(0.6, { owner: 'speech', token: first.token })).code,
      AVATAR_ERROR_CODES.TOKEN_EXPIRED,
    );
    runtime.dispose();
  });

  it('refuses speech and writes carrying an expired owner token', async () => {
    const transport = createFakeTransport();
    const runtime = createAvatarRuntime({ transport, now: () => 0, config: { random: () => 0 } });
    await runtime.connect();
    const seat = runtime.setMouthOwner('speech');

    const released = runtime.releaseOwner('speech');
    assert.equal(released.ok, true);
    assert.equal(released.released, true);
    assert.equal(runtime.snapshot().owner, null);
    assert.equal(runtime.snapshot().mouth, 0);

    const staleWrite = await runtime.writeMouth(0.9, { owner: 'speech', token: seat.token });
    assert.equal(staleWrite.ok, false);
    assert.equal(staleWrite.code, AVATAR_ERROR_CODES.TOKEN_EXPIRED);
    const staleSpeak = await runtime.speak('你好', { owner: 'speech', token: seat.token });
    assert.equal(staleSpeak.ok, false);
    assert.equal(staleSpeak.code, AVATAR_ERROR_CODES.TOKEN_EXPIRED);
    assert.equal(transport.writes.length, 0, 'an expired token never reaches the transport');

    // A fresh seat gets a higher token and is accepted.
    const fresh = runtime.setMouthOwner('speech');
    assert.equal(fresh.ok, true);
    assert.ok(fresh.token > seat.token);
    const accepted = await runtime.writeMouth(0.5, { owner: 'speech', token: fresh.token });
    assert.equal(accepted.ok, true);
    assert.deepEqual(transport.writes.at(-1), { input: 'MouthOpen', value: 0.5 });
    runtime.dispose();
  });

  it('makes every entry point return DISPOSED after dispose, idempotently', async () => {
    const transport = createFakeTransport();
    const runtime = createAvatarRuntime({ transport, now: () => 0, config: { random: () => 0 } });
    await runtime.connect();
    const seat = runtime.setMouthOwner('speech');
    assert.equal((await runtime.writeMouth(0.9, { owner: 'speech', token: seat.token })).ok, true);
    assert.equal(runtime.snapshot().mouth, 0.9);
    assert.equal(transport.listenerCount, 3, 'connect subscribed to close/disconnect/error');

    const first = runtime.dispose();
    assert.equal(first.ok, true);
    assert.equal(first.disposed, true);
    assert.equal(first.alreadyDisposed, false);
    const second = runtime.dispose();
    assert.equal(second.ok, true);
    assert.equal(second.alreadyDisposed, true);

    const snapshot = runtime.snapshot();
    assert.equal(snapshot.disposed, true);
    assert.equal(snapshot.connected, false);
    assert.equal(snapshot.owner, null);
    assert.equal(snapshot.mouth, 0, 'dispose resets the mouth');
    assert.equal(snapshot.timerActive, false);

    const calls = [
      runtime.connect(),
      runtime.disconnect(),
      runtime.setMouthOwner('speech'),
      runtime.releaseOwner('speech'),
      runtime.speak('你好'),
      runtime.writeMouth(0.5),
      runtime.idle(10),
      runtime.tick(10),
    ];
    let disposed = 0;
    for (const call of calls) {
      const result = await Promise.resolve(call);
      assert.equal(result.ok, false);
      assert.equal(result.code, AVATAR_ERROR_CODES.DISPOSED);
      disposed += 1;
    }
    assert.equal(disposed, calls.length, 'every entry point answers DISPOSED');
    assert.equal(transport.listenerCount, 0, 'dispose released every transport listener');
    assert.equal(transport.disconnectCalls, 1, 'dispose disconnected the transport exactly once');
  });

  it('returns a complete snapshot with stable field types', async () => {
    const transport = createFakeTransport();
    const runtime = createAvatarRuntime({ transport, now: () => 1234, config: { random: () => 0 } });
    const required = ['connected', 'owner', 'generation', 'mouth', 'idle', 'lastError'];

    const before = runtime.snapshot();
    for (const key of required) assert.ok(key in before, `snapshot is missing ${key}`);
    assert.equal(typeof before.connected, 'boolean');
    assert.equal(before.owner, null);
    assert.equal(typeof before.generation, 'number');
    assert.equal(typeof before.mouth, 'number');
    assert.equal(typeof before.idle, 'boolean');
    assert.equal(before.idle, true);
    assert.equal(before.lastError, null);

    await runtime.connect();
    const seat = runtime.setMouthOwner('speech');
    await runtime.writeMouth(0.6, { owner: 'speech', token: seat.token });
    const after = runtime.snapshot();
    for (const key of required) assert.ok(key in after, `snapshot is missing ${key}`);
    assert.equal(after.connected, true);
    assert.equal(after.owner, 'speech');
    assert.ok(after.generation > before.generation);
    assert.equal(after.mouth, 0.6);
    assert.equal(after.idle, false, 'a live mouth owner is not idle');
    assert.equal(after.lastError, null);
    assert.equal(typeof after.speech, 'object');
    assert.ok(Array.isArray(after.inner.events));
    runtime.dispose();
  });

  it('only controls discovery rows whose own verification says so', async () => {
    const transport = createFakeTransport({ mouthInput: null });
    const logs = [];
    const runtime = createAvatarRuntime({
      transport,
      now: () => 0,
      log: (message, data = {}) => logs.push({ message, ...data }),
      config: { random: () => 0 },
    });
    await runtime.connect();

    // headX/mouth are injectable AND verified; headY is injectable but only a candidate.
    const discovered = [
      { channel: 'headX', inputName: 'FaceAngleX', injectable: true, verified: true, min: -30, max: 30, defaultValue: 0 },
      { channel: 'mouth', inputName: 'MouthOpen', injectable: true, verified: true, min: 0, max: 1, defaultValue: 0 },
      { channel: 'headY', inputName: 'FaceAngleY', injectable: true, verified: false, min: -30, max: 30, defaultValue: 0 },
      { channel: 'breath', inputName: 'Breath', injectable: false, verified: false },
    ];
    const first = await runtime.setChannelMappings(discovered);
    assert.equal(first.ok, true);
    assert.deepEqual(first.channels.controlled, ['headX', 'mouth']);
    assert.deepEqual(first.channels.unverified, ['headY'],
      'injectable:true with verified:false is a candidate, never controlled');
    assert.ok(first.channels.skipped.includes('breath'), 'a non-injectable channel stays skipped');
    assert.equal(transport.writes.length, 0, 'discovery alone never sends a probe');
    assert.equal(logs.some((entry) => entry.event === 'avatar.channel.unverified'
      && entry.channel === 'headY' && entry.reason === 'not-verified'), true,
    'the candidate is recorded as unverified');

    // The verified channel is written; the injectable candidate is not.
    runtime.tick(0);
    await new Promise((resolve) => setImmediate(resolve));
    const written = transport.writes.map((entry) => entry.input);
    assert.ok(written.includes('FaceAngleX'), 'the verified idle channel is written');
    assert.equal(written.includes('FaceAngleY'), false, 'an injectable-but-unverified channel is never written');
    runtime.dispose();
  });

  it('probe-verifies an explicit mapping only when VTS acknowledges the probe', async () => {
    const transport = createFakeTransport({ mouthInput: null });
    const logs = [];
    const runtime = createAvatarRuntime({
      transport,
      now: () => 0,
      log: (message, data = {}) => logs.push({ message, ...data }),
      config: { random: () => 0 },
    });
    await runtime.connect();
    const discovered = [
      { channel: 'headX', inputName: 'FaceAngleX', injectable: true, verified: true, min: -30, max: 30, defaultValue: 0 },
      { channel: 'gazeX', inputName: 'MyGaze', injectable: true, verified: false, min: -1, max: 1, defaultValue: 0 },
    ];
    const explicit = { channelMap: { gazeX: 'MyGaze' } };

    // `sent:true` alone is not proof: the frame left the socket without an answer.
    transport.write = async () => ({ ok: true, sent: true, acknowledged: false });
    const unacked = await runtime.setChannelMappings(discovered, explicit);
    assert.deepEqual(unacked.channels.controlled, ['headX']);
    assert.deepEqual(unacked.channels.unverified, ['gazeX']);
    assert.equal(logs.some((entry) => entry.event === 'avatar.channel.unverified'
      && entry.channel === 'gazeX' && entry.reason === 'no-acknowledgement'), true,
    'the missing acknowledgement is recorded');

    // A frame reported without any acknowledgement field is unconfirmed too.
    transport.write = async () => ({ ok: true, sent: true });
    const noAckField = await runtime.setChannelMappings(discovered, explicit);
    assert.deepEqual(noAckField.channels.controlled, ['headX']);
    assert.deepEqual(noAckField.channels.unverified, ['gazeX']);

    // Acknowledged → verified and controlled, with exactly one probe value.
    transport.write = async () => ({ ok: true, sent: true, acknowledged: true });
    const acked = await runtime.setChannelMappings(discovered, explicit);
    assert.deepEqual(acked.channels.controlled, ['gazeX', 'headX']);
    assert.deepEqual(acked.channels.unverified, []);
    assert.equal(logs.some((entry) => entry.event === 'avatar.channel.verified'
      && entry.channel === 'gazeX' && entry.reason === 'probe-accepted'), true,
    'the acknowledged probe is recorded as verified');

    // A rejected probe keeps the explicit channel unverified and out of the writer's set.
    transport.write = async () => ({ ok: false, reason: 'rejected by VTS' });
    const rejected = await runtime.setChannelMappings(discovered, explicit);
    assert.deepEqual(rejected.channels.controlled, ['headX']);
    assert.deepEqual(rejected.channels.unverified, ['gazeX']);
    runtime.dispose();
  });

  it('never falls back to a model parameter name for an unmapped explicit channel', async () => {
    const transport = createFakeTransport({ mouthInput: null });
    const runtime = createAvatarRuntime({ transport, now: () => 0, config: { random: () => 0 } });
    await runtime.connect();
    const discovered = [
      { channel: 'headX', inputName: 'FaceAngleX', injectable: true, verified: true },
      { channel: 'breath', inputName: 'ParamBreath', injectable: false, verified: false },
    ];
    const result = await runtime.setChannelMappings(discovered, {
      channelMap: { breath: 'ParamBreath' },
    });
    assert.deepEqual(result.channels.controlled, ['headX']);
    assert.deepEqual(result.channels.unverified, ['breath']);
    assert.equal(transport.writes.some((entry) => entry.input === 'ParamBreath'), false,
      'a model parameter name is never injected as a fallback');
    runtime.dispose();
  });
});

// ---------------------------------------------------------------------------------------------
// 11. P1 — a connect() whose transport settles late must not resurrect the runtime
// ---------------------------------------------------------------------------------------------

/** Fake transport whose `connect()` stays pending until the test releases it by hand. */
const createLateTransport = () => {
  const gate = deferred();
  const state = {
    connectCalls: 0,
    disconnectCalls: 0,
    transportConnected: false,
    listeners: new Map(),
  };
  const transport = {
    async connect() {
      state.connectCalls += 1;
      await gate.promise;
      state.transportConnected = true;
    },
    async disconnect() {
      state.disconnectCalls += 1;
      state.transportConnected = false;
    },
    async write() {
      return { ok: true };
    },
    on(event, handler) {
      state.listeners.set(event, handler);
      return () => state.listeners.delete(event);
    },
    off(event) {
      state.listeners.delete(event);
    },
  };
  Object.defineProperties(transport, {
    connectCalls: { get: () => state.connectCalls },
    disconnectCalls: { get: () => state.disconnectCalls },
    listenerCount: { get: () => state.listeners.size },
    transportConnected: { get: () => state.transportConnected },
  });
  return { transport, resolveConnect: () => gate.resolve() };
};

describe('late connect — dispose/disconnect during connect never resurrects', () => {
  it('dispose during connect: late connect is released, connected stays false and no timer/listeners', async () => {
    const late = createLateTransport();
    const runtime = createAvatarRuntime({
      transport: late.transport,
      now: () => 0,
      config: { random: () => 0, autoTickMs: 60_000 },
    });

    const connecting = runtime.connect();
    assert.equal(late.transport.connectCalls, 1, 'transport.connect() is in flight');
    assert.equal(runtime.snapshot().connected, false);

    runtime.dispose();
    assert.equal(runtime.snapshot().disposed, true);
    assert.equal(runtime.snapshot().connected, false);

    late.resolveConnect();
    const result = await connecting;
    assert.equal(result.ok, false);
    assert.equal(result.code, AVATAR_ERROR_CODES.DISPOSED);

    const snapshot = runtime.snapshot();
    assert.equal(snapshot.disposed, true);
    assert.equal(snapshot.connected, false, 'a late connect must not set connected back to true');
    assert.equal(snapshot.timerActive, false, 'a late connect must not start the tick timer');
    assert.equal(late.transport.listenerCount, 0, 'a late connect must not register listeners');
    assert.equal(late.transport.transportConnected, false, 'the late transport was released');
    assert.ok(late.transport.disconnectCalls >= 1, 'dispose/late release asked the transport to disconnect');
  });

  it('disconnect during connect: the late result cannot set connected back to true or start the tick', async () => {
    const late = createLateTransport();
    const runtime = createAvatarRuntime({
      transport: late.transport,
      now: () => 0,
      config: { random: () => 0, autoTickMs: 60_000 },
    });

    const connecting = runtime.connect();
    const disconnected = await runtime.disconnect();
    assert.equal(disconnected.ok, true);
    assert.equal(disconnected.connected, false);

    late.resolveConnect();
    const result = await connecting;
    assert.equal(result.ok, false);
    assert.equal(result.code, AVATAR_ERROR_CODES.DISPOSED);

    const snapshot = runtime.snapshot();
    assert.equal(snapshot.disposed, false, 'disconnect is not dispose');
    assert.equal(snapshot.connected, false);
    assert.equal(snapshot.timerActive, false, 'the late result must not start the tick timer');
    assert.equal(late.transport.listenerCount, 0, 'the late result must not register listeners');
    assert.equal(late.transport.transportConnected, false);
    runtime.dispose();
  });

  it('normal connect wires 3 listeners and the auto-tick only after the generation check', async () => {
    const transport = createFakeTransport();
    const runtime = createAvatarRuntime({
      transport,
      now: () => 0,
      config: { random: () => 0, autoTickMs: 60_000 },
    });

    const result = await runtime.connect();
    assert.equal(result.ok, true);
    assert.equal(result.connected, true);
    assert.equal(result.generation, 1);

    const snapshot = runtime.snapshot();
    assert.equal(snapshot.connected, true);
    assert.equal(snapshot.timerActive, true, 'the timer starts after the generation check');
    assert.equal(transport.listenerCount, 3, 'close, disconnect and error are subscribed');
    assert.equal(runtime.setMouthOwner('speech').ok, true);

    runtime.dispose();
    assert.equal(runtime.snapshot().timerActive, false, 'dispose clears the timer');
    assert.equal(transport.listenerCount, 0, 'dispose clears the listeners');
  });

  it('connect after dispose returns DISPOSED and never revives the transport', async () => {
    const transport = createFakeTransport();
    const runtime = createAvatarRuntime({ transport, now: () => 0, config: { random: () => 0 } });
    runtime.dispose();

    const result = await runtime.connect();
    assert.equal(result.ok, false);
    assert.equal(result.code, AVATAR_ERROR_CODES.DISPOSED);
    assert.equal(runtime.snapshot().connected, false);
    assert.equal(runtime.snapshot().disposed, true);
    assert.equal(transport.connectCalls, 0, 'a disposed runtime never calls transport.connect()');
  });

  it('dispose stays idempotent and disconnects the transport exactly once', async () => {
    const transport = createFakeTransport();
    const runtime = createAvatarRuntime({ transport, now: () => 0, config: { random: () => 0 } });
    await runtime.connect();
    assert.equal(transport.listenerCount, 3);

    const first = runtime.dispose();
    const second = runtime.dispose();
    assert.equal(first.ok, true);
    assert.equal(first.disposed, true);
    assert.equal(first.alreadyDisposed, false);
    assert.equal(second.ok, true);
    assert.equal(second.disposed, true);
    assert.equal(second.alreadyDisposed, true);

    const snapshot = runtime.snapshot();
    assert.equal(snapshot.disposed, true);
    assert.equal(snapshot.connected, false);
    assert.equal(snapshot.timerActive, false);
    assert.equal(transport.listenerCount, 0);
    assert.equal(transport.disconnectCalls, 1, 'the second dispose is a no-op');
  });

  it('regression: a normal reconnect after disconnect is still allowed', async () => {
    const transport = createFakeTransport();
    const runtime = createAvatarRuntime({ transport, now: () => 0, config: { random: () => 0 } });
    assert.equal((await runtime.connect()).generation, 1);

    await runtime.disconnect();
    assert.equal(runtime.snapshot().connected, false);

    const reconnected = await runtime.connect();
    assert.equal(reconnected.ok, true);
    assert.equal(reconnected.connected, true);
    assert.equal(reconnected.generation, 2, 'a completed reconnect advances the public generation');
    assert.equal(runtime.snapshot().connected, true);
    assert.equal(transport.listenerCount, 3);
    runtime.dispose();
  });
});

// ---------------------------------------------------------------------------------------------
// 12. P2 — concurrent connect() shares one attempt; stale results never close a shared transport
// ---------------------------------------------------------------------------------------------

/** Fake transport that parks every connect() until the test settles that call explicitly. */
const createGatedTransport = () => {
  const gates = [];
  const state = {
    connectCalls: 0,
    disconnectCalls: 0,
    transportConnected: false,
    listeners: new Map(),
  };
  const transport = {
    async connect() {
      state.connectCalls += 1;
      const gate = deferred();
      gates.push(gate);
      await gate.promise;
      state.transportConnected = true;
    },
    async disconnect() {
      state.disconnectCalls += 1;
      state.transportConnected = false;
    },
    async write() {
      return { ok: true };
    },
    on(event, handler) {
      state.listeners.set(event, handler);
      return () => state.listeners.delete(event);
    },
    off(event) {
      state.listeners.delete(event);
    },
  };
  Object.defineProperties(transport, {
    connectCalls: { get: () => state.connectCalls },
    disconnectCalls: { get: () => state.disconnectCalls },
    transportConnected: { get: () => state.transportConnected },
    listenerCount: { get: () => state.listeners.size },
  });
  const resolveConnect = (index = gates.length - 1) => {
    const gate = gates[index];
    assert.ok(gate, `connect gate ${index} does not exist`);
    gate.resolve();
  };
  return { transport, gates, resolveConnect };
};

/** The runtime must never claim connected while the transport itself reports a closed socket. */
const assertTransportConsistent = (runtime, transport, label) => {
  const snapshot = runtime.snapshot();
  if (snapshot.connected) {
    assert.equal(transport.transportConnected, true, `${label}: connected=true 时 transport 必须仍连接`);
  }
  assert.equal(snapshot.connected, transport.transportConnected, `${label}: connected 与 transport 实际状态一致`);
};

describe('concurrent connect — one shared attempt, stale results never close it', () => {
  it('concurrent connect A/B dials the transport once and both calls return ok', async () => {
    const gated = createGatedTransport();
    const runtime = createAvatarRuntime({
      transport: gated.transport,
      now: () => 0,
      config: { random: () => 0, autoTickMs: 60_000 },
    });

    const a = runtime.connect();
    const b = runtime.connect();
    assert.equal(gated.transport.connectCalls, 1, '并发调用只发起 1 次底层 connect');
    assert.equal(gated.gates.length, 1, '没有第二次在途尝试');

    gated.resolveConnect();
    const [ra, rb] = await Promise.all([a, b]);
    for (const result of [ra, rb]) {
      assert.equal(result.ok, true);
      assert.equal(result.connected, true);
    }
    assert.equal(ra.generation, rb.generation, '两个调用看到同一个连接代次');

    const snapshot = runtime.snapshot();
    assert.equal(snapshot.connected, true);
    assert.equal(gated.transport.transportConnected, true);
    assert.equal(gated.transport.connectCalls, 1, '底层 connect 次数保持 1');
    assert.equal(gated.transport.listenerCount, 3, '监听只注册一次');
    runtime.dispose();
  });

  it('disconnect while connect is pending: the late result stays disconnected and releases once', async () => {
    const gated = createGatedTransport();
    const runtime = createAvatarRuntime({
      transport: gated.transport,
      now: () => 0,
      config: { random: () => 0 },
    });

    const connecting = runtime.connect();
    const disconnected = await runtime.disconnect();
    assert.equal(disconnected.ok, true);
    assert.equal(runtime.snapshot().connected, false);
    assert.equal(gated.transport.disconnectCalls, 0, '连接尚未建立时 disconnect 不关闭 transport');
    assert.equal(gated.transport.transportConnected, false);

    gated.resolveConnect();
    const late = await connecting;
    assert.equal(late.ok, false);
    assert.equal(late.code, AVATAR_ERROR_CODES.DISPOSED);
    assert.equal(runtime.snapshot().connected, false, '迟到结果不得置 connected=true');
    assert.equal(gated.transport.transportConnected, false, '迟到连接由持有它的调用释放');
    assert.equal(gated.transport.disconnectCalls, 1, '合计只关闭一次');
    assert.equal(gated.transport.connectCalls, 1, '没有被关闭后又重开');
    assert.equal(gated.transport.listenerCount, 0, '迟到结果不注册监听');
    runtime.dispose();
  });

  it('immediate reconnect after disconnect: a stale in-flight result cannot overwrite or close it', async () => {
    const gated = createGatedTransport();
    const runtime = createAvatarRuntime({
      transport: gated.transport,
      now: () => 0,
      config: { random: () => 0 },
    });

    const stale = runtime.connect();
    await runtime.disconnect();
    const fresh = runtime.connect();
    assert.equal(gated.transport.connectCalls, 2);
    assert.equal(gated.gates.length, 2);

    gated.resolveConnect(0); // 旧连接迟到
    const late = await stale;
    assert.equal(late.ok, false);
    assert.equal(late.code, AVATAR_ERROR_CODES.DISPOSED);
    assert.equal(runtime.snapshot().connected, false, '旧结果不得改写新连接状态');
    assert.equal(gated.transport.disconnectCalls, 0, '旧调用不得关闭新连接共用的 transport');
    assert.equal(gated.transport.transportConnected, true, 'transport 仍为新连接保持打开');

    gated.resolveConnect(1);
    const connected = await fresh;
    assert.equal(connected.ok, true);
    assert.equal(connected.connected, true);
    assert.equal(runtime.snapshot().connected, true);
    assert.equal(gated.transport.transportConnected, true);
    assert.equal(gated.transport.disconnectCalls, 0, '新连接没有被旧结果关闭');
    runtime.dispose();
  });

  it('dispose during concurrent connect: every caller sees DISPOSED and the transport closes at most once', async () => {
    const gated = createGatedTransport();
    const runtime = createAvatarRuntime({
      transport: gated.transport,
      now: () => 0,
      config: { random: () => 0, autoTickMs: 60_000 },
    });

    const a = runtime.connect();
    const b = runtime.connect();
    assert.equal(gated.transport.connectCalls, 1);
    runtime.dispose();

    gated.resolveConnect();
    const results = await Promise.all([a, b]);
    for (const result of results) {
      assert.equal(result.ok, false);
      assert.equal(result.code, AVATAR_ERROR_CODES.DISPOSED);
    }
    const snapshot = runtime.snapshot();
    assert.equal(snapshot.connected, false);
    assert.equal(snapshot.disposed, true);
    assert.equal(snapshot.timerActive, false);
    assert.equal(gated.transport.listenerCount, 0);
    assert.equal(gated.transport.transportConnected, false);
    assert.equal(gated.transport.disconnectCalls, 1, 'dispose + 迟到连接合计只关闭一次');
  });

  it('state consistency: snapshot().connected matches the transport on every path', async () => {
    // 正常连接 / 断开
    const plain = createFakeTransport();
    const normal = createAvatarRuntime({ transport: plain, now: () => 0, config: { random: () => 0 } });
    await normal.connect();
    assertTransportConsistent(normal, plain, 'connect');
    await normal.disconnect();
    assertTransportConsistent(normal, plain, 'disconnect');

    // 连接失败
    const failing = createFakeTransport({ connectError: new Error('refused') });
    const failed = createAvatarRuntime({ transport: failing, now: () => 0, config: { random: () => 0 } });
    assert.equal((await failed.connect()).code, AVATAR_ERROR_CODES.CONNECT_FAILED);
    assertTransportConsistent(failed, failing, 'connect failed');

    // 在途 connect 被 disconnect 失效
    const gated = createGatedTransport();
    const late = createAvatarRuntime({ transport: gated.transport, now: () => 0, config: { random: () => 0 } });
    const pending = late.connect();
    await late.disconnect();
    assertTransportConsistent(late, gated.transport, 'disconnect during connect');
    gated.resolveConnect();
    await pending;
    assertTransportConsistent(late, gated.transport, 'late connect settled');

    // dispose
    const disposable = createFakeTransport();
    const disposed = createAvatarRuntime({ transport: disposable, now: () => 0, config: { random: () => 0 } });
    await disposed.connect();
    disposed.dispose();
    assertTransportConsistent(disposed, disposable, 'dispose');

    normal.dispose();
    failed.dispose();
    late.dispose();
  });
});

// ---------------------------------------------------------------------------------------------
// 13. P2 — a connect() issued while disconnect() is still closing must wait for the barrier
// ---------------------------------------------------------------------------------------------

/** Fake transport whose connect() and disconnect() both park until the test settles them. */
const createBarrierTransport = () => {
  const connectGates = [];
  const disconnectGates = [];
  const state = {
    connectCalls: 0,
    disconnectCalls: 0,
    transportConnected: false,
    disconnectError: null,
    listeners: new Map(),
  };
  const transport = {
    async connect() {
      state.connectCalls += 1;
      const gate = deferred();
      connectGates.push(gate);
      await gate.promise;
      state.transportConnected = true;
    },
    async disconnect() {
      state.disconnectCalls += 1;
      const gate = deferred();
      disconnectGates.push(gate);
      await gate.promise;
      // The socket is gone either way; a failure surfaces *after* the close (the realistic worst case).
      state.transportConnected = false;
      if (state.disconnectError !== null) {
        const error = state.disconnectError;
        state.disconnectError = null;
        throw error;
      }
    },
    async write() {
      return { ok: true };
    },
    on(event, handler) {
      state.listeners.set(event, handler);
      return () => state.listeners.delete(event);
    },
    off(event) {
      state.listeners.delete(event);
    },
  };
  Object.defineProperties(transport, {
    connectCalls: { get: () => state.connectCalls },
    disconnectCalls: { get: () => state.disconnectCalls },
    transportConnected: { get: () => state.transportConnected },
    listenerCount: { get: () => state.listeners.size },
  });
  const settle = (gates, index, label) => {
    const gate = gates[index];
    assert.ok(gate, `${label} gate ${index} does not exist`);
    gate.resolve();
  };
  return {
    transport,
    connectGates,
    disconnectGates,
    resolveConnect: (index = connectGates.length - 1) => settle(connectGates, index, 'connect'),
    resolveDisconnect: (index = disconnectGates.length - 1) => settle(disconnectGates, index, 'disconnect'),
    failNextDisconnect: (error) => {
      state.disconnectError = error;
    },
  };
};

/** Let the barrier waiters resume (they are queued behind the disconnect promise). */
const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

describe('P2 — connect() during disconnect() waits for the barrier', () => {
  it('waits for a hanging disconnect and really re-dials: connected/transportConnected true, connectCalls=2', async () => {
    const gated = createBarrierTransport();
    const runtime = createAvatarRuntime({
      transport: gated.transport,
      now: () => 0,
      config: { random: () => 0, autoTickMs: 60_000 },
    });

    const first = runtime.connect();
    gated.resolveConnect(0);
    assert.equal((await first).ok, true);
    assert.equal(runtime.snapshot().connected, true);
    assert.equal(gated.transport.transportConnected, true);

    // 底层退出挂起：disconnect() 已开始，transport.disconnect() 尚未 resolve
    const closing = runtime.disconnect();
    assert.equal(gated.transport.disconnectCalls, 1);
    assert.equal(gated.disconnectGates.length, 1);
    assert.equal(runtime.snapshot().disconnecting, true, 'disconnect() 开始即置 disconnecting');
    assert.equal(runtime.snapshot().connected, true, '底层退出完成前 connected 仍为 true');
    assert.equal(runtime.snapshot().timerActive, false, '断开开始即停表');
    assert.equal(gated.transport.listenerCount, 0, '断开开始即摘监听');

    // 断开挂起期间发起 connect：必须等待，不得 alreadyConnected 短路
    const reconnecting = runtime.connect();
    assert.equal(gated.transport.connectCalls, 1, '断开完成前不发起第二次底层 connect');
    assert.equal(gated.connectGates.length, 1);

    gated.resolveDisconnect(0);
    assert.equal((await closing).ok, true);
    assert.equal(runtime.snapshot().disconnecting, false, '断开完成后清除 disconnecting');
    await flushMicrotasks();

    assert.equal(gated.transport.connectCalls, 2, '断开完成后真正重建了连接');
    assert.equal(gated.connectGates.length, 2);
    assert.equal(runtime.snapshot().connected, false, '新连接仍在握手，connected 尚未置 true');

    gated.resolveConnect(1);
    const result = await reconnecting;
    assert.equal(result.ok, true);
    assert.equal(result.connected, true);
    assert.equal(result.generation, 2, '重建连接推进 generation');
    assert.equal(runtime.snapshot().connected, true);
    assert.equal(gated.transport.transportConnected, true, '最终 transport 实际连接');
    assert.equal(gated.transport.connectCalls, 2);
    assert.equal(gated.transport.listenerCount, 3, '重连重新注册监听');
    runtime.dispose();
  });

  it('returns a rebuilt connection, never alreadyConnected:true', async () => {
    const gated = createBarrierTransport();
    const runtime = createAvatarRuntime({ transport: gated.transport, now: () => 0, config: { random: () => 0 } });

    const first = runtime.connect();
    gated.resolveConnect(0);
    await first;

    const closing = runtime.disconnect();
    const reconnecting = runtime.connect();
    gated.resolveDisconnect(0);
    await closing;
    await flushMicrotasks();
    gated.resolveConnect(1);
    const rebuilt = await reconnecting;

    assert.equal(rebuilt.ok, true);
    assert.notEqual(rebuilt.alreadyConnected, true, '断开中不得返回 alreadyConnected:true');
    assert.equal(rebuilt.generation, 2, '这是一次真正重建的连接');
    assert.equal(gated.transport.connectCalls, 2);
    assert.equal(runtime.snapshot().generation, 2);
    runtime.dispose();
  });

  it('dispose while a connect waits on the barrier: that connect returns DISPOSED promptly', async () => {
    const gated = createBarrierTransport();
    const runtime = createAvatarRuntime({ transport: gated.transport, now: () => 0, config: { random: () => 0 } });

    const first = runtime.connect();
    gated.resolveConnect(0);
    await first;

    const closing = runtime.disconnect();
    assert.equal(runtime.snapshot().disconnecting, true);
    const reconnecting = runtime.connect();
    assert.equal(gated.transport.connectCalls, 1, '等待期间不拨号');

    // 关闭仍挂起，dispose 必须让等待中的 connect 立刻返回，而不是等一个可能永不完成的 close
    const disposed = runtime.dispose();
    assert.equal(disposed.disposed, true);
    const result = await reconnecting;
    assert.equal(result.ok, false);
    assert.equal(result.code, AVATAR_ERROR_CODES.DISPOSED);
    assert.equal(gated.transport.connectCalls, 1, 'dispose 后等待中的 connect 不得再拨号');
    assert.equal(runtime.snapshot().connected, false);
    assert.equal(runtime.snapshot().disposed, true);
    assert.equal(gated.transport.disconnectCalls, 1, 'dispose 不重复关闭在途 disconnect');

    // 物理关闭仍由在途 disconnect 完成，完成后状态一致
    gated.resolveDisconnect(0);
    await closing;
    await flushMicrotasks();
    const snapshot = runtime.snapshot();
    assert.equal(snapshot.disconnecting, false);
    assert.equal(snapshot.connected, false);
    assert.equal(gated.transport.transportConnected, false);
    assert.equal(gated.transport.disconnectCalls, 1);
    assert.equal(gated.transport.listenerCount, 0);
  });

  it('a failed disconnect clears connected and disconnecting and stays transport-consistent', async () => {
    const gated = createBarrierTransport();
    const runtime = createAvatarRuntime({ transport: gated.transport, now: () => 0, config: { random: () => 0 } });

    const first = runtime.connect();
    gated.resolveConnect(0);
    await first;
    assert.equal(gated.transport.transportConnected, true);

    gated.failNextDisconnect(new Error('socket stuck'));
    const closing = runtime.disconnect();
    assert.equal(runtime.snapshot().disconnecting, true);
    gated.resolveDisconnect(0);
    const result = await closing;

    const snapshot = runtime.snapshot();
    assert.equal(result.ok, true, '失败仍以结果对象返回，不抛给调用方');
    assert.equal(snapshot.connected, false, '断开失败后不得 connected=true');
    assert.equal(snapshot.disconnecting, false, '断开失败后清除 disconnecting');
    assert.equal(gated.transport.transportConnected, false, 'transport 已断，connected 必须一致');
    assert.equal(snapshot.lastErrorCode, AVATAR_ERROR_CODES.DISCONNECT_FAILED);
    assert.equal(snapshot.timerActive, false);
    assert.equal(gated.transport.listenerCount, 0);

    // 下一次 connect 仍然可以真正重建
    const reconnecting = runtime.connect();
    assert.equal(gated.transport.connectCalls, 2);
    gated.resolveConnect(1);
    const rebuilt = await reconnecting;
    assert.equal(rebuilt.ok, true);
    assert.equal(runtime.snapshot().connected, true);
    assert.equal(gated.transport.transportConnected, true);
    runtime.dispose();
  });

  it('concurrent connects issued during the close share one new attempt', async () => {
    const gated = createBarrierTransport();
    const runtime = createAvatarRuntime({ transport: gated.transport, now: () => 0, config: { random: () => 0 } });

    const first = runtime.connect();
    gated.resolveConnect(0);
    await first;

    const closing = runtime.disconnect();
    const a = runtime.connect();
    const b = runtime.connect();
    assert.equal(gated.transport.connectCalls, 1, '断开期间两个 connect 都不得拨号');

    gated.resolveDisconnect(0);
    await closing;
    await flushMicrotasks();
    assert.equal(gated.transport.connectCalls, 2, '两个等待者共享同一次新连接');
    assert.equal(gated.connectGates.length, 2);

    gated.resolveConnect(1);
    const [ra, rb] = await Promise.all([a, b]);
    for (const result of [ra, rb]) {
      assert.equal(result.ok, true);
      assert.equal(result.connected, true);
      assert.notEqual(result.alreadyConnected, true);
    }
    assert.equal(ra.generation, rb.generation, '两个调用看到同一个连接代次');
    assert.equal(gated.transport.connectCalls, 2);
    assert.equal(runtime.snapshot().connected, true);
    assert.equal(gated.transport.transportConnected, true);
    assert.equal(gated.transport.listenerCount, 3);
    runtime.dispose();
  });
});
