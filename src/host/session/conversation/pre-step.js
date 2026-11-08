/** Continuation-context injection that preserves an upstream rejection. */
import { responseGroupContextMessage } from './responseGroup.js';

export function createConversationPreStep(services) {
  const handler = async (payload, next) => {
      const decision = await next();
      if (decision === null || typeof decision !== 'object' || decision.kind === 'reject') return decision;
      if (Number(payload?.step) !== 1) return decision;
      const sessionId = typeof payload?.agent?.session?.id === 'string' ? payload.agent.session.id : '';
      if (sessionId.length === 0) return decision;
      const base = Array.isArray(decision.messages) ? decision.messages : [];
      const appended = [];
      // Rollover day digest: the target assistant session's first request carries its own day
      // background. It is context for that request, never a turn the model has to answer.
      try {
        const digest = services.rolloverDigest?.take?.({ agent: payload?.agent, sessionId });
        if (digest !== null && digest !== undefined) appended.push(digest);
      } catch {
        /* background only: a broken digest must never block the continuation lane */
      }
      const pending = services.responseGroups.takePendingInternal({ sessionId });
      if (pending !== null) {
        appended.push(responseGroupContextMessage(pending.text, {
          groupId: pending.groupId, version: pending.version,
        }));
      }
      if (appended.length === 0) return decision;
      return { ...decision, messages: [...base, ...appended] };
    };
  return handler;
}
