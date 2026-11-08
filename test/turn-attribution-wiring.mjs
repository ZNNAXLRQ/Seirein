/**
 * P-46 stage 2: the host wires turn attribution into every synthesis and seat wait.
 *
 * Stage 1 made `tts.js` / `speech-ledger.js` able to carry `turn` / `deliveryMessageId` /
 * `sessionId`; this file proves the INDEX side actually fills them, without changing any
 * playback, synthesis, cache or priority rule:
 *
 *   1. one automatic voice reply -> every `voice.tts.request` of the answer body carries
 *      `turn` / `deliveryMessageId` / `sessionId`, and the playback seat wait
 *      (`speech.seat.wait`) carries `sessionId` / `turn` / `waitMs`;
 *   2. one typed (non-voice) reply -> the same attribution, no voice delivery involved;
 *   3. `assistant_say` with `play:false` -> `purpose:'tool'`, the tool call's own turn;
 *   4. the waiting line (`purpose:'ack'`) -> the delivery turn, `deliveryMessageId` null;
 *   5. a line that belongs to no turn (busy notice) -> all three stay null, never fabricated.
 *
 * The real `tts.js` runs (`voice.tts.request` is a real observation row) with only the Edge
 * socket and the player replaced, so the assertions are about the row the host actually writes.
 * The plugin is mounted against a temp root with a fake hearing device and fake loop; no
 * microphone, ffmpeg, TTS service, network or GUI is used.
 *
 * Run: node --test test/turn-attribution-wiring.mjs
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cleanupRoot } from './helpers/cleanup.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const state = {
  events: [],
  followups: [],
  onUpdate: null,
  players: [],
  listenerErrors: [],
  agent: null,
};
globalThis.__turnAttributionWiring = state;

const moduleUrl = (path) => new URL(path, import.meta.url).href;
const hearingUrl = moduleUrl('../src/host/hearing/hearing.js');
const sightUrl = moduleUrl('../src/host/vision/sight.js');
const ttsUrl = moduleUrl('../src/host/speech/tts.js');

const hooks = registerHooks({
  load(href, context, next) {
    if (href === hearingUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          const s = globalThis.__turnAttributionWiring;
          export const modelReady = () => true;
          export const finalModelReady = () => false;
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
    // Real reporting + real provider fallback; only the player is replaced.
    if (href === ttsUrl) {
      const real = `${ttsUrl}?turn-attribution-wiring-real`;
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          export * from ${JSON.stringify(real)};
          const s = globalThis.__turnAttributionWiring;
          export const play = (file, options = {}) => {
            let resolve;
            const done = new Promise((doneResolve) => { resolve = doneResolve; });
            s.players.push({ file, options, resolve, settled: false });
            try { options.onStart?.({ playerReadyAt: Date.now(), spawnAt: Date.now() }); } catch { /* observation */ }
            return done;
          };
        `,
      };
    }
    if (href.endsWith('/msedge-tts/dist/index.js')) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          import { Readable } from 'node:stream';
          class FakeMsEdgeTTS {
            async setMetadata() {}
            async toStream() {
              let sent = false;
              const audioStream = new Readable({
                read() {
                  if (sent) return;
                  sent = true;
                  this.push(Buffer.from('fake-audio-bytes'));
                  this.push(null);
                },
              });
              return { audioStream };
            }
            close() {}
          }
          export default { MsEdgeTTS: FakeMsEdgeTTS };
        `,
      };
    }
    return next(href, context);
  },
});

const { apply } = await import('../src/host/index.js');
const { EventLog } = await import('../src/host/memory/store.js');
hooks.deregister();

const originalEmit = EventLog.prototype.emit;
EventLog.prototype.emit = async function emit(type, payload) {
  state.events.push({ type, payload });
  return { id: 'turn-attribution-wiring', ts: new Date().toISOString(), type, payload };
};

after(() => {
  EventLog.prototype.emit = originalEmit;
  delete globalThis.__turnAttributionWiring;
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

async function until(predicate, label, timeoutMs = 8_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate() === true) return;
    await sleep(10);
  }
  assert.fail(`timed out: ${label}`);
}

/** Resolve every clip the fake player received; an unresolved transport stalls the round. */
function drainPlayers() {
  for (const player of state.players) {
    if (player.settled === true) continue;
    player.settled = true;
    player.resolve();
  }
}

/** Wait for a condition while keeping the fake playback moving. */
async function untilEvents(predicate, label) {
  await until(() => {
    drainPlayers();
    return predicate();
  }, label);
}

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
    async dispatch(type, ...args) {
      let result;
      for (const entry of [...listeners]) {
        if (entry.type !== type) continue;
        result = await entry.fn(...args);
      }
      return result;
    },
  };
}

/**
 * Mount the plugin against a temp root. The fake loop commits one synthetic turn per delivery:
 * `replyDelayMs` postpones the assistant message (so a waiting line can win the deadline) and
 * `endDelayMs` postpones `turn/end` (so the session stays busy for a following utterance).
 */
async function mount(t, { replyDelayMs = 0, endDelayMs = 0, ackDelayMs = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-turn-attribution-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await mkdir(join(root, 'workspace'), { recursive: true });
  await writeFile(join(root, 'data', 'features.json'), JSON.stringify({
    hearing: true,
    ambient: false,
    voice: true,
    vision: false,
    subtitle: false,
    avatar: false,
    memory: true,
    fastpath: false,
  }), 'utf8');
  await writeFile(join(root, 'data', 'settings.json'), JSON.stringify({
    gptSovits: { enabled: false },
    langs: { speech: 'zh', subtitle: 'zh' },
    autoMemory: { enabled: false },
    ...(ackDelayMs === null ? {} : { voice: { ackDelayMs } }),
  }), 'utf8');

  state.events = [];
  state.followups = [];
  state.onUpdate = null;
  state.players = [];
  state.listenerErrors = [];
  state.agent = null;

  const bus = createBus();
  const cleanups = [];
  const tools = new Map();
  const services = new Map([
    ['agentDefaultModel', { currentSelection: () => ({ provider: 'fake-provider', model: 'fake-model' }) }],
    ['sessionTitle', { get: () => undefined, rename: (_session, title) => ({ title, source: { kind: 'user' } }) }],
    ['workspaceRegistry', {
      async create(path) {
        return { id: 'ws-turn-attribution', path };
      },
      get() {
        return { id: 'ws-turn-attribution', async attachSession() {} };
      },
    }],
  ]);
  const agents = new Map();
  let persisted = false;
  const makeAgent = (sessionId) => {
    const session = {
      id: sessionId,
      header: { cwd: join(root, 'workspace') },
      append() {},
    };
    let turn = 0;
    const agent = {
      id: sessionId,
      session,
      followup(message) {
        state.followups.push(message);
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
        const assistant = () => fire('assistant/message', {
          turn: turnId,
          step: 1,
          message: {
            id: `a-${turnId}`,
            role: 'assistant',
            content: [{ type: 'text', text: '好的。我这就去查。' }],
          },
        });
        const finish = () => fire('turn/end', { turn: turnId, reason: { kind: 'completed' } });
        if (replyDelayMs > 0) setTimeout(assistant, replyDelayMs);
        else assistant();
        if (endDelayMs > 0) setTimeout(finish, endDelayMs);
        else finish();
      },
    };
    state.agent = agent;
    return agent;
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
  const ctx = {
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
  };
  apply(ctx, { root, enabled: true, asrMergeWindowMs: 10 });
  t.after(async () => {
    drainPlayers();
    await cleanupRoot(root, cleanups.splice(0));
  });

  const listen = tools.get('assistant_listen');
  assert.ok(listen !== undefined, 'assistant_listen is registered');
  const started = await listen.execute({ action: 'start' });
  assert.equal(started.ok, true, `listening started: ${started.error ?? ''}`);
  assert.equal(typeof state.onUpdate, 'function', 'the hearing session exposes onUpdate');

  const rows = (type) => state.events.filter((entry) => entry.type === type);
  return {
    root,
    rows,
    say: (text) => state.onUpdate({ final: text, durationMs: 100 }),
    tools,
    bus,
    agent: () => state.agent,
  };
}

const payloads = (app, type) => app.rows(type).map((entry) => entry.payload);

// ---------------------------------------------------------------------------
// 1) automatic voice reply: tts rows + seat wait carry the delivery attribution
// ---------------------------------------------------------------------------

test('1) an automatic reply names its turn/delivery/session on every tts row and the seat wait', async (t) => {
  const app = await mount(t);
  app.say('帮我看看明天的天气');
  await untilEvents(() => app.rows('voice.latency').length === 1, 'voice.latency');

  const agent = app.agent();
  const sessionId = agent.session.id;
  const request = state.followups.at(-1);
  assert.ok(request !== undefined, 'the voice delivery registered one followup');

  const answerRows = payloads(app, 'voice.tts.request').filter((row) => row.purpose === 'answer');
  assert.ok(answerRows.length >= 1, 'the answer body was synthesized');
  for (const row of answerRows) {
    assert.equal(row.turn, 1, 'voice.tts.request.turn is the reply turn');
    assert.equal(row.sessionId, sessionId, 'voice.tts.request.sessionId');
    assert.equal(row.deliveryMessageId, request.id, 'voice.tts.request.deliveryMessageId');
  }

  const seats = payloads(app, 'speech.seat.wait').filter((row) => row.turn === 1 && row.sessionId === sessionId);
  assert.ok(seats.length >= 1, 'the reply seat wait was attributed');
  for (const seat of seats) {
    assert.ok(Number.isInteger(seat.waitMs) && seat.waitMs >= 0, 'waitMs is a measured duration');
    assert.ok(typeof seat.outcome === 'string' && seat.outcome.length > 0, 'outcome is present');
  }

  const row = answerRows[0];
  const seat = seats[0];
  console.log(`[1] answer rows=${answerRows.length} tts=${JSON.stringify({
    purpose: row.purpose, turn: row.turn, sessionId: row.sessionId, deliveryMessageId: row.deliveryMessageId,
  })} seat=${JSON.stringify({
    sessionId: seat.sessionId, turn: seat.turn, waitMs: seat.waitMs, queueDepth: seat.queueDepth, outcome: seat.outcome,
  })}`);
});

// ---------------------------------------------------------------------------
// 2) typed reply: no voice delivery, but the same turn attribution
// ---------------------------------------------------------------------------

test('2) a typed reply names its own turn and session on the tts row', async (t) => {
  const app = await mount(t);
  // One voice round first only to let the fake host create a session; the typed turn is new.
  app.say('先随便说一句');
  await untilEvents(() => app.rows('voice.latency').length === 1, 'the setup round');
  drainPlayers();

  const agent = app.agent();
  const session = agent.session;
  const turn = 5;
  const fire = (type, data) => app.bus.fire('session/event', session, {
    type,
    seq: 500 + turn,
    time: Date.now(),
    data,
  });
  fire('turn/start', { turn });
  fire('user/message', {
    turn,
    id: 'typed-u-5',
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: '请给我一句说明。' }],
  });
  fire('assistant/message', {
    turn,
    step: 1,
    message: {
      id: 'typed-a-5',
      role: 'assistant',
      content: [{ type: 'text', text: '收到。我这就处理。' }],
    },
  });
  fire('turn/end', { turn, reason: { kind: 'completed' } });

  await untilEvents(() => payloads(app, 'voice.tts.request').some((row) => (
    row.sessionId === session.id && row.turn === turn
  )), 'the typed reply synthesis');

  const typedRows = payloads(app, 'voice.tts.request').filter((row) => row.turn === turn);
  assert.ok(typedRows.length >= 1, 'the typed body was synthesized');
  for (const row of typedRows) {
    assert.equal(row.sessionId, session.id, 'typed row sessionId');
    assert.equal(row.turn, turn, 'typed row turn');
  }

  console.log(`[2] typed rows=${typedRows.length} turn=${typedRows[0].turn} `
    + `sessionId=${typedRows[0].sessionId} deliveryMessageId=${typedRows[0].deliveryMessageId}`);
});

// ---------------------------------------------------------------------------
// 3) assistant_say (play:false): purpose 'tool' with the tool call's own turn
// ---------------------------------------------------------------------------

test('3) assistant_say play:false is a tool synthesis with the tool call turn', async (t) => {
  const app = await mount(t);
  app.say('先确认一下环境');
  await untilEvents(() => app.rows('voice.latency').length === 1, 'the setup round');
  drainPlayers();

  const agent = app.agent();
  const sayTool = app.tools.get('assistant_say');
  assert.ok(sayTool !== undefined, 'assistant_say is registered');
  const accepted = await sayTool.execute({ text: '我先查一下。', play: false, purpose: 'explicit' }, { agent });
  assert.equal(accepted.accepted, true, `say accepted: ${accepted.reason ?? ''}`);

  await untilEvents(() => payloads(app, 'voice.tts.request').some((row) => row.purpose === 'tool'), 'tool synthesis');
  const rows = payloads(app, 'voice.tts.request').filter((row) => row.purpose === 'tool');
  for (const row of rows) {
    assert.equal(row.turn, 1, 'the tool line belongs to the current turn');
    assert.equal(row.sessionId, agent.session.id, 'the tool line names its session');
    assert.equal(row.deliveryMessageId, null, 'a tool line has no delivery message id');
  }

  console.log(`[3] tool rows=${rows.length} purpose=${rows[0].purpose} turn=${rows[0].turn} `
    + `sessionId=${rows[0].sessionId} deliveryMessageId=${rows[0].deliveryMessageId}`);
});

// ---------------------------------------------------------------------------
// 4) ack (waiting line): the delivery turn, deliveryMessageId null
// ---------------------------------------------------------------------------

test('4) the waiting line is synthesized for the turn, without a delivery message id', async (t) => {
  // The body is deliberately slow so the ack deadline wins and the fallback line is synthesized.
  const app = await mount(t, { replyDelayMs: 900, endDelayMs: 1_200, ackDelayMs: 500 });
  app.say('帮我想想周末去哪里');
  await untilEvents(() => payloads(app, 'voice.tts.request').some((row) => row.purpose === 'ack'), 'ack synthesis');

  const agent = app.agent();
  const rows = payloads(app, 'voice.tts.request').filter((row) => row.purpose === 'ack');
  assert.ok(rows.length >= 1, 'the waiting line was synthesized');
  for (const row of rows) {
    assert.equal(row.turn, 1, 'the waiting line belongs to the delivery turn');
    assert.equal(row.sessionId, agent.session.id, 'the waiting line names its session');
    assert.equal(row.deliveryMessageId, null, 'a waiting line has no delivery message id');
  }

  console.log(`[4] ack rows=${rows.length} purpose=${rows[0].purpose} turn=${rows[0].turn} `
    + `sessionId=${rows[0].sessionId} deliveryMessageId=${rows[0].deliveryMessageId}`);
});

// ---------------------------------------------------------------------------
// 5) no turn: a busy notice stays null on all three fields
// ---------------------------------------------------------------------------

test('5) a line outside any turn reports explicit nulls, never a fabricated id', async (t) => {
  // The first round stays open before its body starts, so the second utterance meets an active
  // delivery waiter, is refused as busy, and the shared whole-line outlet speaks the notice with
  // no turn/session of its own.
  const app = await mount(t, { replyDelayMs: 2_500, endDelayMs: 2_500 });
  app.say('第一个问题');
  await untilEvents(() => app.rows('voice.injected').length === 1, 'first delivery');
  // The first waiter still owns the session and nothing is sounding yet: not a barge-in.
  await sleep(150);
  app.say('第二个问题');
  await untilEvents(() => payloads(app, 'voice.tts.request').some((row) => row.purpose === 'say'), 'busy notice synthesis');

  const rows = payloads(app, 'voice.tts.request').filter((row) => row.purpose === 'say');
  assert.ok(rows.length >= 1, 'the busy notice was synthesized');
  for (const row of rows) {
    assert.equal(row.turn, null, 'no turn is invented for the notice');
    assert.equal(row.sessionId, null, 'no session is invented for the notice');
    assert.equal(row.deliveryMessageId, null, 'no delivery id is invented for the notice');
  }

  console.log(`[5] say rows=${rows.length} purpose=${rows[0].purpose} turn=${rows[0].turn} `
    + `sessionId=${rows[0].sessionId} deliveryMessageId=${rows[0].deliveryMessageId}`);

  // Let the delayed first round finish before teardown closes the stores it still uses.
  await untilEvents(() => app.rows('voice.latency').length === 1, 'the delayed round completes');
});
