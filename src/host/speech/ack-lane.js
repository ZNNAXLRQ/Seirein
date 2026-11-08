/** ack-lane — extracted from index.js; no host entry dependency. */
import { ACK_BODY_PHASES } from './ack-speech.js';
import { ACK_DELAY_MS } from './ack-speech.js';
import { planAckPriority } from './ack-speech.js';
import { validateAckLine } from './ack-speech.js';

/**
 * The last-resort waiting line (selection tier c): spoken only when this turn's draft has no audio
 * yet and the warm pool has no line. A fixed generic line, synthesized at the deadline, that never
 * promises an action or a duration.
 */
export const ACK_FALLBACK_LINE = '我在这儿听着你慢慢说';


/**
 * Waiting-line ("候音") lane: one short spoken line per turn when the reply body is slow.
 *
 * The only trigger is the clock: the lane starts preparing when the user message is delivered,
 * and at `delayMs` it plays a ready line if the reply body has not started speaking. No tool
 * name, category or task keyword is consulted. The line is drafted from the persona and this
 * turn's user message in one independent short request, in the CAPTION (subtitle) language;
 * translation to the voice language and synthesis start immediately after the text is final.
 * The caption shown to the user is always the caption-language text, never the speech translation.
 *
 * At the deadline the tier is chosen from what is ready at that instant, in this order: this
 * turn's own draft (text AND audio) first, otherwise a warm pool line, otherwise the fixed
 * `ACK_FALLBACK_LINE`. The deadline never waits for a slow draft: a draft that only has text, or
 * fails, or is still synthesizing loses the turn. A line that already played is never replaced by
 * a draft that arrives later.
 *
 * The lane sits beside the voice/tool/typed channels but never claims the turn's voice owner.
 * `claimed` keeps one line per turn, and every record is keyed by (sessionId, turn), so an
 * interrupt, a newer turn or a cancelled answer aborts generation, synthesis and playback
 * together; a late result is discarded rather than played.
 *
 * Events: `voice.ack.spoken {turn, chars, source, ackTriggerMs, ackReadyMs, ackFirstAudioMs,
 * bodyFirstAudioMs}`, `voice.ack.source {turn, source:'draft'|'warm'|'fallback', draftReadyMs}`
 * (debug, throttled), `voice.ack.body-first` with the same timing fields, `voice.ack.skipped
 * {turn, reason}`, `voice.ack.failed {turn, stage, reason, error}`, `voice.ack.cancelled
 * {turn, reason}`, `voice.ack.kept {turn, reason:'body-synthesizing', bodyPhase}` and
 * `voice.ack.cache.hit {turn, key, captionLang, speechLang}`. A body that is still synthesizing
 * keeps the line (there is no audio that could speak first), so no cancellation/supersede row
 * exists for that case. A fire with no usable tier writes `voice.ack.silent {turn, reason}`.
 *
 * @param {object} options injected seams
 * @returns {{beginTurn: Function, answerStart: Function, bodyStarted: Function,
 *            bodySynthesizing: Function, bodyReady: Function, cancel: Function,
 *            cancelTurn: Function, cancelSuperseded: Function, whenIdle: Function, records: Map}}
 */
export function createAckLane({
  emit = async () => {},
  generate = null,
  synthesize = null,
  play = null,
  persona = () => '',
  /** The subtitle language: the draft/warm TEXT is generated in this language. */
  captionLang = () => 'zh-CN',
  /** The voice language: only the speech translation/synthesis uses it, never the caption. */
  speechLang = () => 'zh-CN',
  enabled = () => true,
  captureSignal = null,
  /** A2 warm pool: the synchronous `take()` that serves tier b at the deadline, never a request. */
  warm = null,
  /** Observation only: the line's real first-sound instant, for the turn's firstAudible lane. */
  onFirstAudio = null,
  delayMs = ACK_DELAY_MS,
  timeoutMs = () => 1200,
  now = () => Date.now(),
  limit = 128,
} = {}) {
  /** `${sessionId}\u0000${turn}` -> record (kept after settling for the body-start timing). */
  const records = new Map();
  /** Turn keys that already earned a line attempt; a second trigger is refused. */
  const claimed = new Set();
  /** The last few spoken waiting lines: context for the next draft, never a memory lookup. */
  const recentLines = [];
  /** Debug only, throttled: which tier served a line and how early the draft was ready. */
  const ACK_SOURCE_LOG_MS = 30_000;
  const ackSourceLoggedAt = new Map();
  const log = async (type, payload) => {
    try {
      await emit(type, payload);
    } catch {
      /* the event log is best-effort */
    }
  };
  const keyOf = (sessionId, turn) => `${String(sessionId ?? '')}\u0000${String(turn ?? '')}`;
  /** A language seam may be a function (read per line) or a fixed string. */
  const langOf = (value) => {
    try {
      const resolved = typeof value === 'function' ? value() : value;
      return typeof resolved === 'string' && resolved.length > 0 ? resolved : 'zh-CN';
    } catch {
      return 'zh-CN';
    }
  };
  const elapsed = (from, to) => (from > 0 && to >= from ? Math.round(to - from) : null);
  /** Observation only: report this line's real first sound for the turn's firstAudible lane. */
  const noteAudible = (record) => {
    if (!(record.firstAudioAt > 0)) return;
    try {
      onFirstAudio?.({
        sessionId: record.sessionId,
        turn: record.turn,
        lane: 'ack',
        firstAudioAt: record.firstAudioAt,
      });
    } catch {
      /* attribution cannot break the line */
    }
  };
  const timings = (record) => ({
    ackTriggerMs: elapsed(record.deliveredAt, record.triggeredAt),
    ackReadyMs: elapsed(record.deliveredAt, record.readyAt),
    ackFirstAudioMs: elapsed(record.deliveredAt, record.firstAudioAt),
    bodyFirstAudioMs: elapsed(record.deliveredAt, record.bodyFirstAt),
  });
  /** Absolute stamps: the four stages stay readable even when a later one never happened. */
  const stamps = (record) => ({
    prepareStartedAt: record.prepareStartedAt > 0 ? record.prepareStartedAt : null,
    textReadyAt: record.textReadyAt > 0 ? record.textReadyAt : null,
    audioReadyAt: record.audioReadyAt > 0 ? record.audioReadyAt : null,
    playedAt: record.playedAt > 0 ? record.playedAt : null,
  });
  const droppedMs = (record, at = 0) => elapsed(record.deliveredAt, at > 0 ? at : record.droppedAt);
  /**
   * Debug only, throttled per tier: `voice.ack.source {turn, source, draftReadyMs}`. `draftReadyMs`
   * is the draft's own text+audio readiness before the deadline, and null when the draft lost.
   */
  const noteSource = (record, source) => {
    const at = now();
    if (at - (ackSourceLoggedAt.get(source) ?? 0) < ACK_SOURCE_LOG_MS) return false;
    ackSourceLoggedAt.set(source, at);
    if (ackSourceLoggedAt.size > 4) {
      ackSourceLoggedAt.delete(ackSourceLoggedAt.keys().next().value);
    }
    void log('voice.ack.source', {
      turn: record.turn,
      source,
      draftReadyMs: record.ready === true && record.readyAt > 0
        ? elapsed(record.deliveredAt, record.readyAt)
        : null,
    });
    return true;
  };
  const trim = () => {
    while (claimed.size > limit) claimed.delete(claimed.values().next().value);
    if (records.size > limit) {
      for (const [key, record] of records) {
        if (record.settled) {
          records.delete(key);
          break;
        }
      }
    }
  };
  const finalize = (record) => {
    if (record.settled) return;
    if (record.timer !== null) {
      clearTimeout(record.timer);
      record.timer = null;
    }
    record.settled = true;
    record.settle();
  };
  /**
   * A record whose draft already failed and that never chose a tier has no clip to cancel: it is
   * settled silently, so neither the body's first audio nor its readiness writes a drop row.
   */
  const releaseFailedDraft = (record) => {
    if (record.draftFailed !== true || record.source !== '') return false;
    finalize(record);
    return true;
  };
  /** Cancellation is terminal: abort generation/synthesis/playback and drop a late result. */
  const cancelRecord = (record, reason, event = 'cancelled') => {
    if (record.settled) return false;
    record.cancelled = true;
    record.reason = reason;
    record.droppedAt = now();
    try {
      record.controller.abort(new DOMException(String(reason), 'AbortError'));
    } catch {
      /* already aborted */
    }
    void log(event === 'skipped'
      ? 'voice.ack.skipped'
      : event === 'superseded' ? 'voice.ack.superseded' : 'voice.ack.cancelled', {
      turn: record.turn,
      reason,
      ackDroppedMs: droppedMs(record),
      bodyPhase: record.bodyPhase,
      ...timings(record),
      ...stamps(record),
    });
    finalize(record);
    return true;
  };
  const ackError = (reason, message) => {
    const error = new Error(message);
    error.ackReason = reason;
    return error;
  };
  /**
   * Draft and synthesize the line immediately, in parallel with the answer. A failure (model
   * error, budget expiry, rejected text, synthesis error) means the draft loses the deadline and
   * the warm pool / fallback tier serves the turn instead.
   */
  const prepare = (record, input) => {
    record.prepareStartedAt = now();
    const task = (async () => {
      try {
        if (typeof generate !== 'function') throw ackError('generate', '生成器不可用');
        const budget = Math.max(1, Number(timeoutMs()) || 1200);
        const draft = new AbortController();
        record.draftController = draft;
        // A draft that lost the deadline is aborted through this controller, so its late TTS never
        // competes with the line that already owns the turn.
        const draftSignal = AbortSignal.any([record.signal, draft.signal]);
        const generation = Promise.resolve().then(() => generate({
          // The explicit ack input package: persona + this message + the last few waiting lines
          // only. The channel renders it and never retrieves memory or the chat history.
          ack: {
            persona: persona(),
            userText: input.userText,
            recent: recentLines.slice(-3),
            // The draft is the CAPTION text: generate it in the subtitle language, never in the
            // voice language. The speech translation happens after the text is final.
            language: langOf(captionLang),
          },
          signal: draftSignal,
        })).then((text) => ({ ok: true, text }), (error) => ({ ok: false, error }));
        let timer = null;
        const budgetOut = new Promise((resolve) => {
          timer = setTimeout(() => {
            draft.abort();
            resolve({ ok: false, timedOut: true });
          }, budget);
          timer.unref?.();
        });
        const outcome = await Promise.race([generation, budgetOut]);
        if (timer !== null) clearTimeout(timer);
        if (record.cancelled) return false;
        // A warm/fallback line already spoke for this turn: the draft loses and stays silent.
        if (record.source !== '') return false;
        if (outcome.timedOut === true) throw ackError('timeout', '候音生成超时');
        if (outcome.ok !== true) throw ackError('generate', outcome.error?.message ?? String(outcome.error));
        // The generator may return text alone (tests) or `{text, context}`; the package path has
        // no context, so the echo check compares against the current message only.
        const draftValue = outcome.text;
        const draftText = typeof draftValue === 'string'
          ? draftValue
          : (typeof draftValue?.text === 'string' ? draftValue.text : '');
        const draftContext = typeof draftValue?.context === 'string' ? draftValue.context : '';
        const checked = validateAckLine(draftText.trim(), { context: draftContext, userText: input.userText });
        if (!checked.ok) throw ackError('validate', checked.reason);
        record.line = checked.line;
        record.captionText = checked.line;
        record.speechText = checked.line;
        if (recentLines.length >= 3) recentLines.shift();
        recentLines.push(checked.line);
        // Text is final: start translation + TTS at once instead of waiting for the two-second
        // deadline. The translation is therefore never started by the trigger itself.
        record.textReadyAt = now();
        if (typeof synthesize === 'function') {
          const audio = await synthesize({
            speech: checked.line,
            captionText: checked.line,
            captionLang: langOf(captionLang),
            speechLang: langOf(speechLang),
            signal: draftSignal,
            turn: record.turn,
          });
          if (record.cancelled) return false;
          if (record.source !== '') return false;
          if (audio === null || audio === undefined) throw ackError('synthesize', '候音合成失败');
          record.audio = audio;
          // The synth outlet returns the caption it was given and the translated speech it spoke;
          // a seam that only returns audio keeps the caption as the source line.
          if (typeof audio.captionText === 'string' && audio.captionText.length > 0) {
            record.captionText = audio.captionText;
            record.line = audio.captionText;
          }
          if (typeof audio.speechText === 'string' && audio.speechText.length > 0) {
            record.speechText = audio.speechText;
          }
        }
        record.audioReadyAt = now();
        record.readyAt = record.audioReadyAt;
        record.ready = true;
        return true;
      } catch (error) {
        if (record.cancelled) return false;
        // The turn is already owned by a warm/fallback line: never report or settle it here.
        if (record.source !== '') return false;
        // The draft lost, but the deadline may still serve the warm pool or the fixed fallback:
        // the record stays pending until `fire()` decides, instead of settling into silence.
        record.draftFailed = true;
        record.droppedAt = now();
        const reason = typeof error?.ackReason === 'string' ? error.ackReason : 'prepare';
        await log('voice.ack.failed', {
          turn: record.turn,
          stage: reason,
          reason,
          error: error?.message ?? String(error),
          ackDroppedMs: droppedMs(record),
          ...timings(record),
          ...stamps(record),
        });
        return false;
      }
    })();
    record.prep = task;
    return task;
  };
  /**
   * Pick the tier that serves the deadline, synchronously. Only tier a requires BOTH text and
   * audio (`record.ready`); a text-only draft is not usable and falls through to the warm pool.
   *
   * @returns {'draft'|'warm'|'fallback'|''} `''` only when no tier can produce a clip
   */
  const chooseSource = (record) => {
    if (record.ready === true) return 'draft';
    let warmLine = null;
    if (warm !== null && typeof warm?.take === 'function') {
      try {
        warmLine = warm.take();
      } catch {
        warmLine = null;
      }
    }
    if (warmLine !== null && warmLine !== undefined) {
      // The pool entry already carries both halves: `captionText` in the subtitle language and
      // the pre-translated `speechText` that its audio was synthesized from.
      const warmCaption = typeof warmLine.captionText === 'string' && warmLine.captionText.length > 0
        ? warmLine.captionText
        : (typeof warmLine.text === 'string' ? warmLine.text : '');
      if (warmCaption.length > 0) {
        record.warmHit = true;
        record.warmKey = String(warmLine.key ?? '');
        record.line = warmCaption;
        record.captionText = warmCaption;
        record.speechText = typeof warmLine.speechText === 'string' && warmLine.speechText.length > 0
          ? warmLine.speechText
          : warmCaption;
        record.audio = warmLine.audio ?? null;
        record.textReadyAt = now();
        record.audioReadyAt = record.textReadyAt;
        void log('voice.ack.cache.hit', {
          turn: record.turn,
          key: record.warmKey,
          chars: [...record.line].length,
          captionLang: warmLine.captionLang ?? '',
          speechLang: warmLine.speechLang ?? '',
        });
        return 'warm';
      }
    }
    return typeof synthesize === 'function' ? 'fallback' : '';
  };
  /**
   * The two-second deadline: the tier is chosen from what is ready at this instant. The deadline
   * never waits for the draft (a text-only or still-synthesizing draft loses), and a line that
   * already played is never replaced by a draft that arrives later.
   */
  const fire = async (record) => {
    record.timer = null;
    if (record.cancelled || record.settled) return;
    record.triggeredAt = now();
    if (record.bodyStarted === true) {
      cancelRecord(record, 'body-first-audio');
      return;
    }
    // A1: the body's state at the deadline decides. Only a body whose audio is ready may preempt
    // the line (`cancel`, body-ready); a body that has not started or is still synthesizing keeps
    // it (`kept`, body-synthesizing / body-not-started) because no audio exists that could speak
    // first. A playing line is never cut.
    const priority = planAckPriority({ bodyPhase: record.bodyPhase, ackPlaying: record.playing });
    if (priority.action === 'supersede' || priority.action === 'cancel') {
      cancelRecord(record, priority.reason, priority.event);
      return;
    }
    // The policy kept the line (the body still has no audio to speak first): record the verdict
    // right before the tier is chosen, so it is visible even when the player itself never starts.
    if (priority.event === 'kept') {
      void log('voice.ack.kept', {
        turn: record.turn,
        reason: priority.reason,
        bodyPhase: record.bodyPhase,
        ...timings(record),
      });
    }
    // Tier order, decided synchronously at the trigger: draft (text + audio) > warm pool > fixed
    // fallback. A failed draft already logged `voice.ack.failed`; it simply loses here.
    const source = chooseSource(record);
    if (source === '') {
      // No tier could produce a clip. The silence is a real outcome, not a lost record: report it
      // with the reason so a turn whose draft failed is never indistinguishable from no attempt.
      await log('voice.ack.silent', {
        turn: record.turn,
        reason: record.draftFailed === true ? 'draft-failed' : 'no-tier',
        draftFailed: record.draftFailed === true,
        bodyPhase: record.bodyPhase,
        ...timings(record),
      });
      finalize(record); // no tier could produce a clip: silence, never a hung record
      return;
    }
    record.source = source;
    // A losing draft is stopped: its late text/audio must never replace the chosen line.
    if (source !== 'draft') record.draftController?.abort?.(new DOMException('tier-selected', 'AbortError'));
    noteSource(record, source);
    try {
      let speech = record.speechText || record.line;
      let audio = record.audio;
      if (source === 'fallback') {
        // Tier c has no audio ahead of time: synthesize the fixed line now. The trigger itself
        // already happened; this bridge is the fallback's own cost, never a delay of the trigger.
        audio = await synthesize({
          speech: ACK_FALLBACK_LINE,
          captionText: ACK_FALLBACK_LINE,
          captionLang: langOf(captionLang),
          speechLang: langOf(speechLang),
          signal: record.signal,
          turn: record.turn,
        });
        if (record.cancelled || record.settled) return;
        if (audio === null || audio === undefined) throw ackError('fallback', '通用兜底合成失败');
        speech = typeof audio.speechText === 'string' && audio.speechText.length > 0
          ? audio.speechText
          : ACK_FALLBACK_LINE;
        const caption = typeof audio.captionText === 'string' && audio.captionText.length > 0
          ? audio.captionText
          : ACK_FALLBACK_LINE;
        record.line = caption;
        record.captionText = caption;
        record.speechText = speech;
        record.audio = audio;
        record.textReadyAt = now();
        record.audioReadyAt = record.textReadyAt;
      }
      const started = await play({
        speech,
        // The visible line is the caption text (subtitle language); `audio` already speaks the
        // translated speech text, so the player never has to translate on the trigger path.
        caption: record.captionText || record.line,
        audio,
        signal: record.signal,
        turn: record.turn,
      });
      if (record.cancelled) return;
      // "Playing" is a fact about the player's real first audio, not about `play()` resolving:
      // the session's own start hook back-fills `startedAt` (a player can report it later).
      const session = started?.session ?? null;
      if (session !== null && typeof session.onStart === 'function') {
        let confirmStart;
        const confirmed = new Promise((resolveStart) => { confirmStart = resolveStart; });
        session.onStart((info) => {
          const at = Number(info?.startedAt);
          if (!(at > 0)) return;
          record.playing = true;
          record.playedAt = Math.round(at);
          record.firstAudioAt = record.playedAt;
          noteAudible(record);
          confirmStart(true);
        });
        // A session that already started resolves inside `onStart`; one that has not gets a short
        // bounded wait so a player that never starts is reported as a play failure, never hung.
        const deadline = new Promise((resolveDeadline) => {
          const timer = setTimeout(resolveDeadline, 1500);
          timer.unref?.();
        });
        await Promise.race([confirmed, deadline]);
      } else {
        const at = Number(started?.audioStartedAt);
        if (at > 0) {
          record.playing = true;
          // The real first-audio instant of the clip, not the moment the trigger timer fired.
          record.playedAt = Math.round(at);
          record.firstAudioAt = record.playedAt;
          noteAudible(record);
        }
      }
      if (record.playing !== true) throw ackError('play', '候音未能播放');
      await log('voice.ack.spoken', {
        sessionId: record.sessionId,
        turn: record.turn,
        // Join keys: `lane` attributes the first sound; `firstAudioAt` is the absolute instant
        // the relative `ackFirstAudioMs` was computed from.
        lane: 'ack',
        firstAudioAt: record.firstAudioAt > 0 ? record.firstAudioAt : null,
        chars: [...record.line].length,
        source: record.source,
        ackDroppedMs: null,
        ...timings(record),
        ...stamps(record),
      });
      await started?.done;
    } catch (error) {
      if (!record.cancelled) {
        record.failed = true;
        record.droppedAt = now();
        const reason = typeof error?.ackReason === 'string' ? error.ackReason : 'play';
        await log('voice.ack.failed', {
          turn: record.turn,
          stage: reason,
          reason,
          error: error?.message ?? String(error),
          ackDroppedMs: droppedMs(record),
          ...timings(record),
          ...stamps(record),
        });
      }
    } finally {
      finalize(record);
    }
  };
  /**
   * Claim one turn's waiting line at message delivery. Generation and synthesis start right here,
   * in parallel with the answer, so the deadline never waits for the model or TTS.
   */
  const beginTurn = ({ sessionId = '', turn = null, userText = '' } = {}) => {
    if (!Number.isInteger(turn)) {
      void log('voice.ack.skipped', { turn, reason: 'no-turn' });
      return { ack: false, reason: 'no-turn' };
    }
    const turnKey = keyOf(sessionId, turn);
    if (enabled() !== true) {
      void log('voice.ack.skipped', { turn, reason: 'disabled' });
      return { ack: false, reason: 'disabled' };
    }
    let external = null;
    if (typeof captureSignal === 'function') {
      try {
        external = captureSignal();
      } catch {
        void log('voice.ack.skipped', { turn, reason: 'muted' });
        return { ack: false, reason: 'muted' };
      }
    }
    if (external !== null && external !== undefined && external.aborted === true) {
      void log('voice.ack.skipped', { turn, reason: 'muted' });
      return { ack: false, reason: 'muted' };
    }
    // One line per turn: a repeated delivery for the same turn never drafts a second one.
    if (claimed.has(turnKey)) {
      void log('voice.ack.skipped', { turn, reason: 'already-acknowledged' });
      return { ack: false, reason: 'already-acknowledged' };
    }
    claimed.add(turnKey);
    trim();
    const controller = new AbortController();
    let settle;
    const record = {
      key: turnKey,
      sessionId,
      turn,
      controller,
      signal: external === null || external === undefined
        ? controller.signal
        : AbortSignal.any([controller.signal, external]),
      deliveredAt: now(),
      triggeredAt: 0,
      prepareStartedAt: 0,
      textReadyAt: 0,
      audioReadyAt: 0,
      readyAt: 0,
      firstAudioAt: 0,
      playedAt: 0,
      droppedAt: 0,
      bodyFirstAt: 0,
      bodyPhase: ACK_BODY_PHASES.idle,
      bodySynthesizingAt: 0,
      bodyReadyAt: 0,
      ready: false,
      warmHit: false,
      warmKey: '',
      bodyStarted: false,
      bodyReported: false,
      playing: false,
      source: '',
      line: '',
      captionText: '',
      speechText: '',
      audio: null,
      cancelled: false,
      settled: false,
      failed: false,
      draftFailed: false,
      reason: '',
      prep: null,
      draftController: null,
      timer: null,
      done: null,
      settle: null,
    };
    /** The shared mute/barge-in signal dying means this line is cancelled with the answer. */
    const onExternalAbort = () => cancelRecord(record, 'interrupted');
    record.done = new Promise((resolveDone) => { settle = resolveDone; });
    const resolveRecord = settle;
    record.settle = () => {
      external?.removeEventListener?.('abort', onExternalAbort);
      resolveRecord();
    };
    records.set(turnKey, record);
    if (external !== null && external !== undefined && typeof external.addEventListener === 'function') {
      external.addEventListener('abort', onExternalAbort, { once: true });
    }
    // The draft always starts at delivery: it is tier a, so it must be able to win the deadline.
    // The warm pool is NOT taken here; it is only a fallback if the draft is not fully ready.
    void prepare(record, { userText });
    // 候音等待是运行期设置：每轮开始时读取，改完立即对下一轮生效，不必重装。
    const resolvedDelay = typeof delayMs === 'function' ? delayMs() : delayMs;
    record.timer = setTimeout(() => { void fire(record); }, Math.max(0, Number(resolvedDelay) || ACK_DELAY_MS));
    record.timer.unref?.();
    return { ack: true, reason: 'ok' };
  };
  /**
   * The reply body is ready to speak. This is NOT "the body is sounding": an unplayed line is
   * never cancelled here (only `bodyStarted`, i.e. the body's real first audio, may cancel it);
   * a line already playing is allowed to finish first.
   *
   * The verdict is evaluated on every call, never cached: a line that was still preparing at the
   * first request can be playing by the next one, and only the live `playing` fact may turn the
   * answer into "finish the line first". (Only the generation result is cached, inside the
   * record; the release decision is not.)
   */
  const answerStart = ({ sessionId = '', turn = null } = {}) => {
    const record = records.get(keyOf(sessionId, turn));
    if (record === undefined) return Promise.resolve({ action: 'none' });
    if (record.playing !== true) return Promise.resolve({ action: 'speak' });
    return record.done.then(() => ({ action: 'finish-ack-then-answer' }));
  };
  /**
   * The reply body actually started playing: the last stamp in the ack timing row, and a cancel
   * for a line that has not started even when `answerStart` was not called.
   */
  const bodyStarted = ({ sessionId = '', turn = null, at = 0 } = {}) => {
    const record = records.get(keyOf(sessionId, turn));
    if (record === undefined) return false;
    if (record.bodyFirstAt === 0) {
      const value = Number(at);
      record.bodyFirstAt = Number.isFinite(value) && value > 0 ? Math.round(value) : now();
    }
    record.bodyStarted = true;
    record.bodyPhase = ACK_BODY_PHASES.playing;
    // The body's real first audio is the one thing that cancels an unplayed line. The reason says
    // so explicitly; "the answer is ready/preparing" never reaches this path. A draft that already
    // failed left no clip behind: it is merely settled, never reported as a cancellation.
    const cancelled = record.playing === true || releaseFailedDraft(record)
      ? false
      : cancelRecord(record, 'body-first-audio');
    if (record.bodyReported !== true) {
      record.bodyReported = true;
      void log('voice.ack.body-first', {
        turn: record.turn,
        ackDroppedMs: record.playing === true ? null : droppedMs(record),
        ...timings(record),
        ...stamps(record),
      });
    }
    return cancelled;
  };
  /**
   * A1: the reply body's first sentence entered synthesis. The line is not cancelled here: it
   * keeps its own clock, and the two-second priority verdict decides whether it may still speak.
   * This only records the three-state fact so the verdict is never guessed from playback timings.
   */
  const bodySynthesizing = ({ sessionId = '', turn = null } = {}) => {
    const record = records.get(keyOf(sessionId, turn));
    if (record === undefined) return false;
    if (record.bodySynthesizingAt === 0) record.bodySynthesizingAt = now();
    if (record.bodyPhase === ACK_BODY_PHASES.idle) record.bodyPhase = ACK_BODY_PHASES.synthesizing;
    return true;
  };
  /**
   * A1: the reply body's first clip has its audio ready. An unplayed line is cancelled at once
   * (`body-ready`) and the body speaks; a line already sounding is never cut and keeps the existing
   * "finish the line first" rule.
   */
  const bodyReady = ({ sessionId = '', turn = null } = {}) => {
    const record = records.get(keyOf(sessionId, turn));
    if (record === undefined) return false;
    if (record.bodyReadyAt === 0) record.bodyReadyAt = now();
    if (record.bodyPhase !== ACK_BODY_PHASES.playing) record.bodyPhase = ACK_BODY_PHASES.ready;
    if (record.playing === true || record.settled === true) return false;
    if (releaseFailedDraft(record)) return false;
    return cancelRecord(record, 'body-ready');
  };
  /**
   * The named `(sessionId, turn)` body really started sounding: cancel exactly that turn's
   * unplayed line. The tool path knows its own scope; a global `cancel()` would also cut another
   * conversation's (or an older turn's) waiting line.
   */
  const cancelBodyStarted = ({ sessionId = '', turn = null } = {}) => {
    const record = records.get(keyOf(sessionId, turn));
    return record === undefined ? false : cancelRecord(record, 'body-first-audio');
  };
  /** Cancel exactly one `(sessionId, turn)` line; the host uses this for aborted/ended turns. */
  const cancelTurn = (sessionId = '', turn = null, reason = 'interrupted') => {
    const record = records.get(keyOf(sessionId, turn));
    return record === undefined ? false : cancelRecord(record, reason);
  };
  /** A newer turn replaces every unfinished line of the same session (late results are dropped). */
  const cancelSuperseded = (sessionId = '', keepTurn = null, reason = 'superseded') => {
    const prefix = `${String(sessionId ?? '')}\u0000`;
    let cancelled = false;
    for (const record of records.values()) {
      if (record.turn === keepTurn || !record.key.startsWith(prefix)) continue;
      if (cancelRecord(record, reason)) cancelled = true;
    }
    return cancelled;
  };
  /** Mute, barge-in, supersede, shutdown: drop generation, queue and playback for every line. */
  const cancel = (reason = 'interrupted') => {
    let cancelled = false;
    for (const record of records.values()) {
      if (cancelRecord(record, reason)) cancelled = true;
    }
    return cancelled;
  };
  /** Wait for every line the lane started (tests and shutdown diagnostics). */
  const whenIdle = async () => {
    for (;;) {
      const active = [...records.values()].filter((record) => !record.settled);
      if (active.length === 0) return;
      await Promise.allSettled(active.map((record) => record.done));
    }
  };
  /** Read-only view of the latest line per turn: phase plus every stage stamp (status route). */
  const phaseOf = (record) => {
    if (record.settled) return record.playing ? 'played' : 'dropped';
    if (record.playing) return 'playing';
    if (record.cancelled || record.failed) return 'dropped';
    return record.ready ? 'ready' : 'preparing';
  };
  const status = () => [...records.values()].map((record) => ({
    sessionId: record.sessionId ?? '',
    turn: record.turn,
    phase: phaseOf(record),
    reason: record.reason ?? '',
    source: record.source ?? '',
    captionText: record.captionText ?? record.line ?? '',
    speechText: record.speechText ?? record.line ?? '',
    bodyPhase: record.bodyPhase ?? ACK_BODY_PHASES.idle,
    warmKey: record.warmKey ?? '',
    ackDroppedMs: droppedMs(record),
    ...timings(record),
    ...stamps(record),
  }));
  return {
    beginTurn,
    answerStart,
    bodyStarted,
    bodySynthesizing,
    bodyReady,
    cancelBodyStarted,
    cancel,
    cancelTurn,
    cancelSuperseded,
    whenIdle,
    status,
    records,
  };
}
