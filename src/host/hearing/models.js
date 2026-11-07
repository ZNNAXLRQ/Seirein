/** models — extracted from hearing.js; no host entry dependency. */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_ENDPOINT_RULES } from './audio-evidence.js';

const require = createRequire(import.meta.url);


const MODEL_FILES = {
  encoder: 'encoder-epoch-99-avg-1.onnx',
  decoder: 'decoder-epoch-99-avg-1.onnx',
  joiner: 'joiner-epoch-99-avg-1.onnx',
  tokens: 'tokens.txt',
};


/** Whether a directory looks like a usable streaming-transducer model. */
export function modelReady(modelDir) {
  if (typeof modelDir !== 'string' || modelDir.length === 0) return false;
  return Object.values(MODEL_FILES).every((name) => existsSync(join(modelDir, name)));
}


/** Whether a directory holds the SenseVoice final-pass model. */
export function finalModelReady(modelDir) {
  if (typeof modelDir !== 'string' || modelDir.length === 0) return false;
  return existsSync(join(modelDir, 'model.int8.onnx')) && existsSync(join(modelDir, 'tokens.txt'));
}


/** Build the offline (final-pass) recognizer. Also used inside the decode worker thread. */
export function createFinalRecognizer(modelDir, { numThreads = 2, language = 'auto' } = {}) {
  const sherpa = require('sherpa-onnx-node');
  return new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      senseVoice: {
        model: join(modelDir, 'model.int8.onnx'),
        language,
        useInverseTextNormalization: 1,
      },
      tokens: join(modelDir, 'tokens.txt'),
      numThreads,
      provider: 'cpu',
      debug: 0,
    },
  });
}


/**
 * Resolve endpoint-rule overrides. Omitted (or invalid) keys keep `DEFAULT_ENDPOINT_RULES`, so the
 * shipping endpoint behaviour is unchanged unless a caller passes `endpoint` explicitly.
 */
export function resolveEndpointRules(endpoint = {}) {
  const pick = (value, fallback) => (value != null && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : fallback);
  return {
    rule1MinTrailingSilence: pick(endpoint?.rule1MinTrailingSilence, DEFAULT_ENDPOINT_RULES.rule1MinTrailingSilence),
    rule2MinTrailingSilence: pick(endpoint?.rule2MinTrailingSilence, DEFAULT_ENDPOINT_RULES.rule2MinTrailingSilence),
    rule3MinUtteranceLength: pick(endpoint?.rule3MinUtteranceLength, DEFAULT_ENDPOINT_RULES.rule3MinUtteranceLength),
  };
}


/** Build the streaming recognizer once; construction is expensive. */
export function createRecognizer(modelDir, { numThreads = 2, endpoint = {} } = {}) {
  const sherpa = require('sherpa-onnx-node');
  const rules = resolveEndpointRules(endpoint);
  return new sherpa.OnlineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: join(modelDir, MODEL_FILES.encoder),
        decoder: join(modelDir, MODEL_FILES.decoder),
        joiner: join(modelDir, MODEL_FILES.joiner),
      },
      tokens: join(modelDir, MODEL_FILES.tokens),
      numThreads,
      provider: 'cpu',
      debug: 0,
    },
    decodingMethod: 'greedy_search',
    enableEndpoint: true,
    rule1MinTrailingSilence: rules.rule1MinTrailingSilence,
    rule2MinTrailingSilence: rules.rule2MinTrailingSilence,
    // The same value the shadow row reads back as `endpointReason: 'max-duration'`.
    rule3MinUtteranceLength: rules.rule3MinUtteranceLength,
  });
}

export { require, MODEL_FILES };
