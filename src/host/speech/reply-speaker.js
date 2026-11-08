/** reply-speaker — extracted from index.js; no host entry dependency. */
import { DEFAULT_SPEECH_MAX_CHARS } from './speech-text.js';
import { limitSpeechToSentences } from '../shared/text.js';
import { resolveSpeechBudget } from './speech-text.js';
import { rm } from 'node:fs/promises';
import { speechCharCount } from '../shared/text.js';
import { takeSentences } from '../shared/text.js';
import { chunkPlayer } from './chunk-capabilities.js';

/** `voice.prefetchDepth` bounds: how many sentences may be synthesized ahead of playback. */
export const DEFAULT_VOICE_PREFETCH_DEPTH = 2;

export const VOICE_PREFETCH_DEPTH_MIN = 1;

export const VOICE_PREFETCH_DEPTH_MAX = 3;

/**
 * Read-only lifecycle diagnostic for one reply speaker. Transition-only (a repeated state is
 * collapsed) and throttled, so a long clip cannot flood the event log. `ageMs` is measured from the
 * speaker's `startedAt`, which is what distinguishes "still translating/synthesizing" from "queued"
 * and "really playing". `speechId` is the host ledger id as soon as the play seam reports it; before
 * the first clip it is this speaker's own stable id.
 */
export const SPEECH_LIFECYCLE_EVENT = 'voice.speech.lifecycle';

/** Minimum gap before the same state may be reported again (a phase transition always reports). */
export const SPEECH_LIFECYCLE_MIN_MS = 1_000;

/** One speaker id per invocation (module-local; diagnostics only, never a ledger identity). */
let replySpeakerSequence = 0;

/** Clamp the configurable `voice.prefetchDepth`; a missing/invalid value keeps the default 2. */
export function resolveVoicePrefetchDepth(value, fallback = DEFAULT_VOICE_PREFETCH_DEPTH) {
  const numeric = typeof value === 'number'
    ? value
    : (typeof value === 'string' && value.trim().length > 0 ? Number(value) : Number.NaN);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(VOICE_PREFETCH_DEPTH_MAX, Math.max(VOICE_PREFETCH_DEPTH_MIN, Math.round(numeric)));
}


// ---- spoken version: one answer, two expressions, one voice outlet --------
// The session/memory keep the full body. The automatic lane speaks exactly one "spoken version":
// the original text for a short answer, a condensed rewrite for a long one, and the full body when
// the rewrite fails. Nothing here writes a second assistant message.
export const DEFAULT_SPOKEN_VERSION_WAIT_MS = 800;

/** Budget for the rewrite itself once the answer is complete (the channel also enforces a deadline). */
export const SPOKEN_VERSION_TIMEOUT_MS = 6_000;

/**
 * The streamed rewrite is a HANG guard, not a first-audio deadline: the first unit already started
 * translation + synthesis, so cutting the stream at the old 6 s would truncate an answer the user is
 * already hearing. A silent provider is still aborted here, and a cancelled turn aborts immediately.
 */
const SPOKEN_STREAM_HANG_MS = 20_000;

export const SPOKEN_VERSION_WAIT_MIN_MS = 100;

export const SPOKEN_VERSION_WAIT_MAX_MS = 8_000;


/** Clamp `voice.spokenWaitMs`: the short cap that keeps the first audio from waiting on a rewrite. */
export function resolveSpokenWaitMs(value, fallback = DEFAULT_SPOKEN_VERSION_WAIT_MS) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.min(SPOKEN_VERSION_WAIT_MAX_MS, Math.max(SPOKEN_VERSION_WAIT_MIN_MS, Math.round(numeric)));
}


/**
 * Duplicate tasks are identified by `(sessionId, turn, replyVersion, purpose)` — never by text
 * similarity. The session is part of the key because two sessions can be on the same turn number
 * and must not collapse each other's progress line.
 * `purpose='explicit'` is an independent `assistant_say` line and is not collapsed here.
 * @returns {{claim: Function, has: Function, release: Function, clear: Function, size: Function}}
 */
export function createSpokenTaskDedupe({ limit = 256 } = {}) {
  const seen = new Map();
  const keyOf = ({ sessionId = '', turn = null, replyVersion = 0, purpose = 'answer' } = {}) => {
    const version = Number.isFinite(Number(replyVersion)) ? Math.max(0, Math.floor(Number(replyVersion))) : 0;
    return `${String(sessionId ?? '')}\u0000${turn ?? 'none'}\u0000${version}\u0000${String(purpose || 'answer')}`;
  };
  return {
    claim({ sessionId = '', turn = null, replyVersion = 0, purpose = 'answer', text = '' } = {}) {
      const key = keyOf({ sessionId, turn, replyVersion, purpose });
      const prior = seen.get(key);
      if (prior !== undefined) return { ok: false, duplicate: true, key, prior };
      seen.set(key, { text: String(text ?? ''), at: Date.now() });
      while (seen.size > Math.max(1, limit)) seen.delete(seen.keys().next().value);
      return { ok: true, duplicate: false, key };
    },
    has(options = {}) {
      return seen.has(keyOf(options));
    },
    release(key) {
      return seen.delete(String(key ?? ''));
    },
    clear() {
      seen.clear();
    },
    size: () => seen.size,
  };
}


/**
 * P-65 fallback when the chunk driver is unavailable (a test double replaced `tts.js` before it
 * exported one): exactly the previous one-clip-per-sentence contract, with the same summary shape.
 */
async function speakSingleBlock({ chunks, first = null, sentenceId = 0, play, signal = undefined, onStart = null }) {
  const text = chunks[0];
  const chunkId = `${sentenceId}:0`;
  const started = await play({ audio: first, text, chunkId, index: 0, count: 1, signal });
  const audioStartedAt = Number(started?.audioStartedAt) || 0;
  const summary = {
    status: 'completed',
    chunks: 1,
    texts: [text],
    chunkIds: [chunkId],
    playedChunks: audioStartedAt > 0 ? 1 : 0,
    skipped: started?.skipped === true ? 1 : 0,
    playedText: audioStartedAt > 0 ? text : '',
    firstAudioAt: audioStartedAt,
    lastAudioAt: audioStartedAt,
    firstStarted: started ?? null,
  };
  try { onStart?.({ index: 0, chunkId, count: 1, started }); } catch { /* observation only */ }
  await started?.done;
  return summary;
}


/**
 * Speak one reply sentence by sentence while its text is still arriving.
 *
 * `push(delta)` appends newly available body text, splits it, and starts synthesis as soon as a
 * complete sentence exists. While one clip plays, up to `prefetchDepth` more sentences are
 * synthesized ahead (default 2, clamped to 1–3 by `resolveVoicePrefetchDepth`); playback itself
 * stays strictly serial, and the depth cap counts both running synthesizers and ready clips, so a
 * long answer is never synthesized in one burst. The first sentence is always synthesized as soon
 * as it is queued, never behind the prefetch window. `finish({fullText})` flushes the unterminated
 * tail exactly once, waits for the last clip to end, and — only when nothing was ever played —
 * speaks the whole reply, so a split/synthesis failure or an empty delta stream cannot swallow the
 * answer. `cancel()` closes the queue, aborts the clip in flight, and deletes every prefetched clip
 * that never reached the player; later pushes are ignored.
 *
 * Injected seams keep the ordering rules testable: `synthesize({text, signal})` produces audio,
 * `play({audio, text, signal})` resolves once the player has actually started, with
 * `{audioStartedAt, done}` (`done` settles when the clip ends; an `audioStartedAt` of 0 means
 * nothing was played), and `speakWhole(text)` is the existing whole-turn path. A player that
 * throws before confirming its start is a failure, not a played clip. `now()`/`startedAt` exist
 * so a fake clock can prove timing. `maxChars` is the shared `voice.speechMaxChars` budget
 * (resolved once through `resolveSpeechBudget`, 0 means "speak it all"): a sentence that would
 * cross it ends the spoken share instead of being cut in half, and `finish` applies the same cap
 * to the fallback. `prefetchDepth` is the configurable `voice.prefetchDepth`; `onEvent` receives
 * `{type: 'voice.prefetch', …}` as the window fills, and `onBudget` receives one final
 * `{type: 'voice.speech.budget', requestedChars, spokenChars, truncated, keptSentences,
 * droppedSentences}`.
 *
 * P-65: one sentence may be spoken as comma-sized blocks. The lane's `synthesize` seam returns
 * the already-prepared sentence audio plus `chunkTexts` and `synthesizeChunk`; this speaker then
 * plays block 0 and synthesizes block N+1 while block N plays (one-block lookahead). The play
 * seam still receives the whole sentence text and a `chunkIndex`, so the caption/ledger stay
 * per sentence. Without `chunkTexts` the path is exactly the old one-clip-per-sentence one.
 *
 * @returns {{push: Function, finish: Function, cancel: Function, stats: object,
 *            hasPlayed: Function}}
 */
export function createReplySpeaker({
  synthesize: synthesizeSentence,
  play: playSentence,
  speakWhole = null,
  split = takeSentences,
  signal = undefined,
  startedAt = Date.now(),
  maxChars = DEFAULT_SPEECH_MAX_CHARS,
  budget: resolveBudget = resolveSpeechBudget,
  prefetchDepth = DEFAULT_VOICE_PREFETCH_DEPTH,
  onEvent = null,
  /** A5: the final `{type:'voice.speech.budget', …}` report, kept separate from prefetch events. */
  onBudget = null,
  now = () => Date.now(),
} = {}) {
  const controller = new AbortController();
  const lane = signal === undefined || signal === null ? controller.signal : AbortSignal.any([signal, controller.signal]);
  // ---- C: lifecycle + explicit release -----------------------------------
  // One clip may be replaced/cancelled while its player never settles. The speaker must still let
  // go of its active ownership, otherwise the response group stays "playing" for minutes.
  replySpeakerSequence += 1;
  const speakerId = `reply-speaker-${replySpeakerSequence}`;
  let active = true;
  let lifecycleSpeechId = '';
  let lifecycleState = '';
  let lifecycleAt = 0;
  const lifecycleStartedAt = Number.isFinite(Number(startedAt)) && Number(startedAt) > 0
    ? Number(startedAt)
    : now();
  /** The host's ledger speech id rides on the play session; keep it once it is observable. */
  const noteLifecycleSpeechId = (session) => {
    const id = session?.owner?.speechId;
    if (typeof id === 'string' && id.length > 0) lifecycleSpeechId = id;
  };
  /** Terminal lifecycle states are reported once; the others may re-report after the throttle. */
  const LIFECYCLE_FINAL = new Set(['finished', 'failed', 'cancelled', 'released']);
  /** Transition-only, throttled `voice.speech.lifecycle {speechId, state, ageMs, reason}`. */
  const emitLifecycle = (state, reason = '', extra = {}) => {
    if (typeof onEvent !== 'function') return;
    // Once the speaker released its ownership, later cleanup must not reopen the lifecycle stream
    // (the release row is the last one a consumer may rely on).
    if (!active) return;
    const at = now();
    if (state === lifecycleState
      && (LIFECYCLE_FINAL.has(state) || at - lifecycleAt < SPEECH_LIFECYCLE_MIN_MS)) return;
    lifecycleState = state;
    lifecycleAt = at;
    try {
      onEvent({
        type: SPEECH_LIFECYCLE_EVENT,
        // Stable across every phase of this speaker, so early (pre-play) rows join later ones.
        speakerId,
        // The host ledger id once the play seam reports it; before that the speaker id is used.
        speechId: lifecycleSpeechId.length > 0 ? lifecycleSpeechId : speakerId,
        state,
        ageMs: Math.max(0, at - lifecycleStartedAt),
        reason: String(reason ?? ''),
        ...extra,
      });
    } catch {
      /* observation cannot break playback */
    }
  };
  const releaseActive = (reason) => {
    if (!active) return;
    emitLifecycle('released', reason);
    // The release row is written first; from here no later cleanup may claim the speaker is alive.
    active = false;
  };
  const abortReason = () => (
    lane.reason instanceof Error ? lane.reason : new DOMException('Reply speech cancelled', 'AbortError')
  );
  /**
   * Resolve/reject with the lane: a cancelled or superseded version must not keep `run()` (and
   * therefore `finish()`) waiting on a player/synthesis promise that may never settle.
   */
  const abortable = (promise) => {
    if (lane.aborted) return Promise.reject(abortReason());
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(abortReason());
      lane.addEventListener('abort', onAbort, { once: true });
      Promise.resolve(promise).then(
        (value) => { lane.removeEventListener('abort', onAbort); resolve(value); },
        (error) => { lane.removeEventListener('abort', onAbort); reject(error); },
      );
    });
  };
  const speechBudget = resolveBudget({ maxChars });
  let remaining = speechBudget.unbounded ? Infinity : speechBudget.maxChars;
  const stats = {
    sentences: 0,
    played: 0,
    /** Sentences skipped because the turn already spoke the same words (never counted as played). */
    skipped: 0,
    chars: 0,
    // A5: the budget report. `chars` mirrors `spokenChars` for older listeners.
    requestedChars: 0,
    spokenChars: 0,
    truncated: false,
    keptSentences: 0,
    droppedSentences: 0,
    fallback: false,
    partial: false,
    cancelled: false,
    error: '',
    firstQueuedAt: 0,
    firstSynthStartedAt: 0,
    // Gap A: the first and the last clip have separate stamps. Only the first sentence may feed
    // the latency stage; overwriting the stamp with every later clip recorded the last one.
    firstPlayStartedAt: 0,
    lastPlayStartedAt: 0,
    firstQueuedMs: 0,
    // First-sentence breakdown (all 0 until measured):
    // queued -> synthesis start, synthesis, audio ready -> player start, player start -> sound.
    firstSynthWaitMs: 0,
    firstSynthMs: 0,
    firstQueueWaitMs: 0,
    firstPlayerStartMs: 0,
    /**
     * Player spawn -> player-ready of the first block (0 when the transport reports no readiness).
     * This is PROCESS readiness only, never decoded PCM or speaker sound.
     */
    firstSpawnToPlayerReadyMs: 0,
    /** Synthesis slot wait of the first sentence (0 when its slot was free). */
    firstTtsSlotWaitMs: 0,
    /** Translation-gate wait of the first sentence (0 when no gate wait was measured). */
    firstTranslateQueueWaitMs: 0,
    /** The first block's live player session, read at finish() for the spawn anchor. */
    firstStartSession: null,
    /** True while the player cannot report the instant the sound card actually started. */
    firstPlayerStartUnknown: true,
    // Translation attribution for the first sentence (0/false when it was already the speech
    // language). Filled by the lane's synthesize seam; never from a later prefetched clip.
    firstTranslateMs: 0,
    firstTranslateCached: false,
    firstTranslated: false,
  };
  let buffer = '';
  let queue = [];
  let waiters = [];
  let closed = false;
  let cancelled = false;
  let failure = null;
  let running = null;
  /** True once any clip really produced sound; the fallback decision uses this, not `played`. */
  let playedAny = false;
  /** A5: `voice.speech.budget` is reported once, after the last sentence was considered. */
  let budgetReported = false;
  /** Clock at which the first sentence's audio became available; 0 until then. */
  let firstSynthDoneAt = 0;
  /** A: how far ahead playback may be synthesized, and how many such slots are in use. */
  const depth = resolveVoicePrefetchDepth(prefetchDepth);
  /** Prefetch slots in sentence order; each settles to `{value: entry|null}` or `{error}`. */
  let ahead = [];
  /** The entry playing now (or the first one, before the loop starts). */
  let current = null;
  /** Running synthesizers right now; `maxAhead` is its high-water mark for the event log. */
  let synthActive = 0;
  let maxAhead = 0;
  let lastPrefetchEvent = '';

  const stopped = () => cancelled || failure !== null || lane.aborted;
  const release = (value) => {
    for (const resume of waiters.splice(0)) resume(value);
  };
  /** Observability only: one `voice.prefetch` event per changed window, never on the hot path. */
  const notifyPrefetch = () => {
    if (typeof onEvent !== 'function') return;
    const prepared = ahead.length;
    const signature = `${prepared}:${maxAhead}`;
    if (signature === lastPrefetchEvent) return;
    lastPrefetchEvent = signature;
    try {
      onEvent({ type: 'voice.prefetch', depth, prepared, maxAhead });
    } catch {
      /* observation cannot break playback */
    }
  };

  const nextSentence = () => {
    if (queue.length > 0) return Promise.resolve(queue.shift());
    if (closed || stopped()) return Promise.resolve(null);
    return new Promise((resolve) => { waiters.push(resolve); });
  };

  const synthesizeItem = async (item) => {
    if (lane.aborted) throw lane.reason ?? new DOMException('Reply speech cancelled', 'AbortError');
    const synthAt = now();
    if (stats.firstSynthStartedAt === 0) stats.firstSynthStartedAt = synthAt;
    if (lifecycleState === '' || lifecycleState === 'queued') {
      emitLifecycle('synthesizing', 'first-sentence');
    }
    // The seam must observe cancellation too: a provider that ignores its signal may otherwise
    // pin the run (and `finish`) long after this version was replaced.
    const pendingAudio = Promise.resolve(synthesizeSentence({ text: item.text, sentenceId: item.seq, signal: lane }));
    let audio;
    try {
      audio = await abortable(pendingAudio);
    } catch (error) {
      // Released before the clip arrived: a provider that ignores its signal may still return it.
      // It never reached the player, so delete its file whenever that late result finally lands.
      void pendingAudio.then((lateAudio) => discardAudio(lateAudio), () => {});
      throw error;
    }
    if (lane.aborted) {
      await discardAudio(audio);
      throw lane.reason ?? new DOMException('Reply speech cancelled', 'AbortError');
    }
    // Only the first sentence's stage payload is reported; prefetched later clips are not measured.
    if (item.seq === 0) {
      stats.firstTranslated = audio?.translated === true;
      stats.firstTranslateCached = audio?.cached === true;
      const translateMs = Number(audio?.translateMs);
      if (Number.isFinite(translateMs) && translateMs > 0) stats.firstTranslateMs = Math.round(translateMs);
      // Observation only: how long this sentence waited for a translation slot and for a TTS
      // synthesis slot. Both were previously folded into the first-block synthesis time.
      const translateWaitMs = Number(audio?.translateQueueWaitMs);
      if (Number.isFinite(translateWaitMs) && translateWaitMs >= 0) {
        stats.firstTranslateQueueWaitMs = Math.round(translateWaitMs);
      }
      const slotWaitMs = Number(audio?.slotWaitMs);
      if (Number.isFinite(slotWaitMs) && slotWaitMs >= 0) stats.firstTtsSlotWaitMs = Math.round(slotWaitMs);
    }
    if (item.seq === 0 && firstSynthDoneAt === 0) firstSynthDoneAt = now();
    return audio;
  };

  /** One prefetch slot: reserve the next sentence and synthesize it while the current clip plays. */
  const launchPrefetch = () => {
    if (stopped() || ahead.length >= depth) return false;
    const task = (async () => {
      const next = await nextSentence();
      if (next === null || stopped()) return null;
      synthActive += 1;
      if (synthActive > maxAhead) maxAhead = synthActive;
      try {
        return { item: next, audio: await synthesizeItem(next) };
      } finally {
        synthActive -= 1;
      }
    })().then((value) => {
      notifyPrefetch();
      return { value };
    }, (error) => {
      notifyPrefetch();
      return { error };
    });
    ahead.push(trackPrefetch(task));
    notifyPrefetch();
    return true;
  };

  /**
   * A5: a prefetched clip that never reached the player is still the producer's, so its file is
   * deleted with the same force-remove rule `tts.js` applies to a rejected slot. Deletion never
   * waits for a synthesizer; a slot's settle hook removes a late result when it lands.
   */
  const discardAudio = async (audio) => {
    const file = typeof audio?.file === 'string' && audio.file.length > 0 ? audio.file : '';
    if (file.length === 0) return;
    try {
      await rm(file, { force: true });
    } catch (error) {
      // Cleanup is diagnostic only: a failed unlink must never fail finish() or the run.
      try {
        onEvent?.({
          type: 'voice.speech.cleanup.failed',
          level: 'debug',
          file,
          error: String(error?.code ?? error?.message ?? error),
        });
      } catch {
        /* observation cannot break playback */
      }
    }
  };
  /**
   * A prefetch keeps its cleanup responsibility until the playback loop adopts it. A slot still
   * `pending` when the speaker stops deletes its file whenever synthesis settles — including a
   * late result that arrives after `finish()`. `adopted` slots belong to playback, not cleanup.
   */
  const trackPrefetch = (task) => {
    const slot = { task, audio: null, settled: false, state: 'pending' };
    task.then((outcome) => {
      slot.settled = true;
      slot.audio = outcome?.value?.audio ?? null;
      if (slot.state === 'discarded') void discardAudio(slot.audio);
    }, () => { slot.settled = true; });
    return slot;
  };
  const discardSlot = async (slot) => {
    if (slot.state !== 'pending') return;
    slot.state = 'discarded';
    // Ready now -> delete now (bounded, local); still synthesizing -> the settle hook deletes it.
    if (slot.settled) await discardAudio(slot.audio);
  };
  const discardAhead = async () => {
    const pending = ahead.splice(0);
    // Never wait for a synthesizer here: a cancelled/replaced version must release immediately.
    // Each slot owns its late result, so no prefetched file can outlive the speaker.
    const removals = pending.map((slot) => discardSlot(slot));
    if (pending.length > 0) notifyPrefetch();
    await Promise.all(removals);
  };

  const run = async () => {
    try {
      // The first sentence is the latency-critical path: it is reserved and synthesized the
      // instant a complete sentence exists, never behind the prefetch window.
      const first = await nextSentence();
      if (first === null || stopped()) return;
      current = { item: first, audio: await synthesizeItem(first), played: false };
      for (;;) {
        if (stopped() || current === null) return;
        // Fill the prefetch window while this clip plays. `depth` caps ready clips plus running
        // synthesizers together, so one long answer is never synthesized in a single burst.
        while (ahead.length < depth && launchPrefetch()) { /* fill the window */ }
        // Gap 5: a clip is counted as `played` only after its playback really completed (the
        // `done` promise settled), never at `accept`/synthesis/player-start. A player that throws
        // before starting leaves `played` at 0, so `finish()` still speaks the whole reply.
        const entry = current;
        // P-65: this sentence is spoken either as one clip or as comma-sized blocks. Block 0 is
        // the audio the prefetch slot already synthesized; the driver synthesizes block N+1 while
        // block N plays. The play seam still gets the whole sentence text (and the block index),
        // so the caption and the ledger stay per sentence.
        const blocks = Array.isArray(entry.audio?.chunkTexts) && entry.audio.chunkTexts.length > 1
          ? entry.audio.chunkTexts
          : null;
        const summary = await abortable((chunkPlayer ?? speakSingleBlock)({
          chunks: blocks ?? [entry.item.text],
          sentenceId: entry.item.seq,
          first: entry.audio,
          signal: lane,
          synthesize: blocks !== null && typeof entry.audio?.synthesizeChunk === 'function'
            ? (request) => entry.audio.synthesizeChunk(request)
            : null,
          play: (request) => playSentence({
            ...request,
            text: entry.item.text,
            sentenceId: entry.item.seq,
            // The lane seams name the block position `chunkIndex`/`chunkCount`; the driver's
            // internal request calls them `index`/`count`.
            chunkIndex: request.index,
            chunkCount: request.count,
          }),
          // Only a sentence that really split emits `voice.chunk` rows; the one-clip path keeps
          // the existing event stream untouched.
          onEvent: blocks === null ? null : (event) => {
            if (typeof onEvent !== 'function') return;
            try { onEvent(event); } catch { /* observation cannot break playback */ }
          },
          onStart: ({ started, index }) => {
            const audioAt = Number(started?.audioStartedAt) || 0;
            entry.played = audioAt > 0;
            // C: the ledger speech id (owner of the single playback session) makes the lifecycle
            // row joinable with speech.* without the speaker ever owning playback state.
            noteLifecycleSpeechId(started?.session);
            // Observation only: keep the first block's player session; the player-ready anchor is
            // read at finish(), after the transport had time to report its process readiness.
            if (entry.item.seq === 0 && index === 0 && started?.session !== undefined) {
              stats.firstStartSession = started.session ?? null;
            }
            if (audioAt > 0) {
              playedAny = true;
              emitLifecycle('playing', 'audio-started', {
                sentenceId: entry.item.seq,
                chunkIndex: index,
              });
              // Gap A: `firstPlayStartedAt` is written once (the first sentence's first block);
              // the last block has its own stamp, so a three-sentence reply reports 1000 and
              // 6000, not 6000 twice.
              stats.lastPlayStartedAt = audioAt;
              if (stats.firstPlayStartedAt === 0) stats.firstPlayStartedAt = audioAt;
              // The player reports when it started, not when sound left the device. A seam that can
              // also report the audible instant (`audioHeardAt`) turns the last stage from unknown
              // into a measurement; otherwise it stays 0 and is flagged unknown.
              const heardAt = Number(started?.audioHeardAt) || 0;
              if (entry.item.seq === 0 && index === 0 && heardAt >= audioAt && heardAt > 0) {
                stats.firstPlayerStartMs = Math.max(0, heardAt - audioAt);
                stats.firstPlayerStartUnknown = false;
              }
            }
          },
        }));
        // One skipped sentence counts once, however many blocks it had.
        if (summary.skipped > 0) stats.skipped += 1;
        // Counted once the player really finished the clip (not at accept/synthesis/start); a
        // clip that only reached the player still counts as heard even if a barge-in cut its tail.
        if (entry.played === true) stats.played += 1;
        if (lane.aborted) return;
        // Strictly serial playback: the oldest prefetched sentence is awaited in order, so a
        // fast later synthesis never reorders the queue and sentence N+1 cannot play early.
        const slot = ahead.shift();
        if (slot === undefined) return;
        let settled;
        try {
          settled = await abortable(slot.task);
        } catch (error) {
          // The prefetched clip never reached the player: hand it back to delete-on-settle
          // cleanup before releasing the run (a late result must still remove its file).
          await discardSlot(slot);
          throw error;
        }
        if (settled.error) {
          await discardSlot(slot);
          throw settled.error;
        }
        // Playback adopts this slot now; only unadopted prefetches are ever deleted as spills.
        slot.state = 'adopted';
        current = settled.value;
        if (current === null) return;
      }
    } catch (error) {
      // A cancellation is not a failure: it must never trigger the whole-reply fallback. A clip
      // superseded by another voice path (a newer reply took the single playback session) stops
      // this queue too, instead of playing its next sentence over the newer reply.
      if (error?.code === 'REPLY_SUPERSEDED') cancelled = true;
      else if (!lane.aborted) failure ??= error;
      emitLifecycle(cancelled || lane.aborted ? 'cancelled' : 'failed', String(error?.code ?? error?.message ?? ''));
      release(null);
      controller.abort();
    } finally {
      // A5: no prefetch waiter may survive this invocation; every unplayed prefetched clip is
      // deleted, which is what the depth-1 implementation could not do for its extra sentence.
      release(null);
      await discardAhead();
      if (current !== null && current.played !== true) await discardAudio(current.audio);
      // C: the run is over (finished, cancelled or failed) — the speaker owns nothing from here.
      // `finish()` awaits this promise, so releasing here is what prevents a stuck "still playing".
      emitLifecycle(cancelled ? 'cancelled' : (failure !== null ? 'failed' : 'finished'), 'run-settled');
      releaseActive(cancelled ? 'cancelled' : (failure !== null ? 'failed' : 'finished'));
    }
  };
  const start = () => {
    if (running === null) running = run();
  };

  const enqueue = (sentence) => {
    const text = String(sentence).trim();
    if (text.length === 0 || stopped()) return;
    const chars = speechCharCount(text);
    stats.requestedChars += chars;
    // A5: a sentence is the smallest unit the budget may drop — never a character. The first
    // sentence that would cross the cap ends the spoken share; it and everything after it are
    // dropped, so the caption (built from this same per-sentence text) cannot outrun the voice.
    if (stats.truncated || chars > remaining) {
      stats.truncated = true;
      remaining = 0;
      stats.droppedSentences += 1;
      return;
    }
    remaining -= chars;
    stats.keptSentences += 1;
    stats.chars += chars;
    stats.spokenChars += chars;
    if (stats.firstQueuedAt === 0) stats.firstQueuedAt = now();
    const item = { seq: stats.sentences, text };
    if (stats.sentences === 0) emitLifecycle('queued', 'first-sentence');
    stats.sentences += 1;
    const waiter = waiters.shift();
    if (waiter !== undefined) {
      waiter(item);
      return;
    }
    queue.push(item);
    start();
  };

  const push = (delta) => {
    if (closed || stopped()) return;
    const text = typeof delta === 'string' ? delta : '';
    if (text.length === 0) return;
    buffer += text;
    let taken;
    try {
      taken = split(buffer);
    } catch (error) {
      failure ??= error;
      release(null);
      controller.abort();
      return;
    }
    buffer = typeof taken?.rest === 'string' ? taken.rest : '';
    for (const sentence of Array.isArray(taken?.sentences) ? taken.sentences : []) enqueue(sentence);
  };

  const closeSource = () => {
    if (closed) return;
    closed = true;
    const tail = buffer.trim();
    buffer = '';
    if (tail.length > 0 && !stopped()) enqueue(tail);
    release(null);
    start();
  };

  const reportBudget = () => {
    if (budgetReported || typeof onBudget !== 'function') return;
    budgetReported = true;
    try {
      onBudget({
        type: 'voice.speech.budget',
        requestedChars: stats.requestedChars,
        spokenChars: stats.spokenChars,
        truncated: stats.truncated,
        keptSentences: stats.keptSentences,
        droppedSentences: stats.droppedSentences,
      });
    } catch {
      /* observation cannot break playback */
    }
  };

  const finish = async ({ fullText = '' } = {}) => {
    closeSource();
    if (running !== null) await running;
    if (stats.firstQueuedAt > 0) {
      const origin = Number.isFinite(startedAt) && startedAt > 0 ? startedAt : stats.firstQueuedAt;
      stats.firstQueuedMs = Math.max(0, stats.firstQueuedAt - origin);
    }
    // Gap A: the first sentence's four stages are separate measurements. Each stays 0 when its
    // boundary was never reached (nothing queued, synthesis failed, no clip started).
    if (stats.firstQueuedAt > 0 && stats.firstSynthStartedAt > 0) {
      stats.firstSynthWaitMs = Math.max(0, stats.firstSynthStartedAt - stats.firstQueuedAt);
    }
    if (stats.firstSynthStartedAt > 0 && firstSynthDoneAt > 0) {
      stats.firstSynthMs = Math.max(0, firstSynthDoneAt - stats.firstSynthStartedAt);
    }
    if (firstSynthDoneAt > 0 && stats.firstPlayStartedAt > 0) {
      stats.firstQueueWaitMs = Math.max(0, stats.firstPlayStartedAt - firstSynthDoneAt);
    }
    // Spawn -> player-ready is only readable once the player process reported readiness; by
    // finish() the first clip has started. This proves the process is up, never that audio was
    // decoded, submitted or heard, so the field is never called PCM. A transport that cannot
    // report readiness stays 0 (unknown), never a fabricated value.
    const startSession = stats.firstStartSession;
    if (startSession !== null && Number(startSession.playerReadyAt) > 0
      && Number(startSession.spawnAt) > 0
      && Number.isFinite(Number(startSession.playerReadyMs))) {
      stats.firstSpawnToPlayerReadyMs = Math.max(0, Math.round(Number(startSession.playerReadyMs)));
    }
    if (cancelled || (lane.aborted && failure === null)) {
      // An external abort (barge-in, mute, teardown) is a cancellation: never speak the whole
      // reply after the user interrupted. A failure that aborted the lane still falls back below.
      stats.cancelled = true;
      reportBudget();
      // finish() is the caller's end callback: it must release even when no run ever started.
      releaseActive('cancelled');
      return stats;
    }
    if (failure !== null) stats.error = String(failure?.message ?? failure);
    if (stats.played === 0 && playedAny !== true && stats.skipped === 0) {
      // Nothing started: the old whole-reply line is still the guarantee (split failure, a turn
      // whose body never reached the callback, or a body that was entirely suppressed).
      if (typeof speakWhole === 'function') {
        // A5: the fallback obeys the same cap and the same sentence boundary. It never gets to
        // speak past what the captions show, and a single over-budget sentence is not cut open.
        const limited = limitSpeechToSentences(String(fullText ?? ''), { budget: speechBudget });
        if (stats.requestedChars === 0) {
          stats.requestedChars = limited.requestedChars;
          stats.spokenChars = limited.spokenChars;
          stats.truncated = limited.truncated;
          stats.keptSentences = limited.keptSentences;
          stats.droppedSentences = limited.droppedSentences;
        }
        if (limited.text.length > 0) {
          stats.fallback = true;
          try {
            // The fallback is the same voice outlet: a replaced version must not keep `finish`
            // waiting on a clip whose lane was already aborted.
            const spoken = await abortable(speakWhole(limited.text));
            noteLifecycleSpeechId(spoken?.session);
            const audioAt = Number(spoken?.audioStartedAt) || 0;
            if (audioAt > 0) {
              if (stats.firstPlayStartedAt === 0) stats.firstPlayStartedAt = audioAt;
              // The fallback speaks exactly one clip, so it is also the last start.
              stats.lastPlayStartedAt = audioAt;
              if (stats.firstStartSession === null && spoken?.session !== undefined) {
                stats.firstStartSession = spoken.session ?? null;
              }
            }
          } catch (error) {
            if (stats.error.length === 0) stats.error = String(error?.message ?? error);
          }
        }
      }
    } else if (failure !== null) {
      // Replaying from the top would repeat text the user already heard; report the partial tail.
      stats.partial = true;
    }
    // A lane aborted during the fallback is still a cancellation, never a finished answer.
    if (!stats.cancelled && lane.aborted && failure === null) stats.cancelled = true;
    reportBudget();
    if (running === null) emitLifecycle('finished', 'no-clip');
    releaseActive(cancelled || lane.aborted ? 'cancelled' : (failure !== null ? 'failed' : 'finished'));
    return stats;
  };

  const cancel = (reason = 'cancel') => {
    if (cancelled) return false;
    cancelled = true;
    stats.cancelled = true;
    buffer = '';
    queue = [];
    release(null);
    emitLifecycle('cancelled', String(reason ?? 'cancel'));
    controller.abort(new DOMException(String(reason), 'AbortError'));
    // The version was replaced or stopped: it owns no active playback from this instant, even if
    // its player/run promise settles later. This is what keeps a superseded version inactive.
    releaseActive(`cancel:${String(reason ?? 'cancel')}`);
    return true;
  };

  return {
    push,
    finish,
    cancel,
    close: closeSource,
    stats,
    signal: lane,
    hasPlayed: () => playedAny,
    /** True while this speaker may still own the voice outlet (false after finish/cancel). */
    isActive: () => active,
    /** Stable diagnostic id; the ledger `speechId` is used once the play seam reports one. */
    speakerId,
  };
}


/**
 * Per-turn voice ownership. The turn captures the speech signal that is live at the instant it
 * wins delivery; `invalidateSpeech()` aborts that same signal on mute or barge-in, so a body
 * fragment that arrives after the user muted and unmuted again still belongs to a dead turn and
 * can never borrow the new signal. `owner` keeps one reply channel per turn: `assistant_say`
 * claims `'tool'`, automatic body speech claims `'auto'`, and the auto path stays silent once
 * the tool has spoken. `release()` ends the ownership when the turn settles.
 */
export function createVoiceTurnOwnership({ captureSignal = null, sessionId = '', turnId = null } = {}) {
  let signal = null;
  let captured = false;
  let owner = null;
  const turnIdOf = () => {
    if (typeof turnId !== 'function') return turnId;
    try {
      return turnId();
    } catch {
      return null;
    }
  };
  return {
    get sessionId() {
      return sessionId;
    },
    get turnId() {
      return turnIdOf();
    },
    capture() {
      captured = true;
      owner = null;
      try {
        signal = typeof captureSignal === 'function' ? captureSignal() : null;
      } catch {
        // A muted/disabled lane at delivery time means this turn has no voice at all.
        signal = null;
      }
      return signal;
    },
    get captured() {
      return captured;
    },
    get signal() {
      return signal;
    },
    get owner() {
      return owner;
    },
    canSpeak() {
      return captured && signal !== null && signal !== undefined && signal.aborted !== true;
    },
    claimTool() {
      owner = 'tool';
      return true;
    },
    claimAuto() {
      if (owner === 'tool') return false;
      owner = 'auto';
      return true;
    },
    release() {
      captured = false;
      signal = null;
      owner = null;
    },
  };
}


/**
 * Let one `assistant_say` call claim the active voice turn only when it runs inside that exact
 * conversation and round. A tool call from another session keeps its own audio: it never mutates
 * (nor is silenced by) a different conversation's reply owner.
 * @returns {{claimed: boolean, reason: string}} `reason` is diagnostic, never shown to the model.
 */
export function claimVoiceTurnForTool(activeTurn, scope) {
  if (activeTurn === null || typeof activeTurn !== 'object' || typeof activeTurn.claimTool !== 'function') {
    return { claimed: false, reason: 'no-active-turn' };
  }
  const sessionId = typeof scope?.sessionId === 'string' ? scope.sessionId : '';
  const turnId = Number.isInteger(scope?.turnId) ? scope.turnId : null;
  if (sessionId.length === 0 || turnId === null) return { claimed: false, reason: 'unbound' };
  if (activeTurn.sessionId !== sessionId) return { claimed: false, reason: 'foreign-session' };
  const activeTurnId = typeof activeTurn.turnId === 'function' ? activeTurn.turnId() : activeTurn.turnId;
  if (!Number.isInteger(activeTurnId) || activeTurnId !== turnId) {
    return { claimed: false, reason: 'foreign-turn' };
  }
  return activeTurn.claimTool() === true
    ? { claimed: true, reason: 'claimed' }
    : { claimed: false, reason: 'refused' };
}

export { SPOKEN_STREAM_HANG_MS, speakSingleBlock };
