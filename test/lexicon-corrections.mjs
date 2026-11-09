/**
 * Personal lexicon stage 1 — the tightened "不是甲，是乙" rules.
 *
 * An explicit correction becomes a lexicon rule only when it corrects a word form/reading, the
 * target is unique, and the speaker identity is confirmed. A fact correction (周五/周六, 3个/4个)
 * is ignored with a reason and never enters the lexicon. Replacement entries must carry a
 * `context` and `applyCorrection` only replaces where that context still matches.
 *
 * Run: node --test test/lexicon-corrections.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyCorrection,
  confirmCandidate,
  createLexiconState,
  extractLexiconCandidates,
  listEntries,
  listUnassigned,
  mergeCandidates,
  parseExplicitCorrection,
} from '../src/host/speech/lexicon-candidates.js';

const T1 = '2026-11-08T09:00:00+08:00';
const T2 = '2026-11-08T09:05:00+08:00';

test('1. 「不是小满，是向晚」+ 词形线索 → correction，wrongForms 含小满，带 context', () => {
  const parsed = parseExplicitCorrection('不是小满，是向晚，写法是向晚');
  assert.equal(parsed.kind, 'correction');
  assert.equal(parsed.wrong, '小满');
  assert.equal(parsed.right, '向晚');
  assert.equal(parsed.explicit, true);
  assert.equal(parsed.ambiguous, false);
  assert.equal(parsed.ignored, undefined);
  assert.deepEqual(parsed.context, { before: '不是', after: '，是向晚' });

  const candidates = extractLexiconCandidates({
    corrections: [{ ...parsed, at: T1, speakerId: 'spk-1' }],
    now: T2,
  });
  assert.equal(candidates.length, 1);
  const [entry] = candidates;
  assert.equal(entry.kind, 'correction');
  assert.deepEqual(entry.wrongForms, ['小满']);
  assert.deepEqual(entry.context, { before: '不是', after: '，是向晚' });
  assert.equal(entry.ambiguous, false);
  assert.equal(entry.assigned, true);
  assert.equal(entry.speakerId, 'spk-1');

  // The effective entry keeps the replacement context and the misrecognised form.
  const state = createLexiconState();
  mergeCandidates(state, candidates);
  const confirmed = confirmCandidate(state, { text: '向晚', speakerId: 'spk-1', canonical: '向晚', now: T2 });
  assert.equal(confirmed.ok, true);
  assert.deepEqual(listEntries(state)[0].context, { before: '不是', after: '，是向晚' });
  assert.deepEqual(listEntries(state)[0].wrongForms, ['小满']);

  // Without a cue word, two short name-shaped nouns are enough: this stays a form correction.
  const noCue = parseExplicitCorrection('不是小满，是向晚');
  assert.equal(noCue.kind, 'correction');
  assert.equal(noCue.ambiguous, false);
  assert.deepEqual(noCue.context, { before: '不是', after: '，是向晚' });

  console.log('[1] parsed=', JSON.stringify(parsed), 'entry=', JSON.stringify(entry), 'confirmed=', JSON.stringify(listEntries(state)[0]), 'no-cue=', noCue.kind);
});

test('2. 「不是周五，是周六」→ fact-correction，ignored + reason，语言库不生效', () => {
  const parsed = parseExplicitCorrection('不是周五，是周六');
  assert.equal(parsed.kind, 'fact-correction');
  assert.equal(parsed.ignored, true);
  assert.equal(parsed.reason, 'fact-correction');
  assert.equal(parsed.wrong, '周五');
  assert.equal(parsed.right, '周六');

  const candidates = extractLexiconCandidates({
    corrections: [{ ...parsed, at: T1, speakerId: 'spk-1' }],
    now: T2,
  });
  assert.deepEqual(candidates, [], 'a fact correction never becomes a lexicon candidate');

  const state = createLexiconState();
  assert.deepEqual(mergeCandidates(state, candidates), { ok: true, added: 0, merged: 0, skipped: 0 });
  assert.deepEqual(listEntries(state), []);
  assert.deepEqual(listUnassigned(state), []);
  assert.equal(JSON.stringify(state).includes('周六'), false, 'nothing about the fact is stored');

  console.log('[2] parsed=', JSON.stringify(parsed), 'candidates=', candidates.length, 'entries=', listEntries(state).length);
});

test('3. 「不是3个，是4个」→ fact-correction（数量）', () => {
  const parsed = parseExplicitCorrection('不是3个，是4个');
  assert.equal(parsed.kind, 'fact-correction');
  assert.equal(parsed.ignored, true);
  assert.equal(parsed.reason, 'fact-correction');
  assert.equal(parsed.wrong, '3个');
  assert.equal(parsed.right, '4个');
  assert.deepEqual(parsed.context, { before: '不是', after: '，是4个' });

  const candidates = extractLexiconCandidates({
    corrections: [{ ...parsed, at: T1, speakerId: 'spk-1' }],
    now: T2,
  });
  assert.deepEqual(candidates, []);
  // The action/state variant is a fact too.
  assert.equal(parseExplicitCorrection('不是去了，是没去').kind, 'fact-correction');

  console.log('[3] parsed=', JSON.stringify(parsed), 'action=', parseExplicitCorrection('不是去了，是没去').kind);
});

test('4. 同句两个纠正 / 代词指向不明 → ambiguous，落候选但不自动确认', () => {
  const parsed = parseExplicitCorrection('不是小满，是向晚，也不是小蛮，是向晚');
  assert.equal(parsed.kind, 'correction');
  assert.equal(parsed.ambiguous, true);
  assert.equal(parsed.reason, 'ambiguous-target');

  const candidates = extractLexiconCandidates({
    corrections: [{ ...parsed, at: T1, speakerId: 'spk-1' }],
    now: T2,
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].ambiguous, true);
  assert.equal(candidates[0].assigned, false, 'an ambiguous target is never attributed');
  assert.equal(candidates[0].speakerId, null);

  const state = createLexiconState();
  mergeCandidates(state, candidates);
  assert.equal(listUnassigned(state)[0].ambiguous, true);
  const refused = confirmCandidate(state, { text: '向晚', speakerId: 'spk-1', now: T2 });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'ambiguous-target');
  assert.deepEqual(listEntries(state), []);

  const pronoun = parseExplicitCorrection('不是这个，是向晚');
  assert.equal(pronoun.kind, 'correction');
  assert.equal(pronoun.ambiguous, true);
  assert.equal(pronoun.wrong, '这个');

  console.log('[4] parsed=', JSON.stringify(parsed), 'candidate=', JSON.stringify(candidates[0]), 'confirm=', JSON.stringify(refused));
});

test('5. speakerId 为空 → 候选不 assigned，但确认不再要求 speakerId', () => {
  const parsed = parseExplicitCorrection('不是小满，是向晚');
  assert.equal(parsed.ambiguous, false);

  for (const speakerId of [null, undefined, '   ']) {
    const candidates = extractLexiconCandidates({
      corrections: [{ ...parsed, at: T1, speakerId }],
      now: T2,
    });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].assigned, false);
    assert.equal(candidates[0].speakerId, null);
  }

  const candidates = extractLexiconCandidates({
    corrections: [{ ...parsed, at: T1, speakerId: null }],
    now: T2,
  });
  const state = createLexiconState();
  mergeCandidates(state, candidates);
  assert.equal(listUnassigned(state).length, 1);
  assert.deepEqual(listEntries(state), []);

  // The shared lexicon does not require a voiceprint identity: confirmation succeeds with
  // speakerId null and the entry becomes effective.
  const confirmed = confirmCandidate(state, { text: '向晚', canonical: '向晚', now: T2 });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.entry.assigned, true);
  assert.equal(confirmed.entry.speakerId, null);
  assert.equal(listUnassigned(state).length, 0);
  assert.equal(listEntries(state).length, 1);

  console.log('[5] candidate=', JSON.stringify(candidates[0]), 'confirm=', JSON.stringify(confirmed.entry));
});

test('6. applyCorrection：上下文匹配才替换，不匹配/无上下文不替换', () => {
  const entry = {
    text: '向晚',
    canonical: '向晚',
    wrongForms: ['小满'],
    context: { before: '她叫', after: '来了' },
  };
  const hit = applyCorrection('她叫小满来了，大家都笑了。', entry);
  assert.equal(hit.ok, true);
  assert.equal(hit.replaced, 1);
  assert.equal(hit.changed, true);
  assert.equal(hit.text, '她叫向晚来了，大家都笑了。');

  const miss = applyCorrection('小满今天很开心。', entry);
  assert.equal(miss.ok, true);
  assert.equal(miss.replaced, 0);
  assert.equal(miss.changed, false);
  assert.equal(miss.text, '小满今天很开心。', 'no global replacement without matching context');

  const bare = applyCorrection('她叫小满来了。', { text: '向晚', canonical: '向晚', wrongForms: ['小满'] });
  assert.equal(bare.ok, false);
  assert.equal(bare.reason, 'context-required');
  assert.equal(bare.text, '她叫小满来了。');

  const zero = applyCorrection('她叫小满来了。', entry, { contextWindow: 0 });
  assert.equal(zero.ok, false);
  assert.equal(zero.reason, 'context-required');

  console.log('[6] hit=', JSON.stringify(hit), 'miss=', JSON.stringify(miss), 'bare=', JSON.stringify(bare));
});

test('7. 同一错词在不同上下文 → 只替换匹配的那处', () => {
  const parsed = parseExplicitCorrection('不是小满，是向晚');
  const entry = { ...parsed, wrongForms: ['小满'], canonical: '向晚' };
  const source = '不是小满，是向晚。小满来了。';

  const applied = applyCorrection(source, entry);
  assert.equal(applied.ok, true);
  assert.equal(applied.replaced, 1, 'only the occurrence with the stored context is replaced');
  assert.equal(applied.text, '不是向晚，是向晚。小满来了。');
  assert.equal(applied.text.includes('。小满来了。'), true, 'the other occurrence stays untouched');

  const elsewhere = applyCorrection('她叫小满来了。', entry);
  assert.equal(elsewhere.replaced, 0);
  assert.equal(elsewhere.text, '她叫小满来了。');

  console.log('[7] source=', JSON.stringify(source), 'applied=', JSON.stringify(applied), 'elsewhere=', JSON.stringify(elsewhere));
});
