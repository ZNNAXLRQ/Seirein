/**
 * Mouth chunk-boundary acceptance.
 *
 * Run: node --test test/motion-mouth-boundary.mjs
 *
 * The contract:
 *   - a TTS chunk boundary is a decode boundary, NOT a pause: an adjacent chunk extends the SAME
 *     envelope clock instead of resetting it (no dip to zero, no restarted level index);
 *   - a real pause is allowed to close the mouth through the existing release fade;
 *   - an explicit cancel closes at once;
 *   - no second smoothing layer / long tail is added: the existing 200 ms release cross-fade is
 *     the only tail.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { TIMING, createAvatarRuntime } from '../src/host/avatar/avatarRuntime.js';

const DT = 1000 / 30;
const flush = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

const baseConfig = () => ({
  autoTickMs: 0,
  flushIntervalMs: 1,
  idleActions: [],
  idleParams: { headX: { inputName: 'FaceAngleX', min: -30, max: 30 } },
});

async function setup() {
  const clock = { value: 0 };
  const writes = [];
  const transport = {
    connect: async () => {},
    disconnect: async () => {},
    write: async ({ input, value }) => {
      writes.push({ input, value, at: clock.value });
      return { ok: true };
    },
    writeFrame: async (entries) => {
      writes.push(...entries.map((entry) => ({ ...entry, at: clock.value })));
      return { ok: true };
    },
  };
  const runtime = createAvatarRuntime({ transport, now: () => clock.value, config: baseConfig() });
  const connected = await runtime.connect();
  assert.equal(connected.ok, true);
  runtime.setMouthInput('MouthOpen');
  writes.length = 0;
  runtime.takeEvents();
  return { runtime, clock, writes };
}

const tickRows = async (runtime, clock, from, to, step = 50) => {
  const rows = [];
  for (clock.value = from; clock.value <= to; clock.value += step) {
    const pose = runtime.tick(clock.value);
    rows.push({ at: clock.value, mouth: pose.mouth });
    await flush();
  }
  return rows;
};

test('1. 相邻切块不重置包络：同一 startedAt/level index 延续，边界无归零', async () => {
  const { runtime, clock } = await setup();
  const first = await runtime.speak({
    levels: [0.6, 0.8, 0.9, 0.7, 0.5], stepMs: 100, durationMs: 500, startedAt: 0, owner: 'speech',
  });
  assert.equal(first.ok, true);
  // Drive THROUGH the first chunk's end, so the second chunk really arrives one tick after the
  // end (the post-end continuity window), not only before the end.
  const before = await tickRows(runtime, clock, 0, 500, 50);
  assert.ok(before.at(-1).mouth > 0.4, 'the first chunk is audibly open at its end');

  // The next TTS chunk starts exactly at the previous chunk's end: it must continue the envelope.
  const second = await runtime.speak({
    levels: [0.4, 0.8, 1.0, 0.6], stepMs: 100, durationMs: 400, startedAt: 500, owner: 'speech',
  });
  assert.equal(second.ok, true);
  assert.equal(second.continued, true, 'the chunk was appended, not restarted');
  assert.equal(second.startedAt, 0, 'the envelope clock was NOT reset at the chunk boundary');
  assert.equal(second.durationMs, 900, 'the envelope duration extends to the last chunk end');
  assert.equal(second.frames, 9, 'the level list is the concatenation of both chunks');
  let snap = runtime.snapshot();
  assert.equal(snap.inner.mouth.continuations, 1, 'the continuation is counted');
  assert.ok(Number.isFinite(snap.inner.mouth.token) && snap.inner.mouth.token > 0,
    'the same live mouth session token is kept across the boundary');

  const around = await tickRows(runtime, clock, 450, 550, 25);
  assert.ok(around.some((row) => row.at === 500), 'the boundary tick was sampled');
  const atBoundary = around.find((row) => row.at === 500);
  assert.ok(Math.abs(atBoundary.mouth - 0.4) < 0.05,
    `the boundary uses chunk 2's first level, not a restarted build-up (${atBoundary.mouth})`);
  assert.ok(around.every((row) => row.mouth > 0.05),
    `no dip to zero at the chunk boundary (${around.map((row) => row.mouth.toFixed(2)).join(',')})`);

  const tail = await tickRows(runtime, clock, 550, 900, 50);
  assert.ok(tail.some((row) => row.mouth > 0.05), 'the appended chunk is still audible');
  const after = await tickRows(runtime, clock, 950, 1400, 50);
  const releaseEnd = 900 + TIMING.RELEASE_DURATION_MS;
  const firstZero = after.find((row) => row.mouth === 0);
  assert.ok(firstZero, 'the mouth really closes after the envelope ends');
  assert.ok(firstZero.at <= releaseEnd + 100,
    `the release fade is the existing 200 ms, not a second long tail (${firstZero.at} ≤ ${releaseEnd + 100})`);
  assert.ok(after.filter((row) => row.at > releaseEnd + 100).every((row) => row.mouth === 0),
    'no non-zero mouth write outlives the release window');
  snap = runtime.snapshot();
  assert.equal(snap.inner.mouth.continuations, 1);
  console.log(
    `[mouth] boundary first=${first.frames} appended=${second.frames}`
    + ` continued=${second.continued} clock=${second.startedAt}`
    + ` boundaryMouth=${atBoundary.mouth.toFixed(2)} releaseEnd@${firstZero.at}`,
  );
  runtime.dispose();
});

test('2. 真实停顿允许闭嘴：超出连续性窗口后新开包络，而不是硬接上一块', async () => {
  const { runtime, clock } = await setup();
  const first = await runtime.speak({
    levels: [0.8, 0.8, 0.8, 0.8, 0.8], stepMs: 100, durationMs: 500, startedAt: 0, owner: 'speech',
  });
  assert.equal(first.ok, true);
  await tickRows(runtime, clock, 0, 450, 50);
  const closed = await tickRows(runtime, clock, 500, 800, 25);
  assert.ok(closed.some((row) => row.mouth === 0), 'a real pause lets the mouth close');
  const sessionsBefore = runtime.snapshot().inner.mouth.sessions;

  // 400 ms after the previous envelope ended: a REAL pause, so this is a fresh envelope.
  const second = await runtime.speak({
    levels: [0.7, 0.7, 0.7], stepMs: 100, durationMs: 300, startedAt: 900, owner: 'speech',
  });
  assert.equal(second.ok, true);
  assert.equal(second.continued, false, 'a real pause does not continue the old envelope');
  assert.equal(second.startedAt, 900, 'the new envelope has its own real start');
  assert.ok(runtime.snapshot().inner.mouth.sessions > sessionsBefore,
    'a real pause opens a fresh mouth session');
  clock.value = 900;
  const pose = runtime.tick(900);
  await flush();
  assert.ok(Math.abs(pose.mouth - 0.7) < 0.05, `the fresh chunk starts at its own level (${pose.mouth})`);
  console.log(
    `[mouth] realPause closed=1 continued=${second.continued === true}`
    + ` sessions=${sessionsBefore}->${runtime.snapshot().inner.mouth.sessions}`,
  );
  runtime.dispose();
});

test('3. 显式取消及时收口：releaseOwner 当帧归零，无迟到的口型写入', async () => {
  const { runtime, clock, writes } = await setup();
  const spoken = await runtime.speak({
    levels: Array.from({ length: 10 }, () => 0.9), stepMs: 100, durationMs: 1000, startedAt: 0,
    owner: 'speech',
  });
  assert.equal(spoken.ok, true);
  for (clock.value = 0; clock.value <= 200; clock.value += DT) {
    const pose = runtime.tick(clock.value);
    assert.ok(pose.mouth > 0.5, 'the mouth is open before the cancel');
    await flush();
  }
  const beforeCancel = writes.length;
  const released = runtime.releaseOwner('speech');
  assert.equal(released.ok, true);
  assert.equal(released.released, true);
  const snap = runtime.snapshot();
  assert.equal(snap.mouth, 0, 'the facade mouth is closed immediately');
  assert.equal(snap.inner.mouth.active, false, 'the mouth session is revoked');
  assert.equal(snap.inner.turn.speaking, false, 'speech is no longer reported as playing');

  clock.value = 233;
  const pose = runtime.tick(233);
  await flush();
  assert.equal(pose.mouth, 0, 'the very next tick carries a closed mouth');
  const lateMouth = writes.slice(beforeCancel).filter((entry) => entry.input === 'MouthOpen'
    && Number(entry.value) > 0);
  assert.equal(lateMouth.length, 0, 'no late positive mouth write survives the explicit cancel');
  runtime.dispose();
});
