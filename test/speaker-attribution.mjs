/**
 * 声纹阶段 3：写入路径接线（用户定稿）。
 *
 * Identity is used ONLY to attribute a NEW personal-lexicon candidate and a NEW memory record to
 * the confirmed self. An uncertain row never claims the user; nothing here rejects, mutes,
 * interrupts or reclaims an earlier transcript. The shadow arrives after delivery, so an already
 * written record is never changed (the late row is only labelled).
 *
 * Covers the acceptance list:
 *   1. self `match` + `self` + confirmed enrollment → the correction candidate carries the self
 *      speakerId, the new memory record's `speaker_attribution` is `assigned:true`, and the
 *      `speaker.attribution.assigned` debug event names the utterance;
 *   2. another voice / `unsure` / no enrollment → the candidate stays unassigned and the record is
 *      stored with `assigned:false` (the other id may be kept as evidence, never as self);
 *   3. a shadow that arrives AFTER the record was written keeps the record unassigned (no
 *      retroactive rewrite), and the late row is only labelled `attribution-late`;
 *   4. old data: a legacy `memory_event` table without the new column and a legacy lexicon file
 *      without the speaker fields are still readable; new rows store the field;
 *   5. no hard decision: delivery text/order, barge-in, filtering and cancellation counts are
 *      identical with and without the identity wiring;
 *   6. regression: `speaker-*`, `lexicon-*`, `memory-*`, `voice-lanes`, `node test/smoke.mjs`.
 *
 * A synthetic microphone (registerHooks stub) and a fake agent loop drive the REAL `apply`,
 * `handleVoiceTask`, auto-recorder and stores. No sound, model, network, TTS or GUI is touched.
 *
 * Run: node --test test/speaker-attribution.mjs
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { DatabaseSync } from 'node:sqlite';
import { cleanupRoot } from './helpers/cleanup.mjs';

const run = promisify(execFile);
const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SELF_ID = 'spk-self';
const OTHER_ID = 'spk-other';
const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Module seams: synthetic microphone + never-touch-real-capture sight
// ---------------------------------------------------------------------------

const state = { onUpdate: null, onEvent: null, messageIds: [] };
globalThis.__speakerAttribution = state;

const hearingUrl = new URL('../src/host/hearing/hearing.js', import.meta.url).href;
const sightUrl = new URL('../src/host/vision/sight.js', import.meta.url).href;

const hooks = registerHooks({
  load(url, context, next) {
    if (url === hearingUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    const s = globalThis.__speakerAttribution;
    export const modelReady = () => true;
    export const finalModelReady = () => false;
    export const isLoopbackDevice = (name) => /CABLE|Stereo Mix|Virtual/i.test(String(name));
    export const selectMicrophoneDevice = (devices, requested) => ({
      device: requested || devices[0] || '', loopback: false, error: '',
    });
    export const listDevices = async () => ['Fake Mic'];
    export const startHearing = (options) => {
      s.onUpdate = options.onUpdate;
      s.onEvent = options.onEvent;
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
      return { ...v, at, ageMs, stale: at === null || ageMs >= ttlMs };
    }`,
      };
    }
    return next(url, context);
  },
});
const { apply } = await import('../src/host/index.js');
hooks.deregister();
after(() => { delete globalThis.__speakerAttribution; });

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A valid v1 enrollment file: the user's own voice is explicitly confirmed. */
function enrollmentFile(selfId = SELF_ID) {
  return {
    version: 1,
    selfId,
    updatedAt: '2026-11-09T03:00:00.000Z',
    entries: [{
      speakerId: selfId,
      label: '我',
      status: 'confirmed',
      samples: [{ id: 'smp-1', durationMs: 4000, at: '2026-11-09T03:00:00.000Z', source: 'mic' }],
      createdAt: '2026-11-09T03:00:00.000Z',
      confirmedAt: '2026-11-09T03:00:00.000Z',
      modelVersion: '',
    }],
  };
}

async function newRoot({ enrollment = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-speaker-attribution-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await mkdir(join(root, 'workspace'), { recursive: true });
  await writeFile(join(root, 'data', 'features.json'), JSON.stringify({
    hearing: true, ambient: false, voice: false, vision: false, subtitle: false,
    avatar: false, memory: true, fastpath: false,
  }));
  await writeFile(join(root, 'data', 'settings.json'), JSON.stringify({
    gptSovits: { enabled: false },
    langs: { speech: 'zh', subtitle: 'zh' },
    autoMemory: { enabled: true },
    voice: { chunking: false },
  }));
  if (enrollment !== null) {
    await writeFile(join(root, 'data', 'speaker-enrollment.json'), JSON.stringify(enrollment, null, 2));
  }
  return root;
}

// ---------------------------------------------------------------------------
// Mounted host: real apply(), synthetic microphone, fake agent loop + event bus
// ---------------------------------------------------------------------------

async function mount(root) {
  state.onUpdate = null;
  state.onEvent = null;
  state.messageIds = [];

  const cleanups = [];
  const tools = new Map();
  const routes = new Map();
  const listeners = new Set();
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
  let seq = 0;
  let persisted = false;
  const agents = new Map();
  const makeAgent = (sessionId) => {
    const session = { id: sessionId, header: { cwd: join(root, 'workspace') }, append() {} };
    let turn = 0;
    return {
      id: sessionId,
      session,
      followup(message) {
        turn += 1;
        const turnId = turn;
        state.messageIds.push(message.id);
        const fire = (type, data) => bus.fire('session/event', session, {
          type, seq: (seq += 1), time: Date.now(), data,
        });
        void (async () => {
          fire('turn/start', { turn: turnId });
          // The message object is exactly what the Harness logs as `user/message.data`.
          fire('user/message', message);
          fire('assistant/message', {
            turn: turnId,
            step: 1,
            message: { id: `a-${turnId}`, role: 'assistant', content: [{ type: 'text', text: '好。' }] },
          });
          fire('turn/end', { turn: turnId, reason: { kind: 'completed' } });
        })().catch(() => {});
      },
    };
  };
  const services = new Map([
    ['agentDefaultModel', { currentSelection: () => ({ provider: 'fake-provider', model: 'fake-model' }) }],
    ['sessionTitle', { get: () => undefined, rename: (_session, title) => ({ title, source: { kind: 'user' } }) }],
    ['workspaceRegistry', {
      async create(path) { return { id: 'ws-speaker-attribution', path }; },
      get() { return { id: 'ws-speaker-attribution', async attachSession() {} }; },
    }],
    ['agentLoop', {
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
    }],
  ]);
  const effect = (fn) => {
    const cleanup = fn();
    if (typeof cleanup === 'function') cleanups.push(cleanup);
    return cleanup;
  };
  const scope = {
    effect,
    on: bus.on,
    get: (serviceName) => services.get(serviceName),
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
    get: (serviceName) => services.get(serviceName),
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    inject: (_deps, register) => register(scope),
    webServer: { register: () => () => {} },
  }, {
    root,
    enabled: true,
    asrMergeWindowMs: 10,
    // Candidate extraction is opt-in by default; this suite exercises attribution ON the
    // automatic-lexicon candidate path, so it must opt in explicitly without touching the default.
    lexicon: { autoCandidates: true },
  });

  const listen = tools.get('assistant_listen');
  assert.ok(listen !== undefined, 'assistant_listen is registered');
  const started = await listen.execute({ action: 'start' }, {});
  assert.equal(started.ok, true, `synthetic microphone started: ${started.error ?? ''}`);
  assert.equal(typeof state.onUpdate, 'function', 'the hearing session exposes onUpdate');
  assert.equal(typeof state.onEvent, 'function', 'the hearing session exposes onEvent');
  // Bind THIS mount's seams: two mounts may be alive at once (test 5), and the module-level slot
  // always points at the newest session.
  const ownOnUpdate = state.onUpdate;
  const ownOnEvent = state.onEvent;

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
  const events = async () => {
    try {
      const text = await readFile(join(root, 'data', 'events.jsonl'), 'utf8');
      return text.trim().split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  const waitFor = async (check, message, timeoutMs = 6000) => {
    const startedAt = Date.now();
    for (;;) {
      const value = await check();
      if (value) return value;
      if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out: ${message}`);
      await tick(10);
    }
  };
  const waitForEvent = async (type, predicate = () => true) => {
    let hit;
    await waitFor(async () => {
      hit = (await events()).find((event) => event.type === type && predicate(event.payload ?? {}));
      return hit !== undefined;
    }, `${type} event`);
    return hit;
  };
  const poll = async () => listen.execute({ action: 'poll' }, {});
  const latestCandidates = async () => (await action({ action: 'lexicon.candidates' })).candidates ?? [];
  const waitForCandidate = async (text) => {
    let hit;
    await waitFor(async () => {
      hit = (await latestCandidates()).find((entry) => entry.text === text);
      return hit !== undefined;
    }, `lexicon candidate ${text}`);
    return hit;
  };
  const waitForRecord = async () => {
    let record = null;
    await waitFor(async () => {
      const messageId = state.messageIds.at(-1);
      if (typeof messageId !== 'string') return false;
      record = readRecord(root, messageId);
      return record !== null;
    }, 'memory record');
    return record;
  };
  const close = async () => {
    await cleanupRoot(root, cleanups.splice(0));
  };

  return {
    root,
    action,
    events,
    waitFor,
    waitForEvent,
    poll,
    latestCandidates,
    waitForCandidate,
    waitForRecord,
    close,
    messageIds: () => [...state.messageIds],
    shadow: (payload) => ownOnEvent('speaker.shadow', payload),
    say: (text, meta = {}) => ownOnUpdate({ final: text, durationMs: 4000, ...meta }),
  };
}

/** Read one message record straight from the store (the host holds the write handle). */
function readRecord(root, messageId) {
  const file = join(root, 'memory', 'memory.db');
  if (!existsSync(file)) return null;
  const db = new DatabaseSync(file);
  try {
    const row = db
      .prepare('SELECT role, ts, speaker_attribution AS attribution FROM memory_event WHERE message_id = ?')
      .get(messageId);
    if (row === undefined) return null;
    return {
      role: row.role,
      ts: row.ts,
      attribution: typeof row.attribution === 'string' && row.attribution.length > 0
        ? JSON.parse(row.attribution)
        : null,
    };
  } finally {
    db.close();
  }
}

const rowsOf = (events, type) => events.filter((event) => event.type === type);

// ---------------------------------------------------------------------------
// 1. Confirmed self
// ---------------------------------------------------------------------------

test('1. 本人 match+self+已确认 → 候选带 speakerId、新记忆 attribution assigned', async (t) => {
  const root = await newRoot({ enrollment: enrollmentFile() });
  const app = await mount(root);
  t.after(async () => { await app.close(); });

  app.shadow({
    decision: 'match',
    class: 'self',
    quality: 'ok',
    score: 0.94,
    speakerId: SELF_ID,
    source: 'mic',
    utteranceId: 'u-self-1',
  });
  app.say('不是小满，是向晚', { utteranceId: 'u-self-1' });

  const candidate = await app.waitForCandidate('向晚');
  assert.equal(candidate.kind, 'correction');
  assert.equal(candidate.assigned, true, 'a confirmed self assigns the correction candidate');
  assert.equal(candidate.speakerId, SELF_ID, 'the candidate carries the confirmed self id');

  const record = await app.waitForRecord();
  assert.equal(record.role, 'user');
  assert.deepEqual(record.attribution, {
    speakerId: SELF_ID,
    assigned: true,
    confidence: 'confirmed',
    source: 'shadow',
    at: record.ts,
  }, 'the new record stores the fixed attribution field');

  const assigned = await app.waitForEvent('speaker.attribution.assigned', (payload) => payload.utteranceId === 'u-self-1');
  assert.deepEqual(assigned.payload, { utteranceId: 'u-self-1', speakerId: SELF_ID, confidence: 'confirmed' });
  assert.equal(Object.hasOwn(assigned.payload, 'text'), false, 'the debug row never carries transcript text');
  const unassigned = rowsOf(await app.events(), 'speaker.attribution.unassigned')
    .find((event) => event.payload.utteranceId === 'u-self-1');
  assert.equal(unassigned, undefined, 'an assigned record emits no unassigned row');
  console.log(`[1] candidate=${JSON.stringify([candidate.kind, candidate.assigned, candidate.speakerId])} `
    + `record=${JSON.stringify(record.attribution)} event=${JSON.stringify(assigned.payload)}`);
});

// ---------------------------------------------------------------------------
// 2. Other / unsure / no enrollment
// ---------------------------------------------------------------------------

test('2. 他人 / unsure / 无登记 → 未归属，候选 speakerId=null，记录 assigned:false', async () => {
  const cases = [
    {
      name: 'other',
      root: await newRoot({ enrollment: enrollmentFile() }),
      shadow: {
        decision: 'mismatch', class: 'other', quality: 'ok', score: 0.11,
        speakerId: OTHER_ID, source: 'mic', utteranceId: 'u-other',
      },
      expected: { speakerId: OTHER_ID, confidence: 'mismatch' },
    },
    {
      name: 'unsure',
      root: await newRoot({ enrollment: enrollmentFile() }),
      shadow: {
        decision: 'unsure', class: 'unknown-identity', quality: 'ok', score: 0.36,
        speakerId: null, source: 'mic', utteranceId: 'u-unsure',
      },
      expected: { speakerId: null, confidence: 'unsure' },
    },
    {
      name: 'no-enrollment',
      root: await newRoot(),
      shadow: {
        decision: 'match', class: 'self', quality: 'ok', score: 0.95,
        speakerId: SELF_ID, source: 'mic', utteranceId: 'u-no-enroll',
      },
      expected: { speakerId: null, confidence: 'unsure' },
    },
  ];

  const report = [];
  for (const item of cases) {
    const app = await mount(item.root);
    try {
      app.shadow(item.shadow);
      app.say('不是小蛮，是林晚', { utteranceId: item.shadow.utteranceId });

      const candidate = await app.waitForCandidate('林晚');
      assert.equal(candidate.assigned, false, `${item.name}: the candidate is not assigned`);
      assert.equal(candidate.speakerId, null, `${item.name}: the candidate names no speaker`);

      const record = await app.waitForRecord();
      assert.equal(record.attribution.assigned, false, `${item.name}: the record is not assigned`);
      assert.equal(record.attribution.confidence, item.expected.confidence, `${item.name}: confidence`);
      assert.deepEqual(record.attribution.speakerId, item.expected.speakerId, `${item.name}: evidence id only`);
      assert.notEqual(record.attribution.speakerId, SELF_ID, `${item.name}: never claimed as self`);

      const unassigned = await app.waitForEvent(
        'speaker.attribution.unassigned',
        (payload) => payload.utteranceId === item.shadow.utteranceId,
      );
      assert.equal(typeof unassigned.payload.reason, 'string');
      assert.ok(unassigned.payload.reason.length > 0);
      assert.equal(rowsOf(await app.events(), 'speaker.attribution.assigned').length, 0,
        `${item.name}: no assigned event`);
      report.push(`${item.name}=${JSON.stringify([record.attribution.speakerId, record.attribution.assigned,
        record.attribution.confidence, unassigned.payload.reason])}`);
    } finally {
      await app.close();
    }
  }
  console.log(`[2] ${report.join(' ')}`);
});

// ---------------------------------------------------------------------------
// 3. Late shadow: no retroactive rewrite
// ---------------------------------------------------------------------------

test('3. shadow 晚到 → 记录保持未归属、不回溯；事件标注 attribution-late', async (t) => {
  const root = await newRoot({ enrollment: enrollmentFile() });
  const app = await mount(root);
  t.after(async () => { await app.close(); });

  // No shadow row yet: the record and the candidate are written as unassigned.
  app.say('不是小满，是向晚', { utteranceId: 'u-late' });
  const before = await app.waitForRecord();
  assert.equal(before.attribution.assigned, false, 'no shadow row yet means unassigned');
  const beforeCandidate = await app.waitForCandidate('向晚');
  assert.equal(beforeCandidate.assigned, false);
  assert.equal(beforeCandidate.speakerId, null);

  // The shadow arrives after the record: nothing is rewritten; the late row is only annotated.
  app.shadow({
    decision: 'match', class: 'self', quality: 'ok', score: 0.96,
    speakerId: SELF_ID, source: 'mic', utteranceId: 'u-late',
  });
  const late = await app.waitForEvent('speaker.attribution.unassigned', (payload) => payload.reason === 'attribution-late');
  assert.equal(late.payload.utteranceId, 'u-late');

  await tick(120);
  const after = readRecord(root, app.messageIds().at(-1));
  assert.equal(after.attribution.assigned, false, 'the stored record stays unassigned (no retro-claim)');
  assert.equal(after.attribution.speakerId, null);
  const afterCandidate = (await app.latestCandidates()).find((entry) => entry.text === '向晚');
  assert.equal(afterCandidate.assigned, false, 'the candidate is not retro-assigned either');
  assert.equal(afterCandidate.speakerId, null);

  const assignedRows = rowsOf(await app.events(), 'speaker.attribution.assigned');
  assert.equal(assignedRows.some((event) => event.payload.utteranceId === 'u-late'), false,
    'a late shadow never emits an assigned row');

  console.log(`[3] before=${JSON.stringify(before.attribution)} after=${JSON.stringify(after.attribution)} `
    + `candidate=${JSON.stringify([afterCandidate.assigned, afterCandidate.speakerId])} `
    + `late=${JSON.stringify(late.payload)} assignedEvents=${assignedRows.length}`);
});

// ---------------------------------------------------------------------------
// 4. Old data compatibility
// ---------------------------------------------------------------------------

test('4. 旧数据兼容：无新列/无新字段仍可读，新行才写归属', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-speaker-attribution-legacy-'));
  t.after(async () => { await cleanupRoot(root); });
  await mkdir(join(root, 'memory'), { recursive: true });
  await mkdir(join(root, 'data'), { recursive: true });

  // A legacy memory_event table without `speaker_attribution`, one stored message.
  const legacyDb = new DatabaseSync(join(root, 'memory', 'memory.db'));
  legacyDb.exec(`CREATE TABLE memory_event (
    id TEXT PRIMARY KEY, ts TEXT NOT NULL, domain TEXT NOT NULL, kind TEXT NOT NULL,
    text TEXT NOT NULL, importance INTEGER NOT NULL DEFAULT 50,
    clarity TEXT NOT NULL DEFAULT 'vivid', last_seen TEXT,
    recall_count INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT '',
    message_id TEXT, role TEXT
  )`);
  legacyDb.prepare(`INSERT INTO memory_event (id, ts, domain, kind, text, message_id, role)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run('old-1', '2026-01-01T00:00:00.000Z', 'chat', 'event', '旧记录', 'old-msg', 'user');
  legacyDb.close();

  const { MemoryStore } = await import('../src/host/memory/store.js');
  const store = new MemoryStore(root);
  let legacyText = '';
  let newAssigned = null;
  try {
    store.open();
    const columns = store.db.prepare('PRAGMA table_info(memory_event)').all().map((row) => row.name);
    const archiveColumns = store.db.prepare('PRAGMA table_info(memory_archive)').all().map((row) => row.name);
    assert.ok(columns.includes('speaker_attribution'), 'the additive column exists after open()');
    assert.ok(archiveColumns.includes('speaker_attribution'), 'and it is carried into the archive');
    const legacy = store.messageRecords().find((row) => row.messageId === 'old-msg');
    legacyText = legacy.text;
    assert.equal(legacy.text, '旧记录', 'an old row is still readable');
    assert.equal(store.messageAttribution('old-msg'), null, 'a legacy row has no attribution');

    const written = store.addMessage({
      role: 'user',
      sessionId: 'legacy-session',
      turnId: 1,
      messageId: 'new-msg',
      text: '新记录',
      speakerAttribution: {
        speakerId: SELF_ID, assigned: true, confidence: 'confirmed', source: 'shadow',
        at: '2026-11-09T03:00:00.000Z',
      },
    });
    assert.equal(written.record.speakerAttribution.assigned, true);
    assert.deepEqual(store.messageAttribution('new-msg'), {
      speakerId: SELF_ID, assigned: true, confidence: 'confirmed', source: 'shadow',
      at: '2026-11-09T03:00:00.000Z',
    });
    newAssigned = store.messageAttribution('new-msg').assigned;
    const replay = store.addMessage({ role: 'user', messageId: 'new-msg', text: '新记录' });
    assert.equal(replay.deduped, true, 'the idempotent replay is unchanged');
    assert.equal(store.messageAttribution('new-msg').assigned, true, 'the replay keeps the stored row');
  } finally {
    store.close();
  }

  // A legacy lexicon file without `speakerId`/`assigned` on its entries still loads.
  const { createLexiconStore, lexiconHints } = await import('../src/host/speech/lexicon-store.js');
  await writeFile(join(root, 'data', 'lexicon.json'), JSON.stringify({
    version: 1,
    nextId: 2,
    entries: [{
      id: 'lex-1', key: '向晚', text: '向晚', canonical: '向晚', kind: 'proper-noun',
      status: 'confirmed', wrongForms: ['小满'], sourceIds: ['voice-1'], context: null,
      ambiguous: false, at: '2026-01-01T00:00:00.000Z',
      confirmedAt: '2026-01-01T00:00:00.000Z', rejectedAt: '',
    }],
  }));
  const lexicon = createLexiconStore({ root });
  const [entry] = lexicon.listConfirmed();
  assert.equal(entry.text, '向晚');
  assert.equal(entry.speakerId, null, 'a field-less legacy entry stays unassigned');
  assert.equal(entry.assigned, false);
  assert.deepEqual(lexiconHints([entry])[0].wrongForms, ['小满'], 'the confirmed hint still applies');

  console.log(`[4] legacyRow=${legacyText} legacyAttr=null newAttr=${JSON.stringify({ speakerId: SELF_ID, assigned: newAssigned })} `
    + `lexicon=${JSON.stringify([entry.speakerId, entry.assigned, lexiconHints([entry])[0].wrongForms])}`);
});

// ---------------------------------------------------------------------------
// 5. No hard decision
// ---------------------------------------------------------------------------

test('5. 不触发硬决策：投递/过滤/打断计数不变，调试事件不含文本', async (t) => {
  const plainRoot = await newRoot();
  const plain = await mount(plainRoot);
  const identityRoot = await newRoot({ enrollment: enrollmentFile() });
  const identity = await mount(identityRoot);
  t.after(async () => {
    await plain.close();
    await identity.close();
  });

  const text = '不是小满，是向晚';
  // NOTE: both mounts share the module-level `state.messageIds`; the identity record is therefore
  // identified by its assigned debug event instead of by "the last message id". `poll` drains the
  // finals, so the first non-empty result is captured instead of polling again later.
  plain.say(text, { utteranceId: 'u-plain' });
  identity.shadow({
    decision: 'match', class: 'self', quality: 'ok', score: 0.97,
    speakerId: SELF_ID, source: 'mic', utteranceId: 'u-identity',
  });
  identity.say(text, { utteranceId: 'u-identity' });

  let plainFinals = null;
  let identityFinals = null;
  await plain.waitFor(async () => {
    const result = await plain.poll();
    if (result.finals.length === 0) return false;
    plainFinals = result.finals;
    return true;
  }, 'plain final');
  await identity.waitFor(async () => {
    const result = await identity.poll();
    if (result.finals.length === 0) return false;
    identityFinals = result.finals;
    return true;
  }, 'identity final');
  await identity.waitForEvent('speaker.attribution.assigned', (payload) => payload.utteranceId === 'u-identity');

  assert.deepEqual(identityFinals, plainFinals,
    'the delivered text and order are identical with and without identity');
  assert.deepEqual(identityFinals, [text]);

  const plainEvents = await plain.events();
  const identityEvents = await identity.events();
  const countOf = (rows, prefix) => rows.filter((event) => event.type.startsWith(prefix)).length;
  assert.equal(countOf(identityEvents, 'hearing.filtered'), countOf(plainEvents, 'hearing.filtered'));
  assert.equal(countOf(identityEvents, 'hearing.duplicate'), countOf(plainEvents, 'hearing.duplicate'));
  assert.equal(countOf(identityEvents, 'hearing.bargein'), countOf(plainEvents, 'hearing.bargein'));
  assert.equal(countOf(identityEvents, 'voice.response.user-cancel'), countOf(plainEvents, 'voice.response.user-cancel'));
  assert.equal(countOf(identityEvents, 'voice.bargein'), countOf(plainEvents, 'voice.bargein'));
  assert.equal(countOf(identityEvents, 'voice.transcript'), countOf(plainEvents, 'voice.transcript'));

  for (const event of rowsOf(identityEvents, 'speaker.attribution.assigned')) {
    assert.deepEqual(Object.keys(event.payload).sort(), ['confidence', 'speakerId', 'utteranceId']);
    assert.equal(JSON.stringify(event.payload).includes(text), false, 'no transcript text in a debug row');
  }
  for (const event of rowsOf(identityEvents, 'speaker.attribution.unassigned')) {
    assert.equal(Object.hasOwn(event.payload, 'text'), false);
    assert.equal(JSON.stringify(event.payload).includes(text), false);
  }

  console.log(`[5] finals=${JSON.stringify(identityFinals)} `
    + `filtered=${countOf(identityEvents, 'hearing.filtered')} duplicate=${countOf(identityEvents, 'hearing.duplicate')} `
    + `bargein=${countOf(identityEvents, 'hearing.bargein') + countOf(identityEvents, 'voice.bargein')} `
    + `cancel=${countOf(identityEvents, 'voice.response.user-cancel')} attributionEvents=${countOf(identityEvents, 'speaker.attribution.')}`);
});

// ---------------------------------------------------------------------------
// 6. Regression
// ---------------------------------------------------------------------------

const childEnv = { ...process.env };
delete childEnv.NODE_TEST_CONTEXT;
/**
 * Run one suite as a plain `node <file>`. `DSH_SPEAKER_ATTRIBUTION_NESTED` marks a child run: this
 * suite's own regression test skips there, because `speaker-download-cancel.mjs` also runs
 * `speaker-*` and would otherwise recurse into this file forever.
 */
const runSuite = (file, args = []) => run(process.execPath, [...args, file], {
  cwd: PROJECT_ROOT,
  env: { ...childEnv, DSH_SPEAKER_ATTRIBUTION_NESTED: '1' },
  maxBuffer: 64 * 1024 * 1024,
});

test('6. 回归：speaker-*、lexicon-*、memory-*、voice-lanes、smoke', async (t) => {
  // Nested invocations (e.g. speaker-download-cancel's own regression) must not recurse.
  if (process.env.DSH_SPEAKER_ATTRIBUTION_NESTED === '1') {
    t.skip('nested run: the top-level speaker-attribution regression already covers these suites');
    return;
  }
  t.timeout = 1_800_000;
  for (const file of ['src/host/index.js', 'src/host/memory/auto-recorder.js', 'src/host/memory/store.js', 'test/speaker-attribution.mjs']) {
    await assert.doesNotReject(runSuite(file, ['--check']), `${file} parses`);
  }

  const testDir = join(PROJECT_ROOT, 'test');
  const names = await readdir(testDir);
  const self = 'speaker-attribution.mjs';
  const suites = names
    .filter((name) => /^speaker-.*\.mjs$/u.test(name) && name !== self)
    .concat(names.filter((name) => /^lexicon-.*\.mjs$/u.test(name)))
    .concat(names.filter((name) => /^memory-.*\.mjs$/u.test(name)))
    .concat(names.filter((name) => ['voice-lanes.mjs', 'smoke.mjs'].includes(name)))
    .sort();
  assert.ok(suites.length >= 30, `found the regression suites: ${suites.length}`);

  const results = [];
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= suites.length) return;
      const name = suites[index];
      try {
        const result = await runSuite(join(testDir, name));
        results.push({ name, output: `${result.stdout}\n${result.stderr}`, ok: true });
      } catch (error) {
        // A plain script (memory-policy / smoke) exits 0 on success and prints no node:test
        // summary; the exit status is the authoritative pass/fail signal here.
        results.push({
          name,
          output: `${error?.stdout ?? ''}\n${error?.stderr ?? ''}`,
          ok: false,
        });
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, () => worker()));

  const failures = results.filter(({ output, ok }) => ok !== true || /\bfail [1-9]/u.test(output));
  for (const { name, output } of failures) {
    console.error(`[6] ${name}\n${output.slice(-4000)}`);
  }
  assert.deepEqual(failures.map(({ name }) => name), [], 'every regression suite passes');

  const smoke = results.find(({ name }) => name === 'smoke.mjs');
  assert.match(smoke.output, /SMOKE TEST PASSED/u);
  console.log(`[6] suites=${results.length} failed=0 smoke=ok`);
});
