import { nonverbalClearReason, nonverbalCuePrompt, nonverbalLaughterTag } from '../shared/text.js';

// ---- nonverbal perception cue (experimental, default off) -------------------
/**
 * The five-minute validity bound of one nonverbal cue. It is a limit on how long an observation
 * may still be shown, NOT a claim that the user is in that state for five minutes.
 */
export const NONVERBAL_CUE_TTL_MS = 5 * 60 * 1000;

/**
 * The experimental nonverbal cue slot. One Laughter detection opens a five-minute window; the
 * window is only a validity bound and a continuing conversation never extends it. The only
 * refresh is a new detection from a DIFFERENT audio segment (the same utterance id means the same
 * audio, so a repeat is ignored). It is not a user utterance, memory, persona or profile input.
 *
 * @param {{enabled?: () => boolean, emit?: (type: string, payload: object) => void,
 *          sessionId?: () => string, now?: () => number}} [options]
 */
export function createNonverbalCue({ enabled = () => false, emit = null, sessionId = () => '', now = () => Date.now() } = {}) {
  let cue = null;
  let cueSession = '';
  /** Recent audio segments already used as evidence; a repeat can never refresh the cue. */
  const seenAudio = new Set();
  const active = () => {
    try {
      return enabled() === true;
    } catch {
      return false;
    }
  };
  const announce = (type, payload) => {
    try {
      emit?.(type, payload);
    } catch {
      /* an observation sink must never break a turn */
    }
  };
  const clear = (reason) => {
    if (cue === null) return false;
    cue = null;
    cueSession = '';
    announce('voice.nonverbal.cleared', { reason });
    return true;
  };
  const observe = ({ tag = null, source = 'unknown', audioKey = null, at = now() } = {}) => {
    if (!active()) return null;
    if (!nonverbalLaughterTag(tag)) return null;
    const key = audioKey === null || audioKey === undefined ? null : String(audioKey);
    if (key !== null) {
      if (seenAudio.has(key)) return null;
      seenAudio.add(key);
      if (seenAudio.size > 32) seenAudio.delete(seenAudio.values().next().value);
    }
    cue = {
      kind: 'nonverbal-laughter',
      observedAt: at,
      source: source === 'mic' || source === 'loopback' ? source : 'unknown',
      evidence: 'sensevoice-event',
      ttlUntil: at + NONVERBAL_CUE_TTL_MS,
    };
    cueSession = String(sessionId() ?? '');
    announce('voice.nonverbal.cue', { kind: cue.kind, source: cue.source, observedAt: cue.observedAt });
    return { ...cue };
  };
  const render = (at = now()) => {
    if (!active()) {
      clear('disabled');
      return '';
    }
    if (cue === null) return '';
    if (at >= cue.ttlUntil) {
      clear('expired');
      return '';
    }
    const ageMs = Math.max(0, at - cue.observedAt);
    announce('voice.nonverbal.injected', { ageMs });
    return nonverbalCuePrompt(cue, ageMs);
  };
  const noteUserText = (text) => {
    const reason = nonverbalClearReason(text);
    return reason === '' ? false : clear(reason);
  };
  /** A cue belongs to the session that heard it: a message in another session retires it. */
  const noteSession = (id) => {
    const next = typeof id === 'string' ? id.trim() : '';
    if (cue === null || next.length === 0 || cueSession.length === 0) return false;
    return next === cueSession ? false : clear('session-switch');
  };
  return {
    observe,
    render,
    noteUserText,
    noteSession,
    clear,
    get cue() {
      return cue === null ? null : { ...cue };
    },
  };
}
