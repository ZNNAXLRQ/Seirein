/** Continuation-context injection that preserves an upstream rejection. */
import { responseGroupContextMessage } from './responseGroup.js';


export function createConversationPreStep(services) {
  const handler = async (payload, next) => {
      const decision = await next();
      if (decision === null || typeof decision !== 'object' || decision.kind === 'reject') return decision;
      if (Number(payload?.step) !== 1) return decision;
      const sessionId = typeof payload?.agent?.session?.id === 'string' ? payload.agent.session.id : '';
      if (sessionId.length === 0) return decision;
      const pending = services.responseGroups.takePendingInternal({ sessionId });
      if (pending === null) return decision;
      return {
        ...decision,
        messages: [
          ...(Array.isArray(decision.messages) ? decision.messages : []),
          responseGroupContextMessage(pending.text, { groupId: pending.groupId, version: pending.version }),
        ],
      };
    };
  return handler;
}
