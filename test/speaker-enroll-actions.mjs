/**
 * 声纹登记 / 影子观测的宿主 action 接线（设置页「声纹」卡片的宿主侧）。
 *
 * The client already speaks one contract; the Host owns the data:
 *
 *   1. `speaker.enroll.list` — empty (`selfId:''`, no entries) and with collected samples; the read
 *      shape is `{speakerId,label,status,samples,totalDurationMs,confirmedAt}` and never creates the
 *      file;
 *   2. `speaker.enroll.confirm` — a pending voice under 3 s is refused with `insufficient-samples`
 *      and NOTHING is written; the same voice at >= 3 s becomes `confirmed` + `selfId`; an unknown
 *      id is `not-found`;
 *   3. `speaker.enroll.reject` / `speaker.enroll.remove` — the rejected row stays a visible
 *      tombstone, a sample can be pruned alone and the whole entry can be deleted;
 *   4. `speaker.status.shadow` — the three verdict counts (match/mismatch/unsure) and the last row
 *      (`decision/class/quality/score/speakerId/at`), from the existing `speaker.shadow` events;
 *   5. failure/bad data: a corrupt store file or malformed body never throws and never returns a
 *      filesystem path;
 *   6. events: every explicit write is recorded as `speaker.enroll.*` in events.jsonl;
 *   7. regression: node --check, speaker-enrollment / speaker-shadow / speaker-identity /
 *      lexicon-* / host-api and smoke.
 *
 * Nothing here confirms or rejects automatically: only an action call writes, and the shadow verdict
 * never reaches a gate, a rejection or delivery. No microphone, model, network or GUI is used.
 *
 * Run: node --test test/speaker-enroll-actions.mjs
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { ACTIONS, createRuntimeSettingsActions } from '../src/host/runtime/settings/system-actions.js';
import { cleanupRoot, disposeAll } from './helpers/cleanup.mjs';

const run = promisify(execFile);
const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const ENROLLMENT_FILE = join('data', 'speaker-enrollment.json');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const childEnv = { ...process.env };
delete childEnv.NODE_TEST_CONTEXT;
const runSuite = (file, args = []) => run(process.execPath, [...args, file], {
  cwd: PROJECT_ROOT,
  env: childEnv,
  maxBuffer: 64 * 1024 * 1024,
});

// ---------------------------------------------------------------------------
// Module seams: a recording hearing + a model downloader that is never asked
// ---------------------------------------------------------------------------

const state = { onUpdate: null, onEvent: null, starts: [] };
globalThis.__speakerEnrollTest = state;

const hearingUrl = new URL('../src/host/hearing/hearing.js', import.meta.url).href;
const modelDownloadUrl = new URL('../src/host/platform/modelDownload.js', import.meta.url).href;

const hook = registerHooks({
  load(url, context, next) {
    if (url === hearingUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    const s = globalThis.__speakerEnrollTest;
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
      return { device: options.device, stats: () => ({ rmsDb: -20 }), stop() {} };
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
    export const SPEAKER_MODEL_FILE = '3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx';
    export function speakerModelTarget({ modelDir = '', finalModelDir = '' } = {}) {
      const base = finalModelDir || modelDir;
      return base ? join(dirname(base), SPEAKER_MODEL_FILE) : '';
    }
    export function isSharedModelTarget(targetPath) {
      return typeof targetPath === 'string' && targetPath.length > 0
        && basename(dirname(resolve(targetPath))) === 'models';
    }
    export function vadModelTarget() { return ''; }
    export function ensureVadModel() { return Promise.reject(new Error('vad download forbidden')); }
    export function ensureSpeakerModel() {
      return Promise.reject(new Error('speaker download forbidden in this suite'));
    }`,
      };
    }
    return next(url, context);
  },
});
const { apply } = await import('../src/host/index.js');
hook.deregister();
after(() => { delete globalThis.__speakerEnrollTest; });

// ---------------------------------------------------------------------------
// Host mount + enrollment fixtures
// ---------------------------------------------------------------------------

async function newRoot() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-speaker-enroll-'));
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
  }));
  return root;
}

async function mount(root) {
  state.starts = [];
  state.onUpdate = null;
  state.onEvent = null;
  const cleanups = [];
  const tools = new Map();
  const routes = new Map();
  const effect = (fn) => {
    const cleanup = fn();
    if (typeof cleanup === 'function') cleanups.push(cleanup);
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
  }, { root, enabled: true, asrMergeWindowMs: 10 });

  const listen = tools.get('assistant_listen');
  assert.ok(listen !== undefined, 'assistant_listen is registered');
  const started = await listen.execute({ action: 'start' }, {});
  assert.equal(started.ok, true, `synthetic microphone started: ${started.error ?? ''}`);
  assert.equal(typeof state.onEvent, 'function', 'the hearing session exposes onEvent');

  const action = async (body) => {
    const handler = routes.get('/assistant/action');
    assert.equal(typeof handler, 'function', 'the action route is registered');
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
  const events = async () => readEvents(root);
  const waitForEvent = async (type, predicate = () => true) => {
    const startedAt = Date.now();
    for (;;) {
      const hit = (await events()).find((event) => event.type === type && predicate(event.payload ?? {}));
      if (hit !== undefined) return hit;
      if (Date.now() - startedAt > 4000) assert.fail(`timed out: ${type} event`);
      await delay(10);
    }
  };
  return {
    root,
    action,
    status,
    events,
    waitForEvent,
    /** Feed one `speaker.shadow` row exactly as hearing would emit it. */
    shadow: (payload) => state.onEvent('speaker.shadow', payload),
    close: () => disposeAll(cleanups.splice(0)),
  };
}

const enrollmentState = (entries = [], selfId = '') => ({ version: 1, selfId, updatedAt: '', entries });

const entryOf = ({
  speakerId,
  label = '',
  status = 'pending',
  samples = [],
  createdAt = '2026-11-09T03:00:00.000Z',
  confirmedAt = null,
  modelVersion = '',
}) => ({ speakerId, label, status, samples, createdAt, confirmedAt, modelVersion });

const sampleOf = (id, durationMs, at = '2026-11-09T03:00:00.000Z') => ({ id, durationMs, at, source: 'mic' });

const writeEnrollment = (root, data) => writeFile(
  join(root, ENROLLMENT_FILE),
  `${JSON.stringify(data, null, 2)}\n`,
  'utf8',
);
const readEnrollment = async (root) => JSON.parse(await readFile(join(root, ENROLLMENT_FILE), 'utf8'));

async function readEvents(root) {
  try {
    const text = await readFile(join(root, 'data', 'events.jsonl'), 'utf8');
    return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 1. list: empty and with samples
// ---------------------------------------------------------------------------

test('1) speaker.enroll.list：空登记 / 有样本，读取不建文件', async (t) => {
  for (const name of [
    'speaker.enroll.list', 'speaker.enroll.confirm', 'speaker.enroll.reject',
    'speaker.enroll.remove', 'speaker.status.shadow',
  ]) {
    assert.ok(ACTIONS.includes(name), `${name} is a registered host action`);
  }

  const root = await newRoot();
  const host = await mount(root);
  t.after(async () => { await host.close(); await cleanupRoot(root); });

  const empty = await host.action({ action: 'speaker.enroll.list' });
  assert.deepEqual(empty, { ok: true, selfId: '', entries: [] });
  assert.equal(await exists(join(root, ENROLLMENT_FILE)), false, 'a read never creates the store');

  await writeEnrollment(root, enrollmentState([entryOf({
    speakerId: 'self-lin',
    label: '本人',
    samples: [sampleOf('smp-1', 2000), sampleOf('smp-2', 1200, '2026-11-09T03:00:10.000Z')],
  })]));

  const listed = await host.action({ action: 'speaker.enroll.list' });
  assert.equal(listed.ok, true);
  assert.equal(listed.selfId, '');
  assert.deepEqual(listed.entries, [{
    speakerId: 'self-lin',
    label: '本人',
    status: 'pending',
    samples: 2,
    totalDurationMs: 3200,
    confirmedAt: '',
  }]);
  console.log(`[1] empty=0 entries=1 samples=${listed.entries[0].samples} total=${listed.entries[0].totalDurationMs}ms`);
});

// ---------------------------------------------------------------------------
// 2. confirm: the 3-second rule + success
// ---------------------------------------------------------------------------

test('2) speaker.enroll.confirm：样本<3s → insufficient-samples；≥3s → confirmed + selfId', async (t) => {
  const root = await newRoot();
  const host = await mount(root);
  t.after(async () => { await host.close(); await cleanupRoot(root); });

  await writeEnrollment(root, enrollmentState([
    entryOf({ speakerId: 'shorty', label: '太短', samples: [sampleOf('smp-1', 1200)] }),
    entryOf({
      speakerId: 'self-lin',
      label: '本人',
      samples: [sampleOf('smp-1', 2000), sampleOf('smp-2', 1600, '2026-11-09T03:00:10.000Z')],
    }),
  ]));

  const insufficient = await host.action({ action: 'speaker.enroll.confirm', speakerId: 'shorty' });
  assert.deepEqual(insufficient, {
    ok: false, speakerId: 'shorty', reason: 'insufficient-samples',
  });
  let saved = await readEnrollment(root);
  assert.equal(saved.entries.find((entry) => entry.speakerId === 'shorty').status, 'pending');
  assert.equal(saved.selfId, '', 'a refused confirm writes nothing');

  const missing = await host.action({ action: 'speaker.enroll.confirm', speakerId: 'ghost' });
  assert.deepEqual(missing, { ok: false, speakerId: 'ghost', reason: 'not-found' });

  const confirmed = await host.action({ action: 'speaker.enroll.confirm', speakerId: 'self-lin' });
  assert.deepEqual(confirmed, { ok: true, speakerId: 'self-lin' });
  saved = await readEnrollment(root);
  const entry = saved.entries.find((row) => row.speakerId === 'self-lin');
  assert.equal(entry.status, 'confirmed');
  assert.equal(saved.selfId, 'self-lin');
  assert.ok(Number.isFinite(Date.parse(entry.confirmedAt)), 'confirmedAt is an ISO instant');

  const listed = await host.action({ action: 'speaker.enroll.list' });
  assert.equal(listed.selfId, 'self-lin');
  assert.equal(listed.entries.find((row) => row.speakerId === 'self-lin').status, 'confirmed');
  console.log(`[2] insufficient=${insufficient.reason} confirmed=${confirmed.ok} selfId=${saved.selfId}`);
});

// ---------------------------------------------------------------------------
// 3. reject / remove
// ---------------------------------------------------------------------------

test('3) speaker.enroll.reject / remove：拒绝留墓碑、单样本删除、整条删除', async (t) => {
  const root = await newRoot();
  const host = await mount(root);
  t.after(async () => { await host.close(); await cleanupRoot(root); });

  await writeEnrollment(root, enrollmentState([
    entryOf({
      speakerId: 'bob',
      label: '朋友',
      samples: [sampleOf('smp-1', 2000), sampleOf('smp-2', 2000, '2026-11-09T03:00:10.000Z')],
    }),
    entryOf({ speakerId: 'carol', label: '同事', samples: [sampleOf('smp-1', 4000)] }),
  ]));

  const rejected = await host.action({ action: 'speaker.enroll.reject', speakerId: 'bob' });
  assert.deepEqual(rejected, { ok: true, speakerId: 'bob' });
  let saved = await readEnrollment(root);
  assert.equal(saved.entries.find((row) => row.speakerId === 'bob').status, 'rejected');
  const afterReject = await host.action({ action: 'speaker.enroll.list' });
  assert.equal(afterReject.entries.find((row) => row.speakerId === 'bob').status, 'rejected',
    'the rejected tombstone stays visible so the user can delete it');

  assert.deepEqual(
    await host.action({ action: 'speaker.enroll.reject', speakerId: 'ghost' }),
    { ok: false, speakerId: 'ghost', reason: 'not-found' },
  );

  const pruned = await host.action({ action: 'speaker.enroll.remove', speakerId: 'carol', sampleId: 'smp-1' });
  assert.deepEqual(pruned, { ok: true, speakerId: 'carol', sampleId: 'smp-1' });
  saved = await readEnrollment(root);
  assert.deepEqual(saved.entries.find((row) => row.speakerId === 'carol').samples, []);
  assert.deepEqual(
    await host.action({ action: 'speaker.enroll.remove', speakerId: 'carol', sampleId: 'smp-9' }),
    { ok: false, speakerId: 'carol', reason: 'sample-not-found' },
  );

  const removed = await host.action({ action: 'speaker.enroll.remove', speakerId: 'carol' });
  assert.deepEqual(removed, { ok: true, speakerId: 'carol' });
  saved = await readEnrollment(root);
  assert.equal(saved.entries.some((row) => row.speakerId === 'carol'), false);
  assert.deepEqual(
    await host.action({ action: 'speaker.enroll.remove', speakerId: 'carol' }),
    { ok: false, speakerId: 'carol', reason: 'not-found' },
  );

  const finalList = await host.action({ action: 'speaker.enroll.list' });
  assert.deepEqual(finalList.entries.map((row) => [row.speakerId, row.status]), [['bob', 'rejected']]);
  console.log(`[3] rejected=bob pruned=carol remains=${finalList.entries.length}`);
});

// ---------------------------------------------------------------------------
// 4. shadow aggregation
// ---------------------------------------------------------------------------

test('4) speaker.status.shadow：match/mismatch/unsure 计数 + lastShadow 全字段', async (t) => {
  const root = await newRoot();
  const host = await mount(root);
  t.after(async () => { await host.close(); await cleanupRoot(root); });

  const initial = await host.action({ action: 'speaker.status.shadow' });
  assert.deepEqual(initial, {
    ok: true,
    lastShadow: null,
    counts: { match: 0, mismatch: 0, unsure: 0 },
  });

  host.shadow({ decision: 'match', class: 'self', quality: 'ok', score: 0.91, speakerId: 'self-lin' });
  host.shadow({ decision: 'mismatch', class: 'other', quality: 'short', score: 0.12, speakerId: 'bob' });
  host.shadow({ decision: 'unsure', class: 'unknown-identity', quality: 'quiet', score: 0.45 });
  host.shadow({ decision: 'no-speakers', class: 'unknown-identity', quality: 'short' });
  host.shadow({ decision: 'match', class: 'self', quality: 'ok', score: 0.88, speakerId: 'self-lin' });

  const shadow = await host.action({ action: 'speaker.status.shadow' });
  assert.deepEqual(shadow.counts, { match: 2, mismatch: 1, unsure: 1 });
  assert.deepEqual(Object.keys(shadow.counts).sort(), ['match', 'mismatch', 'unsure']);
  assert.equal(shadow.lastShadow.decision, 'match');
  assert.equal(shadow.lastShadow.class, 'self');
  assert.equal(shadow.lastShadow.quality, 'ok');
  assert.equal(shadow.lastShadow.score, 0.88);
  assert.equal(shadow.lastShadow.speakerId, 'self-lin');
  assert.ok(Number.isFinite(Date.parse(shadow.lastShadow.at)), 'at is an ISO instant the card can show');

  const status = await host.status();
  assert.equal(status.speaker.matches, 2, 'the legacy status aggregate still sees matches');
  assert.equal(status.speaker.unsure, 1);
  assert.equal(status.speaker.noSpeakers, 1);
  assert.equal(await exists(join(root, ENROLLMENT_FILE)), false, 'shadow observation never writes');
  console.log(`[4] counts=${JSON.stringify(shadow.counts)} last=${shadow.lastShadow.decision}/${shadow.lastShadow.class}/${shadow.lastShadow.quality}/${shadow.lastShadow.score}`);
});

// ---------------------------------------------------------------------------
// 5. failure / bad data never throws and never leaks a path
// ---------------------------------------------------------------------------

test('5) 失败与坏数据：不抛、不泄露路径、受控 reason', async (t) => {
  const root = await newRoot();
  const host = await mount(root);
  t.after(async () => { await host.close(); await cleanupRoot(root); });

  await writeFile(join(root, ENROLLMENT_FILE), '{"version": 999, "entries": []}\n', 'utf8');
  const badVersion = await host.action({ action: 'speaker.enroll.list' });
  assert.deepEqual(badVersion, { ok: true, selfId: '', entries: [] });
  assert.equal(JSON.stringify(badVersion).includes(root), false, 'no path in the reply');

  await writeFile(join(root, ENROLLMENT_FILE), JSON.stringify({
    version: 1,
    selfId: '',
    entries: [{
      speakerId: 'bad',
      status: 'pending',
      samples: [{ id: 'smp-1', durationMs: 0, at: '2026-11-09T03:00:00.000Z', source: 'mic' }],
    }],
  }), 'utf8');
  const badSample = await host.action({ action: 'speaker.enroll.list' });
  assert.deepEqual(badSample, { ok: true, selfId: '', entries: [] });

  await writeFile(join(root, ENROLLMENT_FILE), 'not json at all\n', 'utf8');
  const badJson = await host.action({ action: 'speaker.enroll.list' });
  assert.deepEqual(badJson, { ok: true, selfId: '', entries: [] });
  assert.equal(JSON.stringify(badJson).includes(root), false);

  assert.deepEqual(
    await host.action({ action: 'speaker.enroll.confirm' }),
    { ok: false, speakerId: '', reason: 'speaker-required' },
  );
  assert.deepEqual(
    await host.action({ action: 'speaker.enroll.remove', sampleId: 'smp-1' }),
    { ok: false, speakerId: '', reason: 'speaker-required' },
  );

  // A store that throws on every call: the action turns it into a controlled reason.
  const secret = join(root, ENROLLMENT_FILE);
  const throwing = {
    list() { throw new Error(`EACCES ${secret}`); },
    getConfirmedSelf() { throw new Error(`EACCES ${secret}`); },
    confirm() { throw new Error(`EACCES ${secret}`); },
    reject() { throw new Error(`EACCES ${secret}`); },
    removeEntry() { throw new Error(`EACCES ${secret}`); },
    removeSample() { throw new Error(`EACCES ${secret}`); },
  };
  const guarded = createRuntimeSettingsActions({ speakerEnrollmentStore: throwing });
  for (const [body, reason] of [
    [{ action: 'speaker.enroll.list' }, 'read-failed'],
    [{ action: 'speaker.enroll.confirm', speakerId: 'a' }, 'write-failed'],
    [{ action: 'speaker.enroll.reject', speakerId: 'a' }, 'write-failed'],
    [{ action: 'speaker.enroll.remove', speakerId: 'a' }, 'write-failed'],
    [{ action: 'speaker.enroll.remove', speakerId: 'a', sampleId: 'smp-1' }, 'write-failed'],
  ]) {
    const result = await guarded(body);
    assert.equal(result.ok, false, `${body.action} fails cleanly`);
    assert.equal(result.reason, reason);
    assert.equal(JSON.stringify(result).includes(secret), false, 'a throwing store never leaks its path');
  }

  const absent = createRuntimeSettingsActions({});
  for (const body of [
    { action: 'speaker.enroll.list' },
    { action: 'speaker.enroll.confirm', speakerId: 'a' },
    { action: 'speaker.enroll.reject', speakerId: 'a' },
    { action: 'speaker.enroll.remove', speakerId: 'a' },
    { action: 'speaker.status.shadow' },
  ]) {
    const result = await absent(body);
    assert.deepEqual(result.reason, 'unavailable', `${body.action} refuses without a store`);
  }
  console.log('[5] badVersion/badSample/badJson=[] throwing=controlled absent=unavailable pathLeak=0');
});

// ---------------------------------------------------------------------------
// 6. events
// ---------------------------------------------------------------------------

test('6) 事件：speaker.enroll.* 写入 events.jsonl，且不写路径', async (t) => {
  const root = await newRoot();
  const host = await mount(root);
  t.after(async () => { await host.close(); await cleanupRoot(root); });

  await writeEnrollment(root, enrollmentState([
    entryOf({
      speakerId: 'self-lin',
      label: '本人',
      samples: [sampleOf('smp-1', 2000), sampleOf('smp-2', 2000, '2026-11-09T03:00:10.000Z')],
    }),
    entryOf({
      speakerId: 'bob',
      label: '朋友',
      samples: [sampleOf('smp-1', 2000), sampleOf('smp-2', 2000, '2026-11-09T03:00:10.000Z')],
    }),
    entryOf({ speakerId: 'tiny', label: '太短', samples: [sampleOf('smp-1', 900)] }),
  ]));

  await host.action({ action: 'speaker.enroll.confirm', speakerId: 'tiny' });
  await delay(60);
  assert.equal(
    (await host.events()).filter((event) => event.type === 'speaker.enroll.confirmed').length, 0,
    'a refused confirm writes no confirmed event',
  );

  await host.action({ action: 'speaker.enroll.confirm', speakerId: 'self-lin' });
  const confirmed = await host.waitForEvent('speaker.enroll.confirmed', (payload) => payload.speakerId === 'self-lin');
  assert.equal(confirmed.payload.sampleCount, 2);
  assert.equal(confirmed.payload.totalDurationMs, 4000);

  await host.action({ action: 'speaker.enroll.reject', speakerId: 'bob' });
  const rejected = await host.waitForEvent('speaker.enroll.rejected');
  assert.equal(rejected.payload.speakerId, 'bob');

  await host.action({ action: 'speaker.enroll.remove', speakerId: 'self-lin', sampleId: 'smp-2' });
  const sampleRemoved = await host.waitForEvent('speaker.enroll.removed', (payload) => payload.kind === 'sample');
  assert.equal(sampleRemoved.payload.speakerId, 'self-lin');
  assert.equal(sampleRemoved.payload.sampleId, 'smp-2');

  await host.action({ action: 'speaker.enroll.remove', speakerId: 'bob' });
  const entryRemoved = await host.waitForEvent('speaker.enroll.removed', (payload) => payload.kind === 'entry');
  assert.equal(entryRemoved.payload.speakerId, 'bob');

  const rows = (await host.events()).filter((event) => event.type.startsWith('speaker.enroll.'));
  assert.deepEqual(rows.map((event) => event.type).sort(), [
    'speaker.enroll.confirmed', 'speaker.enroll.rejected',
    'speaker.enroll.removed', 'speaker.enroll.removed',
  ]);
  for (const row of rows) {
    assert.equal(JSON.stringify(row.payload).includes(root), false, `${row.type} carries no path`);
  }
  console.log(`[6] confirmed=1 rejected=1 removed=2 pathLeak=0`);
});

// ---------------------------------------------------------------------------
// 7. Regression
// ---------------------------------------------------------------------------

test('7) 回归：node --check、speaker-* / lexicon-* / host-api / smoke', async (t) => {
  t.timeout = 900_000;
  for (const file of [
    'src/host/index.js',
    'src/host/hearing/speaker-enrollment.js',
    'src/host/runtime/settings/system-actions.js',
    'test/speaker-enroll-actions.mjs',
  ]) {
    await assert.doesNotReject(runSuite(join(PROJECT_ROOT, file), ['--check']), `${file} parses`);
  }

  const testDir = join(PROJECT_ROOT, 'test');
  const names = await readdir(testDir);
  const suites = names
    .filter((name) => ['speaker-enrollment.mjs', 'speaker-shadow.mjs', 'speaker-identity.mjs', 'host-api.mjs']
      .includes(name) || /^lexicon-.*\.mjs$/u.test(name))
    .sort()
    .map((name) => join(testDir, name));
  assert.ok(suites.length >= 10, `found the speaker/lexicon/host suites: ${suites.length}`);

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
  console.log(`[7] node --check=ok suites=${suites.length} smoke=ok`);
});
