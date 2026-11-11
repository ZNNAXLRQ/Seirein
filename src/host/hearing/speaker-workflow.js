/** Candidate-pool creation and incremental training for independently managed voiceprints. */
import { randomUUID } from 'node:crypto';
import { decodeEmbedding } from './speaker-candidates.js';
import { buildSpeakerTemplate, cosineSimilarity } from './speaker-template.js';

/** Only metadata crosses the settings boundary. */
export function voiceprintView(row) {
  return { speakerId: row.speakerId, label: row.label, enabled: row.enabled,
    sampleCount: row.activeCount, createdAt: row.createdAt };
}

/**
 * The caller owns the stores. Creation consumes only its snapshot of the pool, after saving;
 * a clear match trains that exact live identity, never another voiceprint or the candidate pool.
 */
export function createSpeakerWorkflow({ library, candidates, enrollment, log = null }) {
  const trained = new Map();
  const note = (type, data) => {
    try { Promise.resolve(log?.emit?.(type, data)).catch(() => {}); } catch { /* logging is optional */ }
  };
  const list = () => ({ ok: true, voiceprints: library.list().map(voiceprintView) });
  const create = ({ label = '' } = {}) => {
    const name = String(label).trim() || '新声纹';
    if ([...name].length > 40) return { ok: false, reason: 'label-too-long' };
    const rows = candidates.list();
    if (rows.length === 0) return { ok: false, reason: 'empty-candidates' };
    const before = enrollment.read();
    const consumed = new Set(before.entries.flatMap(entry => entry.samples.map(sample => sample.sampleId)));
    if (rows.some(row => consumed.has(`voice-utterance:${row.utteranceId}`))) {
      return { ok: false, reason: 'candidate-cleanup-pending' };
    }
    const built = buildSpeakerTemplate(rows.map(row => ({
      ...row, embedding: decodeEmbedding(row.embedding),
    })));
    if (!built.ok) return built;
    if (built.totalDurationMs < 3000) {
      return { ok: false, reason: 'insufficient-samples', requiredMs: 3000,
        sampleCount: Number(built.sampleCount) || rows.length,
        totalDurationMs: built.totalDurationMs };
    }
    const speakerId = `voiceprint-${randomUUID()}`;
    const db = library.open();
    let enrollmentTouched = false;
    try {
      db.exec('SAVEPOINT speaker_pool_create');
      const registered = library.register(speakerId, built.vector, { label: name, enabled: true });
      if (!registered.ok) throw new Error(registered.reason);
      db.prepare('UPDATE speaker_template SET active_count = ? WHERE speaker_id = ?')
        .run(rows.length, speakerId);
      const merged = enrollment.mergeSamples({ speakerId, samples: rows.map(row => ({
        label: name, sampleRef: `voice-utterance:${row.utteranceId}`,
        durationMs: row.durationMs, source: 'mic', at: row.at,
      })) });
      if (!merged.ok) throw new Error(merged.reason);
      enrollmentTouched = true;
      const confirmed = enrollment.confirm({ speakerId });
      if (!confirmed.ok) throw new Error(confirmed.reason);
      db.exec('RELEASE speaker_pool_create');
    } catch (error) {
      try { db.exec('ROLLBACK TO speaker_pool_create'); db.exec('RELEASE speaker_pool_create'); }
      catch { /* report the failure; never consume candidate audio */ }
      if (enrollmentTouched) enrollment.write(before);
      return { ok: false, reason: 'create-failed', error: error?.message ?? String(error) };
    }
    const cleanupPending = [];
    for (const row of rows) {
      if (candidates.remove(row.id)?.ok !== true) cleanupPending.push(row.id);
    }
    note('speaker.voiceprint.created', { speakerId, sampleCount: rows.length,
      totalDurationMs: built.totalDurationMs, cleanupPending: cleanupPending.length });
    note('speaker.candidates.built', { speakerId, sampleCount: rows.length,
      totalDurationMs: built.totalDurationMs, created: true,
      cleanupPending: cleanupPending.length });
    return { ok: true, speakerId, sampleCount: rows.length,
      totalDurationMs: built.totalDurationMs, cleanupPending, created: true,
      selfId: enrollment.getConfirmedSelf()?.speakerId ?? speakerId,
      voiceprint: voiceprintView(library.get(speakerId)) };
  };
  const trainSample = (sample) => {
    const id = typeof sample?.speakerId === 'string' ? sample.speakerId : '';
    if (sample?.decision !== 'match' || id === '') return { ok: false, reason: 'not-matched' };
    const utteranceId = typeof sample.utteranceId === 'string' ? sample.utteranceId : '';
    if (utteranceId === '') return { ok: false, reason: 'utterance-id-required' };
    // An utterance is accepted at most once, even if a late retry names another identity.
    if (trained.has(utteranceId)) return { ok: true, trained: false, reason: 'duplicate-utterance' };
    const current = library.get(id);
    if (current === null || current.enabled !== true) return { ok: false, reason: 'speaker-unavailable' };
    if (sample.shadowQuality !== 'ok') return { ok: false, reason: 'quality' };
    const score = Number(sample.score);
    if (Number.isFinite(score) && score < 0.75) return { ok: false, reason: 'score' };
    const durationMs = Number(sample.durationMs);
    if (Number.isFinite(durationMs) && (durationMs < 800 || durationMs > 15000)) {
      return { ok: false, reason: 'duration' };
    }
    if (!(sample.embedding instanceof Float32Array)
      || !(current.embedding instanceof Float32Array)) {
      return { ok: false, reason: 'invalid-embedding' };
    }
    // One short utterance may only update the row it actually resembles. This is a consistency
    // gate, not an attribution decision: the shadow already chose this speakerId.
    const baseCosine = cosineSimilarity(current.embedding, sample.embedding);
    if (!Number.isFinite(baseCosine) || baseCosine < 0.8) {
      return { ok: false, reason: 'base-consistency' };
    }
    const result = library.register(id, sample.embedding, { label: current.label, enabled: true });
    if (!result.ok) return result;
    trained.set(utteranceId, id);
    while (trained.size > 2048) trained.delete(trained.keys().next().value);
    note('speaker.auto.trained', { speakerId: id, utteranceId, durationMs: sample.durationMs,
      score: Number.isFinite(score) ? score : null, baseCosine,
      activeCount: result.activeCount });
    return { ...result, trained: true };
  };
  const train = (sample) => {
    try { return trainSample(sample); }
    catch { return { ok: false, reason: 'train-failed' }; }
  };
  const remove = (speakerId) => {
    const before = enrollment.read();
    const db = library.open();
    try {
      db.exec('SAVEPOINT speaker_voiceprint_remove');
      const result = library.remove(speakerId);
      if (!result.ok) { db.exec('RELEASE speaker_voiceprint_remove'); return result; }
      const removed = enrollment.removeEntry({ speakerId });
      if (!removed.ok && removed.reason !== 'not-found') throw new Error(removed.reason);
      db.exec('RELEASE speaker_voiceprint_remove');
      note('speaker.voiceprint.removed', { speakerId });
      return { ok: true, speakerId };
    } catch (error) {
      try { db.exec('ROLLBACK TO speaker_voiceprint_remove'); db.exec('RELEASE speaker_voiceprint_remove'); }
      catch { /* return a controlled failure */ }
      enrollment.write(before);
      return { ok: false, reason: 'remove-failed', error: error?.message ?? String(error) };
    }
  };
  const rename = (speakerId, label) => {
    const name = typeof label === 'string' ? label.trim() : '';
    if (!name || [...name].length > 40) return { ok: false, reason: 'invalid-label', speakerId };
    if (library.get(speakerId) === null) return { ok: false, reason: 'not-found', speakerId };
    const before = enrollment.read();
    const db = library.open();
    try {
      db.exec('SAVEPOINT speaker_voiceprint_rename');
      db.prepare('UPDATE speaker_template SET label = ?, updated_at = ? WHERE speaker_id = ?')
        .run(name, new Date().toISOString(), speakerId);
      const next = structuredClone(before);
      const entry = next.entries.find(row => row.speakerId === speakerId);
      if (entry) { entry.label = name; enrollment.write(next); }
      db.exec('RELEASE speaker_voiceprint_rename');
      note('speaker.renamed', { speakerId, labelChars: [...name].length });
      return { ok: true, speakerId, label: name };
    } catch {
      try { db.exec('ROLLBACK TO speaker_voiceprint_rename'); db.exec('RELEASE speaker_voiceprint_rename'); }
      catch { /* report the failed rename */ }
      enrollment.write(before);
      return { ok: false, reason: 'write-failed' };
    }
  };
  return { list, create, train, remove, rename };
}
