/**
 * Gaze-mapping probe staleness — a late result may never verify/unverify a mapping it did not
 * measure.
 *
 * Run: node --test test/vts-probe-stale.mjs
 *
 * The runtime captures the connection epoch, the mapping generation and the probed channel's
 * input/model parameters before measuring. Any drift while the probe is in flight discards the
 * result (marked `stale:true`, `discarded:<reason>`), leaves verified/controlled untouched and
 * never marks a channel unverified. A newer probe supersedes an older one even on the same
 * connection and mapping.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createAvatarRuntime } from '../src/host/avatar/avatarRuntime.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const GAZE_ROW = (inputName, verified = true) => ({
  channel: 'gazeX',
  inputName,
  inputSource: 'test',
  injectable: true,
  verified,
  modelParams: ['ParamEyeBallX'],
  min: -1,
  max: 1,
  defaultValue: 0,
});

function createTransport(probeInputMapping) {
  const writes = [];
  return {
    writes,
    probeActive: false,
    connect: async () => {},
    disconnect: async () => {},
    write: (frame) => {
      writes.push(frame);
      return { ok: true, acknowledged: true };
    },
    probeInputMapping,
  };
}

const createRuntime = (transport) => createAvatarRuntime({
  transport,
  config: { autoTickMs: 0 },
});

// ---------------------------------------------------------------------------------------------
// 1. mapping changed to NewEye while the OldEye probe is still measuring
// ---------------------------------------------------------------------------------------------
test('1. 探测中切换映射：OldEye 迟到 changed:true → NewEye 仍 unverified、不写', async () => {
  const pending = deferred();
  const started = deferred();
  const calls = [];
  const transport = createTransport(async ({ inputName }) => {
    calls.push(inputName);
    if (calls.length === 1) {
      started.resolve(inputName);
      return pending.promise;
    }
    return { ok: true, changed: false, delta: { ParamEyeBallX: 0 }, error: '' };
  });
  const runtime = createRuntime(transport);
  try {
    assert.equal((await runtime.connect()).ok, true);
    await runtime.setChannelMappings([GAZE_ROW('OldEye', true)]);
    assert.equal(runtime.snapshot().channels.controlled.includes('gazeX'), true);

    const probe = runtime.probeGazeMapping();
    assert.equal(await started.promise, 'OldEye', 'the probe measured the OldEye mapping');

    // The user changes the mapping while the probe is still measuring. NewEye starts unverified.
    await runtime.setChannelMappings([GAZE_ROW('NewEye', false)]);
    assert.equal(runtime.snapshot().channels.controlled.includes('gazeX'), false);
    assert.ok(runtime.snapshot().channels.unverified.includes('gazeX'));

    pending.resolve({ ok: true, changed: true, delta: { ParamEyeBallX: 0.5 }, error: '' });
    const stale = await probe;
    assert.equal(stale.stale, true, 'the late result is marked stale');
    assert.match(String(stale.discarded), /mapping|binding/u, `discarded=${stale.discarded}`);
    assert.equal(stale.applied, false);
    assert.deepEqual(stale.channels, {}, 'a stale result exposes no applicable evidence');
    assert.deepEqual(stale.mappingUnverified, [], 'a stale result marks nothing unverified');
    assert.equal(stale.discardedChannels.gazeX.inputName, 'OldEye');
    assert.equal(stale.discardedChannels.gazeX.changed, true);

    const after = runtime.snapshot();
    assert.equal(after.channels.controlled.includes('gazeX'), false,
      'the old changed:true result did not verify NewEye');
    assert.ok(after.channels.unverified.includes('gazeX'));
    assert.equal(transport.writes.length, 0, 'no frame was written from stale evidence');

    // The live binding really is NewEye and still needs its own probe.
    const fresh = await runtime.probeGazeMapping();
    assert.equal(fresh.stale, undefined);
    assert.equal(fresh.channels.gazeX.inputName, 'NewEye');
    assert.equal(fresh.channels.gazeX.changed, false);
    assert.equal(runtime.snapshot().channels.controlled.includes('gazeX'), false);
    assert.deepEqual(calls, ['OldEye', 'NewEye']);
    console.log(`1) discarded=${stale.discarded} calls=${calls.join(',')} newEyeVerified=false`);
  } finally {
    runtime.dispose();
  }
});

// ---------------------------------------------------------------------------------------------
// 2. disconnect/reconnect while the probe is in flight
// ---------------------------------------------------------------------------------------------
test('2. 探测中断连/重连：旧结果迟到 → 丢弃，不覆盖重连后的验证', async () => {
  const pending = deferred();
  const started = deferred();
  const transport = createTransport(async () => {
    started.resolve();
    return pending.promise;
  });
  const runtime = createRuntime(transport);
  try {
    assert.equal((await runtime.connect()).ok, true);
    await runtime.setChannelMappings([GAZE_ROW('EyeRightX', true)]);
    const probe = runtime.probeGazeMapping();
    await started.promise;

    assert.equal((await runtime.disconnect()).ok, true);
    assert.equal((await runtime.connect()).ok, true);
    await runtime.setChannelMappings([GAZE_ROW('EyeRightX', true)]);
    assert.ok(runtime.snapshot().channels.controlled.includes('gazeX'),
      'the reconnected mapping is verified before the old result arrives');

    // A changed:false result from the old connection would unverify the new one if it were applied.
    pending.resolve({ ok: true, changed: false, delta: { ParamEyeBallX: 0 }, error: '' });
    const stale = await probe;
    assert.equal(stale.stale, true);
    assert.match(String(stale.discarded), /connection|disconnected/u, `discarded=${stale.discarded}`);
    assert.deepEqual(stale.channels, {});

    const after = runtime.snapshot();
    assert.ok(after.channels.controlled.includes('gazeX'),
      'the old connection result did not unverify the reconnected mapping');
    assert.equal(after.channels.unverified.includes('gazeX'), false);
    console.log(`2) discarded=${stale.discarded} controlled=${after.channels.controlled.join(',')}`);
  } finally {
    runtime.dispose();
  }
});

// ---------------------------------------------------------------------------------------------
// 3. same connection, same mapping: the normal result still applies
// ---------------------------------------------------------------------------------------------
test('3. 同连接同映射：正常 changed:true 结果仍生效', async () => {
  const transport = createTransport(async ({ inputName }) => {
    assert.equal(inputName, 'EyeRightX');
    return { ok: true, changed: true, delta: { ParamEyeBallX: 0.5 }, error: '' };
  });
  const runtime = createRuntime(transport);
  try {
    assert.equal((await runtime.connect()).ok, true);
    await runtime.setChannelMappings([GAZE_ROW('EyeRightX', false)]);
    assert.equal(runtime.snapshot().channels.controlled.includes('gazeX'), false);

    const result = await runtime.probeGazeMapping();
    assert.equal(result.stale, undefined);
    assert.equal(result.channels.gazeX.changed, true);
    assert.equal(result.channels.gazeX.inputName, 'EyeRightX');
    const after = runtime.snapshot();
    assert.ok(after.channels.controlled.includes('gazeX'), 'the verified result remains effective');
    assert.equal(after.channels.unverified.includes('gazeX'), false);
    console.log(`3) changed=${result.channels.gazeX.changed} controlled=${after.channels.controlled.join(',')}`);
  } finally {
    runtime.dispose();
  }
});

// ---------------------------------------------------------------------------------------------
// 4. two concurrent probes: the older result may not overwrite the newer one
// ---------------------------------------------------------------------------------------------
test('4. 旧结果不覆盖新结果：并发探测 → 旧结果 superseded', async () => {
  const first = deferred();
  const second = deferred();
  const firstStarted = deferred();
  const secondStarted = deferred();
  let calls = 0;
  const transport = createTransport(async () => {
    calls += 1;
    if (calls === 1) {
      firstStarted.resolve();
      return first.promise;
    }
    secondStarted.resolve();
    return second.promise;
  });
  const runtime = createRuntime(transport);
  try {
    assert.equal((await runtime.connect()).ok, true);
    await runtime.setChannelMappings([GAZE_ROW('EyeRightX', false)]);

    const older = runtime.probeGazeMapping();
    await firstStarted.promise;
    const newer = runtime.probeGazeMapping();
    await secondStarted.promise;

    // The newer probe verifies the channel first.
    second.resolve({ ok: true, changed: true, delta: { ParamEyeBallX: 0.5 }, error: '' });
    const newerResult = await newer;
    assert.equal(newerResult.stale, undefined);
    assert.equal(newerResult.channels.gazeX.changed, true);
    assert.ok(runtime.snapshot().channels.controlled.includes('gazeX'));

    // The older, contradictory result arrives last and must be discarded.
    first.resolve({ ok: true, changed: false, delta: { ParamEyeBallX: 0 }, error: '' });
    const olderResult = await older;
    assert.equal(olderResult.stale, true);
    assert.equal(olderResult.discarded, 'superseded');
    assert.deepEqual(olderResult.channels, {});
    assert.deepEqual(olderResult.mappingUnverified, []);

    const after = runtime.snapshot();
    assert.ok(after.channels.controlled.includes('gazeX'),
      'the older changed:false result did not overwrite the newer verified result');
    assert.equal(after.channels.unverified.includes('gazeX'), false);
    console.log(`4) discarded=${olderResult.discarded} controlled=${after.channels.controlled.join(',')}`);
  } finally {
    runtime.dispose();
  }
});
