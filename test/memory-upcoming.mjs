/**
 * Task B: near-term convention recall, graded by relative day.
 *
 * The pre-request recall (`recall()` / `brief()`) re-ranks records that name a day inside a
 * three-day window around `now`, with a graded multiplier instead of one fixed bump:
 *   - today      ×3.0  the convention is due right now;
 *   - previous   ×1.5  a just-due convention is still the most likely referent;
 *   - next day   ×1.2  a deliberate "echo": raised, but always below the previous day;
 *   - other days ×1.0  untouched — including two days back and two days ahead.
 * Absolute `YYYY-MM-DD` dates and the weekly ("每周六", "每个周末") / monthly ("每月5号") repeats
 * share the same relative-day rule (a repeat names its next occurrence, so it is today or next).
 * The weight only REORDERS rows the query already retrieved: it never adds a candidate, never
 * forces a row into the block, and never lets the six-row / 1200-character budget slip.
 *
 * Run: node --test test/memory-upcoming.mjs
 *      MEMORY_TEST_NOW=2026-11-08T10:00:00+08:00 node --test test/memory-upcoming.mjs  (pretend-day)
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  MemoryStore,
  UPCOMING_INJECT,
  UPCOMING_SPAN_DAYS,
  UPCOMING_WEIGHTS,
  UPCOMING_WINDOW,
  upcomingConvention,
} from '../src/host/memory/store.js';

async function tempRoot() {
  return mkdtemp(join(tmpdir(), 'dsh-mem-upcoming-'));
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
    onEvent(type, payload) {
      events.push({ type, payload });
    },
  };
}

const upcomingEvents = (log) => log.events.filter((entry) => entry.type === 'memory.upcoming');

const ids = (recalled) => recalled.hits.map((hit) => hit.messageId);

const scoreOf = (recalled, messageId) => recalled.hits.find((hit) => hit.messageId === messageId).score;

const levelOf = (recalled, messageId) => recalled.hits.find((hit) => hit.messageId === messageId).upcomingLevel;

/** The graded facts of one convention evaluation, without the verbose hit list. */
const graded = (text, now) => {
  const value = upcomingConvention(text, now);
  return { matched: value.matched, level: value.level, weight: value.weight, distanceDays: value.distanceDays };
};

/**
 * Store one message with an explicit timestamp. `source: 'manual'` keeps the auto-write penalty
 * out of the comparison, and no session/turn means the block is only the direct hits.
 */
const add = (memory, messageId, text, ts, extra = {}) => memory.addMessage({
  role: 'user',
  sessionId: '',
  turnId: null,
  messageId,
  ts,
  text,
  source: 'manual',
  importance: 50,
  ...extra,
});

/** Two timestamps: `older` loses the recency tie-break, `newer` wins it. */
function stamps() {
  const now = Date.now();
  return {
    older: new Date(now - 40 * 86_400_000).toISOString(),
    newer: new Date(now - 2 * 86_400_000).toISOString(),
  };
}

/**
 * The fixed clock the relative-day assertions grade against. The suite must never read the real
 * system date: storing a literal `YYYY-MM-DD` next to `recall()`'s default clock made test 8 fail on
 * the day after that literal (2026-11-07). Every dated record below is derived from CLOCK instead.
 * `MEMORY_TEST_NOW` shifts the clock so the suite can be re-run as a "pretend tomorrow" check.
 */
const CLOCK = new Date(process.env.MEMORY_TEST_NOW ?? '2026-11-07T10:00:00+08:00');

/** Local calendar day at `offsetDays` from CLOCK (13:00 unless an hour/minute is given). */
const dayAt = (offsetDays, hour = 13, minute = 0) => (
  new Date(CLOCK.getFullYear(), CLOCK.getMonth(), CLOCK.getDate() + offsetDays, hour, minute, 0)
);

/** `YYYY-MM-DD` in local time — the exact shape the normalizer stores in a record body. */
const stampOf = (value) => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;

/** The local calendar stamp `offsetDays` from CLOCK, written the way a stored record carries it. */
const todayStamp = (offsetDays = 0) => stampOf(dayAt(offsetDays));

// A fixed reference week for the pure weekday/monthly unit tests: these take `now` explicitly and
// are independent of CLOCK, so shifting MEMORY_TEST_NOW never changes what they assert.
const FRI = new Date(2026, 10, 6, 13, 0, 0); // 2026-11-06, a Friday
const SAT = new Date(2026, 10, 7, 13, 0, 0); // 2026-11-07, a Saturday
const SUN = new Date(2026, 10, 8, 13, 0, 0); // 2026-11-08, a Sunday
const WED = new Date(2026, 10, 4, 13, 0, 0); // 2026-11-04, a Wednesday

test('1) the same candidate set ranks today > previous > next > an unrelated day', async (t) => {
  const root = await tempRoot();
  const log = eventLog();
  const memory = new MemoryStore(root, { capacity: 100, onEvent: log.onEvent });
  t.after(() => cleanup(root, memory));
  const { newer } = stamps();

  // Same body, same keyword overlap and the same stored timestamp: only the named day differs, so
  // the ordering is decided by the graded weight alone (the retrieval-order term is ≤0.75 of the
  // ~15-point base, far below the gaps between levels).
  add(memory, 'dated-today', `我们说好 ${todayStamp(0)} 一起看动画`, newer);
  add(memory, 'dated-prev', `我们说好 ${todayStamp(-1)} 一起看动画`, newer);
  add(memory, 'dated-next', `我们说好 ${todayStamp(1)} 一起看动画`, newer);
  add(memory, 'dated-far', `我们说好 ${todayStamp(4)} 一起看动画`, newer);

  const recalled = memory.recall({ query: '一起看动画', now: CLOCK });
  assert.deepEqual(ids(recalled), ['dated-today', 'dated-prev', 'dated-next', 'dated-far']);
  assert.ok(
    scoreOf(recalled, 'dated-today') > scoreOf(recalled, 'dated-prev')
      && scoreOf(recalled, 'dated-prev') > scoreOf(recalled, 'dated-next')
      && scoreOf(recalled, 'dated-next') > scoreOf(recalled, 'dated-far'),
    'scores descend today > prev > next > unrelated',
  );
  assert.equal(levelOf(recalled, 'dated-today'), 'today');
  assert.equal(levelOf(recalled, 'dated-prev'), 'prev');
  assert.equal(levelOf(recalled, 'dated-next'), 'next');
  assert.equal(levelOf(recalled, 'dated-far'), null, 'a day outside the window has no level');

  assert.equal(recalled.hits.length, 4, 'the candidate set is exactly what was retrieved');
  assert.equal(recalled.upcoming.matched, 3, 'the three in-window candidates were raised');
  assert.equal(recalled.upcoming.windowDays, UPCOMING_SPAN_DAYS);
  assert.deepEqual(recalled.upcoming.levels, { today: 1, prev: 1, next: 1 });

  const event = upcomingEvents(log).at(-1);
  assert.ok(event !== undefined, 'memory.upcoming is emitted when something was raised');
  assert.deepEqual(event.payload, {
    matched: 3,
    windowDays: 3,
    levels: { today: 1, prev: 1, next: 1 },
  });
  console.log(
    `[upcoming 1] order=${ids(recalled).join(',')} scores=${ids(recalled).map((id) => scoreOf(recalled, id)).join('>')}`
      + ` levels=${JSON.stringify(recalled.upcoming.levels)}`,
  );
});

test('2) two days back and two days ahead are not raised at all', async (t) => {
  // Unit level: both days are outside the three-day window and keep the neutral ×1 weight.
  const day = (offset) => `我们说好 ${todayStamp(offset)} 一起看动画`;
  assert.deepEqual(graded(day(-2), CLOCK), { matched: false, level: null, weight: 1, distanceDays: null });
  assert.deepEqual(graded(day(2), CLOCK), { matched: false, level: null, weight: 1, distanceDays: null });
  assert.deepEqual(graded(day(-1), CLOCK), { matched: true, level: 'prev', weight: 1.5, distanceDays: -1 });
  assert.deepEqual(graded(day(0), CLOCK), { matched: true, level: 'today', weight: 3, distanceDays: 0 });
  assert.deepEqual(graded(day(1), CLOCK), { matched: true, level: 'next', weight: 1.2, distanceDays: 1 });

  // Recall level: candidates on those days stay exactly at their base score and emit no event.
  const root = await tempRoot();
  const log = eventLog();
  const memory = new MemoryStore(root, { capacity: 100, onEvent: log.onEvent });
  t.after(() => cleanup(root, memory));
  const { newer } = stamps();
  add(memory, 'dated-minus2', day(-2), newer);
  add(memory, 'dated-plus2', day(2), newer);
  add(memory, 'plain', '我们说好一起看动画', newer);

  const first = memory.recall({ query: '一起看动画', now: CLOCK });
  const second = memory.recall({ query: '一起看动画', now: dayAt(48, 9) });
  assert.equal(first.upcoming.matched, 0, 'neither out-of-window day is raised');
  assert.deepEqual(first.upcoming.levels, { today: 0, prev: 0, next: 0 });
  assert.equal(levelOf(first, 'dated-minus2'), null);
  assert.equal(levelOf(first, 'dated-plus2'), null);
  assert.deepEqual(ids(first), ids(second), 'an out-of-window date cannot reorder anything');
  assert.equal(upcomingEvents(log).length, 0, 'no promotion event for out-of-window dates');
});

test('3) weekly, monthly and weekend repeats share the same relative-day rule', () => {
  // A repeat names its NEXT occurrence: it can be today or the next day, never the previous day.
  assert.deepEqual(graded('我答应你每周六一起看动画', FRI), { matched: true, level: 'next', weight: 1.2, distanceDays: 1 });
  assert.deepEqual(graded('我答应你每周六一起看动画', SAT), { matched: true, level: 'today', weight: 3, distanceDays: 0 });
  assert.deepEqual(graded('我答应你每周六一起看动画', SUN), { matched: false, level: null, weight: 1, distanceDays: null });
  assert.deepEqual(graded('说好每月5号交房租', WED), { matched: true, level: 'next', weight: 1.2, distanceDays: 1 });
  assert.deepEqual(graded('说好每月5号交房租', new Date(2026, 10, 5, 13, 0, 0)), {
    matched: true, level: 'today', weight: 3, distanceDays: 0,
  });
  assert.deepEqual(graded('说好每月5号交房租', new Date(2026, 10, 3, 13, 0, 0)), {
    matched: false, level: null, weight: 1, distanceDays: null,
  });
  assert.deepEqual(graded('我们每个周末去散步', FRI), { matched: true, level: 'next', weight: 1.2, distanceDays: 1 });
  assert.deepEqual(graded('我们每个周末去散步', SAT), { matched: true, level: 'today', weight: 3, distanceDays: 0 });
  // The weights are the exported table, so a test cannot drift from the ranking code.
  assert.deepEqual(UPCOMING_WEIGHTS, { today: 3, prev: 1.5, next: 1.2 });
  assert.deepEqual(UPCOMING_WINDOW, { lookbackDays: 1, aheadDays: 1 });
});

test('4) an absolute date equal to now leads the block', async (t) => {
  const root = await tempRoot();
  const log = eventLog();
  const memory = new MemoryStore(root, { capacity: 100, onEvent: log.onEvent });
  t.after(() => cleanup(root, memory));
  const { older, newer } = stamps();

  add(memory, 'dated-today', `我们说好 ${todayStamp(0)} 一起看动画`, older);
  add(memory, 'dated-far', `我们说好 ${todayStamp(48)} 一起看动画`, newer);

  const recalled = memory.recall({ query: '看动画', now: CLOCK });
  assert.deepEqual(ids(recalled), ['dated-today', 'dated-far'], 'the dated-today row outranks the newer tie');
  assert.equal(recalled.upcoming.matched, 1, 'exactly one candidate was raised');
  assert.equal(recalled.upcoming.windowDays, UPCOMING_WINDOW.lookbackDays + UPCOMING_WINDOW.aheadDays + 1);
  assert.deepEqual(recalled.upcoming.levels, { today: 1, prev: 0, next: 0 });
  const event = upcomingEvents(log).at(-1);
  assert.ok(event !== undefined, 'memory.upcoming is emitted when something was raised');
  assert.deepEqual(event.payload, { matched: 1, windowDays: 3, levels: { today: 1, prev: 0, next: 0 } });
  console.log(`[upcoming 4] order=${ids(recalled).join(',')} event=${JSON.stringify(event.payload)}`);
});

test('5) a date three days out is outside the window and is not raised', async (t) => {
  const root = await tempRoot();
  const log = eventLog();
  const memory = new MemoryStore(root, { capacity: 100, onEvent: log.onEvent });
  t.after(() => cleanup(root, memory));
  const { older, newer } = stamps();

  add(memory, 'dated-plus3', `我们说好 ${todayStamp(3)} 一起看动画`, older);
  add(memory, 'dated-far', `我们说好 ${todayStamp(48)} 一起看动画`, newer);

  const recalled = memory.recall({ query: '看动画', now: CLOCK });
  assert.deepEqual(ids(recalled), ['dated-far', 'dated-plus3'], 'the newer tie wins, the +3d date gets no weight');
  assert.equal(recalled.upcoming.matched, 0);
  assert.equal(upcomingEvents(log).length, 0, 'no promotion event for a plain recall');
});

test('6) 每周六 is raised on Saturday (today, ×3)', async (t) => {
  const root = await tempRoot();
  const log = eventLog();
  const memory = new MemoryStore(root, { capacity: 100, onEvent: log.onEvent });
  t.after(() => cleanup(root, memory));
  const { older, newer } = stamps();

  add(memory, 'weekly-sat', '我答应你每周六一起看动画', older);
  add(memory, 'occasional', '偶尔一起看动画', newer);

  const recalled = memory.recall({ query: '一起看动画', now: SAT });
  assert.deepEqual(ids(recalled), ['weekly-sat', 'occasional'], 'today is the named weekday');
  assert.equal(recalled.upcoming.matched, 1);
  assert.deepEqual(recalled.upcoming.levels, { today: 1, prev: 0, next: 0 });
  assert.deepEqual(upcomingEvents(log).at(-1).payload, { matched: 1, windowDays: 3, levels: { today: 1, prev: 0, next: 0 } });
});

test('7) 每周六 is not raised on Wednesday', async (t) => {
  const root = await tempRoot();
  const log = eventLog();
  const memory = new MemoryStore(root, { capacity: 100, onEvent: log.onEvent });
  t.after(() => cleanup(root, memory));
  const { older, newer } = stamps();

  add(memory, 'weekly-sat', '我答应你每周六一起看动画', older);
  add(memory, 'occasional', '偶尔一起看动画', newer);

  const recalled = memory.recall({ query: '一起看动画', now: WED });
  assert.deepEqual(ids(recalled), ['occasional', 'weekly-sat'], 'three days before is not imminent');
  assert.equal(recalled.upcoming.matched, 0);
  assert.equal(upcomingEvents(log).length, 0);
});

test('8) the weight never breaks the six-row / 1200-character budget', async (t) => {
  const root = await tempRoot();
  const log = eventLog();
  const memory = new MemoryStore(root, { capacity: 100, onEvent: log.onEvent });
  t.after(() => cleanup(root, memory));
  const { older } = stamps();

  const long = '我们一起看动画、散步、聊很多很多今天发生的事情。'.repeat(8);
  for (let index = 0; index < 8; index += 1) {
    // Every candidate is today's convention and far too long: the weight must not buy extra room.
    add(memory, `bulk-${index}`, `约定 第${index}条 ${long} ${todayStamp(0)}`, older);
  }

  const recalled = memory.recall({ query: '约定', budgetChars: 1200, maxRecords: 6, now: CLOCK });
  assert.ok(recalled.hits.length <= 6, `rows<=6 (${recalled.hits.length})`);
  assert.equal(recalled.assembly.rowLimit, 6);
  assert.equal(recalled.assembly.charLimit, 1200);
  assert.ok(recalled.assembly.chars <= 1200, `chars<=1200 (${recalled.assembly.chars})`);
  assert.ok(recalled.upcoming.matched > 0, 'the candidates really were raised');
  assert.equal(recalled.upcoming.levels.today, recalled.upcoming.matched, 'all of them are today');
  assert.equal(upcomingEvents(log).at(-1).payload.levels.today, recalled.upcoming.matched);
  console.log(`[upcoming 8] rows=${recalled.hits.length} chars=${recalled.assembly.chars}/1200 matched=${recalled.upcoming.matched}`);
});

test('8b) the local-midnight rollover flips one record from today to prev', async (t) => {
  const root = await tempRoot();
  const log = eventLog();
  const memory = new MemoryStore(root, { capacity: 100, onEvent: log.onEvent });
  t.after(() => cleanup(root, memory));
  const { older } = stamps();

  // The record names the calendar day CLOCK sits on. At 23:59 that day is still "today"; one
  // minute after local midnight the very same stamp is "yesterday" (prev) — not a day outside.
  const body = `我们说好 ${todayStamp(0)} 一起看动画`;
  const lateNight = dayAt(0, 23, 59);
  const afterMidnight = dayAt(1, 0, 1);
  assert.deepEqual(graded(body, lateNight), { matched: true, level: 'today', weight: 3, distanceDays: 0 });
  assert.deepEqual(graded(body, afterMidnight), { matched: true, level: 'prev', weight: 1.5, distanceDays: -1 });

  add(memory, 'dated-today', body, older);
  const before = memory.recall({ query: '看动画', now: lateNight });
  const after = memory.recall({ query: '看动画', now: afterMidnight });
  assert.equal(levelOf(before, 'dated-today'), 'today');
  assert.equal(levelOf(after, 'dated-today'), 'prev');
  assert.deepEqual(before.upcoming.levels, { today: 1, prev: 0, next: 0 });
  assert.deepEqual(after.upcoming.levels, { today: 0, prev: 1, next: 0 });
  console.log(`[upcoming 8b] 23:59=${levelOf(before, 'dated-today')} 00:01=${levelOf(after, 'dated-today')}`);
});

test('9) records without any date behave exactly as before', async (t) => {
  const root = await tempRoot();
  const log = eventLog();
  const memory = new MemoryStore(root, { capacity: 100, onEvent: log.onEvent });
  t.after(() => cleanup(root, memory));
  const { older, newer } = stamps();

  add(memory, 'plain-a', '我们约定以后多一起看动画', older);
  add(memory, 'plain-b', '我们约定下次一起看动画', newer);
  add(memory, 'plain-c', '我们还约定一起看动画', newer);

  const first = memory.recall({ query: '约定', now: CLOCK });
  const second = memory.recall({ query: '约定', now: dayAt(48, 9) });
  assert.deepEqual(ids(first), ids(second), 'the clock date cannot reorder undated records');
  assert.equal(first.assembly.chars, second.assembly.chars);
  assert.equal(first.upcoming.matched, 0);
  assert.deepEqual(first.upcoming.levels, { today: 0, prev: 0, next: 0 });
  assert.equal(upcomingEvents(log).length, 0, 'no event when nothing matches');
});

test('10) a monthly convention one day ahead is the weaker "next" level', async (t) => {
  const root = await tempRoot();
  const log = eventLog();
  const memory = new MemoryStore(root, { capacity: 100, onEvent: log.onEvent });
  t.after(() => cleanup(root, memory));
  const { older, newer } = stamps();

  add(memory, 'monthly-5', '说好每月5号交房租', older);
  add(memory, 'monthly-20', '说好每月20号交房租', newer);

  // 2026-11-04: the next 5th is tomorrow.
  const recalled = memory.recall({ query: '交房租', now: WED });
  assert.deepEqual(ids(recalled), ['monthly-5', 'monthly-20'], 'tomorrow counts, at the ×1.2 level');
  assert.equal(recalled.upcoming.matched, 1);
  assert.deepEqual(recalled.upcoming.levels, { today: 0, prev: 0, next: 1 });
  assert.equal(upcomingEvents(log).length, 1);
});

test('11) 每个周末 is at the "next" level on Friday and a plain habit is not raised', async (t) => {
  const root = await tempRoot();
  const log = eventLog();
  const memory = new MemoryStore(root, { capacity: 100, onEvent: log.onEvent });
  t.after(() => cleanup(root, memory));
  const { older, newer } = stamps();

  add(memory, 'weekend-walk', '我们每个周末去散步', older);
  add(memory, 'rare-walk', '我们偶尔去散步', newer);

  const recalled = memory.recall({ query: '去散步', now: FRI });
  assert.deepEqual(ids(recalled), ['weekend-walk', 'rare-walk'], 'Saturday is one day away');
  assert.equal(recalled.upcoming.matched, 1);
  assert.deepEqual(recalled.upcoming.levels, { today: 0, prev: 0, next: 1 });
});

test('12) yesterday is the "prev" level; two days back is not raised', async (t) => {
  const root = await tempRoot();
  const log = eventLog();
  const memory = new MemoryStore(root, { capacity: 100, onEvent: log.onEvent });
  t.after(() => cleanup(root, memory));
  const { older, newer } = stamps();

  add(memory, 'dated-yesterday', `我们说好 ${todayStamp(-1)} 一起看动画`, older);
  add(memory, 'dated-minus2', `我们说好 ${todayStamp(-2)} 一起看动画`, newer);

  const recalled = memory.recall({ query: '看动画', now: CLOCK });
  assert.deepEqual(ids(recalled), ['dated-yesterday', 'dated-minus2'], 'the lookback is one day');
  assert.equal(recalled.upcoming.matched, 1);
  assert.deepEqual(recalled.upcoming.levels, { today: 0, prev: 1, next: 0 });
});

// ---- 13/14. the bounded upcoming CANDIDATE entry (2026-11-06) -------------------------------

/** A body long enough to spend real characters but short enough for two to fit the supplement. */
const filler = (label) => `${label}${'，细节都记在约定里'.repeat(6)}`;

test('13) 周六问代码（关键词零命中）→ 三项约定以 kind:upcoming 补入，最多 2 条 / 200 字', async (t) => {
  const root = await tempRoot();
  const log = eventLog();
  const memory = new MemoryStore(root, { capacity: 100, onEvent: log.onEvent });
  t.after(() => cleanup(root, memory));
  const { older } = stamps();

  // All three name SAT itself (weekly Saturday, weekend, the 7th) and share no keyword with the
  // question. Before the supplement the block was empty and the convention was never retrieved.
  add(memory, 'weekly-anime', filler('每周六晚上八点一起看动画，先由我选片'), older);
  add(memory, 'weekly-cleaning', filler('每个周末一起大扫除，先收拾书桌'), older);
  add(memory, 'monthly-rent', filler('每月7号交房租，按合同金额'), older);

  const recalled = memory.recall({ query: 'TypeScript 编译报错怎么修', now: SAT });
  const blocks = recalled.hits.filter((hit) => hit.kind === 'upcoming');
  assert.equal(recalled.upcoming.matched, 0, 'no direct candidate was raised — zero keyword overlap');
  assert.equal(blocks.length, UPCOMING_INJECT.maxRows, `three candidates, two supplemented (${blocks.length})`);
  assert.ok(blocks.every((hit) => hit.text.length > 0 && hit.skippedByBudget !== true));
  const bodies = blocks.reduce((sum, hit) => sum + hit.text.length, 0);
  assert.ok(bodies <= UPCOMING_INJECT.maxChars, `supplement stays within 200 characters (${bodies})`);
  assert.equal(recalled.assembly.upcoming, blocks.length, 'assembly counts the supplemented rows');
  assert.ok(recalled.assembly.chars <= 1200);

  const injected = log.events.filter((event) => event.type === 'memory.upcoming.injected').at(-1);
  assert.ok(injected !== undefined, 'memory.upcoming.injected is recorded');
  assert.deepEqual(injected.payload, { count: blocks.length });
  assert.equal(log.events.filter((event) => event.type === 'memory.upcoming').length, 0,
    'a zero-keyword recall raised no ranking weight, only the candidate entry');
  console.log(`[upcoming 13] query="TypeScript 编译报错怎么修" → rows=${blocks.length} `
    + `bodies=${bodies}/200 kinds=${recalled.hits.map((hit) => hit.kind).join(',')} `
    + `event=${JSON.stringify(injected.payload)}`);
});

test('14) 直接命中优先：命中先出现，约定只补在后面', async (t) => {
  const root = await tempRoot();
  const log = eventLog();
  const memory = new MemoryStore(root, { capacity: 100, onEvent: log.onEvent });
  t.after(() => cleanup(root, memory));
  const { older } = stamps();

  add(memory, 'code-hit-1', 'TypeScript 编译报错先看 tsconfig 的 target', older);
  add(memory, 'code-hit-2', 'TypeScript 编译报错也可能是类型推断的问题', older);
  add(memory, 'weekly-anime', filler('每周六晚上八点一起看动画，先由我选片'), older);

  const recalled = memory.recall({ query: 'TypeScript 编译报错怎么修', now: SAT });
  const kinds = recalled.hits.map((hit) => hit.kind);
  assert.equal(recalled.assembly.hits, 2, `both direct hits are kept (${kinds.join(',')})`);
  assert.equal(kinds[0], 'hit');
  assert.equal(kinds[1], 'hit');
  assert.ok(kinds.indexOf('upcoming') > 1, 'the supplement comes after every direct hit');
  assert.equal(recalled.assembly.upcoming, 1);
  assert.ok(recalled.hits[0].text.includes('TypeScript'), 'the first direct hit keeps its body');

  // A tight budget still pays the direct hit first: the supplement can be dropped, never the hit.
  const tight = memory.recall({ query: 'TypeScript 编译报错怎么修', now: SAT, budgetChars: 120, maxRecords: 6 });
  assert.equal(tight.hits[0].kind, 'hit', 'the direct hit keeps the first slot under a tight budget');
  assert.ok(tight.hits[0].text.includes('TypeScript'));
  assert.ok(tight.assembly.chars <= 120, `chars within the tight budget (${tight.assembly.chars})`);
  console.log(`[upcoming 14] kinds=${kinds.join(',')} assembly=${JSON.stringify({ hits: recalled.assembly.hits, upcoming: recalled.assembly.upcoming })} `
    + `tight=${tight.hits.map((hit) => hit.kind).join(',')} chars=${tight.assembly.chars}/120`);
});
