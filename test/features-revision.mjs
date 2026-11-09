/**
 * Minimal contract for `FeatureStore.revision(id)`: a read-only per-component counter bumped by
 * every `set()`. The VTS auto-connect tick records it before an awaited probe and refuses to
 * connect when it changed (close → re-open must invalidate the old probe).
 *
 * Run: node --test test/features-revision.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { FeatureStore } from '../src/host/runtime/features.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-features-revision-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  return { root, store: new FeatureStore(root) };
}

test('revision starts at 0 and increments on every set for that component only', async (t) => {
  const { store } = await fixture(t);
  assert.equal(store.revision('avatar'), 0);
  assert.equal(store.revision('hearing'), 0);

  await store.set('avatar', false);
  assert.equal(store.revision('avatar'), 1);
  assert.equal(store.revision('hearing'), 0, 'another component is untouched');
  assert.equal(store.enabled('avatar'), false);

  // A no-op set still records the caller's intent: a probe admitted before it is stale.
  await store.set('avatar', false);
  assert.equal(store.revision('avatar'), 2);

  await store.set('avatar', true);
  assert.equal(store.revision('avatar'), 3);
  assert.equal(store.enabled('avatar'), true);
});

test('revision survives persistence but is not persisted and does not change enabled()', async (t) => {
  const { root, store } = await fixture(t);
  await store.set('avatar', false);
  const saved = JSON.parse(await readFile(join(root, 'data', 'features.json'), 'utf8'));
  assert.equal(saved.avatar, false, 'the persisted switch keeps its existing shape');
  assert.equal(Object.hasOwn(saved, 'revision'), false, 'the counter is never written to disk');

  // A fresh store starts from the persisted switch with its own counter.
  const reopened = new FeatureStore(root);
  assert.equal(reopened.enabled('avatar'), false);
  assert.equal(reopened.revision('avatar'), 0);
  await assert.rejects(() => reopened.set('missing', true), /unknown feature/);
  assert.equal(reopened.revision('missing'), 0, 'an unknown id never gets a counter');
});
