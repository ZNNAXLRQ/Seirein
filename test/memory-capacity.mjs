/**
 * Memory capacity defaults (2026-11-05 user decision).
 *
 * Capacity is 5000 records; the sustained-pressure threshold is 5% of capacity (250). A database
 * written under the old 2000 default stored 100 as a *calculated* value — never a user choice —
 * so it is re-derived once for the new size. A custom threshold, record count, and every clarity
 * level are left exactly as they were: this migration never fades and never archives.
 *
 * Run: node --test test/memory-capacity.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { MemoryStore, defaultPressureThreshold } from '../src/host/memory/store.js';

/** Temp root that closes every store it handed out before deleting the directory (Windows/EBUSY). */
async function withRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-capacity-'));
  const stores = [];
  t.after(async () => {
    for (const store of stores) store.close();
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });
  const open = (options = {}) => {
    const store = new MemoryStore(root, options);
    stores.push(store);
    return store;
  };
  return { root, open };
}

/** Simulate a database written by the pre-2026-11-05 build (capacity 2000 → threshold 100). */
function seedLegacy(root, open, { rows = 0, threshold } = {}) {
  const legacy = open({ capacity: 2000 });
  legacy.open();
  if (threshold !== undefined) legacy.setPressureThreshold(threshold);
  for (let index = 0; index < rows; index += 1) {
    legacy.add('chat', `旧库记忆 ${index}：用户喜欢冰美式`, 'preference');
  }
  legacy.close();
}

test('a) a new database defaults to capacity 5000 and threshold 250', async (t) => {
  const { open } = await withRoot(t);
  const events = [];
  const store = open({ onEvent: (type, payload) => events.push({ type, payload }) });
  const usage = store.usage(); // first use opens memory.db
  const policy = store.policyState();

  assert.equal(usage.capacity, 5000, `capacity should be 5000, got ${usage.capacity}`);
  assert.equal(policy.pressureThreshold, 250, `threshold should be 250, got ${policy.pressureThreshold}`);
  assert.equal(defaultPressureThreshold(5000), 250, '5% of 5000 is 250');
  assert.deepEqual(events, [], 'a fresh database migrates nothing');
  console.log(`a) capacity=${usage.capacity} threshold=${policy.pressureThreshold}`);
});

test('b) an old calculated threshold (100) migrates to 250 exactly once', async (t) => {
  const { root, open } = await withRoot(t);
  seedLegacy(root, open, { rows: 3 });

  // The seeded file really does carry the old calculated default, written without a user choice.
  const probe = open({ capacity: 2000 });
  assert.equal(probe.policyState().pressureThreshold, 100, 'legacy file stores 100');
  probe.close();

  const events = [];
  const migrated = open({ onEvent: (type, payload) => events.push({ type, payload }) });
  const policy = migrated.policyState();
  assert.equal(policy.pressureThreshold, 250, `migrated threshold should be 250, got ${policy.pressureThreshold}`);
  assert.deepEqual(
    events,
    [{ type: 'memory.capacity.migrated', payload: { from: 100, to: 250 } }],
    `one migration event, got ${JSON.stringify(events)}`,
  );
  migrated.close();

  const reopenedEvents = [];
  const reopened = open({ onEvent: (type, payload) => reopenedEvents.push({ type, payload }) });
  assert.equal(reopened.policyState().pressureThreshold, 250, 'the migrated value survives a restart');
  assert.deepEqual(reopenedEvents, [], 'the migration is one-shot');
  console.log(
    `b) from=100 to=${reopened.policyState().pressureThreshold} events=${events.length} reopenedEvents=${reopenedEvents.length}`,
  );
});

test('c) a custom threshold (300) is never overwritten', async (t) => {
  const { root, open } = await withRoot(t);
  seedLegacy(root, open, { rows: 2, threshold: 300 });

  const events = [];
  const store = open({ onEvent: (type, payload) => events.push({ type, payload }) });
  const policy = store.policyState();
  assert.equal(policy.pressureThreshold, 300, `custom threshold should stay 300, got ${policy.pressureThreshold}`);
  assert.deepEqual(events, [], 'no migration event for a custom threshold');
  console.log(`c) capacity=${store.usage().capacity} threshold=${policy.pressureThreshold} events=${events.length}`);
});

test('d) migration leaves record count and clarity untouched', async (t) => {
  const { root, open } = await withRoot(t);
  const legacy = open({ capacity: 2000 });
  legacy.open();
  legacy.addMessage({
    role: 'user',
    messageId: 'm-1',
    text: '旧库里的用户消息：今天想听点安静的音乐',
    clarity: 'vivid',
    importance: 60,
  });
  legacy.addMessage({
    role: 'assistant',
    messageId: 'm-2',
    text: '旧库里的回复：好呀，我给你找一张安静的专辑。',
    clarity: 'fuzzy',
    importance: 40,
  });
  legacy.addMessage({
    role: 'user',
    messageId: 'm-3',
    text: '旧库里的用户消息：上周那家咖啡店叫什么来着',
    clarity: 'trace',
    importance: 20,
  });
  const before = {
    records: legacy.usage().records,
    clarity: legacy.clarityCounts(),
    archived: legacy.usage().archived,
  };
  legacy.close();

  const store = open({ onEvent: () => {} });
  store.policyState(); // opens the database → runs the capacity migration
  const after = {
    records: store.usage().records,
    clarity: store.clarityCounts(),
    archived: store.usage().archived,
  };

  assert.equal(store.policyState().pressureThreshold, 250, 'the migration did run');
  assert.deepEqual(after, before, 'rows, clarity levels and the archive are unchanged');
  assert.equal(after.records, 3, `record count should stay 3, got ${after.records}`);
  assert.deepEqual(after.clarity, { vivid: 1, clear: 0, fuzzy: 1, trace: 1 });
  console.log(
    `d) records=${after.records} archived=${after.archived} clarity=${JSON.stringify(after.clarity)}`,
  );
});
