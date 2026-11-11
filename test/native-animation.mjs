import assert from 'node:assert/strict';
import test from 'node:test';

import { createNativeAnimationScheduler } from '../src/host/avatar/native-animation.js';

test('native animation picks exclude the immediate previous name', () => {
  const sampler = createNativeAnimationScheduler({
    pool: ['My Animation 1', 'My Animation 2', 'My Animation 3'],
    random: () => 0,
  });
  assert.equal(sampler.pick(), 'My Animation 1');
  assert.equal(sampler.pick(), 'My Animation 2');
  const third = sampler.pick();
  assert.notEqual(third, 'My Animation 2', 'the immediate previous name is excluded');
  assert.ok(['My Animation 1', 'My Animation 3'].includes(third));
});

test('repeated names decay but remain available, and the pool can refresh', () => {
  const sampler = createNativeAnimationScheduler({
    pool: ['a', 'b'],
    random: () => 0,
  });
  assert.equal(sampler.pick(), 'a');
  assert.equal(sampler.pick(), 'b');
  // 'a' is now older than the immediate previous 'b' and can return.
  assert.equal(sampler.pick(), 'a');
  sampler.setPool(['x', 'y']);
  assert.deepEqual(sampler.pool(), ['x', 'y']);
  assert.ok(['x', 'y'].includes(sampler.pick()));
});

test('empty pools and duplicate names stay inert', () => {
  const empty = createNativeAnimationScheduler({ pool: [] });
  assert.equal(empty.pick(), null);
  const deduped = createNativeAnimationScheduler({ pool: ['  one  ', 'one', ''] });
  assert.deepEqual(deduped.pool(), ['one']);
  deduped.clear();
  assert.equal(deduped.history().length, 0);
});
