/**
 * 候音等待（voice.ackDelayMs）与 hearing 的「投递判定」。
 *
 * A. 投递判定（只增加返回值，不改变投递规则）：
 *    1. 播放中判定的回授 → onUpdate 返回 {accepted:false, reason:'playback-echo'}，台词缓冲不 push；
 *    2. 正常语音（未播放）→ {accepted:true} 且入缓冲（回环通道用 status.ambient.recent 观察）；
 *    3. 组件关闭/停止中到达的片段 → {accepted:false, reason:'inactive'}（照常投递，只是不进缓冲）。
 * B. 设置入口 `voice.ack.delay {ms}`：写 settings.voice.ackDelayMs，夹在 500–15000，非法输入拒绝，
 *    事件 voice.ack.delay.set {ms}，status.voiceAckDelayMs 立即反映新值；lane 每轮重新读取，改完即生效。
 * C. 设置页「候音等待」行：显示当前值；合法输入保存；非法输入不写入并提示（与「麦克风阈值」同一套写法）。
 *
 * hearing / TTS / sight / subtitle / hardware / child_process 全部换成脚本替身，不录不放不联网。
 * 台词缓冲用真实的 `createDialogueCapture`（hearing.js 的实现）驱动，所以「不 push」是缓冲自己的结论。
 *
 * Run: node --test test/ack-delay-ui.mjs
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { cleanupRoot } from './helpers/cleanup.mjs';
import { createDialogueContext } from '../src/host/session/conversation/dialogueContext.js';

const state = { calls: [], players: [], captures: [], synthTexts: [] };
globalThis.__ackDelayHost = state;

const urlOf = (path) => new URL(path, import.meta.url).href;
const hearingUrl = urlOf('../src/host/hearing/hearing.js');
const ttsUrl = urlOf('../src/host/speech/tts.js');
const sightUrl = urlOf('../src/host/vision/sight.js');
const subtitleUrl = urlOf('../src/host/subtitle/subtitle.js');
const hardwareUrl = urlOf('../src/host/platform/hardware.js');
const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8');

const hooks = registerHooks({
  load(url, context, next) {
    if (url === hearingUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    // The real capture implementation decides whether a delivered final enters the buffer.
    import { createDialogueCapture } from '${hearingUrl}?ack-delay-real';
    const s = globalThis.__ackDelayHost;
    export const modelReady = () => true;
    export const finalModelReady = () => false;
    export const isLoopbackDevice = (name) => /CABLE|Stereo Mix|Virtual/i.test(String(name));
    export const listDevices = async () => ['Fake Mic', 'CABLE Output (VB-Audio Virtual Cable)'];
    export const startHearing = (options) => {
      const source = /CABLE|Stereo Mix|Virtual/i.test(String(options.device)) ? 'loopback' : 'mic';
      const capture = options.dialogueContext
        ? createDialogueCapture({
            context: options.dialogueContext,
            source,
            emit: (type, payload) => {
              s.captures.push({ type, payload });
              options.onEvent?.(type, payload);
            },
          })
        : null;
      // Mirror the one rule hearing owns: a delivered final enters the buffer only when the host
      // did not refuse it (no verdict falls back to the delivery condition, as before).
      const onUpdate = (event) => {
        const verdict = options.onUpdate?.(event);
        if (typeof event?.final === 'string' && verdict?.accepted !== false) {
          capture?.push({
            text: event.final,
            at: Number(event.at) > 0 ? Number(event.at) : Date.now(),
            utteranceId: event.utteranceId,
          });
        }
        return verdict;
      };
      s.calls.push({ device: options.device, onUpdate, dialogueContext: options.dialogueContext });
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
    const s = globalThis.__ackDelayHost;
    export { resolveGptLangs, resolveGptSovitsTimeout } from '${ttsUrl}?ack-delay-helpers';
    export const configureTts = () => {};
    export const gptSovitsReferenceStatus = async () => ({ seconds: null, ok: false, readable: false });
    export const warmupGptSovits = async () => ({ ok: false, skipped: 'disabled' });
    export const applyGptSovitsModels = () => ({ ok: true });
    export const synthesize = async ({ text }) => {
      s.synthTexts.push(text);
      return { file: 'fake-ack.mp3', bytes: 16, durationMs: 5000, provider: 'fake' };
    };
    export const speakStreaming = async () => { throw new Error('streaming not expected'); };
    export const stopPlayback = () => true;
    export const stopTts = () => true;
    // A clip that is only "started" and never ends: ttsIsSpeaking stays true for the echo test.
    export const play = (file, options) => {
      let resolve;
      const done = new Promise((doneResolve) => { resolve = doneResolve; });
      const player = { file, ...options, startedAt: Date.now(), endedAt: 0, cancelled: false, resolve };
      s.players.push(player);
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
    export function readObservation(value) { return { ...(value ?? {}), stale: true, hint: '' }; }`,
      };
    }
    if (url === subtitleUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    export const averageColor = async () => null;
    export { SubtitleHold } from '${subtitleUrl}?ack-delay-real';
    export class SubtitleOverlay {
      constructor({ config }) { this.config = config; }
      async show() { return true; }
      async hide() {}
      async stop() {}
    }`,
      };
    }
    if (url === hardwareUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `export const detectTuning = () => ({
          cores: 8, memoryGb: 16, streamThreads: 2, finalThreads: 3, decodeCapSec: 10, tier: 'mid',
        });`,
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

const { apply, createAckLane } = await import('../src/host/index.js');
hooks.deregister();

after(() => { delete globalThis.__ackDelayHost; });

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check, label, timeoutMs = 5000) => {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) assert.fail(`timed out: ${label}`);
    await tick(10);
  }
};

const ACK_LINE = '我这就去看看你说的天气情况';

/** Mount the real plugin with scripted hearing/TTS and the real action/status routes. */
async function mount(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ack-delay-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await mkdir(join(root, 'workspace'), { recursive: true });
  await writeFile(join(root, 'data', 'features.json'), JSON.stringify({
    hearing: true,
    ambient: true,
    voice: true,
    vision: false,
    subtitle: false,
    avatar: false,
    memory: false,
    fastpath: false,
  }));
  await writeFile(join(root, 'data', 'settings.json'), JSON.stringify({
    gptSovits: { enabled: false },
    // No warm build during these short mounts.
    voice: { ackWarmIdleMs: 600000 },
  }));

  state.calls = [];
  state.players = [];
  state.captures = [];
  state.synthTexts = [];

  const dialogueContext = createDialogueContext({ source: 'mic' });
  const routes = new Map();
  const tools = new Map();
  const cleanups = [];
  const handlers = [];
  const effect = (run) => {
    const cleanup = run();
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
    get: (name) => (name === 'agentDefaultModel'
      ? { currentSelection: () => ({ provider: 'fake-provider', model: 'fake-model' }) }
      : undefined),
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    inject: (_deps, register) => register(scope),
    webServer: scope.webServer,
  }, {
    root,
    enabled: true,
    // The test seam the host already documents: one buffer, so the stub capture writes where the
    // real capture session would write.
    dialogueContext,
  });

  const action = async (body) => {
    const handler = routes.get('/assistant/action');
    assert.equal(typeof handler, 'function', 'the action route is registered');
    let result;
    await handler(
      Object.assign(Readable.from([JSON.stringify(body)]), { method: 'POST' }),
      { writeHead() {}, end(value) { result = JSON.parse(value); } },
    );
    return result;
  };
  const status = async () => {
    const handler = routes.get('/assistant/status');
    assert.equal(typeof handler, 'function', 'the status route is registered');
    let body = '';
    await handler({ method: 'GET', url: '/assistant/status' }, { writeHead() {}, end(value) { body = value; } });
    return JSON.parse(body);
  };
  const events = async () => {
    try {
      const text = await readFile(join(root, 'data', 'events.jsonl'), 'utf8');
      return text.trim().split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  const say = (args) => tools.get('assistant_say').execute(args, {});

  // The microphone session first, then the loopback lane: both onUpdate callbacks are captured.
  const listen = tools.get('assistant_listen');
  assert.ok(listen !== undefined, 'assistant_listen is registered');
  const started = await listen.execute({ action: 'start' });
  assert.equal(started.ok, true, `listening started: ${started.error ?? ''}`);
  const ambientStarted = await action({ action: 'ambient.start' });
  assert.equal(ambientStarted.ok, true, `ambient started: ${ambientStarted.error ?? ''}`);
  assert.equal(state.calls.length, 2, 'both capture sessions reached the scripted hearing');
  const mic = state.calls[0];
  const ambient = state.calls[1];

  t.after(async () => {
    for (const player of state.players) player.resolve();
    await cleanupRoot(root, cleanups.splice(0));
  });

  return {
    root,
    dialogueContext,
    action,
    status,
    events,
    say,
    mic,
    ambient,
    micOnUpdate: (event) => mic.onUpdate(event),
    ambientOnUpdate: (event) => ambient.onUpdate(event),
    players: () => state.players,
  };
}

// ---------------------------------------------------------------------------
// A1. 播放中回授：两个 onUpdate 都返回 playback-echo，台词缓冲不 push
// ---------------------------------------------------------------------------

test('1. 播放中回授 → 麦克风/回环 onUpdate 都返回 playback-echo，缓冲不 push', async (t) => {
  const app = await mount(t);
  const spoken = await app.say({ text: '我在听你说。' });
  assert.equal(spoken.accepted, true, 'the clip was accepted for background playback');
  await until(() => app.players().length === 1, 'the clip reached the player');

  const micVerdict = app.micOnUpdate({ final: '我在听你说。', durationMs: 100, utteranceId: '1' });
  const ambientVerdict = app.ambientOnUpdate({ final: '我在听你说。', durationMs: 100, utteranceId: '2' });
  assert.deepEqual(micVerdict, { accepted: false, reason: 'playback-echo' }, 'mic echo is refused');
  assert.deepEqual(ambientVerdict, { accepted: false, reason: 'playback-echo' }, 'loopback echo is refused');

  assert.equal(app.dialogueContext.snapshot().recent.length, 0, 'a refused echo never enters the buffer');
  assert.equal((await app.status()).ambient.recent.length, 0, 'the ambient lane holds no echo either');
  await tick(50);
  assert.equal(
    (await app.events()).filter((row) => row.type === 'hearing.dialogue.appended').length,
    0,
    'no appended row was written for the refused echo',
  );
});

// ---------------------------------------------------------------------------
// A2. 正常语音：accepted:true 且入缓冲
// ---------------------------------------------------------------------------

test('2. 正常语音 → onUpdate 返回 accepted:true 且台词缓冲/环境音都 push', async (t) => {
  const app = await mount(t);

  const micVerdict = app.micOnUpdate({ final: '今天天气不错。', durationMs: 900, utteranceId: 'm1' });
  assert.deepEqual(micVerdict, { accepted: true }, 'normal microphone speech is accepted');
  assert.deepEqual(
    app.dialogueContext.snapshot().recent.map((entry) => entry.text),
    ['今天天气不错。'],
    'the accepted final was pushed once',
  );

  const ambientVerdict = app.ambientOnUpdate({ final: '视频里说下午有雨。', durationMs: 800, utteranceId: 'a1' });
  assert.deepEqual(ambientVerdict, { accepted: true }, 'normal loopback speech is accepted');
  const status = await app.status();
  assert.deepEqual(status.ambient.recent, ['视频里说下午有雨。'], 'the loopback lane kept the line');

  // A partial is forwarded as well (it never enters the buffer anyway).
  assert.deepEqual(app.micOnUpdate({ partial: '今天' }), { accepted: true });
  assert.equal(app.dialogueContext.snapshot().recent.length, 2, 'the partial added no buffer entry');

  const appended = await until(async () => {
    const rows = (await app.events()).filter((row) => row.type === 'hearing.dialogue.appended');
    return rows.length >= 2 ? rows : null;
  }, 'two appended rows');
  assert.equal(appended.length, 2, 'each accepted final wrote one appended row');
});

// ---------------------------------------------------------------------------
// A3. 组件关闭/停止中到达的片段：inactive（继续投递，但不进缓冲）
// ---------------------------------------------------------------------------

test('3. 组件关闭后到达的片段 → inactive（投递不变，只是不进缓冲）', async (t) => {
  const app = await mount(t);
  const off = await app.action({ action: 'feature.set', id: 'hearing', enabled: false });
  assert.equal(off.ok, true, `hearing closed: ${off.error ?? ''}`);

  assert.deepEqual(
    app.micOnUpdate({ partial: '还在吗' }),
    { accepted: false, reason: 'inactive' },
    'a fragment arriving while the component is closed is inactive',
  );
  assert.equal(app.dialogueContext.snapshot().recent.length, 0);
});

// ---------------------------------------------------------------------------
// B. voice.ack.delay：3000/1500 生效、越界夹紧、非法拒绝
// ---------------------------------------------------------------------------

test('3b. voice.ack.delay → 3000/1500 写入并立即反映；越界夹紧；非法拒绝', async (t) => {
  const app = await mount(t);

  assert.deepEqual(await app.action({ action: 'voice.ack.delay', ms: 3000 }), { ok: true, ackDelayMs: 3000 });
  assert.equal((await app.status()).voiceAckDelayMs, 3000, 'status reflects the saved value at once');
  const saved = JSON.parse(await readFile(join(app.root, 'data', 'settings.json'), 'utf8'));
  assert.equal(saved.voice.ackDelayMs, 3000, 'settings.json keeps voice.ackDelayMs');

  assert.deepEqual(await app.action({ action: 'voice.ack.delay', ms: 1500 }), { ok: true, ackDelayMs: 1500 });
  assert.equal((await app.status()).voiceAckDelayMs, 1500);

  assert.deepEqual(await app.action({ action: 'voice.ack.delay', ms: 60_000 }), { ok: true, ackDelayMs: 15_000 });
  assert.deepEqual(await app.action({ action: 'voice.ack.delay', ms: 100 }), { ok: true, ackDelayMs: 500 });

  const refused = await app.action({ action: 'voice.ack.delay', ms: 'abc' });
  assert.equal(refused.ok, false, 'a non-numeric value is refused');
  assert.equal(refused.error.length > 0, true, 'the refusal carries a message');
  assert.equal((await app.status()).voiceAckDelayMs, 500, 'a refused value changes nothing');
  assert.equal((await app.action({ action: 'voice.ack.delay' })).ok, false, 'a missing value is refused too');

  const rows = (await app.events()).filter((row) => row.type === 'voice.ack.delay.set');
  assert.deepEqual(rows.map((row) => row.payload.ms), [3000, 1500, 15_000, 500], 'one row per accepted value');
});

// ---------------------------------------------------------------------------
// B2. 立即生效：lane 每轮重新读取 delayMs；宿主把 getter 接进 lane
// ---------------------------------------------------------------------------

test('3c. 改完立即生效：下一轮按新值计时（lane 每轮重新读取）', async (t) => {
  t.diagnostic('the lane reads delayMs on every beginTurn, so no restart is needed');
  const box = { ms: 3000 };
  const plays = [];
  const lane = createAckLane({
    emit: async () => {},
    generate: async () => '我这就去看看你说的天气情况',
    synthesize: async () => ({ file: 'ack.mp3', durationMs: 100 }),
    play: async () => {
      const player = { startedAt: Date.now(), end: null };
      const done = new Promise((resolve) => { player.end = () => resolve(); });
      plays.push(player);
      return { audioStartedAt: player.startedAt, done };
    },
    delayMs: () => box.ms,
    timeoutMs: () => 100,
  });
  t.after(() => lane.cancel('test-done'));

  lane.beginTurn({ sessionId: 's-slow', turn: 1, userText: '第一轮' });
  await tick(120);
  assert.equal(plays.length, 0, '3000 ms has not elapsed yet');

  box.ms = 40; // the settings action would write this
  lane.beginTurn({ sessionId: 's-fast', turn: 2, userText: '第二轮' });
  await until(() => plays.length === 1, 'the second turn used the new 40 ms value');
  assert.equal(plays.length, 1);

  const hostSource = await readFile(new URL('../src/host/index.js', import.meta.url), 'utf8');
  assert.match(
    hostSource,
    /delayMs: \(\) => resolveAckDelayMs\(readSettings\(\), config\),/u,
    'the host wires the live settings value into the lane',
  );
});

// ---------------------------------------------------------------------------
// C. 设置页「候音等待」行（从 client.js 抽出真实发货的函数）
// ---------------------------------------------------------------------------

const h = (type, props, ...children) => ({ type, props: props ?? {}, children });
const styles = new Proxy({}, { get: (_target, key) => ({ marker: String(key) }) });

const loadAckDelayRow = () => {
  const from = clientSource.indexOf('    function ackDelayRow(h, { draft, saved, busy, onDraft, onSave, onInvalid }) {');
  const to = clientSource.indexOf('    function Panel() {', from);
  assert.ok(from > 0 && to > from, 'the shipped ackDelayRow is found in client.js');
  return new Function('styles', `${clientSource.slice(from, to)}\nreturn ackDelayRow;`)(styles);
};
const ackDelayRow = loadAckDelayRow();

const walk = (node, visit) => {
  if (node === null || node === undefined || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
};
const inputOf = (tree) => {
  let found = null;
  walk(tree, (node) => {
    if (found === null && node.type === 'input' && node.props.type === 'number') found = node;
  });
  assert.ok(found !== null, 'the row renders a number input');
  return found;
};
const saveButtonOf = (tree) => {
  let found = null;
  walk(tree, (node) => {
    if (found === null && node.type === 'button'
      && (node.children ?? []).some((child) => child === '保存候音等待')) found = node;
  });
  assert.ok(found !== null, 'the row renders the 保存候音等待 button');
  return found;
};
const textsOf = (tree) => {
  const texts = [];
  walk(tree, (node) => {
    for (const child of node.children ?? []) if (typeof child === 'string') texts.push(child);
  });
  return texts;
};

const mountRow = ({ saved = 3000, draft = null, result = { ok: true } } = {}) => {
  const row = { saved, draft, busy: '', calls: [], errors: [], result };
  row.onSave = async (ms) => {
    row.calls.push(ms);
    if (row.result.ok) row.saved = ms;
    return row.result;
  };
  const render = () => ackDelayRow(h, {
    draft: row.draft,
    saved: row.saved,
    busy: row.busy,
    onDraft: (value) => { row.draft = value; },
    onSave: row.onSave,
    onInvalid: (message) => row.errors.push(message),
  });
  return {
    row,
    render,
    type: (value) => inputOf(render()).props.onChange({ target: { value } }),
    save: async () => saveButtonOf(render()).props.onClick(),
  };
};

test('4. 设置页显示当前值，合法输入保存后回显新值', async () => {
  const view = mountRow({ saved: 3000 });
  assert.equal(inputOf(view.render()).props.value, '3000', '打开时显示 status.voiceAckDelayMs');
  assert.ok(textsOf(view.render()).includes('候音等待 3000 ms（0.5–15 秒，默认 3000）'), '标签带当前值与范围');

  view.type('1500');
  assert.equal(inputOf(view.render()).props.value, '1500', '编辑时显示草稿');
  await view.save();
  assert.deepEqual(view.row.calls, [1500], '保存发送的是输入框里的毫秒数');
  assert.equal(view.row.draft, null, '保存成功后丢弃草稿');
  assert.equal(inputOf(view.render()).props.value, '1500', '输入框回显保存后的值');
  assert.equal(view.row.errors.length, 0, '合法输入不提示错误');
});

test('5. 非法输入不写入并提示；界面不出现脏值', async () => {
  const view = mountRow({ saved: 3000 });
  for (const bad of ['', 'abc', '40000', '100']) {
    view.row.calls.length = 0;
    view.row.errors.length = 0;
    view.type(bad);
    await view.save();
    assert.deepEqual(view.row.calls, [], `"${bad}" is never written`);
    assert.equal(view.row.errors.length, 1, `"${bad}" shows one hint`);
    assert.match(view.row.errors[0], /500–15000/u, 'the hint names the accepted range');
    assert.equal(view.row.draft, bad, 'the draft stays in the box so the user can fix it');
  }
  assert.equal(view.row.saved, 3000, 'the saved value never moved');

  // Panel wiring: status value in, action out, same controlled draft.
  assert.match(clientSource, /const \[ackDelayDraft, setAckDelayDraft\] = useState\(null\);/u);
  assert.match(clientSource, /saved: Number\(status\.voiceAckDelayMs \?\? 3000\),/u);
  assert.match(clientSource, /action: 'voice\.ack\.delay', ms/u);
  assert.match(clientSource, /ackDelayRow\(h, \{/u);
});
