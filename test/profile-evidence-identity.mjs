/**
 * ProfileStore data-layer hardening: persistent evidence identity, evidence/score atomicity,
 * deletion boundaries and merge preview/apply.
 *
 * The rules:
 *  - dedupe identity is `(entry, session, turn, role)`; a missing reliable turn falls back to
 *    the message id. The ledger lives in SQLite, so a restart replays nothing twice;
 *  - `applyEvidence(entryId, evidence, delta)` writes evidence → score → ledger in one
 *    transaction; a throw rolls all three back;
 *  - explicit `remove` writes a `deleted_persona` boundary with the evidence keys it saw, and
 *    `purgeDeleted` is the only cleanup path;
 *  - `planMerge` is read-only; `applyMerge` moves evidence once per identity and never sums
 *    scores or auto-adopts the merged entry.
 *
 * Run: node --test test/profile-evidence-identity.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DatabaseSync } from 'node:sqlite';

import { createProfileStore } from '../src/host/profile/profileStore.js';

async function fresh(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-profile-evidence-'));
  const db = new DatabaseSync(join(root, 'profile.db'));
  const profile = createProfileStore({ db });
  t.after(async () => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });
  return { root, db, profile };
}

const ledgerCount = (db) => db.prepare('SELECT COUNT(*) AS c FROM profile_evidence_identity').get().c;

test('1) 同一 (entry, session, turn, role) 重复写证据 → 只记一次、评分只加一次', async (t) => {
  const { db, profile } = await fresh(t);
  const entry = profile.upsert({ side: 'agent', text: '喜欢安静', clarity: 50, efficacy: 50 }).entry;
  const evidence = { sessionId: 's-1', turnId: '1', role: 'user', messageId: 'm-1', kind: 'support' };

  const first = profile.applyEvidence(entry.id, evidence, { clarity: 10, efficacy: 3 });
  assert.equal(first.applied, true);
  assert.equal(first.duplicate, false);
  assert.equal(profile.evidenceKey(evidence), 'session:s-1\nturn:1\nrole:user');

  // Same exchange, different message id: the turn identity still makes this a replay.
  const second = profile.applyEvidence(
    entry.id,
    { ...evidence, messageId: 'm-2' },
    { clarity: 10, efficacy: 3 },
  );
  assert.equal(second.applied, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.reason, 'duplicate');

  // `recordSupport` goes through the same ledger: a new message id on the same turn is a replay.
  const supportReplay = profile.recordSupport(entry.id, {
    sessionId: 's-1', turnId: '1', role: 'user', messageId: 'm-3',
  });
  assert.equal(supportReplay.duplicate, true);
  assert.equal(supportReplay.applied, false);

  const stored = profile.get(entry.id);
  assert.deepEqual([stored.clarity, stored.efficacy], [60, 53], 'the score changed exactly once');
  assert.equal(stored.evidence_count, 1);
  assert.equal(profile.evidence(entry.id).length, 1);
  assert.equal(profile.evidenceLedger(entry.id).length, 1);
  assert.equal(ledgerCount(db), 1);
  console.log(`1) applied=${first.applied}/${second.duplicate} C/E=${stored.clarity}/${stored.efficacy} evidence=${profile.evidence(entry.id).length} ledger=${ledgerCount(db)}`);
});

test('2) 缺 turnId 时回退 message_id，同样只记一次', async (t) => {
  const { db, profile } = await fresh(t);
  const entry = profile.upsert({ side: 'user', text: '喜欢冰美式', clarity: 50, efficacy: 50 }).entry;
  const evidence = { messageId: 'm-fallback', kind: 'support' };

  const first = profile.applyEvidence(entry.id, evidence, { clarity: 10, efficacy: 3 });
  const replayByMessage = profile.applyEvidence(entry.id, evidence, { clarity: 10, efficacy: 3 });
  const replayBySupport = profile.recordSupport(entry.id, { messageId: 'm-fallback' });

  assert.equal(first.applied, true);
  assert.equal(replayByMessage.duplicate, true);
  assert.equal(replayBySupport.duplicate, true);
  assert.equal(replayBySupport.applied, false);
  const stored = profile.get(entry.id);
  assert.deepEqual([stored.clarity, stored.efficacy], [60, 53]);
  assert.equal(stored.evidence_count, 1);
  assert.equal(profile.evidence(entry.id).length, 1);
  assert.equal(ledgerCount(db), 1);
  console.log(`2) first=${first.applied} messageReplay=${replayByMessage.duplicate} supportReplay=${replayBySupport.duplicate} C/E=${stored.clarity}/${stored.efficacy} ledger=${ledgerCount(db)}`);
});

test('3) 重启（新实例重开同一 DB）后重放 → 不重复加分', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-profile-restart-'));
  const file = join(root, 'profile.db');
  t.after(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  const db1 = new DatabaseSync(file);
  const first = createProfileStore({ db: db1 });
  const entry = first.upsert({ side: 'agent', text: '重启后仍只算一次', clarity: 50, efficacy: 50 }).entry;
  const evidence = { sessionId: 'session-a', turnId: '7', role: 'user', messageId: 'm-before-restart' };
  assert.equal(first.applyEvidence(entry.id, evidence, { clarity: 10, efficacy: 3 }).applied, true);
  assert.equal(first.get(entry.id).clarity, 60);
  db1.close();

  const db2 = new DatabaseSync(file);
  const second = createProfileStore({ db: db2 });
  const replay = second.applyEvidence(
    entry.id,
    { ...evidence, messageId: 'm-after-restart' },
    { clarity: 10, efficacy: 3 },
  );
  assert.equal(replay.duplicate, true);
  assert.equal(replay.applied, false);
  const stored = second.get(entry.id);
  const persistedEvidence = second.evidence(entry.id).length;
  const persistedLedger = ledgerCount(db2);
  assert.deepEqual([stored.clarity, stored.efficacy], [60, 53], 'the persisted ledger blocks the replay');
  assert.equal(stored.evidence_count, 1);
  assert.equal(persistedEvidence, 1);
  assert.equal(persistedLedger, 1);
  db2.close();
  console.log(`3) afterRestart duplicate=${replay.duplicate} C/E=${stored.clarity}/${stored.efficacy} evidence=${persistedEvidence} ledger=${persistedLedger}`);
});

test('4) 评分更新失败（构造异常）→ evidence 与账本回滚，DB 保持一致', async (t) => {
  const { db, profile } = await fresh(t);
  const entry = profile.upsert({ side: 'agent', text: '评分失败也一致', clarity: 50, efficacy: 50 }).entry;
  const beforeVersion = profile.libraryVersion();

  const realWriteRankScores = profile.writeRankScores;
  profile.writeRankScores = () => {
    throw new Error('score update boom');
  };
  assert.throws(
    () => profile.applyEvidence(
      entry.id,
      { sessionId: 's-fail', turnId: '1', role: 'user', messageId: 'm-fail' },
      { clarity: 10, efficacy: 3 },
    ),
    /score update boom/,
  );
  profile.writeRankScores = realWriteRankScores;

  // The ledger is the last step: failing it must roll the already-written evidence and score back.
  const realInsertIdentity = profile.insertEvidenceIdentity;
  profile.insertEvidenceIdentity = () => {
    throw new Error('ledger boom');
  };
  assert.throws(
    () => profile.applyEvidence(
      entry.id,
      { sessionId: 's-fail', turnId: '2', role: 'user', messageId: 'm-fail-2' },
      { clarity: 10, efficacy: 3 },
    ),
    /ledger boom/,
  );
  profile.insertEvidenceIdentity = realInsertIdentity;

  const stored = profile.get(entry.id);
  assert.deepEqual([stored.clarity, stored.efficacy], [50, 50], 'score update rolled back');
  assert.equal(stored.evidence_count, 0, 'evidence_count increment rolled back');
  assert.equal(profile.evidence(entry.id).length, 0, 'evidence row rolled back');
  assert.equal(profile.evidenceLedger(entry.id).length, 0, 'ledger row was never left behind');
  assert.equal(ledgerCount(db), 0);
  assert.equal(profile.libraryVersion(), beforeVersion, 'the failed transaction changed no entry');
  console.log(`4) rolledBack evidence=${profile.evidence(entry.id).length} ledger=${ledgerCount(db)} count=${stored.evidence_count} C/E=${stored.clarity}/${stored.efficacy}`);
});

test('5) 删除记录写入 + isDeletedEvidence 命中删除前证据；purge 后命中失效', async (t) => {
  const { profile } = await fresh(t);
  const entry = profile.upsert({ side: 'user', text: '其实我不喜欢猫', clarity: 60, efficacy: 50 }).entry;
  const evidence = { sessionId: 's-del', turnId: '3', role: 'user', messageId: 'm-del-1', kind: 'support' };
  profile.applyEvidence(entry.id, evidence, { clarity: 10, efficacy: 3 });
  const identity = profile.fingerprint('user', '其实我不喜欢猫');
  const key = profile.evidenceKey(evidence);

  assert.equal(profile.remove(entry.id), true);
  assert.equal(profile.listDeleted().length, 1, 'explicit removal writes one boundary');
  const deleted = profile.listDeleted()[0];
  assert.equal(deleted.identity, identity);
  assert.equal(deleted.description, '其实我不喜欢猫');
  assert.ok(deleted.evidence_ids.includes(key), 'the turn evidence key is recorded');
  assert.ok(deleted.evidence_ids.includes('m-del-1'), 'the fallback message id is recorded too');

  assert.equal(profile.isDeletedEvidence(identity, key), true);
  assert.equal(profile.isDeletedEvidence(identity, 'm-del-1'), true);
  assert.equal(profile.isDeletedEvidence(identity, { messageId: 'm-del-1' }), true);
  assert.equal(profile.isDeletedEvidence(entry.id, key), true, 'the entry id also resolves the same boundary');

  // No automatic cleanup: merely reading/capacity never purges a fresh boundary.
  profile.capacity();
  assert.equal(profile.listDeleted().length, 1);
  const freshPurge = profile.purgeDeleted({ olderThanDays: 30 });
  assert.equal(freshPurge.removed, 0, 'a fresh boundary survives a 30-day purge');
  assert.equal(profile.listDeleted().length, 1);

  const purged = profile.purgeDeleted({ olderThanDays: 0 });
  assert.equal(purged.removed, 1, 'explicit purge removes the boundary');
  assert.equal(profile.listDeleted().length, 0);
  const afterKey = profile.isDeletedEvidence(identity, key);
  const afterMessage = profile.isDeletedEvidence(identity, 'm-del-1');
  assert.equal(afterKey, false, 'after cleanup the evidence no longer matches');
  assert.equal(afterMessage, false, 'the message fallback is honest too');
  console.log(`5) boundary=${deleted.evidence_ids.length} keys freshPurge=${freshPurge.removed} purged=${purged.removed} afterKey=${afterKey} afterMessage=${afterMessage}`);
});

test('6) planMerge 只读；applyMerge 后证据独立计数、评分不直接相加、未自动采纳', async (t) => {
  const { profile } = await fresh(t);
  const target = profile.upsert({
    side: 'agent', category: '性格', text: '喜欢安静', clarity: 80, efficacy: 80, rank: 'new',
  }).entry;
  const source = profile.upsert({
    side: 'agent', category: '性格', text: '喜欢安静一点', clarity: 60, efficacy: 50, rank: 'original',
  }).entry;
  const sharedTurn = { sessionId: 's-merge', turnId: '1', role: 'user' };
  profile.applyEvidence(target.id, { ...sharedTurn, messageId: 'm-target-1' }, { clarity: 10, efficacy: 3 });
  profile.applyEvidence(source.id, { ...sharedTurn, messageId: 'm-source-duplicate' }, { clarity: 10, efficacy: 3 });
  profile.applyEvidence(source.id, { sessionId: 's-merge', turnId: '2', role: 'user', messageId: 'm-source-2' }, { clarity: 10, efficacy: 3 });

  const beforeVersion = profile.libraryVersion();
  const beforeEntries = profile.list().length;
  const beforeEvidence = [profile.evidence(target.id).length, profile.evidence(source.id).length];

  const plan = profile.planMerge([source.id, target.id]);
  assert.equal(plan.readOnly, true);
  assert.equal(plan.targetId, target.id, 'the higher-S entry is the target');
  assert.ok(plan.proposed.clarity <= 90, `scores must not be summed, got ${plan.proposed.clarity}`);
  assert.equal(plan.proposed.clarity, 90, 'the target keeps its own C');
  assert.equal(plan.proposed.rank, 'new', 'merge does not adopt');
  assert.equal(plan.mergedEvidence.length, 2, 'one evidence per identity after dedupe');
  assert.equal(plan.duplicateEvidence.length, 1, 'the shared (session, turn, role) counts once');
  assert.equal(plan.supportCount, 2);

  // Read-only: no row, no evidence and no version moved by the preview.
  assert.equal(profile.libraryVersion(), beforeVersion);
  assert.equal(profile.list().length, beforeEntries);
  assert.deepEqual([profile.evidence(target.id).length, profile.evidence(source.id).length], beforeEvidence);

  // Stale version is refused before any write.
  assert.throws(
    () => profile.applyMerge(plan, { expectedVersion: 'stale' }),
    (error) => error?.code === 'PROFILE_VERSION_MISMATCH',
  );
  assert.equal(profile.list().length, beforeEntries);

  const applied = profile.applyMerge(plan, { expectedVersion: plan.version });
  assert.equal(applied.applied, true);
  assert.equal(applied.targetId, target.id);
  assert.deepEqual(applied.mergedIds, [source.id]);
  assert.equal(profile.get(source.id), null, 'the source entry is removed');
  const merged = profile.get(target.id);
  assert.deepEqual([merged.clarity, merged.efficacy], [90, 83], 'scores are kept, never added');
  assert.equal(merged.rank, 'new', 'the merged entry is not automatically adopted');
  assert.equal(merged.evidence_count, 2);
  assert.equal(profile.evidence(target.id).length, 2, 'evidence is independently recounted');
  assert.equal(profile.evidenceLedger(target.id).length, 2);
  assert.equal(profile.supportCount(target.id), 2, 't-1 and s-3 are the two distinct supports');
  assert.ok(applied.notes.some((note) => note.includes('不叠加评分')));
  assert.ok(applied.notes.some((note) => note.includes('不自动采纳')));
  console.log(`6) planReadOnly=${plan.readOnly} merged=${plan.mergedEvidence.length} dup=${plan.duplicateEvidence.length} appliedScores=${merged.clarity}/${merged.efficacy} rank=${merged.rank} evidence=${profile.evidence(target.id).length} supports=${profile.supportCount(target.id)}`);
});
