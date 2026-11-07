/**
 * ASR worker thread: hosts the SenseVoice offline (accurate-pass) recognizer so a decode never
 * blocks the host's main thread. `src/host/hearing/hearing.js` starts this thread lazily on the first
 * utterance that needs the accurate pass, detaches it with `unref()`, and terminates it on stop.
 *
 * Protocol (main → worker):
 *   { type: 'decode', id, audio, sampleRate, language, utteranceId }
 * Worker → main:
 *   { type: 'result', id, utteranceId, segmentIds, text, joinFallback, lang, langClean, emotion,
 *     emotionClean, event, eventClean }
 *                                                one message per request; the tag fields are null
 *                                                when absent, `segmentIds` names every decode piece
 *   { type: 'error',  id, error }                the decode threw; the caller may fall back
 *
 * The model is created on the first decode inside this thread (`workerData` carries the directory
 * and thread count), so spawning the worker costs nothing until an utterance actually finalizes.
 * `decodeSegmented()` is imported from `hearing.js` on purpose: the worker and the synchronous
 * fallback must produce byte-identical offline results.
 */
import { isMainThread, parentPort, workerData } from 'node:worker_threads';

import { asrTagFields, createFinalRecognizer, decodeSegmented } from './hearing.js';

const config = {
  modelDir: '',
  numThreads: 2,
  segmentSamples: 16000 * 15,
  overlapSamples: 0,
  language: 'auto',
  ...(workerData ?? {}),
};

let recognizer = null;

/** Build the offline recognizer once, on this thread. */
function ensureRecognizer(language) {
  if (recognizer === null) {
    recognizer = createFinalRecognizer(config.modelDir, {
      numThreads: config.numThreads,
      language: language || config.language,
    });
  }
  return recognizer;
}

/** Decode one utterance and answer the main thread. Every request gets exactly one reply. */
function handle(message) {
  if (message?.type !== 'decode') return;
  const { id } = message;
  try {
    const audio = message.audio instanceof Float32Array ? message.audio : new Float32Array(message.audio);
    const pass = decodeSegmented(
      ensureRecognizer(message.language),
      audio,
      Math.max(1, Math.floor(Number(config.segmentSamples) || 16000 * 15)),
      Math.max(0, Math.floor(Number(config.overlapSamples) || 0)),
      Number(message.sampleRate) || 16000,
      // Scope the per-piece ids with the caller's utterance id, so the main thread can line this
      // result up with the capture loop and the noise-shadow row.
      { utteranceId: message.utteranceId ?? null },
    );
    parentPort.postMessage({
      type: 'result',
      id,
      utteranceId: message.utteranceId ?? null,
      segmentIds: Array.isArray(pass.segmentIds) ? pass.segmentIds : [],
      text: pass.text,
      joinFallback: pass.joinFallback === true,
      ...asrTagFields(pass),
    });
  } catch (error) {
    parentPort.postMessage({ type: 'error', id, error: String(error?.message ?? error) });
  }
}

if (!isMainThread && parentPort !== null) {
  parentPort.on('message', handle);
}
