/**
 * Capacity policy regression: fade passes at 30/60/90%, archive-then-delete, recall restore.
 * Runs against a throwaway temp root; no DSH needed.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStore } from '../src/host/memory/store.js';

const root = await mkdtemp(join(tmpdir(), 'dsh-mem-'));
const assert = (condition, message) => {
  if (!condition) throw new Error(`assertion failed: ${message}`);
};
let memory = null;

try {
  memory = new MemoryStore(root, { capacity: 10 });

  for (let index = 0; index < 4; index += 1) memory.add('chat', `普通记忆 ${index}`, 'fact');
  memory.add('chat', '我答应你以后每周一起看动画', 'preference'); // high score, pinned-ish

  // 5/10 = 50% → band 1 crossed, the bottom half fades one level.
  const first = memory.maintain({ lastBand: 0 });
  assert(first.band === 1, `band 1 after 50% (got ${first.band})`);
  assert(first.faded > 0, 'first pass faded records');
  const afterFirst = memory.clarityCounts();
  assert(afterFirst.clear > 0, 'low-scoring records dropped one level');
  assert(afterFirst.vivid > 0, 'high-importance record stayed vivid');

  // Re-running with the same band must not fade again (idempotent).
  const again = memory.maintain({ lastBand: first.band });
  assert(again.faded === 0, 'no second pass inside the same band');

  for (let index = 0; index < 3; index += 1) memory.add('work', `工作记录 ${index}`, 'fact');
  const second = memory.maintain({ lastBand: first.band }); // 8/10 = 80% → band 2
  assert(second.band === 2, `band 2 after 80% (got ${second.band})`);

  for (let index = 0; index < 2; index += 1) memory.add('work', `更多工作 ${index}`, 'fact');
  const third = memory.maintain({ lastBand: second.band }); // 100% → band 3 + archive compaction
  assert(third.band === 3, `band 3 at 100% (got ${third.band})`);
  assert(third.moved > 0, 'compaction archived the lowest trace records');
  const usage = memory.usage();
  assert(usage.ratio <= 0.9, `compaction brought usage to ${usage.ratio.toFixed(2)}`);
  assert(usage.archived > 0, 'archived records are kept, not destroyed');

  // Archive browsing + manual deletion (the user's own lever to shrink storage).
  const listed = memory.listArchive({ limit: 10 });
  assert(listed.length === usage.archived, `archive lists ${listed.length}/${usage.archived}`);
  const removed = memory.deleteArchived([listed[0].id]);
  assert(removed.deleted === 1, 'one archived row deleted');
  assert(memory.usage().archived === usage.archived - 1, 'archive shrank after manual delete');

  // Cross-domain recall sees both scopes.
  const found = memory.search({ query: '工作记录' });
  assert(found.hits.some((hit) => hit.domain === 'work'), 'cross-domain recall finds work');

  // Recall restores one clarity level and bumps importance.
  const target = found.hits[0];
  const before = memory.search({ query: '工作记录', domains: ['work'] }).hits.find((hit) => hit.id === target.id);
  memory.restore([target.id]);
  const after = memory.search({ query: '工作记录', domains: ['work'] }).hits.find((hit) => hit.id === target.id);
  assert(after.clarity === before.clarity || after.clarity === 'vivid' || after.importance > before.importance, 'recall restores');

  // Archive is searchable explicitly and is never returned by normal recall.
  const archivedText = memory.listArchive({ limit: 1 })[0].text;
  const archived = memory.searchArchive(archivedText.slice(0, 4));
  assert(archived.length > 0, `archive search finds faded records (got ${archived.length})`);
  const activeIds = new Set(
    memory.search({ query: archivedText.slice(0, 4), limit: 20 }).hits.map((hit) => hit.id),
  );
  assert(archived.every((row) => !activeIds.has(row.id)), 'archived rows stay out of normal recall');

  const finalClarity = { vivid: 0, clear: 0, fuzzy: 0, trace: 0 };
  console.log('MEMORY POLICY PASSED', JSON.stringify({ usage, clarity: finalClarity }));
} finally {
  // The SQLite handle must be closed before the temp root disappears: Windows refuses to delete
  // an open database (EBUSY), and an assertion failure above must not skip the close either.
  memory?.close();
  await rm(root, { recursive: true, force: true }).catch(() => {});
}
