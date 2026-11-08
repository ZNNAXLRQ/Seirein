/**
 * Rollover day digest: injected into the target assistant session's first request.
 *
 * It used to be delivered as its own `followup` before the user's utterance, so it opened turn 1
 * of the new session and the model answered it before the real request could start (the observed
 * delay was over two minutes of silence). It is now appended to the SAME `agent/pre-step`
 * decision that carries the user's request: background for that request, never a turn to answer.
 *
 * Isolation: the appended message carries this lane's own `source.kind`. The memory recorder, the
 * waiting-line (候音) trigger and the typed-reply lane only accept `source.kind === 'user'`, so the
 * digest is never written to memory, never spoken and never opens a turn.
 *
 * Readiness: generation stays in the background (the 04:00 rollover and `rollover.force`). This
 * lane only READS the stored digest: it never generates and awaits nothing, so a slow generation
 * can never be moved into the request path. A missing/stale/oversized digest degrades immediately
 * to the available summary or a bounded placeholder, and the outcome is logged with its duration.
 *
 * Dedupe: one injection per `(sessionId, version)`. `version` is the day stamp of the request, so
 * a retry, a multi-step turn or a repeated delivery never appends the digest twice.
 */
import { randomUUID } from 'node:crypto';

/** The one custom source kind of this lane; every other lane excludes it structurally. */
export const ROLLOVER_DIGEST_SOURCE = 'assistant-rollover-digest';
/** The label the model sees: source and date, so the block is never mistaken for the user's words. */
export const ROLLOVER_DIGEST_HEADING = '【日摘要 / 换日背景】';
/** Hard ceiling of the injected block (whole text, heading and notes included). */
export const ROLLOVER_DIGEST_MAX_CHARS = 1200;

/** True for this lane's injected context (never a user utterance). */
export function isRolloverDigestMessage(message) {
  return message?.source?.kind === ROLLOVER_DIGEST_SOURCE;
}

/** Per-reason note telling the model why the background is partial, without inventing content. */
const DEGRADED_NOTES = {
  stale: (sourceDate) => `（今日摘要尚未生成，先沿用 ${sourceDate || '上一次'} 的摘要。）`,
  missing: () => '（今日摘要尚未生成，本会话没有可沿用的摘要。）',
  truncated: () => `（摘要超出 ${ROLLOVER_DIGEST_MAX_CHARS} 字符上限，已截断。）`,
  error: () => '（摘要读取失败，本轮没有摘要内容。）',
};

/**
 * The stored digest is generated for a message (`【date】以下内容作为长期约束与背景…`). That
 * preamble is this lane's own heading now, so it is dropped instead of appearing twice in the
 * request. The rest of the text is carried verbatim.
 */
const LEGACY_PREAMBLE_RE = /^【[^】\n]*】以下内容作为长期约束与背景[^\n]*(?:\n|$)/u;

/** The digest body without the legacy message preamble. */
export function digestBodyText(text) {
  return String(text ?? '').replace(LEGACY_PREAMBLE_RE, '').trim();
}

/**
 * The exact block appended to the first request.
 * @param {{date?: string, weekday?: string, body?: string, sourceDate?: string,
 *          reason?: string, truncated?: boolean}} options
 * @returns {string}
 */
export function rolloverDigestBlock({
  date = '',
  weekday = '',
  body = '',
  sourceDate = '',
  reason = '',
  truncated = false,
} = {}) {
  const stamp = `${String(date ?? '')}${weekday ? ` ${weekday}` : ''}`.trim();
  const lines = [
    `${ROLLOVER_DIGEST_HEADING}${stamp}`,
    '来源：换日时自动生成的日摘要；这是背景资料，不是用户发言，不要复述，也不要当成新任务。',
  ];
  const note = typeof DEGRADED_NOTES[reason] === 'function' ? DEGRADED_NOTES[reason](sourceDate) : '';
  if (note.length > 0) lines.push(note);
  if (truncated && reason !== 'truncated') lines.push(DEGRADED_NOTES.truncated());
  const text = String(body ?? '').trim();
  if (text.length > 0) lines.push(text);
  else if (reason === 'missing' || reason === 'error') lines.push('（本会话按当前对话继续，不要编造昨天或昨夜的内容。）');
  return lines.join('\n');
}

/**
 * Apply the explicit character ceiling. The tail is cut (never the heading) and reported, so the
 * caller can log the degradation instead of silently sending a shorter background.
 * @returns {{text: string, truncated: boolean, fullChars: number}}
 */
export function capRolloverDigestText(text, maxChars = ROLLOVER_DIGEST_MAX_CHARS) {
  const value = String(text ?? '');
  const cap = Number.isFinite(maxChars) && maxChars > 0
    ? Math.floor(maxChars)
    : ROLLOVER_DIGEST_MAX_CHARS;
  if (value.length <= cap) return { text: value, truncated: false, fullChars: value.length };
  return { text: `${value.slice(0, Math.max(0, cap - 1))}…`, truncated: true, fullChars: value.length };
}

/**
 * Build the digest lane.
 *
 * @param {{log?: object, readDayDigest?: () => ({date?: string, digest?: string}|null),
 *          today?: () => ({date?: string, weekday?: string}), isTarget?: (sessionId: string) => boolean,
 *          isSubagent?: (agent: object) => boolean, injected?: Set<string>|null,
 *          onInjected?: ((key: string) => void)|null, maxChars?: number,
 *          now?: () => number}} [options]
 */
export function createRolloverDigest({
  log = null,
  readDayDigest = () => null,
  today = () => ({ date: '', weekday: '' }),
  isTarget = () => false,
  isSubagent = () => false,
  injected = null,
  onInjected = null,
  maxChars = ROLLOVER_DIGEST_MAX_CHARS,
  now = () => Date.now(),
} = {}) {
  const seen = injected instanceof Set ? injected : new Set();
  /** One `skipped` row per (session, reason): a non-target session is logged once, not per turn. */
  const quiet = new Set();
  const emit = (type, payload) => {
    try {
      Promise.resolve(log?.emit?.(type, payload)).catch(() => {});
    } catch {
      /* observability only: a broken log never fails the request */
    }
  };
  const skipped = (sessionId, reason, { once = false, version = '' } = {}) => {
    if (once) {
      const key = `${sessionId}\u0000${reason}`;
      if (quiet.has(key)) return;
      quiet.add(key);
      if (quiet.size > 256) quiet.delete(quiet.values().next().value);
    }
    emit('rollover.digest.skipped', version.length > 0
      ? { reason, sessionId, version }
      : { reason, sessionId });
  };

  /**
   * Decide ONE pre-step: the digest message to append, or null to leave the decision untouched.
   * Synchronous by construction — the request path never waits for digest generation.
   * @param {{agent?: object, sessionId?: string}} target
   */
  const take = ({ agent, sessionId } = {}) => {
    const startedAt = now();
    const id = typeof sessionId === 'string' ? sessionId : '';
    if (id.length === 0) return null;
    let child = true;
    try {
      child = isSubagent(agent) === true;
    } catch {
      child = true; // an unreadable identity fails closed
    }
    if (child) {
      skipped(id, 'subagent', { once: true });
      return null;
    }
    let target = false;
    try {
      target = isTarget(id) === true;
    } catch {
      target = false;
    }
    if (!target) {
      skipped(id, 'non-target-session', { once: true });
      return null;
    }
    const stamp = today() ?? {};
    const version = String(stamp.date ?? '');
    const key = `${id}\u0000${version}`;
    if (seen.has(key)) {
      skipped(id, 'duplicate', { version });
      return null;
    }
    let stored = null;
    let failed = false;
    try {
      stored = readDayDigest();
    } catch {
      failed = true;
    }
    const sourceDate = typeof stored?.date === 'string' ? stored.date : '';
    const body = digestBodyText(typeof stored?.digest === 'string' ? stored.digest : '');
    let reason = '';
    if (failed) reason = 'error';
    else if (body.length === 0) reason = 'missing';
    else if (sourceDate !== version) reason = 'stale';
    if (reason === 'error') {
      emit('rollover.digest.degraded', {
        reason, chars: 0, sessionId: id, version, ms: Math.max(0, now() - startedAt),
      });
      return null;
    }
    let text = rolloverDigestBlock({
      date: version, weekday: stamp.weekday, sourceDate, body, reason, truncated: false,
    });
    let capped = capRolloverDigestText(text, maxChars);
    if (capped.truncated) {
      // Re-render so the truncation note itself is part of the block, then apply the hard ceiling.
      text = rolloverDigestBlock({
        date: version, weekday: stamp.weekday, sourceDate, body, reason, truncated: true,
      });
      capped = capRolloverDigestText(text, maxChars);
      if (reason === '') reason = 'truncated';
    }
    seen.add(key);
    if (typeof onInjected === 'function') {
      try {
        onInjected(key);
      } catch {
        /* persistence is best-effort: the in-memory key already dedupes this process */
      }
    }
    const chars = capped.text.length;
    const ms = Math.max(0, now() - startedAt);
    if (reason === '') emit('rollover.digest.injected', { sessionId: id, chars, version, ms });
    else emit('rollover.digest.degraded', { reason, chars, sessionId: id, version, ms });
    return {
      id: randomUUID(),
      role: 'user',
      source: { kind: ROLLOVER_DIGEST_SOURCE, version, degraded: reason },
      content: [{ type: 'text', text: capped.text }],
    };
  };

  return { take, injectedKeys: seen };
}
