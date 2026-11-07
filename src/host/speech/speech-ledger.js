/** Speech acceptance, playback ownership and completion accounting. */
/**
 * Block-boundary hand-over priorities: the turn's final answer outranks a progress cue, which
 * outranks a waiting line. Higher wins; equal priorities never hand over (plain FIFO stays).
 */
export const SPEECH_PRIORITIES = Object.freeze({ ack: 1, progress: 2, explicit: 2, answer: 3 });

/**
 * 接纳即返回的语音账本: one record per accepted call, the synthesis/playback continues in the
 * background, and every record has one ordered event stream.
 *
 * Why a ledger and not the tool body: the caller must not wait for a clip (the old `assistant_say`
 * returned only after the whole sentence had been piped, which reported "spoken" long before the
 * speaker moved and blocked the agent for seconds). The tool registers the speech at once and
 * returns `{accepted, speechId, status:'synthesizing', queued}`; the clip is produced by `run`.
 *
 * Copy the contract verbatim:
 *   - `status` starts `synthesizing`, becomes `playing` on the first audio anchor, and settles as
 *     `finished` / `failed` / `cancelled`. Nothing ever reports "played" before the player started.
 *   - Events: `speech.synth.start` -> `speech.play.start` -> `speech.finish`, or `speech.failed`,
 *     or `speech.cancelled`. Every payload carries `speechId`, `turn`, `sessionId`.
 *   - `wait()` observes only. A timeout returns `{ok:false, reason:'timeout', status}` and never
 *     cancels the clip; stopping is the separate `cancel()` action.
 *   - `speech.finish` (and the failure/cancel events) carry the three costs:
 *     `callToFirstAudioMs` (call -> first audio), `playDurationMs` (actual playback), and
 *     `queueWaitMs` (queue/dedupe wait before the background run started).
 *
 * Each accepted speech starts its own background run in the next microtask (the host's playback
 * slots still serialize the players). `queued` is true when an earlier speech of this host was
 * still unfinished at acceptance, and `queueWaitMs` is the accept -> run-start wait.
 *
 * @param {{emit?: Function, now?: Function, limit?: number}} [options]
 */
export function createSpeechLedger({ emit = async () => {}, onAudible = null, now = () => Date.now(), limit = 256 } = {}) {
  const records = new Map();
  let sequence = 0;
  let pending = 0;
  /**
   * Playback turns in ACCEPTANCE order. Synthesis may run in parallel, but only the oldest
   * unresolved speech may claim the host's single playback seat; a later request that becomes
   * ready first waits for the earlier one (FIFO), it never overtakes it.
   */
  let orderSequence = 0;
  const turnWaiters = [];

  /**
   * Cross-entry content ownership for one turn. `assistant_say` and the reply body may describe
   * the same words; the turn speaks them once. Two sentences of the same reply are a different
   * identity, so identical text in two sentences is allowed. Identity (`identity` below), never
   * text, is the idempotency key.
   */
  const spokenTexts = new Map();
  const normalizeSpokenText = (text) => String(text ?? '')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .toLowerCase();
  const turnTextKey = (sessionId, turn) => `${sessionId}\u0000${Number.isInteger(turn) ? turn : 0}`;
  // Only a complete repeat loses its playback. A reply that CONTAINS an earlier spoken sentence
  // plus new information ("我在" -> "我在这里陪你…") is a supplement, not a duplicate: a shared
  // short fragment must never swallow the rest of the sentence.
  const textOverlap = (candidate, spoken) => candidate === spoken
    || (candidate.length >= 2 && spoken.includes(candidate));
  const trimSpokenTexts = () => {
    while (spokenTexts.size > limit) {
      const oldest = spokenTexts.keys().next().value;
      if (oldest === undefined) return;
      spokenTexts.delete(oldest);
    }
  };
  const claimText = ({ sessionId = '', turn = 0, text = '', owner = 'speech', speechId = '' }) => {
    const normalized = normalizeSpokenText(text);
    if (normalized.length === 0) return { ok: true, duplicate: false, speechId, owner };
    const key = turnTextKey(sessionId, turn);
    let bucket = spokenTexts.get(key);
    if (bucket === undefined) {
      bucket = new Map();
      spokenTexts.set(key, bucket);
    }
    for (const [spoken, entry] of bucket) {
      // Content dedupe only spans the two entry kinds (tool vs automatic reply): the same entry
      // may deliberately repeat itself (assistant_say text dedupe is exact; a reply sentence is
      // identified by its sentenceId, so identical text in another sentence still plays).
      const crossEntry = (owner === 'reply') !== (entry.owner === 'reply');
      if (crossEntry !== true) continue;
      if (textOverlap(normalized, spoken)) {
        return { ok: false, duplicate: true, speechId: entry.speechId, owner: entry.owner };
      }
    }
    bucket.set(normalized, { speechId, owner, at: now() });
    trimSpokenTexts();
    return { ok: true, duplicate: false, speechId, owner };
  };
  /** A clip that failed/cancelled before sounding must not keep its text reserved. */
  const releaseText = ({ sessionId = '', turn = 0, text = '' } = {}) => {
    const normalized = normalizeSpokenText(text);
    if (normalized.length === 0) return false;
    const key = turnTextKey(sessionId, turn);
    const bucket = spokenTexts.get(key);
    if (bucket === undefined) return false;
    const removed = bucket.delete(normalized);
    if (bucket.size === 0) spokenTexts.delete(key);
    return removed;
  };
  /** `${sessionId}\0${turn}\0${kind}\0${identity}` -> speechId: replaying the same sentence id is a no-op. */
  const identities = new Map();
  const trim = () => {
    while (records.size > limit) {
      const oldestId = records.keys().next().value;
      if (oldestId === undefined) return;
      const oldest = records.get(oldestId);
      if (oldest.settled !== true) return;
      records.delete(oldestId);
      for (const [identity, speechId] of identities) {
        if (speechId === oldestId) identities.delete(identity);
      }
    }
  };
  const timingsOf = (record) => ({
    callToFirstAudioMs: record.callToFirstAudioMs,
    playDurationMs: record.playDurationMs,
    queueWaitMs: record.queueWaitMs,
  });
  /**
   * Event-facing cancellation reasons. Only three owners cancel speech: a newer turn, the user
   * (mute / barge-in / interrupt), or an explicit cancel request. The caller's raw reason stays in
   * `rawReason` for diagnosis, so old labels do not change what actually happened.
   */
  const canonicalCancelReason = (reason) => {
    const raw = String(reason ?? '').trim().toLowerCase();
    if (raw === 'turn-start') return 'turn-start';
    if (['user-interrupt', 'interrupted', 'interrupt', 'muted', 'mute', 'barge-in', 'bargein', 'voice', 'user-input'].includes(raw)) {
      return 'user-interrupt';
    }
    return 'explicit';
  };
  /** One-shot "the clip produced its first audio" latch; `playback()` waits on it. */
  const createStarted = () => {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    promise.catch(() => {});
    return { promise, resolve, reject, done: false };
  };
  const speechErrorOf = (record) => {
    const error = new Error(record.status === 'cancelled'
      ? 'Speech cancelled'
      : (record.error || `Speech ${record.status}`));
    error.code = record.status === 'cancelled' ? 'SPEECH_CANCELLED' : 'SPEECH_FAILED';
    error.reason = record.cancelReason || record.failureReason || record.status;
    return error;
  };
  const abortReasonOf = (signal) => (
    signal?.reason instanceof Error ? signal.reason : new DOMException('Speech cancelled', 'AbortError')
  );
  const waitResultOf = (record) => {
    const base = {
      speechId: record.speechId,
      status: record.status,
      turn: record.turn,
      sessionId: record.sessionId,
      sentenceId: record.sentenceId ?? null,
      ...timingsOf(record),
    };
    if (record.status === 'finished') return { ok: true, reason: '', ...base };
    if (record.status === 'cancelled') {
      return {
        ok: false, reason: 'cancelled', cancelReason: record.cancelReason,
        cancelClass: record.cancelClass ?? '', ...base,
      };
    }
    if (record.status === 'failed') {
      return { ok: false, reason: 'failed', failureReason: record.failureReason, error: record.error, ...base };
    }
    return { ok: false, reason: 'pending', ...base };
  };
  const resolveWaiters = (record) => {
    const result = waitResultOf(record);
    for (const waiter of record.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.resolve(result);
    }
  };
  /** Per-record chain: the file order on disk always matches the semantic order of one speech. */
  const emitSpeech = (record, type, extra = {}) => {
    const payload = {
      speechId: record.speechId,
      turn: record.turn,
      sessionId: record.sessionId,
      // The lane that owns this clip: `reply` (body), `say` (assistant_say) or `ack`. It lets a
      // consumer attribute the first sound of a turn from `speech.play.start` alone.
      lane: record.lane,
      sentenceId: record.sentenceId ?? null,
      status: record.status,
      ...timingsOf(record),
      ...extra,
    };
    record.chain = record.chain.then(() => emit(type, payload)).catch(() => {});
    return payload;
  };
  /** Drop one queued playback-turn request and reject it (cancel/failure/timeout). */
  const rejectTurnWaiter = (record, error) => {
    const index = turnWaiters.findIndex((waiter) => waiter.record === record);
    if (index < 0) return false;
    const [waiter] = turnWaiters.splice(index, 1);
    clearTimeout(waiter.timer);
    waiter.signal?.removeEventListener?.('abort', waiter.onAbort);
    waiter.reject(error);
    return true;
  };
  /**
   * True when this speech may take its playback turn: every earlier accepted audible speech is
   * already settled. The seat is exclusive from the moment it is granted until finish/failed/
   * cancelled — a granted clip that has not produced its first audio yet (a slow player start)
   * still holds the seat; `firstAudioAt === 0` is not permission to replace it. Silent requests
   * (`play:false`) never take a seat and are ignored here.
   */
  const canGrantPlaybackTurn = (record) => {
    for (const other of records.values()) {
      if (other.order >= record.order) continue;
      if (other.playbackExpected !== true) continue;
      // The seat is released only after the previous speech's last event was written, so the log
      // reads finish -> start. `settled` alone is too early: its finish event is still queued.
      if (other.settled === true && other.published === true) continue;
      return false;
    }
    return true;
  };
  /**
   * A yielded speech keeps its turn closed while a same-session/turn request at the preemptor's
   * priority (or higher) is still unsettled. The preemptor's later block is a NEW record, so this
   * is what keeps a multi-block preemptor whole instead of letting the yielded blocks slip between.
   */
  const continuationOf = (record) => {
    const floor = record.handoffFloor;
    if (floor === null || floor === undefined) return null;
    for (const other of records.values()) {
      if (other === record || other.settled) continue;
      if (other.sessionId !== record.sessionId || other.turn !== record.turn) continue;
      if (Number(other.priority) >= Number(floor)) return other;
    }
    return null;
  };
  /**
   * The next queued request that continues a hand-over. It is granted ahead of the yielded speech,
   * because the yielded speech may not cut the preemptor's own block sequence.
   */
  const continuationWaiter = () => {
    for (let index = 0; index < turnWaiters.length; index += 1) {
      const waiter = turnWaiters[index];
      const record = waiter.record;
      if (record.settled || waiter.signal?.aborted === true) continue;
      for (const other of records.values()) {
        if (other === record || other.settled || other.turnGranted === true) continue;
        if (other.handoffFloor === null || other.handoffFloor === undefined) continue;
        if (other.sessionId !== record.sessionId || other.turn !== record.turn) continue;
        if (Number(record.priority) >= Number(other.handoffFloor)) {
          return { waiter, index, yielded: other };
        }
      }
    }
    return null;
  };
  /** Apply one grant: remove the waiter, open its turn and let its run continue. */
  const grantTurnWaiter = (waiter, index) => {
    turnWaiters.splice(index, 1);
    clearTimeout(waiter.timer);
    waiter.signal?.removeEventListener?.('abort', waiter.onAbort);
    waiter.record.turnGranted = true;
    waiter.record.resumeAfter = null;
    waiter.record.handoffFloor = null;
    waiter.record.resumeDeferred = false;
    waiter.resolve();
  };
  /** Grant the seat only to the oldest unresolved speech that is waiting for it. */
  const pumpPlaybackTurns = () => {
    for (;;) {
      // A hand-over continuation outranks the yielded speech, even though it was accepted later.
      const continuation = continuationWaiter();
      if (continuation !== null) {
        continuation.yielded.resumeDeferred = false;
        grantTurnWaiter(continuation.waiter, continuation.index);
        return;
      }
      const head = turnWaiters[0];
      if (head === undefined) return;
      if (head.record.settled) {
        turnWaiters.shift();
        clearTimeout(head.timer);
        head.signal?.removeEventListener?.('abort', head.onAbort);
        head.reject(speechErrorOf(head.record));
        continue;
      }
      // A speech that handed its turn over resumes only after the preemptor settled, wrote its last
      // event, and has no further block queued: its remaining blocks then continue in order.
      const preemptor = head.record.resumeAfter;
      if (preemptor !== null && preemptor !== undefined) {
        if (preemptor.settled !== true || preemptor.published !== true) return;
        if (continuationOf(head.record) !== null) return;
        if (head.record.resumeDeferred !== true) {
          // Let the preemptor's chunk driver queue its next block before deciding there is none.
          head.record.resumeDeferred = true;
          setImmediate(() => { pumpPlaybackTurns(); });
          return;
        }
      }
      // A paused speech that was cancelled/invalidated must never resume: `resumeAfter` only
      // continues a LIVE yielded line. A dead lane settles here instead of sounding again later.
      if (head.record.resumeAfter !== null && head.record.resumeAfter !== undefined
        && head.record.controller.signal.aborted === true) {
        settleCancelled(head.record, 'interrupted', { resumed: false });
        continue;
      }
      if (canGrantPlaybackTurn(head.record) !== true) return;
      grantTurnWaiter(head, 0);
      return;
    }
  };
  const settle = (record, status, extra = {}) => {
    if (record.settled) return false;
    record.settled = true;
    record.status = status;
    record.finishedAt = now();
    record.failureReason = status === 'failed' ? String(extra.reason ?? 'failed') : '';
    // The ledger state and the `speech.failed` event carry the same error: a caller that asks
    // `waitSpeech`/`statusOf` instead of reading the log gets the identical reason.
    record.error = status === 'failed' ? String(extra.error ?? '') : '';
    record.playDurationMs = record.firstAudioAt > 0 ? Math.max(0, record.finishedAt - record.firstAudioAt) : 0;
    // A clip that never sounded releases its words, so a later request may still speak them.
    if (status !== 'finished' && record.firstAudioAt === 0 && record.textClaimed === true) {
      releaseText({ sessionId: record.sessionId, turn: record.turn, text: record.text });
    }
    if (status === 'finished') emitSpeech(record, 'speech.finish', { preempted: false, ...extra });
    else if (status === 'failed') emitSpeech(record, 'speech.failed', extra);
    else emitSpeech(record, 'speech.cancelled', extra);
    // Waiters see the settled state only after the last event of this speech was written.
    const publish = () => {
      resolveWaiters(record);
      record.resolveDone?.(waitResultOf(record));
      if (record.started.done !== true) {
        record.started.done = true;
        record.started.reject(speechErrorOf(record));
      }
      // Grant the next seat only after this speech's last event was written: the event log then
      // reads finish -> start, never a start that overtook the finish it was queued behind.
      record.published = true;
      pumpPlaybackTurns();
    };
    record.chain.then(publish, publish);
    // A speech that settles without ever taking its playback turn releases the queue position;
    // the next accepted speech may now be granted the seat. (Its own waiter, if any, is rejected.)
    if (record.turnGranted !== true) rejectTurnWaiter(record, speechErrorOf(record));
    return true;
  };
  const settleCancelled = (record, reason, extra = {}) => {
    if (record.settled) return false;
    const raw = String(reason ?? 'cancelled');
    const cancelClass = canonicalCancelReason(raw);
    // The user-interruption class keeps its precise source (`muted`, `barge-in`, …) in `reason`,
    // which is the long-standing event contract; `cancelClass` carries the three-way class.
    const label = cancelClass === 'user-interrupt' && raw.length > 0 ? raw : cancelClass;
    record.cancelReason = label;
    record.cancelClass = cancelClass;
    record.rawCancelReason = raw;
    record.playDurationMs = record.firstAudioAt > 0 ? Math.max(0, now() - record.firstAudioAt) : 0;
    return settle(record, 'cancelled', {
      reason: label,
      cancelReason: label,
      cancelClass,
      rawReason: raw,
      endReason: 'cancelled',
      elapsedMs: record.playDurationMs,
      ...extra,
    });
  };

  /** Register one accepted speech; returns at once and lets `run` produce the clip in the background. */
  const accept = ({
    sessionId = '', turn = 0, text = '', run = null,
    // `synthesize:false` skips `speech.synth.start` because the caller already has the audio.
    synthesize = true, kind = 'speech',
    /** Which outlet owns this clip (`say` / `reply`); reported with every speech event. */
    lane = null,
    /** Stable idempotency key for a playback-only clip (`<entry>:<sentenceId>`). */
    identity = null,
    /** The reply sentence this clip belongs to; 0-based within its reply stream. */
    sentenceId = null,
    /** Claim this turn's words so the tool line and the reply body never speak them twice. */
    claimText: takeText = false,
    /** `false` (e.g. `assistant_say play:false`) never takes a playback turn, so it never blocks. */
    playbackExpected = true,
    /** Playback priority; a strictly higher priority may take the turn at a block boundary. */
    priority = 0,
  } = {}) => {
    if (typeof run !== 'function') throw new TypeError('Speech run must be a function');
    const turnId = Number.isInteger(turn) ? turn : 0;
    const identityKey = identity === null || identity === undefined
      ? null
      : `${sessionId}\u0000${turnId}\u0000${kind}\u0000${identity}`;
    // Idempotency is identity, never text: the same sentence id delivered twice is a no-op, while
    // the same words in two different sentences (or two deliberate `assistant_say` calls) play.
    if (identityKey !== null) {
      const existing = records.get(identities.get(identityKey) ?? '');
      if (existing !== undefined && existing !== null) {
        return {
          accepted: true, speechId: existing.speechId, status: existing.status,
          queued: existing.queued, duplicate: true, reason: '',
        };
      }
    }
    const speechId = `speech-${turnId}-${++sequence}`;
    // Content ownership (tool vs automatic reply) happens before any synthesis starts, so a
    // duplicate body line never wastes a TTS call and a failed clip releases its words above.
    let textClaimed = false;
    if (takeText === true) {
      const claim = claimText({ sessionId, turn: turnId, text, owner: kind, speechId });
      if (claim.ok !== true) {
        const existing = records.get(claim.speechId ?? '');
        return {
          accepted: true,
          speechId: existing?.speechId ?? claim.speechId ?? '',
          status: existing?.status ?? 'playing',
          queued: existing?.queued ?? false,
          duplicate: true,
          reason: `已由 ${claim.owner} 入口播报`,
        };
      }
      textClaimed = true;
    }
    const record = {
      speechId,
      sessionId,
      turn: turnId,
      kind,
      sentenceId: Number.isInteger(sentenceId) ? sentenceId : null,
      /** `reply` for the body, `say` for assistant_say; also carried by every speech event. */
      lane: lane === 'reply' || lane === 'say' || lane === 'ack'
        ? lane
        : (kind === 'reply' ? 'reply' : 'say'),
      text: String(text ?? ''),
      textClaimed,
      identity: identityKey,
      /** Acceptance order: playback turns are granted strictly by this number. */
      order: ++orderSequence,
      /** Whether this request expects a playback seat at all (`play:false` does not). */
      playbackExpected: playbackExpected === true,
      /** Higher wins a block-boundary hand-over; equal never preempts (acceptance FIFO stays). */
      priority: Number.isFinite(Number(priority)) ? Number(priority) : 0,
      /** Set while this speech is paused between blocks for a preemptor; cleared on the next grant. */
      resumeAfter: null,
      /** Priority floor of the request this speech handed over to while paused; null when idle. */
      handoffFloor: null,
      /** One deferred pump pass has already run for this pause. */
      resumeDeferred: false,
      // A silent line (play:false) never waits for the playback seat: it is accepted already
      // granted, and `canGrantPlaybackTurn` ignores it because it expects no playback at all.
      turnGranted: playbackExpected !== true,
      status: 'synthesizing',
      queued: pending > 0,
      acceptedAt: now(),
      firstAudioAt: 0,
      finishedAt: 0,
      callToFirstAudioMs: 0,
      playDurationMs: 0,
      queueWaitMs: 0,
      error: '',
      cancelReason: '',
      rawCancelReason: '',
      failureReason: '',
      playing: null,
      settled: false,
      /** True once the last lifecycle event of this speech really reached the event log. */
      published: false,
      controller: new AbortController(),
      waiters: [],
      chain: Promise.resolve(),
      started: createStarted(),
      donePromise: null,
      resolveDone: null,
      run,
    };
    record.donePromise = new Promise((resolveDone) => { record.resolveDone = resolveDone; });
    record.donePromise.catch(() => {});
    pending += 1;
    records.set(speechId, record);
    if (identityKey !== null) identities.set(identityKey, speechId);
    trim();
    const start = async () => {
      try {
        if (record.settled) return;
        // The run starts in the next microtask: `queueWaitMs` is the wait a newer speech had for
        // an earlier one still accepting/starting (0 for the first line of a turn).
        record.queueWaitMs = Math.max(0, now() - record.acceptedAt);
        if (synthesize !== false) {
          emitSpeech(record, 'speech.synth.start', { queued: record.queued, queueWaitMs: record.queueWaitMs });
        }
        await run({
          speechId,
          signal: record.controller.signal,
          /** Playback session hand-over: the ledger owns cancellation of exactly this clip. */
          onPlaying: (session) => {
            if (session === null || typeof session !== 'object') return;
            if (record.settled) {
              try { session.cancel?.('cancelled'); } catch { /* already gone */ }
              return;
            }
            record.playing = session;
            // The host's single playback session cancels through here, so `speech.cancelled`
            // carries the speech id instead of being an anonymous playback event.
            session.onCancelled = (detail) => { settleCancelled(record, detail?.reason ?? 'cancelled'); };
          },
          /** First real transport anchor: only now may the status become `playing`. */
          onFirstAudio: (at) => {
            if (record.settled || record.firstAudioAt > 0) return;
            const value = Number.isFinite(at) && at > 0 ? at : now();
            record.firstAudioAt = value;
            record.status = 'playing';
            record.callToFirstAudioMs = Math.max(0, value - record.acceptedAt);
            // Observation only: report the real first-sound instant to the turn-level firstAudible
            // attribution. It runs before the event is written and never waits for it.
            try {
              onAudible?.({
                sessionId: record.sessionId,
                turn: record.turn,
                lane: record.lane,
                firstAudioAt: value,
                speechId: record.speechId,
              });
            } catch {
              /* attribution cannot break playback */
            }
            emitSpeech(record, 'speech.play.start', {
              // This record is the one owner of the single playback seat right now.
              owner: true,
              callToFirstAudioMs: record.callToFirstAudioMs,
              queueWaitMs: record.queueWaitMs,
            });
            if (record.started.done !== true) {
              record.started.done = true;
              record.started.resolve(value);
            }
          },
        });
        // A cancelled record already settled through onPlaying/settleCancelled: never double-report.
        if (!record.settled) settle(record, 'finished');
      } catch (error) {
        if (record.settled) return;
        if (record.controller.signal.aborted || error?.name === 'AbortError') {
          settleCancelled(record, record.cancelReason || 'interrupted');
        } else {
          // A queue timeout/full is its own failure reason, never a generic playback failure.
          const reason = error?.code === 'SPEECH_QUEUE_TIMEOUT' ? 'queue-timeout'
            : error?.code === 'SPEECH_QUEUE_FULL' ? 'queue-full'
              : 'failed';
          settle(record, 'failed', { error: String(error?.message ?? error), reason });
        }
      } finally {
        pending = Math.max(0, pending - 1);
      }
    };
    // Return before any synthesis: the caller only learns that the speech was accepted.
    queueMicrotask(() => { void start(); });
    return { accepted: true, speechId, status: 'synthesizing', queued: record.queued, duplicate: false, reason: '' };
  };

  /** Identity-based lookup (never text): the idempotency key a repeated delivery would reuse. */
  const lookup = ({ sessionId = '', turn = 0, kind = 'speech', identity = null } = {}) => {
    if (identity === null || identity === undefined) return null;
    const turnId = Number.isInteger(turn) ? turn : 0;
    const key = `${sessionId}\u0000${turnId}\u0000${kind}\u0000${identity}`;
    const record = records.get(identities.get(key) ?? '');
    if (record === undefined || record === null) return null;
    return {
      accepted: true, speechId: record.speechId, status: record.status,
      queued: record.queued, duplicate: true, reason: '',
    };
  };

  /**
   * Playback-only speech: the caller already synthesized the audio (a reply sentence). The ledger
   * still owns the clip's identity, its `speech.play.start`/`speech.finish` events and its text
   * ownership; `started` resolves on the first audio and `done` settles when the clip ended,
   * failed or was cancelled. A repeated identity is a no-op (`duplicate:true`), never a replay.
   */
  const playback = ({
    sessionId = '', turn = 0, text = '', sentenceId = null,
    kind = 'reply', identity = null, run = null, priority = 0,
  } = {}) => {
    const accepted = accept({
      sessionId, turn, text, run, synthesize: false, kind,
      sentenceId, identity, claimText: true, priority,
    });
    if (accepted.duplicate === true) {
      return { speechId: accepted.speechId, duplicate: true, done: Promise.resolve(accepted) };
    }
    const record = records.get(accepted.speechId);
    const done = record.donePromise.then((result) => {
      if (result.status === 'finished') return result;
      const error = speechErrorOf(record);
      error.wait = result;
      throw error;
    });
    done.catch(() => {});
    return {
      speechId: accepted.speechId,
      duplicate: false,
      started: record.started.promise,
      done,
    };
  };

  /**
   * Wait for this speech's playback turn. Turns are granted in ACCEPTANCE order: a later request
   * that synthesized faster may not overtake an older one that is still preparing. This is the
   * only ordering gate; synthesis itself keeps running in parallel.
   *
   * `reportOnly` is for a speech resuming its remaining blocks after a hand-over: a long wait is
   * reported (never a failure), so the queued blocks stay alive behind a long preemptor.
   */
  const waitPlaybackTurn = (speechId, { signal, timeoutMs, reportOnly = false } = {}) => {
    const record = records.get(String(speechId ?? ''));
    if (record === undefined || record === null) {
      return Promise.reject(Object.assign(new Error('Unknown speech'), { code: 'SPEECH_UNKNOWN' }));
    }
    if (record.settled) return Promise.reject(speechErrorOf(record));
    if (record.turnGranted === true) return Promise.resolve();
    if (signal?.aborted === true) return Promise.reject(abortReasonOf(signal));
    return new Promise((resolve, reject) => {
      const waiter = { record, resolve, reject, signal, timer: null, onAbort: null };
      waiter.onAbort = () => { rejectTurnWaiter(record, abortReasonOf(signal)); };
      const raw = Number(timeoutMs);
      const waitMs = Number.isFinite(raw) && raw >= 0 ? raw : 15_000;
      const queuedAt = now();
      let reportedSlowTurn = false;
      const armTurnTimer = () => {
        waiter.timer = setTimeout(() => {
          if (record.settled) {
            rejectTurnWaiter(record, speechErrorOf(record));
            return;
          }
          // The reply/voice lane keeps its FIFO place instead of being dropped when the seat is
          // slow: report the wait and keep queueing (the playback watchdog ends a stuck clip).
          // Other producers keep the bounded failure their callers already handle.
          if (record.kind !== 'reply' && reportOnly !== true) {
            rejectTurnWaiter(record, Object.assign(
              new Error(`放音排队超过 ${waitMs}ms`),
              { code: 'SPEECH_QUEUE_TIMEOUT' },
            ));
            return;
          }
          if (reportedSlowTurn !== true) {
            reportedSlowTurn = true;
            void emit('speech.queue.timeout', {
              speechId: record.speechId,
              lane: record.kind,
              waitMs: Math.round(now() - queuedAt),
              status: 'waiting',
            }).catch(() => {});
          }
          armTurnTimer();
        }, waitMs);
        waiter.timer.unref?.();
      };
      armTurnTimer();
      // Insert by acceptance order; a later request may have queued before an earlier one.
      let index = turnWaiters.length;
      while (index > 0 && turnWaiters[index - 1].record.order > record.order) index -= 1;
      turnWaiters.splice(index, 0, waiter);
      signal?.addEventListener?.('abort', waiter.onAbort, { once: true });
      pumpPlaybackTurns();
    });
  };

  /**
   * Block-boundary hand-over: the caller has finished a block and still has blocks left. Only a
   * request that is ALREADY waiting, in the same session and turn, with a strictly higher priority
   * may take the turn; the current block is never cut and the remaining blocks stay queued
   * (`resumeAfter`), resuming after the preemptor settles. No waiter means no switch at all.
   *
   * @returns {{toSpeechId: string, remainingChunks: number}|null}
   */
  const handoffAtBlockBoundary = (speechId, { remainingChunks = 0 } = {}) => {
    const record = records.get(String(speechId ?? ''));
    if (record === undefined || record === null || record.settled || record.turnGranted !== true) return null;
    let best = null;
    let bestIndex = -1;
    for (let index = 0; index < turnWaiters.length; index += 1) {
      const other = turnWaiters[index].record;
      if (other === record || other.settled) continue;
      if (other.sessionId !== record.sessionId || other.turn !== record.turn) continue;
      if (!(Number(other.priority) > Number(record.priority))) continue;
      if (best === null || other.priority > best.priority
        || (other.priority === best.priority && other.order < best.order)) {
        best = other;
        bestIndex = index;
      }
    }
    if (best === null) return null;
    const [waiter] = turnWaiters.splice(bestIndex, 1);
    clearTimeout(waiter.timer);
    waiter.signal?.removeEventListener?.('abort', waiter.onAbort);
    const remaining = Math.max(0, Math.trunc(Number(remainingChunks)) || 0);
    record.turnGranted = false;
    record.resumeAfter = best;
    record.handoffFloor = Number(best.priority);
    record.resumeDeferred = false;
    best.turnGranted = true;
    best.resumeAfter = null;
    best.handoffFloor = null;
    best.resumeDeferred = false;
    void Promise.resolve(emit('speech.seat.handoff', {
      fromSpeechId: record.speechId,
      toSpeechId: best.speechId,
      atChunkBoundary: true,
      remainingChunks: remaining,
      sessionId: record.sessionId,
      turn: record.turn,
    })).catch(() => {});
    waiter.resolve();
    return { toSpeechId: best.speechId, remainingChunks: remaining };
  };

  /**
   * Observe one speech. Resolves on finish/failure/cancel; a timeout reports only the current
   * status and deliberately leaves the clip playing (cancellation is `cancel()`).
   */
  const wait = (speechId, { timeoutMs } = {}) => {
    const record = records.get(String(speechId ?? ''));
    if (record === undefined || record === null) {
      return Promise.resolve({ ok: false, reason: 'unknown', status: 'unknown', speechId: String(speechId ?? '') });
    }
    if (record.settled) return Promise.resolve(waitResultOf(record));
    const raw = Number(timeoutMs);
    const limitMs = Number.isFinite(raw) && raw >= 0 ? raw : 30_000;
    return new Promise((resolve) => {
      const waiter = { resolve, timer: null };
      waiter.timer = setTimeout(() => {
        const index = record.waiters.indexOf(waiter);
        if (index >= 0) record.waiters.splice(index, 1);
        resolve({
          ok: false, reason: 'timeout', status: record.status,
          speechId: record.speechId, turn: record.turn, sessionId: record.sessionId,
        });
      }, limitMs);
      waiter.timer.unref?.();
      record.waiters.push(waiter);
    });
  };

  /** Stop one speech: cancel event first, then the player (the same action, never a wait timeout). */
  const cancel = (speechId, reason = 'explicit', extra = {}) => {
    const record = records.get(String(speechId ?? ''));
    if (record === undefined || record === null) {
      return { ok: false, reason: 'unknown', status: 'unknown', speechId: String(speechId ?? '') };
    }
    if (record.settled) return { ok: false, reason: 'settled', status: record.status, speechId: record.speechId };
    settleCancelled(record, reason, extra);
    try { record.controller.abort(new DOMException('Speech cancelled', 'AbortError')); } catch { /* already aborted */ }
    try { record.playing?.cancel?.(String(reason ?? 'cancelled')); } catch { /* the session is gone */ }
    return { ok: true, reason: '', status: 'cancelled', speechId: record.speechId };
  };

  /** Mute/barge-in/teardown: every unfinished speech reports its own `speech.cancelled`. */
  const cancelAll = (reason = 'explicit') => {
    let count = 0;
    for (const record of [...records.values()]) {
      if (cancel(record.speechId, reason).ok === true) count += 1;
    }
    return count;
  };

  /** A newer turn evicts the previous round's unfinished speech, exactly like the voice lanes. */
  const cancelBefore = (sessionId, turn, reason = 'turn-start') => {
    if (!Number.isInteger(turn)) return 0;
    let count = 0;
    for (const record of [...records.values()]) {
      if (record.settled || record.sessionId !== sessionId) continue;
      if (!Number.isInteger(record.turn) || record.turn >= turn) continue;
      if (cancel(record.speechId, reason, { preemptedBy: 'turn/start' }).ok === true) count += 1;
    }
    return count;
  };

  return {
    accept,
    playback,
    waitPlaybackTurn,
    handoffAtBlockBoundary,
    lookup,
    claimText,
    releaseText,
    wait,
    cancel,
    cancelAll,
    cancelBefore,
    /** Read-only snapshot used by the tool's own diagnostics and by tests. */
    statusOf: (speechId) => {
      const record = records.get(String(speechId ?? ''));
      return record === undefined || record === null ? null : waitResultOf(record);
    },
    get size() {
      return records.size;
    },
  };
}
