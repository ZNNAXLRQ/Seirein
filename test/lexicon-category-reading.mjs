/**
 * 共享词库：自由文本类别 + 无调拼音读音的验收。
 *
 * Covers the user's 2026-11-10 follow-up:
 *   1. category is free text (trim / 40 code-point bound), legacy ids still round-trip, and
 *      blank/missing is stored as `unknown`;
 *   2. the arbitrary category survives a re-read from disk;
 *   3. recall returns the custom category unchanged while the legacy character hint still works;
 *   4. readings typed as `chong dian`, `chongdian`, `chóng diàn` or `Chong Dian` are all recallable
 *      for the same untoned ASR spelling (case/space/tone folding);
 *   5. empty/bad category and reading inputs are refused without writing or throwing.
 *
 * Run: node --test test/lexicon-category-reading.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  LEXICON_CATEGORY_MAX_CHARS,
  LEXICON_DEFAULT_CATEGORY,
  LEXICON_READING_MAX_CHARS,
  createLexiconStore,
} from '../src/host/speech/lexicon-store.js';
import { recallLexiconCandidates } from '../src/host/speech/lexicon-recall.js';

const T0 = '2026-11-10T12:00:00+08:00';

function tempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'seirein-lexicon-category-reading-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('1. 类别是自由文本：trim/长度上限/旧枚举兼容/空值存 unknown', (t) => {
  const store = createLexiconStore({ root: tempRoot(t), clock: () => new Date(T0) });

  const custom = store.addEntry({ text: '奶茶', category: '  饮品  ' });
  assert.equal(custom.ok, true);
  assert.equal(custom.entry.category, '饮品', 'arbitrary category is stored trimmed');
  assert.equal(custom.entry.status, 'confirmed');

  const legacy = store.addEntry({ text: '向晚', category: 'character' });
  assert.equal(legacy.ok, true);
  assert.equal(legacy.entry.category, 'character', 'the legacy enum ids still round-trip');

  const blank = store.addEntry({ text: '空白类别', category: '   ' });
  assert.equal(blank.ok, true);
  assert.equal(blank.entry.category, LEXICON_DEFAULT_CATEGORY, 'a blank category is unknown');

  const missing = store.addEntry({ text: '没填类别' });
  assert.equal(missing.ok, true);
  assert.equal(missing.entry.category, LEXICON_DEFAULT_CATEGORY, 'a missing category is unknown');

  const bound = store.addEntry({ text: '边界类别', category: '饮'.repeat(LEXICON_CATEGORY_MAX_CHARS) });
  assert.equal(bound.ok, true);
  assert.equal(bound.entry.category, '饮'.repeat(LEXICON_CATEGORY_MAX_CHARS));

  assert.deepEqual(
    store.addEntry({ text: '过长类别', category: '饮'.repeat(LEXICON_CATEGORY_MAX_CHARS + 1) }),
    { ok: false, reason: 'invalid-category' },
    'the category bound is measured in code points',
  );
  assert.deepEqual(store.addEntry({ text: '坏类型', category: 42 }), { ok: false, reason: 'invalid-category' });

  const updated = store.updateEntry({ id: custom.entry.id, category: ' 饮料 ' });
  assert.equal(updated.ok, true);
  assert.equal(updated.entry.category, '饮料');
  const cleared = store.updateEntry({ id: custom.entry.id, category: '' });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.entry.category, LEXICON_DEFAULT_CATEGORY, 'clearing the category means unknown');

  assert.equal(store.listConfirmed().find((entry) => entry.text === '奶茶').category, 'unknown');
  assert.equal(store.listConfirmed().find((entry) => entry.text === '向晚').category, 'character');

  console.log('[1] custom=饮品 legacy=character blank=unknown bound=40 invalid=41/non-string');
});

test('2. 任意类别落盘后重新读取仍保留原文', (t) => {
  const root = tempRoot(t);
  const first = createLexiconStore({ root, clock: () => new Date(T0) });
  const added = first.addEntry({
    text: '充电',
    category: '  数码配件  ',
    usage: '给设备充电',
    reading: 'chong dian',
  });
  assert.equal(added.ok, true);
  assert.equal(added.entry.category, '数码配件');

  const second = createLexiconStore({ root });
  const persisted = second.listConfirmed().find((entry) => entry.text === '充电');
  assert.ok(persisted !== undefined);
  assert.equal(persisted.category, '数码配件', 'a free-text category is not coerced to unknown on read');
  assert.equal(persisted.reading, 'chong dian', 'the reading is preserved as the user typed it');

  console.log('[2] category=数码配件 reading=chong dian after-reopen=true');
});

test('3. recall 返回自定义类别原文；旧类别的类别提示仍然有效', () => {
  const custom = {
    id: 'custom',
    text: '奶茶',
    canonical: '奶茶',
    category: '饮品',
    usage: '',
    reading: 'nai cha',
    wrongForms: [],
  };
  const customHit = recallLexiconCandidates({ entries: [custom], text: '我想喝奶茶' });
  assert.equal(customHit.entries.length, 1);
  assert.equal(customHit.entries[0].category, '饮品', 'recall never rewrites a custom category to unknown');
  assert.ok(customHit.entries[0].reasons.includes('exact:canonical'));

  const legacy = {
    id: 'legacy',
    text: '向晚',
    canonical: '向晚',
    category: 'character',
    usage: '',
    reading: '',
    wrongForms: [],
  };
  const legacyHit = recallLexiconCandidates({ entries: [legacy], text: '这个角色叫向晚' });
  assert.equal(legacyHit.entries.length, 1);
  assert.equal(legacyHit.entries[0].category, 'character');
  assert.ok(legacyHit.entries[0].reasons.includes('category:hint'),
    'the legacy character hint still contributes its small bonus');

  console.log('[3] custom=饮品 exact=yes legacy=character hint=yes');
});

test('4. 读音无调/带调/空格/大小写都能按同一拼音召回', (t) => {
  const root = tempRoot(t);
  const store = createLexiconStore({ root, clock: () => new Date(T0) });
  const readings = ['chong dian', 'chongdian', 'chóng diàn', 'Chong Dian'];
  const entries = readings.map((reading, index) => {
    const added = store.addEntry({
      text: `充电${'一二三四'[index]}`,
      canonical: `充电${'一二三四'[index]}`,
      category: 'term',
      reading,
    });
    assert.equal(added.ok, true, `reading ${reading} is accepted`);
    assert.equal(added.entry.reading, reading, 'the reading keeps the user spelling');
    return added.entry;
  });

  const active = store.listActive();
  assert.equal(active.length, readings.length);
  for (const text of ['chong dian', 'chongdian', 'Chong Dian', 'CHONG DIAN']) {
    const result = recallLexiconCandidates({ entries: active, text, limit: 10 });
    assert.equal(result.entries.length, readings.length,
      `every stored reading variant recalls for ${JSON.stringify(text)}`);
    assert.ok(result.entries.every((hit) => hit.reasons.includes('reading:exact')),
      'the exact-reading signal is what matched');
  }

  // A blank reading stays valid and never breaks exact canonical recall.
  const blank = store.addEntry({ text: '空白读音', category: 'term', reading: '' });
  assert.equal(blank.ok, true);
  const exact = recallLexiconCandidates({ entries: store.listActive(), text: '空白读音' });
  assert.ok(exact.entries.some((hit) => hit.id === blank.entry.id));

  console.log('[4] readings=', JSON.stringify(readings), 'queries=4 all=reading:exact blank=ok');
});

test('5. 空/坏类别与读音输入：拒绝写入且 recall 不抛错', (t) => {
  const store = createLexiconStore({ root: tempRoot(t) });

  assert.deepEqual(
    store.addEntry({ text: '类别太长', category: '类'.repeat(LEXICON_CATEGORY_MAX_CHARS + 1) }),
    { ok: false, reason: 'invalid-category' },
  );
  assert.deepEqual(store.addEntry({ text: '类别类型错', category: { name: 'term' } }),
    { ok: false, reason: 'invalid-category' });
  assert.deepEqual(store.addEntry({ text: '读音类型错', category: 'term', reading: 42 }),
    { ok: false, reason: 'invalid-reading' });
  assert.deepEqual(
    store.addEntry({ text: '读音太长', category: 'term', reading: 'x'.repeat(LEXICON_READING_MAX_CHARS + 1) }),
    { ok: false, reason: 'invalid-reading' },
  );
  assert.equal(store.list().length, 0, 'every refused add wrote nothing');

  const malformed = recallLexiconCandidates({
    entries: [{
      id: 'bad',
      text: '充电',
      canonical: '充电',
      category: 42,
      usage: null,
      reading: 42,
      wrongForms: 'not-an-array',
    }],
    text: '充电',
  });
  assert.equal(malformed.entries.length, 1, 'bad optional fields do not break recall');
  assert.equal(malformed.entries[0].category, 'unknown');

  console.log('[5] invalid-category=2 invalid-reading=2 rows=0 recall-bad-fields=unknown');
});
