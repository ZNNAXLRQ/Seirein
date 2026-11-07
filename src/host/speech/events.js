/** Companion turn events: speech ownership, waiting lines and warmup leases. */
import { isAssistantMemoryMessage } from '../shared/text.js';
import { isSubagentAgent } from '../memory/pre-step.js';
import { messageTextBlocks } from '../shared/text.js';


export function createSpeechTurnObserver(services) {
  const handler = (session, event) => {
      const type = event?.type;
      const sessionId = typeof session?.id === 'string' ? session.id : '';
      if (type === 'user/message') {
        // The one trigger: a genuine user message was delivered. The two-second clock starts
        // here; no tool name, category or keyword is consulted, and the line is drafted and
        // synthesized in parallel with the answer so it is audio when the deadline expires.
        const data = event.data ?? {};
        if (isAssistantMemoryMessage(data)) return;
        const kind = data?.source?.kind;
        if (kind !== undefined && kind !== null && kind !== 'user') return;
        const text = String(messageTextBlocks(data)).replace(/\s+/gu, ' ').trim();
        // A cue belongs to the session that heard it; another session's message retires it. The
        // user's own words retire it here too, so a typed denial works like a spoken one.
        services.nonverbalCue.noteSession(sessionId);
        services.nonverbalCue.noteUserText(text);
        if (sessionId.length === 0 || text.length === 0) return;
        // The daily continuity digest is injected by this plugin, not typed by the user.
        if (text.includes('以下内容作为长期约束与背景')) return;
        const turn = Number.isInteger(data.turn)
          ? data.turn
          : (Number.isInteger(event.turnId) ? event.turnId : (services.currentTurnBySession.get(sessionId) ?? null));
        // Delegated children and out-of-scope sessions never speak for the companion.
        const subagent = isSubagentAgent({ session });
        if (subagent || (0, services.autoMemoryScope)(session) !== 'in-scope') {
          (0, services.logAckSkip)(subagent ? 'subagent' : 'out-of-scope', sessionId, turn);
          return;
        }
        // The user's own next input is the ONE event allowed to stop the companion's speech and to
        // replace its unplayed waiting line. (A voice delivery already stopped it at acceptance.)
        if (kind === 'user') (0, services.stopSpeechForUserInput)('user-input', { sessionId, turn });
        if (!Number.isInteger(turn)) {
          (0, services.logAckSkip)('no-turn', sessionId, turn);
          return;
        }
        services.ackLane?.cancelSuperseded(sessionId, turn, 'superseded');
        services.ackLane?.beginTurn({ sessionId, turn, userText: [...text].slice(0, 120).join('') });
        // A2: a new message owns the voice resources from this instant. A warm build already
        // running is aborted (its batch is discarded); the idle countdown restarts instead of
        // racing the answer it would otherwise synthesize beside.
        (0, services.noteAckWarmActivity)('user-message');
        return;
      }
      if (type === 'turn/start') {
        const turn = Number.isInteger(event.data?.turn)
          ? event.data.turn
          : (Number.isInteger(event.turnId) ? event.turnId : null);
        // P3: only the assistant's own turn is tracked, keyed by its own (session, turn). The
        // return value is the authority below: another workspace's turn, or a delegated child,
        // never owns the voice resources.
        const accepted = services.ackWarmTurns.start({ session, sessionId, turn });
        (0, services.logAckWarmTurn)('turn-start', sessionId, turn, accepted);
        // A2: generation started. Warm audio must not be synthesized while a turn is producing its
        // answer, and a build already running is cancelled here. Only an accepted (own,
        // non-delegated) turn may cancel it or reset the idle countdown.
        if (accepted === true) (0, services.noteAckWarmActivity)('turn-start');
        // Turning is machinery: a tool step, a delegated round or an agent continuation never
        // supersedes a line and never stops the answer. Only the user's next input does (the
        // `user/message` branch above).
        // Debug, throttled: this internal turn left the companion's voice alone.
        if (services.playback !== null || services.fastActive !== null) (0, services.noteSpeechKeep)(sessionId, turn);
        return;
      }
      if (type === 'turn/end') {
        // An aborted/errored turn has no answer to accompany: drop its line (generation, synthesis,
        // playback and queue) at once, so a late draft cannot speak after the turn is gone.
        const data = event.data ?? {};
        const turn = Number.isInteger(data.turn)
          ? data.turn
          : (Number.isInteger(event.turnId) ? event.turnId : null);
        const raw = data.reason;
        const kind = String(typeof raw === 'string' ? raw : raw?.kind ?? raw?.type ?? raw?.reason ?? '')
          .trim().toLowerCase();
        if (sessionId.length > 0 && turn !== null
          && ['aborted', 'cancelled', 'canceled', 'error', 'interrupted'].includes(kind)) {
          services.ackLane?.cancelTurn(sessionId, turn, 'turn-aborted');
        }
        // A2: the turn no longer owns generation. P3: only its own (session, turn) row is removed,
        // so one session ending never releases another; only a registered turn restarts the idle
        // window (an ignored end must not touch the build, its timer, or the cache identity). The
        // build itself still re-checks synthesis and playback when that window expires.
        const ended = services.ackWarmTurns.end({ sessionId, turn });
        (0, services.logAckWarmTurn)('turn-end', sessionId, turn, ended);
        if (ended === true) (0, services.noteAckWarmActivity)();
        return;
      }
    };
  return handler;
}
