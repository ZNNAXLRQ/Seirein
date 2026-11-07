/** Profile organization activity tracking for scoped companion sessions. */



export function createProfileActivityObserver(services) {
  const handler = (session, event) => {
      if (event?.type === 'turn/start') services.profileBusy.noteTurnStart(session, event);
      else if (event?.type === 'turn/end') services.profileBusy.noteTurnEnd(session, event);
      // Only the companion's own workspace drives the avatar: a coding-agent turn elsewhere must
      // not make it look like it is thinking about the user. Voice turns are covered separately.
      const cwd = (0, services.sessionCwd)(session);
      if (cwd.length === 0 || !(0, services.sameDirectory)(cwd, (0, services.workspaceScope)().path)) return;
      if (event?.type === 'turn/start') {
        // P-139 stage 4: a new turn starts with no conclusion/confusion mark carried over.
        (0, services.avatarWiringReset)(typeof session?.id === 'string' ? session.id : '');
        (0, services.avatarStatus)('thinking', 'turn.start');
        // P-139: a new turn is a new intent generation; the turn id is the identity that makes it
        // one, so the previous turn's staged/running intent can never carry over.
        (0, services.avatarIntent)('thinking', {
          sessionId: typeof session?.id === 'string' ? session.id : '',
          turnId: Number.isInteger(event?.data?.turn) ? event.data.turn : null,
        });
      } else if (event?.type === 'assistant/message') {
        // The answer's own words: only an explicit "I did not hear / which one" cue tilts the head.
        (0, services.observeAvatarAnswer)(session, event.data ?? {});
      } else if (event?.type === 'turn/end') {
        // A clip may still be playing after the turn settles; playback.end moves us to waiting.
        if (services.playback === null) {
          (0, services.avatarStatusIf)(['thinking'], 'waiting', 'turn.end');
          (0, services.avatarIntent)('idle', { sessionId: typeof session?.id === 'string' ? session.id : '' });
        }
      }
    };
  return handler;
}
