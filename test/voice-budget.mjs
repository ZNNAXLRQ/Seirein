/**
 * A5: one speech budget for voice and captions.
 *
 * The old speaker stopped at a hard 240 characters while the subtitle kept the whole reply, so
 * the sound ended mid-answer and the caption kept going. This build:
 *
 *   1. speaks a short reply in full; the caption is exactly the spoken text (`truncated: false`);
 *   2. for a long reply, the spoken share ends on a sentence boundary at `voice.speechMaxChars`
 *      (default 1200), and the caption shows only those sentences plus `（后文见文字）`;
 *   3. never cuts a sentence in half: the last spoken sentence is complete;
 *   4. `speechMaxChars: 0` means "speak it all" (no boundary applied, no note);
 *   5. the automatic speaker, the typed round-end speaker and `assistant_say` all resolve the same
 *      `resolveSpeechBudget` value (counted through an injected resolver and the module seam);
 *   6. `voice.speech.budget` carries exactly
 *      `{requestedChars, spokenChars, truncated, keptSentences, droppedSentences}`.
 *
 * The lane tests mount the real host with a fake TTS/player/overlay; no sound, network, capture or
 * GUI is involved. Run: node --test test/voice-budget.mjs
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupRoot, disposeAll } from './helpers/cleanup.mjs';

const state = {
  synth: null,
  players: [],
  subtitles: [],
  texts: [],
  /** Every `resolveSpeechBudget` call that went through the module seam. */
  budgetCalls: [],
};
globalThis.__voiceBudget = state;

const speechTextUrl = new URL('../src/host/speech/speech-text.js', import.meta.url).href;
const ttsUrl = new URL('../src/host/speech/tts.js', import.meta.url).href;
const sightUrl = new URL('../src/host/vision/sight.js', import.meta.url).href;
const subtitleUrl = new URL('../src/host/subtitle/subtitle.js', import.meta.url).href;

const hooks = registerHooks({
  load(url, context, next) {
    if (url === speechTextUrl) {
      // Delegate to the real module, but record every budget resolution: the three lanes all
      // import this same binding, so the count is the shared-budget proof.
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    import * as real from '${speechTextUrl}?voice-budget-real';
    const state = () => globalThis.__voiceBudget;
    export const parse = (...args) => real.parse(...args);
    export const toSpeechText = (...args) => real.toSpeechText(...args);
    export const toCaptionText = (...args) => real.toCaptionText(...args);
    export const looksUnbalanced = (...args) => real.looksUnbalanced(...args);
    export const formatMessage = (...args) => real.formatMessage(...args);
    export const DEFAULT_SPEECH_MAX_CHARS = real.DEFAULT_SPEECH_MAX_CHARS;
    export const SPEECH_TRUNCATION_NOTE = real.SPEECH_TRUNCATION_NOTE;
    export const resolveSpeechBudget = (options) => {
      state().budgetCalls.push({ ...options });
      return real.resolveSpeechBudget(options);
    };`,
      };
    }
    if (url === ttsUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    const s = globalThis.__voiceBudget;
    export { resolveGptLangs, resolveGptSovitsTimeout } from '${ttsUrl}?voice-budget-helpers';
    export const configureTts = () => {};
    export const gptSovitsReferenceStatus = async () => ({ seconds: null, ok: false, readable: false });
    export const warmupGptSovits = async () => ({ ok: false, skipped: 'disabled' });
    export const applyGptSovitsModels = () => ({ ok: true });
    export const synthesize = (options) => s.synth(options);
    export const speakStreaming = async () => { throw new Error('streaming not expected'); };
    export const stopPlayback = () => true;
    export const stopTts = () => true;
    // The fake player confirms its start, so the caption is published the way the real one does.
    export const play = (file, options) => {
      s.players.push({ file, ...options });
      options?.onStart?.({ startedAt: Date.now() });
      return Promise.resolve();
    };`,
      };
    }
    if (url === sightUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    const forbidden = () => { throw new Error('real capture forbidden'); };
    export const resolveFfmpeg = () => null;
    export const resolveFfplay = () => null;
    export const capture = forbidden, captureDesktop = forbidden, captureDevice = forbidden, startStoryboard = forbidden;
    export const OBSERVATION_TTL_MS = 30000;
    export function readObservation(o, { now = Date.now(), ttlMs = 30000 } = {}) { const v = o ?? {}; const c = Number(v.capturedAt); const s = Number.isFinite(c) && c > 0 ? c : Number(v.at); const at = Number.isFinite(s) && s > 0 ? s : null; const ageMs = at === null ? null : Math.max(0, now - at); const stale = ageMs === null || ageMs >= ttlMs; return { ...v, at, ageMs, stale, hint: stale ? 'stale' : '' }; }`,
      };
    }
    if (url === subtitleUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    export const averageColor = async () => null;
    export class SubtitleOverlay {
      constructor({ config }) { this.config = config; }
      async show(text) { globalThis.__voiceBudget.subtitles.push({ text }); }
      async hide() {}
      async stop() {}
    }`,
      };
    }
    if (url === 'node:child_process') {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    export const spawn = () => { throw new Error('real process forbidden'); };
    export const execFile = () => { throw new Error('real process forbidden'); };`,
      };
    }
    return next(url, context);
  },
});

const {
  apply,
  createReplySpeaker,
  createTypedVoiceRelay,
  limitSpeechToSentences,
  resolveSpeechBudget,
  splitSentences,
  waitSpeech,
  DEFAULT_SPEECH_MAX_CHARS,
  SPEECH_TRUNCATION_NOTE,
} = await import('../src/host/index.js');
hooks.deregister();
after(() => { delete globalThis.__voiceBudget; });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/** `第1句话。第2句话。…` — sentences differ in length, so a cut is never at a round number. */
const longReply = (count) => Array.from({ length: count }, (_, index) => `第${index + 1}句话。`).join('');

/** The text the budget should speak: a prefix ending on a complete sentence. */
const expectedShare = (text, maxChars) => limitSpeechToSentences(text, { maxChars });

const BUDGET_FIELDS = ['droppedSentences', 'keptSentences', 'requestedChars', 'spokenChars', 'truncated'];

/** Speaker fixture: records every clip text and every event, in order. */
async function runSpeaker({ text, maxChars, budget } = {}) {
  const played = [];
  const events = [];
  const speaker = createReplySpeaker({
    maxChars,
    ...(budget === undefined ? {} : { budget }),
    synthesize: async ({ text: value }) => ({ file: `${value}.mp3`, bytes: 1, durationMs: 10 }),
    play: async ({ text: value }) => {
      played.push(value);
      return { audioStartedAt: Date.now(), done: Promise.resolve() };
    },
    onEvent: (event) => events.push(event),
    onBudget: (event) => events.push(event),
  });
  speaker.push(text);
  const stats = await speaker.finish({ fullText: text });
  return { played, events, stats, spoken: played.join('') };
}

// ---------------------------------------------------------------------------
// Mounted host fixture: real apply(), real assistant_say, synthetic event feed
// ---------------------------------------------------------------------------

async function mount(t, { speechMaxChars } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-voice-budget-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await writeFile(join(root, 'data', 'features.json'), JSON.stringify({
    hearing: false, ambient: false, subtitle: true,
  }));
  const settings = {
    gptSovits: { enabled: false },
    subtitle: { enabled: true, mode: 'region', region: { left: 0, top: 0, width: 320, height: 100 } },
  };
  if (speechMaxChars !== undefined) settings.voice = { speechMaxChars };
  await writeFile(join(root, 'data', 'settings.json'), JSON.stringify(settings));
  state.players = [];
  state.subtitles = [];
  state.texts = [];
  state.budgetCalls = [];
  state.synth = async ({ text }) => {
    state.texts.push(text);
    return { file: join(root, 'tts', `${state.texts.length}.mp3`), bytes: 16, durationMs: 200, provider: 'edge-tts' };
  };
  const handlers = [];
  const cleanups = [];
  const tools = new Map();
  const routes = new Map();
  const effect = (fn) => {
    const cleanup = fn();
    if (typeof cleanup === 'function') cleanups.push(cleanup);
    return cleanup;
  };
  const on = (type, handler) => {
    const entry = { type, handler };
    handlers.push(entry);
    return () => {
      const index = handlers.indexOf(entry);
      if (index >= 0) handlers.splice(index, 1);
    };
  };
  const scope = {
    effect,
    on,
    systemPrompt: { section: () => () => {} },
    webServer: {
      register(route) {
        routes.set(route.path, route.handler);
        return () => routes.delete(route.path);
      },
    },
  };
  apply({
    effect,
    on,
    tools: {
      register(tool) {
        tools.set(tool.name, tool);
        return () => tools.delete(tool.name);
      },
    },
    inject: (_deps, register) => register(scope),
  }, { root, enabled: true });

  const session = { id: 'voice-budget-session', header: { cwd: join(root, 'workspace') } };
  const emit = (target, event) => {
    for (const entry of [...handlers]) {
      if (entry.type === 'session/event') entry.handler(target, event);
    }
  };
  const events = async () => {
    try {
      const text = await readFile(join(root, 'data', 'events.jsonl'), 'utf8');
      return text.trim().split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  const waitForEvent = async (type, predicate = () => true) => {
    const started = Date.now();
    for (;;) {
      const row = (await events()).find((event) => event.type === type && predicate(event.payload ?? {}));
      if (row !== undefined) return row.payload ?? {};
      if (Date.now() - started > 3000) throw new Error(`timed out waiting for ${type}`);
      await tick(10);
    }
  };
  t.after(async () => {
    await disposeAll(cleanups.splice(0));
    await cleanupRoot(root);
  });
  const say = (args) => tools.get('assistant_say').execute(args, {});
  return { root, session, tools, emit, events, waitForEvent, say };
}

// ---------------------------------------------------------------------------
// 1. A short reply is spoken in full; speech and caption are the same text
// ---------------------------------------------------------------------------

test('1. a short reply (< 1200 chars) is spoken whole, with an identical caption and truncated:false', async (t) => {
  const text = longReply(100); // ~590 chars
  assert.ok(text.length < DEFAULT_SPEECH_MAX_CHARS, 'the fixture is shorter than the default cap');

  const { played, events, stats, spoken } = await runSpeaker({ text });
  assert.equal(spoken, text, 'every sentence played');
  assert.equal(stats.requestedChars, text.length);
  assert.equal(stats.spokenChars, text.length);
  assert.equal(stats.truncated, false);
  assert.equal(stats.droppedSentences, 0);
  const budgetEvent = events.find((event) => event.type === 'voice.speech.budget');
  assert.equal(budgetEvent.truncated, false);
  assert.equal(budgetEvent.spokenChars, text.length);
  // The host builds each caption from the clip text it receives, so the caption sequence is
  // exactly the spoken text here.
  assert.equal(played.join(''), text, 'caption source == spoken text');

  // Lane check: assistant_say shows the same line it speaks.
  const app = await mount(t);
  const said = await app.say({ text });
  assert.equal(said.accepted, true, 'the tool accepted the line for background synthesis');
  const finished = await waitSpeech(said.speechId, { timeoutMs: 3000 });
  assert.equal(finished.status, 'finished', 'the accepted speech really finished');
  assert.equal(state.texts.length, 1);
  assert.equal(state.texts[0], text, 'TTS got the whole line');
  await waitUntil(() => state.subtitles.length === 1, 'the caption was published');
  assert.equal(state.subtitles[0].text, text, 'the caption is the spoken text, not a longer body');
  const lane = await app.waitForEvent('voice.speech.budget');
  assert.equal(lane.truncated, false);
  assert.equal(lane.spokenChars, text.length);
  assert.equal(lane.requestedChars, text.length);
  t.diagnostic(`short: spoken=${stats.spokenChars}/${stats.requestedChars} truncated=false caption==speech`);
});

// ---------------------------------------------------------------------------
// 2. A long reply stops at a sentence boundary; the caption stops there too + the note
// ---------------------------------------------------------------------------

test('2. a long reply speaks on a sentence boundary; the caption shows only that share + the note', async (t) => {
  const text = longReply(400);
  assert.ok(text.length >= 2000, `the fixture is a long reply (${text.length} chars)`);
  const expected = expectedShare(text, 1200);
  assert.equal(expected.truncated, true);

  const { played, events, stats, spoken } = await runSpeaker({ text });
  assert.ok(stats.spokenChars <= 1200, `spokenChars ${stats.spokenChars} <= 1200`);
  assert.equal(stats.truncated, true);
  assert.equal(spoken, expected.text, 'the spoken share is exactly the budgeted sentence prefix');
  assert.equal(played.join(''), expected.text, 'the caption source covers the spoken share, not the whole reply');
  assert.ok(!spoken.includes(text.slice(1200)), 'no character beyond the budget reached the player');
  const budgetEvent = events.find((event) => event.type === 'voice.speech.budget');
  assert.equal(budgetEvent.requestedChars, text.length);
  assert.equal(budgetEvent.spokenChars, stats.spokenChars);
  assert.equal(budgetEvent.truncated, true);
  assert.equal(budgetEvent.keptSentences, stats.keptSentences);
  assert.equal(budgetEvent.droppedSentences, stats.droppedSentences);

  // Lane check: the tool's single subtitle is the spoken share plus one note line.
  const app = await mount(t);
  const said = await app.say({ text });
  assert.equal(said.accepted, true, 'the tool accepted the line for background synthesis');
  const finished = await waitSpeech(said.speechId, { timeoutMs: 3000 });
  assert.equal(finished.status, 'finished', 'the accepted speech really finished');
  assert.equal(state.texts.length, 1);
  assert.equal(state.texts[0], expected.text, 'TTS got exactly the budgeted share');
  await waitUntil(() => state.subtitles.length === 1, 'the caption was published');
  const caption = state.subtitles[0].text;
  assert.equal(caption, `${expected.text}\n${SPEECH_TRUNCATION_NOTE}`, 'the caption is the spoken share + note');
  assert.ok(!caption.includes(`第${400}句话。`), 'the caption never shows text the voice did not reach');
  const lane = await app.waitForEvent('voice.speech.budget');
  assert.equal(lane.truncated, true);
  assert.equal(lane.spokenChars, expected.spokenChars);
  assert.equal(lane.droppedSentences > 0, true);
  t.diagnostic(`long: spokenChars=${stats.spokenChars} requestedChars=${stats.requestedChars} truncated=${stats.truncated} kept=${stats.keptSentences} dropped=${stats.droppedSentences}; caption=${JSON.stringify(caption.slice(0, 24))}… + [${SPEECH_TRUNCATION_NOTE}] (${caption.length} chars)`);
});

// ---------------------------------------------------------------------------
// 3. The boundary never cuts a sentence in half
// ---------------------------------------------------------------------------

test('3. the budget drops whole sentences instead of cutting one in half', async (t) => {
  const first = `${'甲'.repeat(700)}。`;
  const second = `${'乙'.repeat(700)}。`;
  const third = `${'丙'.repeat(700)}。`;
  const text = `${first}${second}${third}`;
  const sourceSentences = splitSentences(text);
  assert.equal(sourceSentences.length, 3);

  const { played, stats, spoken } = await runSpeaker({ text, maxChars: 1200 });
  assert.equal(played.length, 1, 'only the first complete sentence fits');
  assert.deepEqual(played, [first], 'the clip is exactly the first sentence');
  assert.equal(spoken, first);
  assert.ok(/[。！？!?；;…]$/u.test(spoken), 'the last spoken character closes a sentence');
  assert.equal(stats.droppedSentences, 2);
  assert.equal(stats.keptSentences, 1);
  // The naive cut would have taken the first 1200 chars: 700 + part of `second`. It must not.
  assert.ok(!spoken.includes('乙'), 'the second sentence was not opened');
  for (const clip of played) {
    assert.ok(sourceSentences.includes(clip), 'every clip is a complete source sentence');
  }

  // A varying-length pair: the remaining room fits only half of the second sentence, so it is
  // dropped whole instead of being trimmed to fit.
  const short = `${'丁'.repeat(1100)}。`;
  const tail = `${'戊'.repeat(300)}。`;
  const pair = await runSpeaker({ text: `${short}${tail}`, maxChars: 1200 });
  assert.deepEqual(pair.played, [short], 'the partially-fitting sentence is dropped whole');
  assert.equal(pair.stats.spokenChars, 1101);
  assert.ok(pair.stats.spokenChars <= 1200);
  t.diagnostic(`boundary: clips=${played.length} spokenChars=${stats.spokenChars} kept=${stats.keptSentences} dropped=${stats.droppedSentences} lastChar="${spoken.at(-1)}" (no half sentence); partial-fit pair spokenChars=${pair.stats.spokenChars}`);
});

// ---------------------------------------------------------------------------
// 4. speechMaxChars: 0 means "speak it all"
// ---------------------------------------------------------------------------

test('4. speechMaxChars 0 disables the cap: the whole reply is spoken with no note', async (t) => {
  assert.deepEqual(resolveSpeechBudget({ maxChars: 0 }), { maxChars: 0, unbounded: true });
  const text = longReply(400);
  const { stats, spoken, events } = await runSpeaker({ text, maxChars: 0 });
  assert.equal(spoken, text, 'every sentence played');
  assert.equal(stats.spokenChars, text.length);
  assert.equal(stats.truncated, false);
  assert.equal(stats.droppedSentences, 0);
  const budgetEvent = events.find((event) => event.type === 'voice.speech.budget');
  assert.equal(budgetEvent.truncated, false);
  assert.equal(budgetEvent.spokenChars, text.length);

  // The same setting through the mounted tool: full TTS text, full caption, no note.
  const app = await mount(t, { speechMaxChars: 0 });
  const said = await app.say({ text });
  assert.equal(said.accepted, true, 'the tool accepted the line for background synthesis');
  const finished = await waitSpeech(said.speechId, { timeoutMs: 3000 });
  assert.equal(finished.status, 'finished', 'the accepted speech really finished');
  assert.equal(state.texts[0], text);
  await waitUntil(() => state.subtitles.length === 1, 'the caption was published');
  assert.equal(state.subtitles[0].text, text);
  assert.ok(!state.subtitles[0].text.includes(SPEECH_TRUNCATION_NOTE), 'no note when nothing was cut');
  const lane = await app.waitForEvent('voice.speech.budget');
  assert.equal(lane.truncated, false);
  assert.equal(lane.spokenChars, text.length);
  t.diagnostic(`speechMaxChars=0: spokenChars=${stats.spokenChars} truncated=${stats.truncated} note=none captionChars=${state.subtitles[0].text.length}`);
});

// ---------------------------------------------------------------------------
// 5. The three lanes resolve the same budget (injected / counted)
// ---------------------------------------------------------------------------

test('5. the auto speaker, the typed relay and assistant_say share one budget value', async (t) => {
  const text = longReply(80); // ~400 chars
  const budgetValue = 300;
  const expected = expectedShare(text, budgetValue).text;

  // Lane 1 — the sentence speaker the automatic reply lane drives, with an injected resolver.
  const speakerCalls = [];
  const auto = await runSpeaker({
    text,
    maxChars: budgetValue,
    budget: (options) => {
      speakerCalls.push(options);
      return resolveSpeechBudget(options);
    },
  });
  assert.equal(speakerCalls.length, 1, 'the automatic speaker resolves the budget once');
  assert.deepEqual(speakerCalls[0], { maxChars: budgetValue });
  assert.equal(auto.spoken, expected);
  assert.equal(auto.stats.truncated, true);

  // Lane 2 — the typed round-end relay, same injected-resolver assertion.
  const typedCalls = [];
  const typedTexts = [];
  const emitted = [];
  const relay = createTypedVoiceRelay({
    emit: async (type, payload) => { emitted.push({ type, ...payload }); },
    synthesize: async ({ text: value, sentenceId }) => {
      typedTexts.push(value);
      return { file: `${value}.mp3`, bytes: 1, durationMs: 10, captionText: value, speechText: value, sentenceId };
    },
    play: async () => ({ audioStartedAt: Date.now(), done: Promise.resolve() }),
    setting: () => true,
    inScope: () => true,
    isSubagent: () => false,
    maxChars: budgetValue,
    budget: (options) => {
      typedCalls.push(options);
      return resolveSpeechBudget(options);
    },
  });
  const session = { id: 's-budget' };
  relay.observe(session, { type: 'turn/start', data: { turn: 1 } });
  relay.observe(session, {
    type: 'user/message',
    data: { turn: 1, id: 'u-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] },
  });
  relay.observe(session, {
    type: 'assistant/message',
    data: { turn: 1, step: 1, message: { id: 'a-1', role: 'assistant', content: [{ type: 'text', text }] } },
  });
  await relay.observe(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  await relay.whenIdle();
  assert.equal(typedCalls.length, 1, 'the typed relay resolves the budget once');
  assert.deepEqual(typedCalls[0], { maxChars: budgetValue });
  assert.equal(typedTexts.join(''), expected);
  const typedBudget = emitted.find((event) => event.type === 'voice.speech.budget');
  assert.equal(typedBudget.truncated, true);
  assert.equal(typedBudget.spokenChars, expected.length);

  // Lane 3 — assistant_say in the mounted host, counted at the shared module seam.
  const app = await mount(t, { speechMaxChars: budgetValue });
  assert.deepEqual(state.budgetCalls, [], 'mounting alone resolves no budget');
  const said = await app.say({ text });
  assert.equal(said.accepted, true, 'the tool accepted the line for background synthesis');
  const finished = await waitSpeech(said.speechId, { timeoutMs: 3000 });
  assert.equal(finished.status, 'finished', 'the accepted speech really finished');
  assert.deepEqual(state.budgetCalls, [{ maxChars: budgetValue }], 'the tool resolves the budget once');
  assert.equal(state.texts[0], expected, 'the tool speaks the same share as the two streaming lanes');
  await waitUntil(() => state.subtitles.length === 1, 'the caption was published');
  assert.equal(state.subtitles[0].text, `${expected}\n${SPEECH_TRUNCATION_NOTE}`);
  assert.equal(new Set([auto.spoken, typedTexts.join(''), state.texts[0]]).size, 1, 'one budget for every lane');
  t.diagnostic(`shared budget ${budgetValue}: auto=${auto.spoken.length}, typed=${typedTexts.join('').length}, tool=${state.texts[0].length}`);
});

// ---------------------------------------------------------------------------
// 6. The budget event has exactly the documented fields
// ---------------------------------------------------------------------------

test('6. voice.speech.budget reports the five documented fields for both outcomes', async (t) => {
  const text = longReply(400);
  const truncated = await runSpeaker({ text, maxChars: 1200 });
  const cut = truncated.events.find((event) => event.type === 'voice.speech.budget');
  assert.deepEqual(Object.keys(cut).sort(), ['type', ...BUDGET_FIELDS].sort());
  assert.equal(cut.requestedChars, text.length);
  assert.equal(cut.spokenChars, truncated.stats.spokenChars);
  assert.equal(cut.truncated, true);
  assert.equal(cut.keptSentences + cut.droppedSentences, splitSentences(text).length);

  const whole = await runSpeaker({ text: longReply(50) });
  const full = whole.events.find((event) => event.type === 'voice.speech.budget');
  assert.deepEqual(Object.keys(full).sort(), ['type', ...BUDGET_FIELDS].sort());
  assert.equal(full.truncated, false);
  assert.equal(full.droppedSentences, 0);
  assert.equal(full.requestedChars, full.spokenChars);

  // The mounted tool logs the same five-field payload (no extra lane-specific keys).
  const app = await mount(t);
  await app.say({ text });
  const row = (await app.events()).find((event) => event.type === 'voice.speech.budget');
  assert.deepEqual(Object.keys(row.payload).sort(), [...BUDGET_FIELDS].sort());
  assert.equal(row.payload.truncated, true);
  assert.equal(row.payload.spokenChars, truncated.stats.spokenChars);
  assert.equal(row.payload.requestedChars, text.length);
  t.diagnostic(`event fields=${Object.keys(row.payload).sort().join(',')} | cut=${JSON.stringify({ requestedChars: cut.requestedChars, spokenChars: cut.spokenChars, truncated: cut.truncated, keptSentences: cut.keptSentences, droppedSentences: cut.droppedSentences })}`);
});
