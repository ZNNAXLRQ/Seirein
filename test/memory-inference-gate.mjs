/**
 * P-127 inference gate: an unverified derived statement must not become a confirmed fact.
 *
 * The gate is deliberately narrow:
 *   - the automatic recorder still stores the real user/assistant wording, role and source;
 *   - `assistant_remember` / `assistant_memory_correct` write a marked statement without an
 *     evidence string/ID as `kind:'hypothesis'` + `unresolved:1` (so every existing recall path
 *     keeps showing its `[待核验]` marker);
 *   - a statement with evidence keeps its normal kind and records the evidence id;
 *   - an explicit `inference:true` forces the hypothesis path, while `inference:false` is NOT a
 *     bypass: the deterministic marker check still runs;
 *   - an inference is excluded from the fixed/landmark layer and from promotion, but it remains
 *     readable through recall as reference material.
 *
 * Run: node --test test/memory-inference-gate.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { apply, createAutoMemoryRecorder } from '../src/host/index.js';
import { MemoryStore } from '../src/host/memory/store.js';
import { cleanupRoot } from './helpers/cleanup.mjs';

async function tempRoot() {
  return mkdtemp(join(tmpdir(), 'dsh-mem-inference-'));
}

/** Mount the real plugin against the minimal fake context used by the other memory tests. */
function mount(root) {
  const tools = new Map();
  const disposers = [];
  const effect = (fn) => {
    const dispose = fn();
    if (typeof dispose === 'function') disposers.push(dispose);
    return dispose;
  };
  const ctx = {
    effect,
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    inject: (_deps, register) => {
      register({
        effect,
        systemPrompt: { section: () => () => {} },
        webServer: {
          register() {
            return () => {};
          },
        },
      });
    },
  };
  apply(ctx, { root, defaultDomain: 'chat', enabled: true });
  const call = async (name, args = {}, exec = {}) => {
    const tool = tools.get(name);
    assert.ok(tool !== undefined, `tool registered: ${name}`);
    return tool.execute(args, exec);
  };
  return {
    tools,
    call,
    render: (name, args, value) => tools.get(name).output.render(args, value)
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n'),
    close: () => cleanupRoot(root, disposers),
  };
}

/** Read one row through a second connection so the test sees exactly what the tool stored. */
function readRow(root, id) {
  const store = new MemoryStore(root, { capacity: 2000 });
  try {
    store.open();
    return store.db
      .prepare(`SELECT id, domain, kind, text, source, role, message_id, unresolved, evidence,
          version FROM memory_event WHERE id = ?`)
      .get(id);
  } finally {
    store.close();
  }
}

function rowCount(root) {
  const store = new MemoryStore(root, { capacity: 2000 });
  try {
    store.open();
    return store.db.prepare('SELECT COUNT(*) AS c FROM memory_event').get().c;
  } finally {
    store.close();
  }
}

function userEvent(id, text, time) {
  return {
    type: 'user/message',
    time,
    data: { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
  };
}

function assistantEvent(id, text, time, turn) {
  return {
    type: 'assistant/message',
    time,
    data: {
      turn,
      message: { id, role: 'assistant', content: [{ type: 'text', text }] },
    },
  };
}

/**
 * Minimal strict JSON-Schema checker for exactly the keywords these tool definitions use:
 * type/object/array/string/boolean/integer/number/null, properties, required,
 * additionalProperties:false, items, enum, oneOf, minimum and maximum. It exists so the test can
 * prove the REGISTERED definitions accept the new fields instead of merely trusting the source.
 */
function schemaTypeMatches(schema, value) {
  switch (schema?.type) {
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'integer':
      return Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'null':
      return value === null;
    default:
      return true;
  }
}

function assertSchema(schema, value, path = '$') {
  if (Array.isArray(schema?.oneOf)) {
    const branch = schema.oneOf.find((candidate) => schemaTypeMatches(candidate, value));
    assert.ok(branch !== undefined, `${path}: no oneOf branch accepts ${JSON.stringify(value)}`);
    assertSchema(branch, value, path);
    return;
  }
  assert.ok(
    schemaTypeMatches(schema, value),
    `${path}: ${JSON.stringify(value)} is not ${schema?.type ?? 'the declared type'}`,
  );
  if (Array.isArray(schema.enum)) {
    assert.ok(schema.enum.includes(value), `${path}: ${JSON.stringify(value)} is not in the enum`);
  }
  if (schema?.type === 'object') {
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      assert.ok(Object.prototype.hasOwnProperty.call(value, key), `${path}.${key}: required field is missing`);
    }
    const properties = schema.properties ?? {};
    for (const [key, child] of Object.entries(value)) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) {
        assert.notEqual(
          schema.additionalProperties,
          false,
          `${path}.${key}: undeclared field rejected by additionalProperties:false`,
        );
        continue;
      }
      assertSchema(properties[key], child, `${path}.${key}`);
    }
  }
  if (schema?.type === 'array' && schema.items !== undefined) {
    value.forEach((item, index) => assertSchema(schema.items, item, `${path}[${index}]`));
  }
  if (schema?.minimum !== undefined) assert.ok(value >= schema.minimum, `${path}: below minimum`);
  if (schema?.maximum !== undefined) assert.ok(value <= schema.maximum, `${path}: above maximum`);
}

test('1) raw user/assistant conversation is still stored verbatim with role and source', async (t) => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 2000 });
  t.after(async () => {
    memory.close();
    await cleanupRoot(root);
  });

  const recorder = createAutoMemoryRecorder({
    memory,
    settings: { enabled: true, minChars: 1, maxChars: 400, includeReply: true },
    timeZone: 'Asia/Shanghai',
  });
  const session = { id: 'raw-session' };
  const at = Date.now();
  const userText = '因为下雨，所以不出门';
  const assistantText = '看来是路面湿滑导致的';
  await recorder.handle(session, { type: 'turn/start', time: at, data: { turn: 7 } });
  await recorder.handle(session, userEvent('raw-user-1', userText, at));
  await recorder.handle(session, assistantEvent('raw-assistant-1', assistantText, at, 7));
  await recorder.handle(session, {
    type: 'turn/end',
    time: at,
    data: { turn: 7, reason: { kind: 'completed' } },
  });

  const rows = memory.db
    .prepare(`SELECT role, source, kind, text, unresolved, message_id FROM memory_event
      WHERE role IS NOT NULL ORDER BY rowid ASC`)
    .all();
  assert.equal(rows.length, 2, 'both sides of the turn were recorded');
  const user = rows.find((row) => row.role === 'user');
  const assistant = rows.find((row) => row.role === 'assistant');
  assert.ok(user !== undefined, 'the user message exists');
  assert.ok(assistant !== undefined, 'the assistant reply exists');
  for (const row of [user, assistant]) {
    assert.equal(row.source, 'auto', 'the automatic recorder remains the source');
    assert.equal(row.kind, 'event', 'a real message is a conversation event, not a hypothesis');
    assert.equal(row.unresolved, 0, 'inference markers in quoted speech do not taint the message');
  }
  assert.equal(user.text, userText, 'the user wording is unchanged');
  assert.equal(assistant.text, assistantText, 'the assistant wording is unchanged');
  assert.equal(user.message_id, 'raw-user-1');
  assert.equal(assistant.message_id, 'raw-assistant-1');
});

test('2) remember with a causal marker and no evidence -> hypothesis/unresolved, not fixed', async (t) => {
  const root = await tempRoot();
  const app = mount(root);
  t.after(() => app.close());

  const text = '因为用户之前切换过 OBS 场景，所以现在看到的是浏览器';
  const value = await app.call('assistant_remember', {
    text,
    kind: 'fact',
    importance: 90,
  });
  assert.equal(value.inference, true, 'the tool reports the unverified inference');
  assert.equal(value.kind, 'hypothesis', 'the stored kind is hypothesis');

  const row = readRow(root, value.id);
  assert.equal(row.kind, 'hypothesis');
  assert.equal(row.unresolved, 1, 'the existing unresolved state is what marks it');
  assert.equal(row.evidence, null, 'no evidence was supplied');
  assert.equal(row.source, 'manual');
  assert.equal(rowCount(root), 1);

  // Fixed/landmark layer: importance 90 would normally qualify, but a hypothesis never does.
  const brief = await app.call('assistant_memory_brief', { query: 'OBS' });
  assert.equal(
    brief.fixedRecords.some((record) => record.text.includes('OBS 场景')),
    false,
    'an inference is not a landmark/fixed record',
  );

  // Recall is still allowed, but it must carry the existing unverified marker.
  const recall = await app.call('assistant_recall', { query: 'OBS 场景' });
  const hit = recall.hits.find((entry) => entry.text.includes('OBS 场景'));
  assert.ok(hit !== undefined, 'the inference is still readable as reference');
  assert.equal(hit.unresolved, 1);
  assert.ok(hit.text.startsWith('[待核验]'), 'recall shows the unverified marker');

  // Fixed-vault and persona/profile constraints are separate stores and must stay untouched.
  const fixedVault = await app.call('assistant_resource_list', {});
  assert.equal(fixedVault.count, 0, 'assistant_remember did not write the fixed-memory vault');
  const persona = await app.call('assistant_persona_view', { which: 'both' });
  assert.equal(persona.text.includes('OBS'), false, 'the inference did not enter persona/profile text');
});

test('3) remember with verified evidence keeps the normal kind and records the evidence ref', async (t) => {
  const root = await tempRoot();
  const app = mount(root);
  t.after(() => app.close());

  // A reference must name a REAL source. Seed one recorded user message in the same domain and
  // cite it with a verbatim quote; a made-up id no longer counts as evidence.
  const seed = new MemoryStore(root, { capacity: 2000 });
  seed.open();
  try {
    const recorded = seed.addMessage({
      role: 'user',
      sessionId: 'inference-gate',
      messageId: 'obs-user-1',
      text: '我昨天把 OBS 场景切换到了浏览器',
      domain: 'chat',
    });
    assert.ok(recorded.record !== null, 'the evidence source message was recorded');
  } finally {
    seed.close();
  }

  const text = '因为用户之前切换过 OBS 场景，所以现在看到的是浏览器';
  const evidence = 'msg:obs-user-1#OBS 场景';
  const value = await app.call('assistant_remember', {
    text,
    kind: 'fact',
    importance: 70,
    evidence,
  });
  assert.equal(value.inference, false, 'a verified reference lifts the inference');
  assert.equal(value.kind, 'fact');
  assert.equal(value.evidenceVerified, true, 'the tool reports the verification result');
  assert.deepEqual(value.evidenceErrors, []);

  const row = readRow(root, value.id);
  assert.equal(row.kind, 'fact');
  assert.equal(row.unresolved, 0);
  assert.equal(row.evidence, evidence, 'the verified reference travels with the record');

  const recall = await app.call('assistant_recall', { query: 'OBS 场景' });
  const hit = recall.hits.find((entry) => entry.text.includes('OBS 场景'));
  assert.ok(hit !== undefined);
  assert.equal(hit.unresolved, 0);
  assert.equal(hit.text.startsWith('[待核验]'), false);
});

test('4) explicit inference:true forces hypothesis; explicit false does not bypass the marker check', async (t) => {
  const root = await tempRoot();
  const app = mount(root);
  t.after(() => app.close());

  const explicitTrue = await app.call('assistant_remember', {
    text: '用户喜欢在雨天散步',
    kind: 'preference',
    inference: true,
  });
  assert.equal(explicitTrue.inference, true);
  assert.equal(explicitTrue.kind, 'hypothesis', 'explicit inference wins without a marker');
  assert.equal(readRow(root, explicitTrue.id).unresolved, 1);

  const plain = await app.call('assistant_remember', {
    text: '用户住在杭州',
    kind: 'fact',
    inference: false,
  });
  assert.equal(plain.inference, false);
  assert.equal(plain.kind, 'fact', 'a plain statement keeps its normal kind');

  const markerDespiteFalse = await app.call('assistant_remember', {
    text: '用户没来，所以大概是忘了',
    kind: 'fact',
    inference: false,
  });
  assert.equal(markerDespiteFalse.inference, true, 'inference:false is not a bypass');
  assert.equal(markerDespiteFalse.kind, 'hypothesis');
});

test('5) a normal memory_correct replacement is unchanged (kind/unresolved untouched)', async (t) => {
  const root = await tempRoot();
  const app = mount(root);
  t.after(() => app.close());

  const target = await app.call('assistant_remember', {
    text: '原定下午三点开会',
    kind: 'fact',
    importance: 60,
  });
  const corrected = await app.call('assistant_memory_correct', {
    targetId: target.id,
    expectedVersion: 1,
    expectedText: '下午三点',
    replacement: '下午四点',
  });
  assert.equal(corrected.ok, true);
  assert.equal(corrected.version, 2);
  const row = readRow(root, target.id);
  assert.equal(row.kind, 'fact');
  assert.equal(row.unresolved, 0);
  assert.equal(row.version, 2);
  assert.ok(row.text.includes('下午四点'));
});

test('6) a speculative memory_correct replacement/extraText becomes unresolved', async (t) => {
  const root = await tempRoot();
  const app = mount(root);
  t.after(() => app.close());

  const target = await app.call('assistant_remember', {
    text: '用户没来',
    kind: 'fact',
    importance: 60,
  });
  const corrected = await app.call('assistant_memory_correct', {
    targetId: target.id,
    expectedVersion: 1,
    expectedText: '用户没来',
    replacement: '用户没来，所以大概是忘了',
    extraText: '另外看来他临时有事',
  });
  assert.equal(corrected.ok, true);
  const row = readRow(root, target.id);
  assert.equal(row.kind, 'hypothesis', 'a derived target cannot stay a confirmed fact');
  assert.equal(row.unresolved, 1);
  assert.equal(row.evidence, null);

  const extra = readRow(root, corrected.extraId);
  assert.equal(extra.kind, 'hypothesis', 'the same-sentence extra content is gated too');
  assert.equal(extra.unresolved, 1);
});

test('7) registered schemas accept inference/evidence; a strict remember path returns inference/kind and warns', async (t) => {
  const root = await tempRoot();
  const app = mount(root);
  t.after(() => app.close());

  const remember = app.tools.get('assistant_remember');
  assert.ok(remember !== undefined, 'the real host registered assistant_remember');
  assert.equal(remember.parameters.additionalProperties, false, 'input schema is closed');
  assert.equal(remember.parameters.properties.inference?.type, 'boolean', 'input: optional inference boolean');
  assert.equal(remember.parameters.properties.evidence?.type, 'string', 'input: optional evidence string');
  assert.equal(remember.parameters.required.includes('inference'), false, 'inference is optional');
  assert.equal(remember.parameters.required.includes('evidence'), false, 'evidence is optional');

  const output = remember.output.schema;
  assert.equal(output.additionalProperties, false, 'output schema is closed');
  assert.equal(output.properties.inference?.type, 'boolean', 'output: inference boolean');
  assert.equal(output.properties.kind?.type, 'string', 'output: kind string');
  assert.ok(output.required.includes('inference'), 'every successful remember reports inference');
  assert.ok(output.required.includes('kind'), 'every successful remember reports kind');

  const correct = app.tools.get('assistant_memory_correct');
  assert.ok(correct !== undefined, 'the real host registered assistant_memory_correct');
  assert.equal(correct.parameters.additionalProperties, false, 'correct input schema is closed');
  assert.equal(correct.parameters.properties.inference?.type, 'boolean', 'correct input: inference boolean');
  assert.equal(correct.parameters.properties.evidence?.type, 'string', 'correct input: evidence string');
  assert.equal(correct.parameters.required.includes('inference'), false, 'correct inference is optional');
  assert.equal(correct.parameters.required.includes('evidence'), false, 'correct evidence is optional');
  assert.equal(correct.output.schema.additionalProperties, false, 'correct output schema stays closed');

  // Strict schema path: validate the exact arguments against the registered input schema, execute,
  // then validate the exact returned value against the registered output schema.
  const args = {
    text: '用户大概喜欢爵士乐',
    kind: 'preference',
    importance: 70,
    inference: true,
  };
  assertSchema(remember.parameters, args);
  const value = await app.call('assistant_remember', args);
  assert.equal(value.inference, true, 'the stored row is an unverified inference');
  assert.equal(value.kind, 'hypothesis');
  assertSchema(output, value);

  const rendered = app.render('assistant_remember', args, value);
  assert.ok(rendered.includes('已标记为未证实推断'), 'render carries the inference warning');
  assert.ok(rendered.includes('待核验'), 'render names the recall marker');
  assert.ok(rendered.includes('不作为已确认事实'), 'render refuses to present it as confirmed');
  assert.equal(rendered.includes(args.text), false, 'the warning must not repeat the memory body');

  // No inference: the same strict path is accepted and the warning is absent.
  const plainArgs = { text: '用户住在杭州', kind: 'fact', importance: 70 };
  assertSchema(remember.parameters, plainArgs);
  const plain = await app.call('assistant_remember', plainArgs);
  assert.equal(plain.inference, false);
  assertSchema(output, plain);
  const plainRendered = app.render('assistant_remember', plainArgs, plain);
  assert.equal(plainRendered.includes('已标记为未证实推断'), false, 'a confirmed row gets no warning');
  assert.equal(plainRendered.includes('待核验'), false);
});

test('8) memory_correct accepts inference/evidence and its render also warns on inference:true', async (t) => {
  const root = await tempRoot();
  const app = mount(root);
  t.after(() => app.close());

  const target = await app.call('assistant_remember', {
    text: '原定下午三点开会',
    kind: 'fact',
    importance: 60,
  });
  const correct = app.tools.get('assistant_memory_correct');
  const args = {
    targetId: target.id,
    expectedVersion: 1,
    expectedText: '下午三点',
    replacement: '下午四点',
    inference: true,
    evidence: 'msg-correction-1',
  };
  assertSchema(correct.parameters, args);
  const result = await app.call('assistant_memory_correct', args);
  assert.equal(result.ok, true, 'the schema-valid call is accepted');
  assert.equal(result.version, 2);
  const row = readRow(root, target.id);
  assert.equal(row.kind, 'hypothesis');
  assert.equal(row.unresolved, 1);
  assert.equal(row.evidence, null, 'an unverifiable reference is never persisted');
  assert.equal(result.evidenceVerified, false);
  assert.deepEqual(result.evidenceErrors.map((entry) => entry.reason), ['not-found']);

  // `executeMemoryCorrect` now projects the gate verdict; the render must honor inference as soon
  // as a caller supplies the flag (the two tools share one warning contract).
  const warned = app.render('assistant_memory_correct', args, { ...result, inference: true });
  assert.ok(warned.includes('已标记为未证实推断'));
  assert.ok(warned.includes('待核验'));
  assert.ok(warned.includes('不作为已确认事实'));
  const quiet = app.render('assistant_memory_correct', args, { ...result, inference: false });
  assert.equal(quiet.includes('已标记为未证实推断'), false);
});
