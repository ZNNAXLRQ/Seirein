/**
 * GPT-SoVITS reference guard: the stock server answers HTTP 400 for a reference clip outside
 * 3–10 s, for an empty prompt text, and for a language the text does not match. The host now
 * measures the clip first (never sending the doomed request), lets `text_lang`/`prompt_lang`
 * follow `langs.speech` unless the user pinned them, and decodes the error body as UTF-8 so a
 * Chinese message is readable in the event log instead of mojibake.
 *
 * Run: node --test test/gptsovits-reference.mjs
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

import { apply } from '../src/host/index.js';
import { configureTts, gptSovitsReferenceStatus, synthesize } from '../src/host/speech/tts.js';
import { cleanupRoot } from './helpers/cleanup.mjs';

const API = 'http://127.0.0.1:9880';
const REF = '<root>\\voice\\Reference\\Hina_ExWeapon_Get.wav';
/** Per-run output dir: the successful requests below write real WAVs into it. */
const DIR = await mkdtemp(join(tmpdir(), 'dsh-gptsovits-reference-dir-'));
after(() => cleanupRoot(DIR));
/** One valid RIFF header, so a 200 answer is accepted as audio. */
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
    refAudioPath: REF,
    promptText: '参考音频里说的话',
    promptLang: '', // '' = follow langs.speech
    textLang: '',
    models: { gptModelPath: '', sovitsModelPath: '' },
    ...patch,
  };
}

/** Configure the GPT provider, an injected clip length, and recording hooks. */
function harness(seconds, state = settings()) {
  const seen = { edge: [], skipped: [], failed: [], warned: [] };
  configureTts({
    gptSovits: () => state,
    onGptSovitsSkipped: (payload) => seen.skipped.push(payload),
    onGptSovitsFailed: (payload) => seen.failed.push(payload),
    onGptSovitsWarning: (payload) => seen.warned.push(payload),
    probeReference: async () => seconds,
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

test('a 60 s reference is never sent: skipped reference-duration, Edge fallback', async (t) => {
  const seen = harness(60, settings({ promptText: '' }));
  const calls = stubFetch(t, () => {
    throw new Error('no /tts request may be sent for an out-of-range reference');
  });

  const result = await synthesize({ text: 'こんにちは', lang: 'ja', dir: DIR });

  assert.equal(calls.length, 0, 'the doomed request is not sent');
  assert.deepEqual(seen.skipped, [{ reason: 'reference-duration', seconds: 60 }]);
  assert.deepEqual(seen.failed, [], 'a skip is not a failure');
  assert.equal(result.provider, 'edge-tts');
  assert.equal(seen.edge[0].voice, 'ja-JP-NanamiNeural', 'the fallback keeps the speech language');
});

test('an 8 s reference with an empty promptText is skipped: the stock API would 400', async (t) => {
  const seen = harness(8, settings({ promptText: '   ' }));
  const calls = stubFetch(t, () => {
    throw new Error('no /tts request may be sent without a prompt text');
  });

  const result = await synthesize({ text: 'テスト', lang: 'ja', dir: DIR });

  assert.equal(calls.length, 0);
  assert.deepEqual(seen.skipped, [{ reason: 'no-prompt-text' }]);
  assert.deepEqual(seen.failed, []);
  assert.equal(result.provider, 'edge-tts');
});

test('8 s + promptText: text_lang=ja, prompt_lang=ja follow langs.speech', async (t) => {
  const seen = harness(8.4);
  const calls = stubFetch(t, () => ({ ok: true, status: 200, arrayBuffer: wavBody }));

  const result = await synthesize({ text: 'こんにちは', lang: 'ja', dir: DIR });

  assert.equal(calls.length, 1);
  const url = new URL(calls[0]);
  assert.equal(url.pathname, '/tts');
  assert.equal(url.searchParams.get('text_lang'), 'ja', 'text_lang follows langs.speech');
  assert.equal(url.searchParams.get('prompt_lang'), 'ja', 'prompt_lang follows langs.speech');
  assert.equal(url.searchParams.get('prompt_text'), '参考音频里说的话');
  assert.equal(url.searchParams.get('ref_audio_path'), REF);
  assert.equal(result.provider, 'gpt-sovits');
  assert.deepEqual(seen.skipped, []);
  console.log(`captured /tts URL: ${calls[0]}`);
});

test('an explicit textLang/promptLang wins over langs.speech', async (t) => {
  harness(8.4, settings({ textLang: 'zh', promptLang: 'ja' }));
  const calls = stubFetch(t, () => ({ ok: true, status: 200, arrayBuffer: wavBody }));

  await synthesize({ text: 'こんにちは', lang: 'ja', dir: DIR });

  const url = new URL(calls[0]);
  assert.equal(url.searchParams.get('text_lang'), 'zh', 'a pinned text_lang is respected');
  assert.equal(url.searchParams.get('prompt_lang'), 'ja');
});

test('an unreadable duration warns but does not block the request', async (t) => {
  const seen = harness(null);
  const calls = stubFetch(t, () => ({ ok: true, status: 200, arrayBuffer: wavBody }));

  const result = await synthesize({ text: 'テスト', lang: 'ja', dir: DIR });

  assert.equal(calls.length, 1, 'a probe failure degrades to "try it anyway"');
  assert.deepEqual(seen.warned, [{ reason: 'reference-unreadable' }]);
  assert.deepEqual(seen.skipped, []);
  assert.equal(result.provider, 'gpt-sovits');
});

test('an HTTP 400 body with Chinese decodes as UTF-8, not mojibake', async (t) => {
  const body = '{"message":"参考音频在3~10秒范围外，请更换"}';
  const seen = harness(8.4);
  stubFetch(t, () => ({
    ok: false,
    status: 400,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  }));

  const result = await synthesize({ text: 'テスト', lang: 'ja', dir: DIR });

  assert.equal(seen.failed.length, 1);
  assert.equal(seen.failed[0].status, 400);
  assert.ok(seen.failed[0].body.includes('参考音频'), 'the Chinese message survives the decode');
  assert.ok(!seen.failed[0].body.includes('锟'), 'no GBK mojibake fragment');
  assert.ok(!seen.failed[0].body.includes('\uFFFD'), 'no replacement characters');
  assert.equal(result.provider, 'edge-tts');
});

test('status diagnostics expose referenceSeconds / referenceOk', async () => {
  harness(8.4);
  const measured = await gptSovitsReferenceStatus();
  assert.equal(measured.seconds, 8.4);
  assert.equal(measured.ok, true);

  harness(60);
  const rejected = await gptSovitsReferenceStatus();
  assert.equal(rejected.seconds, 60);
  assert.equal(rejected.ok, false);
});

/** Mount the real host against a temp root; returns a status/action caller. */
async function mountHost(t, settings) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-gptsovits-reference-host-'));
  // Every effect's disposer is kept and run before rm, so a store cannot keep the root locked.
  const disposers = [];
  t.after(() => cleanupRoot(root, disposers));
  await mkdir(join(root, 'data'), { recursive: true });
  await writeFile(join(root, 'data', 'settings.json'), JSON.stringify(settings, null, 2), 'utf8');

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

test('a legacy saved textLang=zh (written by the old default) does not pin anything', async (t) => {
  const host = await mountHost(t, {
    langs: { speech: 'ja', subtitle: 'zh' },
    gptSovits: {
      enabled: true,
      apiBase: 'http://127.0.0.1:9880',
      refAudioPath: '',
      promptText: 'こんにちは',
      promptLang: 'zh',
      textLang: 'zh',
    },
  });

  const status = await host.status();
  const tts = status.tts.gptSovits;
  assert.equal(tts.effectiveTextLang, 'ja', 'the stale default follows langs.speech');
  assert.equal(tts.effectivePromptLang, 'ja');
  assert.equal(tts.promptOk, true);
  assert.equal(tts.referenceSeconds, null, 'no clip configured: nothing is measured');
  assert.equal(tts.referenceOk, false);
});

test('a language picked in the card is explicit; clearing it follows langs.speech again', async (t) => {
  const host = await mountHost(t, {
    langs: { speech: 'ja', subtitle: 'zh' },
    gptSovits: { enabled: true, apiBase: 'http://127.0.0.1:9880', refAudioPath: '', promptText: 'x' },
  });

  await host.act({ action: 'tts.config', textLang: 'zh' });
  assert.equal((await host.status()).tts.gptSovits.effectiveTextLang, 'zh', 'a picked language wins');

  await host.act({ action: 'tts.config', textLang: '' });
  assert.equal((await host.status()).tts.gptSovits.effectiveTextLang, 'ja', 'empty clears the pin');
});
