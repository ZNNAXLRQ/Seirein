/**
 * ASR diagnostics at the host boundary: both `startHearing` calls (microphone and loopback) must
 * hand the worker's `onEvent` sink to the host event log, so `asr.worker.started`,
 * `asr.worker.stopped`, `asr.worker.degraded` and `asr.decode` really land in `events.jsonl`.
 *
 * Why this test exists: `test/asr-worker.mjs` proves the worker client emits those events, but it
 * constructs the client directly. The host call sites used to drop `onEvent`, so a real machine
 * produced no ASR diagnostics at all. Here the real mounted host (`apply`) is driven; only the
 * capture/ASR module is short-circuited, and the real `EventLog` writes the JSONL file that is
 * then read back — the assertion is on the file, not on a captured call.
 *
 * No microphone, ffmpeg, ASR model, TTS, network or child process is involved.
 *
 * Covered:
 *   1. mic lane: `startHearing` receives `onEvent`; started/stopped reach `events.jsonl`
 *   2. loopback lane: the same wiring for the ambient session
 *   3. privacy: only counts/timings/reasons; no audio bytes and no transcript on any asr.* row
 *
 * Run: node --test test/asr-events.mjs
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { Readable } from 'node:stream';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupRoot } from './helpers/cleanup.mjs';

/** Shared with the fake hearing module: the options the host passed, in call order. */
const state = { sessions: [], stops: 0 };
globalThis.__asrEvents = state;

const moduleUrl = (path) => new URL(path, import.meta.url).href;
const hearingUrl = moduleUrl('../src/host/hearing/hearing.js');
const sightUrl = moduleUrl('../src/host/vision/sight.js');
const hardwareUrl = moduleUrl('../src/host/platform/hardware.js');

/** A capture device and a matching virtual-cable loopback (the host's `LOOPBACK_RE`). */
const MIC = 'Fake Mic';
const LOOPBACK = 'CABLE Output (VB-Audio Virtual Cable)';

const hooks = registerHooks({
  load(href, context, next) {
    if (href === hearingUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          const s = globalThis.__asrEvents;
          export const modelReady = () => true;
          export const finalModelReady = () => false;
          // ambient.js imports this classifier at module load, even when the test never starts one.
          export const isLoopbackDevice = (name) => /CABLE|Stereo Mix|Virtual/i.test(String(name));
          export const listDevices = async () => ['${MIC}', '${LOOPBACK}'];
          // Mirrors createAsrWorkerClient: 'started' when the worker spawns, 'stopped' from stop().
          // Every emit goes through the host-provided onEvent, exactly like the real session.
          export const startHearing = (options) => {
            const session = {
              device: options.device,
              options,
              done: Promise.resolve(),
              stopCount: 0,
              stop() {
                if (this.stopCount > 0) return;
                this.stopCount += 1;
                s.stops += 1;
                options.onEvent?.('asr.worker.stopped', { decodes: 0, restarts: 0, crashes: 0 });
              },
            };
            s.sessions.push(session);
            options.onEvent?.('asr.worker.started', { attempt: 1 });
            return session;
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
          export const capture = forbidden, captureDesktop = forbidden, captureDevice = forbidden, startStoryboard = forbidden;
          export const OBSERVATION_TTL_MS = 30000;
          export function readObservation(o, { now = Date.now(), ttlMs = 30000 } = {}) { const v = o ?? {}; const c = Number(v.capturedAt); const s = Number.isFinite(c) && c > 0 ? c : Number(v.at); const at = Number.isFinite(s) && s > 0 ? s : null; const ageMs = at === null ? null : Math.max(0, now - at); const stale = ageMs === null || ageMs >= ttlMs; return { ...v, at, ageMs, stale, hint: stale ? 'stale' : '' }; }`,
      };
    }
    if (href === hardwareUrl) {
      // The loopback lane is gated on the detected tier; pin it so the test is machine-independent.
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
hooks.deregister();

after(() => { delete globalThis.__asrEvents; });

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, label, timeoutMs = 3000) {
  const startedAt = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - startedAt > timeoutMs) assert.fail(`timed out: ${label}`);
    await tick(10);
  }
}

// ---------------------------------------------------------------------------
// Mounted host: real apply() + real EventLog; only capture/ASR/OS probe are faked
// ---------------------------------------------------------------------------

async function mount(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-asr-events-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await writeFile(
    join(root, 'data', 'features.json'),
    JSON.stringify({ voice: false, hearing: true, ambient: true }),
    'utf8',
  );
  await writeFile(join(root, 'data', 'settings.json'), '{}', 'utf8');
  state.sessions = [];
  state.stops = 0;

  const tools = new Map();
  const routes = new Map();
  const cleanups = [];
  const effect = (fn) => {
    const cleanup = fn();
    if (typeof cleanup === 'function') cleanups.push(cleanup);
    return cleanup;
  };
  const webServer = {
    register(route) {
      routes.set(route.path, route.handler);
      return () => routes.delete(route.path);
    },
  };
  const ctx = {
    effect,
    get: () => undefined,
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
        webServer,
      });
    },
    webServer,
  };
  // Short merge window: the transcript arrives at the host's callback immediately, not after the
  // production debounce (the lane under test is the worker telemetry, not the merge policy).
  apply(ctx, { root, enabled: true, asrMergeWindowMs: 10 });
  t.after(async () => {
    await cleanupRoot(root, cleanups.splice(0));
  });

  const events = async () => {
    try {
      const text = await readFile(join(root, 'data', 'events.jsonl'), 'utf8');
      return text
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  const rowsOfType = async (type) => (await events()).filter((row) => row.type === type);
  const waitEvent = (type, predicate = () => true) =>
    until(async () => {
      const rows = await rowsOfType(type);
      return rows.find((row) => predicate(row.payload ?? {}));
    }, `${type} in events.jsonl`);

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

  const listen = (actionName) => {
    const tool = tools.get('assistant_listen');
    assert.ok(tool !== undefined, 'assistant_listen is registered');
    return tool.execute({ action: actionName });
  };

  const sessionFor = (device) => state.sessions.find((session) => session.device === device);

  return { root, events, rowsOfType, waitEvent, action, listen, sessionFor };
}

// ---------------------------------------------------------------------------
// 1. Microphone lane
// ---------------------------------------------------------------------------

test('mic: startHearing gets onEvent and started/stopped reach events.jsonl', async (t) => {
  const app = await mount(t);

  const started = await app.listen('start');
  assert.equal(started.ok, true, `the mic lane started: ${started.error ?? ''}`);
  assert.equal(started.device, MIC, 'the fake capture device was selected');

  const session = app.sessionFor(MIC);
  assert.ok(session !== undefined, 'the host called startHearing for the microphone');
  assert.equal(typeof session.options.onEvent, 'function', 'index.js passes onEvent into startHearing');

  // The session emitted 'started' at spawn through the host sink: it must be on disk.
  const startRow = await app.waitEvent('asr.worker.started');
  assert.deepEqual(startRow.payload, { attempt: 1 }, 'the started payload is the worker shape, unchanged');
  assert.equal((await app.rowsOfType('asr.worker.started')).length, 1, 'exactly one started row per session');

  // Any other diagnostic type travels the same path (decode timing).
  session.options.onEvent('asr.decode', { ms: 37, queued: 1, ok: true });
  const decodeRow = await app.waitEvent('asr.decode');
  assert.deepEqual(decodeRow.payload, { ms: 37, queued: 1, ok: true });

  const stopped = await app.listen('stop');
  assert.equal(stopped.ok, true);
  const stopRow = await app.waitEvent('asr.worker.stopped');
  assert.deepEqual(stopRow.payload, { decodes: 0, restarts: 0, crashes: 0 });
  assert.equal((await app.rowsOfType('asr.worker.stopped')).length, 1, 'exactly one stopped row per session');

  // The real EventLog wrote them: ids/timestamps come from store.js, not from the seam.
  for (const row of [startRow, stopRow]) {
    assert.equal(typeof row.id, 'string');
    assert.equal(typeof row.ts, 'string');
  }
});

// ---------------------------------------------------------------------------
// 2. Loopback (ambient) lane: the same wiring on the second startHearing call
// ---------------------------------------------------------------------------

test('loopback: the ambient session forwards started/stopped through onEvent too', async (t) => {
  const app = await mount(t);

  const started = await app.action({ action: 'ambient.start' });
  assert.equal(started.ok, true, `the loopback lane started: ${started.error ?? ''}`);
  assert.equal(started.device, LOOPBACK, 'the virtual cable was selected');

  const session = app.sessionFor(LOOPBACK);
  assert.ok(session !== undefined, 'the host called startHearing for the loopback');
  assert.equal(typeof session.options.onEvent, 'function', 'index.js passes onEvent into startHearing');

  const startRow = await app.waitEvent('asr.worker.started');
  assert.deepEqual(startRow.payload, { attempt: 1 });
  assert.equal((await app.rowsOfType('asr.worker.started')).length, 1);

  // Degraded is the diagnostic that matters when the worker dies: same sink, same file.
  session.options.onEvent('asr.worker.degraded', { reason: 'worker exited (1)', restarts: 0, crashes: 1 });
  const degraded = await app.waitEvent('asr.worker.degraded');
  assert.deepEqual(degraded.payload, { reason: 'worker exited (1)', restarts: 0, crashes: 1 });

  const stopped = await app.action({ action: 'ambient.stop' });
  assert.equal(stopped.ok, true);
  const stopRow = await app.waitEvent('asr.worker.stopped');
  assert.deepEqual(stopRow.payload, { decodes: 0, restarts: 0, crashes: 0 });
  assert.equal((await app.rowsOfType('asr.worker.stopped')).length, 1);
});

// ---------------------------------------------------------------------------
// 3. Privacy: counts, timings and reasons only
// ---------------------------------------------------------------------------

test('asr diagnostics carry no audio bytes and no transcript text', async (t) => {
  const app = await mount(t);
  const started = await app.listen('start');
  assert.equal(started.ok, true);
  const session = app.sessionFor(MIC);
  assert.ok(session !== undefined);

  // One representative payload per diagnostic type: counts, timings and a short reason, the
  // shapes hearing.js emits. None of them may gain an audio or transcript field on the way out.
  const shapes = {
    'asr.worker.started': { attempt: 1 },
    'asr.decode': { ms: 12, queued: 0, ok: true },
    'asr.worker.stopped': { decodes: 3, restarts: 0, crashes: 0 },
  };
  for (const [type, payload] of Object.entries(shapes)) {
    session.options.onEvent(type, payload);
    const row = await app.waitEvent(type);
    assert.deepEqual(row.payload, payload, `${type} is forwarded verbatim (the host adds no field)`);
  }

  // A full transcript arriving on the recognition lane must never leak into an asr.* row.
  const SECRET = '这是一段完整的识别转写文本，不应该出现在诊断事件里。';
  session.options.onUpdate({ final: SECRET, durationMs: 120 });
  await until(
    async () => (await app.rowsOfType('hearing.utterance')).length === 1,
    'the host consumed the final transcript',
  );

  const rows = (await app.events()).filter((row) => row.type.startsWith('asr.'));
  assert.ok(rows.length >= 3, 'the diagnostic rows exist');
  for (const row of rows) {
    const serialized = JSON.stringify(row.payload ?? {});
    assert.ok(!serialized.includes(SECRET), `${row.type} never carries the transcript`);
    // Audio would have to arrive as samples/bytes: neither a key nor a long blob may exist.
    assert.ok(!/[a-z]*(audio|samples?|pcm|bytes?|transcript|text)/i.test(Object.keys(row.payload ?? {}).join(',')), `${row.type} has no audio/text key`);
    assert.doesNotMatch(serialized, /[A-Za-z0-9+/]{64,}/, `${row.type} has no encoded audio blob`);
    // Diagnostic values are short scalars, not content.
    for (const value of Object.values(row.payload ?? {})) {
      if (typeof value === 'string') assert.ok(value.length <= 40, `${row.type} carries a short label only`);
    }
  }
});
