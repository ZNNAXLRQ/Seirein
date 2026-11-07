/**
 * Temporary diagnosis: `voice.dedupe.decision`.
 *
 * The same spoken sentence reaches the session four times (chars 15 → 19 ×3). The repeat gate
 * (`isRepeatFinal`) runs on the *merged* buffer, so the event records the gate's inputs as
 * lengths and booleans, plus how many finals were concatenated into `mergeBuffer` before it.
 * It must never carry the transcript, and it must not change what is delivered.
 *
 * No real microphone, ASR, ffmpeg, TTS, network or child process is used: the hearing module is
 * short-circuited by a loader hook, so the test feeds finals straight into the host's callback.
 * The EventLog is captured in memory instead of reading/writing `data/events.jsonl`.
 *
 * Run: node --test test/voice-dedupe-probe.mjs
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cleanupRoot } from './helpers/cleanup.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Everything the fake hearing session and the captured event log share. */
const state = { events: [], onUpdate: null, stops: 0 };
globalThis.__voiceDedupeProbe = state;

const moduleUrl = (path) => new URL(path, import.meta.url).href;
const hearingUrl = moduleUrl('../src/host/hearing/hearing.js');
const sightUrl = moduleUrl('../src/host/vision/sight.js');

const hooks = registerHooks({
  load(href, context, next) {
    if (href === hearingUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          const s = globalThis.__voiceDedupeProbe;
          export const modelReady = () => true;
          export const finalModelReady = () => false;
          // ambient.js imports this classifier at module load, even when no ambient session starts.
          export const isLoopbackDevice = (name) => /CABLE|Stereo Mix|Virtual/i.test(String(name));
          export const listDevices = async () => ['Fake Mic'];
          export const startHearing = (options) => {
            s.onUpdate = options.onUpdate;
            return { device: options.device, stop() { s.stops += 1; }, stats: () => null };
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
    return next(href, context);
  },
});

const { apply } = await import('../src/host/index.js');
const { EventLog } = await import('../src/host/memory/store.js');
hooks.deregister();

/** Capture every event in memory: the probe test must not wait on file I/O. */
const originalEmit = EventLog.prototype.emit;
EventLog.prototype.emit = async function emit(type, payload) {
  state.events.push({ type, payload });
  return { id: 'probe-test', ts: new Date().toISOString(), type, payload };
};

after(() => {
  EventLog.prototype.emit = originalEmit;
  delete globalThis.__voiceDedupeProbe;
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** 15 chars: the first final the user's log shows. */
const FINAL_15 = '语音探针甲'.repeat(3);
/** 19 chars, deliberately not a superset/subset of FINAL_15 (no containment drop). */
const FINAL_19 = `${'语音探针乙'.repeat(3)}乙乙乙乙`;

/**
 * Mount the plugin against a temp root. Voice is disabled so a delivered transcript cannot reach
 * a real TTS engine; the hearing path is the fake module installed above.
 */
async function mount(t, { settings = {}, mergeWindowMs = 10 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-dedupe-probe-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await writeFile(join(root, 'data', 'features.json'), JSON.stringify({ voice: false }), 'utf8');
  await writeFile(join(root, 'data', 'settings.json'), JSON.stringify(settings), 'utf8');
  state.events = [];
  state.onUpdate = null;
  state.stops = 0;

  const tools = new Map();
  const cleanups = [];
  const effect = (fn) => {
    const cleanup = fn();
    if (typeof cleanup === 'function') cleanups.push(cleanup);
    return cleanup;
  };
  const ctx = {
    effect,
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    inject: (_deps, register) => {
      register({
        effect,
        systemPrompt: { section: () => () => {} },
        webServer: { register: () => () => {} },
      });
    },
  };
  apply(ctx, { root, enabled: true, asrMergeWindowMs: mergeWindowMs });
  t.after(async () => {
    await cleanupRoot(root, cleanups);
  });

  const listen = tools.get('assistant_listen');
  assert.ok(listen !== undefined, 'assistant_listen is registered');
  const started = await listen.execute({ action: 'start' });
  assert.equal(started.ok, true, `listening started: ${started.error ?? ''}`);
  // The autostart ladder may already own the fake session; either way its callback is captured.
  assert.equal(typeof state.onUpdate, 'function', 'hearing session exposes onUpdate');
  return { root, tools };
}

const decisions = () => state.events.filter((entry) => entry.type === 'voice.dedupe.decision');

async function until(predicate, label, timeoutMs = 3_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await sleep(10);
  }
  assert.fail(`timed out: ${label}`);
}

/** Feed one final through the real host callback and wait for its flush decision. */
async function finalAndWait(text, expected) {
  const before = decisions().length;
  assert.equal(typeof state.onUpdate, 'function', 'hearing session is live');
  state.onUpdate({ final: text, durationMs: 100 });
  await until(() => decisions().length === expected, `decision #${expected} after ${text.length} chars`);
  assert.equal(decisions().length, before + 1, 'exactly one decision per flush');
}

// ---------------------------------------------------------------------------
// 1) three finals -> three decisions, action/reasons follow the existing gate
// ---------------------------------------------------------------------------

test('three finals produce one decision each; action and reason match the existing gate', async (t) => {
  await mount(t);

  await finalAndWait(FINAL_15, 1);
  await finalAndWait(FINAL_19, 2);
  await finalAndWait(FINAL_19, 3);

  const [first, second, third] = decisions().map((entry) => entry.payload);

  // 15 chars: nothing earlier, delivered as the first final.
  assert.equal(first.mergedChars, 15);
  assert.equal(first.lastChars, 0);
  assert.equal(first.same, false);
  assert.equal(first.mergedContainsLast, false);
  assert.equal(first.lastContainsMerged, false);
  assert.equal(first.recent, false);
  assert.equal(first.matched, false);
  assert.equal(first.action, 'deliver');
  assert.equal(first.reason, 'first');
  assert.equal(first.repeats, 0);
  assert.equal(first.windowMs, 2500);
  assert.deepEqual(first.mergeDeltas, [15]);

  // 19 chars, distinct from the 15: still a new utterance, delivered.
  assert.equal(second.mergedChars, 19);
  assert.equal(second.lastChars, 15);
  assert.equal(second.same, false);
  assert.equal(second.mergedContainsLast, false);
  assert.equal(second.lastContainsMerged, false);
  assert.equal(second.recent, true);
  assert.equal(second.matched, false);
  assert.equal(second.action, 'deliver');
  assert.equal(second.reason, 'first');
  assert.equal(second.repeats, 0);
  assert.deepEqual(second.mergeDeltas, [19]);

  // The same 19 chars again, inside the window: dropped exactly like before this probe existed.
  assert.equal(third.mergedChars, 19);
  assert.equal(third.lastChars, 19);
  assert.equal(third.same, true);
  assert.equal(third.mergedContainsLast, true);
  assert.equal(third.lastContainsMerged, true);
  assert.equal(third.recent, true);
  assert.equal(third.matched, true);
  assert.equal(third.action, 'drop');
  assert.equal(third.reason, 'same');
  assert.equal(third.repeats, 1);
  assert.deepEqual(third.mergeDeltas, [19]);

  // The behaviour itself is untouched: the duplicate is still recorded and still swallowed.
  assert.equal(state.events.filter((entry) => entry.type === 'hearing.duplicate').length, 1);
  assert.equal(state.events.filter((entry) => entry.type === 'hearing.utterance').length, 2);
});

// ---------------------------------------------------------------------------
// 2) privacy: lengths and booleans only, never the transcript
// ---------------------------------------------------------------------------

test('the decision payload carries no transcript, only lengths and booleans', async (t) => {
  await mount(t);
  await finalAndWait(FINAL_15, 1);
  await finalAndWait(FINAL_19, 2);
  await finalAndWait(FINAL_19, 3);

  const KEYS = [
    'action', 'lastChars', 'lastContainsMerged', 'matched', 'mergeAppends', 'mergeDeltas',
    'mergeWindowMs', 'mergedChars', 'mergedContainsLast', 'reason', 'recent', 'repeats',
    'same', 'sessionId', 'windowMs',
  ];
  for (const { payload } of decisions()) {
    assert.deepEqual(Object.keys(payload).sort(), KEYS, 'the probe logs exactly its declared fields');
    const serialized = JSON.stringify(payload);
    assert.ok(!serialized.includes(FINAL_15), 'the 15-char transcript never appears');
    assert.ok(!serialized.includes(FINAL_19), 'the 19-char transcript never appears');
    for (const [key, value] of Object.entries(payload)) {
      if (key === 'sessionId' || key === 'action' || key === 'reason') {
        assert.equal(typeof value, 'string', `${key} is a short label`);
        continue;
      }
      if (key === 'mergeDeltas') {
        assert.ok(Array.isArray(value), 'mergeDeltas is a list');
        for (const delta of value) assert.equal(typeof delta, 'number', 'each delta is a number');
        continue;
      }
      assert.ok(typeof value === 'number' || typeof value === 'boolean', `${key} is a number or boolean`);
    }
  }
});

// ---------------------------------------------------------------------------
// 3) the documented off switch: runtime.dedupeProbe === true
// ---------------------------------------------------------------------------

test('runtime.dedupeProbe=true disables the probe without changing delivery', async (t) => {
  await mount(t, { settings: { dedupeProbe: true } });

  const utterances = () => state.events.filter((entry) => entry.type === 'hearing.utterance').length;
  const duplicates = () => state.events.filter((entry) => entry.type === 'hearing.duplicate').length;
  state.onUpdate({ final: FINAL_15, durationMs: 100 });
  await until(() => utterances() === 1, 'first final flushed');
  state.onUpdate({ final: FINAL_19, durationMs: 100 });
  await until(() => utterances() === 2, 'second final flushed');
  state.onUpdate({ final: FINAL_19, durationMs: 100 });
  // Wait until the duplicate of the third final has been judged by the real gate.
  await until(() => duplicates() === 1, 'the existing duplicate gate still ran');

  assert.equal(decisions().length, 0, 'no probe events while the off switch is set');
  // The old behaviour is fully intact: two utterances were heard, one duplicate dropped.
  assert.equal(utterances(), 2);
  assert.equal(duplicates(), 1);
});

// ---------------------------------------------------------------------------
// 4) concat bookkeeping: the merge happens before the decision
// ---------------------------------------------------------------------------

test('a merged round reports how many finals were concatenated and each delta', async (t) => {
  await mount(t, { mergeWindowMs: 60 });

  // All three arrive inside the merge window: the probe must show 3 appends on one decision.
  state.onUpdate({ final: FINAL_15, durationMs: 100 });
  state.onUpdate({ final: FINAL_19, durationMs: 100 });
  state.onUpdate({ final: FINAL_19, durationMs: 100 });
  await until(() => decisions().length === 1, 'one decision for the merged round');

  const [decision] = decisions().map((entry) => entry.payload);
  assert.equal(decision.mergedChars, 53, '15 + 19 + 19 chars reached flushMerged');
  assert.equal(decision.mergeAppends, 3, 'acceptFinal concatenated three finals');
  assert.deepEqual(decision.mergeDeltas, [15, 19, 19], 'each append delta is preserved');
  assert.equal(decision.lastChars, 0, 'first round of the session');
  assert.equal(decision.action, 'deliver');
  assert.equal(decision.reason, 'first');
});
