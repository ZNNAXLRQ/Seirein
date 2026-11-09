/**
 * P2 evidence modality: a question or a conditional sentence never directly supports a claim.
 *
 * The P-127 gate used to accept literal containment alone, so a source such as
 *   "你觉得我喜欢恐怖片吗？"
 * verified the derived claim "我喜欢恐怖片" (and a conditional such as
 *   "如果我喜欢恐怖片，就推荐招魂。"
 * did the same). Literal containment is necessary but not sufficient: the sentence that would
 * support the claim must ASSERT it, not ask about it or suppose it.
 *
 * Cases covered:
 *   - question sentence (?, ending 吗/呢/吧, cue 是否/有没有/你觉得/你认为) → question-source
 *   - conditional/hypothetical (如果/假如/要是/若/假设/万一 + 就/那么/便, or …的话)
 *     → conditional-source
 *   - declarative statement → still fact/verified
 *   - a multi-sentence source is judged ONLY by the sentence holding the quote / containing the
 *     claim; a nearby declarative sentence cannot rescue a question.
 *
 * Run: node --test test/memory-evidence-modality.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { MemoryStore } from '../src/host/memory/store.js';

async function tempRoot() {
  return mkdtemp(join(tmpdir(), 'dsh-mem-evidence-modality-'));
}

function openStore(root) {
  const store = new MemoryStore(root, { capacity: 2000 });
  store.open();
  return store;
}

function readRow(store, id) {
  return store.db
    .prepare(`SELECT id, kind, text, source, role, message_id, session_id, unresolved, evidence
      FROM memory_event WHERE id = ?`)
    .get(id);
}

function recordMessage(store, sessionId, messageId, text) {
  const message = store.addMessage({
    role: 'user',
    sessionId,
    messageId,
    text,
    domain: 'chat',
  });
  assert.ok(message.record !== null, `message ${messageId} was recorded`);
}

test('1) a question sentence is never direct support (question-source)', async (t) => {
  const root = await tempRoot();
  const store = openStore(root);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  const claim = '我喜欢恐怖片';
  const questions = [
    ['q-end', '你觉得我喜欢恐怖片吗？'],
    ['q-mark', '我喜欢恐怖片？'],
    ['q-ma', '我妈问我喜欢恐怖片吗'],
    ['q-ne', '我喜欢恐怖片呢'],
    ['q-ba', '我喜欢恐怖片吧'],
    ['q-cue-shi', '你是否觉得我喜欢恐怖片？'],
    ['q-cue-you', '有没有可能我喜欢恐怖片'],
    ['q-cue-ni', '你认为我喜欢恐怖片'],
  ];
  for (const [messageId, sourceText] of questions) {
    recordMessage(store, 's-question', messageId, sourceText);
    const verdict = store.verifyEvidence(`msg:${messageId}`, {
      domain: 'chat',
      sessionId: 's-question',
      text: claim,
    });
    assert.equal(verdict.verified, false, `${sourceText}: question cannot verify`);
    assert.deepEqual(
      verdict.errors.map((entry) => entry.reason),
      ['question-source'],
      `${sourceText}: reason is question-source`,
    );
  }

  // A rhetorical question with no question mark is still a question via its cue word.
  recordMessage(store, 's-question', 'q-rhetorical', '难道我不喜欢恐怖片');
  const rhetorical = store.verifyEvidence('msg:q-rhetorical', {
    domain: 'chat',
    sessionId: 's-question',
    text: '我不喜欢恐怖片',
  });
  assert.equal(rhetorical.verified, false);
  assert.deepEqual(rhetorical.errors.map((entry) => entry.reason), ['question-source']);

  // The exact counterexample from the review, through the manual lane: the row stays a hypothesis.
  const added = store.add('chat', claim, 'preference', {
    source: 'manual',
    sessionId: 's-question',
    inference: true,
    evidence: 'msg:q-end',
  });
  assert.equal(added.inference, true);
  assert.equal(added.kind, 'hypothesis');
  assert.equal(added.unresolved, 1);
  assert.equal(added.evidenceVerified, false);
  assert.deepEqual(added.evidenceErrors.map((entry) => entry.reason), ['question-source']);
  const row = readRow(store, added.id);
  assert.equal(row.kind, 'hypothesis');
  assert.equal(row.unresolved, 1);
  assert.equal(row.evidence, null, 'an unverified reference is not persisted');
  assert.equal(row.text, claim, 'the claim text is never rewritten');

  // A verbatim quote inside the question does not change the verdict.
  const quoted = store.verifyEvidence('msg:q-end#我喜欢恐怖片', {
    domain: 'chat',
    sessionId: 's-question',
    text: claim,
  });
  assert.equal(quoted.verified, false);
  assert.deepEqual(quoted.errors.map((entry) => entry.reason), ['question-source']);
});

test('2) a conditional/hypothetical sentence is never direct support (conditional-source)', async (t) => {
  const root = await tempRoot();
  const store = openStore(root);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  const claim = '我喜欢恐怖片';
  const conditionals = [
    ['c-ru', '如果我喜欢恐怖片，就推荐招魂。'],
    ['c-jia', '假如我喜欢恐怖片，那么推荐招魂。'],
    ['c-yao', '要是我喜欢恐怖片，便推荐招魂。'],
    ['c-ruo', '若我喜欢恐怖片，就推荐招魂。'],
    ['c-she', '假设我喜欢恐怖片，就推荐招魂。'],
    ['c-wan', '万一我喜欢恐怖片，就推荐招魂。'],
    ['c-hua', '如果我喜欢恐怖片的话，推荐招魂。'],
  ];
  for (const [messageId, sourceText] of conditionals) {
    recordMessage(store, 's-conditional', messageId, sourceText);
    const verdict = store.verifyEvidence(`msg:${messageId}`, {
      domain: 'chat',
      sessionId: 's-conditional',
      text: claim,
    });
    assert.equal(verdict.verified, false, `${sourceText}: conditional cannot verify`);
    assert.deepEqual(
      verdict.errors.map((entry) => entry.reason),
      ['conditional-source'],
      `${sourceText}: reason is conditional-source`,
    );
  }

  // The exact conditional counterexample from the review, through the manual lane.
  const added = store.add('chat', claim, 'preference', {
    source: 'manual',
    sessionId: 's-conditional',
    inference: true,
    evidence: 'msg:c-ru',
  });
  assert.equal(added.inference, true);
  assert.equal(added.kind, 'hypothesis');
  assert.equal(added.unresolved, 1);
  assert.equal(added.evidenceVerified, false);
  assert.deepEqual(added.evidenceErrors.map((entry) => entry.reason), ['conditional-source']);
  assert.equal(readRow(store, added.id).evidence, null);

  // A quote inside the conditional is still only a supposition.
  const quoted = store.verifyEvidence('msg:c-hua#我喜欢恐怖片', {
    domain: 'chat',
    sessionId: 's-conditional',
    text: claim,
  });
  assert.equal(quoted.verified, false);
  assert.deepEqual(quoted.errors.map((entry) => entry.reason), ['conditional-source']);
});

test('3) a direct declarative statement still verifies (fact/verified)', async (t) => {
  const root = await tempRoot();
  const store = openStore(root);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  recordMessage(store, 's-statement', 'stmt-1', '我喜欢恐怖片。');
  const added = store.add('chat', '我喜欢恐怖片', 'fact', {
    source: 'manual',
    sessionId: 's-statement',
    inference: true,
    evidence: 'msg:stmt-1#喜欢恐怖片',
  });
  assert.equal(added.inference, false, 'a declarative source lifts the hypothesis');
  assert.equal(added.kind, 'fact');
  assert.equal(added.unresolved, 0);
  assert.equal(added.evidenceVerified, true);
  assert.deepEqual(added.evidenceErrors, []);
  const row = readRow(store, added.id);
  assert.equal(row.kind, 'fact');
  assert.equal(row.evidence, 'msg:stmt-1#喜欢恐怖片', 'the verified reference is persisted');

  // A declarative sentence among other declarative sentences is still judged sentence-wise.
  recordMessage(store, 's-statement', 'stmt-2', '我平时不看电影。其实我喜欢恐怖片。');
  const multiStatement = store.add('chat', '我喜欢恐怖片', 'fact', {
    source: 'manual',
    sessionId: 's-statement',
    inference: true,
    evidence: 'msg:stmt-2',
  });
  assert.equal(multiStatement.evidenceVerified, true);
  assert.equal(multiStatement.kind, 'fact');
});

test('4) a multi-sentence source is judged only by the sentence holding the claim', async (t) => {
  const root = await tempRoot();
  const store = openStore(root);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  // The question holds the claim; the neighbouring declarative sentence does NOT state it.
  recordMessage(
    store,
    's-mixed',
    'mixed-question',
    '你觉得我喜欢恐怖片吗？不过我从来不看电影。',
  );
  const rescued = store.add('chat', '我喜欢恐怖片', 'fact', {
    source: 'manual',
    sessionId: 's-mixed',
    inference: true,
    evidence: 'msg:mixed-question',
  });
  assert.equal(rescued.evidenceVerified, false, 'a nearby statement must not rescue the question');
  assert.equal(rescued.kind, 'hypothesis');
  assert.equal(rescued.unresolved, 1);
  assert.deepEqual(rescued.evidenceErrors.map((entry) => entry.reason), ['question-source']);

  // The conditional holds the claim; the neighbouring declarative sentence does NOT state it.
  recordMessage(
    store,
    's-mixed',
    'mixed-conditional',
    '如果我喜欢恐怖片，就推荐招魂。我平时不看电影。',
  );
  const conditional = store.add('chat', '我喜欢恐怖片', 'fact', {
    source: 'manual',
    sessionId: 's-mixed',
    inference: true,
    evidence: 'msg:mixed-conditional',
  });
  assert.equal(conditional.evidenceVerified, false);
  assert.deepEqual(
    conditional.evidenceErrors.map((entry) => entry.reason),
    ['conditional-source'],
  );

  // The statement holds the claim; the question sentence does NOT contain it. Following the
  // sentence that actually contains the claim, this is a valid declarative source.
  recordMessage(store, 's-mixed', 'mixed-statement', '你觉得我最近忙吗？其实我喜欢恐怖片。');
  const supported = store.add('chat', '我喜欢恐怖片', 'fact', {
    source: 'manual',
    sessionId: 's-mixed',
    inference: true,
    evidence: 'msg:mixed-statement',
  });
  assert.equal(supported.evidenceVerified, true);
  assert.equal(supported.inference, false);
  assert.equal(supported.kind, 'fact');

  // A quote pins the decision to the quoted sentence, not to a declarative neighbour.
  recordMessage(
    store,
    's-mixed',
    'mixed-quote',
    '如果我喜欢恐怖片，就推荐招魂。我今天看了电影。',
  );
  const quoted = store.add('chat', '我喜欢恐怖片', 'fact', {
    source: 'manual',
    sessionId: 's-mixed',
    inference: true,
    evidence: 'msg:mixed-quote#我喜欢恐怖片',
  });
  assert.equal(quoted.evidenceVerified, false);
  assert.deepEqual(quoted.evidenceErrors.map((entry) => entry.reason), ['conditional-source']);
});

test('5) correct() applies the same modality gate; errors carry only ref+reason', async (t) => {
  const root = await tempRoot();
  const store = openStore(root);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  recordMessage(store, 's-correct', 'correct-question', '你觉得我喜欢恐怖片吗？');
  const target = store.add('chat', '最近在看电影', 'fact', {
    source: 'manual',
    sessionId: 's-correct',
  });
  const corrected = store.correct({
    targetId: target.id,
    expectedVersion: 1,
    expectedText: '最近在看电影',
    replacement: '我喜欢恐怖片',
    sessionId: 's-correct',
    inference: true,
    evidence: 'msg:correct-question',
  });
  assert.equal(corrected.ok, true);
  assert.equal(corrected.evidenceVerified, false);
  assert.equal(corrected.inference, true);
  assert.deepEqual(corrected.evidenceErrors.map((entry) => entry.reason), ['question-source']);
  const row = readRow(store, target.id);
  assert.equal(row.kind, 'hypothesis');
  assert.equal(row.unresolved, 1);
  assert.equal(row.evidence, null);

  // The reason code is the only new field: no source/claim body leaks into evidenceErrors.
  recordMessage(store, 's-correct', 'correct-conditional', '如果我喜欢恐怖片，就推荐招魂。');
  const rejected = store.verifyEvidence('msg:correct-conditional', {
    domain: 'chat',
    sessionId: 's-correct',
    text: '我喜欢恐怖片',
  });
  assert.deepEqual(rejected.errors, [
    { ref: 'msg:correct-conditional', reason: 'conditional-source' },
  ]);
  for (const entry of rejected.errors) {
    assert.deepEqual(Object.keys(entry).sort(), ['reason', 'ref']);
    assert.equal('text' in entry, false);
  }
  assert.equal(JSON.stringify(rejected.errors).includes('推荐招魂'), false, 'no source body in errors');
});
