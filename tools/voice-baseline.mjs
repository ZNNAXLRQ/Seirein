#!/usr/bin/env node
/**
 * Read-only voice-latency baseline from the existing event log.
 *
 *   node tools/voice-baseline.mjs [events.jsonl] [window]
 *
 * Three lanes are kept separate. A lane with zero samples is unavailable, never filled with reply
 * numbers. Reply pipeline/latency rows are joined by session + delivery/turn before paired
 * statistics; `firstAudioMs` and `firstChunkSynthMs` are INJECTION-origin values, so
 * body-relative waits are computed per pair (`firstAudioMs - bodyReadyMs`).
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2] ?? 'data/events.jsonl';
const windowSize = Math.max(1, Math.min(500, Number(process.argv[3]) || 20));
const rows = readFileSync(file, 'utf8').trim().split('\n').map((line) => {
  try { return JSON.parse(line); } catch { return null; }
}).filter(Boolean);

const num = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const percentile = (values, p) => {
  const numbers = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (numbers.length === 0) return null;
  return numbers[Math.min(numbers.length - 1, Math.floor((numbers.length - 1) * p))];
};
const stats = (values) => ({
  count: values.filter(Number.isFinite).length,
  p50: percentile(values, 0.5),
  p95: percentile(values, 0.95),
  max: percentile(values, 1),
});
const fieldStats = (list, field) => stats(list.map((row) => num(row[field])).filter((value) => value !== null));
const keyOf = (row) => {
  const payload = row.payload ?? {};
  const session = String(payload.sessionId ?? '');
  const id = String(payload.deliveryMessageId ?? '');
  if (session && id) return `${session}\0${id}`;
  if (session && Number.isSafeInteger(payload.turn)) return `${session}\0turn:${payload.turn}`;
  return '';
};

const pipeline = rows.filter((row) => row.type === 'voice.pipeline.timeline').map((row) => row.payload ?? {});
const latency = rows.filter((row) => row.type === 'voice.latency').map((row) => row.payload ?? {});
const pipelineByKey = new Map(pipeline.map((row) => [keyOf({ payload: row }), row]).filter(([key]) => key !== ''));
const latencyByKey = new Map(latency.map((row) => [keyOf({ payload: row }), row]).filter(([key]) => key !== ''));
const allPairedKeys = [...pipelineByKey.keys()].filter((key) => latencyByKey.has(key));
const joinedKeys = allPairedKeys.slice(-windowSize);
const joined = joinedKeys.map((key) => ({ key, pipeline: pipelineByKey.get(key), latency: latencyByKey.get(key) }));
// Count missing counterparts across the WHOLE log, then restrict only the statistics window.
// A pair outside the last N rounds is old data, not an unpaired row.
const unpairedPipeline = pipeline.filter((row) => {
  const key = keyOf({ payload: row });
  return key === '' || !latencyByKey.has(key);
}).length;
const unpairedLatency = latency.filter((row) => {
  const key = keyOf({ payload: row });
  return key === '' || !pipelineByKey.has(key);
}).length;

const bodyAfter = joined
  .map(({ pipeline: p }) => (num(p.firstAudioMs) !== null && num(p.bodyReadyMs) !== null
    ? num(p.firstAudioMs) - num(p.bodyReadyMs) : null))
  .filter((value) => value !== null);
const synthAfterBody = joined
  .map(({ pipeline: p }) => (num(p.firstChunkSynthMs) !== null && num(p.bodyReadyMs) !== null
    ? num(p.firstChunkSynthMs) - num(p.bodyReadyMs) : null))
  .filter((value) => value !== null);

const reply = {
  pairedSamples: joined.length,
  pairedSamplesAll: allPairedKeys.length,
  pairedOutsideWindow: allPairedKeys.length - joined.length,
  pipelineSamples: pipeline.length,
  latencySamples: latency.length,
  unpairedPipeline,
  unpairedLatency,
  pipeline: Object.fromEntries([
    'bodyReadyMs', 'firstChunkTranslateMs', 'firstChunkTtsMs', 'firstChunkSynthMs',
    'firstChunkSlotWaitMs', 'firstChunkQueueWaitMs', 'firstAudioMs', 'firstChunkChars',
  ].map((field) => [field, fieldStats(joined.map((entry) => entry.pipeline), field)])),
  // Paired body-relative waits: never subtract two independent p50 values.
  bodyRelative: {
    firstChunkSynthAfterBodyMs: stats(synthAfterBody),
    firstAudioAfterBodyMs: stats(bodyAfter),
  },
  latency: Object.fromEntries([
    'totalMs', 'asrMs', 'ackToFirstTextMs', 'firstTextToFirstSentenceMs',
    'firstSentenceToFirstAudioMs', 'firstSynthMs', 'translateMs', 'firstQueueWaitMs',
    'ttsSlotWaitMs', 'firstAudibleMs',
  ].map((field) => [field, fieldStats(joined.map((entry) => entry.latency), field)])),
};

const sayRows = rows
  .filter((row) => row.type === 'speech.play.start')
  .map((row) => row.payload ?? {})
  .filter((payload) => payload.lane === 'say')
  .slice(-windowSize);
const fastpathRows = rows
  .filter((row) => row.type === 'fastpath.turn')
  .map((row) => row.payload ?? {})
  .slice(-windowSize);

console.log(JSON.stringify({
  source: file,
  window: windowSize,
  lanes: {
    reply,
    assistant_say: {
      samples: sayRows.length,
      note: sayRows.length === 0 ? 'no say-lane speech.play.start rows' : 'playback start only; no full first-audio row',
      callToFirstAudioMs: fieldStats(sayRows, 'callToFirstAudioMs'),
      queueWaitMs: fieldStats(sayRows, 'queueWaitMs'),
    },
    fastpath: {
      samples: fastpathRows.length,
      note: fastpathRows.length === 0 ? 'no fastpath.turn rows' : 'fastpath.turn.ms is a whole-turn duration, not first audio',
      turnMs: fieldStats(fastpathRows, 'ms'),
    },
  },
  semantics: {
    firstChunkTranslateMs: 'translation only',
    firstChunkTtsMs: 'pure first-block synthesis; do not add translation again',
    firstChunkSynthMs: 'injection-to-first-block-ready; includes preparation/translation',
    bodyReadyMs: 'injection-to-body-ready',
    firstAudioMs: 'injection-to-first-audio',
    firstChunkSlotWaitMs: 'synthesis-seat queue wait',
    firstChunkQueueWaitMs: 'synthesis-ready-to-playback-start (playback seat)',
    firstQueueWaitMs: 'synthesis-ready-to-playback-start (playback seat)',
    ttsSlotWaitMs: 'synthesis-seat queue wait on the latency row',
    residualMs: 'whole-turn timeline residual; not all player time',
    bodyRelative: 'per-row subtraction firstAudioMs - bodyReadyMs; never subtract independent p50s',
  },
}, null, 2));
