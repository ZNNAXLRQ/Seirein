/**
 * P-127 P1: `assistant_archive_search` must filter the archive by the resolved time window.
 *
 * Before this fix the tool computed a window (e.g. "昨天") only to throw it away at the store
 * call: `searchArchive(query, limit)` matched the word "昨天" anywhere in the whole archive, so
 * "no match" could not be read as "nothing in yesterday's window". This suite pins:
 *
 *   1. rows inside the window match, rows outside do not (ISO and epoch-ms bounds);
 *   2. no window still searches the whole archive (old behaviour preserved);
 *   3. a malformed/inverted bound falls back to the whole archive and is REPORTED, never
 *      silently treated as an empty result;
 *   4. hidden archive rows stay hidden (a time filter never resurrects them);
 *   5. the mounted tool projects + renders the window it actually used.
 *
 * Run: node --test test/memory-archive-range.mjs
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { apply } from '../src/host/index.js';
import { MemoryStore } from '../src/host/memory/store.js';
import { detectArchiveRange } from '../src/host/shared/time.js';
import { cleanupRoot } from './helpers/cleanup.mjs';

const TYPE_CHECKS = {
  object: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
  array: (value) => Array.isArray(value),
  string: (value) => typeof value === 'string',
  number: (value) => typeof value === 'number' && Number.isFinite(value),
  integer: (value) => Number.isInteger(value),
  boolean: (value) => typeof value === 'boolean',
  null: (value) => value === null,
};

function validate(schema, value, path = 'value') {
  if (Object.hasOwn(schema, 'oneOf')) {
    const matches = schema.oneOf.filter((candidate) => {
      try {
        validate(candidate, value, path);
        return true;
      } catch {
        return false;
      }
    });
    assert.equal(matches.length, 1, `${path} must match exactly one oneOf branch`);
    return;
  }
  if (Object.hasOwn(schema, 'type')) {
    assert.ok(TYPE_CHECKS[schema.type](value), `${path} must be of type ${schema.type}`);
  }
  if (Object.hasOwn(schema, 'enum')) assert.ok(schema.enum.includes(value), `${path} is not an enum member`);
  if (schema.type === 'object') {
    for (const key of schema.required ?? []) assert.ok(Object.hasOwn(value, key), `${path}.${key} is required`);
    const properties = schema.properties ?? {};
    for (const [key, child] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) validate(child, value[key], `${path}.${key}`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        assert.ok(Object.hasOwn(properties, key), `"${path}.${key}" is not a declared property`);
      }
    }
  }
  if (schema.type === 'array') {
    for (const [index, item] of value.entries()) validate(schema.items ?? {}, item, `${path}[${index}]`);
  }
}

async function tempRoot(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

async function openStore(root) {
  const memory = new MemoryStore(root, { capacity: 5000 });
  memory.open();
  return memory;
}

/** Insert one archived row directly; the archive triggers keep memory_archive_fts in sync. */
function archive(memory, { text, ts, hidden = 0 }) {
  const id = randomUUID();
  memory.db
    .prepare(`INSERT INTO memory_archive
      (id, ts, domain, kind, text, importance, clarity, archived_at, reason, hidden)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, ts, 'chat', 'fact', text, 50, 'trace', ts, 'test', hidden);
  return id;
}

const midpoint = (range) => new Date((Date.parse(range.fromIso) + Date.parse(range.toIso)) / 2).toISOString();
const dayOffset = (range, days) => ({
  fromIso: new Date(Date.parse(range.fromIso) + days * 86_400_000).toISOString(),
  toIso: new Date(Date.parse(range.toIso) + days * 86_400_000).toISOString(),
});

/** Mount the plugin against a fake context, as the host does. */
function mount(root) {
  const tools = new Map();
  const disposers = [];
  const effect = (fn) => {
    const dispose = fn();
    if (typeof dispose === 'function') disposers.push(dispose);
    return dispose;
  };
  apply({
    effect,
    tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name); } },
    inject: (_names, callback) => callback({
      effect,
      webServer: { register: () => () => {} },
      systemPrompt: { section: () => () => {} },
    }),
  }, { root, defaultDomain: 'chat', enabled: true });
  return { tools, disposers };
}

const renderText = (tool, value) => tool.output.render({}, value)
  .filter((block) => block.type === 'text').map((block) => block.text).join('\n');

// ---------------------------------------------------------------------------
// Store level: keyword AND time on the archived original's ts
// ---------------------------------------------------------------------------

test('searchArchiveInWindow filters by ISO and epoch-ms bounds, and no bound keeps the full archive', async (t) => {
  const root = await tempRoot('dsh-archive-range-');
  const memory = await openStore(root);
  t.after(async () => {
    memory.close();
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  const window = detectArchiveRange('昨天');
  const inside = archive(memory, { text: '昨天的动画电影很好看', ts: midpoint(window) });
  const outside = archive(memory, { text: '前天的动画电影也不错', ts: midpoint(dayOffset(window, -2)) });
  const hidden = archive(memory, { text: '昨天被合并的动画电影', ts: midpoint(window), hidden: 1 });

  const byIso = memory.searchArchiveInWindow('动画电影', { from: window.fromIso, to: window.toIso });
  assert.deepEqual(byIso.rows.map((row) => row.id), [inside], 'only the in-window visible row matches');
  assert.deepEqual(byIso.range, { from: window.fromIso, to: window.toIso });
  assert.equal(byIso.invalid, false);

  const byMs = memory.searchArchiveInWindow('动画电影', {
    from: Date.parse(window.fromIso),
    to: Date.parse(window.toIso),
  });
  assert.deepEqual(byMs.rows.map((row) => row.id), [inside], 'epoch-ms bounds behave like ISO');
  assert.deepEqual(byMs.range, byIso.range);

  const whole = memory.searchArchiveInWindow('动画电影');
  assert.deepEqual(new Set(whole.rows.map((row) => row.id)), new Set([inside, outside]),
    'no bound = whole archive (hidden still excluded)');
  assert.equal(whole.range, null);
  assert.equal(whole.invalid, false);

  // The old call shapes keep working: no options, a limit, and the includeHidden opt-in.
  assert.deepEqual(new Set(memory.searchArchive('动画电影').map((row) => row.id)), new Set([inside, outside]));
  assert.equal(memory.searchArchive('动画电影', 1).length, 1);
  assert.deepEqual(
    new Set(memory.searchArchive('动画电影', 10, { includeHidden: true }).map((row) => row.id)),
    new Set([inside, outside, hidden]),
  );

  console.log(`[store-range] in=${inside.slice(0, 8)} out=${outside.slice(0, 8)} hidden=${hidden.slice(0, 8)}`
    + ` iso=${byIso.rows.length} ms=${byMs.rows.length} whole=${whole.rows.length}`);
});

test('an invalid or inverted window falls back to the whole archive and reports invalid:true', async (t) => {
  const root = await tempRoot('dsh-archive-invalid-');
  const memory = await openStore(root);
  t.after(async () => {
    memory.close();
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  const window = detectArchiveRange('昨天');
  const first = archive(memory, { text: '动画电影第一行', ts: midpoint(dayOffset(window, -1)) });
  const second = archive(memory, { text: '动画电影第二行', ts: midpoint(window) });

  for (const bounds of [
    { from: 'not-a-date', to: 'also-bad' },
    { from: window.toIso, to: window.fromIso },
    // A bound is never spliced into SQL; an injection-shaped string is simply invalid and falls back.
    { from: `${window.fromIso}' OR 1=1 --`, to: window.toIso },
  ]) {
    const result = memory.searchArchiveInWindow('动画电影', bounds);
    assert.equal(result.invalid, true, `invalid window is reported: ${JSON.stringify(bounds)}`);
    assert.equal(result.range, null, 'an unusable window is not reported as a real range');
    assert.deepEqual(new Set(result.rows.map((row) => row.id)), new Set([first, second]),
      'the fallback searches the whole archive instead of an empty window');
  }

  // A partially malformed window is rejected as a whole, not half-applied.
  const partial = memory.searchArchiveInWindow('动画电影', { from: 'not-a-date', to: window.toIso });
  assert.equal(partial.invalid, true);
  assert.equal(partial.range, null);
  assert.equal(partial.rows.length, 2);

  console.log(`[store-invalid] fallbackRows=${partial.rows.length} invalid=${partial.invalid}`);
});

// ---------------------------------------------------------------------------
// Tool level: the mounted assistant_archive_search uses and reports the window
// ---------------------------------------------------------------------------

test('assistant_archive_search matches inside the window, never outside, and reports range', async (t) => {
  const root = await tempRoot('dsh-archive-tool-');
  const yesterday = detectArchiveRange('昨天');
  const beforeYesterday = detectArchiveRange('前天');

  const seeder = await openStore(root);
  const inYesterday = archive(seeder, {
    text: '昨天去看了动画电影',
    ts: midpoint(yesterday),
  });
  // Same keyword, wrong day: it must NOT be returned for a "昨天" query.
  const outsideYesterday = archive(seeder, {
    text: '昨天也看了动画电影',
    ts: midpoint(dayOffset(yesterday, -3)),
  });
  const before = archive(seeder, {
    text: '前天的动画电影',
    ts: midpoint(beforeYesterday),
  });
  seeder.close();

  const { tools, disposers } = mount(root);
  t.after(() => cleanupRoot(root, disposers));
  const tool = tools.get('assistant_archive_search');
  const schema = tool.output.schema;

  const scoped = await tool.execute({ query: '昨天' }, {});
  validate(schema, scoped);
  assert.deepEqual(scoped.range, { from: yesterday.fromIso, to: yesterday.toIso },
    'the projected range is the detected window');
  assert.equal(scoped.relaxed, false);
  assert.equal(scoped.rangeInvalid, false);
  assert.deepEqual(scoped.hits.map((hit) => hit.id), [inYesterday],
    'the out-of-window row with the same word is not a hit');
  const scopedText = renderText(tool, scoped);
  assert.ok(
    scopedText.includes(`查询范围：${yesterday.fromIso}–${yesterday.toIso}`),
    `render names the applied window\n${scopedText}`,
  );
  assert.ok(scopedText.includes('放宽：否'), scopedText);

  const otherDay = await tool.execute({ query: '前天' }, {});
  validate(schema, otherDay);
  assert.deepEqual(otherDay.range, { from: beforeYesterday.fromIso, to: beforeYesterday.toIso });
  assert.deepEqual(otherDay.hits.map((hit) => hit.id), [before]);

  // No time phrase: the whole archive (the old behaviour) and an explicit "unbounded" render.
  const whole = await tool.execute({ query: '动画电影' }, {});
  validate(schema, whole);
  assert.equal(whole.range, null, 'a keyword-only archive query has no window');
  assert.equal(whole.relaxed, false);
  assert.equal(whole.rangeInvalid, false);
  assert.deepEqual(
    new Set(whole.hits.map((hit) => hit.id)),
    new Set([inYesterday, outsideYesterday, before]),
    'without a window every visible archived row is searched',
  );
  const wholeText = renderText(tool, whole);
  assert.ok(wholeText.includes('查询范围：未限定'), wholeText);
  assert.ok(wholeText.includes('放宽：否'), wholeText);

  console.log(`[tool-range] 昨天=${scoped.hits.length} 前天=${otherDay.hits.length} all=${whole.hits.length}`);
});

test('assistant_archive_search reports a rejected window instead of claiming an empty result', async (t) => {
  const root = await tempRoot('dsh-archive-tool-invalid-');
  const seeder = await openStore(root);
  archive(seeder, { text: '回退报告用的动画电影', ts: new Date().toISOString() });
  seeder.close();

  const original = MemoryStore.prototype.searchArchiveInWindow;
  MemoryStore.prototype.searchArchiveInWindow = function invalidWindow() {
    return { rows: [], range: null, invalid: true };
  };
  t.after(() => {
    MemoryStore.prototype.searchArchiveInWindow = original;
  });

  const { tools, disposers } = mount(root);
  t.after(() => cleanupRoot(root, disposers));
  const tool = tools.get('assistant_archive_search');
  const value = await tool.execute({ query: '昨天 回退报告' }, {});

  validate(tool.output.schema, value);
  assert.equal(value.rangeInvalid, true, 'the invalid window is reported, not hidden');
  assert.equal(value.range, null);
  assert.equal(value.relaxed, false);
  const text = renderText(tool, value);
  assert.ok(text.includes('查询范围：未限定'), text);
  assert.ok(text.includes('已回退为全归档'), `render reports the fallback\n${text}`);
  console.log(`[tool-invalid] rangeInvalid=${value.rangeInvalid} text="${text.split('\n')[0]}"`);
});

test('a time filter never resurrects a hidden archive row', async (t) => {
  const root = await tempRoot('dsh-archive-hidden-');
  const seeder = await openStore(root);
  const window = detectArchiveRange('昨天');
  const visible = archive(seeder, { text: '昨天去看了动画电影', ts: midpoint(window) });
  const hidden = archive(seeder, { text: '昨天被更正合并的动画电影', ts: midpoint(window), hidden: 1 });
  seeder.close();

  const { tools, disposers } = mount(root);
  t.after(() => cleanupRoot(root, disposers));
  const tool = tools.get('assistant_archive_search');
  // "昨天" applies both the time window AND the keyword; the hidden row contains the word and
  // sits inside the window, so only the visibility rule can keep it out of the answer.
  const value = await tool.execute({ query: '昨天' }, {});

  validate(tool.output.schema, value);
  const ids = value.hits.map((hit) => hit.id);
  assert.deepEqual(ids, [visible], 'the hidden row stays hidden even when it is inside the window');
  assert.equal(ids.includes(hidden), false, 'a hidden row is not resurrected by the time filter');
  console.log(`[hidden] visible=${visible.slice(0, 8)} hiddenExcluded=${!ids.includes(hidden)}`);
});
