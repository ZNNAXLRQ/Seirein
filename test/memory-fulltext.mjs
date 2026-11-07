/**
 * Gap 3: every utterance is stored complete; `maxChars` only budgets the recall display view.
 *
 * Defaults used to drop anything shorter than 2 characters ("好") and cut long bodies to
 * `maxChars` at write time, so the tail was unreachable. Storage is now lossless, `minChars`
 * defaults to 1, and recall clips only the injected prefix with `displayTruncated: true`.
 *
 * Run: node --test test/memory-fulltext.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  AUTO_MEMORY_DEFAULTS,
  MemoryStore,
  normalizeAutoMemory,
} from '../src/host/memory/store.js';

async function tempRoot() {
  return mkdtemp(join(tmpdir(), 'dsh-mem-fulltext-'));
}

async function cleanup(root, memory) {
  try {
    memory.close();
  } catch {
    /* already closed */
  }
  await rm(root, { recursive: true, force: true }).catch(() => {});
}

test('defaults: minChars=1 and "好" is a real record', async (t) => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 2000 });
  t.after(() => cleanup(root, memory));

  assert.equal(AUTO_MEMORY_DEFAULTS.minChars, 1);
  assert.equal(normalizeAutoMemory({}).minChars, 1);

  const stored = memory.addMessage({
    role: 'user',
    sessionId: 'short',
    turnId: 1,
    messageId: 'short-1',
    text: '好',
  });
  assert.equal(stored.deduped, false);
  assert.equal(stored.record.text, '好');
  assert.equal(memory.messageRecords({ limit: 10 }).length, 1, 'a one-character utterance is in memory');

  const recalled = memory.recall({ query: '好' });
  assert.ok(recalled.hits.some((hit) => hit.messageId === 'short-1'), '"好" is recallable');

  console.log(`[fulltext] "好" stored length=${stored.record.text.length}; records=${memory.messageRecords({ limit: 10 }).length}`);
});

test('a 3000-character body is stored complete and only the display view is clipped', async (t) => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 2000 });
  t.after(() => cleanup(root, memory));

  const body = `关键开头${'长'.repeat(2996)}`; // 4 + 2996 = 3000 characters, tail is searchable
  assert.equal(body.length, 3000);
  const stored = memory.addMessage({
    role: 'user',
    sessionId: 'long',
    turnId: 1,
    messageId: 'long-1',
    text: body,
  });
  assert.equal(stored.deduped, false);
  assert.equal(stored.record.text.length, 3000, 'the record returned by addMessage is complete');
  assert.equal(stored.record.truncated, 0, 'storage is never marked truncated');

  const dbRow = memory.db.prepare('SELECT text, truncated FROM memory_event WHERE message_id = ?').get('long-1');
  assert.equal(dbRow.text.length, 3000, 'the database keeps the whole body');
  assert.equal(dbRow.truncated, 0);

  const recalled = memory.recall({ query: '关键开头' });
  const hit = recalled.hits.find((row) => row.messageId === 'long-1');
  assert.ok(hit !== undefined, 'the long message is recallable');
  assert.equal(hit.text.length, AUTO_MEMORY_DEFAULTS.maxChars, 'the display view uses the per-message budget');
  assert.ok(hit.text.endsWith('…'));
  assert.equal(hit.displayTruncated, true, 'the display flag is reported');
  assert.equal(hit.truncated, 1, '`truncated` describes the display view');

  // The tail stays searchable even though only the head is injected.
  const tail = memory.recall({ query: '长长长长长长' });
  assert.ok(tail.hits.some((row) => row.messageId === 'long-1'), 'the tail is still in storage');

  const after = memory.db.prepare('SELECT LENGTH(text) AS n FROM memory_event WHERE message_id = ?').get('long-1');
  assert.equal(after.n, 3000, 'recall never writes a clipped body back');

  console.log(
    `[fulltext] stored=${after.n} chars; display=${hit.text.length} (displayTruncated=${hit.displayTruncated})`,
  );
});
