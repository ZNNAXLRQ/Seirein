/**
 * Recall feedback must reinforce only the memories the model actually received.
 *
 * The bug: `assistant_recall` called `memory.restore(hits.map((hit) => hit.id))` without
 * filtering `skippedByBudget`, so a third hit the display budget could not fit (empty body) was
 * still strengthened — "a memory that never entered the context got stickier". The brief tool had
 * the same shape. The delivered-body filter now gates both calls.
 *
 * Run: node --test test/memory-restore-delivered.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { apply, deliveredRecallRows } from '../src/host/index.js';
import { MemoryStore } from '../src/host/memory/store.js';

const QUERY = '月光';
// 600 chars each: the recall display budget (600) fits row 1 (400) + row 2 (200) and no row 3.
const BODY = `${QUERY}${'长'.repeat(600 - QUERY.length)}`;

/** Mount the real plugin and expose its tools; teardown closes the store and timers. */
function mount(root) {
  const tools = new Map();
  const cleanups = [];
  const effect = (fn) => {
    const value = fn();
    if (typeof value === 'function') cleanups.push(value);
    return value;
  };
  const ctx = {
    effect,
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    inject: (_deps, register) => {
      register({
        effect,
        systemPrompt: { section: () => () => {} },
        webServer: {
          register() {
            return () => {};
          },
        },
      });
    },
  };
  apply(ctx, { root, enabled: true });
  const call = async (name, args = {}, exec = {}) => {
    const tool = tools.get(name);
    assert.ok(tool !== undefined, `tool registered: ${name}`);
    return tool.execute(args, exec);
  };
  return {
    call,
    close: () => {
      for (const fn of cleanups.reverse()) fn();
    },
  };
}

/** Seed three equal-priority fuzzy records whose bodies all match the query. */
async function seed(root) {
  const memory = new MemoryStore(root);
  memory.open();
  const ids = [];
  for (let index = 1; index <= 3; index += 1) {
    const { record } = memory.addMessage({
      role: 'user',
      sessionId: 'restore-delivered',
      turnId: index,
      messageId: `restore-${index}`,
      text: BODY,
      clarity: 'fuzzy',
      importance: 60,
    });
    ids.push(record.id);
  }
  memory.close();
  return ids;
}

/** Capture every `restore(ids)` call and expose the owning store for a row read-back. */
function captureRestore(t) {
  const calls = [];
  let store = null;
  const original = MemoryStore.prototype.restore;
  MemoryStore.prototype.restore = function patched(ids) {
    calls.push([...(ids ?? [])]);
    store = this;
    return original.call(this, ids);
  };
  t.after(() => {
    MemoryStore.prototype.restore = original;
  });
  return { calls, store: () => store };
}

function clarityRows(store, ids) {
  const read = store.db.prepare('SELECT id, clarity, importance FROM memory_event WHERE id = ?');
  return ids.map((id) => ({ ...read.get(id) }));
}

async function withRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-restore-delivered-'));
  t.after(() => rm(root, { recursive: true, force: true }).catch(() => {}));
  return root;
}

test('assistant_recall restores only the two bodies the budget delivered', async (t) => {
  const root = await withRoot(t);
  const ids = await seed(root);
  const app = mount(root);
  t.after(() => app.close());
  const capture = captureRestore(t);

  const value = await app.call('assistant_recall', { query: QUERY }, {});
  assert.equal(value.hits.length, 3, 'three hits were found');
  assert.equal(value.hits[2].skippedByBudget, true, 'the budget could not fit the third body');
  assert.equal(value.hits[2].text, '', 'the skipped hit carries no body');

  assert.equal(capture.calls.length, 1, 'restore is called once');
  assert.equal(capture.calls[0].length, 2, `restore received exactly the 2 delivered ids, got ${capture.calls[0].length}`);
  const deliveredHits = value.hits.filter((hit) => hit.skippedByBudget !== true);
  const skippedHit = value.hits.find((hit) => hit.skippedByBudget === true);
  assert.deepEqual(capture.calls[0], deliveredHits.map((hit) => hit.id));

  // Read each row by the id the tool reported, so recall order (recency) cannot confuse the check.
  const read = capture.store().db.prepare('SELECT id, clarity, importance FROM memory_event WHERE id = ?');
  for (const hit of deliveredHits) {
    const row = read.get(hit.id);
    assert.equal(row.clarity, 'clear', `delivered ${hit.id} faded up one level`);
    assert.equal(row.importance, 62, `delivered ${hit.id} gained importance`);
  }
  const skippedRow = read.get(skippedHit.id);
  assert.equal(skippedRow.clarity, 'fuzzy', 'the undelivered hit keeps its clarity');
  assert.equal(skippedRow.importance, 60, 'the undelivered hit keeps its importance');
  const summary = [deliveredHits[0], deliveredHits[1], skippedHit].map((hit) => {
    const row = read.get(hit.id);
    return [row.clarity, row.importance];
  });
  console.log(`recall: restore(${capture.calls[0].length} ids) → ${JSON.stringify(summary)}`);
});

test('assistant_memory_brief restores only the delivered matched rows', async (t) => {
  const root = await withRoot(t);
  const ids = await seed(root);
  const app = mount(root);
  t.after(() => app.close());
  const capture = captureRestore(t);

  const value = await app.call('assistant_memory_brief', { query: QUERY }, {});
  assert.equal(value.fixed, 0, 'no fixed layer is seeded');
  assert.equal(value.matched, 2, `the brief delivers 2 matched rows, got ${value.matched}`);

  assert.equal(capture.calls.length, 1, 'restore is called once');
  assert.equal(capture.calls[0].length, 2, `restore received exactly the 2 delivered ids, got ${capture.calls[0].length}`);

  // Exactly two rows were reinforced and the third stayed untouched: the brief's budget-skipped
  // hit never entered the context, so it must not fade up.
  const rows = clarityRows(capture.store(), ids);
  assert.equal(rows.filter((row) => row.clarity === 'clear' && row.importance === 62).length, 2);
  assert.equal(rows.filter((row) => row.clarity === 'fuzzy' && row.importance === 60).length, 1);
  console.log(`brief: matched=${value.matched} restore(${capture.calls[0].length} ids)`);
});

test('deliveredRecallRows drops budget-skipped and empty bodies, keeps evidence rows', () => {
  const rows = [
    { id: 'shown', text: '有正文' },
    { id: 'skipped', text: '', skippedByBudget: true },
    { id: 'empty', text: '   ' },
    { id: 'overflow', text: '证据正文', budgetOverflow: true },
  ];
  assert.deepEqual(deliveredRecallRows(rows).map((row) => row.id), ['shown', 'overflow']);
  assert.deepEqual(deliveredRecallRows(undefined), []);
  assert.deepEqual(deliveredRecallRows(null), []);
  console.log(`filter: ${rows.length} rows → ${deliveredRecallRows(rows).length} delivered`);
});
