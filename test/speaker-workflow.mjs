import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSpeakerLibrary } from '../src/host/hearing/speakerVoice.js';
import { createSpeakerCandidatesStore } from '../src/host/hearing/speaker-candidates.js';
import { createSpeakerEnrollmentStore } from '../src/host/hearing/speaker-enrollment.js';
import { createSpeakerWorkflow } from '../src/host/hearing/speaker-workflow.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'speaker-workflow-'));
  const library = createSpeakerLibrary({ root });
  const candidates = createSpeakerCandidatesStore({ root });
  const enrollment = createSpeakerEnrollmentStore({ root });
  const workflow = createSpeakerWorkflow({ library, candidates, enrollment });
  t.after(async () => { library.close(); await rm(root, { recursive: true, force: true }); });
  const add = (id, embedding = [1, 0], durationMs = 1000) => {
    const audioPath = join(root, id + '.wav');
    writeFileSync(audioPath, 'fake audio');
    const result = candidates.add({ utteranceId: id, embedding: Float32Array.from(embedding),
      durationMs, audioPath, text: id, source: 'mic', quality: 'ok' });
    assert.equal(result.ok, true);
    return result;
  };
  return { root, library, candidates, enrollment, workflow, add };
}

test('create consumes the entire pool, including more than the old 20 selected-row limit', async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 25; i++) f.add('candidate-' + i);
  const result = f.workflow.create({ label: '我的声音' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.sampleCount, 25);
  assert.equal(f.candidates.list().length, 0);
  assert.equal(f.library.get(result.speakerId).activeCount, 25);
  assert.equal(f.enrollment.getConfirmedSelf().speakerId, result.speakerId);
  assert.equal(f.workflow.list().voiceprints[0].label, '我的声音');
});

test('multiple voiceprints coexist; one matched input trains only its own row without a completed turn', (t) => {
  const f = fixture(t);
  f.add('a', [1, 0], 3000);
  const a = f.workflow.create({ label: '甲' });
  f.add('b', [0, 1], 3000);
  const b = f.workflow.create({ label: '乙' });
  assert.equal(b.ok, true);
  assert.notEqual(a.speakerId, b.speakerId);
  const input = { utteranceId: 'short-input', speakerId: b.speakerId, decision: 'match',
    shadowQuality: 'ok', durationMs: 1000, embedding: new Float32Array([0.1, 0.99]) };
  assert.equal(f.workflow.train(input).trained, true);
  assert.equal(f.library.get(a.speakerId).activeCount, 1);
  assert.equal(f.library.get(b.speakerId).activeCount, 2);
  assert.equal(f.workflow.train(input).trained, false, 'repeated callback is not another sample');
  assert.equal(f.candidates.list().length, 0);
  assert.equal(f.enrollment.getConfirmedSelf().speakerId, a.speakerId, 'existing profile identity is preserved');
});

test('rename and delete preserve other voiceprints; a late match never recreates a deleted one', (t) => {
  const f = fixture(t);
  f.add('a', [1, 0], 3000); const a = f.workflow.create({ label: '甲' });
  f.add('b', [0, 1], 3000); const b = f.workflow.create({ label: '乙' });
  assert.equal(f.workflow.rename(b.speakerId, '新名称').ok, true);
  assert.equal(f.library.get(b.speakerId).label, '新名称');
  assert.equal(f.workflow.remove(b.speakerId).ok, true);
  assert.equal(f.library.get(b.speakerId), null);
  assert.equal(f.library.get(a.speakerId).label, '甲');
  assert.equal(f.workflow.train({ decision: 'match', speakerId: b.speakerId,
    utteranceId: 'late', shadowQuality: 'ok', embedding: new Float32Array([0, 1]) }).ok, false);
  f.add('c', [0, 1], 3000);
  const c = f.workflow.create({ label: '重建' });
  assert.equal(c.ok, true); assert.notEqual(c.speakerId, b.speakerId);
});

test('empty, short or inconsistent pools do not write a voiceprint or consume audio', (t) => {
  const f = fixture(t);
  assert.equal(f.workflow.create().ok, false);
  f.add('a'); assert.equal(f.workflow.create().reason, 'insufficient-samples');
  f.add('b', [0, 1], 3000);
  assert.equal(f.workflow.create().reason, 'inconsistent');
  assert.equal(f.library.list().length, 0); assert.equal(f.candidates.list().length, 2);
});

test('failed confirmation rolls back the new library row and enrollment; candidates remain usable', (t) => {
  const f = fixture(t); f.add('a', [1, 0], 3000);
  const broken = createSpeakerWorkflow({ library: f.library, candidates: f.candidates,
    enrollment: { ...f.enrollment, confirm: () => ({ ok: false, reason: 'write-failed' }) } });
  assert.equal(broken.create().ok, false);
  assert.equal(f.library.list().length, 0);
  assert.equal(f.enrollment.read().entries.length, 0);
  assert.equal(f.candidates.list().length, 1);
  assert.equal(f.workflow.create().ok, true);
});

test('failed pool cleanup cannot create the same voiceprint again on retry', (t) => {
  const f = fixture(t); f.add('one', [1, 0], 3000);
  const broken = createSpeakerWorkflow({ library: f.library, enrollment: f.enrollment,
    candidates: { ...f.candidates, remove: () => ({ ok: false, reason: 'write-failed' }) } });
  const saved = broken.create();
  assert.equal(saved.ok, true); assert.equal(saved.cleanupPending.length, 1);
  assert.equal(f.workflow.create().reason, 'candidate-cleanup-pending');
  assert.equal(f.library.list().length, 1);
});
