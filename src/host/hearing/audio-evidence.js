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
