/**
 * P-46 stage 2: the playback-seat wait is attributable.
 *
 * `waitPlaybackTurn` emits exactly one optional debug row per finished wait:
 *   speech.seat.wait { speechId, sessionId, turn, waitMs, queueDepth, outcome }
 * where `outcome` is `granted` / `timeout` / `cancelled`, `waitMs` is the measured start -> end
 * wait, `queueDepth` is how many earlier audible requests still blocked the seat when this one
 * joined, and `sessionId`/`turn` are the caller's attribution (null when omitted).
 *
 * The ledger is driven directly (no host / index wiring, no sound, network or GUI): a holder takes
 * the seat and blocks, the next requests queue behind it, and each test settles one outcome. The
 * injected sink is an EventLog-shaped `{emit}` object, matching how the host would pass its log.
 *
 * Run: node --test test/speech-seat-wait.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createSpeechLedger } from '../src/host/speech/speech-ledger.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until `predicate` holds (the ledger's own timers are unref'd; these sleeps keep the loop). */
async function until(predicate, label, timeoutMs = 3_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate() === true) return;
    await sleep(5);
  }
  assert.fail(`timed out: ${label}`);
}

/** A ledger plus the event rows it actually writes through `emit`; `log` is the optional sink. */
function makeLedger({ log } = {}) {
  const emitted = [];
  const ledger = createSpeechLedger({
    emit: async (type, payload) => { emitted.push({ type, payload }); },
    ...(log === undefined ? {} : { log }),
  });
  return { ledger, emitted };
}

/**
 * A run that takes the seat, reports its first audio, then holds the seat until `gate` resolves.
 * `release` resolves that gate from the test.
 */
function holdSeat(ledger) {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const run = async ({ speechId, onFirstAudio }) => {
    await ledger.waitPlaybackTurn(speechId);
    onFirstAudio(Date.now());
    await gate;
  };
  return { run, release };
}

/** Events of one type, optionally for one speech. */
const rowsOf = (rows, type, speechId = null) => rows.filter((row) => (
  row.type === type && (speechId === null || row.payload.speechId === speechId)
));

// ---------------------------------------------------------------------------
// 1) granted: one event, measured wait, caller attribution, queue depth
// ---------------------------------------------------------------------------

test('1. granted: one event with measured waitMs, caller session/turn and queueDepth', async (t) => {
  const logged = [];
  // The host passes its EventLog as `log`; tests pass the same `{emit}` shape.
  const { ledger: seatLedger, emitted } = makeLedger({
    log: { emit: (type, payload) => { logged.push({ type, payload }); } },
  });

  // The holder occupies the single playback seat and never reports attribution.
  const holder = holdSeat(seatLedger);
  const held = seatLedger.accept({
    sessionId: 'seat-session', turn: 7, text: '先把这一句播完。', run: holder.run,
  });
  await until(() => seatLedger.statusOf(held.speechId)?.status === 'playing', 'the holder sounds');

  // Two requesters join behind the holder, in acceptance order.
  const acceptWaiter = (turn) => seatLedger.accept({
    sessionId: 'seat-session', turn, text: `等待第 ${turn} 轮。`,
    run: async ({ speechId, onFirstAudio }) => {
      await seatLedger.waitPlaybackTurn(speechId, { sessionId: 'seat-session', turn });
      onFirstAudio(Date.now());
    },
  });
  const first = acceptWaiter(8);
  const second = acceptWaiter(9);
  // Both are genuinely queued (nothing is granted before the holder ends).
  await sleep(20);
  assert.equal(rowsOf(logged, 'speech.seat.wait', first.speechId).length, 0, 'the first waiter is still waiting');
  assert.equal(rowsOf(logged, 'speech.seat.wait', second.speechId).length, 0, 'the second waiter is still waiting');

  holder.release();
  await until(() => rowsOf(logged, 'speech.seat.wait', first.speechId).length === 1, 'the first waiter was granted');
  await until(() => rowsOf(logged, 'speech.seat.wait', second.speechId).length === 1, 'the second waiter was granted');
  await sleep(20); // no late second line for either

  const holderRow = rowsOf(logged, 'speech.seat.wait', held.speechId);
  assert.equal(holderRow.length, 1, 'the immediate grant still writes exactly one row');
  // Omitted attribution is null, never the ledger record's own values.
  assert.equal(holderRow[0].payload.sessionId, null);
  assert.equal(holderRow[0].payload.turn, null);
  assert.equal(holderRow[0].payload.outcome, 'granted');
  assert.equal(holderRow[0].payload.queueDepth, 0);

  const firstRow = rowsOf(logged, 'speech.seat.wait', first.speechId);
  assert.equal(firstRow.length, 1, 'exactly one row per finished wait');
  assert.equal(firstRow[0].payload.outcome, 'granted');
  assert.equal(firstRow[0].payload.sessionId, 'seat-session');
  assert.equal(firstRow[0].payload.turn, 8);
  assert.ok(firstRow[0].payload.waitMs > 0, `waitMs is measured: ${firstRow[0].payload.waitMs}`);
  assert.equal(firstRow[0].payload.queueDepth, 1, 'the holder was ahead when it joined');

  const secondRow = rowsOf(logged, 'speech.seat.wait', second.speechId);
  assert.equal(secondRow.length, 1);
  assert.equal(secondRow[0].payload.turn, 9);
  assert.ok(secondRow[0].payload.waitMs > 0);
  assert.equal(secondRow[0].payload.queueDepth, 2, 'the holder and the first waiter were ahead');
  // The debug row is written to the injected sink only, never through the speech event channel.
  assert.equal(rowsOf(emitted, 'speech.seat.wait').length, 0);
  t.diagnostic(`granted: holder(null/null,d=0), turn8(waitMs=${firstRow[0].payload.waitMs},d=1), `
    + `turn9(waitMs=${secondRow[0].payload.waitMs},d=2)`);
});

// ---------------------------------------------------------------------------
// 2) timeout: one row with outcome timeout
// ---------------------------------------------------------------------------

test('2. timeout: one event with outcome timeout and the wait still fails as before', async (t) => {
  const logged = [];
  const { ledger } = makeLedger({
    log: { emit: (type, payload) => { logged.push({ type, payload }); } },
  });

  const holder = holdSeat(ledger);
  const held = ledger.accept({ sessionId: 'seat-session', turn: 1, text: '占住席位。', run: holder.run });
  await until(() => ledger.statusOf(held.speechId)?.status === 'playing', 'the holder sounds');

  const waiting = ledger.accept({
    sessionId: 'seat-session', turn: 2, text: '等不到位也要如实上报。',
    run: async ({ speechId }) => {
      // kind 'speech' keeps the bounded SPEECH_QUEUE_TIMEOUT failure (only reply/reportOnly re-arm).
      await ledger.waitPlaybackTurn(speechId, { timeoutMs: 40, sessionId: 'seat-session', turn: 2 });
    },
  });
  await until(() => rowsOf(logged, 'speech.seat.wait', waiting.speechId).length === 1, 'the timeout row');
  await sleep(20); // no duplicate and no late grant row

  const rows = rowsOf(logged, 'speech.seat.wait', waiting.speechId);
  assert.equal(rows.length, 1, 'a timeout still writes exactly one row');
  assert.equal(rows[0].payload.outcome, 'timeout');
  assert.equal(rows[0].payload.sessionId, 'seat-session');
  assert.equal(rows[0].payload.turn, 2);
  assert.ok(rows[0].payload.waitMs >= 40, `waitMs covers the timeout: ${rows[0].payload.waitMs}`);
  assert.equal(rows[0].payload.queueDepth, 1);
  // Cancellation semantics are untouched: the record failed with the same queue-timeout reason.
  assert.equal(ledger.statusOf(waiting.speechId).status, 'failed');
  assert.equal(ledger.statusOf(waiting.speechId).failureReason, 'queue-timeout');
  holder.release();
  t.diagnostic(`timeout: waitMs=${rows[0].payload.waitMs}, queueDepth=${rows[0].payload.queueDepth}, `
    + `record=${ledger.statusOf(waiting.speechId).status}/${ledger.statusOf(waiting.speechId).failureReason}`);
});

// ---------------------------------------------------------------------------
// 3) cancelled: one row with outcome cancelled
// ---------------------------------------------------------------------------

test('3. cancelled: one event with outcome cancelled, the wait rejects as cancelled', async (t) => {
  const logged = [];
  const { ledger } = makeLedger({
    log: { emit: (type, payload) => { logged.push({ type, payload }); } },
  });

  const holder = holdSeat(ledger);
  const held = ledger.accept({ sessionId: 'seat-session', turn: 1, text: '占住席位。', run: holder.run });
  await until(() => ledger.statusOf(held.speechId)?.status === 'playing', 'the holder sounds');

  const waiting = ledger.accept({
    sessionId: 'seat-session', turn: 2, text: '等待途中被打断。',
    run: async ({ speechId }) => {
      await ledger.waitPlaybackTurn(speechId, { timeoutMs: 5_000, sessionId: 'seat-session', turn: 2 });
    },
  });
  await sleep(20); // the waiter has joined and is waiting
  assert.equal(rowsOf(logged, 'speech.seat.wait', waiting.speechId).length, 0, 'no row while waiting');
  assert.equal(ledger.cancel(waiting.speechId, 'user-interrupt').ok, true);
  await until(() => rowsOf(logged, 'speech.seat.wait', waiting.speechId).length === 1, 'the cancelled row');
  await sleep(20); // the 5 s timeout was cleared; no second row can appear

  const rows = rowsOf(logged, 'speech.seat.wait', waiting.speechId);
  assert.equal(rows.length, 1, 'a cancelled wait writes exactly one row');
  assert.equal(rows[0].payload.outcome, 'cancelled');
  assert.equal(rows[0].payload.sessionId, 'seat-session');
  assert.equal(rows[0].payload.turn, 2);
  assert.ok(rows[0].payload.waitMs > 0, `waitMs is measured: ${rows[0].payload.waitMs}`);
  assert.equal(rows[0].payload.queueDepth, 1);
  assert.equal(ledger.statusOf(waiting.speechId).status, 'cancelled');
  holder.release();
  t.diagnostic(`cancelled: waitMs=${rows[0].payload.waitMs}, queueDepth=${rows[0].payload.queueDepth}, `
    + `record=${ledger.statusOf(waiting.speechId).status}`);
});

// ---------------------------------------------------------------------------
// 4) no log: behavior is unchanged and nothing is written
// ---------------------------------------------------------------------------

test('4. no log: the wait behaves exactly as before and writes no event', async (t) => {
  const { ledger, emitted } = makeLedger(); // no `log` at all

  const holder = holdSeat(ledger);
  const held = ledger.accept({ sessionId: 'seat-session', turn: 1, text: '占住席位。', run: holder.run });
  await until(() => ledger.statusOf(held.speechId)?.status === 'playing', 'the holder sounds');

  // A queued wait is granted normally after the holder releases.
  let granted = false;
  const queued = ledger.accept({
    sessionId: 'seat-session', turn: 2, text: '没有日志也要照常播。',
    run: async ({ speechId, onFirstAudio }) => {
      await ledger.waitPlaybackTurn(speechId, { sessionId: 'seat-session', turn: 2 });
      granted = true;
      onFirstAudio(Date.now());
    },
  });
  // A bounded timeout still rejects with the same code and settles the same way.
  const timedOut = ledger.accept({
    sessionId: 'seat-session', turn: 3, text: '超时语义不变。',
    run: async ({ speechId }) => {
      await ledger.waitPlaybackTurn(speechId, { timeoutMs: 20, sessionId: 'seat-session', turn: 3 });
    },
  });
  await sleep(10);
  assert.equal(granted, false, 'the queued wait is still held by the seat');
  await until(() => ledger.statusOf(timedOut.speechId)?.status === 'failed', 'the timeout still fails');
  assert.equal(ledger.statusOf(timedOut.speechId).failureReason, 'queue-timeout');

  holder.release();
  await until(() => granted === true, 'the queued wait is still granted without a log');
  await sleep(20);

  assert.equal(rowsOf(emitted, 'speech.seat.wait').length, 0, 'no seat event reaches the speech channel');
  assert.equal(ledger.statusOf(queued.speechId).status, 'finished', 'the granted clip still finished');
  t.diagnostic(`no-log: granted=true, timeout=${ledger.statusOf(timedOut.speechId).status}/queue-timeout, `
    + `speech.seat.wait=0`);
});
