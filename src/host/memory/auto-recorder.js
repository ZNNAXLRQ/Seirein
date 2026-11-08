/** auto-recorder — extracted from index.js; no host entry dependency. */
import { AUTO_MEMORY_DEFAULTS } from './store.js';
import { DEFAULT_MEMORY_TIME_ZONE } from './memory-normalize.js';
import { isAssistantMemoryMessage } from '../shared/text.js';
import { memoryReferentRecord } from './memory-injection.js';
import { messageTextBlocks } from '../shared/text.js';
import { normalizeAutoMemory } from './store.js';
import { normalizeForMemory } from './memory-normalize.js';
import { resolveMemoryTimeZone } from './memory-normalize.js';
import { stripMemoryInjection } from '../shared/text.js';

/**
 * Out-of-scope / cwd-less sessions are reported once per session, then counted: one
 * `memory.auto.skipped.summary {count, windowMs}` per window (or at the session's turn/end)
 * instead of one `memory.auto.skipped` row per skipped message. A log gate only — the scope
 * decision itself never changes.
 */
export const SKIP_SUMMARY_WINDOW_MS = 5 * 60_000;

/**
 * Message-level auto recorder: one `user/message` → one record; `assistant/message` records are
 * buffered per turn and only flushed when that turn actually completed (an aborted/cancelled
 * turn's drafts never enter memory). Every write is idempotent on the Harness message id.
 *
 * Recording obeys two gates before anything is buffered or written: the memory component must
 * be on (`featureEnabled`), and the session must be in the workspace scope (`scopeOf` returns
 * `in-scope` | `out-of-scope` | `no-cwd`). Out-of-scope and cwd-less sessions record nothing and
 * emit `memory.auto.skipped` (first per session) plus `memory.auto.skipped.summary` (the counted
 * rest per `SKIP_SUMMARY_WINDOW_MS` or at turn/end), so another project's conversation can never
 * leak into memory.
 *
 * @param {{memory: object, log?: object,
 *          settings?: (() => object)|object, now?: () => number,
 *          featureEnabled?: () => boolean, scopeOf?: (session: object) => string,
 *          normalize?: (text: string, options: object) => object,
 *          timeZone?: string|(() => string),
 *          contextOf?: (sessionId: string) => object}} options
 */
export function createAutoMemoryRecorder({
  memory,
  log = null,
  settings = AUTO_MEMORY_DEFAULTS,
  now = () => Date.now(),
  featureEnabled = () => true,
  scopeOf = () => 'in-scope',
  normalize = normalizeForMemory,
  timeZone = DEFAULT_MEMORY_TIME_ZONE,
  contextOf = null,
} = {}) {
  const readSettings = () => {
    const raw = typeof settings === 'function' ? settings() : settings;
    return normalizeAutoMemory(raw);
  };
  /** Normalize the scope verdict; an unknown/failed check can only mean "do not record". */
  const scopeFor = (session) => {
    try {
      const state = scopeOf(session);
      return state === 'in-scope' || state === 'out-of-scope' ? state : 'no-cwd';
    } catch {
      return 'no-cwd';
    }
  };
  const turnBySession = new Map();
  const buffers = new Map();
  const keyFor = (sessionId, turnId) => `${sessionId}\u0000${turnId ?? 'none'}`;
  /**
   * Skip rows already reported per session: `{ reason, count, at }`. The first skip of a session is
   * written, the following ones are only counted until the window (or the session's turn/end)
   * flushes one summary — the exact skip is still fully accounted for. The entry is kept (reset)
   * after a flush, so a later skip continues the same session without a second "first" row.
   */
  const skipWindows = new Map();
  /** Flush one session's counted skips as `memory.auto.skipped.summary`; never throws. */
  const flushSkipSummary = async (sessionId) => {
    const window = skipWindows.get(sessionId);
    if (window === undefined) return;
    window.at = now();
    const count = window.count;
    window.count = 0;
    if (count === 0) return;
    try {
      await log?.emit?.('memory.auto.skipped.summary', {
        sessionId,
        reason: window.reason,
        count,
        windowMs: SKIP_SUMMARY_WINDOW_MS,
      });
    } catch {
      /* logging is best-effort */
    }
  };

  /** Zone used to resolve relative dates; a function keeps a live config change effective. */
  const zoneOf = () => resolveMemoryTimeZone(typeof timeZone === 'function' ? timeZone() : timeZone);
  /** Recent conversation for anaphora resolution (one query per write, never a second store). */
  const contextFor = (sessionId) => {
    if (typeof contextOf !== 'function') return {};
    try {
      return contextOf(sessionId);
    } catch {
      return {};
    }
  };
  /** Normalize one body; a broken normalizer must never damage the record itself. */
  const normalizedBody = (text, ts, context) => {
    const stamp = Date.parse(String(ts ?? ''));
    const at = Number.isFinite(stamp) ? stamp : now();
    try {
      return normalize(text, { now: at, timeZone: zoneOf(), context });
    } catch {
      return { text, rawText: text, changes: [], unresolved: 0, tz: zoneOf() };
    }
  };

  const write = async (role, sessionId, turnId, messageId, text, ts) => {
    if (featureEnabled() !== true) return null;
    const config = readSettings();
    if (!config.enabled) return null;
    if (role === 'assistant' && !config.includeReply) return null;
    try {
      // Stage-2 normalization runs BEFORE the write, so `text` is the contextualized body and
      // `raw_text` keeps the original wording. The same context snapshot names the record a
      // resolved pronoun was based on (`referent` link, stage 3).
      const context = contextFor(sessionId);
      const normalized = normalizedBody(text, ts, context);
      const result = memory.addMessage({
        role,
        sessionId,
        turnId,
        messageId,
        ts,
        text: normalized.text,
        domain: 'chat',
        kind: 'event',
        importance: 30,
        clarity: 'vivid',
        source: 'auto',
        minChars: config.minChars,
        maxChars: config.maxChars,
        rawText: normalized.text === normalized.rawText ? null : normalized.rawText,
        unresolved: normalized.unresolved,
        tzUsed: normalized.tz,
      });
      if (result.record !== null && typeof memory.addLink === 'function') {
        const referentId = memoryReferentRecord(normalized);
        if (referentId.length > 0) {
          try {
            memory.addLink(result.record.id, referentId, 'referent');
          } catch {
            /* a link is an enhancement; the message is already stored */
          }
        }
      }
      if (result.record !== null && (normalized.changes.length > 0 || normalized.unresolved === 1)) {
        // Kinds only: the event log never stores the memory body.
        await log?.emit?.('memory.normalize', {
          changes: normalized.changes,
          unresolved: normalized.unresolved,
          tz: normalized.tz,
        });
      }
      if (typeof log?.emit === 'function') {
        await log.emit('memory.auto', {
          role,
          records: result.record === null ? 0 : 1,
          deduped: result.deduped ? 1 : 0,
          chars: result.chars,
        });
      }
      return result;
    } catch (error) {
      // A broken memory DB must never block or alter the reply path.
      try {
        await log?.emit?.('memory.auto.failed', { role, error: error?.message ?? String(error) });
      } catch {
        /* logging is best-effort */
      }
      return null;
    }
  };

  const flush = async (sessionId, turnId) => {
    const key = keyFor(sessionId, turnId);
    const pending = buffers.get(key) ?? [];
    buffers.delete(key);
    for (const entry of pending) {
      await write('assistant', sessionId, turnId, entry.messageId, entry.text, entry.ts);
    }
    return pending.length;
  };

  const handle = async (session, event) => {
    try {
      const sessionId = typeof session?.id === 'string' ? session.id : '';
      if (sessionId.length === 0 || event === null || typeof event !== 'object') return;
      // Component gate first: a disabled memory lane is completely inert (no rows, no buffering).
      if (featureEnabled() !== true) return;
      // Workspace boundary: an unknown cwd is treated as out of scope, never as "record anyway".
      const scope = scopeFor(session);
      if (scope !== 'in-scope') {
        if (event.type === 'user/message' || event.type === 'assistant/message') {
          // One line per session, then one counting row per window (and one at turn/end): the
          // skip decision is unchanged, only its event-log emission is aggregated.
          let window = skipWindows.get(sessionId);
          if (window !== undefined && window.reason !== scope) {
            await flushSkipSummary(sessionId);
            window = undefined;
          }
          if (window === undefined) {
            skipWindows.set(sessionId, { reason: scope, count: 0, at: now() });
            await log?.emit?.('memory.auto.skipped', { reason: scope, sessionId, type: event.type });
          } else {
            window.count += 1;
            if (now() - window.at >= SKIP_SUMMARY_WINDOW_MS) await flushSkipSummary(sessionId);
          }
        } else if (event.type === 'turn/end') {
          await flushSkipSummary(sessionId);
        }
        return;
      }
      const data = event.data ?? {};
      const stamp = Number.isFinite(event.time) ? new Date(event.time).toISOString() : new Date(now()).toISOString();

      if (event.type === 'turn/start') {
        const turn = Number.isInteger(data.turn) ? data.turn : null;
        turnBySession.set(sessionId, turn);
        buffers.delete(keyFor(sessionId, turn));
        return;
      }

      if (event.type === 'user/message') {
        const source = data.source;
        // C2 isolation, checked first: the pre-step memory block is reference material and is
        // never recorded back as a user utterance.
        if (isAssistantMemoryMessage(data)) return;
        // Only genuine user text: injected system-prompt context is not something the user said.
        if (source !== undefined && source !== null && source.kind !== 'user') return;
        const message = data;
        const messageId = typeof message?.id === 'string' ? message.id : '';
        if (messageId.length === 0) return;
        const raw = messageTextBlocks(message);
        // The daily continuity digest is injected by this plugin, not typed by the user.
        if (raw.includes('以下内容作为长期约束与背景')) return;
        const text = stripMemoryInjection(raw);
        if (text.trim().length === 0) return;
        const turn = Number.isInteger(data.turn)
          ? data.turn
          : (Number.isInteger(turnBySession.get(sessionId)) ? turnBySession.get(sessionId) : null);
        await write('user', sessionId, turn, messageId, text, stamp);
        return;
      }
      if (event.type === 'assistant/message') {
        const config = readSettings();
        if (!config.enabled || !config.includeReply) return;
        if (data.interrupted === true) return;
        const message = data.message;
        const messageId = typeof message?.id === 'string' ? message.id : '';
        if (messageId.length === 0) return;
        const text = messageTextBlocks(message);
        if (text.trim().length === 0) return;
        const turn = Number.isInteger(data.turn)
          ? data.turn
          : (Number.isInteger(turnBySession.get(sessionId)) ? turnBySession.get(sessionId) : null);
        const key = keyFor(sessionId, turn);
        const pending = buffers.get(key) ?? [];
        pending.push({ messageId, text, ts: stamp });
        buffers.set(key, pending);
        return;
      }

      if (event.type === 'turn/end') {
        const turn = Number.isInteger(data.turn) ? data.turn : (turnBySession.get(sessionId) ?? null);
        const reason = typeof data.reason?.kind === 'string' ? data.reason.kind : '';
        // A missing reason is a completed turn in older feeds (same rule as the voice waiter).
        const delivered = reason === '' || reason === 'completed' || reason === 'max-tokens';
        if (delivered) {
          await flush(sessionId, turn);
        } else {
          buffers.delete(keyFor(sessionId, turn));
        }
        turnBySession.delete(sessionId);
      }
    } catch (error) {
      try {
        await log?.emit?.('memory.auto.failed', { role: '', error: error?.message ?? String(error) });
      } catch {
        /* the reply path is never blocked by memory bookkeeping */
      }
    }
  };

  return {
    handle,
    flush,
    /** Diagnostic snapshot: how many assistant messages still wait for a turn/end. */
    pending: () => [...buffers.values()].reduce((total, rows) => total + rows.length, 0),
  };
}
