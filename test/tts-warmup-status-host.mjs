/**
 * GPT-SoVITS warm-up status/event wiring in the mounted host.
 *
 * The TTS module already owns the warm-up state machine; this test only proves the host wiring:
 *   1. `onGptSovitsWarmupEvent` rows reach the event log as `tts.warmup.queued/started/succeeded`
 *      with exactly the public fields (key/generation/status/attempt/errorCode/retryInMs/bytes),
 *      never a path, prompt text or provider body;
 *   2. `/assistant/status` exposes `tts.warmup` with the documented shape once warm-up is ready;
 *   3. a mount with TTS disabled still answers the same shape as `unknown` instead of failing.
 *
 * A fake `fetch` replaces the local GPT-SoVITS /tts response; no model, audio device or network
 * is used.
 *
 * Run: node --test test/tts-warmup-status-host.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupRoot } from './helpers/cleanup.mjs';
import { apply, projectTtsWarmupEvent } from '../src/host/index.js';
import {
  gptSovitsWarmupIdentity,
  stopTts,
  warmupGptSovits,
} from '../src/host/speech/tts.js';

const MODEL = 'D:\\models\\warmup-gpt.ckpt';
const SOVITS = 'D:\\models\\warmup-sovits.pth';
const WARMUP_FIELDS = [
  'attempts', 'finishedAt', 'generation', 'key', 'lastErrorCode',
  'retryInMs', 'retryable', 'startedAt', 'status',
];
const EVENT_FIELDS = [
  'attempt', 'bytes', 'errorCode', 'generation', 'key', 'retryInMs', 'status',
];

const WAV = (() => {
  const buffer = Buffer.alloc(48);
  buffer.write('RIFF', 0, 'ascii');
  buffer.write('WAVE', 8, 'ascii');
  return buffer;
})();
const wavResponse = () => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  arrayBuffer: async () => WAV.buffer.slice(WAV.byteOffset, WAV.byteOffset + WAV.length),
});

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function mount(t, { gptSovits }) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tts-warmup-status-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await mkdir(join(root, 'workspace'), { recursive: true });
  await writeFile(join(root, 'data', 'features.json'), JSON.stringify({
    hearing: false, ambient: false, voice: true, vision: false, subtitle: false,
    avatar: false, memory: false, fastpath: false,
  }));
  await writeFile(join(root, 'data', 'settings.json'), JSON.stringify({
    gptSovits,
    langs: { speech: 'zh', subtitle: 'zh' },
    autoMemory: { enabled: false },
    voice: { chunking: false },
  }));

  const routes = new Map();
  const disposers = [];
  const effect = (fn) => {
    const cleanup = fn();
    if (typeof cleanup === 'function') disposers.push(cleanup);
    return cleanup;
  };
  const services = new Map();
  apply({
    effect,
    get: (name) => services.get(name),
    tools: { register: () => () => {} },
    inject: (_dependencies, register) => register({
      effect,
      systemPrompt: {
        section() { return () => {}; },
        context() { return () => {}; },
      },
      webServer: {
        register(route) {
          routes.set(route.path, route.handler);
          return () => routes.delete(route.path);
        },
      },
    }),
  }, {
    root,
    enabled: true,
    defaultDomain: 'chat',
    privacyScene: 'Privacy',
    // Bare mount: never probe/start an external dependency or capture during this test.
    dependencyBootDelayMs: 600000,
    evidenceCaptureBootDelayMs: 600000,
  });

  t.after(() => cleanupRoot(root, disposers));

  const status = async () => {
    const handler = routes.get('/assistant/status');
    assert.ok(handler !== undefined, '/assistant/status is registered');
    let payload = '';
    await handler(
      { method: 'GET', url: '/assistant/status' },
      { writeHead() {}, end(data) { payload = data ?? ''; } },
    );
    return JSON.parse(payload);
  };
  const events = async () => {
    try {
      const text = await readFile(join(root, 'data', 'events.jsonl'), 'utf8');
      return text.trim().split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  const waitFor = async (check, message, timeoutMs = 5000) => {
    const startedAt = Date.now();
    for (;;) {
      const value = await check();
      if (value) return value;
      if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out: ${message}`);
      await tick(10);
    }
  };
  return { root, status, events, waitFor };
}

test('1. 预热事件写入事件日志，payload 只有公开字段', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => (String(url).includes('/tts?') ? wavResponse() : {
    ok: false,
    status: 404,
    headers: { get: () => null },
    arrayBuffer: async () => new ArrayBuffer(0),
    text: async () => 'not found',
  });
  t.after(() => { stopTts(); globalThis.fetch = originalFetch; });

  const app = await mount(t, {
    gptSovits: {
      enabled: true,
      apiBase: 'http://127.0.0.1:9880',
      models: { gptModelPath: MODEL, sovitsModelPath: SOVITS },
    },
  });

  const result = await warmupGptSovits({ dir: join(app.root, 'cache', 'tts'), speech: 'zh' });
  assert.equal(result.ok, true, `warm-up succeeded: ${result.error ?? ''}`);

  const rows = await app.waitFor(async () => {
    const events = await app.events();
    const warm = events.filter((event) => event.type.startsWith('tts.warmup.'));
    return warm.length >= 3 ? warm : null;
  }, 'tts.warmup events');

  assert.deepEqual(
    [...rows.map((row) => row.type)].sort(),
    ['tts.warmup.queued', 'tts.warmup.started', 'tts.warmup.succeeded'],
    'queued/started/succeeded, one row each',
  );
  const identity = gptSovitsWarmupIdentity({ speech: 'zh' });
  for (const row of rows) {
    assert.deepEqual(Object.keys(row.payload).sort(), EVENT_FIELDS, `${row.type} fields`);
    assert.equal(row.payload.generation, identity.generation);
    assert.equal(row.payload.key, identity.key);
  }
  const byType = new Map(rows.map((row) => [row.type, row]));
  assert.equal(byType.get('tts.warmup.queued').payload.status, 'queued');
  assert.equal(byType.get('tts.warmup.started').payload.status, 'warming');
  assert.equal(byType.get('tts.warmup.succeeded').payload.status, 'ready');
  assert.equal(byType.get('tts.warmup.succeeded').payload.bytes, WAV.length);
  for (const row of rows) {
    const serialized = JSON.stringify(row.payload);
    assert.equal(serialized.includes(app.root), false, 'no mount path');
    assert.equal(serialized.includes('9880'), false, 'no API address');
    assert.equal(serialized.includes(MODEL), false, 'no model path');
    assert.equal(serialized.includes(SOVITS), false, 'no model path');
    assert.equal(serialized.includes('参考'), false, 'no prompt text');
  }

  const status = await app.status();
  const warmup = status.tts?.warmup;
  assert.ok(warmup !== null && typeof warmup === 'object', 'tts.warmup is present');
  assert.deepEqual(Object.keys(warmup).sort(), WARMUP_FIELDS);
  assert.equal(warmup.status, 'ready');
  assert.equal(warmup.key, rows[0].payload.key);
  assert.equal(warmup.generation, rows[0].payload.generation);
  assert.equal(warmup.attempts, 0);
  assert.equal(warmup.retryInMs, null);
  assert.equal(warmup.lastErrorCode, null);
  assert.equal(warmup.retryable, false);
  assert.ok(Number.isFinite(warmup.startedAt) && warmup.startedAt > 0);
  assert.ok(Number.isFinite(warmup.finishedAt) && warmup.finishedAt >= warmup.startedAt);

  console.log(`1. events=${rows.map((row) => row.type).join(',')} status=${warmup.status}`);
});

test('2. 未配置 TTS：tts.warmup 仍返回 unknown 形状，status 不报错', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 404,
    headers: { get: () => null },
    arrayBuffer: async () => new ArrayBuffer(0),
    text: async () => 'not found',
  });
  t.after(() => { globalThis.fetch = originalFetch; });
  const app = await mount(t, {
    gptSovits: { enabled: false, apiBase: '', models: { gptModelPath: '', sovitsModelPath: '' } },
  });
  const status = await app.status();
  assert.equal(status.ok, true);
  const warmup = status.tts?.warmup;
  assert.ok(warmup !== null && typeof warmup === 'object', 'tts.warmup is present without TTS');
  assert.deepEqual(Object.keys(warmup).sort(), WARMUP_FIELDS);
  assert.equal(warmup.status, 'unknown');
  assert.equal(warmup.key, null);
  assert.equal(warmup.attempts, 0);
  assert.equal(warmup.retryInMs, null);
  assert.equal(warmup.lastErrorCode, null);
  assert.equal(warmup.retryable, false);
  assert.equal(warmup.startedAt, null);
  assert.equal(warmup.finishedAt, null);

  console.log(`2. unconfigured status=${warmup.status} key=${warmup.key}`);
});

test('3. failed/stale 投影：保留状态数字，丢弃 reason/错误正文/路径', () => {
  const failed = projectTtsWarmupEvent({
    event: 'tts.warmup.failed',
    key: 'k-failed',
    generation: 7,
    status: 'failed',
    attempt: 2,
    errorCode: 'TTS_FAILED',
    retryInMs: 15000,
    bytes: null,
    reason: 'provider',
    error: `boom at ${MODEL}`,
    at: Date.now(),
  });
  assert.ok(failed !== null);
  assert.equal(failed.event, 'tts.warmup.failed');
  assert.deepEqual(failed.payload, {
    key: 'k-failed',
    generation: 7,
    status: 'failed',
    attempt: 2,
    errorCode: 'TTS_FAILED',
    retryInMs: 15000,
    bytes: null,
  });
  assert.equal(JSON.stringify(failed.payload).includes('boom'), false, 'no provider error body');
  assert.equal(JSON.stringify(failed.payload).includes(MODEL), false, 'no model path');

  const stale = projectTtsWarmupEvent({
    event: 'tts.warmup.stale',
    key: 'k-stale',
    generation: 8,
    status: 'unknown',
    reason: 'preempted',
    attempt: 0,
  });
  assert.deepEqual(Object.keys(stale.payload).sort(), EVENT_FIELDS);
  assert.equal(stale.payload.status, 'unknown');
  assert.equal(stale.payload.attempt, 0);
  assert.equal(stale.payload.retryInMs, null);

  // A non-warm-up hook row is not written under a fabricated type.
  assert.equal(projectTtsWarmupEvent({ event: 'tts.warmup.unknown', key: 'k' }), null);
  assert.equal(projectTtsWarmupEvent({ type: 'tts.gptsovits.warmup.failed', key: 'k' }), null);

  console.log('3. failed/stale projections keep status numbers only');
});
