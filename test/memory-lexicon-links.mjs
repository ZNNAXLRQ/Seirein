/**
 * Memory ↔ shared-lexicon links — pure association layer.
 *
 * Run: node --test test/memory-lexicon-links.mjs
 *
 * Covered here:
 *   1. id normalization: trim, drop bad values, de-duplicate, cap and order;
 *   2. merge: union / dedupe / order / cap and input immutability;
 *   3. remove and recordHas, including malformed records;
 *   4. composition: de-duplication across memories, missing/deleted/non-current entries skipped,
 *      the five-field safe view, no definition copied into the memory, Map and object lookups;
 *   5. bad inputs return an empty result instead of throwing, and no function mutates its input.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MEMORY_LEXICON_MAX_IDS,
  composeMemoryLexiconRefs,
  mergeLexiconIds,
  normalizeLexiconIds,
  recordHasLexicon,
  removeLexiconId,
} from '../src/host/memory/lexicon-links.js';

/** Recursively freeze a plain data tree so an accidental in-place write throws. */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function snapshot(value) {
  return JSON.parse(JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// normalizeLexiconIds
// ---------------------------------------------------------------------------

test('normalize keeps non-empty strings, trims and preserves order', () => {
  assert.deepEqual(
    normalizeLexiconIds([' lex-b ', 'lex-a', 'lex-c']),
    ['lex-b', 'lex-a', 'lex-c'],
  );
});

test('normalize drops non-strings, empty and whitespace-only values', () => {
  assert.deepEqual(
    normalizeLexiconIds([null, undefined, 7, true, {}, [], '', '   ', '\n', ' ok ']),
    ['ok'],
  );
});

test('normalize de-duplicates after trimming and keeps the first position', () => {
  assert.deepEqual(
    normalizeLexiconIds(['b', ' a ', 'b', 'a', 'c', ' c ']),
    ['b', 'a', 'c'],
  );
});

test('normalize caps at MEMORY_LEXICON_MAX_IDS in input order', () => {
  const ids = Array.from({ length: 12 }, (_, index) => `lex-${index}`);
  assert.equal(MEMORY_LEXICON_MAX_IDS, 8);
  assert.deepEqual(normalizeLexiconIds(ids), ids.slice(0, MEMORY_LEXICON_MAX_IDS));
});

test('normalize treats a non-array as no links', () => {
  for (const value of [null, undefined, 'lex-a', 42, {}, { 0: 'lex-a' }]) {
    assert.deepEqual(normalizeLexiconIds(value), []);
  }
});

test('normalize returns a fresh array and never alters its input', () => {
  const input = deepFreeze([' a ', 'b', 'a']);
  const result = normalizeLexiconIds(input);
  assert.deepEqual(result, ['a', 'b']);
  assert.notEqual(result, input);
  assert.deepEqual(input, [' a ', 'b', 'a']);
});

// ---------------------------------------------------------------------------
// mergeLexiconIds
// ---------------------------------------------------------------------------

test('merge unions existing then incoming, de-duplicating and preserving order', () => {
  assert.deepEqual(
    mergeLexiconIds(['b', 'a', 'b'], ['c', 'a', ' d ']),
    ['b', 'a', 'c', 'd'],
  );
});

test('merge caps the union while existing ids win', () => {
  const existing = ['e0', 'e1', 'e2', 'e3', 'e4', 'e5'];
  const incoming = ['e4', 'e5', 'n0', 'n1', 'n2', 'n3'];
  assert.deepEqual(
    mergeLexiconIds(existing, incoming),
    ['e0', 'e1', 'e2', 'e3', 'e4', 'e5', 'n0', 'n1'],
  );
});

test('merge accepts bad/missing sides as empty and returns a fresh array', () => {
  assert.deepEqual(mergeLexiconIds(undefined, ['a']), ['a']);
  assert.deepEqual(mergeLexiconIds(['a'], null), ['a']);
  assert.deepEqual(mergeLexiconIds('a', {}), []);
});

test('merge does not modify either input', () => {
  const existing = deepFreeze(['a', 'b']);
  const incoming = deepFreeze(['b', 'c']);
  const result = mergeLexiconIds(existing, incoming);
  assert.deepEqual(result, ['a', 'b', 'c']);
  assert.notEqual(result, existing);
  assert.deepEqual(existing, ['a', 'b']);
  assert.deepEqual(incoming, ['b', 'c']);
});

// ---------------------------------------------------------------------------
// removeLexiconId
// ---------------------------------------------------------------------------

test('remove drops every occurrence of the trimmed id and keeps the others in order', () => {
  assert.deepEqual(removeLexiconId(['a', 'b', 'a', 'c'], ' b '), ['a', 'c']);
});

test('remove normalizes the remaining list (dedupe/order/cap)', () => {
  const ids = Array.from({ length: 10 }, (_, index) => `lex-${index}`);
  assert.deepEqual(removeLexiconId(ids, 'lex-0'), ids.slice(1, MEMORY_LEXICON_MAX_IDS + 1));
  assert.deepEqual(removeLexiconId(['b', ' a ', 'b'], 'zz'), ['b', 'a']);
});

test('remove with an unusable id returns a normalized fresh copy', () => {
  const input = deepFreeze([' b ', 'a', 'b']);
  const result = removeLexiconId(input, null);
  assert.deepEqual(result, ['b', 'a']);
  assert.notEqual(result, input);
  assert.deepEqual(input, [' b ', 'a', 'b']);
  assert.deepEqual(removeLexiconId(null, 'a'), []);
});

// ---------------------------------------------------------------------------
// recordHasLexicon
// ---------------------------------------------------------------------------

test('recordHas matches trimmed ids on a record', () => {
  const record = { id: 'm1', text: '向晚生日', lexiconIds: [' lex-1 ', 'lex-2'] };
  assert.equal(recordHasLexicon(record, 'lex-1'), true);
  assert.equal(recordHasLexicon(record, ' lex-2 '), true);
  assert.equal(recordHasLexicon(record, 'lex-3'), false);
});

test('recordHas is false for malformed records, missing links and unusable ids', () => {
  assert.equal(recordHasLexicon(null, 'lex-1'), false);
  assert.equal(recordHasLexicon(undefined, 'lex-1'), false);
  assert.equal(recordHasLexicon('record', 'lex-1'), false);
  assert.equal(recordHasLexicon([], 'lex-1'), false);
  assert.equal(recordHasLexicon({}, 'lex-1'), false);
  assert.equal(recordHasLexicon({ lexiconIds: 'lex-1' }, 'lex-1'), false);
  assert.equal(recordHasLexicon({ lexiconIds: [42, null] }, 'lex-1'), false);
  assert.equal(recordHasLexicon({ lexiconIds: ['lex-1'] }, null), false);
});

test('recordHas does not modify the record', () => {
  const record = deepFreeze({ id: 'm1', lexiconIds: ['a', 'b'] });
  assert.equal(recordHasLexicon(record, 'a'), true);
  assert.deepEqual(record, { id: 'm1', lexiconIds: ['a', 'b'] });
});

// ---------------------------------------------------------------------------
// composeMemoryLexiconRefs
// ---------------------------------------------------------------------------

/** One current confirmed entry as the shared lexicon store exposes it. */
function confirmedEntry(id, extra = {}) {
  return {
    id,
    status: 'confirmed',
    text: `text-${id}`,
    canonical: `canonical-${id}`,
    category: 'term',
    usage: `usage-${id}`,
    wrongForms: [`wrong-${id}`],
    reading: `reading-${id}`,
    ...extra,
  };
}

test('compose collects linked ids across memories in order and de-duplicates entries', () => {
  const records = [
    { id: 'm1', text: 'first', lexiconIds: [' lex-2 ', 'lex-1'] },
    { id: 'm2', text: 'second', lexiconIds: ['lex-1', 'lex-3'] },
  ];
  const entries = new Map([
    ['lex-1', confirmedEntry('lex-1')],
    ['lex-2', confirmedEntry('lex-2')],
    ['lex-3', confirmedEntry('lex-3')],
  ]);
  const refs = composeMemoryLexiconRefs(records, entries);
  assert.deepEqual(refs.map((ref) => ref.id), ['lex-2', 'lex-1', 'lex-3']);
});

test('compose returns exactly the five safe fields and never copies internal fields', () => {
  const records = [{ id: 'm1', lexiconIds: ['lex-1'] }];
  const entries = new Map([['lex-1', confirmedEntry('lex-1', {
    speakerId: 'voice-self',
    sourceIds: ['candidate-1'],
    context: { before: 'x', after: 'y' },
  })]]);
  const refs = composeMemoryLexiconRefs(records, entries);
  assert.deepEqual(refs, [{
    id: 'lex-1',
    text: 'text-lex-1',
    canonical: 'canonical-lex-1',
    category: 'term',
    usage: 'usage-lex-1',
  }]);
  assert.deepEqual(Object.keys(refs[0]).sort(), ['canonical', 'category', 'id', 'text', 'usage']);
});

test('compose skips missing, deleted, rejected, candidate and malformed entries', () => {
  const records = [{
    id: 'm1',
    lexiconIds: ['missing', 'rejected', 'candidate', 'deleted', 'null-entry', 'scalar-entry',
      'empty', 'mismatch', 'no-text'],
  }];
  const entries = new Map([
    ['rejected', confirmedEntry('rejected', { status: 'rejected' })],
    ['candidate', confirmedEntry('candidate', { status: 'candidate' })],
    ['deleted', confirmedEntry('deleted', { deleted: true })],
    ['null-entry', null],
    ['scalar-entry', 'not-an-entry'],
    ['empty', {}],
    ['mismatch', confirmedEntry('other-id')],
    ['no-text', { id: 'no-text', text: '', canonical: '   ', category: 'term' }],
  ]);
  assert.deepEqual(composeMemoryLexiconRefs(records, entries), []);
});

test('compose accepts a plain object lookup and tolerates an entry without its own id', () => {
  const entries = {
    'lex-1': { text: '甲', canonical: '甲', category: 'person', usage: '' },
  };
  assert.deepEqual(
    composeMemoryLexiconRefs([{ lexiconIds: ['lex-1'] }], entries),
    [{ id: 'lex-1', text: '甲', canonical: '甲', category: 'person', usage: '' }],
  );
});

test('compose defaults missing fields and category safely', () => {
  const entries = new Map([
    ['lex-1', { id: 'lex-1', text: '甲' }],
  ]);
  assert.deepEqual(
    composeMemoryLexiconRefs([{ lexiconIds: ['lex-1'] }], entries),
    [{ id: 'lex-1', text: '甲', canonical: '', category: 'unknown', usage: '' }],
  );
});

test('compose skips malformed records and bad inputs without throwing', () => {
  const entries = new Map([['lex-1', confirmedEntry('lex-1')]]);
  assert.deepEqual(
    composeMemoryLexiconRefs([null, 7, 'record', [], {}, { lexiconIds: 'lex-1' }], entries),
    [],
  );
  assert.deepEqual(composeMemoryLexiconRefs(null, entries), []);
  assert.deepEqual(composeMemoryLexiconRefs([{ lexiconIds: ['lex-1'] }], null), []);
  assert.deepEqual(composeMemoryLexiconRefs([{ lexiconIds: ['lex-1'] }], 'nope'), []);
  assert.deepEqual(composeMemoryLexiconRefs([{ lexiconIds: ['lex-1'] }], new Map()), []);
});

test('compose never writes into the memories or the entries', () => {
  const records = deepFreeze([
    { id: 'm1', text: '向晚是角色', lexiconIds: [' lex-1 ', 'missing'] },
    { id: 'm2', text: '再提一次', lexiconIds: ['lex-1'] },
  ]);
  const entry = confirmedEntry('lex-1', { definition: '一条释义' });
  const entries = new Map([['lex-1', entry]]);
  const entriesBefore = snapshot(entry);
  const recordsBefore = snapshot(records);

  const refs = composeMemoryLexiconRefs(records, entries);

  assert.equal(refs.length, 1);
  assert.deepEqual(records, recordsBefore);
  assert.deepEqual(entry, entriesBefore);
  // The memory keeps ids only, never a definition/spelling copy.
  assert.deepEqual(Object.keys(records[0]).sort(), ['id', 'lexiconIds', 'text']);
  assert.equal('definition' in refs[0], false);
});
