/**
 * Spoken pipeline: turn one committed reply into a stream of speakable SEMANTIC UNITS.
 *
 * The reply lane used to wait for the whole spoken version before the first synthesis. This module
 * is the pure, mechanical half of the fix:
 *
 *  1. `takeSemanticUnits` / `splitSemanticUnits` cut already-available text into units that may be
 *     translated and synthesized on their own. A sentence end always closes a unit. A comma-level
 *     pause closes one only when the whole clause is safe to detach: no contrast / condition /
 *     negation marker on either side ("但是", "不可以", "需要先", "除非", "如果…就" …). When the
 *     look-ahead after a pause is too short to prove that, the cut is HELD until more text arrives,
 *     so a misleading half clause is never delivered.
 *  2. `createUnitSizer` sizes the first block from MEASURED synthesis cost (`ms/char` EWMA) instead
 *     of a fixed "first comma". A short complete sentence wins over any cut; a long sentence is cut
 *     near the target length, at a natural clause boundary.
 *  3. `shouldSkipSpokenVersion` decides whether a short answer may be spoken verbatim: length alone
 *     is not enough — a list, table, code fence or heading must go through the rewrite.
 *  4. `createSpokenUnitStream` consumes model deltas and emits units as soon as each one is stable,
 *     with cancellation that drops every late unit.
 *  5. `collectModelStream` reads the raw provider stream (same delta shapes as `translate.js`).
 *  6. `buildPipelineTimeline` renders the one `voice.pipeline.timeline` event payload, all stamps
 *     relative to the accepted delivery.
 *
 * Nothing here touches the network, the clock or the player; every seam is injected, so the tests
 * can drive it with a fake clock. It never imports the host (no cycle) and never throws on odd input.
 */

/** Characters that end a unit's sentence; a run of them stays with the sentence it closes. */
const SENTENCE_TERMINATORS = '。！？!?；;\n';
/** Closing punctuation that belongs to the sentence before it. */
const SENTENCE_CLOSERS = '”’"\'）)】]」』》〉';
/** Pauses that may close a semantic unit when both sides are safe (a semicolon is a terminator). */
const CLAUSE_PAUSES = new Set(['，', '、', ',']);
/** Pairs a cut must never enter (same rule as the TTS block splitter). */
const CLAUSE_OPENERS = new Map([['（', '）'], ['(', ')'], ['【', '】'], ['[', ']'],
  ['《', '》'], ['〈', '〉'], ['{', '}'], ['「', '」'], ['『', '』']]);
const CLAUSE_CLOSERS = new Set([...CLAUSE_OPENERS.values()]);
const CLAUSE_QUOTES = new Map([['“', '”'], ['‘', '’'], ['"', '"'], ["'", "'"]]);

/**
 * Connectives / negations that make a comma cut misleading when they sit on EITHER side of it.
 * This is the list the requirement names ("但是", "不可以", "需要先", "除非", "如果…就") plus the
 * same family of contrast, condition, reason, ordering and negation markers.
 */
export const SEMANTIC_LEADERS = Object.freeze([
  '但是', '可是', '不过', '然而', '否则', '不然', '而是', '反而', '却',
  '除非', '只有', '只要', '如果', '要是', '假如', '倘若', '若是', '即使', '即便',
  '虽然', '尽管', '无论', '不管', '不管怎样',
  '因为', '由于', '所以', '因此', '于是', '从而',
  '而且', '并且', '或者', '还是', '然后', '接着', '另外', '此外', '同时', '总之',
  '也就是说', '例如', '比如', '特别是', '尤其是', '首先', '其次', '最后',
  '需要先', '得先', '必须先', '先要', '千万不要', '不要', '不能', '不可以', '不行',
  '为了', '以便', '以免', '省得',
]);
/** Leaders that may OPEN the clause AFTER a pause: the cut would split the pair apart. */
const LEADER_PREFIXES = Object.freeze([
  ...SEMANTIC_LEADERS,
  '但', '可', '却', '而', '则', '便', '就', '才', '也', '都', '还', '那', '则',
]);
/** A clause must not end on one of these: the reader expects the rest of the structure. */
const DANGLING_TAILS = ['的', '地', '得', '和', '跟', '与', '或', '及', '而', '并', '却', '则', '把', '被', '给'];

/** Defaults for unit sizing: the first block targets about one second of synthesis. */
export const DEFAULT_UNIT_TARGET_MS = 1200;
export const DEFAULT_UNIT_MS_PER_CHAR = 9;
export const DEFAULT_UNIT_MIN_CHARS = 8;
export const DEFAULT_UNIT_MAX_CHARS = 60;

const codePoints = (text) => [...String(text ?? '')].length;

/** Is `text[index]` a sentence terminator? (Same rules as the host's sentence splitter.) */
function isTerminatorAt(text, index) {
  const ch = text[index];
  if (ch === undefined) return false;
  // One ellipsis is a pause inside a sentence; a run of two or more closes it.
  if (ch === '…') return text[index + 1] === '…';
  if (ch === '.') {
    // An English period is a boundary only outside a decimal/version/abbreviation run (v1.2).
    const before = text[index - 1] ?? '';
    const after = text[index + 1] ?? '';
    return !(/[0-9A-Za-z]/u.test(before) && /[0-9A-Za-z]/u.test(after));
  }
  return SENTENCE_TERMINATORS.includes(ch);
}

/** The clause that follows one pause: everything up to the next pause or sentence end. */
function nextClauseOf(text) {
  const value = text.trimStart();
  for (let index = 0; index < value.length; index += 1) {
    const ch = value[index];
    if (CLAUSE_PAUSES.has(ch) || isTerminatorAt(value, index)) return value.slice(0, index).trim();
  }
  return value.trim();
}

/**
 * Decide what to do with one comma-level pause.
 *  'cut'  - the unit may end here
 *  'skip' - this pause can never close a unit (the clause pair must stay together); scan on
 *  'hold' - the look-ahead is too short to prove safety; wait for the next delta
 */
function pauseVerdict(pending, after, { minChars, cutAtChars, final }) {
  const clause = pending.trim();
  if (clause.length === 0) return 'skip';
  if (after.length === 0) return final ? 'cut' : 'hold';
  const next = nextClauseOf(after);
  // Both sides must be free of a connective / negation that changes the meaning of the pair.
  if (LEADER_PREFIXES.some((marker) => next.startsWith(marker))) return 'skip';
  if (SEMANTIC_LEADERS.some((marker) => clause.includes(marker))) return 'skip';
  // The clause must not end on a particle that expects the rest of the structure.
  const beforePause = clause.replace(/[，、,]$/u, '').trimEnd();
  if (DANGLING_TAILS.includes(beforePause[beforePause.length - 1])) return 'skip';
  // A pause a few characters before the sentence ends is not worth splitting: waiting for the
  // terminator keeps a whole short sentence (the preferred first block) instead of a stub.
  for (let index = 0; index < after.length; index += 1) {
    if (isTerminatorAt(after, index)) {
      if (index <= minChars) return 'skip';
      break;
    }
    if (CLAUSE_PAUSES.has(after[index])) break;
  }
  const chars = codePoints(clause);
  if (chars < minChars) return 'skip';
  // Size-aware first block: only cut once the pending clause is worth synthesizing.
  if (cutAtChars > 0 && chars < cutAtChars) return 'skip';
  return 'cut';
}

/**
 * Take every unit that is stable in `buffer`, keeping the unterminated tail in `rest`.
 *
 * @param {string} buffer
 * @param {{final?: boolean, clauseSplit?: boolean, minChars?: number, cutAtChars?: number}} [options]
 *   `final` flushes the tail (a complete reply); `clauseSplit:false` respects "one clip per
 *   sentence" (the `voice.chunking:false` seam); `cutAtChars` is the measured first-block size.
 * @returns {{units: string[], rest: string}}
 */
export function takeSemanticUnits(buffer, {
  final = false, clauseSplit = true, minChars = DEFAULT_UNIT_MIN_CHARS, cutAtChars = 0,
} = {}) {
  const value = String(buffer ?? '');
  const floor = Math.max(1, Math.floor(Number(minChars) || DEFAULT_UNIT_MIN_CHARS));
  const target = Number(cutAtChars) > 0 ? Math.floor(Number(cutAtChars)) : 0;
  const units = [];
  let start = 0;
  let index = 0;
  let depth = 0;
  let quote = '';
  const flush = (end) => {
    const unit = value.slice(start, end).trim();
    if (unit.length > 0) units.push(unit);
    start = end;
  };
  while (index < value.length) {
    const ch = value[index];
    if (quote !== '') {
      if (ch === quote) quote = '';
      index += 1;
      continue;
    }
    if (CLAUSE_OPENERS.has(ch)) { depth += 1; index += 1; continue; }
    if (CLAUSE_CLOSERS.has(ch)) { depth = Math.max(0, depth - 1); index += 1; continue; }
    const closing = CLAUSE_QUOTES.get(ch);
    if (closing !== undefined) { quote = closing; index += 1; continue; }
    if (isTerminatorAt(value, index)) {
      let end = index + 1;
      while (end < value.length && (value[end] === '…' || isTerminatorAt(value, end))) end += 1;
      while (end < value.length && SENTENCE_CLOSERS.includes(value[end])) end += 1;
      flush(end);
      index = end;
      depth = 0;
      continue;
    }
    if (clauseSplit && depth === 0 && CLAUSE_PAUSES.has(ch)) {
      const pending = value.slice(start, index + 1);
      const after = value.slice(index + 1);
      const verdict = pauseVerdict(pending, after, { minChars: floor, cutAtChars: target, final });
      if (verdict === 'cut') {
        flush(index + 1);
        index += 1;
        continue;
      }
      if (verdict === 'hold') break;
    }
    index += 1;
  }
  return { units, rest: value.slice(start) };
}

/**
 * Split a finished text into semantic units. With `final` (the default) the unterminated tail is
 * the last unit, so a reply without punctuation is still spoken instead of being dropped.
 * @returns {string[]}
 */
export function splitSemanticUnits(text, {
  clauseSplit = true, minChars = DEFAULT_UNIT_MIN_CHARS, cutAtChars = 0,
} = {}) {
  const taken = takeSemanticUnits(text, { final: true, clauseSplit, minChars, cutAtChars });
  const tail = taken.rest.trim();
  return tail.length > 0 ? [...taken.units, tail] : [...taken.units];
}

/**
 * Size the first block from the MEASURED synthesis cost.
 *
 * `observe({ms, chars})` feeds one real synthesis; the ratio is an EWMA, so a slow provider
 * (GPT-SoVITS) shrinks the block and a fast one (Edge TTS) grows it. Until the first measurement
 * the sensible default is used. The result is a character budget for the unit splitter.
 */
export function createUnitSizer({
  targetMs = DEFAULT_UNIT_TARGET_MS,
  defaultMsPerChar = DEFAULT_UNIT_MS_PER_CHAR,
  minChars = DEFAULT_UNIT_MIN_CHARS,
  maxChars = DEFAULT_UNIT_MAX_CHARS,
} = {}) {
  const target = Number(targetMs) > 0 ? Number(targetMs) : DEFAULT_UNIT_TARGET_MS;
  const fallback = Number(defaultMsPerChar) > 0 ? Number(defaultMsPerChar) : DEFAULT_UNIT_MS_PER_CHAR;
  const floor = Math.max(2, Math.floor(Number(minChars) || DEFAULT_UNIT_MIN_CHARS));
  const ceiling = Math.max(floor, Math.floor(Number(maxChars) || DEFAULT_UNIT_MAX_CHARS));
  let msPerChar = fallback;
  let samples = 0;
  return {
    observe({ ms = 0, chars = 0 } = {}) {
      const duration = Number(ms);
      const size = Number(chars);
      if (!(duration > 0) || !(size > 0)) return this;
      const measured = Math.min(200, Math.max(1, duration / size));
      msPerChar = samples === 0 ? measured : (msPerChar * 0.7) + (measured * 0.3);
      samples += 1;
      return this;
    },
    /** The current cost estimate, in milliseconds per character. */
    msPerChar: () => msPerChar,
    /** How many characters the first block should aim for. */
    targetChars: () => Math.min(ceiling, Math.max(floor, Math.round(target / msPerChar))),
    /** Rough duration of a block of `chars` characters at the measured cost. */
    estimateMs: (chars) => Math.max(0, Number(chars) || 0) * msPerChar,
    samples: () => samples,
  };
}

/** Headings, fences, tables, lists, links and emphasis: a shape that is not read verbatim. */
const STRUCTURED = [
  /```/u,
  /^\s{0,3}#{1,6}\s/mu,
  /^\s*\|.*\|\s*$/mu,
  /^\s*[-*+]\s+\S/mu,
  /^\s*\d+[.)]\s+\S/mu,
  /\]\(/u,
  /\*\*[^*]+\*\*/u,
  /`[^`\n]+`/u,
];
const PREAMBLE = /^(?:好的|当然|以下是|这是|没问题|可以|收到)[，,。.!！：:\s]/u;

/** Does the reply raw text carry a list/table/code/heading shape that must not be read verbatim? */
export function hasStructuredShape(raw) {
  const value = String(raw ?? '');
  return STRUCTURED.some((pattern) => pattern.test(value));
}

/** Would a short answer be read naturally as-is? Length is only one of the conditions. */
export function shouldSkipSpokenVersion(raw, speech, {
  maxChars = 60, maxSentences = 2, hardMaxChars = 120,
} = {}) {
  const text = String(speech ?? '').trim();
  if (text.length === 0) return { skip: true, reason: 'empty' };
  const chars = codePoints(text);
  if (chars > hardMaxChars) return { skip: false, reason: 'too-long' };
  if (hasStructuredShape(raw) || hasStructuredShape(text)) return { skip: false, reason: 'structured' };
  if (chars > maxChars) return { skip: false, reason: 'too-long' };
  const sentences = splitSemanticUnits(text, { clauseSplit: false }).length;
  if (sentences > maxSentences) return { skip: false, reason: 'too-many-sentences' };
  return { skip: true, reason: 'short-natural' };
}

/** A model preamble that must never reach the player (the rewrite's own validation strips it too). */
export function looksLikePreamble(text) {
  return PREAMBLE.test(String(text ?? '').trim());
}

/** Body text of one stream chunk across the provider delta shapes. */
function chunkTextOf(chunk) {
  if (typeof chunk === 'string') return chunk;
  for (const key of ['text', 'delta', 'content']) {
    if (typeof chunk?.[key] === 'string') return chunk[key];
  }
  return '';
}
const REASONING_FRAME = /^(reasoning|thinking|thought|analysis|redacted)/u;
const NORMAL_FINISH = new Set(['completed', 'complete', 'stop', 'end', 'eos', 'success', 'finished']);

/**
 * Read one raw model stream, forwarding every text delta immediately.
 *
 * Only a normal finish proves the answer is whole: a stream that simply stops, a `length` /
 * `max-tokens` finish or a `truncated` flag is reported as incomplete, so the caller can fall back
 * instead of playing a half rewrite. Reasoning frames never reach `onDelta`.
 *
 * @returns {Promise<{text: string, finish: string, complete: boolean, truncated: boolean,
 *   reasoningChars: number, firstDeltaMs: number|null}>}
 */
export async function collectModelStream(stream, {
  onDelta = null, signal = null, now = () => Date.now(), startedAt = 0,
} = {}) {
  const emit = typeof onDelta === 'function' ? onDelta : () => {};
  const origin = Number(startedAt) > 0 ? Number(startedAt) : now();
  let text = '';
  let finish = '';
  let truncated = false;
  let reasoningChars = 0;
  let firstDeltaMs = null;
  const refused = () => signal?.aborted === true;
  for await (const chunk of stream) {
    if (refused()) throw signal?.reason ?? new DOMException('Spoken version cancelled', 'AbortError');
    if (typeof chunk === 'string') {
      text += chunk;
      if (firstDeltaMs === null) firstDeltaMs = Math.max(0, now() - origin);
      emit(chunk);
      continue;
    }
    const type = String(chunk?.type ?? '').toLowerCase();
    if (REASONING_FRAME.test(type)) {
      reasoningChars += chunkTextOf(chunk).length;
      continue;
    }
    if (chunk?.truncated === true || chunk?.finish?.truncated === true) truncated = true;
    if (type === 'finish') {
      const reason = chunk?.reason ?? chunk?.finishReason ?? chunk?.finish;
      const kind = String(reason?.kind ?? reason ?? '').trim();
      finish = kind;
      if (kind === 'max-tokens' || kind === 'length' || kind === 'maxtokens') truncated = true;
      continue;
    }
    const delta = chunkTextOf(chunk);
    if (delta.length === 0) continue;
    text += delta;
    if (firstDeltaMs === null) firstDeltaMs = Math.max(0, now() - origin);
    emit(delta);
  }
  const normalized = finish.replace(/[^a-z]/gu, '').toLowerCase();
  return {
    text,
    finish,
    complete: NORMAL_FINISH.has(normalized) && !truncated,
    truncated,
    reasoningChars,
    firstDeltaMs,
  };
}

const unitCount = (text) => codePoints(String(text ?? '').trim());
/** A speakable unit carries at least one letter or digit; a pause-only leftover is not a unit. */
export const hasSpeakableText = (text) => /[\p{L}\p{N}]/u.test(String(text ?? ''));

/**
 * The plan text whose SENTENCE boundaries are exactly the semantic units that were fed to the
 * speaker. A streamed spoken version cuts long sentences at a comma, and the speaker turns each
 * unit into one played sentence (the `\n` it appends is a terminator); grouping the same text by
 * its punctuation alone would count fewer sentences and let the response group close before the
 * last unit played. The spoken characters are unchanged — only the unit separators are explicit.
 *
 * @param {string[]} units the semantic units handed to the speaker, in playback order
 * @returns {string} unit-separated plan text ('' when nothing speakable was fed)
 */
export function joinSpokenUnits(units) {
  return (Array.isArray(units) ? units : [])
    .map((unit) => String(unit ?? '').trim())
    .filter((unit) => hasSpeakableText(unit))
    .join('\n');
}

/**
 * Consume model deltas and hand every stable semantic unit straight to `onUnit`.
 *
 * The first unit is emitted the instant it is provably complete, so translation + synthesis start
 * while the rest of the rewrite is still generating. `finish()` commits the whole unterminated tail
 * as the LAST unit, so a reply that ends without a full stop is still spoken; calling it again is a
 * no-op. `cancel()` (or the injected signal) drops the buffer and every later delta: a superseded
 * turn can never emit into the new one, and a `finish()` after it replays nothing.
 *
 * @returns {{push: Function, finish: Function, cancel: Function, stats: Function}}
 */
export function createSpokenUnitStream({
  signal = null, sizer = null, clauseSplit = true, minChars = DEFAULT_UNIT_MIN_CHARS,
  onUnit = null, now = () => Date.now(),
} = {}) {
  const deliver = typeof onUnit === 'function' ? onUnit : () => {};
  let buffer = '';
  let cancelled = false;
  let closed = false;
  let units = 0;
  let chars = 0;
  let firstUnitAt = 0;
  const stopped = () => cancelled || signal?.aborted === true;
  const emit = (list) => {
    for (const unit of list) {
      if (stopped()) return;
      units += 1;
      chars += unitCount(unit);
      if (firstUnitAt === 0) firstUnitAt = now();
      deliver(unit);
    }
  };
  const cutAtChars = () => (sizer === null || typeof sizer.targetChars !== 'function'
    ? 0
    : Math.max(0, Number(sizer.targetChars()) || 0));
  return {
    push(delta) {
      if (closed || stopped()) return;
      const text = typeof delta === 'string' ? delta : '';
      if (text.length === 0) return;
      buffer += text;
      const taken = takeSemanticUnits(buffer, {
        final: false, clauseSplit, minChars, cutAtChars: cutAtChars(),
      });
      buffer = taken.rest;
      emit(taken.units);
    },
    finish() {
      if (closed) return;
      closed = true;
      if (stopped()) { buffer = ''; return; }
      // The unterminated tail is the LAST unit (never dropped); a pause-only leftover is no unit.
      const taken = takeSemanticUnits(buffer, { final: true, clauseSplit, minChars });
      const tail = taken.rest.trim();
      buffer = '';
      emit([...taken.units, tail].filter((unit) => hasSpeakableText(unit)));
    },
    cancel() {
      cancelled = true;
      buffer = '';
    },
    stats: () => ({ units, chars, firstUnitAt, cancelled }),
  };
}

/**
 * The one `voice.pipeline.timeline` payload. Every stamp is milliseconds since the delivery was
 * accepted; a stage whose boundary was never reached stays null instead of a fabricated 0.
 *
 * `bodyReadyMs` is the COMPLETE answer, `spokenStartedMs` is when the spoken version began being
 * produced (the rewrite request, or the decision itself for a short answer), and
 * `spokenFirstSentenceMs` is the first STABLE semantic unit — not the whole reply.
 *
 * `firstSynthMs` (the speaker's synthesis measurement) already INCLUDES the translation, so this
 * payload never adds `translateMs` to it.
 *
 * @param {{turn?: number|null, origin?: number, bodyReadyAt?: number, spokenStartedAt?: number,
 *   spokenFirstSentenceAt?: number, translatedFirstAt?: number, firstChunkSynthAt?: number,
 *   firstAudioAt?: number, spokenCompleteAt?: number, skippedSpokenVersion?: boolean,
 *   reusedTranslation?: boolean}} fields
 * @returns {{turn: number|null, bodyReadyMs: number|null, spokenStartedMs: number|null,
 *   spokenFirstSentenceMs: number|null, translatedFirstMs: number|null,
 *   firstChunkSynthMs: number|null, firstAudioMs: number|null, spokenCompleteMs: number|null,
 *   skippedSpokenVersion: boolean, reusedTranslation: boolean}}
 */
export function buildPipelineTimeline({
  turn = null,
  origin = 0,
  bodyReadyAt = 0,
  spokenStartedAt = 0,
  spokenFirstSentenceAt = 0,
  translatedFirstAt = 0,
  firstChunkSynthAt = 0,
  firstAudioAt = 0,
  spokenCompleteAt = 0,
  skippedSpokenVersion = false,
  reusedTranslation = false,
} = {}) {
  const base = Number(origin);
  const at = (stamp) => {
    const value = Number(stamp);
    if (!(value > 0) || !(base > 0)) return null;
    return Math.max(0, Math.round(value - base));
  };
  return {
    turn: Number.isSafeInteger(Number(turn)) ? Number(turn) : null,
    bodyReadyMs: at(bodyReadyAt),
    spokenStartedMs: at(spokenStartedAt),
    spokenFirstSentenceMs: at(spokenFirstSentenceAt),
    translatedFirstMs: at(translatedFirstAt),
    firstChunkSynthMs: at(firstChunkSynthAt),
    firstAudioMs: at(firstAudioAt),
    spokenCompleteMs: at(spokenCompleteAt),
    skippedSpokenVersion: skippedSpokenVersion === true,
    reusedTranslation: reusedTranslation === true,
  };
}
