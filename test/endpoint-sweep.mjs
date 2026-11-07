/**
 * Stage 2: endpoint / segmentation parameter sweep, without the VAD model.
 *
 * The real streaming recognizer is fed a synthetic corpus (Edge TTS speech + digital silence) and
 * the endpoint is observed per 100 ms chunk. Three things are compared per parameter group:
 *   - are the five ~0.3 s answers still delivered;
 *   - is a normal sentence spliced by a 300/500/800 ms pause cut into two deliveries;
 *   - endpoint latency from the true end of speech (audio-time p50/p95).
 *
 * The sweep only *reads* endpoint timing. `DEFAULT_ENDPOINT_RULES` stays the shipping setting and
 * `startHearing` without `endpointRules` constructs exactly the old recognizer.
 *
 * Run: node --test test/endpoint-sweep.mjs
 * Regenerate fixtures: $env:ENDPOINT_SWEEP_REGENERATE='1'; node --test test/endpoint-sweep.mjs
 * Force the synthetic timing fallback: $env:ENDPOINT_SWEEP_TTS='0'
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import {
  DEFAULT_ENDPOINT_RULES,
  createFinalRecognizer,
  createRecognizer,
  finalModelReady,
  modelReady,
  resolveEndpointRules,
  voicedMetrics,
} from '../src/host/hearing/hearing.js';
import {
  CHUNK_MS,
  SAMPLE_RATE,
  ensureEndpointFixtures,
  readWav,
} from './fixtures/endpoint-audio.mjs';

const SILENCE_SWEEP_MS = [300, 500, 800];
/** Boundary probe: an 800 ms pause plus observed chunk/decoder overshoot needs a little more. */
const SILENCE_PROBE_MS = 1000;
const MIN_SPEECH_SWEEP_MS = [100, 250];
const LATENCY_TOLERANCE_MS = 1;

/** The streaming model the product ships with, in the usual local locations. */
function findModelDir() {
  const local = process.env.LOCALAPPDATA ?? '';
  const candidates = [
    process.env.ENDPOINT_SWEEP_MODEL_DIR,
    process.env.DSH_ASR_MODEL_DIR,
    local === '' ? '' : join(local, 'dsh-assistant', 'models', 'sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23'),
    local === '' ? '' : join(local, 'Seirein', 'models', 'sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23'),
    join(process.cwd(), 'models', 'sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23'),
  ];
  return candidates.find((candidate) => modelReady(candidate)) ?? null;
}

/** The SenseVoice pass hearing uses for the final text (not a VAD model). */
function findFinalModelDir() {
  const local = process.env.LOCALAPPDATA ?? '';
  const candidates = [
    process.env.ENDPOINT_SWEEP_FINAL_MODEL_DIR,
    local === '' ? '' : join(local, 'dsh-assistant', 'models', 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17'),
    local === '' ? '' : join(local, 'Seirein', 'models', 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17'),
    join(process.cwd(), 'models', 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17'),
  ];
  return candidates.find((candidate) => finalModelReady(candidate)) ?? null;
}

function concatSamples(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Mirror hearing's accurate pass for a text-less endpoint: the offline decode may still hear it. */
function decodeFinal(recognizer, pcm) {
  if (recognizer === null) return '';
  const stream = recognizer.createStream();
  stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: pcm });
  recognizer.decode(stream);
  return String(recognizer.getResult(stream)?.text ?? '').trim();
}

function percentile(samples, fraction) {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((left, right) => left - right);
  const rank = Math.ceil(fraction * sorted.length);
  return Math.round(sorted[Math.max(0, rank - 1)]);
}

/** Audio-time end of the speech range a delivery's endpoint belongs to. */
function speechEndBefore(clip, endpointMs) {
  let end = clip.speechRangesMs[0]?.[1] ?? 0;
  for (const [, rangeEnd] of clip.speechRangesMs) {
    if (rangeEnd <= endpointMs + LATENCY_TOLERANCE_MS) end = rangeEnd;
  }
  return end;
}

/**
 * One endpoint pass over one clip. `deliveries` keeps every endpoint (including text-less ones) so
 * splitting is measured from timing, not from whether a noisy pause happened to decode text.
 */
function runClip(recognizer, finalRecognizer, clip) {
  const stream = recognizer.createStream();
  const chunkSamples = Math.round((SAMPLE_RATE * CHUNK_MS) / 1000);
  const deliveries = [];
  let utterance = [];
  for (let start = 0; start < clip.pcm.length; start += chunkSamples) {
    const piece = clip.pcm.subarray(start, Math.min(clip.pcm.length, start + chunkSamples));
    utterance.push(piece);
    stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: piece });
    while (recognizer.isReady(stream)) recognizer.decode(stream);
    if (!recognizer.isEndpoint(stream)) continue;
    const endpointMs = ((start + piece.length) * 1000) / SAMPLE_RATE;
    const streamingText = String(recognizer.getResult(stream)?.text ?? '').trim();
    const voiced = voicedMetrics(utterance, { sampleRate: SAMPLE_RATE });
    // Only a voiced, text-less endpoint is worth the offline pass; room tone stays untouched.
    const refineStarted = performance.now();
    const offlineText = streamingText === '' && (voiced?.voicedMs ?? 0) >= 150
      ? decodeFinal(finalRecognizer, concatSamples(utterance))
      : '';
    const refineMs = streamingText === '' && (voiced?.voicedMs ?? 0) >= 150
      ? Math.round(performance.now() - refineStarted)
      : 0;
    deliveries.push({
      text: streamingText === '' ? offlineText : streamingText,
      refined: streamingText === '' && offlineText !== '',
      refineMs,
      endpointMs,
      voicedMs: voiced?.voicedMs ?? 0,
      speechEndMs: speechEndBefore(clip, endpointMs),
    });
    recognizer.reset(stream);
    utterance = [];
  }
  return deliveries;
}

function evaluate(manifest, config, deliveriesByClip, judgeable) {
  const rows = [];
  const shortClips = manifest.clips.filter((clip) => clip.kind === 'short-answer');
  const pauseClips = manifest.clips.filter((clip) => clip.kind === 'pause');
  const longClip = manifest.clips.find((clip) => clip.kind === 'long');
  for (const minSpeechMs of MIN_SPEECH_SWEEP_MS) {
    const delivered = (delivery) => delivery.text.length > 0 && delivery.voicedMs >= minSpeechMs;
    const shortMissing = shortClips
      .filter((clip) => !deliveriesByClip.get(clip.id).some(delivered))
      .map((clip) => clip.id);
    const shortDelivered = shortClips.length - shortMissing.length;
    const splitPauses = pauseClips.filter((clip) => {
      // Any endpoint before the second sentence finished means the first sentence was finalized
      // on its own. Comparing against the sentence *start* misses the realistic case where the
      // threshold is reached at the pause boundary and the 100 ms chunk check fires just inside B.
      const secondEnd = clip.speechRangesMs[1][1];
      return deliveriesByClip.get(clip.id).some((delivery) => delivery.endpointMs < secondEnd - LATENCY_TOLERANCE_MS);
    });
    const longDeliveries = deliveriesByClip.get(longClip.id);
    const longRangeEnd = longClip.speechRangesMs.at(-1)[1];
    const longSplit = longDeliveries.some((delivery) => delivery.endpointMs < longRangeEnd - LATENCY_TOLERANCE_MS);
    const latencies = [];
    const deliveryLatencies = [];
    let worst = null;
    for (const clip of manifest.clips) {
      for (const delivery of deliveriesByClip.get(clip.id)) {
        // Endpoint latency is a timing property of voiced audio, so it stays measurable even when
        // the synthetic fallback produced no recognizable text at all.
        if (delivery.voicedMs < minSpeechMs) continue;
        const latencyMs = Math.max(0, delivery.endpointMs - delivery.speechEndMs);
        latencies.push(latencyMs);
        deliveryLatencies.push(latencyMs + delivery.refineMs);
        if (worst === null || latencyMs > worst.latencyMs) {
          worst = { clipId: clip.id, text: delivery.text, latencyMs: Math.round(latencyMs) };
        }
      }
    }
    const splits = splitPauses.length + (longSplit ? 1 : 0);
    rows.push({
      config,
      minSpeechMs,
      shortAnswersDelivered: shortDelivered,
      shortAnswersTotal: shortClips.length,
      shortMissing,
      shortAnswerDelivered: judgeable && shortDelivered === shortClips.length,
      splitPauses: splitPauses.map((clip) => clip.id),
      longSplit,
      splitSentence: splits > 0,
      splitCount: splits,
      samples: latencies.length,
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      deliveryP50: percentile(deliveryLatencies, 0.5),
      deliveryP95: percentile(deliveryLatencies, 0.95),
      worst,
    });
  }
  return rows;
}

test('endpoint rules keep the shipping defaults and accept explicit overrides', () => {
  assert.deepEqual(DEFAULT_ENDPOINT_RULES, {
    rule1MinTrailingSilence: 3.0,
    rule2MinTrailingSilence: 1.8,
    rule3MinUtteranceLength: 20,
  });
  assert.deepEqual(resolveEndpointRules(), DEFAULT_ENDPOINT_RULES);
  assert.deepEqual(resolveEndpointRules({}), DEFAULT_ENDPOINT_RULES);
  assert.deepEqual(resolveEndpointRules({ rule2MinTrailingSilence: 0.3 }), {
    ...DEFAULT_ENDPOINT_RULES,
    rule2MinTrailingSilence: 0.3,
  });
  // Invalid overrides never leak a non-number into the recognizer: the default wins.
  assert.deepEqual(resolveEndpointRules({ rule1MinTrailingSilence: 'nope' }), DEFAULT_ENDPOINT_RULES);
});

test('fixtures are replayable, declared synthetic, and splice exact silence', async (t) => {
  const manifest = await ensureEndpointFixtures();
  t.diagnostic(`fixtures: ${manifest.rootDir} source=${manifest.source} clips=${manifest.clips.length}`);
  assert.equal(manifest.kind, 'endpoint-audio-fixtures');
  assert.equal(manifest.source === 'edge-tts' || manifest.source === 'synthetic', true);
  assert.ok(manifest.disclaimer.includes('不是真人录音') || manifest.disclaimer.includes('不是真实语音'));
  assert.equal(manifest.clips.length, 9, '5 short answers + 3 pauses + 1 long sentence');

  const shorts = manifest.clips.filter((clip) => clip.kind === 'short-answer');
  for (const clip of shorts) {
    assert.ok(clip.speechMs >= 150 && clip.speechMs <= 600, `${clip.id} is a short answer (${clip.speechMs} ms)`);
  }
  for (const pauseMs of [300, 500, 800]) {
    const clip = manifest.clips.find((entry) => entry.id === `pause-${pauseMs}`);
    assert.ok(clip, `pause-${pauseMs} exists`);
    assert.equal(clip.pauseMs, pauseMs);
    const gap = clip.speechRangesMs[1][0] - clip.speechRangesMs[0][1];
    assert.ok(Math.abs(gap - pauseMs) <= 1, `pause-${pauseMs} splices ${pauseMs} ms of silence (got ${gap})`);
  }
  const long = manifest.clips.find((clip) => clip.kind === 'long');
  assert.ok(long.speechMs >= 1500, 'the long sentence is really long');

  // Replay the documents we are about to scan: the same bytes must decode to the same corpus.
  for (const clip of manifest.clips) {
    const wav = readWav(clip.path);
    assert.equal(Math.round(wav.durationMs), clip.durationMs, `${clip.id} duration`);
    assert.ok(wav.pcm.some((sample) => Math.abs(sample) > 0.01), `${clip.id} has speech`);
  }
  const second = await ensureEndpointFixtures();
  assert.equal(second.generatedAt, manifest.generatedAt, 'a second call replays the same manifest');
});

test('endpoint sweep over silence x minimum-speech', {
  skip: findModelDir() === null || findFinalModelDir() === null
    ? 'streaming or SenseVoice model not found'
    : false,
}, async (t) => {
  const modelDir = findModelDir();
  const finalModelDir = findFinalModelDir();
  const finalRecognizer = createFinalRecognizer(finalModelDir, { numThreads: 1 });
  const manifest = await ensureEndpointFixtures();
  const clips = manifest.clips.map((clip) => ({ ...clip, pcm: readWav(clip.path).pcm }));
  const configs = [
    { label: 'default', endpoint: {}, rule2Ms: 1800 },
    ...SILENCE_SWEEP_MS.map((ms) => ({
      label: `silence-${ms}`,
      endpoint: { rule2MinTrailingSilence: ms / 1000 },
      rule2Ms: ms,
    })),
    {
      label: `silence-${SILENCE_PROBE_MS}-probe`,
      endpoint: { rule2MinTrailingSilence: SILENCE_PROBE_MS / 1000 },
      rule2Ms: SILENCE_PROBE_MS,
    },
  ];
  t.diagnostic(`model=${modelDir}`);
  t.diagnostic(`finalModel=${finalModelDir}`);
  t.diagnostic(`fixtures=${manifest.source} chunkMs=${CHUNK_MS} clips=${clips.length}`);
  const shorts = manifest.clips.filter((clip) => clip.kind === 'short-answer');
  t.diagnostic(`short-answer voiced: ${shorts.map((clip) => `${clip.id}=${clip.speechMs}ms "${clip.text}"`).join(', ')}`);

  const rows = [];
  for (const config of configs) {
    const recognizer = createRecognizer(modelDir, { numThreads: 1, endpoint: config.endpoint });
    const deliveriesByClip = new Map();
    for (const clip of clips) deliveriesByClip.set(clip.id, runClip(recognizer, finalRecognizer, clip));
    for (const id of ['short-en', 'pause-800', 'long-sentence']) {
      const clip = clips.find((entry) => entry.id === id);
      const line = deliveriesByClip.get(id)
        .map((delivery) => `ep=${Math.round(delivery.endpointMs)}ms vo=${delivery.voicedMs}ms${delivery.refineMs > 0 ? ` refine=${delivery.refineMs}ms` : ''} "${delivery.text}"`)
        .join(' | ');
      t.diagnostic(`  [${config.label}/${clip.id}] ${line || '(no endpoint)'}`);
    }
    rows.push(...evaluate(manifest, config, deliveriesByClip, manifest.source === 'edge-tts'));
  }

  const header = 'ruleValue                             shortAnswerDelivered splitSentence endpointLatencyMs(p50) endpointLatencyMs(p95)';
  t.diagnostic(header);
  for (const row of rows) {
    const ruleValue = `${row.config.rule2Ms === 1800 ? 'r2=1800ms(default)' : `r2=${row.config.rule2Ms}ms`}/minSpeech=${row.minSpeechMs}ms`;
    const line = [
      ruleValue.padEnd(36),
      (manifest.source === 'synthetic'
        ? 'n/a'
        : row.shortAnswerDelivered ? 'yes' : `no(${row.shortAnswersDelivered}/${row.shortAnswersTotal})`).padEnd(20),
      (row.splitSentence ? `yes(${row.splitCount})` : 'no').padEnd(13),
      String(row.p50).padEnd(23),
      String(row.p95),
    ].join(' ');
    t.diagnostic(line);
    const deliveryDetail = manifest.source === 'synthetic'
      ? 'delivered=n/a'
      : `delivered=${row.shortAnswersDelivered}/${row.shortAnswersTotal}${row.shortMissing.length > 0 ? ` (missing: ${row.shortMissing.join(',')})` : ''}`;
    t.diagnostic(`  detail ${row.config.label}: ${deliveryDetail}, split=${row.splitPauses.join(',') || 'none'}${row.longSplit ? ',long' : ''}, samples=${row.samples}, worst=${row.worst?.clipId}:${row.worst?.latencyMs}ms, delivery p50=${row.deliveryP50}ms p95=${row.deliveryP95}ms`);
  }

  // Every row must be a valid observation, even when the answer is "no".
  for (const row of rows) {
    assert.ok(row.shortAnswersTotal === 5);
    assert.ok(row.samples > 0, `${row.config.label}/${row.minSpeechMs} produced a latency sample`);
    assert.ok(row.p50 !== null && row.p95 !== null && row.p95 >= row.p50);
  }
  if (manifest.source === 'edge-tts') {
    assert.ok(rows.some((row) => row.shortAnswerDelivered), 'at least the shipping default still delivers short answers');
  }
  if (manifest.source === 'edge-tts') {
    assert.ok(rows.some((row) => !row.splitSentence), 'at least one group leaves the spliced sentence intact');
  }

  const rank = (left, right) => left.splitCount - right.splitCount || left.p50 - right.p50 || left.minSpeechMs - right.minSpeechMs;
  const candidates = rows.filter((row) => row.shortAnswerDelivered).sort(rank);
  const ranked = candidates.length > 0 ? candidates : [...rows].sort(rank);
  const best = ranked[0];
  const bestSweep = ranked.find((row) => row.config.label !== 'default') ?? best;
  const defaultBest = rows.filter((row) => row.config.label === 'default').sort(rank)[0];
  const judged = candidates.length > 0;
  t.diagnostic(`best overall: ${best.config.label}/minSpeech=${best.minSpeechMs}ms (splits=${best.splitCount}, p50=${best.p50}ms, p95=${best.p95}ms)`);
  t.diagnostic(`best sweep-only: ${bestSweep.config.label}/minSpeech=${bestSweep.minSpeechMs}ms (splits=${bestSweep.splitCount}, p50=${bestSweep.p50}ms, p95=${bestSweep.p95}ms)`);
  t.diagnostic(`shipping default: splits=${defaultBest.splitCount}, p50=${defaultBest.p50}ms, p95=${defaultBest.p95}ms`);
  const verdict = !judged
    ? 'synthetic fallback: delivery cannot be judged and rule2 may not fire without tokens; treat this table as a smoke test, not a parameter comparison'
    : bestSweep.splitCount < defaultBest.splitCount
      ? `${bestSweep.config.label} splits less than the default while keeping short answers`
      : bestSweep.splitCount === defaultBest.splitCount && bestSweep.p50 < defaultBest.p50
        ? `${bestSweep.config.label} matches the default's ${defaultBest.splitCount} cut(s) at a lower p50 (${bestSweep.p50}ms vs ${defaultBest.p50}ms)`
        : 'no sweep value beats the shipping default on splits; lower silence trades latency for more mid-sentence cuts';
  t.diagnostic(`verdict: ${verdict}`);
  t.diagnostic(`fixture source note: ${manifest.source === 'edge-tts' ? 'real TTS voice; answer recognition is meaningful' : 'synthetic tones; only endpoint timing is meaningful'}`);
});
