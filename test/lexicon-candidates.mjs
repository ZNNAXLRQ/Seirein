/**
 * Personal lexicon stage 1 — candidates + confirmation data model (pure module).
 *
 * The list mirrors the acceptance items:
 *   1. the same proper noun observed twice → candidate; once → not a candidate;
 *   2. an explicit correction "不是小满，是向晚" → kind correction, wrongForms contains 小满,
 *      assigned follows the correction speakerId (and duplicate wrong forms are de-duplicated);
 *   3. an ordinary-transcript candidate is assigned:false and lands in the unassigned area,
 *      never in the effective entry list — even when the utterance carries a speakerId;
 *   4. case / full-width / whitespace differences merge into one candidate with every source id;
 *   5. confirm sets canonical + assigned + confirmedAt and makes the entry visible; a second
 *      confirm can edit the canonical spelling;
 *   6. reject/remove work and the whole state survives a JSON round-trip;
 *   7. confirming without a speakerId is refused with ok:false and writes nothing.
 *
 * Run: node --test test/lexicon-candidates.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LEXICON_DEFAULTS,
  confirmCandidate,
  createLexiconState,
  extractLexiconCandidates,
  lexiconKey,
  listCandidates,
  listEntries,
  listUnassigned,
  mergeCandidates,
  parseExplicitCorrection,
  rejectCandidate,
  removeEntry,
} from '../src/host/speech/lexicon-candidates.js';

const T1 = '2026-11-08T09:00:00+08:00';
const T2 = '2026-11-08T09:05:00+08:00';
const T3 = '2026-11-08T09:10:00+08:00';
const T4 = '2026-11-08T09:15:00+08:00';

const iso = (value) => new Date(value).toISOString();

/** One user utterance in the shape the host will pass in. */
function utterance(id, text, at, speakerId = null) {
  return { id, text, at, speakerId, source: 'mic' };
}

/** Extraction + merge in one step, the way stage 2 will wire it. */
function extractAndMerge(state, options) {
  const candidates = extractLexiconCandidates(options);
  const merged = mergeCandidates(state, candidates);
  return { candidates, merged };
}

test('1. 同一专有名词出现 2 次 → 候选；只 1 次 → 不候选', () => {
  const twice = extractLexiconCandidates({
    utterances: [
      utterance('u1', '向晚今天来了。', T1),
      utterance('u2', '我见过向晚。', T2),
    ],
    now: T3,
  });
  const name = twice.find((candidate) => candidate.text === '向晚');
  assert.ok(name, 'two mentions of 向晚 must produce a candidate');
  assert.equal(name.kind, 'proper-noun');
  assert.deepEqual(name.sourceIds, ['u1', 'u2']);
  assert.deepEqual(name.wrongForms, []);
  assert.equal(name.assigned, false);
  assert.equal(name.speakerId, null);
  assert.equal(name.at, iso(T1));
  assert.deepEqual(
    Object.keys(name).sort(),
    ['assigned', 'at', 'kind', 'sourceIds', 'speakerId', 'text', 'wrongForms'],
    'the candidate surface is exactly the seven fields the stage-1 contract names',
  );

  const once = extractLexiconCandidates({
    utterances: [utterance('u1', '向晚今天来了。', T1)],
    now: T3,
  });
  assert.equal(once.some((candidate) => candidate.text === '向晚'), false, 'one mention is below the default threshold');

  // The threshold counts observations, so two occurrences in one utterance also qualify; the
  // source id is still the single utterance.
  const inOne = extractLexiconCandidates({
    utterances: [utterance('u1', '向晚来了，向晚走了。', T1)],
    now: T3,
  });
  const twiceInOne = inOne.find((candidate) => candidate.text === '向晚');
  assert.ok(twiceInOne);
  assert.deepEqual(twiceInOne.sourceIds, ['u1']);

  console.log('[1] twice=', JSON.stringify(name), 'once=', once.length, 'in-one=', JSON.stringify(twiceInOne));
});

test('2. 明确纠正“不是小满，是向晚” → correction 候选，wrongForms 含小满，assigned 依 speakerId', () => {
  const parsed = parseExplicitCorrection('不是小满，是向晚');
  assert.deepEqual(parsed, { wrong: '小满', right: '向晚', explicit: true });
  assert.deepEqual(parseExplicitCorrection('不是小满而是向晚'), { wrong: '小满', right: '向晚', explicit: true });
  assert.deepEqual(parseExplicitCorrection('是向晚，不是小满'), { wrong: '小满', right: '向晚', explicit: true });
  assert.equal(parseExplicitCorrection('今天下雨了'), null);

  const candidates = extractLexiconCandidates({
    corrections: [
      { ...parsed, at: T1, speakerId: 'spk-1' },
      { wrong: ' 小满 ', right: '向晚', at: T2, speakerId: 'spk-1', explicit: true },
      { wrong: '小蛮', right: '向晚', at: T3, speakerId: 'spk-1', explicit: true },
    ],
    now: T3,
  });
  assert.equal(candidates.length, 1, 'all three corrections name the same right form');
  const [entry] = candidates;
  assert.equal(entry.kind, 'correction');
  assert.equal(entry.text, '向晚');
  assert.deepEqual(entry.wrongForms, ['小满', '小蛮'], 'duplicate wrong forms are de-duplicated, distinct ones are kept');
  assert.deepEqual(entry.sourceIds, []);
  assert.equal(entry.assigned, true);
  assert.equal(entry.speakerId, 'spk-1');
  assert.equal(entry.at, iso(T1));

  const unassigned = extractLexiconCandidates({
    corrections: [{ wrong: '小满', right: '向晚', at: T1, speakerId: null, explicit: true }],
    now: T3,
  });
  assert.equal(unassigned[0].assigned, false);
  assert.equal(unassigned[0].speakerId, null);

  // A correction that is not user-explicit is not trusted and must not enter this lane.
  const notExplicit = extractLexiconCandidates({
    corrections: [{ wrong: '小满', right: '向晚', at: T1, speakerId: 'spk-1', explicit: false }],
    now: T3,
  });
  assert.deepEqual(notExplicit, []);

  console.log('[2] entry=', JSON.stringify(entry), 'unassigned=', JSON.stringify(unassigned[0]), 'non-explicit=', notExplicit.length);
});

test('3. 普通转写候选 assigned:false，进未归属区，不进已确认词库', () => {
  const state = createLexiconState();
  const { candidates } = extractAndMerge(state, {
    utterances: [
      // The utterance carries a speakerId; an ordinary transcript still may not claim the word.
      utterance('u1', 'VOCALOID 很好听。', T1, 'spk-1'),
      utterance('u2', '我昨天听了 VOCALOID。', T2, 'spk-1'),
    ],
    now: T3,
  });
  const entry = candidates.find((candidate) => candidate.text === 'VOCALOID');
  assert.ok(entry);
  assert.equal(entry.kind, 'proper-noun');
  assert.equal(entry.assigned, false);
  assert.equal(entry.speakerId, null);
  assert.deepEqual(entry.sourceIds, ['u1', 'u2']);

  assert.deepEqual(listEntries(state), [], 'a candidate is not effective yet');
  const unassigned = listUnassigned(state).find((item) => item.text === 'VOCALOID');
  assert.ok(unassigned);
  assert.equal(unassigned.status, 'candidate');
  assert.equal(unassigned.canonical, '');
  assert.equal(unassigned.assigned, false);
  assert.equal(listCandidates(state).length, 1);

  console.log('[3] candidate=', JSON.stringify(entry), 'unassigned=', JSON.stringify(unassigned), 'entries=', listEntries(state).length);
});

test('4. 大小写/全半角/空白不同 → 合并为一个候选并保留多个 sourceIds', () => {
  assert.equal(lexiconKey('Seirein'), 'seirein');
  assert.equal(lexiconKey('Ｓｅｉｒｅｉｎ'), 'seirein');
  assert.equal(lexiconKey('  S e i r e i n  '), 'seirein');

  const { candidates, merged } = extractAndMerge(createLexiconState(), {
    utterances: [
      utterance('u1', 'Seirein 是个项目。', T1),
      utterance('u2', 'Ｓｅｉｒｅｉｎ 很好用。', T2),
      utterance('u3', '我 喜欢 seirein 的界面。', T3),
      utterance('u4', 'S e i r e i n 也不错。', T4),
    ],
    now: T4,
  });
  assert.equal(candidates.length, 1, 'all four spellings are the same normalized form');
  const [entry] = candidates;
  assert.equal(entry.text, 'Seirein', 'the first observed spelling is kept for display');
  assert.deepEqual(entry.sourceIds, ['u1', 'u2', 'u3', 'u4']);
  assert.equal(entry.at, iso(T1));
  assert.equal(merged.added, 1);

  console.log('[4] key=', lexiconKey('Ｓｅｉｒｅｉｎ'), 'entry=', JSON.stringify(entry), 'merged=', JSON.stringify(merged));
});

test('5. confirm 后 canonical/assigned 正确，listEntries 可见；可再次修改', () => {
  const state = createLexiconState();
  extractAndMerge(state, {
    utterances: [
      utterance('u1', 'GPT4 是模型。', T1),
      utterance('u2', '我在用 GPT4。', T2),
    ],
    now: T3,
  });
  assert.ok(listCandidates(state).some((item) => item.text === 'GPT4'));

  const confirmed = confirmCandidate(state, { text: 'GPT4', speakerId: 'spk-1', canonical: 'GPT-4', now: T3 });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.entry.text, 'GPT4');
  assert.equal(confirmed.entry.canonical, 'GPT-4');
  assert.equal(confirmed.entry.assigned, true);
  assert.equal(confirmed.entry.speakerId, 'spk-1');
  assert.equal(confirmed.entry.status, 'confirmed');
  assert.equal(confirmed.entry.confirmedAt, iso(T3));

  const entries = listEntries(state);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].canonical, 'GPT-4');
  assert.equal(entries[0].assigned, true);
  assert.deepEqual(listUnassigned(state), []);

  // The canonical spelling is the editable field: confirm again with the corrected spelling.
  const edited = confirmCandidate(state, { text: 'GPT-4', speakerId: 'spk-2', canonical: 'GPT-4o', now: T4 });
  assert.equal(edited.ok, true);
  assert.equal(edited.entry.canonical, 'GPT-4o');
  assert.equal(edited.entry.speakerId, 'spk-2');
  assert.equal(listEntries(state)[0].canonical, 'GPT-4o');
  assert.equal(listEntries(state).length, 1, 'editing keeps the stable entry');

  // A missing canonical defaults to the candidate's own spelling.
  const defaultState = createLexiconState();
  extractAndMerge(defaultState, {
    utterances: [utterance('v1', 'TTS 是语音。', T1), utterance('v2', 'TTS 很好。', T2)],
    now: T3,
  });
  const defaults = confirmCandidate(defaultState, { text: 'TTS', speakerId: 'spk-3', now: T3 });
  assert.equal(defaults.ok, true);
  assert.equal(defaults.entry.canonical, 'TTS');

  console.log('[5] confirmed=', JSON.stringify(confirmed.entry), 'edited=', JSON.stringify(edited.entry), 'default=', JSON.stringify(defaults.entry));
});

test('6. reject/remove 生效，状态可 JSON 序列化往返', () => {
  const state = createLexiconState();
  const { candidates } = extractAndMerge(state, {
    utterances: [
      utterance('u1', 'TTS 是语音。', T1),
      utterance('u2', 'TTS 很好。', T2),
      utterance('u3', 'GPT4 是模型。', T2),
      utterance('u4', '我在用 GPT4。', T3),
    ],
    corrections: [{ wrong: '小满', right: '向晚', at: T2, speakerId: 'spk-1', explicit: true }],
    now: T3,
  });
  assert.equal(candidates.length, 3);

  const rejected = rejectCandidate(state, { text: 'TTS', now: T3 });
  assert.equal(rejected.ok, true);
  assert.equal(rejected.entry.status, 'rejected');
  assert.equal(rejected.entry.rejectedAt, iso(T3));
  assert.equal(listCandidates(state).some((item) => item.text === 'TTS'), false);
  assert.equal(listUnassigned(state).some((item) => item.text === 'TTS'), false);

  // The tombstone blocks re-extraction: the rejected form cannot silently come back.
  const again = mergeCandidates(state, candidates);
  assert.equal(again.added, 0);
  assert.equal(again.merged, 2);
  assert.equal(again.skipped, 1);
  assert.equal(listCandidates(state).some((item) => item.text === 'TTS'), false);

  const serialised = JSON.stringify(state);
  const restored = JSON.parse(serialised);
  assert.deepEqual(restored, state);
  assert.deepEqual(listCandidates(restored), listCandidates(state));
  assert.deepEqual(listUnassigned(restored), listUnassigned(state));
  assert.deepEqual(listEntries(restored), listEntries(state));
  assert.equal(restored.version, 1);
  assert.equal(typeof restored.nextId, 'number');

  const confirmed = confirmCandidate(state, { text: '向晚', speakerId: 'spk-1', canonical: '向晚', now: T3 });
  assert.equal(confirmed.ok, true);
  assert.equal(listEntries(state).length, 1);
  const removed = removeEntry(state, { text: '向晚' });
  assert.equal(removed.ok, true);
  assert.equal(listEntries(state).length, 0);
  assert.equal(removeEntry(state, { text: '向晚' }).ok, false);

  // Deleting the tombstone is the explicit purge; only then may extraction add the form again.
  assert.equal(removeEntry(state, { text: 'TTS' }).ok, true);
  const readded = mergeCandidates(state, candidates.find((candidate) => candidate.text === 'TTS'));
  assert.equal(readded.added, 1);
  assert.equal(listCandidates(state).some((item) => item.text === 'TTS'), true);

  const finalRoundTrip = JSON.parse(JSON.stringify(state));
  assert.deepEqual(finalRoundTrip, state);
  assert.deepEqual(listCandidates(finalRoundTrip), listCandidates(state));
  assert.deepEqual(listEntries(finalRoundTrip), listEntries(state));

  console.log('[6] rejected=', JSON.stringify(rejected.entry), 'again=', JSON.stringify(again), 'bytes=', serialised.length, 'readded=', JSON.stringify(readded));
});

test('7. 无 speakerId 时确认被拒绝（ok:false，不写）', () => {
  const state = createLexiconState();
  extractAndMerge(state, {
    utterances: [utterance('u1', 'TTS 是语音。', T1), utterance('u2', 'TTS 很好。', T2)],
    now: T3,
  });
  const before = JSON.stringify(state);

  const missing = confirmCandidate(state, { text: 'TTS', canonical: 'TTS', now: T3 });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'speaker-required');
  assert.equal(JSON.stringify(state), before, 'a refused confirmation writes nothing');
  assert.equal(listEntries(state).length, 0);
  assert.equal(listUnassigned(state)[0].canonical, '');

  const blank = confirmCandidate(state, { text: 'TTS', speakerId: '   ', canonical: 'TTS', now: T3 });
  assert.equal(blank.ok, false);
  assert.equal(blank.reason, 'speaker-required');
  assert.equal(JSON.stringify(state), before);

  const unknown = confirmCandidate(state, { text: '不存在', speakerId: 'spk-1', now: T3 });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reason, 'not-found');

  assert.equal(rejectCandidate(state, { text: 'TTS', now: T3 }).ok, true);
  const cannotConfirmRejected = confirmCandidate(state, { text: 'TTS', speakerId: 'spk-1', now: T3 });
  assert.equal(cannotConfirmRejected.ok, false);
  assert.equal(cannotConfirmRejected.reason, 'rejected');

  console.log('[7] missing=', JSON.stringify(missing), 'blank=', JSON.stringify(blank), 'unknown=', JSON.stringify(unknown), 'rejected=', JSON.stringify(cannotConfirmRejected));
  console.log('[constants]', JSON.stringify(LEXICON_DEFAULTS));
});
