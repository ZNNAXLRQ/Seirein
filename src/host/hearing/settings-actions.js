/** Settings actions for microphone, ambient capture, speaker shadow and call mode. */

import {
  LEXICON_CATEGORIES,
  LEXICON_CATEGORY_MAX_CHARS,
  LEXICON_LIBRARIES,
  LEXICON_READING_MAX_CHARS,
  LEXICON_TEXT_MAX_CHARS,
  LEXICON_USAGE_MAX_CHARS,
} from '../speech/lexicon-store.js';
import { lexiconKey } from '../speech/lexicon-candidates.js';
import { decodeEmbedding } from './speaker-candidates.js';
import { buildSpeakerTemplate } from './speaker-template.js';
import {
  createVersion,
  createVersionState,
  nextVersion,
  rollback as rollbackTemplateVersion,
} from './speaker-template-version.js';

export const ACTIONS = Object.freeze([
  'hearing.start',
  'hearing.autoListen',
  'voice.speakerShadow',
  /** Opt-in, short-lived diagnosis clips: the switch is `voice.audioRetention`, off by default. */
  'voice.audioRetention',
  'audio.retention.list',
  'audio.retention.delete',
  'audio.retention.export',
  /** Shared lexicon: candidates come from conversation, only an explicit confirm makes a word. */
  'lexicon.list',
  'lexicon.candidates',
  'lexicon.confirm',
  'lexicon.add',
  'lexicon.update',
  'lexicon.move',
  'lexicon.edit',
  'lexicon.reject',
  'lexicon.remove',
  'hearing.threshold',
  'hearing.device',
  'hearing.devices.refresh',
  'ambient.start',
  'ambient.autoListen',
  'ambient.stop',
  'call.mode',
  'call.names.add',
  'call.names.remove',
  'call.names.toggle',
  'hearing.stop',
  /** Candidate → base voiceprint. Only an explicit build writes the library/enrollment/self. */
  'speaker.candidates.list',
  'speaker.candidates.audio',
  'speaker.candidates.remove',
  'speaker.candidates.clear',
  'speaker.candidates.preview',
  'speaker.candidates.build',
  'speaker.voiceprints.remove',
  'speaker.voiceprints.rename',
  'speaker.rename',
  /** Explicit version-chain writes. They never run on their own and never become candidates. */
  'speaker.template.status',
  'speaker.template.strengthen',
  'speaker.template.rollback',
]);

/** The one speaker id this host may create for the user's own base voiceprint. */
export const SPEAKER_BASE_ID = 'self';
/** Required total candidate audio before `speaker.candidates.build` may write anything. */
export const SPEAKER_BUILD_MIN_TOTAL_MS = 3000;
/** Library labels are display-only and bounded; the speakerId is never part of a rename. */
export const SPEAKER_LABEL_MAX_CHARS = 40;
const SPEAKER_BASE_LABEL = '本人';

function speakerActionText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** One bounded label. `fallback` is only for the build path; a rename stays non-empty. */
function prepareSpeakerLabel(value, { fallback = '', required = false } = {}) {
  const raw = speakerActionText(value);
  const label = raw.length > 0 ? raw : fallback;
  if (label.length === 0 && required) return { ok: false, reason: 'label-required' };
  if ([...label].length > SPEAKER_LABEL_MAX_CHARS) {
    return { ok: false, reason: 'label-too-long', max: SPEAKER_LABEL_MAX_CHARS };
  }
  return { ok: true, label };
}

/** Metadata only: the vector, active timestamps and file paths never reach a settings card. */
function speakerLibraryEntryView(entry) {
  if (entry === null || entry === undefined) {
    return { present: false, speakerId: SPEAKER_BASE_ID, label: '', enabled: false, activeCount: 0, dim: 0 };
  }
  return {
    present: true,
    speakerId: speakerActionText(entry.speakerId),
    label: typeof entry.label === 'string' ? entry.label : '',
    enabled: entry.enabled === true,
    activeCount: Number.isFinite(Number(entry.activeCount)) ? Math.max(0, Math.round(Number(entry.activeCount))) : 0,
    dim: Number.isFinite(Number(entry.dim)) ? Math.max(0, Math.round(Number(entry.dim))) : 0,
  };
}

/** One version as the card may see it: no vector, no embedding, no path. */
function speakerTemplateVersionView(record) {
  return {
    version: Math.max(1, Math.round(Number(record?.version) || 0)),
    sampleCount: Math.max(0, Math.round(Number(record?.sampleCount) || 0)),
    totalDurationMs: Number.isFinite(Number(record?.totalDurationMs))
      ? Math.max(0, Number(record.totalDurationMs))
      : 0,
    createdAt: record?.createdAt ?? null,
    reason: typeof record?.reason === 'string' ? record.reason : '',
    parentVersion: record?.parentVersion === null || record?.parentVersion === undefined
      ? null
      : Math.max(1, Math.round(Number(record.parentVersion) || 0)),
  };
}

/**
 * Read-only and fail-closed safe view of the persisted chain. A missing store is `unavailable`;
 * a bad/corrupt file is already normalized to an empty chain by the store, never thrown here.
 */
function speakerTemplateStatusOf(store) {
  if (store === null || typeof store?.read !== 'function') {
    return { ok: false, reason: 'unavailable' };
  }
  let state;
  try {
    state = store.read();
  } catch {
    return { ok: false, reason: 'template-read-failed' };
  }
  const versions = Array.isArray(state?.versions)
    ? state.versions.map(speakerTemplateVersionView)
    : [];
  const currentVersion = versions.some((record) => record.version === state?.currentVersion)
    ? state.currentVersion
    : null;
  return {
    ok: true,
    currentVersion,
    versions,
    canRollback: versions.some((record) => record.version !== currentVersion),
  };
}

/** Trim, validate and de-duplicate a template action's ids, preserving request order. */
function prepareSpeakerTemplateIds(value) {
  if (!Array.isArray(value)) return { ok: false, reason: 'invalid-ids' };
  const ids = [];
  const seen = new Set();
  for (const raw of value) {
    if (typeof raw !== 'string') return { ok: false, reason: 'invalid-id' };
    const id = raw.trim();
    if (id.length === 0) return { ok: false, reason: 'invalid-id' };
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length > 20) return { ok: false, reason: 'too-many-ids', max: 20 };
  }
  if (ids.length === 0) return { ok: false, reason: 'no-ids' };
  return { ok: true, ids };
}

/**
 * Decode the selected candidate rows into the sample shape the version module consumes.
 * Only the id/embedding/duration cross this seam; a candidate's speakerId is deliberately ignored.
 */
function speakerTemplateSamplesOf(store, ids) {
  let candidates;
  try {
    candidates = store.list();
  } catch {
    return { ok: false, reason: 'store-failed' };
  }
  if (!Array.isArray(candidates)) return { ok: false, reason: 'store-failed' };
  const byId = new Map();
  for (const candidate of candidates) {
    const id = speakerActionText(candidate?.id);
    if (id.length > 0 && !byId.has(id)) byId.set(id, candidate);
  }
  const samples = [];
  for (const id of ids) {
    const candidate = byId.get(id);
    if (candidate === undefined) return { ok: false, reason: 'candidate-not-found', id };
    const encoded = speakerActionText(candidate.embedding);
    if (encoded.length === 0) return { ok: false, reason: 'missing-embedding', id };
    const embedding = decodeEmbedding(encoded);
    if (embedding === null) return { ok: false, reason: 'invalid-embedding', id };
    const durationMs = Math.round(Number(candidate.durationMs));
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      return { ok: false, reason: 'invalid-duration', id };
    }
    samples.push({ id, embedding, durationMs });
  }
  if (samples.length === 0) return { ok: false, reason: 'no-ids' };
  return { ok: true, samples };
}

/**
 * Make the library's `self` row carry exactly one version vector.
 *
 * `SpeakerLibrary.register()` folds an embedding into a running average, which is right for
 * enrolling a new sample but wrong for restoring a version: an averaged rollback would not equal
 * the version the user selected. The version chain is authoritative here, so this helper still
 * calls `register()` (created/retired/dim/event rules live there) and then, inside a savepoint,
 * overwrites the stored BLOB with the exact unit vector. A newly created row already equals the
 * vector and needs no second write. On any failure the savepoint rolls both writes back.
 *
 * @returns {{ok: true, created: boolean, activeCount: number}|{ok: false, reason: string}}
 */
function applySpeakerLibraryTemplate(library, vector, label) {
  if (library === null || typeof library?.register !== 'function') {
    return { ok: false, reason: 'unavailable' };
  }
  let existing = null;
  const canRead = typeof library.get === 'function';
  if (canRead) {
    try {
      existing = library.get(SPEAKER_BASE_ID);
    } catch {
      return { ok: false, reason: 'library-failed' };
    }
  }
  if (existing !== null && existing !== undefined) {
    const dim = Number(existing.dim);
    if (Number.isFinite(dim) && dim > 0 && dim !== vector.length) {
      return { ok: false, reason: 'dim-mismatch' };
    }
  }
  const effectiveLabel = label.length > 0
    ? label
    : (typeof existing?.label === 'string' ? existing.label : '');

  let db = null;
  if (typeof library.open === 'function') {
    try {
      db = library.open();
    } catch {
      return { ok: false, reason: 'library-failed' };
    }
  }
  const canExact = db !== null && typeof db?.exec === 'function'
    && typeof db?.prepare === 'function';
  const existingPresent = canRead && existing !== null && existing !== undefined;

  let savepoint = false;
  if (canExact) {
    try {
      db.exec('SAVEPOINT speaker_template_apply');
      savepoint = true;
    } catch {
      return { ok: false, reason: 'library-failed' };
    }
  }
  try {
    const registered = library.register(SPEAKER_BASE_ID, vector, {
      label: effectiveLabel,
      enabled: true,
    });
    if (registered?.ok !== true) {
      throw Object.assign(new Error('register failed'), {
        speakerReason: typeof registered?.reason === 'string' && registered.reason.length > 0
          ? registered.reason
          : 'library-failed',
      });
    }
    // A caller-provided library without `open()`/prepare() cannot be overwritten exactly; it is
    // still allowed to accept the registered vector, but the real Host library always takes the
    // exact branch below (version restore must not become a running average).
    if (existingPresent && canExact) {
      const blob = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
      const result = db.prepare(
        `UPDATE speaker_template
            SET label = ?, dim = ?, embedding = ?, updated_at = ?, enabled = 1
          WHERE speaker_id = ?`,
      ).run(
        effectiveLabel,
        vector.length,
        blob,
        new Date().toISOString(),
        SPEAKER_BASE_ID,
      );
      if (!(Number(result?.changes) > 0)) {
        throw Object.assign(new Error('template update failed'), {
          speakerReason: 'library-failed',
        });
      }
    }
    if (savepoint) db.exec('RELEASE speaker_template_apply');
    return {
      ok: true,
      created: !existingPresent,
      activeCount: Math.max(0, Math.round(Number(registered.activeCount) || 0)),
    };
  } catch (error) {
    if (savepoint) {
      try {
        db.exec('ROLLBACK TO speaker_template_apply');
        db.exec('RELEASE speaker_template_apply');
      } catch {
        /* the connection already unwound it */
      }
    }
    return {
      ok: false,
      reason: typeof error?.speakerReason === 'string' && error.speakerReason.length > 0
        ? error.speakerReason
        : 'library-failed',
    };
  }
}

export function createHearingSettingsActions(services) {
  /**
   * The one diagnosis-clip store. The Host owns it (one per plugin root); a live capture session
   * is the fallback, so the actions keep working even when only the session created the store.
   */
  const retentionStore = () => services.retentionStore ?? services.hearing?.retention ?? null;
  const RETENTION_UNAVAILABLE = Object.freeze({
    ok: false,
    code: 'AUDIO_RETENTION_UNAVAILABLE',
    error: '音频诊断保留尚未接线：需要 Host 提供 retention 存储',
  });
  /**
   * The lexicon store the Host owns (one per plugin root). Every action here is a thin
   * pass-through: the store decides the ambiguous/tombstone/ownership rules, and nothing is
   * auto-confirmed by listing or by a candidate arriving from a transcript. `public` is shared;
   * `voiceprint` is personal and only written while a confirmed self exists.
   */
  const lexiconStore = () => services.lexiconStore ?? null;
  const LEXICON_UNAVAILABLE = Object.freeze({
    ok: false,
    code: 'LEXICON_UNAVAILABLE',
    error: '共享语言库尚未接线：需要 Host 提供 lexicon 存储',
  });
  /**
   * Validate the optional `library` argument before the store is called, so the refusal code is
   * stable across store implementations: an unknown slot is `invalid-library`, and the personal
   * slot without a confirmed self is `self-required` (`undefined` keeps the store's default slot).
   */
  const lexiconLibraryOf = (value) => {
    if (value === undefined || value === null) return { ok: true, library: undefined };
    if (typeof value !== 'string' || !LEXICON_LIBRARIES.includes(value)) {
      return { ok: false, library: null };
    }
    return { ok: true, library: value };
  };
  /**
   * Candidate → voiceprint depends on three host-owned pieces: the candidate store/actions, the
   * one shared SpeakerLibrary (`<root>/memory/speaker.db`) and the enrollment store. A missing one
   * is a controlled refusal before any file or database write.
   */
  const candidateActions = () => services.speakerCandidateActions ?? null;
  const candidateStore = () => services.speakerCandidatesStore ?? null;
  const speakerLibrary = () => services.speakerLibrary ?? null;
  const speakerWorkflow = () => services.speakerWorkflow ?? null;
  const enrollmentStore = () => services.speakerEnrollmentStore ?? null;
  const templateStore = () => services.speakerTemplateStore ?? null;
  const SPEAKER_CANDIDATES_UNAVAILABLE = Object.freeze({
    ok: false,
    reason: 'unavailable',
    error: '声纹候选尚未接线：需要 Host 提供候选、声纹库与登记存储',
  });
  const SPEAKER_TEMPLATE_UNAVAILABLE = Object.freeze({
    ok: false,
    reason: 'unavailable',
    error: '声纹模板版本尚未接线：需要 Host 提供版本存储与声纹库',
  });
  const speakerEvent = async (type, payload) => {
    try {
      await services.log?.emit?.(type, payload);
    } catch {
      /* diagnostics must never change the action result */
    }
  };
  const librarySelfView = () => {
    const library = speakerLibrary();
    if (library === null || typeof library.get !== 'function') return null;
    try {
      return speakerLibraryEntryView(library.get(SPEAKER_BASE_ID));
    } catch {
      return null;
    }
  };
  const enrollmentSelfId = () => {
    const store = enrollmentStore();
    if (store === null || typeof store.getConfirmedSelf !== 'function') return '';
    try {
      return speakerActionText(store.getConfirmedSelf()?.speakerId);
    } catch {
      return '';
    }
  };
  const handler = async (body) => {
    switch (body.action) {
      case 'hearing.start': {
        // A container action opens its component first (and records the permission), then starts.
        const opened = await (0, services.openContainer)('hearing', 'hearing.start');
        if (!opened.ok) return { ok: false, code: 'FEATURE_DISABLED', feature: 'hearing', error: opened.error ?? '听觉组件无法启用' };
        const result = await (0, services.startListening)(body.device);
        return {
          ok: result.ok,
          // The instance that actually opened: the card and the logs can name the same capture.
          ...(result.ok ? { instanceId: result.instanceId ?? '', device: result.device ?? '' } : {}),
          error: result.error ?? '',
          ...(result.ok ? {} : { code: 'START_FAILED', feature: 'hearing' }),
        };
      }
      case 'hearing.autoListen': {
        const enabled = body.enabled === true;
        const next = { ...(0, services.componentSettings)('hearing'), enabled: (0, services.componentSettings)('hearing').enabled !== false, autoListen: enabled };
        services.runtime.hearing = next;
        (0, services.writeSettings)({ hearing: next });
        if (enabled) services.hearingAutostart?.schedule();
        else services.hearingAutostart?.cancel();
        await services.log.emit('hearing.autoListen', { enabled, source: 'settings' });
        return { ok: true, autoListen: enabled };
      }
      case 'voice.speakerShadow': {
        // Observation switch only: persist, start the T1 download when needed, and make the
        // RUNNING capture follow the switch. A session opened before the switch has no
        // `onSpeakerSample`, so its status says `candidateAttached:false`; restarting only in that
        // (or the reverse detach) case re-wires the current session without disturbing a session
        // that is already in the requested state. A failed download leaves the shadow inactive; it
        // never blocks capture or delivery.
        const enabled = body.enabled === true;
        const running = services.hearing != null;
        const attached = running && services.speakerCandidateAttached === true;
        (0, services.writeSettings)({ voice: { ...(0, services.storedVoice)(), speakerShadow: enabled } });
        await services.log.emit(enabled ? 'speaker.enabled' : 'speaker.disabled', { source: 'settings' });
        if (enabled) (0, services.startSpeakerDownload)();
        let restarted = false;
        let restartError = '';
        if (running && (enabled ? !attached : attached)) {
          const device = services.hearing.device;
          await (0, services.stopListening)();
          // The same microphone is reopened: on enable it now receives `onSpeakerSample`, on
          // disable it is opened without the callback. Turning the shadow off must not keep
          // computing embeddings for a lane the user has switched off.
          const started = await (0, services.startListening)(device);
          restarted = started.ok === true;
          if (!started.ok) restartError = started.error ?? 'START_FAILED';
        }
        (0, services.emitSpeakerStatus)(true);
        return {
          ok: true,
          enabled,
          model: (0, services.speakerModelState)(),
          restarted,
          attached: services.speakerCandidateAttached === true,
          collecting: services.speakerCandidateCollecting === true,
          ...(restartError === '' ? {} : { restartError }),
        };
      }
      case 'voice.audioRetention': {
        // Opt-in diagnosis clips, off by default. The switch is persisted first; a running store
        // follows it live, so an enabled capture starts keeping suspicious clips without a restart.
        // Turning it off stops new writes — nothing is deleted behind the user's back.
        const enabled = body.enabled === true;
        (0, services.writeSettings)({ voice: { ...(0, services.storedVoice)(), audioRetention: enabled } });
        const store = retentionStore();
        store?.setEnabled?.(enabled);
        await services.log.emit('hearing.audio.retention', { enabled, source: 'settings' });
        return { ok: true, enabled, limits: store?.limits ?? null, status: store?.status?.() ?? null };
      }
      case 'audio.retention.list': {
        // Entries only: time / utteranceId / rms / vad / text / reason / bytes. Never audio bytes.
        const store = retentionStore();
        if (store === null) return RETENTION_UNAVAILABLE;
        return store.list();
      }
      case 'audio.retention.delete': {
        const store = retentionStore();
        if (store === null) return RETENTION_UNAVAILABLE;
        if (body.all === true || body.id === 'all') return store.deleteAll();
        const id = String(body.id ?? '');
        if (id === '') return { ok: false, error: '需要 id 或 all=true' };
        return store.deleteOne(id);
      }
      case 'audio.retention.export': {
        // A file path for the settings page to play; the audio itself never travels in an event.
        const store = retentionStore();
        if (store === null) return RETENTION_UNAVAILABLE;
        const id = String(body.id ?? '');
        if (id === '') return { ok: false, error: '需要 id' };
        return store.exportPath(id);
      }
      case 'lexicon.list': {
        const store = lexiconStore();
        if (store === null) return LEXICON_UNAVAILABLE;
        // Pending candidates stay visible even when already attributed: `unassigned` keeps the
        // unassigned area AND the assigned-but-unconfirmed corrections (each carries
        // `assigned:true`), so neither row is lost; `candidates` is the same full pending set.
        // `entries` is the administration view: every confirmed row, public and voiceprint. The
        // per-speaker effective view is the store's `listActive()` and is not exposed here.
        const candidates = store.listCandidates();
        return { ok: true, entries: store.listConfirmed(), unassigned: candidates, candidates };
      }
      case 'lexicon.candidates': {
        const store = lexiconStore();
        if (store === null) return LEXICON_UNAVAILABLE;
        return { candidates: store.listCandidates() };
      }
      case 'lexicon.confirm': {
        const store = lexiconStore();
        if (store === null) return LEXICON_UNAVAILABLE;
        // speakerId is optional provenance: normalise a supplied identity (string or finite number)
        // and forward null when absent/blank, so an empty string never reaches the stored entry.
        const rawSpeakerId = body.speakerId;
        const speakerId = typeof rawSpeakerId === 'string'
          ? (rawSpeakerId.trim() === '' ? null : rawSpeakerId.trim())
          : (rawSpeakerId ?? null);
        const result = store.confirm({
          text: body.text ?? '',
          id: body.id,
          speakerId,
          canonical: body.canonical,
          context: body.context,
        });
        if (result.ok) {
          await services.log.emit('lexicon.confirmed', {
            id: result.entry?.id ?? '',
            kind: result.entry?.kind ?? '',
            assigned: result.entry?.assigned === true,
          });
        }
        return result;
      }
      case 'lexicon.add': {
        const store = lexiconStore();
        if (store === null) return LEXICON_UNAVAILABLE;
        // Manual add is confirmed immediately. `public` is open to everyone; `voiceprint` is
        // personal and therefore needs the confirmed self and writes that same speakerId.
        const requested = lexiconLibraryOf(body.library);
        if (requested.ok !== true) return { ok: false, reason: 'invalid-library' };
        const selfId = enrollmentSelfId();
        if (requested.library === 'voiceprint' && selfId === '') {
          return { ok: false, reason: 'self-required' };
        }
        const result = store.addEntry({
          text: body.text,
          canonical: body.canonical,
          category: body.category,
          usage: body.usage,
          reading: body.reading,
          library: requested.library,
          speakerId: requested.library === 'voiceprint' ? selfId : undefined,
        });
        if (result.ok) {
          await services.log.emit('lexicon.added', {
            id: result.entry?.id ?? '',
            category: result.entry?.category ?? 'unknown',
            library: result.entry?.library ?? 'public',
          });
        }
        return result;
      }
      case 'lexicon.update': {
        const store = lexiconStore();
        if (store === null) return LEXICON_UNAVAILABLE;
        // The main edit form may also change the library; the same self gate applies as for move.
        const requested = lexiconLibraryOf(body.library);
        if (requested.ok !== true) return { ok: false, reason: 'invalid-library' };
        const selfId = enrollmentSelfId();
        if (requested.library === 'voiceprint' && selfId === '') {
          return { ok: false, reason: 'self-required' };
        }
        const result = store.updateEntry({
          id: body.id,
          text: body.text,
          canonical: body.canonical,
          category: body.category,
          usage: body.usage,
          reading: body.reading,
          library: requested.library,
          speakerId: requested.library === 'voiceprint' ? selfId : undefined,
        });
        if (result.ok) {
          await services.log.emit('lexicon.updated', {
            id: result.entry?.id ?? '',
            category: result.entry?.category ?? 'unknown',
            library: result.entry?.library ?? 'public',
          });
        }
        return result;
      }
      case 'lexicon.move': {
        const store = lexiconStore();
        if (store === null) return LEXICON_UNAVAILABLE;
        const requested = lexiconLibraryOf(body.library);
        if (requested.ok !== true || requested.library === undefined) {
          return { ok: false, reason: 'invalid-library' };
        }
        const selfId = enrollmentSelfId();
        if (requested.library === 'voiceprint' && selfId === '') {
          return { ok: false, reason: 'self-required' };
        }
        const result = store.moveEntry({
          id: body.id,
          library: requested.library,
          speakerId: requested.library === 'voiceprint' ? selfId : undefined,
        });
        if (result.ok) {
          await services.log.emit('lexicon.moved', {
            id: result.entry?.id ?? '',
            library: result.entry?.library ?? '',
          });
        }
        return result;
      }
      case 'lexicon.edit': {
        const store = lexiconStore();
        if (store === null) return LEXICON_UNAVAILABLE;
        const result = store.edit({
          id: body.id,
          canonical: body.canonical,
          wrongForms: body.wrongForms,
          context: body.context,
        });
        if (result.ok) {
          await services.log.emit('lexicon.edited', {
            id: result.entry?.id ?? '',
            kind: result.entry?.kind ?? '',
          });
        }
        return result;
      }
      case 'lexicon.reject':
      case 'lexicon.remove': {
        const store = lexiconStore();
        if (store === null) return LEXICON_UNAVAILABLE;
        const result = body.action === 'lexicon.reject'
          ? store.reject({ text: body.text ?? '', id: body.id })
          : store.remove({ text: body.text ?? '', id: body.id });
        if (result.ok) {
          await services.log.emit(
            body.action === 'lexicon.reject' ? 'lexicon.rejected' : 'lexicon.removed',
            { id: result.entry?.id ?? '' },
          );
        }
        return result;
      }
      case 'speaker.candidates.list': {
        const actions = candidateActions();
        const store = candidateStore();
        if (actions === null || store === null) return SPEAKER_CANDIDATES_UNAVAILABLE;
        // Grouping is a view, not an identity decision; it never touches speakerId or the library.
        let groupCount = 0;
        try {
          groupCount = store.groups().length;
        } catch {
          try {
            groupCount = Math.max(0, Math.round(Number(store.status()?.groupCount) || 0));
          } catch {
            groupCount = 0;
          }
        }
        const listed = actions.list();
        if (listed?.ok !== true) return listed;
        return {
          ...listed,
          groupCount,
          selfId: enrollmentSelfId(),
          voiceprints: speakerWorkflow()?.list()?.voiceprints ?? [],
          library: librarySelfView(),
          // Read-only version chain projection; a missing store is a controlled null, not a throw.
          template: speakerTemplateStatusOf(templateStore()),
        };
      }
      case 'speaker.candidates.audio': {
        const actions = candidateActions();
        if (actions === null) return SPEAKER_CANDIDATES_UNAVAILABLE;
        const result = actions.audio(body.id);
        if (result?.ok !== true) return result;
        return {
          ...result,
          dataUrl: `data:${result.mime};base64,${result.base64}`,
        };
      }
      case 'speaker.candidates.remove': {
        const actions = candidateActions();
        if (actions === null) return SPEAKER_CANDIDATES_UNAVAILABLE;
        return actions.remove(body.id);
      }
      case 'speaker.candidates.clear': {
        const actions = candidateActions();
        if (actions === null) return SPEAKER_CANDIDATES_UNAVAILABLE;
        return actions.clear();
      }
      case 'speaker.candidates.preview': {
        const actions = candidateActions();
        if (actions === null) return SPEAKER_CANDIDATES_UNAVAILABLE;
        // The UI gets decision evidence only; the vector stays host-side (`includeVector` omitted).
        const result = actions.preview(body.ids);
        if (result?.ok === false && result.reason === 'inconsistent') {
          await speakerEvent('speaker.candidates.preview.inconsistent', {
            sampleCount: Number(result.sampleCount) || 0,
            outlierCount: Array.isArray(result.outlierIds) ? result.outlierIds.length : 0,
          });
        }
        return result;
      }
      case 'speaker.voiceprints.remove': {
        const workflow = speakerWorkflow();
        if (workflow === null || workflow === undefined) return SPEAKER_CANDIDATES_UNAVAILABLE;
        return workflow.remove(speakerActionText(body.speakerId));
      }
      case 'speaker.voiceprints.rename': {
        const workflow = speakerWorkflow();
        if (workflow === null || workflow === undefined) return SPEAKER_CANDIDATES_UNAVAILABLE;
        const speakerId = speakerActionText(body.speakerId);
        const labelResult = prepareSpeakerLabel(body.label, { required: true });
        if (labelResult.ok !== true) return labelResult;
        return workflow.rename(speakerId, labelResult.label);
      }
      case 'speaker.candidates.build': {
        const workflow = speakerWorkflow();
        if (workflow !== null && workflow !== undefined) {
          // The explicit build consumes the WHOLE reviewed pool and creates a NEW independent
          // voiceprint. It never requires the old single `self` slot, so an existing voiceprint
          // does not block creating a second one.
          const label = speakerActionText(body.label);
          return workflow.create({ label });
        }
        const actions = candidateActions();
        const store = candidateStore();
        const library = speakerLibrary();
        const enrollment = enrollmentStore();
        if (actions === null || store === null || library === null || enrollment === null) {
          return SPEAKER_CANDIDATES_UNAVAILABLE;
        }
        const labelResult = prepareSpeakerLabel(body.label, { fallback: SPEAKER_BASE_LABEL });
        if (labelResult.ok !== true) return labelResult;
        const label = labelResult.label;

        // 1) Consistency + duration first, with the vector kept host-side. An inconsistent set or a
        // too-short set returns before the library, enrollment file or `self` is touched.
        const previewed = actions.preview(body.ids, { includeVector: true });
        if (previewed?.ok !== true) return previewed;
        const totalDurationMs = Math.max(0, Math.round(Number(previewed.totalDurationMs) || 0));
        if (totalDurationMs < SPEAKER_BUILD_MIN_TOTAL_MS) {
          return {
            ok: false,
            reason: 'insufficient-samples',
            sampleCount: Math.max(0, Math.round(Number(previewed.sampleCount) || 0)),
            totalDurationMs,
            requiredMs: SPEAKER_BUILD_MIN_TOTAL_MS,
          };
        }
        if (!Array.isArray(previewed.vector) || previewed.vector.length === 0
          || !previewed.vector.every((value) => Number.isFinite(Number(value)))) {
          return { ok: false, reason: 'template-failed' };
        }

        // Normalized ids (same trim/de-duplicate order the preview uses) for sample references.
        const ids = [];
        const seen = new Set();
        if (Array.isArray(body.ids)) {
          for (const raw of body.ids) {
            if (typeof raw !== 'string') continue;
            const id = raw.trim();
            if (id.length === 0 || seen.has(id)) continue;
            seen.add(id);
            ids.push(id);
          }
        }
        if (ids.length === 0) return { ok: false, reason: 'invalid-ids' };

        // An already-confirmed self is never overwritten by a candidate build.
        let beforeEnrollment = null;
        let currentSelf = null;
        try {
          beforeEnrollment = enrollment.read();
          currentSelf = enrollment.getConfirmedSelf();
        } catch {
          return { ok: false, reason: 'enrollment-failed' };
        }
        if (currentSelf !== null && currentSelf !== undefined) {
          return {
            ok: false,
            reason: 'already-confirmed',
            selfId: speakerActionText(currentSelf.speakerId),
          };
        }

        // The library row is read before any write; a broken library fails closed.
        try {
          if (typeof library.get !== 'function' || typeof library.register !== 'function'
            || typeof library.open !== 'function') {
            return { ok: false, reason: 'library-unavailable' };
          }
          library.get(SPEAKER_BASE_ID);
        } catch {
          return { ok: false, reason: 'library-failed' };
        }

        // 2) Candidate durations become the enrollment samples (one reference per candidate id).
        let candidates;
        try {
          candidates = store.list();
        } catch {
          return { ok: false, reason: 'store-failed' };
        }
        const byId = new Map();
        for (const candidate of candidates) {
          const id = speakerActionText(candidate?.id);
          if (id.length > 0 && !byId.has(id)) byId.set(id, candidate);
        }
        const samples = [];
        for (const id of ids) {
          const candidate = byId.get(id);
          if (candidate === undefined) return { ok: false, reason: 'candidate-not-found', id };
          const durationMs = Math.round(Number(candidate.durationMs));
          if (!Number.isFinite(durationMs) || durationMs <= 0) {
            return { ok: false, reason: 'invalid-duration', id };
          }
          samples.push({
            durationMs,
            source: 'mic',
            sampleRef: id,
            at: typeof candidate.at === 'string' ? candidate.at : undefined,
          });
        }

        const vector = Float32Array.from(previewed.vector.map((value) => Number(value)));
        if (vector.length !== previewed.vector.length) return { ok: false, reason: 'template-failed' };

        // A base build also seeds version 1, but an existing chain is never overwritten. The
        // store is optional here so direct/degraded callers keep the old build contract; the Host
        // always injects it.
        const templates = templateStore();
        let beforeTemplateState = null;
        let templateInitialized = false;
        if (templates !== null && typeof templates?.read === 'function') {
          try {
            beforeTemplateState = templates.read();
          } catch {
            beforeTemplateState = null;
          }
        }

        // 3) Library + enrollment are one unit: a SQLite savepoint rolls the template back and the
        // enrollment snapshot restores the JSON file byte-for-byte on any later failure.
        let db = null;
        try {
          db = library.open();
        } catch {
          return { ok: false, reason: 'library-failed' };
        }
        if (db === null || typeof db.exec !== 'function') return { ok: false, reason: 'library-unavailable' };
        const beforeFile = beforeEnrollment;
        let enrollmentTouched = false;
        let registered = null;
        try {
          db.exec('SAVEPOINT speaker_candidates_build');
          registered = library.register(SPEAKER_BASE_ID, vector, { label, enabled: true });
          if (registered?.ok !== true) {
            throw Object.assign(new Error('register failed'), {
              speakerReason: typeof registered?.reason === 'string' ? registered.reason : 'library-failed',
            });
          }
          const merged = enrollment.mergeSamples({ speakerId: SPEAKER_BASE_ID, samples });
          if (merged?.ok !== true) {
            throw Object.assign(new Error('merge failed'), {
              speakerReason: typeof merged?.reason === 'string' ? merged.reason : 'merge-failed',
            });
          }
          enrollmentTouched = true;
          const confirmed = enrollment.confirm({ speakerId: SPEAKER_BASE_ID });
          if (confirmed?.ok !== true) {
            throw Object.assign(new Error('confirm failed'), {
              speakerReason: typeof confirmed?.reason === 'string' ? confirmed.reason : 'confirm-failed',
              speakerExtra: {
                ...(Number.isFinite(Number(confirmed?.totalDurationMs))
                  ? { totalDurationMs: Number(confirmed.totalDurationMs) }
                  : {}),
                ...(Number.isFinite(Number(confirmed?.requiredMs))
                  ? { requiredMs: Number(confirmed.requiredMs) }
                  : {}),
              },
            });
          }
          // Seed v1 only after the library/enrollment writes succeeded, and only when the chain
          // is empty. A second explicit build must not rewrite an existing version 1.
          if (templates !== null && beforeTemplateState !== null
            && beforeTemplateState.versions.length === 0) {
            const createdAt = new Date().toISOString();
            const created = createVersion({
              version: 1,
              vector,
              sampleCount: previewed.sampleCount,
              totalDurationMs,
              createdAt,
              reason: 'initial',
              parentVersion: null,
            });
            if (created.ok !== true) {
              throw Object.assign(new Error('template version failed'), {
                speakerReason: typeof created.reason === 'string' ? created.reason : 'template-failed',
              });
            }
            const seeded = createVersionState(created.record);
            if (seeded.ok !== true) {
              throw Object.assign(new Error('template state failed'), {
                speakerReason: typeof seeded.reason === 'string' ? seeded.reason : 'template-failed',
              });
            }
            templates.write(seeded.state);
            templateInitialized = true;
          }
          db.exec('RELEASE speaker_candidates_build');
        } catch (error) {
          let rolledBack = false;
          try {
            db.exec('ROLLBACK TO speaker_candidates_build');
            db.exec('RELEASE speaker_candidates_build');
            rolledBack = true;
          } catch {
            rolledBack = false;
          }
          let enrollmentRestored = enrollmentTouched !== true;
          if (enrollmentTouched) {
            try {
              enrollment.write(beforeFile);
              enrollmentRestored = true;
            } catch {
              try {
                enrollment.removeEntry({ speakerId: SPEAKER_BASE_ID });
                enrollmentRestored = true;
              } catch {
                enrollmentRestored = false;
              }
            }
          }
          let templateRestored = templateInitialized !== true;
          if (templateInitialized) {
            try {
              templates.write(beforeTemplateState);
              templateRestored = true;
            } catch {
              templateRestored = false;
            }
          }
          const reason = typeof error?.speakerReason === 'string'
            ? error.speakerReason
            : 'write-failed';
          await speakerEvent('speaker.candidates.build.failed', {
            reason,
            rolledBack: rolledBack === true,
            enrollmentRestored: enrollmentRestored === true,
            ...(templateInitialized ? { templateRestored: templateRestored === true } : {}),
          });
          return {
            ok: false,
            reason,
            ...(error?.speakerExtra ?? {}),
            rolledBack: rolledBack === true,
            enrollmentRestored: enrollmentRestored === true,
            ...(templateInitialized ? { templateRestored: templateRestored === true } : {}),
          };
        }

        // 4) The action itself is the user's explicit confirmation; nothing here is automatic.
        let selfId = '';
        let stats = null;
        try {
          const confirmedSelf = enrollment.getConfirmedSelf();
          selfId = speakerActionText(confirmedSelf?.speakerId);
          stats = typeof enrollment.stats === 'function'
            ? enrollment.stats({ speakerId: SPEAKER_BASE_ID })
            : null;
        } catch {
          selfId = '';
          stats = null;
        }
        const libraryView = librarySelfView();
        await speakerEvent('speaker.candidates.built', {
          speakerId: SPEAKER_BASE_ID,
          sampleCount: samples.length,
          totalDurationMs,
          created: registered?.created === true,
        });
        return {
          ok: true,
          speakerId: SPEAKER_BASE_ID,
          label,
          selfId: selfId === '' ? SPEAKER_BASE_ID : selfId,
          sampleCount: samples.length,
          totalDurationMs,
          created: registered?.created === true,
          templateInitialized: templateInitialized === true,
          library: libraryView,
          enrollment: stats === null ? null : {
            speakerId: SPEAKER_BASE_ID,
            status: typeof stats.status === 'string' ? stats.status : 'confirmed',
            sampleCount: Math.max(0, Math.round(Number(stats.sampleCount) || 0)),
            totalDurationMs: Math.max(0, Math.round(Number(stats.totalDurationMs) || 0)),
          },
        };
      }
      case 'speaker.template.status': {
        const templates = templateStore();
        if (templates === null) return SPEAKER_TEMPLATE_UNAVAILABLE;
        return speakerTemplateStatusOf(templates);
      }
      case 'speaker.template.strengthen': {
        const actions = candidateActions();
        const store = candidateStore();
        const library = speakerLibrary();
        const templates = templateStore();
        if (actions === null || store === null || library === null || templates === null) {
          return SPEAKER_TEMPLATE_UNAVAILABLE;
        }
        const idsResult = prepareSpeakerTemplateIds(body.ids);
        if (idsResult.ok !== true) return idsResult;
        const labelResult = prepareSpeakerLabel(body.label);
        if (labelResult.ok !== true) return labelResult;

        // 1) Consistency first; the same gate the explicit build uses. Then decode the exact
        // candidate rows for the version module. A candidate's speakerId is never read here: a
        // selected clip is evidence, not an identity and never automatically `self`.
        const previewed = actions.preview(idsResult.ids);
        if (previewed?.ok !== true) return previewed;
        const samplesRead = speakerTemplateSamplesOf(store, idsResult.ids);
        if (samplesRead.ok !== true) return samplesRead;
        const samples = samplesRead.samples;
        const built = buildSpeakerTemplate(samples);
        if (built?.ok !== true) {
          const failure = {
            ok: false,
            reason: typeof built?.reason === 'string' && built.reason.length > 0
              ? built.reason
              : 'template-failed',
          };
          if (Number.isFinite(Number(built?.minPairCosine))) {
            failure.minPairCosine = Number(built.minPairCosine);
          }
          if (Array.isArray(built?.outlierIds)) failure.outlierIds = [...built.outlierIds];
          return failure;
        }

        let state;
        try {
          state = templates.read();
        } catch {
          return { ok: false, reason: 'template-read-failed' };
        }
        if (!Array.isArray(state?.versions) || state.versions.length === 0
          || state.currentVersion === null) {
          return { ok: false, reason: 'not-initialized' };
        }

        const options = {
          reason: 'strengthen',
          createdAt: new Date().toISOString(),
        };
        if (body.incomingWeight !== undefined) options.incomingWeight = body.incomingWeight;
        const next = nextVersion(state, samples, options);
        if (next?.ok !== true) return next;
        const record = next.state.versions.find((entry) => entry.version === next.version) ?? null;
        if (record === null) return { ok: false, reason: 'template-failed' };

        // 2) Persist the computed state first. If the library then refuses, the previous file is
        // restored, so a failed explicit action leaves neither a new version nor a changed library.
        try {
          templates.write(next.state);
        } catch {
          return { ok: false, reason: 'template-write-failed' };
        }
        const applied = applySpeakerLibraryTemplate(library, record.vector, labelResult.label);
        if (applied.ok !== true) {
          let restored = false;
          try {
            templates.write(state);
            restored = true;
          } catch {
            restored = false;
          }
          await speakerEvent('speaker.template.strengthen.failed', {
            reason: applied.reason,
            restored: restored === true,
          });
          return { ok: false, reason: applied.reason, restored };
        }

        await speakerEvent('speaker.template.strengthened', {
          version: record.version,
          previousVersion: state.currentVersion,
          sampleCount: record.sampleCount,
          totalDurationMs: record.totalDurationMs,
          created: applied.created === true,
        });
        return {
          ok: true,
          speakerId: SPEAKER_BASE_ID,
          version: record.version,
          previousVersion: state.currentVersion,
          sampleCount: record.sampleCount,
          totalDurationMs: record.totalDurationMs,
          batchSampleCount: samples.length,
          batchTotalDurationMs: built.totalDurationMs,
          createdAt: record.createdAt,
          reason: record.reason,
          library: librarySelfView(),
          canRollback: next.state.versions.some((entry) => entry.version !== record.version),
        };
      }
      case 'speaker.template.rollback': {
        const library = speakerLibrary();
        const templates = templateStore();
        if (library === null || templates === null) return SPEAKER_TEMPLATE_UNAVAILABLE;
        const version = Number(body.version);
        if (!Number.isSafeInteger(version) || version < 1) {
          return { ok: false, reason: 'invalid-version' };
        }
        let state;
        try {
          state = templates.read();
        } catch {
          return { ok: false, reason: 'template-read-failed' };
        }
        const rolled = rollbackTemplateVersion(state, version);
        if (rolled?.ok !== true) return rolled;

        const record = rolled.state.versions.find((entry) => entry.version === rolled.currentVersion)
          ?? null;
        if (record === null) return { ok: false, reason: 'version-not-found', version };

        // Persist first, then project the exact selected vector into the library. Re-selecting the
        // current version is still an explicit request, so it also heals a missing/out-of-date
        // library row; only the reported `changed` flag says whether the pointer moved.
        try {
          templates.write(rolled.state);
        } catch {
          return { ok: false, reason: 'template-write-failed' };
        }
        const applied = applySpeakerLibraryTemplate(library, record.vector, '');
        if (applied.ok !== true) {
          let restored = false;
          try {
            templates.write(state);
            restored = true;
          } catch {
            restored = false;
          }
          await speakerEvent('speaker.template.rollback.failed', {
            version,
            reason: applied.reason,
            restored: restored === true,
          });
          return { ok: false, reason: applied.reason, restored };
        }

        await speakerEvent('speaker.template.rolledback', {
          version: rolled.currentVersion,
          restoredFrom: rolled.restoredFrom,
          changed: rolled.changed === true,
          sampleCount: record.sampleCount,
          totalDurationMs: record.totalDurationMs,
        });
        return {
          ok: true,
          speakerId: SPEAKER_BASE_ID,
          currentVersion: rolled.currentVersion,
          restoredFrom: rolled.restoredFrom,
          changed: rolled.changed === true,
          sampleCount: record.sampleCount,
          totalDurationMs: record.totalDurationMs,
          createdAt: record.createdAt,
          reason: record.reason,
          library: librarySelfView(),
          canRollback: rolled.state.versions.some(
            (entry) => entry.version !== rolled.currentVersion,
          ),
        };
      }
      case 'speaker.rename': {
        const workflow = speakerWorkflow();
        if (workflow !== null && workflow !== undefined) {
          const speakerId = speakerActionText(body.speakerId);
          const labelResult = prepareSpeakerLabel(body.label, { required: true });
          if (labelResult.ok !== true) return labelResult;
          return workflow.rename(speakerId, labelResult.label);
        }
        const library = speakerLibrary();
        if (library === null) return SPEAKER_CANDIDATES_UNAVAILABLE;
        const speakerId = speakerActionText(body.speakerId) || SPEAKER_BASE_ID;
        const labelResult = prepareSpeakerLabel(body.label, { required: true });
        if (labelResult.ok !== true) return { ...labelResult, speakerId };
        try {
          if (typeof library.get !== 'function' || typeof library.open !== 'function') {
            return { ok: false, reason: 'unavailable', speakerId };
          }
          if (library.get(speakerId) === null) return { ok: false, reason: 'not-found', speakerId };
          const result = library.open()
            .prepare('UPDATE speaker_template SET label = ?, updated_at = ? WHERE speaker_id = ?')
            .run(labelResult.label, new Date().toISOString(), speakerId);
          if (Number(result?.changes) < 1) return { ok: false, reason: 'not-found', speakerId };
          const updated = library.get(speakerId);
          await speakerEvent('speaker.renamed', {
            speakerId,
            labelChars: [...labelResult.label].length,
          });
          return {
            ok: true,
            speakerId,
            label: labelResult.label,
            library: speakerLibraryEntryView(updated),
          };
        } catch {
          return { ok: false, reason: 'write-failed', speakerId };
        }
      }
      case 'hearing.threshold': {
        // Noise floor in dB: anything quieter than this counts as silence. Lower = more sensitive.
        const value = Number(body.db);
        if (!Number.isFinite(value) || value < -90 || value > -10) {
          return { ok: false, error: '阈值需在 -90 与 -10 之间' };
        }
        services.runtime.asrMinRmsDb = value;
        (0, services.writeSettings)({ asrMinRmsDb: value });
        await services.log.emit('hearing.threshold', { db: value });
        // Restart capture so the saved floor is in force from a NEW instance. The reply is the
        // restart's real outcome: a failed restart is a failed save, never `ok:true` + a quiet
        // `restarted:false` (the old bug: the settings page reported success while nothing ran).
        if (services.hearing === null) {
          services.thresholdRestart = { lastAt: new Date().toISOString(), ok: null, error: '' };
          return { ok: true, db: value, restarted: false, reason: 'not-running', minRmsDb: value };
        }
        const device = services.hearing.device;
        let restarted = null;
        try {
          await (0, services.stopListening)();
          restarted = await (0, services.startListening)(device);
        } catch (error) {
          restarted = { ok: false, error: error?.message ?? String(error) };
        }
        const restartedOk = restarted?.ok === true;
        const instanceId = restartedOk ? String(restarted.instanceId ?? '') : '';
        const error = restartedOk ? '' : (restarted?.error || '重启采集失败');
        services.thresholdRestart = { lastAt: new Date().toISOString(), ok: restartedOk, error };
        if (!restartedOk) {
          await services.log.emit('hearing.threshold.restart.failed', { db: value, device, error });
          return { ok: false, db: value, restarted: false, error, message: `重启失败：${error}` };
        }
        return {
          ok: true, db: value, restarted: true, instanceId, minRmsDb: value, message: '已生效（新实例）',
        };
      }
      case 'hearing.device': {
        const device = String(body.device ?? '');
        // A loopback endpoint would feed our own playback back: refuse it and keep the old setting.
        if (device !== '' && (0, services.isLoopbackName)(device)) {
          return { ok: false, error: 'MIC_LOOPBACK_REJECTED' };
        }
        services.runtime.asrDevice = device;
        (0, services.writeSettings)({ asrDevice: device });
        await services.log.emit('hearing.device', { device, source: 'settings' });
        return { ok: true };
      }
      case 'hearing.devices.refresh': {
        services.deviceCache = null;
        const devices = await (0, services.getDevices)();
        return { ok: true, devices, deviceList: (0, services.deviceRows)(devices) };
      }
      case 'ambient.start': {
        const opened = await (0, services.openContainer)('ambient', 'ambient.start');
        if (!opened.ok) return { ok: false, code: 'FEATURE_DISABLED', feature: 'ambient', error: opened.error ?? '环境声音组件无法启用' };
        const result = await (0, services.startAmbient)(body.device);
        if (result.ok) services.ambientAutostart?.clearDeferred();
        return { ok: result.ok, device: result.device, source: result.source ?? '', error: result.error, ...(result.ok ? {} : { code: 'START_FAILED', feature: 'ambient' }) };
      }
      case 'ambient.autoListen': {
        const enabled = body.enabled === true;
        const next = { ...(0, services.componentSettings)('ambient'), enabled: (0, services.componentSettings)('ambient').enabled !== false, autoListen: enabled };
        services.runtime.ambient = next;
        (0, services.writeSettings)({ ambient: next });
        if (enabled) services.ambientAutostart?.schedule();
        else services.ambientAutostart?.cancel();
        await services.log.emit('ambient.autoListen', { enabled, source: 'settings' });
        return { ok: true, autoListen: enabled };
      }
      case 'ambient.stop': {
        await (0, services.stopAmbient)();
        return { ok: true };
      }
      case 'call.mode': {
        // 设置页手动切换：识别失败时的兜底。enter 仍要求至少一个启用中的称呼。
        const target = body.mode === 'call' ? 'call' : (body.mode === 'normal' ? 'normal' : '');
        if (target === '') return { ok: false, error: 'mode 必须是 call 或 normal' };
        return target === 'call' ? (0, services.enterCallMode)('settings') : (0, services.exitCallMode)('settings');
      }
      case 'call.names.add': {
        const result = services.callNameStore.add((0, services.storedVoice)(), body.text);
        if (!result.ok) {
          return {
            ok: false,
            reason: result.reason,
            error: result.error,
            conflict: result.conflict ?? null,
          };
        }
        (0, services.saveCallNames)(result.callNames);
        await services.log.emit('call.names.add', {
          id: result.item.id,
          enabled: result.item.enabled,
          chars: result.item.text.length,
        });
        return { ok: true, item: result.item, ...(0, services.callModeNames)() };
      }
      case 'call.names.remove': {
        const result = services.callNameStore.remove((0, services.storedVoice)(), body.id);
        if (!result.ok) return { ok: false, reason: result.reason, error: result.error };
        (0, services.saveCallNames)(result.callNames);
        await services.log.emit('call.names.remove', { id: result.item.id });
        return { ok: true, removed: result.item.id, ...(0, services.callModeNames)() };
      }
      case 'call.names.toggle': {
        const result = services.callNameStore.toggle((0, services.storedVoice)(), body.id, body.enabled);
        if (!result.ok) return { ok: false, reason: result.reason, error: result.error };
        (0, services.saveCallNames)(result.callNames);
        await services.log.emit('call.names.toggle', {
          id: result.item.id,
          enabled: result.item.enabled,
          changed: result.changed === true,
        });
        return { ok: true, item: result.item, ...(0, services.callModeNames)() };
      }
      case 'hearing.stop':
        await (0, services.stopListening)();
        return { ok: true };
  }
};
  return handler;
}

/**
 * Chinese/English labels accepted by `/word` and shown by the form/listing. The canonical stored
 * values are the English ids in `LEXICON_CATEGORIES` for those legacy categories; every other
 * non-empty text is stored as the/user typed it. Labels are only an input/display alias.
 */
export const LEXICON_CATEGORY_LABELS = Object.freeze({
  person: '人名',
  character: '角色',
  work: '作品',
  place: '地点',
  term: '术语',
  expression: '特殊表达',
  meme: '梗',
  unknown: '未知',
});

const CATEGORY_ALIASES = new Map();
for (const category of LEXICON_CATEGORIES) {
  CATEGORY_ALIASES.set(category, category);
  CATEGORY_ALIASES.set(LEXICON_CATEGORY_LABELS[category], category);
}
// Friendly synonyms beyond the canonical labels.
for (const [alias, category] of [
  ['人物', 'person'],
  ['人名', 'person'],
  ['角色', 'character'],
  ['作品', 'work'],
  ['地点', 'place'],
  ['地方', 'place'],
  ['术语', 'term'],
  ['专有名词', 'term'],
  ['表达', 'expression'],
  ['特殊表达', 'expression'],
  ['梗', 'meme'],
  ['网络梗', 'meme'],
  ['其他', 'unknown'],
  ['未知', 'unknown'],
]) {
  if (!CATEGORY_ALIASES.has(alias)) CATEGORY_ALIASES.set(alias, category);
}

export const WORD_COMMAND_USAGE = '/word "词或短语" <类别> "用法" [读音]';
const WORD_CATEGORY_HINT = LEXICON_CATEGORIES
  .map((category) => `${LEXICON_CATEGORY_LABELS[category]}=${category}`)
  .join('、');

/**
 * Split `/word` input on whitespace while honoring "double", 'single', “curly”, 「corner」 and
 * 『corner』 quotes, so a usage phrase may contain spaces without becoming extra arguments.
 *
 * @param {unknown} rawInput everything after `/word`
 * @returns {{ok: true, tokens: string[]}|{ok: false, error: string}}
 */
export function tokenizeWordCommand(rawInput) {
  const source = typeof rawInput === 'string' ? rawInput : '';
  const tokens = [];
  let current = '';
  let started = false;
  let close = '';
  const closingOf = (char) => ({
    '"': '"', "'": "'", '“': '”', '‘': '’', '「': '」', '『': '』',
  })[char] ?? '';
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (close !== '') {
      if (char === close) {
        close = '';
        continue;
      }
      if (char === '\\' && (source[index + 1] === close || source[index + 1] === '\\')) {
        current += source[index + 1];
        index += 1;
        continue;
      }
      current += char;
      continue;
    }
    const closing = closingOf(char);
    if (closing !== '') {
      close = closing;
      started = true;
      continue;
    }
    if (/\s/u.test(char)) {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }
  if (close !== '') return { ok: false, error: '引号没有闭合，请检查参数。' };
  if (started) tokens.push(current);
  return { ok: true, tokens };
}

/**
 * Parse the `/word` arguments. Category and usage are REQUIRED and are never guessed: an
 * incomplete call tells the user exactly what is missing. Category is free text: the legacy labels
 * above still map to their canonical ids, and any other non-empty text is stored as typed (bounded
 * by `LEXICON_CATEGORY_MAX_CHARS`). Reading is optional (auto-generation may leave it blank, and
 * the user can add it later).
 *
 * @param {unknown} rawInput everything after `/word`
 * @returns {{ok: true, value: {text: string, category: string, usage: string, reading: string}}
 *   | {ok: false, error: string}}
 */
export function parseWordCommand(rawInput) {
  const tokenized = tokenizeWordCommand(rawInput);
  if (tokenized.ok !== true) return tokenized;
  const tokens = tokenized.tokens;
  if (tokens.length === 0) {
    return { ok: false, error: `缺少词、类别和用法。用法：${WORD_COMMAND_USAGE}` };
  }
  if (tokens.length > 4) {
    return { ok: false, error: `参数过多。用法：${WORD_COMMAND_USAGE}（含空格的用法请加引号）` };
  }
  const [text, categoryInput, usage, reading = ''] = tokens;
  const display = String(text ?? '').trim();
  if (display.length === 0) return { ok: false, error: '词或短语不能为空。' };
  if ([...display].length > LEXICON_TEXT_MAX_CHARS) {
    return { ok: false, error: `词或短语最多 ${LEXICON_TEXT_MAX_CHARS} 个字符。` };
  }
  if (categoryInput === undefined || categoryInput.trim() === '') {
    return { ok: false, error: `缺少类别。常用类别：${WORD_CATEGORY_HINT}` };
  }
  const typedCategory = categoryInput.trim();
  // Known ids/labels keep their canonical English value; anything else is free text now, so the
  // command can never disagree with the store's accepting category (only the bound is shared).
  const category = CATEGORY_ALIASES.get(typedCategory)
    ?? CATEGORY_ALIASES.get(typedCategory.toLowerCase())
    ?? typedCategory;
  if ([...category].length > LEXICON_CATEGORY_MAX_CHARS) {
    return {
      ok: false,
      error: `类别最多 ${LEXICON_CATEGORY_MAX_CHARS} 个字符。常用类别：${WORD_CATEGORY_HINT}`,
    };
  }
  if (usage === undefined || String(usage).trim() === '') {
    return { ok: false, error: `缺少用法说明。用法：${WORD_COMMAND_USAGE}` };
  }
  const usageText = String(usage).trim();
  if ([...usageText].length > LEXICON_USAGE_MAX_CHARS) {
    return { ok: false, error: `用法说明最多 ${LEXICON_USAGE_MAX_CHARS} 个字符。` };
  }
  const readingText = String(reading ?? '').trim();
  if ([...readingText].length > LEXICON_READING_MAX_CHARS) {
    return { ok: false, error: `读音最多 ${LEXICON_READING_MAX_CHARS} 个字符。` };
  }
  return {
    ok: true,
    value: { text: display, category, usage: usageText, reading: readingText },
  };
}

/**
 * Build the `/word` command definition for the DSH commands service. Only the public library is
 * written; a successful result names the editable entry id. The caller registers it with
 * `ctx.get('commands')?.register(definition)` (guarded because the service is optional).
 *
 * @param {{store?: object|null, log?: object|null}} [options]
 * @returns {{name: string, description: string, input: {hint: string},
 *   handler: (invocation: {rawInput?: string}) => Promise<object>}}
 */
export function createWordCommandDefinition({ store = null, log = null } = {}) {
  return Object.freeze({
    name: 'word',
    description: '添加一条公共词库词条（所有人可用，可直接在设置页编辑）',
    input: { hint: '词或短语 类别 "用法" [读音]' },
    async handler(invocation) {
      const parsed = parseWordCommand(invocation?.rawInput ?? '');
      if (parsed.ok !== true) return { kind: 'error', text: parsed.error };
      if (store === null || typeof store.addEntry !== 'function') {
        return { kind: 'error', text: '共享词库尚未接线：宿主没有 lexicon 存储。' };
      }
      const added = store.addEntry({ ...parsed.value, library: 'public' });
      if (added?.ok !== true) {
        if (added?.reason === 'exists') {
          let existingId = '';
          try {
            const key = lexiconKey(parsed.value.text);
            const existing = store.list().find((entry) => entry?.key === key
              || (typeof entry?.canonical === 'string' && entry.canonical.length > 0 && lexiconKey(entry.canonical) === key));
            existingId = typeof existing?.id === 'string' ? existing.id : '';
          } catch {
            /* the duplicate message is still useful without an id */
          }
          return {
            kind: 'error',
            text: `词条已存在${existingId === '' ? '' : `（ID ${existingId}）`}；请到设置页编辑，而不是重复添加。`,
          };
        }
        return { kind: 'error', text: `添加失败：${added?.reason ?? 'unknown'}` };
      }
      try {
        void log?.emit?.('lexicon.command.word', {
          id: added.entry?.id ?? '',
          category: added.entry?.category ?? 'unknown',
          library: 'public',
        })?.catch?.(() => {});
      } catch {
        /* logging must never fail the command */
      }
      const label = LEXICON_CATEGORY_LABELS[added.entry?.category] ?? added.entry?.category ?? '未知';
      return {
        kind: 'success',
        text: `已加入公共词库：「${added.entry?.canonical || added.entry?.text || parsed.value.text}」（${label}）· ID ${added.entry?.id ?? ''}。可在 设置 → 记忆与人设 → 词库 中编辑或移动。`,
      };
    },
  });
}

/**
 * The optional "本人" speaker id used as provenance for the shared lexicon: `voice.selfSpeakerId`
 * from settings.json (written by the user or a later voiceprint registration) wins; otherwise a
 * speaker-shadow `match` supplies it; otherwise there is no identity. This is never a confirmation
 * gate — the lexicon is shared, and an entry may be confirmed with no speaker id at all. Pure, so
 * the Host can project it from a settings snapshot and the live shadow verdict without extra state.
 *
 * @param {{settings?: object, shadow?: object|null}} [evidence]
 * @returns {{speakerId: string|null, source: 'setting'|'shadow'|null}}
 */
export function resolveSelfSpeakerId({ settings = {}, shadow = null } = {}) {
  const saved = settings?.voice?.selfSpeakerId;
  if (typeof saved === 'string' && saved.trim() !== '') {
    return { speakerId: saved.trim(), source: 'setting' };
  }
  if (shadow?.decision === 'match'
    && typeof shadow?.speakerId === 'string'
    && shadow.speakerId.trim() !== '') {
    return { speakerId: shadow.speakerId.trim(), source: 'shadow' };
  }
  return { speakerId: null, source: null };
}

/**
 * The hearing block of `/assistant/status`, projected over the live capture instance.
 *
 * `base` is the status builder's own block (kept as-is). The session owns the evidence the card
 * needs: `instanceId` (which capture session is running) and `minRmsDb` (the floor it resolves
 * *now* — a live getter, so a saved value is visible even before a restart lands). The last
 * threshold-save restart is kept here too, because the action reply is transient while a failed
 * restart must stay visible; `ok: null` means "no restart attempted" (capture was not running).
 * `fallbackMinRmsDb` is the floor the next `startHearing` would begin with while stopped.
 */
export function projectHearingStatus(base, { session = null, restart = null, fallbackMinRmsDb = -50 } = {}) {
  let live = Number.NaN;
  try {
    if (typeof session?.minRmsDb === 'function') live = Number(session.minRmsDb());
  } catch {
    /* a status read must never fail because a session probe did */
  }
  const fallback = Number(fallbackMinRmsDb);
  return {
    ...(base ?? {}),
    instanceId: typeof session?.instanceId === 'string' ? session.instanceId : '',
    minRmsDb: Number.isFinite(live) ? live : (Number.isFinite(fallback) ? fallback : -50),
    thresholdRestart: restart ?? { lastAt: null, ok: null, error: '' },
  };
}

