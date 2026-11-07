import {
  DIALOGUE_SUMMARY_DEFAULTS,
  dialogueSummaryRequest,
  normalizeDialogueSummary,
} from '../../shared/text.js';

/* ---------------------------------------------------------------------------------------------
 * Continuous dialogue, host side: prompt injection + rolling summary.
 *
 * `dialogueContext.js` owns the buffer (verbatim window + pending queue + stored summary). This
 * block is the host contract around it and is deliberately free of I/O so it can be tested alone:
 *  - injection is a pure READ of the rendered snapshot; an empty buffer renders '' and therefore
 *    adds no system section at all;
 *  - the rolling summary is a BACKGROUND call on the existing lightweight channel. It is
 *    generation- and version-scoped, keeps `pending` when it fails, and backs off exponentially
 *    (5 s → 60 s cap) with no timer: the next request simply re-checks;
 *  - neither half writes memory or a database, and the transcript never becomes a user message.
 * ------------------------------------------------------------------------------------------- */

/** Right after the persona section (100), before the compiled profile (150). */
export const DIALOGUE_INJECTION_ORDER = 110;

const DIALOGUE_SUMMARY_SYSTEM = [
  '你是连续台词的滚动摘要器。只根据给出的内容写摘要，绝不编造人物、事件、话题或指代。',
  '把【旧摘要】与【待摘要原文】合并成一段不超过 400 字的摘要，写清：出现的人物、发生了什么事件、聊的是什么话题、以及尚未解决的指代（「他」「那个」指谁）。',
  '不要逐句复述，不要评价，不要输出标题、JSON 或任何标记；只输出摘要正文。',
].join('\n');

const DIALOGUE_SUMMARY_INSTRUCTION = '只输出摘要正文，不解释过程，不复述原文，不新增未出现的信息。';

/**
 * Background rolling summary for one dialogue buffer.
 *
 * `render()` is the prompt-facing half: it returns the current text immediately and only STARTS a
 * summary when one is due, so a request never waits for the model. A failed/slow attempt leaves
 * `pending` untouched and pushes the next attempt out (exponential, capped), still without a timer.
 *
 * @param {{context?: object|null, ask?: Function|null, emit?: Function, now?: Function,
 *          maxChars?: number, maxTokens?: number, timeoutMs?: number,
 *          retryBaseMs?: number, retryMaxMs?: number}} [options]
 */
export function createDialogueSummaryRunner(options = {}) {
  const settings = options !== null && typeof options === 'object' ? options : {};
  const context = settings.context ?? null;
  const ask = typeof settings.ask === 'function' ? settings.ask : null;
  const emit = typeof settings.emit === 'function' ? settings.emit : async () => {};
  const clock = (() => {
    const source = settings.now;
    if (typeof source !== 'function') return () => Date.now();
    return () => {
      try {
        const value = Number(source());
        return Number.isFinite(value) ? value : Date.now();
      } catch {
        return Date.now();
      }
    };
  })();
  const maxChars = Number(settings.maxChars) > 0 ? Number(settings.maxChars) : DIALOGUE_SUMMARY_DEFAULTS.maxChars;
  const maxTokens = Number(settings.maxTokens) > 0 ? Number(settings.maxTokens) : DIALOGUE_SUMMARY_DEFAULTS.maxTokens;
  const timeoutMs = Number(settings.timeoutMs) > 0 ? Number(settings.timeoutMs) : DIALOGUE_SUMMARY_DEFAULTS.timeoutMs;
  const retryBaseMs = Number(settings.retryBaseMs) > 0 ? Number(settings.retryBaseMs) : DIALOGUE_SUMMARY_DEFAULTS.retryBaseMs;
  const retryMaxMs = Number(settings.retryMaxMs) > 0 ? Number(settings.retryMaxMs) : DIALOGUE_SUMMARY_DEFAULTS.retryMaxMs;

  let stopped = false;
  let inFlight = false;
  let attempts = 0;
  let nextAttemptAt = 0;
  let epoch = 0;
  let controller = null;

  const failureReason = (error) => {
    const code = typeof error?.code === 'string' && error.code.length > 0 ? error.code : '';
    return (code || String(error?.name || error?.message || error || 'failed') || 'failed').slice(0, 120);
  };
  /** Telemetry must never turn a successful summary into a failure: the sink is best-effort. */
  const announce = async (type, payload) => {
    try {
      await emit(type, payload);
    } catch {
      /* an event sink cannot change the summary outcome */
    }
  };

  /** Start one attempt when it is due. Returns whether a new attempt was started. */
  const maybeSummarize = () => {
    if (stopped || inFlight || ask === null || context === null) return false;
    if (clock() < nextAttemptAt) return false;
    let snapshot = null;
    try {
      snapshot = context.snapshot();
    } catch {
      return false;
    }
    if (snapshot?.needsSummary !== true) return false;
    const request = dialogueSummaryRequest(snapshot);
    if (request.chars === 0 || request.through <= 0 || request.generation <= 0) return false;
    inFlight = true;
    const token = epoch;
    const startedAt = clock();
    const lane = new AbortController();
    controller = lane;
    const settled = (async () => {
      let failure = '';
      try {
        const result = await ask({
          task: 'persona-rewrite',
          context: 'none',
          system: DIALOGUE_SUMMARY_SYSTEM,
          instruction: DIALOGUE_SUMMARY_INSTRUCTION,
          user: request.user,
          maxTokens,
          timeoutMs,
          signal: lane.signal,
        });
        if (stopped || token !== epoch) return;
        const text = normalizeDialogueSummary(result?.text, maxChars);
        if (text.length === 0) failure = 'empty';
        else {
          const applied = context.applySummary(text, { through: request.through, generation: request.generation });
          if (applied?.ok !== true) failure = String(applied?.reason ?? 'rejected');
          else {
            attempts = 0;
            nextAttemptAt = 0;
            await announce('voice.dialogue.summary', {
              ok: true,
              ms: Math.max(0, clock() - startedAt),
              through: request.through,
              chars: Array.from(String(applied.summary ?? text)).length,
            });
            return;
          }
        }
      } catch (error) {
        if (stopped || token !== epoch) return;
        failure = failureReason(error);
      } finally {
        // A stop() bumps the epoch and already clears the flag; an attempt from an older epoch
        // must never clear the flag of a newer one that started right after the restart.
        if (token === epoch) {
          inFlight = false;
          if (controller === lane) controller = null;
        }
      }
      if (stopped || token !== epoch) return;
      attempts += 1;
      nextAttemptAt = clock() + Math.min(retryBaseMs * 2 ** (attempts - 1), retryMaxMs);
      await announce('voice.dialogue.summary.failed', { reason: failure.length > 0 ? failure : 'failed' });
    })();
    settled.catch(() => {});
    return true;
  };

  /** Prompt-facing read. Never awaits the model: it only kicks a due summary in the background. */
  const render = () => {
    let text = '';
    try {
      text = context === null ? '' : context.render();
    } catch {
      text = '';
    }
    maybeSummarize();
    return typeof text === 'string' ? text.trim() : '';
  };

  /** Listening opened: summaries are allowed again and the backoff restarts clean. */
  const start = () => {
    stopped = false;
    attempts = 0;
    nextAttemptAt = 0;
    return true;
  };

  /** Listening closed: abort the attempt in flight; nothing more is written for this buffer. */
  const stop = () => {
    stopped = true;
    epoch += 1;
    inFlight = false;
    const lane = controller;
    controller = null;
    if (lane !== null) {
      try {
        lane.abort(new Error('dialogue-summary-stopped'));
      } catch {
        /* already settled */
      }
    }
    return true;
  };

  /**
   * Capture sessions (mic / loopback) holding the summary open. Each path holds one lease: while
   * any lease is held the summary keeps running, and only the last release stops it. A direct
   * `stop()` (Host teardown) is not undone by a later release.
   */
  const leases = new Set();
  /**
   * Acquire/release one holder's lease. The first acquire restarts a stopped summary; the last
   * release aborts the attempt in flight. The debug event reports the count after the change.
   */
  const lease = (op, holder) => {
    if (typeof holder !== 'string' || holder.length === 0) return false;
    const idle = leases.size === 0;
    if (op === 'acquire') {
      leases.add(holder);
      if (idle || stopped) start();
    } else {
      leases.delete(holder);
      if (leases.size === 0) stop();
    }
    void announce('voice.dialogue.summary.lease', { op, holder, active: leases.size });
    return true;
  };

  return {
    render,
    maybeSummarize,
    start,
    stop,
    acquire: (holder) => lease('acquire', holder),
    release: (holder) => lease('release', holder),
    status: () => ({
      stopped, inFlight, attempts, nextAttemptAt, active: leases.size, holders: [...leases],
    }),
  };
}
