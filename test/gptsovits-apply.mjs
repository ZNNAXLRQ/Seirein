/**
 * GPT-SoVITS 「应用模型」 regression: saving a weight path only marks it dirty; the card button
 * is the one explicit trigger that calls /set_gpt_weights then /set_sovits_weights and warms the
 * new model with one tiny /tts request. Every request gets its own 30 s cap and is reported with
 * status/body/elapsed, and a warm-up failure must never turn a successful load into a failure.
 *
 * Run: node --test test/gptsovits-apply.mjs
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { apply } from '../src/host/index.js';
import { applyGptSovitsModels, configureTts } from '../src/host/speech/tts.js';
import { cleanupRoot } from './helpers/cleanup.mjs';

const API = 'http://127.0.0.1:9880';
const GPT_PATH = 'D:\\GPT-SoVITS\\GPT_weights\\myvoice.ckpt';
const SOVITS_PATH = 'D:\\GPT-SoVITS\\SoVITS_weights\\myvoice.pth';
/** One valid RIFF header, so a warm-up answer is accepted as audio. */
const WAV = (() => {
  const buffer = Buffer.alloc(48);
  buffer.write('RIFF', 0, 'ascii');
  buffer.write('WAVE', 8, 'ascii');
  return buffer;
})();
const wavBody = async () => WAV.buffer.slice(WAV.byteOffset, WAV.byteOffset + WAV.length);

function settings(patch = {}) {
  return {
    enabled: true,
    apiBase: API,
    refAudioPath: '',
    promptText: '',
    models: { gptModelPath: GPT_PATH, sovitsModelPath: SOVITS_PATH },
    ...patch,
  };
}

/** Wire the provider the same way the host does; a warm-up failure hook is not needed here. */
function harness(state = settings()) {
  configureTts({ gptSovits: () => state });
  return state;
}

/** A JSON ack shaped like a real fetch Response, without a network stack. */
function jsonResponse(status, body = '{"message":"success"}') {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  };
}

function wavResponse() {
  return { ok: true, status: 200, text: async () => '', arrayBuffer: wavBody };
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

test('both weight switches succeed: ok, per-request timings, then one warm-up', async (t) => {
  harness();
  const calls = stubFetch(t, async (url) => {
    const path = new URL(url).pathname;
    if (path === '/set_gpt_weights') return jsonResponse(200, '{"message":"gpt loaded"}');
    if (path === '/set_sovits_weights') {
      // Slow enough that elapsedMs proves it is measured, not a constant.
      await new Promise((resolve) => setTimeout(resolve, 20));
      return jsonResponse(200, '{"message":"sovits loaded"}');
    }
    if (path === '/tts') return wavResponse();
    throw new Error(`unexpected ${url}`);
  });

  const result = await applyGptSovitsModels();

  assert.equal(result.ok, true);
  assert.equal(result.stage, '');
  assert.equal(result.gpt.ok, true);
  assert.equal(result.gpt.status, 200);
  assert.equal(result.gpt.body, '{"message":"gpt loaded"}');
  assert.equal(result.gpt.path, GPT_PATH);
  assert.equal(result.gpt.elapsedMs >= 0, true);
  assert.equal(result.sovits.path, SOVITS_PATH);
  assert.equal(result.sovits.elapsedMs >= 10, true, 'the slow request reports its real elapsed time');
  assert.equal(result.warmupError, '');
  assert.equal(Number.isFinite(result.warmupMs), true);

  assert.equal(calls.length, 3, 'two weight switches + one warm-up /tts');
  assert.match(calls[0], /\/set_gpt_weights\?weights_path=/u);
  assert.equal(new URL(calls[0]).searchParams.get('weights_path'), GPT_PATH);
  assert.match(calls[1], /\/set_sovits_weights\?weights_path=/u);
  assert.equal(new URL(calls[1]).searchParams.get('weights_path'), SOVITS_PATH);
  const warmup = new URL(calls[2]);
  assert.equal(warmup.pathname, '/tts');
  assert.equal(warmup.searchParams.get('text'), 'あ', 'the warm-up text is the shortest useful one');
  assert.equal(warmup.searchParams.get('media_type'), 'wav');
});

test('GPT switch answers 500: ok false, stage gpt, no warm-up', async (t) => {
  harness();
  const calls = stubFetch(t, (url) => {
    const path = new URL(url).pathname;
    if (path === '/set_gpt_weights') return jsonResponse(500, 'gpt weights missing');
    return jsonResponse(200);
  });

  const result = await applyGptSovitsModels();

  assert.equal(result.ok, false);
  assert.equal(result.stage, 'gpt');
  assert.equal(result.gpt.ok, false);
  assert.equal(result.gpt.status, 500);
  assert.equal(result.gpt.body, 'gpt weights missing');
  assert.match(result.error, /HTTP 500/u);
  assert.equal(result.warmupMs, null);
  assert.equal(result.warmupError, '');
  assert.equal(calls.some((url) => new URL(url).pathname === '/tts'), false, 'no warm-up after a failed load');
});

test('SoVITS switch fails after GPT succeeds: ok false, stage sovits', async (t) => {
  harness();
  const calls = stubFetch(t, (url) => {
    const path = new URL(url).pathname;
    if (path === '/set_gpt_weights') return jsonResponse(200);
    if (path === '/set_sovits_weights') return jsonResponse(400, 'sovits weights missing');
    return wavResponse();
  });

  const result = await applyGptSovitsModels();

  assert.equal(result.ok, false);
  assert.equal(result.stage, 'sovits');
  assert.equal(result.gpt.ok, true);
  assert.equal(result.sovits.ok, false);
  assert.equal(result.sovits.status, 400);
  assert.match(result.error, /HTTP 400/u);
  assert.equal(calls.some((url) => new URL(url).pathname === '/tts'), false);
});

test('a warm-up timeout keeps ok true and records warmupError', async (t) => {
  // Fake time: the 30 s cap fires immediately instead of making the suite wait.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  harness();
  const calls = stubFetch(t, (url, options) => {
    if (new URL(url).pathname === '/tts') {
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          'abort',
          () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          { once: true },
        );
      });
    }
    return jsonResponse(200);
  });

  const pending = applyGptSovitsModels();
  for (let i = 0; i < 20 && calls.length < 3; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(calls.length, 3, 'the warm-up request was issued before the abort');
  t.mock.timers.tick(30_000);
  const result = await pending;

  assert.equal(result.ok, true, 'a failed warm-up does not fail the load');
  assert.match(result.warmupError, /超时/u);
  assert.equal(Number.isFinite(result.warmupMs), true);
});

/** Mount the real host against a temp root; returns a status/action caller. */
async function mountHost(t, saved) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-gptsovits-apply-host-'));
  // Every effect's disposer is kept and run before rm, so a store cannot keep the root locked.
  const disposers = [];
  t.after(() => cleanupRoot(root, disposers));
  await mkdir(join(root, 'data'), { recursive: true });
  await writeFile(join(root, 'data', 'settings.json'), JSON.stringify(saved, null, 2), 'utf8');

  const routes = new Map();
  const effect = (fn) => {
    const dispose = fn();
    if (typeof dispose === 'function') disposers.push(dispose);
    return dispose;
  };
  const ctx = {
    effect,
    tools: { register: () => () => {} },
    get: () => undefined,
    inject: (deps, register) => {
      if (!deps.includes('webServer')) return;
      register({
        effect,
        webServer: {
          register(route) {
            routes.set(route.path, route.handler);
            return () => routes.delete(route.path);
          },
        },
      });
    },
  };
  apply(ctx, { root, enabled: true });

  const request = (path, payload) => new Promise((resolveStatus, rejectStatus) => {
    const res = {
      writeHead() {},
      end(body) {
        try {
          resolveStatus(JSON.parse(body));
        } catch (error) {
          rejectStatus(error);
        }
      },
    };
    const req = payload === undefined
      ? {}
      : {
        method: 'POST',
        setEncoding() {},
        on(event, fn) {
          if (event === 'data') fn(JSON.stringify(payload));
          if (event === 'end') fn();
          return req;
        },
      };
    Promise.resolve(routes.get(path)(req, res)).catch(rejectStatus);
  });

  return {
    status: () => request('/assistant/status'),
    act: (payload) => request('/assistant/action', payload),
  };
}

test('a saved path is dirty until the button runs, then clean; the save itself loads nothing', async (t) => {
  const host = await mountHost(t, {
    gptSovits: {
      enabled: false,
      apiBase: API,
      refAudioPath: '',
      promptText: '',
      models: { gptModelPath: '', sovitsModelPath: '' },
    },
  });

  // Saving both paths only persists them. If the host tried to load, this fetch would throw.
  let sawRequest = false;
  const calls = stubFetch(t, (url) => {
    sawRequest = true;
    const path = new URL(url).pathname;
    if (path === '/tts') return wavResponse();
    return jsonResponse(200);
  });

  const saved = await host.act({
    action: 'tts.config',
    models: { gptModelPath: GPT_PATH, sovitsModelPath: SOVITS_PATH },
  });
  assert.equal(saved.ok, true);
  assert.equal(sawRequest, false, 'saving a path never calls the server');
  const dirty = (await host.status()).tts.gptSovits;
  assert.equal(dirty.modelsDirty, true, 'a changed path is still unapplied');
  assert.equal(dirty.modelsApplied.gptOk, false);
  assert.equal(dirty.modelsAppliedAt, 0);

  const applied = await host.act({ action: 'gptSovits.applyModels' });
  assert.equal(applied.ok, true);
  assert.equal(applied.gpt.path, GPT_PATH);
  assert.equal(applied.sovits.path, SOVITS_PATH);
  assert.equal(applied.modelsDirty, false);

  const clean = (await host.status()).tts.gptSovits;
  assert.equal(clean.modelsDirty, false, 'the explicit apply clears the dirty flag');
  assert.equal(clean.modelsApplied.gptOk, true);
  assert.equal(clean.modelsApplied.sovitsOk, true);
  assert.equal(clean.modelsAppliedAt > 0, true);
  assert.equal(Number.isFinite(clean.modelsApplied.warmupMs), true);
  assert.equal(calls.filter((url) => new URL(url).pathname === '/tts').length, 1, 'one warm-up only');
});
