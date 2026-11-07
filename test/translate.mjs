/**
 * Chinese body -> Japanese speech: the isolated translation entry and the one shared speech outlet.
 *
 * What this covers:
 *   1. a Chinese line: the caption stays Chinese, TTS receives kana-only, word-spaced Japanese
 *   2. zh -> zh: the translator is never called
 *   3. `assistant_say` text already in Japanese: no translation (host + component)
 *   4. the translation request carries no history, memory or tool definitions
 *   5. cache hit: the second call does not reach the model and reports `cached: true`
 *   6. a model answer that just repeats the Chinese (or is Han-only) is rejected, then falls back
 *   7. a failed translation falls back to the source language; Chinese is never labelled `ja`
 *   8. sentence ids pair each Chinese caption with its Japanese speech line (3 -> 3)
 *   9. prefetch: while sentence 1 plays, sentence 2 is already translated/synthesized
 *  10. the first-sound latency row carries `translateMs`
 *  11. interrupt: an in-flight translation is cancelled and its late result is never played
 *  12. the mounted `assistant_say` path really translates Chinese before TTS
 *  13. the mounted `assistant_say` path does not translate an already-Japanese line
 *  14. dual stream: subtitle en + speech ja are two independent translations (no audio side)
 *  15. the same-language stream is skipped: subtitle zh + speech ja only translates the voice
 *  16. a failed subtitle stream keeps the original caption and logs an event; speech is untouched
 *  17. `finish:error` / a token-cap stop is TRANSLATE_INCOMPLETE: not cached, not played
 *  18. the token cap without a normal finish is incomplete too
 *  19. a Chinese line quoting one Japanese word is still translated (no kana guessing)
 *  20. 「了解」→「了解です。」 is a translation, not TRANSLATE_UNCHANGED
 *  21. an almost-identical answer is still rejected as unchanged
 *  22. the cache is keyed by target language: subtitle en and speech ja are two entries
 *  23. a stream with `text-delta` but no finish is TRANSLATE_INCOMPLETE and never cached
 *  24. `{text, finishReason:'length', truncated:true}` is incomplete too
 *  25. `{text, finishReason:'stop'}` is complete and may be cached
 *  26. a stream that ends with `finish:'stop'` is complete
 *  27. mounted `assistant_say` runs the subtitle stream: langs.subtitle=en repaints the caption
 *  28. a failed subtitle stream keeps the original caption + event; the voice is unaffected
 *  29. per-sentence check finds a Han sentence inside kana Japanese and repairs only that sentence
 *  30. the repaired line is fully kana + 分かち書き and is what the cache keeps
 *  31. a repair that is still Han fails the WHOLE line (TRANSLATE_NOT_KANA), no cache
 *  32. pure kana + 分かち書き passes without any repair round
 *  33. a Han-only answer (「了解」) is not kana and fails after the repair round
 *  34. one repair round covers every offending sentence at once
 *  35. default kanaSpaced: no Han, kana present, at least one word space
 *  36. the user example '今日はいい天気ですね' is rejected and repaired to spaced kana
 *  37. a successful repair is all-kana, spaced, and the repaired line is cached
 *  38. continuous kana without spaces fails; a repair that stays unspaced ends in TRANSLATE_NOT_KANA
 *  39. zh/en targets keep the old rules: no Han/space check, no repair round
 *  40. a rules-version bump makes the old cache entry miss
 *  41. mixed script keeps kanji + kana and the old TRANSLATE_NOT_JAPANESE failure
 *  42. kana script accepts continuous kana but still rejects any Han
 *  43. kanaSpaced accepts a full-width word space as 分かち書き
 *  44. the three scripts never share a cache entry for the same source
 *  45. an unknown script falls back to kanaSpaced
 *  46. a short answer (「はい。」) passes kanaSpaced with no word spaces and no repair round
 *  47. the long-sentence rule is not relaxed: kana without 分かち書き still fails and falls back
 *  48. purpose 'subtitle': normal Japanese writing (kanji + kana), never kana + spaces
 *  49. purpose 'speech' (and the default): kana + 分かち書き, never the mixed prompt
 *  50. the cache key binds that purpose: speech and subtitle never share an entry
 *  51. a max-tokens truncated first answer retries once with >=8192 and a direct-answer prompt
 *  52. a complete first answer is never retried; default 2048, configurable via translateMaxTokens
 *  53. a still-truncated retry is TRANSLATE_INCOMPLETE: not cached, both lanes fall back
 *  54. voice.translate.retry carries {reason, from, to} as the budgets before/after that retry
 *  55. the deadline defaults to 15000 ms: a 6 s answer succeeds, `translateTimeoutMs` configures it
 *  56. a timed-out first attempt retries ONCE at the SAME 2048 budget with a fresh 15 s clock
 *  57. both attempts late: TRANSLATE_TIMEOUT (attempt 1/2), the line falls back to Chinese
 *  58. truncation still raises 2048 -> 8192; the timeout rule never raises the budget
 *  59. three sentences translate in parallel (max 3); the 4th waits; their windows overlap
 *  60. one timed-out sentence falls back alone while the other two still translate
 *  61. a sentence queued behind the slot cap is cancellable and never leaks its slot
 *  62. the assist channel names its task, tags the target and repairs a context echo
 *  63. an answer that still carries the context after the repair falls back to the source
 *  64. the kana speech path routes as task kana; a clean answer is cached with the same key
 *  65. queued voice lines outrank a queued subtitle (3:1) and never interrupt a running subtitle
 *  66. an empty lane never idles the slot: with only subtitles waiting they all run back-to-back
 *  67. a cancelled (stale) queued subtitle is purged before the next slot is handed out
 *  68. mounted: a subtitle translation arriving after the next line cannot repaint it
 *
 * Run: node --test test/translate.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createTranslator,
  createTranslationCache,
  detectLanguage,
  findInvalidJapaneseSentences,
  prepareCaption,
  prepareReplyStreams,
  prepareSpeech,
  translationKey,
  translationPrompt,
  translationLatencyFields,
  normalizeJaSpeechScript,
  normalizeTranslatePurpose,
  DEFAULT_TRANSLATE_MAX_TOKENS,
  DEFAULT_TRANSLATE_TIMEOUT_MS,
  TRANSLATE_RULES_VERSION,
} from '../src/host/speech/translate.js';
import { cleanupRoot } from './helpers/cleanup.mjs';
import { renderLightweightInput } from '../src/host/session/inference/lightweight.js';

/**
 * The mounted host reaches the real player (ffplay/WPF) and the real caption overlay process.
 * Substitute both once, before `index.js` is imported: the fake player reports its start and
 * stays "playing" until the test releases it, and the overlay records every published caption in
 * `globalThis.__translateHost`. `resolveFfplay` is pinned to null so the file path is exercised.
 */
const hostState = { subtitles: [], players: [] };
globalThis.__translateHost = hostState;
const subtitleUrl = new URL('../src/host/subtitle/subtitle.js', import.meta.url).href;
const ttsUrl = new URL('../src/host/speech/tts.js', import.meta.url).href;
const sightUrl = new URL('../src/host/vision/sight.js', import.meta.url).href;

const hooks = registerHooks({
  load(url, context, next) {
    if (url === subtitleUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    export const averageColor = async () => null;
    export const normalizeGeometry = (value) => (
      value === null || typeof value !== 'object' ? null : value
    );
    export const probeSubtitleWorkArea = async () => null;
    export class SubtitleGeometryTracker {
      constructor({ onEvent = null } = {}) { this.onEvent = onEvent; this.current = null; }
      observe() { return null; }
      set(rect) { this.current = rect ?? null; return this.current; }
      keep() { return this.current; }
    }
    export class SubtitleOverlay {
      constructor({ config } = {}) { this.config = config ?? {}; }
      async show(text) { globalThis.__translateHost.subtitles.push({ text }); }
      async hide() {}
      async stop() {}
    }`,
      };
    }
    if (url === ttsUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    export * from '${ttsUrl}?translate-real';
    export const play = (file, options = {}) => {
      const release = { resolve: null };
      const done = new Promise((resolve) => { release.resolve = resolve; });
      globalThis.__translateHost.players.push({ file, release });
      try { options.onStart?.({ startedAt: Date.now() }); } catch {}
      return done;
    };`,
      };
    }
    if (url === sightUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    export * from '${sightUrl}?translate-real';
    export const resolveFfplay = () => null;`,
      };
    }
    return next(url, context);
  },
});
const { apply, createReplySpeaker, waitSpeech } = await import('../src/host/index.js');
const { configureTts } = await import('../src/host/speech/tts.js');
hooks.deregister();

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

const waitUntil = async (check, message, timeoutMs = 3000) => {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out: ${message}`);
    await tick(5);
  }
};

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

/** A scripted translator: never touches a model, records every call. */
function scriptedTranslator(script, { latencyMs = 0 } = {}) {
  const calls = [];
  return {
    calls,
    async translate(text, { from, to, signal } = {}) {
      calls.push({ text, from, to });
      if (latencyMs > 0) await tick(latencyMs);
      if (signal?.aborted) return { ok: false, code: 'TRANSLATE_CANCELLED', text: '', cached: false, ms: latencyMs };
      const value = typeof script === 'function' ? script(text, { from, to }) : script[text];
      if (value === undefined) return { ok: false, code: 'TRANSLATE_FAILED', text: '', cached: false, ms: latencyMs };
      if (value !== null && typeof value === 'object') return value;
      return { ok: true, text: value, cached: false, ms: latencyMs };
    },
  };
}

/**
 * A speaker exactly like the auto/typed lanes: the shared outlet runs inside `synthesize`, the
 * player receives the decorated audio, and a gate stands in for the clip's duration.
 */
function speechFixture({ translator, speechLang = 'ja', prefetchDepth = 2 } = {}) {
  const synth = [];
  const plays = [];
  const events = [];
  const speaker = createReplySpeaker({
    prefetchDepth,
    startedAt: 0,
    synthesize: async ({ text, signal, sentenceId }) => {
      const prepared = await prepareSpeech(text, {
        translator,
        speechLang,
        signal,
        sentenceId,
        emit: (type, payload) => events.push({ type, ...payload }),
      });
      synth.push({
        sentenceId,
        text,
        speechText: prepared.speechText,
        lang: prepared.speechLang,
        translated: prepared.translated,
        fallback: prepared.fallback,
        code: prepared.code,
      });
      return {
        file: `clip-${sentenceId}.mp3`,
        bytes: 1,
        durationMs: 100,
        captionText: prepared.captionText,
        speechText: prepared.speechText,
        speechLang: prepared.speechLang,
        translated: prepared.translated,
        cached: prepared.cached,
        translateMs: prepared.translateMs,
        sentenceId,
      };
    },
    play: async ({ audio, text, sentenceId, signal }) => {
      const gate = deferred();
      const entry = {
        caption: audio?.captionText ?? text,
        speechText: audio?.speechText ?? text,
        lang: audio?.speechLang,
        sentenceId,
        gate,
        done: false,
      };
      plays.push(entry);
      const onAbort = () => gate.resolve();
      signal?.addEventListener?.('abort', onAbort, { once: true });
      const done = gate.promise.then(() => {
        signal?.removeEventListener?.('abort', onAbort);
        entry.done = true;
        if (signal?.aborted) throw signal.reason ?? new DOMException('cancelled', 'AbortError');
      });
      return { audioStartedAt: Date.now(), done };
    },
  });
  return { speaker, synth, plays, events };
}

/** Release blocked fake players until the speaker's `finish()` promise settles. */
async function driveToEnd(plays, finished) {
  let stats = null;
  let failure = null;
  finished.then((value) => { stats = value; }, (error) => { failure = error; });
  for (let index = 0; index < 200 && stats === null && failure === null; index += 1) {
    const next = plays.find((entry) => entry.done === false);
    if (next !== undefined) next.gate.resolve();
    await tick(5);
  }
  if (failure !== null) throw failure;
  if (stats === null) throw new Error('the speaker did not finish');
  return stats;
}

async function readEvents(root) {
  try {
    const text = await readFile(join(root, 'data', 'events.jsonl'), 'utf8');
    return text.trim().split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/** Mount the real host with a fake LLM (the only translation request) and fake Edge TTS. */
async function mountHost(t, {
  speech = 'ja',
  subtitle = 'zh',
  subtitleVisible = false,
  captionFails = false,
  /** Deferred the FIRST subtitle (English) stream waits on, to stage a late translation. */
  captionHold = null,
  /** Maps the source line to its English "translation" when a test needs distinct captions. */
  englishFor = null,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-translate-host-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await writeFile(join(root, 'data', 'features.json'), JSON.stringify({
    hearing: false, ambient: false, subtitle: subtitleVisible,
  }), 'utf8');
  await writeFile(join(root, 'data', 'settings.json'), JSON.stringify({
    langs: { speech, subtitle },
    gptSovits: { enabled: false },
    subtitle: {
      enabled: subtitleVisible,
      mode: 'region',
      region: { left: 0, top: 0, width: 320, height: 100 },
    },
  }), 'utf8');
  // A fresh caption/player observation per mount; `hostState` belongs to the stubbed modules.
  hostState.subtitles.length = 0;
  hostState.players.length = 0;

  const requests = [];
  const cleanups = [];
  const tools = new Map();
  const ctx = {
    effect(fn) {
      const cleanup = fn();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
      return cleanup;
    },
    get(serviceName) {
      if (serviceName === 'llm') {
        return {
          stream(options) {
            requests.push(options);
            const english = String(options.system ?? '').includes('英语');
            const body = String(options.messages?.[0]?.content?.[0]?.text ?? '');
            return (async function* generate() {
              if (english && captionHold !== null) {
                captionHold.promise.catch(() => {});
                // Only the first subtitle stream is held: the next line's caption must still land.
                if (captionHold.claimed !== true) {
                  captionHold.claimed = true;
                  await captionHold.promise;
                }
              }
              if (english && captionFails) {
                // The subtitle stream dies mid-line; the speech stream is unaffected.
                yield { type: 'text-delta', text: 'The weather is' };
                yield { type: 'finish', reason: { kind: 'error' } };
                return;
              }
              const text = english
                ? (typeof englishFor === 'function' ? englishFor(body) : 'The weather is nice today.')
                : 'きょう は いい おてんき です ね。';
              yield { type: 'text-delta', text };
              yield { type: 'finish', reason: { kind: 'stop' } };
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
  };
  apply(ctx, { root, enabled: true });
  // apply() reconfigured TTS; override Edge afterwards to observe the exact spoken text/voice.
  const edge = [];
  configureTts({
    edgeSynthesize: async (options) => {
      edge.push(options);
      return { file: join(root, 'cache', 'tts', 'fake.mp3'), bytes: 1, durationMs: 1, provider: 'edge-tts' };
    },
  });
  t.after(() => {
    // The fake player never ends by itself: release it before the host tears down.
    for (const player of hostState.players) player.release.resolve();
    return cleanupRoot(root, cleanups);
  });
  return { root, tools, requests, edge };
}

// ---------------------------------------------------------------------------
// 0. Language detection and the cache key contract
// ---------------------------------------------------------------------------

test('detectLanguage: kana wins over Han, Han-only is Chinese; cache key binds the rules revision', () => {
  assert.equal(detectLanguage('今天天气很好。'), 'zh');
  assert.equal(detectLanguage('今日はいい天気ですね。'), 'ja');
  assert.equal(detectLanguage('Hello there'), 'en');
  assert.equal(detectLanguage('안녕하세요'), 'ko');
  assert.equal(TRANSLATE_RULES_VERSION, 3, 'the kana/分かち書き rule change bumped the revision');
  const a = translationKey({ from: 'zh', to: 'ja', rulesVersion: TRANSLATE_RULES_VERSION, text: '今天' });
  const b = translationKey({ from: 'zh', to: 'ja', rulesVersion: TRANSLATE_RULES_VERSION, text: '今天' });
  const c = translationKey({ from: 'zh', to: 'ja', rulesVersion: TRANSLATE_RULES_VERSION + 1, text: '今天' });
  assert.equal(a, b, 'same inputs hash to the same key');
  assert.notEqual(a, c, 'a rules revision change invalidates the cached entry');
});

// ---------------------------------------------------------------------------
// 1-3. The shared outlet
// ---------------------------------------------------------------------------

test('1. Chinese body: caption stays Chinese, TTS receives a different kana-only Japanese line', async () => {
  const translator = scriptedTranslator({ '今天天气很好。': 'きょう は いい おてんき です ね。' });
  const fx = speechFixture({ translator });
  fx.speaker.push('今天天气很好。');
  await waitUntil(() => fx.plays.length === 1, 'the first clip started');
  const played = fx.plays[0];
  assert.equal(played.caption, '今天天气很好。', 'subtitle keeps the Chinese original');
  assert.equal(played.speechText, 'きょう は いい おてんき です ね。', 'TTS gets the translation');
  assert.notEqual(played.caption, played.speechText, 'caption and speech are different texts');
  assert.equal(played.lang, 'ja', 'TTS is told the speech language');
  assert.match(played.speechText, /[\u3040-\u30ff]/u, 'the Japanese line really contains kana');
  assert.doesNotMatch(played.speechText, /[\u3400-\u4dbf\u4e00-\u9fff]/u, 'no Han reaches TTS');
  assert.match(played.speechText, /[ \u3000]/u, 'words are separated for the synthesizer');
  assert.equal(fx.synth[0].translated, true);
  played.gate.resolve();
  await fx.speaker.finish({ fullText: '今天天气很好。' });
});

test('2. zh -> zh: the translator is not called at all', async () => {
  const translator = { calls: 0, async translate() { this.calls += 1; throw new Error('must not translate'); } };
  const prepared = await prepareSpeech('这是中文正文。', { speechLang: 'zh', translator });
  assert.equal(translator.calls, 0);
  assert.equal(prepared.translated, false);
  assert.equal(prepared.speechText, '这是中文正文。');
  assert.equal(prepared.speechLang, 'zh');
});

test('3. an already-Japanese line is synthesized directly, with no second translation', async () => {
  const translator = { calls: 0, async translate() { this.calls += 1; throw new Error('must not translate'); } };
  const text = 'こんにちは、いい天気ですね。';
  const prepared = await prepareSpeech(text, { speechLang: 'ja', translator });
  assert.equal(translator.calls, 0, 'detected ja == target ja');
  assert.equal(prepared.translated, false);
  assert.equal(prepared.speechText, text);
  assert.equal(prepared.speechLang, 'ja');
});

// ---------------------------------------------------------------------------
// 4. The request shape: one isolated line, never the conversation
// ---------------------------------------------------------------------------

test('4. the translation request has one system prompt + one user line, no history/memory/tools', async () => {
  const requests = [];
  const translator = createTranslator({
    request: async (options) => {
      requests.push(options);
      return 'きょう は いい おてんき です ね。';
    },
  });
  const result = await translator.translate('今天天气很好。', { from: 'zh', to: 'ja' });
  assert.equal(result.ok, true);
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.deepEqual(
    Object.keys(request).sort(),
    ['maxTokens', 'messages', 'signal', 'system'],
    'only the prompt pair and a cancellation signal reach the model',
  );
  assert.equal(request.tools, undefined, 'no tool definitions');
  assert.equal(request.history, undefined, 'no chat history');
  assert.equal(request.messages.length, 1, 'exactly one message');
  assert.equal(request.messages[0].role, 'user');
  assert.match(request.system, /翻译/u, 'the system prompt is the translator role');
  assert.match(request.messages[0].content[0].text, /今天天气很好/u, 'the line itself is the only payload');
  assert.ok(request.signal instanceof AbortSignal);
});

// ---------------------------------------------------------------------------
// 5. Cache
// ---------------------------------------------------------------------------

test('5. cache hit: the second call does not reach the model and reports cached:true', async () => {
  let calls = 0;
  const cache = createTranslationCache({ capacity: 2 });
  const translator = createTranslator({
    cache,
    request: async () => {
      calls += 1;
      return 'きょう は いい おてんき です ね。';
    },
  });
  const first = await translator.translate('今天天气很好。', { from: 'zh', to: 'ja' });
  const second = await translator.translate('今天天气很好。', { from: 'zh', to: 'ja' });
  assert.equal(first.ok, true);
  assert.equal(first.cached, false);
  assert.equal(second.ok, true);
  assert.equal(second.cached, true, 'the hit is marked');
  assert.equal(second.text, first.text);
  assert.equal(calls, 1, 'the model was called exactly once');
  assert.equal(cache.size, 1);
});

// ---------------------------------------------------------------------------
// 6-7. Validation and fallback
// ---------------------------------------------------------------------------

test('6. a Han-only / unchanged "translation" is rejected instead of being read aloud', async () => {
  const events = [];
  const translator = createTranslator({
    request: async () => '今日天气很好',
    onEvent: (type, payload) => events.push({ type, ...payload }),
  });
  const prepared = await prepareSpeech('今天天气很好。', { translator, speechLang: 'ja' });
  assert.equal(prepared.ok, false);
  assert.equal(prepared.code, 'TRANSLATE_NOT_KANA', 'Han means it was never a kana reading');
  assert.equal(prepared.fallback, true);
  assert.equal(prepared.speechLang, 'zh', 'the source language is kept, not relabelled ja');
  assert.equal(prepared.speechText, '今天天气很好。');
  assert.ok(events.some((event) => event.type === 'voice.translate.repair'), 'the Han sentence was sent back once');
  assert.ok(events.some((event) => event.type === 'voice.translate.failed'
    && event.code === 'TRANSLATE_NOT_KANA'), 'the failure code is observable');
});

test('7. a failed translation speaks the source line and reports the fallback event', async () => {
  const events = [];
  const translator = createTranslator({
    request: async () => { throw new Error('llm-down'); },
    onEvent: (type, payload) => events.push({ type, ...payload }),
  });
  const fx = speechFixture({ translator });
  fx.speaker.push('今天天气很好。');
  await waitUntil(() => fx.plays.length === 1, 'the fallback clip started');
  const played = fx.plays[0];
  assert.equal(played.caption, '今天天气很好。');
  assert.equal(played.speechText, '今天天气很好。', 'the original text is spoken');
  assert.equal(played.lang, 'zh', 'Chinese is labelled zh, never ja');
  assert.notEqual(played.lang, 'ja');
  assert.ok(events.some((event) => event.type === 'voice.translate.failed'
    && event.code === 'TRANSLATE_REQUEST_FAILED'), 'failure reason is logged');
  assert.ok(fx.events.some((event) => event.type === 'voice.translate.fallback'
    && event.from === 'zh' && event.to === 'ja'
    && event.code === 'TRANSLATE_REQUEST_FAILED'), 'fallback event is logged');
  played.gate.resolve();
  await fx.speaker.finish({ fullText: '今天天气很好。' });
});

// ---------------------------------------------------------------------------
// 8-9. Sentence ids, order and prefetch
// ---------------------------------------------------------------------------

const THREE = {
  '第一句。': '一つ目の文です。',
  '第二句。': '二つ目の文です。',
  '第三句。': '三つ目の文です。',
};

test('8. three sentences produce three caption/speech pairs with matching sentence ids', async () => {
  const fx = speechFixture({ translator: scriptedTranslator(THREE), prefetchDepth: 3 });
  fx.speaker.push('第一句。第二句。第三句。');
  const stats = await driveToEnd(fx.plays, fx.speaker.finish({ fullText: '第一句。第二句。第三句。' }));
  assert.equal(stats.sentences, 3);
  assert.equal(stats.played, 3);
  assert.deepEqual(fx.plays.map((entry) => entry.sentenceId), [0, 1, 2], 'ids are stable and ordered');
  assert.deepEqual(fx.plays.map((entry) => entry.caption), ['第一句。', '第二句。', '第三句。']);
  assert.deepEqual(fx.plays.map((entry) => entry.speechText), [
    '一つ目の文です。', '二つ目の文です。', '三つ目の文です。',
  ]);
  for (const entry of fx.plays) {
    assert.notEqual(entry.caption, entry.speechText, `sentence ${entry.sentenceId} was translated`);
  }
});

test('9. prefetch: sentence 2 is translated/synthesized while sentence 1 still plays', async () => {
  const translator = scriptedTranslator(THREE, { latencyMs: 20 });
  const fx = speechFixture({ translator, prefetchDepth: 2 });
  fx.speaker.push('第一句。第二句。第三句。');
  await waitUntil(() => fx.plays.length === 1, 'sentence 1 started playing');
  await waitUntil(
    () => fx.synth.some((entry) => entry.sentenceId === 1),
    'sentence 2 was synthesized ahead',
  );
  assert.equal(fx.plays.length, 1, 'sentence 2 has not started playing yet');
  assert.ok(translator.calls.some((call) => call.text === '第二句。'), 'sentence 2 was already translated');
  await driveToEnd(fx.plays, fx.speaker.finish({ fullText: '第一句。第二句。第三句。' }));
});

// ---------------------------------------------------------------------------
// 10. Latency attribution
// ---------------------------------------------------------------------------

test('10. the first-sound latency row carries translateMs', async () => {
  const translator = {
    async translate() {
      return { ok: true, text: 'きょう は いい おてんき です ね。', cached: false, ms: 37 };
    },
  };
  const fx = speechFixture({ translator });
  fx.speaker.push('今天天气很好。');
  await waitUntil(() => fx.plays.length === 1, 'the clip started');
  fx.plays[0].gate.resolve();
  const stats = await fx.speaker.finish({ fullText: '今天天气很好。' });
  assert.equal(stats.firstTranslateMs, 37, 'translation time is attributed to the first sentence');
  assert.equal(stats.firstTranslated, true);
  assert.equal(stats.firstTranslateCached, false);
  assert.deepEqual(
    translationLatencyFields({
      translateMs: stats.firstTranslateMs,
      cached: stats.firstTranslateCached,
      translated: stats.firstTranslated,
    }),
    { translateMs: 37, translateCached: false },
    'the voice.latency extension carries translateMs',
  );
});

// ---------------------------------------------------------------------------
// 11. Cancellation: a late translation never reaches synthesis or the player
// ---------------------------------------------------------------------------

test('11. interrupt: the in-flight translation is cancelled and its late result is never played', async () => {
  let requests = 0;
  // This model deliberately ignores the lane and answers after 60 ms; the outlet must discard it.
  const translator = {
    async translate(text, { signal } = {}) {
      requests += 1;
      await tick(60);
      if (signal?.aborted) return { ok: false, code: 'TRANSLATE_CANCELLED', text: '', cached: false, ms: 60 };
      return { ok: true, text: 'きょう は いい おてんき です ね。', cached: false, ms: 60 };
    },
  };
  const fx = speechFixture({ translator });
  fx.speaker.push('今天天气很好。');
  await waitUntil(() => requests === 1, 'the translation is in flight');
  fx.speaker.cancel('barge-in');
  await tick(120); // longer than the model's answer time
  const stats = await fx.speaker.finish({ fullText: '今天天气很好。' });
  assert.equal(fx.plays.length, 0, 'no clip was ever played');
  assert.equal(fx.synth.length, 0, 'the late translation never reached synthesis');
  assert.equal(stats.cancelled, true);
});

// ---------------------------------------------------------------------------
// 12-13. The real mounted assistant_say path
// ---------------------------------------------------------------------------

test('12. mounted assistant_say: Chinese in, Japanese to TTS (host wiring)', async (t) => {
  const app = await mountHost(t);
  const result = await app.tools.get('assistant_say').execute({ text: '今天天气很好。', play: false }, {});
  assert.equal(result.accepted, true, 'the call is accepted; synthesis runs in the background');
  const finished = await waitSpeech(result.speechId, { timeoutMs: 3000 });
  assert.equal(finished.status, 'finished', 'the accepted speech really finished');
  assert.equal(app.requests.length, 1, 'exactly one translation request');
  assert.equal(app.requests[0].tools, undefined);
  assert.equal(app.edge.length, 1, 'exactly one TTS call');
  assert.equal(app.edge[0].text, 'きょう は いい おてんき です ね。');
  assert.notEqual(app.edge[0].text, '今天天气很好。');
  assert.equal(app.edge[0].voice, 'ja-JP-NanamiNeural', 'ja speech selects the Japanese voice');
  const events = await readEvents(app.root);
  const translated = events.find((event) => event.type === 'voice.translate');
  assert.ok(translated !== undefined, 'voice.translate is logged');
  assert.equal(translated.payload.from, 'zh');
  assert.equal(translated.payload.to, 'ja');
  assert.equal(translated.payload.cached, false);
  const spoken = events.find((event) => event.type === 'speech.spoken');
  assert.ok(spoken !== undefined, 'the spoken outcome is logged');
  assert.equal(typeof spoken.payload.translateMs, 'number', 'TTS time and translation time are separable');
  assert.equal(spoken.payload.to, 'ja');
  assert.equal(typeof spoken.payload.synthMs, 'number', 'the existing TTS timing field is kept');
  // The migrated call site sends an input package; the channel's telemetry records its size.
  const lightweightRow = events.find((event) => event.type === 'lightweight.request'
    && event.payload?.task === 'kana');
  assert.ok(lightweightRow !== undefined, 'the translation went through the lightweight channel');
  assert.equal(lightweightRow.payload.failed, false);
  assert.equal(typeof lightweightRow.payload.input.chars, 'number');
  assert.ok(lightweightRow.payload.input.chars > [...'今天天气很好。'].length,
    'the input size covers the rendered prompt, not just the target line');
  assert.equal(lightweightRow.payload.input.tokensEstimate,
    Math.ceil(lightweightRow.payload.input.chars / 2), 'the estimate is derived from the chars');
  assert.equal(lightweightRow.payload.retries, 0);
  assert.equal(typeof lightweightRow.payload.firstTextMs, 'number');
  assert.equal(typeof lightweightRow.payload.doneMs, 'number');
  assert.equal(typeof lightweightRow.payload.reasoningChars, 'number');
});

test('13. mounted assistant_say: an already-Japanese line is synthesized directly', async (t) => {
  // Even with the configured speech language set to Chinese, the tool's Japanese words are spoken
  // as Japanese: the model deliberately handed over the speech text, so it is never translated.
  const app = await mountHost(t, { speech: 'zh' });
  const text = 'こんにちは、いい天気ですね。';
  const result = await app.tools.get('assistant_say').execute({ text, play: false }, {});
  assert.equal(result.accepted, true, 'the call is accepted; synthesis runs in the background');
  const finished = await waitSpeech(result.speechId, { timeoutMs: 3000 });
  assert.equal(finished.status, 'finished', 'the accepted speech really finished');
  assert.equal(app.requests.length, 0, 'no translation request for an already-Japanese line');
  assert.equal(app.edge.length, 1);
  assert.equal(app.edge[0].text, text, 'the text reaches TTS unchanged');
  assert.equal(app.edge[0].voice, 'ja-JP-NanamiNeural', 'it is spoken as Japanese');
});

// ---------------------------------------------------------------------------
// 14-16. The two independent reply streams: subtitle (langs.subtitle) + speech (langs.speech)
// ---------------------------------------------------------------------------

/** A scripted async iterator, so finish/usage chunks reach `collectText` unchanged. */
function chunkStream(chunks) {
  return (async function* generate() {
    for (const chunk of chunks) yield chunk;
  })();
}

test('14. dual stream: subtitle en + speech ja make one call each and produce different lines', async () => {
  const calls = [];
  const translator = {
    async translate(text, { from, to } = {}) {
      calls.push({ text, from, to });
      const value = to === 'en'
        ? 'Today I learned “thank you”, and I am really happy.'
        : 'きょう は 「ありがとう」 を おぼえて、とても うれしいです。';
      return { ok: true, text: value, cached: false, ms: 3 };
    },
  };
  const text = '今天学会了「ありがとう」，真开心。';
  const { caption, speech } = prepareReplyStreams(text, {
    captionLang: 'en',
    speechLang: 'ja',
    translator,
  });
  const [captionResult, speechResult] = await Promise.all([caption, speech]);
  assert.deepEqual(calls.map((call) => call.to).sort(), ['en', 'ja'], 'one translation per stream');
  assert.equal(captionResult.captionText, 'Today I learned “thank you”, and I am really happy.');
  assert.equal(captionResult.captionLang, 'en');
  assert.equal(captionResult.translated, true);
  assert.match(captionResult.captionText, /[A-Za-z]/u, 'the subtitle is English');
  assert.equal(speechResult.speechText, 'きょう は 「ありがとう」 を おぼえて、とても うれしいです。');
  assert.equal(speechResult.speechLang, 'ja');
  assert.match(speechResult.speechText, /[\u3040-\u30ff]/u, 'TTS receives Japanese');
  assert.notEqual(captionResult.captionText, speechResult.speechText, 'the two streams diverge');
});

test('15. the same-language stream is skipped: subtitle zh, speech ja translates only the voice', async () => {
  const calls = [];
  const translator = {
    async translate(text, { from, to } = {}) {
      calls.push({ text, from, to });
      return { ok: true, text: 'きょう は いい おてんき です ね。', cached: false, ms: 2 };
    },
  };
  const { caption, speech } = prepareReplyStreams('今天天气很好。', {
    captionLang: 'zh',
    speechLang: 'ja',
    translator,
  });
  const [captionResult, speechResult] = await Promise.all([caption, speech]);
  assert.equal(calls.length, 1, 'the subtitle stream never calls the model for zh -> zh');
  assert.equal(calls[0].to, 'ja', 'only the speech stream translates');
  assert.equal(captionResult.translated, false);
  assert.equal(captionResult.captionText, '今天天气很好。');
  assert.equal(captionResult.captionLang, 'zh');
  assert.equal(speechResult.translated, true);
  assert.equal(speechResult.speechText, 'きょう は いい おてんき です ね。');
});

test('16. a failed subtitle stream keeps the original caption and logs an event; speech is untouched', async () => {
  const events = [];
  const translator = {
    async translate(text, { to } = {}) {
      if (to === 'en') return { ok: false, code: 'TRANSLATE_INCOMPLETE', text: '', cached: false, ms: 2 };
      return { ok: true, text: 'きょう は いい おてんき です ね。', cached: false, ms: 3 };
    },
  };
  const { caption, speech } = prepareReplyStreams('今天天气很好。', {
    captionLang: 'en',
    speechLang: 'ja',
    translator,
    emit: (type, payload) => events.push({ type, ...payload }),
  });
  const [captionResult, speechResult] = await Promise.all([caption, speech]);
  assert.equal(captionResult.ok, false);
  assert.equal(captionResult.code, 'TRANSLATE_INCOMPLETE');
  assert.equal(captionResult.captionText, '今天天气很好。', 'the subtitle keeps the original line');
  assert.equal(captionResult.translated, false);
  assert.ok(events.some((event) => event.type === 'voice.subtitle.fallback'
    && event.from === 'zh' && event.to === 'en' && event.code === 'TRANSLATE_INCOMPLETE'));
  assert.equal(speechResult.translated, true, 'the voice stream is unaffected');
  assert.equal(speechResult.speechText, 'きょう は いい おてんき です ね。');
  assert.equal(speechResult.speechLang, 'ja');
});

// ---------------------------------------------------------------------------
// 17-18. Completion state and the hardened language checks
// ---------------------------------------------------------------------------

test('17. finish:error marks the translation incomplete: not cached, not spoken', async () => {
  const cache = createTranslationCache();
  const events = [];
  const translator = createTranslator({
    cache,
    onEvent: (type, payload) => events.push({ type, ...payload }),
    request: async () => chunkStream([
      { type: 'text-delta', text: '今日はいい' },
      { type: 'finish', reason: { kind: 'error' } },
    ]),
  });
  const result = await translator.translate('今天天气很好。', { from: 'zh', to: 'ja' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TRANSLATE_INCOMPLETE');
  assert.equal(result.text, '');
  assert.equal(result.cached, false);
  assert.equal(cache.size, 0, 'a partial translation is never cached');
  assert.ok(events.some((event) => event.type === 'voice.translate.failed'
    && event.code === 'TRANSLATE_INCOMPLETE'));

  const prepared = await prepareSpeech('今天天气很好。', { translator, speechLang: 'ja' });
  assert.equal(prepared.ok, false);
  assert.equal(prepared.fallback, true);
  assert.equal(prepared.speechText, '今天天气很好。', 'the half translation is never spoken');
  assert.equal(prepared.speechLang, 'zh');
});

test('18. the token cap without a normal finish is also incomplete', async () => {
  const cache = createTranslationCache();
  const translator = createTranslator({
    cache,
    maxTokens: 8,
    request: async () => chunkStream([
      { type: 'text-delta', text: '今日はいい' },
      { type: 'usage', usage: { outputTokens: 8 } },
    ]),
  });
  const result = await translator.translate('今天天气很好。', { from: 'zh', to: 'ja' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TRANSLATE_INCOMPLETE');
  assert.equal(cache.size, 0);
});

test('19. a Chinese line quoting one Japanese word is still translated as Chinese', async () => {
  const text = '今天学会了「ありがとう」，真开心。';
  assert.equal(detectLanguage(text), 'zh', 'one kana run inside a Han line is a foreign word');
  const calls = [];
  const translator = {
    async translate(value, { from, to } = {}) {
      calls.push({ value, from, to });
      return { ok: true, text: '今日は「ありがとう」を覚えて、とても嬉しいです。', cached: false, ms: 1 };
    },
  };
  const prepared = await prepareSpeech(text, { speechLang: 'ja', translator });
  assert.equal(calls.length, 1, 'the line is not skipped because it contains kana');
  assert.equal(calls[0].from, 'zh');
  assert.equal(calls[0].to, 'ja');
  assert.equal(prepared.translated, true);
  assert.equal(prepared.speechLang, 'ja');

  // The explicit source language always wins over the heuristic.
  calls.length = 0;
  const explicit = await prepareSpeech(text, { speechLang: 'en', textLang: 'zh', translator });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].from, 'zh');
  assert.equal(calls[0].to, 'en');
  assert.equal(explicit.translated, true);
});

test('20. 「了解」→「了解です。」 is a translation, not TRANSLATE_UNCHANGED', async () => {
  const translator = createTranslator({ jaSpeechScript: 'mixed', request: async () => '了解です。' });
  const result = await translator.translate('了解', { from: 'zh', to: 'ja' });
  assert.equal(result.ok, true, 'keeping the source word does not mean it was not translated');
  assert.equal(result.code, undefined);
  assert.equal(result.text, '了解です。');
});

test('21. an almost-identical answer is still rejected as unchanged', async () => {
  const translator = createTranslator({ request: async () => '今天天气很好。' });
  const result = await translator.translate('今天天气很好。', { from: 'zh', to: 'ja' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TRANSLATE_UNCHANGED');
});

// ---------------------------------------------------------------------------
// 22. The cache is keyed by target language
// ---------------------------------------------------------------------------

test('22. the cache keeps subtitle en and speech ja as two independent entries', async () => {
  const cache = createTranslationCache();
  const seen = [];
  const translator = createTranslator({
    cache,
    request: async ({ messages }) => {
      const prompt = messages[0].content[0].text;
      seen.push(prompt);
      return prompt.includes('英语') ? 'Hello.' : 'やあ こんにちは。';
    },
  });
  const en = await translator.translate('你好。', { from: 'zh', to: 'en' });
  const ja = await translator.translate('你好。', { from: 'zh', to: 'ja' });
  assert.equal(en.ok, true);
  assert.equal(ja.ok, true);
  assert.equal(cache.size, 2, 'one cache entry per target language');
  const enAgain = await translator.translate('你好。', { from: 'zh', to: 'en' });
  const jaAgain = await translator.translate('你好。', { from: 'zh', to: 'ja' });
  assert.equal(enAgain.cached, true);
  assert.equal(jaAgain.cached, true);
  assert.equal(seen.length, 2, 'each stream hits its own cache entry');
  assert.notEqual(
    translationKey({ from: 'zh', to: 'en', text: '你好。' }),
    translationKey({ from: 'zh', to: 'ja', text: '你好。' }),
    'the key binds the target language',
  );
});

// ---------------------------------------------------------------------------
// 23-26. Only a complete answer may be cached
// ---------------------------------------------------------------------------

test('23. a stream with text-delta but no finish is incomplete and never cached', async () => {
  const cache = createTranslationCache();
  const events = [];
  const translator = createTranslator({
    cache,
    onEvent: (type, payload) => events.push({ type, ...payload }),
    request: async () => chunkStream([{ type: 'text-delta', text: 'きょう は いい おてんき です ね。' }]),
  });
  const result = await translator.translate('今天天气很好。', { from: 'zh', to: 'ja' });
  assert.equal(result.ok, false, 'a stream that just stops never counts as success');
  assert.equal(result.code, 'TRANSLATE_INCOMPLETE');
  assert.equal(result.text, '');
  assert.equal(cache.size, 0, 'an unfinished stream never reaches the cache');
  assert.ok(events.some((event) => event.type === 'voice.translate.failed'
    && event.code === 'TRANSLATE_INCOMPLETE'));
  const spoken = await prepareSpeech('今天天气很好。', { translator, speechLang: 'ja' });
  assert.equal(spoken.fallback, true, 'the half line is never spoken');
  assert.equal(spoken.speechLang, 'zh');
});

test('24. a structured result with finishReason:length is incomplete too', async () => {
  const cache = createTranslationCache();
  const translator = createTranslator({
    cache,
    request: async () => ({ text: '今日はいい', finishReason: 'length', truncated: true }),
  });
  const result = await translator.translate('今天天气很好。', { from: 'zh', to: 'ja' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TRANSLATE_INCOMPLETE');
  assert.equal(result.text, '');
  assert.equal(cache.size, 0, 'the object branch keeps and checks its finish metadata');
});

test('25. a structured result with finishReason:stop is complete and cached', async () => {
  const cache = createTranslationCache();
  let calls = 0;
  const translator = createTranslator({
    cache,
    request: async () => {
      calls += 1;
      return { text: 'きょう は いい おてんき です ね。', finishReason: 'stop' };
    },
  });
  const first = await translator.translate('今天天气很好。', { from: 'zh', to: 'ja' });
  assert.equal(first.ok, true);
  assert.equal(first.text, 'きょう は いい おてんき です ね。');
  assert.equal(cache.size, 1, 'a complete structured answer is cached');
  const second = await translator.translate('今天天气很好。', { from: 'zh', to: 'ja' });
  assert.equal(second.cached, true);
  assert.equal(calls, 1);
});

test('26. a stream that ends with finish:stop is complete and cached', async () => {
  const cache = createTranslationCache();
  const translator = createTranslator({
    cache,
    request: async () => chunkStream([
      { type: 'text-delta', text: 'きょう は いい' },
      { type: 'text-delta', text: ' おてんき です ね。' },
      { type: 'finish', reason: 'stop' },
    ]),
  });
  const result = await translator.translate('今天天气很好。', { from: 'zh', to: 'ja' });
  assert.equal(result.ok, true);
  assert.equal(result.text, 'きょう は いい おてんき です ね。');
  assert.equal(cache.size, 1, 'the finished translation is cached');
});

// ---------------------------------------------------------------------------
// 27-28. The mounted assistant_say path runs the subtitle stream too
// ---------------------------------------------------------------------------

test('27. mounted assistant_say: langs.subtitle=en repaints the caption, the voice stays speech-language', async (t) => {
  const app = await mountHost(t, { speech: 'ja', subtitle: 'en', subtitleVisible: true });
  // No explicit `subtitle` argument: the caption is the tool text itself.
  // The speech event proves the accepted clip really reached the player, which is what the old
  // synchronous `spoken:true` reported; the caption repaint below proves the caption stream ran.
  const result = await app.tools.get('assistant_say').execute({ text: '今天天气很好。' }, {});
  assert.equal(result.accepted, true, 'the call is accepted; playback runs in the background');
  await waitUntil(
    async () => (await readEvents(app.root)).some(
      (event) => event.type === 'speech.play.start' && event.payload?.speechId === result.speechId,
    ),
    'the accepted speech reached the player',
  );
  await waitUntil(() => hostState.players.length === 1, 'the clip reached the fake player');
  await waitUntil(
    () => hostState.subtitles.some((entry) => entry.text === 'The weather is nice today.'),
    'the translated caption repainted the live line',
  );
  assert.equal(hostState.subtitles[0].text, '今天天气很好。', 'the original line paints first');
  assert.equal(hostState.subtitles.at(-1).text, 'The weather is nice today.', 'the caption ends in English');
  // Two streams, two targets: the subtitle never borrowed the speech language.
  assert.equal(app.edge.length, 1, 'one clip');
  assert.equal(app.edge[0].text, 'きょう は いい おてんき です ね。', 'TTS speaks the speech-language translation');
  assert.equal(app.edge[0].voice, 'ja-JP-NanamiNeural', 'the voice follows langs.speech');
  const events = await readEvents(app.root);
  assert.ok(events.some((event) => event.type === 'voice.translate' && event.payload.to === 'en'),
    'the subtitle stream really translated into langs.subtitle');
  assert.ok(events.some((event) => event.type === 'voice.translate' && event.payload.to === 'ja'),
    'the speech stream translated into langs.speech');
});

test('28. mounted assistant_say: a failed subtitle stream keeps the original caption; the voice is unaffected', async (t) => {
  const app = await mountHost(t, {
    speech: 'ja', subtitle: 'en', subtitleVisible: true, captionFails: true,
  });
  const result = await app.tools.get('assistant_say').execute({ text: '今天天气很好。' }, {});
  assert.equal(result.accepted, true, 'the call is accepted; playback runs in the background');
  await waitUntil(
    async () => (await readEvents(app.root)).some(
      (event) => event.type === 'speech.play.start' && event.payload?.speechId === result.speechId,
    ),
    'the accepted speech reached the player',
  );
  await waitUntil(() => hostState.players.length === 1, 'the clip reached the fake player');
  await waitUntil(
    async () => (await readEvents(app.root)).some((event) => event.type === 'voice.subtitle.fallback'),
    'the subtitle failure is logged',
  );
  assert.equal(hostState.subtitles.at(-1).text, '今天天气很好。', 'the original line stays the subtitle');
  assert.ok(hostState.subtitles.every((entry) => !/[A-Za-z]/u.test(entry.text)),
    'the half English translation is never shown');
  assert.equal(app.edge[0].text, 'きょう は いい おてんき です ね。', 'speech still gets its full translation');
  assert.equal(app.edge[0].voice, 'ja-JP-NanamiNeural');
  const fallback = (await readEvents(app.root)).find((event) => event.type === 'voice.subtitle.fallback');
  assert.equal(fallback.payload.code, 'TRANSLATE_INCOMPLETE');
  assert.equal(fallback.payload.from, 'zh');
  assert.equal(fallback.payload.to, 'en');
});

// ---------------------------------------------------------------------------
// 29-45. Japanese speech script: sentence validation, one targeted repair, A/B modes
// ---------------------------------------------------------------------------

const HAN_CHAR = /[\u3400-\u4dbf\u4e00-\u9fff]/u;
/** A speech-ready kana + 分かち書き sentence that must never be sent back. */
const GOOD_JA = 'きょう は いい おてんき です ね。';
/** A Han sentence the model left in; it must be repaired. */
const HAN_JA = '今日はご飯を食べに行きましょう。';
/** What the repair round must turn it into: kana only, words separated. */
const HAN_JA_FIXED = 'きょう は ごはん を たべ に いきましょう。';
/** One good sentence + one offending sentence in the same line. */
const MIXED_LINE = GOOD_JA + HAN_JA;
const MIXED_FIXED = GOOD_JA + HAN_JA_FIXED;

test('29. per-sentence check finds the Han sentence and repairs only that sentence', async () => {
  const cache = createTranslationCache();
  const requests = [];
  const events = [];
  const translator = createTranslator({
    cache,
    onEvent: (type, payload) => events.push({ type, ...payload }),
    request: async ({ system, messages }) => {
      requests.push({ system, text: messages[0].content[0].text });
      return requests.length === 1 ? MIXED_LINE : HAN_JA_FIXED;
    },
  });
  const result = await translator.translate('今天天气很好。我们去吃饭吧。', { from: 'zh', to: 'ja' });
  assert.equal(result.ok, true);
  assert.equal(result.text, MIXED_FIXED);
  assert.equal(cache.size, 1);
  assert.equal(requests.length, 2, 'one first round + exactly one repair round');
  const repair = requests[1];
  assert.match(requests[0].system, /译文只能使用平假名、片假名、长音符「ー」与标点/u,
    'the first round carries the kana-only rule');
  assert.match(requests[0].system, /不得出现任何汉字/u);
  assert.match(requests[0].system, /分かち書き/u, 'the first round asks for word spaces');
  assert.ok(repair.text.includes(HAN_JA), 'the failing sentence goes back to the model');
  assert.ok(!repair.text.includes(GOOD_JA), 'the good sentence is never re-translated');
  assert.match(repair.system, /不得出现任何汉字/u);
  assert.match(repair.system, /分かち書き/u, 'the repair round carries the same rule');
  const event = events.find((entry) => entry.type === 'voice.translate.repair');
  assert.ok(event !== undefined, 'the repair round is observable');
  assert.deepEqual(event.sentences, [HAN_JA], 'the event names the offending sentence');
});

test('30. the repaired line is fully kana + 分かち書き and is what the cache keeps', async () => {
  let calls = 0;
  const cache = createTranslationCache();
  const translator = createTranslator({
    cache,
    request: async () => {
      calls += 1;
      return calls === 1 ? MIXED_LINE : HAN_JA_FIXED;
    },
  });
  const first = await translator.translate('今天天气很好。我们去吃饭吧。', { from: 'zh', to: 'ja' });
  assert.equal(first.ok, true);
  assert.equal(first.text, MIXED_FIXED);
  assert.equal(findInvalidJapaneseSentences(first.text).length, 0,
    'no sentence keeps Han or misses word spaces');
  assert.equal(calls, 2, 'one first round + one repair');
  const second = await translator.translate('今天天气很好。我们去吃饭吧。', { from: 'zh', to: 'ja' });
  assert.equal(second.cached, true);
  assert.equal(second.text, MIXED_FIXED, 'the cache keeps the repaired line');
  assert.equal(calls, 2, 'the cached call does not reach the model');
});

test('31. a repair that still contains Han fails the whole line and speaks the source language', async () => {
  const cache = createTranslationCache();
  const events = [];
  let calls = 0;
  const translator = createTranslator({
    cache,
    onEvent: (type, payload) => events.push({ type, ...payload }),
    request: async () => {
      calls += 1;
      return calls === 1 ? MIXED_LINE : HAN_JA;
    },
  });
  const result = await translator.translate('今天天气很好。我们去吃饭吧。', { from: 'zh', to: 'ja' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TRANSLATE_NOT_KANA');
  assert.equal(result.text, '');
  assert.equal(cache.size, 0, 'a Han-bearing line is never cached');
  assert.equal(calls, 2, 'the repair round really ran');
  assert.ok(events.some((event) => event.type === 'voice.translate.repair'));
  assert.ok(events.some((event) => event.type === 'voice.translate.failed'
    && event.code === 'TRANSLATE_NOT_KANA'), 'the failure code is observable');

  const prepared = await prepareSpeech('今天天气很好。我们去吃饭吧。', { translator, speechLang: 'ja' });
  assert.equal(prepared.ok, false);
  assert.equal(prepared.fallback, true);
  assert.equal(prepared.speechLang, 'zh', 'the source language is synthesized, not ja');
  assert.equal(prepared.speechText, '今天天气很好。我们去吃饭吧。', 'never a Han-bearing Japanese clip');
  assert.notEqual(prepared.speechLang, 'ja');
});

test('32. pure kana + 分かち書き passes without any repair round', async () => {
  let calls = 0;
  const events = [];
  const translator = createTranslator({
    onEvent: (type, payload) => events.push({ type, ...payload }),
    request: async () => {
      calls += 1;
      return 'にほんご の べんきょう を して います。きょう は いい おてんき です ね。';
    },
  });
  const result = await translator.translate('我在学日语。今天天气很好。', { from: 'zh', to: 'ja' });
  assert.equal(result.ok, true);
  assert.equal(calls, 1, 'valid kana is never sent back');
  assert.equal(result.text, 'にほんご の べんきょう を して います。きょう は いい おてんき です ね。');
  assert.equal(findInvalidJapaneseSentences(result.text).length, 0, 'kana + spaces is speech-ready');
  assert.ok(!events.some((event) => event.type === 'voice.translate.repair'));
});

test('33. a Han-only answer (「了解」) is not kana and fails after the repair round', async () => {
  const cache = createTranslationCache();
  const events = [];
  const translator = createTranslator({
    cache,
    onEvent: (type, payload) => events.push({ type, ...payload }),
    request: async () => '了解',
  });
  const result = await translator.translate('收到。', { from: 'zh', to: 'ja' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TRANSLATE_NOT_KANA', 'pure Han is not a kana reading');
  assert.equal(cache.size, 0);
  const repair = events.find((event) => event.type === 'voice.translate.repair');
  assert.deepEqual(repair.sentences, ['了解'], 'the bare Han sentence was the offender');
});

test('34. one repair round covers every offending sentence at once', async () => {
  const requests = [];
  const events = [];
  const translator = createTranslator({
    onEvent: (type, payload) => events.push({ type, ...payload }),
    request: async ({ messages }) => {
      requests.push(messages[0].content[0].text);
      return requests.length === 1
        ? 'おはよう ございます。我们走吧。吃饭了吗？では また。'
        : 'さあ いきましょう。\nごはん は たべました か？';
    },
  });
  const result = await translator.translate('你好。我们走吧。吃饭了吗？再见。', { from: 'zh', to: 'ja' });
  assert.equal(requests.length, 2, 'a single repair request for both sentences');
  assert.equal(result.ok, true);
  const event = events.find((entry) => entry.type === 'voice.translate.repair');
  assert.deepEqual(event.sentences, ['我们走吧。', '吃饭了吗？']);
  assert.equal(result.text, 'おはよう ございます。さあ いきましょう。ごはん は たべました か？では また。');
  assert.equal(findInvalidJapaneseSentences(result.text).length, 0);
});

test('35. default kanaSpaced: no Han, kana present, at least one word space', async () => {
  const cache = createTranslationCache();
  const requests = [];
  const translator = createTranslator({
    cache,
    request: async (options) => {
      requests.push(options);
      return GOOD_JA;
    },
  });
  assert.equal(translator.jaSpeechScript, 'kanaSpaced', 'the default script');
  const result = await translator.translate('今天天气很好。', { from: 'zh', to: 'ja' });
  assert.equal(result.ok, true);
  assert.equal(result.text, GOOD_JA);
  assert.doesNotMatch(result.text, HAN_CHAR, 'no Han in the speech text');
  assert.match(result.text, /[\u3040-\u30ff]/u, 'kana is present');
  assert.match(result.text, /[ \u3000]/u, 'words are separated');
  assert.equal(cache.size, 1);
  assert.equal(requests.length, 1, 'no repair round for speech-ready kana');
  assert.match(requests[0].system, /译文只能使用平假名、片假名、长音符「ー」与标点/u);
  assert.match(requests[0].system, /不得出现任何汉字/u);
  assert.match(requests[0].system, /分かち書き/u);
});

test("36. the user example '今日はいい天気ですね' is repaired to spaced kana", async () => {
  const requests = [];
  const events = [];
  const translator = createTranslator({
    onEvent: (type, payload) => events.push({ type, ...payload }),
    request: async ({ system, messages }) => {
      requests.push({ system, text: messages[0].content[0].text });
      return requests.length === 1 ? '今日はいい天気ですね' : 'きょう は いい てんき です ね';
    },
  });
  const result = await translator.translate('今天天气很好。', { from: 'zh', to: 'ja' });
  assert.equal(result.ok, true);
  assert.equal(result.text, 'きょう は いい てんき です ね', 'the repaired reading');
  assert.doesNotMatch(result.text, HAN_CHAR, 'no Han');
  assert.doesNotMatch(result.text, /[A-Za-z]/u, 'no latin');
  assert.match(result.text, /[ \u3000]/u, 'word spaces');
  assert.equal(requests.length, 2, 'the Han answer was sent back once');
  assert.ok(requests[1].text.includes('今日はいい天気ですね'), 'the exact Han sentence is repaired');
  assert.match(requests[1].system, /分かち書き/u);
  const event = events.find((entry) => entry.type === 'voice.translate.repair');
  assert.deepEqual(event.sentences, ['今日はいい天気ですね']);
});

test('37. a successful repair is all-kana, spaced, and the repaired line is cached', async () => {
  const cache = createTranslationCache();
  let calls = 0;
  const translator = createTranslator({
    cache,
    request: async () => {
      calls += 1;
      return calls === 1 ? '今日はいい天気ですね。' : 'きょう は いい てんき です ね。';
    },
  });
  const first = await translator.translate('今天天气很好。', { from: 'zh', to: 'ja' });
  assert.equal(first.ok, true);
  assert.equal(first.text, 'きょう は いい てんき です ね。');
  assert.doesNotMatch(first.text, HAN_CHAR);
  assert.match(first.text, /[ \u3000]/u);
  assert.equal(cache.size, 1);
  const second = await translator.translate('今天天气很好。', { from: 'zh', to: 'ja' });
  assert.equal(second.cached, true);
  assert.equal(second.text, first.text, 'the repaired line is what the cache serves');
  assert.equal(calls, 2);
});

test('38. continuous kana without spaces fails and ends in TRANSLATE_NOT_KANA', async () => {
  const cache = createTranslationCache();
  const events = [];
  const unspaced = 'きょうはいいおてんきですね。';
  const translator = createTranslator({
    cache,
    onEvent: (type, payload) => events.push({ type, ...payload }),
    request: async () => unspaced,
  });
  const result = await translator.translate('今天天气很好。', { from: 'zh', to: 'ja' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TRANSLATE_NOT_KANA', 'kana with no word space is not speech-ready');
  assert.equal(cache.size, 0);
  assert.ok(events.some((event) => event.type === 'voice.translate.repair'));
  assert.ok(events.some((event) => event.type === 'voice.translate.failed'
    && event.code === 'TRANSLATE_NOT_KANA'));

  const prepared = await prepareSpeech('今天天气很好。', { translator, speechLang: 'ja' });
  assert.equal(prepared.ok, false);
  assert.equal(prepared.fallback, true);
  assert.equal(prepared.speechLang, 'zh');
  assert.equal(prepared.speechText, '今天天气很好。', 'the unspaced line is never synthesized');

  // The single space `sanitizeTranslation` inserts between model lines is not 分かち書き either.
  const multiline = createTranslator({
    request: async () => 'きょうはいいおてんきですね。\nあしたもいいおてんきですね。',
  });
  const joined = await multiline.translate('今天天气很好。', { from: 'zh', to: 'ja' });
  assert.equal(joined.code, 'TRANSLATE_NOT_KANA', 'a line-join space does not count as a word space');
});

test('39. zh/en targets keep the old rules: no Han/space check and no repair round', async () => {
  const calls = [];
  const translator = createTranslator({
    request: async ({ system, messages }) => {
      calls.push({ system, text: messages[0].content[0].text });
      return calls.length === 1 ? '你好。' : 'Hello.';
    },
  });
  const zh = await translator.translate('こんにちは。', { from: 'ja', to: 'zh' });
  assert.equal(zh.ok, true);
  assert.equal(zh.text, '你好。', 'Han is expected output for Chinese');
  const en = await translator.translate('今天天气很好。', { from: 'zh', to: 'en' });
  assert.equal(en.ok, true);
  assert.equal(en.text, 'Hello.');
  assert.equal(calls.length, 2, 'no repair round for zh/en');
  assert.ok(!calls[0].system.includes('分かち書き'));
  assert.ok(!calls[1].system.includes('不得出现任何汉字'));
  assert.ok(!translationPrompt({ from: 'zh', to: 'en' }).system.includes('分かち書き'));
});

test('40. a rules-version bump makes the old cache entry miss', async () => {
  const cache = createTranslationCache();
  let calls = 0;
  const request = async () => {
    calls += 1;
    return GOOD_JA;
  };
  const older = createTranslator({ cache, rulesVersion: TRANSLATE_RULES_VERSION - 1, request });
  const current = createTranslator({ cache, request });
  assert.equal(current.rulesVersion, TRANSLATE_RULES_VERSION);
  const first = await older.translate('今天天气很好。', { from: 'zh', to: 'ja' });
  const second = await current.translate('今天天气很好。', { from: 'zh', to: 'ja' });
  assert.equal(first.cached, false);
  assert.equal(second.cached, false, 'the new revision does not reuse the old entry');
  assert.equal(calls, 2);
  assert.equal(cache.size, 2);
});

test('41. mixed script keeps kanji + kana and the old TRANSLATE_NOT_JAPANESE failure', async () => {
  const cache = createTranslationCache();
  const translator = createTranslator({
    cache,
    jaSpeechScript: 'mixed',
    request: async () => '今日はいい天気ですね。',
  });
  assert.equal(translator.jaSpeechScript, 'mixed');
  const result = await translator.translate('今天天气很好。', { from: 'zh', to: 'ja' });
  assert.equal(result.ok, true);
  assert.equal(result.text, '今日はいい天気ですね。');
  assert.equal(cache.size, 1);
  assert.match(translationPrompt({ from: 'zh', to: 'ja', jaSpeechScript: 'mixed' }).system,
    /允许假名与汉字混合/u, 'mixed keeps the historical prompt');

  const failing = createTranslator({ jaSpeechScript: 'mixed', request: async () => '今日天气很好' });
  const failed = await failing.translate('今天天气很好。', { from: 'zh', to: 'ja' });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'TRANSLATE_NOT_JAPANESE', 'mixed keeps the historical failure code');
});

test('42. kana script accepts continuous kana but still rejects any Han', async () => {
  const cache = createTranslationCache();
  const translator = createTranslator({
    cache,
    jaSpeechScript: 'kana',
    request: async () => 'きょうはいいおてんきですね。',
  });
  assert.equal(translator.jaSpeechScript, 'kana');
  const result = await translator.translate('今天天气很好。', { from: 'zh', to: 'ja' });
  assert.equal(result.ok, true);
  assert.equal(result.text, 'きょうはいいおてんきですね。');
  assert.doesNotMatch(result.text, /[ \u3000]/u, 'kana needs no word spaces');

  const requests = [];
  const han = createTranslator({
    jaSpeechScript: 'kana',
    request: async ({ system, messages }) => {
      requests.push({ system, text: messages[0].content[0].text });
      return requests.length === 1 ? '今日はいい天気ですね。' : 'きょうはいいおてんきですね。';
    },
  });
  const fixed = await han.translate('今天天气很好。', { from: 'zh', to: 'ja' });
  assert.equal(fixed.ok, true);
  assert.equal(fixed.text, 'きょうはいいおてんきですね。');
  assert.equal(requests.length, 2, 'Han triggers exactly one repair');
  assert.match(requests[0].system, /不得出现任何汉字/u);
  assert.ok(!requests[0].system.includes('分かち書き'), 'kana mode does not ask for spaces');
});

test('43. kanaSpaced accepts a full-width word space as 分かち書き', async () => {
  const text = 'きょう\u3000は\u3000いい\u3000おてんき\u3000です\u3000ね。';
  const translator = createTranslator({ request: async () => text });
  assert.equal(translator.jaSpeechScript, 'kanaSpaced');
  const result = await translator.translate('今天天气很好。', { from: 'zh', to: 'ja' });
  assert.equal(result.ok, true);
  assert.equal(result.text, text);
  assert.match(result.text, /\u3000/u);
  assert.doesNotMatch(result.text, HAN_CHAR);
});

test('44. the three scripts never share a cache entry for the same source', async () => {
  const cache = createTranslationCache();
  let calls = 0;
  const outputs = {
    mixed: '今日はいい天気ですね。',
    kana: 'きょうはいいおてんきですね。',
    kanaSpaced: GOOD_JA,
  };
  const translators = {};
  for (const mode of ['mixed', 'kana', 'kanaSpaced']) {
    translators[mode] = createTranslator({
      cache,
      jaSpeechScript: mode,
      request: async () => {
        calls += 1;
        return outputs[mode];
      },
    });
  }
  const text = '今天天气很好。';
  const mixed = await translators.mixed.translate(text, { from: 'zh', to: 'ja' });
  const kana = await translators.kana.translate(text, { from: 'zh', to: 'ja' });
  const spaced = await translators.kanaSpaced.translate(text, { from: 'zh', to: 'ja' });
  assert.equal(calls, 3, 'each script reached the model once');
  assert.equal(mixed.cached, false);
  assert.equal(kana.cached, false);
  assert.equal(spaced.cached, false);
  assert.equal(cache.size, 3, 'one cache entry per script');
  const again = await translators.kana.translate(text, { from: 'zh', to: 'ja' });
  assert.equal(again.cached, true);
  assert.equal(calls, 3, 'the hit does not reach the model');
  assert.notEqual(
    translationKey({ from: 'zh', to: 'ja', text, jaSpeechScript: 'mixed' }),
    translationKey({ from: 'zh', to: 'ja', text, jaSpeechScript: 'kanaSpaced' }),
    'the key binds the speech script',
  );
});

test('45. an unknown script falls back to kanaSpaced', async () => {
  assert.equal(normalizeJaSpeechScript('bogus'), 'kanaSpaced');
  assert.equal(normalizeJaSpeechScript(undefined), 'kanaSpaced');
  assert.equal(normalizeJaSpeechScript(' kana '), 'kana');
  const translator = createTranslator({ jaSpeechScript: 'nope', request: async () => GOOD_JA });
  assert.equal(translator.jaSpeechScript, 'kanaSpaced');
  const result = await translator.translate('今天天气很好。', { from: 'zh', to: 'ja' });
  assert.equal(result.ok, true);
  const unspaced = createTranslator({
    jaSpeechScript: 'nope',
    request: async () => 'きょうはいいおてんきですね。',
  });
  const failed = await unspaced.translate('今天天气很好。', { from: 'zh', to: 'ja' });
  assert.equal(failed.code, 'TRANSLATE_NOT_KANA', 'the fallback really enforces 分かち書き');
});

// ---------------------------------------------------------------------------
// 46-50. Short answers are legal; subtitle and speech purposes are separated
// ---------------------------------------------------------------------------

test('46. a short answer passes kanaSpaced without word spaces and needs no repair round', async () => {
  // One-word replies have no word boundary to mark, so they are legal as-is.
  for (const short of ['はい。', 'いいえ。', 'そうですね。']) {
    assert.equal(findInvalidJapaneseSentences(short).length, 0, `${short} is a legal short answer`);
  }
  const requests = [];
  const events = [];
  const cache = createTranslationCache();
  const translator = createTranslator({
    cache,
    onEvent: (type, payload) => events.push({ type, ...payload }),
    request: async (options) => {
      requests.push(options);
      return 'はい。';
    },
  });
  const result = await translator.translate('好的。', { from: 'zh', to: 'ja' });
  assert.equal(result.ok, true, 'the short answer is not rejected');
  assert.equal(result.text, 'はい。');
  assert.equal(requests.length, 1, 'no repair request: the two-round path becomes one');
  assert.ok(!events.some((event) => event.type === 'voice.translate.repair'), 'no repair round ran');
  assert.equal(cache.size, 1);
  const again = await translator.translate('好的。', { from: 'zh', to: 'ja' });
  assert.equal(again.cached, true);
  assert.equal(requests.length, 1, 'the cached short answer does not reach the model');
});

test('47. the long-sentence rule is not relaxed: kana without 分かち書き still fails', async () => {
  const unspaced = 'きょうはいいおてんきですね。'; // 13 kana: multi-word, must be spaced
  assert.equal(findInvalidJapaneseSentences(unspaced).length, 1, 'the long line is still an offender');
  const requests = [];
  const cache = createTranslationCache();
  const translator = createTranslator({
    cache,
    request: async ({ messages }) => {
      requests.push(messages[0].content[0].text);
      return unspaced;
    },
  });
  const result = await translator.translate('今天天气很好。', { from: 'zh', to: 'ja' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TRANSLATE_NOT_KANA');
  assert.equal(requests.length, 2, 'the long sentence still goes back for one repair round');
  assert.ok(requests[1].includes(unspaced), 'the unspaced sentence is the offender');
  assert.equal(cache.size, 0, 'the still-unspaced line is never cached');
  const prepared = await prepareSpeech('今天天气很好。', { translator, speechLang: 'ja' });
  assert.equal(prepared.fallback, true, 'the unspaced line falls back to the source language');
  assert.equal(prepared.speechLang, 'zh');
});

test("48. purpose 'subtitle' keeps normal Japanese writing (kanji allowed), not kana + spaces", async () => {
  const requests = [];
  const translator = createTranslator({
    request: async (options) => {
      requests.push(options);
      return '今日はいい天気ですね。';
    },
  });
  const result = await translator.translate('今天天气很好。', { from: 'zh', to: 'ja', purpose: 'subtitle' });
  assert.equal(result.ok, true);
  assert.equal(result.text, '今日はいい天気ですね。', 'the subtitle is normal Japanese writing');
  assert.match(result.text, HAN_CHAR, 'a subtitle is allowed (and expected) to keep kanji');
  assert.doesNotMatch(result.text, /[ \u3000]/u, 'a subtitle is not 分かち書き');
  assert.equal(requests.length, 1, 'the mixed subtitle rule needs no repair round');
  assert.match(requests[0].system, /允许假名与汉字混合/u, 'the subtitle prompt uses the mixed rule');
  assert.ok(!requests[0].system.includes('分かち書き'), 'the subtitle prompt never asks for word spaces');
  assert.ok(!requests[0].system.includes('不得出现任何汉字'), 'the subtitle prompt never bans kanji');
});

test("49. purpose 'speech' (and the default) yields kana + word spaces, not mixed writing", async () => {
  const requests = [];
  const translator = createTranslator({
    request: async (options) => {
      requests.push(options);
      return GOOD_JA;
    },
  });
  assert.equal(normalizeTranslatePurpose(undefined), 'speech', 'speech is the default purpose');
  assert.equal(normalizeTranslatePurpose('bogus'), 'speech');
  const result = await translator.translate('今天天气很好。', { from: 'zh', to: 'ja', purpose: 'speech' });
  assert.equal(result.ok, true);
  assert.equal(result.text, GOOD_JA);
  assert.doesNotMatch(result.text, HAN_CHAR, 'the speech text has no Han');
  assert.match(result.text, /[ \u3000]/u, 'the speech text is 分かち書き');
  assert.match(requests[0].system, /分かち書き/u, 'the speech prompt asks for word spaces');
  assert.ok(!requests[0].system.includes('允许假名与汉字混合'), 'the speech prompt never offers mixed writing');
  const byDefault = await translator.translate('今天天气很好。', { from: 'zh', to: 'ja' });
  assert.equal(byDefault.cached, true, 'an omitted purpose is the speech entry');
  assert.equal(requests.length, 1);
});

test('50. the cache key binds the purpose: speech and subtitle never share an entry', async () => {
  const cache = createTranslationCache();
  const prompts = [];
  const translator = createTranslator({
    cache,
    request: async ({ system }) => {
      prompts.push(system);
      return system.includes('允许假名与汉字混合') ? '今日はいい天気ですね。' : GOOD_JA;
    },
  });
  const text = '今天天气很好。';
  const speech = await translator.translate(text, { from: 'zh', to: 'ja', purpose: 'speech' });
  const subtitle = await translator.translate(text, { from: 'zh', to: 'ja', purpose: 'subtitle' });
  assert.equal(speech.text, GOOD_JA, 'speech keeps kana + 分かち書き');
  assert.equal(subtitle.text, '今日はいい天気ですね。', 'the subtitle keeps normal Japanese');
  assert.equal(prompts.length, 2, 'each purpose reached the model once');
  assert.equal(cache.size, 2, 'one cache entry per purpose');
  assert.notEqual(
    translationKey({ from: 'zh', to: 'ja', text, purpose: 'speech' }),
    translationKey({ from: 'zh', to: 'ja', text, purpose: 'subtitle' }),
    'the key binds the purpose',
  );
  assert.equal(
    translationKey({ from: 'zh', to: 'ja', text }),
    translationKey({ from: 'zh', to: 'ja', text, purpose: 'speech' }),
    'an omitted purpose is the speech key',
  );
  const speechAgain = await translator.translate(text, { from: 'zh', to: 'ja', purpose: 'speech' });
  const subtitleAgain = await translator.translate(text, { from: 'zh', to: 'ja', purpose: 'subtitle' });
  assert.equal(speechAgain.cached, true);
  assert.equal(subtitleAgain.cached, true);
  assert.equal(speechAgain.text, GOOD_JA, 'the speech hit serves the speech form');
  assert.equal(subtitleAgain.text, '今日はいい天気ですね。', 'the subtitle hit serves the subtitle form');
  assert.equal(prompts.length, 2, 'a hit never reaches the model');

  // The two outlets name their purpose, so the mounted host gets the separation for free.
  const seen = [];
  const recorder = {
    async translate(value, options = {}) {
      seen.push(options.purpose);
      return { ok: true, text: value === text ? GOOD_JA : value, cached: false, ms: 1 };
    },
  };
  await prepareCaption(text, { captionLang: 'ja', textLang: 'zh', translator: recorder });
  await prepareSpeech(text, { speechLang: 'ja', textLang: 'zh', translator: recorder });
  assert.deepEqual(seen, ['subtitle', 'speech'], 'each outlet declares its purpose');
});

// ---------------------------------------------------------------------------
// 51-54. A reasoning model that truncates at the token cap: one larger retry
// ---------------------------------------------------------------------------

test('51. a max-tokens truncated first answer retries once with >=8192 and a direct-answer prompt', async () => {
  const requests = [];
  const cache = createTranslationCache();
  let calls = 0;
  const translator = createTranslator({
    cache,
    request: async (options) => {
      requests.push(options);
      calls += 1;
      // The reported scene: the whole first budget went into reasoning, so the body is empty.
      return calls === 1
        ? chunkStream([{ type: 'text-delta', text: '' }, { type: 'finish', reason: 'max-tokens' }])
        : chunkStream([{ type: 'text-delta', text: GOOD_JA }, { type: 'finish', reason: 'stop' }]);
    },
  });
  const result = await translator.translate('今天天气很好。', { from: 'zh', to: 'ja' });
  assert.equal(requests.length, 2, 'exactly one retry, never a third call');
  assert.equal(DEFAULT_TRANSLATE_MAX_TOKENS, 2048, 'the first-request budget was raised from 512');
  assert.equal(requests[0].maxTokens, 2048, 'the first attempt uses the new default budget');
  assert.ok(requests[1].maxTokens >= 8192, 'the truncated retry raises the budget');
  assert.equal(requests[1].maxTokens, 8192, '2048 * 4, clamped to at least 8192');
  assert.ok(requests[1].maxTokens > requests[0].maxTokens);
  assert.match(requests[1].system, /直接输出译文/u, 'the retry asks for the translation directly');
  assert.match(requests[1].system, /不要输出推理过程/u, 'the retry forbids the reasoning that ate the budget');
  assert.match(requests[1].system, /分かち書き/u, 'the retry keeps the same translation rules');
  assert.equal(result.ok, true);
  assert.equal(result.text, GOOD_JA);
  assert.equal(result.cached, false);
  assert.equal(cache.size, 1, 'only the complete retry is cached');
  console.log(`51) calls=${requests.length} maxTokens1=${requests[0].maxTokens} maxTokens2=${requests[1].maxTokens} retryHasDirect=${/直接输出译文/u.test(requests[1].system)} retryHasNoReasoning=${/不要输出推理过程/u.test(requests[1].system)} cacheSize=${cache.size}`);
});

test('52. a complete first answer is never retried; the budget is 2048 by default and configurable', async () => {
  const requests = [];
  const events = [];
  const translator = createTranslator({
    onEvent: (type, payload) => events.push({ type, ...payload }),
    request: async (options) => {
      requests.push(options);
      return { text: GOOD_JA, finishReason: 'stop' };
    },
  });
  const result = await translator.translate('今天天气很好。', { from: 'zh', to: 'ja' });
  assert.equal(result.ok, true);
  assert.equal(requests.length, 1, 'a normal answer is never retried');
  assert.equal(requests[0].maxTokens, DEFAULT_TRANSLATE_MAX_TOKENS);
  assert.ok(!events.some((event) => event.type === 'voice.translate.retry'), 'no retry event without a truncation');

  // `translateMaxTokens` is the settings-facing name: it wins and is not raised on success.
  const configuredRequests = [];
  const configured = createTranslator({
    translateMaxTokens: 1024,
    request: async (options) => {
      configuredRequests.push(options);
      return { text: '今日はいい天気ですね。', finishReason: 'stop' };
    },
  });
  assert.equal(configured.maxTokens, 1024, 'the configured budget is reported');
  const subtitle = await configured.translate('今天天气很好。', { from: 'zh', to: 'ja', purpose: 'subtitle' });
  assert.equal(subtitle.ok, true);
  assert.equal(configuredRequests.length, 1, 'the subtitle purpose follows the same no-retry rule');
  assert.equal(configuredRequests[0].maxTokens, 1024, 'the configured budget reaches the subtitle request');
  assert.match(configuredRequests[0].system, /允许假名与汉字混合/u, 'the subtitle prompt is unchanged');
  console.log(`52) default=${DEFAULT_TRANSLATE_MAX_TOKENS} maxTokens=${requests[0].maxTokens} calls=${requests.length} retries=${events.filter((event) => event.type === 'voice.translate.retry').length} configured=${configuredRequests[0].maxTokens}`);
});

test('53. a retry that is still truncated is TRANSLATE_INCOMPLETE: not cached, both lanes fall back', async () => {
  const cache = createTranslationCache();
  const events = [];
  const budgets = [];
  const translator = createTranslator({
    cache,
    onEvent: (type, payload) => events.push({ type, ...payload }),
    request: async ({ maxTokens }) => {
      budgets.push(maxTokens);
      // A plausible half line that must never be played or cached.
      return chunkStream([
        { type: 'text-delta', text: 'きょう は いい' },
        { type: 'finish', reason: 'max-tokens' },
      ]);
    },
  });
  const result = await translator.translate('今天天气很好。', { from: 'zh', to: 'ja' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TRANSLATE_INCOMPLETE');
  assert.equal(result.text, '');
  assert.equal(result.cached, false);
  assert.equal(cache.size, 0, 'a truncated line never reaches the cache');
  assert.deepEqual(budgets, [2048, 8192], 'the retry raises the budget exactly once');
  assert.ok(events.some((event) => event.type === 'voice.translate.failed'
    && event.code === 'TRANSLATE_INCOMPLETE'), 'the failure stays TRANSLATE_INCOMPLETE');

  const prepared = await prepareSpeech('今天天气很好。', { translator, speechLang: 'ja' });
  assert.equal(prepared.ok, false);
  assert.equal(prepared.fallback, true);
  assert.equal(prepared.speechLang, 'zh', 'the source language is spoken, not ja');
  assert.equal(prepared.speechText, '今天天气很好。', 'the half Japanese line is never spoken');
  const subtitle = await prepareCaption('今天天气很好。', { captionLang: 'ja', textLang: 'zh', translator });
  assert.equal(subtitle.ok, false, 'the subtitle lane obeys the same rule');
  assert.equal(subtitle.code, 'TRANSLATE_INCOMPLETE');
  assert.equal(subtitle.captionText, '今天天气很好。', 'the original caption stays');
  assert.equal(cache.size, 0);
  console.log(`53) code=${result.code} maxTokens=${budgets.slice(0, 2).join('/')} cacheSize=${cache.size} speechFallback=${prepared.fallback} speechLang=${prepared.speechLang} subtitleOk=${subtitle.ok}`);
});

test('54. voice.translate.retry reports the budgets before and after the single retry', async () => {
  const events = [];
  let calls = 0;
  const translator = createTranslator({
    onEvent: (type, payload) => events.push({ type, ...payload }),
    request: async () => {
      calls += 1;
      return calls === 1
        ? chunkStream([{ type: 'finish', reason: 'max_tokens' }])
        : chunkStream([{ type: 'text-delta', text: GOOD_JA }, { type: 'finish', reason: 'stop' }]);
    },
  });
  const result = await translator.translate('今天天气很好。', { from: 'zh', to: 'ja' });
  assert.equal(result.ok, true);
  const retries = events.filter((event) => event.type === 'voice.translate.retry');
  assert.equal(retries.length, 1, 'the retry is logged exactly once');
  assert.deepEqual(retries[0], {
    type: 'voice.translate.retry',
    reason: 'max-tokens',
    from: 2048,
    to: 8192,
  });
  assert.ok(!events.some((event) => event.type === 'voice.translate.retry' && event.reason !== 'max-tokens'));
  console.log(`54) retryEvent=${JSON.stringify({ reason: retries[0].reason, from: retries[0].from, to: retries[0].to })} retries=${retries.length} calls=${calls}`);
});

// ---------------------------------------------------------------------------
// 55-61. The deadline: default 15 s, a fresh clock per attempt, no budget raise on a timeout,
//        parallel sentences, one late sentence that fails alone, and a cancellable queue
// ---------------------------------------------------------------------------

/**
 * A controllable clock: `now` + `timers` are the translator's seams, so a 6 s answer and a 15 s
 * deadline are tested in microseconds instead of real seconds. `advance()` fires due timers in
 * order and flushes promises between them, which is how the translator's own awaits progress.
 */
function fakeClock() {
  let current = 0;
  let sequence = 0;
  const timers = new Map();
  const clock = {
    now: () => current,
    setTimeout(fn, ms = 0) {
      sequence += 1;
      timers.set(sequence, { at: current + Math.max(0, Number(ms) || 0), sequence, fn });
      return sequence;
    },
    clearTimeout(id) { timers.delete(id); },
    async advance(ms) {
      const target = current + Math.max(0, Number(ms) || 0);
      for (;;) {
        let next = null;
        for (const [id, timer] of timers) {
          if (timer.at > target) continue;
          if (next === null || timer.at < next.at || (timer.at === next.at && timer.sequence < next.sequence)) {
            next = { id, ...timer };
          }
        }
        if (next === null) break;
        timers.delete(next.id);
        if (next.at > current) current = next.at;
        next.fn();
        await tick(0);
      }
      current = target;
      await tick(0);
    },
  };
  return clock;
}

/** Advance `clock` in steps until `promise` settles; each step flushes the translator's awaits. */
async function driveClock(clock, promise, { stepMs = 5000, untilMs = 120000 } = {}) {
  let settled = false;
  let value;
  let failure = null;
  promise.then(
    (result) => { value = result; settled = true; },
    (error) => { failure = error; settled = true; },
  );
  await tick(0);
  for (let elapsed = 0; !settled && elapsed <= untilMs; elapsed += stepMs) {
    await clock.advance(stepMs);
  }
  if (failure !== null) throw failure;
  if (!settled) throw new Error('the translation did not settle');
  return value;
}

/** A request that takes `ms` of VIRTUAL time (scheduled on the fake clock). */
const clockDelay = (clock, ms) => new Promise((resolve) => { clock.setTimeout(resolve, ms); });

test('55. the deadline defaults to 15000 ms: a 6 s answer succeeds and translateTimeoutMs configures it', async () => {
  assert.equal(DEFAULT_TRANSLATE_TIMEOUT_MS, 15000, 'the reported 6.0 s misses now have 2.5x the room');
  const clock = fakeClock();
  const calls = [];
  const translator = createTranslator({
    now: clock.now,
    timers: clock,
    request: async ({ maxTokens }) => {
      calls.push({ at: clock.now(), maxTokens });
      await clockDelay(clock, 6000);
      return GOOD_JA;
    },
  });
  assert.equal(translator.timeoutMs, 15000, 'the reported deadline is the new default');
  const result = await driveClock(clock, translator.translate('今天天气很好。', { from: 'zh', to: 'ja' }));
  assert.equal(result.ok, true, 'a 6 s answer is inside the 15 s default');
  assert.equal(result.ms, 6000, 'the request really took 6 s of the virtual clock');
  assert.equal(calls.length, 1, 'no retry: the first answer arrived in time');
  assert.equal(calls[0].maxTokens, 2048);
  assert.equal(translator.cache.size, 1, 'the complete answer is cached');

  // The settings-facing name wins; the code-level name still works.
  assert.equal(createTranslator({ translateTimeoutMs: 20000, request: async () => GOOD_JA }).timeoutMs, 20000);
  assert.equal(createTranslator({ timeoutMs: 250, request: async () => GOOD_JA }).timeoutMs, 250);
  assert.equal(
    createTranslator({ translateTimeoutMs: 20000, timeoutMs: 250, request: async () => GOOD_JA }).timeoutMs,
    20000,
    'translateTimeoutMs is the settings-facing name and wins over timeoutMs',
  );
  console.log(`55) defaultTimeoutMs=${DEFAULT_TRANSLATE_TIMEOUT_MS} configuredTimeoutMs=${translator.timeoutMs} ok=${result.ok} ms=${result.ms} maxTokens=${calls[0].maxTokens} cacheSize=${translator.cache.size}`);
});

test('56. a timed-out first attempt is retried once at the SAME 2048 budget inside the total budget', async () => {
  const clock = fakeClock();
  const events = [];
  const calls = [];
  const translator = createTranslator({
    now: clock.now,
    timers: clock,
    onEvent: (type, payload) => events.push({ type, ...payload }),
    request: async ({ maxTokens, system }) => {
      calls.push({ at: clock.now(), maxTokens, direct: /直接输出译文/u.test(system) });
      // Attempt 1 deliberately ignores the abort: only the deadline can end it. Attempt 2 is a
      // normal answer that fits in what is left of the 20 s total (15 s spent, 5 s left).
      await clockDelay(clock, calls.length === 1 ? 20000 : 3000);
      return GOOD_JA;
    },
  });
  const result = await driveClock(clock, translator.translate('今天天气很好。', { from: 'zh', to: 'ja' }));
  assert.equal(result.ok, true, 'the same-budget retry succeeded inside the total budget');
  assert.deepEqual(calls.map((call) => call.maxTokens), [2048, 2048],
    'the timeout retry KEEPS the 2048 budget instead of raising it to 8192');
  assert.equal(calls[1].at, 15000, 'attempt 2 starts when the 15 s deadline fired');
  assert.equal(calls[1].direct, true, 'the retry asks for the answer directly (reasoning ate the time)');
  assert.equal(result.ms, 18000, 'attempt 2 only got the remaining 5 s of the 20 s total');
  const retries = events.filter((event) => event.type === 'voice.translate.retry');
  assert.deepEqual(retries.map((event) => [event.reason, event.from, event.to]), [['timeout', 2048, 2048]]);
  const failed = events.filter((event) => event.type === 'voice.translate.failed');
  assert.equal(failed.length, 1, 'only the dead first attempt is logged as a failure');
  assert.deepEqual(
    { code: failed[0].code, budgetMs: failed[0].budgetMs, attempt: failed[0].attempt, maxTokens: failed[0].maxTokens },
    { code: 'TRANSLATE_TIMEOUT', budgetMs: 15000, attempt: 1, maxTokens: 2048 },
  );
  console.log(`56) budgets=${calls.map((call) => call.maxTokens).join('/')} retryAtMs=${calls[1].at} retryReason=${retries[0].reason} totalMs=${result.ms} failedEvents=${failed.length} attempt=${failed[0].attempt}/${failed[0].budgetMs}ms ok=${result.ok}`);
});

test('57. both attempts late: TRANSLATE_TIMEOUT with attempt 1/2 and the line falls back to Chinese', async () => {
  const clock = fakeClock();
  const events = [];
  const tokens = [];
  const cache = createTranslationCache();
  const translator = createTranslator({
    cache,
    now: clock.now,
    timers: clock,
    onEvent: (type, payload) => events.push({ type, ...payload }),
    // The reasoning never finishes: only the deadline can end an attempt.
    request: async ({ maxTokens }) => {
      tokens.push(maxTokens);
      return new Promise(() => {});
    },
  });
  const prepared = await driveClock(clock, prepareSpeech('今天天气很好。', {
    translator,
    speechLang: 'ja',
    emit: (type, payload) => events.push({ type, ...payload }),
  }));
  assert.equal(prepared.ok, false);
  assert.equal(prepared.code, 'TRANSLATE_TIMEOUT');
  assert.equal(prepared.fallback, true);
  assert.equal(prepared.speechLang, 'zh', 'Chinese is spoken; an empty Japanese line never is');
  assert.equal(prepared.speechText, '今天天气很好。');
  assert.equal(prepared.translateMs, 20000, 'the ONE 20 s total budget ends the line');
  assert.deepEqual(tokens, [2048, 2048], 'the timeout path never raises 2048 -> 8192');
  assert.equal(cache.size, 0, 'a timed-out line is never cached');
  const failed = events.filter((event) => event.type === 'voice.translate.failed');
  assert.deepEqual(
    failed.map((event) => ({ code: event.code, budgetMs: event.budgetMs, attempt: event.attempt })),
    [
      { code: 'TRANSLATE_TIMEOUT', budgetMs: 15000, attempt: 1 },
      { code: 'TRANSLATE_TIMEOUT', budgetMs: 5000, attempt: 2 },
    ],
    'both late attempts are logged; the retry only had the remaining 5 s',
  );
  assert.ok(events.some((event) => event.type === 'voice.translate.fallback'
    && event.code === 'TRANSLATE_TIMEOUT'), 'the outlet falls back to the source language');
  console.log(`57) code=${prepared.code} fallback=${prepared.fallback} speechLang=${prepared.speechLang} budgets=${tokens.join('/')} failedAttempts=${failed.map((event) => event.attempt).join(',')} budgetMs=${failed.map((event) => event.budgetMs).join(',')} translateMs=${prepared.translateMs} cacheSize=${cache.size}`);
});

test('58. truncation still raises the budget (2048 -> 8192); a timeout never does', async () => {
  const budgets = [];
  const retries = [];
  let calls = 0;
  const translator = createTranslator({
    onEvent: (type, payload) => { if (type === 'voice.translate.retry') retries.push(payload); },
    request: async ({ maxTokens }) => {
      budgets.push(maxTokens);
      calls += 1;
      return calls === 1
        ? chunkStream([{ type: 'finish', reason: 'max-tokens' }])
        : chunkStream([{ type: 'text-delta', text: GOOD_JA }, { type: 'finish', reason: 'stop' }]);
    },
  });
  const result = await translator.translate('今天天气很好。', { from: 'zh', to: 'ja' });
  assert.equal(result.ok, true);
  assert.deepEqual(budgets, [2048, 8192], 'the max-tokens regression is unchanged: 2048 -> 8192');
  assert.deepEqual(retries, [{ reason: 'max-tokens', from: 2048, to: 8192 }],
    'the retry reason says max-tokens, and only a truncation raises the budget');
  console.log(`58) budgets=${budgets.join('->')} reason=${retries[0].reason} ok=${result.ok} cacheSize=${translator.cache.size}`);
});

test('59. three sentences translate in parallel (max 3); a 4th waits and their windows overlap', async () => {
  const windows = [];
  let active = 0;
  let peak = 0;
  const translator = createTranslator({
    timeoutMs: 5000,
    request: async ({ messages }) => {
      active += 1;
      peak = Math.max(peak, active);
      const startedAt = Date.now();
      await tick(80);
      active -= 1;
      windows.push({ text: messages[0].content[0].text, startedAt, endedAt: Date.now() });
      return GOOD_JA;
    },
  });
  assert.equal(translator.maxConcurrent, 3, 'the default width is three sentences');
  const startedAt = Date.now();
  const results = await Promise.all(['第一句。', '第二句。', '第三句。'].map(
    (text) => translator.translate(text, { from: 'zh', to: 'ja' }),
  ));
  const elapsed = Date.now() - startedAt;
  assert.deepEqual(results.map((result) => result.ok), [true, true, true]);
  assert.equal(peak, 3, 'all three sentences reached the model at the same time');
  assert.ok(elapsed < 3 * 80, `three sentences took about one sentence, not three (${elapsed} ms vs 3 x 80 ms)`);
  const ordered = [...windows].sort((a, b) => a.startedAt - b.startedAt);
  assert.ok(ordered[2].startedAt < ordered[0].endedAt, 'the request windows really overlap');
  assert.deepEqual(translator.stats(), { active: 0, peak: 3, max: 3 }, 'the gate reports the reached width');

  // A 4th sentence waits for a released slot instead of opening a 4th model call.
  const capWindows = [];
  let capActive = 0;
  let capPeak = 0;
  const capped = createTranslator({
    timeoutMs: 5000,
    request: async () => {
      capActive += 1;
      capPeak = Math.max(capPeak, capActive);
      const at = Date.now();
      await tick(60);
      capActive -= 1;
      capWindows.push({ startedAt: at, endedAt: Date.now() });
      return GOOD_JA;
    },
  });
  const four = await Promise.all(['甲。', '乙。', '丙。', '丁。'].map(
    (text) => capped.translate(text, { from: 'zh', to: 'ja' }),
  ));
  assert.deepEqual(four.map((result) => result.ok), [true, true, true, true], 'the waiting sentence still succeeds');
  assert.equal(capPeak, 3, 'never more than three model calls at once');
  const lastStarted = [...capWindows].sort((a, b) => a.startedAt - b.startedAt).at(-1);
  assert.ok(capWindows.filter((window) => window.endedAt <= lastStarted.startedAt).length >= 1,
    'the 4th sentence started only after a slot was released');
  assert.equal(capped.stats().peak, 3);
  console.log(`59) peak=${peak} elapsed=${elapsed}ms overlap=${ordered[2].startedAt - ordered[0].endedAt < 0} stats=${JSON.stringify(translator.stats())} capPeak=${capPeak} windows=${capWindows.length} fourOk=${four.every((result) => result.ok)}`);
});

test('60. one timed-out sentence fails alone: the other two still translate', async () => {
  const events = [];
  const slow = '第二句。';
  const translator = createTranslator({
    timeoutMs: 120,
    onEvent: (type, payload) => events.push({ type, ...payload }),
    request: async ({ messages, signal }) => {
      const text = messages[0].content[0].text;
      const replies = {
        '第一句。': 'いち ばん め の ぶん です。',
        '第三句。': 'さん ばん め の ぶん です。',
      };
      const key = Object.keys(replies).find((candidate) => text.endsWith(candidate));
      if (key !== undefined) {
        await tick(10);
        return replies[key];
      }
      // This sentence hangs: only its own deadline ends the attempt.
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 2000);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(signal.reason ?? new Error('aborted'));
        }, { once: true });
      });
      return 'に ばん め の ぶん です。';
    },
  });
  const prepared = await Promise.all(['第一句。', '第二句。', '第三句。'].map((text) => prepareSpeech(text, {
    translator,
    speechLang: 'ja',
    sentenceId: text,
    emit: (type, payload) => events.push({ type, ...payload }),
  })));
  assert.deepEqual(prepared.map((entry) => entry.ok), [true, false, true], 'two sentences succeed, one falls back');
  assert.equal(prepared[0].speechLang, 'ja');
  assert.equal(prepared[0].speechText, 'いち ばん め の ぶん です。');
  assert.equal(prepared[2].speechLang, 'ja');
  assert.equal(prepared[2].speechText, 'さん ばん め の ぶん です。');
  assert.equal(prepared[1].code, 'TRANSLATE_TIMEOUT');
  assert.equal(prepared[1].fallback, true, 'only the late sentence falls back');
  assert.equal(prepared[1].speechLang, 'zh');
  assert.equal(prepared[1].speechText, slow);
  const failed = events.filter((event) => event.type === 'voice.translate.failed');
  assert.deepEqual(failed.map((event) => [event.code, event.attempt]),
    [['TRANSLATE_TIMEOUT', 1], ['TRANSLATE_TIMEOUT', 2]]);
  assert.ok(!events.some((event) => event.type === 'voice.translate.fallback' && event.sentenceId !== slow),
    'the two translated sentences never fell back');

  // This sentence was late, not cancelled: the caller's own abort is still forwarded to the one
  // in-flight attempt (the per-attempt lane replaced the shared `AbortSignal.any` composition).
  const controller = new AbortController();
  const cancellable = createTranslator({
    timeoutMs: 5000,
    request: async ({ signal }) => new Promise((resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });
  const pending = cancellable.translate('今天天气很好。', { from: 'zh', to: 'ja', signal: controller.signal });
  await tick(5);
  controller.abort(new Error('user barge-in'));
  const stopped = await pending;
  assert.equal(stopped.code, 'TRANSLATE_CANCELLED', 'a caller abort is a cancellation, not a timeout');
  assert.equal(cancellable.cache.size, 0);
  console.log(`60) ok=${prepared.map((entry) => entry.ok).join(',')} speechLang=${prepared.map((entry) => entry.speechLang).join(',')} timedOutCode=${prepared[1].code} attempts=${failed.map((event) => event.attempt).join(',')} fallbacks=${events.filter((event) => event.type === 'voice.translate.fallback').length} cancelCode=${stopped.code}`);
});

test('61. a sentence queued behind the slot cap is cancellable and never leaks its slot', async () => {
  const hold = new AbortController();
  const queuedStop = new AbortController();
  const requests = [];
  const translator = createTranslator({
    maxConcurrent: 1,
    timeoutMs: 5000,
    request: async ({ messages, signal }) => {
      requests.push(messages[0].content[0].text);
      await new Promise((resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      return GOOD_JA;
    },
  });
  const blocker = translator.translate('第一句。', { from: 'zh', to: 'ja', signal: hold.signal });
  const queued = translator.translate('第二句。', { from: 'zh', to: 'ja', signal: queuedStop.signal });
  await tick(10);
  assert.equal(translator.stats().active, 1, 'the first sentence holds the only slot');
  assert.equal(requests.length, 1, 'the queued sentence has not reached the model yet');
  queuedStop.abort(new Error('user barge-in'));
  const queuedResult = await queued;
  assert.equal(queuedResult.code, 'TRANSLATE_CANCELLED', 'the queued sentence stops at once');
  assert.equal(requests.length, 1, 'the queued sentence never called the model');
  assert.equal(translator.stats().active, 1, 'the cancelled waiter never took over the slot');
  hold.abort(new Error('user barge-in'));
  assert.equal((await blocker).code, 'TRANSLATE_CANCELLED');
  assert.equal(translator.stats().active, 0, 'the holder released its slot');
  console.log(`61) queuedCode=${queuedResult.code} blockerCode=${(await blocker).code} active=${translator.stats().active} peak=${translator.stats().peak} max=${translator.stats().max} requests=${requests.length}`);
});

// ---------------------------------------------------------------------------
// 62-64. The assist channel: task name, target boundary, context echo and fallback
// ---------------------------------------------------------------------------

const BOUNDARY_CONTEXT = '你是运行在用户 Windows 电脑上的伴生助手。用户喜欢在深夜写代码，喝冰美式。';

function channelResult(text, context = BOUNDARY_CONTEXT) {
  return {
    text,
    complete: true,
    finishKind: 'stop',
    truncated: false,
    context,
    contextChars: [...context].length,
    targetChars: 7,
    firstDeltaMs: 30,
    doneMs: 120,
    reasoningChars: 0,
    model: 'fake-model',
    reasoning: 'off',
  };
}

test('62. a translation through the channel sends an explicit input package and repairs a context echo', async () => {
  const calls = [];
  const events = [];
  const replies = ['用户喜欢在深夜写代码，喝冰美式。', 'きょう は いい おてんき です ね。'];
  const channel = {
    async ask(input) {
      calls.push(input);
      return channelResult(replies[calls.length - 1] ?? replies.at(-1));
    },
  };
  const translator = createTranslator({
    channel,
    jaSpeechScript: 'mixed',
    request: async () => { throw new Error('the request seam must not be used when a channel exists'); },
    onEvent: (type, payload) => events.push({ type, ...payload }),
  });
  const result = await translator.translate('今天天气很好。', { from: 'zh', to: 'ja' });
  assert.equal(result.ok, true);
  assert.equal(result.text, 'きょう は いい おてんき です ね。', 'the repaired answer is the target translation');
  assert.equal(calls.length, 2, 'one first round + one boundary repair');
  // The call site hands over data, not a prompt: the channel renders system/user itself.
  assert.equal(calls[0].task, 'translate', 'a plain translation routes as translate');
  assert.deepEqual(calls[0].input, {
    text: '今天天气很好。',
    targetLang: 'ja',
    from: 'zh',
    jaSpeechScript: 'mixed',
    purpose: 'speech',
    mode: 'translate',
    strict: false,
    boundary: true,
  }, 'only the package fields cross the channel boundary');
  const rendered = renderLightweightInput('translate', calls[0].input);
  assert.match(rendered.system, /唯一需要翻译的目标正文/u, 'the boundary rule is rendered by the channel');
  assert.ok(rendered.user.includes('<待译正文>'), 'the target is wrapped in its own block');
  assert.ok(rendered.user.includes('今天天气很好。'), 'the target text is inside the block');
  assert.ok(!rendered.user.includes('冰美式'), 'the context is not copied into the target block');
  assert.equal(calls[1].input.mode, 'boundary-repair', 'the repair round is its own package mode');
  assert.equal(calls[1].input.text, '今天天气很好。', 'the repair reuses the original target');
  assert.ok(renderLightweightInput('translate', calls[1].input).user.includes('<待译正文>'));
  const boundary = events.find((event) => event.type === 'voice.translate.boundary');
  assert.ok(boundary !== undefined, 'the boundary violation is observable');
  assert.equal(boundary.reason, 'context-echo');
  assert.equal(boundary.contextChars, [...BOUNDARY_CONTEXT].length, 'the event records the context size');
  assert.equal(boundary.targetChars, 7, 'the event records the target size');
  const ok = events.find((event) => event.type === 'voice.translate');
  assert.equal(ok.contextChars, [...BOUNDARY_CONTEXT].length, 'the success row keeps contextChars');
  assert.equal(ok.targetChars, 7);
  console.log(`translate package rounds=${calls.length} first=${JSON.stringify({ task: calls[0].task, text: calls[0].input.text, targetLang: calls[0].input.targetLang, renderedChars: rendered.chars })} repaired=${calls[1].input.mode} contextChars=${ok.contextChars}`);
});

test('63. an answer that still carries the context after the repair round falls back to the source', async () => {
  const events = [];
  const cache = createTranslationCache();
  const channel = {
    async ask() { return channelResult('用户喜欢在深夜写代码，喝冰美式。'); },
  };
  const translator = createTranslator({
    cache,
    channel,
    request: async () => GOOD_JA,
    onEvent: (type, payload) => events.push({ type, ...payload }),
  });
  const result = await translator.translate('今天天气很好。', { from: 'zh', to: 'ja' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TRANSLATE_BOUNDARY', 'the second violation is a hard failure');
  assert.equal(cache.size, 0, 'a context-laden line is never cached');
  assert.equal(events.filter((event) => event.type === 'voice.translate.boundary').length, 1);
  const prepared = await prepareSpeech('今天天气很好。', { translator, speechLang: 'ja' });
  assert.equal(prepared.fallback, true);
  assert.equal(prepared.speechLang, 'zh', 'the source language is spoken instead');
  assert.equal(prepared.speechText, '今天天气很好。');
  assert.ok(cache.size === 0);
});

test('64. the kana speech path routes as task kana; a clean answer is cached with the same key', async () => {
  const calls = [];
  const cache = createTranslationCache();
  const channel = {
    async ask(input) {
      calls.push(input);
      return channelResult('きょう は いい おてんき です ね。');
    },
  };
  const translator = createTranslator({
    cache,
    channel,
    request: async () => GOOD_JA,
    jaSpeechScript: 'kanaSpaced',
  });
  const first = await translator.translate('今天天气很好。', { from: 'zh', to: 'ja' });
  assert.equal(first.ok, true);
  assert.equal(calls[0].task, 'kana', 'the kana script routes as kana, not translate');
  assert.equal(calls[0].input.text, '今天天气很好。', 'the kana package carries the source line');
  assert.equal(calls[0].input.targetLang, 'ja');
  assert.equal(calls[0].input.jaSpeechScript, 'kanaSpaced');
  assert.match(renderLightweightInput('kana', calls[0].input).system, /分かち書き/u,
    'the channel renders the kana speech rule');
  assert.equal(translator.cache.size, 1);
  const second = await translator.translate('今天天气很好。', { from: 'zh', to: 'ja' });
  assert.equal(second.cached, true, 'a cache hit does not reach the channel again');
  assert.equal(calls.length, 1, 'the cache key is unchanged by the channel');
});

// ---------------------------------------------------------------------------
// 65. Queue priority: voice before subtitle, 3:1, without interrupting what already runs
// ---------------------------------------------------------------------------

test('65. queued voice lines outrank a queued subtitle (3:1) and never interrupt a running subtitle', async () => {
  const events = [];
  const started = [];
  const sources = ['字幕先跑。', '字幕排队。', '语音一。', '语音二。', '语音三。'];
  const translator = createTranslator({
    maxConcurrent: 1,
    timeoutMs: 5000,
    onEvent: (type, payload) => events.push({ type, ...payload }),
    request: async ({ messages }) => {
      const body = String(messages[0].content[0].text ?? '');
      started.push(sources.find((text) => body.includes(text)) ?? body);
      await tick(10);
      return GOOD_JA;
    },
  });

  // One subtitle holds the only slot; a second subtitle waits BEFORE the voice lines arrive. A
  // voice line must never queue behind a subtitle that is only waiting, and the subtitle that is
  // already running must never be interrupted to make room.
  const runningSubtitle = translator.translate('字幕先跑。', { from: 'zh', to: 'ja', purpose: 'subtitle' });
  const queuedSubtitle = translator.translate('字幕排队。', { from: 'zh', to: 'ja', purpose: 'subtitle' });
  const voices = ['语音一。', '语音二。', '语音三。'].map(
    (text) => translator.translate(text, { from: 'zh', to: 'ja' }),
  );
  assert.equal(translator.stats().active, 1, 'the first subtitle really holds the one slot');
  const results = await Promise.all([runningSubtitle, queuedSubtitle, ...voices]);

  assert.deepEqual(results.map((result) => result.ok), [true, true, true, true, true]);
  assert.deepEqual(
    started,
    ['字幕先跑。', '语音一。', '语音二。', '语音三。', '字幕排队。'],
    'the earlier queued subtitle does not overtake the voices; after three voice lines it is admitted',
  );
  const priority = events.filter((event) => event.type === 'translate.priority');
  assert.deepEqual(
    priority.map((event) => [event.servedVoice, event.servedSubtitle]),
    [[1, 0], [2, 0], [3, 0], [3, 1]],
    'the counters show a 3:1 voice:subtitle admission ratio',
  );
  // Both lanes' own queue wait is recorded and the lane is tagged, so the ratio can be tuned later.
  for (const row of priority) {
    assert.ok(row.lane === 'voice' || row.lane === 'subtitle', `the lane is tagged: ${row.lane}`);
    assert.ok(Number.isFinite(row.queueWaitMs) && row.queueWaitMs >= 0, `queueWaitMs=${row.queueWaitMs}`);
  }
  const voiceWait = priority.find((row) => row.lane === 'voice').queueWaitMs;
  const subtitleWait = priority.find((row) => row.lane === 'subtitle').queueWaitMs;
  assert.ok(subtitleWait > voiceWait, `the queued subtitle waited longer (${subtitleWait} ms > ${voiceWait} ms)`);
  const translateRows = events.filter((event) => event.type === 'voice.translate');
  assert.equal(translateRows.filter((row) => row.purpose === 'speech').length, 3, 'three voice rows carry purpose=speech');
  assert.equal(translateRows.filter((row) => row.purpose === 'subtitle').length, 2, 'two subtitle rows carry purpose=subtitle');
  for (const row of translateRows) {
    assert.ok(Number.isFinite(row.queueWaitMs) && row.queueWaitMs >= 0, 'every translation row carries its queue wait');
  }
  assert.equal(
    events.filter((event) => event.type === 'voice.translate.failed').length,
    0,
    'no subtitle was cancelled: priority only reorders the queue',
  );
  assert.deepEqual(translator.priorityStats(), { servedVoice: 3, servedSubtitle: 1 });
  assert.deepEqual(translator.stats(), { active: 0, peak: 1, max: 1 }, 'the running subtitle kept its slot');
  console.log(`65) order=${started.join(' -> ')} priority=${priority.map((event) => `${event.servedVoice}:${event.servedSubtitle}`).join(',')} active=${translator.stats().active}`);
});

test('66. an empty lane never idles the slot: with only subtitles waiting they all run back-to-back', async () => {
  const sources = ['字幕甲。', '字幕乙。', '字幕丙。'];
  const started = [];
  const windows = [];
  const events = [];
  const translator = createTranslator({
    maxConcurrent: 1,
    timeoutMs: 5000,
    onEvent: (type, payload) => events.push({ type, ...payload }),
    request: async ({ messages }) => {
      const body = String(messages[0].content[0].text ?? '');
      started.push(sources.find((text) => body.includes(text)) ?? body);
      const from = Date.now();
      await tick(20);
      windows.push({ startedAt: from, endedAt: Date.now() });
      return GOOD_JA;
    },
  });
  const results = await Promise.all(
    sources.map((text) => translator.translate(text, { from: 'zh', to: 'ja', purpose: 'subtitle' })),
  );
  assert.deepEqual(results.map((result) => result.ok), [true, true, true]);
  assert.deepEqual(started, sources, 'the waiting subtitles run in arrival order, one after another');
  // The proof that no slot idles: each next subtitle starts as soon as the previous one released,
  // never after a fairness delay waiting for a voice line that does not exist.
  for (let index = 1; index < windows.length; index += 1) {
    const gap = windows[index].startedAt - windows[index - 1].endedAt;
    assert.ok(gap < 40, `subtitle ${index + 1} started right after the slot was released (gap ${gap} ms)`);
  }
  assert.deepEqual(translator.priorityStats(), { servedVoice: 0, servedSubtitle: 2 },
    'the two queued subtitles are served; the first one never waited');
  const priority = events.filter((event) => event.type === 'translate.priority');
  assert.equal(priority.length, 2, 'only the queued admissions produce a priority row');
  assert.ok(priority.every((row) => row.lane === 'subtitle'), 'no voice line was invented to fill the ratio');
  const first = events.find((event) => event.type === 'voice.translate');
  assert.equal(first.purpose, 'subtitle');
  assert.ok(first.queueWaitMs <= 20, `a subtitle that found a free slot waits for nothing (${first.queueWaitMs} ms)`);
  console.log(`66) order=${started.join(' -> ')} gaps=${windows.slice(1).map((row, index) => row.startedAt - windows[index].endedAt).join(',')}ms served=${JSON.stringify(translator.priorityStats())} firstQueueWaitMs=${first.queueWaitMs}`);
});

test('67. a cancelled (stale) queued subtitle is purged before the next slot is handed out', async () => {
  const sources = ['先跑。', '过时字幕。', '语音甲。', '语音乙。', '语音丙。', '有效字幕。'];
  const started = [];
  const events = [];
  const translator = createTranslator({
    maxConcurrent: 1,
    timeoutMs: 5000,
    onEvent: (type, payload) => events.push({ type, ...payload }),
    request: async ({ messages }) => {
      const body = String(messages[0].content[0].text ?? '');
      started.push(sources.find((text) => body.includes(text)) ?? body);
      await tick(10);
      return GOOD_JA;
    },
  });
  const running = translator.translate('先跑。', { from: 'zh', to: 'ja', purpose: 'subtitle' });
  const staleTurn = new AbortController();
  const staleSubtitle = translator.translate('过时字幕。', {
    from: 'zh', to: 'ja', purpose: 'subtitle', signal: staleTurn.signal,
  });
  const voices = ['语音甲。', '语音乙。', '语音丙。'].map(
    (text) => translator.translate(text, { from: 'zh', to: 'ja' }),
  );
  const liveSubtitle = translator.translate('有效字幕。', { from: 'zh', to: 'ja', purpose: 'subtitle' });
  // The old turn is interrupted while its subtitle still waits: it must never be given a slot.
  staleTurn.abort(new Error('turn-start'));
  const results = await Promise.all([running, staleSubtitle, ...voices, liveSubtitle]);

  assert.equal(results[1].code, 'TRANSLATE_CANCELLED', 'the stale subtitle reports a cancellation');
  assert.deepEqual(
    started,
    ['先跑。', '语音甲。', '语音乙。', '语音丙。', '有效字幕。'],
    'the purged subtitle never reaches the model, and it does not consume a slot or a ratio turn',
  );
  assert.deepEqual(translator.priorityStats(), { servedVoice: 3, servedSubtitle: 1 },
    'only live requests are counted');
  const priority = events.filter((event) => event.type === 'translate.priority');
  assert.deepEqual(priority.map((event) => [event.lane, event.servedVoice, event.servedSubtitle]), [
    ['voice', 1, 0], ['voice', 2, 0], ['voice', 3, 0], ['subtitle', 3, 1],
  ], 'the 3:1 order is not skewed by the purged request');
  assert.equal(
    events.filter((event) => event.type === 'voice.translate.failed' && event.code === 'TRANSLATE_CANCELLED').length,
    1,
    'the cancelled subtitle is reported once',
  );
  console.log(`67) order=${started.join(' -> ')} staleCode=${results[1].code} served=${JSON.stringify(translator.priorityStats())}`);
});

// ---------------------------------------------------------------------------
// 68. Mounted host: a late subtitle translation keeps the newer line's caption
// ---------------------------------------------------------------------------

test('68. mounted: a subtitle translation that arrives after the next line cannot repaint it', async (t) => {
  const captionHold = deferred();
  const app = await mountHost(t, {
    speech: 'ja',
    subtitle: 'en',
    subtitleVisible: true,
    captionHold,
    englishFor: (body) => (body.includes('第一句话')
      ? 'The first sentence caption.'
      : 'The second sentence caption.'),
  });
  const sayTool = app.tools.get('assistant_say');
  const first = await sayTool.execute({ text: '第一句话的字幕内容。' }, {});
  assert.equal(first.accepted, true);
  await waitUntil(() => hostState.players.length === 1, 'the first line reached the player');
  await waitUntil(
    () => hostState.subtitles.some((entry) => entry.text === '第一句话的字幕内容。'),
    'the first ORIGINAL caption painted at its own audio start',
  );

  // The first line ends while its translated (English) caption is still pending.
  hostState.players[0].release.resolve();
  const second = await sayTool.execute({ text: '第二句话的字幕内容。' }, {});
  assert.equal(second.accepted, true);
  await waitUntil(() => hostState.players.length === 2, 'the second line reached the player');
  await waitUntil(
    () => hostState.subtitles.some((entry) => entry.text === 'The second sentence caption.'),
    'the second line repainted with its own translation',
  );
  const painted = hostState.subtitles.length;

  // The first line's translation finally arrives: it may only update its OWN line, never this one.
  captionHold.resolve();
  await waitUntil(
    async () => (await readEvents(app.root)).filter(
      (event) => event.type === 'voice.translate' && event.payload.to === 'en',
    ).length === 2,
    'both subtitle translations completed',
  );
  await tick(40);
  assert.equal(hostState.subtitles.length, painted, 'the late translation published nothing');
  assert.ok(
    !hostState.subtitles.some((entry) => entry.text === 'The first sentence caption.'),
    'sentence 1\'s translation never lands on sentence 2',
  );
  assert.equal(hostState.subtitles.at(-1).text, 'The second sentence caption.',
    'the screen keeps the sentence that is actually current');
  const events = await readEvents(app.root);
  assert.equal(events.filter((event) => event.type === 'voice.subtitle.fallback').length, 0,
    'neither caption stream failed: the late repaint was refused by the line guard');
  t.diagnostic(`late caption: paints=${hostState.subtitles.map((entry) => entry.text).join(' | ')} current=${hostState.subtitles.at(-1).text}`);
});
