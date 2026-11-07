/**
 * No hidden "heard it -> executed it" path, and no swallowed real answer.
 *
 * 1) The host used to regex-match OBS scene commands out of a transcript, switch OBS and return
 *    before the session saw the sentence. That shortcut is gone: every spoken line (including
 *    "切换到游戏场景", its negation and a compound request) reaches the dated session, and only
 *    the agent's `assistant_obs` tool may touch OBS.
 * 2) The noise gate may only drop explicit non-semantic fillers ("嗯"/"呃"/"啊"/"哦", and the
 *    lone English room-tone artifacts) and only while no conversation is active: "好"/"不"/"OK"
 *    are real answers and must reach the session. Each drop is logged as
 *    `hearing.filtered {text, reason}`.
 * 3) `dispatch.js` no longer carries the unused "task utterance" keyword classifier.
 *
 * The hearing, sight, OBS and hardware modules are short-circuited by a loader hook, so the real
 * host runs with no microphone, ffmpeg, ASR model, TTS, network or child process. The fake agent
 * commits one synthetic turn per delivery, so each voice wait settles instead of timing out.
 *
 * Run: node --test test/hearing-routing.mjs
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cleanupRoot } from './helpers/cleanup.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Everything the fake modules, the fake agent and the captured event log share. */
const state = {
  events: [],
  followups: [],
  onUpdate: null,
  obsConnects: 0,
  obsRequests: [],
  listenerErrors: [],
};
globalThis.__hearingRouting = state;

/** What the fake agent's synthetic turn says; never spoken because voice is disabled. */
const FAKE_REPLY = '好的';

const moduleUrl = (path) => new URL(path, import.meta.url).href;
const hearingUrl = moduleUrl('../src/host/hearing/hearing.js');
const sightUrl = moduleUrl('../src/host/vision/sight.js');
const obsUrl = moduleUrl('../src/host/vision/obs.js');
const hardwareUrl = moduleUrl('../src/host/platform/hardware.js');

const hooks = registerHooks({
  load(href, context, next) {
    if (href === hearingUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          const s = globalThis.__hearingRouting;
          export const modelReady = () => true;
          export const finalModelReady = () => false;
          // ambient.js imports this classifier at module load, even when no ambient session starts.
          export const isLoopbackDevice = (name) => /CABLE|Stereo Mix|Virtual/i.test(String(name));
          export const listDevices = async () => ['Fake Mic'];
          export const startHearing = (options) => {
            s.onUpdate = options.onUpdate;
            return { device: options.device, stop() {}, stats: () => null };
          };
          export const watchHearingExit = () => {};
          export const annotateTranscript = (text) => text;
          export const joinDetailFields = () => ({});
          export const mergeJoinFallback = () => ({});
          export const offlineLimitedNote = () => '';
          export const truncationNotice = () => '';
        `,
      };
    }
    if (href === sightUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          const forbidden = async () => { throw new Error('capture forbidden'); };
          export const resolveFfmpeg = () => 'ffmpeg-fake';
          export const resolveFfplay = () => null;
          export const capture = forbidden;
          export const captureDesktop = forbidden;
          export const captureDevice = forbidden;
          export const startStoryboard = forbidden;
          export const OBSERVATION_TTL_MS = 30000;
          export function readObservation(o, { now = Date.now(), ttlMs = 30000 } = {}) { const v = o ?? {}; const c = Number(v.capturedAt); const s = Number.isFinite(c) && c > 0 ? c : Number(v.at); const at = Number.isFinite(s) && s > 0 ? s : null; const ageMs = at === null ? null : Math.max(0, now - at); const stale = ageMs === null || ageMs >= ttlMs; return { ...v, at, ageMs, stale, hint: stale ? 'stale' : '' }; }
        `,
      };
    }
    if (href === obsUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          const s = globalThis.__hearingRouting;
          // Every connect is recorded: a host-side scene switch would have to come through here.
          export const connectObs = (options) => {
            s.obsConnects += 1;
            s.obsRequests.push({ kind: 'connect', options });
            return Promise.resolve({
              request: async (type, data) => {
                s.obsRequests.push({ kind: 'request', type, data });
                if (type === 'GetSceneList') {
                  return { currentProgramSceneName: 'Main', scenes: [{ sceneName: 'Main' }, { sceneName: '游戏' }] };
                }
                if (type === 'GetCurrentProgramScene') return { currentProgramSceneName: 'Main' };
                return {};
              },
              close() {},
            });
          };
        `,
      };
    }
    if (href === hardwareUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          export const detectTuning = () => ({
            cores: 8, memoryGb: 16, streamThreads: 2, finalThreads: 3, decodeCapSec: 10, tier: 'mid',
          });`,
      };
    }
    return next(href, context);
  },
});

const { apply } = await import('../src/host/index.js');
const { EventLog } = await import('../src/host/memory/store.js');
hooks.deregister();

/** Capture every event in memory: these tests assert on the log, not on a file. */
const originalEmit = EventLog.prototype.emit;
EventLog.prototype.emit = async function emit(type, payload) {
  state.events.push({ type, payload });
  return { id: 'hearing-routing', ts: new Date().toISOString(), type, payload };
};

after(() => {
  EventLog.prototype.emit = originalEmit;
  delete globalThis.__hearingRouting;
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

async function until(predicate, label, timeoutMs = 5_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await sleep(10);
  }
  assert.fail(`timed out: ${label}`);
}

/** One `session/event` bus that isolates a throwing listener, like the real dispatch does. */
function createBus() {
  const listeners = new Set();
  return {
    on(type, fn) {
      const entry = { type, fn };
      listeners.add(entry);
      return () => listeners.delete(entry);
    },
    fire(type, ...args) {
      for (const entry of [...listeners]) {
        if (entry.type !== type) continue;
        try {
          entry.fn(...args);
        } catch (error) {
          state.listenerErrors.push({ type, error: error?.message ?? String(error) });
        }
      }
    },
  };
}

/**
 * Mount the plugin against a temp root. `fastpath` is off so a delivered transcript takes the
 * real `handleVoiceTask` path; `voice` is off because these tests never touch TTS/playback.
 */
async function mount(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-hearing-routing-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await writeFile(join(root, 'data', 'features.json'), JSON.stringify({ voice: false, fastpath: false }), 'utf8');
  await writeFile(join(root, 'data', 'settings.json'), '{}', 'utf8');

  const events = [];
  state.events = events;
  const followups = [];
  state.followups = followups;
  state.onUpdate = null;
  state.obsConnects = 0;
  state.obsRequests = [];
  state.listenerErrors = [];

  const bus = createBus();
  const tools = new Map();
  const cleanups = [];
  const effect = (fn) => {
    const cleanup = fn();
    if (typeof cleanup === 'function') cleanups.push(cleanup);
    return cleanup;
  };
  const agents = new Map();
  let persisted = false;

  /** One synthetic turn per `followup`, so `awaitSessionResult` binds and settles. */
  const makeAgent = (sessionId) => {
    const session = {
      id: sessionId,
      header: { cwd: join(root, 'workspace') },
      // The sandbox switch appends `sandbox/mode` through the session; a no-op is enough here.
      append() {},
    };
    let turn = 0;
    return {
      id: sessionId,
      session,
      followup(message) {
        followups.push(message);
        turn += 1;
        const turnId = turn;
        const fire = (type, data) => bus.fire('session/event', session, {
          type,
          seq: state.events.length + turnId,
          time: Date.now(),
          data,
        });
        fire('turn/start', { turn: turnId });
        fire('user/message', message);
        fire('assistant/message', {
          turn: turnId,
          message: { role: 'assistant', content: [{ type: 'text', text: FAKE_REPLY }] },
        });
        fire('turn/end', { turn: turnId, reason: { kind: 'completed' } });
      },
    };
  };

  const services = {
    agentLoop: {
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
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
    sessionTitle: {
      get: () => undefined,
      rename: (_session, title) => ({ title, source: { kind: 'user' } }),
    },
    workspaceRegistry: {
      async create(path) {
        return { id: 'ws-hearing-routing', path };
      },
      get() {
        return { id: 'ws-hearing-routing', async attachSession() {} };
      },
    },
  };

  const ctx = {
    effect,
    on: bus.on,
    get: (serviceName) => services[serviceName],
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    inject: (_deps, registerScope) => {
      registerScope({
        effect,
        systemPrompt: { section: () => () => {} },
        webServer: { register: () => () => {} },
      });
    },
    webServer: { register: () => () => {} },
  };
  apply(ctx, { root, enabled: true, asrMergeWindowMs: 10 });
  t.after(async () => {
    await cleanupRoot(root, cleanups.splice(0));
  });

  const listen = tools.get('assistant_listen');
  assert.ok(listen !== undefined, 'assistant_listen is registered');
  const started = await listen.execute({ action: 'start' });
  assert.equal(started.ok, true, `listening started: ${started.error ?? ''}`);
  assert.equal(typeof state.onUpdate, 'function', 'the hearing session exposes onUpdate');

  const rows = (type) => events.filter((entry) => entry.type === type);
  const followupTexts = () => followups.flatMap((message) => (message.content ?? [])
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text));
  const say = (text) => {
    assert.equal(typeof state.onUpdate, 'function', 'the hearing session is live');
    state.onUpdate({ final: text, durationMs: 100 });
  };
  const waitInjected = (count = 1) => until(() => rows('voice.injected').length === count, `voice.injected #${count}`);
  const waitUtterance = (count = 1) => until(() => rows('hearing.utterance').length === count, `hearing.utterance #${count}`);

  return { root, tools, rows, followupTexts, say, waitInjected, waitUtterance };
}

/** Assert that nothing OBS-related was executed by the host for this mount. */
function assertNoObsExecution() {
  assert.equal(state.obsConnects, 0, 'the host never opened an OBS connection on its own');
  assert.deepEqual(state.obsRequests, [], 'no OBS request was issued');
}

// ---------------------------------------------------------------------------
// 1) "切换到游戏场景" goes to the session; the host never switches OBS
// ---------------------------------------------------------------------------

test('voice "切换到游戏场景" enters the session instead of switching OBS directly', async (t) => {
  const app = await mount(t);
  assert.ok(app.tools.has('assistant_obs'), 'assistant_obs is the tool the agent calls');

  app.say('切换到游戏场景');
  await app.waitInjected(1);

  assertNoObsExecution();
  assert.equal(app.rows('voice.obs.scene').length, 0, 'the old direct-execution event never fires');
  assert.equal(app.rows('voice.obs.scene.failed').length, 0);
  assert.equal(app.rows('hearing.filtered').length, 0, 'a command sentence is not noise');

  const injected = app.rows('voice.injected')[0].payload;
  assert.match(injected.sessionId, /^seirein-\d{4}-\d{2}-\d{2}$/u, 'the dated voice session received it');
  assert.equal(injected.chars, '切换到游戏场景'.length, 'the whole sentence reached the session');

  const transcript = app.rows('voice.transcript')[0].payload;
  assert.equal(transcript.text, '切换到游戏场景', 'the log carries the full transcript');
  assert.ok(app.followupTexts().includes('切换到游戏场景'), 'the agent got the user\'s words verbatim');
});

// ---------------------------------------------------------------------------
// 2) The negation is not a command either
// ---------------------------------------------------------------------------

test('voice "不要切换到游戏场景" also reaches the session; no scene is switched', async (t) => {
  const app = await mount(t);

  app.say('不要切换到游戏场景');
  await app.waitInjected(1);

  assertNoObsExecution();
  assert.equal(app.rows('voice.obs.scene').length, 0);
  assert.equal(app.rows('voice.obs.scene.failed').length, 0);
  assert.equal(app.rows('voice.injected')[0].payload.chars, '不要切换到游戏场景'.length);
  assert.ok(app.followupTexts().includes('不要切换到游戏场景'), 'the negation is delivered unchanged');
});

// ---------------------------------------------------------------------------
// 3) A compound request is not cut off
// ---------------------------------------------------------------------------

test('voice "切换场景后帮我分析一下" is delivered in full', async (t) => {
  const app = await mount(t);

  // The literal case from the report, then the compound form that the old regex would have cut
  // after "游戏" (it matched "切换到游戏场景" and returned before "帮我分析一下").
  app.say('切换场景后帮我分析一下');
  await app.waitInjected(1);
  app.say('切换到游戏场景后帮我分析一下');
  await app.waitInjected(2);

  assertNoObsExecution();
  assert.equal(app.rows('voice.obs.scene').length, 0);
  assert.equal(app.rows('voice.obs.scene.failed').length, 0);
  assert.ok(app.followupTexts().includes('切换场景后帮我分析一下'));
  assert.ok(app.followupTexts().includes('切换到游戏场景后帮我分析一下'), 'the whole compound request is delivered');
  assert.equal(app.rows('voice.injected')[1].payload.chars, '切换到游戏场景后帮我分析一下'.length);
});

// ---------------------------------------------------------------------------
// 4) Short answers are real utterances, never noise
// ---------------------------------------------------------------------------

test('short answers 好 / 不 / OK are never filtered', async (t) => {
  for (const answer of ['好', '不', 'OK']) {
    await t.test(`"${answer}" reaches the session`, async (sub) => {
      const app = await mount(sub);
      app.say(answer);
      await app.waitInjected(1);
      assert.equal(app.rows('hearing.filtered').length, 0, `"${answer}" is not filtered`);
      assert.equal(app.rows('hearing.utterance').length, 1, `"${answer}" is recorded as an utterance`);
      assert.ok(app.followupTexts().includes(answer), `"${answer}" reached the agent`);
    });
  }
});

// ---------------------------------------------------------------------------
// 5) A lone filler is dropped only without conversation context, and logged
// ---------------------------------------------------------------------------

test('"嗯" without context is filtered with a hearing.filtered event; with context it is kept', async (t) => {
  const app = await mount(t);

  app.say('嗯');
  await until(() => app.rows('hearing.filtered').length === 1, 'hearing.filtered #1');
  const filtered = app.rows('hearing.filtered')[0].payload;
  assert.deepEqual(Object.keys(filtered).sort(), ['reason', 'text'], 'the event carries text and reason only');
  assert.equal(filtered.text, '嗯');
  assert.equal(filtered.reason, 'filler', 'the reason names the actual rule');
  assert.equal(app.rows('hearing.utterance').length, 0, 'a filtered filler is not an utterance');
  assert.equal(app.rows('voice.transcript').length, 0, 'it never reaches the session');
  assert.equal(app.rows('voice.injected').length, 0);
  assert.equal(app.followupTexts().length, 0, 'the agent received nothing');

  // A real answer starts a conversation; the next lone filler may be a real answer too.
  app.say('好');
  await app.waitInjected(1);
  assert.ok(app.followupTexts().includes('好'));

  app.say('嗯');
  await app.waitInjected(2);
  assert.equal(app.rows('hearing.filtered').length, 1, 'no second filter while the conversation is active');
  assert.ok(app.followupTexts().includes('嗯'), 'the in-conversation "嗯" is delivered');
});

// ---------------------------------------------------------------------------
// 6) Static proof: the shortcut and the dead classifier are gone
// ---------------------------------------------------------------------------

const HOST_DIR = fileURLToPath(new URL('../src/host/', import.meta.url));
const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));

async function jsFiles(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await jsFiles(path));
    else if (entry.name.endsWith('.js')) files.push(path);
  }
  return files;
}

test('src: no OBS command matcher, no direct scene switch in the voice lane, no task classifier', async () => {
  const hostSource = await readFile(join(HOST_DIR, 'index.js'), 'utf8');
  const dispatchSource = await readFile(join(HOST_DIR, 'session', 'delivery', 'dispatch.js'), 'utf8');

  // 1) The matcher and its direct-execution events are gone from the host.
  assert.ok(!hostSource.includes('matchObsSceneCommand'), 'the scene-command matcher was deleted');
  assert.ok(!hostSource.includes('voice.obs.scene'), 'the direct-execution confirmation events were deleted');

  // 2) handleVoiceTask itself cannot reach OBS: no scene switch, no OBS client.
  const start = hostSource.indexOf('const handleVoiceTask = async');
  assert.ok(start > 0, 'handleVoiceTask exists');
  const nextConst = hostSource.indexOf('\n  const ', start + 1);
  assert.ok(nextConst > start, 'the function body has a terminator');
  const voiceBody = hostSource.slice(start, nextConst);
  assert.ok(!voiceBody.includes('switchObsScene'), 'the voice lane never switches a scene');
  assert.ok(!voiceBody.includes('connectObs'), 'the voice lane never talks to OBS');
  assert.ok(!voiceBody.includes('voice.obs.scene'), 'the voice lane logs no direct execution');

  // 3) The unused task classifier is gone and has no callers anywhere in src/.
  assert.ok(!dispatchSource.includes('isTaskUtterance'), 'isTaskUtterance was deleted');
  assert.ok(!dispatchSource.includes('taskVerbs'), 'its task-verb regex was deleted');
  for (const file of await jsFiles(SRC_DIR)) {
    const source = await readFile(file, 'utf8');
    for (const symbol of ['isTaskUtterance', 'taskVerbs', 'matchObsSceneCommand', 'looksLikeNoise', "'hearing.noise'"]) {
      assert.ok(!source.includes(symbol), `${file} has no reference to ${symbol}`);
    }
  }
});
