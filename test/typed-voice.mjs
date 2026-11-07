/**
 * Typed-turn voice: a typed round is spoken once, at `turn/end`, from its final body text.
 *
 * Scope of this build: round-end only. Nothing here claims the body is spoken while it is being
 * generated — the voice lane keeps that path; this relay starts after the round settles.
 *
 * One answer has one spoken entry. `voiceOwners` is keyed by (sessionId, turnId). In an
 * answer-bearing round the answer line never claims: `assistant_say` accepts it and drops it, and
 * the reply outlet speaks (the purpose is normalized first, so an omitted purpose IS `answer`).
 * A standalone line (no reply outlet to defer to) still claims before it synthesizes, and a claim
 * that never sounded is released. Owners carry a generation, so a late clip of turn A can never
 * clear turn B's state. `spoken` is sticky across a round's standalone lines, and a tool takeover
 * of a typed claim aborts that claim's lane.
 *
 * Most scenarios drive the real mounted host (`apply` + `tools.assistant_say` + the session event
 * feed, including the mute action); the rest drive the exported relay/ownership seams directly so
 * the ownership map, generations and the interruption/supersede paths stay inspectable. No sound,
 * TTS, session or GUI is involved.
 *
 * Run: node --test test/typed-voice.mjs
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { Readable } from 'node:stream';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupRoot, disposeAll } from './helpers/cleanup.mjs';

const state = { synth: null, players: [], autoResolve: true, audioSeq: 0, stops: 0 };
globalThis.__typedVoice = state;

const ttsUrl = new URL('../src/host/speech/tts.js', import.meta.url).href;
const sightUrl = new URL('../src/host/vision/sight.js', import.meta.url).href;
const subtitleUrl = new URL('../src/host/subtitle/subtitle.js', import.meta.url).href;
const hooks = registerHooks({
  load(url, context, next) {
    if (url === ttsUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    const s = globalThis.__typedVoice;
    export { resolveGptLangs, resolveGptSovitsTimeout } from '${ttsUrl}?typed-voice-helpers';
    export const configureTts = () => {};
    export const gptSovitsReferenceStatus = async () => ({ seconds: null, ok: false, readable: false });
    export const warmupGptSovits = async () => ({ ok: false, skipped: 'disabled' });
    export const applyGptSovitsModels = () => ({ ok: true });
    export const synthesize = (options) => s.synth(options);
    export const speakStreaming = async () => { throw new Error('streaming not expected'); };
    export const stopPlayback = () => { s.stops++; return true; };
    export const stopTts = () => { s.stops++; return true; };
    export const play = (file, options) => {
      let resolve;
      const done = new Promise((doneResolve) => { resolve = doneResolve; });
      s.players.push({ file, ...options, resolve });
      if (s.autoResolve) resolve();
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
const { apply, createTypedVoiceRelay, claimVoiceTurnForTool } = await import('../src/host/index.js');
hooks.deregister();
after(() => { delete globalThis.__typedVoice; });

// ---------------------------------------------------------------------------
// Shared event shapes and polling helpers
// ---------------------------------------------------------------------------

const startEvent = (turn) => ({ type: 'turn/start', data: { turn } });
const endEvent = (turn, kind = 'completed') => ({ type: 'turn/end', data: { turn, reason: { kind } } });
const userEvent = (turn, id, text = '这是用户的问题') => ({
  type: 'user/message',
  data: { turn, id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
});
/** A delegated child's completion relayed into the parent: `agent-message` / `subagent-settled`. */
const resultEvent = (turn, senderSessionId, kind = 'agent-message', text = '', extra = {}) => ({
  type: 'user/message',
  data: {
    turn,
    id: extra.id ?? `result-${turn}-${kind}-${senderSessionId}`,
    role: 'user',
    source: {
      kind,
      form: kind === 'agent-message' ? 'relay' : 'notice',
      senderSessionId,
      // Only a feed that really names a task/run id gets one; today's persisted feed does not.
      ...(typeof extra.taskId === 'string' ? { taskId: extra.taskId } : {}),
    },
    content: [{ type: 'text', text }],
  },
});
const assistantEvent = (turn, text, { step = 1, content = null } = {}) => ({
  type: 'assistant/message',
  data: {
    turn,
    step,
    message: { id: `a-${turn}-${step}`, role: 'assistant', content: content ?? [{ type: 'text', text }] },
  },
});

const readEvents = async (root) => {
  try {
    const text = await readFile(join(root, 'data', 'events.jsonl'), 'utf8');
    return text.trim().split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
};

const waitUntil = async (check, message, timeoutMs = 3000) => {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out: ${message}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
};

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

// ---------------------------------------------------------------------------
// Mounted host fixture: real apply(), real tool, synthetic session event feed
// ---------------------------------------------------------------------------

async function mount(t, { typedReply } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-typed-voice-'));
  await mkdir(join(root, 'data'), { recursive: true });
  // Hearing/ambient off: the fixture must not open a device or start ASR.
  await writeFile(join(root, 'data', 'features.json'), JSON.stringify({ hearing: false, ambient: false }));
  state.players = [];
  state.autoResolve = true;
  state.audioSeq = 0;
  state.synth = async ({ text }) => ({
    file: join(root, 'tts', `${++state.audioSeq}.mp3`),
    bytes: 16,
    durationMs: 200,
    provider: 'edge-tts',
    text,
  });
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
  }, { root, enabled: true, ...(typedReply === undefined ? {} : { typedReply }) });

  const workspace = join(root, 'workspace');
  const session = { id: 'typed-voice-session', header: { cwd: workspace } };
  const emit = (target, event) => {
    for (const entry of [...handlers]) {
      if (entry.type === 'session/event') entry.handler(target, event);
    }
  };
  const events = () => readEvents(root);
  const waitForEvent = async (type, predicate = () => true) => {
    const started = Date.now();
    for (;;) {
      const row = (await events()).find((event) => event.type === type && predicate(event.payload ?? {}));
      if (row !== undefined) return row.payload ?? {};
      if (Date.now() - started > 3000) throw new Error(`timed out waiting for ${type}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const driveTypedTurn = (target, turn, text, requestId = `u-${turn}`) => {
    emit(target, startEvent(turn));
    emit(target, userEvent(turn, requestId));
    emit(target, assistantEvent(turn, text));
    emit(target, endEvent(turn));
  };
  t.after(async () => {
    for (const player of state.players) player.resolve();
    await disposeAll(cleanups.splice(0));
    await cleanupRoot(root);
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
  return {
    root,
    workspace,
    session,
    tools,
    routes,
    emit,
    events,
    waitForEvent,
    driveTypedTurn,
    action,
    players: () => state.players,
    say: (args, exec) => tools.get('assistant_say').execute(args, exec),
  };
}

// ---------------------------------------------------------------------------
// 1. A typed round with no tool speech is spoken once, at round end
// ---------------------------------------------------------------------------

test('typed round end speaks the final body once, with the sentence count', async (t) => {
  const app = await mount(t);
  app.driveTypedTurn(app.session, 3, '第一句。第二句。');
  const spoken = await app.waitForEvent('voice.typed.spoken');
  assert.equal(spoken.turn, 3);
  assert.equal(spoken.inputSource, 'typed');
  assert.equal(spoken.sentences, 2, 'two complete sentences');
  assert.equal(spoken.chars, 8, 'the whole body, punctuation included');
  const emitted = (await app.events()).filter((event) => event.type === 'voice.typed.spoken');
  assert.equal(emitted.length, 1, 'one answer, one spoken event');
  assert.equal(app.players().length, 2, 'the splitter played the two sentences');
  assert.ok(app.players().every((player) => player.file.endsWith('.mp3')));
});

// ---------------------------------------------------------------------------
// 2. An untagged tool line in a typed round IS the answer: skipped, no owner
//
// OLD CONTRACT (abolished): an untagged `assistant_say` claimed the round, played its own clip
// and made the typed trigger report `voice.typed.skipped {owner:'tool'}`. That is exactly the
// regression this build removes: the tool entry stole the official answer's voice. The purpose is
// normalized before routing (an omitted purpose IS `answer`), so the line is now skipped before
// any claim exists and the typed reply keeps its single outlet.
// ---------------------------------------------------------------------------

test('an untagged tool answer is skipped, so the typed reply keeps the round', async (t) => {
  const app = await mount(t);
  const { session } = app;
  app.emit(session, startEvent(2));
  app.emit(session, userEvent(2, 'u-2'));
  const first = await app.say({ text: '工具第一句。' }, { agent: { session } });
  const second = await app.say({ text: '工具第二句。' }, { agent: { session } });
  assert.equal(first.accepted, true, 'the call is accepted, never rejected');
  assert.equal(first.status, 'skipped', 'an omitted purpose is the answer: it never plays on its own');
  assert.equal(first.reason, 'answer-goes-through-reply');
  assert.equal(second.status, 'skipped', 'a second untagged line is still the same answer content');
  assert.equal(app.players().length, 0, 'the tool entry never opened a player');
  const skipped = await app.waitForEvent('voice.say.skipped', (payload) => payload.turn === 2);
  assert.equal(skipped.purpose, 'answer', 'an omitted purpose is normalized to answer');
  assert.equal(skipped.requestedPurpose, '', 'the event still shows that no tag was sent');
  assert.equal(
    (await app.events()).filter((event) => event.type === 'voice.say.skipped').length,
    2,
    'both untagged lines were logged as the answer',
  );

  app.emit(session, assistantEvent(2, '正文第一句。'));
  app.emit(session, endEvent(2));

  const spoken = await app.waitForEvent('voice.typed.spoken', (payload) => payload.turn === 2);
  assert.equal(spoken.sentences, 1);
  const rows = await app.events();
  assert.equal(rows.filter((event) => event.type === 'voice.typed.skipped').length, 0, 'the tool never claimed the round');
  assert.equal(rows.filter((event) => event.type === 'speech.spoken').length, 0, 'no say entry initiated playback');
  assert.equal(app.players().length, 1, 'the typed reply spoke the answer exactly once');
  t.diagnostic(
    `turn2 untagged says=2 skipped(reason=${first.reason}, purpose=${skipped.purpose}); `
    + `voice.typed.skipped=0; voice.typed.spoken=${spoken.sentences} sentence; player clips=1 (typed reply only)`,
  );
});

// ---------------------------------------------------------------------------
// 3. An answer line never claims: no failed claim to release, the reply speaks
//
// OLD CONTRACT (abolished): the untagged line successfully claimed the typed round first, so the
// only way the typed trigger could still speak was for that claim to be released by a synthesis
// failure. Under the normalized routing the line is skipped before synthesis, so there is nothing
// to claim and nothing to release; the reply outlet speaks. The release seam itself is still real
// for a standalone line, so it is asserted directly on the relay.
// ---------------------------------------------------------------------------

test('an answer line that never played neither claims nor blocks the typed trigger', async (t) => {
  const app = await mount(t);
  const okSynth = state.synth;
  const synthesized = [];
  state.synth = async (options) => {
    synthesized.push(options.text);
    if (options.text === '工具失败。') throw new Error('tts-down');
    return okSynth(options);
  };
  const { session } = app;
  app.emit(session, startEvent(4));
  app.emit(session, userEvent(4, 'u-4'));
  const skippedSay = await app.say({ text: '工具失败。' }, { agent: { session } });
  assert.equal(skippedSay.accepted, true, 'the call is accepted, never rejected');
  assert.equal(skippedSay.status, 'skipped', 'the answer line never reached synthesis, so no claim can fail');
  assert.equal(skippedSay.reason, 'answer-goes-through-reply');
  assert.equal(app.players().length, 0, 'nothing played and nothing was claimed');
  assert.deepEqual(synthesized, [], 'the tool text was never synthesized');

  app.emit(session, assistantEvent(4, '兜底正文。'));
  app.emit(session, endEvent(4));
  const spoken = await app.waitForEvent('voice.typed.spoken', (payload) => payload.turn === 4);
  assert.equal(spoken.sentences, 1);
  assert.equal(spoken.chars, 5);
  assert.equal(app.players().length, 1, 'the reply spoke exactly once');
  assert.equal((await app.events()).filter((event) => event.type === 'voice.typed.skipped').length, 0);

  // The release seam a standalone line still uses: a reservation that never sounded frees the
  // round, so the next entry can claim it (new generation, not the dead one).
  const { relay } = relayFixture();
  const claim = relay.claimTool({ sessionId: relaySession.id, turnId: 4 });
  assert.equal(claim.ok, true);
  const key = `${relaySession.id}\u00004`;
  assert.equal(relay.voiceOwners.has(key), true);
  relay.release(claim, { spoken: false });
  assert.equal(relay.voiceOwners.has(key), false, 'a line that never sounded releases the round');
  const again = relay.claimTool({ sessionId: relaySession.id, turnId: 4 });
  assert.equal(again.ok, true, 'the freed round can be claimed by the next entry');
  assert.notEqual(again.generation, claim.generation);

  // A typed-round synthesis failure is reported too, and plays nothing.
  state.synth = async (options) => {
    if (options.text === '连语音也失败。') throw new Error('typed-down');
    return okSynth(options);
  };
  app.driveTypedTurn(session, 10, '连语音也失败。');
  const typedFailure = await app.waitForEvent('voice.typed.failed', (payload) => payload.turn === 10);
  assert.match(typedFailure.error, /typed-down/);
  const rows = await app.events();
  assert.equal(rows.filter((event) => event.type === 'voice.typed.spoken' && event.payload.turn === 10).length, 0);
  assert.equal(app.players().length, 1, 'a failed typed synthesis played nothing');
  t.diagnostic(
    `turn4 say status=${skippedSay.status}; synthesized tool text=0; voice.typed.spoken=1; `
    + `release seam: present=false then claim again gen=${again.generation}`,
  );
});

// ---------------------------------------------------------------------------
// 4. A turn registered as a voice delivery is never a typed round
// ---------------------------------------------------------------------------

function relayFixture({
  setting = () => true, inScope = () => true, prepareRoundText = null,
  now = () => 1, autoResolve = false,
} = {}) {
  const events = [];
  const plays = [];
  const synth = [];
  const controller = new AbortController();
  const relay = createTypedVoiceRelay({
    emit: async (type, payload) => { events.push({ type, payload }); },
    prepareRoundText,
    synthesize: async ({ text }) => {
      synth.push(text);
      return { file: `${text}.mp3`, bytes: 8, durationMs: 50 };
    },
    play: ({ text, signal }) => {
      const player = { text, signal, aborted: false, end: null };
      const done = new Promise((resolve) => { player.end = resolve; });
      signal?.addEventListener?.('abort', () => { player.aborted = true; player.end(); }, { once: true });
      plays.push(player);
      if (autoResolve) player.end();
      return { audioStartedAt: 1, done };
    },
    speakWhole: null,
    captureSignal: () => controller.signal,
    setting,
    inScope,
    now,
  });
  return { relay, events, plays, synth, controller };
}

const relaySession = { id: 'relay-session', header: { cwd: 'C:\\workspace' } };

function driveRelayTurn(relay, turn, text, requestId = `u-${turn}`) {
  relay.observe(relaySession, startEvent(turn));
  relay.observe(relaySession, userEvent(turn, requestId));
  relay.observe(relaySession, assistantEvent(turn, text));
  return relay.observe(relaySession, endEvent(turn));
}

test('a voice-delivered request never triggers typed round-end speech', async () => {
  const { relay, events, plays } = relayFixture();
  relay.noteDelivery({ requestId: 'voice-request-1', inputSource: 'voice', sessionId: relaySession.id });
  driveRelayTurn(relay, 1, '语音轮正文。', 'voice-request-1');
  await relay.whenIdle();
  assert.equal(plays.length, 0, 'the voice lane owns its own playback');
  assert.equal(events.filter((event) => event.type.startsWith('voice.typed.')).length, 0);
  assert.equal(relay.voiceOwners.size, 0);

  // The contrast: the very same feed with an unregistered message id is a typed round.
  driveRelayTurn(relay, 2, '打字轮正文。', 'typed-request-1');
  await waitUntil(() => plays.length === 1, 'typed round started playing');
  plays[0].end();
  await relay.whenIdle();
  const spoken = events.filter((event) => event.type === 'voice.typed.spoken');
  assert.equal(spoken.length, 1);
  assert.equal(spoken[0].payload.turn, 2);
  assert.equal(spoken[0].payload.inputSource, 'typed');

  // Ownership matrix: the voice lane wins over the tool, the tool wins over the typed trigger.
  const guard = relayFixture();
  assert.equal(guard.relay.claimVoice({ sessionId: relaySession.id, turnId: 1 }), true);
  const refused = guard.relay.claimTool({ sessionId: relaySession.id, turnId: 1 });
  assert.equal(refused.ok, false, 'the tool skips a round the voice lane already speaks');
  assert.equal(refused.owner, 'voice');
  const reverse = relayFixture();
  assert.equal(reverse.relay.claimTool({ sessionId: relaySession.id, turnId: 1 }).ok, true);
  assert.equal(reverse.relay.claimVoice({ sessionId: relaySession.id, turnId: 1 }), false);
});

// ---------------------------------------------------------------------------
// 5. A multi-step round fires exactly once (tool commentary is not the answer)
// ---------------------------------------------------------------------------

test('a multi-step round speaks only its final body, exactly once', async (t) => {
  const app = await mount(t);
  const { session } = app;
  app.emit(session, startEvent(9));
  app.emit(session, userEvent(9, 'u-9'));
  // Step 1 is pre-tool commentary committed together with the tool call: never the reply body.
  app.emit(session, assistantEvent(9, '', {
    step: 1,
    content: [
      { type: 'text', text: '我先查一下。' },
      { type: 'tool-call', id: 'call-1', name: 'assistant_recall', args: {} },
    ],
  }));
  app.emit(session, { type: 'tool/call', data: { turn: 9, name: 'assistant_recall' } });
  app.emit(session, { type: 'tool/result', data: { turn: 9, name: 'assistant_recall' } });
  // Step 2 is the committed final answer.
  app.emit(session, assistantEvent(9, '查到了。', { step: 2 }));
  app.emit(session, endEvent(9));

  const spoken = await app.waitForEvent('voice.typed.spoken', (payload) => payload.turn === 9);
  assert.equal(spoken.sentences, 1, 'only the post-tool body became a sentence');
  assert.equal(spoken.chars, 4);
  const rows = await app.events();
  assert.equal(rows.filter((event) => event.type === 'voice.typed.spoken').length, 1);
  assert.equal(app.players().length, 1, 'the pre-tool commentary was never played');
});

// ---------------------------------------------------------------------------
// 6. typedReply.voice=false: silent, while memory recording still works
// ---------------------------------------------------------------------------

test('typedReply.voice=false keeps the round silent without touching memory', async (t) => {
  const app = await mount(t, { typedReply: { voice: false } });
  app.driveTypedTurn(app.session, 5, '不该出声。');
  const assistantRecord = await app.waitForEvent('memory.auto', (payload) => payload.role === 'assistant');
  assert.equal(assistantRecord.records, 1, 'the assistant reply still landed in memory');
  const rows = await app.events();
  assert.ok(rows.some((event) => event.type === 'memory.auto' && event.payload.role === 'user'));
  assert.equal(rows.filter((event) => event.type.startsWith('voice.typed.')).length, 0);
  assert.equal(app.players().length, 0, 'the setting turned the round-end speaker off');
});

// ---------------------------------------------------------------------------
// 7. Out-of-scope session: silent
// ---------------------------------------------------------------------------

test('a session outside the workspace scope is not spoken', async (t) => {
  const app = await mount(t);
  const outside = { id: 'outside-session', header: { cwd: join(app.root, 'elsewhere') } };
  app.driveTypedTurn(outside, 6, '作用域外正文。');
  await app.waitForEvent('memory.auto.skipped', (payload) => payload.reason === 'out-of-scope');
  await new Promise((resolve) => setTimeout(resolve, 80));
  const rows = await app.events();
  assert.equal(rows.filter((event) => event.type.startsWith('voice.typed.')).length, 0);
  assert.equal(app.players().length, 0);
});

// ---------------------------------------------------------------------------
// 8. Old-round callbacks cannot touch the new round's owner (generation check)
// ---------------------------------------------------------------------------

test('a stale generation cannot modify a newer turn owner', async (t) => {
  const { relay, events, plays } = relayFixture();
  driveRelayTurn(relay, 5, '旧轮正文。');
  await waitUntil(() => plays.length === 1, 'turn A started playing');
  const keyA = `${relaySession.id}\u00005`;
  const keyB = `${relaySession.id}\u00006`;
  const entryA = relay.voiceOwners.get(keyA);
  assert.equal(entryA.owner, 'typed');

  // Turn B begins while A is still speaking: a different round, a different owner.
  driveRelayTurn(relay, 6, '新轮正文。');
  await waitUntil(() => plays.length === 2, 'turn B started playing');
  const entryB = relay.voiceOwners.get(keyB);
  assert.equal(entryB.owner, 'typed');
  assert.notEqual(entryB.generation, entryA.generation, 'each claim carries its own generation');

  // A stale callback for B's key (A's generation) is rejected and must not clear B.
  assert.equal(relay.release({ sessionId: relaySession.id, turnId: 6, generation: entryA.generation }), false);
  assert.equal(relay.settle({ sessionId: relaySession.id, turnId: 6, generation: entryA.generation }), false);
  assert.equal(relay.voiceOwners.get(keyB).owner, 'typed');
  assert.equal(relay.voiceOwners.get(keyB).generation, entryB.generation);

  // A's own callback still removes A (generation matches), and B keeps playing untouched.
  plays[0].end();
  await waitUntil(
    () => events.some((event) => event.type === 'voice.typed.spoken' && event.payload.turn === 5),
    'turn A finished',
  );
  assert.equal(relay.voiceOwners.has(keyA), false, 'the finished round released its own owner');
  assert.equal(relay.voiceOwners.has(keyB), true, 'turn A did not clear turn B');
  assert.equal(relay.voiceOwners.get(keyB).generation, entryB.generation);

  plays[1].end();
  await relay.whenIdle();
  assert.equal(relay.voiceOwners.size, 0);
  assert.equal(events.filter((event) => event.type === 'voice.typed.spoken').length, 2);
  t.diagnostic(
    `turn5 gen=${entryA.generation}; turn6 gen=${entryB.generation}; stale release/settle(turn6, gen5)=false; `
    + 'turn5 finish deleted only turn5; turn6 owner untouched until its own clip ended',
  );
});

// ---------------------------------------------------------------------------
// 9. Interruption during round-end playback stops it and clears the owner
// ---------------------------------------------------------------------------

test('interrupting the round-end playback stops the clip, clears the owner and leaves no timer', async () => {
  const { relay, events, plays, controller } = relayFixture();
  driveRelayTurn(relay, 7, '被打断的正文。');
  await waitUntil(() => plays.length === 1, 'playback started');

  const originalSetTimeout = globalThis.setTimeout;
  const originalSetInterval = globalThis.setInterval;
  let timers = 0;
  globalThis.setTimeout = (...args) => { timers += 1; return originalSetTimeout(...args); };
  globalThis.setInterval = (...args) => { timers += 1; return originalSetInterval(...args); };
  try {
    controller.abort(); // microphone barge-in / mute path aborts the captured speech signal
    await relay.whenIdle();
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.setInterval = originalSetInterval;
  }
  assert.equal(plays[0].aborted, true, 'the clip was stopped');
  assert.equal(relay.voiceOwners.size, 0, 'the owner was cleaned up');
  assert.equal(timers, 0, 'no residual timer was scheduled by the speech path');
  assert.ok(events.some((event) => event.type === 'voice.typed.skipped' && event.payload.owner === 'interrupted'));
  assert.equal(events.filter((event) => event.type === 'voice.typed.spoken').length, 0);
});

// ---------------------------------------------------------------------------
// 10. Repeated answer lines never accumulate a claim on the typed round
//
// OLD CONTRACT (abolished): the first untagged line claimed the round and played, and the second
// line's failed synthesis had to keep that claim alive so the typed trigger stayed silent. Both
// halves describe the removed "tool owns the typed answer" routing: an untagged line is the
// answer, is skipped before synthesis, and leaves no owner for a later failure to protect. What
// still holds is the seam rule below: once a standalone entry has really sounded, a later failed
// line cannot free it — asserted on the relay, where that path is still reachable.
// ---------------------------------------------------------------------------

test('a failed second tool line cannot free a round that already spoke', async (t) => {
  const app = await mount(t);
  const okSynth = state.synth;
  const synthesized = [];
  state.synth = async (options) => {
    synthesized.push(options.text);
    if (options.text === '工具第二次失败。') throw new Error('tts-down-again');
    return okSynth(options);
  };
  const { session } = app;
  app.emit(session, startEvent(21));
  app.emit(session, userEvent(21, 'u-21'));

  const first = await app.say({ text: '工具第一次成功。' }, { agent: { session } });
  assert.equal(first.accepted, true, 'the first line is accepted');
  assert.equal(first.status, 'skipped', 'the first untagged line is the answer, not an outlet');
  const second = await app.say({ text: '工具第二次失败。' }, { agent: { session } });
  assert.equal(second.accepted, true, 'the second line is accepted as well');
  assert.equal(second.status, 'skipped');
  assert.equal(app.players().length, 0, 'neither answer line produced a clip');
  assert.deepEqual(synthesized, [], 'no answer line reached the TTS seam');

  app.emit(session, assistantEvent(21, '正文从此处开始播。'));
  app.emit(session, endEvent(21));
  const spoken = await app.waitForEvent('voice.typed.spoken', (payload) => payload.turn === 21);
  assert.equal(spoken.sentences, 1, 'the typed reply kept its single outlet');
  const rows = await app.events();
  assert.equal(rows.filter((event) => event.type === 'voice.typed.skipped').length, 0);
  assert.equal(app.players().length, 1, 'one answer, one clip');

  // Seam: a standalone entry that sounded keeps the round even when a later line fails.
  const { relay } = relayFixture();
  const claimA = relay.claimTool({ sessionId: relaySession.id, turnId: 21 });
  claimA.spoken = true;
  relay.watchToolPlayback(claimA, Promise.resolve());
  await relay.whenIdle();
  const claimB = relay.claimTool({ sessionId: relaySession.id, turnId: 21 });
  relay.release(claimB, { spoken: false });
  const after = ownerState(relay, 21);
  assert.equal(after.present, true, 'the spoken owner survives the later failure');
  assert.equal(after.spoken, true);
  assert.equal(after.pending, 0);

  t.diagnostic(
    `turn21 untagged says=2 both skipped; synthesized tool text=0; voice.typed.spoken=${spoken.sentences}; `
    + `player clips=1; after late release: ${describeState(after)}`,
  );
});

// ---------------------------------------------------------------------------
// 11. A tool takeover during typed synthesis supersedes the stale audio
// ---------------------------------------------------------------------------

test('a tool takeover while typing synthesizes never plays the old clip', async (t) => {
  const app = await mount(t);
  const entered = deferred();
  const gate = deferred();
  const cacheDir = join(app.root, 'cache', 'tts');
  state.synth = async (options) => {
    if (options.text === '打字旧正文。') {
      entered.resolve();
      await gate.promise;
      return { file: join(cacheDir, 'stale-typed.mp3'), bytes: 8, durationMs: 100, provider: 'edge-tts', text: options.text };
    }
    return { file: join(cacheDir, 'tool-line.mp3'), bytes: 8, durationMs: 100, provider: 'edge-tts', text: options.text };
  };
  const { session } = app;
  app.driveTypedTurn(session, 22, '打字旧正文。');
  await entered.promise;

  const tool = await app.say({ text: '工具接管。' }, { agent: { session } });
  assert.equal(tool.accepted, true, 'the tool takes the round; the clip plays in the background');
  gate.resolve(); // the superseded typed synthesis finishes after the takeover

  const superseded = await app.waitForEvent('voice.typed.superseded', (payload) => payload.turn === 22);
  assert.equal(superseded.owner, 'tool');
  assert.equal(superseded.previous, 'typed');
  await app.waitForEvent('speech.finish', (payload) => payload.speechId === tool.speechId);
  await new Promise((resolve) => setTimeout(resolve, 60));

  const files = app.players().map((player) => player.file);
  assert.equal(files.length, 1, 'the typed clip never started; only the tool clip played');
  assert.ok(files[0].endsWith('tool-line.mp3'));
  const rows = await app.events();
  assert.equal(rows.filter((event) => event.type === 'voice.typed.spoken').length, 0);
  t.diagnostic(
    `turn22 superseded=${superseded.owner}; typed players=0; total players=${files.length}; `
    + `file=${files[0].split(/[\\/]/u).pop()}`,
  );
});

// ---------------------------------------------------------------------------
// 12. `turn/end` with a stopped reason never speaks the collected body
// ---------------------------------------------------------------------------

test('an aborted turn end never triggers typed speech', async (t) => {
  const app = await mount(t);
  const { session } = app;
  app.emit(session, startEvent(23));
  app.emit(session, userEvent(23, 'u-23'));
  app.emit(session, assistantEvent(23, '已经收集到但不该播。'));
  app.emit(session, { type: 'turn/end', data: { turn: 23, reason: { kind: 'aborted' } } });

  const skipped = await app.waitForEvent('voice.typed.skipped', (payload) => payload.turn === 23);
  assert.equal(skipped.reason, 'aborted');
  assert.equal(app.players().length, 0, 'a cancelled round has no answer to speak');
  const rows = await app.events();
  assert.equal(rows.filter((event) => event.type === 'voice.typed.spoken').length, 0);
  t.diagnostic(`turn23 skipped.reason=${skipped.reason}; players=0; voice.typed.spoken=0`);
});

// ---------------------------------------------------------------------------
// 13. Mute then unmute during the round: the old turn cannot be revived
// ---------------------------------------------------------------------------

test('mute then unmute during a turn leaves the old round silent', async (t) => {
  const app = await mount(t);
  const { session } = app;
  app.emit(session, startEvent(24));
  app.emit(session, userEvent(24, 'u-24'));
  app.emit(session, assistantEvent(24, '静音期间生成的正文。'));
  // The turn captured the signal that was live at `turn/start`; muting aborts exactly that
  // signal and installs a fresh one. Unmuting must not hand the old round the fresh signal.
  assert.equal((await app.action({ action: 'voice.mute', muted: true })).ok, true);
  assert.equal((await app.action({ action: 'voice.mute', muted: false })).ok, true);
  app.emit(session, endEvent(24));

  const skipped = await app.waitForEvent('voice.typed.skipped', (payload) => payload.turn === 24);
  assert.equal(skipped.owner, 'muted');
  assert.equal(app.players().length, 0, 'the old round stayed silent after unmute');
  const rows = await app.events();
  assert.equal(rows.filter((event) => event.type === 'voice.typed.spoken').length, 0);
  t.diagnostic(`turn24 skipped.owner=${skipped.owner}; players=0 (captured identity was aborted by mute)`);
});

// ---------------------------------------------------------------------------
// 14. A tool call in another session never claims this turn's voice owner
// ---------------------------------------------------------------------------

test('assistant_say from another session does not claim the active voice turn', () => {
  let claims = 0;
  const active = {
    sessionId: 'voice-session',
    turnId: 31,
    owner: 'auto',
    claimTool() {
      claims += 1;
      this.owner = 'tool';
      return true;
    },
  };
  // This is the exact decision `assistant_say` makes around its playback block.
  const foreign = claimVoiceTurnForTool(active, { sessionId: 'other-session', turnId: 31 });
  assert.equal(foreign.claimed, false);
  assert.equal(foreign.reason, 'foreign-session');
  assert.equal(claims, 0, 'claimTool was not called for the other session');
  assert.equal(active.owner, 'auto', 'the active turn owner is unchanged');

  const nextTurn = claimVoiceTurnForTool(active, { sessionId: 'voice-session', turnId: 32 });
  assert.equal(nextTurn.claimed, false);
  assert.equal(nextTurn.reason, 'foreign-turn');
  assert.equal(claims, 0, 'a different round of the same session is not this turn');

  const own = claimVoiceTurnForTool(active, { sessionId: 'voice-session', turnId: 31 });
  assert.equal(own.claimed, true, 'the matching round still claims normally');
  assert.equal(claims, 1);
  assert.equal(active.owner, 'tool');
  assert.equal(claimVoiceTurnForTool(null, { sessionId: 'x', turnId: 1 }).reason, 'no-active-turn');
});

// ---------------------------------------------------------------------------
// 15. Regression: an ordinary typed round still speaks exactly once
// ---------------------------------------------------------------------------

test('regression: an ordinary typed round still speaks exactly once', async (t) => {
  const app = await mount(t);
  app.driveTypedTurn(app.session, 25, '回归正文。');
  const spoken = await app.waitForEvent('voice.typed.spoken', (payload) => payload.turn === 25);
  assert.equal(spoken.inputSource, 'typed');
  assert.equal(app.players().length, 1, 'one sentence, one clip');
  const rows = await app.events();
  assert.equal(rows.filter((event) => event.type === 'voice.typed.spoken').length, 1);
  t.diagnostic(`turn25 voice.typed.spoken=1; players=${app.players().length}`);
});

// ---------------------------------------------------------------------------
// 16. Concurrent claimed lines: release frees only its own reservation
//
// OLD CONTRACT (abolished): two untagged `assistant_say` calls in a typed round claimed the round
// before synthesis and the typed trigger had to skip. That routing is gone (an untagged line is
// the answer and never synthesizes in an answer-bearing round), so the mounted half now asserts
// the routing and the claim arithmetic is exercised at the seam where it is still reachable.
// ---------------------------------------------------------------------------

/** The ownership entry `assistant_say` would see for this test's turn, or null. */
const ownerState = (relay, turnId) => {
  const entry = relay.voiceOwners.get(`${relaySession.id}\u0000${turnId}`);
  if (entry === undefined) return { present: false, pending: 0, spoken: false, owner: null };
  return { present: true, pending: entry.pending, spoken: entry.spoken === true, owner: entry.owner };
};
const describeState = (state) => `present=${state.present} pending=${state.pending} `
  + `spoken=${state.spoken} owner=${state.owner ?? 'none'}`;

test('concurrent tool claims: the first failed line must not free the round', async (t) => {
  const app = await mount(t);
  const okSynth = state.synth;
  const synthesized = [];
  state.synth = async (options) => {
    synthesized.push(options.text);
    if (options.text === '并发第一条失败。') throw new Error('first-line-down');
    return okSynth(options);
  };
  const { session } = app;
  app.emit(session, startEvent(30));
  app.emit(session, userEvent(30, 'u-30'));

  // Both untagged calls are answer lines: accepted, skipped, never synthesized or claimed.
  const first = await app.say({ text: '并发第一条失败。' }, { agent: { session } });
  const second = await app.say({ text: '并发第二条成功。' }, { agent: { session } });
  assert.equal(first.accepted, true, 'the first line was accepted');
  assert.equal(second.accepted, true, 'the second line was accepted');
  assert.equal(first.status, 'skipped');
  assert.equal(second.status, 'skipped');
  assert.deepEqual(synthesized, [], 'neither answer line reached the TTS seam');
  assert.equal(app.players().length, 0);

  app.emit(session, assistantEvent(30, '并发轮正文。'));
  app.emit(session, endEvent(30));
  const spoken = await app.waitForEvent('voice.typed.spoken', (payload) => payload.turn === 30);
  assert.equal(spoken.sentences, 1);
  const rows = await app.events();
  assert.equal(rows.filter((event) => event.type === 'voice.typed.skipped').length, 0);
  assert.equal(app.players().length, 1, 'the round end spoke the body once');

  // Ownership arithmetic on the relay seam: the reservation semantics the claim still uses.
  const { relay } = relayFixture();
  const claimA = relay.claimTool({ sessionId: relaySession.id, turnId: 30 });
  const claimB = relay.claimTool({ sessionId: relaySession.id, turnId: 30 });
  assert.equal(relay.voiceOwners.get(`${relaySession.id}\u000030`).pending, 2, 'two live reservations');
  relay.release(claimA, { spoken: false }); // first synthesis failed
  const afterFailure = ownerState(relay, 30);
  assert.equal(afterFailure.present, true, 'the owner survives while the sibling synthesizes');
  assert.equal(afterFailure.pending, 1);
  assert.equal(afterFailure.spoken, false);
  claimB.spoken = true; // the second line really played
  relay.watchToolPlayback(claimB, Promise.resolve());
  await relay.whenIdle();
  const afterPlay = ownerState(relay, 30);
  assert.equal(afterPlay.present, true);
  assert.equal(afterPlay.pending, 0);
  assert.equal(afterPlay.spoken, true);

  t.diagnostic(`turn30 player clips=${app.players().length}; voice.typed.spoken=${spoken.sentences}; `
    + `synthesized tool text=0; after first release: ${describeState(afterFailure)}; `
    + `after second play: ${describeState(afterPlay)}`);
});

// ---------------------------------------------------------------------------
// 17. Both concurrent claimed lines fail: the owner is freed, the round end speaks
//
// OLD CONTRACT (abolished): the two untagged lines claimed the typed round, both failed, the
// owner was freed and only then could the typed trigger speak. The routing half is gone (they are
// skipped answer lines now); the pending arithmetic that decides when a failed reservation frees
// the round is still live on the seam, so it is asserted there.
// ---------------------------------------------------------------------------

test('concurrent tool claims: the owner is freed only after both lines failed', async (t) => {
  const app = await mount(t);
  const okSynth = state.synth;
  const synthesized = [];
  state.synth = async (options) => {
    synthesized.push(options.text);
    if (options.text === '都失败第一条。') throw new Error('both-down-first');
    if (options.text === '都失败第二条。') throw new Error('both-down-second');
    return okSynth(options);
  };
  const { session } = app;
  app.emit(session, startEvent(31));
  app.emit(session, userEvent(31, 'u-31'));

  const first = await app.say({ text: '都失败第一条。' }, { agent: { session } });
  const second = await app.say({ text: '都失败第二条。' }, { agent: { session } });
  assert.equal(first.accepted, true, 'the first line was accepted');
  assert.equal(second.accepted, true, 'the second line was accepted');
  assert.equal(first.status, 'skipped');
  assert.equal(second.status, 'skipped');
  assert.deepEqual(synthesized, [], 'no answer line was synthesized, so no reservation could fail');
  assert.equal(app.players().length, 0);

  app.emit(session, assistantEvent(31, '两条都失败后的正文。'));
  app.emit(session, endEvent(31));
  const spoken = await app.waitForEvent('voice.typed.spoken', (payload) => payload.turn === 31);
  assert.equal(spoken.sentences, 1);
  assert.equal(app.players().length, 1, 'the round end spoke the body exactly once');

  const { relay } = relayFixture();
  const claimA = relay.claimTool({ sessionId: relaySession.id, turnId: 31 });
  const claimB = relay.claimTool({ sessionId: relaySession.id, turnId: 31 });
  relay.release(claimA, { spoken: false });
  const afterFirst = ownerState(relay, 31);
  assert.equal(afterFirst.present, true, 'one sibling is still synthesizing');
  assert.equal(afterFirst.pending, 1);
  relay.release(claimB, { spoken: false });
  const afterSecond = ownerState(relay, 31);
  assert.equal(afterSecond.present, false, 'pending===0 and spoken===false frees the owner');
  assert.equal(relay.voiceOwners.size, 0);

  t.diagnostic(`turn31 player clips=${app.players().length}; voice.typed.spoken=${spoken.sentences} sentence; `
    + `synthesized tool text=0; after first release: ${describeState(afterFirst)}; `
    + `after second release: ${describeState(afterSecond)}`);
});

// ---------------------------------------------------------------------------
// 18. Success first, failure second: a spoken standalone claim keeps the owner
//
// OLD CONTRACT (abolished): the first untagged line claimed the round, played, and the typed
// trigger had to stay silent afterwards. In an answer-bearing typed round the tool can no longer
// claim at all, so the mounted half asserts the routing (both lines skipped, reply speaks); the
// "spoken keeps the owner" rule is still the contract for a standalone claim and is asserted on
// the seam.
// ---------------------------------------------------------------------------

test('concurrent tool claims: a later failure cannot erase an earlier success', async (t) => {
  const app = await mount(t);
  const okSynth = state.synth;
  const synthesized = [];
  state.synth = async (options) => {
    synthesized.push(options.text);
    if (options.text === '先成功再失败。') throw new Error('late-line-down');
    return okSynth(options);
  };
  const { session } = app;
  app.emit(session, startEvent(32));
  app.emit(session, userEvent(32, 'u-32'));

  const first = await app.say({ text: '先成功。' }, { agent: { session } });
  assert.equal(first.accepted, true, 'the first line is accepted');
  assert.equal(first.status, 'skipped', 'the answer line is not an outlet of its own');
  const second = await app.say({ text: '先成功再失败。' }, { agent: { session } });
  assert.equal(second.accepted, true, 'the later line is accepted as well');
  assert.equal(second.status, 'skipped');
  assert.deepEqual(synthesized, [], 'no answer line was synthesized');
  assert.equal(app.players().length, 0);

  app.emit(session, assistantEvent(32, '已经播过一次的正文。'));
  app.emit(session, endEvent(32));
  const spoken = await app.waitForEvent('voice.typed.spoken', (payload) => payload.turn === 32);
  assert.equal(spoken.sentences, 1);
  const rows = await app.events();
  assert.equal(rows.filter((event) => event.type === 'voice.typed.skipped').length, 0);
  assert.equal(app.players().length, 1, 'one answer, one clip');

  const { relay } = relayFixture();
  const claimA = relay.claimTool({ sessionId: relaySession.id, turnId: 32 });
  claimA.spoken = true;
  relay.watchToolPlayback(claimA, Promise.resolve());
  await relay.whenIdle();
  const claimB = relay.claimTool({ sessionId: relaySession.id, turnId: 32 });
  assert.equal(ownerState(relay, 32).pending, 1, 'the failed line added its own reservation');
  relay.release(claimB, { spoken: false });
  const after = ownerState(relay, 32);
  assert.equal(after.present, true, 'spoken===true keeps the owner even at pending===0');
  assert.equal(after.pending, 0);
  assert.equal(after.spoken, true);

  t.diagnostic(`turn32 player clips=${app.players().length}; voice.typed.spoken=${spoken.sentences}; `
    + `synthesized tool text=0; after late release: ${describeState(after)}`);
});

// ---------------------------------------------------------------------------
// 19. A single failed standalone claim still frees the round (no concurrency)
//
// OLD CONTRACT (abolished): the untagged line claimed the typed round, failed, freed it, and the
// typed trigger then spoke. In a typed round the line never claims; the single-reservation release
// is asserted on the seam, where a standalone claim still uses it.
// ---------------------------------------------------------------------------

test('single tool failure without concurrency still frees the round for the typed trigger', async (t) => {
  const app = await mount(t);
  const okSynth = state.synth;
  const synthesized = [];
  state.synth = async (options) => {
    synthesized.push(options.text);
    if (options.text === '单独失败。') throw new Error('single-down');
    return okSynth(options);
  };
  const { session } = app;
  app.emit(session, startEvent(33));
  app.emit(session, userEvent(33, 'u-33'));
  const skippedSay = await app.say({ text: '单独失败。' }, { agent: { session } });
  assert.equal(skippedSay.accepted, true, 'the line is accepted');
  assert.equal(skippedSay.status, 'skipped', 'no synthesis and therefore no failed claim');
  assert.deepEqual(synthesized, [], 'the tool text was never synthesized');
  assert.equal(app.players().length, 0, 'nothing was played');

  app.emit(session, assistantEvent(33, '单条失败后的正文。'));
  app.emit(session, endEvent(33));
  const spoken = await app.waitForEvent('voice.typed.spoken', (payload) => payload.turn === 33);
  assert.equal(spoken.sentences, 1);
  assert.equal(app.players().length, 1, 'the typed trigger spoke the body once');

  const { relay } = relayFixture();
  const claim = relay.claimTool({ sessionId: relaySession.id, turnId: 33 });
  const key = `${relaySession.id}\u000033`;
  const entry = relay.voiceOwners.get(key);
  relay.release(claim, { spoken: false });
  assert.equal(relay.voiceOwners.has(key), false, 'the only reservation released frees the owner');
  assert.equal(entry.pending, 0);
  assert.equal(entry.spoken, false);

  t.diagnostic(`turn33 player clips=${app.players().length}; voice.typed.spoken=${spoken.sentences} sentence; `
    + 'single release: present=false pending=0 spoken=false');
});

// ---------------------------------------------------------------------------
// 34. The typed round is condensed ONCE, from the whole body (not per sentence)
// ---------------------------------------------------------------------------
test('34. a typed round is condensed once from the whole body, not per sentence', async (t) => {
  const calls = [];
  const { relay, synth } = relayFixture({
    prepareRoundText: async (text, options) => {
      calls.push({ text, utterance: options?.utterance ?? '' });
      return { text: '结论：先备份再检查索引。' };
    },
  });
  const body = '先说结论：先备份再检查索引。具体来说，上午云量会逐渐增多。傍晚还有一阵较强的风。';
  relay.observe(relaySession, startEvent(1));
  relay.observe(relaySession, userEvent(1, 'u-34', '展开讲讲背景'));
  relay.observe(relaySession, assistantEvent(1, body));
  relay.observe(relaySession, endEvent(1));
  await waitUntil(() => synth.length >= 1, 'the condensed sentence reached synthesis');
  assert.equal(calls.length, 1, 'exactly one condense for the whole round');
  assert.equal(calls[0].text, body, 'the condense saw the complete body');
  assert.equal(synth[0], '结论：先备份再检查索引。', 'synthesis received the condensed text');
  assert.ok(!synth.some((line) => line.includes('傍晚')), 'the full body was not read sentence by sentence');
  t.diagnostic(`calls=${calls.length} utterance=${JSON.stringify(calls[0].utterance)} synth=${JSON.stringify(synth)}`);
});

// ---------------------------------------------------------------------------
// 35. "read it all" reaches the typed round through the user's own words
// ---------------------------------------------------------------------------
test('35. the typed round receives the user utterance so a full-read request is honoured', async (t) => {
  const seen = [];
  const { relay } = relayFixture({
    prepareRoundText: async (text, options) => {
      seen.push(options?.utterance ?? '');
      return { text };
    },
  });
  relay.observe(relaySession, startEvent(2));
  relay.observe(relaySession, userEvent(2, 'u-35', '详细讲一下这个结论'));
  relay.observe(relaySession, assistantEvent(2, '这是需要完整朗读的正文。'));
  relay.observe(relaySession, endEvent(2));
  await waitUntil(() => seen.length >= 1, 'the round received the user words');
  assert.deepEqual(seen, ['详细讲一下这个结论'], 'the round received the user words');
  t.diagnostic(`utterance=${JSON.stringify(seen)}`);
});

// ---------------------------------------------------------------------------
// 36. purpose:'explicit' in a typed round is a different task: both play
// ---------------------------------------------------------------------------

test('36. an explicit line in a typed round plays on its own and the reply still plays', async (t) => {
  const app = await mount(t);
  const { session } = app;
  app.emit(session, startEvent(40));
  app.emit(session, userEvent(40, 'u-40'));
  const said = await app.say({ text: '这是用户点播的一句独立的话。', purpose: 'explicit' }, { agent: { session } });
  assert.equal(said.accepted, true, 'the explicit line is accepted');
  assert.notEqual(said.status, 'skipped', 'explicit is not the answer and is never routed to the reply');
  await app.waitForEvent('speech.finish', (payload) => payload.speechId === said.speechId);
  assert.equal(app.players().length, 1, 'the explicit line sounded on its own');

  app.emit(session, assistantEvent(40, '正文照常播。'));
  app.emit(session, endEvent(40));
  const spoken = await app.waitForEvent('voice.typed.spoken', (payload) => payload.turn === 40);
  assert.equal(spoken.sentences, 1, 'the typed reply still spoke its own answer');
  assert.equal(app.players().length, 2, 'explicit clip + typed reply clip, two task identities');
  const rows = await app.events();
  assert.notEqual(app.players()[0].file, app.players()[1].file, 'the two clips are different audio');
  assert.equal(rows.filter((event) => event.type === 'voice.say.skipped').length, 0, 'nothing was routed away');
  assert.equal(rows.filter((event) => event.type === 'voice.typed.skipped').length, 0);
  const saySpoken = rows.filter((event) => event.type === 'speech.spoken');
  assert.equal(saySpoken.length, 1, 'the say task reported its own spoken clip');
  assert.equal(saySpoken[0].payload.speechId, said.speechId, 'the say task keeps its own identity');
  t.diagnostic(
    `turn40 explicit status=${said.status} speechId=${said.speechId}; voice.typed.spoken=${spoken.sentences}; `
    + `total clips=2 (say + typed reply); voice.say.skipped=0`,
  );
});

// ---------------------------------------------------------------------------
// 37. progress / ack in a typed round never touch the answer's voice
// ---------------------------------------------------------------------------

test('37. a progress or ack line in a typed round plays and the reply still plays', async (t) => {
  const app = await mount(t);
  const { session } = app;
  // Turn 41: a progress cue first, then the answer.
  app.emit(session, startEvent(41));
  app.emit(session, userEvent(41, 'u-41'));
  const progress = await app.say({ text: '我这就去查一下，稍等。', purpose: 'progress' }, { agent: { session } });
  assert.equal(progress.accepted, true);
  assert.notEqual(progress.status, 'skipped');
  const progressEvent = await app.waitForEvent('voice.say.progress', (payload) => payload.turn === 41);
  assert.ok(progressEvent.chars > 0);
  await app.waitForEvent('speech.finish', (payload) => payload.speechId === progress.speechId);
  app.emit(session, assistantEvent(41, '查到了。'));
  app.emit(session, endEvent(41));
  const spoken = await app.waitForEvent('voice.typed.spoken', (payload) => payload.turn === 41);
  assert.equal(spoken.sentences, 1, 'the answer played after the progress cue');
  assert.equal(app.players().length, 2, 'progress clip + reply clip');

  // Turn 42: the same for an ack cue.
  app.emit(session, startEvent(42));
  app.emit(session, userEvent(42, 'u-42'));
  const ack = await app.say({ text: '收到，马上办。', purpose: 'ack' }, { agent: { session } });
  assert.equal(ack.accepted, true);
  await app.waitForEvent('speech.finish', (payload) => payload.speechId === ack.speechId);
  app.emit(session, assistantEvent(42, '办好了。'));
  app.emit(session, endEvent(42));
  const ackSpoken = await app.waitForEvent('voice.typed.spoken', (payload) => payload.turn === 42);
  assert.equal(ackSpoken.sentences, 1);
  assert.equal(app.players().length, 4, 'ack clip + reply clip on top of the first turn');

  const rows = await app.events();
  assert.equal(rows.filter((event) => event.type === 'voice.say.skipped').length, 0, 'cues are never answer-routed');
  assert.equal(rows.filter((event) => event.type === 'voice.typed.skipped').length, 0);
  const cues = rows.filter((event) => event.type === 'voice.say.progress');
  assert.equal(cues.length, 2, 'one cue event for the progress line and one for the ack');
  assert.deepEqual(cues.map((event) => event.payload.turn).sort(), [41, 42]);
  t.diagnostic(
    `turn41 progress chars=${progressEvent.chars} + reply=${spoken.sentences}; `
    + `turn42 ack + reply=${ackSpoken.sentences}; total clips=${app.players().length}; say=skipped 0`,
  );
});

// ---------------------------------------------------------------------------
// 38. A delegated result relayed as `agent-message` is its own voice lane
//
// The parent receives the child's completion as a `user/message` whose source is
// `agent-message` (or `subagent-settled`), not a genuine user message. Without the result lane the
// source stayed 'unknown', `handleEnd` returned silently, and the generated body never reached the
// one voice outlet. The body is the reply, never the tool's raw output. Acceptance, first sound and
// completion are three separate facts, and the reply body still enters automatic memory.
// ---------------------------------------------------------------------------

test('38. an agent-message result turn is spoken once through the reply outlet', async (t) => {
  const app = await mount(t);
  const baseSynth = state.synth;
  const synthesized = [];
  state.synth = async (options) => {
    synthesized.push(options.text);
    return baseSynth(options);
  };
  const { session } = app;
  app.emit(session, startEvent(50));
  app.emit(session, resultEvent(50, 'child-session-a', 'agent-message', '子代理完成，请转告用户。'));
  // The raw tool output travels through the session feed too, and must never become speech.
  app.emit(session, { type: 'tool/result', data: { turn: 50, name: 'assistant_recall', output: 'RAW_TOOL_OUTPUT_SHOULD_NOT_SPEAK' } });
  app.emit(session, assistantEvent(50, '结果正文。'));
  app.emit(session, endEvent(50));

  const accepted = await app.waitForEvent('voice.result.accepted', (payload) => payload.turn === 50);
  assert.equal(accepted.senderSessionId, 'child-session-a');
  assert.equal(accepted.kind, 'agent-message');
  const started = await app.waitForEvent('voice.result.audio.started', (payload) => payload.turn === 50);
  assert.equal(started.taskId, accepted.taskId, 'first sound belongs to the accepted task');
  const completed = await app.waitForEvent('voice.result.completed', (payload) => payload.turn === 50);
  assert.equal(completed.sentences, 1, 'the result body is one sentence');
  assert.equal(completed.chars, 5, 'the whole body, punctuation included');
  const recorded = await app.waitForEvent('memory.auto', (payload) => payload.role === 'assistant');
  assert.equal(recorded.records, 1, 'the result reply body is recorded in memory');
  assert.equal(recorded.chars, 5, 'the whole result body entered memory');
  const rows = await app.events();
  assert.equal(rows.filter((event) => event.type === 'voice.result.completed').length, 1, 'one completion, one completed event');
  assert.equal(rows.filter((event) => event.type === 'voice.typed.spoken').length, 0, 'the result lane owns its own event');
  assert.equal(app.players().length, 1, 'the result body played exactly once');
  assert.ok(synthesized.includes('结果正文。'), 'the reply body reached synthesis');
  assert.ok(!synthesized.some((line) => line.includes('RAW_TOOL_OUTPUT')), 'the raw tool output was never spoken');
  t.diagnostic(
    `turn50 accepted kind=${accepted.kind} sender=${accepted.senderSessionId} task=${accepted.taskId}; `
    + `audio.started=${started.at > 0}; completed=${completed.sentences} sentence/${completed.chars} chars; `
    + `players=${app.players().length}; memory.auto=${recorded.records}/${recorded.chars} chars; `
    + 'raw tool output synthesized=0',
  );
});

// ---------------------------------------------------------------------------
// 39. The two notices of one task never replay: `agent-message` + `subagent-settled`
//
// The feed names no task/run id, and the two notices carry different injected message ids, so the
// sender's open `agent-message` message id is the task identity that the settled notice inherits.
// ---------------------------------------------------------------------------

test('39. the same sender\'s subagent-settled notice is a duplicate and never replays', async (t) => {
  const app = await mount(t);
  const { session } = app;
  const firstTask = 'result-51-agent-message-child-session-b';
  app.emit(session, startEvent(51));
  app.emit(session, resultEvent(51, 'child-session-b', 'agent-message'));
  app.emit(session, assistantEvent(51, '只播一次。'));
  app.emit(session, endEvent(51));
  await app.waitForEvent('voice.result.completed', (payload) => payload.turn === 51);

  // The settled notice is the same task's second completion notification (different message id).
  app.emit(session, startEvent(52));
  app.emit(session, resultEvent(52, 'child-session-b', 'subagent-settled', '子任务已结束。'));
  app.emit(session, assistantEvent(52, '重复通知。'));
  app.emit(session, endEvent(52));
  const skipped = await app.waitForEvent('voice.result.skipped', (payload) => payload.turn === 52);
  assert.equal(skipped.reason, 'duplicate');
  assert.equal(skipped.senderSessionId, 'child-session-b');
  assert.equal(skipped.taskId, firstTask, 'the settled notice inherited the agent-message task identity');
  await new Promise((resolve) => setTimeout(resolve, 80));

  const rows = await app.events();
  assert.equal(rows.filter((event) => event.type === 'voice.result.completed').length, 1, 'the task spoke once');
  assert.equal(rows.filter((event) => event.type === 'voice.result.accepted').length, 1, 'the duplicate was never accepted');
  assert.equal(app.players().length, 1, 'the duplicate notification opened no player');
  t.diagnostic(
    `turn51 completed=1 task=${firstTask}; turn52 skipped.reason=${skipped.reason} `
    + `task=${skipped.taskId}; players=${app.players().length}`,
  );
});

// ---------------------------------------------------------------------------
// 40. Regression: a real user message still drives the typed lane unchanged
// ---------------------------------------------------------------------------

test('40. regression: an ordinary user message still drives the typed lane', async (t) => {
  const app = await mount(t);
  const { session } = app;
  app.emit(session, startEvent(53));
  app.emit(session, userEvent(53, 'u-53', '真实用户消息'));
  app.emit(session, assistantEvent(53, '普通打字轮正文。'));
  app.emit(session, endEvent(53));

  const spoken = await app.waitForEvent('voice.typed.spoken', (payload) => payload.turn === 53);
  assert.equal(spoken.inputSource, 'typed');
  const rows = await app.events();
  assert.equal(rows.filter((event) => event.type.startsWith('voice.result.')).length, 0, 'no lookup crossed into the result lane');
  assert.equal(app.players().length, 1);
  t.diagnostic(`turn53 voice.typed.spoken=1 inputSource=${spoken.inputSource}; voice.result.*=0; players=1`);
});

// ---------------------------------------------------------------------------
// 41. A result in a subagent session is never spoken for the companion
// ---------------------------------------------------------------------------

test('41. a result arriving in a subagent session is skipped as subagent', async (t) => {
  const app = await mount(t);
  const child = { id: 'child-agent-session', header: { cwd: app.workspace, origin: 'subagent' } };
  app.emit(child, startEvent(54));
  app.emit(child, resultEvent(54, 'grandchild-session', 'agent-message', '子代理内部结果。'));
  app.emit(child, assistantEvent(54, '子代理自己的正文。'));
  app.emit(child, endEvent(54));

  const skipped = await app.waitForEvent('voice.result.skipped', (payload) => payload.turn === 54);
  assert.equal(skipped.reason, 'subagent');
  await new Promise((resolve) => setTimeout(resolve, 60));
  const rows = await app.events();
  assert.equal(rows.filter((event) => event.type === 'voice.result.completed').length, 0);
  assert.equal(app.players().length, 0, 'a delegated child never speaks for the companion');
  t.diagnostic(`turn54 skipped.reason=${skipped.reason}; voice.result.completed=0; players=0`);
});

// ---------------------------------------------------------------------------
// 42. A result turn with no body is silent and says why
// ---------------------------------------------------------------------------

test('42. a result turn with an empty body is skipped as silent', async (t) => {
  const app = await mount(t);
  const { session } = app;
  app.emit(session, startEvent(55));
  app.emit(session, resultEvent(55, 'child-session-c', 'agent-message'));
  app.emit(session, endEvent(55));

  const skipped = await app.waitForEvent('voice.result.skipped', (payload) => payload.turn === 55);
  assert.equal(skipped.reason, 'silent');
  const rows = await app.events();
  assert.equal(rows.filter((event) => event.type === 'voice.result.accepted').length, 0, 'nothing was accepted for speech');
  assert.equal(rows.filter((event) => event.type === 'voice.result.completed').length, 0);
  assert.equal(app.players().length, 0);
  t.diagnostic(`turn55 skipped.reason=${skipped.reason}; accepted=0; completed=0; players=0`);
});

// ---------------------------------------------------------------------------
// 43. A result never interrupts what is already playing; it waits its turn
// ---------------------------------------------------------------------------

test('43. a result arriving during another reply queues without interrupting it', async (t) => {
  const app = await mount(t);
  state.autoResolve = false;
  state.stops = 0;
  const other = { id: 'other-typed-session', header: { cwd: app.workspace } };
  app.driveTypedTurn(other, 60, '正在播的另一条。');
  await waitUntil(() => app.players().length === 1, 'the other reply started playing');
  const playing = app.players()[0];
  const stopsBefore = state.stops;

  const { session } = app;
  app.emit(session, startEvent(61));
  app.emit(session, resultEvent(61, 'child-session-d', 'agent-message'));
  app.emit(session, assistantEvent(61, '排队后的结果。'));
  app.emit(session, endEvent(61));
  await app.waitForEvent('voice.result.accepted', (payload) => payload.turn === 61);
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(app.players().length, 1, 'the result clip is queued behind the playing reply');
  const stoppedWhileQueued = state.stops - stopsBefore;
  assert.equal(stoppedWhileQueued, 0, 'the result turn never stopped the playing answer');
  assert.equal(playing.signal?.aborted, false, 'the playing clip was not aborted');
  assert.equal(app.players()[0], playing, 'the playing clip still owns the seat');

  // The seat is FIFO: once the first answer ends, the queued result plays.
  playing.resolve();
  await waitUntil(() => app.players().length === 2, 'the result clip started after the queue drained');
  app.players()[1].resolve();
  const completed = await app.waitForEvent('voice.result.completed', (payload) => payload.turn === 61);
  assert.equal(completed.sentences, 1);
  t.diagnostic(
    `turn61 queued while turn60 played; stoppedWhileQueued=${stoppedWhileQueued}; clips before=1 after=${app.players().length}; `
    + `voice.result.completed=${completed.sentences}`,
  );
});


// ---------------------------------------------------------------------------
// 44. Task identity, not sender identity: two tasks from one subagent both speak
//
// A continuable subagent keeps one session id while it takes new work. Keying by sender made its
// second task a "duplicate" forever. The first two tasks below are separated by their injected
// message ids (the real feed's only per-task field); the last two by an explicit feed task id.
// ---------------------------------------------------------------------------

test('44. the same sender\'s two different tasks are both spoken', async (t) => {
  const app = await mount(t);
  const { session } = app;
  app.emit(session, startEvent(62));
  app.emit(session, resultEvent(62, 'child-session-e', 'agent-message', '任务一。', { id: 'task-msg-a' }));
  app.emit(session, assistantEvent(62, '第一件结果。'));
  app.emit(session, endEvent(62));
  const first = await app.waitForEvent('voice.result.completed', (payload) => payload.turn === 62);

  app.emit(session, startEvent(63));
  app.emit(session, resultEvent(63, 'child-session-e', 'agent-message', '任务二。', { id: 'task-msg-b' }));
  app.emit(session, assistantEvent(63, '第二件结果。'));
  app.emit(session, endEvent(63));
  const second = await app.waitForEvent('voice.result.completed', (payload) => payload.turn === 63);

  assert.equal(first.taskId, 'task-msg-a');
  assert.equal(second.taskId, 'task-msg-b');
  assert.notEqual(first.taskId, second.taskId, 'the two tasks have distinct identities');
  let rows = await app.events();
  assert.equal(rows.filter((event) => event.type === 'voice.result.accepted').length, 2);
  assert.equal(rows.filter((event) => event.type === 'voice.result.completed').length, 2);
  assert.equal(rows.filter((event) => event.type === 'voice.result.skipped').length, 0, 'no task was swallowed');
  assert.equal(app.players().length, 2, 'both tasks played');

  // The same contract when a feed really supplies a task id: different ids are different tasks.
  app.emit(session, startEvent(64));
  app.emit(session, resultEvent(64, 'child-session-f', 'agent-message', '任务甲。', { taskId: 'task-x' }));
  app.emit(session, assistantEvent(64, '甲结果。'));
  app.emit(session, endEvent(64));
  const third = await app.waitForEvent('voice.result.completed', (payload) => payload.turn === 64);

  app.emit(session, startEvent(65));
  app.emit(session, resultEvent(65, 'child-session-f', 'agent-message', '任务乙。', { taskId: 'task-y' }));
  app.emit(session, assistantEvent(65, '乙结果。'));
  app.emit(session, endEvent(65));
  const fourth = await app.waitForEvent('voice.result.completed', (payload) => payload.turn === 65);

  assert.equal(third.taskId, 'task-x');
  assert.equal(fourth.taskId, 'task-y');
  rows = await app.events();
  assert.equal(rows.filter((event) => event.type === 'voice.result.completed').length, 4);
  assert.equal(app.players().length, 4, 'the second task from the same sender was not swallowed');
  t.diagnostic(
    `sender A tasks=${first.taskId}/${second.taskId} completed=2 players=2; `
    + `sender B tasks=${third.taskId}/${fourth.taskId} completed=4 players=4; skipped=0`,
  );
});

// ---------------------------------------------------------------------------
// 45. One task's two notices share a key; an explicit task id dedupes too
// ---------------------------------------------------------------------------

test('45. the two notices of one task share the task key, while a new task keeps its own', async (t) => {
  const app = await mount(t);
  const { session } = app;
  // No task id in the feed: the agent-message opens the task, the settled notice inherits it.
  app.emit(session, startEvent(66));
  app.emit(session, resultEvent(66, 'child-session-g', 'agent-message', '同一个任务的正文。'));
  app.emit(session, assistantEvent(66, '同一任务只播一次。'));
  app.emit(session, endEvent(66));
  const completed = await app.waitForEvent('voice.result.completed', (payload) => payload.turn === 66);
  assert.equal(completed.taskId, 'result-66-agent-message-child-session-g');

  app.emit(session, startEvent(67));
  app.emit(session, resultEvent(67, 'child-session-g', 'subagent-settled', '任务结束通知。'));
  app.emit(session, assistantEvent(67, '同一任务的第二条通知。'));
  app.emit(session, endEvent(67));
  const duplicate = await app.waitForEvent('voice.result.skipped', (payload) => payload.turn === 67);
  assert.equal(duplicate.reason, 'duplicate');
  assert.equal(duplicate.taskId, completed.taskId, 'both notices resolved to the same task');

  // An explicit task id is honoured on both notices as well.
  app.emit(session, startEvent(68));
  app.emit(session, resultEvent(68, 'child-session-h', 'agent-message', '显式任务正文。', { taskId: 'task-shared' }));
  app.emit(session, assistantEvent(68, '显式任务只播一次。'));
  app.emit(session, endEvent(68));
  const explicit = await app.waitForEvent('voice.result.completed', (payload) => payload.turn === 68);
  assert.equal(explicit.taskId, 'task-shared');

  app.emit(session, startEvent(69));
  app.emit(session, resultEvent(69, 'child-session-h', 'subagent-settled', '显式任务结束。', { taskId: 'task-shared' }));
  app.emit(session, assistantEvent(69, '显式任务的第二条通知。'));
  app.emit(session, endEvent(69));
  const explicitDuplicate = await app.waitForEvent('voice.result.skipped', (payload) => payload.turn === 69);
  assert.equal(explicitDuplicate.reason, 'duplicate');
  assert.equal(explicitDuplicate.taskId, 'task-shared');

  const rows = await app.events();
  assert.equal(rows.filter((event) => event.type === 'voice.result.completed').length, 2, 'one voice per task');
  assert.equal(rows.filter((event) => event.type === 'voice.result.accepted').length, 2);
  assert.equal(app.players().length, 2, 'the two duplicate notices opened no player');
  t.diagnostic(
    `task=${completed.taskId}: completed=1 then skipped=${duplicate.reason}; `
    + `explicit task=${explicit.taskId}: completed=1 then skipped=${explicitDuplicate.reason}; players=2`,
  );
});

// ---------------------------------------------------------------------------
// 46. A speech failure releases the task key: accepted is not played, retry may speak
// ---------------------------------------------------------------------------

test('46. a result synthesis failure is failed, and the same task can retry', async (t) => {
  const app = await mount(t);
  const baseSynth = state.synth;
  let failResult = true;
  state.synth = async (options) => {
    if (failResult && options.text === '结果合成会失败。') throw new Error('result-tts-down');
    return baseSynth(options);
  };
  const { session } = app;
  app.emit(session, startEvent(70));
  app.emit(session, resultEvent(70, 'child-session-i', 'agent-message', '任务正文。', { id: 'task-retry-1' }));
  app.emit(session, assistantEvent(70, '结果合成会失败。'));
  app.emit(session, endEvent(70));

  const failed = await app.waitForEvent('voice.result.failed', (payload) => payload.turn === 70);
  assert.equal(failed.taskId, 'task-retry-1');
  assert.match(failed.reason, /result-tts-down/);
  assert.equal(app.players().length, 0, 'a failed synthesis played nothing');
  let rows = await app.events();
  assert.equal(rows.filter((event) => event.type === 'voice.result.audio.started').length, 0, 'accepted never became played');
  assert.equal(rows.filter((event) => event.type === 'voice.result.completed').length, 0);

  // The same task (same sender, same injected message id) is retried: the key was released.
  failResult = false;
  app.emit(session, startEvent(71));
  app.emit(session, resultEvent(71, 'child-session-i', 'agent-message', '任务正文。', { id: 'task-retry-1' }));
  app.emit(session, assistantEvent(71, '结果合成会失败。'));
  app.emit(session, endEvent(71));
  const completed = await app.waitForEvent('voice.result.completed', (payload) => payload.turn === 71);
  assert.equal(completed.taskId, 'task-retry-1', 'the retry speaks the same task identity');
  await waitUntil(() => app.players().length === 1, 'the retry played the result');

  rows = await app.events();
  assert.equal(rows.filter((event) => event.type === 'voice.result.accepted').length, 2, 'acceptance is per attempt');
  assert.equal(rows.filter((event) => event.type === 'voice.result.failed').length, 1);
  assert.equal(rows.filter((event) => event.type === 'voice.result.completed').length, 1);
  t.diagnostic(
    `task=task-retry-1: turn70 failed.reason=${failed.reason} audio.started=0; `
    + `turn71 completed task=${completed.taskId}; accepted=2 failed=1 completed=1 players=1`,
  );
});

// ---------------------------------------------------------------------------
// 47. First sound and completion are separate, ordered events of one task
// ---------------------------------------------------------------------------

test('47. a result emits accepted, audio.started and completed in that order', async (t) => {
  const app = await mount(t);
  const { session } = app;
  app.emit(session, startEvent(72));
  app.emit(session, resultEvent(72, 'child-session-j', 'agent-message', '顺序任务。'));
  app.emit(session, assistantEvent(72, '顺序正文。'));
  app.emit(session, endEvent(72));
  const completed = await app.waitForEvent('voice.result.completed', (payload) => payload.turn === 72);

  const rows = await app.events();
  const indexOf = (type) => rows.findIndex((event) => event.type === type && event.payload?.turn === 72);
  const acceptedAt = indexOf('voice.result.accepted');
  const startedAt = indexOf('voice.result.audio.started');
  const completedAt = indexOf('voice.result.completed');
  assert.ok(acceptedAt >= 0 && startedAt >= 0 && completedAt >= 0, 'all three events exist');
  assert.ok(acceptedAt < startedAt, 'acceptance precedes first sound');
  assert.ok(startedAt < completedAt, 'first sound precedes completion');
  assert.equal(rows.filter((event) => event.type === 'voice.result.audio.started' && event.payload.turn === 72).length, 1);
  assert.equal(rows.filter((event) => event.type === 'voice.result.completed' && event.payload.turn === 72).length, 1);
  const started = rows[startedAt].payload;
  assert.equal(started.taskId, completed.taskId);
  assert.ok(Number(started.at) > 0, 'the first-sound event carries a real instant');
  t.diagnostic(
    `turn72 order accepted(${acceptedAt}) < audio.started(${startedAt}) < completed(${completedAt}); `
    + `task=${completed.taskId}; audioStartedAt=${started.at}`,
  );
});

// ---------------------------------------------------------------------------
// 48. The user's next typed message retires a reply still being synthesized
//
// The playback queue is not the only place an answer waits: the typed round-end speaker may still
// be blocked in TTS when the next question arrives. The cancellation must retire that round's
// generation (not merely whatever clip is sounding), so the released synthesis result is discarded
// and a new round still claims and speaks.
// ---------------------------------------------------------------------------

test('48. a typed message drops a reply whose synthesis is still in flight', async (t) => {
  const app = await mount(t);
  const entered = deferred();
  const gate = deferred();
  const baseSynth = state.synth;
  state.synth = async (options) => {
    if (options.text === '旧合成正文。') {
      entered.resolve();
      await gate.promise;
    }
    return baseSynth(options);
  };
  const { session } = app;
  app.emit(session, startEvent(22));
  app.emit(session, userEvent(22, 'u-22'));
  app.emit(session, assistantEvent(22, '旧合成正文。'));
  app.emit(session, endEvent(22));
  await entered.promise;

  // The old round is accepted and its synthesis is blocked; the user asks something else.
  app.emit(session, startEvent(23));
  app.emit(session, userEvent(23, 'u-23', '换一个问题'));
  app.emit(session, assistantEvent(23, '新合成正文。'));
  app.emit(session, endEvent(23));
  // The cancellation must be enough on its own: release the old synthesis only after it.
  gate.resolve();

  const stale = await app.waitForEvent('voice.typed.stale-dropped', (payload) => payload.turn === 22);
  assert.equal(stale.reason, 'user-input');
  const cancelled = (await app.events()).find((row) => row.type === 'voice.speech.cancelled'
    && row.payload?.turn === 22);
  assert.equal(cancelled?.payload?.reason, 'user-input', 'the cancellation names the user input');
  assert.equal(cancelled?.payload?.scope, 'typed', 'the cancellation is scoped to the typed lane');

  const spoken = await app.waitForEvent('voice.typed.spoken', (payload) => payload.turn === 23);
  assert.equal(spoken.sentences, 1);
  await waitUntil(() => app.players().length === 1, 'the new round reached the player');
  const rows = await app.events();
  assert.equal(
    rows.filter((row) => row.type === 'voice.typed.spoken' && row.payload.turn === 22).length,
    0,
    'the released old synthesis never became a spoken round',
  );
  t.diagnostic(
    `turn22 stale=${stale.reason}; voice.speech.cancelled scope=${cancelled.payload.scope}; `
    + `players=${app.players().length} (turn23 only); spoken turn23=${spoken.sentences}`,
  );
});

// ---------------------------------------------------------------------------
// 49. A partially played typed reply is stopped and never resumes
//
// The first sentence is already sounding when the next question arrives. Cancelling only the
// current player would let the queued second sentence follow the new question; the lane itself
// must stop, and the new turn must still get its own clip.
// ---------------------------------------------------------------------------

test('49. a typed message stops a partially played reply and it never resumes', async (t) => {
  const app = await mount(t);
  state.autoResolve = false;
  const { session } = app;
  app.emit(session, startEvent(24));
  app.emit(session, userEvent(24, 'u-24'));
  app.emit(session, assistantEvent(24, '旧第一句。旧第二句。'));
  app.emit(session, endEvent(24));
  await waitUntil(() => app.players().length === 1, 'the old first sentence started sounding');

  app.emit(session, startEvent(25));
  const stopsBefore = state.stops;
  app.emit(session, userEvent(25, 'u-25', '新问题'));
  app.emit(session, assistantEvent(25, '新第一句。'));
  app.emit(session, endEvent(25));
  const stale = await app.waitForEvent('voice.typed.stale-dropped', (payload) => payload.turn === 24);
  assert.equal(stale.reason, 'user-input');
  await waitUntil(() => app.players().length === 2, 'only the new turn added a player');
  assert.equal(app.players().length, 2, 'the old queued sentence never started');
  assert.equal(state.stops > stopsBefore, true, 'the sounding old clip was stopped');

  state.autoResolve = true;
  app.players()[1].resolve?.();
  const spoken = await app.waitForEvent('voice.typed.spoken', (payload) => payload.turn === 25);
  assert.equal(spoken.sentences, 1);
  const rows = await app.events();
  assert.equal(
    rows.filter((row) => row.type === 'voice.typed.spoken' && row.payload.turn === 24).length,
    0,
    'the partially played round never completed',
  );
  t.diagnostic(
    `turn24 stale=${stale.reason}; players=${app.players().length} (old first + new first only); `
    + `stops=${state.stops}; spoken turn25=${spoken.sentences}`,
  );
});

// ---------------------------------------------------------------------------
// 50. A result round is retired only while it is the old round
//
// The result lane is a typed claim too, so the same input rule applies. A result that starts after
// the user's input is a new round and must speak; an older result still synthesizing is dropped.
// ---------------------------------------------------------------------------

test('50. a delegated result is not cancelled unless it is the old round', async (t) => {
  const app = await mount(t);
  const baseSynth = state.synth;
  const { session } = app;

  // A new result round AFTER the user's input: it must not be harmed by the cancellation rule.
  app.emit(session, startEvent(30));
  app.emit(session, userEvent(30, 'u-30', '先问一句'));
  app.emit(session, startEvent(31));
  app.emit(session, resultEvent(31, 'child-new', 'agent-message', '新结果通知。'));
  app.emit(session, assistantEvent(31, '新结果正文。'));
  app.emit(session, endEvent(31));
  const completed = await app.waitForEvent('voice.result.completed', (payload) => payload.turn === 31);
  assert.equal(completed.sentences, 1);
  const playersAfterNew = app.players().length;
  assert.equal(playersAfterNew, 1, 'the new result round played');

  // An OLD result round is still synthesizing when the next typed message arrives: it is dropped.
  const entered = deferred();
  const gate = deferred();
  state.synth = async (options) => {
    if (options.text === '旧结果正文。') {
      entered.resolve();
      await gate.promise;
    }
    return baseSynth(options);
  };
  app.emit(session, startEvent(32));
  app.emit(session, resultEvent(32, 'child-old', 'agent-message', '旧结果通知。'));
  app.emit(session, assistantEvent(32, '旧结果正文。'));
  app.emit(session, endEvent(32));
  await entered.promise;
  app.emit(session, startEvent(33));
  app.emit(session, userEvent(33, 'u-33', '新问题'));
  gate.resolve();

  const stale = await app.waitForEvent('voice.typed.stale-dropped', (payload) => payload.turn === 32);
  assert.equal(stale.reason, 'user-input');
  await waitUntil(() => app.players().length === playersAfterNew, 'the old result added no clip');
  const rows = await app.events();
  assert.equal(
    rows.filter((row) => row.type === 'voice.result.audio.started' && row.payload.turn === 32).length,
    0,
    'the old result never started sounding',
  );
  assert.equal(
    rows.filter((row) => row.type === 'voice.result.completed' && row.payload.turn === 32).length,
    0,
  );
  t.diagnostic(
    `turn31 result completed=${completed.sentences} players=${playersAfterNew}; `
    + `turn32 stale=${stale.reason} players=${app.players().length}; result.completed(32)=0`,
  );
});

// ---------------------------------------------------------------------------
// 51. A late `turn/end` of a round the user already superseded never claims or synthesizes
//
// The input can arrive before the old round ended (no claim exists yet). The input-turn floor
// drops that round at `turn/end`, so a delayed old answer cannot start after the new question.
// ---------------------------------------------------------------------------

test('51. a late turn/end of the old round is dropped before it can claim', async (t) => {
  const app = await mount(t);
  const synthesized = [];
  const baseSynth = state.synth;
  state.synth = async (options) => {
    synthesized.push(options.text);
    return baseSynth(options);
  };
  const { session } = app;
  app.emit(session, startEvent(40));
  app.emit(session, userEvent(40, 'u-40'));
  // The next question arrives while turn 40 is still open, then turn 40 ends late.
  app.emit(session, startEvent(41));
  app.emit(session, userEvent(41, 'u-41', '新问题'));
  app.emit(session, assistantEvent(40, '迟到的旧正文。'));
  app.emit(session, endEvent(40));

  const stale = await app.waitForEvent('voice.typed.stale-dropped', (payload) => payload.turn === 40);
  assert.equal(stale.reason, 'user-input');
  assert.equal(app.players().length, 0, 'the late old round opened no player');
  assert.equal(synthesized.includes('迟到的旧正文。'), false, 'the late old round was never synthesized');

  app.emit(session, assistantEvent(41, '新轮正文。'));
  app.emit(session, endEvent(41));
  const spoken = await app.waitForEvent('voice.typed.spoken', (payload) => payload.turn === 41);
  assert.equal(spoken.sentences, 1);
  await waitUntil(() => app.players().length === 1, 'the new round still speaks');
  t.diagnostic(
    `turn40 stale=${stale.reason} synthesized=0 players=0; turn41 spoken=${spoken.sentences} `
    + `players=${app.players().length}`,
  );
});

// ---------------------------------------------------------------------------
// 52. A settled notice closes the sender's task association
//
// `agent-message` opens a task; its `subagent-settled` notice is the task's last word. Without
// closing that association the sender's NEXT settled-only task inherited the finished key and was
// skipped as a duplicate forever. The first task still speaks once; the next one speaks too.
// ---------------------------------------------------------------------------

test('52. a finished settled task closes the sender association, so the next settled-only task speaks', async (t) => {
  const app = await mount(t);
  const { session } = app;
  // Task A opens with `agent-message` (its injected message id is the task key) and speaks.
  app.emit(session, startEvent(80));
  app.emit(session, resultEvent(80, 'child-close', 'agent-message', '任务 A 通知。', { id: 'task-a' }));
  app.emit(session, assistantEvent(80, '任务 A 正文。'));
  app.emit(session, endEvent(80));
  const first = await app.waitForEvent('voice.result.completed', (payload) => payload.turn === 80);
  assert.equal(first.taskId, 'task-a');
  assert.equal(app.players().length, 1, 'task A played once');

  // A's settled notice is the same task's second notification. It is a duplicate AND the task's
  // final word, so resolving it must close the association.
  app.emit(session, startEvent(81));
  app.emit(session, resultEvent(81, 'child-close', 'subagent-settled', '重复通知。', { id: 'settle-a' }));
  app.emit(session, assistantEvent(81, '同一任务的重复通知。'));
  app.emit(session, endEvent(81));
  const duplicate = await app.waitForEvent('voice.result.skipped', (payload) => payload.turn === 81);
  assert.equal(duplicate.reason, 'duplicate');
  assert.equal(duplicate.taskId, 'task-a', 'the settled notice still resolves to task A');
  const closed = await app.waitForEvent('voice.result.task-close', (payload) => payload.taskId === 'task-a');
  assert.equal(closed.reason, 'duplicate');
  assert.equal(app.players().length, 1, 'task A never played twice');

  // The sender's next task arrives as a settled notice ONLY. It must not inherit task A (a
  // permanent duplicate); it opens its own key from its own message id and is spoken.
  app.emit(session, startEvent(82));
  app.emit(session, resultEvent(82, 'child-close', 'subagent-settled', '任务 B 通知。', { id: 'settle-b' }));
  app.emit(session, assistantEvent(82, '任务 B 正文。'));
  app.emit(session, endEvent(82));
  const second = await app.waitForEvent('voice.result.completed', (payload) => payload.turn === 82);
  assert.equal(second.taskId, 'settle-b', 'the settled-only task opens its own key');
  assert.notEqual(second.taskId, first.taskId);
  await waitUntil(() => app.players().length === 2, 'task B started playing');

  const rows = await app.events();
  assert.equal(
    rows.filter((row) => row.type === 'voice.result.completed' && row.payload.taskId === 'task-a').length,
    1,
    'task A spoke exactly once',
  );
  assert.equal(
    rows.filter((row) => row.type === 'voice.result.completed' && row.payload.taskId === 'settle-b').length,
    1,
    'task B spoke once under its own key',
  );
  assert.equal(rows.filter((row) => row.type === 'voice.result.task-open').length, 1, 'only the agent-message opened a task');
  assert.equal(rows.filter((row) => row.type === 'voice.result.skipped' && row.payload.turn === 82).length, 0);
  t.diagnostic(
    `task A=${first.taskId} completed=1 duplicate.close=${closed.reason}; `
    + `task B=${second.taskId} completed=1; players=${app.players().length}; skipped(82)=0`,
  );
});

// ---------------------------------------------------------------------------
// 53. A settled notice with no open association still speaks under its own message id
// ---------------------------------------------------------------------------

test('53. a settled notice with no open association opens its own task key and speaks', async (t) => {
  const app = await mount(t);
  const { session } = app;
  app.emit(session, startEvent(83));
  app.emit(session, resultEvent(83, 'child-fresh', 'subagent-settled', '仅结束通知。', { id: 'settle-only' }));
  app.emit(session, assistantEvent(83, '仅通知正文。'));
  app.emit(session, endEvent(83));
  const completed = await app.waitForEvent('voice.result.completed', (payload) => payload.turn === 83);
  assert.equal(completed.taskId, 'settle-only', 'a settled-only task uses its own message id');
  await waitUntil(() => app.players().length === 1, 'the settled-only task played');
  const rows = await app.events();
  assert.equal(rows.filter((row) => row.type === 'voice.result.task-open').length, 0, 'a settled notice never opens an association');
  assert.equal(rows.filter((row) => row.type === 'voice.result.accepted' && row.payload.turn === 83).length, 1);
  t.diagnostic(`turn83 task=${completed.taskId} completed=1 players=${app.players().length} task-open=0`);
});

// ---------------------------------------------------------------------------
// 54. A failed settled notice closes the association and the same task may retry
// ---------------------------------------------------------------------------

test('54. a failed settled notice closes the association, so the same task retries and speaks', async (t) => {
  const app = await mount(t);
  const baseSynth = state.synth;
  let fail = true;
  state.synth = async (options) => {
    if (fail && options.text === '失败任务正文。') throw new Error('settled-tts-down');
    return baseSynth(options);
  };
  const { session } = app;
  // Task A opens with a silent `agent-message`: the association is open but nothing played.
  app.emit(session, startEvent(84));
  app.emit(session, resultEvent(84, 'child-retry', 'agent-message', '', { id: 'task-fail-b' }));
  app.emit(session, endEvent(84));

  // The settled notice speaks task A and the synthesis fails: failed must also close the
  // association so the task is not left open forever.
  app.emit(session, startEvent(85));
  app.emit(session, resultEvent(85, 'child-retry', 'subagent-settled', '失败任务通知。', { id: 'task-fail-b' }));
  app.emit(session, assistantEvent(85, '失败任务正文。'));
  app.emit(session, endEvent(85));
  const failed = await app.waitForEvent('voice.result.failed', (payload) => payload.turn === 85);
  assert.equal(failed.taskId, 'task-fail-b');
  assert.match(failed.reason, /settled-tts-down/);
  const closed = await app.waitForEvent('voice.result.task-close', (payload) => payload.taskId === 'task-fail-b');
  assert.equal(closed.reason, 'failed');
  assert.equal(app.players().length, 0, 'the failed attempt played nothing');

  // The same task (same sender, same injected id) is retried: the key was released by the failure.
  fail = false;
  app.emit(session, startEvent(86));
  app.emit(session, resultEvent(86, 'child-retry', 'subagent-settled', '失败任务通知。', { id: 'task-fail-b' }));
  app.emit(session, assistantEvent(86, '失败任务正文。'));
  app.emit(session, endEvent(86));
  const completed = await app.waitForEvent('voice.result.completed', (payload) => payload.turn === 86);
  assert.equal(completed.taskId, 'task-fail-b', 'the retry speaks the same task identity');
  await waitUntil(() => app.players().length === 1, 'the retry played');

  const rows = await app.events();
  assert.equal(rows.filter((row) => row.type === 'voice.result.accepted').length, 2, 'acceptance is per attempt');
  assert.equal(rows.filter((row) => row.type === 'voice.result.failed').length, 1);
  assert.equal(rows.filter((row) => row.type === 'voice.result.completed').length, 1);
  t.diagnostic(
    `task=${completed.taskId} failed.close=${closed.reason} accepted=2 failed=1 completed=1 `
    + `players=${app.players().length}`,
  );
});

// ---------------------------------------------------------------------------
// 55. A replayed end notice never speaks twice
//
// The end notice is delivered once as the task's second notification (duplicate, association then
// closed) and delivered AGAIN with the same injected message id. Without the bounded notice map
// the second delivery would fall back to its own id, open a new task and speak the same ending a
// second time. The map keeps the first attribution (task A) and the task state reports duplicate.
// ---------------------------------------------------------------------------

test('55. a replayed end notice is still the same task and never speaks again', async (t) => {
  const app = await mount(t);
  const { session } = app;
  // Task A opens through its agent-message and speaks once.
  app.emit(session, startEvent(90));
  app.emit(session, resultEvent(90, 'child-replay', 'agent-message', '任务 A 通知。', { id: 'task-replay-a' }));
  app.emit(session, assistantEvent(90, '任务 A 正文。'));
  app.emit(session, endEvent(90));
  const first = await app.waitForEvent('voice.result.completed', (payload) => payload.turn === 90);
  assert.equal(first.taskId, 'task-replay-a');

  // A's end notice: same task, so skipped as a duplicate; that skip closes the association.
  app.emit(session, startEvent(91));
  app.emit(session, resultEvent(91, 'child-replay', 'subagent-settled', '', { id: 'settle-replay-a' }));
  app.emit(session, assistantEvent(91, '任务 A 结束。'));
  app.emit(session, endEvent(91));
  const firstSkip = await app.waitForEvent('voice.result.skipped', (payload) => payload.turn === 91);
  assert.equal(firstSkip.reason, 'duplicate');
  assert.equal(firstSkip.taskId, 'task-replay-a');

  // The very same notice id arrives again after the association closed: the map still knows it.
  app.emit(session, startEvent(92));
  app.emit(session, resultEvent(92, 'child-replay', 'subagent-settled', '', { id: 'settle-replay-a' }));
  app.emit(session, assistantEvent(92, '任务 A 结束（重放）。'));
  app.emit(session, endEvent(92));
  const replaySkip = await app.waitForEvent('voice.result.skipped', (payload) => payload.turn === 92);
  assert.equal(replaySkip.reason, 'duplicate');
  assert.equal(replaySkip.taskId, 'task-replay-a', 'the replay kept the original task identity');
  const noticeReplay = await app.waitForEvent(
    'voice.result.notice-replay',
    (payload) => payload.noticeId === 'settle-replay-a',
  );
  assert.equal(noticeReplay.taskId, 'task-replay-a', 'the debug event names the original task');
  await new Promise((resolve) => setTimeout(resolve, 80));

  const rows = await app.events();
  assert.equal(app.players().length, 1, 'the replayed end notice opened no player');
  assert.equal(rows.filter((row) => row.type === 'voice.result.accepted').length, 1, 'nothing was accepted for the replay');
  assert.equal(rows.filter((row) => row.type === 'voice.result.completed').length, 1);
  t.diagnostic(
    `task=task-replay-a: completed=1; notice skip=${firstSkip.reason}; `
    + `replay skip=${replaySkip.reason} task=${replaySkip.taskId}; `
    + `notice-replay task=${noticeReplay.taskId}; players=${app.players().length}`,
  );
});

// ---------------------------------------------------------------------------
// 56. The same sender's NEW task (different notice id) still speaks normally
// ---------------------------------------------------------------------------

test('56. a same-sender new task with a different notice id is still spoken', async (t) => {
  const app = await mount(t);
  const { session } = app;
  app.emit(session, startEvent(95));
  app.emit(session, resultEvent(95, 'child-next', 'agent-message', '任务一通知。', { id: 'task-next-1' }));
  app.emit(session, assistantEvent(95, '任务一正文。'));
  app.emit(session, endEvent(95));
  const first = await app.waitForEvent('voice.result.completed', (payload) => payload.turn === 95);
  assert.equal(first.taskId, 'task-next-1');
  assert.equal(app.players().length, 1, 'the first task played');

  // Its end notice is a duplicate and closes the association.
  app.emit(session, startEvent(96));
  app.emit(session, resultEvent(96, 'child-next', 'subagent-settled', '', { id: 'settle-next-1' }));
  app.emit(session, assistantEvent(96, '任务一结束。'));
  app.emit(session, endEvent(96));
  const duplicate = await app.waitForEvent('voice.result.skipped', (payload) => payload.turn === 96);
  assert.equal(duplicate.reason, 'duplicate');
  assert.equal(duplicate.taskId, 'task-next-1');

  // A NEW task from the same sender, with a different notice id: it is not a replay of either
  // previous notice, so it opens its own task and speaks.
  app.emit(session, startEvent(97));
  app.emit(session, resultEvent(97, 'child-next', 'subagent-settled', '', { id: 'settle-next-2' }));
  app.emit(session, assistantEvent(97, '任务二正文。'));
  app.emit(session, endEvent(97));
  const second = await app.waitForEvent('voice.result.completed', (payload) => payload.turn === 97);
  assert.equal(second.taskId, 'settle-next-2', 'the new task owns a new key');
  assert.notEqual(second.taskId, first.taskId);
  await waitUntil(() => app.players().length === 2, 'the new task started playing');
  assert.equal(app.players().length, 2, 'both tasks played');

  const rows = await app.events();
  assert.equal(rows.filter((row) => row.type === 'voice.result.skipped' && row.payload.turn === 97).length, 0);
  t.diagnostic(
    `task=${first.taskId} completed=1 then duplicate=${duplicate.reason}; `
    + `new task=${second.taskId} completed=1; players=${app.players().length}; skipped(97)=0`,
  );
});

// ---------------------------------------------------------------------------
// 57. A failed end notice may retry: the map hit never blocks the task state
//
// The same notice id is delivered twice. The first attempt really fails, which releases the task
// key; the second delivery hits the notice map but the task has no played state, so it speaks.
// ---------------------------------------------------------------------------

test('57. a failed end notice is retried even though the notice map remembers it', async (t) => {
  const app = await mount(t);
  const baseSynth = state.synth;
  let fail = true;
  state.synth = async (options) => {
    if (fail && options.text === '重试任务正文。') throw new Error('replay-tts-down');
    return baseSynth(options);
  };
  const { session } = app;
  app.emit(session, startEvent(100));
  app.emit(session, resultEvent(100, 'child-retry-notice', 'subagent-settled', '', { id: 'settle-retry-a' }));
  app.emit(session, assistantEvent(100, '重试任务正文。'));
  app.emit(session, endEvent(100));
  const failed = await app.waitForEvent('voice.result.failed', (payload) => payload.turn === 100);
  assert.equal(failed.taskId, 'settle-retry-a');
  assert.match(failed.reason, /replay-tts-down/);
  assert.equal(app.players().length, 0, 'the failed attempt played nothing');

  // The same notice is delivered again: the map hit resolves the same task, whose failure released
  // the key, so playback state (not the map) decides and the retry speaks.
  fail = false;
  app.emit(session, startEvent(101));
  app.emit(session, resultEvent(101, 'child-retry-notice', 'subagent-settled', '', { id: 'settle-retry-a' }));
  app.emit(session, assistantEvent(101, '重试任务正文。'));
  app.emit(session, endEvent(101));
  const completed = await app.waitForEvent('voice.result.completed', (payload) => payload.turn === 101);
  assert.equal(completed.taskId, 'settle-retry-a', 'the retry speaks the same task identity');
  await waitUntil(() => app.players().length === 1, 'the retry played');
  const replayHit = await app.waitForEvent('voice.result.notice-replay', (payload) => payload.noticeId === 'settle-retry-a');
  assert.equal(replayHit.taskId, 'settle-retry-a');

  const rows = await app.events();
  assert.equal(rows.filter((row) => row.type === 'voice.result.skipped' && row.payload.turn === 101).length, 0, 'the retry was not swallowed');
  assert.equal(rows.filter((row) => row.type === 'voice.result.accepted').length, 2, 'acceptance is per attempt');
  assert.equal(rows.filter((row) => row.type === 'voice.result.failed').length, 1);
  assert.equal(rows.filter((row) => row.type === 'voice.result.completed').length, 1);
  t.diagnostic(
    `task=settle-retry-a: turn100 failed=${failed.reason} players=0; `
    + `turn101 map-hit task=${replayHit.taskId} completed=1 players=${app.players().length}; `
    + 'skipped(101)=0',
  );
});

// ---------------------------------------------------------------------------
// 58. The notice map is bounded: the oldest entry is evicted, the newest still dedupes
//
// The map holds at most 64 notices (10 minute LRU). Task A resolves through its agent-message;
// its end notice is attributed to task A and remembered. 64 newer notices then evict that oldest
// entry, so a late replay of A's notice no longer resolves through the map. The newest notice is
// still remembered and is reported as a replay, and an expired entry is dropped too.
// ---------------------------------------------------------------------------

test('58. the notice map evicts the oldest entry and keeps deduplicating the newest', async (t) => {
  let clock = 1_700_000_000_000;
  const { relay, events, plays } = relayFixture({ now: () => clock, autoResolve: true });
  const driveResult = (turn, result) => {
    relay.observe(relaySession, startEvent(turn));
    relay.observe(relaySession, result);
    relay.observe(relaySession, assistantEvent(turn, '正文。'));
    return relay.observe(relaySession, endEvent(turn));
  };
  const settled = (turn, id) => resultEvent(turn, 'child-lru', 'subagent-settled', '', { id });
  const replayCount = () => events.filter((event) => event.type === 'voice.result.notice-replay').length;

  // Task A: the agent-message opens and speaks; its end notice is a duplicate attributed to A.
  await driveResult(1, resultEvent(1, 'child-lru', 'agent-message', '', { id: 'msg-a' }));
  await relay.whenIdle();
  await driveResult(2, settled(2, 'settle-a'));
  await relay.whenIdle();
  assert.equal(plays.length, 1, 'task A spoke once; its end notice was a duplicate');
  assert.ok(events.some((event) => event.type === 'voice.result.skipped'
    && event.payload.reason === 'duplicate' && event.payload.taskId === 'msg-a'));

  // 64 newer noticed tasks fill the map past its 64-entry bound, evicting settle-a's entry.
  for (let i = 1; i <= 64; i += 1) {
    await driveResult(2 + i, settled(2 + i, `settle-${i}`));
    await relay.whenIdle();
  }
  assert.equal(plays.length, 65, 'the 64 new notices each spoke');

  // The oldest entry is gone: A's notice no longer maps to task A, so it opens its own key.
  const beforeEvicted = replayCount();
  await driveResult(67, settled(67, 'settle-a'));
  await relay.whenIdle();
  assert.equal(replayCount(), beforeEvicted, 'the evicted notice is no longer reported as a replay');
  assert.equal(plays.length, 66, 'the evicted notice resolved through its own id, not task A');
  assert.ok(events.some((event) => event.type === 'voice.result.accepted'
    && event.payload.taskId === 'settle-a'));

  // The newest entry survives: its replay is still attributed and deduplicated.
  const beforeNewest = replayCount();
  await driveResult(68, settled(68, 'settle-64'));
  await relay.whenIdle();
  assert.equal(replayCount(), beforeNewest + 1, 'the newest notice is still known');
  assert.equal(plays.length, 66, 'the newest notice did not speak again');
  const newestReplay = events.filter((event) => event.type === 'voice.result.notice-replay').at(-1);
  assert.equal(newestReplay.payload.noticeId, 'settle-64');
  assert.equal(newestReplay.payload.taskId, 'settle-64');

  // Ten minutes after the LRU touch the entry expires; the task state still reports a duplicate.
  const beforeExpiry = replayCount();
  clock += 10 * 60 * 1000 + 1;
  await driveResult(69, settled(69, 'settle-64'));
  await relay.whenIdle();
  assert.equal(replayCount(), beforeExpiry, 'a notice older than 10 minutes is forgotten');
  assert.equal(plays.length, 66, 'the expired replay still deduplicated through the task state');
  t.diagnostic(
    `limit=64: task msg-a completed=1; 64 newer notices each spoke; oldest settle-a entry evicted -> `
    + `opened its own key (plays=${plays.length}); newest settle-64 still known `
    + `(notice-replay task=${newestReplay.payload.taskId}); 10-minute expiry dropped unreported`,
  );
});

