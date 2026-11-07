/**
 * Tool-content regression: `assistant_persona_view`, `assistant_recall` and
 * `assistant_memory_brief` returned only "N chars" / "Found N of M records" to the model.
 * The bodies existed in `value`, but DSH feeds the model only `output.render(...)` — the raw
 * value never reaches the prompt — so the profiles and memories were invisible.
 *
 * This mounts the plugin against a fake context, calls the three tools, and asserts the
 * rendered text (the exact string the Harness shows the model) contains the stored bodies,
 * not just counts. It also validates every returned value against the tool's own output
 * schema, so a returned-but-undeclared field fails here (the `lastShot` class of bug).
 *
 * Run: node --test test/tool-content.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { apply } from '../src/host/index.js';
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

/** Validate one value against the tool-output schema subset (type/oneOf/object/array/enum/const). */
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
  if (Object.hasOwn(schema, 'const')) assert.equal(value, schema.const, `${path} must equal const`);
  if (schema.type === 'object') {
    assert.ok(value !== null && typeof value === 'object', `${path} must be an object`);
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

/** Every top-level key must be declared by the schema, whatever its additionalProperties says. */
function assertDeclared(schema, value, path = 'value') {
  for (const key of Object.keys(value)) {
    assert.ok(Object.hasOwn(schema.properties ?? {}, key), `"${path}.${key}" is not a declared property`);
  }
}

/** Mount the plugin once against the minimal fake context and expose its tool map. */
async function mount(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tool-content-'));
  // The fake context behaves like a real scope: every effect's disposer is kept and run on
  // teardown, so the SQLite stores are closed before the temp root is removed.
  const disposers = [];
  t.after(() => cleanupRoot(root, disposers));

  const tools = new Map();
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
  };
  apply(ctx, { root, defaultDomain: 'chat', enabled: true });
  return { tools, root };
}

async function call(tools, name, args = {}) {
  const tool = tools.get(name);
  assert.ok(tool !== undefined, `${name} is registered`);
  return { tool, value: await tool.execute(args, {}) };
}

/** The exact text the Harness shows the model for one result. */
function rendered(tool, args, value) {
  return tool.output.render(args, value).map((block) => block.text).join('\n');
}

test('assistant_persona_view renders both profile bodies, not just a length', async (t) => {
  const { tools } = await mount(t);
  await call(tools, 'assistant_persona_append', { which: 'agent', text: '你是小满，说话简短。' });
  await call(tools, 'assistant_persona_append', {
    which: 'user',
    text: '用户的助手项目代码放在 D:\\Projects\\dsh-assistant。',
  });

  const args = { which: 'both' };
  const { tool, value } = await call(tools, 'assistant_persona_view', args);
  const schema = tool.output.schema;

  assert.ok(Object.hasOwn(schema.properties, 'agentPersona'), 'the schema declares agentPersona');
  assert.ok(Object.hasOwn(schema.properties, 'userProfile'), 'the schema declares userProfile');
  validate(schema, value);
  assertDeclared(schema, value);

  assert.ok(value.agentPersona.includes('小满'), 'the agent persona field holds the full body');
  assert.ok(value.userProfile.includes('dsh-assistant'), 'the user profile field holds the full body');
  assert.ok(value.text.includes('小满') && value.text.includes('dsh-assistant'), 'text still carries both');

  const text = rendered(tool, args, value);
  assert.ok(text.includes('你是小满，说话简短。'), 'the rendered text carries the persona body');
  assert.ok(text.includes('D:\\Projects\\dsh-assistant'), 'the rendered text carries the profile body');
  assert.notEqual(text.trim(), `${value.chars} chars`, 'a length-only answer is not enough');
});

test('assistant_recall renders each hit body, not just "Found N of M"', async (t) => {
  const { tools } = await mount(t);
  await call(tools, 'assistant_remember', {
    text: '用户的助手项目代码放在 D:\\Projects\\dsh-assistant，项目叫小满助手',
    domain: 'work',
    kind: 'fact',
  });
  await call(tools, 'assistant_remember', { text: '小满喜欢在深夜写代码', domain: 'chat', kind: 'preference' });

  const args = { query: '小满' };
  const { tool, value } = await call(tools, 'assistant_recall', args);
  const schema = tool.output.schema;

  const hitProperties = schema.properties.hits.items.properties;
  for (const field of ['text', 'domain', 'importance', 'clarity', 'ts']) {
    assert.ok(Object.hasOwn(hitProperties, field), `the hit schema declares ${field}`);
  }
  validate(schema, value);
  assertDeclared(schema, value);

  assert.ok(value.hits.length >= 1, 'the query matches at least the work record');
  const work = value.hits.find((hit) => hit.domain === 'work');
  assert.ok(work !== undefined, 'the work record is recalled');
  for (const field of ['text', 'domain', 'importance', 'clarity', 'ts']) {
    assert.ok(Object.hasOwn(work, field), `the hit value carries ${field}`);
  }
  assert.equal(typeof work.clarity, 'string');

  const text = rendered(tool, args, value);
  assert.ok(
    text.startsWith(`Found ${value.hits.length} of ${value.scanned} records`),
    'the count line survives',
  );
  assert.ok(text.includes('dsh-assistant'), 'the rendered text carries the recalled memory body');
  assert.ok(text.includes('[work]'), 'each record keeps its domain tag');
  assert.ok(text.includes('- [命中]'), 'each record leads with its D2 kind prefix');
  assert.ok(text.includes('clarity'), 'clarity is visible beside the body');
});

test('assistant_memory_brief renders the composed block, not just the counts', async (t) => {
  const { tools } = await mount(t);
  await call(tools, 'assistant_remember', {
    text: '用户的助手项目代码放在 D:\\Projects\\dsh-assistant，项目叫小满助手',
    domain: 'work',
    kind: 'fact',
  });
  await call(tools, 'assistant_remember', {
    text: '第一次答应你：以后每周陪小满看一部电影，我喜欢这种约定，谢谢你',
    domain: 'chat',
    kind: 'preference',
  });

  const args = { query: '小满' };
  const { tool, value } = await call(tools, 'assistant_memory_brief', args);
  const schema = tool.output.schema;

  for (const listName of ['fixedRecords', 'matchedRecords']) {
    assert.ok(Object.hasOwn(schema.properties, listName), `the schema declares ${listName}`);
    const fields = Object.keys(schema.properties[listName].items.properties);
    for (const field of ['text', 'domain', 'importance', 'clarity', 'ts']) {
      assert.ok(fields.includes(field), `${listName} declares ${field}`);
    }
  }
  validate(schema, value);
  assertDeclared(schema, value);

  assert.ok(value.fixed >= 1, 'the landmark record lands in the fixed layer');
  assert.ok(value.matched >= 1, 'the work record is matched');
  for (const list of [value.fixedRecords, value.matchedRecords]) {
    assert.ok(Array.isArray(list));
    for (const record of list) {
      for (const field of ['text', 'domain', 'importance', 'clarity', 'ts']) {
        assert.ok(Object.hasOwn(record, field), `a brief record carries ${field}`);
      }
    }
  }
  assert.ok(value.fixedRecords.some((record) => record.text.includes('小满')), 'the fixed layer keeps its body');
  assert.ok(
    value.matchedRecords.some((record) => record.text.includes('dsh-assistant')),
    'the matched layer keeps its body',
  );

  const text = rendered(tool, args, value);
  assert.ok(text.includes('dsh-assistant'), 'the rendered text carries the matched memory body');
  assert.ok(text.includes('小满'), 'the rendered text carries the fixed memory body');
  assert.ok(text.includes(value.text), 'the composed block is included verbatim');
});
