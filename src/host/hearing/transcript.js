/** transcript — extracted from hearing.js; no host entry dependency. */


/** Drop unpaired UTF-16 surrogates: they survive decode but break lossless JSON round-trips. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu;

function sanitize(text) {
  return typeof text === 'string' ? text.replace(LONE_SURROGATE, '') : '';
}


/** SenseVoice tag form (`<|zh|>`, `<|NEUTRAL|>`, `<|Speech|>`, `<|withitn|>`) inside decoded text. */
const ASR_TAG = /<\|([^|<>]{1,32})\|>/gu;


/**
 * Split decoder text into the tags it carries and the text a strip would leave. Observation only:
 * the caller must keep delivering its own text, never `cleaned`, and `stripped` merely records that
 * a strip would have removed something here.
 * @returns {{cleaned: string, tags: string[], stripped: boolean}}
 */
export function splitAsrTags(text) {
  const raw = typeof text === 'string' ? text : '';
  const tags = [];
  for (const match of raw.matchAll(ASR_TAG)) tags.push(match[0]);
  const cleaned = sanitize(raw.replace(ASR_TAG, '')).replace(/\s+/gu, ' ').trim();
  return { cleaned, tags: [...new Set(tags)], stripped: tags.length > 0 };
}


/** The SenseVoice side-channel tags a decode reports next to its text. */
const ASR_TAG_FIELDS = ['lang', 'emotion', 'event'];


/**
 * Normalize a decoder result's `lang`/`emotion`/`event`: `raw` keeps the `<|zh|>` form, `clean` is
 * the value without the brackets. A missing, empty or non-string value is `null` in both keys —
 * never `undefined` — so an event payload can always be written as-is.
 * @returns {{lang: string|null, langClean: string|null, emotion: string|null, emotionClean: string|null,
 *            event: string|null, eventClean: string|null}}
 */
export function asrTagFields(values = null) {
  const fields = {};
  for (const name of ASR_TAG_FIELDS) {
    const value = values?.[name];
    const raw = typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
    fields[name] = raw;
    fields[`${name}Clean`] = raw === null ? null : raw.replace(/^<\|/u, '').replace(/\|>$/u, '');
  }
  return fields;
}


/** Most frequent non-empty value of one raw tag field across the decoded pieces (first wins a tie). */
function dominantTag(decoded, field) {
  const counts = new Map();
  for (const entry of decoded) {
    const value = entry?.[field];
    if (typeof value === 'string' && value.length > 0) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  const ranked = [...counts].sort((left, right) => right[1] - left[1]);
  return ranked.length === 0 ? null : ranked[0][0];
}


/**
 * Join per-segment offline results in order (the no-overlap path). Segments come from
 * non-overlapping audio ranges, so no suffix/prefix text is removed (that guessing deleted real
 * words: `["非常","非常重要"]`). Only a boundary separator is inserted: one space between
 * Latin/digit words, none around CJK.
 * Overlapping pieces are joined by `joinSegmentedTexts()`, which trims against the referee decode.
 */
export function joinSegmentTexts(parts) {
  const normalized = parts.map((part) => normalizePieceText(part)).filter((part) => part.length > 0);
  let out = '';
  for (const part of normalized) out = appendSegmentText(out, part);
  return out.trim();
}


/** Collapse whitespace the same way every offline piece is normalized before joining. */
function normalizePieceText(text) {
  return sanitize(text).replace(/\s+/gu, ' ').trim();
}


/** Concatenate two pieces; a space only between Latin/digit words, never around CJK. */
function appendSegmentText(left, right) {
  if (left.length === 0) return right;
  if (right.length === 0) return left;
  const needsSpace = /[A-Za-z0-9]$/u.test(left) && /^[A-Za-z0-9]/u.test(right);
  return needsSpace ? `${left} ${right}` : `${left}${right}`;
}


/** Default shared audio between neighbouring final-pass pieces, in milliseconds. */
export const DEFAULT_SEGMENT_OVERLAP_MS = 800;


/** `asrSegmentOverlapMs` → samples at 16 kHz; 0 or a non-finite value disables the overlap path. */
export function segmentOverlapSamples(overlapMs) {
  const ms = Number(overlapMs);
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.floor((16000 * Math.round(ms)) / 1000);
}


/**
 * Plan the offline decode jobs of one utterance.
 *
 * Piece k covers `[k*seg - pad, (k+1)*seg + pad)` clamped to the utterance, i.e. every cut point
 * sits `pad` samples inside both neighbours instead of on their edge. One referee piece per joint
 * covers the audio both neighbours saw plus one extra `pad` of the next piece, so its tail is clean
 * context instead of an audio edge; its text is the only anchor used to trim the duplicate.
 * `pad = 0` reproduces the old fixed-size split exactly (no referees).
 *
 * @returns {{pieces: Array<{index: number, startSample: number, endSample: number}>,
 *            joints: Array<{index: number, startSample: number, endSample: number}>,
 *            jobs: Array<{kind: 'segment'|'joint', piece?: object, joint?: object}>}}
 */
export function planSegmentedDecodes(totalSamples, segmentSamples, overlapSamples = 0) {
  const total = Math.max(0, Math.floor(Number(totalSamples) || 0));
  const segment = Math.max(1, Math.floor(Number(segmentSamples) || 1));
  const pad = Math.max(0, Math.min(Math.floor(Number(overlapSamples) || 0), segment - 1));
  const count = total === 0 ? 0 : Math.ceil(total / segment);

  const pieces = [];
  for (let index = 0; index < count; index += 1) {
    const startSample = index === 0 ? 0 : Math.max(0, index * segment - pad);
    const endSample = index === count - 1 ? total : Math.min(total, (index + 1) * segment + pad);
    pieces.push({ index, startSample, endSample });
  }

  const joints = [];
  if (pad > 0) {
    for (let index = 0; index < pieces.length - 1; index += 1) {
      // The audio both neighbours decoded is [next.start .. prev.end]; the referee gets one extra
      // `pad` of the next piece on top, so its tail lands in clean audio instead of on the joint.
      joints.push({
        index,
        startSample: pieces[index + 1].startSample,
        endSample: Math.min(total, pieces[index].endSample + pad),
      });
    }
  }

  const jobs = [];
  for (let index = 0; index < pieces.length; index += 1) {
    jobs.push({ kind: 'segment', piece: pieces[index] });
    if (joints[index] !== undefined) jobs.push({ kind: 'joint', joint: joints[index] });
  }
  return { pieces, joints, jobs };
}


/** Punctuation and spaces are ignored when matching text against the referee anchor. */
const ANCHOR_IGNORED = /[\s，。！？、；：,.!?;:'"“”‘’…—－·（）()【】[\]《》<>「」『』～~]/u;


/** Text form used for anchoring: punctuation/spaces dropped, plus the raw index of every kept char. */
function anchorForm(text) {
  const raw = sanitize(text);
  let norm = '';
  const rawIndex = [];
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (ANCHOR_IGNORED.test(char)) continue;
    norm += /[A-Z]/u.test(char) ? char.toLowerCase() : char;
    rawIndex.push(index);
  }
  return { raw, norm, rawIndex };
}


const countOccurrences = (haystack, needle) => (needle.length === 0 ? 0 : haystack.split(needle).length - 1);


/** Longest prefix of `anchor` that ends `text` (the previous piece can only lose its tail). */
function prefixAtEnd(anchor, text) {
  for (let length = Math.min(anchor.length, text.length); length > 0; length -= 1) {
    if (text.endsWith(anchor.slice(0, length))) return length;
  }
  return 0;
}


/** Longest suffix of `anchor` that starts `text` (the next piece can only lose its head). */
function suffixAtStart(anchor, text) {
  for (let length = Math.min(anchor.length, text.length); length > 0; length -= 1) {
    if (text.startsWith(anchor.slice(anchor.length - length))) return length;
  }
  return 0;
}


/** Longest string that both ends `previousWindow` and starts `nextWindow` (at least 2 chars). */
function longestBoundaryOverlap(previousWindow, nextWindow) {
  for (let length = Math.min(previousWindow.length, nextWindow.length); length >= 2; length -= 1) {
    const candidate = nextWindow.slice(0, length);
    if (previousWindow.endsWith(candidate)) return candidate;
  }
  return '';
}


/** Whether every char of `needle` appears in `haystack` in order (the referee confirming a cut). */
function isSubsequence(needle, haystack) {
  if (needle.length === 0 || haystack.length === 0) return false;
  let cursor = 0;
  for (const char of haystack) {
    if (char === needle[cursor]) cursor += 1;
    if (cursor === needle.length) return true;
  }
  return false;
}


/**
 * Decide how much of `nextText`'s head repeats `previousText`'s tail, using the referee decode of
 * the shared audio as the anchor. No arbitrary suffix/prefix removal: the only thing ever cut is a
 * next-head prefix that is *textually identical* to a previous tail suffix, and the referee has to
 * confirm it.
 *
 *  1. referee anchor: the previous tail renders the anchor's head and the next head renders the
 *     anchor's tail, so the overlap between both renditions is the duplicate;
 *  2. the referee clip is short (`3*overlap`) and its head is the next piece's own mid-syllable
 *     start, so one char of slop on the referee's edge is allowed. A leading char the referee and the
 *     next piece share is only excluded from the *alignment*: when a head skip is needed, nothing
 *     after it may be cut either, because the skip is exactly the case where the previous tail does
 *     not prove what the next head repeats ("我们可以" + "不可以继续" must stay "不可以继续", never
 *     "不继续"). The whole next piece is kept and the join is reported as `fallback: true` with
 *     `reason: 'head-char-kept'`;
 *  3. if the referee decoded too poorly for either, the longest exact boundary overlap is used
 *     instead — accepted only when the referee text contains it in order;
 *  4. anything else — missing/short referee (`< 2` chars), a referee occurring more than once in
 *     either boundary window (ambiguous), unverifiable overlap — keeps both texts and reports
 *     `fallback: true`. Duplication is preferred over loss.
 *
 * Matching never searches further than each side's boundary window.
 *
 * @returns {{fallback: boolean, reason: string, path: 'referee'|'referee-edge'|'verified-overlap'|'',
 *            trimChars: number, headTrimmed: string, anchorLength: number,
 *            tailLength: number, headLength: number}}
 */
export function alignJointTexts({ previousText = '', nextText = '', refereeText = '' } = {}) {
  const previous = anchorForm(previousText);
  const next = anchorForm(nextText);
  const anchor = anchorForm(refereeText).norm;
  const result = (overrides = {}) => ({
    fallback: false,
    reason: '',
    path: '',
    trimChars: 0,
    headTrimmed: next.raw,
    anchorLength: anchor.length,
    tailLength: 0,
    headLength: 0,
    ...overrides,
  });
  const keepBoth = (reason) => result({ fallback: true, reason, headTrimmed: normalizePieceText(nextText) });
  /**
   * Cut `count` chars off the next head, but only when `skip` is 0: the cut chars must be a
   * textually identical copy of the previous tail, verified here.
   *
   * A required head skip means the previous tail never proved what the next head repeats, so no
   * character after the skipped one can be removed either: "我们可以 / 不可以继续" must stay
   * "不可以继续", never "不继续". Such a join keeps the whole next piece and is reported as a
   * fallback.
   */
  const cut = (skip, count, path, extra = {}) => {
    if (skip > 0) return keepBoth('head-char-kept');
    if (count > 0 && next.norm.slice(0, count) !== previous.norm.slice(previous.norm.length - count)) {
      return keepBoth('overlap-unverified');
    }
    const rawAfter = count >= next.norm.length ? next.raw.length : next.rawIndex[count];
    return result({
      path,
      trimChars: count,
      headTrimmed: next.raw.slice(rawAfter).replace(/^\s+/u, ''),
      ...extra,
    });
  };

  // A 1-char referee is a coin flip: it would confirm almost any adjacent text.
  if (anchor.length < 2) return keepBoth('referee-too-short');
  if (previous.norm.length === 0 || next.norm.length === 0) {
    // Nothing on one side to duplicate: both texts are already disjoint.
    return result({ reason: 'one-side-empty' });
  }

  const windowLength = Math.max(24, anchor.length * 2 + 8);
  const previousWindow = previous.norm.slice(-windowLength);
  const nextWindow = next.norm.slice(0, windowLength);

  if (countOccurrences(previousWindow, anchor) > 1 || countOccurrences(nextWindow, anchor) > 1) {
    return keepBoth('referee-ambiguous');
  }

  // Asymmetric edges are tried in a fixed order; each variant is at most one char off the referee.
  // A leading char the referee and the next piece share (they start on the same sample) may be
  // excluded from the alignment only — `cut()` keeps the whole next piece and flags the join, so no
  // unverified character (and nothing after it) is ever dropped.
  for (const [skipHead, dropTail] of [[0, false], [0, true], [1, false], [1, true]]) {
    if (skipHead === 1) {
      // Both start on the same sample, so an identical first char is the same re-rendition artifact.
      // It is bounded to one char, never removed from the text, and blocks any cut after it.
      if (anchor.length < 3 || next.norm.length < 3 || anchor[0] !== next.norm[0]) continue;
    }
    const variant = anchor.slice(skipHead, dropTail ? anchor.length - 1 : anchor.length);
    if (variant.length < 2) continue;
    const nextView = skipHead === 1 ? next.norm.slice(1) : next.norm;
    if (
      countOccurrences(previousWindow, variant) > 1
      || countOccurrences(nextView.slice(0, windowLength), variant) > 1
    ) continue;

    const tailLength = prefixAtEnd(variant, previousWindow);
    const headLength = suffixAtStart(variant, nextView);
    if (tailLength + headLength < variant.length) continue;
    // Overlap inside the anchor: only that overlap is cut. `0` means the two sides cover the anchor
    // end-to-end, which is only trustworthy when both sides actually matched part of it.
    const overlap = tailLength + headLength - variant.length;
    if (overlap === 0 && (tailLength === 0 || headLength === 0)) continue;
    return cut(skipHead, overlap, skipHead === 0 && !dropTail ? 'referee' : 'referee-edge', {
      tailLength,
      headLength,
      anchorLength: variant.length,
    });
  }

  // The referee clip is short and its head is the next piece's own (mid-syllable) start, so the
  // longest exact boundary overlap is used when the anchor path is inconclusive. It is accepted only
  // when the referee contains it in order. A leading char may be excluded from the alignment here as
  // well (the same edge artifact the referee renders differently, "新橙子" vs "亲橙子"), but the whole
  // next piece is kept and the join is flagged.
  for (const skipHead of [0, 1]) {
    // Skipping is only ever the *same-sample* artifact: the referee and the next piece must open with
    // the identical char. When they disagree, the referee heard something the next piece did not, so
    // the head is left untouched and the join falls back.
    if (skipHead === 1 && (next.norm.length < 3 || anchor[0] !== next.norm[0])) continue;
    const nextView = skipHead === 1 ? next.norm.slice(1) : next.norm;
    const plainOverlap = longestBoundaryOverlap(previousWindow, nextView.slice(0, windowLength));
    if (plainOverlap.length >= 2 && isSubsequence(plainOverlap, anchor)) {
      return cut(skipHead, plainOverlap.length, 'verified-overlap');
    }
  }
  return keepBoth('anchor-mismatch');
}


/**
 * Join overlapping offline pieces in order. Each `joint` entry is the referee decode of the audio
 * both neighbours saw; it decides how much of the next piece's head duplicates the previous piece's
 * tail (see `alignJointTexts`). Entries without a `kind` are treated as plain segments.
 *
 * @param {Array<{kind?: 'segment'|'joint', index: number, startSample?: number, endSample?: number,
 *               text: string}>} decoded
 * @returns {{text: string, joinFallback: boolean, joints: Array<object>,
 *            segments: Array<{index: number, startSample?: number, endSample?: number, text: string}>}}
 */
export function joinSegmentedTexts(decoded) {
  const segments = [];
  const referees = new Map();
  for (const entry of Array.isArray(decoded) ? decoded : []) {
    const text = normalizePieceText(entry?.text);
    if (entry?.kind === 'joint') referees.set(Number(entry.index), text);
    else {
      segments.push({
        index: Number(entry?.index ?? segments.length),
        startSample: entry?.startSample,
        endSample: entry?.endSample,
        text,
      });
    }
  }

  const joints = [];
  let joinFallback = false;
  let out = '';
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    let head = segment.text;
    if (index > 0 && referees.has(index - 1)) {
      // Only the overlap path has a referee; without one the pieces are disjoint by construction.
      const refereeText = referees.get(index - 1);
      const aligned = alignJointTexts({ previousText: segments[index - 1].text, nextText: segment.text, refereeText });
      joints.push({ index: index - 1, refereeText, ...aligned });
      if (aligned.fallback) joinFallback = true;
      head = aligned.headTrimmed;
    }
    out = appendSegmentText(out, head);
  }
  return { text: out.trim(), joinFallback, joints, segments };
}


/**
 * Fold one final's join detail into the metadata of the transcript being merged from several finals.
 * The flag is a logical OR — one final whose joint the referee could not verify makes the merged
 * transcript unverified — and `joinFallbacks` counts how many held finals carried one.
 *
 * @param {{joinFallback?: boolean, joinFallbacks?: number}} current accumulated metadata
 * @param {boolean} incoming this final's `joinFallback`
 * @returns {{joinFallback: boolean, joinFallbacks: number}}
 */
export function mergeJoinFallback(current = {}, incoming = false) {
  const seen = Number.isFinite(current?.joinFallbacks) ? current.joinFallbacks : 0;
  return {
    joinFallback: current?.joinFallback === true || incoming === true,
    joinFallbacks: seen + (incoming === true ? 1 : 0),
  };
}


/**
 * The join-detail fields a `voice.transcript` event carries. Kept next to `mergeJoinFallback` so the
 * emitted payload and the merged metadata can never drift apart.
 *
 * @param {{joinFallback?: boolean, joinFallbacks?: number}} meta merged transcript metadata
 * @returns {{joinFallback: boolean, joinFallbacks: number}}
 */
export function joinDetailFields(meta = {}) {
  return {
    joinFallback: meta?.joinFallback === true,
    joinFallbacks: Number.isFinite(meta?.joinFallbacks) ? meta.joinFallbacks : 0,
  };
}


/** One-line note prepended to a transcript whose accurate pass lost audio beyond the cap. */
export function truncationNotice(maxUtteranceSec = 90) {
  const seconds = Number.isFinite(maxUtteranceSec) ? Math.max(1, Math.round(maxUtteranceSec)) : 90;
  return `（语音过长，已截断至 ${seconds} 秒）`;
}


/**
 * Note for a transcript that is complete but whose accurate pass only covered the capped prefix.
 * It belongs in the event log, never in the text the user or the model reads.
 */
export function offlineLimitedNote(maxUtteranceSec = 90) {
  const seconds = Number.isFinite(maxUtteranceSec) ? Math.max(1, Math.round(maxUtteranceSec)) : 90;
  return `离线精修仅覆盖前 ${seconds} 秒`;
}


/** Prefix the note only when the transcript really lost audio; metadata stays structured too. */
export function annotateTranscript(text, meta = {}) {
  if (meta?.truncated !== true) return text;
  return `${truncationNotice(Number(meta.maxUtteranceSec ?? 90))}\n${text}`;
}


/**
 * Decode one utterance as overlapping pieces (plus one referee per joint) and join them by the
 * referee anchor. A short utterance is a single piece, so the result is byte-for-byte the old one.
 *
 * Exported because the decode worker thread runs exactly this function: the offline result must be
 * identical whether it came from the worker or from the synchronous fallback.
 *
 * @param {{utteranceId?: string|number|null}} [options] identity of the utterance this decode
 *   belongs to; every piece id is scoped by it, so one transcript can be traced to the exact pieces
 *   that produced it.
 */
export function decodeSegmented(finalRecognizer, samples, segmentSamples, overlapSamples = 0, sampleRate = 16000, { utteranceId = null } = {}) {
  const plan = planSegmentedDecodes(samples.length, segmentSamples, overlapSamples);
  const decoded = [];
  for (const job of plan.jobs) {
    const { startSample, endSample } = job.kind === 'segment' ? job.piece : job.joint;
    const offlineStream = finalRecognizer.createStream();
    offlineStream.acceptWaveform({ sampleRate, samples: samples.subarray(startSample, endSample) });
    finalRecognizer.decode(offlineStream);
    const result = finalRecognizer.getResult(offlineStream) ?? {};
    decoded.push({
      kind: job.kind,
      index: job.kind === 'segment' ? job.piece.index : job.joint.index,
      startSample,
      endSample,
      text: typeof result.text === 'string' ? result.text : '',
      lang: result.lang,
      emotion: result.emotion,
      event: result.event,
    });
  }
  // The side-channel tags are decode metadata, never part of the joined text: the dominant value
  // among the pieces wins (a one-piece utterance is exact) and missing fields stay null.
  return {
    ...joinSegmentedTexts(decoded),
    ...asrTagFields({
      lang: dominantTag(decoded, 'lang'),
      emotion: dominantTag(decoded, 'emotion'),
      event: dominantTag(decoded, 'event'),
    }),
    // Identity of every decode in plan order: `<utterance>:s0` for an audio segment,
    // `<utterance>:j0` for a joint referee. The noise shadow records these ids.
    segmentIds: decoded.map((entry) => decodePieceId(utteranceId, entry)),
  };
}


/** Stable id of one offline decode: `<utterance>:s<index>` (segment) or `<utterance>:j<index>`. */
function decodePieceId(utteranceId, entry) {
  const scope = utteranceId === null || utteranceId === undefined || utteranceId === '' ? '' : `${utteranceId}:`;
  return `${scope}${entry?.kind === 'joint' ? 'j' : 's'}${Number(entry?.index ?? 0)}`;
}

export {
  LONE_SURROGATE,
  sanitize,
  ASR_TAG,
  ASR_TAG_FIELDS,
  dominantTag,
  normalizePieceText,
  appendSegmentText,
  ANCHOR_IGNORED,
  anchorForm,
  countOccurrences,
  prefixAtEnd,
  suffixAtStart,
  longestBoundaryOverlap,
  isSubsequence,
  decodePieceId,
};
