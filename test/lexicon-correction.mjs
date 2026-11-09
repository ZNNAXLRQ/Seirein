/**
 * Lexicon v2 — pure replacement decision and plan application.
 *
 * Run: node --test test/lexicon-correction.mjs
 *
 * Covers the acceptance items:
 *   1. one clearly-leading exact/wrongForm candidate becomes one replacement;
 *   2. a close top-two score is ambiguous and replaces nothing;
 *   3. a top score below the threshold replaces nothing;
 *   4. category/usage-only evidence and unsupported near forms replace nothing;
 *   5. negated/explicit-correction and fact-shaped spans stay untouched;
 *   6. overlapping forms pick the longer, more specific span;
 *   7. two non-overlapping candidates are both applied in text order;
 *   8. applyLexiconPlan works from the end backwards (including a serialized plan);
 *   9. reading:exact can rewrite the recognised phonetic spelling;
 *  10. empty, missing and malformed inputs are safe and pure.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CORRECTION_MIN_GAP,
  CORRECTION_MIN_SCORE,
  applyLexiconPlan,
  planLexiconCorrection,
} from '../src/host/speech/lexicon-correction.js';

function candidate(id, canonical, extra = {}) {
  return {
    id,
    text: canonical,
    canonical,
    category: 'unknown',
    usage: '',
    score: 0.97,
    reasons: ['exact:wrongForm'],
    wrongForms: [],
    ...extra,
  };
}

function core(replacement) {
  return {
    from: replacement.from,
    to: replacement.to,
    entryId: replacement.entryId,
    reason: replacement.reason,
  };
}

test('1. a unique, clearly leading wrong form becomes one replacement', () => {
  const entry = candidate('char-1', '向晚', {wrongForms: ['向皖']});
  const plan = planLexiconCorrection('今天向皖来了', [entry]);

  assert.equal(plan.ambiguous, false);
  assert.equal(plan.reason, 'replace');
  assert.equal(plan.replacements.length, 1);
  assert.deepEqual(plan.replacements.map(core), [{
    from: '向皖',
    to: '向晚',
    entryId: 'char-1',
    reason: 'exact:wrongForm',
  }]);
  // The public plan shape stays exactly the documented four fields.
  assert.deepEqual(Object.keys(plan.replacements[0]), ['from', 'to', 'entryId', 'reason']);

  const applied = applyLexiconPlan('今天向皖来了', plan);
  assert.equal(applied.text, '今天向晚来了');
  assert.deepEqual(applied.applied.map(core), plan.replacements.map(core));

  // An already-correct spelling is never "replaced" with itself.
  const canonical = planLexiconCorrection('今天向晚来了', [entry]);
  assert.deepEqual(canonical.replacements, []);
  assert.equal(canonical.reason, 'already-canonical');
});

test('2. close top-two scores are ambiguous and replace nothing', () => {
  const first = candidate('first', '向晚', {wrongForms: ['向皖'], score: 0.97});
  const second = candidate('second', '向皖', {wrongForms: ['向皖'], score: 0.94});

  const plan = planLexiconCorrection('向皖来了', [first, second]);
  assert.ok(first.score - second.score < CORRECTION_MIN_GAP);
  assert.deepEqual(plan.replacements, []);
  assert.equal(plan.ambiguous, true);
  assert.equal(plan.reason, 'ambiguous');

  // recall's own ambiguity flag is authoritative even when only one entry survives a limit.
  const recallFlag = planLexiconCorrection('向皖来了', {entries: [first], ambiguous: true});
  assert.deepEqual(recallFlag.replacements, []);
  assert.equal(recallFlag.ambiguous, true);
  assert.equal(recallFlag.reason, 'ambiguous');
});

test('3. a top score below the threshold replaces nothing', () => {
  const plan = planLexiconCorrection('向皖来了', [
    candidate('weak', '向晚', {wrongForms: ['向皖'], score: CORRECTION_MIN_SCORE - 0.01}),
  ]);
  assert.deepEqual(plan.replacements, []);
  assert.equal(plan.ambiguous, false);
  assert.equal(plan.reason, 'low-confidence');
});

test('4. category/usage-only evidence and unsupported near forms are refused', () => {
  const contextOnly = planLexiconCorrection('这个角色叫向皖', [
    candidate('category', '向晚', {
      wrongForms: ['向皖'],
      score: 0.9,
      reasons: ['category:hint', 'usage:overlap'],
    }),
  ]);
  assert.deepEqual(contextOnly.replacements, []);
  assert.equal(contextOnly.reason, 'weak-evidence');

  const near = candidate('near', '向晚', {
    wrongForms: [],
    score: 0.86,
    reasons: ['form:near'],
    usage: '朋友之间的称呼',
  });
  const unsupported = planLexiconCorrection('我在等向皖', [near]);
  assert.deepEqual(unsupported.replacements, []);
  assert.equal(unsupported.reason, 'context-required');

  const supported = planLexiconCorrection('我在等向皖', [near], {context: '我朋友叫向皖'});
  assert.equal(supported.replacements.length, 1);
  assert.equal(supported.replacements[0].from, '向皖');
  assert.equal(supported.replacements[0].reason, 'form:near');

  const usageReason = planLexiconCorrection('我朋友叫向皖', [
    {...near, reasons: ['form:near', 'usage:overlap'], usage: '朋友之间的称呼'},
  ]);
  assert.equal(usageReason.replacements.length, 1, 'usage:overlap is valid support for a near form');
});

test('5. negation, explicit corrections and fact-shaped spans are not rewritten', () => {
  const name = candidate('name', '向晚', {wrongForms: ['向皖']});
  const negated = planLexiconCorrection('不是向皖，是向晚', [name]);
  assert.deepEqual(negated.replacements, []);
  assert.equal(negated.ambiguous, false);
  assert.equal(negated.reason, 'negation-context');

  const fact = planLexiconCorrection('不是周五，是周六', [
    candidate('fact', '周六', {wrongForms: ['周五']}),
  ]);
  assert.deepEqual(fact.replacements, []);
  assert.equal(fact.reason, 'factual-form');

  // An action/state fact supplied by a bad candidate is still not a spelling correction.
  const actionFact = planLexiconCorrection('我去了', [
    candidate('action', '没去', {wrongForms: ['去了']}),
  ]);
  assert.deepEqual(actionFact.replacements, []);
  assert.equal(actionFact.reason, 'factual-form');

  // Only the recognised form changes: the surrounding negation/intent stays intact.
  const ordinary = planLexiconCorrection('我不去，向皖也别去', [name]);
  const applied = applyLexiconPlan('我不去，向皖也别去', ordinary);
  assert.equal(applied.text, '我不去，向晚也别去');
  assert.equal(applied.text.includes('我不去'), true);
  assert.equal(applied.text.includes('别去'), true);
});

test('6. overlapping forms pick the longer, more specific span', () => {
  const entry = candidate('longer', '向晚', {wrongForms: ['小满', '小满子']});
  const plan = planLexiconCorrection('小满子来了', [entry]);

  assert.equal(plan.replacements.length, 1);
  assert.equal(plan.replacements[0].from, '小满子');
  assert.equal(plan.replacements[0].to, '向晚');
  assert.equal(applyLexiconPlan('小满子来了', plan).text, '向晚来了');
});

test('7. two non-overlapping candidates are both applied in text order', () => {
  const first = candidate('first', '向晚', {wrongForms: ['向皖'], score: 0.97});
  const second = candidate('second', '星野', {wrongForms: ['星也'], score: 0.86});
  const plan = planLexiconCorrection('向皖和星也', [first, second]);

  assert.equal(plan.ambiguous, false);
  assert.deepEqual(plan.replacements.map(core), [
    {from: '向皖', to: '向晚', entryId: 'first', reason: 'exact:wrongForm'},
    {from: '星也', to: '星野', entryId: 'second', reason: 'exact:wrongForm'},
  ]);
  assert.equal(applyLexiconPlan('向皖和星也', plan).text, '向晚和星野');
});

test('8. applyLexiconPlan applies from the end backwards, without offset drift', () => {
  const entry = candidate('repeat', '向晚', {wrongForms: ['向皖']});
  const source = '向皖来了，向皖走了，向皖笑了';
  const plan = planLexiconCorrection(source, [entry]);
  assert.equal(plan.replacements.length, 3);

  const appliedText = applyLexiconPlan(source, plan);
  assert.equal(appliedText.text, '向晚来了，向晚走了，向晚笑了');
  assert.equal(appliedText.applied.length, 3);
  // `applied` is reported in text order, not reverse application order.
  assert.deepEqual(appliedText.applied.map((item) => item.from), ['向皖', '向皖', '向皖']);

  // A serialized plan loses the hidden spans; literal fallback must still replace every occurrence.
  const serialized = JSON.parse(JSON.stringify(plan));
  assert.equal(serialized.replacements[0].start, undefined);
  assert.equal(applyLexiconPlan(source, serialized).text, '向晚来了，向晚走了，向晚笑了');

  // Replacements closer to the front are applied last, so their offsets stay valid.
  const manual = applyLexiconPlan('甲X乙Y', {
    replacements: [
      {from: 'X', to: 'LONG', entryId: 1, reason: 'r'},
      {from: 'Y', to: 'LONGER', entryId: 2, reason: 'r'},
    ],
  });
  assert.equal(manual.text, '甲LONG乙LONGER');
});

test('9. reading:exact may replace the recognised phonetic spelling', () => {
  const plan = planLexiconCorrection('wo xiang wan', [
    candidate('reading', '向晚', {
      wrongForms: [],
      reading: 'xiang wan',
      score: 0.9,
      reasons: ['reading:exact'],
    }),
  ]);
  assert.equal(plan.replacements.length, 1);
  assert.equal(plan.replacements[0].from, 'xiang wan');
  assert.equal(plan.replacements[0].to, '向晚');
  assert.equal(plan.replacements[0].reason, 'reading:exact');
  assert.equal(applyLexiconPlan('wo xiang wan', plan).text, 'wo 向晚');
});

test('10. empty, missing and malformed inputs are safe and pure', () => {
  assert.deepEqual(planLexiconCorrection(), {
    replacements: [],
    ambiguous: false,
    reason: 'empty-text',
  });
  assert.deepEqual(planLexiconCorrection(null), {
    replacements: [],
    ambiguous: false,
    reason: 'invalid-input',
  });
  assert.deepEqual(planLexiconCorrection('', []), {
    replacements: [],
    ambiguous: false,
    reason: 'empty-text',
  });
  assert.deepEqual(planLexiconCorrection('向皖来了', null), {
    replacements: [],
    ambiguous: false,
    reason: 'no-candidates',
  });
  assert.deepEqual(
    planLexiconCorrection('向皖来了', [null, 42, 'x', {id: 'bad', canonical: ''}]),
    {replacements: [], ambiguous: false, reason: 'no-candidates'},
  );

  const bad = candidate('bad', '向晚', {wrongForms: ['向皖'], reasons: 'exact:wrongForm'});
  assert.equal(planLexiconCorrection('向皖来了', [bad]).reason, 'weak-evidence');

  assert.deepEqual(applyLexiconPlan(null, {replacements: []}), {text: '', applied: []});
  assert.deepEqual(applyLexiconPlan('原样', null), {text: '原样', applied: []});
  assert.deepEqual(applyLexiconPlan('原样', {replacements: 'nope'}), {text: '原样', applied: []});
  assert.deepEqual(applyLexiconPlan('原样', {
    replacements: [
      null,
      {from: '', to: 'x'},
      {from: '原样', to: '原样'},
      {from: '不存在', to: 'x'},
    ],
  }), {text: '原样', applied: []});
});
