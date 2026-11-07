/**
 * Call mode wiring (phase 1b): storage, the mode tool and the voice delivery gate.
 *
 * The host is mounted for real (`apply`) with a synthetic microphone and a fake agent loop, so
 * every scenario below runs through the shipped `flushMerged` / `handleVoiceTask` path instead of
 * a re-implementation:
 *
 *   1. no enabled name: `assistant_call_mode` enter is refused (`no-address-name`) and tells the
 *      user to configure one; the mode stays normal;
 *   2. add a name via the settings action, then enter: mode=call, and `/assistant/status` reports
 *      the mode and the list;
 *   3. in call mode an unaddressed final is not delivered, opens no turn and logs
 *      `voice.call.unaddressed {chars}`;
 *   4. an addressed final (「小满，在吗」) is delivered normally;
 *   5. an explicit 「退出通话模式」 is delivered even without an address;
 *   6. normal mode is unchanged: the same unaddressed final is delivered;
 *   7. storage refuses a call name that is already a user self-name (cross-class findConflict);
 *   8. the settings UI adds/enables/deletes names and switches the mode through `act`.
 *
 * No sound, TTS, capture, model or GUI is used.
 *
 * Run: node --test test/call-mode-host.mjs
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupRoot, disposeAll } from './helpers/cleanup.mjs';
import { createSpeakerRegistry } from '../src/host/hearing/interaction/callMode.js';
import { createCallNameStore } from '../src/host/hearing/interaction/callNames.js';

const state = { onUpdate: null, lastVerdict: null, players: [], stops: 0 };
globalThis.__callModeHost = state;

const hearingUrl = new URL('../src/host/hearing/hearing.js', import.meta.url).href;
const ttsUrl = new URL('../src/host/speech/tts.js', import.meta.url).href;
const sightUrl = new URL('../src/host/vision/sight.js', import.meta.url).href;
const subtitleUrl = new URL('../src/host/subtitle/subtitle.js', import.meta.url).href;

const hooks = registerHooks({
  load(url, context, next) {
    if (url === hearingUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    const s = globalThis.__callModeHost;
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
    export { resolveGptLangs, resolveGptSovitsTimeout } from '${ttsUrl}?call-mode-host-helpers';
    export const configureTts = () => {};
    export const gptSovitsReferenceStatus = async () => ({ seconds: null, ok: false, readable: false });
    export const warmupGptSovits = async () => ({ ok: false, skipped: 'disabled' });
    export const applyGptSovitsModels = () => ({ ok: true });
    export const synthesize = async ({ text }) => ({
      file: 'call-mode-host.mp3', bytes: 16, durationMs: 200, provider: 'edge-tts', text,
    });
    export const speakStreaming = async () => { throw new Error('streaming forbidden'); };
    export const stopPlayback = () => { globalThis.__callModeHost.stops += 1; return true; };
    export const stopTts = () => { globalThis.__callModeHost.stops += 1; return true; };
    export const play = (file, options = {}) => {
      const s = globalThis.__callModeHost;
      let resolve;
      const done = new Promise((doneResolve) => { resolve = doneResolve; });
      s.players.push({ file, signal: options.signal, resolve });
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
    export function readObservation(o, { now = Date.now(), ttlMs = 30000 } = {}) {
      const v = o ?? {}; const c = Number(v.capturedAt); const s = Number.isFinite(c) && c > 0 ? c : Number(v.at);
      const at = Number.isFinite(s) && s > 0 ? s : null; const ageMs = at === null ? null : Math.max(0, now - at);
      const stale = ageMs === null || ageMs >= ttlMs;
      return { ...v, at, ageMs, stale, hint: stale ? 'stale' : '' };
    }`,
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
      async show() {}
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
after(() => { delete globalThis.__callModeHost; });

// ---------------------------------------------------------------------------
// Mounted host: real apply(), fake agent loop, synthetic microphone
// ---------------------------------------------------------------------------

async function mount(t, { callNames = [], voice = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-call-mode-host-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await mkdir(join(root, 'workspace'), { recursive: true });
  // Voice OFF by default: the delivery gate is under test, not TTS. The barge-in test opts in so a
  // sounding clip exists when an unaddressed final arrives.
  await writeFile(join(root, 'data', 'features.json'), JSON.stringify({
    hearing: true, ambient: false, voice, vision: false, subtitle: false,
    avatar: false, memory: false, fastpath: false,
  }));
  await writeFile(join(root, 'data', 'settings.json'), JSON.stringify({
    gptSovits: { enabled: false },
    langs: { speech: 'zh', subtitle: 'zh' },
    autoMemory: { enabled: false },
    voice: { chunking: false, callNames },
  }));

  state.onUpdate = null;
  state.lastVerdict = null;
  state.players = [];
  state.stops = 0;

  const listeners = new Set();
  const cleanups = [];
  const tools = new Map();
  const routes = new Map();
  const deliveries = [];
  const cleanupsSeen = [];

  const bus = {
    on(type, fn) {
      const entry = { type, fn };
      listeners.add(entry);
      return () => listeners.delete(entry);
    },
    fire(type, ...args) {
      for (const entry of [...listeners]) {
        if (entry.type !== type) continue;
        try { entry.fn(...args); } catch { /* isolate a listener like the real bus */ }
      }
    },
  };
  const services = new Map([
    ['agentDefaultModel', { currentSelection: () => ({ provider: 'fake-provider', model: 'fake-model' }) }],
    ['sessionTitle', { get: () => undefined, rename: (_session, title) => ({ title, source: { kind: 'user' } }) }],
    ['workspaceRegistry', {
      async create(path) { return { id: 'ws-call-mode-host', path }; },
      get() { return { id: 'ws-call-mode-host', async attachSession() {} }; },
    }],
  ]);
  const agents = new Map();
  let persisted = false;
  const makeAgent = (sessionId) => {
    const session = { id: sessionId, header: { cwd: join(root, 'workspace') }, append() {} };
    let turn = 0;
    return {
      id: sessionId,
      session,
      followup(message) {
        deliveries.push(message);
        turn += 1;
        const turnId = turn;
        const text = JSON.stringify(message?.content ?? message);
        const fire = (type, data) => bus.fire('session/event', session, {
          type, seq: turnId, time: Date.now(), data,
        });
        void (async () => {
          fire('turn/start', { turn: turnId });
          fire('user/message', message);
          fire('assistant/message', {
            turn: turnId,
            step: 1,
            message: { id: `a-${turnId}`, role: 'assistant', content: [{ type: 'text', text: '收到。' }] },
          });
          fire('turn/end', { turn: turnId, reason: { kind: 'completed' } });
        })().catch(() => {});
        // The digest is a separate followup on a fresh session; tests never count it as a turn.
        return text;
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
  const scope = {
    effect,
    on: bus.on,
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
    on: bus.on,
    get: (name) => services.get(name),
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    webServer: {
      register(route) {
        routes.set(route.path, route.handler);
        return () => routes.delete(route.path);
      },
    },
    inject: (_deps, registerScope) => registerScope(scope),
  }, { root, enabled: true, asrMergeWindowMs: 10 });

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
  const waitUntil = async (check, message, timeoutMs = 4000) => {
    const startedAt = Date.now();
    for (;;) {
      const value = await check();
      if (value) return value;
      if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out: ${message}`);
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  const waitForEvent = (type, predicate = () => true) => waitUntil(
    async () => {
      const row = (await events()).find((event) => event.type === type && predicate(event.payload ?? {}));
      return row === undefined ? null : (row.payload ?? {});
    },
    type,
  );
  const action = async (body) => {
    const handler = routes.get('/assistant/action');
    assert.equal(typeof handler, 'function', 'the action route is registered');
    let result;
    const { Readable } = await import('node:stream');
    await handler(
      Object.assign(Readable.from([JSON.stringify(body)]), { method: 'POST' }),
      { writeHead() {}, end(value) { result = JSON.parse(value); } },
    );
    return result;
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
  const callMode = (args) => tools.get('assistant_call_mode').execute(args, {});
  const sayTool = (args, exec = { agent: { session: { id: 'call-mode-host-typed' } } }) =>
    tools.get('assistant_say').execute(args, exec);
  const say = async (text) => {
    state.lastVerdict = state.onUpdate({ final: text, durationMs: 200 });
    return state.lastVerdict;
  };
  const isDigest = (message) => JSON.stringify(message?.content ?? message).includes('以下内容作为长期约束与背景');
  const voiceDeliveries = () => deliveries.filter((message) => isDigest(message) !== true);

  t.after(async () => {
    for (const player of state.players) player.resolve?.();
    await disposeAll(cleanups.splice(0));
    await cleanupRoot(root);
  });

  return {
    root,
    tools,
    callMode,
    sayTool,
    action,
    status,
    say,
    events,
    waitForEvent,
    waitUntil,
    deliveries,
    voiceDeliveries,
    players: () => state.players,
    stops: () => state.stops,
    sessionId: voiceSessionTarget({ root }).sessionId,
    cleanupsSeen,
  };
}

// ---------------------------------------------------------------------------
// 1–2. Entering call mode: refusal without a name, success after adding one
// ---------------------------------------------------------------------------

test('1. 无称呼 enter → 拒绝 no-address-name 并提示去设置，模式仍是 normal', async (t) => {
  const app = await mount(t);
  const refused = await app.callMode({ action: 'enter' });

  assert.equal(refused.ok, false);
  assert.equal(refused.mode, 'normal');
  assert.equal(refused.reason, 'no-address-name');
  assert.match(refused.error, /设置页/u, 'the refusal tells the user to open the settings page');
  assert.match(refused.error, /称呼/u);

  const status = await app.callMode({ action: 'status' });
  assert.equal(status.mode, 'normal');
  assert.deepEqual(status.names, []);
  assert.deepEqual(status.enabledNames, []);

  const events = await app.events();
  assert.ok(events.some((event) => event.type === 'call.mode.refused' && event.payload.reason === 'no-address-name'));
  console.log(`[1] refused=${JSON.stringify({ mode: refused.mode, reason: refused.reason })}`);
});

test('2. 添加称呼后 enter → call；status 与 /assistant/status 都反映', async (t) => {
  const app = await mount(t);
  const added = await app.action({ action: 'call.names.add', text: '小满' });
  assert.equal(added.ok, true);
  assert.equal(added.item.text, '小满');
  assert.equal(added.item.enabled, true);
  assert.match(added.item.id, /^call-/u);

  // Full name CRUD through the settings action: add → toggle → remove, each with an event.
  const second = await app.action({ action: 'call.names.add', text: '阿明' });
  assert.equal(second.ok, true);
  const disabled = await app.action({ action: 'call.names.toggle', id: second.item.id, enabled: false });
  assert.equal(disabled.item.enabled, false);
  const enabled = await app.action({ action: 'call.names.toggle', id: second.item.id, enabled: true });
  assert.equal(enabled.item.enabled, true);
  const removed = await app.action({ action: 'call.names.remove', id: second.item.id });
  assert.equal(removed.ok, true);
  assert.deepEqual(removed.names.map((entry) => entry.text), ['小满']);
  const duplicate = await app.action({ action: 'call.names.add', text: '小满' });
  assert.equal(duplicate.ok, false, 'a duplicate call name is refused by the host action');
  assert.equal(duplicate.reason, 'duplicate-name');
  assert.equal(duplicate.conflict.kind, 'call-name');

  const entered = await app.callMode({ action: 'enter' });
  assert.equal(entered.ok, true);
  assert.equal(entered.mode, 'call');
  assert.deepEqual(entered.enabledNames, ['小满']);

  const toolStatus = await app.callMode({ action: 'status' });
  assert.equal(toolStatus.mode, 'call');
  assert.deepEqual(toolStatus.names.map((entry) => entry.text), ['小满']);

  const status = await app.status();
  assert.equal(status.call.mode, 'call', 'the settings payload reflects the runtime mode');
  assert.deepEqual(status.call.names.map((entry) => entry.text), ['小满']);
  assert.deepEqual(status.call.enabledNames, ['小满']);

  const events = await app.events();
  assert.ok(events.some((event) => event.type === 'call.names.add'));
  assert.ok(events.some((event) => event.type === 'call.names.toggle' && event.payload.enabled === false));
  assert.ok(events.some((event) => event.type === 'call.names.toggle' && event.payload.enabled === true));
  assert.ok(events.some((event) => event.type === 'call.names.remove'));
  assert.ok(events.some((event) => event.type === 'call.mode.enter'));
  assert.equal(
    events.filter((event) => event.type === 'call.names.add').length,
    2,
    'the refused duplicate writes no add event',
  );
  console.log(`[2] mode=${status.call.mode} names=${JSON.stringify(status.call.names)} events=add2/toggle2/remove1`);
});

// ---------------------------------------------------------------------------
// 3–6. The delivery gate
// ---------------------------------------------------------------------------

test('3. call 模式未寻址语音 → 不投递、无新轮次、记 voice.call.unaddressed', async (t) => {
  const app = await mount(t, { callNames: [{ id: 'call-1', text: '小满', enabled: true }] });
  const entered = await app.callMode({ action: 'enter' });
  assert.equal(entered.ok, true);

  const verdict = await app.say('今天天气不错');
  assert.equal(verdict?.accepted, true, 'the final is handled locally, not refused by hearing');
  const unaddressed = await app.waitForEvent('voice.call.unaddressed');
  assert.deepEqual(unaddressed, { chars: 6, reason: 'name-not-present' });

  // The merge window is 10 ms; give the (never scheduled) delivery a real chance to happen.
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(app.voiceDeliveries(), [], 'no request reaches the agent');
  assert.equal(app.deliveries.length, 0, 'not even the new-session digest was sent');
  assert.equal((await app.callMode({ action: 'status' })).mode, 'call', 'a miss never exits call mode');
  console.log(`[3] delivered=0 turn=0 event=${JSON.stringify(unaddressed)}`);
});

test('4. call 模式命中称呼 → 正常投递', async (t) => {
  const app = await mount(t, { callNames: [{ id: 'call-1', text: '小满', enabled: true }] });
  assert.equal((await app.callMode({ action: 'enter' })).ok, true);

  await app.say('小满，在吗');
  const delivered = await cleanupDone(app, 1);
  assert.equal(delivered.length, 1, 'exactly one request is delivered');
  assert.ok(JSON.stringify(delivered[0].content).includes('小满，在吗'));
  console.log(`[4] delivered=${delivered.length} chars=${JSON.stringify(delivered[0].content).length}`);
});

test('5. 「退出通话模式」未称呼也放行（让 agent 能退出）', async (t) => {
  const app = await mount(t, { callNames: [{ id: 'call-1', text: '小满', enabled: true }] });
  assert.equal((await app.callMode({ action: 'enter' })).ok, true);

  await app.say('退出通话模式');
  const delivered = await cleanupDone(app, 1);
  assert.equal(delivered.length, 1, 'the explicit exit request is delivered without an address');
  assert.ok(JSON.stringify(delivered[0].content).includes('退出通话模式'));
  assert.equal((await app.callMode({ action: 'status' })).mode, 'call',
    'the host itself does not guess: the agent decides whether to exit');
  // The agent can now exit through its tool.
  assert.equal((await app.callMode({ action: 'exit' })).mode, 'normal');
  console.log(`[5] delivered=1 modeAfterAgentExit=${(await app.callMode({ action: 'status' })).mode}`);
});

test('6. normal 模式不变：同一句未寻址语音照常投递（回归）', async (t) => {
  const app = await mount(t, { callNames: [{ id: 'call-1', text: '小满', enabled: true }] });
  assert.equal((await app.callMode({ action: 'status' })).mode, 'normal');

  await app.say('今天天气不错');
  const delivered = await cleanupDone(app, 1);
  assert.equal(delivered.length, 1, 'normal mode still accepts an unaddressed utterance');
  assert.ok(JSON.stringify(delivered[0].content).includes('今天天气不错'));
  const events = await app.events();
  assert.equal(events.filter((event) => event.type === 'voice.call.unaddressed').length, 0);
  console.log(`[6] delivered=${delivered.length} mode=normal unaddressedEvents=0`);
});

/** Wait until the fake agent has received `wanted` non-digest followups (or fail). */
async function cleanupDone(app, wanted) {
  const started = Date.now();
  for (;;) {
    if (app.voiceDeliveries().length >= wanted) return app.voiceDeliveries();
    if (Date.now() - started > 4000) {
      throw new Error(`timed out waiting for ${wanted} voice deliveries; got ${app.voiceDeliveries().length}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// ---------------------------------------------------------------------------
// 7. Cross-class duplicate names
// ---------------------------------------------------------------------------

test('7. 称呼查重：与用户自称冲突拒绝，本类重复也拒绝', () => {
  const registry = createSpeakerRegistry();
  const store = createCallNameStore({ findConflict: (name) => registry.findConflict(name) });
  const user = registry.addSpeaker({ speakerId: 'spk-user', names: ['阿明'] });
  assert.equal(user.ok, true);

  const conflicted = store.add({ callNames: [] }, '阿明');
  assert.equal(conflicted.ok, false);
  assert.equal(conflicted.reason, 'duplicate-name');
  assert.equal(conflicted.conflict.kind, 'speaker');
  assert.equal(conflicted.conflict.speakerId, 'spk-user');
  assert.match(conflicted.error, /用户自称/u);

  const first = store.add({ callNames: [] }, '小满');
  assert.equal(first.ok, true);
  const again = store.add({ callNames: first.callNames }, '小满');
  assert.equal(again.ok, false);
  assert.equal(again.conflict.kind, 'call-name');

  // Full-width/case folding is the same namespace rule.
  const latinUser = createSpeakerRegistry();
  assert.equal(latinUser.addSpeaker({ speakerId: 'spk-sei', names: ['Sei'] }).ok, true);
  const latinStore = createCallNameStore({ findConflict: (name) => latinUser.findConflict(name) });
  assert.equal(latinStore.add({ callNames: [] }, 'ｓｅｉ').reason, 'duplicate-name');

  console.log(`[7] conflict=${JSON.stringify(conflicted.conflict)} duplicate=${JSON.stringify(again.conflict)}`);
});

// ---------------------------------------------------------------------------
// 8. Settings UI: add / enable / delete / mode switch
// ---------------------------------------------------------------------------

test('8. UI：添加/启用/删除称呼与普通↔通话切换都走 act', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const clientFile = fileURLToPath(new URL('../client.js', import.meta.url));
  const clientSource = readFileSync(clientFile, 'utf8');

  const from = clientSource.indexOf('    function callModeSection(h, {');
  const to = clientSource.indexOf('    function Panel() {', from);
  assert.ok(from > 0 && to > from, 'the shipped callModeSection is found in client.js');
  const load = () => new Function('styles', 'MUTED', `${clientSource.slice(from, to)}\nreturn callModeSection;`);
  const styles = new Proxy({}, { get: (_target, key) => ({ marker: String(key) }) });
  const callModeSection = load()(styles, '#6b7280');

  const h = (type, props, ...children) => ({ type, props: props ?? {}, children });
  const walk = (node, visit) => {
    if (node === null || node === undefined || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const child of node) walk(child, visit); return; }
    visit(node);
    for (const child of node.children ?? []) walk(child, visit);
  };
  const buttonsOf = (tree) => {
    const found = [];
    walk(tree, (node) => { if (node.type === 'button') found.push(node); });
    return found;
  };
  const buttonWith = (tree, label) => buttonsOf(tree).find((node) => (node.children ?? []).includes(label));
  const inputOf = (tree) => {
    let found = null;
    walk(tree, (node) => { if (found === null && node.type === 'input') found = node; });
    assert.ok(found !== null, 'the section renders the add-name input');
    return found;
  };

  const calls = [];
  const shown = [];
  const status = {
    call: {
      mode: 'normal',
      names: [
        { id: 'call-1', text: '小满', enabled: true },
        { id: 'call-2', text: '阿明', enabled: false },
      ],
    },
  };
  let draft = '';
  const act = async (body, tag) => {
    calls.push({ body, tag });
    return { ok: true, item: { id: body.id ?? 'call-3', text: body.text ?? '', enabled: true } };
  };
  const render = () => callModeSection(h, {
    status, busy: '', act, draft, onDraft: (value) => { draft = value; }, onShow: (text) => shown.push(text),
  });

  // mode switch both ways
  await buttonWith(render(), '普通').props.onClick();
  await buttonWith(render(), '通话').props.onClick();
  assert.deepEqual(calls.slice(0, 2).map((entry) => entry.body), [
    { action: 'call.mode', mode: 'normal' },
    { action: 'call.mode', mode: 'call' },
  ]);

  // add: typing then 添加 sends the text, clears the draft and confirms
  calls.length = 0;
  inputOf(render()).props.onChange({ target: { value: '小满老师' } });
  assert.equal(draft, '小满老师');
  await buttonWith(render(), '添加').props.onClick();
  assert.deepEqual(calls[0].body, { action: 'call.names.add', text: '小满老师' });
  assert.equal(draft, '', 'a successful add clears the input');
  assert.ok(shown.some((text) => text.includes('已添加称呼')), 'the add is confirmed');

  // enable/disable and delete use the row id
  calls.length = 0;
  await buttonWith(render(), '已启用').props.onClick();
  await buttonWith(render(), '已停用').props.onClick();
  await buttonWith(render(), '删除').props.onClick();
  assert.deepEqual(calls.map((entry) => entry.body), [
    { action: 'call.names.toggle', id: 'call-1', enabled: false },
    { action: 'call.names.toggle', id: 'call-2', enabled: true },
    { action: 'call.names.remove', id: 'call-1' },
  ]);

  // A duplicate refusal reaches the inline prompt instead of clearing the draft.
  draft = '小满';
  const refusing = () => callModeSection(h, {
    status, busy: '', draft, onDraft: (value) => { draft = value; },
    onShow: (text) => shown.push(text),
    act: async () => ({ ok: false, reason: 'duplicate-name', error: '「小满」已经是助手称呼' }),
  });
  await buttonWith(refusing(), '添加').props.onClick();
  assert.ok(shown.includes('「小满」已经是助手称呼'), 'the duplicate hint is shown');
  assert.equal(draft, '小满', 'a refused add keeps the typed text');

  // A state without names disables the call-mode button and explains how to enable it.
  const empty = callModeSection(h, {
    status: { call: { mode: 'normal', names: [] } }, busy: '', act, draft: '', onDraft: () => {}, onShow: () => {},
  });
  assert.equal(buttonWith(empty, '通话').props.disabled, true, 'no enabled name -> call button disabled');
  assert.ok(JSON.stringify(empty).includes('先添加并启用一个称呼'));

  console.log(`[8] actions=${calls.length} addDraftCleared=1 toggle=2 remove=1 duplicateShown=1`);
});

// ---------------------------------------------------------------------------
// 9. Barge-in isolation: an unaddressed final never stops the sounding reply
// ---------------------------------------------------------------------------

test('9. call 模式未寻址不打断播报；命中称呼才允许打断并投递', async (t) => {
  const app = await mount(t, {
    callNames: [{ id: 'call-1', text: '小满', enabled: true }],
    voice: true,
  });
  assert.equal((await app.callMode({ action: 'enter' })).ok, true);

  const accepted = await app.sayTool(
    { text: '我在这里。', purpose: 'progress' },
    { agent: { session: { id: 'call-mode-host-barge' } } },
  );
  assert.equal(accepted.accepted, true, `a progress clip is accepted: ${accepted.reason ?? ''}`);
  await app.waitUntil(() => app.players().length > 0, 'the progress clip started');
  const clip = app.players()[0];
  const stopsBefore = app.stops();

  // Unaddressed while a clip is sounding: no delivery, no interruption, no barge-in row.
  await app.say('今天天气不错');
  await app.waitForEvent('voice.call.unaddressed');
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(app.stops(), stopsBefore, 'the unaddressed final never cancels playback');
  assert.equal(clip.signal.aborted, false, 'the sounding clip signal is untouched');
  assert.deepEqual(app.voiceDeliveries(), [], 'and nothing is delivered');
  assert.equal(
    (await app.events()).filter((event) => event.type === 'hearing.bargein').length,
    0,
    'no barge-in event is written for an unaddressed final',
  );

  // An addressed final is the one interruption call mode allows.
  await app.say('小满，在吗');
  await app.waitForEvent('hearing.bargein');
  await cleanupDone(app, 1);
  assert.ok(app.stops() > stopsBefore, 'addressed speech stops the sounding clip');
  console.log(`[9] unaddressedStops=${stopsBefore} addressedStops=${app.stops()} delivered=1`);
});
