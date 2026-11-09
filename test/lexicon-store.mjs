/**
 * Shared lexicon stage B3 — candidate persistence + the pending area (pure module).
 *
 * The list mirrors the acceptance items:
 *   1. missing file → default state (reading creates nothing); the first merge writes and returns
 *      {added, merged, skipped};
 *   2. a failed write (read-only target, disconnected directory) never publishes a half file and
 *      never leaves a temp file behind;
 *   3. bad JSON / version / top-level structure → default state + one `lexicon.store.corrupt`
 *      (identical consecutive content is reported once);
 *   4. confirm succeeds without speakerId (the user's confirmation is the only gate), sets
 *      assigned/confirmedAt and is the only thing that makes a word visible in listConfirmed();
 *      a supplied speakerId is optional provenance;
 *   5. edit sets canonical/wrongForms/context and editedAt, and cannot change id/kind/status;
 *   6. reject leaves a tombstone that re-extraction cannot resurrect; remove really deletes;
 *   7. assigned:false candidates appear only in the pending area — never auto-added to the lexicon;
 *   8. a new store instance over the same root sees the same state (restart) and keeps allocating
 *      fresh ids;
 *   9. an ordinary-transcript candidate is never auto-confirmed;
 *  10. regression: the lexicon-candidates/lexicon-corrections behaviour reused through the store.
 *
 * Run: node --test test/lexicon-store.mjs
 */
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  applyCorrection,
  createLexiconState,
  extractLexiconCandidates,
  mergeCandidates,
  parseExplicitCorrection,
} from '../src/host/speech/lexicon-candidates.js';
import { createLexiconStore } from '../src/host/speech/lexicon-store.js';

const T0 = '2026-11-08T09:00:00+08:00';
const T1 = '2026-11-08T09:05:00+08:00';
const T2 = '2026-11-08T09:10:00+08:00';
const T3 = '2026-11-08T09:15:00+08:00';

const iso = (value) => new Date(value).toISOString();

/** One user utterance in the shape the host will pass to candidate extraction. */
function utterance(id, text, at = T0) {
  return { id, text, at, speakerId: null, source: 'mic' };
}

/** Root with `data/` removed after the test; a read-only lexicon file is made deletable first. */
function tempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'seirein-lexicon-store-'));
  t.after(() => {
    try {
      chmodSync(join(root, 'data', 'lexicon.json'), 0o666);
    } catch {
      /* no file was written */
    }
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function collectingLog() {
  const events = [];
  return {
    events,
    emit(event, payload) {
      events.push({ event, ...payload });
      return Promise.resolve();
    },
    of(event) {
      return events.filter((item) => item.event === event);
    },
  };
}

/** A settable injected clock, so every stored timestamp is checkable. */
function makeClock(start) {
  let current = start;
  const clock = () => new Date(current);
  clock.set = (value) => {
    current = value;
  };
  return clock;
}

/** Ordinary transcript: two mentions of 向晚 → one proper-noun candidate, assigned:false. */
function properNounCandidates() {
  return extractLexiconCandidates({
    utterances: [utterance('u1', '向晚今天来了。'), utterance('u2', '我见过向晚。')],
    now: T0,
  });
}

/** Explicit correction with a confirmed speaker → kind correction, wrongForms:['小满']. */
function correctionCandidates() {
  const parsed = parseExplicitCorrection('不是小满，是向晚');
  return extractLexiconCandidates({
    corrections: [{ ...parsed, at: T0, speakerId: 'spk-1' }],
    now: T0,
  });
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function tempFiles(dir) {
  return readdirSync(dir).filter((name) => name.endsWith('.tmp'));
}

test('1. 空文件 → 默认结构；首次 merge 写入并返回计数', (t) => {
  const root = tempRoot(t);
  const log = collectingLog();
  const store = createLexiconStore({ root, log });
  const file = join(root, 'data', 'lexicon.json');
  assert.equal(store.file, file);
  assert.equal(existsSync(file), false);

  const empty = store.read();
  assert.deepEqual(empty, createLexiconState(), 'a missing file reads as the default state');
  assert.equal(existsSync(file), false, 'reading never creates the file');
  assert.deepEqual(store.list(), []);
  assert.deepEqual(store.listUnassigned(), []);
  assert.deepEqual(store.listConfirmed(), []);

  const candidates = properNounCandidates();
  assert.equal(candidates.length, 1);
  const first = store.mergeCandidates(candidates);
  assert.deepEqual(first, { added: 1, merged: 0, skipped: 0 });
  assert.equal(existsSync(file), true);

  const saved = readJson(file);
  assert.equal(saved.version, 1);
  assert.equal(saved.entries.length, 1);
  const entry = saved.entries[0];
  assert.equal(entry.id, 'lex-1');
  assert.equal(entry.text, '向晚');
  assert.equal(entry.kind, 'proper-noun');
  assert.equal(entry.status, 'candidate');
  assert.equal(entry.assigned, false);
  assert.equal(entry.speakerId, null);
  assert.equal(entry.canonical, '');
  assert.deepEqual(entry.wrongForms, []);
  assert.deepEqual(entry.sourceIds, ['u1', 'u2']);
  assert.equal(entry.context, null);
  assert.equal(entry.confirmedAt, '');
  assert.equal(entry.rejectedAt, '');
  assert.equal(entry.editedAt, '');
  assert.deepEqual(
    log.of('lexicon.store.changed').map((item) => ({ op: item.op, id: item.id })),
    [{ op: 'merge', id: 'lex-1' }],
    'one changed event per write, op merge, with the new id',
  );

  const second = store.mergeCandidates(candidates);
  assert.deepEqual(second, { added: 0, merged: 1, skipped: 0 });
  assert.equal(readJson(file).entries.length, 1);
  assert.equal(log.of('lexicon.store.changed').length, 2, 'a merge that only adds evidence still writes once');

  console.log('[1] empty=', JSON.stringify(empty), 'first=', JSON.stringify(first), 'second=', JSON.stringify(second), 'entry=', JSON.stringify(entry));
});

test('2. 原子写：写失败/中断不产生半文件', (t) => {
  const root = tempRoot(t);
  const store = createLexiconStore({ root });
  const dataDir = join(root, 'data');
  const file = join(dataDir, 'lexicon.json');
  store.mergeCandidates(properNounCandidates());
  const oldText = readFileSync(file, 'utf8');

  // (a) the target cannot be replaced (Windows read-only attribute → rename EPERM): the old file
  // must stay byte-identical and the temp file must be removed, never published.
  chmodSync(file, 0o444);
  const nextState = store.read();
  nextState.entries[0].canonical = '改过';
  assert.throws(() => store.write(nextState), /EPERM|EACCES|permission/i);
  assert.equal(readFileSync(file, 'utf8'), oldText, 'the published file is untouched');
  assert.deepEqual(tempFiles(dataDir), [], 'the temp file is cleaned up after a failed rename');
  chmodSync(file, 0o666);

  // (b) a malformed state is refused before any file operation.
  assert.throws(() => store.write({ version: 1 }), TypeError);
  assert.throws(() => store.write({ version: 2, entries: [] }), TypeError);
  assert.equal(readFileSync(file, 'utf8'), oldText);
  assert.deepEqual(tempFiles(dataDir), []);

  // (c) the directory cannot be created (root/data is a plain file): nothing is written.
  const brokenRoot = tempRoot(t);
  writeFileSync(join(brokenRoot, 'data'), 'not a directory', 'utf8');
  const brokenStore = createLexiconStore({ root: brokenRoot });
  assert.throws(() => brokenStore.write(store.read()), /EEXIST|ENOTDIR|ENOENT/i);
  assert.equal(existsSync(join(brokenRoot, 'data', 'lexicon.json')), false);

  // (d) once writable again the same call succeeds, so no state was corrupted by the failures.
  const recovered = store.write(store.read());
  assert.equal(recovered.entries[0].canonical, '');
  assert.equal(readJson(file).version, 1);

  console.log('[2] old-bytes=', oldText.length, 'tmp-after-failure=', JSON.stringify(tempFiles(dataDir)), 'recovered-canonical=', JSON.stringify(recovered.entries[0].canonical));
});

test('3. 坏 JSON/版本/结构 → 回退默认并记 corrupt 仅一次', (t) => {
  const root = tempRoot(t);
  const log = collectingLog();
  const store = createLexiconStore({ root, log });
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, 'lexicon.json');

  const badJson = '{ 不是 json';
  writeFileSync(file, badJson, 'utf8');
  assert.deepEqual(store.read(), createLexiconState());
  assert.equal(log.of('lexicon.store.corrupt').length, 1);
  assert.equal(typeof log.of('lexicon.store.corrupt')[0].error, 'string');
  assert.ok(log.of('lexicon.store.corrupt')[0].error.length > 0);
  assert.equal(log.of('lexicon.store.corrupt')[0].file, file);

  // the same corrupt content read again is not reported a second time
  assert.deepEqual(store.read(), createLexiconState());
  assert.equal(log.of('lexicon.store.corrupt').length, 1, 'identical corrupt content is reported once');

  // a different broken version / structure is a new corruption event
  writeFileSync(file, '{"version":2,"entries":[]}', 'utf8');
  assert.deepEqual(store.read(), createLexiconState());
  assert.equal(log.of('lexicon.store.corrupt').length, 2);

  writeFileSync(file, '{"version":1,"entries":{}}', 'utf8');
  assert.deepEqual(store.read(), createLexiconState());
  assert.equal(log.of('lexicon.store.corrupt').length, 3);

  writeFileSync(file, '{"version":1,"entries":[{"text":"   "}]}', 'utf8');
  assert.deepEqual(store.read(), createLexiconState());
  assert.equal(log.of('lexicon.store.corrupt').length, 4, 'an entry without a usable text is corrupt structure');

  // a good file reads back as-is and clears the guard
  store.write({ version: 1, nextId: 1, entries: [] });
  assert.deepEqual(store.read(), createLexiconState());
  assert.equal(log.of('lexicon.store.corrupt').length, 4);

  console.log('[3] corrupt-events=', JSON.stringify(log.of('lexicon.store.corrupt').map((item) => item.error)));
});

test('4. confirm 无需 speakerId；assigned/confirmedAt 正确，listConfirmed 可见，speakerId 可选', (t) => {
  const root = tempRoot(t);
  const clock = makeClock(T1);
  const log = collectingLog();
  const store = createLexiconStore({ root, clock, log });
  const file = join(root, 'data', 'lexicon.json');
  store.mergeCandidates(properNounCandidates());

  // No speakerId at all: confirmation still succeeds; the entry is shared and speakerId is null.
  clock.set(T2);
  const confirmed = store.confirm({ text: '向晚', canonical: '向晚' });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.entry.id, 'lex-1');
  assert.equal(confirmed.entry.status, 'confirmed');
  assert.equal(confirmed.entry.assigned, true);
  assert.equal(confirmed.entry.speakerId, null);
  assert.equal(confirmed.entry.canonical, '向晚');
  assert.equal(confirmed.entry.confirmedAt, iso(T2));

  let persisted = readJson(file).entries[0];
  assert.equal(persisted.status, 'confirmed');
  assert.equal(persisted.assigned, true);
  assert.equal(persisted.speakerId, null);
  assert.equal(persisted.confirmedAt, iso(T2));

  assert.deepEqual(store.listConfirmed().map((entry) => entry.text), ['向晚']);
  assert.deepEqual(store.listUnassigned(), [], 'a confirmed word left the pending area');

  // A speakerId is optional provenance: when supplied later it is recorded on the same entry.
  clock.set(T3);
  const attributed = store.confirm({ text: '向晚', speakerId: 'spk-1', canonical: '向晚' });
  assert.equal(attributed.ok, true);
  assert.equal(attributed.entry.id, 'lex-1');
  assert.equal(attributed.entry.status, 'confirmed');
  assert.equal(attributed.entry.assigned, true);
  assert.equal(attributed.entry.speakerId, 'spk-1');
  assert.equal(attributed.entry.confirmedAt, iso(T3));
  persisted = readJson(file).entries[0];
  assert.equal(persisted.speakerId, 'spk-1');
  assert.equal(log.of('lexicon.store.changed').filter((item) => item.op === 'confirm').length, 2);

  assert.deepEqual(store.confirm({ text: '不存在', speakerId: 'spk-1' }), { ok: false, reason: 'not-found' });

  console.log('[4] no-speaker-confirm=', JSON.stringify(confirmed.entry), 'attributed=', JSON.stringify(attributed.entry), 'listConfirmed=', JSON.stringify(store.listConfirmed()));
});

test('5. edit canonical/wrongForms/context 生效且 editedAt 更新；不可改 id/kind/status', (t) => {
  const root = tempRoot(t);
  const clock = makeClock(T1);
  const store = createLexiconStore({ root, clock });
  const file = join(root, 'data', 'lexicon.json');
  store.mergeCandidates(correctionCandidates());
  clock.set(T2);
  const confirmed = store.confirm({ text: '向晚', speakerId: 'spk-1' });
  assert.equal(confirmed.ok, true);
  const id = confirmed.entry.id;
  assert.equal(confirmed.entry.kind, 'correction');
  assert.deepEqual(confirmed.entry.wrongForms, ['小满']);

  clock.set(T3);
  const edited = store.edit({
    id,
    canonical: '  向晚  ',
    wrongForms: ['小满', '小蛮', ' 小满 '],
    context: { before: '不是', after: '，是向晚' },
    // identity fields are not part of the edit contract: they must be ignored, not applied
    kind: 'proper-noun',
    status: 'rejected',
    editedAt: '1999-01-01T00:00:00.000Z',
  });
  assert.equal(edited.ok, true);
  assert.equal(edited.entry.id, id);
  assert.equal(edited.entry.kind, 'correction', 'kind cannot be changed by edit');
  assert.equal(edited.entry.status, 'confirmed', 'status cannot be changed by edit');
  assert.equal(edited.entry.canonical, '向晚');
  assert.deepEqual(edited.entry.wrongForms, ['小满', '小蛮'], 'wrong forms are de-duplicated by lexicon key');
  assert.deepEqual(edited.entry.context, { before: '不是', after: '，是向晚' });
  assert.equal(edited.entry.editedAt, iso(T3), 'editedAt comes from the clock, not from the caller');

  const persisted = readJson(file).entries.find((entry) => entry.id === id);
  assert.equal(persisted.canonical, '向晚');
  assert.equal(persisted.editedAt, iso(T3));
  assert.equal(persisted.kind, 'correction');
  assert.equal(persisted.status, 'confirmed');

  // refused edits write nothing
  const before = readFileSync(file, 'utf8');
  assert.deepEqual(store.edit({ id, canonical: '   ' }), { ok: false, reason: 'canonical-empty' });
  assert.deepEqual(store.edit({ id }), { ok: false, reason: 'no-editable-field' });
  assert.deepEqual(store.edit({ canonical: 'x' }), { ok: false, reason: 'id-required' });
  assert.deepEqual(store.edit({ id: 'lex-99', canonical: 'x' }), { ok: false, reason: 'not-found' });
  assert.deepEqual(store.edit({ id, wrongForms: '小满' }), { ok: false, reason: 'invalid-wrong-forms' });
  assert.deepEqual(store.edit({ id, context: '不是' }), { ok: false, reason: 'invalid-context' });
  assert.equal(readFileSync(file, 'utf8'), before);

  // an explicit null context clears it
  const cleared = store.edit({ id, context: null });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.entry.context, null);

  console.log('[5] edited=', JSON.stringify(edited.entry), 'persisted-editedAt=', persisted.editedAt, 'cleared-context=', JSON.stringify(cleared.entry.context));
});

test('6. reject 后不再出现在候选；remove 真删除', (t) => {
  const root = tempRoot(t);
  const store = createLexiconStore({ root, clock: makeClock(T1) });
  const file = join(root, 'data', 'lexicon.json');
  const candidates = extractLexiconCandidates({
    utterances: [
      utterance('u1', '向晚今天来了，Seirein 也在。'),
      utterance('u2', '我见过向晚，Seirein 很好用。'),
    ],
    now: T0,
  });
  assert.deepEqual(store.mergeCandidates(candidates), { added: 2, merged: 0, skipped: 0 });

  const rejected = store.reject({ text: '向晚' });
  assert.equal(rejected.ok, true);
  assert.equal(rejected.entry.status, 'rejected');
  assert.equal(rejected.entry.rejectedAt, iso(T1));
  assert.equal(store.listUnassigned().some((entry) => entry.text === '向晚'), false);
  assert.equal(store.listConfirmed().some((entry) => entry.text === '向晚'), false);
  const all = store.list();
  assert.equal(all.length, 2, 'the tombstone stays on disk');
  assert.equal(all.find((entry) => entry.text === '向晚').status, 'rejected');

  // re-extraction cannot silently resurrect a rejected form
  assert.deepEqual(store.mergeCandidates(candidates), { added: 0, merged: 1, skipped: 1 });

  const removed = store.remove({ text: 'Seirein' });
  assert.equal(removed.ok, true);
  assert.deepEqual(store.list().map((entry) => entry.text), ['向晚']);
  assert.deepEqual(readJson(file).entries.map((entry) => entry.text), ['向晚']);
  assert.deepEqual(store.remove({ text: 'Seirein' }), { ok: false, reason: 'not-found' });

  console.log('[6] rejected=', JSON.stringify(rejected.entry), 'after-remove=', JSON.stringify(store.list().map((entry) => [entry.id, entry.text, entry.status])));
});

test('7. 未归属区：assigned:false 的条目只在 listUnassigned', (t) => {
  const root = tempRoot(t);
  const store = createLexiconStore({ root });

  // 向晚 comes from an ordinary transcript → assigned:false; 林晚 comes from an explicit
  // correction naming a confirmed speaker → assigned:true but still an unconfirmed candidate.
  const proper = properNounCandidates();
  const correction = (() => {
    const parsed = parseExplicitCorrection('不是小满，是林晚');
    return extractLexiconCandidates({ corrections: [{ ...parsed, at: T0, speakerId: 'spk-1' }], now: T0 });
  })();
  assert.equal(correction[0].assigned, true);
  assert.equal(correction[0].text, '林晚');
  assert.deepEqual(store.mergeCandidates([...proper, ...correction]), { added: 2, merged: 0, skipped: 0 });

  const unassigned = store.listUnassigned();
  assert.deepEqual(unassigned.map((entry) => entry.text), ['向晚']);
  assert.equal(unassigned[0].assigned, false);
  assert.equal(unassigned[0].speakerId, null);
  assert.deepEqual(store.listConfirmed(), []);

  // The correction candidate is assigned but not confirmed: it is neither an unassigned word nor
  // an effective one; only the full list() view exposes it (the UI would still need a confirm).
  const correctionView = store.list().find((entry) => entry.text === '林晚');
  assert.equal(correctionView.assigned, true);
  assert.equal(correctionView.speakerId, 'spk-1');
  assert.equal(correctionView.status, 'candidate');
  assert.equal(store.listUnassigned().some((entry) => entry.text === '林晚'), false);

  console.log('[7] unassigned=', JSON.stringify(unassigned.map((entry) => [entry.text, entry.assigned, entry.speakerId])), 'assigned-candidate=', JSON.stringify([correctionView.text, correctionView.status]));
});

test('8. 重启（新 store 实例读同文件）状态保持', (t) => {
  const root = tempRoot(t);
  const clock = makeClock(T1);
  const first = createLexiconStore({ root, clock });
  first.mergeCandidates(properNounCandidates());
  clock.set(T2);
  const confirmed = first.confirm({ text: '向晚', speakerId: 'spk-1', canonical: '向晚' });
  assert.equal(confirmed.ok, true);
  const edit = first.edit({
    id: confirmed.entry.id,
    wrongForms: ['小满'],
    context: { before: '叫', after: '' },
  });
  assert.equal(edit.ok, true);
  assert.equal(edit.entry.editedAt, iso(T2));

  // A fresh instance over the same root must see exactly the persisted state.
  const second = createLexiconStore({ root, clock: makeClock(T3) });
  const confirmedViews = second.listConfirmed();
  assert.equal(confirmedViews.length, 1);
  assert.equal(confirmedViews[0].id, confirmed.entry.id);
  assert.equal(confirmedViews[0].canonical, '向晚');
  assert.equal(confirmedViews[0].speakerId, 'spk-1');
  assert.equal(confirmedViews[0].status, 'confirmed');
  assert.deepEqual(confirmedViews[0].wrongForms, ['小满']);
  assert.deepEqual(confirmedViews[0].context, { before: '叫', after: '' });
  assert.equal(confirmedViews[0].editedAt, iso(T2));

  // ids continue instead of being reused after the restart
  const more = second.mergeCandidates(extractLexiconCandidates({
    utterances: [utterance('u3', 'Seirein 啊。'), utterance('u4', 'Seirein 好。')],
    now: T0,
  }));
  assert.deepEqual(more, { added: 1, merged: 0, skipped: 0 });
  assert.equal(second.list().some((entry) => entry.text === 'Seirein' && entry.id === 'lex-2'), true);

  console.log('[8] restart-confirmed=', JSON.stringify(confirmedViews[0]), 'ids=', JSON.stringify(second.list().map((entry) => entry.id)));
});

test('9. 普通转写候选未经 confirm 不会进入 listConfirmed', (t) => {
  const root = tempRoot(t);
  const store = createLexiconStore({ root });
  const file = join(root, 'data', 'lexicon.json');

  assert.deepEqual(store.mergeCandidates(properNounCandidates()), { added: 1, merged: 0, skipped: 0 });
  assert.deepEqual(store.listConfirmed(), []);
  assert.equal(store.listUnassigned().length, 1);
  const persisted = readJson(file).entries[0];
  assert.equal(persisted.status, 'candidate');
  assert.equal(persisted.confirmedAt, '');
  assert.equal(persisted.assigned, false);

  // merging the same transcript again adds evidence but still confirms nothing
  store.mergeCandidates(properNounCandidates());
  assert.deepEqual(store.listConfirmed(), []);

  // only the explicit confirm action makes it effective
  const confirmed = store.confirm({ text: '向晚', speakerId: 'spk-1' });
  assert.equal(confirmed.ok, true);
  assert.equal(store.listConfirmed().length, 1);

  console.log('[9] before-confirm=', JSON.stringify({ confirmed: [], unassigned: 1 }), 'after-confirm=', JSON.stringify(store.listConfirmed().map((entry) => entry.text)));
});

test('10. 回归：lexicon-candidates / lexicon-corrections 语义经 store 未变', (t) => {
  // the model still extracts one candidate and merges into an empty state
  const state = createLexiconState();
  const merged = mergeCandidates(state, properNounCandidates());
  assert.deepEqual(merged, { ok: true, added: 1, merged: 0, skipped: 0 });

  // "不是小满，是向晚" is still a correction candidate with wrongForms + replacement context
  const parsed = parseExplicitCorrection('不是小满，是向晚');
  assert.equal(parsed.kind, 'correction');
  assert.deepEqual(parsed.context, { before: '不是', after: '，是向晚' });

  const root = tempRoot(t);
  const store = createLexiconStore({ root });
  store.mergeCandidates(correctionCandidates());
  const confirmed = store.confirm({ text: '向晚', speakerId: 'spk-1' });
  assert.equal(confirmed.ok, true);
  assert.deepEqual(confirmed.entry.wrongForms, ['小满']);
  assert.deepEqual(confirmed.entry.context, { before: '不是', after: '，是向晚' });

  // the confirmed entry still applies as a correction rule through applyCorrection
  const applied = applyCorrection('不是小满，是向晚', confirmed.entry);
  assert.equal(applied.ok, true);
  assert.equal(applied.replaced, 1);
  assert.equal(applied.text, '不是向晚，是向晚');

  console.log('[10] merged=', JSON.stringify(merged), 'applied=', JSON.stringify(applied), 'confirmed=', JSON.stringify([confirmed.entry.text, confirmed.entry.wrongForms]));
});
