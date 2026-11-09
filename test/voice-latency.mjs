/**
 * Voice latency measurement regression.
 *
 * This round adds instrumentation: one `voice.latency` event per spoken voice turn and the last
 * 20 rows (with p50/p95) in `status.voiceLatency`. Nothing here touches a reasoning level or any
 * other behavior — the reasoning policy is deliberately not part of this change.
 *
 * P-140: `translateMs` / `translateCached` are canonical stages now, so a translated round keeps
 * its measurement in the row/status/card and a same-language round stays null (never 0/false).
 *
 * Voice-latency gap round (observation only): `firstSpawnToPlayerReadyMs` (tts.js player spawn ->
 * the player PROCESS reporting readiness, never a PCM/audible instant), `ttsSlotWaitMs` (synthesis
 * slot queue), `translateQueueWaitMs` (translation gate queue), `firstAudibleLane`/`firstAudibleMs`
 * (earliest ack/say/reply sound, null when no read-back proves one) and the stable
 * `deliveryMessageId`/`acceptTurn` join keys shared by `voice.latency` and `voice.first-sentence`.
 * No announcement or playback behavior changes.
 *
 * Run: node --test test/voice-latency.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  earliestAudible,
  firstSentenceOf,
  percentile,
  summarizeVoiceLatency,
  VOICE_LATENCY_FIELDS,
  VOICE_LATENCY_OBSERVATION_FIELDS,
  VOICE_LATENCY_OPTIONAL_FIELDS,
  voiceJoinKeys,
  voiceLatencyEvent,
  voiceLatencyObservations,
  VoiceLatencyLog,
} from '../src/host/session/delivery/dispatch.js';
import { createTranslator, prepareSpeech } from '../src/host/speech/translate.js';
import { buildFirstChunkBreakdown } from '../src/host/speech/tts.js';
import { apply, createReplySpeaker, voiceLatencyObservationFields } from '../src/host/index.js';
import {
  buildTurnTimeline,
  turnTimelineStats,
  VOICE_LATENCY_TIMELINE_FIELDS,
} from '../src/host/session/timeline/turn-timeline.js';

const EXAMPLE = {
  sessionId: 'seirein-2026-11-04',
  asrMs: 700,
  injectToAckMs: 40,
  ackToFirstTextMs: 1800,
  firstTextToFirstSentenceMs: 250,
  firstSentenceToFirstAudioMs: 900,
  totalMs: 3600,
};

const rowAt = (index) => ({
  ...EXAMPLE,
  sessionId: `session-${index}`,
  asrMs: 700 + index * 10,
  totalMs: 3000 + index * 100,
});

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
async function until(predicate) {
  for (let index = 0; index < 500; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail('async boundary did not arrive');
}

// ---------------------------------------------------------------------------
// A) the event payload
// ---------------------------------------------------------------------------

test('voice.latency has every documented stage in order; unobserved stages are null', () => {
  const row = voiceLatencyEvent(EXAMPLE);
  assert.deepEqual(Object.keys(row), ['sessionId', ...VOICE_LATENCY_FIELDS]);
  assert.deepEqual(row, {
    sessionId: 'seirein-2026-11-04',
    asrMs: 700,
    injectToAckMs: 40,
    ackToFirstTextMs: 1800,
    firstTextToFirstSentenceMs: 250,
    firstSentenceToFirstAudioMs: 900,
    totalMs: 3600,
    translateMs: null,
    translateCached: null,
  });
});

test('unmeasurable stages are null, never a fabricated 0 or a negative', () => {
  const row = voiceLatencyEvent({ sessionId: 'x', asrMs: 'NaN', totalMs: -5 });
  for (const field of VOICE_LATENCY_FIELDS) {
    assert.equal(row[field], null, `${field} was not observed, so it is null`);
  }
  // An explicit 0 is still a measurement and is kept as such.
  assert.equal(voiceLatencyEvent({ sessionId: 'x', asrMs: 0 }).asrMs, 0);
});

test('the first-sentence boundary used by firstSentenceToFirstAudioMs', () => {
  assert.equal(firstSentenceOf('好的。我这就去查。'), '好的。');
  assert.equal(firstSentenceOf('真的吗？那就这样！'), '真的吗？');
  assert.equal(firstSentenceOf('还没结束'), '', 'no boundary yet -> the stage waits');
  assert.equal(firstSentenceOf(''), '');
});

test('the optional first-sentence split is written only when measured', () => {
  const measured = voiceLatencyEvent({
    ...EXAMPLE,
    firstSynthWaitMs: 120,
    firstSynthMs: 800,
    firstQueueWaitMs: 340,
    firstPlayerStartMs: 45,
  });
  for (const field of VOICE_LATENCY_OPTIONAL_FIELDS) {
    assert.ok(field in measured, `${field} is present when measured`);
  }
  assert.equal(measured.firstSynthWaitMs, 120);
  assert.equal(measured.firstPlayerStartMs, 45);
  // A row recorded without the split keeps exactly the required stage set.
  const legacy = voiceLatencyEvent(EXAMPLE);
  for (const field of VOICE_LATENCY_OPTIONAL_FIELDS) assert.ok(!(field in legacy), `${field} is absent`);
  assert.deepEqual(Object.keys(legacy), ['sessionId', ...VOICE_LATENCY_FIELDS]);
  // The caller omits an unmeasured stage; an explicit 0 is kept as a measurement.
  const zero = voiceLatencyEvent({ ...EXAMPLE, firstPlayerStartMs: 0 });
  assert.equal(zero.firstPlayerStartMs, 0);
});

// ---------------------------------------------------------------------------
// A3) additive observations: spawn -> player-ready, TTS slot wait, first audible lane
// ---------------------------------------------------------------------------

test('player spawn -> player-ready is mapped; it never becomes a PCM or audible instant', () => {
  const measured = voiceLatencyObservationFields({
    firstSpawnToPlayerReadyMs: 41,
    ttsSlotWaitMs: 3720,
    translateQueueWaitMs: 450,
    firstAudibleLane: 'ack',
    firstAudibleMs: 1800,
  });
  assert.equal(measured.firstSpawnToPlayerReadyMs, 41, 'spawn -> player-ready is kept');
  assert.ok(!('firstSpawnToPcmMs' in measured), 'the event no longer claims a PCM instant on spawn');
  assert.ok(!('firstPcmAt' in measured), 'no PCM field rides on voice.latency');
  assert.equal(measured.ttsSlotWaitMs, 3720, 'the TTS synthesis-slot queue wait is kept');
  assert.equal(measured.translateQueueWaitMs, 450, 'the translation-gate wait is kept');
  assert.equal(measured.firstAudibleLane, 'ack');
  assert.equal(measured.firstAudibleMs, 1800);

  // Unmeasured is null (never 0), an explicit 0 is a measurement. A wait that was never observed
  // stays null: spawn/data are not silently converted into a first-audible instant.
  const empty = voiceLatencyObservationFields({});
  assert.equal(empty.firstSpawnToPlayerReadyMs, null, 'no player-ready evidence -> null');
  for (const field of VOICE_LATENCY_OBSERVATION_FIELDS.filter((name) => name !== 'firstSpawnToPcmMs')) {
    assert.equal(empty[field], null, `${field} has no measurement`);
  }
  assert.equal(empty.firstAudibleLane, null);
  assert.equal(empty.firstAudibleUnknown, 'no-ack-or-speech-start', 'a null lane carries its reason');
  assert.equal(voiceLatencyObservationFields({ firstSpawnToPlayerReadyMs: 0 }).firstSpawnToPlayerReadyMs, 0);
  // The canonical stage set is untouched: observations never become canonical fields.
  assert.deepEqual(Object.keys(voiceLatencyEvent(EXAMPLE)), ['sessionId', ...VOICE_LATENCY_FIELDS]);
  console.log(`ℹ voice.latency: firstSpawnToPlayerReadyMs=${measured.firstSpawnToPlayerReadyMs} unknown=${empty.firstSpawnToPlayerReadyMs} keys=${Object.keys(measured).join(',')}`);
});

test('firstAudibleLane: the earliest sounding lane wins, an empty set is null', () => {
  // ack first: the waiting line started before the reply body.
  assert.deepEqual(
    earliestAudible([
      { lane: 'reply', firstAudioAt: 2400 },
      { lane: 'ack', firstAudioAt: 2000 },
    ]),
    { lane: 'ack', firstAudioAt: 2000 },
  );
  // say first: assistant_say sounded before the reply body.
  assert.deepEqual(
    earliestAudible([
      { lane: 'reply', firstAudioAt: 3000 },
      { lane: 'say', firstAudioAt: 2100 },
    ]),
    { lane: 'say', firstAudioAt: 2100 },
  );
  // No ack/say: the reply body is still attributable.
  assert.deepEqual(earliestAudible([{ lane: 'reply', firstAudioAt: 2600 }]), {
    lane: 'reply',
    firstAudioAt: 2600,
  });
  assert.equal(earliestAudible([]), null);
  assert.equal(earliestAudible([{ lane: 'typed', firstAudioAt: 100 }]), null, 'only the three voice lanes count');
  assert.equal(earliestAudible([{ lane: 'ack', firstAudioAt: 0 }]), null, '0 was not measured');
});

test('voice.latency and voice.first-sentence share the deliveryMessageId / acceptTurn join keys', () => {
  const latency = voiceJoinKeys({ deliveryMessageId: 'msg-42', acceptTurn: 7, turn: 8 });
  const firstSentence = voiceJoinKeys({ deliveryMessageId: 'msg-42', acceptTurn: 7, turn: 8 });
  assert.equal(latency.deliveryMessageId, firstSentence.deliveryMessageId);
  assert.equal(latency.deliveryMessageId, 'msg-42', 'the injected message id is the join key');
  assert.equal(latency.acceptTurn, 7);
  assert.equal(latency.turn, 8, 'turn is kept unchanged for compatibility');
  assert.equal(voiceJoinKeys({ deliveryMessageId: '', acceptTurn: null }).deliveryMessageId, null);
  assert.equal(voiceJoinKeys({ acceptTurn: '7' }).acceptTurn, null, 'never a coerced turn');
});

test('translateQueueWaitMs matches the voice.translate event for the same turn', async () => {
  const events = [];
  const gate = deferred();
  let requests = 0;
  const translator = createTranslator({
    maxConcurrent: 1,
    jaSpeechScript: 'mixed',
    onEvent: (type, payload) => events.push({ type, payload }),
    request: async () => {
      requests += 1;
      // The first call holds the only slot; the queued call is the one with a measured wait.
      if (requests === 1) await gate.promise;
      return '今日はいい天気ですね。';
    },
  });
  const first = translator.translate('今天天气很好。', { from: 'zh', to: 'ja' });
  await until(() => requests === 1);
  const second = prepareSpeech('明天也会下雨。', {
    translator: () => translator,
    speechLang: 'ja',
    textLang: 'zh',
    context: { turn: 7, deliveryMessageId: 'msg-7' },
  });
  await new Promise((resolve) => setTimeout(resolve, 15));
  gate.resolve();
  const [firstResult, prepared] = await Promise.all([first, second]);
  assert.equal(firstResult.ok, true);

  const translateEvent = events.find(
    (event) => event.type === 'voice.translate' && event.payload.turn === 7,
  );
  assert.ok(translateEvent !== undefined, 'voice.translate was emitted');
  assert.ok(translateEvent.payload.queueWaitMs >= 15, 'the queued call really waited for the gate');
  assert.equal(translateEvent.payload.turn, 7, 'turn is a join key on voice.translate');
  assert.equal(translateEvent.payload.deliveryMessageId, 'msg-7');
  assert.equal(
    prepared.translateQueueWaitMs,
    translateEvent.payload.queueWaitMs,
    'the prepared line carries the same queue wait as the event',
  );
  const observations = voiceLatencyObservations({ translateQueueWaitMs: prepared.translateQueueWaitMs });
  assert.equal(observations.translateQueueWaitMs, translateEvent.payload.queueWaitMs);
});

test('the first-sentence stats carry spawn->player-ready, TTS slot and translation-gate waits', async () => {
  // The first block's live session reports its player-ready anchor after the play call returned;
  // the speaker's finish() must still pick it up (that is when `voice.latency` is recorded).
  const firstSession = { spawnAt: 0, playerReadyAt: 0, playerReadyMs: null };
  const speaker = createReplySpeaker({
    startedAt: 0,
    synthesize: async () => ({
      file: 'first.mp3',
      bytes: 8,
      durationMs: 1000,
      slotWaitMs: 3720,
      translateQueueWaitMs: 450,
    }),
    play: async () => ({
      audioStartedAt: 1000,
      session: firstSession,
      done: (async () => {
        firstSession.spawnAt = 1000;
        firstSession.playerReadyAt = 1041;
        firstSession.playerReadyMs = 41;
        // The transport never measured PCM or speaker sound: neither may be fabricated here.
        firstSession.firstPcmAt = null;
        firstSession.firstAudibleAt = null;
      })(),
    }),
  });
  speaker.push('你好。');
  const stats = await speaker.finish({ fullText: '你好。' });
  assert.equal(stats.played, 1);
  assert.equal(stats.firstTtsSlotWaitMs, 3720, 'the synthesis-slot wait reaches voice.latency');
  assert.equal(stats.firstTranslateQueueWaitMs, 450, 'the translation-gate wait reaches voice.latency');
  assert.equal(stats.firstSpawnToPlayerReadyMs, 41, 'the player spawn -> player-ready wait reaches voice.latency');
  assert.equal(stats.firstSpawnToPcmMs, undefined, 'no spawn->PCM stat exists anymore');
});

test('the first-chunk breakdown keeps slot wait, request and audio-ready apart', () => {
  const T = 1_760_000_000_000;
  const row = (payload, offset) => ({ at: T + offset, payload });
  const answer = row({
    purpose: 'answer', ok: true, chunkIndex: 0, sentenceId: 0,
    slotWaitMs: 5000, requestMs: 200, totalMs: 5200, chars: 40, coldStart: true,
  }, 20);
  // An ack and a later block are present but must never become the body's first chunk.
  const rows = [
    row({ purpose: 'ack', ok: true, chunkIndex: 0, sentenceId: 0, slotWaitMs: 4000, requestMs: 900, chars: 30 }, 10),
    answer,
    row({ purpose: 'answer', ok: true, chunkIndex: 1, sentenceId: 0, slotWaitMs: 0, requestMs: 300, chars: 60 }, 30),
  ];
  const breakdown = buildFirstChunkBreakdown({
    rows,
    streamed: { firstTranslated: false, firstTranslateMs: 0 },
    origin: T,
    // Derived from the pipeline's measured first-chunk stage, not re-read from a clock.
    audioReadyMs: 800,
  });
  assert.equal(breakdown.firstChunkSlotWaitMs, 5000, 'the first block queue wait');
  assert.equal(breakdown.firstChunkQueueWaitMs, 5000, 'the compatibility field is retained');
  assert.equal(breakdown.firstChunkRequestMs, 200, 'only the synthesis round trip');
  assert.equal(breakdown.firstChunkTtsMs, 200, 'the compatibility field is retained');
  assert.notEqual(breakdown.firstChunkRequestMs, 5200, 'queue time is not synthesis time');
  assert.equal(breakdown.firstChunkAudioReadyMs, 800, 'derived first-chunk stage');
  assert.equal(breakdown.firstChunkChars, 40, 'block 0 characters, never a later block');
  assert.equal(breakdown.firstChunkTranslateMs, 0, 'same language is a measured 0');
  assert.equal(breakdown.firstChunkKanaMs, 0);
  assert.equal(breakdown.ttsColdStart, true);

  // Missing boundaries stay null: no row and no audio-ready measurement must not become 0.
  const empty = buildFirstChunkBreakdown({
    rows: [row({ purpose: 'ack', ok: true, chunkIndex: 0, sentenceId: 0, requestMs: 900 }, 10)],
    streamed: null,
    origin: T,
    audioReadyMs: null,
  });
  for (const key of [
    'firstChunkQueueWaitMs', 'firstChunkSlotWaitMs', 'firstChunkTranslateMs', 'firstChunkKanaMs',
    'firstChunkTtsMs', 'firstChunkRequestMs', 'firstChunkAudioReadyMs', 'firstChunkChars',
    'ttsColdStart',
  ]) {
    assert.equal(empty[key], null, `${key} is null when never measured`);
  }
  // An explicit 0 is a measurement and is kept.
  const zero = buildFirstChunkBreakdown({ rows: [answer], streamed: null, origin: T, audioReadyMs: 0 });
  assert.equal(zero.firstChunkAudioReadyMs, 0);
});



test('P-140: a translated round keeps ms/cached, matching the voice.translate event', () => {
  // The translator reports this pair on `voice.translate`; the host folds the first sentence's
  // copy into the same turn's timeline row.
  const translateEvent = { ms: 320, cached: true };
  const row = voiceLatencyEvent({
    ...EXAMPLE,
    translateMs: translateEvent.ms,
    translateCached: translateEvent.cached,
    translated: true,
  });
  assert.ok(row.translateMs > 0);
  assert.equal(row.translateCached, translateEvent.cached, 'cache flag matches the event');

  // `snapshot()` is exactly what `/assistant/status` serializes as `voiceLatency`.
  const log = new VoiceLatencyLog();
  log.record({
    ...EXAMPLE,
    translateMs: translateEvent.ms,
    translateCached: translateEvent.cached,
    translated: true,
  });
  const snapshot = log.snapshot();
  assert.ok(snapshot.translateMs > 0, 'status.voiceLatency.translateMs > 0');
  assert.equal(snapshot.translateCached, translateEvent.cached);
  assert.deepEqual(snapshot.recent.at(-1), row, 'the retained row is the same timeline row');
});

test('P-140: a cache hit records translateCached=true (and its measured 0 ms lookup)', () => {
  const row = voiceLatencyEvent({ ...EXAMPLE, translated: true, translateMs: 0, translateCached: true });
  assert.equal(row.translateCached, true, 'the translation came from the cache');
  assert.equal(row.translateMs, 0, 'a cache hit measured 0 ms, not an unobserved null');
});

test('P-140: a same-language round leaves both translation stages null, never 0/false', () => {
  const row = voiceLatencyEvent({
    ...EXAMPLE,
    translated: false,
    translateMs: 0,
    translateCached: false,
  });
  assert.equal(row.translateMs, null);
  assert.equal(row.translateCached, null);
});

test('P-140: a failed translation attempt stays null even though it burned time', () => {
  const row = voiceLatencyEvent({
    ...EXAMPLE,
    translated: false,
    translateMs: 1500,
    translateCached: false,
  });
  assert.equal(row.translateMs, null, 'a fallback is not a translation stage');
  assert.equal(row.translateCached, null, 'never "not cached" without a translation');
});

// ---------------------------------------------------------------------------
// B) percentiles
// ---------------------------------------------------------------------------

test('percentile handles empty, single-value and interpolated samples', () => {
  assert.equal(percentile([], 0.5), null, 'no samples -> null');
  assert.equal(percentile([42], 0.5), 42, 'one sample -> itself');
  assert.equal(percentile([42], 0.95), 42, 'one sample at p95 -> itself');
  assert.equal(percentile([0, 1, 2, 3, 4], 0.5), 2, 'median of 0..4');
  assert.equal(percentile([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95), 10, 'p95 of 0..10');
  // Values arrive unsorted and non-numeric entries must not poison the result.
  assert.equal(percentile(['8', 'bad', 4, null, '0'], 0.5), 4);
});

test('summarizeVoiceLatency reports p50 and p95 for every stage', () => {
  const rows = [rowAt(0), rowAt(1), rowAt(2), rowAt(3)];
  const summary = summarizeVoiceLatency(rows);
  assert.equal(summary.count, 4);
  for (const field of VOICE_LATENCY_FIELDS) {
    if (field === 'translateCached') {
      // No translated sample in this set: a cache verdict would be fabricated.
      assert.equal(summary.p50[field], null, 'p50 translateCached needs a translated sample');
      assert.equal(summary.p95[field], null, 'p95 translateCached needs a translated sample');
      continue;
    }
    if (field === 'translateMs') {
      assert.equal(summary.p50[field], null, 'p50 translateMs has no translated sample');
      assert.equal(summary.p95[field], null, 'p95 translateMs has no translated sample');
      continue;
    }
    assert.ok(Number.isFinite(summary.p50[field]), `p50 ${field}`);
    assert.ok(Number.isFinite(summary.p95[field]), `p95 ${field}`);
    assert.ok(summary.p95[field] >= summary.p50[field], `p95 ${field} >= p50`);
  }
  // totalMs = 3000,3100,3200,3300 -> p50 between the middle values, p95 near the top.
  assert.equal(summary.p50.totalMs, 3150);
  assert.equal(summary.p95.totalMs, 3285);
  assert.equal(summarizeVoiceLatency([]).p50.totalMs, null, 'empty summary has null percentiles');
});

// ---------------------------------------------------------------------------
// C) the bounded 20-row ring
// ---------------------------------------------------------------------------

test('VoiceLatencyLog: empty and single-row boundaries', () => {
  const empty = new VoiceLatencyLog().snapshot();
  assert.deepEqual(empty.recent, []);
  assert.equal(empty.samples, 0);
  assert.deepEqual(empty.fields, VOICE_LATENCY_FIELDS);
  for (const field of VOICE_LATENCY_FIELDS) {
    assert.equal(empty.p50[field], null, `empty p50 ${field} is null`);
    assert.equal(empty.p95[field], null, `empty p95 ${field} is null`);
  }

  const one = new VoiceLatencyLog();
  one.record(EXAMPLE);
  const single = one.snapshot();
  assert.equal(single.samples, 1);
  assert.equal(single.recent.length, 1);
  assert.deepEqual(single.p50, {
    asrMs: 700,
    injectToAckMs: 40,
    ackToFirstTextMs: 1800,
    firstTextToFirstSentenceMs: 250,
    firstSentenceToFirstAudioMs: 900,
    totalMs: 3600,
    translateMs: null,
    translateCached: null,
  });
  assert.deepEqual(single.p95, single.p50, 'one row: p50 === p95');
});

test('VoiceLatencyLog: more than 20 rows keeps only the newest 20', () => {
  const log = new VoiceLatencyLog({ capacity: 20 });
  for (let index = 0; index < 25; index += 1) log.record(rowAt(index));
  const snapshot = log.snapshot();

  assert.equal(snapshot.samples, 25, 'the lifetime counter still counts every round');
  assert.equal(snapshot.recent.length, 20, 'the ring holds exactly 20 rows');
  assert.equal(snapshot.recent[0].sessionId, 'session-5', 'the five oldest rows were dropped');
  assert.equal(snapshot.recent[19].sessionId, 'session-24', 'the newest row is last');
  // Percentiles are computed over the retained window, not all 25 rounds.
  assert.equal(snapshot.p50.totalMs, 4450);
  assert.equal(snapshot.p95.totalMs, 5305);
});

test('P-140: the status snapshot exposes translation in rows, latest pair and p50/p95', () => {
  const log = new VoiceLatencyLog();
  log.record({ ...EXAMPLE, translated: true, translateMs: 320, translateCached: true });
  log.record({ ...EXAMPLE, translated: true, translateMs: 480, translateCached: false });
  const snapshot = log.snapshot();

  assert.deepEqual(
    snapshot.recent.map((row) => [row.translateMs, row.translateCached]),
    [[320, true], [480, false]],
    'every recent row carries both translation stages',
  );
  assert.equal(snapshot.translateMs, 480, 'status.voiceLatency.translateMs is the newest round');
  assert.equal(snapshot.translateCached, false);
  assert.equal(snapshot.p50.translateMs, 400, 'translated rounds feed the p50');
  assert.equal(snapshot.p95.translateMs, 472);
  assert.equal(snapshot.p50.translateCached, true, 'half the measured rounds were cached');
  assert.equal(snapshot.p95.translateCached, false);

  // A newer same-language round nulls the flattened pair without erasing older rows.
  log.record({ ...EXAMPLE, translated: false, translateMs: 0, translateCached: false });
  const after = log.snapshot();
  assert.equal(after.translateMs, null);
  assert.equal(after.translateCached, null);
  assert.deepEqual(after.recent.map((row) => row.translateCached), [true, false, null]);
});

// ---------------------------------------------------------------------------
// E) the settings card
// ---------------------------------------------------------------------------

test('P-140: the latency card renders cached / measured / no-translation text', () => {
  const clientSource = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const start = clientSource.indexOf('    const fmtTranslateLatency = (latency) => {');
  assert.ok(start > 0, 'the shipped fmtTranslateLatency is found in client.js');
  const end = clientSource.indexOf('\n    };', start);
  assert.ok(end > start, 'the helper body ends');
  const slice = clientSource.slice(start, end + '\n    };'.length);
  const fmt = new Function(`${slice}\nreturn fmtTranslateLatency;`)();

  assert.equal(fmt({ translateMs: 320, translateCached: true }), '320ms（缓存）');
  assert.equal(fmt({ translateMs: 450, translateCached: false }), '450ms');
  assert.equal(fmt({ translateMs: 0, translateCached: true }), '0ms（缓存）', 'a cache hit keeps the marker');
  assert.equal(fmt({ translateMs: null, translateCached: null }), '—');
  assert.equal(fmt({}), '—');

  const cardLine = "line('翻译', fmtTranslateLatency(latency)),";
  assert.equal(clientSource.split(cardLine).length - 1, 1, 'exactly one translation row in the card');
  assert.ok(
    clientSource.indexOf(cardLine) > clientSource.indexOf("line('总延迟 p50 / p95'"),
    'the translation row sits under the p50/p95 rows',
  );
});

// ---------------------------------------------------------------------------
// D) the status route
// ---------------------------------------------------------------------------

/** Mount the plugin on a temp root and capture the status route. */
function mountStatus(root) {
  const routes = new Map();
  const cleanups = [];
  const effect = (fn) => {
    const value = fn();
    if (typeof value === 'function') cleanups.push(value);
    return value;
  };
  const ctx = {
    effect,
    tools: { register: () => () => {} },
    inject: (_deps, register) => {
      register({
        effect,
        systemPrompt: { section: () => () => {} },
        webServer: {
          register(route) {
            routes.set(route.path, route.handler);
            return () => routes.delete(route.path);
          },
        },
      });
    },
  };
  apply(ctx, { root, enabled: true });
  return {
    status: () => new Promise((resolve, reject) => {
      const handler = routes.get('/assistant/status');
      assert.ok(handler !== undefined, 'status route registered');
      const res = {
        writeHead() {},
        end(payload) {
          try {
            resolve(JSON.parse(payload));
          } catch (error) {
            reject(error);
          }
        },
      };
      Promise.resolve(handler({ method: 'GET' }, res)).catch(reject);
    }),
    close: () => {
      for (const fn of cleanups.reverse()) fn();
    },
  };
}

test('status.voiceLatency exposes recent rows and p50/p95 keys', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-assistant-latency-'));
  const app = mountStatus(root);
  t.after(async () => {
    app.close();
    // node:sqlite keeps the file mapped until the process exits; a locked cleanup must not turn
    // a passing assertion into a failing test.
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {});
  });

  const status = await app.status();
  assert.ok(status.voiceLatency !== undefined, 'voiceLatency is in status');
  assert.ok(Array.isArray(status.voiceLatency.recent), 'recent is an array');
  assert.equal(status.voiceLatency.samples, 0, 'a fresh host has no samples');
  assert.deepEqual(status.voiceLatency.fields, VOICE_LATENCY_FIELDS);
  assert.ok(status.voiceLatency.fields.includes('translateMs'), 'translateMs is a canonical field');
  assert.ok(status.voiceLatency.fields.includes('translateCached'), 'translateCached is a canonical field');
  assert.equal(status.voiceLatency.translateMs, null, 'no sampled round yet -> null, not 0');
  assert.equal(status.voiceLatency.translateCached, null, 'no sampled round yet -> null, not false');
  assert.ok('p50' in status.voiceLatency && 'p95' in status.voiceLatency);
  for (const field of VOICE_LATENCY_FIELDS) {
    assert.ok(field in status.voiceLatency.p50, `p50.${field}`);
    assert.ok(field in status.voiceLatency.p95, `p95.${field}`);
  }
  // No disabled capability leaks into the status payload this round.
  assert.equal(status.reasoningPolicy, undefined, 'no dormant reasoning policy in status');
});

// ---------------------------------------------------------------------------
// E) P-46: the turn timeline's derived numbers beside the canonical stage set
// ---------------------------------------------------------------------------

test('the turn timeline adds observation numbers without touching the canonical 8 stages', () => {
  // The documented P-46 group, in order: model / tool split, first text/audio after the last
  // tool, prepare and residual, plus how many raw observations fed the round.
  assert.deepEqual([...VOICE_LATENCY_TIMELINE_FIELDS], [
    'modelMs', 'modelRounds', 'preToolMs', 'toolMs', 'toolMsSum', 'toolCalls', 'toolFailures',
    'firstTextAfterLastToolMs', 'firstAudioAfterLastToolMs', 'prepareMs', 'residualMs', 'collected',
  ]);
  for (const field of VOICE_LATENCY_TIMELINE_FIELDS) {
    assert.ok(!VOICE_LATENCY_FIELDS.includes(field), `${field} must not become a canonical stage`);
  }
  const T0 = 1_760_000_000_000;
  const observations = [
    { type: 'turn/start', at: T0, turn: 4, step: null },
    { type: 'step/start', at: T0 + 100, turn: 4, step: 1 },
    { type: 'assistant/message', at: T0 + 1_100, turn: 4, step: 1, hasTool: true, chars: 5 },
    { type: 'tool/call', at: T0 + 1_110, turn: 4, step: 1, callId: 't1', toolName: 'assistant_say' },
    { type: 'tool/call', at: T0 + 1_110, turn: 4, step: 1, callId: 't2', toolName: 'session_search' },
    { type: 'tool/result', at: T0 + 1_910, turn: 4, step: 1, callId: 't1', ok: true, reason: null },
    { type: 'tool/result', at: T0 + 2_310, turn: 4, step: 1, callId: 't2', ok: false, reason: 'TIMEOUT' },
    { type: 'turn/end', at: T0 + 2_400, turn: 4, step: null, status: 'completed' },
  ];
  const payload = buildTurnTimeline({
    sessionId: 'seirein-latency-timeline',
    turn: 4,
    origin: { at: T0, source: 'transcript' },
    observations,
    status: 'ok',
  });
  const stats = turnTimelineStats(payload, {
    firstTextAt: T0 + 2_500,
    audioAt: T0 + 2_700,
    transcriptAt: T0 + 40,
    injectedAt: T0 + 90,
    collected: observations.length,
  });
  assert.deepEqual(Object.keys(stats), [...VOICE_LATENCY_TIMELINE_FIELDS]);
  assert.equal(stats.modelMs, 1_000, 'one model round of 1 s');
  assert.equal(stats.modelRounds, 1);
  assert.equal(stats.preToolMs, 1_110, 'origin -> first tool call');
  // t1 800 ms and t2 1200 ms overlap from 1110 to 1910: union 1200, sum 2000.
  assert.equal(stats.toolMs, 1_200, 'the union is the wall time spent in tools');
  assert.equal(stats.toolMsSum, 2_000, 'the additive sum keeps the overlap visible');
  assert.equal(stats.toolCalls, 2);
  assert.equal(stats.toolFailures, 1);
  assert.equal(stats.firstTextAfterLastToolMs, 190, 'first text - last tool end');
  assert.equal(stats.firstAudioAfterLastToolMs, 390);
  assert.equal(stats.prepareMs, 50, 'transcript -> injected');
  assert.equal(stats.collected, observations.length);

  // An explicit measured 0 is kept (no tool call really spent 0 ms in tools); an unmeasured value
  // is null, never 0. The canonical event row itself is unchanged.
  const noTools = buildTurnTimeline({
    sessionId: 'seirein-latency-timeline',
    turn: 5,
    origin: { at: T0, source: 'injected' },
    observations: [
      { type: 'step/start', at: T0 + 10, turn: 5, step: 1 },
      { type: 'assistant/message', at: T0 + 10, turn: 5, step: 1, hasTool: false, chars: 3 },
    ],
  });
  const noToolStats = turnTimelineStats(noTools, { collected: 2 });
  assert.equal(noToolStats.modelMs, 0, 'an explicit 0 duration is a measurement');
  assert.equal(noToolStats.toolMs, 0, 'a tool-less round measured 0 ms of tool time');
  assert.equal(noToolStats.toolCalls, 0);
  assert.equal(noToolStats.preToolMs, null, 'no tool call -> no pre-tool stage');
  assert.equal(noToolStats.prepareMs, null, 'no transcript/injected pair -> null');

  // The canonical payload (the 8 stages and their p50/p95 card) is untouched by this group.
  assert.deepEqual(Object.keys(voiceLatencyEvent(EXAMPLE)), ['sessionId', ...VOICE_LATENCY_FIELDS]);
  const summary = summarizeVoiceLatency([voiceLatencyEvent(EXAMPLE)]);
  for (const field of VOICE_LATENCY_TIMELINE_FIELDS) {
    assert.ok(!(field in summary.p50), `${field} has no p50`);
  }
  console.log(`ℹ P-46 latency group: modelMs=${stats.modelMs} modelRounds=${stats.modelRounds} `
    + `preToolMs=${stats.preToolMs} toolMs=${stats.toolMs} toolMsSum=${stats.toolMsSum} `
    + `toolCalls=${stats.toolCalls} toolFailures=${stats.toolFailures} `
    + `residualMs=${stats.residualMs} collected=${stats.collected}`);
});
