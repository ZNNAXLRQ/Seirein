/**
 * 记忆归档必须保留声纹归属：入库 → 归档 → 读回 一致性。
 *
 * `84b615e` 让 `store.js` 的 `compact()` 在 SELECT（L1910）和 archive INSERT（L1921/1935）两侧
 * 都带上了 `speaker_attribution`，但既有测试（`speaker-attribution.mjs` 第 4 项）只断言
 * `memory_archive` 有这一列，没有验证“值真的随行迁移”。本文件补齐这条审查缺口：
 *
 *   1. 新记录带 `assigned:true` 的归属 → 生产触发路径 `maintain()`（表在 ≥90% 容量带内）
 *      调 `compact()` 归档 → 归档行/读回接口返回同一归属，字段逐项相等；
 *   2. `assigned:false`（以及 `confidence:'mismatch'`、`speakerId:null`）的归属原样保留：
 *      false / null 是真实取值，不是“字段缺失”，JSON 里必须还在；
 *   3. 旧记录（建库时没有该列 → 迁移后 NULL）归档后仍为 NULL；旧归档行迁移后也仍为 NULL；
 *   4. 归档后 `messageAttribution()` 只读 active 表（返回 null，记录已不在活跃表），
 *      权威读回是归档行本身；`listArchive()` 能按 messageId 找回该行；
 *   5. compact() 的反向路径：`revertCorrection()` 把 hidden 的归档行恢复回 active 表后，
 *      归属仍在（`insert()` 对已序列化的字符串原样透传，不会二次序列化）。
 *
 * 只使用真实的 MemoryStore（真实 SQLite、真实 compact/归档/恢复），不启动 host/GUI/模型/TTS；
 * 不改任何生产代码。归档行通过 `store.db` 读取，因为现有的 `searchArchive()` / `listArchive()`
 * 投影都不包含该列（它们只返回展示字段，见 store.js L2179/L2196）。
 *
 * Run: node --test test/memory-attribution-archive.mjs
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { MemoryStore } from '../src/host/memory/store.js';

/** 归属对象出现过的全部字段：逐项比较，而不是只比 JSON 字符串。 */
const ATTRIBUTION_FIELDS = ['speakerId', 'assigned', 'confidence', 'source', 'at'];

async function tempRoot() {
  return mkdtemp(join(tmpdir(), 'dsh-mem-attribution-archive-'));
}

/** 关掉本次测试打开过的 store（可能已被测试自己关过），再删临时根目录。 */
async function cleanup(root, ...stores) {
  for (const store of stores) {
    try {
      store?.close();
    } catch {
      /* already closed */
    }
  }
  await rm(root, { recursive: true, force: true }).catch(() => {});
}

/** 归档行里的原始归属文本：未找到 → found:false；无值 → raw:null / value:null。 */
function archiveAttribution(memory, messageId) {
  const row = memory.db
    .prepare('SELECT speaker_attribution AS value FROM memory_archive WHERE message_id = ?')
    .get(messageId);
  if (row === undefined) return { found: false, raw: undefined, value: undefined };
  const raw = row.value;
  return {
    found: true,
    raw,
    value: typeof raw === 'string' && raw.length > 0 ? JSON.parse(raw) : null,
  };
}

/** 活跃表里的原始归属文本（用于证明旧行是 NULL 而不是空串）。 */
function activeAttributionRaw(memory, messageId) {
  const row = memory.db
    .prepare('SELECT speaker_attribution AS value FROM memory_event WHERE message_id = ?')
    .get(messageId);
  return row === undefined ? undefined : row.value;
}

/** 归一路径由 store 拥有：三次 ratio=1 的 fadePass 把 vivid → clear → fuzzy → trace。 */
function fadeAllToTrace(memory) {
  for (let step = 0; step < 3; step += 1) memory.fadePass({ ratio: 1 });
}

/** 逐项断言两个归属对象完全相同（含“字段本身是否存在”，false/null 不会被当成缺失）。 */
function assertAttributionEqual(actual, expected, label) {
  assert.equal(typeof actual, 'object', `${label}: an attribution object is present`);
  assert.ok(actual !== null && !Array.isArray(actual), `${label}: not null/array`);
  for (const field of ATTRIBUTION_FIELDS) {
    assert.ok(Object.hasOwn(actual, field), `${label}: field ${field} survives`);
    assert.equal(actual[field], expected[field], `${label}: field ${field} is identical`);
  }
  assert.deepEqual(actual, expected, `${label}: the whole object is identical`);
}

// ---------------------------------------------------------------------------
// 1. 入库 → 归档 → 读回（assigned:true，生产触发路径 maintain）
// ---------------------------------------------------------------------------

test('1. 入库→归档→读回：assigned:true 归属字段逐项一致，重启后仍在', async (t) => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 2 });
  let reopened = null;
  t.after(() => cleanup(root, reopened, memory));
  memory.open();

  // capacity=2 → compact 目标 = max(1, floor(2*0.85)) = 1；三条活跃记录时溢出 2 条。
  const ASSIGNED = {
    speakerId: 'spk-self',
    assigned: true,
    confidence: 'confirmed',
    source: 'shadow',
    at: '2026-11-09T03:00:00.000Z',
  };
  const written = memory.addMessage({
    role: 'user',
    sessionId: 's-attr',
    turnId: 7,
    messageId: 'voice-assigned',
    ts: '2026-11-09T03:00:00.000Z',
    text: '这条语音记录带确认归属，归档以后也必须还带着它',
    importance: 30,
    speakerAttribution: ASSIGNED,
  });
  assert.equal(written.deduped, false);
  assert.deepEqual(written.record.speakerAttribution, ASSIGNED, 'addMessage returns the validated field as stored');

  // 一条无归属的记录（既是 compact 的第二个候选，也验证“没有归属”的归档行是 NULL），
  // 外加一条 importance 最高的 keeper，保证归档只搬走前两条。
  memory.addMessage({
    role: 'user',
    messageId: 'typed-null',
    ts: '2026-11-09T03:01:00.000Z',
    text: '一条打字记录没有声纹归属，归档后保持没有',
    importance: 50,
  });
  memory.addMessage({
    role: 'assistant',
    messageId: 'voice-keeper',
    ts: '2026-11-09T03:02:00.000Z',
    text: '保留在活跃表里的重要记录',
    importance: 100,
  });
  assert.equal(memory.usage().records, 3);

  // 归档前的权威读回；之后每一步都必须与它相等。
  const beforeValue = memory.messageAttribution('voice-assigned');
  assert.deepEqual(beforeValue, ASSIGNED, 'the active row already carries the attribution');
  assert.equal(activeAttributionRaw(memory, 'voice-assigned'), JSON.stringify(ASSIGNED),
    'the active column holds the serialized attribution');

  fadeAllToTrace(memory);

  // 生产触发：表在 ≥90% 容量带内，maintain() 先 fade 再 compact()。
  const maintained = memory.maintain();
  assert.equal(maintained.band, 3, 'the table sits in the top capacity band');
  assert.equal(maintained.moved, 2, 'maintain archives the two trace rows');
  assert.equal(memory.usage().records, 1, 'only the keeper stays active');
  assert.equal(memory.usage().archived, 2);

  const after = archiveAttribution(memory, 'voice-assigned');
  assert.equal(after.found, true, 'the archived row is readable');
  assert.equal(typeof after.raw, 'string', 'the archived column holds serialized JSON');
  assertAttributionEqual(after.value, beforeValue, '归档行 vs 归档前');
  assert.deepEqual(after.value, ASSIGNED);

  // “没有归属”的记录归档后仍然是 NULL，而不是 "{}" / "null" 字符串。
  const typed = archiveAttribution(memory, 'typed-null');
  assert.equal(typed.found, true);
  assert.equal(typed.raw, null);
  assert.equal(typed.value, null);
  assert.equal(memory.messageAttribution('typed-null'), null);

  // messageAttribution() 只读活跃表：归档后它返回 null 是正确语义（记录已不在活跃表），
  // 归属由归档行本身持有（见上面的 after）。
  assert.equal(memory.messageAttribution('voice-assigned'), null,
    'messageAttribution() reads only the active table');

  // 现有的归档浏览接口能按 messageId 找回该行；若将来它的投影也暴露该字段，必须与库内一致。
  const listed = memory.listArchive({ limit: 10 }).find((row) => row.messageId === 'voice-assigned');
  assert.ok(listed, 'listArchive() still finds the archived message');
  if ('speakerAttribution' in listed) {
    assert.deepEqual(listed.speakerAttribution, ASSIGNED, 'an archive projection that exposes the field must agree');
  }

  // 重启后归档行仍在、值不变：证明它真的落进了 SQLite，而不是只在内存里。
  memory.close();
  reopened = new MemoryStore(root, { capacity: 2 });
  reopened.open();
  const persisted = archiveAttribution(reopened, 'voice-assigned');
  assert.equal(persisted.found, true);
  assertAttributionEqual(persisted.value, beforeValue, '重启后的归档行');

  console.log(`[1] maintain.band=${maintained.band} moved=${maintained.moved} `
    + `before=${JSON.stringify(beforeValue)} after=${JSON.stringify(persisted.value)} raw=${persisted.raw} `
    + `typedNullRaw=${JSON.stringify(typed.raw)} active=${memory.usage().records}`);
});

// ---------------------------------------------------------------------------
// 2. assigned:false / mismatch 原样保留
// ---------------------------------------------------------------------------

test('2. assigned:false 与 confidence:mismatch 原样保留（false/null 不丢字段）', async (t) => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 2 });
  t.after(() => cleanup(root, memory));
  memory.open();

  // assigned:false + 一个其他 speakerId：只作证据，绝不冒充本人。
  const OTHER = {
    speakerId: 'spk-other',
    assigned: false,
    confidence: 'unsure',
    source: 'shadow',
    at: '2026-11-09T03:10:00.000Z',
  };
  // mismatch：连 speakerId 都没有，但 confidence/assigned 仍是真实判定。
  const MISMATCH = {
    speakerId: null,
    assigned: false,
    confidence: 'mismatch',
    source: 'shadow',
    at: '2026-11-09T03:11:00.000Z',
  };
  memory.addMessage({
    role: 'user',
    sessionId: 's-unassigned',
    turnId: 1,
    messageId: 'voice-other',
    ts: '2026-11-09T03:10:00.000Z',
    text: '另一个人的声音，只作为证据保留，不归到本人',
    importance: 30,
    speakerAttribution: OTHER,
  });
  memory.addMessage({
    role: 'user',
    sessionId: 's-unassigned',
    turnId: 1,
    messageId: 'voice-mismatch',
    ts: '2026-11-09T03:11:00.000Z',
    text: '声纹不匹配时也要保留判定结果，不能因为 false 就丢字段',
    importance: 31,
    speakerAttribution: MISMATCH,
  });
  memory.addMessage({
    role: 'assistant',
    messageId: 'voice-keeper',
    ts: '2026-11-09T03:12:00.000Z',
    text: '保留一条活跃记录，让表超过归档目标线',
    importance: 100,
  });

  fadeAllToTrace(memory);
  const compacted = memory.compact({ targetRatio: 0.85 });
  assert.equal(compacted.moved, 2, 'both unassigned rows are archived');

  const other = archiveAttribution(memory, 'voice-other');
  assert.equal(other.found, true);
  assert.equal(other.value.assigned, false);
  assert.ok(Object.hasOwn(other.value, 'assigned'), 'the false flag survives as a real field');
  assert.match(other.raw, /"assigned":false/, 'the stored JSON keeps assigned:false verbatim');
  assert.equal(other.value.speakerId, 'spk-other', 'the other id is kept as evidence');
  assertAttributionEqual(other.value, OTHER, 'assigned:false');

  const mismatch = archiveAttribution(memory, 'voice-mismatch');
  assert.equal(mismatch.found, true);
  assert.equal(mismatch.value.assigned, false);
  assert.ok(Object.hasOwn(mismatch.value, 'speakerId'), 'a null speakerId is kept as a field, not dropped');
  assert.equal(mismatch.value.speakerId, null);
  assert.match(mismatch.raw, /"confidence":"mismatch"/, 'the mismatch verdict survives archiving');
  assertAttributionEqual(mismatch.value, MISMATCH, 'mismatch');

  console.log(`[2] other=${other.raw} mismatch=${mismatch.raw} active=${memory.usage().records}`);
});

// ---------------------------------------------------------------------------
// 3. 旧记录 / 旧归档行：归档后仍为 NULL
// ---------------------------------------------------------------------------

test('3. 旧记录（无该列）归档后仍为 NULL，旧归档行迁移后也仍为 NULL', async (t) => {
  const root = await tempRoot();
  t.after(() => cleanup(root));
  const dir = join(root, 'memory');
  await mkdir(dir, { recursive: true });

  // 一个 84b615e 之前的数据库：memory_event / memory_archive 都没有 speaker_attribution。
  const legacy = new DatabaseSync(join(dir, 'memory.db'));
  legacy.exec(`CREATE TABLE memory_event (
    id TEXT PRIMARY KEY, ts TEXT NOT NULL, domain TEXT NOT NULL, kind TEXT NOT NULL,
    text TEXT NOT NULL, importance INTEGER NOT NULL DEFAULT 50,
    clarity TEXT NOT NULL DEFAULT 'vivid', last_seen TEXT,
    recall_count INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT '',
    message_id TEXT, role TEXT, session_id TEXT, turn_id INTEGER
  )`);
  legacy.exec(`CREATE TABLE memory_archive (
    id TEXT PRIMARY KEY, ts TEXT NOT NULL, domain TEXT NOT NULL, kind TEXT NOT NULL,
    text TEXT NOT NULL, importance INTEGER NOT NULL, clarity TEXT NOT NULL,
    archived_at TEXT NOT NULL, reason TEXT NOT NULL
  )`);
  const insertEvent = legacy.prepare(`INSERT INTO memory_event
    (id, ts, domain, kind, text, importance, clarity, message_id, role, session_id, turn_id)
    VALUES (?, ?, 'chat', 'event', ?, ?, 'vivid', ?, 'user', 's-legacy', 1)`);
  insertEvent.run('old-1', '2026-01-01T00:00:00.000Z', '旧记录一：归档后归属仍应为空', 30, 'old-msg-1');
  insertEvent.run('old-2', '2026-01-01T00:01:00.000Z', '旧记录二：留在活跃表的keeper', 100, 'old-msg-2');
  legacy.prepare(`INSERT INTO memory_archive
    (id, ts, domain, kind, text, importance, clarity, archived_at, reason)
    VALUES ('old-arch-1', '2025-12-01T00:00:00.000Z', 'chat', 'event', '更早归档的旧记录', 50, 'trace',
      '2025-12-02T00:00:00.000Z', 'capacity')`).run();
  legacy.close();

  const memory = new MemoryStore(root, { capacity: 2 });
  let reopened = null;
  t.after(() => cleanup(root, reopened, memory));
  memory.open();

  const eventColumns = new Set(memory.db.prepare('PRAGMA table_info(memory_event)').all().map((row) => row.name));
  const archiveColumns = new Set(memory.db.prepare('PRAGMA table_info(memory_archive)').all().map((row) => row.name));
  assert.ok(eventColumns.has('speaker_attribution'), 'migration added the active column');
  assert.ok(archiveColumns.has('speaker_attribution'), 'migration added the archive column');

  assert.equal(activeAttributionRaw(memory, 'old-msg-1'), null,
    'a legacy row is NULL, not "" and not the string "null"');
  assert.equal(memory.messageAttribution('old-msg-1'), null, 'a legacy row has no attribution');

  fadeAllToTrace(memory);
  const compacted = memory.compact({ targetRatio: 0.85 });
  assert.equal(compacted.moved, 1, 'only the low-importance legacy row is archived');
  assert.equal(memory.usage().records, 1, 'the keeper stays active');

  const archivedLegacy = archiveAttribution(memory, 'old-msg-1');
  assert.equal(archivedLegacy.found, true, 'the legacy row did move to the archive');
  assert.equal(archivedLegacy.raw, null, 'NULL survives archiving (no "null" string, no "{}")');
  assert.equal(archivedLegacy.value, null);
  assert.equal(memory.messageAttribution('old-msg-1'), null);

  const oldArchive = memory.db
    .prepare("SELECT speaker_attribution AS value FROM memory_archive WHERE id = 'old-arch-1'")
    .get();
  assert.equal(oldArchive.value, null, 'a pre-existing archive row stays NULL after migration');

  memory.close();
  reopened = new MemoryStore(root, { capacity: 2 });
  reopened.open();
  assert.equal(archiveAttribution(reopened, 'old-msg-1').raw, null, 'still NULL after a restart');
  assert.equal(reopened.messageAttribution('old-msg-1'), null);

  console.log(`[3] legacyActiveRaw=null legacyArchiveRaw=${JSON.stringify(archivedLegacy.raw)} `
    + `oldArchiveRaw=${JSON.stringify(oldArchive.value)} moved=${compacted.moved}`);
});

// ---------------------------------------------------------------------------
// 4. compact 的反向路径：revertCorrection 从归档恢复 active，归属不丢
// ---------------------------------------------------------------------------

test('4. compact 反向（revertCorrection 归档恢复）后归属仍在', async (t) => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 2 });
  t.after(() => cleanup(root, memory));
  memory.open();

  // 修正声明的归属：它会被 merge 成 hidden，然后被 compact 归档，再被 revert 恢复。
  const CORR = {
    speakerId: 'spk-self',
    assigned: true,
    confidence: 'confirmed',
    source: 'shadow',
    at: '2026-11-09T03:20:00.000Z',
  };
  const corr = memory.addMessage({
    role: 'user',
    sessionId: 's-restore',
    turnId: 2,
    messageId: 'corr-1',
    ts: '2026-11-09T03:20:00.000Z',
    text: '不对，我不叫小满，我叫向晚',
    importance: 30,
    speakerAttribution: CORR,
  });
  const target = memory.addMessage({
    role: 'assistant',
    sessionId: 's-restore',
    turnId: 2,
    messageId: 'target-1',
    ts: '2026-11-09T03:19:00.000Z',
    text: '记住，你叫小满',
    importance: 60,
  });
  memory.addMessage({
    role: 'assistant',
    messageId: 'voice-keeper',
    ts: '2026-11-09T03:21:00.000Z',
    text: '另一条活跃记录，让 compact 有溢出可做',
    importance: 100,
  });

  const corrected = memory.correct({
    targetId: target.record.id,
    expectedVersion: 1,
    expectedText: '小满',
    replacement: '向晚',
    sourceMessageId: 'corr-1',
  });
  assert.equal(corrected.ok, true, `correction applies (${corrected.error || 'ok'})`);
  assert.equal(corrected.supersededId, corr.record.id, 'the correction statement was merged (hidden)');

  const hidden = memory.db
    .prepare(`SELECT hidden, superseded_by AS supersededBy, clarity FROM memory_event WHERE message_id = 'corr-1'`)
    .get();
  assert.deepEqual([hidden.hidden, hidden.supersededBy], [1, target.record.id]);
  assert.equal(hidden.clarity, 'trace', 'the hidden row is already a compact candidate');

  // before=2 条可见记录（target + keeper）> 目标 1：hidden 的 trace 行先被搬进归档；
  // 可见记录里没有 trace（都是 vivid），所以这次 pass 以 limitedBy:'trace' 提前收手。
  const compacted = memory.compact({ targetRatio: 0.85 });
  assert.equal(compacted.moved, 1, 'the hidden trace row moved to the archive');
  assert.equal(compacted.limitedBy, 'trace');
  assert.equal(memory.usage().archived, 1);
  assert.equal(
    memory.db.prepare("SELECT COUNT(*) AS c FROM memory_event WHERE message_id = 'corr-1'").get().c,
    0,
    'the hidden row left the active table',
  );

  const archived = archiveAttribution(memory, 'corr-1');
  assert.equal(archived.found, true);
  assertAttributionEqual(archived.value, CORR, '归档的 hidden 行');
  assert.equal(memory.messageAttribution('corr-1'), null);

  // 反向路径：撤销修正会把这条归档记录重建回 active 表。
  const reverted = memory.revertCorrection(target.record.id, corrected.revisionId);
  assert.equal(reverted.ok, true, `revert succeeds (${reverted.error || 'ok'})`);
  assert.equal(reverted.restoredId, corr.record.id, 'the archived correction record was rebuilt in the active table');
  assert.deepEqual(memory.messageAttribution('corr-1'), CORR, 'the restored active row keeps the same attribution');
  assert.equal(memory.usage().archived, 0, 'the archive row was consumed by the restore');

  const restored = memory.db
    .prepare(`SELECT hidden, superseded_by AS supersededBy FROM memory_event WHERE message_id = 'corr-1'`)
    .get();
  assert.deepEqual([restored.hidden, restored.supersededBy], [0, null], 'the restored row is active again');

  console.log(`[4] archived=${archived.raw} restored=${JSON.stringify(memory.messageAttribution('corr-1'))} `
    + `archivedCount=${memory.usage().archived} limitedBy=${compacted.limitedBy}`);
});
