/** audio-evidence — extracted from hearing.js; no host entry dependency. */
import { splitAsrTags } from './transcript.js';

/**
 * ---------------------------------------------------------------------------------------------
 * Noise shadow (round 1): observation only.
 *
 * Real data shows the same short decodes arriving again and again as *separate* deliveries
 * ("The.", "Yeah.", "Okay okay,", "嗯。"), 20–45 s apart — well past the repeat window — with a
 * `durationMs` that is suspiciously exact (3500 ms). This block records the *evidence* for a later
 * decision: whether to filter, and at which threshold, depends on the comparison data collected
 * first. Nothing here filters, reorders or re-thresholds: `hearing.noise.shadow` is written after
 * the delivery verdict is already made, and `text` is still delivered exactly as before.
 *
 * What the data can and cannot answer:
 *  - endpoint reason: `max-duration` when the clip reached the utterance-length rule; below that the
 *    endpoint was a trailing-silence one and the streaming text at the endpoint separates the
 *    no-token rule (`silence`) from the with-token one (`natural`). It is an inference from the
 *    configured rules and the observed hypothesis, not a value the SDK reports; `other` stays for a
 *    duration/state that cannot be judged.
 *  - voiced ratio: measured from the buffered PCM (energy VAD), never estimated. It cannot tell
 *    speech from steady room tone — that is exactly what the collected rows are for.
 *  - both texts: the streaming text and the raw offline text travel separately, so agreement is
 *    measured even when the offline pass was not adopted for delivery.
 * ---------------------------------------------------------------------------------------------
 */

/** Endpoint rule 3 (`rule3MinUtteranceLength`): an utterance at least this long was cut by length. */
export const ENDPOINT_MAX_UTTERANCE_SEC = 20;


/**
 * The streaming pass's endpoint rules. These are the shipping values: `createRecognizer` /
 * `startHearing` accept overrides, and omitting them resolves to exactly this table.
 */
export const DEFAULT_ENDPOINT_RULES = Object.freeze({
  rule1MinTrailingSilence: 3.0,
  rule2MinTrailingSilence: 1.8,
  rule3MinUtteranceLength: ENDPOINT_MAX_UTTERANCE_SEC,
});


/**
 * Fixed-cut grid of the capture chain, in milliseconds. The real log shows one exact duration over
 * and over (3500 ms — seven grid units), which is what an endpoint check on a coarse capture chunk
 * looks like, not what a speaker's pause looks like. A duration that lands exactly on the grid is
 * therefore a `forced-segment` suspect; this is a heuristic for the shadow row, never a verdict.
 */
export const FORCED_CUT_GRID_MS = 500;


/** One full shadow row per (suspect set, similar text) per window; suppressed rows carry a count. */
export const SHADOW_SUPPRESS_WINDOW_MS = 30_000;


/**
 * Shortest audio the speaker shadow will embed. Below 600 ms the row says `too-short` and no
 * embedding is computed: the measurement is unreliable, and skipping it keeps the shadow cheap.
 */
export const SPEAKER_SHADOW_MIN_MS = 600;

export const SPEAKER_SHADOW_MIN_SAMPLES = SPEAKER_SHADOW_MIN_MS * 16;


/** Longer Latin-only text is a sentence, not the short artifact the shadow is looking for. */
export const SHORT_LATIN_MAX_CHARS = 12;


/** One energy-VAD frame; a frame is voiced when it is within this range of the loudest frame… */
export const VOICED_FRAME_MS = 20;

export const VOICED_DYNAMIC_RANGE_DB = 24;

/** …and above the digital-silence floor (dither/DC offset is not voice). */
export const VOICED_FLOOR_DB = -60;


/**
 * Which rule ended an utterance. sherpa reports one boolean for its three rules, but two of them are
 * still separable from data this thread already has:
 *  - `max-duration`: the clip reached the configuration's utterance-length rule, which only happens
 *    when no trailing-silence rule ended it earlier;
 *  - below that length the endpoint was a trailing-silence one, and sherpa checks the no-token rule
 *    (3.0 s, hypothesis still empty) before the with-token rule (1.8 s). The streaming text at the
 *    endpoint therefore says which fired: text present → `natural` (the speaker stopped after real
 *    words), nothing decoded → `silence` (the room-tone shape);
 *  - `other`: the duration is unusable, or the caller cannot say whether text was decoded.
 *
 * @param {{hasOnlineText?: boolean|null}} [options] whether the streaming pass had decoded text at
 *   the endpoint; `null` means "unknown", which is reported as `other`, never guessed.
 * @returns {'natural'|'silence'|'max-duration'|'other'}
 */
export function endpointReasonOf(durationMs, {
  maxEndpointMs = ENDPOINT_MAX_UTTERANCE_SEC * 1000,
  hasOnlineText = null,
} = {}) {
  const ms = Number(durationMs);
  const limit = Number(maxEndpointMs);
  if (!Number.isFinite(ms) || ms <= 0 || !Number.isFinite(limit) || limit <= 0) return 'other';
  if (ms >= limit) return 'max-duration';
  if (hasOnlineText === true) return 'natural';
  if (hasOnlineText === false) return 'silence';
  return 'other';
}


/**
 * Why one ASR fragment ended, from data the capture thread already has. `silence` is the only
 * reason that means "the speaker finished"; the other three are internal cuts, so a group keeps
 * collecting after them. `other` is never guessed into a natural end: an unknown cut is reported
 * as a capture anomaly (or an offline split when the accurate pass had to segment the audio).
 *
 * @returns {'silence'|'max-duration'|'offline-split'|'capture-anomaly'}
 */
export function segmentEndReasonOf(snapshot) {
  if (snapshot?.truncated === true) return 'capture-anomaly';
  if (snapshot?.endpointReason === 'max-duration') return 'max-duration';
  if (snapshot?.endpointReason === 'natural' || snapshot?.endpointReason === 'silence') return 'silence';
  return snapshot?.offlineSplit === true ? 'offline-split' : 'capture-anomaly';
}


/** Commit buffer after a natural endpoint: at most this long for the speaker to continue. */
export const DEFAULT_GROUP_COMMIT_MS = 300;


/**
 * Bounded recovery after a commit-buffer cancellation. When no *further* confirmed continuation
 * (a new streaming partial or another sustained voiced run) arrives within this window, the commit
 * timer is re-armed and the text already collected is delivered without waiting for the next
 * endpoint. Without it a single cancelled timer could leave a finished sentence undelivered for the
 * whole no-text endpoint rule (~3 s).
 */
export const DEFAULT_GROUP_RESUME_GRACE_MS = 500;


/**
 * Sustained audio needed to confirm a continuation. One frame (or a 20 ms blip) never cancels the
 * commit timer; only a run that stays above the existing RMS floor for this long does.
 */
export const GROUP_RESUME_MIN_VOICE_MS = 120;


/** Did this clip both start and end exactly on the capture chain's fixed cut grid? */
export function onFixedCutGrid(durationMs, gridMs = FORCED_CUT_GRID_MS) {
  const ms = Number(durationMs);
  const grid = Number(gridMs);
  if (!Number.isFinite(ms) || !Number.isFinite(grid) || ms <= 0 || grid <= 0) return false;
  // One grid unit is a short word on its own; only a clip spanning two or more is a fixed segment.
  return ms >= grid * 2 && ms % grid === 0;
}


/**
 * Text form used to compare the two passes and to group shadow rows: ASR tags, punctuation,
 * symbols, spacing and case are ignored ("Okay okay," and "okay  okay" are the same words).
 */
export function shadowTextKey(text) {
  return splitAsrTags(text).cleaned.replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
}


/** Words of a decode: Latin/digit runs, or one token per CJK character ("嗯嗯" → two tokens). */
function shadowTokens(text) {
  return splitAsrTags(text).cleaned.toLowerCase().match(/[a-z0-9]+|[^\s\p{P}\p{S}]/gu) ?? [];
}


/**
 * Energy VAD over the buffered utterance. A frame is voiced when its level is within
 * `VOICED_DYNAMIC_RANGE_DB` of the loudest frame and above `VOICED_FLOOR_DB` — i.e. this measures
 * *energy*, not speech: continuous room tone is as "voiced" as a sustained vowel. That limitation
 * is the reason the ratio is recorded as evidence instead of being turned into a gate.
 *
 * @param {Float32Array|Float32Array[]|null} source one buffer or the chunk list kept for the pass
 * @returns {{voicedMs: number, voicedRatio: number, frames: number}|null} null when there is no
 *   audio to measure (never a fabricated 0)
 */
export function voicedMetrics(source, { sampleRate = 16000, frameMs = VOICED_FRAME_MS } = {}) {
  const chunks = Array.isArray(source)
    ? source.filter((chunk) => Number(chunk?.length) > 0)
    : (Number(source?.length) > 0 ? [source] : []);
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const rate = Number(sampleRate) > 0 ? Number(sampleRate) : 16000;
  if (total <= 0) return null;
  const frameSamples = Math.max(1, Math.round((rate * Math.max(1, Number(frameMs) || VOICED_FRAME_MS)) / 1000));
  const levels = [];
  let sumSquares = 0;
  let countInFrame = 0;
  for (const chunk of chunks) {
    for (const sample of chunk) {
      sumSquares += sample * sample;
      countInFrame += 1;
      if (countInFrame === frameSamples) {
        levels.push(Math.sqrt(sumSquares / countInFrame));
        sumSquares = 0;
        countInFrame = 0;
      }
    }
  }
  // A tail shorter than half a frame would let one stray sample look like a peak; drop it.
  if (countInFrame >= frameSamples / 2) levels.push(Math.sqrt(sumSquares / countInFrame));
  if (levels.length === 0) return null;
  const peak = Math.max(...levels);
  if (peak <= 0) return { voicedMs: 0, voicedRatio: 0, frames: levels.length };
  const thresholdDb = Math.max(VOICED_FLOOR_DB, 20 * Math.log10(peak) - VOICED_DYNAMIC_RANGE_DB);
  let voiced = 0;
  for (const level of levels) {
    if (level > 0 && 20 * Math.log10(level) >= thresholdDb) voiced += 1;
  }
  return {
    voicedMs: Math.round((voiced * frameSamples * 1000) / rate),
    voicedRatio: Math.round((voiced / levels.length) * 1000) / 1000,
    frames: levels.length,
  };
}


/**
 * Thresholds of the record-only `wouldDrop` verdict. Both are evidence, never gates: nothing reads
 * them back, so a clip they flag is still delivered exactly as before.
 */
export const LOW_VAD_SPEECH_MAX_RATIO = 0.15;

export const PLAYBACK_ECHO_MAX_RATIO = 0.25;

/** "Short" text for the verdict: ≤2 cleaned characters, or pure Latin ≤3 ("The." → "the"). */
export const DROP_SHORT_TEXT_MAX_CHARS = 2;

export const DROP_SHORT_LATIN_MAX_CHARS = 3;

/**
 * High-confidence playback echo: a real echo repeats at least this many normalized characters.
 * Shorter input is a short answer/interjection, never an echo — see `ECHO_MIN_CHARS` in `echoMatch`.
 */
export const ECHO_MIN_CHARS = 4;

/**
 * How much of the input must be covered by the playing line. Kept as a defensive belt: the residual
 * rule below already passes any input with one real character of its own, so a coverage shortfall
 * without such a character cannot arise — this only guards against a future matching change.
 */
export const ECHO_MIN_COVERAGE = 0.7;

/**
 * @deprecated P2 no longer uses a character count to judge noise: **one** real character outside
 * the echo is enough to prove the user is speaking. Kept as an export only because `hearing.js`
 * still imports it; no decision reads it.
 */
export const ECHO_EXTRA_MIN_CHARS = 2;

/**
 * Words that *label* the uncovered part of a mixed input (`extraKind`). They are looked for in the
 * residual only, and they never decide the delivery: the residual rule below already passes every
 * real character, so these lists only annotate a stop / correction / negation for the debug row.
 * Do not grow them into a gate.
 */
export const ECHO_EXTRA_STOP_WORDS = Object.freeze([
  '停下', '别说了', '等一下', '等等', '取消', '停', '别',
]);

export const ECHO_EXTRA_CORRECTION_WORDS = Object.freeze(['不对', '错了', '算了']);

export const ECHO_EXTRA_NEGATION_WORDS = Object.freeze(['不是', '不']);

/** Nothing but the echo (punctuation and filler syllables aside): no extra content at all. */
const NO_ECHO_EXTRA = Object.freeze({
  extraChars: 0, extraKind: '', extraReason: '', residual: '',
});

/**
 * Tone/filler syllables ignored when comparing with the playing line and when deciding whether the
 * residual contains any real word. This is a comparison-only normalization: it never edits the
 * delivered text and never protects a stop word.
 */
const ECHO_FILLERS = /[啊呀吧呢哦嗯嘛啦哇咯诶欸]/gu;


/**
 * Answers that must never even become a *candidate*: a real short answer (好/不/停/OK/嗯) and every
 * stop/interrupt word. This is a whitelist, not a blacklist: the suspect rules never use a word
 * list, because "The"/"Yeah" showing up often in the log is evidence about the audio, not the word.
 */
export const PROTECTED_SHORT_ANSWERS = Object.freeze([
  '好', '好的', '嗯', '不', '不是', '不行', '不要', '不要了', '不用', '不用了', '没有', '等一下',
  '停', '停下', '停止', '停一下', '别说了', '别讲了', '暂停', '打断',
  'ok', 'okay', 'yes', 'no', 'stop', 'pause',
]);


/**
 * Is this text a protected short answer / stop word? Same normalization as the shadow rows (tags,
 * punctuation, spacing and case ignored), plus the obvious repetition "嗯嗯" / "停停停".
 */
export function isProtectedShortAnswer(text) {
  const key = shadowTextKey(text);
  if (key === '') return false;
  if (PROTECTED_SHORT_ANSWERS.includes(key)) return true;
  const tokens = shadowTokens(text);
  return tokens.length > 1 && tokens.every((token) => token === tokens[0])
    && PROTECTED_SHORT_ANSWERS.includes(tokens[0]);
}


/**
 * Comparison form of a transcript for the echo check: ASR tags, punctuation, symbols, spacing,
 * case and filler syllables are ignored ("嗯，今天 天气不错啊。" and "今天天气不错" are the same words).
 * The input text itself is never rewritten; only this comparison key is.
 */
export function echoTextKey(text) {
  return shadowTextKey(text).replace(ECHO_FILLERS, '');
}


/**
 * Does `text` repeat what is sounding now? Two shapes only, both requiring at least
 * `ECHO_MIN_CHARS` normalized characters:
 *  - the whole input equals the playing line, or is one contiguous piece of it;
 *  - the whole playing line is one contiguous piece of the input (the user may have added words;
 *    `coverage` then says how much of the input the playing line covers).
 * Similar wording that is not a contiguous substring ("今天天气很好" vs "今天天气不错") is **not**
 * an echo: matching is exact/substring only, because an uncertain match must pass through.
 *
 * @returns {{matched: boolean, reason: string, matchedChars: number, playingChars: number,
 *   coverage: number}}
 */
export function echoMatch(text, playingText) {
  const spoken = echoTextKey(text);
  const playing = echoTextKey(playingText);
  const inputChars = [...spoken].length;
  const playingChars = [...playing].length;
  if (inputChars === 0 || playingChars === 0) {
    return { matched: false, reason: 'no-text', matchedChars: 0, playingChars, coverage: 0 };
  }
  if (inputChars < ECHO_MIN_CHARS) {
    return { matched: false, reason: 'short-text', matchedChars: 0, playingChars, coverage: 0 };
  }
  if (spoken === playing) {
    return { matched: true, reason: 'exact', matchedChars: inputChars, playingChars, coverage: 1 };
  }
  if (playing.includes(spoken)) {
    return { matched: true, reason: 'input-in-playing', matchedChars: inputChars, playingChars, coverage: 1 };
  }
  if (playingChars >= ECHO_MIN_CHARS && spoken.includes(playing)) {
    const coverage = Math.round((playingChars / inputChars) * 1000) / 1000;
    return { matched: true, reason: 'playing-in-input', matchedChars: playingChars, playingChars, coverage };
  }
  return { matched: false, reason: 'not-similar', matchedChars: 0, playingChars, coverage: 0 };
}


/**
 * The part of `text` the playing line does not cover, in comparison form (fillers/punctuation gone).
 *
 * The match is contiguous (`echoMatch`), so removing one occurrence of the playing line from the
 * input leaves at most two pieces: the prefix before it and the suffix after it. `''` therefore
 * means "the whole input is the echo", which is the only shape that may be dropped.
 */
export function echoResidual(text, playingText) {
  const spoken = echoTextKey(text);
  const playing = echoTextKey(playingText);
  if (spoken === '' || playing === '') return '';
  if (spoken === playing || playing.includes(spoken)) return '';
  const at = spoken.indexOf(playing);
  if (at < 0) return spoken;
  return spoken.slice(0, at) + spoken.slice(at + playing.length);
}


/**
 * The real content of a residual: everything that is not punctuation, spacing or a tone/filler
 * syllable. `echoResidual` already normalizes those away; the second pass keeps the rule true even
 * if that normalization ever changes.
 */
function echoResidualContent(residual) {
  return residual.replace(ECHO_FILLERS, '').replace(/[\s\p{P}\p{S}]/gu, '');
}


/** Which protection word the residual contains — a label for `extraKind`, never a decision. */
function echoExtraKindOf(residual) {
  const contains = (words) => words.some((word) => residual.includes(word));
  if (contains(ECHO_EXTRA_STOP_WORDS)) return 'stop';
  if (contains(ECHO_EXTRA_CORRECTION_WORDS)) return 'correction';
  if (contains(ECHO_EXTRA_NEGATION_WORDS)) return 'negation';
  return 'other';
}


/**
 * Is this a **mixed input** — the echoed sentence plus real speech of the user's own? Only a pure
 * echo is ever dropped, so this is the rule that protects a negation, a correction, a stop order or
 * a one-character change that happens next to words the assistant is saying.
 *
 * P2 is deliberately conservative: **any** character outside the echoed span that is not
 * punctuation, spacing or a tone/filler syllable means the user is talking, so the input passes.
 * There is no 2-character threshold (a single 「吗」 turns a statement into a question) and the
 * protection word lists below only set `extraKind` for the debug row, never the verdict.
 *
 * @returns {{extraChars: number, extraKind: ''|'negation'|'stop'|'correction'|'other',
 *   extraReason: string, residual: string}} `extraChars` counts the real uncovered characters and
 *   is `0` for a pure echo; `extraKind` annotates non-zero content only.
 */
export function echoExtraContent(text, playingText) {
  const residual = echoResidual(text, playingText);
  if (residual === '') return NO_ECHO_EXTRA;
  const extraChars = [...echoResidualContent(residual)].length;
  if (extraChars === 0) {
    // Punctuation / spacing / tone particles only: still the echo, nothing of the user's own.
    return { extraChars: 0, extraKind: '', extraReason: '', residual };
  }
  return { extraChars, extraKind: echoExtraKindOf(residual), extraReason: 'extra-content', residual };
}


/**
 * The one applied noise rule: a **high-confidence playback echo** is dropped only when all of the
 * independent conditions hold — the player is sounding, the input is a *pure* echo of the text that
 * is sounding (nothing but that text, punctuation and filler syllables aside), and the real VAD
 * measured very little speech. Every other outcome is a pass-through, and the reason says which
 * condition was missing (recorded as `hearing.echo.candidate`).
 *
 * The reference is `playingText` — the text really sent to TTS (`speechText`), never a subtitle in
 * another language. An empty reference is **not** guessed at: `no-speech-text` passes, because a
 * wrong reference can only turn a real answer into a false echo.
 *
 * A protected short answer / stop word is checked first and never dropped, even if its text also
 * matches the playing line exactly. A low VAD ratio without a content match stays `low-vad-speech`
 * in the shadow row — it is not applied here.
 *
 * @returns {{drop: boolean, reason: string, match: object, extraChars: number,
 *   extraKind: ''|'negation'|'stop'|'correction'|'other', residual: string}}
 */
export function echoGate(input = {}) {
  const text = typeof input?.text === 'string' ? input.text : '';
  if (isProtectedShortAnswer(text)) {
    return {
      drop: false, reason: 'whitelisted', extraChars: 0, extraKind: '', residual: '', match: echoMatch(text, input?.playingText),
    };
  }
  const match = echoMatch(text, input?.playingText);
  // P2: no speech text means no reliable reference. Do not fall back to the subtitle: pass.
  if (typeof input?.playingText !== 'string' || shadowTextKey(input.playingText) === '') {
    return { drop: false, reason: 'no-speech-text', extraChars: 0, extraKind: '', residual: '', match };
  }
  if (!match.matched) {
    return { drop: false, reason: match.reason, extraChars: 0, extraKind: '', residual: '', match };
  }
  if (input?.playing !== true) {
    return { drop: false, reason: 'not-playing', extraChars: 0, extraKind: '', residual: '', match };
  }
  // P1/P2: anything the playing line does not cover is the user's own speech. A single real
  // character (「吗」, 「谁」, 「不」, 「停」) is already enough, so a mixed input always passes.
  const extra = echoExtraContent(text, input.playingText);
  if (extra.extraChars > 0 || extra.extraKind !== '') {
    return {
      drop: false,
      reason: 'mixed',
      extraChars: extra.extraChars,
      extraKind: extra.extraKind,
      residual: extra.residual,
      match,
    };
  }
  if (match.coverage < ECHO_MIN_COVERAGE) {
    return { drop: false, reason: 'mixed', extraChars: extra.extraChars, extraKind: '', residual: extra.residual, match };
  }
  const ratio = Number.isFinite(input?.vadSpeechRatio) ? Number(input.vadSpeechRatio) : null;
  if (ratio === null) {
    return { drop: false, reason: 'no-vad', extraChars: extra.extraChars, extraKind: '', residual: extra.residual, match };
  }
  if (ratio >= PLAYBACK_ECHO_MAX_RATIO) {
    return { drop: false, reason: 'vad-high', extraChars: extra.extraChars, extraKind: '', residual: extra.residual, match };
  }
  return { drop: true, reason: 'playback-echo', extraChars: extra.extraChars, extraKind: '', residual: extra.residual, match };
}


/**
 * The `wouldDrop` verdict for one final judgment: computed and recorded, **never applied**.
 *
 * Inputs (all optional): `vadSpeechRatio` (real Silero ratio; `null` = not measured, never 0),
 * `energyVoicedRatio` (the volume meter, recorded next to it under its own name — it can never
 * stand in for speech and never decides), `text`, `durationMs`, `endpointReason`, `playing`,
 * `onlineOfflineAgree` (all carried into the row as context).
 *
 * Decision order, so every answer has one explainable reason:
 *  - `whitelisted`: protected short answer / stop word → false, in every case;
 *  - `no-text`: nothing decoded → false (nothing to judge);
 *  - `no-vad`: no real VAD measurement → false (the energy meter is not a substitute);
 *  - `playback-echo`: playing + ratio < 0.25 + short text → true (checked before low-vad: while
 *    the assistant's own voice is sounding, an echo is the more specific explanation);
 *  - `low-vad-speech`: ratio < 0.15 + short text (≤2 chars, or pure Latin ≤3) → true;
 *  - `not-suspicious`: everything else → false.
 */
export function wouldDropVerdict(input = {}) {
  const text = typeof input?.text === 'string' ? input.text : '';
  if (isProtectedShortAnswer(text)) return { wouldDrop: false, wouldDropReason: 'whitelisted' };
  const key = shadowTextKey(text);
  if (key === '') return { wouldDrop: false, wouldDropReason: 'no-text' };
  const ratio = Number.isFinite(input?.vadSpeechRatio) ? Number(input.vadSpeechRatio) : null;
  if (ratio === null) return { wouldDrop: false, wouldDropReason: 'no-vad' };
  // "Short" is the same definition the shadow uses for a suspect text, never a word list.
  const shortText = key.length <= DROP_SHORT_TEXT_MAX_CHARS
    || (/^[a-z]+$/u.test(key) && key.length <= DROP_SHORT_LATIN_MAX_CHARS);
  if (!shortText) return { wouldDrop: false, wouldDropReason: 'not-suspicious' };
  if (input?.playing === true && ratio < PLAYBACK_ECHO_MAX_RATIO) {
    return { wouldDrop: true, wouldDropReason: 'playback-echo' };
  }
  if (ratio < LOW_VAD_SPEECH_MAX_RATIO) return { wouldDrop: true, wouldDropReason: 'low-vad-speech' };
  return { wouldDrop: false, wouldDropReason: 'not-suspicious' };
}


/**
 * The **low-evidence** delivery verdict (shadow first): the real (Silero) VAD measured exactly zero
 * speech, the streaming pass decoded nothing, and the offline pass still produced text — i.e. the
 * only thing that "heard" a word was the accurate pass on an utterance the speech detector calls
 * silent.
 *
 * All five conditions must hold, and a protected short answer is checked before the verdict:
 *  - `vadSpeechRatio` exactly `0` (a null/unmeasured value is **not** low evidence — `no-vad`);
 *  - the streaming text is empty (tags/punctuation only count as empty);
 *  - the offline text is non-empty (that is the hallucination source this verdict is about);
 *  - the endpoint was the no-token silence rule (`silence`); `max-duration` has its own policy;
 *  - the delivered text is not a protected short answer (好/不/停/OK…) — the whitelist is checked
 *    last, so a real short answer is reported as `whitelisted` instead of low evidence.
 *
 * `durationMs` is accepted so callers can pass the whole snapshot unchanged; it is not a condition
 * (the endpoint reason already describes the cut).
 *
 * @param {{text?: string, vadSpeechRatio?: number|null, onlineText?: string, offlineText?: string,
 *          endpointReason?: string, durationMs?: number}} [input]
 * @returns {{lowEvidence: false, reason: string}|{lowEvidence: true, reason: string,
 *           wouldDrop: true}}
 */
export function lowEvidenceVerdict(input = {}) {
  const {
    text = '',
    vadSpeechRatio = null,
    onlineText = '',
    offlineText = '',
    endpointReason = 'other',
  } = input ?? {};
  const key = shadowTextKey(text);
  if (key === '') return { lowEvidence: false, reason: 'no-text' };
  const ratio = Number.isFinite(vadSpeechRatio) ? Number(vadSpeechRatio) : null;
  if (ratio === null) return { lowEvidence: false, reason: 'no-vad' };
  if (ratio !== 0) return { lowEvidence: false, reason: 'vad-speech' };
  if (shadowTextKey(onlineText) !== '') return { lowEvidence: false, reason: 'online-text' };
  if (shadowTextKey(offlineText) === '') return { lowEvidence: false, reason: 'no-offline-text' };
  if (endpointReason === 'max-duration') return { lowEvidence: false, reason: 'max-duration' };
  if (endpointReason !== 'silence') return { lowEvidence: false, reason: 'endpoint-other' };
  // Whitelist last: only a clip that would otherwise be low evidence can report `whitelisted`.
  if (isProtectedShortAnswer(text)) return { lowEvidence: false, reason: 'whitelisted' };
  return { lowEvidence: true, reason: 'silent-offline-hallucination', wouldDrop: true };
}


/**
 * The suspects recorded for one final judgment. Each is a hypothesis for the follow-up comparison,
 * never a filter: an empty list means "nothing suspicious here", and the text is delivered exactly
 * as before either way.
 *
 * @returns {Array<'short-latin'|'repeat-token'|'forced-segment'|'no-voiced'>}
 */
export function noiseSuspects({ text = '', durationMs = 0, endpointReason = 'other', voicedMs = null } = {}) {
  const suspects = [];
  const key = shadowTextKey(text);
  const latin = key.replace(/[^a-z]/gu, '');
  if (latin.length > 0 && latin.length <= SHORT_LATIN_MAX_CHARS && /^[a-z0-9]+$/u.test(key)) {
    suspects.push('short-latin');
  }
  const tokens = shadowTokens(text);
  if (tokens.length >= 2 && tokens.every((token) => token === tokens[0])) suspects.push('repeat-token');
  if (endpointReason === 'max-duration' || onFixedCutGrid(durationMs)) suspects.push('forced-segment');
  if (voicedMs === 0) suspects.push('no-voiced');
  return suspects;
}


/**
 * Compare the streaming pass with the raw offline pass: `true` = same words, `false` = they
 * disagree, `null` = one side produced nothing, so there is nothing to compare (never a guess).
 */
export function onlineOfflineAgree(onlineText, offlineText) {
  const online = shadowTextKey(onlineText);
  const offline = shadowTextKey(offlineText);
  if (online.length === 0 || offline.length === 0) return null;
  return online === offline;
}


/**
 * Debug observation of the three ASR layers. Unlike the `asr.*` counters these rows carry
 * transcript text, so they are throttled: at most this many rows per window, per hearing session.
 */
export const ASR_OBSERVE_WINDOW_MS = 10_000;

export const ASR_OBSERVE_MAX_ROWS = 24;

export { shadowTokens };
