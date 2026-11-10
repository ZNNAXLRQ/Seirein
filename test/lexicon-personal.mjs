/**
 * Optional personal lexicon (声纹库) — active-view filtering, ownership and host wiring.
 *
 * The fixed rules (2026-11-10):
 *   - `public` is shared: every speaker (and no speaker) may use it; `speakerId` is optional there;
 *   - `voiceprint` is personal: it belongs to exactly one confirmed self (`speakerId === selfId`),
 *     can only be created/moved into while that self is confirmed, and moving back to public
 *     clears the owner;
 *   - `listActive({speakerId})` is public + that speaker's own voiceprint rows only. Another
 *     speaker's voiceprint rows are never listed, never merged and never deleted;
 *   - the host's ASR correction and pre-step explanation injection read `listActive(selfId)`;
 *     `/word` still writes only the public library;
 *   - old files without `library` read as public, and one confirmed self can never absorb or move
 *     another self's private row.
 *
 * Run: node --test test/lexicon-personal.mjs
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { applyVoiceLexiconCorrection, recallLexiconContext } from '../src/host/index.js';
import {
  createHearingSettingsActions,
  createWordCommandDefinition,
} from '../src/host/hearing/settings-actions.js';
import {
  applyLexiconText,
  createLexiconStore,
} from '../src/host/speech/lexicon-store.js';

const SELF = 'self-1';
const OTHER = 'self-2';
const T0 = '2026-11-10T09:00:00+08:00';

function tempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'seirein-lexicon-personal-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
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

const lexiconFile = (root) => join(root, 'data', 'lexicon.json');
const readLexicon = (root) => JSON.parse(readFileSync(lexiconFile(root), 'utf8'));
const writeLexicon = (root, entries) => {
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(lexiconFile(root), `${JSON.stringify({
    version: 1,
    nextId: entries.length + 1,
    entries,
  }, null, 2)}\n`, 'utf8');
};

/** One confirmed entry in the persisted shape; old files may omit library/speakerId. */
function storedEntry(overrides = {}) {
  return {
    id: 'lex-1',
    key: '充电',
    text: '充电',
    canonical: '充电',
    wrongForms: [],
    kind: 'proper-noun',
    status: 'confirmed',
    category: 'expression',
    usage: '',
    reading: '',
    library: 'public',
    speakerId: null,
    assigned: true,
    context: null,
    ambiguous: false,
    sourceIds: [],
    at: T0,
    confirmedAt: T0,
    rejectedAt: '',
    editedAt: '',
    ...overrides,
  };
}

const confirmed = (store, entryId) => store.listConfirmed().find((entry) => entry.id === entryId);

// ---------------------------------------------------------------------------
// 1. No confirmed self: public only; voiceprint writes are refused
// ---------------------------------------------------------------------------

test('1. 无 selfId：只有公共库生效，声纹添加/移动被拒绝', async (t) => {
  const root = tempRoot(t);
  const store = createLexiconStore({ root });

  const publicAdd = store.addEntry({ text: '公共词', category: 'person' });
  assert.equal(publicAdd.ok, true);
  assert.equal(publicAdd.entry.library, 'public');
  assert.equal(publicAdd.entry.speakerId, null);

  assert.deepEqual(
    store.addEntry({ text: '私人词', category: 'person', library: 'voiceprint' }),
    { ok: false, reason: 'self-required' },
  );
  const publicId = publicAdd.entry.id;
  assert.deepEqual(
    store.moveEntry({ id: publicId, library: 'voiceprint' }),
    { ok: false, reason: 'self-required' },
  );

  assert.deepEqual(store.listActive().map((entry) => entry.text), ['公共词']);
  assert.deepEqual(store.listActive({ speakerId: '' }).map((entry) => entry.text), ['公共词']);
  assert.equal(readLexicon(root).entries.length, 1, 'refused writes left the file untouched');

  // A voiceprint row that predates the confirmation is still not active without a confirmed self.
  writeLexicon(root, [
    storedEntry({ id: 'lex-1', text: '公共词', canonical: '公共词' }),
    storedEntry({
      id: 'lex-2', key: '旧私人', text: '旧私人', canonical: '旧私人',
      library: 'voiceprint', speakerId: SELF,
    }),
  ]);
  const reopened = createLexiconStore({ root });
  assert.deepEqual(reopened.listActive().map((entry) => entry.text), ['公共词']);
  assert.equal(reopened.listConfirmed().length, 2, 'the private row is kept, not deleted');
  assert.equal(reopened.listActive({ speakerId: OTHER }).some((entry) => entry.text === '旧私人'), false,
    'an explicitly different speaker never sees another self\'s row');

  console.log('[1] active=公共词 only; voiceprint add/move=self-required; file kept');
});

// ---------------------------------------------------------------------------
// 2. Confirmed self: public + own voiceprint; another speaker's row is excluded
// ---------------------------------------------------------------------------

test('2. 有 selfId：public+自己的声纹生效；其他 speakerId 的声纹不生效', (t) => {
  const root = tempRoot(t);
  const store = createLexiconStore({ root, selfId: SELF });

  assert.equal(store.addEntry({ text: '公共词', category: 'person' }).ok, true);
  const own = store.addEntry({ text: '本人词', category: 'person', library: 'voiceprint' });
  assert.equal(own.ok, true);
  assert.equal(own.entry.library, 'voiceprint');
  assert.equal(own.entry.speakerId, SELF, 'voiceprint add writes the confirmed self');

  // Another self's row exists in the same file; the current store must neither list nor merge it.
  const state = readLexicon(root);
  state.entries.push(storedEntry({
    id: 'lex-99', key: '别人词', text: '别人词', canonical: '别人词',
    library: 'voiceprint', speakerId: OTHER,
  }));
  writeFileSync(lexiconFile(root), `${JSON.stringify(state, null, 2)}\n`, 'utf8');

  assert.deepEqual(store.listActive().map((entry) => entry.text).sort(), ['公共词', '本人词'].sort());
  assert.deepEqual(
    store.listActive({ speakerId: SELF }).map((entry) => entry.text).sort(),
    ['公共词', '本人词'].sort(),
  );
  assert.deepEqual(
    store.listActive({ speakerId: OTHER }).map((entry) => entry.text),
    ['公共词'],
    'a mismatched explicit speaker sees only public, never another self\'s private row',
  );
  assert.equal(store.listConfirmed().some((entry) => entry.text === '别人词'), true,
    'the administration view still sees the other row and keeps it on disk');
  assert.equal(confirmed(store, 'lex-99').speakerId, OTHER, 'the other row keeps its owner');
  assert.equal(readLexicon(root).entries.length, 3, 'nothing was deleted or merged by listing');

  console.log('[2] selfActive=', JSON.stringify(store.listActive({ speakerId: SELF }).map((entry) => [entry.text, entry.library, entry.speakerId])),
    'otherActive=', JSON.stringify(store.listActive({ speakerId: OTHER }).map((entry) => entry.text)));
});

// ---------------------------------------------------------------------------
// 3. Move in/out, ownership and clearing
// ---------------------------------------------------------------------------

test('3. 移入/移出：归属=本人，移回公共清空 speakerId，别人的声纹不可吞并', (t) => {
  const root = tempRoot(t);
  const store = createLexiconStore({ root, selfId: SELF });
  const added = store.addEntry({ text: '可移动', category: 'term' });
  const id = added.entry.id;

  const moved = store.moveEntry({ id, library: 'voiceprint' });
  assert.equal(moved.ok, true);
  assert.equal(moved.entry.library, 'voiceprint');
  assert.equal(moved.entry.speakerId, SELF);
  assert.deepEqual(store.listActive().map((entry) => entry.text), ['可移动']);

  const back = store.moveEntry({ id, library: 'public' });
  assert.equal(back.ok, true);
  assert.equal(back.entry.library, 'public');
  assert.equal(back.entry.speakerId, null, 'moving back to public clears the owner');
  assert.deepEqual(store.listActive().map((entry) => entry.text), ['可移动']);

  // Another self's voiceprint row cannot be moved into this self's slot, nor released to public.
  writeLexicon(root, [storedEntry({
    id: 'lex-1', key: '别人词', text: '别人词', canonical: '别人词',
    library: 'voiceprint', speakerId: OTHER,
  })]);
  assert.deepEqual(store.moveEntry({ id: 'lex-1', library: 'voiceprint' }), { ok: false, reason: 'not-owned' });
  assert.deepEqual(store.confirm({ id: 'lex-1', speakerId: SELF }),
    { ok: false, reason: 'not-owned' },
    'confirming cannot steal another self\'s private row');
  assert.equal(confirmed(store, 'lex-1').speakerId, OTHER, 'the owner was not overwritten');
  assert.equal(confirmed(store, 'lex-1').library, 'voiceprint');
  // Releasing another row back to public is a cleanup, not an adoption: it only clears the owner.
  const released = store.moveEntry({ id: 'lex-1', library: 'public' });
  assert.equal(released.ok, true);
  assert.equal(released.entry.speakerId, null);
  assert.equal(released.entry.library, 'public');

  // The settings action surfaces the same gate as explicit reasons.
  assert.deepEqual(
    createLexiconStore({ root: tempRoot(t) }).addEntry({
      text: '无主词', category: 'person', library: 'voiceprint',
    }),
    { ok: false, reason: 'self-required' },
  );

  console.log('[3] owner=', SELF, 'publicOwner=', back.entry.speakerId, 'otherMove=', 'not-owned');
});

// ---------------------------------------------------------------------------
// 4. ASR correction and explanation injection read only the active view
// ---------------------------------------------------------------------------

test('4. ASR/释义注入只取 active：公共+本人声纹；其他声纹不替换也不注入', (t) => {
  const root = tempRoot(t);
  const store = createLexiconStore({ root, selfId: SELF });

  // Public entry with a misrecognised form.
  const publicAdd = store.addEntry({ text: '充电', category: 'expression' });
  assert.equal(store.edit({ id: publicAdd.entry.id, wrongForms: ['冲电'] }).ok, true);

  // Personal entry with a misrecognised form plus a reading for the ASR recall lane.
  const personalAdd = store.addEntry({
    text: '向晚', category: 'person', reading: 'xiangwan', library: 'voiceprint',
  });
  assert.equal(store.edit({ id: personalAdd.entry.id, wrongForms: ['像晚'] }).ok, true);

  // Another self's private word would rewrite if the inactive row leaked into the pass.
  const state = readLexicon(root);
  state.entries.push(storedEntry({
    id: 'lex-90', key: '别人词', text: '别人词', canonical: '别人词',
    library: 'voiceprint', speakerId: OTHER, wrongForms: ['别认错'],
  }));
  writeFileSync(lexiconFile(root), `${JSON.stringify(state, null, 2)}\n`, 'utf8');

  // The confirmed self: both public and own voiceprint exact rules apply.
  assert.equal(applyLexiconText('冲电 像晚', { store, speakerId: SELF }), '充电 向晚');
  assert.equal(applyLexiconText('冲电 像晚', { store }), '充电 向晚',
    'a configured self is active even when the caller omits the id');

  // Any other declared speaker: public only, never the current self's voiceprint row.
  assert.equal(applyLexiconText('冲电 像晚', { store, speakerId: OTHER }), '充电 像晚');
  assert.equal(applyLexiconText('冲电 别认错', { store, speakerId: SELF }), '充电 别认错',
    'another self\'s private row is never applied');

  // ASR recall lane uses the same active list.
  assert.equal(
    applyVoiceLexiconCorrection('xiangwan来了', { store, speakerId: SELF }),
    '向晚来了',
  );
  assert.equal(
    applyVoiceLexiconCorrection('xiangwan来了', { store, speakerId: OTHER }),
    'xiangwan来了',
    'a non-self never gets the personal recall hint',
  );

  // Explanation injection: only the active entries are recalled; the other row is invisible.
  const active = store.listActive({ speakerId: SELF });
  assert.equal(active.some((entry) => entry.text === '别人词'), false);
  const recall = recallLexiconContext({ entries: active, text: '向晚今天直播吗' });
  assert.ok(recall.text.includes('向晚'), 'the own voiceprint row participates in explanation context');
  const foreign = recallLexiconContext({
    entries: store.listActive({ speakerId: OTHER }), text: '别人词',
  });
  assert.equal(foreign.text.includes('别人词'), false, 'the other self\'s row never enters another context');

  // Host wiring: ASR and the pre-step read listActive(selfId), not listConfirmed().
  const hostSource = readFileSync(new URL('../src/host/index.js', import.meta.url), 'utf8');
  assert.match(hostSource,
    /lexiconEntries: \(\) => lexiconStore\.listActive\(\{ speakerId: lexiconSelfId\(\) \}\)/u,
    'the pre-step explanation context uses the active view');
  assert.match(hostSource,
    /applyVoiceLexiconCorrection\(refined, \{[\s\S]*?speakerId: lexiconSelfId\(\),/u,
    'the ASR correction passes the confirmed self id');

  console.log('[4] activeExact=充电/向晚 otherExact=充电/像晚 asrSelf=向晚来了 asrOther=xiangwan来了');
});

// ---------------------------------------------------------------------------
// 5. Old data compatibility
// ---------------------------------------------------------------------------

test('5. 旧数据兼容：library 缺省按 public 读取，确认词仍生效', (t) => {
  const root = tempRoot(t);
  writeLexicon(root, [{
    id: 'lex-1',
    key: 'seirein',
    text: 'Seirein',
    canonical: 'Seirein',
    wrongForms: ['seirein'],
    kind: 'proper-noun',
    status: 'confirmed',
    category: 'term',
    usage: '旧文件',
    reading: '',
    speakerId: null,
    assigned: true,
    context: null,
    ambiguous: false,
    sourceIds: [],
    at: T0,
    confirmedAt: T0,
    rejectedAt: '',
    editedAt: '',
  }]);

  const store = createLexiconStore({ root, selfId: SELF });
  const [entry] = store.listConfirmed();
  assert.equal(entry.library, 'public', 'a missing library reads as public');
  assert.equal(entry.speakerId, null);
  assert.deepEqual(store.listActive().map((item) => item.text), ['Seirein']);
  assert.equal(applyLexiconText('seirein来了', { store, speakerId: SELF }), 'Seirein来了');

  console.log('[5] legacyLibrary=', entry.library, 'active=', JSON.stringify(store.listActive().map((item) => item.text)));
});

// ---------------------------------------------------------------------------
// 6. Settings actions and /word
// ---------------------------------------------------------------------------

function hearingActions(store, selfId) {
  const enrollment = {
    getConfirmedSelf() {
      return selfId === '' ? null : { speakerId: selfId, status: 'confirmed' };
    },
  };
  return createHearingSettingsActions({
    lexiconStore: store,
    speakerEnrollmentStore: enrollment,
    log: collectingLog(),
  });
}

test('6. 设置动作：add/update/move 支持 library，voiceprint 需要 selfId；/word 仍只写 public', async (t) => {
  const root = tempRoot(t);
  const store = createLexiconStore({ root, selfId: SELF });
  const action = hearingActions(store, SELF);

  const publicAdd = await action({ action: 'lexicon.add', text: '公共词', category: 'person' });
  assert.equal(publicAdd.ok, true);
  assert.equal(publicAdd.entry.library, 'public');

  const privateAdd = await action({
    action: 'lexicon.add', text: '本人词', category: 'person', library: 'voiceprint',
  });
  assert.equal(privateAdd.ok, true);
  assert.equal(privateAdd.entry.library, 'voiceprint');
  assert.equal(privateAdd.entry.speakerId, SELF);

  assert.deepEqual(
    await action({ action: 'lexicon.add', text: '坏库位', category: 'person', library: 'private' }),
    { ok: false, reason: 'invalid-library' },
  );

  // lexicon.update can change the slot; the store applies the same ownership rule.
  const updated = await action({
    action: 'lexicon.update', id: publicAdd.entry.id, library: 'voiceprint',
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.entry.library, 'voiceprint');
  assert.equal(updated.entry.speakerId, SELF);
  const back = await action({
    action: 'lexicon.update', id: publicAdd.entry.id, library: 'public',
  });
  assert.equal(back.ok, true);
  assert.equal(back.entry.library, 'public');
  assert.equal(back.entry.speakerId, null);

  const moved = await action({ action: 'lexicon.move', id: publicAdd.entry.id, library: 'voiceprint' });
  assert.equal(moved.ok, true);
  assert.equal(moved.entry.speakerId, SELF);
  assert.deepEqual(
    await action({ action: 'lexicon.move', id: publicAdd.entry.id, library: 'private' }),
    { ok: false, reason: 'invalid-library' },
  );

  // /word still writes only public, even while a confirmed self exists.
  const command = createWordCommandDefinition({ store, log: collectingLog() });
  const wordResult = await command.handler({ rawInput: '"麦克风" 术语 "输入设备"' });
  assert.equal(wordResult.kind, 'success');
  const wordEntry = store.listConfirmed().find((entry) => entry.text === '麦克风');
  assert.equal(wordEntry.library, 'public');
  assert.equal(wordEntry.speakerId, null);
  assert.deepEqual(store.listActive().map((entry) => entry.text).includes('麦克风'), true);

  // Without a confirmed self the same settings actions refuse the personal slot explicitly.
  const anonymousRoot = tempRoot(t);
  const anonymousStore = createLexiconStore({ root: anonymousRoot });
  const anonymousAction = hearingActions(anonymousStore, '');
  assert.deepEqual(
    await anonymousAction({ action: 'lexicon.add', text: '私人词', category: 'person', library: 'voiceprint' }),
    { ok: false, reason: 'self-required' },
  );
  const anonymousPublic = await anonymousAction({
    action: 'lexicon.add', text: '公共词', category: 'person',
  });
  assert.equal(anonymousPublic.ok, true);
  assert.deepEqual(
    await anonymousAction({ action: 'lexicon.move', id: anonymousPublic.entry.id, library: 'voiceprint' }),
    { ok: false, reason: 'self-required' },
  );

  console.log('[6] privateAdd=', JSON.stringify([privateAdd.entry.library, privateAdd.entry.speakerId]),
    'updatedSlots=', JSON.stringify([moved.entry.library, moved.entry.speakerId]),
    'word=', JSON.stringify([wordEntry.library, wordEntry.speakerId]),
    'anonymousSelfRequired=true');
});
