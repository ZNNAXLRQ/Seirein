/**
 * GPT-SoVITS warm-up identity, priority and retry semantics.
 *
 * The warm-up is keyed by backend address + model configuration + reference-audio version +
 * reference text + resolved language configuration. The same identity shares one in-flight task
 * and a successful identity is not warmed twice; a changed identity warms again and an old
 * completion cannot mark the new identity ready. Warm-up runs at a negative synthesis-slot
 * priority: a real request cancels it while it is still waiting, never after it has started.
 * Failures are visible, never block a real request, and retry only a bounded number of times.
 *
 * Run: node --test test/tts-warmup-identity.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  configureTts,
  gptSovitsWarmupIdentity,
  gptSovitsWarmupStatus,
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

function settings(patch = {}) {
  return {
    enabled: true,
    apiBase: API,
    refAudioPath: REF,
    promptText: PROMPT,
    promptLang: '',
    textLang: '',
    models: { gptModelPath: '', sovitsModelPath: '' },
    ...patch,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function until(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail('controlled boundary did not arrive');
    await sleep(2);
  }
}

/**
 * A fresh provider generation. `respond` receives the decoded /tts query so a test can gate or
 * fail only the warm-up (`text === 'あ'`) while real speech keeps working.
 */
async function fixture(t, { dir, respond, retryDelays = [10, 20] } = {}) {
  const workdir = dir ?? await mkdtemp(join(tmpdir(), 'dsh-tts-warmup-'));
  const provider = { settings: settings() };
  const events = [];
  const failures = [];
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    calls.push({ text: parsed.searchParams.get('text'), params: parsed.searchParams });
    return respond({ url: parsed, text: parsed.searchParams.get('text'), calls });
  };
  configureTts({
    gptSovits: () => provider.settings,
    probeReference: async () => 8.4,
    warmupRetryDelays: retryDelays,
    onGptSovitsWarmupEvent: (payload) => events.push(payload),
    onGptSovitsWarmupFailed: (payload) => failures.push(payload),
    edgeSynthesize: async () => ({
      file: join(workdir, 'edge.mp3'), bytes: 1, durationMs: 1, provider: 'edge-tts',
    }),
  });
  t.after(async () => {
    globalThis.fetch = originalFetch;
    stopTts();
    configureTts({});
    await rm(workdir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  return { dir: workdir, provider, events, failures, calls };
}

test('1. the identity is a digest of every warm-up input', () => {
  const base = settings();
  const key = (patch) => gptSovitsWarmupIdentity({ settings: { ...base, ...patch } }).key;
  const baseline = key({});
  assert.equal(key({}), baseline, 'the same inputs produce the same key');
  const variants = [
    ['apiBase', { apiBase: 'http://127.0.0.1:9881' }],
    ['models', { models: { gptModelPath: 'g2', sovitsModelPath: 's2' } }],
    ['reference path', { refAudioPath: `${REF}.other` }],
    ['reference text', { promptText: '另一段参考文本' }],
    ['prompt language', { promptLang: 'en' }],
    ['text language', { textLang: 'en' }],
  ];
  for (const [label, patch] of variants) {
    assert.notEqual(key(patch), baseline, `${label} must change the identity`);
  }
  const identity = gptSovitsWarmupIdentity({ settings: base, speech: 'ja' });
  assert.equal(identity.key, baseline);
  assert.equal(identity.textLang, 'ja');
  assert.equal(identity.promptLang, 'ja');
  const serialized = JSON.stringify(identity);
  assert.ok(!serialized.includes(REF), 'the exported identity never carries the reference path');
  assert.ok(!serialized.includes(PROMPT), 'the exported identity never carries the reference text');
  console.log(`1. key=${baseline.slice(0, 12)}… variants=${variants.length}`);
});

test('2. the same identity warms once and shares the in-flight request', async (t) => {
  const app = await fixture(t, { respond: async () => wavResponse() });
  const dir = app.dir;
  const first = warmupGptSovits({ dir, speech: 'ja' });
  const second = warmupGptSovits({ dir, speech: 'ja' });
  assert.equal(second, first, 'a queued/warming identity shares the exact promise');
  const results = await Promise.all([first, second]);
  assert.equal(results[0].ok, true);
  assert.equal(results[1], results[0], 'both callers observe the same resolution');
  assert.equal(app.calls.length, 1, 'one /tts request for the identity');
  assert.equal(app.calls[0].text, 'あ', 'the existing one-character warm-up text is preserved');
  assert.equal(gptSovitsWarmupStatus().status, 'ready');

  const again = await warmupGptSovits({ dir, speech: 'ja' });
  assert.equal(again.skipped, 'already-warm');
  assert.equal(app.calls.length, 1, 'a ready identity is never warmed again');
  assert.deepEqual(
    app.events.map((event) => event.event),
    ['tts.warmup.queued', 'tts.warmup.started', 'tts.warmup.succeeded'],
  );
  assert.ok(!JSON.stringify(app.events).includes(REF), 'events never carry the reference path');
  assert.ok(!JSON.stringify(app.events).includes(PROMPT), 'events never carry the reference text');
  console.log(`2. calls=${app.calls.length} status=${gptSovitsWarmupStatus().status}`);
});

test('3. a changed model warms a new identity; the old completion stays stale', async (t) => {
  const gate = deferred();
  const app = await fixture(t, {
    respond: async ({ text, calls }) => {
      if (text === 'あ' && calls.length === 1) await gate.promise;
      return wavResponse();
    },
  });
  const oldKey = gptSovitsWarmupIdentity({ settings: app.provider.settings }).key;
  const oldRun = warmupGptSovits({ dir: app.dir, speech: 'ja' });
  await until(() => app.calls.length === 1, 1000);

  // A model switch while the old warm-up is still in the slot: the new identity queues and the
  // old completion can only produce a stale result, never `ready` for the new key.
  app.provider.settings = settings({
    models: { gptModelPath: 'G2', sovitsModelPath: 'S2' },
  });
  const newKey = gptSovitsWarmupIdentity({ settings: app.provider.settings }).key;
  assert.notEqual(newKey, oldKey);
  const newRun = warmupGptSovits({ dir: app.dir, speech: 'ja' });
  assert.equal(gptSovitsWarmupStatus().key, newKey);
  assert.equal(gptSovitsWarmupStatus().status, 'queued');

  gate.resolve();
  const oldResult = await oldRun;
  assert.equal(oldResult.ok, false);
  assert.equal(oldResult.skipped, 'stale', 'the superseded run never claims success');

  const newResult = await newRun;
  assert.equal(newResult.ok, true);
  const status = gptSovitsWarmupStatus();
  assert.equal(status.key, newKey);
  assert.equal(status.status, 'ready', 'only the new identity is ready');
  assert.equal(app.calls.length, 2);
  assert.ok(
    app.events.some((event) => event.event === 'tts.warmup.stale' && event.key === oldKey),
    'the old identity emits a stale event',
  );
  assert.ok(
    app.events.some((event) => event.event === 'tts.warmup.succeeded' && event.key === newKey),
    'the new identity emits its own success',
  );
  console.log(`3. old=${oldKey.slice(0, 12)}… stale; new=${newKey.slice(0, 12)}… ready`);
});

test('4. a real request cancels a not-yet-started warm-up and runs first', async (t) => {
  const blockerGate = deferred();
  let blockerStarted = false;
  const app = await fixture(t, {
    respond: async ({ text }) => {
      if (text === 'blocker') { blockerStarted = true; await blockerGate.promise; }
      return wavResponse();
    },
  });
  const blocker = synthesize({ text: 'blocker', lang: 'ja', dir: app.dir });
  await until(() => blockerStarted, 1000);

  const warm = warmupGptSovits({ dir: app.dir, speech: 'ja' });
  await sleep(10);
  assert.equal(gptSovitsWarmupStatus().status, 'queued');
  assert.equal(app.calls.some((call) => call.text === 'あ'), false, 'warm-up has not started');

  const real = synthesize({ text: 'real', lang: 'ja', dir: app.dir });
  const warmResult = await warm;
  assert.equal(warmResult.ok, false);
  assert.equal(warmResult.skipped, 'preempted');
  assert.equal(gptSovitsWarmupStatus().status, 'unknown');

  blockerGate.resolve();
  await Promise.all([blocker, real]);
  assert.deepEqual(app.calls.map((call) => call.text), ['blocker', 'real']);
  assert.ok(
    app.events.some((event) => event.event === 'tts.warmup.stale' && event.reason === 'preempted'),
    'a preempted warm-up is visible as stale',
  );
  console.log(`4. calls=${app.calls.map((call) => call.text).join(',')} warm=${warmResult.skipped}`);
});

test('5. failure stays visible, does not block a real request, and retries are bounded', async (t) => {
  const app = await fixture(t, {
    respond: async ({ text }) => {
      if (text === 'あ') throw new Error('warmup boom');
      return wavResponse();
    },
  });
  const result = await warmupGptSovits({ dir: app.dir, speech: 'ja' });
  assert.equal(result.ok, false);

  await until(() => {
    const status = gptSovitsWarmupStatus();
    return status.status === 'failed' && status.attempts === 3 && status.retryInMs === null;
  }, 3000);
  const failed = gptSovitsWarmupStatus();
  assert.equal(failed.status, 'failed');
  assert.equal(failed.attempts, 3, '1 attempt + 2 bounded retries');
  assert.equal(failed.retryable, true);
  assert.equal(failed.lastErrorCode, 'TTS_FAILED');
  assert.equal(app.failures.length, 3, 'the legacy failure hook sees every attempt');
  assert.equal(app.events.filter((event) => event.event === 'tts.warmup.failed').length, 3);
  assert.equal(app.calls.filter((call) => call.text === 'あ').length, 3);

  await sleep(80);
  assert.equal(gptSovitsWarmupStatus().attempts, 3, 'no retry after the bounded budget');

  const real = await synthesize({ text: 'real', lang: 'ja', dir: app.dir });
  assert.equal(real.provider, 'gpt-sovits', 'a failed warm-up never blocks real speech');
  assert.equal(gptSovitsWarmupStatus().status, 'failed', 'the failed status stays visible');
  assert.ok(!JSON.stringify(app.events).includes('warmup boom'), 'the status stream drops the error body');
  assert.ok(!JSON.stringify(app.events).includes(REF), 'the status stream drops paths');
  console.log(`5. attempts=${failed.attempts} code=${failed.lastErrorCode} real=${real.provider}`);
});

test('6. a successful warm-up deletes its temporary clip and never plays it', async (t) => {
  const app = await fixture(t, { respond: async () => wavResponse() });

  const result = await warmupGptSovits({ dir: app.dir, speech: 'ja' });
  assert.equal(result.ok, true);
  assert.equal(gptSovitsWarmupStatus().status, 'ready');
  assert.deepEqual(await readdir(app.dir), [], 'the one-character clip is removed');
  // Warm-up resolves through the synthesis path only; it carries no player/transport result.
  assert.equal('via' in result, false);
  assert.equal('firstChunkMs' in result, false);
  console.log(`6. status=${gptSovitsWarmupStatus().status} files=${(await readdir(app.dir)).length}`);
});
