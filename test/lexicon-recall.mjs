/**
 * Lexicon v2 — local candidate recall engine.
 *
 * Run: node --test test/lexicon-recall.mjs
 *
 * The cases mirror the acceptance items:
 *   1. exact canonical/text/wrongForms, with a stable public field shape;
 *   2. an exact reading, a reading within one edit, and a shared reading fragment;
 *   3. near-form matching without a reading (edit distance + Dice), and unrelated text missing;
 *   4. close top-two scores (gap < RECALL_AMBIGUITY_GAP) reported as ambiguous, far scores not;
 *   5. category/usage only as a light bonus — never pulling in an unmatched entry;
 *   6. empty text, missing/bad arrays and malformed entries are safe and skipped;
 *   7. the returned candidate list is bounded by the default and by the caller's limit;
 *   8. CJK/Japanese/English mixing is safe, and Latin forms are not matched inside longer tokens.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RECALL_AMBIGUITY_GAP,
  recallLexiconCandidates,
} from '../src/host/speech/lexicon-recall.js';

function entry(id, canonical, extra = {}) {
  return {
    id,
    text: canonical,
    canonical,
    category: 'unknown',
    usage: '',
    reading: '',
    wrongForms: [],
    ...extra,
  };
}

function ids(result) {
  return result.entries.map((candidate) => candidate.id);
}

const EMPTY = {entries: [], ambiguous: false};

test('exact canonical / text / wrongForm hits, with a stable candidate shape', () => {
  const entries = [
    entry('canonical', '向晚'),
    entry('wrong', '阿澄', {wrongForms: ['阿橙']}),
    entry('shared', '星野'),
    entry('unrelated', '长夜'),
  ];

  const canonical = recallLexiconCandidates({entries, text: '今天向晚来了'});
  assert.deepEqual(ids(canonical), ['canonical']);
  assert.equal(canonical.ambiguous, false);
  const hit = canonical.entries[0];
  assert.deepEqual(Object.keys(hit), ['id', 'text', 'canonical', 'category', 'usage', 'score', 'reasons']);
  assert.equal(hit.text, '向晚');
  assert.equal(hit.canonical, '向晚');
  assert.ok(hit.reasons.includes('exact:canonical'));
  assert.ok(hit.score >= 0.97);

  const wrong = recallLexiconCandidates({entries: [entries[1]], text: '我认识阿橙'});
  assert.deepEqual(ids(wrong), ['wrong']);
  assert.ok(wrong.entries[0].reasons.includes('exact:wrongForm'));
  assert.ok(wrong.entries[0].score >= 0.93);

  // NFKC/case/space insensitive exact text hit.
  const spaced = recallLexiconCandidates({
    entries: [entry('latin', 'OpenAI')],
    text: 'open ai 发布了新东西',
  });
  assert.deepEqual(ids(spaced), ['latin']);
  assert.ok(spaced.entries[0].reasons.includes('exact:canonical'));
});

test('reading: exact, one-edit near, and a shared fragment', () => {
  const target = entry('read', '向晚', {reading: 'xiang wan'});

  const exact = recallLexiconCandidates({entries: [target], text: 'wo xiang wan'});
  assert.deepEqual(ids(exact), ['read']);
  assert.ok(exact.entries[0].reasons.includes('reading:exact'));
  assert.equal(exact.entries[0].score, 0.9);

  const near = recallLexiconCandidates({entries: [target], text: 'wo xiang wam'});
  assert.deepEqual(ids(near), ['read']);
  assert.ok(near.entries[0].reasons.includes('reading:near'));
  assert.ok(near.entries[0].score >= 0.82);

  const fragment = recallLexiconCandidates({entries: [target], text: 'xiang'});
  assert.deepEqual(ids(fragment), ['read']);
  assert.ok(fragment.entries[0].reasons.includes('reading:fragment'));
  assert.ok(fragment.entries[0].score >= 0.7);

  // Japanese kana reading, no romanization involved.
  const japanese = recallLexiconCandidates({
    entries: [entry('jp', '今日和', {reading: 'きょうわ'})],
    text: 'きょうわ、またね',
  });
  assert.deepEqual(ids(japanese), ['jp']);
  assert.ok(japanese.entries[0].reasons.includes('reading:exact'));
});

test('near-form matching without a reading, and unrelated text misses', () => {
  const near = recallLexiconCandidates({
    entries: [entry('near', '向晚')],
    text: '我在等向皖',
  });
  assert.deepEqual(ids(near), ['near']);
  assert.ok(near.entries[0].reasons.includes('form:near'));
  assert.ok(!near.entries[0].reasons.some((reason) => reason.startsWith('exact:')));
  assert.ok(near.entries[0].score >= 0.7);
  assert.ok(near.entries[0].score < 0.9);

  const longer = recallLexiconCandidates({
    entries: [entry('goal', '今天和')],
    text: '今天话很多',
  });
  assert.deepEqual(ids(longer), ['goal']);

  for (const text of ['今天天气不错', 'nothing related here', '']) {
    const miss = recallLexiconCandidates({entries: [entry('far', '向晚')], text});
    assert.deepEqual(miss, EMPTY);
  }
});

test('close top-two scores are ambiguous, a clear winner is not', () => {
  const close = recallLexiconCandidates({
    entries: [entry('first', '向晚'), entry('second', '向皖')],
    text: '向碗',
  });
  assert.deepEqual(ids(close), ['first', 'second']);
  assert.equal(close.ambiguous, true);
  assert.ok(close.entries[0].score - close.entries[1].score < RECALL_AMBIGUITY_GAP);

  const clear = recallLexiconCandidates({
    entries: [entry('exact', '向晚'), entry('near', '向皖')],
    text: '向晚',
  });
  assert.deepEqual(ids(clear), ['exact', 'near']);
  assert.equal(clear.ambiguous, false);
});

test('category/usage bonus reorders only already-matched candidates', () => {
  const entries = [
    entry('character', '向晚', {category: 'character'}),
    entry('term', '向皖', {category: 'term'}),
  ];
  const result = recallLexiconCandidates({entries, text: '这个角色叫向碗'});
  assert.deepEqual(ids(result), ['character', 'term']);
  assert.ok(result.entries[0].reasons.includes('category:hint'));
  assert.ok(!result.entries[1].reasons.includes('category:hint'));
  assert.equal(result.ambiguous, true);

  const usage = recallLexiconCandidates({
    entries: [entry('friend', '向晚', {usage: '朋友之间的称呼'})],
    text: '我朋友叫向皖',
  });
  assert.ok(usage.entries[0].reasons.includes('usage:overlap'));
  assert.ok(usage.entries[0].score > 0.7);

  // A usage description that mentions the utterance cannot recall an unrelated entry.
  const unrelated = recallLexiconCandidates({
    entries: [entry('other', '阿澄', {category: 'character', usage: '向晚是我的朋友'})],
    text: '向晚',
  });
  assert.deepEqual(unrelated, EMPTY);
});

test('empty, missing and malformed inputs are safe', () => {
  assert.deepEqual(recallLexiconCandidates(), EMPTY);
  assert.deepEqual(recallLexiconCandidates(null), EMPTY);
  assert.deepEqual(recallLexiconCandidates({entries: null, text: '向晚'}), EMPTY);
  assert.deepEqual(recallLexiconCandidates({entries: [], text: '向晚'}), EMPTY);
  assert.deepEqual(recallLexiconCandidates({entries: [entry('x', '向晚')], text: 42}), EMPTY);
  assert.deepEqual(recallLexiconCandidates({entries: [entry('x', '向晚')], text: '   '}), EMPTY);

  const malformed = [
    null,
    'not an entry',
    42,
    [],
    {},
    {id: 'blank', text: '', canonical: '   '},
    {id: 'types', text: 123, canonical: null},
  ];
  const valid = entry('valid', '向晚');
  const result = recallLexiconCandidates({entries: [...malformed, valid], text: '向晚'});
  assert.deepEqual(ids(result), ['valid']);

  // Auxiliary fields of the wrong type are tolerated, not fatal.
  const tolerant = recallLexiconCandidates({
    entries: [{
      id: 'tolerant',
      text: '向晚',
      canonical: '向晚',
      category: 7,
      usage: null,
      reading: 42,
      wrongForms: 'not-an-array',
    }],
    text: '向晚',
  });
  assert.deepEqual(ids(tolerant), ['tolerant']);
  assert.equal(tolerant.entries[0].category, 'unknown');
  assert.equal(tolerant.entries[0].usage, '');
});

test('candidate count is bounded by the default and by the caller limit', () => {
  const entries = ['甲', '乙', '丙', '丁', '戊'].map((marker, index) => (
    entry(`e${index}`, `占位${index}`, {wrongForms: [`错${marker}`]})
  ));
  const text = '错甲 错乙 错丙 错丁 错戊';

  const byDefault = recallLexiconCandidates({entries, text});
  assert.equal(byDefault.entries.length, 3);
  assert.equal(byDefault.ambiguous, true);

  const limited = recallLexiconCandidates({entries, text, limit: 1});
  assert.equal(limited.entries.length, 1);
  // Ambiguity is computed before truncation: a limit must not hide a close second.
  assert.equal(limited.ambiguous, true);

  const wide = recallLexiconCandidates({entries, text, limit: 100});
  assert.equal(wide.entries.length, 5);

  const invalid = recallLexiconCandidates({entries, text, limit: 0});
  assert.equal(invalid.entries.length, 3);
});

test('mixed CJK/Japanese/English text is safe; Latin matches respect token boundaries', () => {
  const gpt = recallLexiconCandidates({
    entries: [entry('gpt', 'GPT-4', {category: 'term'})],
    text: '我用GPT4画图',
  });
  assert.deepEqual(ids(gpt), ['gpt']);

  const inside = recallLexiconCandidates({
    entries: [entry('ann', 'Ann')],
    text: 'banana',
  });
  assert.deepEqual(inside, EMPTY);

  const boundary = recallLexiconCandidates({
    entries: [entry('ann', 'Ann')],
    text: 'ann is here',
  });
  assert.deepEqual(ids(boundary), ['ann']);

  const mixed = recallLexiconCandidates({
    entries: [entry('mixed', '向晚AI', {wrongForms: ['向皖AI']})],
    text: '向皖AI来了',
  });
  assert.deepEqual(ids(mixed), ['mixed']);
  assert.ok(mixed.entries[0].reasons.includes('exact:wrongForm'));
});
