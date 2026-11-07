/**
 * GPT-SoVITS guard regression: a missing reference clip must not reach `/tts` (the stock API
 * answers HTTP 400), and a real failure must log the status plus the first 400 characters of the
 * response body instead of only "HTTP 400". Both cases still fall back to Edge with the language
 * voice.
 *
 * Run: node --test test/gptsovits-guard.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { configureTts, synthesize } from '../src/host/speech/tts.js';

const API = 'http://127.0.0.1:9880';
const DIR = 'C:\\tmp\\dsh-gptsovits-guard';

function settings(patch = {}) {
  return {
    enabled: true,
    apiBase: API,
    refAudioPath: '',
    promptText: '',
    promptLang: 'zh',
    textLang: 'zh',
    models: { gptModelPath: '', sovitsModelPath: '' },
    ...patch,
  };
}

/** Configure a GPT provider plus capture hooks and an Edge stub that records its parameters. */
function harness(state) {
  const seen = { edge: [], skipped: [], failed: [], fetches: [] };
  configureTts({
    gptSovits: () => state,
    onGptSovitsSkipped: (payload) => seen.skipped.push(payload),
    onGptSovitsFailed: (payload) => seen.failed.push(payload),
    edgeSynthesize: async (options) => {
      seen.edge.push(options);
      return { file: 'edge.mp3', bytes: 1, durationMs: 1, provider: 'edge-tts' };
    },
  });
  return seen;
}

function stubFetch(t, response) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return response;
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

test('no reference clip: zero GPT requests, one skipped event, Edge fallback', async (t) => {
  const seen = harness(settings());
  const fetches = stubFetch(t, { ok: true, status: 200, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) });

  const result = await synthesize({ text: 'こんにちは', lang: 'ja', dir: DIR });

  assert.equal(fetches.length, 0, 'the guard never calls /tts without a reference clip');
  assert.deepEqual(seen.skipped, [{ reason: 'no-reference' }]);
  assert.deepEqual(seen.failed, [], 'a skip is not a failure');
  assert.equal(result.provider, 'edge-tts');
  assert.equal(seen.edge[0].voice, 'ja-JP-NanamiNeural', 'the fallback keeps the speech language');
});

test('with a reference clip: HTTP 400 records status and the first 400 body characters', async (t) => {
  const body = `{"message":"${'参考音频过长'.repeat(90)}"}`;
  assert.ok(body.length > 400);
  const seen = harness(settings({
    refAudioPath: 'C:\\voices\\ref.wav',
    promptText: 'こんにちは',
    promptLang: 'ja',
    textLang: 'ja',
  }));
  // The host decodes the error body from raw bytes (UTF-8), so the stub returns an ArrayBuffer.
  const fetches = stubFetch(t, {
    ok: false,
    status: 400,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  });

  const result = await synthesize({ text: 'テスト', lang: 'ja', dir: DIR });

  assert.equal(fetches.length, 1);
  assert.match(fetches[0], /\/tts\?/u);
  assert.equal(seen.failed.length, 1);
  assert.equal(seen.failed[0].status, 400);
  assert.equal(seen.failed[0].body.length, 400, 'the body is clipped, not dumped whole');
  assert.equal(String(seen.failed[0].error), 'GPT-SoVITS HTTP 400');
  assert.equal(result.provider, 'edge-tts');
  assert.equal(seen.edge[0].voice, 'ja-JP-NanamiNeural');
});

test('loaded models still allow one reference-less attempt, whose failure is logged', async (t) => {
  const seen = harness(settings({
    models: { gptModelPath: 'C:\\models\\gpt.ckpt', sovitsModelPath: 'C:\\models\\sovits.pth' },
  }));
  const fetches = stubFetch(t, {
    ok: false,
    status: 400,
    arrayBuffer: async () => new TextEncoder().encode('not supported without ref').buffer,
  });

  const result = await synthesize({ text: 'テスト', lang: 'en', dir: DIR });

  assert.equal(fetches.length, 1, 'the loaded-model deployment is allowed one attempt');
  assert.deepEqual(seen.skipped, []);
  assert.equal(seen.failed[0].status, 400);
  assert.equal(seen.failed[0].body, 'not supported without ref');
  assert.equal(result.provider, 'edge-tts');
  assert.equal(seen.edge[0].voice, 'en-US-AriaNeural');
});
