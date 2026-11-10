/**
 * 声纹候选 → 基础声纹：宿主动作 + 设置页 UI 的验收测试。
 *
 *   1. `speaker.candidates.list / audio / preview` 只读：数量/分组、WAV data URL、一致性证据，
 *      不建库、不写登记、不确认；
 *   2. `remove / clear` 删除候选与试听音频；
 *   3. 不一致候选与总时长不足 3 秒都明确拒绝，且不留下任何库/登记/self；
 *   4. `build` 成功后：同一个 `<root>/memory/speaker.db` 里有 self 模板、登记有 3 条样本并确认，
 *      selfId 只在这一次显式动作后才出现；
 *   5. `rename` 只改库显示名称，speakerId 不变，重新打开库仍可见；空/超长名称被拒绝；
 *   6. 失败回滚：库 SQLite 已写入后登记确认失败 → 库行回滚、登记恢复快照，不留半套数据；
 *   7. 静态 UI：候选数/分组、试听、勾选、删除、清空、预览、建立、重命名、提示文案与动作名。
 *   8. 运行中开关声纹影子：当前监听补挂/摘除候选回调；隐私期拒绝收集，且不自动确认 self 或建模板。
 *
 * 不需要真实麦克风、模型、网络或 GUI。
 *
 * Run: node --test test/speaker-candidate-ui-host.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

import {
  SPEAKER_CANDIDATE_SAFE_VIEW_FIELDS,
  createSpeakerCandidateActions,
} from '../src/host/hearing/speaker-candidate-actions.js';
import {
  createSpeakerCandidatesStore,
  decodeEmbedding,
  encodeEmbedding,
} from '../src/host/hearing/speaker-candidates.js';
import { createSpeakerEnrollmentStore } from '../src/host/hearing/speaker-enrollment.js';
import { buildSpeakerTemplate } from '../src/host/hearing/speaker-template.js';
import { createSpeakerLibrary } from '../src/host/hearing/speakerVoice.js';
import { createHearingSettingsActions } from '../src/host/hearing/settings-actions.js';
import { disposeAll } from './helpers/cleanup.mjs';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CANDIDATE_DIR = join('cache', 'speaker-candidates');
const ENROLLMENT_FILE = join('data', 'speaker-enrollment.json');

// ---------------------------------------------------------------------------
// Hearing seam: record the options (the shared library must be passed in)
// ---------------------------------------------------------------------------

const state = { starts: [] };
globalThis.__speakerCandidateUiHostTest = state;

const hearingUrl = new URL('../src/host/hearing/hearing.js', import.meta.url).href;
const hook = registerHooks({
  load(url, context, next) {
    if (url === hearingUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    const s = globalThis.__speakerCandidateUiHostTest;
    export const modelReady = () => true;
    export const finalModelReady = () => true;
    export const isLoopbackDevice = (name) => /CABLE|Stereo Mix|Virtual/i.test(String(name));
    export const selectMicrophoneDevice = (devices, requested) => ({
      device: requested || devices[0] || '', loopback: false, error: '',
    });
    export const listDevices = async () => ['Fake Mic'];
    export const startHearing = (options) => {
      s.starts.push(options);
      return {
        device: options.device,
        instanceId: 'mock-speaker-candidate-ui',
        stats: () => ({ rmsDb: -20 }),
        stop() {},
      };
    };
    export const watchHearingExit = () => {};
    export const annotateTranscript = (text) => text;
    export const joinDetailFields = () => ({});
    export const mergeJoinFallback = () => ({});
    export const offlineLimitedNote = () => '';
    export const truncationNotice = () => '';`,
      };
    }
    return next(url, context);
  },
});
const { apply } = await import('../src/host/index.js');
hook.deregister();
after(() => { delete globalThis.__speakerCandidateUiHostTest; });

// ---------------------------------------------------------------------------
// Fixtures / mount
// ---------------------------------------------------------------------------

const TOLERANCE = 1e-6;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `predicate()` is true; a missed deadline fails the test instead of hanging it. */
async function until(predicate, label, timeoutMs = 4000) {
  const startedAt = Date.now();
  while (!(await predicate())) {
    if (Date.now() - startedAt > timeoutMs) assert.fail(`timed out: ${label}`);
    await delay(10);
  }
}

function close(actual, expected, message, tolerance = TOLERANCE) {
  assert.ok(
    Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
    `${message}: expected ${expected}, got ${actual}`,
  );
}

function cosine(left, right) {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function candidateSpec(id, { durationMs = 1200, embedding = [1, 0, 0], text = '候选正文' } = {}) {
  return { id, durationMs, embedding, text };
}

/** Write the candidate JSON + WAV bytes the host will read; absolute paths are rewritten. */
async function writeCandidates(root, specs) {
  const audioDir = join(root, CANDIDATE_DIR);
  await mkdir(audioDir, { recursive: true });
  const at = new Date(Date.now() - 60_000).toISOString();
  const candidates = [];
  for (const spec of specs) {
    const audioPath = join(audioDir, `${spec.id}.wav`);
    await writeFile(audioPath, Buffer.alloc(240, 0x5a));
    candidates.push({
      id: spec.id,
      utteranceId: `utt-${spec.id}`,
      speakerId: null,
      embedding: encodeEmbedding(spec.embedding),
      durationMs: spec.durationMs,
      at,
      source: 'mic',
      quality: 'ok',
      text: spec.text,
      audioPath,
      status: 'pending',
      groupId: null,
    });
  }
  await writeFile(
    join(root, 'data', 'speaker-candidates.json'),
    `${JSON.stringify({ version: 1, updatedAt: '', candidates }, null, 2)}\n`,
    'utf8',
  );
  return candidates;
}

async function newRoot(settings = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-speaker-candidate-ui-host-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await mkdir(join(root, 'workspace'), { recursive: true });
  await writeFile(join(root, 'data', 'features.json'), JSON.stringify({
    hearing: true, ambient: false, voice: false, vision: false,
    subtitle: false, avatar: false, memory: false, fastpath: false,
  }));
  await writeFile(join(root, 'data', 'settings.json'), JSON.stringify({
    langs: { speech: 'zh', subtitle: 'zh' },
    autoMemory: { enabled: false },
    voice: { chunking: false, speakerShadow: true, ...(settings.voice ?? {}) },
    ...settings,
  }));
  return root;
}

async function readEvents(root) {
  try {
    const text = await readFile(join(root, 'data', 'events.jsonl'), 'utf8');
    return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function mount(root) {
  state.starts = [];
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
  }, {
    root,
    enabled: true,
    asrMergeWindowMs: 10,
    speakerModelStartup: false,
    speakerModelDownload: async () => ({ ok: false, reason: 'test-double' }),
  });

  const listen = tools.get('assistant_listen');
  assert.ok(listen !== undefined, 'assistant_listen is registered');

  const start = async () => listen.execute({ action: 'start' }, {});
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
  let disposed = false;
  const close = async () => {
    if (disposed) return;
    disposed = true;
    const failures = await disposeAll(cleanups);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'dispose failed');
  };
  return { root, start, action, status, close };
}

async function withHost(t, specs) {
  const root = await newRoot();
  const candidates = await writeCandidates(root, specs);
  const host = await mount(root);
  t.after(async () => {
    await host.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  return { ...host, candidates };
}

function libraryOf(root) {
  return createSpeakerLibrary({ root });
}

async function libraryRows(root) {
  const library = libraryOf(root);
  try {
    return library.list();
  } finally {
    library.close();
  }
}

async function enrollmentState(root) {
  try {
    return JSON.parse(await readFile(join(root, ENROLLMENT_FILE), 'utf8'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 1. list / audio / preview are read-only
// ---------------------------------------------------------------------------

test('1) list/audio/preview：只读、无路径/embedding、data URL、一致性证据', async (t) => {
  const host = await withHost(t, [
    candidateSpec('spc-1', { embedding: [1, 0, 0] }),
    candidateSpec('spc-2', { embedding: [0.9, 0.1, 0] }),
    candidateSpec('spc-3', { embedding: [0.95, 0.05, 0] }),
  ]);
  const started = await host.start();
  assert.equal(started.ok, true, started.error ?? '');
  const options = state.starts.at(-1);
  assert.ok(options !== undefined, 'startHearing received options');
  assert.equal(typeof options.speakerLibrary?.get, 'function',
    'the Host passes its one shared SpeakerLibrary into hearing');
  assert.equal(options.speakerLibrary.root, host.root,
    'hearing borrows the Host instance rooted at the same directory');

  const listed = await host.action({ action: 'speaker.candidates.list' });
  assert.equal(listed.ok, true);
  assert.equal(listed.count, 3);
  assert.equal(listed.groupCount, 1, 'the three similar clips form one group');
  assert.equal(listed.selfId, '', 'listing never creates a self');
  assert.deepEqual(listed.library, {
    present: false, speakerId: 'self', label: '', enabled: false, activeCount: 0, dim: 0,
  });
  assert.equal(listed.candidates.length, 3);
  for (const candidate of listed.candidates) {
    assert.deepEqual(Object.keys(candidate).sort(), [...SPEAKER_CANDIDATE_SAFE_VIEW_FIELDS].sort());
  }
  const listJson = JSON.stringify(listed);
  assert.equal(listJson.includes(host.root), false, 'no absolute path crosses the action seam');
  assert.equal(listJson.includes('embedding'), false);
  assert.equal(listJson.includes('audioPath'), false);

  const audio = await host.action({ action: 'speaker.candidates.audio', id: 'spc-1' });
  assert.equal(audio.ok, true);
  assert.equal(audio.mime, 'audio/wav');
  assert.match(audio.dataUrl, /^data:audio\/wav;base64,/u);
  assert.equal(Buffer.from(audio.base64, 'base64').length, audio.bytes);
  assert.ok(audio.bytes > 0);
  assert.equal(JSON.stringify(audio).includes(host.root), false);
  assert.deepEqual(
    await host.action({ action: 'speaker.candidates.audio', id: 'ghost' }),
    { ok: false, reason: 'not-found', id: 'ghost' },
  );

  const preview = await host.action({
    action: 'speaker.candidates.preview',
    ids: ['spc-1', 'spc-2', 'spc-3'],
  });
  assert.equal(preview.ok, true);
  assert.equal(preview.sampleCount, 3);
  assert.equal(preview.totalDurationMs, 3600);
  assert.ok(preview.minPairCosine >= 0.72);
  assert.equal('vector' in preview, false, 'the template vector never reaches the card');

  assert.equal(await enrollmentState(host.root), null, 'reads never create the enrollment file');
  assert.deepEqual(await libraryRows(host.root), [], 'reads never create a template');
  const events = await readEvents(host.root);
  for (const type of ['speaker.enroll.confirmed', 'speaker.candidates.built']) {
    assert.equal(events.some((event) => event.type === type), false, `${type} is not automatic`);
  }
  console.log(`[1] count=${listed.count} groups=${listed.groupCount} audio=${audio.bytes}B preview=${preview.totalDurationMs}ms`);
});

// ---------------------------------------------------------------------------
// 2. remove / clear
// ---------------------------------------------------------------------------

test('2) remove/clear：删候选与试听音频，库与登记不受影响', async (t) => {
  const host = await withHost(t, [
    candidateSpec('spc-1'),
    candidateSpec('spc-2', { embedding: [0.9, 0.1, 0] }),
    candidateSpec('spc-3', { embedding: [0.95, 0.05, 0] }),
  ]);
  const audioFile = join(host.root, CANDIDATE_DIR, 'spc-2.wav');

  const removed = await host.action({ action: 'speaker.candidates.remove', id: 'spc-2' });
  assert.deepEqual(removed, {
    ok: true, id: 'spc-2', removed: 1, audioDeleted: true, audioFailed: false,
  });
  assert.equal(existsSync(audioFile), false, 'the candidate audio was unlinked');
  let listed = await host.action({ action: 'speaker.candidates.list' });
  assert.equal(listed.count, 2);
  assert.deepEqual(
    await host.action({ action: 'speaker.candidates.remove', id: 'spc-2' }),
    { ok: false, reason: 'not-found' },
  );

  const cleared = await host.action({ action: 'speaker.candidates.clear' });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.removed, 2);
  assert.equal(cleared.audioDeleted, 2);
  listed = await host.action({ action: 'speaker.candidates.list' });
  assert.equal(listed.count, 0);
  const files = (await readdir(join(host.root, CANDIDATE_DIR))).filter((name) => name.endsWith('.wav'));
  assert.deepEqual(files, []);
  assert.equal(await enrollmentState(host.root), null, 'removing candidates never confirms anything');
  assert.deepEqual(await libraryRows(host.root), []);
  console.log(`[2] removed=${removed.removed} cleared=${cleared.removed} wavLeft=${files.length}`);
});

// ---------------------------------------------------------------------------
// 3. inconsistent / insufficient: no writes
// ---------------------------------------------------------------------------

test('3) 不一致与不足 3 秒：返回原因/outliers，不写库不写登记', async (t) => {
  const host = await withHost(t, [
    candidateSpec('spc-1', { durationMs: 1500, embedding: [1, 0, 0] }),
    candidateSpec('spc-2', { durationMs: 1500, embedding: [0, 1, 0] }),
  ]);

  const inconsistent = await host.action({
    action: 'speaker.candidates.build',
    ids: ['spc-1', 'spc-2'],
    label: '不一致',
  });
  assert.equal(inconsistent.ok, false);
  assert.equal(inconsistent.reason, 'inconsistent');
  assert.deepEqual([...inconsistent.outlierIds].sort(), ['spc-1', 'spc-2']);
  assert.equal(await enrollmentState(host.root), null);
  assert.deepEqual(await libraryRows(host.root), []);

  await writeCandidates(host.root, [
    candidateSpec('spc-3', { durationMs: 1000, embedding: [1, 0, 0] }),
    candidateSpec('spc-4', { durationMs: 1000, embedding: [0.9, 0.1, 0] }),
  ]);
  const short = await host.action({
    action: 'speaker.candidates.build',
    ids: ['spc-3', 'spc-4'],
    label: '太短',
  });
  assert.deepEqual(short, {
    ok: false,
    reason: 'insufficient-samples',
    sampleCount: 2,
    totalDurationMs: 2000,
    requiredMs: 3000,
  });
  assert.equal(await enrollmentState(host.root), null, 'a too-short set writes nothing');
  assert.deepEqual(await libraryRows(host.root), []);
  console.log(`[3] inconsistent=${inconsistent.outlierIds.join(',')} short=${short.totalDurationMs}ms`);
});

// ---------------------------------------------------------------------------
// 4. build success + rename persistence
// ---------------------------------------------------------------------------

test('4) build：库+登记+self 一次成立；rename 只改名称并持久化', async (t) => {
  const specs = [
    candidateSpec('spc-1', { embedding: [1, 0, 0] }),
    candidateSpec('spc-2', { embedding: [0.9, 0.1, 0] }),
    candidateSpec('spc-3', { embedding: [0.95, 0.05, 0] }),
  ];
  const host = await withHost(t, specs);
  const ids = specs.map((spec) => spec.id);

  const built = await host.action({
    action: 'speaker.candidates.build',
    ids,
    label: '基础声纹',
  });
  assert.equal(built.ok, true, `${built.reason ?? ''}`);
  assert.equal(built.speakerId, 'self');
  assert.equal(built.selfId, 'self', 'selfId appears only after the explicit build');
  assert.equal(built.sampleCount, 3);
  assert.equal(built.totalDurationMs, 3600);
  assert.equal(built.created, true);
  assert.equal(built.library.present, true);
  assert.equal(built.library.label, '基础声纹');
  assert.equal(built.library.enabled, true);

  const enrollment = await enrollmentState(host.root);
  assert.ok(enrollment !== null);
  assert.equal(enrollment.selfId, 'self');
  const entry = enrollment.entries.find((row) => row.speakerId === 'self');
  assert.ok(entry !== undefined);
  assert.equal(entry.status, 'confirmed');
  assert.equal(entry.samples.length, 3);
  assert.equal(entry.samples.reduce((sum, sample) => sum + sample.durationMs, 0), 3600);
  for (const sample of entry.samples) {
    assert.ok(['spc-1', 'spc-2', 'spc-3'].includes(sample.sampleId), 'each sample references a candidate id');
  }

  const library = libraryOf(host.root);
  try {
    const row = library.get('self');
    assert.ok(row !== null);
    assert.equal(row.label, '基础声纹');
    assert.equal(row.enabled, true);
    assert.equal(row.activeCount, 1);
    assert.equal(row.embedding.length, 3);
    const expected = buildSpeakerTemplate(specs.map((spec) => ({
      id: spec.id,
      embedding: Float32Array.from(spec.embedding),
      durationMs: spec.durationMs,
    })));
    assert.equal(expected.ok, true);
    close(cosine(row.embedding, expected.vector), 1, 'library template direction matches the candidates', 1e-4);
  } finally {
    library.close();
  }

  const afterBuild = await host.action({ action: 'speaker.candidates.list' });
  assert.equal(afterBuild.selfId, 'self');
  assert.equal(afterBuild.library.present, true);
  assert.equal(afterBuild.library.label, '基础声纹');
  assert.equal(afterBuild.count, 3, 'building does not silently delete the candidates');

  const renamed = await host.action({ action: 'speaker.rename', label: '我的声音' });
  assert.equal(renamed.ok, true, renamed.reason ?? '');
  assert.equal(renamed.speakerId, 'self', 'rename never changes the speakerId');
  assert.equal(renamed.label, '我的声音');
  assert.equal(renamed.library.label, '我的声音');
  const renamedList = await host.action({ action: 'speaker.candidates.list' });
  assert.equal(renamedList.library.label, '我的声音');

  const reopened = libraryOf(host.root);
  try {
    const row = reopened.get('self');
    assert.equal(row.speakerId, 'self');
    assert.equal(row.label, '我的声音', 'the new label survives a fresh connection');
  } finally {
    reopened.close();
  }

  assert.deepEqual(
    await host.action({ action: 'speaker.rename', label: '' }),
    { ok: false, reason: 'label-required', speakerId: 'self' },
  );
  const tooLong = await host.action({ action: 'speaker.rename', label: 'x'.repeat(41) });
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.reason, 'label-too-long');
  assert.equal(tooLong.max, 40);
  assert.deepEqual(
    await host.action({ action: 'speaker.rename', speakerId: 'ghost', label: 'x' }),
    { ok: false, reason: 'not-found', speakerId: 'ghost' },
  );

  const events = await readEvents(host.root);
  assert.equal(events.filter((event) => event.type === 'speaker.enroll.confirmed').length, 1);
  assert.equal(events.filter((event) => event.type === 'speaker.candidates.built').length, 1);
  console.log(`[4] built=${built.library.label} samples=${built.sampleCount} self=${enrollment.selfId} renamed=${renamed.label}`);
});

// ---------------------------------------------------------------------------
// 5. rollback / no half data
// ---------------------------------------------------------------------------

test('5) 失败回滚：库已写入后确认失败 → 库回滚、登记恢复，不留半套', async (t) => {
  const root = await newRoot();
  await writeCandidates(root, [
    candidateSpec('spc-1'),
    candidateSpec('spc-2', { embedding: [0.9, 0.1, 0] }),
    candidateSpec('spc-3', { embedding: [0.95, 0.05, 0] }),
  ]);

  const store = createSpeakerCandidatesStore({ root });
  const actions = createSpeakerCandidateActions({ store, root });
  const library = createSpeakerLibrary({ root });
  t.after(async () => {
    library.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  let saved = { version: 1, selfId: '', updatedAt: '', entries: [] };
  const fakeEnrollment = {
    file: join(root, ENROLLMENT_FILE),
    read: () => JSON.parse(JSON.stringify(saved)),
    getConfirmedSelf: () => {
      const entry = saved.entries.find((row) => row.speakerId === saved.selfId);
      return entry === undefined ? null : JSON.parse(JSON.stringify(entry));
    },
    mergeSamples: ({ samples }) => {
      const entry = {
        speakerId: 'self',
        label: 'x',
        status: 'pending',
        samples: samples.map((sample) => ({ ...sample })),
        createdAt: '2026-11-10T00:00:00.000Z',
        confirmedAt: null,
      };
      saved = { ...saved, entries: [...saved.entries, entry] };
      return { ok: true, speakerId: 'self', added: samples.length, skipped: 0, duplicates: 0, invalid: 0 };
    },
    confirm: () => ({ ok: false, reason: 'insufficient-samples', totalDurationMs: 0, requiredMs: 3000 }),
    write: (next) => { saved = JSON.parse(JSON.stringify(next)); },
    removeEntry: () => {
      saved = { version: 1, selfId: '', updatedAt: '', entries: [] };
      return { ok: true };
    },
    stats: () => ({ status: 'confirmed', sampleCount: 3, totalDurationMs: 3600 }),
  };
  const handler = createHearingSettingsActions({
    speakerCandidateActions: actions,
    speakerCandidatesStore: store,
    speakerLibrary: library,
    speakerEnrollmentStore: fakeEnrollment,
    log: { emit: async () => {} },
  });

  const failed = await handler({
    action: 'speaker.candidates.build',
    ids: ['spc-1', 'spc-2', 'spc-3'],
    label: '回滚',
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'insufficient-samples');
  assert.equal(failed.rolledBack, true, 'the SQLite savepoint rolled the template back');
  assert.equal(failed.enrollmentRestored, true, 'the enrollment snapshot was restored');
  assert.deepEqual(library.list(), [], 'no template survives a failed build');
  assert.deepEqual(saved, { version: 1, selfId: '', updatedAt: '', entries: [] });
  assert.equal(fakeEnrollment.getConfirmedSelf(), null);
  console.log(`[5] reason=${failed.reason} rolledBack=${failed.rolledBack} enrollmentRestored=${failed.enrollmentRestored}`);

  // Library failure before the enrollment write: no half data either.
  const retiredRoot = await newRoot();
  await writeCandidates(retiredRoot, [
    candidateSpec('spc-1'),
    candidateSpec('spc-2', { embedding: [0.9, 0.1, 0] }),
    candidateSpec('spc-3', { embedding: [0.95, 0.05, 0] }),
  ]);
  const retiredStore = createSpeakerCandidatesStore({ root: retiredRoot });
  const retiredActions = createSpeakerCandidateActions({ store: retiredStore, root: retiredRoot });
  const retiredLibrary = createSpeakerLibrary({ root: retiredRoot });
  retiredLibrary.register('self', Float32Array.from([1, 0, 0]), { label: 'old' });
  retiredLibrary.remove('self');
  const realEnrollment = createSpeakerEnrollmentStore({ root: retiredRoot });
  const retiredHandler = createHearingSettingsActions({
    speakerCandidateActions: retiredActions,
    speakerCandidatesStore: retiredStore,
    speakerLibrary: retiredLibrary,
    speakerEnrollmentStore: realEnrollment,
    log: { emit: async () => {} },
  });
  t.after(async () => {
    retiredLibrary.close();
    await rm(retiredRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  const retired = await retiredHandler({
    action: 'speaker.candidates.build',
    ids: ['spc-1', 'spc-2', 'spc-3'],
    label: '已退休',
  });
  assert.deepEqual(retired, {
    ok: false, reason: 'retired', rolledBack: true, enrollmentRestored: true,
  });
  assert.deepEqual(retiredLibrary.list(), []);
  assert.equal(realEnrollment.getConfirmedSelf(), null);
  assert.equal(existsSync(join(retiredRoot, ENROLLMENT_FILE)), false,
    'a library refusal before merge never writes an enrollment file');
  console.log('[5b] retired library refusal leaves enrollment absent');
});

// ---------------------------------------------------------------------------
// 6. Client static assertions
// ---------------------------------------------------------------------------

test('6) 设置页 UI 静态接线：候选数/分组、试听、勾选、删除、清空、预览、建立、重命名、提示', async () => {
  const clientSource = readFileSync(join(PROJECT_ROOT, 'client.js'), 'utf8');
  const hostSource = readFileSync(join(PROJECT_ROOT, 'src', 'host', 'index.js'), 'utf8');
  const settingsSource = readFileSync(
    join(PROJECT_ROOT, 'src', 'host', 'hearing', 'settings-actions.js'),
    'utf8',
  );
  for (const action of [
    'speaker.candidates.list', 'speaker.candidates.audio', 'speaker.candidates.remove',
    'speaker.candidates.clear', 'speaker.candidates.preview', 'speaker.candidates.build',
    'speaker.rename',
  ]) {
    assert.ok(clientSource.includes(`action: '${action}'`), `client calls ${action}`);
    assert.ok(settingsSource.includes(`'${action}'`), `host registers ${action}`);
  }
  assert.match(hostSource, /createSpeakerLibrary\(\{/u, 'the Host creates the one shared library');
  assert.match(hostSource, /speakerCandidateActions = createSpeakerCandidateActions/u);
  assert.match(hostSource, /speakerLibrary,\s*\n(?:\s*\/\/[^\n]*\n)*\s*speakerLibraryRoot: root/u,
    'hearing receives the shared library instance');

  for (const copy of [
    '只有你确认后才生效',
    '还没有声纹候选',
    '声纹影子',
    '正常说话',
    '试听',
    '删除',
    '清空候选',
    '预览一致性',
    '建立基础声纹',
    '重命名',
    '声纹候选',
  ]) {
    assert.ok(clientSource.includes(copy), `the card ships the copy: ${copy}`);
  }
  assert.ok(clientSource.includes("'data-settings-group': 'speaker-candidates'"));
  assert.ok(clientSource.includes("type: 'checkbox'"), 'candidates are selectable with checkboxes');
  assert.ok(clientSource.includes("h('audio'"), 'the preview renders an audio element');
  assert.match(clientSource, /candidateAudio: speakerCandidateAudio/u);
  assert.match(clientSource, /candidateSelection: speakerCandidateSelection/u);
  assert.match(clientSource, /onCandidateRename: \(label\) => void renameSpeakerLibrary\(label\)/u);
  assert.doesNotMatch(clientSource, /setInterval\(loadSpeakerCandidates/u, 'candidate reads add no timer');
  assert.equal((clientSource.match(/setInterval\(load, 3000\)/gu) ?? []).length, 1,
    'the original status poll remains the only one');
  console.log('[6] actions=7 copy=10 checkboxes=1 audio=1 polling=1');
});

// ---------------------------------------------------------------------------
// 7. Live wiring: enabling the shadow attaches the candidate callback to the
//    CURRENT capture; turning it off / entering privacy stops collection.
// ---------------------------------------------------------------------------

/** One valid microphone clip for the host callback seam (16 kHz mono Float32). */
function sampleOf(utteranceId, overrides = {}) {
  return {
    utteranceId,
    source: 'mic',
    quality: 'ok',
    sampleRate: 16000,
    durationMs: 1000,
    embedding: new Float32Array([1, 0, 0]),
    samples: new Float32Array(16000),
    text: '候选正文',
    ...overrides,
  };
}

test('7) 运行中开影子：当前监听补挂候选收集；关闭/隐私停止收集', async (t) => {
  const root = await newRoot({ voice: { chunking: false, speakerShadow: false } });
  const host = await mount(root);
  t.after(async () => {
    await host.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  // Capture starts with the shadow OFF: the session has no candidate callback.
  assert.equal((await host.start()).ok, true);
  assert.equal(state.starts.length, 1);
  assert.equal(state.starts[0].onSpeakerSample, undefined, 'no callback before the switch is on');
  let snapshot = await host.status();
  assert.equal(snapshot.speaker.candidates, undefined, 'the default-OFF shape stays unchanged');
  assert.equal(snapshot.speaker.candidateAttached, undefined);
  assert.equal(snapshot.speaker.candidateCollecting, undefined);

  // Turning it on while listening restarts that session with the callback, so the CURRENT
  // conversation starts collecting immediately instead of waiting for a later restart.
  const enabled = await host.action({ action: 'voice.speakerShadow', enabled: true });
  assert.equal(enabled.ok, true, enabled.error);
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.restarted, true, 'the live capture was re-opened');
  assert.equal(enabled.attached, true);
  assert.equal(enabled.collecting, true);
  assert.equal(state.starts.length, 2);
  const liveCallback = state.starts[1].onSpeakerSample;
  assert.equal(typeof liveCallback, 'function', 'the current session now has a candidate callback');
  snapshot = await host.status();
  assert.equal(snapshot.speaker.candidateAttached, true);
  assert.equal(snapshot.speaker.candidateCollecting, true);
  assert.equal(snapshot.speaker.candidateCollectReason, '');

  liveCallback(sampleOf('live-shadow:1'));
  await until(async () => (await host.status()).speaker.candidates?.count === 1, 'live candidate');
  let attachedEvent;
  await until(async () => {
    attachedEvent = (await readEvents(root)).find(
      (event) => event.type === 'speaker.candidates.collection' && event.payload?.attached === true,
    );
    return attachedEvent !== undefined;
  }, 'candidate collection attach event');
  assert.ok(attachedEvent !== undefined, 'attaching the callback is recorded');

  // Turning it off detaches the callback from a still-running capture; the old callback can no
  // longer add rows even if hearing already queued one.
  const disabled = await host.action({ action: 'voice.speakerShadow', enabled: false });
  assert.equal(disabled.ok, true, disabled.error);
  assert.equal(disabled.restarted, true, 'the capture is re-opened without the callback');
  assert.equal(disabled.attached, false);
  assert.equal(disabled.collecting, false);
  assert.equal(state.starts.length, 3);
  assert.equal(state.starts[2].onSpeakerSample, undefined);
  liveCallback(sampleOf('live-shadow:2'));
  snapshot = await host.status();
  assert.equal(snapshot.speaker.candidates.count, 1, 'a stale/off callback cannot add');
  assert.equal(snapshot.speaker.candidateAttached, false);
  assert.equal(snapshot.speaker.candidateCollecting, false);
  assert.equal(snapshot.speaker.candidateCollectReason, 'shadow-disabled');

  // Enable again, then enter privacy: the callback exists but collection is refused by the gate.
  const again = await host.action({ action: 'voice.speakerShadow', enabled: true });
  assert.equal(again.ok, true, again.error);
  assert.equal(again.attached, true);
  const privacyCallback = state.starts.at(-1).onSpeakerSample;
  assert.equal(typeof privacyCallback, 'function');
  const privacy = await host.action({ action: 'vision.mode', mode: 'privacy' });
  assert.equal(privacy.ok, true, privacy.error);
  privacyCallback(sampleOf('live-shadow:3'));
  snapshot = await host.status();
  assert.equal(snapshot.speaker.candidates.count, 1, 'privacy refuses a candidate');
  assert.equal(snapshot.speaker.candidateAttached, true, 'the callback is still attached');
  assert.equal(snapshot.speaker.candidateCollecting, false);
  assert.equal(snapshot.speaker.candidateCollectReason, 'privacy');

  let skipped = [];
  await until(async () => {
    skipped = (await readEvents(root))
      .filter((event) => event.type === 'speaker.candidates.skipped')
      .map((event) => event.payload?.reason);
    return skipped.includes('shadow-disabled') && skipped.includes('privacy');
  }, 'candidate skip reasons');
  assert.ok(skipped.includes('shadow-disabled'), `expected shadow-disabled, got ${skipped.join(',')}`);
  assert.ok(skipped.includes('privacy'), `expected privacy, got ${skipped.join(',')}`);
  assert.equal(await enrollmentState(root), null, 'collection never confirms self');
  assert.deepEqual(await libraryRows(root), [], 'collection never builds a template');
  console.log('[7] attach=live/on restart=on detach=off privacy=refused self=null template=none');
});
