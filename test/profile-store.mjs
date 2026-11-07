/**
 * ProfileStore (step 1): tables, edit API and the agent-split text import.
 *
 * Proves the rules the user fixed on 2026-11-06:
 *  - the four `profile_*` tables are independent from memory (same file is allowed, counting is
 *    not), capacity is `adoptionQuota × 4`, and the fifth stage deletes instead of archiving;
 *  - user edits apply only the real diff, write one revision and can be reverted;
 *  - a lock blocks automatic (agent) edits but never the user;
 *  - a reject writes a fingerprint tombstone, so old evidence cannot resurrect the entry;
 *  - every mutation is one transaction: a throw rolls everything back.
 *
 * Run: node --test test/profile-store.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DatabaseSync } from 'node:sqlite';

import {
  PROFILE_DEFAULT_ADOPTION_QUOTA,
  PROFILE_DEFAULT_CLARITY,
  PROFILE_DEFAULT_EFFICACY,
  createProfileStore,
  profileFingerprint,
} from '../src/host/profile/profileStore.js';
import { profileLineTokens, profilePromptOverheadTokens } from '../src/host/profile/profileRank.js';
import { MemoryStore } from '../src/host/memory/store.js';

/** One temp database per test; the store never opens/closes the handle, the test owns it. */
async function fresh(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-profile-store-'));
  const db = new DatabaseSync(join(root, 'profile.db'));
  const profile = createProfileStore({ db, ...options });
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

const entryCount = (db) => db.prepare('SELECT COUNT(*) AS c FROM profile_entry').get().c;

test('a) 建库：profile 表与删除边界表存在，cap = adoptionQuota × 4', async (t) => {
  const { db, profile } = await fresh(t);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'profile_%' ORDER BY name")
    .all()
    .map((row) => row.name);
  assert.deepEqual(tables, [
    'profile_entry',
    'profile_evidence',
    'profile_evidence_identity',
    'profile_reject',
    'profile_revision',
  ]);
  const deletedTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'deleted_persona'")
    .get();
  assert.equal(deletedTable?.name, 'deleted_persona', 'deletion boundaries own a table');

  const capacity = profile.capacity();
  assert.equal(capacity.cap, 96, `cap should be 24×4, got ${capacity.cap}`);
  assert.equal(capacity.used, 0);
  assert.deepEqual(capacity.stages, { original: 0, new: 0, candidate: 0, sinking: 0 });
  assert.equal(PROFILE_DEFAULT_ADOPTION_QUOTA * 4, 96);

  // The quota option scales the whole budget; an explicit cap overrides it.
  assert.equal(createProfileStore({ db, adoptionQuota: 10 }).capacity().cap, 40);
  assert.equal(createProfileStore({ db, adoptionQuota: 10, capacity: 7 }).capacity().cap, 7);
  console.log(`a) tables=${tables.join(',')} cap=${capacity.cap}`);
});

test('b) upsert/get/list 正常，side 与 category 过滤生效', async (t) => {
  const { profile } = await fresh(t);
  const agent = profile.upsert({ side: 'agent', category: 'tone', text: '说话简短' }).entry;
  const user = profile.upsert({ side: 'user', category: 'food', tags: ['辣', ' 冰 '], text: '喜欢冰美式' }).entry;
  profile.upsert({ side: 'user', category: 'food', text: '不吃香菜' });

  assert.equal(profile.get(agent.id).text, '说话简短');
  assert.equal(profile.get('missing'), null);
  assert.equal(profile.list({ side: 'agent' }).length, 1);
  assert.equal(profile.list({ side: 'user' }).length, 2);
  assert.equal(profile.list({ side: 'user', category: 'food' }).length, 2);
  assert.equal(profile.list({ side: 'agent', category: 'food' }).length, 0);
  assert.equal(profile.list({ rank: 'original' }).length, 0, 'plain upserts default to stage new');
  assert.equal(user.tags, '辣,冰', 'array tags normalize to one comma string');
  console.log(`b) agent=${profile.list({ side: 'agent' }).length} user=${profile.list({ side: 'user' }).length}`);
});

test('c) edit 只改差异、写一条 revision、可 revert；用户编辑立即成为原订', async (t) => {
  const { profile } = await fresh(t);
  const entry = profile.upsert({ side: 'agent', text: '说话简短' }).entry;

  const edited = profile.edit(entry.id, { text: '说话简短一点', category: 'tone' });
  assert.deepEqual(
    edited.changed,
    ['category', 'text', 'clarity', 'rank'],
    `the user edit also adopts (C→60, rank→original), got ${edited.changed}`,
  );
  assert.equal(edited.revision.source, 'user');
  assert.deepEqual(edited.revision.before, { category: '', text: '说话简短', clarity: 50, rank: 'new' });
  assert.deepEqual(
    edited.revision.after,
    { category: 'tone', text: '说话简短一点', clarity: 60, rank: 'original' },
  );
  assert.equal(edited.entry.version, 2);
  assert.deepEqual([edited.entry.clarity, edited.entry.rank], [60, 'original']);

  // Re-saving the same values is a no-op: no revision, no version bump.
  const again = profile.edit(entry.id, { text: '说话简短一点', category: 'tone' });
  assert.deepEqual(again.changed, []);
  assert.equal(again.revision, null);
  assert.equal(again.entry.version, 2);
  assert.equal(profile.revision(entry.id).length, 1);

  const reverted = profile.revert(profile.revision(entry.id)[0].id);
  assert.equal(reverted.entry.text, '说话简短');
  assert.equal(reverted.entry.category, '');
  assert.deepEqual([reverted.entry.clarity, reverted.entry.rank], [50, 'new'], 'revert restores the pre-edit baseline');
  assert.equal(reverted.entry.version, 3, 'revert bumps the version too');
  console.log(`c) changed=${edited.changed.join('+')} version=${edited.entry.version} rank=${edited.entry.rank} reverted.version=${reverted.entry.version}`);
});

test('d) lock 挡不住用户 edit，但拦住自动整理 editFromAgent', async (t) => {
  const { profile } = await fresh(t);
  const entry = profile.upsert({ side: 'agent', text: '说话简短' }).entry;

  assert.equal(profile.lock(entry.id, true).locked, true);
  const refused = profile.editFromAgent(entry.id, { text: '自动改写' });
  assert.equal(refused, null, 'agent edit on a locked entry must be refused');
  assert.equal(profile.get(entry.id).text, '说话简短');
  assert.equal(profile.get(entry.id).version, 1, 'a refusal writes nothing');

  const userEdit = profile.edit(entry.id, { text: '用户改写' }, { source: 'user' });
  assert.equal(userEdit.entry.text, '用户改写', 'the user wins over the lock');
  assert.equal(userEdit.entry.locked, true, 'editing does not silently unlock');
  assert.deepEqual([userEdit.entry.clarity, userEdit.entry.rank], [60, 'original'], 'a user edit adopts immediately');
  assert.equal(userEdit.entry.version, 2);

  // An unlocked entry still accepts automatic organization, and the revision says so.
  const loose = profile.upsert({ side: 'agent', text: '语气温和' }).entry;
  const agentEdit = profile.editFromAgent(loose.id, { rank: 'candidate' });
  assert.equal(agentEdit.entry.rank, 'candidate');
  assert.equal(agentEdit.revision.source, 'agent');
  console.log(`d) locked editFromAgent=${refused} locked=${userEdit.entry.locked} agentSource=${agentEdit.revision.source}`);
});

test('e) reject 写 fingerprint 墓碑，旧文本不能复活；remove 同时清掉证据与修订', async (t) => {
  const { db, profile } = await fresh(t);
  const entry = profile.upsert({ side: 'user', text: '其实我不喜欢猫' }).entry;
  profile.addEvidence(entry.id, { messageId: 'msg-old-1', kind: 'support', note: '很久以前的对话' });
  assert.equal(profile.get(entry.id).evidence_count, 1);

  assert.equal(profile.reject(entry.id), true);
  assert.equal(profile.get(entry.id), null, 'a rejected entry is gone from the live table');
  assert.equal(profile.list({ side: 'user' }).length, 0);

  // Old evidence arrives again: the tombstone refuses it instead of recreating the entry.
  const resurrected = profile.upsert({ side: 'user', text: ' 其实我不喜欢猫 ' });
  assert.equal(resurrected, null, 'the same normalized text must stay rejected');
  const imported = profile.importText({
    side: 'user',
    text: '导入旧画像',
    items: [{ text: '其实我不喜欢猫' }, { text: '喜欢安静' }],
  });
  assert.equal(imported.skipped.length, 1);
  assert.equal(imported.imported.length, 1);

  const tombstone = db.prepare('SELECT fingerprint, text FROM profile_reject').all();
  assert.equal(tombstone.length, 1);
  assert.equal(tombstone[0].fingerprint, profileFingerprint('user', '其实我不喜欢猫'));

  // remove is a hard delete: evidence and revisions go with the entry.
  const doomed = profile.upsert({ side: 'agent', text: '临时条目' }).entry;
  profile.addEvidence(doomed.id, { messageId: 'msg-2' });
  profile.edit(doomed.id, { text: '临时条目（改）' });
  assert.equal(profile.remove(doomed.id), true);
  assert.equal(profile.get(doomed.id), null);
  assert.equal(profile.evidence(doomed.id).length, 0);
  assert.equal(profile.revision(doomed.id).length, 0);
  assert.equal(profile.remove(doomed.id), false);
  console.log(`e) tombstone=${tombstone[0].fingerprint.slice(0, 12)} skipped=${imported.skipped.length}`);
});

test('f) 容量：写满 cap 后继续 upsert，按 clarity 最低删除（第五阶段），返回删除列表', async (t) => {
  const { profile } = await fresh(t, { adoptionQuota: 1 }); // cap = 1 × 4 = 4
  const clarity = [10, 20, 30, 40];
  clarity.forEach((score, index) => {
    profile.upsert({ side: 'agent', text: `条目 ${index}`, clarity: score, rank: 'new' });
  });
  assert.equal(profile.capacity().cap, 4);
  assert.equal(profile.capacity().used, 4);

  const overflow = profile.upsert({ side: 'agent', text: '新条目', clarity: 100 });
  assert.equal(overflow.removed.length, 1, 'one entry must be evicted to stay at cap');
  assert.equal(overflow.removed[0].clarity, 10, 'the lowest-clarity entry goes first');
  assert.equal(overflow.entry.text, '新条目');
  assert.equal(profile.capacity().used, 4);
  assert.deepEqual(
    profile.list().map((row) => row.clarity).sort((a, b) => a - b),
    [20, 30, 40, 100],
  );

  // capacity() enforces the same rule when rows came from outside the API.
  const { db, profile: raw } = await fresh(t, { adoptionQuota: 1 }); // cap 4
  for (let index = 0; index < 6; index += 1) {
    db.prepare(
      `INSERT INTO profile_entry (id, side, text, clarity, rank, created_at, updated_at)
        VALUES (?, 'agent', ?, ?, 'new', ?, ?)`,
    ).run(`raw-${index}`, `越权写入 ${index}`, 5 + index, new Date().toISOString(), new Date().toISOString());
  }
  const collected = raw.capacity();
  assert.equal(collected.removed.length, 2, 'capacity() trims rows it could not intercept');
  assert.equal(collected.used, 4);
  assert.deepEqual(collected.removed.map((row) => row.clarity).sort((a, b) => a - b), [5, 6]);
  console.log(`f) cap=4 used=${profile.capacity().used} removed=${JSON.stringify(overflow.removed.map((row) => row.text))}`);
});

test('g) importText：5 条已拆分条目 → 全部 original、C/E 沿用、写入成功', async (t) => {
  const { profile } = await fresh(t);
  const items = [
    { text: '说话简短', category: 'tone', clarity: 70, efficacy: 60 },
    { text: '喜欢冰美式', category: 'food', tags: ['冰', '咖啡'], clarity: 80, efficacy: 55 },
    { text: '不吃香菜', category: 'food', clarity: 65 },
    { text: '夜里写代码', category: 'habit', efficacy: 40 },
    { text: '不主动叫醒我', category: 'boundary', clarity: 90, efficacy: 85 },
  ];
  const result = profile.importText({ side: 'user', text: '# 关于用户\n- ……', items });

  assert.equal(result.imported.length, 5, `all five split items land, got ${result.imported.length}`);
  assert.equal(result.skipped.length, 0);
  assert.ok(result.imported.every((entry) => entry.rank === 'original'), 'the baseline is 原订 for every item');
  assert.equal(result.sourceText.startsWith('# 关于用户'), true);

  const byText = new Map(result.imported.map((entry) => [entry.text, entry]));
  assert.equal(byText.get('说话简短').clarity, 70, 'supplied C is kept');
  assert.equal(byText.get('说话简短').efficacy, 60, 'supplied E is kept');
  assert.equal(byText.get('不吃香菜').efficacy, PROFILE_DEFAULT_EFFICACY, 'missing E gets the default');
  assert.equal(byText.get('夜里写代码').clarity, PROFILE_DEFAULT_CLARITY, 'missing C gets the default');
  assert.equal(profile.list({ side: 'user' }).length, 5);
  assert.equal(profile.capacity().stages.original, 5);

  // The host never splits: without agent-provided items the import refuses rather than guessing.
  assert.throws(() => profile.importText({ side: 'user', text: '一整段没有拆分的人设' }), /items/);
  console.log(`g) imported=${result.imported.length} original=${profile.capacity().stages.original} defaultC/E=${PROFILE_DEFAULT_CLARITY}/${PROFILE_DEFAULT_EFFICACY}`);
});

test('h) 与记忆隔离：profile_entry 不计入 memory usage/capacity，两边计数互不影响', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-profile-isolation-'));
  const memory = new MemoryStore(root, { capacity: 5000 });
  memory.open();
  const profile = createProfileStore({ db: memory.db });
  t.after(async () => {
    memory.close();
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  memory.add('chat', '用户喜欢冰美式', 'preference');
  memory.add('chat', '用户住在杭州', 'fact');
  const before = memory.usage();
  assert.equal(before.records, 2);
  assert.equal(before.capacity, 5000);

  // 20 profile entries on the SAME file/connection must cost the memory budget nothing.
  for (let index = 0; index < 20; index += 1) {
    profile.upsert({ side: index % 2 === 0 ? 'agent' : 'user', text: `画像条目 ${index}` });
  }
  const afterProfile = memory.usage();
  assert.equal(afterProfile.records, 2, `memory records must stay 2, got ${afterProfile.records}`);
  assert.equal(afterProfile.capacity, 5000);
  assert.equal(profile.capacity().used, 20);
  assert.equal(profile.capacity().cap, 96);

  // The other direction: a new memory does not move the profile count either.
  memory.add('chat', '用户养了一只猫', 'fact');
  assert.equal(profile.capacity().used, 20);
  assert.equal(memory.usage().records, 3);
  console.log(`h) memory=${memory.usage().records}/5000 profile=${profile.capacity().used}/96 isolated=true`);
});

test('i) revision 列表按时间倒序，revert 后版本号 +1', async (t) => {
  const { profile } = await fresh(t);
  const entry = profile.upsert({ side: 'agent', text: '版本一' }).entry;
  profile.edit(entry.id, { text: '版本二' });
  profile.edit(entry.id, { text: '版本三' });

  const revisions = profile.revision(entry.id);
  assert.equal(revisions.length, 2);
  assert.equal(revisions[0].after.text, '版本三', 'newest revision first');
  assert.equal(revisions[1].after.text, '版本二');
  assert.ok(revisions[0].at >= revisions[1].at, 'timestamps are non-increasing');

  const reverted = profile.revert(revisions[1].id); // undo 版本一 → 版本二
  assert.equal(reverted.entry.text, '版本一');
  assert.equal(reverted.entry.version, 4, `version should be 4 after revert, got ${reverted.entry.version}`);
  assert.equal(profile.revision(entry.id).length, 3, 'the revert itself is recorded');
  assert.equal(profile.revision(entry.id)[0].source, 'user');
  console.log(`i) revisions=2 newest=${revisions[0].after.text} reverted=${reverted.entry.text} version=${reverted.entry.version}`);
});

test('j) 事务：中途抛错 → 同一事务里的写入全部回滚', async (t) => {
  const { profile } = await fresh(t);
  assert.throws(
    () =>
      profile.transact(() => {
        profile.upsert({ side: 'agent', text: '会被回滚的条目' });
        profile.upsert({ side: 'agent', text: '也会被回滚的条目' });
        throw new Error('boom');
      }),
    /boom/,
  );
  assert.equal(profile.list().length, 0, 'both inserts rolled back');
  assert.equal(profile.capacity().used, 0);

  // An edit + revision inside a failing transaction also leaves no trace.
  const entry = profile.upsert({ side: 'agent', text: '稳定条目' }).entry;
  assert.throws(
    () =>
      profile.transact(() => {
        profile.edit(entry.id, { text: '不稳定的修改' });
        throw new Error('boom-2');
      }),
    /boom-2/,
  );
  assert.equal(profile.get(entry.id).text, '稳定条目');
  assert.equal(profile.get(entry.id).version, 1);
  assert.equal(profile.revision(entry.id).length, 0);
  console.log('j) rolledBack entries=0 revisions=0 version=1');
});

test('k) 幂等：同一 (side, text) 重复 upsert 不产生第二条', async (t) => {
  const { db, profile } = await fresh(t);
  const first = profile.upsert({ side: 'agent', text: '同一句话' }).entry;
  const second = profile.upsert({ side: 'agent', text: '  同一句话  ' }).entry;

  assert.equal(second.id, first.id, 'whitespace-normalized text maps to the same entry');
  assert.equal(entryCount(db), 1);
  assert.equal(profile.list({ side: 'agent' }).length, 1);

  // Re-importing the baseline is idempotent too.
  const imported = profile.importText({ side: 'agent', items: [{ text: '同一句话' }, { text: '同一句话' }] });
  assert.equal(imported.imported.length, 2, 'both items resolve to the same existing entry');
  assert.equal(imported.imported[0].id, imported.imported[1].id);
  assert.equal(entryCount(db), 1);
  console.log(`k) rows=${entryCount(db)} id=${first.id.slice(0, 8)}`);
});

test('l) capacity().used 与实际行数一致', async (t) => {
  const { db, profile } = await fresh(t);
  for (let index = 0; index < 7; index += 1) {
    profile.upsert({ side: index % 2 === 0 ? 'agent' : 'user', text: `画像 ${index}`, clarity: 50 + index });
  }
  const rows = entryCount(db);
  const capacity = profile.capacity();
  assert.equal(capacity.used, rows, `used=${capacity.used} rows=${rows}`);
  assert.equal(capacity.used, 7);
  assert.deepEqual(capacity.stages, { original: 0, new: 7, candidate: 0, sinking: 0 });

  profile.remove(profile.list()[0].id);
  assert.equal(profile.capacity().used, entryCount(db));
  assert.equal(profile.capacity().used, 6);
  console.log(`l) used=${profile.capacity().used} rows=${entryCount(db)} stages=${JSON.stringify(profile.capacity().stages)}`);
});

test('m) 锁定：支持/矛盾/衰退都不改 C/E 与采纳状态，并记 profile.locked.exempt', async (t) => {
  const events = [];
  const { profile } = await fresh(t, { emit: (type, payload) => events.push({ type, payload }) });
  const locked = profile.upsert({
    side: 'agent', category: '性格', text: '被锁定的条目', clarity: 35, efficacy: 50, rank: 'original',
  }).entry;
  profile.lock(locked.id, true);

  const results = [
    profile.recordSupport(locked.id, { messageId: 'support-1' }),
    profile.recordContradiction(locked.id, { severity: 'sustained', messageId: 'contra-1' }),
    profile.recordIdle(locked.id, { hasNewExchange: true }),
  ];
  assert.deepEqual(results.map((item) => item.applied), [false, false, false]);
  assert.deepEqual(results.map((item) => item.reason), ['locked', 'locked', 'locked']);
  const after = profile.get(locked.id);
  assert.deepEqual([after.clarity, after.efficacy, after.rank], [35, 50, 'original']);
  assert.equal(profile.evidence(locked.id).length, 0, 'a locked entry collects no automatic evidence');

  profile.compileRank();
  assert.equal(profile.get(locked.id).rank, 'original', 'C=35 would retire an unlocked original; the lock keeps it');

  const lockedNew = profile.upsert({ side: 'agent', text: '被锁定的新增', clarity: 90, efficacy: 90 }).entry;
  profile.addEvidence(lockedNew.id, { messageId: 'new-1', kind: 'support' });
  profile.addEvidence(lockedNew.id, { messageId: 'new-2', kind: 'support' });
  profile.lock(lockedNew.id, true);
  profile.compileRank();
  assert.equal(profile.get(lockedNew.id).rank, 'new', 'a locked new entry is never auto-promoted');

  assert.deepEqual(events.map((event) => [event.type, event.payload.entryId, event.payload.event]), [
    ['profile.locked.exempt', locked.id, 'support'],
    ['profile.locked.exempt', locked.id, 'contradiction'],
    ['profile.locked.exempt', locked.id, 'idle'],
  ]);
  console.log(`m) C=${profile.get(locked.id).clarity} rank=${profile.get(locked.id).rank} lockedNew=${profile.get(lockedNew.id).rank} events=${events.length}`);
});

test('n) 用户编辑是新原订基准：C→60、rank→original、不算支持；后续矛盾仍生效', async (t) => {
  const { profile } = await fresh(t);
  const entry = profile.upsert({
    side: 'agent', category: '性格', text: '原来的说法', clarity: 50, efficacy: 50,
  }).entry;
  const edited = profile.edit(entry.id, { text: '用户改成的说法' });

  assert.equal(edited.entry.rank, 'original', 'a user edit is adopted immediately');
  assert.equal(edited.entry.clarity, 60, 'C is lifted to the adoption line, not +10');
  assert.equal(edited.entry.efficacy, 50, 'E is unchanged by a user edit');
  assert.equal(profile.supportCount(entry.id), 0, 'a user edit is not a support event');
  assert.equal(profile.evidence(entry.id).length, 0, 'no support evidence is written');

  // Not frozen: later evidence still strengthens and later contradictions still degrade it.
  const supported = profile.recordSupport(entry.id, { messageId: 's-later' });
  assert.deepEqual([supported.entry.clarity, profile.supportCount(entry.id)], [70, 1], 'a later support still applies');

  // A higher user-supplied C is never lowered by the floor.
  const strong = profile.upsert({ side: 'agent', text: '本来就高分', clarity: 80, efficacy: 60 }).entry;
  assert.equal(profile.edit(strong.id, { text: '本来就高分（改）' }).entry.clarity, 80);

  // Still retirable: enough sustained contradictions bring it below C=40 to retire it.
  assert.equal(profile.recordContradiction(entry.id, { severity: 'sustained', messageId: 'c-1' }).entry.clarity, 60);
  profile.recordContradiction(entry.id, { severity: 'sustained', messageId: 'c-2' });
  profile.recordContradiction(entry.id, { severity: 'sustained', messageId: 'c-3' });
  const last = profile.recordContradiction(entry.id, { severity: 'sustained', messageId: 'c-4' });
  assert.equal(last.entry.clarity, 30, '70 - 4×10');
  const compiled = profile.compileRank();
  assert.equal(profile.get(entry.id).rank, 'new', 'C<40 retires the user-edited original');
  assert.equal(compiled.forgotten.length, 0);
  console.log(`n) edited=${edited.entry.clarity}/${edited.entry.rank} supports=${profile.supportCount(entry.id)} afterContradictions=${last.entry.clarity} rank=${profile.get(entry.id).rank}`);
});

test('o) 用户编辑的原订不受 supports 门槛限制，但仍受预算约束', async (t) => {
  const { profile } = await fresh(t);
  const edited = profile.upsert({
    side: 'agent', category: '性格', text: '用户编辑的条目', clarity: 50, efficacy: 50,
  }).entry;
  profile.edit(edited.id, { text: '用户编辑的条目' }); // C→60, rank→original, supports=0

  const ordinary = profile.upsert({
    side: 'agent', category: '性格', text: '普通统计条目', clarity: 60, efficacy: 40,
  }).entry;
  profile.addEvidence(ordinary.id, { messageId: 's-1', kind: 'support' });
  profile.addEvidence(ordinary.id, { messageId: 's-2', kind: 'support' });

  const cost = profileLineTokens(profile.get(edited.id));
  const overhead = profilePromptOverheadTokens(new Set(['agent']));
  const compiled = profile.compileRank({ config: { totalBudget: cost + overhead + 1, categoryBudget: 1000 } });
  assert.equal(profile.supportCount(edited.id), 0);
  assert.equal(profile.get(edited.id).rank, 'original', 'user intent beats the statistical support gate');
  assert.equal(profile.get(ordinary.id).rank, 'new', 'the lower-S entry loses the budget race');
  assert.ok(compiled.skipped.some((item) => item.id === ordinary.id && item.reason === 'skippedByBudget'));
  console.log(`o) editedRank=${profile.get(edited.id).rank} supports=${profile.supportCount(edited.id)} ordinaryRank=${profile.get(ordinary.id).rank} skipped=${compiled.skipped.find((item) => item.id === ordinary.id)?.reason}`);
});
