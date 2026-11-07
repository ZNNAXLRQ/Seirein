/**
 * D2 projection regression: `assistant_recall` must expose the assembly rows the store already
 * built — `kind` (hit / link / pair / neighbour / due convention), `group`, `delivered`,
 * `unresolved` — plus one top-level `assembly` summary (hits / pairs / neighbors / chars /
 * dropped / rowLimit / charLimit …), and the rendered text must name each row's kind, mark
 * pair/neighbour rows as context, and repeat the same summary.
 *
 * P-66 host-projection acceptance (2026-11-08): the three items the plan leaves open are pinned
 * here — (1) the model can tell "direct hits N + same-turn pairs M + ±window neighbours K" apart,
 * (2) candidates refused by the budget are visible in `assembly.dropped` / `skippedByBudget`,
 * (3) a legacy row without `kind` / `group` does not break the schema.
 *
 * The fixtures are REAL MemoryStore rows created through the normal addMessage / linkTurnRecord
 * path, then the mounted tool is called exactly as the model would call it.
 *
 * Run: node --test test/memory-recall-projection.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { apply } from '../src/host/index.js';
import { MemoryStore } from '../src/host/memory/store.js';
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

/** Minimal validator for the tool-output schema subset used by `assistant_recall`. */
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

/** Mount the plugin against a fake context, as the host does. */
function mount(root) {
  const tools = new Map();
  const disposers = [];
  const ctx = {
    effect: (fn) => {
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
      return dispose;
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    inject: (_names, callback) => callback({
      effect: (fn) => {
        const dispose = fn();
        if (typeof dispose === 'function') disposers.push(dispose);
        return dispose;
      },
      webServer: { register: () => () => {} },
      systemPrompt: { section: () => () => {} },
    }),
  };
  apply(ctx, { root, defaultDomain: 'chat', enabled: true });
  return { tools, disposers };
}

/** Seed through the real store (the tool opens the same file later). */
function seed(root, rows) {
  const store = new MemoryStore(root, { capacity: 5000 });
  try {
    return rows.map((row) => store.addMessage(row));
  } finally {
    store.close();
  }
}

const idsInRenderOrder = (lines) => lines
  .map((line) => line.match(/id ([0-9a-f-]{36})/u)?.[1] ?? null)
  .filter((id) => id !== null);

test('assistant_recall projects kind/group/delivered/unresolved + assembly and renders type prefixes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-recall-projection-'));
  const now = Date.now();
  const at = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString();

  // Seed through the real store (the tool opens the same file later).
  const add = (options) => seed(root, [options]);
  add({
    role: 'user', sessionId: 'projection', turnId: 1, messageId: 'projection-1',
    ts: at(60), text: '我昨天看了一部电影。',
  });
  add({
    role: 'assistant', sessionId: 'projection', turnId: 2, messageId: 'projection-2',
    ts: at(50), text: '那部电影叫什么名字？',
  });
  add({
    role: 'user', sessionId: 'projection', turnId: 3, messageId: 'projection-3',
    ts: at(40), text: '周末去看樱花吧，顺便拍点照片。',
  });
  add({
    role: 'assistant', sessionId: 'projection', turnId: 3, messageId: 'projection-3-reply',
    ts: at(39), text: '好，我把相机和电池放进包里。',
  });
  add({
    role: 'user', sessionId: 'projection', turnId: 4, messageId: 'projection-4',
    ts: at(30), text: '出门记得带伞。',
  });
  // Due-convention supplement: no keyword overlap with "樱花", but it names tomorrow's date.
  // (upcomingCandidates reads the absolute date the normalizer writes, not the word 明天.)
  const tomorrow = new Date(now + 24 * 60 * 60 * 1000);
  const tomorrowStamp = [
    tomorrow.getFullYear(),
    String(tomorrow.getMonth() + 1).padStart(2, '0'),
    String(tomorrow.getDate()).padStart(2, '0'),
  ].join('-');
  add({
    role: 'user', sessionId: 'projection', turnId: 9, messageId: 'projection-9',
    ts: at(10), text: `${tomorrowStamp} 记得去买猫粮。`,
  });

  const { tools, disposers } = mount(root);
  t.after(() => cleanupRoot(root, disposers));

  const tool = tools.get('assistant_recall');
  assert.ok(tool !== undefined, 'assistant_recall is registered');
  const value = await tool.execute({ query: '樱花', limit: 10 }, {});
  const schema = tool.output.schema;

  // 1. The declared schema accepts the projected value (additionalProperties: false included).
  validate(schema, value);
  assert.ok(Object.hasOwn(schema.properties, 'assembly'), 'the top-level assembly is declared');

  // 2. All four row shapes really came from the store, and every row carries the D2 flags.
  const kinds = new Set(value.hits.map((hit) => hit.kind));
  for (const kind of ['hit', 'link', 'neighbor', 'upcoming']) {
    assert.ok(kinds.has(kind), `the fixture produced a ${kind} row (saw ${[...kinds].join(', ')})`);
  }
  for (const hit of value.hits) {
    assert.equal(typeof hit.delivered, 'boolean', `${hit.id} declares delivered`);
    assert.ok(hit.unresolved === 0 || hit.unresolved === 1, `${hit.id} declares unresolved as 0/1`);
  }
  const hitRows = value.hits.filter((hit) => hit.kind === 'hit');
  for (const hit of value.hits) {
    if (hit.kind === 'hit' || hit.kind === 'upcoming') {
      assert.equal(Object.hasOwn(hit, 'group'), false, `${hit.kind} row carries no group`);
    } else {
      assert.ok(hitRows.some((row) => row.id === hit.group), `${hit.kind}.group names a direct hit`);
    }
  }
  const link = value.hits.find((hit) => hit.kind === 'link');
  assert.equal(link.delivered, true, 'the link row delivered its body');

  // 3. The assembly summary is the whitelisted subset and agrees with the rows.
  assert.deepEqual(Object.keys(value.assembly).sort(), [
    'chars', 'charLimit', 'delivered', 'dropped', 'hits', 'limit', 'links',
    'neighbors', 'pairs', 'rowLimit', 'skippedByBudget', 'upcoming',
  ].sort());
  assert.ok(value.assembly.hits >= 1, 'assembly counts the direct hit');
  assert.ok(value.assembly.links >= 1, 'assembly counts the link');
  assert.ok(value.assembly.upcoming >= 1, 'assembly counts the due convention');
  assert.equal(value.assembly.rowLimit, 6, 'rowLimit is the row half of the contract');
  assert.equal(value.assembly.charLimit, 600, 'charLimit is the budget the tool asked for');
  assert.ok(value.assembly.chars <= value.assembly.charLimit, 'chars never exceeds the limit');
  assert.equal(
    value.assembly.delivered,
    value.hits.filter((hit) => hit.delivered === true).length,
    'assembly.delivered is exactly the rows that delivered their body',
  );
  assert.equal(
    value.assembly.delivered,
    value.assembly.hits + value.assembly.links + value.assembly.pairs
      + value.assembly.neighbors + value.assembly.upcoming,
    'the delivered count is the sum of the projected kinds',
  );
  assert.ok(Number.isInteger(value.assembly.dropped), 'dropped is an integer');

  // 4. Render text names each row type and repeats the summary line.
  const text = tool.output.render({}, value).map((block) => block.text).join('\n');
  for (const label of ['[命中]', '[链接·上下文]', '[邻轮·上下文]', '[约定]']) {
    assert.ok(text.includes(label), `render shows ${label}\n${text}`);
  }
  assert.ok(
    text.includes(`命中 ${value.assembly.hits} · 同轮 ${value.assembly.pairs}`
      + ` · 邻轮 ${value.assembly.neighbors} · 链接 ${value.assembly.links}`
      + ` · 约定 ${value.assembly.upcoming} · 跳过 ${value.assembly.skippedByBudget}`
      + ` · 丢弃 ${value.assembly.dropped}`),
    `render repeats the assembly summary\n${text}`,
  );

  console.log(
    `[recall] kinds=${[...kinds].join(',')} hits=${value.assembly.hits} links=${value.assembly.links}`
    + ` pairs=${value.assembly.pairs} neighbors=${value.assembly.neighbors}`
    + ` upcoming=${value.assembly.upcoming} delivered=${value.assembly.delivered}`
    + ` skipped=${value.assembly.skippedByBudget} dropped=${value.assembly.dropped}`
    + ` chars=${value.assembly.chars}/${value.assembly.charLimit}`,
  );
});

test('mixed recall: direct hit N + same-turn pair M + ±window neighbour K each keep kind/group', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-recall-mixed-'));
  const now = Date.now();
  const at = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString();
  seed(root, [
    // Turn 1: two user lines. The second one is same-role, so no `turn` link exists — the pair
    // pass has to find it, which is exactly the row this test is about.
    {
      role: 'user', sessionId: 'mixed', turnId: 1, messageId: 'mixed-hit',
      ts: at(50), text: '长颈鹿今天吃掉了两筐树叶。',
    },
    {
      role: 'user', sessionId: 'mixed', turnId: 1, messageId: 'mixed-pair',
      ts: at(49), text: '后来它在树荫下面睡着了。',
    },
    {
      role: 'assistant', sessionId: 'mixed', turnId: 1, messageId: 'mixed-link',
      ts: at(48), text: '那它下午应该很有精神。',
    },
    {
      role: 'user', sessionId: 'mixed', turnId: 2, messageId: 'mixed-neighbor',
      ts: at(40), text: '栏舍外面那棵树该修剪了。',
    },
  ]);

  const { tools, disposers } = mount(root);
  t.after(() => cleanupRoot(root, disposers));
  const tool = tools.get('assistant_recall');
  const value = await tool.execute({ query: '长颈鹿', limit: 10 }, {});
  const schema = tool.output.schema;
  validate(schema, value);

  const byKind = (kind) => value.hits.filter((hit) => hit.kind === kind);
  const hit = byKind('hit')[0];
  assert.ok(hit !== undefined, `a direct hit exists (kinds=${value.hits.map((row) => row.kind).join(',')})`);
  assert.equal(byKind('hit').length, 1, 'exactly one independent hit');
  assert.equal(byKind('pair').length, 1, 'the same-turn second line is a pair');
  assert.equal(byKind('neighbor').length, 1, 'the ±window line is a neighbour');
  assert.equal(byKind('link').length, 1, 'the explicit turn link stays a link');

  // Every context row points back at the direct hit it was expanded from; the hit itself has no
  // group (the field is optional and never invented).
  for (const kind of ['pair', 'neighbor', 'link']) {
    assert.equal(byKind(kind)[0].group, hit.id, `${kind}.group is the source hit id`);
  }
  assert.equal(Object.hasOwn(hit, 'group'), false, 'a direct hit is not its own group');

  // The structured summary is the same N / M / K the rows report.
  assert.equal(value.assembly.hits, byKind('hit').length);
  assert.equal(value.assembly.pairs, byKind('pair').length);
  assert.equal(value.assembly.neighbors, byKind('neighbor').length);
  assert.equal(value.assembly.links, byKind('link').length);
  assert.equal(value.assembly.dropped, 0, 'nothing was dropped in this fixture');
  assert.equal(value.assembly.delivered, 4, 'all four rows delivered their body');
  assert.equal(value.assembly.delivered, value.hits.filter((row) => row.delivered === true).length);
  assert.equal(value.assembly.rowLimit, 6);
  assert.equal(value.assembly.charLimit, 600);
  assert.ok(value.assembly.chars <= value.assembly.charLimit, 'chars fits the budget');

  // Schema declaration: group is declared (but optional) and the new assembly counters are
  // both declared and required, so the rendered value can never silently omit them.
  const item = schema.properties.hits.items;
  assert.ok(Object.hasOwn(item.properties, 'group'), 'hits[].group is declared');
  assert.equal(item.required.includes('group'), false, 'group stays optional for legacy rows');
  for (const field of ['dropped', 'rowLimit', 'charLimit']) {
    assert.ok(Object.hasOwn(schema.properties.assembly.properties, field), `assembly.${field} is declared`);
    assert.ok(schema.properties.assembly.required.includes(field), `assembly.${field} is required`);
  }

  console.log(
    `[mixed] kinds=${value.hits.map((row) => `${row.kind}:${row.group === undefined ? '-' : 'hit'}`).join(',')}`
    + ` N=${value.assembly.hits} M=${value.assembly.pairs} K=${value.assembly.neighbors}`
    + ` delivered=${value.assembly.delivered} dropped=${value.assembly.dropped}`
    + ` chars=${value.assembly.chars}/${value.assembly.charLimit}`,
  );
});

test('budget drop: assembly.dropped and per-row skippedByBudget agree with the delivered rows', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-recall-budget-'));
  const QUERY = '月光';
  // 600 characters each: the recall display budget (600) fits row 1 (400) + row 2 (200) and no row 3.
  const BODY = `${QUERY}${'长'.repeat(600 - QUERY.length)}`;
  seed(root, [1, 2, 3].map((index) => ({
    role: 'user',
    sessionId: 'budget',
    turnId: index,
    messageId: `budget-${index}`,
    text: BODY,
    clarity: 'fuzzy',
    importance: 60,
  })));

  const { tools, disposers } = mount(root);
  t.after(() => cleanupRoot(root, disposers));
  const tool = tools.get('assistant_recall');
  const value = await tool.execute({ query: QUERY }, {});
  validate(tool.output.schema, value);

  assert.equal(value.hits.length, 3, 'all three candidates stay visible');
  const skipped = value.hits.filter((hit) => hit.skippedByBudget === true);
  const delivered = value.hits.filter((hit) => hit.skippedByBudget !== true);
  assert.equal(skipped.length, 1, 'the character budget could not fit one body');
  assert.equal(delivered.length, 2);
  assert.equal(skipped[0].delivered, false, 'a skipped row is not delivered');
  assert.equal(skipped[0].text, '', 'a skipped row carries no body');

  // The top-level counters are the same facts: `dropped` is the total (here only the char-budget
  // drop), `skippedByBudget` is its character-budget part, and `delivered` is the rest.
  assert.equal(value.assembly.skippedByBudget, skipped.length);
  assert.equal(value.assembly.dropped, skipped.length, 'the only drop reason here is the budget');
  assert.equal(value.assembly.delivered, delivered.length);
  assert.equal(value.assembly.delivered, value.hits.filter((hit) => hit.delivered === true).length);
  assert.ok(value.assembly.chars <= value.assembly.charLimit, `chars ${value.assembly.chars} fits ${value.assembly.charLimit}`);

  console.log(
    `[budget] rows=${value.hits.length} delivered=${value.assembly.delivered}`
    + ` skippedByBudget=${value.assembly.skippedByBudget} dropped=${value.assembly.dropped}`
    + ` chars=${value.assembly.chars}/${value.assembly.charLimit}`,
  );
});

test('legacy rows without kind/group still project (defaults, no schema error)', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-recall-legacy-'));
  seed(root, [{
    role: 'user', sessionId: 'legacy', turnId: 1, messageId: 'legacy-1',
    text: '旧的樱花记录没有任何装配字段。',
  }]);

  const { tools, disposers } = mount(root);
  t.after(() => cleanupRoot(root, disposers));
  const tool = tools.get('assistant_recall');

  // Simulate a pre-D2 recall: rows have no `kind` / `group` and the assembly predates
  // `dropped` / `rowLimit` / `charLimit`. The projection must not throw and must not emit a
  // value that contradicts its own declared schema.
  const original = MemoryStore.prototype.recall;
  MemoryStore.prototype.recall = function legacyRecall(options) {
    const result = original.call(this, options);
    return {
      ...result,
      hits: result.hits.map(({ kind, group, ...row }) => row),
      assembly: {
        hits: result.assembly.hits,
        links: result.assembly.links,
        pairs: result.assembly.pairs,
        neighbors: result.assembly.neighbors,
        upcoming: result.assembly.upcoming,
        delivered: result.assembly.delivered,
        skippedByBudget: result.assembly.skippedByBudget,
        chars: result.assembly.chars,
        limit: result.assembly.limit,
      },
    };
  };
  t.after(() => {
    MemoryStore.prototype.recall = original;
  });

  const value = await tool.execute({ query: '樱花', limit: 10 }, {});
  validate(tool.output.schema, value);

  assert.equal(value.hits.length, 1, 'the legacy row is still readable');
  assert.equal(value.hits[0].kind, 'hit', 'a missing kind defaults to hit');
  assert.equal(Object.hasOwn(value.hits[0], 'group'), false, 'a missing group stays omitted');
  assert.equal(value.hits[0].text, '旧的樱花记录没有任何装配字段。', 'the body is untouched');
  assert.equal(value.assembly.dropped, 0, 'a missing dropped count projects as 0');
  assert.equal(value.assembly.rowLimit, 0, 'a missing rowLimit projects as 0');
  assert.equal(value.assembly.charLimit, value.assembly.limit, 'the legacy limit fills charLimit');

  const text = tool.output.render({}, value).map((block) => block.text).join('\n');
  assert.ok(text.includes('[命中]'), `a kind-less row still renders as a hit\n${text}`);

  console.log(
    `[legacy] rows=${value.hits.length} kind=${value.hits[0].kind} group=${JSON.stringify(value.hits[0].group ?? null)}`
    + ` assembly=${JSON.stringify(value.assembly)}`,
  );
});

test('render marks pair/neighbour as context without touching body, id or order', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-recall-render-'));
  const now = Date.now();
  const at = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString();
  seed(root, [
    {
      role: 'user', sessionId: 'render', turnId: 1, messageId: 'render-hit',
      ts: at(50), text: '长颈鹿今天吃掉了两筐树叶。',
    },
    {
      role: 'user', sessionId: 'render', turnId: 1, messageId: 'render-pair',
      ts: at(49), text: '后来它在树荫下面睡着了。',
    },
    {
      role: 'user', sessionId: 'render', turnId: 2, messageId: 'render-neighbor',
      ts: at(40), text: '栏舍外面那棵树该修剪了。',
    },
  ]);

  const { tools, disposers } = mount(root);
  t.after(() => cleanupRoot(root, disposers));
  const tool = tools.get('assistant_recall');
  const value = await tool.execute({ query: '长颈鹿', limit: 10 }, {});
  validate(tool.output.schema, value);

  const blocks = tool.output.render({}, value);
  assert.equal(blocks.length, 1, 'one text block');
  const lines = blocks[0].text.split('\n');
  assert.equal(lines.length, value.hits.length + 2, 'header + summary + one line per row');
  const rowLines = lines.slice(2);

  // Order is the projection order, and every id/body is carried verbatim.
  assert.deepEqual(idsInRenderOrder(rowLines), value.hits.map((hit) => hit.id), 'order unchanged');
  value.hits.forEach((hit, index) => {
    assert.ok(rowLines[index].includes(`id ${hit.id}`), `row ${index} keeps its id`);
    if (hit.delivered && hit.text.length > 0) {
      assert.ok(rowLines[index].includes(hit.text), `row ${index} keeps its body verbatim`);
    }
  });

  // Pair and neighbour lines say "context"; the direct hit does not.
  const lineOf = (kind) => rowLines[value.hits.findIndex((hit) => hit.kind === kind)];
  assert.ok(lineOf('pair').startsWith('- [同轮·上下文]'), `pair is context: ${lineOf('pair')}`);
  assert.ok(lineOf('neighbor').startsWith('- [邻轮·上下文]'), `neighbour is context: ${lineOf('neighbor')}`);
  assert.ok(lineOf('hit').startsWith('- [命中]'), `direct hit is not context: ${lineOf('hit')}`);
  assert.equal(lineOf('hit').includes('上下文'), false, 'a direct hit is never labelled context');

  // The summary line is what lets the model tell N / M / K apart even though it only sees render.
  assert.ok(
    lines[1].startsWith(`命中 ${value.assembly.hits} · 同轮 ${value.assembly.pairs}`
      + ` · 邻轮 ${value.assembly.neighbors}`),
    `summary names direct / pair / neighbour\n${lines[1]}`,
  );

  console.log(
    `[render] rows=${value.hits.length} order=${idsInRenderOrder(rowLines).length}`
    + ` pair="${lineOf('pair').slice(0, 16)}" neighbor="${lineOf('neighbor').slice(0, 16)}"`
    + ` summary="${lines[1]}"`,
  );
});
