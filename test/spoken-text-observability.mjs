/**
 * 口语版文本观测：`voice.spoken.text`（debug）。
 *
 * The event log used to keep only `voice.spoken.version {chars}`, so "the audio and the text do not
 * match" (or the audio carried the previous round) could not be checked. This build adds ONE
 * observation row per spoken outlet and per turn:
 *
 *   {turn, purpose:'typed'|'answer', bodyChars, spokenChars, spokenText, source,
 *    groupId?, answerVersion?, truncated?, topicOverlap}
 *
 * `spokenText` is the text the outlet handed to speech (not a regenerated string), bounded to 200
 * characters with an explicit `truncated:true`. It never carries the user's input or the persona.
 * The switch is `config.voiceSpokenTextLog` (default on, local diagnosis only).
 *
 * What this test proves:
 *   1. the typed outlet's row is complete and its spokenText equals the captured speech text;
 *   2. the answer outlet's row carries groupId/answerVersion and stays in sync with the version row;
 *   3. the 200-character bound plus the `truncated` marker, without cutting what is played;
 *   4. the switch off writes ZERO rows while the rest of the log and the speech stay identical;
 *   5. delivery and playback are byte-for-byte unchanged by the observation;
 *   6. one row per turn even when the outlet itself runs twice (throttle).
 *
 * Run: node --test test/spoken-text-observability.mjs
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupRoot, disposeAll } from './helpers/cleanup.mjs';

const state = { players: [], texts: [], synth: null, onUpdate: null };
globalThis.__spokenText = state;

const ttsUrl = new URL('../src/host/speech/tts.js', import.meta.url).href;
const sightUrl = new URL('../src/host/vision/sight.js', import.meta.url).href;
const subtitleUrl = new URL('../src/host/subtitle/subtitle.js', import.meta.url).href;
const hearingUrl = new URL('../src/host/hearing/hearing.js', import.meta.url).href;

const hooks = registerHooks({
  load(url, context, next) {
    if (url === hearingUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    const s = globalThis.__spokenText;
    export const modelReady = () => true;
    export const finalModelReady = () => false;
    export const isLoopbackDevice = (name) => /CABLE|Stereo Mix|Virtual/i.test(String(name));
    export const listDevices = async () => ['Fake Mic'];
    export const startHearing = (options) => {
      s.onUpdate = options.onUpdate;
      return { device: options.device, stop() {}, stats: () => ({ rmsDb: -20 }) };
    };
    export const watchHearingExit = () => {};
    export const annotateTranscript = (text) => text;
    export const joinDetailFields = () => ({});
    export const mergeJoinFallback = () => ({});
    export const offlineLimitedNote = () => '';
    export const truncationNotice = () => '';`,
      };
    }
    if (url === ttsUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    const s = globalThis.__spokenText;
    export { resolveGptLangs, resolveGptSovitsTimeout } from '${ttsUrl}?spoken-text-helpers';
    export const configureTts = () => {};
    export const gptSovitsReferenceStatus = async () => ({ seconds: null, ok: false, readable: false });
    export const warmupGptSovits = async () => ({ ok: false, skipped: 'disabled' });
    export const applyGptSovitsModels = () => ({ ok: true });
    export const synthesize = (options) => s.synth(options);
    export const speakStreaming = async () => { throw new Error('streaming not expected'); };
    export const stopPlayback = () => true;
    export const stopTts = () => true;
    export const play = (file, options) => {
      let resolve;
      const done = new Promise((doneResolve) => { resolve = doneResolve; });
      s.players.push({ file, ...options, resolve });
      resolve();
      return done;
    };`,
      };
    }
    if (url === sightUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    const forbidden = () => { throw new Error('real capture forbidden'); };
    export const resolveFfmpeg = () => 'ffmpeg-fake';
    export const resolveFfplay = () => null;
    export const capture = forbidden, captureDesktop = forbidden, captureDevice = forbidden, startStoryboard = forbidden;
    export const OBSERVATION_TTL_MS = 30000;
    export function readObservation(o) { return { ...(o ?? {}), stale: false }; }`,
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
      async show() { return true; }
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
const { apply, voiceSessionTarget } = await import('../src/host/index.js');
hooks.deregister();
after(() => { delete globalThis.__spokenText; });

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const codePoints = (text) => [...String(text ?? '')].length;
const waitUntil = async (check, message, timeoutMs = 6000) => {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out: ${message}`);
    await tick(10);
  }
};

// ---------------------------------------------------------------------------
// Round texts
// ---------------------------------------------------------------------------

/** Long by both measures (>120 characters and >2 sentences): always condensed. */
const LONG_BODY = '先说结论：明天出门要带伞，因为下午有雨。具体来说，上午云量逐渐增多，中午以后降水概率升到七成，傍晚还有一阵较强的风。必要条件是带上防水外套和一把结实的伞。下一步：今晚先把伞放进包里，明早出门前再看一次雷达图。另外，如果临时有变，我会再提醒你。';
/** What the (fake) rewrite model returns: shorter than the body, no preamble, real content. */
const SPOKEN_REWRITE = '结论：明天出门要带伞，下午有雨，先看雷达图。';
const SHORT_BODY = '现在下午三点。';
/** 17 characters x 16 = 272 code points: longer than the 200-character log bound. */
const READ_BODY = '第一段先说明结论，明天出门要带伞。'.repeat(16);

// ---------------------------------------------------------------------------
// Mounted host fixture: real apply(), fake TTS/player/hearing/LLM, real event log
// ---------------------------------------------------------------------------

async function mount(t, { voice = false, config = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-spoken-text-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await mkdir(join(root, 'workspace'), { recursive: true });
  await writeFile(join(root, 'data', 'features.json'), JSON.stringify({
    hearing: voice, ambient: false, voice: true, vision: false,
    subtitle: true, avatar: false, memory: true, fastpath: false,
  }));
  await writeFile(join(root, 'data', 'settings.json'), JSON.stringify({
    gptSovits: { enabled: false },
    langs: { speech: 'zh', subtitle: 'zh' },
    voice: { chunking: false },
    subtitle: { enabled: true, mode: 'region', region: { left: 0, top: 0, width: 320, height: 100 } },
  }));
  state.players = [];
  state.texts = [];
  state.onUpdate = null;
  // This mount's own captures: a second mount inside one test must not re-point them.
  const players = state.players;
  const texts = state.texts;
  state.synth = async ({ text }) => {
    texts.push(text);
    return {
      file: join(root, 'tts', `${texts.length}.mp3`), bytes: 16, durationMs: 200, provider: 'edge-tts',
    };
  };

  const streamOf = (text) => (async function* generate() {
    yield { type: 'text-delta', text };
    yield { type: 'finish', reason: { kind: 'stop' } };
  })();
  /** Fake LLM: a spoken rewrite is answered with SPOKEN_REWRITE, anything else with a filler. */
  const spokenRequests = [];
  const llm = {
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }] } }),
    stream(options) {
      const system = String(options?.system ?? '');
      const user = String(options?.messages?.[0]?.content?.[0]?.text ?? '');
      const spokenRequest = system.includes('可直接朗读的口语版') || user.includes('<完整答复>');
      if (spokenRequest) spokenRequests.push(options);
      return streamOf(spokenRequest ? SPOKEN_REWRITE : '稍等，我在查。');
    },
  };

  const listeners = new Set();
  const cleanups = [];
  const tools = new Map();
  const services = new Map([
    ['llm', llm],
    ['agentDefaultModel', { currentSelection: () => ({ provider: 'fake-provider', model: 'fake-model' }) }],
    ['sessionTitle', { get: () => undefined, rename: (_session, title) => ({ title, source: { kind: 'user' } }) }],
    ['workspaceRegistry', {
      async create(path) { return { id: 'ws-spoken-text', path }; },
      get() { return { id: 'ws-spoken-text', async attachSession() {} }; },
    }],
  ]);
  const bus = {
    on(type, fn) {
      const entry = { type, fn };
      listeners.add(entry);
      return () => listeners.delete(entry);
    },
    fire(type, ...args) {
      for (const entry of [...listeners]) {
        if (entry.type !== type) continue;
        try { entry.fn(...args); } catch { /* isolate like the real bus */ }
      }
    },
  };
  // Voice lane only: a turn that ends with one committed body. Typed rounds are driven directly
  // below (no agent loop needed), so this stays a plain synthetic feed.
  const makeAgent = (sessionId) => {
    const session = { id: sessionId, header: { cwd: join(root, 'workspace') }, append() {} };
    let turn = 0;
    return {
      id: sessionId,
      session,
      followup(message) {
        turn += 1;
        const turnId = turn;
        const text = JSON.stringify(message?.content ?? message);
        const isDigest = text.includes('以下内容作为长期约束与背景');
        const fire = (type, data) => bus.fire('session/event', session, {
          type, seq: turnId * 10 + 1, time: Date.now(), data,
        });
        void (async () => {
          fire('turn/start', { turn: turnId });
          fire('user/message', message);
          if (isDigest !== true) {
            fire('assistant/message', {
              turn: turnId,
              step: 1,
              message: { id: `a-${turnId}`, role: 'assistant', content: [{ type: 'text', text: SHORT_BODY }] },
            });
          }
          fire('turn/end', { turn: turnId, reason: { kind: 'completed' } });
        })().catch(() => {});
      },
    };
  };
  const agents = new Map();
  let persisted = false;
  services.set('agentLoop', {
    async resume(_ownerCtx, options) {
      if (!persisted) throw new Error('not persisted yet');
      const id = options.resumeSessionId;
      if (!agents.has(id)) agents.set(id, makeAgent(id));
      return { agent: agents.get(id) };
    },
    async createAgent(_ownerCtx, options) {
      const agent = makeAgent(options.sessionId);
      agents.set(options.sessionId, agent);
      persisted = true;
      return { agent };
    },
  });

  const effect = (fn) => {
    const cleanup = fn();
    if (typeof cleanup === 'function') cleanups.push(cleanup);
    return cleanup;
  };
  apply({
    effect,
    on: bus.on,
    get: (name) => services.get(name),
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    inject: (_deps, registerScope) => {
      registerScope({
        effect,
        on: bus.on,
        systemPrompt: { section: () => () => {} },
        webServer: { register: () => () => {} },
      });
    },
    webServer: { register: () => () => {} },
  }, { root, enabled: true, asrMergeWindowMs: 10, ...config });

  // The typed lane: a session whose messages were never registered as a voice delivery. Same
  // event shapes the real feed writes (turn/start, user/message, assistant/message, turn/end).
  const typedSession = { id: 'spoken-text-typed', header: { cwd: join(root, 'workspace') }, append() {} };
  let typedSeq = 0;
  const driveTyped = (turn, { body, utterance = '明天出门要注意什么' }) => {
    const fire = (type, data) => bus.fire('session/event', typedSession, { type, seq: ++typedSeq, time: Date.now(), data });
    fire('turn/start', { turn });
    fire('user/message', {
      turn, id: `u-${turn}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: utterance }],
    });
    fire('assistant/message', {
      turn, step: 1, message: { id: `a-${turn}`, role: 'assistant', content: [{ type: 'text', text: body }] },
    });
    fire('turn/end', { turn, reason: { kind: 'completed' } });
  };

  let voiceSay = null;
  if (voice) {
    const listen = tools.get('assistant_listen');
    const started = await listen.execute({ action: 'start' });
    assert.equal(started.ok, true, `listening started: ${started.error ?? ''}`);
    voiceSay = (text) => state.onUpdate({ final: text, durationMs: 100 });
  }

  const events = async () => {
    try {
      const text = await readFile(join(root, 'data', 'events.jsonl'), 'utf8');
      return text.trim().split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  const waitForEvent = async (type, predicate = () => true, timeoutMs = 6000) => {
    const startedAt = Date.now();
    for (;;) {
      const row = (await events()).find((event) => event.type === type && predicate(event.payload ?? {}));
      if (row !== undefined) return row.payload ?? {};
      if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out waiting for ${type}`);
      await tick(10);
    }
  };
  const rowsOf = async (type) => (await events()).filter((event) => event.type === type);

  t.after(async () => {
    for (const player of [...players]) player.resolve();
    await tick(20);
    await disposeAll(cleanups.splice(0));
    await cleanupRoot(root);
  });
  return {
    root,
    typedSession,
    driveTyped,
    voiceSay,
    events,
    rowsOf,
    waitForEvent,
    players: () => players,
    texts: () => texts,
    spokenRequests,
  };
}

// ---------------------------------------------------------------------------
// 1. Typed outlet: complete row, and spokenText is exactly the captured speech
// ---------------------------------------------------------------------------

test('1. the typed outlet logs the spoken version it handed to speech', async (t) => {
  const app = await mount(t);
  app.driveTyped(1, { body: LONG_BODY });
  const row = await app.waitForEvent('voice.spoken.text', (payload) => payload.purpose === 'typed');
  const spoken = await app.waitForEvent('voice.typed.spoken', (payload) => payload.turn === 1);

  assert.equal(row.turn, 1, 'the row names the round');
  assert.equal(row.purpose, 'typed');
  assert.equal(row.source, 'condensed', 'the rewrite was adopted');
  assert.equal(row.bodyChars, codePoints(LONG_BODY), 'bodyChars counts the body');
  assert.equal(row.spokenChars, codePoints(SPOKEN_REWRITE));
  assert.equal(row.spokenText, SPOKEN_REWRITE, 'spokenText is the decided expression');
  assert.equal(row.truncated, undefined, 'a short expression is stored whole');
  assert.ok(row.topicOverlap > 0 && row.topicOverlap <= 1,
    `topicOverlap=${row.topicOverlap} shows the two expressions share wording`);
  assert.equal('groupId' in row, false, 'a typed round has no response group');
  assert.equal('answerVersion' in row, false);

  const captured = app.texts().join('');
  assert.equal(captured, SPOKEN_REWRITE, 'the speaker received exactly that text');
  assert.equal(row.spokenText, captured, 'the logged text equals the captured speech');
  assert.equal(spoken.sentences, 1);

  const version = await app.waitForEvent('voice.spoken.version', (payload) => payload.purpose === 'typed');
  assert.equal(version.source, row.source, 'the text row agrees with the version row');
  assert.equal(version.chars, row.spokenChars);
  t.diagnostic(
    `typed turn1: source=${row.source} bodyChars=${row.bodyChars} spokenChars=${row.spokenChars} `
    + `captured=${JSON.stringify(captured)} topicOverlap=${row.topicOverlap} truncated=none`,
  );
});

// ---------------------------------------------------------------------------
// 2. Answer outlet: groupId/answerVersion, and the row matches the version decision
// ---------------------------------------------------------------------------

test('2. the answer outlet carries groupId and answerVersion', async (t) => {
  const app = await mount(t, { voice: true });
  app.voiceSay('现在几点');
  const row = await app.waitForEvent('voice.spoken.text', (payload) => payload.purpose === 'answer');
  const version = await app.waitForEvent('voice.spoken.version');

  assert.equal(row.purpose, 'answer');
  assert.equal(row.source, 'original', 'a short natural answer is spoken verbatim');
  assert.equal(row.spokenText, SHORT_BODY);
  assert.equal(row.spokenChars, codePoints(SHORT_BODY));
  assert.equal(row.bodyChars, codePoints(SHORT_BODY));
  assert.ok(Number.isSafeInteger(row.turn) && row.turn > 0, 'the annotation row names the turn');
  assert.equal(typeof row.groupId, 'string');
  assert.ok(row.groupId.length > 0, 'the answer row names its response group');
  assert.ok(Number.isSafeInteger(row.answerVersion) && row.answerVersion >= 1,
    `answerVersion=${row.answerVersion}`);
  assert.equal('truncated' in row, false);

  const captured = app.texts().join('');
  assert.equal(captured, SHORT_BODY);
  assert.equal(row.spokenText, captured, 'the logged text equals what was played');
  assert.equal(version.source, row.source);
  assert.equal(version.chars, row.spokenChars);
  t.diagnostic(
    `answer turn${row.turn}: groupId=${row.groupId} answerVersion=${row.answerVersion} `
    + `source=${row.source} spokenChars=${row.spokenChars} captured=${JSON.stringify(captured)}`,
  );
});

// ---------------------------------------------------------------------------
// 3. The 200-character bound and the `truncated` marker never cut the speech
// ---------------------------------------------------------------------------

test('3. spokenText is cut at 200 characters and marked truncated, playback untouched', async (t) => {
  const app = await mount(t);
  app.driveTyped(3, { body: READ_BODY, utterance: '详细讲一下那边的安排' });
  const row = await app.waitForEvent('voice.spoken.text', (payload) => payload.turn === 3);
  const spoken = await app.waitForEvent('voice.typed.spoken', (payload) => payload.turn === 3);

  const points = [...READ_BODY];
  assert.equal(row.source, 'original', 'an explicit "read it all" is spoken verbatim');
  assert.equal(row.spokenChars, points.length);
  assert.ok(row.spokenChars > 200, `spokenChars=${row.spokenChars} exceeds the log bound`);
  assert.equal(row.truncated, true);
  assert.equal([...row.spokenText].length, 201, '200 characters plus one ellipsis');
  assert.equal(row.spokenText, `${points.slice(0, 200).join('')}…`);
  assert.ok(row.spokenText.endsWith('…'));
  assert.equal(row.bodyChars, points.length);
  assert.equal(spoken.chars, points.length, 'the round still spoke the whole body');
  assert.ok(app.texts().length > 0, 'the player received the untruncated sentences');
  assert.ok(app.texts().join('').length > 200, 'playback was never cut by the log bound');
  t.diagnostic(
    `typed turn3: bodyChars=${row.bodyChars} spokenChars=${row.spokenChars} `
    + `loggedLen=${[...row.spokenText].length} truncated=${row.truncated} `
    + `playedChars=${app.texts().join('').length}`,
  );
});

// ---------------------------------------------------------------------------
// 4. Switch off: zero rows, the rest of the log and the speech are unchanged
// ---------------------------------------------------------------------------

test('4. config.voiceSpokenTextLog=false writes zero rows', async (t) => {
  const app = await mount(t, { config: { voiceSpokenTextLog: false } });
  app.driveTyped(4, { body: LONG_BODY });
  const spoken = await app.waitForEvent('voice.typed.spoken', (payload) => payload.turn === 4);

  const rows = await app.events();
  assert.equal(rows.filter((event) => event.type === 'voice.spoken.text').length, 0,
    'the switch suppresses every text row');
  assert.equal(rows.filter((event) => event.type === 'voice.spoken.version').length, 1,
    'the existing version row is still written');
  assert.equal(app.texts().join(''), SPOKEN_REWRITE, 'speech is unchanged by the switch');
  assert.equal(spoken.sentences, 1);
  t.diagnostic(
    `switch off: voice.spoken.text=0 voice.spoken.version=1 `
    + `captured=${JSON.stringify(app.texts().join(''))}`,
  );
});

// ---------------------------------------------------------------------------
// 5. Observation never changes delivery or playback (same round, switch on vs off)
// ---------------------------------------------------------------------------

test('5. the row changes neither delivery nor playback', async (t) => {
  // Off first: its state is global, so the "on" mount below must not overwrite a snapshot.
  const read = async (app) => ({
    texts: [...app.texts()],
    clips: app.players().length,
    replies: (await app.rowsOf('voice.reply')).map(({ payload }) => ({
      ok: payload.ok, chars: payload.chars,
    })),
    versions: (await app.rowsOf('voice.spoken.version')).map(({ payload }) => ({
      purpose: payload.purpose, source: payload.source, chars: payload.chars,
      adopted: payload.adopted, refused: payload.refused, decision: payload.decision,
    })),
    textRows: (await app.rowsOf('voice.spoken.text')).length,
  });

  const off = await mount(t, { voice: true, config: { voiceSpokenTextLog: false } });
  off.voiceSay('现在几点');
  await off.waitForEvent('voice.spoken.version');
  const offState = await read(off);

  const on = await mount(t, { voice: true });
  on.voiceSay('现在几点');
  const row = await on.waitForEvent('voice.spoken.text', (payload) => payload.purpose === 'answer');
  const onState = await read(on);

  assert.equal(offState.textRows, 0);
  assert.equal(onState.textRows, 1);
  assert.deepEqual(onState.texts, offState.texts, 'the same speech text was synthesized');
  assert.equal(onState.clips, offState.clips, 'the same number of clips played');
  assert.deepEqual(onState.replies, offState.replies, 'the delivery row is unchanged');
  assert.deepEqual(onState.versions, offState.versions, 'the spoken-version decision is unchanged');
  assert.equal(row.spokenText, onState.texts.join(''));
  t.diagnostic(
    `on: textRows=1 clips=${onState.clips} texts=${JSON.stringify(onState.texts)}; `
    + `off: textRows=0 clips=${offState.clips} texts=${JSON.stringify(offState.texts)}; `
    + `delivery rows and version rows identical`,
  );
});

// ---------------------------------------------------------------------------
// 6. Throttle: one row per turn even when the outlet itself runs twice
// ---------------------------------------------------------------------------

test('6. one row per turn even when the same outlet runs twice', async (t) => {
  const app = await mount(t);
  app.driveTyped(6, { body: '重复触发测试的第一句。' });
  await app.waitForEvent('voice.typed.spoken', (payload) => payload.turn === 6);
  // The identical round end is delivered again: the outlet really speaks a second time.
  app.driveTyped(6, { body: '重复触发测试的第一句。' });
  await waitUntil(async () => (await app.rowsOf('voice.typed.spoken')).length === 2,
    'the outlet ran twice');

  const textRows = (await app.rowsOf('voice.spoken.text')).filter(({ payload }) => payload.turn === 6);
  const typedRows = (await app.rowsOf('voice.typed.spoken')).filter(({ payload }) => payload.turn === 6);
  assert.equal(typedRows.length, 2, 'the spoken outlet itself produced two rows');
  assert.equal(textRows.length, 1, 'the observation row is throttled to one per turn');
  assert.equal(textRows[0].payload.spokenText, '重复触发测试的第一句。');
  assert.equal(app.players().length, 2, 'playback is unchanged by the throttle');
  t.diagnostic(
    `turn6: voice.typed.spoken=${typedRows.length} voice.spoken.text=${textRows.length} `
    + `clips=${app.players().length}`,
  );
});
