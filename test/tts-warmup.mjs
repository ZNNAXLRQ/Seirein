/**
 * Warm-up benefit check, with a fake cold backend.
 *
 * The one-character warm-up is still real `/tts` content (not a natural sentence). This test
 * models a server whose first synthesis pays a fixed cold-start cost and whose later requests are
 * fast: without a warm-up the first real block pays that cost, with a successful warm-up the
 * following real block does not. It also checks that the warm-up clip is cleaned up.
 *
 * Run: node test/tts-warmup.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  configureTts,
  stopTts,
  synthesize,
  warmupGptSovits,
} from '../src/host/speech/tts.js';

const API = 'http://127.0.0.1:9880';
const REF = '<root>\\voice\\Reference\\warmup.wav';
const PROMPT = '参考音频里说的话';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const WAV = (() => {
  const buffer = Buffer.alloc(48);
  buffer.write('RIFF', 0, 'ascii');
  buffer.write('WAVE', 8, 'ascii');
  return buffer;
})();
const wavBody = () => WAV.buffer.slice(WAV.byteOffset, WAV.byteOffset + WAV.length);
const wavResponse = () => ({
  ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => wavBody(),
});

function settings() {
  return {
    enabled: true,
    apiBase: API,
    refAudioPath: REF,
    promptText: PROMPT,
    promptLang: '',
    textLang: '',
    models: { gptModelPath: '', sovitsModelPath: '' },
  };
}

/** A fake backend: the FIRST /tts in a scenario is cold (slow), every later one is fast. */
function fakeBackend({ coldDelayMs }) {
  let warmed = false;
  const calls = [];
  return {
    calls,
    async fetch(url) {
      calls.push(new URL(url).searchParams.get('text'));
      await sleep(warmed ? 2 : coldDelayMs);
      warmed = true;
      return wavResponse();
    },
  };
}

async function scenario(t, backend, dir) {
  const rows = [];
  configureTts({
    gptSovits: settings,
    probeReference: async () => 8.4,
    onTtsRequest: (payload) => rows.push(payload),
    edgeSynthesize: async () => { throw new Error('Edge fallback is not expected'); },
  });
  return { rows, dir, backend };
}

test('warm-up pays the cold cost so the following first block is faster; its clip is removed', async (t) => {
  const baselineDir = await mkdtemp(join(tmpdir(), 'dsh-tts-warmup-baseline-'));
  const warmDir = await mkdtemp(join(tmpdir(), 'dsh-tts-warmup-effect-'));
  const originalFetch = globalThis.fetch;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    stopTts();
    configureTts({});
    for (const dir of [baselineDir, warmDir]) {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  // (a) Baseline: no warm-up, so the first real request is the cold one.
  const baselineBackend = fakeBackend({ coldDelayMs: 45 });
  globalThis.fetch = (url) => baselineBackend.fetch(url);
  const baseline = await scenario(t, baselineBackend, baselineDir);
  const coldBlock = await synthesize({ text: '最初の文', lang: 'ja', dir: baselineDir });
  assert.equal(coldBlock.provider, 'gpt-sovits');
  assert.equal(baseline.rows.length, 1);
  const coldMs = baseline.rows[0].requestMs;
  assert.ok(coldMs >= 35, `the fake cold request is measured (${coldMs} ms)`);

  // (b) Warm-up first: the one-character request pays the cold cost; the following first block
  // does not. A fresh provider generation starts a fresh warm-up identity.
  const warmBackend = fakeBackend({ coldDelayMs: 45 });
  globalThis.fetch = (url) => warmBackend.fetch(url);
  const warmed = await scenario(t, warmBackend, warmDir);
  const warm = await warmupGptSovits({ dir: warmDir, speech: 'ja' });
  assert.equal(warm.ok, true);
  assert.equal(warmBackend.calls[0], 'あ', 'the warm-up keeps its existing one-character text');
  assert.deepEqual(await readdir(warmDir), [], 'the warm-up clip is deleted');

  const warmBlock = await synthesize({ text: '最初の文', lang: 'ja', dir: warmDir });
  assert.equal(warmBlock.provider, 'gpt-sovits');
  assert.equal(warmed.rows.length, 1, 'the warm-up itself writes no voice.tts.request row');
  const warmMs = warmed.rows[0].requestMs;
  assert.ok(
    warmMs + 10 < coldMs,
    `warm-up helps the following first block: cold=${coldMs} ms, after-warm=${warmMs} ms`,
  );
  assert.deepEqual(warmBackend.calls, ['あ', '最初の文'], 'warm-up and the real sentence are distinct');
  console.log(`warm-up effect (fake): cold first block=${coldMs} ms; after warm-up=${warmMs} ms`);
});
