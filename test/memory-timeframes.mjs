/**
 * Gap 5: time phrases must describe the window users mean, and the event must show it.
 *
 *   - "上周" is the previous natural ISO week (local Monday 00:00 → this Monday 00:00), not a
 *     rolling 14–7 day window.
 *   - "上次" is relevance-first and not capped at 7 days: it searches a wide 90-day window and
 *     widens once when no keyword hit existed at all.
 *   - `memory.recall` records the actual `from`/`to` used.
 *
 * Run: node --test test/memory-timeframes.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { recallVoiceMemory } from '../src/host/index.js';
import { MemoryStore, detectTimeRange } from '../src/host/memory/store.js';

async function tempRoot() {
  return mkdtemp(join(tmpdir(), 'dsh-mem-time-'));
}

async function cleanup(root, memory) {
  try {
    memory.close();
  } catch {
    /* already closed */
  }
  await rm(root, { recursive: true, force: true }).catch(() => {});
}

function eventLog() {
  const events = [];
  return {
    events,
    async emit(type, payload) {
      events.push({ type, payload });
      return { type, payload };
    },
  };
}

const add = (memory, { id, ts, text, turn = 1, role = 'user' }) => memory.addMessage({
  role,
  // One session per record: this suite tests the time window, not adjacency expansion.
  sessionId: `time-session-${id}`,
  turnId: turn,
  messageId: id,
  ts: ts.toISOString(),
  text,
});

/** Local Monday 00:00 of the ISO week containing `date`. */
function weekStart(date) {
  const start = new Date(date.getTime());
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  return start;
}

test('"上周" means the previous natural ISO week, boundaries included/excluded correctly', async (t) => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 2000 });
  t.after(() => cleanup(root, memory));

  const now = new Date(2026, 10, 5, 10, 0, 0); // Thursday 2026-11-05, local
  const thisMonday = weekStart(now); // 2026-11-02 00:00 local
  const lastMonday = new Date(thisMonday.getTime());
  lastMonday.setDate(lastMonday.getDate() - 7); // 2026-10-26 00:00 local

  const mondayMorning = new Date(lastMonday.getTime());
  mondayMorning.setHours(9, 0, 0, 0); // first day, included
  const sundayNight = new Date(thisMonday.getTime());
  sundayNight.setDate(sundayNight.getDate() - 1);
  sundayNight.setHours(23, 59, 0, 0); // last day, included
  const earlier = new Date(lastMonday.getTime());
  earlier.setDate(earlier.getDate() - 1);
  earlier.setHours(23, 59, 0, 0); // previous Sunday, excluded
  const thisMondayMidnight = new Date(thisMonday.getTime()); // boundary end, excluded

  add(memory, { id: 'prev-mon', ts: mondayMorning, text: '上周一早上说的第一句话' });
  add(memory, { id: 'prev-sun', ts: sundayNight, text: '上周日晚上说的最后一句话' });
  add(memory, { id: 'prev-before', ts: earlier, text: '上上周日的话不该进上周' });
  add(memory, { id: 'prev-next', ts: thisMondayMidnight, text: '本周一零点的话不该进上周' });

  const range = detectTimeRange('上周', now);
  assert.equal(range.fromIso, lastMonday.toISOString(), 'from = previous Monday local midnight');
  assert.equal(range.toIso, thisMonday.toISOString(), 'to = this Monday local midnight (exclusive)');
  assert.equal(range.relaxable, undefined);

  const recalled = memory.recall({ query: '上周', now });
  const ids = new Set(recalled.hits.map((hit) => hit.messageId));
  assert.equal(recalled.range, '上周');
  assert.equal(recalled.from, lastMonday.toISOString());
  assert.equal(recalled.to, thisMonday.toISOString());
  assert.ok(ids.has('prev-mon'), 'Monday 00:00+ is inside the week');
  assert.ok(ids.has('prev-sun'), 'Sunday 23:59 is inside the week');
  assert.ok(!ids.has('prev-before'), 'the Sunday before is outside');
  assert.ok(!ids.has('prev-next'), 'this Monday 00:00 is outside (half-open)');

  console.log(
    `[week] window=${recalled.from}..${recalled.to} hits=${[...ids].join(',')}`,
  );
});

test('"上次" finds a 10-day-old event, relaxes past 90 days, and the event records from/to', async (t) => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 2000 });
  t.after(() => cleanup(root, memory));

  const now = new Date(2026, 10, 5, 10, 0, 0);
  const tenDaysAgo = new Date(now.getTime() - 10 * 86_400_000);
  const oldDaysAgo = new Date(now.getTime() - 120 * 86_400_000);
  add(memory, { id: 'last-10', ts: tenDaysAgo, text: '上次讨论的部署方案是蓝绿发布' });

  const expectedFrom = new Date(now.getTime() - 90 * 86_400_000).toISOString();
  const recent = memory.recall({ query: '上次讨论的部署方案', now });
  const recentHit = recent.hits.find((hit) => hit.messageId === 'last-10');
  assert.ok(recentHit !== undefined, '10 days ago is inside the wide "上次" window');
  assert.equal(recent.range, '上次');
  assert.equal(recent.from, expectedFrom, 'the 90-day floor is reported');
  assert.equal(recent.to, now.toISOString());
  assert.equal(recent.relaxed, false);

  // The event carries the actual resolved window. recallVoiceMemory has no injectable clock, so
  // derive the expected floor from the event's own upper bound (which is the same resolution).
  const log = eventLog();
  await recallVoiceMemory({ memory, log, query: '上次讨论的部署方案', sessionId: 'time-session' });
  const recallEvent = log.events.find((event) => event.type === 'memory.recall');
  const eventRange = detectTimeRange('上次讨论的部署方案', new Date(recallEvent.payload.to));
  assert.equal(recallEvent?.payload.from, eventRange.fromIso);
  assert.equal(recallEvent?.payload.to, eventRange.toIso);
  assert.equal(recallEvent?.payload.relaxed, false);

  // A 120-day-old event is outside the 90-day probe; with no keyword hit inside, recall widens
  // once to the unbounded window and still finds it.
  add(memory, { id: 'last-120', ts: oldDaysAgo, text: '很久以前的发布计划要等下个季度' });
  const widened = memory.recall({ query: '上次发布的计划', now });
  const oldHit = widened.hits.find((hit) => hit.messageId === 'last-120');
  assert.ok(oldHit !== undefined, 'the widened search reaches beyond 90 days');
  assert.equal(widened.relaxed, true, 'widening is visible in the result');
  assert.equal(widened.from, null, 'the actual lower bound is unbounded after widening');
  assert.equal(widened.to, now.toISOString());

  console.log(
    `[last] 10d hit=${recentHit?.messageId} window=${recent.from}..${recent.to}; `
      + `widened hit=${oldHit?.messageId} from=${widened.from} relaxed=${widened.relaxed}`,
  );
});
