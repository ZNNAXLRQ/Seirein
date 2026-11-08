import test from 'node:test';
import assert from 'node:assert/strict';
import { CHANNELS } from '../src/host/avatar/motion-primitives.js';
import { STYLES, OPERATIONS, RECIPES, PRESETS, getPreset, queryPresets, catalogStats } from '../src/host/avatar/presets/index.js';

test('catalog identities, channel references and styles are valid; no absolute amplitude', () => {
  assert.equal(new Set(PRESETS.map(p => p.id)).size, PRESETS.length);
  assert.equal(new Set(PRESETS.map(p => p.name)).size, PRESETS.length);
  assert.ok(RECIPES.length >= 70);
  assert.ok(PRESETS.length >= 280);
  const styles = new Set(STYLES.map(s => s.id));
  for (const preset of PRESETS) {
    assert.equal(getPreset(preset.id), preset);
    assert.ok(preset.styles.every(s => styles.has(s)));
    assert.ok(preset.requires.every(channel => CHANNELS.includes(channel)));
    assert.deepEqual([...new Set(preset.operations.flatMap(op => OPERATIONS[op]))], preset.requires);
    assert.ok(!JSON.stringify(preset).includes('amplitude'));
    assert.ok(Object.isFrozen(preset));
  }
  assert.equal(catalogStats().presets, PRESETS.length);
});

test('head-only idle remains diverse without borrowing unavailable body or gaze', () => {
  const choices = queryPresets({ state: 'idle', event: 'idle', verifiedChannels: ['headX', 'headY', 'headZ'] });
  assert.ok(choices.length >= 24);
  assert.ok(new Set(choices.map(p => p.family)).size >= 3);
  assert.ok(choices.every(p => p.requires.every(c => c.startsWith('head'))));
  assert.ok(choices.every(p => p.semantic === 'neutral'));
});

test('semantic gestures never enter idle draw; denial needs matching meaning', () => {
  assert.equal(queryPresets({ state: 'speaking', event: 'deny', verifiedChannels: CHANNELS }).length, 0);
  const deny = queryPresets({ state: 'speaking', event: 'deny', semantic: 'disagreement', verifiedChannels: CHANNELS });
  assert.ok(deny.length > 0);
  assert.ok(deny.every(p => p.family === 'negation'));
  assert.equal(queryPresets({ state: 'idle', event: 'deny', semantic: 'disagreement', verifiedChannels: CHANNELS }).length, 0);
});

test('target and sound direction require separate proofs', () => {
  const context = { state: 'listening', event: 'user-speaking', verifiedChannels: CHANNELS };
  const unproved = queryPresets(context);
  assert.ok(unproved.length > 0);
  assert.ok(unproved.every(p => !p.requiresTarget && !p.requiresDirection));
  const proved = queryPresets({ ...context, targetVerified: true, directionVerified: true });
  assert.ok(proved.some(p => p.requiresTarget));
  assert.ok(proved.some(p => p.requiresDirection));
});

test('disabled id/family and privacy/dispose cannot be bypassed', () => {
  const context = { state: 'idle', event: 'idle', verifiedChannels: CHANNELS, targetVerified: true };
  const choices = queryPresets(context);
  const result = queryPresets({ ...context, disabledIds: [choices[0].id], disabledFamilies: ['posture'] });
  assert.ok(result.length > 0);
  assert.ok(result.every(p => p.id !== choices[0].id && p.family !== 'posture'));
  assert.deepEqual(queryPresets({ ...context, privacy: true }), []);
  assert.deepEqual(queryPresets({ ...context, disposed: true }), []);
});

test('missing context and unknown model capabilities fail closed', () => {
  assert.deepEqual(queryPresets(), []);
  assert.deepEqual(queryPresets({ state: 'idle', event: 'idle' }), []);
  assert.deepEqual(queryPresets({ state: 'idle', event: 'unknown', verifiedChannels: CHANNELS }), []);
  assert.deepEqual(queryPresets({ state: 'idle', event: 'idle', family: 'unknown', verifiedChannels: CHANNELS }), []);
  assert.equal(getPreset('missing'), null);
});
