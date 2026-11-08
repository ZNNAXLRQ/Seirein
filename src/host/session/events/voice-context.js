/** Track voice-context activity in the active companion session. */



export function createVoiceContextObserver(services) {
  const handler = (session, event) => {
      const sessionId = typeof session?.id === 'string' ? session.id : '';
      if (sessionId.length === 0) return;
      // A user message in the dated voice session (spoken or typed) keeps the noise gate's
      // conversation window open, so the next lone filler is delivered instead of swallowed.
      if (event?.type === 'user/message'
        && event?.data?.source?.kind === 'user'
        && sessionId === (0, services.voiceSessionTarget)({ root: services.root, rolloverHour: services.ROLLOVER_HOUR }).sessionId) {
        services.voiceContextAt = Date.now();
      }
      const turn = Number.isInteger(event?.data?.turn) ? event.data.turn : null;
      if (turn === null) return;
      if (event.type === 'turn/start') services.currentTurnBySession.set(sessionId, turn);
      if (event.type === 'turn/start') services.memoryTurnLedger.forgetBefore(sessionId, turn);
      if (event.type === 'turn/start') (0, services.forgetReplySpokeBefore)(sessionId, turn);
      // A new turn must not inherit the previous round's recall under the same key.
      if (event.type === 'turn/start') services.voiceRecallByTurn.delete((0, services.voiceRecallKey)(sessionId, turn));
    };
  return handler;
}
