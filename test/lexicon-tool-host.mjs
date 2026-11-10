/**
 * Lexicon assistant tool — host registration and authorization boundary.
 *
 * The tool is registered by the real `apply()` as `assistant_lexicon`, separate from the memory
 * tools. Behind it is the existing pure core (`runLexiconTool`) over the host's real file-backed
 * lexicon store, so this suite pins the acceptance items:
 *
 *   1. the tool is registered, has the five actions, and is not a memory tool;
 *   2. query/propose default to `assistant-discovered` (query reads, propose writes a candidate
 *      only) and an assistant-discovered proposal never becomes a confirmed word;
 *   3. add/update/remove WITHOUT `explicit:true` return `needs-user-confirmation` and change
 *      nothing — the model cannot silently edit a confirmed entry;
 *   4. add/update/remove with `explicit:true` reach the store and return a safe view with id/status;
 *   5. every returned entry view uses only the documented safe fields, and the tool never returns
 *      internal store fields (wrongForms / sourceIds / context / speakerId / audio paths …).
 *
 * Run: node --test test/lexicon-tool-host.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { apply } from '../src/host/index.js';
import { LEXICON_TOOL_SAFE_FIELDS } from '../src/host/speech/lexicon-tool.js';
import { cleanupRoot } from './helpers/cleanup.mjs';

const SAFE = new Set(LEXICON_TOOL_SAFE_FIELDS);

/** Mount the real plugin against a fake context, exactly as the host does. */
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

async function withTool(t, run) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lexicon-tool-host-'));
  const { tools, disposers } = mount(root);
  t.after(async () => cleanupRoot(root, disposers));
  const tool = tools.get('assistant_lexicon');
  assert.ok(tool !== undefined, 'assistant_lexicon is registered');
  return run({ tool, tools });
}

function assertSafeView(view, label = 'entry') {
  assert.ok(view !== null && typeof view === 'object' && !Array.isArray(view), `${label} is an object`);
  for (const key of Object.keys(view)) {
    assert.equal(SAFE.has(key), true, `${label} leaked unsafe field: ${key}`);
  }
  assert.equal(typeof view.id, 'string', `${label}.id is a string`);
  assert.equal(typeof view.status, 'string', `${label}.status is a string`);
  // The pure core only includes a version when the store actually carries one.
  if (Object.hasOwn(view, 'version')) {
    assert.ok(typeof view.version === 'number' || typeof view.version === 'string', `${label}.version is number|string`);
  }
}

function returnedViews(value) {
  const views = [];
  if (value.entry !== undefined && value.entry !== null) views.push(value.entry);
  for (const candidate of value.candidates ?? []) views.push(candidate);
  if (value.revision !== undefined && value.revision !== null) views.push(value.revision);
  return views;
}

test('assistant_lexicon is a separate registered tool with the five actions', async (t) => {
  await withTool(t, ({ tool, tools }) => {
    assert.equal(tools.has('assistant_recall'), true, 'memory tools stay separate');
    assert.equal(tools.has('assistant_remember'), true, 'memory tools stay separate');
    assert.deepEqual(tool.parameters.properties.action.enum, ['query', 'propose', 'add', 'update', 'remove']);
    assert.equal(tool.parameters.properties.explicit.type, 'boolean');
    assert.match(tool.description, /explicit:true/u);
    assert.match(tool.description, /propose/u);
    assert.match(tool.description, /needs-user-confirmation/u);
    assert.equal(tool.parameters.additionalProperties, false);
  });
});

test('query and propose default to assistant-discovered; a proposal is only a candidate', async (t) => {
  await withTool(t, async ({ tool }) => {
    const empty = await tool.execute({ action: 'query', query: '向晚' });
    assert.equal(empty.ok, true, 'query on an empty lexicon is a normal empty result');
    assert.deepEqual(empty.candidates, [], 'nothing matches yet');

    // No explicit flag: the assistant-discovered lane may propose, never confirm.
    const proposed = await tool.execute({
      action: 'propose',
      text: '向晚',
      category: 'person',
      usage: '候选人，不是确认词条',
    });
    assert.equal(proposed.ok, true, `propose succeeds: ${proposed.reason ?? ''}`);
    assert.ok(Array.isArray(proposed.candidates) && proposed.candidates.length === 1, 'the candidate is returned');
    assert.equal(proposed.candidates[0].status, 'candidate', 'propose never confirms');
    assert.equal(proposed.candidates[0].category, 'unknown', 'propose does not silently confirm meaning fields');
    for (const view of returnedViews(proposed)) assertSafeView(view, 'proposed');

    const queried = await tool.execute({ action: 'query', text: '向晚' });
    assert.equal(queried.ok, true);
    assert.equal(queried.entry.status, 'candidate', 'the word is still pending after propose');
    assert.equal(queried.candidates.length, 1);
    for (const view of returnedViews(queried)) assertSafeView(view, 'queried');
  });
});

test('add/update/remove without explicit:true are refused and change nothing', async (t) => {
  await withTool(t, async ({ tool }) => {
    const add = await tool.execute({ action: 'add', text: '星野', category: 'person' });
    assert.deepEqual(
      { ok: add.ok, action: add.action, reason: add.reason },
      { ok: false, action: 'add', reason: 'needs-user-confirmation' },
    );
    const afterAdd = await tool.execute({ action: 'query', text: '星野' });
    assert.deepEqual(afterAdd.candidates, [], 'a refused add writes no word');

    const created = await tool.execute({ action: 'add', text: '长崎', category: 'person', explicit: true });
    assert.equal(created.ok, true, `explicit add succeeds: ${created.reason ?? ''}`);
    assertSafeView(created.entry, 'created');
    assert.equal(created.entry.status, 'confirmed', 'an explicit user add is confirmed');
    const id = created.entry.id;

    const update = await tool.execute({ action: 'update', id, usage: '改为别的用法' });
    assert.deepEqual(
      { ok: update.ok, action: update.action, reason: update.reason },
      { ok: false, action: 'update', reason: 'needs-user-confirmation' },
    );
    const unchanged = await tool.execute({ action: 'query', id });
    assert.equal(unchanged.entry.usage, '', 'a refused update leaves the entry untouched');

    const remove = await tool.execute({ action: 'remove', id });
    assert.deepEqual(
      { ok: remove.ok, action: remove.action, reason: remove.reason },
      { ok: false, action: 'remove', reason: 'needs-user-confirmation' },
    );
    const stillThere = await tool.execute({ action: 'query', id });
    assert.equal(stillThere.ok, true, 'a refused remove leaves the entry in place');
    assert.equal(stillThere.entry.id, id);
  });
});

test('explicit:true reaches the store for update and remove, and the view stays safe', async (t) => {
  await withTool(t, async ({ tool }) => {
    const created = await tool.execute({
      action: 'add',
      text: '星野',
      category: 'person',
      usage: '旧用法',
      explicit: true,
    });
    assert.equal(created.ok, true, `explicit add: ${created.reason ?? ''}`);
    assertSafeView(created.entry, 'created');
    assert.equal(created.entry.status, 'confirmed');
    const id = created.entry.id;

    const updated = await tool.execute({
      action: 'update',
      id,
      usage: '新用法',
      canonical: '星野酱',
      explicit: true,
    });
    assert.equal(updated.ok, true, `explicit update: ${updated.reason ?? ''}`);
    assertSafeView(updated.entry, 'updated');
    assert.equal(updated.entry.id, id, 'the id is stable');
    assert.equal(updated.entry.canonical, '星野酱');
    assert.equal(updated.entry.usage, '新用法');
    assert.equal(updated.entry.status, 'confirmed');

    const removed = await tool.execute({ action: 'remove', id, explicit: true });
    assert.equal(removed.ok, true, `explicit remove: ${removed.reason ?? ''}`);
    assertSafeView(removed.entry, 'removed');
    assert.equal(removed.entry.id, id);

    const gone = await tool.execute({ action: 'query', id });
    assert.equal(gone.ok, false);
    assert.equal(gone.reason, 'not-found');
  });
});
