/**
 * 宿主强化 / 回滚：声纹模板版本链的持久化、显式动作与设置页接线。
 *
 * This suite mirrors the acceptance items:
 *   1. the version store round-trips a chain (base64 vector), tolerates a missing/bad file and
 *      writes atomically; the safe status view never exposes a vector;
 *   2. an explicit base build seeds v1, and a later build never overwrites an existing v1;
 *   3. an explicit strengthen appends v2 with changed statistics and updates the one library row;
 *   4. a low-similarity/inconsistent/unknown batch is refused and writes nothing;
 *   5. the chain stays bounded at 20 and evicts the oldest version;
 *   6. rollback restores both the pointer and the library vector; unknown/bad versions are refused;
 *   7. strengthening never confirms `self` again and never runs automatically;
 *   8. the Host wires the store and the client card exposes status/strengthen/rollback with a
 *      second confirmation.
 *
 * No microphone, model, network, TTS or GUI is used.
 *
 * Run: node --test test/speaker-reinforce-host.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createSpeakerCandidatesStore,
  encodeEmbedding,
} from '../src/host/hearing/speaker-candidates.js';
import { createSpeakerCandidateActions } from '../src/host/hearing/speaker-candidate-actions.js';
import { createSpeakerEnrollmentStore } from '../src/host/hearing/speaker-enrollment.js';
import {
  ACTIONS,
  SPEAKER_BASE_ID,
  createHearingSettingsActions,
} from '../src/host/hearing/settings-actions.js';
import {
  createEmptySpeakerTemplateStoreState,
  createSpeakerTemplateStore,
} from '../src/host/hearing/speaker-template-store.js';
import { createVersion, createVersionState } from '../src/host/hearing/speaker-template-version.js';
import { cosineSimilarity } from '../src/host/hearing/speaker-template.js';
import { createSpeakerLibrary } from '../src/host/hearing/speakerVoice.js';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CANDIDATE_FILE = join('data', 'speaker-candidates.json');
const TEMPLATE_FILE = join('data', 'speaker-template-versions.json');
const ENROLLMENT_FILE = join('data', 'speaker-enrollment.json');
const TOLERANCE = 1e-6;

function close(actual, expected, message, tolerance = TOLERANCE) {
  assert.ok(
    Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
    `${message}: expected ${expected}, got ${actual}`,
  );
}

function vectorClose(actual, expected, message, tolerance = TOLERANCE) {
  assert.equal(actual.length, expected.length, `${message}: length`);
  for (let index = 0; index < expected.length; index += 1) {
    close(actual[index], expected[index], `${message}[${index}]`, tolerance);
  }
}

function candidateSpec(id, { durationMs = 1200, embedding = [1, 0, 0], text = '候选正文' } = {}) {
  return { id, durationMs, embedding, text };
}

async function newRoot() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-speaker-reinforce-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await mkdir(join(root, 'workspace'), { recursive: true });
  return root;
}

async function writeCandidates(root, specs) {
  const at = new Date(Date.now() - 60_000).toISOString();
  const candidates = specs.map((spec) => ({
    id: spec.id,
    utteranceId: `utt-${spec.id}`,
    speakerId: null,
    embedding: encodeEmbedding(spec.embedding),
    durationMs: spec.durationMs,
    at,
    source: 'mic',
    quality: 'ok',
    text: spec.text,
    audioPath: join('cache', 'speaker-candidates', `${spec.id}.wav`),
    status: 'pending',
    groupId: null,
  }));
  await writeFile(
    join(root, CANDIDATE_FILE),
    `${JSON.stringify({ version: 1, updatedAt: '', candidates }, null, 2)}\n`,
    'utf8',
  );
}

async function harness(t, specs) {
  const root = await newRoot();
  await writeCandidates(root, specs);
  const events = [];
  const log = { emit: async (type, payload) => { events.push({ type, payload }); } };
  const store = createSpeakerCandidatesStore({ root });
  const actions = createSpeakerCandidateActions({ store, root });
  const library = createSpeakerLibrary({ root, onEvent: (type, payload) => events.push({ type, payload }) });
  const enrollment = createSpeakerEnrollmentStore({ root, log });
  const templates = createSpeakerTemplateStore({ root, log });
  const handler = createHearingSettingsActions({
    speakerCandidateActions: actions,
    speakerCandidatesStore: store,
    speakerLibrary: library,
    speakerEnrollmentStore: enrollment,
    speakerTemplateStore: templates,
    log,
  });
  t.after(async () => {
    try { library.close(); } catch { /* already closed */ }
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  return { root, store, actions, library, enrollment, templates, events, handler };
}

const statusOf = (app) => app.handler({ action: 'speaker.template.status' });
const strengthen = (app, ids, extra = {}) => app.handler({
  action: 'speaker.template.strengthen', ids, ...extra,
});
const rollback = (app, version) => app.handler({ action: 'speaker.template.rollback', version });
const libraryVector = (app) => {
  const row = app.library.get(SPEAKER_BASE_ID);
  assert.ok(row !== null, 'the library has a self row');
  return row.embedding;
};
const enrollmentFile = async (app) => JSON.parse(
  await readFile(join(app.root, ENROLLMENT_FILE), 'utf8'),
);

// ---------------------------------------------------------------------------
// 1. Store schema / round-trip / tolerance / atomic write
// ---------------------------------------------------------------------------

test('1) 版本存储：base64 往返、坏文件容错、原子写、状态视图不含向量', async (t) => {
  const root = await newRoot();
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const templates = createSpeakerTemplateStore({ root });
  assert.deepEqual(templates.read(), createEmptySpeakerTemplateStoreState());
  assert.equal(existsSync(join(root, TEMPLATE_FILE)), false, 'a read never creates the file');

  const created = createVersion({
    version: 1,
    vector: [0.6, 0.8, 0],
    sampleCount: 3,
    totalDurationMs: 3600,
    createdAt: '2026-11-10T00:00:00.000Z',
    reason: 'initial',
    parentVersion: null,
  });
  assert.equal(created.ok, true);
  const seeded = createVersionState(created.record);
  assert.equal(seeded.ok, true);
  templates.write(seeded.state);

  const raw = JSON.parse(await readFile(join(root, TEMPLATE_FILE), 'utf8'));
  assert.equal(raw.version, 1);
  assert.equal(raw.currentVersion, 1);
  assert.equal(raw.lastVersion, 1);
  assert.equal(raw.versions.length, 1);
  assert.equal(typeof raw.versions[0].vector, 'string', 'vectors are persisted as base64');
  assert.equal(raw.versions[0].sampleCount, 3);
  assert.equal(raw.versions[0].parentVersion, null);
  const reopened = createSpeakerTemplateStore({ root }).read();
  assert.equal(reopened.currentVersion, 1);
  vectorClose(reopened.versions[0].vector, [0.6, 0.8, 0], 'round-tripped vector');

  // A hand-written number array is accepted on read (older file), then rewritten as base64.
  await writeFile(join(root, TEMPLATE_FILE), `${JSON.stringify({
    version: 1,
    updatedAt: '',
    lastVersion: 1,
    currentVersion: 1,
    versions: [{
      version: 1,
      vector: [1, 0, 0],
      sampleCount: 1,
      totalDurationMs: 1000,
      createdAt: null,
      reason: 'manual',
      parentVersion: null,
    }],
  })}\n`, 'utf8');
  assert.equal(templates.read().versions.length, 1);

  await writeFile(join(root, TEMPLATE_FILE), 'not json at all\n', 'utf8');
  assert.deepEqual(templates.read(), createEmptySpeakerTemplateStoreState());
  await writeFile(join(root, TEMPLATE_FILE), `${JSON.stringify({
    version: 1,
    currentVersion: 1,
    lastVersion: 1,
    versions: [{
      version: 1,
      vector: 'AAAA',
      sampleCount: 1,
      totalDurationMs: 1000,
      createdAt: null,
      reason: 'manual',
      parentVersion: null,
    }],
  })}\n`, 'utf8');
  assert.deepEqual(templates.read(), createEmptySpeakerTemplateStoreState(), 'a zero/broken vector is refused');

  assert.throws(() => templates.write({ versions: 'bad' }), TypeError);
  const names = await readdir(join(root, 'data'));
  assert.equal(names.some((name) => name.endsWith('.tmp')), false, 'no temp file survives');

  // The safe view never includes a vector/embedding/path.
  const app = await harness(t, [candidateSpec('s-1')]);
  const status = await statusOf(app);
  assert.deepEqual(status, { ok: true, currentVersion: null, versions: [], canRollback: false });
  const text = JSON.stringify(status);
  assert.equal(text.includes('vector'), false);
  assert.equal(text.includes('embedding'), false);
  assert.equal(text.includes(root), false);
  console.log('[1] base64-roundtrip=ok corrupt=empty atomic=ok status=vector-free');
});

// ---------------------------------------------------------------------------
// 2. Base build seeds v1; an existing v1 is never overwritten
// ---------------------------------------------------------------------------

test('2) build 成功初始化 v1；已有 v1 不覆盖', async (t) => {
  const app = await harness(t, [
    candidateSpec('s-1', { embedding: [1, 0, 0] }),
    candidateSpec('s-2', { embedding: [0.9, 0.1, 0] }),
    candidateSpec('s-3', { embedding: [0.95, 0.05, 0] }),
  ]);
  const ids = ['s-1', 's-2', 's-3'];
  const before = await statusOf(app);
  assert.deepEqual(before, { ok: true, currentVersion: null, versions: [], canRollback: false });
  assert.equal(existsSync(join(app.root, TEMPLATE_FILE)), false);

  const built = await app.handler({ action: 'speaker.candidates.build', ids, label: '基础声纹' });
  assert.equal(built.ok, true, built.reason ?? '');
  assert.equal(built.templateInitialized, true);
  const status = await statusOf(app);
  assert.equal(status.ok, true);
  assert.equal(status.currentVersion, 1);
  assert.equal(status.canRollback, false);
  assert.deepEqual(status.versions, [{
    version: 1,
    sampleCount: 3,
    totalDurationMs: 3600,
    createdAt: status.versions[0].createdAt,
    reason: 'initial',
    parentVersion: null,
  }]);
  assert.ok(Number.isFinite(Date.parse(status.versions[0].createdAt)));
  const firstFile = await readFile(join(app.root, TEMPLATE_FILE), 'utf8');

  // The card reads the same chain through `speaker.candidates.list`; it is still vector-free.
  const listed = await app.handler({ action: 'speaker.candidates.list' });
  assert.equal(listed.ok, true);
  assert.equal(listed.template.ok, true);
  assert.equal(listed.template.currentVersion, 1);
  assert.equal(listed.template.versions.length, 1);
  assert.equal(JSON.stringify(listed.template).includes('vector'), false);

  // Simulate a later build path where the chain already exists: deleting the enrollment file
  // makes the explicit build runnable again, but v1 must stay byte-identical (not re-created).
  await rm(join(app.root, ENROLLMENT_FILE), { force: true });
  const rebuilt = await app.handler({ action: 'speaker.candidates.build', ids, label: '再次基础' });
  assert.equal(rebuilt.ok, true, rebuilt.reason ?? '');
  assert.equal(rebuilt.templateInitialized, false, 'an existing v1 is not re-seeded');
  const secondFile = await readFile(join(app.root, TEMPLATE_FILE), 'utf8');
  assert.equal(secondFile, firstFile, 'the existing version file was not rewritten');
  assert.equal((await statusOf(app)).versions.length, 1);
  console.log('[2] build=v1 initial; existing-v1 untouched');
});

// ---------------------------------------------------------------------------
// 3. Strengthen appends v2, changes stats/vector, updates the library
// ---------------------------------------------------------------------------

test('3) strengthen：追加 v2、向量/统计变化、库更新，且不重复确认 self', async (t) => {
  const app = await harness(t, [
    candidateSpec('s-1', { embedding: [1, 0, 0] }),
    candidateSpec('s-2', { embedding: [0.9, 0.1, 0] }),
    candidateSpec('s-3', { embedding: [0.95, 0.05, 0] }),
    candidateSpec('s-4', { embedding: [0.98, 0.15, 0] }),
    candidateSpec('s-5', { embedding: [0.97, 0.18, 0] }),
  ]);
  const built = await app.handler({
    action: 'speaker.candidates.build', ids: ['s-1', 's-2', 's-3'], label: '本人',
  });
  assert.equal(built.ok, true, built.reason ?? '');
  const state1 = app.templates.read();
  const v1 = state1.versions[0].vector;
  const enrollmentBefore = await enrollmentFile(app);
  assert.equal(enrollmentBefore.entries[0].status, 'confirmed');
  assert.equal(enrollmentBefore.entries[0].samples.length, 3);
  assert.equal(app.events.filter((event) => event.type === 'speaker.enroll.confirmed').length, 1);

  const strengthened = await strengthen(app, ['s-4', 's-5'], { label: '本人' });
  assert.equal(strengthened.ok, true, strengthened.reason ?? '');
  assert.equal(strengthened.version, 2);
  assert.equal(strengthened.previousVersion, 1);
  assert.equal(strengthened.sampleCount, 5);
  assert.equal(strengthened.totalDurationMs, 6000);
  assert.equal(strengthened.batchSampleCount, 2);
  assert.equal(strengthened.batchTotalDurationMs, 2400);
  assert.equal(strengthened.library.present, true);
  assert.equal(strengthened.canRollback, true);

  const status = await statusOf(app);
  assert.equal(status.currentVersion, 2);
  assert.deepEqual(status.versions.map((record) => record.version), [1, 2]);
  assert.equal(status.versions[1].reason, 'strengthen');
  assert.equal(status.versions[1].parentVersion, 1);
  assert.equal(status.versions[1].sampleCount, 5);
  assert.equal(JSON.stringify(status).includes('vector'), false);

  const state2 = app.templates.read();
  const v2 = state2.versions.find((record) => record.version === 2).vector;
  assert.equal(state2.currentVersion, 2);
  assert.equal(state2.lastVersion, 2);
  assert.notEqual(cosineSimilarity(v1, v2), 1, 'the strengthened direction changed');
  assert.ok(cosineSimilarity(v1, v2) >= 0.72);
  vectorClose(libraryVector(app), v2, 'library self vector equals the current version');

  const enrollmentAfter = await enrollmentFile(app);
  assert.equal(enrollmentAfter.entries[0].status, 'confirmed');
  assert.equal(enrollmentAfter.entries[0].samples.length, 3, 'strengthen does not append/confirm more self samples');
  assert.equal(enrollmentAfter.selfId, 'self');
  assert.equal(app.events.filter((event) => event.type === 'speaker.enroll.confirmed').length, 1,
    'self is confirmed once, not again by strengthen');
  assert.equal(app.events.filter((event) => event.type === 'speaker.template.strengthened').length, 1);
  console.log(`[3] v1=${v1.indexOf(Math.max(...v1))} v2=${Array.from(v2).map((n) => n.toFixed(2)).join(',')} samples=5 library=exact`);
});

// ---------------------------------------------------------------------------
// 4. Refusals: low similarity / inconsistent / unknown candidate write nothing
// ---------------------------------------------------------------------------

test('4) 低相似/不一致/未知候选：拒绝且不写文件、不改库', async (t) => {
  const app = await harness(t, [
    candidateSpec('s-1', { embedding: [1, 0, 0] }),
    candidateSpec('s-2', { embedding: [0.9, 0.1, 0] }),
    candidateSpec('s-3', { embedding: [0.95, 0.05, 0] }),
    candidateSpec('s-4', { embedding: [0, 1, 0] }),
    candidateSpec('s-5', { embedding: [0, 1, 0.05] }),
  ]);
  const built = await app.handler({
    action: 'speaker.candidates.build', ids: ['s-1', 's-2', 's-3'], label: '本人',
  });
  assert.equal(built.ok, true, built.reason ?? '');
  const fileBefore = await readFile(join(app.root, TEMPLATE_FILE), 'utf8');
  const vectorBefore = libraryVector(app);

  const low = await strengthen(app, ['s-4', 's-5']);
  assert.equal(low.ok, false);
  assert.equal(low.reason, 'low-similarity');
  assert.ok(Number.isFinite(low.similarity));
  assert.equal((await readFile(join(app.root, TEMPLATE_FILE), 'utf8')), fileBefore);
  vectorClose(libraryVector(app), vectorBefore, 'a refused strengthen leaves the library unchanged');
  assert.equal((await statusOf(app)).currentVersion, 1);

  const inconsistent = await strengthen(app, ['s-1', 's-4']);
  assert.equal(inconsistent.ok, false);
  assert.equal(inconsistent.reason, 'inconsistent');
  assert.deepEqual([...inconsistent.outlierIds].sort(), ['s-1', 's-4']);
  assert.equal((await readFile(join(app.root, TEMPLATE_FILE), 'utf8')), fileBefore);
  vectorClose(libraryVector(app), vectorBefore, 'an inconsistent batch leaves the library unchanged');

  const missing = await strengthen(app, ['ghost']);
  assert.deepEqual(missing, { ok: false, reason: 'candidate-not-found', id: 'ghost' });
  assert.equal((await readFile(join(app.root, TEMPLATE_FILE), 'utf8')), fileBefore);
  console.log(`[4] low=${low.similarity.toFixed(3)} inconsistent=${inconsistent.outlierIds.join(',')} missing=refused`);
});

// ---------------------------------------------------------------------------
// 5. Bounded chain
// ---------------------------------------------------------------------------

test('5) 版本链上限 20：追加后丢弃最旧版本，版本号不复用', async (t) => {
  const app = await harness(t, [
    candidateSpec('s-1', { embedding: [1, 0, 0] }),
    candidateSpec('s-2', { embedding: [0.9, 0.1, 0] }),
    candidateSpec('s-3', { embedding: [0.95, 0.05, 0] }),
    candidateSpec('s-4', { embedding: [1, 0.01, 0] }),
  ]);
  const built = await app.handler({
    action: 'speaker.candidates.build', ids: ['s-1', 's-2', 's-3'], label: '本人',
  });
  assert.equal(built.ok, true, built.reason ?? '');
  for (let index = 0; index < 20; index += 1) {
    const result = await strengthen(app, ['s-4']);
    assert.equal(result.ok, true, `strengthen ${index + 1}: ${result.reason ?? ''}`);
    assert.equal(result.version, index + 2);
  }
  const status = await statusOf(app);
  assert.equal(status.versions.length, 20);
  assert.equal(status.versions[0].version, 2, 'v1 was evicted');
  assert.equal(status.versions.at(-1).version, 21);
  assert.equal(status.currentVersion, 21);
  assert.equal(status.canRollback, true);
  const raw = JSON.parse(await readFile(join(app.root, TEMPLATE_FILE), 'utf8'));
  assert.equal(raw.lastVersion, 21, 'version numbers are never reused');
  assert.equal(raw.versions.length, 20);
  console.log(`[5] versions=${status.versions.length} first=v${status.versions[0].version} current=v${status.currentVersion} last=${raw.lastVersion}`);
});

// ---------------------------------------------------------------------------
// 6. Rollback restores the library; unknown/bad versions refused
// ---------------------------------------------------------------------------

test('6) rollback：恢复库向量与 current；未知版本/坏向量拒绝', async (t) => {
  const app = await harness(t, [
    candidateSpec('s-1', { embedding: [1, 0, 0] }),
    candidateSpec('s-2', { embedding: [0.9, 0.1, 0] }),
    candidateSpec('s-3', { embedding: [0.95, 0.05, 0] }),
    candidateSpec('s-4', { embedding: [0.98, 0.15, 0] }),
    candidateSpec('s-5', { embedding: [0.97, 0.18, 0] }),
  ]);
  const built = await app.handler({
    action: 'speaker.candidates.build', ids: ['s-1', 's-2', 's-3'], label: '本人',
  });
  assert.equal(built.ok, true, built.reason ?? '');
  const v1 = app.templates.read().versions[0].vector;
  assert.equal((await strengthen(app, ['s-4', 's-5'])).ok, true);
  const v2 = app.templates.read().versions.find((record) => record.version === 2).vector;

  const rolled = await rollback(app, 1);
  assert.equal(rolled.ok, true, rolled.reason ?? '');
  assert.equal(rolled.currentVersion, 1);
  assert.equal(rolled.restoredFrom, 2);
  assert.equal(rolled.changed, true);
  assert.equal(rolled.library.present, true);
  vectorClose(libraryVector(app), v1, 'rollback restores the library vector');
  assert.notEqual(cosineSimilarity(libraryVector(app), v2), 1);
  const status = await statusOf(app);
  assert.equal(status.currentVersion, 1);
  assert.deepEqual(status.versions.map((record) => record.version), [1, 2],
    'rollback keeps history and only moves current');
  assert.equal(app.events.filter((event) => event.type === 'speaker.template.rolledback').length, 1);

  const noop = await rollback(app, 1);
  assert.equal(noop.ok, true);
  assert.equal(noop.changed, false);
  vectorClose(libraryVector(app), v1, 'a no-op rollback leaves the library alone');

  const beforeUnknown = await readFile(join(app.root, TEMPLATE_FILE), 'utf8');
  const unknown = await rollback(app, 99);
  assert.deepEqual(unknown, { ok: false, reason: 'version-not-found', version: 99 });
  assert.equal((await readFile(join(app.root, TEMPLATE_FILE), 'utf8')), beforeUnknown);
  vectorClose(libraryVector(app), v1, 'a refused rollback leaves the library alone');
  assert.deepEqual(await rollback(app, 0), { ok: false, reason: 'invalid-version' });
  assert.deepEqual(await rollback(app, 'x'), { ok: false, reason: 'invalid-version' });

  // A file whose only vector is broken is treated as corrupt: rollback refuses instead of using it.
  await writeFile(join(app.root, TEMPLATE_FILE), `${JSON.stringify({
    version: 1,
    currentVersion: 1,
    lastVersion: 1,
    versions: [{
      version: 1,
      vector: 'AAAA',
      sampleCount: 3,
      totalDurationMs: 3600,
      createdAt: null,
      reason: 'initial',
      parentVersion: null,
    }],
  })}\n`, 'utf8');
  assert.deepEqual(await statusOf(app), {
    ok: true, currentVersion: null, versions: [], canRollback: false,
  });
  assert.deepEqual(await rollback(app, 1), { ok: false, reason: 'version-not-found', version: 1 });
  vectorClose(libraryVector(app), v1, 'a bad-vector file cannot move the library');
  console.log('[6] rollback=ok to-v1; unknown/bad-vector/invalid refused');
});

// ---------------------------------------------------------------------------
// 7. Explicit-only / host-client wiring
// ---------------------------------------------------------------------------

test('7) 不自动强化/不自动确认；Host 接线与设置页文案/二次确认', async () => {
  assert.ok(ACTIONS.includes('speaker.template.status'));
  assert.ok(ACTIONS.includes('speaker.template.strengthen'));
  assert.ok(ACTIONS.includes('speaker.template.rollback'));

  const hostSource = readFileSync(join(PROJECT_ROOT, 'src', 'host', 'index.js'), 'utf8');
  const settingsSource = readFileSync(
    join(PROJECT_ROOT, 'src', 'host', 'hearing', 'settings-actions.js'),
    'utf8',
  );
  const clientSource = readFileSync(join(PROJECT_ROOT, 'client.js'), 'utf8');
  assert.match(hostSource, /import \{ createSpeakerTemplateStore \} from '\.\/hearing\/speaker-template-store\.js'/u);
  assert.match(hostSource, /const speakerTemplateStore = createSpeakerTemplateStore\(\{ root, log \}\)/u);
  assert.match(hostSource, /get speakerTemplateStore\(\) \{ return speakerTemplateStore; \}/u);
  assert.ok(settingsSource.includes("'speaker.template.status'"));
  assert.ok(settingsSource.includes("'speaker.template.strengthen'"));
  assert.ok(settingsSource.includes("'speaker.template.rollback'"));

  for (const action of [
    'speaker.template.strengthen',
    'speaker.template.rollback',
  ]) {
    assert.ok(clientSource.includes(`action: '${action}'`), `client calls ${action}`);
  }
  assert.ok(clientSource.includes('templateCurrentVersion'), 'the card reads the version status');
  assert.ok(clientSource.includes('templateVersions'), 'the card renders the version list');
  for (const copy of [
    '强化当前声纹',
    '回滚到此版本',
    '确认回滚',
    '当前版本',
    '版本链最多保留 20 个版本',
    '不会自动强化',
    '不会自动确认 self',
  ]) {
    assert.ok(clientSource.includes(copy), `the card ships the copy: ${copy}`);
  }
  assert.match(clientSource, /onTemplateStrengthen: \(ids, label\)/u);
  assert.match(clientSource, /onTemplateRollbackAsk: \(version\)/u);
  assert.match(clientSource, /onTemplateRollback: \(version\)/u);
  assert.doesNotMatch(clientSource, /setInterval\([^\n]*speakerTemplate/u, 'versions add no timer');
  console.log('[7] actions=3 hostWired=true card=status/strengthen/rollback+confirm noTimer=true');
});
