/**
 * Memory records ↔ shared-lexicon ids.
 *
 * A memory record may carry `lexiconIds: string[]` — stable lexicon entry ids only, never a copy
 * of the entry's spelling/definition. This suite pins the acceptance items:
 *
 *   1. the store schema gains a nullable `lexicon_ids` column and migrates an old database in
 *      place; old rows read back with no association (an omitted field, not `[]`);
 *   2. the write path normalizes: trim, drop bad values, de-duplicate, cap at 8, and stores ids
 *      only (the memory body is byte-for-byte unchanged);
 *   3. `assistant_remember` accepts `lexiconIds`, and `assistant_recall` / `assistant_memory_brief`
 *      return them on their records; the tool schemas declare request + output fields;
 *   4. adding an association does not change recall ranking, and `assistant_memory_correct`
 *      does not rewrite the association;
 *   5. every read projection returns the public array shape, never the internal column text.
 *
 * Run: node --test test/memory-lexicon-ids.mjs
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { apply } from '../src/host/index.js';
import { MemoryStore } from '../src/host/memory/store.js';
import { cleanupRoot } from './helpers/cleanup.mjs';

/** Mount the real plugin against a fake context, exactly as the host does. */
function mount(root) {
  const tools = new Map();
  const disposers = [];
  const ctx = {
    effect: (fn) => {
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
      return dispose;
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    inject: (_names, callback) => callback({
      effect: (fn) => {
        const dispose = fn();
        if (typeof dispose === 'function') disposers.push(dispose);
        return dispose;
      },
      webServer: { register: () => () => {} },
      systemPrompt: { section: () => () => {} },
    }),
  };
  apply(ctx, { root, defaultDomain: 'chat', enabled: true });
  return { tools, disposers };
}

/**
 * One store plus its temp root. The single after hook closes the database BEFORE removing the
 * directory: on Windows an open WAL/SHM handle makes the unlink fail with EBUSY.
 */
async function tempStore(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const store = new MemoryStore(root);
  store.open();
  t.after(async () => {
    store.close();
    await cleanupRoot(root, []);
  });
  return { root, store };
}

async function mounted(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-lexicon-ids-'));
  const { tools, disposers } = mount(root);
  t.after(async () => cleanupRoot(root, disposers));
  return { tools, root };
}

const FIXED_NOW = new Date('2026-11-10T12:00:00.000Z');

test('store write/read returns normalized ids only and leaves the body untouched', async (t) => {
  const { store } = await tempStore(t, 'dsh-memory-lexicon-store-');

  const raw = [
    ' lex-b ', 'lex-a', 'lex-b', '', 7, null, {}, 'lex-c', 'lex-d', 'lex-e',
    'lex-f', 'lex-g', 'lex-h', 'lex-i', 'lex-j',
  ];
  const expected = ['lex-b', 'lex-a', 'lex-c', 'lex-d', 'lex-e', 'lex-f', 'lex-g', 'lex-h'];
  const record = store.add('chat', '向晚的生日是十一月一日。', 'fact', {
    source: 'manual',
    importance: 90,
    lexiconIds: raw,
  });
  assert.deepEqual(record.lexiconIds, expected, 'write normalizes trim/dedupe/bad values/cap');
  assert.equal(record.text, '向晚的生日是十一月一日。', 'the memory body never carries the ids');
  for (const id of expected) assert.equal(record.text.includes(id), false, `body does not contain ${id}`);

  const stored = store.getActiveById(record.id);
  assert.deepEqual(stored.lexiconIds, expected, 'read projection returns the array');
  assert.equal(Object.hasOwn(stored, 'lexicon_ids'), false, 'the internal column never leaks');
  assert.deepEqual(store.lexiconIdsByIds([record.id]).get(record.id), expected, 'batch read agrees');

  const recalled = store.recall({ query: '向晚', now: FIXED_NOW, budgetChars: 1200, maxRecords: 6 });
  const hit = recalled.hits.find((row) => row.id === record.id);
  assert.ok(hit, 'the memory is recallable');
  assert.deepEqual(hit.lexiconIds, expected, 'recall returns the ids as an array');
  assert.equal(hit.text, record.text, 'foreground text is unchanged');

  const brief = store.brief({ query: '向晚', displayChars: 400 });
  const fixed = brief.fixed.find((row) => row.id === record.id);
  assert.ok(fixed, 'a high-importance record reaches the fixed brief layer');
  assert.deepEqual(fixed.lexiconIds, expected, 'brief fixed records carry the ids');
  assert.equal(brief.text.includes('lex-b'), false, 'the rendered brief copies no ids into the body');

  const changed = store.setLexiconIds(record.id, [' x ', 'x', 'y', 5, '']);
  assert.deepEqual(changed, ['x', 'y']);
  assert.deepEqual(store.getActiveById(record.id).lexiconIds, ['x', 'y']);

  const cleared = store.setLexiconIds(record.id, ['', 7, null]);
  assert.deepEqual(cleared, []);
  assert.equal(Object.hasOwn(store.getActiveById(record.id), 'lexiconIds'), false, 'an empty list is omitted');

  // The message-level write path accepts the same optional field.
  const message = store.addMessage({
    role: 'user',
    messageId: 'msg-lex',
    text: '一条带有词条关联的消息记录。',
    lexiconIds: ['lex-msg', ' lex-msg ', 3],
  });
  assert.deepEqual(message.record.lexiconIds, ['lex-msg']);
  assert.deepEqual(store.getActiveById(message.record.id).lexiconIds, ['lex-msg']);
});

test('adding ids does not change recall order or scores', async (t) => {
  const { store } = await tempStore(t, 'dsh-memory-lexicon-rank-');

  const first = store.add('chat', '排序词：第一件记录', 'fact', { importance: 60 });
  store.add('chat', '排序词：第二件记录', 'fact', { importance: 60 });
  const options = { query: '排序词', now: FIXED_NOW, budgetChars: 1200, maxRecords: 6 };
  const before = store.recall(options);
  const beforeIds = before.hits.map((row) => row.id);
  const beforeScores = before.hits.map((row) => row.score);

  store.setLexiconIds(first.id, ['lex-rank']);
  const after = store.recall(options);
  assert.deepEqual(after.hits.map((row) => row.id), beforeIds, 'ranking order is unchanged');
  assert.deepEqual(after.hits.map((row) => row.score), beforeScores, 'scores are unchanged');
  assert.deepEqual(
    after.hits.map((row) => row.text),
    before.hits.map((row) => row.text),
    'bodies are unchanged',
  );
  const linked = after.hits.find((row) => row.id === first.id);
  assert.deepEqual(linked.lexiconIds, ['lex-rank']);
});

test('an old database gains the nullable column and legacy rows read as no links', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-lexicon-migrate-'));
  await mkdir(join(root, 'memory'), { recursive: true });
  const { DatabaseSync } = await import('node:sqlite');
  const file = join(root, 'memory', 'memory.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE memory_event (
    id TEXT PRIMARY KEY,
    ts TEXT NOT NULL,
    domain TEXT NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    importance INTEGER NOT NULL DEFAULT 50,
    clarity TEXT NOT NULL DEFAULT 'vivid',
    last_seen TEXT,
    recall_count INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT ''
  )`);
  old.prepare(`INSERT INTO memory_event
    (id, ts, domain, kind, text, importance, clarity, last_seen, recall_count, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'legacy-1',
    '2026-11-01T00:00:00.000Z',
    'chat',
    'fact',
    '旧库记录：迁移前就存在。',
    90,
    'vivid',
    '2026-11-01T00:00:00.000Z',
    0,
    'manual',
  );
  old.close();

  const store = new MemoryStore(root);
  store.open();
  t.after(async () => {
    store.close();
    await cleanupRoot(root, []);
  });
  const columns = store.db.prepare('PRAGMA table_info(memory_event)').all().map((row) => row.name);
  assert.ok(columns.includes('lexicon_ids'), 'the nullable lexicon_ids column was added');

  const legacy = store.getActiveById('legacy-1');
  assert.ok(legacy, 'the old row survives the migration');
  assert.equal(Object.hasOwn(legacy, 'lexiconIds'), false, 'a legacy row has no invented association');

  const recalled = store.recall({ query: '旧库记录', now: FIXED_NOW, budgetChars: 1200, maxRecords: 6 });
  const hit = recalled.hits.find((row) => row.id === 'legacy-1');
  assert.ok(hit, 'the legacy row is recallable');
  assert.equal(Object.hasOwn(hit, 'lexiconIds'), false, 'recall leaves a legacy row untouched');

  store.setLexiconIds('legacy-1', ['lex-legacy']);
  assert.deepEqual(store.getActiveById('legacy-1').lexiconIds, ['lex-legacy'],
    'the migrated column accepts a new association');
});

test('host tools write and return lexiconIds; schemas declare the field', async (t) => {
  const { tools } = await mounted(t);
  const remember = tools.get('assistant_remember');
  const recall = tools.get('assistant_recall');
  const brief = tools.get('assistant_memory_brief');
  const correct = tools.get('assistant_memory_correct');

  // Request schema: optional array of strings, capped at 8.
  const requestField = remember.parameters.properties.lexiconIds;
  assert.ok(requestField, 'assistant_remember declares lexiconIds');
  assert.equal(requestField.type, 'array');
  assert.equal(requestField.items.type, 'string');
  assert.equal(requestField.maxItems, 8);
  assert.match(requestField.description, /id/u);

  // Output schemas: the projection wrappers may add the field, so it must be declared.
  assert.ok(recall.output.schema.properties.hits.items.properties.lexiconIds, 'recall hits declare lexiconIds');
  assert.ok(brief.output.schema.properties.fixedRecords.items.properties.lexiconIds,
    'brief fixedRecords declare lexiconIds');
  assert.ok(brief.output.schema.properties.matchedRecords.items.properties.lexiconIds,
    'brief matchedRecords declare lexiconIds');
  assert.ok(remember.output.schema.properties.lexiconIds, 'remember output declares lexiconIds');

  const unique = Array.from({ length: 10 }, (_value, index) => `lex-${index}`);
  const remembered = await remember.execute({
    text: '向晚的生日是十一月一日。',
    importance: 90,
    lexiconIds: [' lex-0 ', 'lex-0', '', 7, null, ...unique],
  }, {});
  assert.ok(typeof remembered.id === 'string' && remembered.id.length > 0, 'the memory was written');
  assert.deepEqual(remembered.lexiconIds, unique.slice(0, 8),
    'the response reports the normalized, capped ids');

  const recalled = await recall.execute({ query: '向晚' }, {});
  const hit = recalled.hits.find((row) => row.id === remembered.id);
  assert.ok(hit, 'assistant_recall returns the new memory');
  assert.deepEqual(hit.lexiconIds, unique.slice(0, 8), 'assistant_recall returns the ids');
  assert.equal(hit.text, '向晚的生日是十一月一日。', 'the body is unchanged');
  assert.equal(hit.text.includes('lex-0'), false, 'ids never enter the body');

  const briefed = await brief.execute({ query: '向晚' }, {});
  const fixed = briefed.fixedRecords.find((row) => row.id === remembered.id);
  assert.ok(fixed, 'the high-importance memory reaches the brief fixed list');
  assert.deepEqual(fixed.lexiconIds, unique.slice(0, 8), 'assistant_memory_brief returns the ids');
  assert.equal(briefed.text.includes('lex-0'), false, 'the brief text carries no ids');

  // A correction rewrites the body only; the association survives untouched.
  const corrected = await correct.execute({
    targetId: remembered.id,
    expectedVersion: hit.version,
    expectedText: '十一月一日',
    replacement: '十一月二日',
  }, {});
  assert.equal(corrected.ok, true, `correction succeeds: ${corrected.error ?? ''}`);
  const after = await recall.execute({ query: '向晚' }, {});
  const correctedHit = after.hits.find((row) => row.id === remembered.id);
  assert.ok(correctedHit, 'the corrected record is recallable');
  assert.equal(correctedHit.text, '向晚的生日是十一月二日。');
  assert.deepEqual(correctedHit.lexiconIds, unique.slice(0, 8), 'correct does not change the association');
});

test('a remember call with only bad ids writes no association', async (t) => {
  const { tools } = await mounted(t);
  const remember = tools.get('assistant_remember');
  const recall = tools.get('assistant_recall');
  const value = await remember.execute({
    text: '没有有效关联词的记录。',
    importance: 70,
    lexiconIds: [null, 7, '', '   ', {}],
  }, {});
  assert.equal(Object.hasOwn(value, 'lexiconIds'), false, 'the response omits an empty association');
  const recalled = await recall.execute({ query: '没有有效关联词' }, {});
  const hit = recalled.hits.find((row) => row.id === value.id);
  assert.ok(hit);
  assert.equal(Object.hasOwn(hit, 'lexiconIds'), false, 'the stored row has no association');
});
