/**
 * Loopback diagnostic shadow (`voice.speakerShadowLoopback`, **default OFF**).
 *
 * The microphone speaker shadow is covered by `speaker-shadow.mjs` / `speaker-host-wiring.mjs`.
 * This file proves the loopback lane can be switched on for research WITHOUT touching the
 * microphone path or any hard decision:
 *
 *   1. default OFF — ambient's `startHearing` receives no `speakerShadow`, no `speaker.shadow`
 *      row and no `speaker.loopback.shadow.disabled` row; an explicit OFF reports that row once;
 *   2. ON — ambient receives `speakerShadow:true` + `speakerLibraryRoot:<root>` and a simulated
 *      loopback row keeps its `source=loopback` / `class` / `quality` / three-state verdict, while
 *      the microphone counters and `lastShadow` stay empty;
 *   3. ON — the microphone lane's own switch is unchanged and its rows aggregate separately;
 *   4. the real hearing layer writes source=loopback, never updates a template, and the host emits
 *      no `speaker.attribution.*` / lexicon row for a loopback utterance;
 *   5. delivery / barge-in stay unchanged (a loopback final is context only, not a turn);
 *   6. `speaker.status` reports microphone and loopback counts separately (`bySource`) without
 *      changing the existing fields;
 *   7. regression: `node --check`, `speaker-*`, `voice-lanes`, `ambient-*`, `node test/smoke.mjs`.
 *
 * No real microphone, model, network, TTS or GUI is touched.
 *
 * Run: node --test test/speaker-loopback-shadow.mjs
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { createSpeakerLibrary } from '../src/host/hearing/speakerVoice.js';
import { cleanupRoot } from './helpers/cleanup.mjs';

const run = promisify(execFile);
const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SPEAKER_FILE = '3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx';
const SAMPLE_RATE = 16000;
const LOOPBACK_DEVICE = 'CABLE Output (VB-Audio Virtual Cable)';
const MIC_DEVICE = 'Fake Microphone';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Child suites never need to fan out into their own regressions: this file's test 7 already runs
// the requested `speaker-*`, `voice-lanes` and `ambient-*` set.
const childEnv = {
  ...process.env,
  DSH_LOOPBACK_SHADOW_NESTED: '1',
  DSH_SPEAKER_ATTRIBUTION_NESTED: '1',
};
delete childEnv.NODE_TEST_CONTEXT;
const runSuite = (file, args = []) => run(process.execPath, [...args, file], {
  cwd: PROJECT_ROOT,
  env: childEnv,
  maxBuffer: 64 * 1024 * 1024,
});
/** Run a suite's functional tests only; each suite's own `回归` test is another aggregator. */
const runFunctionalSuite = (file) => runSuite(file, [
  '--test-skip-pattern',
  '回归|regression',
]);

/** Poll until `predicate()` is true; a missed deadline fails the test instead of hanging it. */
async function until(predicate, label, timeoutMs = 8000) {
  const startedAt = Date.now();
  while (!(await predicate())) {
    if (Date.now() - startedAt > timeoutMs) assert.fail(`timed out: ${label}`);
    await delay(10);
  }
}

// ---------------------------------------------------------------------------
// Module seams: a recording hearing + a deterministic device enumeration
// ---------------------------------------------------------------------------

const state = { starts: [], recorder: null };
globalThis.__loopbackShadowTest = state;

const hearingUrl = new URL('../src/host/hearing/hearing.js', import.meta.url).href;

const hook = registerHooks({
  load(url, context, next) {
    if (url !== hearingUrl) return next(url, context);
    return {
      format: 'module',
      shortCircuit: true,
      source: `
    const s = globalThis.__loopbackShadowTest;
    export const modelReady = () => true;
    export const finalModelReady = () => true;
    export const isLoopbackDevice = (name) => /CABLE|Stereo Mix|Virtual|Loopback/i.test(String(name));
    export const listDevices = async () => ['${MIC_DEVICE}', '${LOOPBACK_DEVICE}'];
    export const selectMicrophoneDevice = (devices, requested) => {
      const list = Array.isArray(devices) ? devices : [];
      const wanted = typeof requested === 'string' ? requested.trim() : '';
      if (wanted.length > 0 && !isLoopbackDevice(wanted)) return { device: wanted, loopback: false, error: '' };
      const mic = list.find((name) => !isLoopbackDevice(name));
      return mic === undefined
        ? { device: '', loopback: false, error: 'MIC_LOOPBACK_ONLY' }
        : { device: mic, loopback: false, error: '' };
    };
    export const startHearing = (options) => {
      const lane = isLoopbackDevice(options.device) ? 'ambient' : 'mic';
      let doneResolve;
      const done = new Promise((resolve) => { doneResolve = resolve; });
      const session = {
        device: options.device,
        instanceId: 'mock-' + (s.starts.length + 1),
        source: lane === 'ambient' ? 'loopback' : 'mic',
        stats: () => ({ rmsDb: -20, peakDb: -10 }),
        stop() { doneResolve(); },
        done,
      };
      s.starts.push({ lane, options, session });
      if (Array.isArray(s.recorder)) s.recorder.push({ lane, options, session });
      return session;
    };
    export const watchHearingExit = () => {};
    export const annotateTranscript = (text) => text;
    export const joinDetailFields = () => ({});
    export const mergeJoinFallback = () => ({});
    export const offlineLimitedNote = () => '';
    export const truncationNotice = () => '';`,
    };
  },
});
const { apply } = await import('../src/host/index.js');
hook.deregister();

after(() => { delete globalThis.__loopbackShadowTest; });

/** The real hearing module (the hook above only replaced the Host's import for this file). */
const realStartHearing = await import(`${hearingUrl}?real-loopback-shadow`);

// ---------------------------------------------------------------------------
// Host mount (same shape as speaker-host-wiring.mjs)
// ---------------------------------------------------------------------------

async function mount(t, { config = {}, settings = {}, model = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-loopback-shadow-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await mkdir(join(root, 'workspace'), { recursive: true });
  await mkdir(join(root, 'bin'), { recursive: true });
  // resolveFfmpeg only checks existence; the mocked hearing never executes it.
  await writeFile(join(root, 'bin', 'ffmpeg.exe'), Buffer.alloc(0));
  await writeFile(join(root, 'data', 'features.json'), JSON.stringify({
    hearing: true, ambient: true, voice: false, vision: false,
    subtitle: false, avatar: false, memory: false, fastpath: false,
  }));
  const stored = { ...settings };
  stored.voice = { chunking: false, ...(settings.voice ?? {}) };
  stored.ambient = { autoListen: true, ...(settings.ambient ?? {}) };
  await writeFile(join(root, 'data', 'settings.json'), JSON.stringify(stored));
  if (model) {
    await mkdir(join(root, 'models'), { recursive: true });
    await writeFile(join(root, 'models', SPEAKER_FILE), Buffer.from('fake-pinned-model'));
  }

  state.starts = [];
  const recorder = [];
  state.recorder = recorder;

  const tools = new Map();
  const routes = new Map();
  const disposers = [];
  const effect = (fn) => {
    const cleanup = fn();
    if (typeof cleanup === 'function') disposers.push(cleanup);
    return cleanup;
  };
  const scope = {
    effect,
    on: () => () => {},
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
    on: () => () => {},
    get: () => undefined,
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    inject: (_dependencies, registerScope) => registerScope(scope),
  }, {
    root,
    enabled: true,
    asrMergeWindowMs: 10,
    ffmpegPath: join(root, 'bin', 'ffmpeg.exe'),
    dependencyBootDelayMs: 60_000,
    ...config,
  });

  const listen = tools.get('assistant_listen');
  assert.ok(listen !== undefined, 'assistant_listen is registered');

  const events = async () => {
    try {
      const text = await readFile(join(root, 'data', 'events.jsonl'), 'utf8');
      return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  const waitForEvent = async (type, predicate = () => true) => {
    let hit;
    await until(async () => {
      hit = (await events()).find((event) => event.type === type && predicate(event.payload ?? {}));
      return hit !== undefined;
    }, `${type} event`);
    return hit;
  };
  const status = async () => {
    const handler = routes.get('/assistant/status');
    assert.equal(typeof handler, 'function', 'the status route is registered');
    let result = '';
    await handler({ method: 'GET', url: '/assistant/status' }, {
      writeHead() {},
      end(value) { result = value; },
    });
    return JSON.parse(result);
  };
  const action = async (body) => {
    const handler = routes.get('/assistant/action');
    assert.equal(typeof handler, 'function', 'the action route is registered');
    let result;
    await handler(
      Object.assign(Readable.from([JSON.stringify(body)]), { method: 'POST' }),
      { writeHead() {}, end(value) { result = value; } },
    );
    return JSON.parse(result);
  };
  const startMic = async () => {
    const result = await listen.execute({ action: 'start' }, {});
    assert.equal(result.ok, true, result.error);
    return recorder.find((entry) => entry.lane === 'mic');
  };
  const poll = async () => listen.execute({ action: 'poll' }, {});

  t.after(async () => {
    for (const entry of recorder) entry.session.stop();
    await cleanupRoot(root, disposers);
  });

  return {
    root,
    events,
    waitForEvent,
    status,
    action,
    startMic,
    poll,
    ambient: () => recorder.find((entry) => entry.lane === 'ambient'),
    mic: () => recorder.find((entry) => entry.lane === 'mic'),
  };
}

const ofType = (events, type) => events.filter((event) => event.type === type);
const waitForAmbient = (app) => app.waitForEvent('ambient.start', (payload) => payload.source === 'loopback');
const shadowBySource = (events, source) => ofType(events, 'speaker.shadow')
  .map((event) => event.payload)
  .filter((payload) => payload?.source === source);

// ---------------------------------------------------------------------------
// 1. Default OFF (and an explicit OFF is reported once)
// ---------------------------------------------------------------------------

test('1) 默认关闭：ambient 不带 speakerShadow，无回环 shadow；显式 false 记一次 disabled', async (t) => {
  t.timeout = 40_000;

  // (a) Nothing configured: the switch is off by default and writes no diagnostic row.
  const app = await mount(t, { config: { voice: { speakerShadow: false } } });
  const started = await waitForAmbient(app);
  assert.equal(started.payload.source, 'loopback', 'ambient runs on the loopback lane');

  const ambient = app.ambient();
  assert.ok(ambient !== undefined, 'ambient startHearing was called');
  assert.equal('speakerShadow' in ambient.options, false, 'no speakerShadow while the switch is off');
  assert.equal('speakerLibraryRoot' in ambient.options, false, 'and no library root');

  const snapshot = await app.status();
  assert.equal('bySource' in snapshot.speaker, false, 'the default-off status keeps its old shape');
  const rows = await app.events();
  assert.deepEqual(shadowBySource(rows, 'loopback'), [], 'no loopback shadow row');
  assert.deepEqual(ofType(rows, 'speaker.loopback.shadow.disabled'), [], 'default writes no disabled row');

  // (b) An explicit OFF is a different fact from the default: one row explains the absence.
  const explicit = await mount(t, { config: { voice: { speakerShadowLoopback: false } } });
  await waitForAmbient(explicit);
  assert.equal('speakerShadow' in explicit.ambient().options, false, 'explicit false still passes nothing');
  const disabled = await explicit.waitForEvent('speaker.loopback.shadow.disabled');
  assert.equal(disabled.payload.reason, 'setting-off');
  const explicitRows = await explicit.events();
  assert.equal(ofType(explicitRows, 'speaker.loopback.shadow.disabled').length, 1, 'reported once');

  // (c) The runtime setting wins over plugin config: settings=false beats config=true.
  const settingsOff = await mount(t, {
    config: { voice: { speakerShadowLoopback: true } },
    settings: { voice: { speakerShadowLoopback: false } },
  });
  await waitForAmbient(settingsOff);
  assert.equal('speakerShadow' in settingsOff.ambient().options, false, 'settings=false wins over config=true');
  await settingsOff.waitForEvent('speaker.loopback.shadow.disabled', (payload) => payload.reason === 'setting-off');

  console.log(
    `[loopback-shadow 1] default={speakerShadow:false,rows:0,statusBySource:false} `
    + `explicitOff={disabled:${ofType(explicitRows, 'speaker.loopback.shadow.disabled').length}} `
    + `settingsWins={passed:true}`,
  );
});

// ---------------------------------------------------------------------------
// 2. ON: ambient wiring + a loopback row keeps its annotation
// ---------------------------------------------------------------------------

test('2) 开启：ambient 传 speakerShadow/root，回环行 source=loopback 且质量/三态保留', async (t) => {
  t.timeout = 40_000;
  const app = await mount(t, { config: { voice: { speakerShadowLoopback: true } } });
  await waitForAmbient(app);

  const ambient = app.ambient();
  assert.equal(ambient.options.speakerShadow, true, 'the loopback diagnostic reaches hearing');
  assert.equal(ambient.options.speakerLibraryRoot, app.root, 'the shared library root is <root>');

  // What hearing emits for a loopback clip: the source and the classified verdict are preserved.
  ambient.options.onEvent('speaker.shadow', {
    decision: 'match',
    class: 'self',
    quality: 'ok',
    source: 'loopback',
    reason: 'loopback-match',
    score: 0.88,
    speakerId: 'alice',
    ms: 3,
    utteranceId: 'ambient-instance:1',
  });
  await app.waitForEvent('speaker.shadow', (payload) => payload.source === 'loopback');

  const rows = await app.events();
  const [row] = shadowBySource(rows, 'loopback');
  assert.equal(row.decision, 'match');
  assert.equal(row.class, 'self');
  assert.equal(row.quality, 'ok');
  assert.equal(row.reason, 'loopback-match');
  assert.equal(row.speakerId, 'alice');

  const snapshot = await app.status();
  assert.equal(snapshot.speaker.lastShadow, null, 'a loopback row never becomes the microphone lastShadow');
  assert.equal(snapshot.speaker.matches, 0, 'and never enters the microphone counters');
  assert.equal(snapshot.speaker.bySource.loopback.match, 1);
  assert.equal(snapshot.speaker.bySource.mic.match, 0);
  assert.deepEqual(ofType(rows, 'speaker.attribution.assigned'), [], 'no attribution event');
  assert.deepEqual(ofType(rows, 'speaker.attribution.unassigned'), [], 'not even an unassigned row');

  // The runtime setting wins over plugin config: settings=true beats config=false.
  const settingsOn = await mount(t, {
    config: { voice: { speakerShadowLoopback: false } },
    settings: { voice: { speakerShadowLoopback: true } },
  });
  await waitForAmbient(settingsOn);
  assert.equal(settingsOn.ambient().options.speakerShadow, true, 'settings=true wins over config=false');

  console.log(
    `[loopback-shadow 2] options={speakerShadow:true,root:true} row={source:${row.source},`
    + `decision:${row.decision},class:${row.class},quality:${row.quality}} `
    + `mic={matches:${snapshot.speaker.matches},lastShadow:${snapshot.speaker.lastShadow}} `
    + `loopbackCounts=${JSON.stringify(snapshot.speaker.bySource.loopback)} settingsWins=true`,
  );
});

// ---------------------------------------------------------------------------
// 3. ON: the microphone lane is independent
// ---------------------------------------------------------------------------

test('3) 开启回环不影响麦克风 shadow：各自开关、各自计数、lastShadow 只属于麦克风', async (t) => {
  t.timeout = 40_000;
  const app = await mount(t, {
    config: { voice: { speakerShadow: true, speakerShadowLoopback: true } },
    model: true,
  });
  const mic = await app.startMic();
  await waitForAmbient(app);

  assert.equal(mic.options.speakerShadow, true, 'the microphone switch still reaches its own lane');
  assert.equal(mic.options.speakerLibraryRoot, app.root);
  assert.equal(app.ambient().options.speakerShadow, true, 'the loopback switch reaches ambient');

  mic.options.onEvent('speaker.shadow', {
    decision: 'match', class: 'self', quality: 'ok', source: 'mic',
    reason: 'match', score: 0.9, speakerId: 'alice', ms: 2, utteranceId: 'mic-instance:1',
  });
  app.ambient().options.onEvent('speaker.shadow', {
    decision: 'mismatch', class: 'other', quality: 'ok', source: 'loopback',
    reason: 'mismatch', score: 0.1, speakerId: 'alice', ms: 2, utteranceId: 'ambient-instance:1',
  });
  await app.waitForEvent('speaker.shadow', (payload) => payload.source === 'loopback');
  await delay(30);

  const snapshot = await app.status();
  assert.equal(snapshot.speaker.matches, 1, 'existing counters are microphone-only');
  assert.deepEqual(snapshot.speaker.bySource.mic, { match: 1, mismatch: 0, unsure: 0 });
  assert.deepEqual(snapshot.speaker.bySource.loopback, { match: 0, mismatch: 1, unsure: 0 });
  assert.equal(snapshot.speaker.lastShadow.source, 'mic', 'the loopback row did not replace lastShadow');
  assert.equal(snapshot.speaker.lastShadow.decision, 'match');

  // A switch pair that is the other way round: only the microphone is enabled.
  const onlyMic = await mount(t, { config: { voice: { speakerShadow: true, speakerShadowLoopback: false } }, model: true });
  const mic2 = await onlyMic.startMic();
  await waitForAmbient(onlyMic);
  assert.equal(mic2.options.speakerShadow, true);
  assert.equal('speakerShadow' in onlyMic.ambient().options, false, 'the loopback lane stays off independently');

  console.log(
    `[loopback-shadow 3] mic={passed:true,counts:${JSON.stringify(snapshot.speaker.bySource.mic)}} `
    + `loopback={passed:true,counts:${JSON.stringify(snapshot.speaker.bySource.loopback)}} `
    + `lastShadow=${snapshot.speaker.lastShadow.source}/${snapshot.speaker.lastShadow.decision} `
    + `independentOff=true`,
  );
});

// ---------------------------------------------------------------------------
// 4. Read-only: no template update, no attribution, no lexicon candidate
// ---------------------------------------------------------------------------

test('4) 回环 shadow 只读：模板不变、无 attribution、不进词库候选/新记忆归属', async (t) => {
  t.timeout = 60_000;

  // (a) Real hearing: the loopback clip is scored, but `match()` never updates a template.
  const repoRoot = await mkdtemp(join(tmpdir(), 'loopback-shadow-library-'));
  const library = createSpeakerLibrary({ root: repoRoot });
  t.after(async () => {
    try { library.close(); } catch { /* already closed */ }
    await rm(repoRoot, { recursive: true, force: true }).catch(() => {});
  });
  const alice = Float32Array.from([0.9, 0.3, 0.1, 0.2]);
  assert.equal(library.register('alice', alice).ok, true);
  const beforeList = library.list();
  const beforeVector = Array.from(library.get('alice').embedding);

  const clip = await runRealClip(t, {
    speakerShadow: true,
    speakerLibrary: library,
    speakerEmbedderFactory: () => ({ embed: () => alice }),
  });
  const [shadow] = ofType(clip.events, 'speaker.shadow').map((event) => event.payload);
  assert.equal(shadow.source, 'loopback', 'the real hearing row is marked loopback');
  assert.equal(shadow.decision, 'match');
  assert.equal(shadow.class, 'self');
  assert.equal(shadow.quality, 'ok');
  assert.equal(shadow.reason, 'loopback-match');

  const afterList = library.list();
  assert.deepEqual(afterList, beforeList, 'no template metadata (including lastMatchedAt) changed');
  assert.deepEqual(Array.from(library.get('alice').embedding), beforeVector, 'the embedding is unchanged');

  // (b) Host: a loopback row and a loopback final produce no attribution/lexicon evidence.
  const app = await mount(t, { config: { voice: { speakerShadowLoopback: true } } });
  await waitForAmbient(app);
  const ambient = app.ambient();
  ambient.options.onEvent('speaker.shadow', {
    decision: 'match', class: 'self', quality: 'ok', source: 'loopback',
    reason: 'loopback-match', score: 0.88, speakerId: 'alice', ms: 3, utteranceId: 'ambient-instance:7',
  });
  ambient.options.onUpdate({ final: '视频里的话', durationMs: 500, utteranceId: 'ambient-instance:7' });
  await app.waitForEvent('ambient.utterance');
  await delay(40);

  const rows = await app.events();
  assert.deepEqual(ofType(rows, 'speaker.attribution.assigned'), [], 'no assigned attribution');
  assert.deepEqual(ofType(rows, 'speaker.attribution.unassigned'), [], 'no unassigned attribution either');
  assert.deepEqual(ofType(rows, 'lexicon.candidate.added'), [], 'no lexicon candidate from a loopback voice');
  assert.deepEqual(ofType(rows, 'memory.candidate.added'), [], 'no memory candidate from a loopback voice');
  const polled = await app.poll();
  assert.deepEqual(polled.finals, [], 'a loopback final is context only, not a delivered turn');

  console.log(
    `[loopback-shadow 4] real={source:${shadow.source},decision:${shadow.decision},`
    + `templatesSame:true,embeddingSame:true} host={attribution:0,lexicon:0,memory:0,finals:0}`,
  );
});

// ---------------------------------------------------------------------------
// 5. Delivery / barge-in unchanged
// ---------------------------------------------------------------------------

test('5) 投递/打断不变：回环片段只进环境缓冲，不产生新回合或打断事件', async (t) => {
  t.timeout = 40_000;
  const app = await mount(t, { config: { voice: { speakerShadowLoopback: true } } });
  const mic = await app.startMic();
  await waitForAmbient(app);

  mic.options.onUpdate({ final: '麦克风第一句', durationMs: 400, utteranceId: 'mic-instance:1' });
  await delay(30);
  const firstPoll = await app.poll();
  assert.deepEqual(firstPoll.finals, ['麦克风第一句'], 'the microphone delivery is unchanged');

  const ambient = app.ambient();
  ambient.options.onUpdate({ final: '电影台词', durationMs: 800, utteranceId: 'ambient-instance:1' });
  ambient.options.onEvent('speaker.shadow', {
    decision: 'match', class: 'self', quality: 'ok', source: 'loopback',
    reason: 'loopback-match', score: 0.8, speakerId: 'alice', ms: 2, utteranceId: 'ambient-instance:1',
  });
  await app.waitForEvent('ambient.utterance', (payload) => payload.text === '电影台词');
  await delay(40);

  const secondPoll = await app.poll();
  assert.deepEqual(secondPoll.finals, [], 'the loopback text never becomes a second turn');
  assert.equal(firstPoll.finals.length, 1, 'the microphone turn was delivered exactly once');
  const rows = await app.events();
  assert.deepEqual(ofType(rows, 'hearing.bargein'), [], 'no barge-in was triggered');
  assert.deepEqual(ofType(rows, 'hearing.bargein.skipped'), [], 'and nothing was skipped either');
  assert.deepEqual(ofType(rows, 'speaker.attribution.assigned'), [], 'still no attribution');

  console.log(
    `[loopback-shadow 5] first=${firstPoll.finals.join(',')} second=${secondPoll.finals.length} `
    + `bargein=${ofType(rows, 'hearing.bargein').length} skipped=${ofType(rows, 'hearing.bargein.skipped').length}`,
  );
});

// ---------------------------------------------------------------------------
// 6. Statistics split by source
// ---------------------------------------------------------------------------

test('6) 统计分开：speaker.status.bySource 区分 mic/loopback，旧字段不变', async (t) => {
  t.timeout = 40_000;
  const app = await mount(t, {
    config: { voice: { speakerShadow: true, speakerShadowLoopback: true } },
    model: true,
  });
  const mic = await app.startMic();
  await waitForAmbient(app);
  const ambient = app.ambient();

  mic.options.onEvent('speaker.shadow', {
    decision: 'match', class: 'self', quality: 'ok', source: 'mic', reason: 'match', score: 0.9, speakerId: 'alice',
  });
  mic.options.onEvent('speaker.shadow', {
    decision: 'unsure', class: 'unknown-identity', quality: 'short', source: 'mic', reason: 'too-short', score: 0,
  });
  ambient.options.onEvent('speaker.shadow', {
    decision: 'match', class: 'self', quality: 'ok', source: 'loopback', reason: 'loopback-match', score: 0.8, speakerId: 'alice',
  });
  ambient.options.onEvent('speaker.shadow', {
    decision: 'mismatch', class: 'other', quality: 'ok', source: 'loopback', reason: 'mismatch', score: 0.1, speakerId: 'alice',
  });
  ambient.options.onEvent('speaker.shadow', {
    decision: 'unsure', class: 'unknown-identity', quality: 'quiet', source: 'loopback', reason: 'quiet', score: 0,
  });
  await app.waitForEvent('speaker.shadow', (payload) => payload.source === 'loopback');
  await delay(50);

  const snapshot = await app.status();
  assert.equal(snapshot.speaker.matches, 1, 'the legacy matches counter is microphone-only');
  assert.equal(snapshot.speaker.unsure, 1);
  assert.deepEqual(snapshot.speaker.bySource.mic, { match: 1, mismatch: 0, unsure: 1 });
  assert.deepEqual(snapshot.speaker.bySource.loopback, { match: 1, mismatch: 1, unsure: 1 });

  const rows = await app.events();
  const statusRows = ofType(rows, 'speaker.status');
  // The event is throttled: the first microphone row already contains `bySource`; the full loopback
  // counts below are read from the status route, which is the authoritative live projection.
  const withSource = statusRows.find((event) => event.payload.bySource !== undefined);
  assert.ok(withSource !== undefined, 'the status event carries bySource');
  assert.deepEqual(withSource.payload.bySource.mic, { match: 1, mismatch: 0, unsure: 0 });
  assert.equal(ofType(rows, 'speaker.shadow').length, 5, 'every row is still logged as evidence');

  // `speaker.status.shadow` exposes the same split through `counts.bySource` (read-only action).
  const shadowAction = await app.action({ action: 'speaker.status.shadow' });
  assert.deepEqual(shadowAction.counts.bySource, snapshot.speaker.bySource, 'the action agrees with status');

  console.log(
    `[loopback-shadow 6] legacy={matches:${snapshot.speaker.matches},unsure:${snapshot.speaker.unsure}} `
    + `bySource=${JSON.stringify(snapshot.speaker.bySource)} rows=${ofType(rows, 'speaker.shadow').length} `
    + `actionBySource=${JSON.stringify(shadowAction.counts.bySource)}`,
  );
});

// ---------------------------------------------------------------------------
// Real-hearing clip helper
// ---------------------------------------------------------------------------

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
  }

  kill() {}
}

function tone(ms) {
  const samples = new Int16Array(Math.round((SAMPLE_RATE * ms) / 1000));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.round(Math.sin((2 * Math.PI * 440 * index) / SAMPLE_RATE) * 0.25 * 32767);
  }
  const buffer = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) buffer.writeInt16LE(samples[index], index * 2);
  return buffer;
}

function fakeStreaming({ endpointAtSamples, text }) {
  return {
    createStream: () => ({
      samples: 0,
      acceptWaveform({ samples }) { this.samples += samples.length; },
    }),
    isReady: () => false,
    decode: () => {},
    getResult: (stream) => ({ text: stream.samples > 0 ? text : '' }),
    isEndpoint: (stream) => stream.samples >= endpointAtSamples,
    reset(stream) { stream.samples = 0; },
  };
}

function fakeWorker(text) {
  const worker = new EventEmitter();
  worker.unref = () => {};
  worker.terminate = () => worker.emit('exit', null);
  worker.postMessage = (message) => {
    setImmediate(() => worker.emit('message', {
      type: 'result',
      id: message.id,
      utteranceId: message.utteranceId ?? null,
      segmentIds: [`${message.utteranceId ?? 's'}:s0`],
      text,
    }));
  };
  return worker;
}

async function runRealClip(t, { speakerShadow, speakerLibrary, speakerEmbedderFactory }) {
  const child = new FakeChild();
  const updates = [];
  const events = [];
  const clip = tone(1000);
  const hearing = realStartHearing.startHearing({
    ffmpegPath: 'ffmpeg-not-used',
    modelDir: 'models-not-used',
    finalModelDir: '',
    device: LOOPBACK_DEVICE,
    recognizer: fakeStreaming({ endpointAtSamples: clip.length / 2, text: '好' }),
    spawnProcess: () => child,
    asrWorkerFactory: () => fakeWorker('好'),
    speakerShadow,
    speakerLibrary,
    speakerEmbedderFactory,
    onUpdate: (event) => updates.push(event),
    onEvent: (type, payload) => events.push({ type, payload }),
  });
  t.after(() => hearing.stop());
  child.stdout.write(clip);
  await until(() => updates.some((event) => typeof event.final === 'string'), 'the delivered final', 4000);
  await until(() => events.some((event) => event.type === 'speaker.shadow'), 'speaker.shadow', 4000);
  await delay(20);
  hearing.stop();
  return { updates, events };
}

// ---------------------------------------------------------------------------
// 7. Regression
// ---------------------------------------------------------------------------

test('7) 回归：node --check、speaker-*、voice-lanes、ambient-*、smoke', async (t) => {
  // A nested run (speaker-attribution's / another speaker suite's own regression) already covers
  // these; skipping here keeps the fan-out bounded.
  if (process.env.DSH_LOOPBACK_SHADOW_NESTED === '1'
    || process.env.DSH_SPEAKER_ATTRIBUTION_NESTED === '1') {
    t.skip('nested run: the top-level regression already covers these suites');
    return;
  }
  t.timeout = 900_000;

  for (const file of ['src/host/index.js', 'src/host/hearing/hearing.js', 'test/speaker-loopback-shadow.mjs']) {
    await assert.doesNotReject(runSuite(join(PROJECT_ROOT, file), ['--check']), `${file} parses`);
  }

  const testDir = join(PROJECT_ROOT, 'test');
  const names = await readdir(testDir);
  const self = 'speaker-loopback-shadow.mjs';
  const suites = names
    .filter((name) => /^speaker-.*\.mjs$/u.test(name) && name !== self)
    .concat(names.filter((name) => /^ambient-.*\.mjs$/u.test(name)))
    .concat(names.filter((name) => name === 'voice-lanes.mjs'))
    .sort();
  assert.ok(suites.length >= 11, `found the speaker/ambient/voice-lanes suites: ${suites.length}`);

  const results = [];
  for (const name of suites) {
    try {
      // Only the functional tests: running a suite's own `回归` test would fan out into another
      // copy of this same regression set (and into unrelated memory/lexicon suites).
      const result = await runFunctionalSuite(join(testDir, name));
      results.push({ name, output: `${result.stdout}\n${result.stderr}`, ok: true });
    } catch (error) {
      results.push({ name, output: `${error?.stdout ?? ''}\n${error?.stderr ?? ''}`, ok: false });
    }
  }
  const failures = results.filter(({ output, ok }) => ok !== true || /\bfail [1-9]/u.test(output));
  for (const { name, output } of failures) console.error(`[7] ${name}\n${output.slice(-4000)}`);
  assert.deepEqual(failures.map(({ name }) => name), [], 'every regression suite passes');

  const smoke = await runSuite(join(testDir, 'smoke.mjs'));
  assert.match(smoke.stdout, /SMOKE TEST PASSED/u);
  console.log(`[loopback-shadow 7] node --check=ok suites=${results.length} smoke=ok`);
});
