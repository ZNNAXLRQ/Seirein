/**
 * Waiting-line language split and cache identity.
 *
 * The generated line is the CAPTION: warm prompts and the per-turn draft are asked in the subtitle
 * language. The voice language is applied only by the speech outlet (`prepareSpeech`): caption
 * text -> translated speech text -> TTS. The warm pool persists the ready triple
 * `{captionText, speechText, audio}` per language pair/persona, so the trigger never starts a
 * translation; a draft that is not ready at the deadline falls back to that warm triple.
 *
 * The second half covers the observability fixes: `voice.ack.warm.blocked {blockedBy}`, a cancelled
 * build keeping the valid pool (a late result never re-enters), and `voice.ack.silent {reason}`.
 *
 * Run: node --test test/ack-language.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupRoot } from './helpers/cleanup.mjs';
import { createAckLane } from '../src/host/speech/ack-lane.js';
import { ackWarmKey, createAckWarmPool } from '../src/host/speech/ack-speech.js';
import {
  ackWarmActivityReason,
  createAckWarmTurnMeter,
} from '../src/host/speech/ack-warmup.js';
import { prepareSpeech } from '../src/host/speech/translate.js';

const CAPTION_ZH = '我这就去看看你说的天气情况';
const SPEECH_JA = '今の天気を見てきますね';
const SPEECH_JA_2 = '少し待っていてくださいね';
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const waitUntil = async (check, message, timeoutMs = 4000) => {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out: ${message}`);
    await tick(5);
  }
};
const findEvent = (events, type) => events.find((event) => event.type === type);

/** A translator seam with a visible call log; the target language is marked in the text. */
function fakeTranslator() {
  const calls = [];
  return {
    calls,
    stats: () => ({ active: 0, peak: 0, max: 2 }),
    async translate(text, { from, to, purpose = '' } = {}) {
      calls.push({ text, from, to, purpose, at: Date.now() });
      return { ok: true, text: `【${to}】${text}`, cached: false, ms: 1, queueWaitMs: 0, reused: false };
    },
  };
}

/** TTS seam: records exactly what reaches the voice engine, and writes a real file. */
function fakeTts(dir) {
  const calls = [];
  let seq = 0;
  return {
    calls,
    async synthesize({ text, lang, signal }) {
      seq += 1;
      calls.push({ text, lang, at: Date.now() });
      await mkdir(dir, { recursive: true });
      const file = join(dir, `tts-${seq}.mp3`);
      await writeFile(file, text);
      if (signal?.aborted) {
        await rm(file, { force: true });
        signal.throwIfAborted?.();
      }
      return { file, durationMs: 100, bytes: 8, provider: 'fake' };
    },
  };
}

/** The host's speech outlet in miniature: caption stays the source, TTS gets the translation. */
async function speechOutlet({ captionText, captionLang, speechLang, translator, tts, signal }) {
  const prepared = await prepareSpeech(captionText, {
    translator,
    textLang: captionLang,
    speechLang,
    signal,
  });
  const audio = await tts.synthesize({ text: prepared.speechText, lang: prepared.speechLang, signal });
  return {
    ...audio,
    captionText: prepared.captionText,
    speechText: prepared.speechText,
    speechLang: prepared.speechLang,
  };
}

async function warmPoolFixture(t, {
  captionLang = 'zh', speechLang = 'ja', capacity = 6,
  lines = [CAPTION_ZH], translator = fakeTranslator(), speechLines: speechLinesOption = null,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ack-lang-'));
  t.after(() => cleanupRoot(root));
  const dir = join(root, 'cache', 'ack');
  await mkdir(dir, { recursive: true });
  const tts = fakeTts(dir);
  const events = [];
  const generated = [];
  let speechIndex = 0;
  const speechLines = speechLinesOption ?? [SPEECH_JA, SPEECH_JA_2];
  const meta = {
    persona: '你是小音，说话温柔简短。',
    captionLang,
    speechLang,
    voice: 'voice-a',
    modelVersion: 'route/fake|edge',
  };
  const pool = createAckWarmPool({
    dir,
    meta: () => meta,
    generate: async ({ language, captionLang: cap, speechLang: speech, count }) => {
      generated.push({ language, captionLang: cap, speechLang: speech, count });
      return lines.slice(0, count);
    },
    synthesize: async ({ text, captionText, signal, captionLang: cap, speechLang: speech }) => {
      const result = await speechOutlet({
        captionText: captionText ?? text,
        captionLang: cap,
        speechLang: speech,
        translator,
        tts,
        signal,
      });
      // The fake translator marks the target; keep a stable Japanese line for assertions.
      const speechText = result.speechText.startsWith('【')
        ? (speechLines[speechIndex++] ?? speechLines[speechLines.length - 1])
        : result.speechText;
      await writeFile(result.file, speechText);
      return { ...result, speechText };
    },
    emit: async (type, payload) => { events.push({ type, payload }); },
    capacity,
  });
  return { root, dir, pool, meta, tts, translator, events, generated };
}

/** One lane wired the way the host wires it, with the same caption/speech split. */
function laneFixture({
  langCaption = 'zh', langSpeech = 'ja', warm = null, delayMs = 60,
  generate = async () => CAPTION_ZH,
  synthesize = async () => ({ file: 'ack.mp3', durationMs: 100 }),
  play,
} = {}) {
  const events = [];
  const plays = [];
  const playLine = play ?? (async ({ speech, caption, signal }) => {
    const player = { speech, caption, signal, startedAt: Date.now(), end: null };
    const done = new Promise((resolve) => { player.end = resolve; });
    plays.push(player);
    return { audioStartedAt: player.startedAt, done };
  });
  const lane = createAckLane({
    emit: async (type, payload) => { events.push({ type, payload }); },
    generate,
    synthesize,
    play: playLine,
    warm,
    persona: () => '你是小音，说话温柔简短。',
    captionLang: () => langCaption,
    speechLang: () => langSpeech,
    captureSignal: () => new AbortController().signal,
    delayMs,
    timeoutMs: () => 1000,
  });
  return { lane, events, plays };
}

// ---------------------------------------------------------------------------
// 1-2. Caption language vs speech language
// ---------------------------------------------------------------------------

test('1. warm: generated in the subtitle language, TTS receives the voice translation, caption stays Chinese', async (t) => {
  const fixture = await warmPoolFixture(t, { captionLang: 'zh', speechLang: 'ja' });
  const build = await fixture.pool.build();
  assert.ok(build.built >= 1, `warm built=${build.built}`);
  // The generation request names the SUBTITLE language, never the voice language.
  assert.equal(fixture.generated[0].language, 'zh');
  assert.equal(fixture.generated[0].captionLang, 'zh');
  assert.equal(fixture.generated[0].speechLang, 'ja');
  // One translation, to the voice language, during the idle build.
  assert.equal(fixture.translator.calls.length, 1, 'exactly one speech translation for the warm line');
  assert.equal(fixture.translator.calls[0].to, 'ja');
  assert.equal(fixture.tts.calls.length, 1);
  assert.equal(fixture.tts.calls[0].lang, 'ja', 'TTS language is the voice language');
  assert.match(fixture.tts.calls[0].text, /^【ja】/u, 'TTS received the translated text, not the caption');
  const taken = fixture.pool.take();
  assert.ok(taken !== null);
  assert.equal(taken.captionText, CAPTION_ZH, 'captionText is the Chinese source line');
  assert.equal(taken.speechText, SPEECH_JA, 'speechText is the Japanese translation');
  assert.equal(taken.captionLang, 'zh');
  assert.equal(taken.speechLang, 'ja');

  const { lane, events, plays } = laneFixture({ warm: fixture.pool, generate: async () => '' });
  const translatedAt = fixture.translator.calls[0].at;
  const deliveredAt = Date.now();
  lane.beginTurn({ sessionId: 's-lang-warm', turn: 1, userText: '帮我查一下明天的天气' });
  await waitUntil(() => plays.length === 1, 'the prebuilt warm line reached the player');
  assert.equal(plays[0].caption, CAPTION_ZH, 'the visible line is Chinese');
  assert.equal(plays[0].speech, SPEECH_JA, 'the spoken line is Japanese');
  assert.ok(translatedAt < deliveredAt, 'the translation happened during the idle build, before delivery');
  assert.equal(fixture.translator.calls.length, 1, 'the trigger started no translation');
  const hit = findEvent(events, 'voice.ack.cache.hit');
  assert.equal(hit.payload.captionLang, 'zh');
  assert.equal(hit.payload.speechLang, 'ja');
  plays[0].end();
  await lane.whenIdle();
  t.diagnostic(
    `warm caption="${plays[0].caption}" speech="${plays[0].speech}" `
    + `translate=${fixture.translator.calls.length}/zh->ja ttsLang=${fixture.tts.calls[0].lang}`,
  );
});

test('2. draft: generated in the subtitle language, translated before the trigger, caption stays Chinese', async (t) => {
  const translator = fakeTranslator();
  const ttsDir = await mkdtemp(join(tmpdir(), 'dsh-ack-lang-draft-'));
  t.after(() => cleanupRoot(ttsDir));
  const tts = fakeTts(ttsDir);
  let generatedLang = '';
  let draftTranslateCount = 0;
  const { lane, events, plays } = laneFixture({
    generate: async ({ ack }) => {
      generatedLang = ack.language;
      return CAPTION_ZH;
    },
    synthesize: async ({ captionText, captionLang, speechLang, signal }) => {
      draftTranslateCount += 1;
      const result = await speechOutlet({ captionText, captionLang, speechLang, translator, tts, signal });
      return { ...result, speechText: SPEECH_JA };
    },
  });
  lane.beginTurn({ sessionId: 's-lang-draft', turn: 2, userText: '帮我查一下明天的天气' });
  const spoken = await waitUntil(() => findEvent(events, 'voice.ack.spoken'), 'the draft was spoken');
  assert.equal(generatedLang, 'zh', 'the draft prompt asked for the subtitle language');
  assert.equal(translator.calls.length, 1, 'exactly one draft translation');
  assert.equal(translator.calls[0].to, 'ja');
  assert.equal(tts.calls[0].lang, 'ja');
  assert.equal(plays[0].caption, CAPTION_ZH);
  assert.equal(plays[0].speech, SPEECH_JA);
  assert.ok(spoken.payload.ackReadyMs <= spoken.payload.ackTriggerMs,
    `draft ready ${spoken.payload.ackReadyMs}ms <= trigger ${spoken.payload.ackTriggerMs}ms`);
  assert.equal(draftTranslateCount, 1, 'translation happens once, inside the draft path');
  plays[0].end();
  await lane.whenIdle();
  t.diagnostic(
    `draft generateLang=${generatedLang} caption="${plays[0].caption}" speech="${plays[0].speech}" `
    + `translate=${translator.calls.length} ready=${spoken.payload.ackReadyMs}ms trigger=${spoken.payload.ackTriggerMs}ms`,
  );
});

test('3. same language: warm and draft skip the translator entirely (0 calls)', async (t) => {
  const fixture = await warmPoolFixture(t, {
    captionLang: 'zh', speechLang: 'zh', lines: [CAPTION_ZH], speechLines: [CAPTION_ZH],
  });
  await fixture.pool.build();
  assert.equal(fixture.translator.calls.length, 0, 'same language warm build makes 0 translation calls');
  const taken = fixture.pool.take();
  assert.equal(taken.speechText, taken.captionText, 'speech text equals the caption when languages match');

  const translator = fakeTranslator();
  const ttsDir = await mkdtemp(join(tmpdir(), 'dsh-ack-lang-same-'));
  t.after(() => cleanupRoot(ttsDir));
  const tts = fakeTts(ttsDir);
  const { lane, plays } = laneFixture({
    langCaption: 'zh', langSpeech: 'zh',
    synthesize: async ({ captionText, captionLang, speechLang, signal }) => {
      const result = await speechOutlet({ captionText, captionLang, speechLang, translator, tts, signal });
      return result;
    },
  });
  lane.beginTurn({ sessionId: 's-lang-same', turn: 3, userText: '帮我查一下明天的天气' });
  await waitUntil(() => plays.length === 1, 'the same-language draft reached the player');
  assert.equal(translator.calls.length, 0, 'same language draft makes 0 translation calls');
  assert.equal(plays[0].caption, CAPTION_ZH);
  assert.equal(plays[0].speech, CAPTION_ZH);
  plays[0].end();
  await lane.whenIdle();
  t.diagnostic(`same-language translateCalls=0 caption=speech="${plays[0].caption}"`);
});

// ---------------------------------------------------------------------------
// 4. Cache identity
// ---------------------------------------------------------------------------

test('4. cache key covers caption lang + speech lang + persona: changing either rebuilds', async (t) => {
  const fixture = await warmPoolFixture(t, { captionLang: 'zh', speechLang: 'ja' });
  const first = await fixture.pool.build();
  const firstKey = first.key;
  assert.equal(ackWarmKey(fixture.meta), firstKey);
  assert.notEqual(
    ackWarmKey({ ...fixture.meta, captionLang: 'en' }),
    firstKey,
    'the caption language is part of the key',
  );
  assert.notEqual(
    ackWarmKey({ ...fixture.meta, speechLang: 'zh' }),
    firstKey,
    'the speech language is part of the key',
  );
  assert.notEqual(
    ackWarmKey({ ...fixture.meta, persona: '你是另一个人设。' }),
    firstKey,
    'the persona version is part of the key',
  );

  // Caption language changes: the old lines/audio are not reused.
  fixture.meta.captionLang = 'ja';
  const captionChange = await fixture.pool.ensure();
  assert.equal(captionChange.rebuilt, true);
  assert.equal(captionChange.reason, 'captionLang-changed');
  assert.notEqual(captionChange.key, firstKey);
  assert.equal(fixture.pool.take(), null, 'the old Chinese caption row is not served');
  assert.equal(fixture.pool.status().entries, 0);

  // Speech language changes: a second rebuild, with its own reason.
  fixture.meta.speechLang = 'zh';
  const speechChange = await fixture.pool.ensure();
  assert.equal(speechChange.rebuilt, true);
  assert.equal(speechChange.reason, 'speechLang-changed');
  assert.notEqual(speechChange.key, captionChange.key);
  assert.equal(fixture.pool.take(), null);
  const rebuilds = fixture.events
    .filter((event) => event.type === 'voice.ack.cache.rebuild')
    .map((event) => event.payload.reason);
  assert.deepEqual(rebuilds, ['captionLang-changed', 'speechLang-changed']);
  t.diagnostic(
    `key=${firstKey} captionChange=${captionChange.reason}/${captionChange.key} `
    + `speechChange=${speechChange.reason}/${speechChange.key} take=null`,
  );
});

// ---------------------------------------------------------------------------
// 5. Warm trigger is prebuilt; an unready draft falls back without translating at the trigger
// ---------------------------------------------------------------------------

test('5. warm plays from the prebuilt triple; an unready draft falls back to it with no trigger-time translation', async (t) => {
  const fixture = await warmPoolFixture(t, { captionLang: 'zh', speechLang: 'ja' });
  await fixture.pool.build();
  assert.equal(fixture.translator.calls.length, 1, 'precondition: the warm triple was prepared');
  const translatorCallsBefore = fixture.translator.calls.length;
  const ttsCallsBefore = fixture.tts.calls.length;

  const { lane, events, plays } = laneFixture({
    warm: fixture.pool,
    delayMs: 60,
    // The draft text arrives, but its audio never does: the deadline must use the warm pool.
    generate: async () => CAPTION_ZH,
    synthesize: () => new Promise(() => {}),
  });
  const deliveredAt = Date.now();
  lane.beginTurn({ sessionId: 's-lang-trigger', turn: 5, userText: '帮我查一下明天的天气' });
  await waitUntil(() => plays.length === 1, 'the warm line reached the player');
  const firstAudioMs = Date.now() - deliveredAt;
  assert.equal(findEvent(events, 'voice.ack.source').payload.source, 'warm', 'the unready draft lost');
  assert.equal(plays[0].caption, CAPTION_ZH);
  assert.equal(plays[0].speech, SPEECH_JA);
  assert.equal(fixture.translator.calls.length, translatorCallsBefore, 'the trigger translated nothing');
  assert.equal(fixture.tts.calls.length, ttsCallsBefore, 'the trigger synthesized nothing');
  assert.ok(firstAudioMs <= 500, `warm first audio ${firstAudioMs}ms (budget 500ms)`);
  plays[0].end();
  await lane.whenIdle();
  t.diagnostic(
    `warm firstAudio=${firstAudioMs}ms translateBefore/after=${translatorCallsBefore}/${fixture.translator.calls.length} `
    + `ttsBefore/after=${ttsCallsBefore}/${fixture.tts.calls.length} source=warm`,
  );
});

// ---------------------------------------------------------------------------
// 6. blockedBy on the throttled blocked row
// ---------------------------------------------------------------------------

test('6. voice.ack.warm.blocked names all four live resources and stays throttled', (t) => {
  let clock = 1_000_000;
  const events = [];
  const meter = createAckWarmTurnMeter({
    emit: async (type, payload) => { events.push({ type, payload }); },
    throttleMs: 30_000,
    now: () => clock,
  });
  meter.start({ session: {}, sessionId: 's-block', turn: 1 });
  // The host's precedence is unchanged: playing > synthesizing > translating > generating.
  assert.equal(ackWarmActivityReason({ playing: true, synthesizing: true, translating: true, generating: true }), 'playing');
  assert.equal(ackWarmActivityReason({ synthesizing: true, translating: true, generating: true }), 'synthesizing');
  assert.equal(ackWarmActivityReason({ translating: true, generating: true }), 'translating');
  assert.equal(ackWarmActivityReason({ generating: true }), 'generating');

  const reasons = ['playing', 'synthesizing', 'translating', 'generating'];
  for (const blockedBy of reasons) {
    clock += 30_000;
    assert.equal(meter.noteBlocked(blockedBy), true, `${blockedBy} reports`);
    const row = events.at(-1);
    assert.equal(row.type, 'voice.ack.warm.blocked');
    assert.equal(row.payload.reason, 'busy');
    assert.equal(row.payload.blockedBy, blockedBy);
    assert.equal(row.payload.activeTurns, 1);
    clock += 29_999;
    assert.equal(meter.noteBlocked(blockedBy), false, `${blockedBy} is still inside the throttle window`);
    clock += 1;
  }
  assert.deepEqual(events.map((event) => event.payload.blockedBy), reasons);
  assert.equal(events.length, 4, 'one row per window, never one per idle tick');
  t.diagnostic(`blockedBy=${events.map((event) => event.payload.blockedBy).join(',')} throttle=30000`);
});

// ---------------------------------------------------------------------------
// 7. Cancelling a build keeps the valid pool and drops the late result
// ---------------------------------------------------------------------------

test('7. cancelling a build keeps valid entries; the late result never re-enters the pool', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ack-lang-cancel-'));
  t.after(() => cleanupRoot(root));
  const dir = join(root, 'cache', 'ack');
  await mkdir(dir, { recursive: true });
  const firstLine = '我在这里陪你等一会儿';
  const lateLine = '你先说说看我一直听着';
  const events = [];
  let synthCalls = 0;
  let lateStarted = false;
  let releaseLate = () => {};
  const lateGate = new Promise((resolve) => { releaseLate = resolve; });
  const pool = createAckWarmPool({
    dir,
    meta: () => ({ persona: '你是小音', captionLang: 'zh', speechLang: 'zh', voice: 'voice-a', modelVersion: 'm1' }),
    generate: async ({ count }) => {
      // First build: one line. Second build (the one cancelled): the late line.
      if (synthCalls === 0) return [firstLine].slice(0, count);
      return [lateLine].slice(0, count);
    },
    synthesize: async ({ text, dir: target, signal }) => {
      synthCalls += 1;
      const file = join(target, `warm-${synthCalls}.mp3`);
      await mkdir(target, { recursive: true });
      await writeFile(file, text);
      if (text === lateLine) {
        lateStarted = true;
        await lateGate;
        if (signal?.aborted === true) {
          await rm(file, { force: true });
          signal.throwIfAborted?.();
        }
      }
      return { file, durationMs: 120, bytes: 8, provider: 'fake', captionText: text, speechText: text };
    },
    emit: async (type, payload) => { events.push({ type, payload }); },
    capacity: 2,
  });
  const first = await pool.build();
  assert.equal(first.built, 1);
  assert.ok(pool.status().texts.includes(firstLine));

  const controller = new AbortController();
  const running = pool.build({ signal: controller.signal });
  await waitUntil(() => lateStarted, 'the late line is synthesizing');
  controller.abort(new DOMException('user-message', 'AbortError'));
  releaseLate();
  const late = await running;
  assert.equal(late.stale, true, 'the cancelled batch is stale');
  assert.equal(late.built, 0);
  // The valid entry survived; the late line never entered the in-memory pool.
  assert.equal(pool.status().entries, 1, 'the existing warm line is preserved');
  assert.ok(pool.status().texts.includes(firstLine));
  assert.ok(!pool.status().texts.includes(lateLine), 'the late result is not pooled');
  const taken = pool.take();
  assert.ok(taken !== null, 'the surviving entry is still servable');
  assert.equal(taken.captionText, firstLine);
  const discarded = events.filter((event) => event.type === 'voice.ack.warm.discarded');
  assert.equal(discarded.length, 1);
  assert.equal(discarded[0].payload.reason, 'cancelled');
  t.diagnostic(
    `entries=${pool.status().entries} take="${taken.captionText}" latePooled=${pool.status().texts.includes(lateLine)} `
    + `discarded=${discarded.length}/${discarded[0].payload.reason}`,
  );
});

// ---------------------------------------------------------------------------
// 8. Silent finish is observable
// ---------------------------------------------------------------------------

test('8. a fire with no usable tier writes voice.ack.silent with a reason', async (t) => {
  const { lane, events, plays } = laneFixture({
    delayMs: 40,
    warm: null,
    generate: async () => { throw new Error('model down'); },
    synthesize: null,
    play: async () => { throw new Error('must not play'); },
  });
  lane.beginTurn({ sessionId: 's-lang-silent', turn: 8, userText: '帮我查一下明天的天气' });
  const silent = await waitUntil(() => findEvent(events, 'voice.ack.silent'), 'the silent row');
  assert.equal(silent.payload.turn, 8);
  assert.equal(silent.payload.reason, 'draft-failed', 'the reason names the failed draft');
  assert.equal(silent.payload.draftFailed, true);
  assert.equal(plays.length, 0);
  assert.equal(events.filter((event) => event.type === 'voice.ack.spoken').length, 0);
  await lane.whenIdle();
  t.diagnostic(`silent reason=${silent.payload.reason} draftFailed=${silent.payload.draftFailed} players=0`);
});
