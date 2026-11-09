/**
 * P-67 §6 — manual-lane relative time absolutization.
 *
 * The manual lanes (`assistant_remember` → add(), `correct()`) write a concrete calendar date
 * while keeping the original wording in parentheses: `下周三` → `2026-11-18（下周三）`.
 * `raw_text` keeps the submitted wording and `timeResolved` reports every expression:
 * `{term, date, ok}` on success, `{term, date:null, ok:false, reason}` when it is deliberately
 * not guessed. The automatic lane is NOT rewritten (design §6.4).
 *
 * Run: node --test test/memory-time-absolute.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { MemoryStore, resolveRelativeTime } from '../src/host/memory/store.js';

/** Monday 2026-11-09, 16:00 Asia/Shanghai. */
const NOW = new Date('2026-11-09T16:00:00+08:00');

async function tempRoot() {
  return mkdtemp(join(tmpdir(), 'dsh-mem-time-absolute-'));
}

async function openStore(t, options = {}) {
  const root = await tempRoot();
  const store = new MemoryStore(root, { capacity: 2000, ...options });
  t.after(async () => {
    try {
      store.close();
    } catch {
      /* already closed */
    }
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });
  return store;
}

const rowOf = (store, id) =>
  store.db.prepare('SELECT id, text, raw_text, unresolved, tz_used, version FROM memory_event WHERE id = ?').get(id);

function stored(store, text, extra = {}) {
  return store.add('chat', text, 'fact', { source: 'manual', importance: 60, now: NOW, ...extra });
}

test('1. day words resolve to concrete dates and keep the original word', async (t) => {
  const store = await openStore(t);
  const cases = [
    ['今天开会', '2026-11-09（今天）开会'],
    ['明天开会', '2026-11-10（明天）开会'],
    ['后天开会', '2026-11-11（后天）开会'],
    ['大后天开会', '2026-11-12（大后天）开会'],
    ['昨天开会', '2026-11-08（昨天）开会'],
    ['前天开会', '2026-11-07（前天）开会'],
    ['大前天开会', '2026-11-06（大前天）开会'],
  ];
  for (const [input, expected] of cases) {
    const record = stored(store, input);
    assert.equal(record.text, expected, `${input} stored as an absolute date`);
    assert.equal(record.raw_text, input, `${input} raw_text keeps the submitted wording`);
    assert.equal(record.timeResolved.length, 1);
    assert.equal(record.timeResolved[0].ok, true);
    assert.equal(record.timeResolved[0].term, input.slice(0, input.indexOf('开会')));
    assert.equal(rowOf(store, record.id).text, expected);
    assert.equal(rowOf(store, record.id).tz_used, 'Asia/Shanghai');
  }
  console.log(`[1] day words: ${cases.map(([input]) => input.slice(0, 3)).join(', ')}`);
});

test('2. ISO week forms, Chinese numerals and a trailing time-of-day', async (t) => {
  const store = await openStore(t);
  const cases = [
    ['下周三开会', '2026-11-18（下周三）开会'],
    ['上周五开会', '2026-11-06（上周五）开会'],
    ['下下周三开会', '2026-11-25（下下周三）开会'],
    ['本周五开会', '2026-11-13（本周五）开会'],
    ['这周六开会', '2026-11-14（这周六）开会'],
    ['下星期天开会', '2026-11-22（下星期天）开会'],
    ['礼拜三开会', '2026-11-11（礼拜三）开会'],
    ['周三开会', '2026-11-11（周三）开会'],
    ['星期三开会', '2026-11-11（星期三）开会'],
    ['明天下午开会', '2026-11-10（明天）下午开会'],
  ];
  for (const [input, expected] of cases) {
    const record = stored(store, input);
    assert.equal(record.text, expected, input);
    assert.equal(record.raw_text, input);
    assert.equal(record.timeResolved[0].ok, true, input);
    // A bare weekday is the nearest future occurrence, and the report says so.
    if (input.startsWith('周') || input.startsWith('星期') || input.startsWith('礼拜')) {
      assert.equal(record.timeResolved[0].note, 'next-occurrence');
    }
  }
  console.log(`[2] week forms: ${cases.length}/${cases.length} resolved, 明天下午 keeps 下午`);
});

test('3. 04:00 day boundary: 02:30 still belongs to the previous day', async (t) => {
  const store = await openStore(t);
  const early = new Date('2026-11-10T02:30:00+08:00');
  const record = store.add('chat', '今天和明天都要早起', 'fact', {
    source: 'manual',
    now: early,
    importance: 60,
  });
  assert.equal(record.text, '2026-11-09（今天）和2026-11-10（明天）都要早起');
  assert.deepEqual(
    record.timeResolved.map((item) => [item.term, item.date]),
    [['今天', '2026-11-09'], ['明天', '2026-11-10']],
  );
  // A late-night session name and "today" agree: 02:30 on the 10th is still the 9th's day.
  assert.equal(resolveRelativeTime('今天', { now: early }).text, '2026-11-09（今天）');
  console.log('[3] 02:30 anchor = 2026-11-09 (04:00 boundary)');
});

test('4. recurring / vague / ambiguous expressions stay as written and report a reason', async (t) => {
  const store = await openStore(t);
  const cases = [
    ['每周三开例会', 'recurring'],
    ['每天跑步', 'recurring'],
    ['下周再说', 'missing-weekday'],
    ['这周很忙', 'missing-weekday'],
    ['下个月再说', 'missing-day'],
    ['上个月很忙', 'missing-day'],
    ['改天一起吃饭', 'vague'],
  ];
  for (const [input, reason] of cases) {
    const record = stored(store, input);
    assert.equal(record.text, input, `${input} is never guessed`);
    // `raw_text` is only duplicated when the body actually changed; an unchanged row already is
    // the original wording.
    assert.equal(record.raw_text, null);
    assert.equal(record.timeResolved.length, 1, input);
    assert.equal(record.timeResolved[0].ok, false);
    assert.equal(record.timeResolved[0].reason, reason, input);
    assert.equal(record.timeResolved[0].date, null);
  }

  // Invalid calendar days are refused, not rolled over into the next month.
  const late = store.add('chat', '下个月31号交表', 'fact', {
    source: 'manual',
    importance: 60,
    now: new Date('2027-01-15T10:00:00+08:00'),
  });
  assert.equal(late.text, '下个月31号交表');
  assert.equal(late.timeResolved[0].reason, 'invalid-date');

  // Idempotent: an already-annotated body is not rewritten or reported a second time.
  const annotated = stored(store, '2026-11-10（明天）去公园');
  assert.equal(annotated.text, '2026-11-10（明天）去公园');
  assert.equal(annotated.timeResolved, null);
  console.log(`[4] refused ${cases.length} ambiguous/recurring forms + invalid-date + idempotent`);
});

test('5. month edges and a cross-year week resolve deterministically', async (t) => {
  const store = await openStore(t);
  const now = new Date('2026-12-30T10:00:00+08:00'); // Wednesday
  const record = store.add('chat', '下个月1号、月底和下周六', 'fact', {
    source: 'manual',
    importance: 60,
    now,
  });
  assert.equal(
    record.text,
    '2027-01-01（下个月1号）、2026-12-31（月底）和2027-01-09（下周六）',
  );
  assert.deepEqual(
    record.timeResolved.map((item) => item.date),
    ['2027-01-01', '2026-12-31', '2027-01-09'],
  );
  assert.equal(rowOf(store, record.id).unresolved, 0);

  // Previous month that has no 31st is refused (does not roll into March).
  const march = new Date('2027-03-15T10:00:00+08:00');
  const invalid = store.add('chat', '上个月31号', 'fact', {
    source: 'manual',
    importance: 60,
    now: march,
  });
  assert.equal(invalid.timeResolved[0].reason, 'invalid-date');
  console.log(`[5] ${record.text} | invalid=${invalid.timeResolved[0].reason}`);
});

test('6. correct(): the replacement is absolutized, versioned and reported', async (t) => {
  const store = await openStore(t);
  const target = store.add('chat', '原定时间开会', 'fact', { importance: 60 });
  const result = store.correct({
    targetId: target.id,
    expectedVersion: 1,
    expectedText: '时间',
    replacement: '下周三下午三点',
    now: NOW,
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.version, 2);
  assert.equal(result.from, '时间');
  assert.equal(result.to, '2026-11-18（下周三）下午三点');
  assert.equal(result.text, '原定2026-11-18（下周三）下午三点开会');
  assert.deepEqual(result.timeResolved, [
    { term: '下周三', date: '2026-11-18', ok: true },
  ]);
  const row = rowOf(store, target.id);
  assert.equal(row.text, result.text);
  assert.equal(row.raw_text, '原定时间开会', 'raw_text keeps the pre-correction body');
  const revision = store.revisions(target.id)[0];
  assert.equal(revision.beforeText, '原定时间开会');
  assert.equal(revision.afterText, result.text, 'the revision records the absolutized text');

  // A bare weekday is only resolved when the reference instant is injected; the direct
  // correction path historically relies on literal fragment replacement.
  const bareTarget = store.add('chat', '原定日期', 'fact', { importance: 60 });
  const bare = store.correct({
    targetId: bareTarget.id,
    expectedVersion: 1,
    expectedText: '日期',
    replacement: '周五',
    now: NOW,
  });
  assert.equal(bare.text, '原定2026-11-13（周五）');
  const literalTarget = store.add('chat', '原定日期二', 'fact', { importance: 60 });
  const literal = store.correct({
    targetId: literalTarget.id,
    expectedVersion: 1,
    expectedText: '日期二',
    replacement: '周五',
  });
  assert.equal(literal.text, '原定周五', 'no injected reference → no guess');
  assert.equal(literal.timeResolved, null);
  console.log(`[6] correct: ${result.to} v${result.version}; bare-with-now=${bare.text}; bare-literal=${literal.text}`);
});

test('7. the automatic lane is never absolutized (§6.4)', async (t) => {
  const store = await openStore(t);
  const auto = store.add('chat', '明天开会', 'event', { source: 'auto', now: NOW });
  assert.equal(auto.text, '明天开会');
  assert.equal(auto.timeResolved, null);
  const message = store.addMessage({
    role: 'user',
    sessionId: 'auto-time',
    turnId: 1,
    messageId: 'auto-time-1',
    text: '明天开会',
    ts: NOW.toISOString(),
  });
  assert.equal(message.record.text, '明天开会');
  assert.equal(rowOf(store, message.record.id).text, '明天开会');
  console.log('[7] auto add + addMessage keep the original wording');
});

test('8. assistant_remember bridge: absolute body + original rawText gets the annotation', async (t) => {
  const store = await openStore(t);
  // This is what the tool passes today: normalizeForMemory already wrote the date, rawText still
  // carries the model's wording. Store-level annotation restores the design's bracket form.
  const record = store.add('chat', '2026-11-10去公园', 'fact', {
    source: 'manual',
    importance: 60,
    now: NOW,
    rawText: '明天去公园',
  });
  assert.equal(record.text, '2026-11-10（明天）去公园');
  assert.equal(record.raw_text, '明天去公园');
  assert.equal(record.timeResolved[0].term, '明天');
  assert.equal(record.timeResolved[0].date, '2026-11-10');
  console.log(`[8] bridge: ${record.text} raw_text=${record.raw_text}`);
});

test('9. durations and a title are handled without corrupting quoted text', async (t) => {
  const store = await openStore(t);
  const record = stored(store, '3天后取快递，过两天再听《明天会更好》，三天前已经买过一次');
  assert.equal(
    record.text,
    '2026-11-12（3天后）取快递，2026-11-11（过两天）再听《明天会更好》，2026-11-06（三天前）已经买过一次',
  );
  assert.equal(record.timeResolved.length, 3);
  assert.ok(record.timeResolved.every((item) => item.ok === true));

  const nullish = resolveRelativeTime(null);
  assert.equal(nullish.text, '');
  assert.equal(nullish.items, null);
  console.log('[9] durations + protected title; non-string input is a no-op');
});
