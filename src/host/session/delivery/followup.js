/**
 * Follow-up speech after a delegated task settles.
 *
 * A voice turn normally ends when its first answer is committed. A `subagent` / goal / job
 * notification then arrives as a later user-message source, and the Agent's next answer contains
 * the result. Without this observer that answer is visible in the transcript but never reaches
 * the voice outlet. This module watches only that narrow window, emits at most one result, and
 * never speaks ordinary turns or a second tool-step.
 */

/** Sources that mean "a task the user already handed over has returned". */
export const VOICE_FOLLOWUP_SOURCE_KINDS = Object.freeze([
  'subagent-settled',
  'goal',
  'tool-jobs',
  'agent-message',
  'team-message',
]);

const SOURCE_SET = new Set(VOICE_FOLLOWUP_SOURCE_KINDS);

/** The user-message source when it is a task-settled notification, or null. */
export function voiceFollowupSource(event) {
  if (event?.type !== 'user/message') return null;
  const data = event?.data;
  const source = data?.message?.source ?? data?.source ?? null;
  const kind = typeof source?.kind === 'string' ? source.kind : '';
  if (!SOURCE_SET.has(kind)) return null;
  const summary = typeof source.summary === 'string' ? source.summary.trim() : '';
  const name = typeof source.name === 'string' ? source.name.trim() : '';
  const label = summary.slice(0, 80) || name.slice(0, 80) || kind;
  return { kind, label, summary, senderSessionId: source.senderSessionId ?? null };
}

/** Text blocks of an assistant message, trimmed; never includes reasoning blocks. */
export function assistantMessageText(event) {
  const content = event?.data?.message?.content ?? [];
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
    .trim();
}

function hasToolCallBlocks(event) {
  const content = event?.data?.message?.content;
  return Array.isArray(content)
    && content.some((block) => typeof block?.type === 'string' && block.type.startsWith('tool'));
}

/**
 * Watch one session for the first assistant answer after a task-settled source.
 *
 * The caller gates the actual playback (e.g. waits for the first answer's audio to finish). The
 * watcher always removes its listener and timer exactly once, on result, cancel or timeout.
 * @param {object} options
 * @param {object} options.ctx Host context with `on`.
 * @param {string} options.sessionId Session whose events are observed.
 * @param {number} [options.afterSeq] Ignore events at/before this sequence.
 * @param {(result: {text: string, source: object, turn: number|string|null}) => unknown} options.onResult
 * @param {(error: Error) => void} [options.onError]
 * @param {number} [options.timeoutMs] Bounded wait; the default is ten minutes.
 * @param {() => number} [options.now]
 * @param {(type: string, payload?: object) => unknown} [options.note]
 */
export function createVoiceFollowup({
  ctx,
  sessionId,
  afterSeq = 0,
  onResult,
  onError = null,
  timeoutMs = 10 * 60 * 1000,
  now = Date.now,
  note = null,
}) {
  let disposed = false;
  let timer = null;
  let off = null;
  let armed = null;
  let pendingTools = 0;
  const startedAt = now();

  const cleanup = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    try { off?.(); } catch { /* listener already gone */ }
    off = null;
  };
  const cancel = () => {
    if (disposed) return;
    disposed = true;
    cleanup();
  };
  const fail = (error) => {
    if (disposed) return;
    try { onError?.(error); } catch { /* diagnostics must not rethrow */ }
    cancel();
  };
  const emit = (result) => {
    if (disposed) return;
    disposed = true;
    cleanup();
    try {
      Promise.resolve(onResult?.(result)).catch((error) => {
        try { onError?.(error); } catch { /* best effort */ }
      });
    } catch (error) {
      try { onError?.(error); } catch { /* best effort */ }
    }
  };

  const handler = (session, event) => {
    if (disposed || session?.id !== sessionId) return;
    const seq = Number(event?.seq);
    if (afterSeq > 0 && Number.isFinite(seq) && seq <= afterSeq) return;
    if (event?.time !== undefined && Number.isFinite(event.time) && event.time < startedAt) return;
    if (event?.type === 'tool/call') {
      pendingTools += 1;
      return;
    }
    if (event?.type === 'tool/result') {
      pendingTools = Math.max(0, pendingTools - 1);
      return;
    }
    if (event?.type === 'user/message') {
      const source = voiceFollowupSource(event);
      if (source !== null) armed = { ...source, at: event.time ?? now() };
      return;
    }
    if (event?.type !== 'assistant/message' || armed === null) return;
    if (pendingTools > 0 || hasToolCallBlocks(event)) return;
    const text = assistantMessageText(event);
    if (text.length === 0) return;
    emit({
      text,
      source: armed,
      turn: event?.data?.turn ?? null,
      seq: event?.seq ?? null,
    });
  };

  try {
    off = ctx.on('session/event', handler);
  } catch (error) {
    fail(error instanceof Error ? error : new Error(String(error)));
    return { cancel, live: () => false };
  }
  timer = setTimeout(() => {
    if (disposed) return;
    try { note?.('voice.followup.timeout', { sessionId, armed: armed !== null }); } catch { /* best effort */ }
    cancel();
  }, Math.max(1, timeoutMs));
  timer.unref?.();

  return {
    cancel,
    live: () => disposed === false,
    get armed() { return armed !== null; },
  };
}
