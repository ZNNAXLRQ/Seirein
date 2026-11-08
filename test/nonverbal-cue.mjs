/**
 * 非语言感知线索位 (experimental nonverbal cue) — a Laughter tag is a timed hint, not a mood.
 *
 * The contract under test:
 *   - NOT an emotion judgement: only the SenseVoice `event=<|Laughter|>` tag opens a cue; an
 *     `<|HAPPY|>` emotion tag never does, and a missing tag never does;
 *   - the five-minute TTL is an upper bound. Continuing the conversation — with or without a
 *     denial — never renews it; only a new Laughter from a DIFFERENT audio segment does;
 *   - an explicit denial / recovery / request to stop adjusting / session switch / expiry clears
 *     it at once;
 *   - the injected block is host-controlled ("系统观察", "麦克风", "未确认", "不必主动提及", age in
 *     seconds) and is rendered as its own system-prompt block — never into the user message or the
 *     session history;
 *   - `source:'loopback'` is never described as "用户笑了";
 *   - `voice.nonverbalCue` defaults to false: no collection, no injection, no events.
 *
 * The plugin is mounted for real against a synthetic microphone (only hearing.js's process/device
 * layer is replaced), so the host's `onUpdate` → cue → prompt-section path is what runs. No
 * microphone, ffmpeg, model, TTS or GUI is touched.
 *
 * Run: node --test test/nonverbal-cue.mjs
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test, { after } from 'node:test';

import { cleanupRoot } from './helpers/cleanup.mjs';

const HEARING_URL = new URL('../src/host/hearing/hearing.js', import.meta.url).href;
/** The real module, loaded next to the stub: the host wiring and the tag upload are both real. */
const REAL_HEARING_URL = new URL('../src/host/hearing/hearing.js?nonverbal-real', import.meta.url).href;

const state = { onUpdate: null };
globalThis.__nonverbalCue = state;

const hooks = registerHooks({
  load(url, context, next) {
    if (url !== HEARING_URL) return next(url, context);
    return {
      format: 'module',
      shortCircuit: true,
      source: `
    import * as real from ${JSON.stringify(REAL_HEARING_URL)};
    const s = globalThis.__nonverbalCue;
    export const startHearing = (options) => {
      s.onUpdate = options.onUpdate;
      return { device: options.device, stop() {}, stats: () => ({ rmsDb: -20 }) };
    };
    export const listDevices = async () => ['Fake Mic'];
    export const modelReady = () => true;
    export const finalModelReady = () => false;
    export const watchHearingExit = () => {};
    export const isLoopbackDevice = real.isLoopbackDevice;
    export const selectMicrophoneDevice = real.selectMicrophoneDevice;
    export const annotateTranscript = real.annotateTranscript;
    export const joinDetailFields = real.joinDetailFields;
    export const mergeJoinFallback = real.mergeJoinFallback;
    export const offlineLimitedNote = real.offlineLimitedNote;
    export const truncationNotice = real.truncationNotice;`,
    };
  },
});
const {
  NONVERBAL_CUE_TTL_MS,
  apply,
  createNonverbalCue,
  nonverbalClearReason,
  nonverbalCuePrompt,
  nonverbalLaughterTag,
  voiceSessionTarget,
} = await import('../src/host/index.js');
const { parseUtteranceId, startHearing } = await import(REAL_HEARING_URL);
hooks.deregister();

after(() => {
  delete globalThis.__nonverbalCue;
});

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const SAMPLE_RATE = 16000;
const WORKSPACE = (root) => join(root, 'workspace');

/** Recorded emits of a bare cue instance: `[{ type, payload }]`, in order. */
function bareCue(options = {}) {
  const events = [];
  let clock = 1_000_000;
  const cue = createNonverbalCue({
    enabled: () => true,
    emit: (type, payload) => events.push({ type, payload }),
    sessionId: () => 'session-a',
    now: () => clock,
    ...options,
  });
  return { cue, events, advance(ms) { clock += ms; } };
}

/** ffmpeg stand-in: the test writes PCM into `stdout` and hearing treats it as capture. */
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
      acceptWaveform({ samples }) {
        this.samples += samples.length;
      },
    }),
    isReady: () => false,
    decode: () => {},
    getResult: (stream) => ({ text: stream.samples > 0 ? text : '' }),
    isEndpoint: (stream) => stream.samples >= endpointAtSamples,
    reset(stream) {
      stream.samples = 0;
    },
  };
}

function fakeWorker(result) {
  const worker = new EventEmitter();
  worker.unref = () => {};
  worker.terminate = () => worker.emit('exit', null);
  worker.postMessage = (message) => {
    setImmediate(() => worker.emit('message', { type: 'result', id: message.id, ...result }));
  };
  return worker;
}

/** One real `startHearing` utterance: what does the final update upload about its tag/source? */
async function runHearingClip({ device, workerResult }) {
  const child = new FakeChild();
  const updates = [];
  const clip = tone(900);
  const hearing = startHearing({
    ffmpegPath: 'ffmpeg-not-used',
    modelDir: 'models-not-used',
    finalModelDir: '',
    device,
    recognizer: fakeStreaming({ endpointAtSamples: clip.length / 2, text: workerResult.text }),
    asrWorkerFactory: () => fakeWorker(workerResult),
    spawnProcess: () => child,
    vadEnabled: false,
    onUpdate: (event) => updates.push(event),
  });
  child.stdout.write(clip);
  const deadline = Date.now() + 3000;
  while (!updates.some((event) => typeof event.final === 'string') && Date.now() < deadline) await tick(5);
  hearing.stop();
  return updates.find((event) => typeof event.final === 'string') ?? null;
}

// ---------------------------------------------------------------------------
// Host mount
// ---------------------------------------------------------------------------

async function mountHost(t, { nonverbalCue }) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-nonverbal-cue-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await mkdir(WORKSPACE(root), { recursive: true });
  await writeFile(join(root, 'data', 'features.json'), JSON.stringify({
    hearing: true,
    ambient: false,
    voice: false,
    vision: false,
    subtitle: false,
    avatar: false,
    memory: false,
    fastpath: false,
  }));
  await writeFile(join(root, 'data', 'settings.json'), JSON.stringify({
    gptSovits: { enabled: false },
    autoMemory: { enabled: false },
    voice: { nonverbalCue },
  }));
  state.onUpdate = null;
  const sections = new Map();
  const tools = new Map();
  const routes = new Map();
  const handlers = [];
  const cleanups = [];
  const effect = (fn) => {
    const value = fn();
    if (typeof value === 'function') cleanups.push(value);
    return value;
  };
  const on = (type, handler) => {
    const entry = { type, handler };
    handlers.push(entry);
    return () => {
      const index = handlers.indexOf(entry);
      if (index >= 0) handlers.splice(index, 1);
    };
  };
  const registerRoute = (route) => {
    routes.set(route.path, route.handler);
    return () => routes.delete(route.path);
  };
  const scope = {
    effect,
    on,
    systemPrompt: {
      section(definition) {
        sections.set(definition.name, definition);
        return () => sections.delete(definition.name);
      },
    },
    webServer: { register: registerRoute },
  };
  apply({
    effect,
    on,
    get: () => undefined,
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    inject: (_deps, register) => register(scope),
    webServer: { register: registerRoute },
  }, {
    root,
    enabled: true,
    // Short merge window: one arriving final is delivered almost immediately.
    asrMergeWindowMs: 10,
    // Any existing file satisfies the ffmpeg self-check; the stubbed hearing never spawns it.
    ffmpegPath: process.execPath,
  });

  const listen = tools.get('assistant_listen');
  assert.ok(listen !== undefined, 'assistant_listen is registered');
  const started = await listen.execute({ action: 'start' });
  assert.equal(started.ok, true, `listening started: ${started.error ?? ''}`);
  assert.equal(typeof state.onUpdate, 'function', 'the hearing session exposes onUpdate');

  const events = async () => {
    try {
      const text = await readFile(join(root, 'data', 'events.jsonl'), 'utf8');
      return text.trim().split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  const waitForEvents = async (type, count = 1, timeoutMs = 5000) => {
    const startedAt = Date.now();
    for (;;) {
      const rows = (await events()).filter((event) => event.type === type);
      if (rows.length >= count) return rows;
      if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out waiting for ${count} × ${type}`);
      await tick(10);
    }
  };
  const context = { agent: { session: { header: { cwd: WORKSPACE(root) } } } };
  const sessionId = voiceSessionTarget({ root }).sessionId;
  t.after(() => cleanupRoot(root, cleanups.splice(0)));

  return {
    root,
    sessionId,
    events,
    waitForEvents,
    section: () => sections.get('assistant:nonverbal'),
    render: () => sections.get('assistant:nonverbal')?.text(context) ?? '',
    /** One microphone final exactly as hearing uploads it (tag/source/segment id included). */
    update: (patch) => state.onUpdate({ durationMs: 100, ...patch }),
    /** A typed user message on the real session/event feed. */
    emitUser(id, text) {
      const event = {
        type: 'user/message',
        data: { turn: 1, id: `m-${text.length}-${Date.now()}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
      };
      for (const entry of [...handlers]) if (entry.type === 'session/event') entry.handler({ id }, event);
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Evidence → cue → injected block
// ---------------------------------------------------------------------------

test('1. Laughter 标签产生线索并在本轮注入（麦克风/未确认/不必主动提及/年龄秒数）', async (t) => {
  const app = await mountHost(t, { nonverbalCue: true });
  assert.ok(app.section() !== undefined, 'the nonverbal prompt section is registered');

  // An emotion tag is not evidence: this is not an emotion judgement.
  app.update({ final: '你好', event: '<|HAPPY|>', eventClean: 'HAPPY', source: 'mic', utteranceId: 1 });
  await tick(80);
  assert.equal((await app.events()).filter((event) => event.type === 'voice.nonverbal.cue').length, 0, 'emotion is not evidence');
  assert.equal(app.render(), '', 'no cue → nothing injected');

  // The Laughter tag, as hearing uploads it (`event` + the audio segment that carried it).
  app.update({ final: '哈哈', event: '<|Laughter|>', eventClean: 'Laughter', source: 'mic', utteranceId: 2 });
  const [cueRow] = await app.waitForEvents('voice.nonverbal.cue');
  assert.deepEqual(
    { kind: cueRow.payload.kind, source: cueRow.payload.source },
    { kind: 'nonverbal-laughter', source: 'mic' },
  );
  assert.ok(Number.isFinite(cueRow.payload.observedAt) && cueRow.payload.observedAt > 0);

  await tick(1150);
  const injected = app.render();
  assert.match(injected, /系统观察/, 'labelled as a host observation');
  assert.match(injected, /麦克风/, 'microphone source is named, not the user');
  assert.match(injected, /未确认/, 'the meaning stays unconfirmed');
  assert.match(injected, /不必主动提及/, 'the model is told not to bring it up');
  assert.match(injected, /在 1 秒前/, 'the age in seconds is present');
  const [injectedRow] = await app.waitForEvents('voice.nonverbal.injected');
  assert.ok(injectedRow.payload.ageMs >= 1000, `ageMs is the real age: ${injectedRow.payload.ageMs}`);
  assert.match(injected, /不要据此断言用户开心/);

  // The cue never touches the delivered user message: the transcript row is still exactly the words.
  const transcript = (await app.waitForEvents('voice.transcript', 2)).at(-1);
  assert.equal(transcript.payload.text, '哈哈');
  assert.ok(!transcript.payload.text.includes('系统观察'));
  assert.ok(!String(app.render()).includes('哈哈'), 'the cue block carries no transcript text');
});

// ---------------------------------------------------------------------------
// 2. Five-minute cap
// ---------------------------------------------------------------------------

test('2. 五分钟后过期：不再注入并清除', async () => {
  const { cue, events, advance } = bareCue();
  cue.observe({ tag: '<|Laughter|>', source: 'mic', audioKey: 'u1' });
  assert.deepEqual(
    cue.cue,
    {
      kind: 'nonverbal-laughter',
      observedAt: 1_000_000,
      source: 'mic',
      evidence: 'sensevoice-event',
      ttlUntil: 1_000_000 + NONVERBAL_CUE_TTL_MS,
    },
    'the pinned data structure: five fields, evidence names the tag source',
  );
  advance(NONVERBAL_CUE_TTL_MS - 1);
  assert.match(cue.render(), /秒前/, 'still inside the window');
  advance(1); // exactly the TTL: the upper bound has been reached
  assert.equal(cue.render(), '', 'a cue at the TTL is never injected');
  assert.equal(cue.cue, null, 'the cue is gone');
  const cleared = events.filter((event) => event.type === 'voice.nonverbal.cleared');
  assert.deepEqual(cleared.map((event) => event.payload), [{ reason: 'expired' }]);
  assert.equal(events.filter((event) => event.type === 'voice.nonverbal.injected').length, 1);
  assert.equal(NONVERBAL_CUE_TTL_MS, 5 * 60 * 1000, 'five minutes, not longer');
});

// ---------------------------------------------------------------------------
// 3. Explicit denial / recovery / stop-adjusting / session switch
// ---------------------------------------------------------------------------

test('3. 用户明确否认或要求停止 → 立即清除', async (t) => {
  const app = await mountHost(t, { nonverbalCue: true });

  app.update({ final: '哈哈', event: '<|Laughter|>', source: 'mic', utteranceId: 1 });
  await app.waitForEvents('voice.nonverbal.cue');
  assert.match(app.render(), /麦克风/);
  app.update({ final: '我已经没事了', utteranceId: 2 });
  const [recovered] = await app.waitForEvents('voice.nonverbal.cleared');
  assert.equal(recovered.payload.reason, 'recovered');
  assert.equal(app.render(), '', 'no injection after the user recovered');

  app.update({ final: '哈哈', event: '<|Laughter|>', source: 'mic', utteranceId: 3 });
  await app.waitForEvents('voice.nonverbal.cue', 2);
  assert.match(app.render(), /麦克风/);
  app.update({ final: '别这样', utteranceId: 4 });
  const stopped = (await app.waitForEvents('voice.nonverbal.cleared', 2)).at(-1);
  assert.equal(stopped.payload.reason, 'stop-adjusting');
  assert.equal(app.render(), '');

  // A typed denial must behave exactly like a spoken one, and another session retires the cue.
  app.update({ final: '哈哈', event: '<|Laughter|>', source: 'mic', utteranceId: 5 });
  await app.waitForEvents('voice.nonverbal.cue', 3);
  app.emitUser(app.sessionId, '我没笑');
  const denied = (await app.waitForEvents('voice.nonverbal.cleared', 3)).at(-1);
  assert.equal(denied.payload.reason, 'denied');

  app.update({ final: '哈哈', event: '<|Laughter|>', source: 'mic', utteranceId: 6 });
  await app.waitForEvents('voice.nonverbal.cue', 4);
  app.emitUser('another-session', '换个话题吧');
  const switched = (await app.waitForEvents('voice.nonverbal.cleared', 4)).at(-1);
  assert.equal(switched.payload.reason, 'session-switch');
  assert.equal(app.render(), '');
});

// ---------------------------------------------------------------------------
// 4. Ordinary chat never renews the window
// ---------------------------------------------------------------------------

test('4. 继续普通聊天 3 轮不续期（observedAt 不变）', async (t) => {
  const app = await mountHost(t, { nonverbalCue: true });
  app.update({ final: '哈哈', event: '<|Laughter|>', source: 'mic', utteranceId: 1 });
  const [cueRow] = await app.waitForEvents('voice.nonverbal.cue');
  app.render();
  await tick(1100);
  app.render();

  for (let round = 1; round <= 3; round += 1) {
    app.emitUser(app.sessionId, '今天天气不错');
    app.update({ final: '今天天气不错', utteranceId: 10 + round });
    await tick(20);
    app.render();
  }
  await app.waitForEvents('voice.nonverbal.injected', 5);

  const all = await app.events();
  const cues = all.filter((event) => event.type === 'voice.nonverbal.cue');
  assert.equal(cues.length, 1, 'ordinary chat never opens a second cue');
  assert.equal(cues[0].payload.observedAt, cueRow.payload.observedAt, 'the observation time is unchanged');
  const injected = all.filter((event) => event.type === 'voice.nonverbal.injected').map((event) => event.payload.ageMs);
  assert.ok(injected.length >= 5, `each rendered turn got the cue: ${injected.length}`);
  assert.ok(injected.at(-1) >= injected[0] + 1000, 'the age grows; the window is not renewed');
  assert.equal(all.filter((event) => event.type === 'voice.nonverbal.cleared').length, 0, 'chat never clears it either');
});

// ---------------------------------------------------------------------------
// 5. New detection refreshes, the same audio segment does not
// ---------------------------------------------------------------------------

test('5. 新的一次 Laughter 刷新 observedAt；同一段音频重复不刷新', async (t) => {
  const app = await mountHost(t, { nonverbalCue: true });
  app.update({ final: '哈哈', event: '<|Laughter|>', source: 'mic', utteranceId: 1 });
  const [first] = await app.waitForEvents('voice.nonverbal.cue');

  await tick(30);
  // The very same audio segment delivered again (same utterance id) is not new evidence.
  app.update({ final: '哈哈', event: '<|Laughter|>', source: 'mic', utteranceId: 1 });
  await tick(80);
  assert.equal((await app.events()).filter((event) => event.type === 'voice.nonverbal.cue').length, 1);

  // A different audio segment is a new detection and moves the observation time forward.
  await tick(30);
  app.update({ final: '哈哈', event: '<|Laughter|>', eventClean: 'Laughter', source: 'mic', utteranceId: 2 });
  const cues = await app.waitForEvents('voice.nonverbal.cue', 2);
  assert.ok(cues[1].payload.observedAt > first.payload.observedAt, 'a new segment refreshes observedAt');
  assert.equal(app.render().includes('秒前'), true);
});

// ---------------------------------------------------------------------------
// 6. Loopback is never the user's laughter
// ---------------------------------------------------------------------------

test('6. 回环来源不写成“用户笑了”', async (t) => {
  // The real hearing module classifies its device and uploads that with the tag.
  const upload = await runHearingClip({
    device: 'CABLE Output (VB-Audio Virtual Cable)',
    workerResult: { text: '哈哈', event: '<|Laughter|>', eventClean: 'Laughter' },
  });
  assert.ok(upload !== null, 'a delivered final was uploaded');
  assert.equal(upload.source, 'loopback');
  assert.equal(upload.event, '<|Laughter|>');
  assert.equal(upload.eventClean, 'Laughter');
  assert.equal(parseUtteranceId(upload.utteranceId).seq, 1, 'the audio segment id travels with it');

  const micUpload = await runHearingClip({
    device: '麦克风 (Realtek(R) Audio)',
    workerResult: { text: '哈哈', event: '<|Laughter|>', eventClean: 'Laughter' },
  });
  assert.equal(micUpload.source, 'mic');
  const bareUpload = await runHearingClip({ device: '麦克风 (Realtek(R) Audio)', workerResult: { text: '你好' } });
  assert.equal(bareUpload.event, null, 'a missing tag is uploaded as null');
  assert.equal(bareUpload.eventClean, null);
  assert.equal(nonverbalLaughterTag(bareUpload.event), false, 'a missing tag is not evidence');

  const app = await mountHost(t, { nonverbalCue: true });
  app.update({ final: '哈哈', event: '<|Laughter|>', source: 'loopback', utteranceId: 7 });
  await app.waitForEvents('voice.nonverbal.cue');
  const injected = app.render();
  assert.ok(!injected.includes('用户笑了'), 'a loopback may be a video or music, never the user');
  assert.match(injected, /回环/);
  assert.match(injected, /未确认/);
  assert.match(injected, /可能来自视频或音乐/);

  // An unknown input never borrows "麦克风" either.
  const unknown = nonverbalCuePrompt({ kind: 'nonverbal-laughter', observedAt: Date.now(), source: 'unknown' }, 3000);
  assert.match(unknown, /音频输入/);
  assert.ok(!unknown.includes('麦克风'));
  assert.ok(!unknown.includes('用户笑了'));
});

// ---------------------------------------------------------------------------
// 7. Off by default
// ---------------------------------------------------------------------------

test('7. 开关关闭：不采集、不注入、无事件', async (t) => {
  const app = await mountHost(t, { nonverbalCue: false });
  app.update({ final: '哈哈', event: '<|Laughter|>', eventClean: 'Laughter', source: 'mic', utteranceId: 1 });
  await tick(120);
  assert.equal(app.render(), '', 'off means the section renders empty');
  const rows = (await app.events()).filter((event) => event.type.startsWith('voice.nonverbal'));
  assert.deepEqual(rows, [], 'off means no cue / injected / cleared rows');

  // The default (no setting at all) is the same: off.
  const defaulted = bareCue({ enabled: () => false });
  assert.equal(defaulted.cue.observe({ tag: '<|Laughter|>', source: 'mic', audioKey: 'u1' }), null);
  assert.equal(defaulted.cue.render(), '');
  assert.deepEqual(defaulted.events, []);
  assert.equal(nonverbalLaughterTag('<|HAPPY|>'), false);
  assert.equal(nonverbalLaughterTag('<|Speech|>'), false);
  assert.equal(nonverbalLaughterTag('<|Laughter|>'), true);
  assert.equal(nonverbalClearReason('今天天气不错'), '', 'ordinary chat matches no clearing phrase');
});

// ---------------------------------------------------------------------------
// 8. The cue is not a person/memory input
// ---------------------------------------------------------------------------

test('8. 线索不进入用户消息、记忆、人设或硬决策', async (t) => {
  const app = await mountHost(t, { nonverbalCue: true });
  app.update({ final: '哈哈', event: '<|Laughter|>', source: 'mic', utteranceId: 1 });
  await app.waitForEvents('voice.nonverbal.cue');
  assert.match(app.render(), /不是用户发言/);
  assert.match(app.render(), /不改变任何硬决策/);
  await tick(40);
  const types = (await app.events()).map((event) => event.type);
  assert.ok(!types.some((type) => type.startsWith('memory.')), 'nothing reaches memory');
  assert.ok(!types.includes('persona.write'), 'nothing reaches the persona/profile');
  const transcript = (await app.events()).find((event) => event.type === 'voice.transcript');
  assert.ok(transcript !== undefined, 'the user words still travel normally');
  assert.equal(transcript.payload.text, '哈哈', 'unchanged, with no cue text attached');
});
