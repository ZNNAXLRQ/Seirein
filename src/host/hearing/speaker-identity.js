/**
 * Speaker identity — stage 3 helper layer: attribute a NEW record to the confirmed self.
 *
 * User rules (2026-11-09, final):
 *   - identity is used only for the personal lexicon and for attributing new memory records;
 *   - an uncertain row stays unconfirmed (unassigned) and is never claimed as "you";
 *   - identity is NOT used to reject speech, mute, interrupt, or to reclaim earlier transcripts;
 *   - a mismatch may record the OTHER speaker id, but that id is never "self".
 *
 * This is a pure decision layer: it performs no I/O, writes no memory, changes no lexicon, emits no
 * event and takes no hard action. Its inputs are one `speaker.shadow` row (`decision` / `class` /
 * `score` / `speakerId` / `quality` / `source`) and the enrollment module (`getConfirmedSelf()`),
 * or a plain `{selfId}` snapshot. Every malformed input resolves to `assigned:false`.
 *
 * Assignment needs all three: `decision === 'match'`, `class === 'self'` and a confirmed selfId.
 * When the row also names a speakerId, that id must BE the confirmed selfId: a match against some
 * other enrolled voice is not the user, so the disagreement stays unassigned (`self-id-conflict`)
 * instead of silently claiming "you".
 *
 * `likely-video-leak` is a cue, never a verdict: a loopback row that is non-self with a low score
 * is labelled, and its attribution stays unassigned. Nothing is rejected, muted or dropped.
 */

/** The closed confidence vocabulary of an attribution. */
export const IDENTITY_CONFIDENCE = Object.freeze({
  CONFIRMED: 'confirmed',
  UNSURE: 'unsure',
  MISMATCH: 'mismatch',
});

/** The only value the record-attribution field uses for `source`. */
export const RECORD_ATTRIBUTION_SOURCE = 'shadow';

/** The cue label for a likely video/loopback leak (evidence only). */
export const VIDEO_LEAK_LABEL = 'likely-video-leak';

/**
 * Leak-scoring default: a loopback non-self row at or below this cosine score is likely video
 * bleed. 0.32 is the shadow's own default mismatch edge (threshold 0.4 - unsureMargin 0.08), so
 * the cue starts where a definite mismatch starts; callers may override it per row.
 */
export const VIDEO_LEAK_DEFAULTS = Object.freeze({ scoreCeiling: 0.32 });

const DECISIONS = new Set(['match', 'mismatch', 'unsure']);
const QUALITY_OK = 'ok';

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A trimmed string or ''. */
function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** A finite number, or null: absent/''/NaN never collapse to 0. */
function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** The one unassigned answer shape; `reason` is data, never an action. */
function unassigned(reason, confidence = IDENTITY_CONFIDENCE.UNSURE) {
  return { speakerId: null, assigned: false, confidence, reason };
}

/**
 * The confirmed selfId behind an enrollment input.
 *
 * Accepts the enrollment module (`getConfirmedSelf()`) or a plain `{selfId}` snapshot; anything
 * else is "no usable enrollment". A getter that throws is treated as absent, never propagated.
 *
 * @returns {{selfId: string, reason: string}}
 */
function confirmedSelfOf(enrollment) {
  if (enrollment === null || enrollment === undefined) return { selfId: '', reason: 'no-enrollment' };
  if (!plainObject(enrollment)) return { selfId: '', reason: 'invalid-enrollment' };
  if (typeof enrollment.getConfirmedSelf === 'function') {
    let confirmed;
    try {
      confirmed = enrollment.getConfirmedSelf();
    } catch {
      return { selfId: '', reason: 'enrollment-error' };
    }
    if (typeof confirmed === 'string') {
      const id = text(confirmed);
      return { selfId: id, reason: id === '' ? 'no-confirmed-self' : '' };
    }
    const selfId = plainObject(confirmed) ? text(confirmed.speakerId) : '';
    return { selfId, reason: selfId === '' ? 'no-confirmed-self' : '' };
  }
  const selfId = text(enrollment.selfId);
  if (selfId !== '') return { selfId, reason: '' };
  return { selfId: '', reason: 'selfId' in enrollment ? 'no-confirmed-self' : 'no-enrollment' };
}

/**
 * Classify a likely video leak from one shadow row. This is a cue only.
 *
 * The signature is: `source === 'loopback'` + a non-self class (`other` / `unknown-identity`) +
 * a finite score at or below `scoreCeiling`. Anything else is not labelled; a missing score or
 * class cannot prove a leak, and a loopback SELF match is not a leak (the lane can carry the
 * user's own voice).
 *
 * @param {object|null} shadow one `speaker.shadow` row
 * @param {{scoreCeiling?: number}} [options]
 * @returns {{leak: boolean, label: string|null, reason: string}}
 */
export function classifyVideoLeak(shadow, { scoreCeiling = VIDEO_LEAK_DEFAULTS.scoreCeiling } = {}) {
  const row = plainObject(shadow) ? shadow : null;
  if (row === null) return { leak: false, label: null, reason: 'invalid-shadow' };
  if (text(row.source) !== 'loopback') return { leak: false, label: null, reason: 'not-loopback' };
  const identityClass = text(row.class);
  if (identityClass === 'self') return { leak: false, label: null, reason: 'self' };
  if (identityClass !== 'other' && identityClass !== 'unknown-identity') {
    return { leak: false, label: null, reason: 'no-class' };
  }
  const score = finiteOrNull(row.score);
  if (score === null) return { leak: false, label: null, reason: 'no-score' };
  const ceiling = finiteOrNull(scoreCeiling) ?? VIDEO_LEAK_DEFAULTS.scoreCeiling;
  if (score > ceiling) return { leak: false, label: null, reason: 'score-not-low' };
  return { leak: true, label: VIDEO_LEAK_LABEL, reason: VIDEO_LEAK_LABEL };
}

/**
 * Resolve the identity attribution for ONE new record.
 *
 *   match + self + confirmed selfId → {speakerId: selfId, assigned: true, confidence:'confirmed'}
 *   mismatch                        → {speakerId: otherId|null, assigned:false, confidence:'mismatch'}
 *   unsure / low quality / leak     → {speakerId: null, assigned: false, confidence:'unsure'}
 *   no confirmed self / bad input   → {speakerId: null, assigned: false, confidence:'unsure'}
 *
 * Pure: it only reads its arguments (an enrollment getter is called at most once) and returns a
 * fresh object. A row is never rewritten and nothing is emitted.
 *
 * @param {{shadow?: object|null, enrollment?: object|null}} [input]
 * @returns {{speakerId: string|null, assigned: boolean,
 *            confidence: 'confirmed'|'unsure'|'mismatch', reason: string}}
 */
export function resolveIdentityForNewRecord(input = {}) {
  const options = plainObject(input) ? input : {};
  const row = plainObject(options.shadow) ? options.shadow : null;
  if (row === null) return unassigned('invalid-shadow');
  const confirmed = confirmedSelfOf(options.enrollment);
  if (confirmed.selfId === '') return unassigned(confirmed.reason);

  const rawQuality = row.quality;
  if (rawQuality !== undefined && rawQuality !== null && rawQuality !== ''
    && typeof rawQuality !== 'string') {
    return unassigned('invalid-quality');
  }
  const quality = text(rawQuality);
  if (quality !== '' && quality !== QUALITY_OK) return unassigned('low-quality');
  const leak = classifyVideoLeak(row);
  if (leak.leak) return unassigned(leak.label);

  const decision = text(row.decision);
  if (!DECISIONS.has(decision)) return unassigned('invalid-decision');
  if (decision === 'unsure') return unassigned('unsure');
  if (decision === 'mismatch') {
    // The other id is recorded as evidence, but it is never promoted to the confirmed self.
    const other = text(row.speakerId);
    const speakerId = other !== '' && other !== confirmed.selfId ? other : null;
    return { speakerId, assigned: false, confidence: IDENTITY_CONFIDENCE.MISMATCH, reason: 'mismatch' };
  }

  const identityClass = text(row.class);
  if (identityClass !== 'self') {
    return unassigned(identityClass === '' ? 'missing-class' : 'class-not-self');
  }
  const claimed = row.speakerId;
  if (claimed !== null && claimed !== undefined && claimed !== '' && typeof claimed !== 'string') {
    return unassigned('invalid-speaker-id');
  }
  const claimedId = text(claimed);
  if (claimedId !== '' && claimedId !== confirmed.selfId) return unassigned('self-id-conflict');
  return {
    speakerId: confirmed.selfId,
    assigned: true,
    confidence: IDENTITY_CONFIDENCE.CONFIRMED,
    reason: 'confirmed-self',
  };
}

/** One ISO instant, or null when the value is not a usable date. */
function isoInstantOf(value) {
  try {
    if (value instanceof Date) {
      const ms = value.getTime();
      return Number.isFinite(ms) ? value.toISOString() : null;
    }
    if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
    if (typeof value === 'string' && value.trim() !== '') {
      const ms = Date.parse(value);
      return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
    }
  } catch {
    /* an out-of-range date is "no instant", never a throw */
  }
  return null;
}

/**
 * The optional attribution field of a new memory entry / lexicon candidate:
 *
 *     { speakerId, assigned, confidence, source: 'shadow', at }
 *
 * `resolution` may be the object returned by `resolveIdentityForNewRecord` (so one row can feed
 * both a memory record and a lexicon candidate without asking enrollment twice); otherwise the
 * resolver runs on `shadow` + `enrollment`. A bad/garbage resolution is sanitized to unassigned,
 * and `assigned:true` is only ever emitted together with `confidence:'confirmed'` and a real id.
 *
 * `at` is the record instant supplied by the caller (Date / epoch ms / ISO string); an unusable
 * value becomes `null` and the function never reads the wall clock. No file, no event, no write.
 *
 * @param {{resolution?: object|null, shadow?: object|null, enrollment?: object|null,
 *          at?: Date|number|string|null}} [input]
 * @returns {{speakerId: string|null, assigned: boolean,
 *            confidence: 'confirmed'|'unsure'|'mismatch', source: 'shadow', at: string|null}}
 */
export function createRecordAttribution(input = {}) {
  const options = plainObject(input) ? input : {};
  const resolution = plainObject(options.resolution) ? options.resolution : null;
  const identity = resolution ?? resolveIdentityForNewRecord({
    shadow: options.shadow,
    enrollment: options.enrollment,
  });
  const speakerId = text(identity.speakerId);
  const confidence = text(identity.confidence);
  const confirmed = identity.assigned === true && confidence === IDENTITY_CONFIDENCE.CONFIRMED
    && speakerId !== '';
  const mismatch = !confirmed && confidence === IDENTITY_CONFIDENCE.MISMATCH && speakerId !== '';
  return {
    speakerId: confirmed || mismatch ? speakerId : null,
    assigned: confirmed,
    confidence: confirmed
      ? IDENTITY_CONFIDENCE.CONFIRMED
      : (mismatch ? IDENTITY_CONFIDENCE.MISMATCH : IDENTITY_CONFIDENCE.UNSURE),
    source: RECORD_ATTRIBUTION_SOURCE,
    at: isoInstantOf(options.at),
  };
}
