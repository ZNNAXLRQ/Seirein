/**
 * Unit-sizer sample provenance: queue wait must never become synthesis speed.
 *
 * The first block's size is chosen from a measured ms/char EWMA. That measurement used to be the
 * host's `await synthesize()` time, which ALSO contains the slot queue wait. A 5 s wait behind a
 * slow request could therefore look like 5.2 s of synthesis for a 40-character block and shrink the
 * next block to a stub. The fix reads the request's own `requestMs` (slot acquired -> synthesis
 * end) from the `voice.tts.request` row; queue time, a cache hit (0 ms) and a missing row are
 * reported explicitly instead of silently feeding the EWMA.
 *
 * Run: node --test test/tts-sizer-queue.mjs
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildFirstChunkBreakdown,
  configureTts,
  firstBlockRequestRows,
  resolveUnitSizerSample,
  synthesize,
} from '../src/host/speech/tts.js';
import { createUnitSizer } from '../src/host/speech/spokenPipeline.js';

/** One `voice.tts.request` payload shape (no text: characters and times only). */
function requestRow(overrides = {}) {
  return {
    level: 'debug',
    purpose: 'answer',
    turn: 7,
    deliveryMessageId: 'msg-7',
    sessionId: 'session-7',
    speechId: null,
    engine: 'edge',
    chars: 40,
    slotWaitMs: 5000,
    requestMs: 200,
    totalMs: 5200,
    ok: true,
    errorCode: null,
    cached: false,
    chunkIndex: 0,
    sentenceId: 0,
    coldStart: false,
    queueDepth: 1,
    ...overrides,
  };
}

const at = (payload, time) => ({ at: time, payload });
const observed = (overrides = {}) => resolveUnitSizerSample({
  rows: [at(requestRow(overrides), 1100)],
  purpose: 'answer',
  turn: 7,
  deliveryMessageId: 'msg-7',
  sessionId: 'session-7',
  sentenceId: 0,
  chunkIndex: 0,
  from: 1000,
  observedAt: 1200,
  fallbackMs: 5200,
  chars: 40,
});

after(() => {
  // The module-level hooks are global; never leave a test fixture attached to the next file.
  configureTts({});
});

test('1. queue wait 5 s + synthesis 200 ms: the sample is 200 ms, not 5200 ms', () => {
  const sample = observed();
  assert.equal(sample.source, 'request');
  assert.equal(sample.observe, true);
  assert.equal(sample.ms, 200, 'the request’s own synthesis time');
  assert.equal(sample.requestMs, 200);
  assert.equal(sample.slotWaitMs, 5000, 'the queue wait is kept visible, not folded in');
  assert.equal(sample.chars, 40);

  const sizer = createUnitSizer();
  sizer.observe({ ms: sample.ms, chars: sample.chars });
  assert.equal(sizer.samples(), 1);
  assert.equal(sizer.msPerChar(), 200 / 40, 'the EWMA learns 5 ms/char, not 130 ms/char');
  // The queue-polluted value would have clamped the measured cost to its 200 ms/char ceiling.
  assert.notEqual(sizer.msPerChar(), 5200 / 40);
});

test('2. latest matching first-block row wins; later blocks and other lanes never match', () => {
  const rows = [
    at(requestRow({ requestMs: 200, slotWaitMs: 5000 }), 1100),
    at(requestRow({ requestMs: 300, slotWaitMs: 0, chunkIndex: 1 }), 1150),
    at(requestRow({ purpose: 'ack', requestMs: 900 }), 1120),
    at(requestRow({ purpose: 'tool', requestMs: 800 }), 1130),
    at(requestRow({ requestMs: 250, ok: false }), 1140),
    at(requestRow({ requestMs: 260 }), 1160),
  ];
  const matched = firstBlockRequestRows({
    rows,
    purpose: 'answer',
    turn: 7,
    deliveryMessageId: 'msg-7',
    sessionId: 'session-7',
    sentenceId: 0,
    chunkIndex: 0,
    from: 1000,
    observedAt: 1200,
  });
  assert.deepEqual(matched.map((entry) => entry.payload.requestMs), [200, 260],
    'only ok answer block-0 rows, oldest first');
  const sample = resolveUnitSizerSample({
    rows,
    purpose: 'answer',
    turn: 7,
    deliveryMessageId: 'msg-7',
    sessionId: 'session-7',
    sentenceId: 0,
    chunkIndex: 0,
    from: 1000,
    observedAt: 1200,
    fallbackMs: 5200,
    chars: 40,
  });
  assert.equal(sample.ms, 260, 'the request that just finished is the newest matching row');
});

test('3. identity mismatch / missing row keeps the old fallback and names it', () => {
  const sample = resolveUnitSizerSample({
    rows: [at(requestRow({ turn: 8 }), 1100)],
    purpose: 'answer',
    turn: 7,
    sentenceId: 0,
    chunkIndex: 0,
    from: 1000,
    observedAt: 1200,
    fallbackMs: 5200,
    chars: 40,
  });
  assert.equal(sample.source, 'fallback-total');
  assert.equal(sample.observe, true, 'the old behavior is kept');
  assert.equal(sample.ms, 5200, 'the host await time still includes the queue wait');
  assert.equal(sample.slotWaitMs, null);
  assert.equal(sample.requestMs, null);

  const outsideWindow = resolveUnitSizerSample({
    rows: [at(requestRow(), 900)],
    from: 1000,
    observedAt: 1200,
    fallbackMs: 5200,
    chars: 40,
  });
  assert.equal(outsideWindow.source, 'fallback-total', 'a row before this call is not its sample');
  assert.equal(outsideWindow.ms, 5200);
});

test('4. a cache hit (requestMs 0) is reported but never observed', () => {
  const sample = observed({ requestMs: 0, cached: true, totalMs: 5000 });
  assert.equal(sample.source, 'cache-hit');
  assert.equal(sample.observe, false, '0 ms claims no provider cost');
  assert.equal(sample.ms, 0);
  assert.equal(sample.requestMs, 0);

  const sizer = createUnitSizer();
  const before = sizer.msPerChar();
  if (sample.observe) sizer.observe({ ms: sample.ms, chars: sample.chars });
  assert.equal(sizer.samples(), 0, 'the cache hit left the EWMA untouched');
  assert.equal(sizer.msPerChar(), before);
});

test('5. the old direct observation path still works when no row exists', () => {
  const sizer = createUnitSizer();
  sizer.observe({ ms: 400, chars: 40 });
  assert.equal(sizer.samples(), 1);
  assert.equal(sizer.msPerChar(), 10);
  assert.ok(sizer.targetChars() > 0);
});

test('6. first-chunk breakdown: ack never becomes body and blocks are never summed', () => {
  const rows = [
    at(requestRow({ purpose: 'ack', slotWaitMs: 9000, requestMs: 500, chars: 99 }), 600),
    at(requestRow({ slotWaitMs: 5000, requestMs: 200, chars: 40 }), 1100),
    at(requestRow({ chunkIndex: 1, slotWaitMs: 0, requestMs: 300, chars: 60 }), 1200),
  ];
  const breakdown = buildFirstChunkBreakdown({
    rows,
    streamed: { firstTranslated: false, firstTranslateMs: 0 },
    origin: 1000,
    audioReadyMs: 800,
  });
  assert.equal(breakdown.firstChunkSlotWaitMs, 5000, 'the queue wait of block 0');
  assert.equal(breakdown.firstChunkQueueWaitMs, 5000, 'the compatibility field stays');
  assert.equal(breakdown.firstChunkRequestMs, 200, 'synthesis only; the 5 s wait is not added');
  assert.equal(breakdown.firstChunkTtsMs, 200, 'the compatibility field stays');
  assert.equal(breakdown.firstChunkAudioReadyMs, 800, 'derived from the measured first-chunk stage');
  assert.equal(breakdown.firstChunkChars, 40);
  assert.equal(breakdown.firstChunkTranslateMs, 0, 'same language is a measured 0');
  assert.equal(breakdown.firstChunkKanaMs, 0);
  assert.equal(breakdown.ttsColdStart, false);

  const ackOnly = buildFirstChunkBreakdown({
    rows: [at(requestRow({ purpose: 'ack' }), 1100)],
    streamed: null,
    origin: 1000,
    audioReadyMs: null,
  });
  for (const key of [
    'firstChunkQueueWaitMs', 'firstChunkSlotWaitMs', 'firstChunkTranslateMs', 'firstChunkKanaMs',
    'firstChunkTtsMs', 'firstChunkRequestMs', 'firstChunkAudioReadyMs', 'firstChunkChars',
    'ttsColdStart',
  ]) {
    assert.equal(ackOnly[key], null, `${key} is null without a body row, never a fabricated 0`);
  }
});

test('7. voice.tts.request carries speechId when known, null otherwise; queue still measured apart', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tts-sizer-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }).catch(() => {}));
  const rows = [];
  configureTts({
    edgeSynthesize: async () => ({ file: join(dir, 'edge.mp3'), bytes: 10, durationMs: 1000, provider: 'edge-tts' }),
    onTtsRequest: (payload) => rows.push(payload),
  });
  await synthesize({
    text: '这是第一块', lang: 'zh', dir, purpose: 'answer',
    turn: 7, deliveryMessageId: 'msg-7', sessionId: 'session-7', speechId: 'speech-7-1',
    sentenceId: 0, chunkIndex: 0,
  });
  await synthesize({ text: '没有台账', lang: 'zh', dir, purpose: 'tool', turn: 7, sessionId: 'session-7' });

  assert.equal(rows.length, 2);
  assert.equal(rows[0].speechId, 'speech-7-1');
  assert.equal(rows[0].turn, 7);
  assert.equal(rows[0].deliveryMessageId, 'msg-7');
  assert.equal(rows[0].sessionId, 'session-7');
  assert.equal(rows[1].speechId, null, 'a lane without a ledger id reports null, never a guess');
  for (const row of rows) {
    assert.equal(row.totalMs, row.slotWaitMs + row.requestMs);
    assert.ok(Number.isInteger(row.requestMs) && row.requestMs >= 0);
  }
});
