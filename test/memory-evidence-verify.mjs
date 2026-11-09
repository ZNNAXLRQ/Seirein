/**
 * P-127 evidence verification: an inference is lifted only by a real, checkable source.
 *
 * The gate is deliberately conservative:
 *   - the reference is `mem:<memoryId>` or `msg:<messageId>`, optionally `#<verbatim quote>`;
 *   - the source must exist, be visible (not superseded/hidden/archived), share the claim's domain
 *     or session, not be the assistant's own speculation, and not itself be `unresolved=1`;
 *   - a quote must occur verbatim; support is then DIRECT TEXT only (the source, or the sentence
 *     holding the quote, must literally contain the claim's core assertion). Keyword overlap alone
 *     no longer verifies, and an opposite negation state is reported as `contradiction`;
 *   - only a fully verified reference is persisted and lifts the hypothesis. A failed one keeps
 *     the row `hypothesis/unresolved`, persists no reference, and changes no original text.
 *
 * Run: node --test test/memory-evidence-verify.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { apply } from '../src/host/index.js';
import { MemoryStore } from '../src/host/memory/store.js';
import { cleanupRoot } from './helpers/cleanup.mjs';

async function tempRoot() {
  return mkdtemp(join(tmpdir(), 'dsh-mem-evidence-'));
}

function openStore(root) {
  const store = new MemoryStore(root, { capacity: 2000 });
  store.open();
  return store;
}

function readRow(store, id) {
  return store.db
    .prepare(`SELECT id, domain, kind, text, source, role, message_id, session_id, unresolved,
        evidence, version FROM memory_event WHERE id = ?`)
    .get(id);
}

function openStoreRow(root, id) {
  const store = openStore(root);
  try {
    return readRow(store, id);
  } finally {
    store.close();
  }
}

/** Mount the real plugin against the same minimal fake context the other memory tests use. */
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
  return {
    tools,
    call: async (name, args = {}, exec = {}) => {
      const tool = tools.get(name);
      assert.ok(tool !== undefined, `tool registered: ${name}`);
      return tool.execute(args, exec);
    },
    render: (name, args, value) => tools.get(name).output.render(args, value)
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n'),
    close: () => cleanupRoot(root, disposers),
  };
}

/**
 * Minimal strict JSON-Schema checker for exactly the keywords these tool definitions use:
 * type/object/array/string/boolean/integer/number/null, properties, required,
 * additionalProperties:false, items, enum, oneOf, minimum and maximum. It proves the REGISTERED
 * definitions accept the evidence verdict instead of merely trusting the source file.
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

test('1) reference format: mem/msg ids, optional verbatim quotes, comma-separated refs', async (t) => {
  const root = await tempRoot();
  const store = openStore(root);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  // An untyped id / empty id is not a reference and resolves to nothing.
  assert.deepEqual(store.verifyEvidence('msg-obs-1', { domain: 'chat' }).errors, [
    { ref: 'msg-obs-1', reason: 'not-found' },
  ]);
  assert.deepEqual(store.verifyEvidence('mem:', { domain: 'chat' }).errors, [
    { ref: 'mem:', reason: 'not-found' },
  ]);

  store.addMessage({
    role: 'user',
    sessionId: 's-format',
    messageId: 'format-1',
    text: '第一段：OBS 场景',
    domain: 'chat',
  });
  store.addMessage({
    role: 'user',
    sessionId: 's-format',
    messageId: 'format-2',
    text: '第二段：OBS 场景，还有浏览器窗口',
    domain: 'chat',
  });
  store.addMessage({
    role: 'user',
    sessionId: 's-format',
    messageId: 'format-3',
    text: '用户说：好, 很好',
    domain: 'chat',
  });

  // A comma that starts another mem/msg ref separates references; a comma inside a quote is kept.
  // The second quote is not the whole claim, but its sentence literally contains the claim.
  const multiple = store.verifyEvidence('msg:format-1#OBS 场景,msg:format-2#浏览器窗口', {
    domain: 'chat',
    sessionId: 's-format',
    text: 'OBS 场景',
  });
  assert.equal(multiple.verified, true);
  assert.deepEqual(multiple.errors, []);
  const commaQuote = store.verifyEvidence('msg:format-3#好, 很好', {
    domain: 'chat',
    sessionId: 's-format',
    text: '好 很好',
  });
  assert.equal(commaQuote.verified, true);
  assert.deepEqual(commaQuote.errors, []);
});

test('2) a real memory id + verbatim quote lifts the hypothesis and persists the reference', async (t) => {
  const root = await tempRoot();
  const store = openStore(root);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  // The source is a fuller sentence: it literally contains the claim's assertion.
  const source = store.add('chat', '用户把 OBS 场景切换到了浏览器，昨天一整天都在看浏览器画面', 'fact', {
    source: 'manual',
  });
  assert.equal(source.kind, 'fact');
  const evidence = `mem:${source.id}#OBS 场景`;
  const claim = store.add('chat', '用户把 OBS 场景切换到了浏览器', 'fact', {
    source: 'manual',
    inference: true,
    evidence,
  });

  assert.equal(claim.inference, false, 'verified evidence lifts the inference');
  assert.equal(claim.kind, 'fact');
  assert.equal(claim.unresolved, 0);
  assert.equal(claim.evidenceVerified, true);
  assert.deepEqual(claim.evidenceErrors, []);
  const row = readRow(store, claim.id);
  assert.equal(row.kind, 'fact');
  assert.equal(row.unresolved, 0);
  assert.equal(row.evidence, evidence, 'the verified reference is persisted');
  assert.equal(row.text, claim.text, 'the original sentence is stored unchanged');
});

test('3) a real recorded message id + quote verifies (msg: form)', async (t) => {
  const root = await tempRoot();
  const store = openStore(root);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  const recorded = store.addMessage({
    role: 'user',
    sessionId: 's-obs',
    messageId: 'obs-msg-1',
    text: '我昨天把 OBS 切换到了浏览器，后来一直用浏览器看资料',
    domain: 'chat',
  });
  assert.ok(recorded.record !== null);
  const evidence = 'msg:obs-msg-1#OBS 切换';
  const claim = store.add('chat', '把 OBS 切换到了浏览器', 'fact', {
    source: 'manual',
    sessionId: 's-obs',
    inference: true,
    evidence,
  });

  assert.equal(claim.evidenceVerified, true);
  assert.equal(claim.inference, false);
  assert.equal(claim.kind, 'fact');
  assert.equal(readRow(store, claim.id).evidence, evidence);
});

test('4) without a quote, direct containment verifies; keyword overlap alone is unsupported', async (t) => {
  const root = await tempRoot();
  const store = openStore(root);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  const strong = store.add('chat', '用户昨天把 OBS 切换到了浏览器场景，之后一直在用', 'fact', {
    source: 'manual',
  });
  const supported = store.add('chat', '把 OBS 切换到了浏览器场景', 'fact', {
    source: 'manual',
    inference: true,
    evidence: `mem:${strong.id}`,
  });
  assert.equal(supported.evidenceVerified, true, 'literal containment is still direct support');
  assert.equal(supported.inference, false);

  // Same topic and many shared words, but the source never states the claim → NOT support.
  const overlapOnly = store.add('chat', '用户昨天坐高铁去了杭州，逛了西湖', 'fact', { source: 'manual' });
  const unsupported = store.add('chat', '用户昨天去了杭州', 'fact', {
    source: 'manual',
    inference: true,
    evidence: `mem:${overlapOnly.id}`,
  });
  assert.equal(unsupported.evidenceVerified, false);
  assert.equal(unsupported.inference, true);
  assert.equal(unsupported.kind, 'hypothesis');
  assert.equal(unsupported.unresolved, 1);
  assert.deepEqual(unsupported.evidenceErrors.map((entry) => entry.reason), ['unsupported']);
  assert.equal(readRow(store, unsupported.id).evidence, null, 'the failed ref is not persisted');
});

test('5) not-found and wrong-quote references do not lift the hypothesis', async (t) => {
  const root = await tempRoot();
  const store = openStore(root);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  const missingRef = 'mem:00000000-0000-4000-8000-000000000000';
  const missing = store.add('chat', '用户可能是忘了会议', 'fact', {
    source: 'manual',
    evidence: missingRef,
  });
  assert.equal(missing.inference, true);
  assert.equal(missing.kind, 'hypothesis');
  assert.equal(missing.evidenceVerified, false);
  assert.deepEqual(missing.evidenceErrors, [{ ref: missingRef, reason: 'not-found' }]);

  const source = store.add('chat', '用户住在杭州', 'fact', { source: 'manual' });
  const badQuote = store.add('chat', '用户可能住在杭州', 'fact', {
    source: 'manual',
    evidence: `mem:${source.id}#上海`,
  });
  assert.equal(badQuote.inference, true);
  assert.equal(badQuote.kind, 'hypothesis');
  assert.deepEqual(badQuote.evidenceErrors.map((entry) => entry.reason), ['unsupported']);
  assert.equal(readRow(store, badQuote.id).evidence, null);
});

test('6) cross-domain/cross-session sources are refused; same domain OR same session is allowed', async (t) => {
  const root = await tempRoot();
  const store = openStore(root);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  store.addMessage({
    role: 'user',
    sessionId: 's-work',
    messageId: 'work-msg',
    text: '我把 OBS 切换到了浏览器',
    domain: 'work',
  });
  const foreign = store.add('chat', '把 OBS 切换到了浏览器', 'fact', {
    source: 'manual',
    sessionId: 's-chat',
    inference: true,
    evidence: 'msg:work-msg#OBS',
  });
  assert.equal(foreign.inference, true);
  assert.equal(foreign.evidenceVerified, false);
  assert.deepEqual(foreign.evidenceErrors.map((entry) => entry.reason), ['scope']);

  // Same session, different domain: allowed by the "same domain OR same session" rule.
  store.addMessage({
    role: 'user',
    sessionId: 's-shared',
    messageId: 'shared-msg',
    text: '我把 OBS 切换到了浏览器',
    domain: 'work',
  });
  const sameSession = store.add('chat', '把 OBS 切换到了浏览器', 'fact', {
    source: 'manual',
    sessionId: 's-shared',
    inference: true,
    evidence: 'msg:shared-msg#OBS',
  });
  assert.equal(sameSession.evidenceVerified, true);
  assert.equal(sameSession.inference, false);
});

test('7) hidden/superseded sources are stale and never lift a hypothesis', async (t) => {
  const root = await tempRoot();
  const store = openStore(root);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  store.addMessage({
    role: 'user',
    sessionId: 's-stale',
    messageId: 'hidden-msg',
    text: '我把 OBS 切换到了浏览器',
    domain: 'chat',
  });
  store.db.prepare('UPDATE memory_event SET hidden = 1 WHERE message_id = ?').run('hidden-msg');
  const hidden = store.add('chat', '用户可能切换过 OBS', 'fact', {
    source: 'manual',
    sessionId: 's-stale',
    evidence: 'msg:hidden-msg#OBS',
  });
  assert.equal(hidden.inference, true);
  assert.deepEqual(hidden.evidenceErrors.map((entry) => entry.reason), ['stale']);

  store.addMessage({
    role: 'user',
    sessionId: 's-stale',
    messageId: 'superseded-msg',
    text: '我把 OBS 切换到了浏览器',
    domain: 'chat',
  });
  store.db.prepare('UPDATE memory_event SET superseded_by = ? WHERE message_id = ?')
    .run('replacement-id', 'superseded-msg');
  const superseded = store.add('chat', '用户可能切换过 OBS', 'fact', {
    source: 'manual',
    sessionId: 's-stale',
    evidence: 'msg:superseded-msg#OBS',
  });
  assert.equal(superseded.inference, true);
  assert.deepEqual(superseded.evidenceErrors.map((entry) => entry.reason), ['stale']);
});

test('8) a hypothesis or an assistant speculation is not independent evidence', async (t) => {
  const root = await tempRoot();
  const store = openStore(root);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  const hypothesis = store.add('chat', '用户可能是忘了会议', 'fact', { source: 'manual' });
  assert.equal(hypothesis.kind, 'hypothesis');
  const fromHypothesis = store.add('chat', '用户可能忘了会议', 'fact', {
    source: 'manual',
    evidence: `mem:${hypothesis.id}#忘了会议`,
  });
  assert.equal(fromHypothesis.inference, true);
  assert.deepEqual(
    fromHypothesis.evidenceErrors.map((entry) => entry.reason),
    ['unresolved-source'],
    'a hypothesis row is still unresolved, so it cannot be independent evidence',
  );

  store.addMessage({
    role: 'assistant',
    sessionId: 's-self',
    messageId: 'assistant-guess',
    text: '看来用户是忘了会议',
    domain: 'chat',
  });
  const fromAssistant = store.add('chat', '用户可能忘了会议', 'fact', {
    source: 'manual',
    sessionId: 's-self',
    evidence: 'msg:assistant-guess#忘了会议',
  });
  assert.equal(fromAssistant.inference, true);
  assert.deepEqual(
    fromAssistant.evidenceErrors.map((entry) => entry.reason),
    ['self-inference'],
    'the assistant repeating its own guess is not independent evidence',
  );
});

test('9) no evidence + marker stays the existing hypothesis; raw conversation is untouched', async (t) => {
  const root = await tempRoot();
  const store = openStore(root);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  const inference = store.add('chat', '因为下雨，所以用户没来', 'fact', { source: 'manual' });
  assert.equal(inference.inference, true);
  assert.equal(inference.kind, 'hypothesis');
  assert.equal(inference.unresolved, 1);
  assert.equal(inference.evidence, null);
  assert.equal(inference.evidenceVerified, false);

  // The automatic recorder stores quoted speech verbatim, even with causal markers.
  const recorded = store.addMessage({
    role: 'user',
    sessionId: 's-raw',
    messageId: 'raw-msg',
    text: '因为下雨，所以不出门',
    domain: 'chat',
  });
  assert.ok(recorded.record !== null);
  const row = readRow(store, recorded.record.id);
  assert.equal(row.kind, 'event');
  assert.equal(row.source, 'auto');
  assert.equal(row.role, 'user');
  assert.equal(row.unresolved, 0);
  assert.equal(row.evidence, null, 'the automatic lane never runs the evidence gate');
  assert.equal(row.text, '因为下雨，所以不出门');
});

test('10) correct() verifies the replacement: a passing ref lifts, a bad ref stays hypothesis', async (t) => {
  const root = await tempRoot();
  const store = openStore(root);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  store.addMessage({
    role: 'user',
    sessionId: 's-correct',
    messageId: 'correct-msg-1',
    text: '用户没来，大概是忘了',
    domain: 'chat',
  });
  const target = store.add('chat', '用户没来', 'fact', { source: 'manual', sessionId: 's-correct' });
  const verified = store.correct({
    targetId: target.id,
    expectedVersion: 1,
    expectedText: '用户没来',
    replacement: '用户没来，大概是忘了',
    sessionId: 's-correct',
    evidence: 'msg:correct-msg-1#忘了',
  });
  assert.equal(verified.ok, true);
  assert.equal(verified.evidenceVerified, true);
  assert.equal(verified.inference, false);
  const verifiedRow = readRow(store, target.id);
  assert.equal(verifiedRow.kind, 'fact', 'a verified correction keeps the normal kind');
  assert.equal(verifiedRow.unresolved, 0);
  assert.equal(verifiedRow.evidence, 'msg:correct-msg-1#忘了');

  const second = store.add('chat', '原定下午三点开会', 'fact', { source: 'manual' });
  const rejected = store.correct({
    targetId: second.id,
    expectedVersion: 1,
    expectedText: '下午三点',
    replacement: '下午四点，所以可能是改期了',
    evidence: `mem:${target.id}#不存在的片段`,
  });
  assert.equal(rejected.ok, true);
  assert.equal(rejected.evidenceVerified, false);
  assert.equal(rejected.inference, true);
  const rejectedRow = readRow(store, second.id);
  assert.equal(rejectedRow.kind, 'hypothesis');
  assert.equal(rejectedRow.unresolved, 1);
  assert.equal(rejectedRow.evidence, null, 'an unverified reference is not persisted');
  assert.deepEqual(rejected.evidenceErrors.map((entry) => entry.reason), ['unsupported']);

  // Correcting an older hypothesis with a verified reference restores a confirmed kind and clears
  // the unresolved mark (the original kind was overwritten when it became a hypothesis).
  store.addMessage({
    role: 'user',
    sessionId: 's-correct',
    messageId: 'correct-msg-2',
    text: '用户没来，肯定是忘了',
    domain: 'chat',
  });
  const oldHypothesis = store.add('chat', '用户没来，大概是忘了', 'fact', { source: 'manual' });
  assert.equal(oldHypothesis.kind, 'hypothesis');
  const lifted = store.correct({
    targetId: oldHypothesis.id,
    expectedVersion: 1,
    expectedText: '大概是忘了',
    replacement: '肯定是忘了',
    sessionId: 's-correct',
    evidence: 'msg:correct-msg-2#忘了',
  });
  assert.equal(lifted.ok, true);
  assert.equal(lifted.evidenceVerified, true);
  assert.equal(lifted.inference, false);
  const liftedRow = readRow(store, oldHypothesis.id);
  assert.equal(liftedRow.kind, 'fact', 'a verified correction restores a normal kind');
  assert.equal(liftedRow.unresolved, 0);
});

test('11) assistant_remember reports evidenceVerified/evidenceErrors for evidence-bearing calls', async (t) => {
  const root = await tempRoot();
  const seed = openStore(root);
  const source = seed.add('chat', '用户把 OBS 场景切换到了浏览器，当前显示的是 OBS 场景', 'fact', {
    source: 'manual',
  });
  seed.close();
  const app = mount(root);
  t.after(() => app.close());

  const verified = await app.call('assistant_remember', {
    text: '用户把 OBS 场景切换到了浏览器',
    kind: 'fact',
    importance: 70,
    inference: true,
    evidence: `mem:${source.id}#OBS 场景`,
  });
  assert.equal(verified.inference, false);
  assert.equal(verified.kind, 'fact');
  assert.equal(verified.evidenceVerified, true);
  assert.deepEqual(verified.evidenceErrors, []);
  assert.equal(verified.evidenceErrors.some((entry) => 'text' in entry), false, 'no body in errors');

  const missingRef = 'mem:11111111-1111-4111-8111-111111111111';
  const rejected = await app.call('assistant_remember', {
    text: '用户可能喜欢爵士乐',
    kind: 'preference',
    evidence: missingRef,
  });
  assert.equal(rejected.inference, true);
  assert.equal(rejected.kind, 'hypothesis');
  assert.equal(rejected.evidenceVerified, false);
  assert.deepEqual(rejected.evidenceErrors, [{ ref: missingRef, reason: 'not-found' }]);

  // The existing render warning still names the unverified state for an unresolved inference.
  const rendered = app.render('assistant_remember', {}, rejected);
  assert.ok(rendered.includes('已标记为未证实推断'));
  assert.ok(rendered.includes('待核验'));

  // The correct tool passes the same reference through and reports the same verdict.
  const target = await app.call('assistant_remember', {
    text: '当前显示的是浏览器',
    kind: 'fact',
    importance: 60,
  });
  const corrected = await app.call('assistant_memory_correct', {
    targetId: target.id,
    expectedVersion: 1,
    expectedText: '浏览器',
    replacement: 'OBS 场景',
    evidence: `mem:${source.id}#OBS 场景`,
  });
  assert.equal(corrected.ok, true);
  assert.equal(corrected.evidenceVerified, true);
  assert.equal(corrected.inference, false);
  assert.deepEqual(corrected.evidenceErrors, []);
  const correctedRow = openStoreRow(root, target.id);
  assert.equal(correctedRow.kind, 'fact');
  assert.equal(correctedRow.unresolved, 0);
  assert.equal(correctedRow.evidence, `mem:${source.id}#OBS 场景`);
});

test('12) registered schemas accept the evidence verdict; render shows verified vs unresolved', async (t) => {
  const root = await tempRoot();
  const seed = openStore(root);
  const source = seed.add('chat', '用户把 OBS 场景切换到了浏览器，当前显示的是 OBS 场景', 'fact', {
    source: 'manual',
  });
  seed.close();
  const app = mount(root);
  t.after(() => app.close());

  // The REAL registered definitions must declare the two optional fields and the reference
  // format, otherwise strict output validation rejects an evidence-bearing return.
  const remember = app.tools.get('assistant_remember');
  const correct = app.tools.get('assistant_memory_correct');
  for (const [name, tool] of [
    ['assistant_remember', remember],
    ['assistant_memory_correct', correct],
  ]) {
    assert.ok(tool !== undefined, `${name} is registered by the real host`);
    const schema = tool.output.schema;
    assert.equal(schema.additionalProperties, false, `${name}: output schema stays closed`);
    assert.equal(schema.properties.evidenceVerified?.type, 'boolean', `${name}: declares evidenceVerified`);
    assert.equal(schema.properties.evidenceErrors?.type, 'array', `${name}: declares evidenceErrors`);
    const entry = schema.properties.evidenceErrors?.items;
    assert.equal(entry?.type, 'object', `${name}: evidenceErrors items are objects`);
    assert.equal(entry?.additionalProperties, false, `${name}: error entries stay closed`);
    assert.deepEqual(entry?.required, ['ref', 'reason'], `${name}: error entries require ref+reason`);
    assert.equal(entry?.properties?.ref?.type, 'string');
    assert.equal(entry?.properties?.reason?.type, 'string');
    assert.equal(schema.required.includes('evidenceVerified'), false, `${name}: verdict is optional`);
    assert.equal(schema.required.includes('evidenceErrors'), false, `${name}: errors are optional`);
    const description = tool.parameters.properties.evidence?.description ?? '';
    for (const marker of ['mem:<id>', 'msg:<id>', '#<来源原文片段>', '多个用逗号分隔']) {
      assert.ok(description.includes(marker), `${name}: evidence description names ${marker}`);
    }
  }

  // A remember call with valid evidence: the strict return is accepted and names the verified state.
  const verifiedArgs = {
    text: '用户把 OBS 场景切换到了浏览器',
    kind: 'fact',
    importance: 70,
    inference: true,
    evidence: `mem:${source.id}#OBS 场景`,
  };
  const verified = await app.call('assistant_remember', verifiedArgs);
  assert.equal(verified.evidenceVerified, true);
  assert.deepEqual(verified.evidenceErrors, []);
  assertSchema(remember.output.schema, verified);
  const verifiedText = app.render('assistant_remember', verifiedArgs, verified);
  assert.ok(verifiedText.includes('已由来源核验，可作为已确认记录。'), 'verified render confirms the source');
  assert.equal(verifiedText.includes('已标记为未证实推断'), false, 'no unresolved warning for a verified row');

  // A failed reference keeps the existing unresolved warning and never claims verification.
  const rejectedArgs = {
    text: '用户可能喜欢爵士乐',
    kind: 'preference',
    evidence: 'mem:11111111-1111-4111-8111-111111111111',
  };
  const rejected = await app.call('assistant_remember', rejectedArgs);
  assert.equal(rejected.evidenceVerified, false);
  assertSchema(remember.output.schema, rejected);
  const rejectedText = app.render('assistant_remember', rejectedArgs, rejected);
  assert.ok(rejectedText.includes('已标记为未证实推断'));
  assert.ok(rejectedText.includes('待核验'));
  assert.equal(rejectedText.includes('已由来源核验'), false);

  // Neither evidence nor inference: the return keeps its old shape and render adds no line.
  const plainArgs = { text: '用户住在杭州', kind: 'fact', importance: 70 };
  const plain = await app.call('assistant_remember', plainArgs);
  assert.equal(Object.hasOwn(plain, 'evidenceVerified'), false);
  assert.equal(Object.hasOwn(plain, 'evidenceErrors'), false);
  assertSchema(remember.output.schema, plain);
  const plainText = app.render('assistant_remember', plainArgs, plain);
  for (const line of ['已由来源核验', '已标记为未证实推断', '待核验']) {
    assert.equal(plainText.includes(line), false, `no-evidence render omits ${line}`);
  }

  // The correct tool returns the same verdict shape and its render confirms a verified source.
  const target = await app.call('assistant_remember', {
    text: '当前显示的是浏览器',
    kind: 'fact',
    importance: 60,
  });
  const correctArgs = {
    targetId: target.id,
    expectedVersion: 1,
    expectedText: '浏览器',
    replacement: 'OBS 场景',
    evidence: `mem:${source.id}#OBS 场景`,
  };
  const corrected = await app.call('assistant_memory_correct', correctArgs);
  assert.equal(corrected.ok, true);
  assert.equal(corrected.evidenceVerified, true);
  assert.deepEqual(corrected.evidenceErrors, []);
  // Only the two new fields are asserted against the registered schema here: a full strict pass
  // on memory_correct is blocked by pre-existing undeclared fields (staleLinkIds/inference) that
  // this change is not allowed to widen.
  assertSchema(correct.output.schema.properties.evidenceVerified, corrected.evidenceVerified,
    '$.evidenceVerified');
  assertSchema(correct.output.schema.properties.evidenceErrors, corrected.evidenceErrors,
    '$.evidenceErrors');
  const correctedText = app.render('assistant_memory_correct', correctArgs, corrected);
  assert.ok(correctedText.includes('已由来源核验，可作为已确认记录。'));
});

test('13) a verbatim quote cannot invert a negation: 喜欢 vs 不喜欢 is contradiction', async (t) => {
  const root = await tempRoot();
  const store = openStore(root);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  const source = store.add('chat', '用户不喜欢恐怖片', 'fact', { source: 'manual' });
  const claimText = '用户喜欢恐怖片，因为刺激';
  const claim = store.add('chat', claimText, 'fact', {
    source: 'manual',
    evidence: `mem:${source.id}#不喜欢恐怖片`,
  });

  // The quote really occurs in the source and shares most words with the claim; neither is enough.
  assert.equal(claim.evidenceVerified, false);
  assert.equal(claim.inference, true);
  assert.equal(claim.kind, 'hypothesis');
  assert.equal(claim.unresolved, 1);
  assert.deepEqual(claim.evidenceErrors.map((entry) => entry.reason), ['contradiction']);
  const stored = readRow(store, claim.id);
  assert.equal(stored.text, claimText, 'the original claim is stored unchanged');
  assert.equal(stored.evidence, null, 'the failed reference is not persisted');

  // Same source, same polarity: direct text support still verifies.
  const honest = store.add('chat', '用户不喜欢恐怖片', 'fact', {
    source: 'manual',
    inference: true,
    evidence: `mem:${source.id}#不喜欢恐怖片`,
  });
  assert.equal(honest.evidenceVerified, true);
  assert.equal(honest.inference, false);
});

test('14) an added cause/evaluation is unsupported; only the source stating it verifies', async (t) => {
  const root = await tempRoot();
  const store = openStore(root);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  const bare = store.add('chat', '用户喜欢恐怖片', 'fact', { source: 'manual' });
  const causal = store.add('chat', '用户喜欢恐怖片，因为刺激', 'fact', {
    source: 'manual',
    evidence: `mem:${bare.id}#喜欢恐怖片`,
  });
  assert.equal(causal.evidenceVerified, false, 'the quote covers the premise, not the added cause');
  assert.equal(causal.inference, true);
  assert.equal(causal.kind, 'hypothesis');
  assert.equal(causal.unresolved, 1);
  assert.deepEqual(causal.evidenceErrors.map((entry) => entry.reason), ['unsupported']);

  const evaluation = store.add('chat', '用户把票退了，说明不想去', 'fact', {
    source: 'manual',
    evidence: `mem:${bare.id}#恐怖片`,
  });
  assert.equal(evaluation.evidenceVerified, false);
  assert.deepEqual(evaluation.evidenceErrors.map((entry) => entry.reason), ['unsupported']);

  // When the source itself states the whole claim, the same causal sentence is direct support.
  const full = store.addMessage({
    role: 'user',
    sessionId: 's-causal',
    messageId: 'causal-msg',
    text: '用户喜欢恐怖片，因为刺激',
    domain: 'chat',
  });
  assert.ok(full.record !== null);
  const verified = store.add('chat', '用户喜欢恐怖片，因为刺激', 'fact', {
    source: 'manual',
    sessionId: 's-causal',
    inference: true,
    evidence: 'msg:causal-msg#因为刺激',
  });
  assert.equal(verified.evidenceVerified, true);
  assert.equal(verified.inference, false);
  assert.equal(verified.kind, 'fact');

  // The quote's own sentence is enough even when another sentence carries a negation.
  store.addMessage({
    role: 'user',
    sessionId: 's-multi',
    messageId: 'multi-msg',
    text: '用户不喜欢恐怖片。不过用户喜欢喜剧。',
    domain: 'chat',
  });
  const withinSentence = store.add('chat', '用户喜欢喜剧', 'fact', {
    source: 'manual',
    sessionId: 's-multi',
    inference: true,
    evidence: 'msg:multi-msg#喜欢喜剧',
  });
  assert.equal(withinSentence.evidenceVerified, true);
  assert.equal(withinSentence.inference, false);

  // Legacy-shaped case: the source states the action (and the quote is verbatim), but the claim
  // adds a cause and a conclusion it never states. That is exactly the extra-tail case and stays
  // an unresolved hypothesis, even though most keywords overlap.
  store.addMessage({
    role: 'user',
    sessionId: 's-partial',
    messageId: 'partial-msg',
    text: '我昨天把 OBS 场景切换到了浏览器',
    domain: 'chat',
  });
  const partial = store.add('chat', '因为用户之前切换过 OBS 场景，所以现在看到的是浏览器', 'fact', {
    source: 'manual',
    sessionId: 's-partial',
    evidence: 'msg:partial-msg#OBS 场景',
  });
  assert.equal(partial.evidenceVerified, false);
  assert.equal(partial.inference, true);
  assert.equal(partial.kind, 'hypothesis');
  assert.deepEqual(partial.evidenceErrors.map((entry) => entry.reason), ['unsupported']);
});

test('15) question/conditional sentences are not direct support; a declarative statement still is', async (t) => {
  const root = await tempRoot();
  const store = openStore(root);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  // P2 counterexample: literal containment inside a question is not an assertion.
  store.addMessage({
    role: 'user',
    sessionId: 's-modality',
    messageId: 'modality-question',
    text: '你觉得我喜欢恐怖片吗？',
    domain: 'chat',
  });
  const fromQuestion = store.add('chat', '我喜欢恐怖片', 'preference', {
    source: 'manual',
    sessionId: 's-modality',
    inference: true,
    evidence: 'msg:modality-question',
  });
  assert.equal(fromQuestion.evidenceVerified, false);
  assert.equal(fromQuestion.inference, true);
  assert.equal(fromQuestion.kind, 'hypothesis');
  assert.equal(fromQuestion.unresolved, 1);
  assert.deepEqual(fromQuestion.evidenceErrors.map((entry) => entry.reason), ['question-source']);
  assert.equal(readRow(store, fromQuestion.id).evidence, null);

  // P2 counterexample: a conditional states a supposition, not the fact.
  store.addMessage({
    role: 'user',
    sessionId: 's-modality',
    messageId: 'modality-conditional',
    text: '如果我喜欢恐怖片，就推荐招魂。',
    domain: 'chat',
  });
  const fromConditional = store.add('chat', '我喜欢恐怖片', 'preference', {
    source: 'manual',
    sessionId: 's-modality',
    inference: true,
    evidence: 'msg:modality-conditional',
  });
  assert.equal(fromConditional.evidenceVerified, false);
  assert.equal(fromConditional.kind, 'hypothesis');
  assert.equal(fromConditional.unresolved, 1);
  assert.deepEqual(
    fromConditional.evidenceErrors.map((entry) => entry.reason),
    ['conditional-source'],
  );

  // A nearby declarative sentence must not rescue the question that holds the claim.
  store.addMessage({
    role: 'user',
    sessionId: 's-modality',
    messageId: 'modality-mixed',
    text: '你觉得我喜欢恐怖片吗？不过我从来不看电影。',
    domain: 'chat',
  });
  const mixed = store.add('chat', '我喜欢恐怖片', 'preference', {
    source: 'manual',
    sessionId: 's-modality',
    inference: true,
    evidence: 'msg:modality-mixed',
  });
  assert.equal(mixed.evidenceVerified, false);
  assert.deepEqual(mixed.evidenceErrors.map((entry) => entry.reason), ['question-source']);

  // A direct declarative statement keeps the previous behavior: literal containment verifies.
  store.addMessage({
    role: 'user',
    sessionId: 's-modality',
    messageId: 'modality-statement',
    text: '我喜欢恐怖片。',
    domain: 'chat',
  });
  const fromStatement = store.add('chat', '我喜欢恐怖片', 'fact', {
    source: 'manual',
    sessionId: 's-modality',
    inference: true,
    evidence: 'msg:modality-statement',
  });
  assert.equal(fromStatement.evidenceVerified, true);
  assert.equal(fromStatement.inference, false);
  assert.equal(fromStatement.kind, 'fact');
  assert.equal(fromStatement.unresolved, 0);
  assert.deepEqual(fromStatement.evidenceErrors, []);
  assert.equal(readRow(store, fromStatement.id).evidence, 'msg:modality-statement');
});
