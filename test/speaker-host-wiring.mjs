/**
 * Speaker-voice shadow, HOST side: config → startHearing, status aggregation, enable-time T1
 * download and the read-only settings row. The capture layer is already tested in
 * `speaker-shadow.mjs`; this file proves the host actually connects it and adds no delivery path.
 *
 *   1. default OFF — hearing receives no `speakerShadow`, no `speaker.*` event exists;
 *   2. ON via config or settings — `speakerShadow:true` + `speakerLibraryRoot:<root>` reach
 *      `startHearing`, settings win over config, and status.model follows the model file;
 *   3. `speaker.shadow` rows are aggregated into status.speaker (matches/unsure/noSpeakers/
 *      lastShadow) and `speaker.status` is throttled;
 *   4. enabling with a missing model starts the T1 download (`downloading`), a failure becomes
 *      `missing` + errors, and starting capture / delivering a final still works;
 *   5. the settings row renders OFF / ON / model-missing and files `voice.speakerShadow`;
 *   6. a verdict never changes the delivered text or its order (host path, plus a real-hearing
 *      match run with a fake embedder);
 *   7. regression: `speaker-voice` / `speaker-shadow` / `voice-lanes` / `hearing-*` / smoke.
 *
 * No microphone, model file, network, TTS or GUI is touched.
 *
 * Run: node --test test/speaker-host-wiring.mjs
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
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
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A suite must run as a plain `node <file>`: inheriting the parent runner's `NODE_TEST_CONTEXT`
 * makes node:test switch the child to its serialized IPC reporter instead of human output.
 */
const childEnv = { ...process.env };
delete childEnv.NODE_TEST_CONTEXT;
const runSuite = (file, args = []) => run(process.execPath, [...args, file], {
  cwd: PROJECT_ROOT,
  env: childEnv,
  maxBuffer: 64 * 1024 * 1024,
});

/** Poll until `predicate()` is true; a missed deadline fails the test instead of hanging it. */
async function until(predicate, label, timeoutMs = 4000) {
  const startedAt = Date.now();
  while (!(await predicate())) {
    if (Date.now() - startedAt > timeoutMs) assert.fail(`timed out: ${label}`);
    await delay(10);
  }
}

// ---------------------------------------------------------------------------
// Module seams: a recording hearing + a controllable speaker-model downloader
// ---------------------------------------------------------------------------

const state = {
  starts: [],
  onUpdate: null,
  onEvent: null,
  sessions: [],
  download: null,
  downloads: [],
};
globalThis.__speakerHostTest = state;

const hearingUrl = new URL('../src/host/hearing/hearing.js', import.meta.url).href;
const modelDownloadUrl = new URL('../src/host/platform/modelDownload.js', import.meta.url).href;

const hook = registerHooks({
  load(url, context, next) {
    if (url === hearingUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    const s = globalThis.__speakerHostTest;
    export const modelReady = () => true;
    export const finalModelReady = () => true;
    export const isLoopbackDevice = (name) => /CABLE|Stereo Mix|Virtual/i.test(String(name));
    export const selectMicrophoneDevice = (devices, requested) => ({
      device: requested || devices[0] || '', loopback: false, error: '',
    });
    export const listDevices = async () => ['Fake Mic'];
    export const startHearing = (options) => {
      s.starts.push(options);
      s.onUpdate = options.onUpdate;
      s.onEvent = options.onEvent;
      let doneResolve;
      const done = new Promise((resolve) => { doneResolve = resolve; });
      const session = {
        device: options.device,
        stats: () => ({ rmsDb: -20, peakDb: -10 }),
        stop() { doneResolve(); },
        done,
      };
      s.sessions.push(session);
      return session;
    };
    export const watchHearingExit = () => {};
    export const annotateTranscript = (text) => text;
    export const joinDetailFields = () => ({});
    export const mergeJoinFallback = () => ({});
    export const offlineLimitedNote = () => '';
    export const truncationNotice = () => '';`,
      };
    }
    if (url === modelDownloadUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    import { basename, dirname, join, resolve } from 'node:path';
    export const SPEAKER_MODEL_FILE = '${SPEAKER_FILE}';
    export function speakerModelTarget({ modelDir = '', finalModelDir = '' } = {}) {
      const base = finalModelDir || modelDir;
      return base ? join(dirname(base), SPEAKER_MODEL_FILE) : '';
    }
    export function isSharedModelTarget(targetPath) {
      return typeof targetPath === 'string' && targetPath.length > 0 && basename(dirname(resolve(targetPath))) === 'models';
    }
    export function vadModelTarget() { return ''; }
    export function ensureVadModel() { return Promise.reject(new Error('vad download forbidden')); }
    export function ensureSpeakerModel(options) {
      const s = globalThis.__speakerHostTest;
      s.downloads.push(options);
      return new Promise((done, fail) => { s.download = { options, done, fail }; });
    }`,
      };
    }
    return next(url, context);
  },
});
const { apply } = await import('../src/host/index.js');
hook.deregister();

after(() => { delete globalThis.__speakerHostTest; });

const realHearingUrl = `${hearingUrl}?real-speaker-host`;
let realStartHearing = null;

// ---------------------------------------------------------------------------
// Host mount
// ---------------------------------------------------------------------------

async function mount(t, { config = {}, settings = {}, model = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-speaker-host-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await mkdir(join(root, 'workspace'), { recursive: true });
  await writeFile(join(root, 'data', 'features.json'), JSON.stringify({
    hearing: true, ambient: false, voice: false, vision: false,
    subtitle: false, avatar: false, memory: false, fastpath: false,
  }));
  await writeFile(join(root, 'data', 'settings.json'), JSON.stringify({
    langs: { speech: 'zh', subtitle: 'zh' },
    autoMemory: { enabled: false },
    voice: { chunking: false },
    ...settings,
  }));
  if (model) {
    await mkdir(join(root, 'models'), { recursive: true });
    await writeFile(join(root, 'models', SPEAKER_FILE), Buffer.from('fake-pinned-model'));
  }

  state.starts = [];
  state.onUpdate = null;
  state.onEvent = null;
  state.sessions = [];
  state.download = null;
  state.downloads = [];

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
  }, { root, enabled: true, asrMergeWindowMs: 10, ...config });

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
  const action = async (body) => {
    const handler = routes.get('/assistant/action');
    assert.equal(typeof handler, 'function', 'the action route is registered');
    const { Readable } = await import('node:stream');
    let result;
    await handler(
      Object.assign(Readable.from([JSON.stringify(body)]), { method: 'POST' }),
      { writeHead() {}, end(value) { result = value; } },
    );
    return JSON.parse(result);
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
  const start = async () => listen.execute({ action: 'start' }, {});
  const poll = async () => listen.execute({ action: 'poll' }, {});
  const say = async (text, durationMs = 200) => state.onUpdate({ final: text, durationMs });

  t.after(async () => {
    for (const session of state.sessions) session.stop();
    await cleanupRoot(root, disposers);
  });

  return { root, start, poll, say, action, status, events, waitForEvent, listen };
}

const ofType = (events, type) => events.filter((event) => event.type === type);
const speakerEvents = (events) => events.filter((event) => event.type.startsWith('speaker.'));

// ---------------------------------------------------------------------------
// 1. Default OFF
// ---------------------------------------------------------------------------

test('1) 默认关闭：startHearing 未收到 speakerShadow，speaker 事件为零，投递照常', async (t) => {
  const app = await mount(t, { config: { voice: { speakerShadow: false } } });
  const started = await app.start();
  assert.equal(started.ok, true, started.error);

  const options = state.starts.at(-1);
  assert.equal('speakerShadow' in options, false, 'the option is not passed while the shadow is off');
  assert.equal('speakerLibraryRoot' in options, false, 'and neither is the library root');

  const snapshot = await app.status();
  assert.deepEqual(snapshot.speaker, {
    enabled: false, model: 'missing', lastShadow: null,
    matches: 0, unsure: 0, noSpeakers: 0, errors: 0,
  });

  await app.say('你好');
  await delay(30);
  const polled = await app.poll();
  assert.deepEqual(polled.finals, ['你好'], 'delivery is unchanged');

  const rows = await app.events();
  assert.deepEqual(speakerEvents(rows), [], 'no speaker.* event at all');
  console.log(`[speaker-host 1] speakerShadowInOptions=${'speakerShadow' in options} speakerEvents=0 finals=${polled.finals.length}`);
});

// ---------------------------------------------------------------------------
// 2. Config/settings wiring + model state
// ---------------------------------------------------------------------------

test('2) 开启：配置与 settings 生效、传参正确，status.model 跟随模型文件', async (t) => {
  // (a) plugin config ON, model present.
  const configOn = await mount(t, { config: { voice: { speakerShadow: true } }, model: true });
  assert.equal((await configOn.start()).ok, true);
  let options = state.starts.at(-1);
  assert.equal(options.speakerShadow, true, 'config.voice.speakerShadow reaches startHearing');
  assert.equal(options.speakerLibraryRoot, configOn.root, 'the library root is <root>');
  let snapshot = await configOn.status();
  assert.equal(snapshot.speaker.enabled, true);
  assert.equal(snapshot.speaker.model, 'ready', 'the present model file is reported ready');

  // (b) settings ON overrides config OFF.
  const settingsOn = await mount(t, {
    config: { voice: { speakerShadow: false } },
    settings: { voice: { chunking: false, speakerShadow: true } },
    model: true,
  });
  assert.equal((await settingsOn.start()).ok, true);
  options = state.starts.at(-1);
  assert.equal(options.speakerShadow, true, 'settings.voice.speakerShadow reaches startHearing');
  assert.equal(options.speakerLibraryRoot, settingsOn.root);

  // (c) settings OFF overrides config ON (the runtime setting is authoritative).
  const settingsOff = await mount(t, {
    config: { voice: { speakerShadow: true } },
    settings: { voice: { chunking: false, speakerShadow: false } },
    model: true,
  });
  assert.equal((await settingsOff.start()).ok, true);
  options = state.starts.at(-1);
  assert.equal('speakerShadow' in options, false, 'settings=false wins over config=true');

  console.log(`[speaker-host 2] config={passed:true,root:true,model:ready} settings={passed:true,offWins:true}`);
});

// ---------------------------------------------------------------------------
// 3. Status aggregation + throttled speaker.status
// ---------------------------------------------------------------------------

test('3) speaker.shadow → status 汇总；speaker.status 节流', async (t) => {
  const app = await mount(t, { config: { voice: { speakerShadow: true } }, model: true });
  assert.equal((await app.start()).ok, true);

  state.onEvent('speaker.shadow', { decision: 'match', score: 0.91, speakerId: 'alice', ms: 2, utteranceId: 1 });
  state.onEvent('speaker.shadow', { decision: 'unsure', score: 0.45, speakerId: 'bob', ms: 1, utteranceId: 2 });
  state.onEvent('speaker.shadow', { decision: 'no-speakers' });
  state.onEvent('speaker.shadow', { decision: 'no-match', score: 0.12, speakerId: 'bob', ms: 1, utteranceId: 3 });

  const snapshot = await app.status();
  assert.equal(snapshot.speaker.matches, 1);
  assert.equal(snapshot.speaker.unsure, 1);
  assert.equal(snapshot.speaker.noSpeakers, 1);
  assert.equal(snapshot.speaker.errors, 0);
  assert.equal(snapshot.speaker.lastShadow.decision, 'no-match');
  assert.equal(snapshot.speaker.lastShadow.score, 0.12);
  assert.equal(snapshot.speaker.lastShadow.speakerId, 'bob');
  assert.ok(Number.isFinite(snapshot.speaker.lastShadow.at), 'lastShadow carries a timestamp');

  await app.waitForEvent('speaker.status', (payload) => payload.matches === 1);
  const rows = await app.events();
  assert.equal(ofType(rows, 'speaker.shadow').length, 4, 'every verdict is still logged as evidence');
  assert.equal(ofType(rows, 'speaker.status').length, 1, 'four verdicts in the window produce one status row');
  console.log('[speaker-host 3] matches=1 unsure=1 noSpeakers=1 last=no-match/0.12 statusEvents=1');
});

// ---------------------------------------------------------------------------
// 4. Missing model: T1 download → failure, capture/delivery unaffected
// ---------------------------------------------------------------------------

test('4) 模型缺失：开启触发 T1（downloading）→ failed 变 missing，听觉与投递照常', async (t) => {
  const app = await mount(t, { config: { voice: { speakerShadow: false } } });
  let snapshot = await app.status();
  assert.equal(snapshot.speaker.model, 'missing');

  const enabled = await app.action({ action: 'voice.speakerShadow', enabled: true });
  assert.equal(enabled.ok, true, enabled.error);
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.model, 'downloading', 'enabling starts the T1 download');
  assert.equal(state.downloads.length, 1, 'exactly one download task');
  assert.equal(state.downloads[0].targetPath, join(app.root, 'models', SPEAKER_FILE), 'the pinned target');

  snapshot = await app.status();
  assert.equal(snapshot.speaker.model, 'downloading');
  assert.equal(snapshot.speaker.enabled, true);
  await app.waitForEvent('speaker.enabled', (payload) => payload.source === 'settings');

  // The download fails: the shadow reports the error, the capture is still allowed to start.
  state.download.options.onEvent('speaker.model.failed', { reason: 'network' });
  state.download.fail(Object.assign(new Error('network'), { reason: 'network' }));
  await until(async () => (await app.status()).speaker.model === 'missing', 'model back to missing');
  snapshot = await app.status();
  assert.equal(snapshot.speaker.errors, 1, 'the failure is counted');
  await app.waitForEvent('speaker.model.failed', (payload) => payload.reason === 'network');

  const started = await app.start();
  assert.equal(started.ok, true, `capture starts despite the missing model: ${started.error ?? ''}`);
  const options = state.starts.at(-1);
  assert.equal(options.speakerShadow, true, 'the enabled shadow still reaches hearing');
  assert.equal(state.downloads.length, 2, 'start re-arms the T1 download, but does not wait for it');
  assert.equal((await app.status()).speaker.model, 'downloading');

  // Delivery continues while the download is still pending, and after it fails again.
  await app.say('好');
  await delay(30);
  let polled = await app.poll();
  assert.deepEqual(polled.finals, ['好'], 'a final is delivered while the model download is in flight');
  state.download.options.onEvent('speaker.model.failed', { reason: 'network' });
  state.download.fail(Object.assign(new Error('network'), { reason: 'network' }));
  await until(async () => (await app.status()).speaker.model === 'missing', 'second failure settles');
  await app.say('还在');
  await delay(30);
  polled = await app.poll();
  assert.deepEqual(polled.finals, ['还在'], 'delivery continues after the failure');
  assert.equal((await app.status()).speaker.errors, 2);

  console.log(`[speaker-host 4] model=downloading→missing errors=2 downloads=${state.downloads.length} `
    + `captureStart=ok finals=${['好', '还在'].join(',')}`);
});

// ---------------------------------------------------------------------------
// 5. Settings row
// ---------------------------------------------------------------------------

const clientSource = await readFile(join(PROJECT_ROOT, 'client.js'), 'utf8');
const rowStart = clientSource.indexOf('    function speakerShadowRow(h, { status, busy, act }) {');
const rowEnd = clientSource.indexOf('    function Panel() {', rowStart);
assert.ok(rowStart > 0 && rowEnd > rowStart, 'the shipped speakerShadowRow is found in client.js');
const loadSpeakerRow = () => new Function(
  'styles',
  `${clientSource.slice(rowStart, rowEnd)}\nreturn speakerShadowRow;`,
)(new Proxy({}, { get: (_target, key) => ({ marker: String(key) }) }));
const speakerRow = loadSpeakerRow();
const h = (type, props, ...children) => ({ type, props: props ?? {}, children });
const walk = (node, visit) => {
  if (node === null || node === undefined || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const child of node) walk(child, visit); return; }
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
};
const textsOf = (tree) => {
  const texts = [];
  walk(tree, (node) => {
    for (const child of node.children ?? []) if (typeof child === 'string') texts.push(child);
  });
  return texts;
};
const buttonOf = (tree) => {
  let found = null;
  walk(tree, (node) => { if (found === null && node.type === 'button') found = node; });
  assert.ok(found !== null, 'the row renders a toggle button');
  return found;
};

test('5) 设置页：关闭/开启/模型缺失三种状态与开关动作', async () => {
  const calls = [];
  const act = async (body, tag) => { calls.push({ body, tag }); return { ok: true }; };
  const render = (speaker, busy = '') => speakerRow(h, {
    status: { speaker }, busy, act,
  });

  const off = render({ enabled: false, model: 'missing', matches: 0, unsure: 0, noSpeakers: 0, errors: 0 });
  assert.equal(buttonOf(off).children[0], '已关闭', 'default OFF is shown as 已关闭');
  assert.ok(textsOf(off).some((text) => text.includes('默认关闭')), 'the hint says it is off by default');
  assert.ok(textsOf(off).some((text) => text.includes('模型缺失')), 'the missing model is visible');
  assert.deepEqual(buttonOf(off).props.style, { marker: 'btn' });
  await buttonOf(off).props.onClick();
  assert.deepEqual(calls.at(-1), {
    body: { action: 'voice.speakerShadow', enabled: true }, tag: 'speaker-shadow',
  }, 'the off button asks the host to enable it');

  const ready = render({ enabled: true, model: 'ready', matches: 2, unsure: 1, noSpeakers: 3, errors: 0 });
  assert.equal(buttonOf(ready).children[0], '已开启');
  const readyText = textsOf(ready).join(' ');
  assert.match(readyText, /已开启/u);
  assert.match(readyText, /模型就绪/u);
  assert.match(readyText, /匹配 2 · 不确定 1 · 无声纹 3 · 错误 0/u);
  await buttonOf(ready).props.onClick();
  assert.deepEqual(calls.at(-1).body, { action: 'voice.speakerShadow', enabled: false }, 'the on button turns it off');

  const downloading = render({ enabled: true, model: 'downloading', matches: 0, unsure: 0, noSpeakers: 0, errors: 1 });
  assert.ok(textsOf(downloading).some((text) => text.includes('模型下载中')), 'download progress is visible');

  assert.match(clientSource, /speakerShadowRow\(h, \{ status, busy, act \}\),/u, 'the row is mounted in the 听觉 card');
  console.log('[speaker-host 5] off=已关闭/模型缺失 on=已开启/模型就绪 downloading=模型下载中 action=voice.speakerShadow');
});

// ---------------------------------------------------------------------------
// 6. Verdicts never touch delivery
// ---------------------------------------------------------------------------

test('6) 判定不参与投递：宿主侧文本与顺序不变；真实 hearing 的 match 也不变', async (t) => {
  const app = await mount(t, { config: { voice: { speakerShadow: true } }, model: true });
  assert.equal((await app.start()).ok, true);

  await app.say('第一句');
  await delay(30);
  const first = await app.poll();
  state.onEvent('speaker.shadow', { decision: 'match', score: 0.93, speakerId: 'alice', ms: 1, utteranceId: 1 });

  await app.say('第二句');
  await delay(30);
  const second = await app.poll();

  assert.deepEqual(first.finals, ['第一句'], 'the first final keeps its text');
  assert.deepEqual(second.finals, ['第二句'], 'the second final keeps its text and order');
  assert.deepEqual([...first.finals, ...second.finals], ['第一句', '第二句']);

  // Real hearing: one fake embedder matching an enrolled voice; the delivered text must be
  // byte-identical to the same clip with the shadow OFF, and `speaker.shadow` exists only in the ON run.
  if (realStartHearing === null) {
    realStartHearing = (await import(realHearingUrl)).startHearing;
  }
  const realRoot = await mkdtemp(join(tmpdir(), 'speaker-host-real-'));
  const library = createSpeakerLibrary({ root: realRoot });
  t.after(async () => {
    try { library.close(); } catch { /* already closed */ }
    await rm(realRoot, { recursive: true, force: true }).catch(() => {});
  });
  const alice = Float32Array.from([0.9, 0.3, 0.1, 0.2]);
  assert.equal(library.register('alice', alice).ok, true);

  const clip = (speakerShadow) => runRealClip(t, {
    speakerShadow,
    speakerLibrary: speakerShadow ? library : undefined,
    speakerEmbedderFactory: speakerShadow ? () => ({ embed: () => alice }) : undefined,
  });
  const offRun = await clip(false);
  const onRun = await clip(true);
  // Compare the delivered words/order and the per-utterance ids; `endpointAt` is a wall clock.
  const delivered = (result) => result.updates
    .filter((event) => typeof event.final === 'string')
    .map((event) => ({ final: event.final, utteranceId: event.utteranceId }));
  assert.deepEqual(delivered(onRun), delivered(offRun), 'the delivered text and order are byte-identical');
  assert.deepEqual(delivered(onRun), [{ final: '好', utteranceId: 1 }], 'one unchanged final');
  const shadows = onRun.events.filter((event) => event.type === 'speaker.shadow');
  assert.equal(shadows.length, 1);
  assert.equal(shadows[0].payload.decision, 'match');
  assert.equal(shadows[0].payload.speakerId, 'alice');
  assert.deepEqual(offRun.events.filter((event) => event.type === 'speaker.shadow'), []);

  console.log(`[speaker-host 6] hostOrder=${first.finals[0]},${second.finals[0]} `
    + `realOnFinal=${delivered(onRun)[0]?.final} realDecision=${shadows[0].payload.decision} identical=true`);
});

// ---- real-hearing clip helpers (same shape as speaker-shadow.mjs) ----------

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
  const hearing = realStartHearing({
    ffmpegPath: 'ffmpeg-not-used',
    modelDir: 'models-not-used',
    finalModelDir: '',
    device: 'fake-device',
    recognizer: fakeStreaming({ endpointAtSamples: clip.length / 2, text: '好' }),
    spawnProcess: () => child,
    asrWorkerFactory: () => fakeWorker('好'),
    speakerShadow,
    ...(speakerLibrary === undefined ? {} : { speakerLibrary }),
    ...(speakerEmbedderFactory === undefined ? {} : { speakerEmbedderFactory }),
    onUpdate: (event) => updates.push(event),
    onEvent: (type, payload) => events.push({ type, payload }),
  });
  t.after(() => hearing.stop());
  child.stdout.write(clip);
  await until(() => updates.some((event) => typeof event.final === 'string'), 'the delivered final');
  if (speakerShadow) await until(() => events.some((event) => event.type === 'speaker.shadow'), 'speaker.shadow');
  await delay(20);
  hearing.stop();
  return { updates, events };
}

// ---------------------------------------------------------------------------
// 7. Regression
// ---------------------------------------------------------------------------

test('7) 回归：node --check、speaker-voice/speaker-shadow/voice-lanes/hearing-*、smoke', async (t) => {
  t.timeout = 900_000;
  for (const file of ['src/host/index.js', 'src/host/hearing/speakerVoice.js', 'client.js', 'test/speaker-host-wiring.mjs']) {
    await assert.doesNotReject(runSuite(join(PROJECT_ROOT, file), ['--check']), `${file} parses`);
  }

  const testDir = join(PROJECT_ROOT, 'test');
  const names = await readdir(testDir);
  const suites = names
    .filter((name) => /^hearing-.*\.mjs$/u.test(name)
      || ['speaker-voice.mjs', 'speaker-shadow.mjs', 'voice-lanes.mjs'].includes(name))
    .sort()
    .map((name) => join(testDir, name));
  assert.ok(suites.length >= 7, `found the speaker/hearing suites: ${suites.length}`);

  const results = [];
  for (const suite of suites) {
    const result = await runSuite(suite);
    results.push({ suite, output: `${result.stdout}\n${result.stderr}` });
  }
  for (const { suite, output } of results) {
    assert.match(output, /\bpass\b/u, `${suite} prints its summary`);
    assert.doesNotMatch(output, /\bfail [1-9]/u, `${suite} has no failures`);
  }

  const smoke = await runSuite(join(testDir, 'smoke.mjs'));
  assert.match(smoke.stdout, /SMOKE TEST PASSED/u);
  console.log(`[speaker-host 7] node --check=ok suites=${suites.length} smoke=ok`);
});
