/**
 * Edge TTS language regression: `langs.speech` selects the default Edge voice, so a Japanese
 * setting no longer speaks with the Chinese voice after a GPT-SoVITS fallback. An explicit
 * `ttsVoice` still wins, because a user may deliberately pin one voice.
 *
 * Also covers the GPT-SoVITS request body: `text_lang` follows the language of the text that was
 * actually prepared (a Chinese fallback stays `zh` even when the card pinned `ja`), while
 * `prompt_lang` still follows the settings/reference clip.
 *
 * Run: node --test test/tts-language.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply, waitSpeech } from '../src/host/index.js';
import { DEFAULT_VOICES, configureTts, resolveGptLangs, synthesize, voiceForLanguage } from '../src/host/speech/tts.js';
import { cleanupRoot } from './helpers/cleanup.mjs';

/** A minimal RIFF/WAVE header: the GPT path only accepts real wav bytes. */
const WAV = (() => {
  const buffer = Buffer.alloc(44);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16000, 24);
  buffer.writeUInt32LE(32000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(0, 40);
  return buffer;
})();

/** Replace the Edge synthesizer so the test observes the exact parameters it receives. */
function captureEdge() {
  const calls = [];
  configureTts({
    edgeSynthesize: async (options) => {
      calls.push(options);
      return { file: join(options.dir, 'fake.mp3'), bytes: 1, durationMs: 1, provider: 'edge-tts' };
    },
  });
  return calls;
}

/** A fake `ctx.effect` that keeps each disposer, so teardown matches a real scope. */
function effectDisposers(disposers) {
  return (fn) => {
    const dispose = fn();
    if (typeof dispose === 'function') disposers.push(dispose);
    return dispose;
  };
}

test('the language table matches the agreed Edge defaults', () => {
  assert.deepEqual(DEFAULT_VOICES, {
    zh: 'zh-CN-XiaoxiaoNeural',
    ja: 'ja-JP-NanamiNeural',
    en: 'en-US-AriaNeural',
    ko: 'ko-KR-SunHiNeural',
    yue: 'zh-HK-HiuGaaiNeural',
  });
  assert.equal(voiceForLanguage('JA'), 'ja-JP-NanamiNeural', 'language matching is case-insensitive');
  assert.equal(voiceForLanguage('xx'), 'zh-CN-XiaoxiaoNeural', 'unknown languages fall back to Chinese');
});

for (const [lang, expected] of Object.entries(DEFAULT_VOICES)) {
  test(`speech=${lang} synthesizes with ${expected}`, async () => {
    const calls = captureEdge();
    await synthesize({ text: '你好', lang, dir: join(tmpdir(), 'dsh-tts-language') });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].voice, expected);
  });
}

test('an explicit ttsVoice overrides the language default', async () => {
  const calls = captureEdge();
  await synthesize({
    text: '你好',
    lang: 'ja',
    voice: 'en-US-GuyNeural',
    dir: join(tmpdir(), 'dsh-tts-language'),
  });
  assert.equal(calls[0].voice, 'en-US-GuyNeural');
});

test('the host passes langs.speech into synthesize for the spoken tool', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tts-language-host-'));
  const disposers = [];
  t.after(() => cleanupRoot(root, disposers));
  await mkdir(join(root, 'data'), { recursive: true });
  await writeFile(join(root, 'data', 'settings.json'), JSON.stringify({
    langs: { speech: 'ja', subtitle: 'zh' },
    gptSovits: { enabled: false },
  }), 'utf8');

  const tools = new Map();
  apply({
    effect: effectDisposers(disposers),
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
  }, { root, enabled: true });

  // The host reconfigures TTS on apply; override Edge afterwards to observe the call.
  const calls = captureEdge();
  const say = tools.get('assistant_say');
  assert.ok(say !== undefined, 'assistant_say is registered');
  const said = await say.execute({ text: 'こんにちは', play: false }, {});
  assert.equal(said.accepted, true, 'the line is accepted for background synthesis');
  const finished = await waitSpeech(said.speechId, { timeoutMs: 3000 });
  assert.equal(finished.status, 'finished', 'the background synthesis really finished');
  assert.equal(calls.length, 1, 'the tool synthesized one clip');
  assert.equal(calls[0].voice, 'ja-JP-NanamiNeural', 'ja speech reaches Edge as a Japanese voice');
});

test('an explicit host ttsVoice still overrides langs.speech', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tts-language-pinned-'));
  const disposers = [];
  t.after(() => cleanupRoot(root, disposers));
  await mkdir(join(root, 'data'), { recursive: true });
  await writeFile(join(root, 'data', 'settings.json'), JSON.stringify({
    langs: { speech: 'ja', subtitle: 'zh' },
    gptSovits: { enabled: false },
  }), 'utf8');

  const tools = new Map();
  apply({
    effect: effectDisposers(disposers),
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
  }, { root, enabled: true, ttsVoice: 'en-US-GuyNeural' });

  const calls = captureEdge();
  const said = await tools.get('assistant_say').execute({ text: 'こんにちは', play: false }, {});
  assert.equal(said.accepted, true, 'the line is accepted for background synthesis');
  const finished = await waitSpeech(said.speechId, { timeoutMs: 3000 });
  assert.equal(finished.status, 'finished', 'the background synthesis really finished');
  assert.equal(calls[0].voice, 'en-US-GuyNeural', 'a pinned ttsVoice wins over the language table');
});

test('resolveGptLangs: the prepared speech language beats a pinned text_lang', () => {
  assert.deepEqual(
    resolveGptLangs({ textLang: 'ja', promptLang: 'ja' }, 'zh', { textLang: 'zh' }),
    { textLang: 'zh', promptLang: 'ja' },
    'a line prepared as Chinese is never relabelled ja by the settings pin',
  );
  assert.deepEqual(
    resolveGptLangs({ textLang: '', promptLang: '' }, 'ja'),
    { textLang: 'ja', promptLang: 'ja' },
    'empty settings follow the spoken language',
  );
});

test('a translation fallback sends text_lang=zh although the card pinned ja', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tts-language-fallback-'));
  const disposers = [];
  t.after(() => cleanupRoot(root, disposers));
  await mkdir(join(root, 'data'), { recursive: true });
  await writeFile(join(root, 'data', 'settings.json'), JSON.stringify({
    langs: { speech: 'ja', subtitle: 'zh' },
    gptSovits: { enabled: false },
  }), 'utf8');

  const tools = new Map();
  let translations = 0;
  apply({
    effect: effectDisposers(disposers),
    get(serviceName) {
      if (serviceName === 'llm') {
        return {
          stream() {
            translations += 1;
            // A partial Japanese answer then an error: the outlet must fall back to Chinese.
            return (async function* generate() {
              yield { type: 'text-delta', text: '今日はいい' };
              yield { type: 'finish', reason: { kind: 'error' } };
            })();
          },
        };
      }
      if (serviceName === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'fake-provider', model: 'fake-model' }) };
      }
      return undefined;
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
  }, { root, enabled: true });

  const edge = [];
  configureTts({
    gptSovits: () => ({
      enabled: true,
      apiBase: 'http://127.0.0.1:9880',
      refAudioPath: 'G:\\voice\\reference.wav',
      promptText: '参考音频里说的话',
      promptLang: 'ja',
      // The card pinned ja; it must not turn the Chinese fallback into "Japanese".
      textLang: 'ja',
      models: { gptModelPath: '', sovitsModelPath: '' },
    }),
    probeReference: async () => 8.4,
    edgeSynthesize: async (options) => {
      edge.push(options);
      return { file: join(options.dir, 'edge.mp3'), bytes: 1, durationMs: 1, provider: 'edge-tts' };
    },
  });
  const urls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => WAV.buffer.slice(WAV.byteOffset, WAV.byteOffset + WAV.byteLength),
    };
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await tools.get('assistant_say').execute({ text: '今天天气很好。', play: false }, {});
  assert.equal(result.accepted, true, 'the call is accepted; the fallback synthesis runs in the background');
  const finished = await waitSpeech(result.speechId, { timeoutMs: 3000 });
  assert.equal(finished.status, 'finished', 'the accepted fallback speech really finished');
  assert.equal(translations, 1, 'the speech stream attempted one translation');
  assert.equal(urls.length, 1, 'GPT-SoVITS received exactly one request');
  const url = new URL(urls[0]);
  assert.equal(url.pathname, '/tts');
  assert.equal(url.searchParams.get('text_lang'), 'zh', 'the fallback Chinese text is labelled zh');
  assert.equal(url.searchParams.get('prompt_lang'), 'ja', 'the reference clip still follows the setting');
  assert.equal(url.searchParams.get('text'), '今天天气很好。', 'the original line is what is spoken');
  assert.equal(edge.length, 0, 'the GPT-SoVITS path answered, so Edge was not used');
});
