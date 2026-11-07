/**
 * Message-level auto memory + adjacent/time recall.
 *
 * Covers the acceptance list:
 *   1. the same `messageId` replayed is stored once and costs no pressure;
 *   2. "刚才我用什么问题测试你" finds the user's original words AND the matching reply;
 *   3. "我说过什么" / "你说过什么" separate the two roles;
 *   4. importance 30 records are recallable but `restore()` never promotes them;
 *   5. multi-turn / cross-day / cancelled / retried feeds neither cross-link nor duplicate;
 *   6. minChars / maxChars / enabled:false behave as configured.
 *
 * Run: node --test test/memory-auto.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createAutoMemoryRecorder } from '../src/host/index.js';
import { MemoryStore, normalizeAutoMemory } from '../src/host/memory/store.js';

async function tempRoot() {
  return mkdtemp(join(tmpdir(), 'dsh-mem-auto-'));
}

async function cleanup(root, ...stores) {
  for (const store of stores) {
    try {
      store.close();
    } catch {
      /* already closed */
    }
  }
  await rm(root, { recursive: true, force: true }).catch(() => {});
}

/** In-memory stand-in for `data/events.jsonl`. */
function eventLog() {
  const events = [];
  return {
    events,
    async emit(type, payload) {
      events.push({ type, payload });
      return { type, payload };
    },
  };
}

const iso = (ms) => new Date(ms).toISOString();

/** One `user/message` feed event (the shape the Harness logs). */
function userEvent(id, text, time) {
  return {
    type: 'user/message',
    time,
    data: { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
  };
}

/** One `assistant/message` feed event. */
function assistantEvent(id, text, turn, time, extra = {}) {
  return {
    type: 'assistant/message',
    time,
    data: {
      turn,
      step: 0,
      message: { id, role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text }] },
      stream: [],
      ...extra,
    },
  };
}

const turnStart = (turn, time) => ({ type: 'turn/start', time, data: { turn } });
const turnEnd = (turn, kind, time) => ({ type: 'turn/end', time, data: { turn, reason: { kind } } });

async function runTurn(recorder, sessionId, { turn, at, userId, userText, assistantId, assistantText, endKind = 'completed' }) {
  const session = { id: sessionId };
  await recorder.handle(session, turnStart(turn, at));
  await recorder.handle(session, userEvent(userId, userText, at));
  if (assistantId !== undefined) {
    await recorder.handle(session, assistantEvent(assistantId, assistantText, turn, at + 1000));
  }
  await recorder.handle(session, turnEnd(turn, endKind, at + 2000));
}

/** Two real rounds in one dated session, exactly the data the "刚才" question should recover. */
function seedTwoRounds(memory, now) {
  memory.addMessage({
    role: 'user',
    sessionId: 'seirein-2026-11-04',
    turnId: 1,
    messageId: 'seed-u1',
    ts: iso(now - 12 * 60_000),
    text: '我用「语音识别的延迟是多少」这个问题测试你，看看快路回答快不快',
  });
  memory.addMessage({
    role: 'assistant',
    sessionId: 'seirein-2026-11-04',
    turnId: 1,
    messageId: 'seed-a1',
    ts: iso(now - 11 * 60_000),
    text: '你刚才问的是语音识别延迟，实测首音 p95 大约 1.2 秒。',
  });
  memory.addMessage({
    role: 'user',
    sessionId: 'seirein-2026-11-04',
    turnId: 2,
    messageId: 'seed-u2',
    ts: iso(now - 5 * 60_000),
    text: '那字幕呢，字幕默认打开吗',
  });
  memory.addMessage({
    role: 'assistant',
    sessionId: 'seirein-2026-11-04',
    turnId: 2,
    messageId: 'seed-a2',
    ts: iso(now - 4 * 60_000),
    text: '字幕默认是关闭的，可以在设置里打开。',
  });
}

test('1) replaying the same messageId stores one row and charges no extra pressure', async (t) => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 2000 });
  t.after(() => cleanup(root, memory));
  const message = {
    role: 'user',
    sessionId: 'session-1',
    turnId: 7,
    messageId: 'replay-1',
    text: '这条消息会被重放两次',
  };

  const first = memory.addMessage(message);
  assert.equal(first.deduped, false);
  assert.equal(first.record.importance, 30, 'auto originals start at importance 30');
  assert.equal(first.record.source, 'auto');
  const pressureAfterFirst = memory.policyState().pendingPressure;

  const second = memory.addMessage(message);
  assert.equal(second.deduped, true, 'the replay is recognised');
  assert.equal(second.record, null);
  assert.equal(memory.messageRecords({ limit: 100 }).length, 1, 'one row, not two');
  assert.equal(memory.policyState().pendingPressure, pressureAfterFirst, 'replay costs no pressure');

  console.log(`[1] records=1 pendingPressure=${pressureAfterFirst} (unchanged after replay)`);
});

test('2) "刚才我用什么问题测试你" recovers the user original and its reply', async (t) => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 2000 });
  t.after(() => cleanup(root, memory));
  const now = Date.now();
  seedTwoRounds(memory, now);

  const recalled = memory.recall({ query: '刚才我用什么问题测试你', now: new Date(now) });
  assert.ok(['keyword', 'time', 'adjacent'].includes(recalled.mode), `mode is one of the enum (${recalled.mode})`);
  assert.deepEqual(recalled.roles, ['user', 'assistant'], 'no explicit role filter for this question');
  assert.equal(recalled.window, 1, 'fixed ±one-turn window');

  const userHit = recalled.hits.find((hit) => hit.role === 'user' && hit.text.includes('语音识别的延迟是多少'));
  const replyHit = recalled.hits.find((hit) => hit.role === 'assistant' && hit.text.includes('1.2 秒'));
  assert.ok(userHit !== undefined, 'the user original is recovered');
  assert.ok(replyHit !== undefined, 'the assistant reply in the same turn is recovered');
  assert.equal(userHit.sessionId, 'seirein-2026-11-04');
  assert.equal(userHit.turnId, 1);
  assert.equal(replyHit.turnId, 1, 'the reply belongs to the same turn');
  assert.ok(recalled.hits.length <= 6, 'at most 6 rows');
  const chars = recalled.hits.reduce((total, hit) => total + hit.text.length, 0);
  assert.ok(chars <= 600, `total chars stayed within 600 (${chars})`);

  console.log(`[2] mode=${recalled.mode} roles=${recalled.roles.join('+')} window=${recalled.window} rows=${recalled.hits.length} chars=${chars}`);
  console.log(`[2] 找回原话：${userHit.text}`);
  console.log(`[2] 对应回答：${replyHit.text}`);
});

test('3) "我说过什么" and "你说过什么" filter by role', async (t) => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 2000 });
  t.after(() => cleanup(root, memory));
  seedTwoRounds(memory, Date.now());

  const mine = memory.recall({ query: '我说过什么' });
  const yours = memory.recall({ query: '你说过什么' });
  assert.deepEqual(mine.roles, ['user']);
  assert.deepEqual(yours.roles, ['assistant']);
  assert.ok(mine.hits.length > 0 && yours.hits.length > 0, 'both questions return rows');
  assert.ok(mine.hits.every((hit) => hit.role === 'user'), 'only user originals');
  assert.ok(yours.hits.every((hit) => hit.role === 'assistant'), 'only assistant originals');
  assert.ok(mine.hits.some((hit) => hit.text.includes('语音识别的延迟是多少')));
  assert.ok(mine.hits.every((hit) => !hit.text.includes('1.2 秒')), 'the reply never leaks into "我说过什么"');
  assert.ok(yours.hits.some((hit) => hit.text.includes('1.2 秒')));
  assert.ok(yours.hits.every((hit) => !hit.text.includes('语音识别的延迟是多少')), 'the original never leaks into "你说过什么"');

  console.log(`[3] 我说过什么 → user×${mine.hits.length}; 你说过什么 → assistant×${yours.hits.length}`);
});

test('4) an importance-30 record is recallable but restore() does not promote it', async (t) => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 2000 });
  t.after(() => cleanup(root, memory));
  const added = memory.addMessage({
    role: 'user',
    sessionId: 'session-low',
    turnId: 1,
    messageId: 'low-1',
    text: '低重要性的原话也应该能被检索到',
  });
  const id = added.record.id;

  const recalled = memory.recall({ query: '低重要性的原话' });
  assert.ok(recalled.hits.some((hit) => hit.id === id), 'auto record is eligible for recall');
  assert.equal(recalled.hits.find((hit) => hit.id === id).importance, 30);

  memory.restore([id]);
  const afterRestore = memory.db.prepare('SELECT importance, clarity FROM memory_event WHERE id = ?').get(id);
  assert.equal(afterRestore.importance, 30, 'restore() leaves importance below 50 untouched');
  assert.equal(afterRestore.clarity, 'vivid', 'restore() leaves clarity untouched too');

  // The explicit confirmation path is the way up, not a hidden restore() side effect.
  const promoted = memory.promote(id, { importance: 55 });
  assert.equal(promoted.importance, 55, 'a manual confirmation can lift an auto record');

  console.log('[4] recallable at importance=30; restore() → 30; promote() → 55');
});

test('5) multi-turn / cancelled / retried / cross-day feeds neither cross-link nor duplicate', async (t) => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 2000 });
  const log = eventLog();
  const recorder = createAutoMemoryRecorder({
    memory,
    log,
    settings: () => normalizeAutoMemory({ enabled: true, minChars: 2, maxChars: 400, includeReply: true }),
  });
  t.after(() => cleanup(root, memory));

  const today = Date.now();
  const yesterday = today - 24 * 3600_000;
  // Turn ids are deliberately non-contiguous (1, 4, 9): adjacency is by conversation order,
  // never by `turnId ± 1`.
  await runTurn(recorder, 's1', {
    turn: 1, at: today - 3 * 3600_000, userId: 'u1', userText: '第一轮：帮我比较两个方案',
    assistantId: 'a1', assistantText: '第一轮回答：方案 A 更稳妥。',
  });
  // Cancelled turn: the user's words stay, the draft reply must not.
  await runTurn(recorder, 's1', {
    turn: 4, at: today - 2 * 3600_000, userId: 'u2', userText: '第二轮：那就再展开说说方案 A',
    assistantId: 'a2', assistantText: '这段是被取消的草稿，不应该入库。', endKind: 'aborted',
  });
  await runTurn(recorder, 's1', {
    turn: 9, at: today - 3600_000, userId: 'u3', userText: '第三轮：缓存目录放在哪里',
    assistantId: 'a3', assistantText: '第三轮回答：缓存目录在 cache 子目录。',
  });

  let rows = memory.messageRecords({ limit: 100 });
  assert.equal(rows.length, 5, 'three user messages + two delivered replies');
  assert.ok(rows.every((row) => row.messageId !== 'a2'), 'the cancelled draft never landed');
  assert.ok(rows.some((row) => row.messageId === 'u2'), 'the user utterance of a cancelled turn still counts');
  assert.equal(recorder.pending(), 0, 'no assistant message is left buffered');

  // Retry the first turn with the same message ids: nothing is added, nothing is doubled.
  await runTurn(recorder, 's1', {
    turn: 1, at: today - 3 * 3600_000, userId: 'u1', userText: '第一轮：帮我比较两个方案',
    assistantId: 'a1', assistantText: '第一轮回答：方案 A 更稳妥。',
  });
  rows = memory.messageRecords({ limit: 100 });
  assert.equal(rows.length, 5, 'the retry is idempotent');
  assert.equal(new Set(rows.map((row) => row.messageId)).size, rows.length, 'message ids are unique');

  // A different dated session must never appear in this one's adjacency window.
  await runTurn(recorder, 's2', {
    turn: 1, at: yesterday, userId: 'x1', userText: '昨天的跨日问题：旧会话说了什么',
    assistantId: 'x2', assistantText: '昨天的回答：旧会话里的另一段对话。',
  });

  const here = memory.recall({ query: '缓存目录放在哪里' });
  assert.ok(here.hits.length > 0);
  assert.ok(here.hits.every((hit) => hit.sessionId === 's1'), 'adjacency never crosses the session boundary');
  assert.ok(here.hits.some((hit) => hit.messageId === 'u3'));
  assert.ok(here.hits.some((hit) => hit.messageId === 'a3'));

  const there = memory.recall({ query: '跨日问题' });
  assert.ok(there.hits.length > 0);
  assert.ok(there.hits.every((hit) => hit.sessionId === 's2'), 'the old session stays self-contained');

  // A turn may deliver more than one assistant message; each delivered body is its own record.
  const multi = { id: 's3' };
  await recorder.handle(multi, turnStart(11, today));
  await recorder.handle(multi, userEvent('m-u', '这一轮会有两段回答', today));
  await recorder.handle(multi, assistantEvent('m-a1', '第一段回答。', 11, today + 1000));
  await recorder.handle(multi, assistantEvent('m-a2', '第二段回答。', 11, today + 2000));
  await recorder.handle(multi, turnEnd(11, 'completed', today + 3000));
  const multiRows = memory.messageRecords({ sessionId: 's3', limit: 10 });
  assert.deepEqual(
    multiRows.map((row) => row.messageId).sort(),
    ['m-a1', 'm-a2', 'm-u'],
    'both assistant messages of a turn land separately',
  );

  console.log(`[5] s1 rows=${memory.messageRecords({ sessionId: 's1', limit: 100 }).length} (retry unchanged), cancelled draft absent, cross-session isolated, multi-reply×2`);
});

test('6) minChars / maxChars / enabled:false / includeReply are honoured', async (t) => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 2000 });
  t.after(() => cleanup(root, memory));

  // enabled:false: the lane is completely inert (no row, no memory.auto event).
  const offLog = eventLog();
  const off = createAutoMemoryRecorder({ memory, log: offLog, settings: { enabled: false } });
  await runTurn(off, 'off', {
    turn: 1, at: Date.now(), userId: 'off-u', userText: '关闭时这句话不该入库',
    assistantId: 'off-a', assistantText: '关闭时这句回答也不该入库。',
  });
  assert.equal(memory.messageRecords({ limit: 100 }).length, 0);
  assert.equal(offLog.events.filter((event) => event.type === 'memory.auto').length, 0);

  // minChars: 2 drops "嗯" but keeps "嗯嗯".
  const shortLog = eventLog();
  const shortRecorder = createAutoMemoryRecorder({
    memory,
    log: shortLog,
    settings: { enabled: true, minChars: 2, maxChars: 400, includeReply: true },
  });
  await runTurn(shortRecorder, 'short', {
    turn: 1, at: Date.now(), userId: 'short-u1', userText: '嗯', assistantId: undefined,
  });
  assert.equal(memory.messageRecords({ limit: 100 }).length, 0, 'a one-character utterance is skipped');
  const skipped = shortLog.events.find((event) => event.type === 'memory.auto' && event.payload.role === 'user');
  assert.equal(skipped.payload.records, 0);
  assert.equal(skipped.payload.deduped, 0);

  await runTurn(shortRecorder, 'short', {
    turn: 2, at: Date.now(), userId: 'short-u2', userText: '嗯嗯', assistantId: undefined,
  });
  assert.equal(memory.messageRecords({ limit: 100 }).length, 1, '"嗯嗯" reaches the minimum and is kept');

  // maxChars is a recall display budget now: storage keeps the complete body, and the injected
  // view is clipped per message with `displayTruncated: true`.
  const longText = '这是一句很长很长的话，用来确认截断标记确实写进了记忆库里，而不是被静默丢弃。';
  const longRecorder = createAutoMemoryRecorder({
    memory,
    log: eventLog(),
    settings: { enabled: true, minChars: 2, maxChars: 10, includeReply: true },
  });
  await runTurn(longRecorder, 'long', {
    turn: 1, at: Date.now(), userId: 'long-u', userText: longText, assistantId: undefined,
  });
  const stored = memory.messageRecords({ limit: 10 }).find((row) => row.messageId === 'long-u');
  assert.equal(stored.text, longText, 'the whole body is stored');
  assert.equal(stored.text.length, longText.length, 'storage is never cut by maxChars');
  assert.equal(stored.truncated, 0, 'storage is not truncated');
  const shown = memory.recall({ query: '很长很长', displayChars: 10 });
  const shownHit = shown.hits.find((hit) => hit.messageId === 'long-u');
  assert.equal(shownHit.text.length, 10, 'the display view is cut to maxChars');
  assert.ok(shownHit.text.endsWith('…'), 'display truncation is visible');
  assert.equal(shownHit.displayTruncated, true, 'the display flag is reported');
  assert.equal(shownHit.truncated, 1, 'the same flag is readable through `truncated`');
  assert.equal(
    memory.messageRecords({ limit: 10 }).find((row) => row.messageId === 'long-u').text,
    longText,
    'the stored row is untouched after recall',
  );

  // includeReply:false keeps the user's original but not the assistant reply.
  const userOnly = createAutoMemoryRecorder({
    memory,
    log: eventLog(),
    settings: { enabled: true, minChars: 2, maxChars: 400, includeReply: false },
  });
  await runTurn(userOnly, 'user-only', {
    turn: 1, at: Date.now(), userId: 'uo-u', userText: '只记原话的配置',
    assistantId: 'uo-a', assistantText: '这段助手回复不该入库。',
  });
  const userOnlyRows = memory.messageRecords({ sessionId: 'user-only', limit: 10 });
  assert.deepEqual(userOnlyRows.map((row) => row.messageId), ['uo-u']);

  // Injected context is not something either side said: the plugin's memory block is stripped,
  // and the daily continuity digest is not recorded at all.
  const clean = createAutoMemoryRecorder({
    memory,
    log: eventLog(),
    settings: { enabled: true, minChars: 2, maxChars: 400, includeReply: true },
  });
  await runTurn(clean, 'clean', {
    turn: 1,
    at: Date.now(),
    userId: 'clean-u',
    userText: '## 相关记忆（供参考）\n- [提炼] 一条旧记忆\n\n用户真正说的这句话',
    assistantId: undefined,
  });
  const cleanRow = memory.messageRecords({ sessionId: 'clean', limit: 10 })[0];
  assert.equal(cleanRow.text, '用户真正说的这句话', 'the injected memory block is stripped');
  await runTurn(clean, 'digest', {
    turn: 1,
    at: Date.now(),
    userId: 'digest-u',
    userText: '【2026-11-04 周三】以下内容作为长期约束与背景，不需要逐条复述。',
    assistantId: undefined,
  });
  assert.equal(memory.messageRecords({ sessionId: 'digest', limit: 10 }).length, 0, 'the digest is not a user utterance');

  // Capacity estimate from the rows this suite actually stored, plus one representative turn.
  const autoRows = memory.messageRecords({ limit: 100 });
  const avg = autoRows.reduce((total, row) => total + row.text.length, 0) / Math.max(1, autoRows.length);
  const sampleUser = '刚才我们说的语音识别延迟和字幕默认状态，你再帮我确认一下细节。';
  const sampleReply = '好的，我来确认：语音识别首音延迟 p95 大约 1.2 秒，字幕默认关闭，可以在设置页的记忆卡片下面打开。如果还要调整，告诉我具体场景，我再给一组更细的数据和结论。';
  const perTurn = sampleUser.length + sampleReply.length;
  console.log(
    `[6] 控制行 avg=${avg.toFixed(1)} chars/message; 典型一轮 ${sampleUser.length}+${sampleReply.length}=${perTurn} 字符; `
    + `100 句（50 轮）≈ ${perTurn * 50} 字符, 100 条记录 = ${(100 / 2000 * 100).toFixed(1)}% of capacity 2000`,
  );
});
