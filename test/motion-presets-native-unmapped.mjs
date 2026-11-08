/**
 * 动作预设不可用原因的两种区分（只读文案，不改判定）：
 *   native-unmapped   → 当前模型未映射：bodyX / bodyY / bodyZ / breath（VTS 原生所有权，未映射）
 *   channel-unverified → 能力未验证：可注入但尚未验证的语义通道
 *
 * 本测试验证：
 *   1) 模型缺 body/breath 时，5 条 idle 配方（20 条预设）标为“当前模型未映射”，不混入“能力未验证”；
 *   2) 缺 headZ 等可注入通道时仍是“能力未验证”；
 *   3) verified 增加原生通道后，原被排除的配方自动恢复为候选（同一 refresh 路径，无需重启）；
 *   4) 原因文案不影响判定：available 数量与库自身硬过滤的参考值一致；
 *   5) 不删预设、不写映射、不伪造能力（只读字段 + 原有硬过滤）。
 *
 * Run: node --test test/motion-presets-native-unmapped.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OPERATIONS, PRESETS } from '../src/host/avatar/presets/index.js';
import { PRESET_NATIVE_CHANNELS } from '../src/host/avatar/motion-config.js';
import {
  createAvatarSettingsActions,
  createMotionPresetOverridesStore,
} from '../src/host/avatar/settings-actions.js';

const FULL_CHANNELS = Object.freeze([...new Set(Object.values(OPERATIONS).flat())]);
const NATIVE = new Set(PRESET_NATIVE_CHANNELS);
/** Simulates a model whose body/breath inputs are not mapped: every other channel is verified. */
const INJECTABLE_CHANNELS = FULL_CHANNELS.filter(channel => !NATIVE.has(channel));

const makeEnv = (initialVerified = INJECTABLE_CHANNELS) => {
  const root = mkdtempSync(join(tmpdir(), 'seirein-motion-native-unmapped-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  const file = join(root, 'data', 'motion-presets.json');
  const events = [];
  const log = {
    emit: (type, payload) => {
      events.push({ type, payload });
      return Promise.resolve();
    },
  };
  const store = createMotionPresetOverridesStore({ file, log });
  let verified = [...initialVerified];
  const services = {
    motionPresetStore: store,
    log,
    // The refresh path reads this on every list call: a new verified set takes effect immediately.
    avatarCapabilitiesStatus: () => ({ verified: [...verified] }),
    avatarMotionLockReasons: [],
  };
  return {
    root,
    file,
    events,
    store,
    services,
    handler: createAvatarSettingsActions(services),
    addVerified: (channel) => { if (!verified.includes(channel)) verified = [...verified, channel]; },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
};

const listOf = (env, body = {}) => env.handler({ action: 'motion.presets.list', ...body });

/** Recipes whose required channels include a VTS-native one; exactly the body/breath family. */
const NATIVE_RECIPES = Object.freeze(
  [...new Set(PRESETS.filter(preset => preset.requires.some(channel => NATIVE.has(channel)))
    .map(preset => preset.recipeId))].sort(),
);

// ---------------------------------------------------------------------------------------------
// 1. A model without body/breath: the five idle recipes say "当前模型未映射", not "能力未验证"
// ---------------------------------------------------------------------------------------------
test('1. 模型缺 body/breath：5 条 idle 配方标“当前模型未映射”，不混入“能力未验证”', async (t) => {
  const env = makeEnv();
  t.after(env.cleanup);

  const result = await listOf(env);
  assert.equal(result.ok, true);
  assert.equal(result.items.length, 320, '预设库仍是 320 条（不删除任何预设）');
  assert.deepEqual(result.unmappedNative, ['bodyX', 'bodyY', 'bodyZ', 'breath']);

  const affected = result.items.filter(item => item.requires.some(channel => NATIVE.has(channel)));
  const recipeIds = [...new Set(affected.map(item => item.recipe))].sort();
  assert.deepEqual(recipeIds, [...NATIVE_RECIPES]);
  assert.equal(recipeIds.length, 5, `5 条 idle 配方：${recipeIds.join(', ')}`);
  assert.equal(affected.length, 20, '5 条配方 × 4 种节奏变体');
  assert.ok(affected.every(item => item.reason.includes('当前模型未映射')), '每条都标为当前模型未映射');
  assert.ok(affected.every(item => !item.reason.includes('能力未验证')), '原生未映射不混入能力未验证');
  assert.ok(affected.every(item => item.available === false), '仍硬过滤，不降级为候选');
  assert.match(
    affected.find(item => item.recipe === 'idle-body-head').reason,
    /^当前模型未映射：bodyX$/,
    '头部已验证、仅 bodyX 原生未映射',
  );

  console.log(`[native] recipes=${recipeIds.join('|')} presets=${affected.length}`
    + ` available=${result.items.filter(item => item.available).length}`
    + ` unmappedNative=${result.unmappedNative.join('|')}`
    + ` reason="${affected[0].reason}"`);
});

// ---------------------------------------------------------------------------------------------
// 2. A missing injectable channel (headZ) keeps the distinct "能力未验证" wording
// ---------------------------------------------------------------------------------------------
test('2. 缺 headZ 等可注入通道：仍是“能力未验证”，原生文案不串用', async (t) => {
  const env = makeEnv(INJECTABLE_CHANNELS.filter(channel => channel !== 'headZ'));
  t.after(env.cleanup);

  const result = await listOf(env);
  const tilt = result.items.find(item => item.recipe === 'idle-tilt');
  assert.deepEqual(tilt.requires, ['headZ']);
  assert.equal(tilt.available, false);
  assert.match(tilt.reason, /^能力未验证：headZ$/);
  assert.ok(!tilt.reason.includes('当前模型未映射'));

  // Only VTS-native channels may ever appear after "当前模型未映射：" (headZ must not leak in).
  const nativeLabels = result.items
    .map(item => item.reason.match(/当前模型未映射：([^；]*)/u))
    .filter(Boolean)
    .flatMap(match => match[1].split('、'));
  assert.ok(nativeLabels.length > 0);
  assert.ok(nativeLabels.every(channel => NATIVE.has(channel)), `headZ 未被误标为原生：${nativeLabels.join('、')}`);
  assert.ok(!result.unmappedNative.includes('headZ'), 'headZ 是能力未验证，不进 unmappedNative');

  console.log(`[injectable] tilt="${tilt.reason}" nativeLabels=${[...new Set(nativeLabels)].join('|')}`
    + ` unmappedNative=${result.unmappedNative.join('|')}`);
});

// ---------------------------------------------------------------------------------------------
// 3. A later verified native mapping restores the presets automatically (existing refresh path)
// ---------------------------------------------------------------------------------------------
test('3. verified 增加原生通道后，被排除的配方自动恢复候选（无需重启）', async (t) => {
  const env = makeEnv();
  t.after(env.cleanup);

  const before = await listOf(env);
  for (const item of before.items.filter(entry => entry.requires.some(channel => NATIVE.has(channel)))) {
    assert.equal(item.available, false, `${item.presetId} 在未映射时被排除`);
  }

  const restored = new Map([
    ['bodyX', 'idle-lean'],
    ['bodyY', 'idle-body-settle'],
    ['bodyZ', 'idle-body-tilt'],
    ['breath', 'idle-breath'],
  ]);
  for (const [channel, recipeId] of restored) {
    env.addVerified(channel);
    const after = await listOf(env);
    const item = after.items.find(entry => entry.recipe === recipeId);
    assert.equal(item.available, true, `${recipeId} 在 ${channel} 验证后恢复候选`);
    assert.equal(item.reason, '', `${recipeId} 恢复后不再有原因`);
    assert.ok(!after.unmappedNative.includes(channel), `${channel} 离开 unmappedNative`);
  }

  const allVerified = await listOf(env);
  assert.deepEqual(allVerified.unmappedNative, []);
  const nativeAvailable = allVerified.items.filter(item => item.requires.some(channel => NATIVE.has(channel)));
  assert.equal(nativeAvailable.length, 20);
  assert.ok(nativeAvailable.every(item => item.available === true), '四条原生通道都验证后全部恢复');

  console.log(`[restore] before=${before.items.filter(item => item.available).length}`
    + ` after=${allVerified.items.filter(item => item.available).length}`
    + ` nativeAvailable=${nativeAvailable.length} unmappedNative=[]`);
});

// ---------------------------------------------------------------------------------------------
// 4. The wording change never changes the decision: available equals the library's hard filter
// ---------------------------------------------------------------------------------------------
test('4. 判定不受文案影响：available 数量与库硬过滤参考值一致，原因只读', async (t) => {
  const env = makeEnv();
  t.after(env.cleanup);

  const result = await listOf(env, { targetVerified: true, directionVerified: true });
  const expected = PRESETS.filter(preset => preset.requires.every(channel => INJECTABLE_CHANNELS.includes(channel)));
  const available = result.items.filter(item => item.available);
  assert.equal(available.length, expected.length);
  assert.equal(available.length, 300, '320 − 5 条原生配方 × 4 变体');
  assert.ok(result.items.every(item => item.available === (item.reason === '')), 'available 仍等价于无原因');
  assert.ok(result.items.every(item => typeof item.reason === 'string'), 'reason 字段保持不变');
  assert.ok(result.items.every(item => !('unmappedNative' in item)), 'unmappedNative 只在顶层只读诊断');

  // The library itself was never rewritten: the id set and requirement lists are untouched.
  assert.equal(PRESETS.length, 320);
  assert.equal(new Set(PRESETS.map(preset => preset.id)).size, 320);
  for (const item of result.items) {
    const preset = PRESETS.find(entry => entry.id === item.presetId);
    assert.deepEqual(item.requires, [...preset.requires], `${item.presetId} requires 未被改写`);
  }

  const full = makeEnv(FULL_CHANNELS);
  t.after(full.cleanup);
  const fullList = await listOf(full, { targetVerified: true, directionVerified: true });
  assert.equal(fullList.items.filter(item => item.available).length, 320);
  assert.deepEqual(fullList.unmappedNative, []);

  console.log(`[decision] available=${available.length}/320 expected=${expected.length}`
    + ` unavailable=${result.items.length - available.length}`
    + ` fullVerifiedAvailable=${fullList.items.filter(item => item.available).length}`);
});
