#!/usr/bin/env node
/**
 * Read-only voice-latency baseline from the existing event log.
 *
 *   node tools/voice-baseline.mjs [events.jsonl] [window]
 *
 * The three lanes are kept separate. A lane with zero rows is reported as unavailable; this
 * script never fills it with reply-lane numbers. Stage meanings are printed next to the fields so
 * translation / pure synthesis / synthesis-seat wait / playback-seat wait cannot be added by
 * mistake.
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2] ?? 'data/events.jsonl';
const windowSize = Math.max(1, Math.min(500, Number(process.argv[3]) || 20));
const lines = readFileSync(file, 'utf8').trim().split('\n');
const rows = lines.map((line) => {
  try { return JSON.parse(line); } catch { return null; }
}).filter(Boolean);

const latest = (type, count = windowSize) => rows.filter((row) => row.type === type).slice(-count);
const percentile = (values, p) => {
  const numbers = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (numbers.length === 0) return null;
  return numbers[Math.min(numbers.length - 1, Math.floor((numbers.length - 1) * p))];
};
const stats = (values) => ({
  count: values.filter((value) => Number.isFinite(value)).length,
  p50: percentile(values, 0.5),
  p95: percentile(values, 0.95),
  max: percentile(values, 1),
});

const pipelines = latest('voice.pipeline.timeline').map((row) => row.payload ?? {});
const latencies = latest('voice.latency').map((row) => row.payload ?? {});
const say = latest('speech.play.start').map((row) => row.payload ?? {}).filter((row) => row.lane === 'say');
const fastpath = rows.filter((row) => String(row.type ?? '').startsWith('fastpath.')).slice(-windowSize);

const pick = (list, field) => stats(list.map((row) => Number(row[field])));

const reply = {
  samples: Math.max(pipelines.length, latencies.length),
  pipeline: Object.fromEntries([
    'bodyReadyMs', 'firstChunkTranslateMs', 'firstChunkTtsMs', 'firstChunkSynthMs',
    'firstChunkSlotWaitMs', 'firstChunkQueueWaitMs', 'firstAudioMs', 'firstChunkChars',
  ].map((field) => [field, pick(pipelines, field)])),
  latency: Object.fromEntries([
    'totalMs', 'asrMs', 'ackToFirstTextMs', 'firstTextToFirstSentenceMs',
    'firstSentenceToFirstAudioMs', 'firstSynthMs', 'translateMs', 'firstQueueWaitMs',
    'ttsSlotWaitMs', 'firstAudibleMs',
  ].map((field) => [field, pick(latencies, field)])),
};

console.log(JSON.stringify({
  source: file,
  window: windowSize,
  lanes: {
    reply,
    assistant_say: { samples: say.length, note: say.length === 0 ? 'no say-lane samples in log' : '' },
    fastpath: { samples: fastpath.length, note: fastpath.length === 0 ? 'no fastpath samples in log' : '' },
  },
  semantics: {
    firstChunkTranslateMs: 'translation only',
    firstChunkTtsMs: 'pure first-block synthesis; do not add translation again',
    firstChunkSynthMs: 'body-ready to first-block ready; includes preparation/translation',
    firstChunkSlotWaitMs: 'synthesis-seat queue wait',
    firstChunkQueueWaitMs: 'synthesis ready to playback start (playback seat)',
    firstQueueWaitMs: 'synthesis ready to playback start (playback seat)',
    ttsSlotWaitMs: 'synthesis-seat queue wait on the latency row',
    residualMs: 'whole-turn timeline residual; not all player time',
  },
}, null, 2));
