/**
 * 共享语言库：确认门槛、跨说话人共享与冲突规则。
 *
 * 锁定用户 2026-11-10 的要求：
 *   1. 两个不同 speakerId 的候选进入同一份库；确认不需要声纹，speakerId 只是可选来源；
 *   2. 没有 speakerId 也能确认，确认后 listEntries / listConfirmed 生效；
 *   3. 同一个写法来自多个说话人时合并为一条共享候选，候选和词条都不按 speaker 分库；
 *   4. ambiguous target 与 rejected 墓碑仍然拒绝确认；
 *   5. 上下文纠正仍然生效（只在上下文匹配时替换）。
 *
 * Run: node --test test/lexicon-shared.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  applyCorrection,
  confirmCandidate,
  createLexiconState,
  extractLexiconCandidates,
  listCandidates,
  listEntries,
  listUnassigned,
  mergeCandidates,
  parseExplicitCorrection,
  rejectCandidate,
} from '../src/host/speech/lexicon-candidates.js';
import {
  applyLexiconHints,
  createLexiconStore,
  lexiconHints,
} from '../src/host/speech/lexicon-store.js';

const T0 = '2026-11-10T09:00:00+08:00';
const T1 = '2026-11-10T09:05:00+08:00';
const T2 = '2026-11-10T09:10:00+08:00';

function tempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'seirein-lexicon-shared-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** One explicit correction candidate from one speaker. */
function correctionCandidates(text, speakerId, at = T0) {
  return extractLexiconCandidates({
    corrections: [{ ...parseExplicitCorrection(text), at, speakerId }],
    now: at,
  });
}

/** Two ordinary mentions of one word → one proper-noun candidate. */
function properNounCandidates(word, at = T0) {
  return extractLexiconCandidates({
    utterances: [
      { id: 'u1', text: `${word} 今天来了。`, at, speakerId: null, source: 'mic' },
      { id: 'u2', text: `我见过 ${word}。`, at, speakerId: null, source: 'mic' },
    ],
    now: at,
  });
}

test('1. 不同 speakerId 的候选进入同一库；无声纹确认成功，listEntries 生效', (t) => {
  const root = tempRoot(t);
  const store = createLexiconStore({ root, clock: () => new Date(T1) });

  // Two different words, each first seen from a different speaker.
  const fromSpeakerA = correctionCandidates('不是小满，是向晚', 'spk-a');
  const fromSpeakerB = correctionCandidates('不是阿杰，是林晚', 'spk-b');
  assert.deepEqual(store.mergeCandidates([...fromSpeakerA, ...fromSpeakerB]), {
    added: 2, merged: 0, skipped: 0,
  });

  // The store is one shared bucket: both speakers' candidates are side by side.
  assert.deepEqual(
    store.listCandidates().map((entry) => [entry.text, entry.assigned, entry.speakerId]).sort(),
    [['向晚', true, 'spk-a'], ['林晚', true, 'spk-b']].sort(),
  );

  // No speakerId at all: the user's confirmation alone is enough.
  const first = store.confirm({ text: '向晚', canonical: '向晚' });
  assert.equal(first.ok, true);
  assert.equal(first.entry.status, 'confirmed');
  assert.equal(first.entry.assigned, true);
  assert.equal(first.entry.speakerId, null);
  assert.equal(first.entry.canonical, '向晚');

  // The same for the second speaker's candidate, addressed by its stable id.
  const second = store.confirm({ id: store.listCandidates()[0].id });
  assert.equal(second.ok, true);
  assert.equal(second.entry.status, 'confirmed');
  assert.equal(second.entry.assigned, true);
  assert.equal(second.entry.speakerId, null);

  // One shared effective list, not one list per speaker.
  const effective = store.listConfirmed();
  assert.deepEqual(effective.map((entry) => entry.canonical).sort(), ['向晚', '林晚'].sort());
  assert.equal(effective.every((entry) => entry.status === 'confirmed' && entry.assigned === true), true);
  assert.deepEqual(store.listUnassigned(), []);

  // listEntries (pure model) agrees with the store view.
  assert.deepEqual(
    listEntries(store.read()).map((entry) => entry.text).sort(),
    ['向晚', '林晚'].sort(),
  );

  // Persisted rows carry the same shared semantics: assigned:true, speakerId:null.
  const saved = JSON.parse(readFileSync(join(root, 'data', 'lexicon.json'), 'utf8'));
  assert.equal(saved.entries.length, 2);
  for (const entry of saved.entries) {
    assert.equal(entry.status, 'confirmed');
    assert.equal(entry.assigned, true);
    assert.equal(entry.speakerId, null);
    assert.equal(entry.canonical, entry.text);
  }

  console.log('[1] entries=', JSON.stringify(effective.map((entry) => [entry.text, entry.status, entry.assigned, entry.speakerId])));
});

test('2. 同一个写法来自两个 speaker：合并为一条共享候选，确认后仍只有一条词条', (t) => {
  const root = tempRoot(t);
  const store = createLexiconStore({ root, clock: () => new Date(T1) });

  const candidates = [
    ...correctionCandidates('不是小满，是向晚', 'spk-a', T0),
    ...correctionCandidates('不是小蛮，是向晚', 'spk-b', T0),
  ];
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].text, '向晚');
  assert.equal(candidates[1].text, '向晚');

  assert.deepEqual(store.mergeCandidates(candidates), { added: 1, merged: 1, skipped: 0 });

  const pending = store.listCandidates();
  assert.equal(pending.length, 1, 'one shared row, not one row per speaker');
  assert.equal(pending[0].text, '向晚');
  assert.deepEqual(pending[0].wrongForms.sort(), ['小蛮', '小满'].sort());
  // Two different optional sources are not ownership: the row stays shared and unattributed
  // rather than picking one speaker.
  assert.equal(pending[0].speakerId, null);
  assert.equal(pending[0].assigned, false);

  const confirmed = store.confirm({ text: '向晚', canonical: '向晚' });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.entry.speakerId, null);
  assert.equal(store.listConfirmed().length, 1);
  assert.deepEqual(store.listConfirmed()[0].wrongForms.sort(), ['小蛮', '小满'].sort());
  assert.equal(store.list().filter((entry) => entry.text === '向晚').length, 1);

  console.log('[2] pending=', JSON.stringify([pending[0].text, pending[0].wrongForms, pending[0].speakerId]),
    'confirmed=', JSON.stringify([confirmed.entry.text, confirmed.entry.wrongForms, confirmed.entry.speakerId]));
});

test('3. ambiguous target 与 rejected 墓碑仍然拒绝确认', (t) => {
  const root = tempRoot(t);
  const store = createLexiconStore({ root, clock: () => new Date(T1) });

  const ambiguousParsed = parseExplicitCorrection('不是小满，是向晚，不是小蛮');
  assert.equal(ambiguousParsed.ambiguous, true);
  const ambiguousCandidates = extractLexiconCandidates({
    corrections: [{ ...ambiguousParsed, at: T0, speakerId: 'spk-a' }],
    now: T0,
  });
  assert.equal(ambiguousCandidates.length, 1);
  assert.equal(ambiguousCandidates[0].ambiguous, true);
  store.mergeCandidates(ambiguousCandidates);
  const refused = store.confirm({ text: '向晚', canonical: '向晚' });
  assert.deepEqual(refused, { ok: false, reason: 'ambiguous-target' });
  assert.deepEqual(store.listConfirmed(), []);

  // A rejected candidate stays a tombstone and cannot be confirmed afterwards.
  const proper = properNounCandidates('TTS');
  const rejectedState = createLexiconState();
  mergeCandidates(rejectedState, proper);
  assert.equal(rejectCandidate(rejectedState, { text: 'TTS', now: T1 }).ok, true);
  const rejected = confirmCandidate(rejectedState, { text: 'TTS', canonical: 'TTS', now: T2 });
  assert.deepEqual(rejected, { ok: false, reason: 'rejected' });
  assert.deepEqual(listEntries(rejectedState), []);
  assert.equal(listCandidates(rejectedState).length, 0);
  assert.equal(listUnassigned(rejectedState).length, 0);

  console.log('[3] ambiguous=', JSON.stringify(refused), 'rejected=', JSON.stringify(rejected));
});

test('4. 上下文纠正仍生效：只有上下文匹配才替换', () => {
  const state = createLexiconState();
  mergeCandidates(state, correctionCandidates('不是小满，是向晚', null));
  const confirmed = confirmCandidate(state, { text: '向晚', canonical: '向晚', now: T1 });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.entry.speakerId, null);
  assert.deepEqual(confirmed.entry.wrongForms, ['小满']);
  assert.deepEqual(confirmed.entry.context, { before: '不是', after: '，是向晚' });

  const hit = applyCorrection('不是小满，是向晚', confirmed.entry);
  assert.equal(hit.ok, true);
  assert.equal(hit.replaced, 1);
  assert.equal(hit.text, '不是向晚，是向晚');

  const miss = applyCorrection('小满今天很开心。', confirmed.entry);
  assert.equal(miss.ok, true);
  assert.equal(miss.replaced, 0);
  assert.equal(miss.text, '小满今天很开心。', 'no global replacement without matching context');

  // The same confirmed shared entry is a usable ASR hint for any speaker.
  const hints = lexiconHints(listEntries(state));
  assert.equal(hints.length, 1);
  assert.equal(hints[0].replaceable, true);
  const applied = applyLexiconHints('不是小满，是向晚', hints);
  assert.equal(applied.text, '不是向晚，是向晚');
  assert.equal(applied.applied.length, 1);

  console.log('[4] entry=', JSON.stringify([confirmed.entry.text, confirmed.entry.speakerId, confirmed.entry.wrongForms, confirmed.entry.context]),
    'hit=', JSON.stringify(hit.text), 'miss=', JSON.stringify(miss.text));
});

test('5. 可选 speakerId：提供则记录，空字符串规范化为 null', (t) => {
  const root = tempRoot(t);
  const store = createLexiconStore({ root, clock: () => new Date(T1) });

  store.mergeCandidates([
    ...correctionCandidates('不是小满，是向晚', null),
    ...properNounCandidates('TTS'),
  ]);
  const attributed = store.confirm({ text: '向晚', speakerId: '  spk-9  ', canonical: '向晚' });
  assert.equal(attributed.ok, true);
  assert.equal(attributed.entry.assigned, true);
  assert.equal(attributed.entry.speakerId, 'spk-9');

  const blank = store.confirm({ text: 'TTS', speakerId: '   ', canonical: 'TTS' });
  assert.equal(blank.ok, true);
  assert.equal(blank.entry.assigned, true);
  assert.equal(blank.entry.speakerId, null);

  console.log('[5] attributed=', JSON.stringify([attributed.entry.text, attributed.entry.speakerId]),
    'blank=', JSON.stringify([blank.entry.text, blank.entry.speakerId]));
});
