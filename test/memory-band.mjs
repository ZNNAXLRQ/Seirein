/**
 * Capacity watermark + sustained-pressure policy.
 *
 * Covers the two failure modes the old `lastBand` policy had: a band that never fell back
 * after the table shrank, and a table parked above 90% that stopped decaying because no new
 * band was ever crossed. Trigger state must survive a restart without spending the same
 * pressure twice.
 *
 * Run: node --test test/memory-band.mjs
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { MemoryStore } from '../src/host/memory/store.js';

async function tempRoot() {
  return mkdtemp(join(tmpdir(), 'dsh-band-'));
}

async function cleanup(root, ...stores) {
  for (const store of stores) {
    try {
      store.close();
    } catch {
      /* already closed */
    }
  }
  await rm(root, { recursive: true, force: true }).catch(() => {});
}

/** Add `count` ordinary records and return their ids. */
function fill(memory, prefix, count, importance = 50) {
  const ids = [];
  for (let index = 0; index < count; index += 1) {
    ids.push(memory.add('chat', `${prefix} ${index}`, 'fact', { importance: importance + index }).id);
  }
  return ids;
}

/**
 * Keep calling `maintain()` until it triggers nothing, reporting how many sustained-pressure
 * passes ran and what pressure is still banked. This is what "the same additions" must agree on
 * no matter how they were batched.
 */
function drain(memory, limit = 20) {
  let runs = 0;
  let fadedRows = 0;
  for (let index = 0; index < limit; index += 1) {
    const result = memory.maintain();
    if (result.triggeredBy === null) {
      return { runs, fadedRows, pending: result.pendingPressure, last: result };
    }
    if (result.triggeredBy === 'pressure') {
      runs += 1;
      fadedRows += result.faded;
    }
  }
  throw new Error('maintain() never settled');
}

test('a) first 30% crossing fades once; a repeat maintain with no new memories is a no-op', async () => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 10 });
  try {
    fill(memory, '首次跨档记录', 3); // 3/10 = 30%

    const first = memory.maintain();
    assert.equal(first.band, 1, 'band comes from the real ratio');
    assert.equal(first.triggeredBy, 'watermark');
    assert.ok(first.faded > 0, 'crossing 30% runs one fade pass');
    assert.equal(first.pendingPressure, 0, '30% is under the 0.85 release line, so the cycle ends at zero');
    const clarity = memory.clarityCounts();

    const second = memory.maintain();
    assert.equal(second.band, 1);
    assert.equal(second.triggeredBy, null);
    assert.equal(second.faded, 0, 'no new memories → no second decay');
    assert.equal(second.pendingPressure, 0, 'maintain never decrements pending pressure on its own');
    assert.deepEqual(memory.clarityCounts(), clarity, 'a no-op maintain changes nothing');
  } finally {
    await cleanup(root, memory);
  }
});

test('b) band follows the water level down and re-arms on the way back up', async () => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 10 });
  try {
    fill(memory, '回落测试记录', 9); // 90% → band 3
    const high = memory.maintain();
    assert.equal(high.band, 3);
    assert.equal(high.triggeredBy, 'watermark');

    // Delete five rows: 4/10 = 40%, so the table drops through the 60% and 30% bands.
    const doomed = memory.db.prepare('SELECT id FROM memory_event ORDER BY ts ASC LIMIT 5').all();
    for (const row of doomed) memory.db.prepare('DELETE FROM memory_event WHERE id = ?').run(row.id);

    const dropped = memory.maintain();
    assert.equal(dropped.band, 1, 'band falls back to the actual 40%');
    assert.equal(dropped.triggeredBy, null);
    assert.equal(dropped.faded, 0, 'falling back does not itself fade anything');
    assert.equal(memory.policyState().lastTriggeredBand, 1, 'the durable marker fell with the water level');

    fill(memory, '回升测试记录', 2); // 6/10 = 60%
    const risen = memory.maintain();
    assert.equal(risen.band, 2);
    assert.equal(risen.triggeredBy, 'watermark', 'rising into 60% fires again after the fall');
    assert.ok(risen.faded > 0);
    assert.equal(memory.policyState().lastTriggeredBand, 2);
  } finally {
    await cleanup(root, memory);
  }
});

test('c) sustained top band: only accumulated new memories spend pressure fades', async () => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 20, pressureThreshold: 5 });
  try {
    fill(memory, '高水位记录', 19); // 95% → band 3
    const boot = memory.maintain();
    assert.equal(boot.band, 3);
    assert.equal(boot.triggeredBy, 'watermark');
    assert.equal(boot.pendingPressure, 14, 'the crossing charges one threshold (19 - 5), never a reset');
    // Start the sustained-pressure phase from a clean balance: the threshold charged above
    // belongs to the band crossing, not to the additions this test is about.
    memory.setPendingPressure(0);

    fill(memory, '压力增量甲', 4); // below the threshold
    const below = memory.maintain();
    assert.equal(below.band, 3);
    assert.equal(below.triggeredBy, null, 'fewer new memories than the threshold → no decay');
    assert.equal(below.faded, 0);
    assert.equal(below.pendingPressure, 4);

    fill(memory, '压力增量乙', 3); // 4 + 3 = 7 ≥ 5
    const fired = memory.maintain();
    assert.equal(fired.triggeredBy, 'pressure');
    assert.equal(fired.band, 3);
    assert.ok(fired.faded > 0, 'reaching the threshold runs exactly one fade pass');
    assert.equal(fired.pendingPressure, 2, 'subtracts one threshold and keeps the remainder');

    const settled = memory.maintain();
    assert.equal(settled.triggeredBy, null);
    assert.equal(settled.faded, 0, 'the remainder below the threshold does not fade again');
    assert.equal(settled.pendingPressure, 2);

    // A burst larger than one threshold still buys only one pass per maintain, but the banked
    // thresholds are *not* discarded: the next add-free maintain spends the next one.
    fill(memory, '压力增量丙', 12);
    const burst = memory.maintain();
    assert.equal(burst.triggeredBy, 'pressure');
    assert.equal(burst.pendingPressure, 9, '14 - 1×5 = 9: one threshold charged, the rest banked');
    const banked = memory.maintain();
    assert.equal(banked.triggeredBy, 'pressure', 'the second banked threshold is spent next');
    assert.equal(banked.pendingPressure, 4, '9 - 1×5 = 4, still below the threshold');
    const drained = memory.maintain();
    assert.equal(drained.triggeredBy, null);
    assert.equal(drained.faded, 0, 'once the bank is empty, an add-free maintain is a no-op');
    assert.equal(drained.pendingPressure, 4);
  } finally {
    await cleanup(root, memory);
  }
});

test('d) pressure state survives a restart and is never spent twice', async () => {
  const root = await tempRoot();
  let memory = new MemoryStore(root, { capacity: 20, pressureThreshold: 5 });
  try {
    fill(memory, '重启记录', 19);
    const boot = memory.maintain(); // watermark pass → one threshold charged
    assert.equal(boot.pendingPressure, 14, 'the crossing charged one threshold (19 - 5)');
    memory.setPendingPressure(0); // isolate the sustained-pressure balance from that charge
    fill(memory, '重启压力', 7);
    assert.equal(memory.policyState().pendingPressure, 7);
    memory.close();

    // No constructor override: the persisted threshold must be read back.
    memory = new MemoryStore(root, { capacity: 20 });
    assert.deepEqual(memory.policyState(), {
      lastTriggeredBand: 3,
      pendingPressure: 7,
      pressureThreshold: 5,
    });

    const fired = memory.maintain();
    assert.equal(fired.triggeredBy, 'pressure');
    assert.equal(fired.pendingPressure, 2);
    memory.close();

    memory = new MemoryStore(root, { capacity: 20 });
    assert.equal(memory.policyState().pendingPressure, 2, 'the consumed amount stayed consumed');
    const repeated = memory.maintain();
    assert.equal(repeated.triggeredBy, null);
    assert.equal(repeated.faded, 0, 'no new memories after restart → no repeat decay');
    assert.equal(repeated.pendingPressure, 2);
  } finally {
    await cleanup(root, memory);
  }
});

test('e) without trace records compact reports limitedBy trace and keeps rows/clarity', async () => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 10 });
  try {
    fill(memory, '未遗忘记录', 10);
    const maintained = memory.maintain();
    assert.equal(maintained.band, 3);
    assert.equal(maintained.moved, 0, 'nothing has reached trace yet');
    assert.equal(maintained.archived, 0);
    assert.equal(maintained.limitedBy, 'trace');
    const clarityAfterMaintain = memory.clarityCounts();
    assert.equal(clarityAfterMaintain.trace, 0);

    const compacted = memory.compact({ targetRatio: 0.85 });
    assert.equal(compacted.moved, 0);
    assert.equal(compacted.limitedBy, 'trace', 'the shortfall is reported, not forced');
    assert.equal(compacted.after, 10);
    assert.deepEqual(memory.clarityCounts(), clarityAfterMaintain, 'no row was archived or demoted');
    assert.equal(memory.usage().archived, 0);
  } finally {
    await cleanup(root, memory);
  }
});

test('f) a record is a fade candidate on clarity alone; nothing protects a row from the watermark', async () => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 10 });
  try {
    // The retired `pinned` column is gone from the schema, so there is no "never fades" flag:
    // the lowest-scoring row is the first candidate no matter what else it carries.
    memory.open();
    const columns = memory.db.prepare('PRAGMA table_info(memory_event)').all().map((row) => row.name);
    assert.equal(columns.includes('pinned'), false, 'the protection column no longer exists');
    fill(memory, '衰减记录', 10, 1);
    const faded = memory.fadePass();
    assert.equal(faded.considered, 10, 'every non-trace row is a candidate');
    assert.ok(faded.faded > 0);
    assert.equal(
      memory.db.prepare("SELECT COUNT(*) AS c FROM memory_event WHERE clarity = 'trace'").get().c,
      0,
      'one pass only demotes one level, never straight to trace',
    );
  } finally {
    await cleanup(root, memory);
  }
});

test('g) a pass is charged by subtraction: 250 pending at threshold 100 leaves 150', async () => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 100, pressureThreshold: 100 });
  try {
    fill(memory, '阈值基数记录', 90); // 90/100 = 90% → band 3
    const boot = memory.maintain();
    assert.equal(boot.band, 3);
    assert.equal(boot.triggeredBy, 'watermark');
    assert.equal(boot.pendingPressure, 0, '90 < the 100 threshold, so the crossing charge clamps to zero');

    fill(memory, '阈值压力记录', 250);
    assert.equal(memory.policyState().pendingPressure, 250, 'no ceiling: nothing is cut');

    const fired = memory.maintain();
    assert.equal(fired.triggeredBy, 'pressure');
    assert.equal(fired.pendingPressure, 150, '250 - 1×100 = 150 (never 250 % 100 = 50)');

    const second = memory.maintain();
    assert.equal(second.triggeredBy, 'pressure', 'the threshold still banked is spent by the next call');
    assert.equal(second.pendingPressure, 50, '150 - 1×100 = 50');

    const idle = memory.maintain();
    assert.equal(idle.triggeredBy, null);
    assert.equal(idle.faded, 0);
    assert.equal(idle.pendingPressure, 50, 'a partial threshold never fades on its own');
    console.log(`[memory-band] threshold 100, pending 250 → one pass → ${fired.pendingPressure}`);
  } finally {
    await cleanup(root, memory);
  }
});

test('h) batched additions and one burst spend the same total pressure', async () => {
  const onceRoot = await tempRoot();
  const batchRoot = await tempRoot();
  const single = new MemoryStore(onceRoot, { capacity: 100, pressureThreshold: 100 });
  const chunks = new MemoryStore(batchRoot, { capacity: 100, pressureThreshold: 100 });
  try {
    for (const memory of [single, chunks]) {
      fill(memory, '一致性基数记录', 90);
      const boot = memory.maintain();
      assert.equal(boot.triggeredBy, 'watermark');
      assert.equal(boot.pendingPressure, 0);
    }

    // One write of 250 additions, then let the policy settle.
    fill(single, '一次性压力记录', 250);
    const oneShot = drain(single);
    assert.equal(oneShot.runs, 2, 'two complete thresholds, two passes');
    assert.equal(oneShot.pending, 50, 'the remaining 50 is below the threshold');

    // The same 250 additions as 100 + 100 + 50, maintaining after every batch.
    let batchedPasses = 0;
    fill(chunks, '分期压力甲', 100);
    const batchA = chunks.maintain();
    assert.equal(batchA.triggeredBy, 'pressure');
    assert.equal(batchA.pendingPressure, 0, '100 - 1×100 = 0');
    batchedPasses += 1;

    fill(chunks, '分期压力乙', 100);
    const batchB = chunks.maintain();
    assert.equal(batchB.triggeredBy, 'pressure');
    assert.equal(batchB.pendingPressure, 0);
    batchedPasses += 1;

    fill(chunks, '分期压力丙', 50);
    const batchC = chunks.maintain();
    assert.equal(batchC.triggeredBy, null, '50 < 100: this batch only banks pressure');
    assert.equal(batchC.pendingPressure, 50);

    const batched = drain(chunks);
    assert.equal(batched.runs, 0, 'nothing left to spend');

    // The number of *rows* demoted depends on how full the table was when each pass ran, but the
    // budget is batching-invariant: the same two passes and the same 50 left over.
    assert.equal(batched.pending, oneShot.pending, 'same final pending pressure (50)');
    assert.equal(batchedPasses + batched.runs, oneShot.runs, 'same total executed passes (2)');
  } finally {
    await cleanup(onceRoot, single);
    await cleanup(batchRoot, chunks);
  }
});

test('i) dropping under the 85% release line clears banked pressure (the band drop alone does not)', async () => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 20, pressureThreshold: 5 });
  try {
    fill(memory, '解除基数记录', 19); // 95% → band 3
    const boot = memory.maintain(); // watermark → one threshold charged
    assert.equal(boot.pendingPressure, 14, 'the crossing charged one threshold (19 - 5)');
    memory.setPendingPressure(0); // the release below starts from a clean sustained balance
    fill(memory, '解除压力记录', 7);
    const fired = memory.maintain();
    assert.equal(fired.triggeredBy, 'pressure');
    assert.equal(fired.pendingPressure, 2);

    // Delete 14 rows: 12/20 = 60%, which is under the 0.85 release line (not a band-only drop).
    const doomed = memory.db.prepare('SELECT id FROM memory_event ORDER BY ts ASC LIMIT 14').all();
    for (const row of doomed) memory.db.prepare('DELETE FROM memory_event WHERE id = ?').run(row.id);
    assert.equal(memory.usage().records, 12);

    const released = memory.maintain();
    assert.equal(released.band, 2);
    assert.equal(released.triggeredBy, null);
    assert.equal(released.faded, 0);
    assert.equal(released.pendingPressure, 0, 'the batch behind the pressure is gone, so is the credit');
    assert.equal(memory.policyState().pendingPressure, 0, 'the reset is durable');
    assert.equal(memory.policyState().lastTriggeredBand, 2, 'the marker fell with the water level');
  } finally {
    await cleanup(root, memory);
  }

  // The 85% release line also clears the counter while the band itself stays put.
  const lowRoot = await tempRoot();
  const low = new MemoryStore(lowRoot, { capacity: 20, pressureThreshold: 5 });
  try {
    fill(low, '解线下记录', 13); // 65% → band 2
    const boot = low.maintain();
    assert.equal(boot.triggeredBy, 'watermark');
    assert.equal(boot.pendingPressure, 0);

    fill(low, '解线压力记录', 2); // 15/20 = 75%, still band 2
    assert.equal(low.policyState().pendingPressure, 2);
    const below = low.maintain();
    assert.equal(below.band, 2);
    assert.equal(below.triggeredBy, null);
    assert.equal(below.faded, 0);
    assert.equal(below.pendingPressure, 0, 'ratio 0.75 ≤ 0.85 releases the counter without a band drop');
  } finally {
    await cleanup(lowRoot, low);
  }
});

test('j) the pressure counter is unbounded: 400 additions stay 400 pending', async () => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 100, pressureThreshold: 100 });
  try {
    fill(memory, '无上限基数记录', 90);
    assert.equal(memory.maintain().pendingPressure, 0, 'crossing charge clamped (90 < 100)');
    fill(memory, '无上限压力记录', 400);
    assert.equal(memory.policyState().pendingPressure, 400, 'nothing is truncated at 3×threshold');
    assert.equal(memory.maintain().pendingPressure, 300, '400 - 1×100 = 300 after one pass');
  } finally {
    await cleanup(root, memory);
  }
});

test('k) restart keeps pending and the band marker, and never fades on its own', async () => {
  const root = await tempRoot();
  let memory = new MemoryStore(root, { capacity: 100, pressureThreshold: 100 });
  try {
    fill(memory, '重启基数记录', 90);
    assert.equal(memory.maintain().pendingPressure, 0, 'crossing charge clamped (90 < 100)');
    fill(memory, '重启压力记录', 250);
    assert.equal(memory.policyState().pendingPressure, 250);
    const clarityBefore = memory.clarityCounts();
    memory.close();

    memory = new MemoryStore(root, { capacity: 100 });
    assert.deepEqual(
      memory.policyState(),
      { lastTriggeredBand: 3, pendingPressure: 250, pressureThreshold: 100 },
      'both the counter and the marker survived',
    );
    assert.deepEqual(memory.clarityCounts(), clarityBefore, 'opening the database never fades anything');

    const fired = memory.maintain();
    assert.equal(fired.triggeredBy, 'pressure');
    assert.equal(fired.pendingPressure, 150);
    memory.close();

    memory = new MemoryStore(root, { capacity: 100 });
    assert.equal(memory.policyState().pendingPressure, 150, 'the charged amount stayed charged');
    const second = memory.maintain();
    assert.equal(second.triggeredBy, 'pressure');
    assert.equal(second.pendingPressure, 50);
    memory.close();

    memory = new MemoryStore(root, { capacity: 100 });
    assert.equal(memory.policyState().pendingPressure, 50);
    const idle = memory.maintain();
    assert.equal(idle.triggeredBy, null);
    assert.equal(idle.faded, 0, 'the restart does not add an extra decay pass');
    assert.equal(idle.pendingPressure, 50);
  } finally {
    await cleanup(root, memory);
  }
});

test('l) regression: repeat maintain is inert, compact still stops at trace rows', async () => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 10, pressureThreshold: 5 });
  try {
    fill(memory, '回归记录', 10);
    const boot = memory.maintain();
    assert.equal(boot.band, 3);
    assert.equal(boot.triggeredBy, 'watermark');
    assert.equal(boot.pendingPressure, 5, 'ten additions are two thresholds; the crossing charges one');
    // The second threshold is still owed, so clear it to test the inert steady state below.
    memory.setPendingPressure(0);
    const clarity = memory.clarityCounts();

    for (let index = 0; index < 3; index += 1) {
      const idle = memory.maintain();
      assert.equal(idle.triggeredBy, null, 'no new memories → neither watermark nor pressure');
      assert.equal(idle.faded, 0);
      assert.deepEqual(memory.clarityCounts(), clarity, 'a repeat maintain changes no clarity');
    }

    const noTrace = memory.compact({ targetRatio: 0.85 });
    assert.equal(noTrace.moved, 0, 'nothing has reached trace yet');
    assert.equal(noTrace.limitedBy, 'trace', 'the shortfall is still reported, never forced');

    // Everything is trace: compact moves the weakest by importance, then age.
    const ids = memory.db
      .prepare('SELECT id FROM memory_event ORDER BY ts ASC')
      .all()
      .map((row) => row.id);
    memory.db.exec("UPDATE memory_event SET clarity = 'trace'");

    const compacted = memory.compact({ targetRatio: 0.85 });
    assert.equal(compacted.target, 8);
    assert.equal(compacted.moved, 2);
    assert.equal(compacted.after, 8);
    assert.equal(compacted.limitedBy, null);
    const archived = new Set(memory.listArchive({ limit: 20 }).map((row) => row.id));
    assert.equal(archived.size, 2);
    assert.ok(archived.has(ids[0]) && archived.has(ids[1]), 'the two weakest trace rows move');
    assert.ok(!archived.has(ids[2]), 'the rest stay in memory');
  } finally {
    await cleanup(root, memory);
  }
});

test('m) an uncapped 400-addition burst spends the same passes as 4×100 batches', async () => {
  const onceRoot = await tempRoot();
  const batchRoot = await tempRoot();
  const single = new MemoryStore(onceRoot, { capacity: 100, pressureThreshold: 100 });
  const chunks = new MemoryStore(batchRoot, { capacity: 100, pressureThreshold: 100 });
  try {
    for (const memory of [single, chunks]) {
      fill(memory, '爆发一致性基数', 90); // 90% → band 3
      const boot = memory.maintain();
      assert.equal(boot.triggeredBy, 'watermark');
      assert.equal(boot.pendingPressure, 0);
    }

    // One burst of 400: the balance is kept whole, so four thresholds are owed four passes.
    fill(single, '一次性爆发记录', 400);
    assert.equal(single.policyState().pendingPressure, 400, 'no 3×threshold truncation');
    const burst = drain(single);
    assert.equal(burst.runs, 4, '400 / 100 = 4 passes, one per maintain()');
    assert.equal(burst.pending, 0, 'four complete thresholds, nothing banked');

    // The same 400 additions delivered as 4 × 100, maintaining after every batch.
    let batchedRuns = 0;
    let batchedPending = 0;
    for (let index = 0; index < 4; index += 1) {
      fill(chunks, `分期爆发记录 ${index} `, 100);
      const step = drain(chunks);
      batchedRuns += step.runs;
      batchedPending = step.pending;
    }
    const settled = drain(chunks);
    assert.equal(settled.runs, 0, 'nothing left to spend');

    assert.equal(batchedRuns, burst.runs, 'same total pass count for the same additions');
    assert.equal(batchedPending, burst.pending, 'same remaining pressure balance');
    assert.equal(settled.pending, burst.pending);
    console.log(`[memory-band] 400 once → ${burst.runs} passes, ${burst.pending} left; 4×100 → ${batchedRuns} passes, ${settled.pending} left`);
  } finally {
    await cleanup(onceRoot, single);
    await cleanup(batchRoot, chunks);
  }
});

test('n) a failed pressure write rolls the memory row back and restores the counter', async () => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 100, pressureThreshold: 100 });
  try {
    assert.equal(memory.usage().records, 0);
    assert.equal(memory.policyState().pendingPressure, 0);

    // Injected fault: the pressure upsert aborts, i.e. the second half of the add.
    memory.db.exec(`CREATE TRIGGER fail_pressure BEFORE INSERT ON memory_meta
      WHEN NEW.key LIKE '%pending%' BEGIN
        SELECT RAISE(ABORT, 'pressure write failed');
      END`);

    assert.throws(() => memory.add('chat', '计数失败的记忆', 'fact'), /pressure write failed/);
    assert.equal(memory.usage().records, 0, 'the memory row is rolled back with the counter');
    assert.equal(memory.policyState().pendingPressure, 0, 'the in-memory counter is restored');
    assert.equal(
      memory.db.prepare("SELECT COUNT(*) AS c FROM memory_meta WHERE key = 'policy.pendingPressure'").get().c,
      0,
      'no dangling pressure row was persisted',
    );
    assert.equal(memory.search({ query: '计数失败的记忆' }).hits.length, 0, 'the FTS index rolled back too');

    // A retry after the fault stores exactly one record, charged exactly once.
    memory.db.exec('DROP TRIGGER fail_pressure');
    memory.add('chat', '计数失败的记忆', 'fact');
    assert.equal(memory.usage().records, 1, 'the retry is the only stored row');
    assert.equal(memory.policyState().pendingPressure, 1, 'and it cost exactly one unit of pressure');
    assert.equal(memory.search({ query: '计数失败的记忆' }).hits.length, 1);
  } finally {
    await cleanup(root, memory);
  }
});

test('o) trace rows are not fade candidates, and a pass with no work is not paid', async () => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 10, pressureThreshold: 5 });
  try {
    // Five lowest-scoring rows already reached trace; five vivid rows remain demotable.
    const traced = fill(memory, '旧线索记录', 5, 1);
    memory.db.exec("UPDATE memory_event SET clarity = 'trace' WHERE importance <= 5");
    const vivid = fill(memory, '新鲜记录', 5, 60);

    const faded = memory.fadePass();
    assert.equal(faded.considered, 5, 'trace rows are not fade candidates');
    assert.ok(faded.faded > 0, 'the vivid rows are selected instead of the trace rows');
    for (const id of traced) {
      assert.equal(memory.db.prepare('SELECT clarity FROM memory_event WHERE id = ?').get(id).clarity, 'trace');
    }
    const counts = memory.clarityCounts();
    assert.equal(counts.trace, 5, 'trace rows stay untouched');
    assert.equal(counts.clear, 3, 'take = ceil(5 × 0.5) = 3 demotable rows');
    assert.equal(counts.vivid, 2);
    assert.ok(vivid.some((id) => memory.db.prepare('SELECT clarity FROM memory_event WHERE id = ?').get(id).clarity === 'clear'));
  } finally {
    await cleanup(root, memory);
  }

  // Everything is trace: the pressure pass finds no work, so it must not charge the balance.
  const allRoot = await tempRoot();
  const allTrace = new MemoryStore(allRoot, { capacity: 100, pressureThreshold: 5 });
  try {
    fill(allTrace, '全部线索基数', 90);
    const boot = allTrace.maintain(); // watermark → band 3
    assert.equal(boot.pendingPressure, 85, 'the crossing charged one threshold (90 - 5)');
    // Clear the crossing charge: this half only tests how a zero-work pressure pass is accounted.
    allTrace.setPendingPressure(0);
    fill(allTrace, '全部线索压力', 6);
    allTrace.db.exec("UPDATE memory_event SET clarity = 'trace'");
    const banked = allTrace.policyState().pendingPressure;
    assert.equal(banked, 6);

    const idle = allTrace.maintain();
    assert.equal(idle.band, 3);
    assert.equal(idle.faded, 0, 'no demotable record → no fade');
    assert.equal(idle.triggeredBy, null, 'an unpayable pass is not reported as a pressure pass');
    assert.equal(idle.pendingPressure, banked, 'banked pressure is not spent on zero work');
    assert.equal(allTrace.policyState().pendingPressure, banked, 'and the balance stays durable');
  } finally {
    await cleanup(allRoot, allTrace);
  }
});

test('p) a stale JSON water mark cannot hide a decay the database already recorded', async () => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 100, pressureThreshold: 100 });
  try {
    // The legacy file still claims band 3 (the highest band ever crossed).
    const stateFile = join(root, 'data', 'memory-state.json');
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, `${JSON.stringify({ lastBand: 3 }, null, 2)}\n`, 'utf8');
    const legacy = JSON.parse(readFileSync(stateFile, 'utf8'));

    fill(memory, '旧水位基数', 90); // 90% → band 3
    assert.equal(memory.maintain().triggeredBy, 'watermark');

    // The table shrinks through the bands; the database records the fall (the JSON does not).
    const doomed = memory.db.prepare('SELECT id FROM memory_event ORDER BY ts ASC LIMIT 50').all();
    for (const row of doomed) memory.db.prepare('DELETE FROM memory_event WHERE id = ?').run(row.id);
    const lowered = memory.maintain();
    assert.equal(lowered.band, 1);
    assert.equal(memory.policyState().lastTriggeredBand, 1);

    // A later start would offer the stale JSON band: the database must ignore it, once and for all.
    const adopted = memory.importLegacyBand(Number(legacy.lastBand));
    assert.equal(adopted.migrated, false, 'the database already owns the band, so nothing is adopted');
    assert.equal(memory.policyState().lastTriggeredBand, 1, 'the stale 3 did not come back');

    fill(memory, '水位回升记录', 20); // 60% → band 2
    const risen = memory.maintain({ lastBand: 3 });
    assert.equal(risen.band, 2);
    assert.equal(risen.triggeredBy, 'watermark', 'rising into band 2 still fires after the fall');
    assert.ok(risen.faded > 0);
    assert.equal(memory.policyState().lastTriggeredBand, 2);
  } finally {
    await cleanup(root, memory);
  }
});

test('q) the JSON water mark is migrated once, then never consulted again', async () => {
  const root = await tempRoot();
  let memory = new MemoryStore(root, { capacity: 100, pressureThreshold: 100 });
  const stateFile = join(root, 'data', 'memory-state.json');
  try {
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, `${JSON.stringify({ lastBand: 3 }, null, 2)}\n`, 'utf8');
    fill(memory, '迁移基数记录', 90);

    const first = memory.importLegacyBand(3);
    assert.equal(first.migrated, true, 'a database with no band adopts the JSON value once');
    assert.equal(first.from, 3);
    assert.equal(memory.policyState().lastTriggeredBand, 3);
    assert.equal(
      memory.db.prepare("SELECT COUNT(*) AS c FROM memory_meta WHERE key = 'policy.bandMigratedFrom'").get().c,
      1,
      'the migration itself is recorded durably',
    );

    // The file is edited afterwards: the old value must not come back.
    writeFileSync(stateFile, `${JSON.stringify({ lastBand: 0 }, null, 2)}\n`, 'utf8');
    const second = memory.importLegacyBand(Number(JSON.parse(readFileSync(stateFile, 'utf8')).lastBand));
    assert.equal(second.migrated, false, 'a second migration never happens');
    assert.equal(memory.policyState().lastTriggeredBand, 3);

    const idle = memory.maintain();
    assert.equal(idle.band, 3);
    assert.equal(idle.triggeredBy, null, 'band 3 was already consumed, so nothing fires');
    assert.equal(idle.faded, 0, 'editing the JSON cannot re-arm a consumed band');

    memory.close();
    memory = new MemoryStore(root, { capacity: 100 });
    assert.equal(memory.policyState().lastTriggeredBand, 3, 'the database value survives a restart');
    assert.equal(memory.importLegacyBand(0).migrated, false, 'and is not re-migrated');
    assert.equal(memory.policyState().lastTriggeredBand, 3);
  } finally {
    await cleanup(root, memory);
  }
});

// ---------------------------------------------------------------------------------------------
// Release vs charge unification: an ineffective pass is free, an effective pass costs one
// threshold, and only the 0.85 capacity line ends the pressure cycle.
// ---------------------------------------------------------------------------------------------

test('r) [new a] cross-band with faded === 0 keeps the balance, advances the marker, and is not re-checked', async () => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 20, pressureThreshold: 50 });
  try {
    fill(memory, '全线索跨档记录', 18); // 18/20 = 90% → band 3
    // Every row is already at the end of the fade path, so the crossing has nothing to demote.
    memory.db.exec("UPDATE memory_event SET clarity = 'trace'");
    assert.equal(memory.policyState().pendingPressure, 18);

    // Count the passes: a crossing that cannot demote anything must be observed once, not
    // re-checked on every later maintain().
    let passes = 0;
    const realFadePass = memory.fadePass.bind(memory);
    memory.fadePass = (options) => {
      passes += 1;
      return realFadePass(options);
    };

    const first = memory.maintain();
    assert.equal(first.band, 3);
    assert.equal(first.faded, 0, 'every row is already trace, so nothing can fade');
    assert.equal(first.triggeredBy, null, 'a pass with no work is not reported as a decay');
    assert.equal(first.pendingPressure, 18, 'faded === 0 leaves the balance exactly as it was');
    assert.equal(memory.policyState().pendingPressure, 18, 'and the balance is still durable');
    assert.equal(memory.policyState().lastTriggeredBand, 3, 'the crossing itself is still recorded');
    assert.equal(first.moved, 1, 'the 90% compact pass archives the one trace overflow row');

    // The compact pass brought the table to exactly 0.85, so the release line ends the cycle on
    // the next maintain — still without running a second fade pass.
    const second = memory.maintain();
    assert.equal(second.faded, 0);
    assert.equal(second.pendingPressure, 0, 'the capacity line releases the cycle');
    assert.equal(passes, 1, 'band 3 is already observed, and nothing re-ran the pass');
  } finally {
    await cleanup(root, memory);
  }
});

test('s) [new b] cross-band with faded > 0 charges exactly one threshold (not the whole balance)', async () => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 20, pressureThreshold: 5 });
  try {
    fill(memory, '跨档扣减记录', 19); // 95% → band 3, 19 additions banked
    assert.equal(memory.policyState().pendingPressure, 19);

    const crossed = memory.maintain();
    assert.equal(crossed.band, 3);
    assert.equal(crossed.triggeredBy, 'watermark');
    assert.ok(crossed.faded > 0, 'the crossing actually demoted rows');
    assert.equal(crossed.pendingPressure, 14, '19 - 1×5 = 14: one charge, never a reset to zero');
    assert.notEqual(crossed.pendingPressure, 0);
    assert.equal(memory.policyState().pendingPressure, 14);
  } finally {
    await cleanup(root, memory);
  }
});

test('t) [new c] 95% → 88% (band 3 → 2) retains the balance and the pressure state', async () => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 100, pressureThreshold: 5 });
  try {
    fill(memory, '保留水位记录', 95); // 95% → band 3
    const boot = memory.maintain();
    assert.equal(boot.band, 3);
    const carried = boot.pendingPressure;
    assert.equal(carried, 90, 'the crossing charged one threshold out of 95 additions');

    // Delete 7 rows → 88/100 = 0.88: still above the release line, one band lower.
    const doomed = memory.db.prepare('SELECT id FROM memory_event ORDER BY ts ASC LIMIT 7').all();
    for (const row of doomed) memory.db.prepare('DELETE FROM memory_event WHERE id = ?').run(row.id);
    assert.equal(memory.usage().records, 88);

    const shifted = memory.maintain();
    assert.equal(shifted.band, 2, 'the band follows the water level down');
    assert.equal(shifted.faded, 0);
    assert.equal(shifted.triggeredBy, null);
    assert.equal(shifted.pendingPressure, carried, '0.85 < ratio < 0.90 keeps the balance');
    assert.ok(shifted.pendingPressure > 0, 'the pressure state is still active');
    assert.equal(memory.policyState().pendingPressure, carried, 'the retained balance is durable');
    assert.equal(memory.policyState().lastTriggeredBand, 2);
    console.log(`[memory-band] 95% → 88%: band 3 → 2, pending ${carried} → ${shifted.pendingPressure} (retained)`);
  } finally {
    await cleanup(root, memory);
  }
});

test('u) [new d] 95% → 84% crosses the release line, clears the balance and ends the cycle', async () => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 100, pressureThreshold: 5 });
  try {
    fill(memory, '释放水位记录', 95);
    const boot = memory.maintain();
    const carried = boot.pendingPressure;
    assert.equal(carried, 90);

    // Delete 11 rows → 84/100 = 0.84, below the 0.85 release line.
    const doomed = memory.db.prepare('SELECT id FROM memory_event ORDER BY ts ASC LIMIT 11').all();
    for (const row of doomed) memory.db.prepare('DELETE FROM memory_event WHERE id = ?').run(row.id);
    assert.equal(memory.usage().records, 84);

    const released = memory.maintain();
    assert.equal(released.band, 2);
    assert.equal(released.faded, 0);
    assert.equal(released.triggeredBy, null);
    assert.equal(released.pendingPressure, 0, 'ratio <= 0.85 ends the pressure cycle');
    assert.equal(memory.policyState().pendingPressure, 0, 'the release is durable');
    assert.equal(memory.policyState().lastTriggeredBand, 2);
    console.log(`[memory-band] 95% → 84%: pending ${carried} → ${released.pendingPressure} (released)`);
  } finally {
    await cleanup(root, memory);
  }
});

test('v) [new e] at 84% repeated maintain() neither fades nor restores the balance', async () => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 100, pressureThreshold: 5 });
  try {
    fill(memory, '低位反复记录', 84); // 84% → band 2, under the release line
    const entering = memory.maintain(); // the band-2 crossing also ends the cycle
    assert.equal(entering.band, 2);
    assert.equal(entering.pendingPressure, 0, 'under the release line the balance is cleared');
    const clarity = memory.clarityCounts();

    for (let index = 0; index < 3; index += 1) {
      const idle = memory.maintain();
      assert.equal(idle.band, 2);
      assert.equal(idle.faded, 0, 'no band crossing and a zero balance → no decay');
      assert.equal(idle.triggeredBy, null);
      assert.equal(idle.pendingPressure, 0, 'the balance stays at zero');
      assert.deepEqual(memory.clarityCounts(), clarity, 'repeated maintains change nothing');
    }
  } finally {
    await cleanup(root, memory);
  }
});

test('w) [new f] climbing back to 91% re-enters the pressure state without restoring the cleared balance', async () => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 100, pressureThreshold: 5 });
  try {
    fill(memory, '回升重新进入记录', 84);
    const low = memory.maintain();
    assert.equal(low.pendingPressure, 0, '84% ended the previous cycle at zero');

    fill(memory, '回升新记录', 7); // 84 + 7 = 91 rows → 91%
    assert.equal(memory.policyState().pendingPressure, 7, 'only the seven new additions are banked');

    const back = memory.maintain();
    assert.equal(back.band, 3);
    assert.equal(back.triggeredBy, 'watermark', 'crossing 90% re-enters the pressure state');
    assert.ok(back.faded > 0);
    assert.equal(back.pendingPressure, 2, '7 - 1×5 = 2: the cleared balance was not restored');
    assert.equal(memory.policyState().pendingPressure, 2, 'the new balance is durable');
    assert.equal(memory.policyState().lastTriggeredBand, 3);
  } finally {
    await cleanup(root, memory);
  }
});

