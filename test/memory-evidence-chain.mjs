/**
 * P2 evidence chain: an unresolved row can never become the next confirmed record.
 *
 * A conversation row keeps `kind:'event'` when a correction is explicitly an inference, so `kind`
 * alone cannot tell a confirmed row from a pending one. The `unresolved` flag is the only honest
 * signal, and `verifyEvidence` must read it: every `unresolved=1` source is `unresolved-source`
 * and cannot lift a later hypothesis. Only after a later verification clears that flag may the
 * corrected row serve as a basis.
 *
 * The chain covered here:
 *   raw conversation (resolved) → inference correction (event, unresolved=1)
 *     → new inference citing it → still hypothesis/unresolved
 *     → an independent resolved source → the new inference verifies
 *     → verifying the old row itself (unresolved=0) → citing it now verifies
 *
 * Raw conversation storage and the P-30 correction merge are deliberately not exercised/changed
 * here; this file only proves the evidence gate reads the unresolved state.
 *
 * Run: node --test test/memory-evidence-chain.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { MemoryStore } from '../src/host/memory/store.js';

async function tempRoot() {
  return mkdtemp(join(tmpdir(), 'dsh-mem-evidence-chain-'));
}

function openStore(root) {
  const store = new MemoryStore(root, { capacity: 2000 });
  store.open();
  return store;
}

function readRow(store, id) {
  return store.db
    .prepare(`SELECT id, domain, kind, text, source, role, message_id, session_id, unresolved,
        evidence, raw_text, version FROM memory_event WHERE id = ?`)
    .get(id);
}

test('1) an unresolved inference correction cannot be cited as independent evidence', async (t) => {
  const root = await tempRoot();
  const store = openStore(root);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  const raw = store.addMessage({
    role: 'user',
    sessionId: 's-chain',
    messageId: 'chain-msg-1',
    text: '用户住在杭州',
    domain: 'chat',
  });
  assert.ok(raw.record !== null, 'the raw conversation is still recorded');
  assert.equal(readRow(store, raw.record.id).unresolved, 0);

  // Explicitly an inference: a conversation row keeps its event kind but must stay unresolved.
  const corrected = store.correct({
    targetId: raw.record.id,
    expectedVersion: 1,
    expectedText: '杭州',
    replacement: '北京',
    sessionId: 's-chain',
    inference: true,
  });
  assert.equal(corrected.ok, true);
  assert.equal(corrected.inference, true);
  const pendingSource = readRow(store, raw.record.id);
  assert.equal(pendingSource.kind, 'event', 'a conversation row keeps its event kind');
  assert.equal(pendingSource.unresolved, 1, 'the inference correction is still unresolved');
  assert.equal(pendingSource.text, '用户住在北京');
  assert.equal(pendingSource.raw_text, '用户住在杭州', 'the original wording is preserved');

  // Citing that pending row by mem id must fail, even though the row exists and contains the claim.
  const claimText = '用户住在北京';
  const viaMem = store.add('chat', claimText, 'fact', {
    source: 'manual',
    sessionId: 's-chain',
    inference: true,
    evidence: `mem:${pendingSource.id}#住在北京`,
  });
  assert.equal(viaMem.evidenceVerified, false);
  assert.equal(viaMem.inference, true);
  assert.equal(viaMem.kind, 'hypothesis');
  assert.equal(viaMem.unresolved, 1);
  assert.deepEqual(viaMem.evidenceErrors.map((entry) => entry.reason), ['unresolved-source']);
  assert.equal(readRow(store, viaMem.id).evidence, null, 'the rejected reference is not persisted');
  assert.equal(readRow(store, viaMem.id).text, claimText, 'the claim text is never rewritten');

  // The same pending row by message id is refused too, regardless of the reference form.
  const viaMsg = store.add('chat', claimText, 'fact', {
    source: 'manual',
    sessionId: 's-chain',
    inference: true,
    evidence: 'msg:chain-msg-1#住在北京',
  });
  assert.equal(viaMsg.inference, true);
  assert.deepEqual(viaMsg.evidenceErrors.map((entry) => entry.reason), ['unresolved-source']);

  // "Regardless of kind": a deliberately unresolved assistant event is refused on the same flag.
  const assistant = store.addMessage({
    role: 'assistant',
    sessionId: 's-chain',
    messageId: 'assistant-pending',
    text: '用户住在北京',
    domain: 'chat',
    unresolved: 1,
  });
  assert.ok(assistant.record !== null);
  const viaAssistant = store.add('chat', claimText, 'fact', {
    source: 'manual',
    sessionId: 's-chain',
    inference: true,
    evidence: 'msg:assistant-pending#住在北京',
  });
  assert.equal(viaAssistant.inference, true);
  assert.equal(viaAssistant.kind, 'hypothesis');
  assert.equal(viaAssistant.unresolved, 1);
  assert.deepEqual(viaAssistant.evidenceErrors.map((entry) => entry.reason), ['unresolved-source']);

  // A manual row can also be explicitly unresolved while keeping a non-event kind.
  const pendingFact = store.add('chat', claimText, 'fact', {
    source: 'manual',
    sessionId: 's-chain',
    unresolved: 1,
  });
  assert.equal(pendingFact.kind, 'fact');
  assert.equal(pendingFact.unresolved, 1);
  const viaFact = store.add('chat', claimText, 'fact', {
    source: 'manual',
    sessionId: 's-chain',
    inference: true,
    evidence: `mem:${pendingFact.id}#住在北京`,
  });
  assert.equal(viaFact.inference, true);
  assert.equal(viaFact.kind, 'hypothesis');
  assert.deepEqual(viaFact.evidenceErrors.map((entry) => entry.reason), ['unresolved-source']);
});

test('2) an independent resolved source lifts; then the verified old row can be cited', async (t) => {
  const root = await tempRoot();
  const store = openStore(root);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  const raw = store.addMessage({
    role: 'user',
    sessionId: 's-chain',
    messageId: 'chain-msg-2',
    text: '用户住在杭州',
    domain: 'chat',
  });
  const corrected = store.correct({
    targetId: raw.record.id,
    expectedVersion: 1,
    expectedText: '杭州',
    replacement: '北京',
    sessionId: 's-chain',
    inference: true,
  });
  assert.equal(corrected.ok, true);
  const pendingId = raw.record.id;
  assert.equal(readRow(store, pendingId).unresolved, 1);

  const blocked = store.add('chat', '用户住在北京', 'fact', {
    source: 'manual',
    sessionId: 's-chain',
    inference: true,
    evidence: `mem:${pendingId}#住在北京`,
  });
  assert.equal(blocked.kind, 'hypothesis');
  assert.deepEqual(blocked.evidenceErrors.map((entry) => entry.reason), ['unresolved-source']);

  // A separate, resolved conversation row is a valid independent basis.
  const independent = store.addMessage({
    role: 'user',
    sessionId: 's-independent',
    messageId: 'independent-msg',
    text: '用户住在北京',
    domain: 'chat',
  });
  assert.ok(independent.record !== null);
  assert.equal(readRow(store, independent.record.id).unresolved, 0);
  const lifted = store.add('chat', '用户住在北京', 'fact', {
    source: 'manual',
    sessionId: 's-chain',
    inference: true,
    evidence: 'msg:independent-msg#住在北京',
  });
  assert.equal(lifted.evidenceVerified, true);
  assert.equal(lifted.inference, false);
  assert.equal(lifted.kind, 'fact');
  assert.equal(lifted.unresolved, 0);
  assert.equal(readRow(store, lifted.id).evidence, 'msg:independent-msg#住在北京');

  // Verify the pending row itself against the independent source: unresolved clears.
  const cleared = store.correct({
    targetId: pendingId,
    expectedVersion: 2,
    expectedText: '北京',
    replacement: '北京',
    sessionId: 's-chain',
    evidence: 'msg:independent-msg#住在北京',
  });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.evidenceVerified, true);
  assert.equal(cleared.inference, false);
  const clearedRow = readRow(store, pendingId);
  assert.equal(clearedRow.unresolved, 0, 'a later verified correction clears the flag');
  assert.equal(clearedRow.kind, 'event');
  assert.equal(clearedRow.evidence, 'msg:independent-msg#住在北京');
  assert.equal(clearedRow.raw_text, '用户住在杭州', 'the raw conversation wording is still kept');

  // Only now may the old row be the basis for a new claim.
  const afterClear = store.add('chat', '用户住在北京', 'fact', {
    source: 'manual',
    sessionId: 's-chain',
    inference: true,
    evidence: `mem:${pendingId}#住在北京`,
  });
  assert.equal(afterClear.evidenceVerified, true);
  assert.equal(afterClear.inference, false);
  assert.equal(afterClear.kind, 'fact');
  assert.equal(afterClear.unresolved, 0);
  assert.deepEqual(afterClear.evidenceErrors, []);
  assert.equal(readRow(store, afterClear.id).evidence, `mem:${pendingId}#住在北京`);
});
