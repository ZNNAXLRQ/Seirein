/** maintain-busy — extracted from profileMaintain.js; no host entry dependency. */
import { PROFILE_MAINTAIN_TURN_STALE_MS, cleanText, positiveInt } from './maintain-config.js';

/** Turn id carried by one session event, in any shape the harness exposes. */
function eventTurnId(event) {
  const data = event !== null && typeof event === 'object' && event.data !== null && typeof event.data === 'object'
    ? event.data
    : {};
  for (const value of [data.turn, data.turnId, event?.turnId]) {
    if (Number.isInteger(value)) return value;
  }
  return null;
}


/** Pending voice queue → `{size, cancelledOnly}`; a cancelled entry is not busy. */
function normalizePendingVoice(value) {
  if (Array.isArray(value)) {
    const live = value.filter((entry) => entry?.cancelled !== true
      && entry?.dropped !== true
      && entry?.state !== 'cancelled'
      && entry?.status !== 'cancelled');
    return { size: live.length, cancelledOnly: live.length === 0 && value.length > 0 };
  }
  if (value !== null && typeof value === 'object') {
    const raw = Number(value.size ?? value.length ?? 0);
    return {
      size: Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0,
      cancelledOnly: value.cancelledOnly === true,
    };
  }
  const raw = Number(value ?? 0);
  return { size: Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0, cancelledOnly: false };
}


/** One injectable busy snapshot → the stable shape every reason/snapshot consumer reads. */
function normalizeBusySnapshot(value = {}) {
  const source = value !== null && typeof value === 'object' ? value : {};
  const turns = Array.isArray(source.activeChatTurns)
    ? source.activeChatTurns
    : (Array.isArray(source.turns) ? source.turns : []);
  const activeChatTurns = turns
    .filter((turn) => turn !== null && typeof turn === 'object'
      && typeof turn.sessionId === 'string' && turn.sessionId.length > 0)
    .map((turn) => ({
      sessionId: turn.sessionId,
      turnId: Number.isInteger(turn.turnId) ? turn.turnId : null,
      startedAt: Number(turn.startedAt) || 0,
      workspace: cleanText(turn.workspace),
    }));
  const playbackSource = source.playback;
  const voiceSource = source.voiceTurn;
  const playback = playbackSource !== null && playbackSource !== undefined && playbackSource !== false
    ? { token: playbackSource.token ?? null, startedAt: Number(playbackSource.startedAt) || 0 }
    : null;
  const voiceTurn = voiceSource !== null && voiceSource !== undefined
    ? {
      sessionId: cleanText(voiceSource.sessionId),
      turnId: Number.isInteger(voiceSource.turnId) ? voiceSource.turnId : null,
      startedAt: Number(voiceSource.startedAt) || 0,
    }
    : null;
  return {
    activeChatTurns,
    playback,
    voiceTurn,
    playing: playback !== null || voiceTurn !== null,
    pendingVoice: normalizePendingVoice(source.pendingVoice ?? source.pendingVoices ?? source.queue),
    fastPath: source.fastPath === true || source.fastActive === true,
  };
}


/** Concrete busy reason, in the order the user sees one reason at a time. */
function busyReasonOf(snapshot) {
  if (snapshot.activeChatTurns.length > 0) return 'active-turn';
  if (snapshot.playback !== null || snapshot.voiceTurn !== null) return 'playing';
  if (snapshot.pendingVoice.size > 0) return 'pending-voice';
  if (snapshot.fastPath === true) return 'fast-path';
  return null;
}


/**
 * Tracks the assistant's OWN chat turns and combines them with the voice/fast-path state.
 * Collection is scoped: a coding-agent session in another workspace must never make the
 * companion look busy. A turn older than `staleMs` is bookkeeping, not work.
 */
export function createProfileMaintainBusyTracker({
  isAssistantSession = () => true,
  workspaceOf = () => '',
  now = () => Date.now(),
  staleMs = PROFILE_MAINTAIN_TURN_STALE_MS,
} = {}) {
  const turns = new Map();
  const clock = typeof now === 'function' ? now : () => Date.now();
  const stale = positiveInt(staleMs, PROFILE_MAINTAIN_TURN_STALE_MS);
  const relevant = typeof isAssistantSession === 'function' ? isAssistantSession : () => true;
  const workspace = typeof workspaceOf === 'function' ? workspaceOf : () => '';
  const instant = () => {
    const value = Number(clock());
    return Number.isFinite(value) ? value : Date.now();
  };
  const prune = () => {
    const at = instant();
    for (const [id, turn] of turns) {
      if (at - turn.startedAt > stale) turns.delete(id);
    }
    return at;
  };
  const snapshot = (extra = {}) => {
    const at = prune();
    const base = normalizeBusySnapshot(extra);
    return {
      at: new Date(at).toISOString(),
      activeChatTurns: [...turns.values()].map((turn) => ({ ...turn })),
      playback: base.playback,
      voiceTurn: base.voiceTurn,
      playing: base.playing,
      pendingVoice: base.pendingVoice,
      fastPath: base.fastPath,
    };
  };
  const reason = (extra = {}) => busyReasonOf(snapshot(extra));
  return {
    noteTurnStart(session, event = {}) {
      const sessionId = cleanText(session?.id);
      if (sessionId.length === 0) return false;
      prune();
      let mine = false;
      try {
        mine = relevant(session) === true;
      } catch {
        mine = false;
      }
      if (!mine) {
        // A session can move out of scope between start and end: never leave a stale entry.
        turns.delete(sessionId);
        return false;
      }
      turns.set(sessionId, {
        sessionId,
        turnId: eventTurnId(event),
        startedAt: instant(),
        workspace: cleanText(workspace(session)),
      });
      return true;
    },
    noteTurnEnd(session, event = {}) {
      const sessionId = cleanText(session?.id);
      if (sessionId.length === 0) return false;
      const existing = turns.get(sessionId);
      if (existing === undefined) return false;
      const turnId = eventTurnId(event);
      // A late end of an older turn must not delete the turn that replaced it.
      if (turnId !== null && existing.turnId !== null && turnId !== existing.turnId) return false;
      return turns.delete(sessionId);
    },
    clear() {
      turns.clear();
    },
    prune,
    snapshot,
    reason,
    isBusy(extra = {}) {
      return reason(extra) !== null;
    },
  };
}

export { eventTurnId, normalizePendingVoice, normalizeBusySnapshot, busyReasonOf };
