/**
 * Lexicon assistant tool — pure local core.
 *
 * The list mirrors the acceptance items:
 *   1. user-explicit add/update/remove really change the store, and every returned entry is the
 *      safe view;
 *   2. assistant-discovered may only propose candidates — add/update/remove are refused and a
 *      proposal never becomes an effective word;
 *   3. query is exact by id/text and recalls locally for a longer text, without leaking
 *      wrongForms/embedding/paths or any other internal store field;
 *   4. a duplicate confirmed row with a different meaning returns `needs-revision` and is not
 *      overwritten (add and propose); the same meaning returns `exists`;
 *   5. malformed calls, bad fields/limits and duplicate/rename collisions return stable reasons;
 *   6. the pure core is synchronous/local and works with both accepted call shapes.
 *
 * Run: node --test test/lexicon-tool.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createLexiconStore } from '../src/host/speech/lexicon-store.js';
import {
  LEXICON_TOOL_SAFE_FIELDS,
  createLexiconTool,
  runLexiconTool,
} from '../src/host/speech/lexicon-tool.js';

const T0 = '2026-11-10T09:00:00+08:00';
const USER = 'user-explicit';
const DISCOVERED = 'assistant-discovered';
const SAFE = new Set(LEXICON_TOOL_SAFE_FIELDS);

function tempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'seirein-lexicon-tool-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  return root;
}

function makeStore(t) {
  return createLexiconStore({
    root: tempRoot(t),
    clock: () => new Date(T0),
  });
}

function invoke(store, action, authorization, params = {}) {
  return runLexiconTool({store, action, authorization, ...params});
}

function assertSafe(view) {
  assert.equal(view !== null && typeof view === 'object' && !Array.isArray(view), true);
  for (const key of Object.keys(view)) {
    assert.equal(SAFE.has(key), true, `unsafe field leaked: ${key}`);
  }
}

/** A store whose read view is deliberately hostile; only query may use it here. */
function hostileStore(entry) {
  const forbidden = () => {
    throw new Error('this test store is read-only');
  };
  return {
    listConfirmed: () => [entry],
    listCandidates: () => [],
    addEntry: forbidden,
    updateEntry: forbidden,
    removeEntry: forbidden,
  };
}

/** A five-method double with no candidate seam, for the propose capability failure. */
function noCandidateSeamStore() {
  return {
    listConfirmed: () => [],
    listCandidates: () => [],
    addEntry: () => ({ok: false, reason: 'not-used'}),
    updateEntry: () => ({ok: false, reason: 'not-used'}),
    removeEntry: () => ({ok: false, reason: 'not-used'}),
  };
}

test('1. user-explicit add/update/remove（安全视图生效）', (t) => {
  const store = makeStore(t);

  const added = invoke(store, 'add', USER, {
    text: '向晚',
    category: 'person',
    usage: '角色名',
    reading: 'xiang wan',
    library: 'public',
  });
  assert.equal(added.ok, true);
  assert.equal(added.action, 'add');
  assertSafe(added.entry);
  assert.equal(added.entry.text, '向晚');
  assert.equal(added.entry.canonical, '向晚');
  assert.equal(added.entry.category, 'person');
  assert.equal(added.entry.usage, '角色名');
  assert.equal(added.entry.reading, 'xiang wan');
  assert.equal(added.entry.library, 'public');
  assert.equal(added.entry.status, 'confirmed');
  assert.equal(typeof added.entry.id, 'string');
  assert.equal(store.listConfirmed().length, 1);

  const updated = invoke(store, 'update', USER, {
    id: added.entry.id,
    canonical: '向晚晚',
    category: 'character',
    usage: '更新后的用法',
    reading: 'xiang wan wan',
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.action, 'update');
  assertSafe(updated.entry);
  assert.equal(updated.entry.id, added.entry.id);
  assert.equal(updated.entry.canonical, '向晚晚');
  assert.equal(updated.entry.text, '向晚晚');
  assert.equal(updated.entry.category, 'character');
  assert.equal(updated.entry.usage, '更新后的用法');
  assert.equal(updated.entry.reading, 'xiang wan wan');
  assert.equal(store.listConfirmed()[0].canonical, '向晚晚');

  // With an id, `text` is an editable spelling, exactly as store.updateEntry treats it.
  const renamed = invoke(store, 'update', USER, {id: added.entry.id, text: '向晚酱'});
  assert.equal(renamed.ok, true);
  assert.equal(renamed.entry.canonical, '向晚酱');
  assert.equal(renamed.entry.text, '向晚酱');

  // Without an id, `text` is the selector and `canonical` is the rename field.
  const byText = invoke(store, 'update', USER, {text: '向晚酱', reading: 'wan'});
  assert.equal(byText.ok, true);
  assert.equal(byText.entry.reading, 'wan');
  assert.equal(byText.entry.canonical, '向晚酱');
  assert.equal(store.listConfirmed()[0].canonical, '向晚酱');

  const removed = invoke(store, 'remove', USER, {text: '向晚酱'});
  assert.equal(removed.ok, true);
  assert.equal(removed.action, 'remove');
  assertSafe(removed.entry);
  assert.equal(removed.entry.id, added.entry.id);
  assert.equal(removed.entry.category, 'character', 'the pre-delete safe view is returned');
  assert.equal(removed.entry.usage, '更新后的用法');
  assert.deepEqual(store.listConfirmed(), []);

  console.log('[1] added=', JSON.stringify(added.entry),
    'updated=', JSON.stringify(updated.entry), 'removed=', JSON.stringify(removed.entry));
});

test('2. assistant-discovered 只能 propose：add/update/remove 拒绝，候选不生效', (t) => {
  const store = makeStore(t);

  const refusedAdd = invoke(store, 'add', DISCOVERED, {text: '林晚', category: 'person'});
  assert.equal(refusedAdd.ok, false);
  assert.equal(refusedAdd.action, 'add');
  assert.equal(refusedAdd.reason, 'forbidden');
  assert.deepEqual(store.list(), [], 'a refused add wrote nothing');

  const refusedUpdate = invoke(store, 'update', DISCOVERED, {id: 'lex-1', category: 'person'});
  assert.equal(refusedUpdate.ok, false);
  assert.equal(refusedUpdate.reason, 'forbidden');

  const refusedRemove = invoke(store, 'remove', DISCOVERED, {id: 'lex-1'});
  assert.equal(refusedRemove.ok, false);
  assert.equal(refusedRemove.reason, 'forbidden');

  const proposed = invoke(store, 'propose', DISCOVERED, {text: '林晚'});
  assert.equal(proposed.ok, true);
  assert.equal(proposed.action, 'propose');
  assert.equal(proposed.candidates.length, 1);
  assertSafe(proposed.candidates[0]);
  assert.equal(proposed.candidates[0].text, '林晚');
  assert.equal(proposed.candidates[0].status, 'candidate');
  assert.equal(store.listConfirmed().length, 0, 'propose never confirms');
  assert.equal(store.listCandidates().length, 1);

  // A second discovery merges evidence into the same candidate; still not effective.
  const again = invoke(store, 'propose', DISCOVERED, {text: '林晚'});
  assert.equal(again.ok, true);
  assert.equal(again.candidates.length, 1);
  assert.equal(again.candidates[0].id, proposed.candidates[0].id);
  assert.equal(store.listConfirmed().length, 0);
  assert.equal(store.listCandidates().length, 1);

  // Discovery can read, so query stays available.
  const queried = invoke(store, 'query', DISCOVERED, {text: '林晚'});
  assert.equal(queried.ok, true);
  assert.equal(queried.entry.id, proposed.candidates[0].id);

  console.log('[2] proposed=', JSON.stringify(proposed.candidates),
    'confirmed=', store.listConfirmed().length, 'candidates=', store.listCandidates().length);
});

test('3. query 精确/召回且只返回安全视图（不含 wrongForms/embedding/path）', () => {
  const hostile = {
    id: 'lex-7',
    text: '向晚',
    canonical: '向晚',
    category: 'person',
    usage: '角色名',
    reading: 'xiang wan',
    library: 'public',
    status: 'confirmed',
    version: 4,
    wrongForms: ['小满'],
    context: {before: '不是', after: '，是向晚'},
    sourceIds: ['u1', 'u2'],
    speakerId: 'spk-a',
    embedding: 'SECRET-EMBEDDING-VECTOR',
    audioPath: 'C:\\secret\\voice.wav',
    internalPath: 'D:\\private\\lexicon.json',
  };
  const store = hostileStore(hostile);

  const byText = runLexiconTool({store, action: 'query', authorization: DISCOVERED, text: '向晚'});
  assert.equal(byText.ok, true);
  assert.equal(byText.action, 'query');
  assert.equal(byText.entry.id, 'lex-7');
  assertSafe(byText.entry);
  assert.equal(byText.entry.version, 4);
  assert.equal(byText.candidates.length, 1);
  assertSafe(byText.candidates[0]);

  const serialized = JSON.stringify(byText);
  for (const secret of [
    'SECRET-EMBEDDING',
    'wrongForms',
    'embedding',
    'audioPath',
    'internalPath',
    'secret',
    'sourceIds',
    'speakerId',
    'context',
  ]) {
    assert.equal(serialized.includes(secret), false, `query leaked ${secret}`);
  }

  const byId = runLexiconTool({store, action: 'query', authorization: DISCOVERED, id: 'lex-7'});
  assert.equal(byId.ok, true);
  assert.equal(byId.entry.id, 'lex-7');
  assertSafe(byId.entry);

  // No exact key ("向晚今天来了"), so the local recall engine finds 向晚 by occurrence.
  const recalled = runLexiconTool({
    store,
    action: 'query',
    authorization: DISCOVERED,
    text: '向晚今天来了',
  });
  assert.equal(recalled.ok, true);
  assert.equal(recalled.candidates.length, 1);
  assert.equal(recalled.candidates[0].id, 'lex-7');
  assertSafe(recalled.candidates[0]);
  assert.equal(recalled.ambiguous, false);

  const missing = runLexiconTool({store, action: 'query', authorization: DISCOVERED, id: 'lex-99'});
  assert.deepEqual(missing, {ok: false, action: 'query', reason: 'not-found'});

  const empty = runLexiconTool({store, action: 'query', authorization: DISCOVERED});
  assert.deepEqual(empty, {ok: false, action: 'query', reason: 'text-required'});

  console.log('[3] text=', JSON.stringify(byText.entry), 'recalled=', JSON.stringify(recalled.candidates));
});

test('4. 已确认词条含义冲突 → needs-revision，不静默覆盖', (t) => {
  const store = makeStore(t);
  const added = invoke(store, 'add', USER, {text: '向晚', category: 'person'});
  assert.equal(added.ok, true);

  // A true repeat add keeps the store untouched and says exists.
  const repeated = invoke(store, 'add', USER, {text: '向晚', category: 'person'});
  assert.equal(repeated.ok, false);
  assert.equal(repeated.reason, 'exists');
  assert.equal(repeated.entry.id, added.entry.id);

  for (const conflicting of [
    {text: '向晚', category: 'work'},
    {text: '向晚', category: 'person', usage: '另一种含义'},
    {text: '向晚', category: 'person', reading: 'xiang wan wan'},
    {text: '向晚', category: 'person', library: 'voiceprint'},
  ]) {
    const result = invoke(store, 'add', USER, conflicting);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'needs-revision');
    assertSafe(result.revision);
    assert.equal(result.revision.id, added.entry.id);
    assert.equal(result.revision.status, 'confirmed');
  }

  const persisted = store.listConfirmed();
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].category, 'person');
  assert.equal(persisted[0].usage, '');
  assert.equal(persisted[0].reading, '');
  assert.equal(persisted[0].library, 'public');

  // Discovery hits the same rule but can never overwrite the confirmed row.
  const discoveredConflict = invoke(store, 'propose', DISCOVERED, {
    text: '向晚',
    category: 'work',
  });
  assert.equal(discoveredConflict.ok, false);
  assert.equal(discoveredConflict.reason, 'needs-revision');
  assert.equal(discoveredConflict.revision.id, added.entry.id);
  assert.equal(store.listCandidates().length, 0);

  // A null library means the store default (public), not a conflict.
  const nullLibrary = invoke(store, 'propose', DISCOVERED, {text: '向晚', library: null});
  assert.equal(nullLibrary.ok, false);
  assert.equal(nullLibrary.reason, 'exists');

  const same = invoke(store, 'propose', DISCOVERED, {text: '向晚', category: 'person'});
  assert.equal(same.ok, false);
  assert.equal(same.reason, 'exists');
  assert.equal(same.entry.id, added.entry.id);
  assert.equal(store.listCandidates().length, 0);

  console.log('[4] repeated=', JSON.stringify(repeated.reason),
    'conflict=', JSON.stringify(discoveredConflict), 'persisted=', JSON.stringify(persisted[0]));
});

test('5. 坏输入：动作/授权/store、字段校验与不存在目标', (t) => {
  const store = makeStore(t);
  const added = invoke(store, 'add', USER, {text: '向晚', category: 'person'});
  assert.equal(added.ok, true);
  const id = added.entry.id;

  assert.deepEqual(runLexiconTool({store, action: 'delete', authorization: USER}),
    {ok: false, action: 'delete', reason: 'invalid-action'});
  assert.deepEqual(
    runLexiconTool({store, action: 'add', authorization: 'root', text: '甲', category: 'person'}),
    {ok: false, action: 'add', reason: 'invalid-authorization'},
  );
  assert.deepEqual(runLexiconTool({action: 'query', text: '向晚'}),
    {ok: false, action: 'query', reason: 'invalid-store'});
  assert.deepEqual(runLexiconTool({store: {}, action: 'query', text: '向晚'}),
    {ok: false, action: 'query', reason: 'invalid-store'});
  assert.throws(() => createLexiconTool({store: {}}), TypeError);

  // Missing authorization is the least-privileged mode, so add is refused.
  const noAuthorization = runLexiconTool({store, action: 'add', text: '林晚', category: 'person'});
  assert.deepEqual(noAuthorization, {ok: false, action: 'add', reason: 'forbidden'});

  const badAdds = [
    [{}, 'text-required'],
    [{text: 'x'.repeat(41), category: 'person'}, 'text-too-long'],
    [{text: '甲', category: 'nope'}, 'invalid-category'],
    [{text: '甲', category: 'person', library: 'nope'}, 'invalid-library'],
    [{text: '甲', category: 'person', usage: 123}, 'invalid-usage'],
    [{text: '甲', category: 'person', usage: 'x'.repeat(201)}, 'invalid-usage'],
    [{text: '甲', category: 'person', reading: 123}, 'invalid-reading'],
    [{text: '甲', category: 'person', reading: 'x'.repeat(81)}, 'invalid-reading'],
  ];
  for (const [params, reason] of badAdds) {
    const result = invoke(store, 'add', USER, params);
    assert.equal(result.ok, false, JSON.stringify(params));
    assert.equal(result.reason, reason, JSON.stringify(params));
  }

  const badUpdates = [
    [{}, 'id-required'],
    [{id: 'lex-99', category: 'person'}, 'not-found'],
    [{id}, 'no-editable-field'],
    [{text: '不存在', category: 'person'}, 'not-found'],
    [{id, category: 'nope'}, 'invalid-category'],
    [{id, library: 'public'}, 'unsupported-field'],
  ];
  for (const [params, reason] of badUpdates) {
    const result = invoke(store, 'update', USER, params);
    assert.equal(result.ok, false, JSON.stringify(params));
    assert.equal(result.reason, reason, JSON.stringify(params));
  }

  assert.deepEqual(invoke(store, 'remove', USER, {text: '不存在'}),
    {ok: false, action: 'remove', reason: 'not-found'});
  assert.deepEqual(invoke(store, 'remove', USER, {}),
    {ok: false, action: 'remove', reason: 'not-found'});

  const badProposals = [
    [{}, 'text-required'],
    [{text: 'x'.repeat(41)}, 'text-too-long'],
    [{text: '甲', category: 'nope'}, 'invalid-category'],
    [{text: '甲', library: 'nope'}, 'invalid-library'],
    [{text: '甲', usage: 123}, 'invalid-usage'],
    [{text: '甲', usage: 'x'.repeat(201)}, 'invalid-usage'],
    [{text: '甲', reading: 123}, 'invalid-reading'],
    [{text: '甲', reading: 'x'.repeat(81)}, 'invalid-reading'],
  ];
  for (const [params, reason] of badProposals) {
    const result = invoke(store, 'propose', DISCOVERED, params);
    assert.equal(result.ok, false, JSON.stringify(params));
    assert.equal(result.reason, reason, JSON.stringify(params));
  }

  const unsupported = invoke(noCandidateSeamStore(), 'propose', DISCOVERED, {text: '甲'});
  assert.deepEqual(unsupported, {ok: false, action: 'propose', reason: 'unsupported-store'});

  console.log('[5] bad-input checks=', badAdds.length + badUpdates.length + badProposals.length + 6);
});

test('6. 重复与重命名冲突；重复 add 返回 exists', (t) => {
  const store = makeStore(t);
  const first = invoke(store, 'add', USER, {text: '向晚', category: 'person'});
  const second = invoke(store, 'add', USER, {text: '林晚', category: 'person'});
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);

  const duplicate = invoke(store, 'add', USER, {
    text: '向晚',
    category: 'person',
    usage: '',
    reading: '',
    library: 'public',
  });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.reason, 'exists');
  assert.equal(duplicate.entry.id, first.entry.id);

  // Renaming one confirmed word onto another is refused by the store and passed through.
  const rename = invoke(store, 'update', USER, {id: second.entry.id, canonical: '向晚'});
  assert.equal(rename.ok, false);
  assert.equal(rename.reason, 'exists');
  assert.equal(store.listConfirmed().find((entry) => entry.id === second.entry.id).canonical, '林晚');

  const removed = invoke(store, 'remove', USER, {text: '林晚'});
  assert.equal(removed.ok, true);
  assert.equal(removed.entry.id, second.entry.id);
  assert.equal(removed.entry.category, 'person');
  assert.deepEqual(store.listConfirmed().map((entry) => entry.text), ['向晚']);

  console.log('[6] duplicate=', JSON.stringify(duplicate.reason), 'rename=', JSON.stringify(rename.reason),
    'remaining=', JSON.stringify(store.listConfirmed().map((entry) => entry.text)));
});

test('7. 两种调用形式、factory 动作与嵌套 params', (t) => {
  const store = makeStore(t);

  const added = runLexiconTool(store, {
    action: 'add',
    authorization: USER,
    text: '向晚',
    category: 'person',
  });
  assert.equal(added.ok, true);
  assertSafe(added.entry);

  const viaFactory = createLexiconTool({store}).query({
    authorization: DISCOVERED,
    text: '向晚',
  });
  assert.equal(viaFactory.ok, true);
  assert.equal(viaFactory.entry.id, added.entry.id);

  const nested = runLexiconTool({
    store,
    action: 'query',
    authorization: DISCOVERED,
    params: {text: '向晚'},
  });
  assert.equal(nested.ok, true);
  assert.equal(nested.entry.id, added.entry.id);

  const factoryAdd = createLexiconTool({store}).add({
    authorization: USER,
    text: '林晚',
    category: 'character',
  });
  assert.equal(factoryAdd.ok, true);
  assert.equal(factoryAdd.entry.category, 'character');

  // The module is pure/local: no async, network or model seam is reachable from the result.
  const result = invoke(store, 'query', DISCOVERED, {text: '向晚'});
  assert.equal(result.ok, true);
  assert.equal(typeof result.then, 'undefined');

  console.log('[7] call-shapes=', JSON.stringify([added.entry.id, viaFactory.entry.id, nested.entry.id]),
    'factory-add=', JSON.stringify(factoryAdd.entry));
});

test('8. 删除方法名兼容：store.removeEntry 与 store.remove 都可接受', () => {
  const rows = [{
    id: 'lex-1',
    text: '向晚',
    canonical: '向晚',
    category: 'person',
    usage: '',
    reading: '',
    library: 'public',
    status: 'confirmed',
    wrongForms: ['小满'],
    embedding: 'SECRET',
  }];
  const store = {
    listConfirmed: () => rows,
    listCandidates: () => [],
    addEntry: () => ({ok: false, reason: 'not-used'}),
    updateEntry: () => ({ok: false, reason: 'not-used'}),
    removeEntry: ({id}) => {
      const index = rows.findIndex((entry) => entry.id === id);
      if (index < 0) return {ok: false, reason: 'not-found'};
      const [removed] = rows.splice(index, 1);
      return {ok: true, entry: removed};
    },
  };

  const tool = createLexiconTool({store});
  const result = tool.run({action: 'remove', authorization: USER, id: 'lex-1'});
  assert.equal(result.ok, true);
  assert.equal(result.action, 'remove');
  assertSafe(result.entry);
  assert.deepEqual(rows, []);
  assert.equal(JSON.stringify(result).includes('SECRET'), false);

  console.log('[8] removeEntry-alias=', JSON.stringify(result.entry));
});

test('9. propose 撞到 rejected 墓碑 → rejected，不悄悄复活', (t) => {
  const store = makeStore(t);
  const first = invoke(store, 'propose', DISCOVERED, {text: '林晚'});
  assert.equal(first.ok, true);
  assert.equal(store.reject({text: '林晚'}).ok, true);

  const again = invoke(store, 'propose', DISCOVERED, {text: '林晚'});
  assert.equal(again.ok, false);
  assert.equal(again.action, 'propose');
  assert.equal(again.reason, 'rejected');
  assert.deepEqual(store.listCandidates(), []);
  assert.deepEqual(store.listConfirmed(), []);

  console.log('[9] rejected-tombstone=', JSON.stringify(again));
});
