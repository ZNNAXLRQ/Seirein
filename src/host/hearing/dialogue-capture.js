/** dialogue-capture — extracted from hearing.js; no host entry dependency. */


/**
 * ---------------------------------------------------------------------------------------------
 * Continuous dialogue capture (this round: capture and boundaries only).
 *
 * Every *delivered* final is pushed into the session's `createDialogueContext()` buffer with its
 * capture timestamp AND the capture it came from (`mic` / `loopback`), so segmented ASR reads as one
 * continuous dialogue without ever melting a microphone sentence and a video sentence together.
 * A final the host refuses through `onUpdate`'s return value (playback echo, filler, duplicate) is
 * never pushed: the refusal is recorded as one throttled `hearing.dialogue.gated` debug row. Without
 * a verdict the delivery condition itself (`audible && loudEnough && meaningful`) is the gate.
 * Nothing is injected into a prompt here: `dialogueSnapshot()` is the read-only view the host may
 * consume later, and delivery is untouched — the push happens after `onUpdate`, and no text, gate or
 * order changes.
 *
 * Sources are never concatenated: an utterance whose source differs from the previous buffer entry
 * opens a source boundary automatically (a debug `voice.dialogue.source-boundary {from, to, at}`
 * row), and render() tags every line with its source and puts a divider between captures. A device
 * change inside one source is not a source change.
 *
 * Boundaries keep two sources/segments from being spliced together: `source-switch` (loopback ↔
 * microphone), `device-switch` (another endpoint of the same kind), `start` (a continued buffer
 * whose sentence was still open), `stop` (capture ended) and `idle` (no speech for
 * `DIALOGUE_IDLE_MS`). Idle is checked lazily on the frame path that already ticks — no timer.
 *
 * Event rows follow the same contract as `hearing.asr.*`: the synchronous fallback still captures
 * (pushes and boundaries) but writes no rows, because it deliberately keeps its event log empty.
 *
 * A repeated delivery of the SAME utteranceId inside `DIALOGUE_REPEAT_WINDOW_MS` is a duplicate of
 * speech already captured, never new speech, so it is pushed once.
 * ---------------------------------------------------------------------------------------------
 */

/** Silence longer than this closes the dialogue segment (boundary reason `idle`). */
export const DIALOGUE_IDLE_MS = 30_000;

/** A second delivery of the same utterance inside this window is the same speech, not new speech. */
export const DIALOGUE_REPEAT_WINDOW_MS = 30_000;

/** The lazy idle check looks at most once per this much capture time; never a timer. */
export const DIALOGUE_IDLE_CHECK_MS = 1_000;

/** Utterance identities remembered for the duplicate check (one per push, bounded memory). */
const DIALOGUE_PUSH_MEMORY = 64;

/** Contexts this process already captured from: their last source/device, for restart boundaries. */
const DIALOGUE_LAST_CAPTURE = new WeakMap();


const EMPTY_DIALOGUE_VIEW = Object.freeze({
  renderText: '', needsSummary: false, pendingVersion: 0, generation: 1,
});


/**
 * The host's verdict on one delivered final, read from what `onUpdate` returned.
 *
 * The legacy callback returns nothing, so `null` means "no verdict" and capture falls back to the
 * condition that delivered the text in the first place (`audible && loudEnough && meaningful`).
 * A host that owns barge-in can return `false` (or `{accepted: false, reason?}`) when it refused
 * the utterance — playback echo, filler, duplicate — and that refusal also keeps it out of the
 * continuous dialogue buffer. `true` / `{accepted: true}` accepts explicitly.
 *
 * @returns {{accepted: boolean, reason: string}|null}
 */
function hostDialogueVerdict(value) {
  if (value === false) return { accepted: false, reason: 'host-dropped' };
  if (value === true) return { accepted: true, reason: 'host-accepted' };
  if (value === null || typeof value !== 'object') return null;
  const reason = typeof value.reason === 'string' && value.reason.trim() !== ''
    ? value.reason.trim()
    : 'host-dropped';
  if (value.accepted === false) return { accepted: false, reason };
  if (value.accepted === true) return { accepted: true, reason: 'host-accepted' };
  return null;
}


/** Build this session's buffer; a broken factory disables capture instead of breaking the session. */
function resolveDialogueBuffer(instance, factory, source, device) {
  let candidate = instance;
  if (candidate === null || candidate === undefined) {
    if (typeof factory !== 'function') return null;
    try {
      candidate = factory({ source, device });
    } catch {
      return null;
    }
  }
  const usable = candidate !== null && candidate !== undefined
    && typeof candidate.push === 'function'
    && typeof candidate.snapshot === 'function'
    && typeof candidate.markBoundary === 'function';
  return usable ? candidate : null;
}


/**
 * Capture half of the continuous dialogue: push one delivered final, suppress a repeated delivery,
 * and mark the boundaries. It never touches delivery — the caller has already handed its update to
 * the host, and nothing here can change it.
 *
 * @param {{context?: object|null, source?: 'mic'|'loopback'|'unknown', now?: Function,
 *          emit?: ((type: string, payload: object) => void)|null}} [options]
 * @returns {{
 *   source: 'mic'|'loopback',
 *   push: (utterance: {text: string, at?: number, source?: 'mic'|'loopback', utteranceId?: string})
 *         => object|null,
 *   markBoundary: (reason: string, options?: {from?: string, to?: string}) => object|null,
 *   idleCheck: (at?: number) => boolean,
 *   close: (reason?: string) => object|null,
 *   hasOpenSentence: () => boolean,
 *   snapshot: () => {renderText: string, needsSummary: boolean,
 *                    pendingVersion: number, generation: number},
 * }}
 */
export function createDialogueCapture({
  context = null, source = 'mic', now = Date.now, emit = null,
} = {}) {
  const clock = typeof now === 'function'
    ? () => {
      try {
        const value = Number(now());
        return Number.isFinite(value) ? value : Date.now();
      } catch {
        return Date.now();
      }
    }
    : () => Date.now();
  const captureSource = source === 'loopback' ? 'loopback' : 'mic';
  /** One entry per pushed utterance identity, kept for `DIALOGUE_REPEAT_WINDOW_MS`. */
  const pushes = [];
  let lastSpeechAt = 0;
  let idleMarked = false;
  let idleCheckedAt = 0;
  let closed = false;

  const notify = (type, payload) => {
    try {
      emit?.(type, payload);
    } catch {
      /* an event sink must never break capture */
    }
  };

  const hasOpenSentence = () => {
    if (context === null) return false;
    try {
      return context.snapshot()?.openSentence === true;
    } catch {
      return false;
    }
  };

  /** Read-only view for the caller that renders or injects the context (this round: nobody does). */
  const snapshot = () => {
    if (context === null) return EMPTY_DIALOGUE_VIEW;
    try {
      const view = context.snapshot();
      const renderText = context.render(view);
      return Object.freeze({
        renderText: typeof renderText === 'string' ? renderText : '',
        needsSummary: view?.needsSummary === true,
        pendingVersion: Number.isSafeInteger(view?.pendingVersion) ? view.pendingVersion : 0,
        generation: Number.isSafeInteger(view?.generation) ? view.generation : 1,
      });
    } catch {
      return EMPTY_DIALOGUE_VIEW;
    }
  };

  const markBoundary = (reason, options = {}) => {
    if (context === null) return null;
    // A source boundary may name both captures, so the buffer can render `麦克风 → 系统声音`.
    const payload = { reason };
    if (options !== null && typeof options === 'object') {
      if (typeof options.from === 'string' && options.from.length > 0) payload.from = options.from;
      if (typeof options.to === 'string' && options.to.length > 0) payload.to = options.to;
    }
    let boundary = null;
    try {
      boundary = context.markBoundary(payload);
    } catch {
      return null;
    }
    // A boundary is a discontinuity: a delivery from before it never suppresses one after it, and
    // the silence before it is already accounted for (no second `idle` boundary for the same gap).
    pushes.length = 0;
    idleMarked = true;
    notify('hearing.dialogue.boundary', payload);
    return boundary;
  };

  const push = (utterance = {}) => {
    if (context === null || closed) return null;
    const text = typeof utterance?.text === 'string' ? utterance.text : '';
    if (text.trim().length === 0) return null;
    const at = Number.isFinite(utterance?.at) ? utterance.at : clock();
    // A delivery names the capture it came from. Only a real `mic`/`loopback` is accepted; a
    // missing, `unknown` or foreign value keeps this session's own source.
    const requested = utterance?.source;
    const source = requested === 'mic' || requested === 'loopback' ? requested : captureSource;
    const rawId = typeof utterance?.utteranceId === 'string' ? utterance.utteranceId.trim() : '';
    // The utterance identity is the whole dedupe key; a missing one is scoped to its capture time.
    const id = rawId.length > 0 ? rawId : `utt-${at}`;
    for (let index = pushes.length - 1; index >= 0; index -= 1) {
      if (at - pushes[index].at >= DIALOGUE_REPEAT_WINDOW_MS) pushes.splice(index, 1);
    }
    if (pushes.some((entry) => entry.key === id)) return null;
    // A long silence before this utterance closes the previous segment first, so the two are never
    // read as one conversation (the frame path normally got here already).
    if (lastSpeechAt > 0 && !idleMarked && at - lastSpeechAt >= DIALOGUE_IDLE_MS) {
      idleMarked = true;
      markBoundary('idle');
    }
    let entry = null;
    try {
      entry = context.push({ text, at, source, utteranceId: id });
    } catch {
      return null;
    }
    if (entry === null || entry === undefined) return null;
    // Debug observation: the buffer met a different capture and opened a source boundary on this
    // push. It never changes delivery; the rendered context carries the same information.
    if (entry.sourceBoundary !== null && typeof entry.sourceBoundary === 'object') {
      notify('voice.dialogue.source-boundary', {
        from: entry.sourceBoundary.from,
        to: entry.sourceBoundary.to,
        at: entry.sourceBoundary.at,
      });
    }
    pushes.push({ key: id, at });
    if (pushes.length > DIALOGUE_PUSH_MEMORY) pushes.shift();
    lastSpeechAt = at;
    idleMarked = false;
    idleCheckedAt = at;
    notify('hearing.dialogue.appended', {
      chars: text.length,
      at,
      utteranceId: typeof entry.utteranceId === 'string' ? entry.utteranceId : id,
    });
    return entry;
  };

  /** Lazy idle boundary: no timer, the capture frame that already ticks is the clock. */
  const idleCheck = (atValue) => {
    if (context === null || closed) return false;
    const at = Number.isFinite(atValue) ? atValue : clock();
    if (at - idleCheckedAt < DIALOGUE_IDLE_CHECK_MS) return false;
    idleCheckedAt = at;
    if (lastSpeechAt === 0 || idleMarked) return false;
    if (at - lastSpeechAt < DIALOGUE_IDLE_MS) return false;
    idleMarked = true;
    markBoundary('idle');
    return true;
  };

  /** Capture is over: close the last segment so nothing later can be spliced onto it. */
  const close = (reason = 'stop') => {
    if (closed) return null;
    closed = true;
    if (lastSpeechAt === 0) return null;
    return markBoundary(reason);
  };

  return { source: captureSource, push, markBoundary, idleCheck, close, hasOpenSentence, snapshot };
}

export {
  DIALOGUE_PUSH_MEMORY,
  DIALOGUE_LAST_CAPTURE,
  EMPTY_DIALOGUE_VIEW,
  hostDialogueVerdict,
  resolveDialogueBuffer,
};
