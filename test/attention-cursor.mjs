/**
 * 鼠标作为注视目标与方向来源。
 *
 * Acceptance pinned here:
 *   1. a fake GetCursorPos is projected onto the avatar-window centre (verified target + direction);
 *   2. a failed cursor read is `verified:false` and the target/direction presets stay unavailable;
 *   3. privacy pauses the cursor sample while the motion runtime keeps writing frames;
 *   4. `motion.presets.list` marks target/direction presets available from the current cursor and
 *      unavailable with the right reason when there is none;
 *   5. privacy never appears as an action lock reason;
 *   6. an off-screen cursor produces null, never a clamped direction.
 *
 * Run: node --test test/attention-cursor.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OPERATIONS } from '../src/host/avatar/presets/index.js';
import {
  ATTENTION_SAMPLE_MS,
  createCursorAttentionSource,
  projectCursorTarget,
} from '../src/host/vision/attention-source.js';
import { createAvatarRuntime } from '../src/host/avatar/avatarRuntime.js';
import {
  createAvatarSettingsActions,
  createMotionPresetOverridesStore,
} from '../src/host/avatar/settings-actions.js';

const FULL_CHANNELS = Object.freeze([...new Set(Object.values(OPERATIONS).flat())]);
const SCREEN = Object.freeze({ x: 0, y: 0, width: 1920, height: 1080 });

const makeEnv = (overrides = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'seirein-attention-cursor-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  const store = createMotionPresetOverridesStore({ file: join(root, 'data', 'motion-presets.json') });
  const services = {
    motionPresetStore: store,
    avatarCapabilitiesStatus: () => ({ verified: FULL_CHANNELS }),
    avatarMotionLockReasons: [],
    vision: { mode: 'watch' },
    ...overrides,
  };
  return {
    root,
    handler: createAvatarSettingsActions(services),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
};

const listOf = (handler, body = {}) => handler({ action: 'motion.presets.list', ...body });

// ---------------------------------------------------------------------------------------------
// 1. Fake GetCursorPos → normalized target and verified=true
// ---------------------------------------------------------------------------------------------
test('1. 假 GetCursorPos → 归一化目标正确、verified=true', () => {
  const now = 1_700_000_000_000;
  const source = createCursorAttentionSource({
    readCursor: () => ({ x: 1600, y: 600 }),
    readScreen: () => SCREEN,
    // Avatar window: x 1000..1800, y 500..900; centre (1400, 700), half extent (400, 200).
    readAnchor: () => ({ x: 1000, y: 500, width: 800, height: 400 }),
    now: () => now,
    intervalMs: ATTENTION_SAMPLE_MS,
  });
  const sample = source.sample();
  assert.equal(sample.source, 'cursor');
  assert.equal(sample.verified, true);
  assert.equal(sample.x, 0.5, 'cursor is 200 px right of centre inside a 400 px half-width');
  assert.equal(sample.y, 0.5, 'cursor is 100 px above centre inside a 200 px half-height');
  assert.equal(sample.at, now);
  assert.equal(ATTENTION_SAMPLE_MS, 250, 'sampling is 4 Hz');
  console.log(`[1] x=${sample.x} y=${sample.y} verified=${sample.verified} at=${sample.at}`);
});

// ---------------------------------------------------------------------------------------------
// 2. Read failure → verified=false and target presets remain unavailable
// ---------------------------------------------------------------------------------------------
test('2. 读取失败 → verified=false，目标预设仍不可用', async (t) => {
  const source = createCursorAttentionSource({
    readCursor: () => null,
    readScreen: () => SCREEN,
    readAnchor: () => null,
    now: () => 42,
  });
  const env = makeEnv({ attentionSource: source });
  t.after(env.cleanup);

  const sample = source.sample();
  assert.equal(sample.verified, false);
  assert.equal(sample.x, null);
  assert.equal(sample.y, null);
  assert.equal(sample.at, 42, 'the attempted read is still timestamped');

  const list = await listOf(env.handler);
  const targetItem = list.items.find(item => item.presetId === 'idle-look-back.flow');
  assert.equal(targetItem.requiresTarget, true);
  assert.equal(targetItem.available, false);
  assert.match(targetItem.reason, /需要目标/);
  assert.equal(list.targetVerified, false);
  assert.equal(list.directionVerified, false);
  console.log(`[2] verified=${sample.verified} targetAvailable=${targetItem.available}`
    + ` reason=${JSON.stringify(targetItem.reason)}`);
});

// ---------------------------------------------------------------------------------------------
// 3. Privacy stops target updates; motion frames keep flowing
// ---------------------------------------------------------------------------------------------
test('3. 隐私期间目标停止更新，动作帧照常继续', async () => {
  let clock = 0;
  let cursor = { x: 1600, y: 600 };
  const frames = [];
  const transport = {
    connect: async () => {},
    disconnect: async () => {},
    write: async () => ({ ok: true }),
    writeMotion: async (payload) => { frames.push(payload); return { ok: true }; },
  };
  const runtime = createAvatarRuntime({
    transport,
    now: () => clock,
    config: {
      autoTickMs: 0,
      flushIntervalMs: 1,
      idleActions: [],
      idleSwayScale: 0,
      motionWrites: true,
      motionOutputHz: 30,
      presetExecution: true,
    },
  });
  assert.equal((await runtime.connect()).ok, true);
  const rows = FULL_CHANNELS.map((channel) => ({
    channel, inputName: `P_${channel}`, injectable: true, verified: true,
  }));
  await runtime.setChannelMappings(rows, { channelMap: {} });

  const source = createCursorAttentionSource({
    readCursor: () => cursor,
    readScreen: () => SCREEN,
    readAnchor: () => ({ x: 1000, y: 500, width: 800, height: 400 }),
    now: () => clock,
    intervalMs: 20,
    onSample: (sample) => {
      if (sample.verified === true) {
        runtime.setAttention(
          { x: sample.x, y: sample.y, at: sample.at },
          { verified: true, source: 'cursor', record: false },
        );
      } else {
        runtime.setAttention(null, { verified: false, source: 'cursor', record: false });
      }
    },
  });

  const live = source.sample();
  assert.equal(live.verified, true);
  const attention = runtime.snapshot().motion.attention;
  assert.equal(attention.mode, 'user');
  assert.equal(attention.verified, true);
  assert.equal(attention.source, 'cursor');
  assert.equal(runtime.snapshot().motion.presets.capabilities.targetVerified, true);
  assert.equal(runtime.snapshot().motion.presets.capabilities.directionVerified, true,
    'a cursor bearing is also a verified direction proof');
  const liveEvents = runtime.takeEvents();
  assert.equal(liveEvents.some((event) => event.type === 'avatar.attention'), false,
    'a 4 Hz cursor sample leaves no coordinate history in the event buffer');

  for (const at of [0, 100, 200]) {
    clock = at;
    runtime.tick(at);
  }
  await new Promise((resolve) => setImmediate(resolve));
  const framesBeforePrivacy = runtime.snapshot().motion.outputFrames;
  const writtenBeforePrivacy = frames.length;
  assert.ok(framesBeforePrivacy > 0, 'the controller wrote frames before privacy');

  clock = 300;
  const paused = source.setPrivacy(true);
  assert.equal(source.privacy, true);
  assert.equal(paused.verified, false);
  assert.equal(paused.at, null);
  assert.equal(runtime.snapshot().motion.attention.mode, 'neutral', 'the stale target is cleared');
  const frozenAt = source.snapshot().at;

  cursor = { x: 0, y: 1080 };
  const afterPrivacySample = source.sample();
  assert.equal(afterPrivacySample.verified, false, 'privacy refuses to read the cursor');
  assert.equal(afterPrivacySample.at, frozenAt, 'the sample timestamp does not advance');

  for (const at of [400, 500]) {
    clock = at;
    runtime.tick(at);
  }
  await new Promise((resolve) => setImmediate(resolve));
  const framesAfterPrivacy = runtime.snapshot().motion.outputFrames;
  assert.ok(framesAfterPrivacy > framesBeforePrivacy, 'motion keeps ticking while privacy is on');
  assert.ok(frames.length >= writtenBeforePrivacy, 'the transport writer keeps receiving frames');

  const resumed = source.setPrivacy(false);
  assert.equal(source.privacy, false);
  assert.equal(resumed.verified, true, 'leaving privacy resumes sampling');
  assert.equal(resumed.x, -1, 'the new cursor position is used after resume');
  assert.equal(resumed.y, -1);
  source.stop();
  console.log(`[3] before=${framesBeforePrivacy} after=${framesAfterPrivacy}`
    + ` resumed=(${resumed.x},${resumed.y}) privacyAt=${JSON.stringify(frozenAt)}`);
});

// ---------------------------------------------------------------------------------------------
// 4. Preset availability follows the live cursor target/direction
// ---------------------------------------------------------------------------------------------
test('4. 预设列表：有目标时 requiresTarget/requiresDirection 可用，无目标时不可用', async (t) => {
  const proof = { source: 'cursor', x: 0.4, y: -0.2, at: 7, verified: true };
  const env = makeEnv({ attentionSource: { snapshot: () => ({ ...proof }) } });
  t.after(env.cleanup);

  proof.verified = false;
  proof.x = null;
  proof.y = null;
  const without = await listOf(env.handler);
  assert.equal(without.targetVerified, false);
  const targetWithout = without.items.find(item => item.presetId === 'idle-look-back.flow');
  const directionWithout = without.items.find(item => item.presetId === 'listen-turn.flow');
  assert.equal(targetWithout.available, false);
  assert.match(targetWithout.reason, /需要目标/);
  assert.equal(directionWithout.available, false);
  assert.match(directionWithout.reason, /需要方向/);

  proof.verified = true;
  proof.x = 0.4;
  proof.y = -0.2;
  const withCursor = await listOf(env.handler);
  assert.equal(withCursor.targetVerified, true);
  assert.equal(withCursor.directionVerified, true);
  const targetWith = withCursor.items.find(item => item.presetId === 'idle-look-back.flow');
  const directionWith = withCursor.items.find(item => item.presetId === 'listen-turn.flow');
  assert.equal(targetWith.available, true);
  assert.equal(directionWith.available, true);
  const before = without.items.filter(item => item.available).length;
  const after = withCursor.items.filter(item => item.available).length;
  assert.ok(after > before, 'the cursor target unlocks target/direction presets');
  console.log(`[4] target=${targetWithout.available}->${targetWith.available}`
    + ` direction=${directionWithout.available}->${directionWith.available}`
    + ` available=${before}->${after}`);
});

// ---------------------------------------------------------------------------------------------
// 5. Privacy is not an action lock reason
// ---------------------------------------------------------------------------------------------
test('5. 隐私不再出现在动作锁定理由里', async (t) => {
  const env = makeEnv({
    avatarMotionLockReasons: ['privacy'],
    vision: { mode: 'privacy' },
  });
  t.after(env.cleanup);
  const list = await listOf(env.handler, { privacy: true });
  assert.equal(list.locked, false, 'privacy locks capture, not motion');
  assert.deepEqual(list.lockReasons, []);
  assert.ok(list.items.every(item => !item.reason.includes('隐私锁定')));
  assert.ok(list.items.some(item => item.available === true), 'non-target actions stay available');
  console.log(`[5] locked=${list.locked} lockReasons=${JSON.stringify(list.lockReasons)}`
    + ` available=${list.items.filter(item => item.available).length}`);
});

// ---------------------------------------------------------------------------------------------
// 6. Off-screen cursor → null (never an out-of-range direction)
// ---------------------------------------------------------------------------------------------
test('6. 屏幕外坐标 → null，不产生越界方向', () => {
  for (const cursor of [{ x: -1, y: 500 }, { x: 1921, y: 500 }, { x: 500, y: 1081 }]) {
    const source = createCursorAttentionSource({
      readCursor: () => cursor,
      readScreen: () => SCREEN,
      readAnchor: () => null,
      now: () => 1,
    });
    const sample = source.sample();
    assert.equal(sample.verified, false, `cursor ${JSON.stringify(cursor)} is outside`);
    assert.equal(sample.x, null);
    assert.equal(sample.y, null);
  }
  assert.equal(projectCursorTarget({ x: -1, y: 0 }, null, SCREEN), null);
  // An edge point is still on screen and maps to the normalized limit.
  assert.deepEqual(projectCursorTarget({ x: 1920, y: 0 }, null, SCREEN), { x: 1, y: 1 });
  console.log('[6] offscreen=-1/1921/1081 → null; edge=(1920,0) → (1,1)');
});
