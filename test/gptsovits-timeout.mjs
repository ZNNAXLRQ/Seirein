/**
 * GPT-SoVITS timeout regression.
 *
 * A cold API server loads the weights on the first /tts call; the old 8 s limit made every first
 * utterance fall back to Edge. The default is now 30 s (settings `gptSovits.timeoutMs`, clamped to
 * 5–120 s), a timeout reports the measured wait plus the cold-start hint, the event log stays
 * valid UTF-8 (the earlier mojibake was a GBK reader, not the writer), and the optional warm-up
 * request only ever produces `tts.gptsovits.warmup.failed` on failure.
 *
 * Run: node --test test/gptsovits-timeout.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { EventLog } from '../src/host/memory/store.js';
import {
  DEFAULT_GPT_SOVITS_TIMEOUT_MS,
  GPT_SOVITS_TIMEOUT_MAX_MS,
  GPT_SOVITS_TIMEOUT_MIN_MS,
  configureTts,
  resolveGptSovitsTimeout,
  synthesize,
  warmupGptSovits,
} from '../src/host/speech/tts.js';

const API = 'http://127.0.0.1:9880';
const REF = '<root>\\voice\\Reference\\Hina_ExWeapon_Get.wav';
const WAV = (() => {
  const buffer = Buffer.alloc(48);
  buffer.write('RIFF', 0, 'ascii');
  buffer.write('WAVE', 8, 'ascii');
  return buffer;
})();
const wavBody = async () => WAV.buffer.slice(WAV.byteOffset, WAV.byteOffset + WAV.length);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function settings(patch = {}) {
  return {
    enabled: true,
    apiBase: API,
    refAudioPath: REF,
    promptText: '参考音频里说的话',
    promptLang: '',
    textLang: '',
    models: { gptModelPath: '', sovitsModelPath: '' },
    ...patch,
  };
}

/** Provider plus recording hooks; every harness gets a fresh warm-up generation. */
function harness(state = settings()) {
  const seen = { edge: [], failed: [], warmupFailed: [] };
  configureTts({
    gptSovits: () => state,
    probeReference: async () => 8.4,
    onGptSovitsFailed: (payload) => seen.failed.push(payload),
    onGptSovitsWarmupFailed: (payload) => seen.warmupFailed.push(payload),
    edgeSynthesize: async (options) => {
      seen.edge.push(options);
      return { file: 'edge.mp3', bytes: 1, durationMs: 1, provider: 'edge-tts' };
    },
  });
  return seen;
}

function stubFetch(t, handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push(String(url));
    return handler(url, options);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

/** A fetch that never answers on its own; the AbortController is expected to end it. */
function hangingFetch(_url, { signal } = {}) {
  return new Promise((_resolve, reject) => {
    const abort = () => {
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      reject(error);
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

test('default timeout is 30 s and stays inside 5–120 s', () => {
  assert.equal(DEFAULT_GPT_SOVITS_TIMEOUT_MS, 30_000);
  assert.ok(resolveGptSovitsTimeout({}) >= 30_000);
  assert.equal(resolveGptSovitsTimeout({}), 30_000);
  assert.equal(resolveGptSovitsTimeout({ timeoutMs: 30_000 }), 30_000);
  assert.equal(resolveGptSovitsTimeout({ timeoutMs: '45000' }), 45_000);
  assert.equal(resolveGptSovitsTimeout({ timeoutMs: 1000 }), GPT_SOVITS_TIMEOUT_MIN_MS);
  assert.equal(resolveGptSovitsTimeout({ timeoutMs: 999_999 }), GPT_SOVITS_TIMEOUT_MAX_MS);
  assert.equal(resolveGptSovitsTimeout({ timeoutMs: Number.NaN }), DEFAULT_GPT_SOVITS_TIMEOUT_MS);
  assert.equal(resolveGptSovitsTimeout(null), DEFAULT_GPT_SOVITS_TIMEOUT_MS);
});

test('a fake fetch answering after 12 s still succeeds under the 30 s default', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-gptsovits-slow-'));
  t.after(() => rm(dir, { recursive: true, force: true }).catch(() => {}));
  const seen = harness(settings());
  stubFetch(t, async () => {
    await sleep(12_000);
    return { ok: true, status: 200, arrayBuffer: wavBody };
  });

  const startedAt = Date.now();
  const result = await synthesize({ text: 'こんにちは', lang: 'ja', dir });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.provider, 'gpt-sovits', 'a 12 s cold start must not fall back to Edge');
  assert.ok(elapsedMs >= 12_000);
  assert.deepEqual(seen.failed, [], 'no timeout event for a 12 s answer');
  assert.equal(seen.edge.length, 0);
  console.log(`12 s delayed GPT-SoVITS fetch: provider=${result.provider} elapsed=${elapsedMs} ms bytes=${result.bytes}`);
});

test('over the configured timeout: event carries the measured wait, valid UTF-8, Edge fallback', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-gptsovits-timeout-'));
  const root = await mkdtemp(join(tmpdir(), 'dsh-gptsovits-timeout-log-'));
  t.after(() => {
    rm(dir, { recursive: true, force: true }).catch(() => {});
    rm(root, { recursive: true, force: true }).catch(() => {});
  });

  const log = new EventLog(root);
  const seen = { failed: [], edge: [], warmupFailed: [] };
  configureTts({
    gptSovits: () => settings({ timeoutMs: 5000 }),
    probeReference: async () => 8.4,
    onGptSovitsFailed: async (payload) => {
      seen.failed.push(payload);
      // Exercise the real JSONL writer, not only the in-memory string.
      await log.emit('tts.gptsovits.failed', payload);
    },
    onGptSovitsWarmupFailed: (payload) => seen.warmupFailed.push(payload),
    edgeSynthesize: async (options) => {
      seen.edge.push(options);
      return { file: 'edge.mp3', bytes: 1, durationMs: 1, provider: 'edge-tts' };
    },
  });
  stubFetch(t, hangingFetch);

  const startedAt = Date.now();
  const result = await synthesize({ text: 'テスト', lang: 'ja', dir });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.provider, 'edge-tts', 'the Edge fallback is preserved');
  assert.equal(seen.edge[0].voice, 'ja-JP-NanamiNeural');
  assert.equal(seen.failed.length, 1);
  const payload = seen.failed[0];
  assert.equal(payload.timeoutMs, 5000);
  assert.ok(Number.isInteger(payload.elapsedMs), 'the payload carries the measured wait');
  assert.ok(payload.elapsedMs >= 4500 && payload.elapsedMs <= 15_000, `elapsed ${payload.elapsedMs} ms fits the 5 s limit`);
  assert.match(payload.error, /^GPT-SoVITS 超时/u);
  assert.ok(payload.error.includes(`实际耗时 ${payload.elapsedMs} ms`), 'the message names the actual elapsed time');
  assert.ok(payload.error.includes('首次调用可能较慢'), 'the message explains the cold start');
  assert.ok(payload.error.includes('gptSovits.timeoutMs'), 'the message names the setting to raise');
  assert.ok(!payload.error.includes('\uFFFD'), 'no replacement characters');
  assert.ok(!payload.error.includes('瓒呮椂'), 'no GBK-decoded mojibake');
  assert.ok(elapsedMs >= 4500);

  // The on-disk event must be valid UTF-8 and keep the Chinese text readable.
  const raw = await readFile(join(root, 'data', 'events.jsonl'));
  const text = raw.toString('utf8');
  assert.ok(Buffer.from(text, 'utf8').equals(raw), 'events.jsonl is valid UTF-8');
  assert.ok(!text.includes('\uFFFD'));
  const event = JSON.parse(text.trim().split('\n').pop());
  assert.equal(event.type, 'tts.gptsovits.failed');
  assert.equal(event.payload.error, payload.error);
  assert.ok(event.payload.error.includes('超时'));
  console.log(`timeout event error: ${event.payload.error}`);
});

test('a failed warm-up only records an event; the next synthesis still uses GPT-SoVITS', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-gptsovits-warmup-fail-'));
  t.after(() => rm(dir, { recursive: true, force: true }).catch(() => {}));
  const seen = harness(settings());
  let call = 0;
  const calls = stubFetch(t, () => {
    call += 1;
    if (call === 1) throw new Error('warmup boom');
    return { ok: true, status: 200, arrayBuffer: wavBody };
  });

  const warm = await warmupGptSovits({ dir, speech: 'ja' });
  assert.equal(warm.ok, false);
  assert.equal(seen.warmupFailed.length, 1, 'the warm-up failure is reported to its own hook');
  assert.match(seen.warmupFailed[0].error, /warmup boom/u);
  assert.deepEqual(seen.failed, [], 'a warm-up failure is not a synthesis failure');

  const result = await synthesize({ text: 'テスト', lang: 'ja', dir });
  assert.equal(result.provider, 'gpt-sovits', 'normal synthesis is unaffected by the failed warm-up');
  assert.equal(seen.failed.length, 0);
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[0]).searchParams.get('text'), 'あ', 'the warm-up sends one short char');
});

test('a successful warm-up sends one short request and is not repeated', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-gptsovits-warmup-ok-'));
  t.after(() => rm(dir, { recursive: true, force: true }).catch(() => {}));
  harness(settings());
  const calls = stubFetch(t, () => ({ ok: true, status: 200, arrayBuffer: wavBody }));

  const first = await warmupGptSovits({ dir, speech: 'ja' });
  assert.equal(first.ok, true);
  assert.equal(new URL(calls[0]).searchParams.get('text'), 'あ');

  const second = await warmupGptSovits({ dir, speech: 'ja' });
  assert.equal(second.skipped, 'already-warm');
  assert.equal(calls.length, 1, 'a warm model is not loaded again');
});
