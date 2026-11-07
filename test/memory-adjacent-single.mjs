/**
 * Gap 4: a hit's own turn is always expanded, even when it is the only recorded turn.
 *
 * The old code skipped expansion when `neighborTurns()` returned just one turn, so a session
 * with only turn 42's user/assistant pair returned the user line alone. The pair must always
 * come out together.
 *
 * Run: node --test test/memory-adjacent-single.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { MemoryStore } from '../src/host/memory/store.js';

async function tempRoot() {
  return mkdtemp(join(tmpdir(), 'dsh-mem-single-turn-'));
}

async function cleanup(root, memory) {
  try {
    memory.close();
  } catch {
    /* already closed */
  }
  await rm(root, { recursive: true, force: true }).catch(() => {});
}

test('a single recorded turn returns both its user message and its assistant reply', async (t) => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 2000 });
  t.after(() => cleanup(root, memory));

  memory.addMessage({
    role: 'user',
    sessionId: 'only-turn',
    turnId: 42,
    messageId: 'u42',
    ts: '2026-11-05T01:00:00.000Z',
    text: '单轮场景：只有这两条消息，问题关键词只在这句用户原话里',
  });
  memory.addMessage({
    role: 'assistant',
    sessionId: 'only-turn',
    turnId: 42,
    messageId: 'a42',
    ts: '2026-11-05T01:00:01.000Z',
    text: '好的，这是同一轮的答复，本身不含命中词。',
  });

  // Precondition: the hit's own turn really has no neighbours.
  assert.deepEqual(memory.neighborTurns('only-turn', 42, 1), [42], 'turn 42 is the only recorded turn');

  const recalled = memory.recall({ query: '单轮场景的问题关键词' });
  const ids = recalled.hits.map((row) => row.messageId);
  assert.ok(ids.includes('u42'), 'the matching user message is returned');
  assert.ok(ids.includes('a42'), 'the same-turn assistant reply rides along');
  assert.equal(recalled.expanded, true, 'the recall reports that it expanded context');
  assert.equal(recalled.hits.length, 2);

  console.log(`[single-turn] hits=${ids.join('+')} expanded=${recalled.expanded}`);
});
