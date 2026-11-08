/**
 * Observability wiring in the mounted host.
 *
 * These tests drive the REAL plugin (`apply` + the real voice round / `assistant_say`) with a
 * scripted TTS transport, player, microphone and overlay, and check only the wiring:
 *  1. one voice round writes `voice.tts.request` with purpose/chars/slotWaitMs/requestMs/engine;
 *  2. every synthesis lane carries its own purpose (`say`/`ack`/`tool`/`answer`/`ack-warm`), and
 *     the streamed answer transport is tagged `answer`;
 *  3. `voice.pipeline.timeline` carries the first-chunk breakdown and its stages add up;
 *  4. `voice.endpointProbe:false` reaches hearing as `endpointProbe:false` (its own suite proves
 *     that mode writes zero probe rows) and no simulated probe row is produced;
 *  5. `voice.endpointProbeMs` reaches hearing unchanged;
 *  6. text, clip order and first-audio evidence are identical with the probe on and off.
 *
 * Run: node --test test/observability-wiring.mjs
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupRoot, disposeAll } from './helpers/cleanup.mjs';

const state = {
  root: '',
  onUpdate: null,
  hearing: [],
  ttsHooks: null,
  ttsCalls: [],
  players: [],
  subtitles: [],
  synthSeq: 0,
  synthDelayMs: 6,
  ffplay: null,
};
globalThis.__obsWiring = state;

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
    const s = globalThis.__obsWiring;
    export const modelReady = () => true;
    export const finalModelReady = () => false;
    export const isLoopbackDevice = (name) => /CABLE|Stereo Mix|Virtual/i.test(String(name));
    export const listDevices = async () => ['Fake Mic', 'CABLE Input (Fake)'];
    export const startHearing = (options) => {
      s.hearing.push({ ...options });
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
    const s = globalThis.__obsWiring;
    export { resolveGptLangs, resolveGptSovitsTimeout } from '${ttsUrl}?obs-wiring-helpers';
    export { speakChunks, speechChunkTexts } from '${ttsUrl}?obs-wiring-chunk';
    export const configureTts = (options) => { s.ttsHooks = options; };
    export const gptSovitsReferenceStatus = async () => ({ seconds: null, ok: false, readable: false });
    export const warmupGptSovits = async () => ({ ok: false, skipped: 'disabled' });
    export const applyGptSovitsModels = () => ({ ok: true });
    export const synthesize = async (options) => {
      const startedAt = Date.now();
      s.ttsCalls.push({ ...options, at: startedAt });
      if (s.synthDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, s.synthDelayMs));
      const chars = [...String(options.text ?? '')].length;
      s.ttsHooks?.onTtsRequest?.({
        level: 'debug',
        purpose: String(options.purpose ?? 'speech'),
        engine: 'fake',
        chars,
        slotWaitMs: 0,
        requestMs: Math.max(0, Date.now() - startedAt),
        totalMs: Math.max(0, Date.now() - startedAt),
        ok: true,
        errorCode: null,
        cached: false,
        chunkIndex: Number.isInteger(options.chunkIndex) ? options.chunkIndex : null,
        sentenceId: Number.isInteger(options.sentenceId) ? options.sentenceId : null,
        coldStart: true,
      });
      s.synthSeq += 1;
      return {
        file: s.root + '/tts/' + s.synthSeq + '.mp3',
        bytes: 32,
        durationMs: 120,
        provider: 'fake',
      };
    };
    export const speakStreaming = async (options) => {
      s.ttsCalls.push({ ...options, streamed: true, at: Date.now() });
      s.synthSeq += 1;
      return { file: s.root + '/tts/' + s.synthSeq + '.mp3', bytes: 32, durationMs: 120, firstChunkMs: 1, via: 'file', provider: 'fake' };
    };
    export const play = (file, options) => {
      const startedAt = Date.now();
      s.players.push({ file, at: startedAt });
      options?.onStart?.({
        startedAt, spawnAt: startedAt, playerReadyAt: startedAt, playerReadyMs: 1,
        firstDataAt: startedAt, firstDataMs: 1, firstDataIsAudible: false,
        firstPcmAt: null, firstAudibleAt: null,
      });
      return new Promise((resolve) => setTimeout(() => resolve({ exitCode: 0 }), 8));
    };
    export const stopPlayback = () => true;
    export const stopTts = () => true;`,
      };
    }
    if (url === sightUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    const forbidden = () => { throw new Error('real capture forbidden'); };
    export const resolveFfmpeg = () => 'ffmpeg-fake';
    export const resolveFfplay = () => globalThis.__obsWiring.ffplay;
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
    export { SubtitleHold } from '${subtitleUrl}?obs-wiring-real';
    export class SubtitleOverlay {
      constructor({ config }) { this.config = config; }
      async show(text) { globalThis.__obsWiring.subtitles.push({ text, at: Date.now() }); return true; }
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
after(() => { delete globalThis.__obsWiring; });

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const waitUntil = async (check, message, timeoutMs = 8000) => {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out: ${message}`);
    await tick(10);
  }
};

/** One mounted host with fake microphone/TTS/player/overlay. */
async function mount(t, {
  replyText = '这是今天的第一条答复。',
  holdReply = false,
  ackDelayMs = null,
  voice = {},
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-obs-wiring-'));
  state.root = root;
  state.onUpdate = null;
  state.hearing = [];
  state.ttsHooks = null;
  state.ttsCalls = [];
  state.players = [];
  state.subtitles = [];
  state.synthSeq = 0;
  state.ffplay = null;
  await mkdir(join(root, 'data'), { recursive: true });
  await mkdir(join(root, 'workspace'), { recursive: true });
  await mkdir(join(root, 'tts'), { recursive: true });
  await writeFile(join(root, 'data', 'features.json'), JSON.stringify({
    hearing: true, ambient: false, voice: true, vision: false, subtitle: false,
    avatar: false, memory: false, fastpath: false,
  }));
  await writeFile(join(root, 'data', 'settings.json'), JSON.stringify({
    gptSovits: { enabled: false },
    langs: { speech: 'zh', subtitle: 'zh' },
    autoMemory: { enabled: false },
    voice: { chunking: true, ...(ackDelayMs === null ? {} : { ackDelayMs }) },
  }));

  const gate = holdReply ? deferred() : null;
  const listeners = new Set();
  const cleanups = [];
  const tools = new Map();
  const services = new Map([
    ['agentDefaultModel', { currentSelection: () => ({ provider: 'fake-provider', model: 'fake-model' }) }],
    ['sessionTitle', { get: () => undefined, rename: (_session, title) => ({ title, source: { kind: 'user' } }) }],
    ['workspaceRegistry', {
      async create(path) { return { id: 'ws-obs-wiring', path }; },
      get() { return { id: 'ws-obs-wiring', async attachSession() {} }; },
    }],
  ]);
  const agents = new Map();
  let persisted = false;
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
          type, seq: turnId, time: Date.now(), data,
        });
        void (async () => {
          fire('turn/start', { turn: turnId });
          fire('user/message', message);
          if (isDigest !== true && gate !== null) await gate.promise;
          fire('assistant/message', {
            turn: turnId,
            step: 1,
            message: { id: `a-${turnId}`, role: 'assistant', content: [{ type: 'text', text: replyText }] },
          });
          fire('turn/end', { turn: turnId, reason: { kind: 'completed' } });
        })().catch(() => {});
      },
    };
  };
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
  }, { root, enabled: true, asrMergeWindowMs: 10, voice });

  const listen = tools.get('assistant_listen');
  const started = await listen.execute({ action: 'start' });
  assert.equal(started.ok, true, `listening started: ${started.error ?? ''}`);

  const events = async () => {
    try {
      const text = await readFile(join(root, 'data', 'events.jsonl'), 'utf8');
      return text.trim().split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  const waitForEvent = async (type, predicate = () => true, timeoutMs = 8000) => {
    const startedAt = Date.now();
    for (;;) {
      const row = (await events()).find((event) => event.type === type && predicate(event.payload ?? {}));
      if (row !== undefined) return row.payload ?? {};
      if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out waiting for ${type}`);
      await tick(10);
    }
  };
  const sessionId = voiceSessionTarget({ root }).sessionId;
  const sessionFor = (id) => (id === sessionId
    ? state.loopSession ?? { id, header: { cwd: join(root, 'workspace') } }
    : { id, header: { cwd: join(root, 'workspace') } });
  const dispose = async () => {
    gate?.resolve();
    await tick(20);
    await disposeAll(cleanups.splice(0));
    await cleanupRoot(root);
  };
  t.after(dispose);
  return {
    root,
    sessionId,
    say: (text) => state.onUpdate({ final: text, durationMs: 100 }),
    toolSay: (args) => tools.get('assistant_say').execute(
      typeof args === 'string' ? { text: args } : args,
      { agent: { session: sessionFor(sessionId) } },
    ),
    releaseReply: () => gate?.resolve(),
    events,
    waitForEvent,
    dispose,
  };
}

// ---------------------------------------------------------------------------
// 1. A voice round writes `voice.tts.request` with the required fields
// ---------------------------------------------------------------------------
test('1. a voice round emits voice.tts.request with purpose/chars/slotWaitMs/requestMs/engine', async (t) => {
  const app = await mount(t);
  app.say('你好');
  const row = await app.waitForEvent('voice.tts.request', (event) => event.purpose === 'answer');
  for (const key of ['purpose', 'chars', 'slotWaitMs', 'requestMs', 'engine']) {
    assert.ok(key in row, `voice.tts.request carries ${key}`);
  }
  assert.equal(row.purpose, 'answer');
  assert.equal(row.engine, 'fake');
  assert.ok(row.chars > 0, `chars ${row.chars}`);
  assert.ok(Number.isInteger(row.slotWaitMs) && row.slotWaitMs >= 0, `slotWaitMs ${row.slotWaitMs}`);
  assert.ok(Number.isInteger(row.requestMs) && row.requestMs >= 0, `requestMs ${row.requestMs}`);
  console.log(`1. purpose=${row.purpose} chars=${row.chars} slotWaitMs=${row.slotWaitMs} requestMs=${row.requestMs} engine=${row.engine}`);
});

// ---------------------------------------------------------------------------
// 2. Every synthesis call site carries its lane purpose
// ---------------------------------------------------------------------------
test('2. each lane tags its synthesis: say / ack / tool / answer / ack-warm / streamed answer', async (t) => {
  const source = await readFile(new URL('../src/host/index.js', import.meta.url), 'utf8');
  for (const [label, pattern] of [
    ['onTtsRequest hook', /onTtsRequest: noteTtsRequest/],
    ['speakLine -> say', /purpose: 'say'/],
    ['ack -> ack', /purpose: 'ack'/],
    ['say tool -> tool', /purpose: 'tool'/],
    ['reply block -> answer + sentenceId', /purpose: 'answer', sentenceId/],
    ['ack warm -> ack-warm', /purpose: 'ack-warm'/],
    ['streamed answer -> answer', /purpose: 'answer'/],
  ]) {
    assert.match(source, pattern, `${label} is wired in src/host/index.js`);
  }
  // The chunked body passes both the block number and the sentence id to synthesis.
  assert.match(source, /synthesizeBlock = \(text, blockSignal, priority = 0, chunkIndex = 0\)/, 'blocks carry chunkIndex');
  // `playStreaming` must ACCEPT and FORWARD the purpose to speakStreaming; a call-site property it
  // drops would leave the streamed request row untagged.
  assert.match(source, /purpose = 'speech'/u, 'playStreaming takes a purpose');
  assert.match(source, /speakStreaming\(\{[\s\S]{0,300}?\n\s*purpose,/u, 'speakStreaming receives the purpose');

  // Live proof for the streaming transport: an explicit standalone line uses the streamed path
  // when a player exists, and its request row is tagged `answer` (the say lane's streamed outlet).
  const app = await mount(t);
  state.ffplay = 'fake-player';
  const said = await app.toolSay({ text: '我查一下。', purpose: 'explicit', play: true });
  assert.equal(said.accepted, true, `streamed line accepted: ${said.reason ?? ''}`);
  await waitUntil(() => state.ttsCalls.some((call) => call.streamed === true), 'the streamed line reached TTS');
  const streamed = state.ttsCalls.find((call) => call.streamed === true);
  assert.equal(streamed.purpose, 'answer', 'the streamed answer transport is tagged answer');
  state.ffplay = null;
  console.log(`2. source wiring found: say, ack, tool, answer+sentenceId, ack-warm; streamed purpose=${streamed.purpose}`);
});

// ---------------------------------------------------------------------------
// 3. The three observable purposes really travel through the host
// ---------------------------------------------------------------------------
test('3. ack/tool/answer requests keep their own purpose and the block number', async (t) => {
  const app = await mount(t, { holdReply: true, ackDelayMs: 500, replyText: '第一条答复。' });
  app.say('你好');
  await tick(50);
  const toolSay = await app.toolSay({ text: '正在处理。', purpose: 'progress', play: false });
  assert.equal(toolSay.accepted, true, `tool line accepted: ${toolSay.reason ?? ''}`);
  const tool = await app.waitForEvent('voice.tts.request', (event) => event.purpose === 'tool');
  assert.equal(tool.chunkIndex, null, 'a whole tool line has no block number');
  const ack = await app.waitForEvent('voice.tts.request', (event) => event.purpose === 'ack');
  assert.ok(ack.chars > 0, `ack chars ${ack.chars}`);
  app.releaseReply();
  const answer = await app.waitForEvent('voice.tts.request', (event) => event.purpose === 'answer' && event.chunkIndex === 0);
  assert.equal(answer.sentenceId, 0, 'the first answer sentence is block 0 of sentence 0');
  console.log(`3. tool chars=${tool.chars}; ack chars=${ack.chars}; answer chunk=${answer.chunkIndex} sentence=${answer.sentenceId}`);
});

// ---------------------------------------------------------------------------
// 4. The first-chunk breakdown is present and adds up
// ---------------------------------------------------------------------------
test('4. voice.pipeline.timeline carries the first-chunk breakdown, consistent with the tts row', async (t) => {
  const app = await mount(t, { replyText: '第一条答复。' });
  app.say('你好');
  const timeline = await app.waitForEvent('voice.pipeline.timeline');
  const keys = [
    'firstChunkQueueWaitMs', 'firstChunkTranslateMs', 'firstChunkKanaMs',
    'firstChunkTtsMs', 'firstChunkChars', 'ttsColdStart',
  ];
  for (const key of keys) assert.ok(key in timeline, `timeline carries ${key}`);
  assert.equal(timeline.ttsColdStart, true);
  assert.equal(timeline.firstChunkKanaMs, 0, 'kana shares the translation request, no separate stage');
  assert.equal(timeline.firstChunkTranslateMs, 0, 'zh -> zh needs no translation');
  assert.ok(Number.isInteger(timeline.firstChunkQueueWaitMs));
  assert.ok(Number.isInteger(timeline.firstChunkTtsMs) && timeline.firstChunkTtsMs >= 0);
  assert.ok(Number.isInteger(timeline.firstChunkChars) && timeline.firstChunkChars > 0);
  // The row's characters name the FIRST block, not the whole sentence.
  const row = await app.waitForEvent('voice.tts.request', (event) => event.purpose === 'answer');
  assert.equal(timeline.firstChunkChars, row.chars, 'timeline chars come from the same first-block row');
  // translate + queue + pure synth must explain the measured first-block stage (small scheduling slack).
  const derived = timeline.firstChunkTranslateMs + timeline.firstChunkQueueWaitMs + timeline.firstChunkTtsMs;
  const measured = timeline.firstChunkSynthMs - timeline.spokenFirstSentenceMs;
  assert.ok(
    Math.abs(derived - measured) < 100,
    `translate ${timeline.firstChunkTranslateMs} + queue ${timeline.firstChunkQueueWaitMs} `
      + `+ tts ${timeline.firstChunkTtsMs} = ${derived}ms vs measured ${measured}ms`,
  );
  console.log(`4. queue=${timeline.firstChunkQueueWaitMs} translate=${timeline.firstChunkTranslateMs} `
    + `kana=${timeline.firstChunkKanaMs} tts=${timeline.firstChunkTtsMs} chars=${timeline.firstChunkChars} `
    + `cold=${timeline.ttsColdStart} derived=${derived} measured=${measured}`);
});

// ---------------------------------------------------------------------------
// 5. endpointProbe / endpointProbeMs reach both hearing lanes
// ---------------------------------------------------------------------------
test('5. voice.endpointProbe:false and a custom endpointProbeMs reach hearing', async (t) => {
  // Both capture lanes (microphone and loopback) must receive the switch, not just the first one.
  const source = await readFile(new URL('../src/host/index.js', import.meta.url), 'utf8');
  assert.equal(
    (source.match(/endpointProbe: config\?\.voice\?\.endpointProbe !== false/gu) ?? []).length,
    2,
    'both startHearing call sites carry endpointProbe',
  );
  assert.equal(
    (source.match(/endpointProbeMs: Number\(config\?\.voice\?\.endpointProbeMs\) > 0/gu) ?? []).length,
    2,
    'both startHearing call sites carry endpointProbeMs',
  );
  const off = await mount(t, { voice: { endpointProbe: false, endpointProbeMs: 900 } });
  const mic = state.hearing[0];
  assert.equal(mic.endpointProbe, false, 'the microphone lane gets endpointProbe:false');
  assert.equal(mic.endpointProbeMs, 900, 'the custom silence point is passed through');
  // The host passed the switch; hearing's own suite proves `false` writes zero probe rows. Here we
  // also prove the host does not synthesize a probe row of its own for that configuration.
  off.say('你好');
  await off.waitForEvent('voice.tts.request', (event) => event.purpose === 'answer');
  const probeRows = (await off.events()).filter((row) => String(row.type).startsWith('hearing.endpoint.'));
  assert.deepEqual(probeRows, [], 'no endpoint probe rows with the probe off');
  await off.dispose();

  const on = await mount(t);
  const defaults = state.hearing[0];
  assert.equal(defaults.endpointProbe, true, 'the probe defaults on');
  assert.equal(defaults.endpointProbeMs, undefined, 'no override means hearing keeps its 1200 ms default');
  console.log('5. off: endpointProbe=false ms=900; on: endpointProbe=true ms=undefined');
});

// ---------------------------------------------------------------------------
// 6. No behaviour regression with the probe on/off (same fake harness)
// ---------------------------------------------------------------------------
test('6. text, clip order and first audio are identical with the probe on and off', async (t) => {
  const run = async (voice) => {
    const app = await mount(t, { replyText: '第一条答复。第二条答复。', voice });
    app.say('你好');
    const first = await app.waitForEvent('voice.first-sentence');
    const timeline = await app.waitForEvent('voice.pipeline.timeline');
    await waitUntil(() => state.players.length > 0, 'the first clip reached the player');
    const snapshot = {
      texts: state.ttsCalls.map((call) => String(call.text ?? '')),
      purposes: state.ttsCalls.map((call) => String(call.purpose ?? '')),
      players: state.players.map((player) => String(player.file).split(/[\\/]/u).pop()),
      sentences: first.sentences,
      chars: first.chars,
      played: first.played,
      firstAudioMs: timeline.firstAudioMs,
    };
    await app.dispose();
    return snapshot;
  };
  const off = await run({ endpointProbe: false });
  const on = await run({ endpointProbe: true });
  assert.deepEqual(off.texts, on.texts, 'the same speech text in the same order');
  assert.deepEqual(off.purposes, on.purposes, 'the same lane purposes in the same order');
  assert.deepEqual(off.players, on.players, 'the same clips in the same order');
  assert.equal(off.sentences, on.sentences);
  assert.equal(off.chars, on.chars);
  assert.equal(off.played, on.played);
  assert.ok(Number(off.firstAudioMs) >= 0 && Number(on.firstAudioMs) >= 0, 'both rounds measured first audio');
  console.log(`6. texts=${off.texts.length} players=${off.players.length} sentences=${off.sentences} `
    + `chars=${off.chars} firstAudioMs=${off.firstAudioMs}/${on.firstAudioMs}`);
});
