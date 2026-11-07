/**
 * Continuous dialogue context: segmented ASR, unsegmented understanding.
 *
 * Recognized speech arrives one utterance at a time, but the companion should read it as one
 * dialogue. This module keeps the recent transcript verbatim in a time- and size-bounded window,
 * rolls older utterances into a bounded pending queue, and lets the caller generate the rolling
 * summary asynchronously and write it back through `applySummary`.
 *
 * It is the buffering + summary skeleton only:
 *  - no model call and no prompt building; `applySummary` stores what the caller produced;
 *  - no memory write, no database, no audio and no file I/O;
 *  - no timer and no promise: a quiet moment changes nothing, and `snapshot()` is read-only.
 *
 * Sentence continuity: an utterance that does not end in `。！？!?` is unfinished. The next
 * utterance of the SAME segment is rendered on the same line, keeping its comma/connector, and a
 * period is never invented (`钥匙在柜子里，` + `你去拿吧。` → `钥匙在柜子里，你去拿吧。`).
 *
 * Segment independence: `markBoundary({reason})` starts a new segment. The window and the summary
 * keep their content but are marked as another source/segment, and `render()` puts a boundary line
 * between them, so two videos are never read as one story. The unfinished sentence is dropped at
 * the boundary: text after it can never be spliced onto text before it.
 *
 * Source independence: every entry remembers the capture it came from (`mic` = microphone,
 * `loopback` = what the speakers play). A push whose source differs from the previous entry in time
 * order opens a source boundary automatically, and `render()` never joins or continues an unfinished
 * sentence across two sources: it prints a source divider and a `[麦克风]` / `[系统声音]` tag on
 * every line, so "我不舒服，" (mic) + "你去拿药吧。" (a video) stay two observations and cannot
 * become one person's sentence. A device change inside one source is NOT a source change.
 *
 * `snapshot()` is the request-facing structure (recent / pending / summary / boundary / generation);
 * `render()` turns it into a system-prompt paragraph that says it is an observation, not a user
 * turn. Rolling out of the window moves text to `pending`; the text is NOT lost until a summary
 * covering it is applied, and `needsSummary()` says when the caller should generate one.
 *
 * Summary requests are generation-scoped: `clear()` starts a new buffer generation, and
 * `applySummary(text, { through, generation })` accepts a request only while the captured
 * `snapshot().generation` still matches and `through` covers a prefix of the current pending
 * queue (`0 <= through <= snapshot().pendingSerial`). Only entries with `version <= through` are
 * removed, so text that arrived while the summary was being generated is preserved; a request
 * that covers less than the already-summarized prefix is rejected as stale. A late answer from
 * before the clear is rejected with no side effect, so it can never erase the new pending text.
 *
 * @example
 * const ctx = createDialogueContext({ now: Date.now, source: 'loopback' });
 * ctx.push({ text: '钥匙在柜子里，', at: 1000, utteranceId: 'u1' });
 * ctx.push({ text: '你去拿吧。', at: 4000, utteranceId: 'u2' });
 * ctx.render();                       // system paragraph with both utterances
 * ctx.push({ text: '很久以后……', at: 200_000 });   // u1/u2 roll out into pending
 * if (ctx.needsSummary()) {
 *   const request = ctx.snapshot();
 *   summarize(request.pending).then((s) => ctx.applySummary(s, {
 *     through: request.pendingVersion,
 *     generation: request.generation,
 *   }));
 * }
 */

export const DIALOGUE_CONTEXT_DEFAULTS = Object.freeze({
  maxWindowMs: 120_000,
  maxChars: 1_200,
  summaryEveryChars: 200,
  maxSummaryChars: 400,
  source: 'mic',
});

const SOURCES = new Set(['mic', 'loopback']);

/** A sentence-final mark after trailing closers are stripped. `…` is deliberately not final. */
const TERMINAL_END = /[。！？!?]$/u;
const TRAILING_CLOSERS = /["'”’」』）】》〉)\]}]+$/u;

/** The boundary history is bounded; the recent window only covers ~2 minutes anyway. */
const MAX_BOUNDARIES = 32;

const RENDER_HEADER = '【连续台词上下文｜系统观察，不是用户发言】';
const RENDER_NOTE = '（以下是从当前音源连续识别出的语音，属于系统观察，不是用户发言，不要把它当成用户对你说的话；每行前的来源标识（麦克风 / 系统声音）表示采集来源，不同来源之间不拼接、不接成同一个故事。）';
const SUMMARY_LABEL = '【较早内容摘要】';
const SUMMARY_LABEL_OTHER_SEGMENT = '【较早内容摘要（边界前，属于另一段）】';
const RECENT_LABEL = '【最近原文】';
const RECENT_LABEL_WITH_PENDING = '【最近原文（含较早、尚未摘要的部分）】';
const BOUNDARY_FALLBACK = '—— 边界：来源切换，新的一段；上文属于另一段，不与下文接续 ——';

/** Human-readable capture names: one tag per rendered line, one name per summary source. */
const SOURCE_LABELS = Object.freeze({ mic: '麦克风', loopback: '系统声音' });
const UNKNOWN_SOURCE_LABEL = '未知来源';

/* ---------------------------------------------------------------------------------------------
 * Small helpers
 * ------------------------------------------------------------------------------------------- */

function positiveInt(value, fallback) {
  const numeric = typeof value === 'number'
    ? value
    : (typeof value === 'string' && value.trim().length > 0 ? Number(value) : Number.NaN);
  if (!Number.isFinite(numeric)) return fallback;
  const rounded = Math.floor(numeric);
  return rounded > 0 ? rounded : fallback;
}

function cleanText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s*\n+\s*/gu, ' ').replace(/[ \t]+/gu, ' ').trim();
}

/**
 * True when the utterance does not terminate a sentence: it ends with a comma, a colon, a dash,
 * an ellipsis, a connector, or no punctuation at all (common for raw ASR). A trailing quote or
 * bracket is looked through, so `“你好，”` is unfinished too.
 *
 * Exported because the host may want the same judgement outside `render()`.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isUnfinishedSentence(text) {
  const body = cleanText(text).replace(TRAILING_CLOSERS, '').replace(/[ \t]+$/u, '');
  if (body.length === 0) return false;
  return !TERMINAL_END.test(body);
}

function createClock(now) {
  if (typeof now === 'function') {
    return () => {
      const value = Number(now());
      return Number.isFinite(value) ? value : Date.now();
    };
  }
  if (typeof now === 'number' && Number.isFinite(now)) return () => now;
  return () => Date.now();
}

/** Which capture an entry came from; an unset/foreign value is "unknown", never guessed. */
function sourceKey(item) {
  const value = item !== null && typeof item === 'object' ? item.source : '';
  return SOURCES.has(value) ? value : '';
}

/** `[麦克风]` / `[系统声音]`: the tag render() puts in front of one line. */
function sourceLabelOf(source) {
  return `[${SOURCE_LABELS[source] ?? UNKNOWN_SOURCE_LABEL}]`;
}

/**
 * The divider between two different captures. It names both sources (and the boundary reason when
 * one is known) so the reader can never mistake the two streams for one conversation.
 */
function sourceBoundaryLine(from, to, reason) {
  const left = SOURCE_LABELS[from] ?? UNKNOWN_SOURCE_LABEL;
  const right = SOURCE_LABELS[to] ?? UNKNOWN_SOURCE_LABEL;
  const cause = typeof reason === 'string' && reason.length > 0 ? `（${reason}）` : '';
  return `—— 来源切换：${left} → ${right}${cause}；两路音源不拼接，上文不与下文接续 ——`;
}

function boundaryView(boundary) {
  const view = { at: boundary.at, reason: boundary.reason, segment: boundary.segment };
  if (typeof boundary.from === 'string' && boundary.from.length > 0) view.from = boundary.from;
  if (typeof boundary.to === 'string' && boundary.to.length > 0) view.to = boundary.to;
  return Object.freeze(view);
}

/** Summary heading: says it is earlier text, and which captures that text came from. */
function summaryLabelFor(sources, earlier) {
  const tags = (Array.isArray(sources) ? sources : [])
    .map((source) => SOURCE_LABELS[source] ?? UNKNOWN_SOURCE_LABEL)
    .join('、');
  const base = earlier === true ? SUMMARY_LABEL_OTHER_SEGMENT : SUMMARY_LABEL;
  return tags.length > 0 ? `${base}（来源：${tags}）` : base;
}

function boundaryLine(boundary) {
  const reason = typeof boundary.reason === 'string' && boundary.reason.length > 0
    ? `（${boundary.reason}）`
    : '';
  return `—— 边界：来源切换，新的一段${reason}；上文属于另一段，不与下文接续 ——`;
}

/** One boundary record as a divider line: a source switch names both sides, a plain one does not. */
function renderBoundary(boundary) {
  return typeof boundary.from === 'string' && boundary.from.length > 0
    && typeof boundary.to === 'string' && boundary.to.length > 0
    ? sourceBoundaryLine(boundary.from, boundary.to, boundary.reason)
    : boundaryLine(boundary);
}

function boundaryFor(boundaries, segment) {
  for (const boundary of boundaries) {
    if (boundary.segment === segment) return boundary;
  }
  return null;
}

/** Two items continue the SAME stream only when neither the segment nor the capture changed. */
function sameStream(previous, item) {
  return previous !== null
    && previous.segment === item.segment
    && sourceKey(previous) === sourceKey(item);
}

/**
 * Render one transcript stream: consecutive items of the same segment AND source join on one line
 * while the previous one is unfinished; a boundary inserts its divider line. A source change gets
 * the source divider even when it did not also open a new segment, and a new line always starts
 * with its own `[来源]` tag.
 */
function joinStream(items, boundaries, { trailing = false, labels = true } = {}) {
  let out = '';
  let previous = null;
  for (const item of items) {
    const text = typeof item.text === 'string' ? item.text : '';
    if (text.length === 0) continue;
    const prefix = labels ? `${sourceLabelOf(sourceKey(item))} ` : '';
    if (previous === null) {
      out = `${prefix}${text}`;
    } else if (!sameStream(previous, item)) {
      const boundary = boundaryFor(boundaries, item.segment);
      if (sourceKey(item) !== sourceKey(previous)) {
        out += `\n${sourceBoundaryLine(sourceKey(previous), sourceKey(item), boundary ? boundary.reason : '')}`;
      } else {
        out += `\n${boundary ? boundaryLine(boundary) : BOUNDARY_FALLBACK}`;
      }
      out += `\n${prefix}${text}`;
    } else if (isUnfinishedSentence(previous.text)) {
      // Same source, same segment: the same sentence continues across the ASR segment boundary.
      out += text;
    } else {
      out += `\n${prefix}${text}`;
    }
    previous = item;
  }
  if (trailing) {
    const lastSegment = previous === null ? -1 : previous.segment;
    for (const boundary of boundaries) {
      if (boundary.segment <= lastSegment) continue;
      const line = renderBoundary(boundary);
      out = out.length === 0 ? line : `${out}\n${line}`;
    }
  }
  return out;
}

/**
 * Group transcript items by capture, in the order each source first appears (which is time order).
 * This is what a rolling-summary request must read: the pending text of the two captures stays
 * separate, so the generated summary can name the microphone and the system audio instead of
 * merging them into one speaker.
 *
 * @param {Array<{text?: string, at?: number, source?: string, segment?: number}>} items
 * @returns {ReadonlyArray<{source: string, label: string, text: string, chars: number, at: number}>}
 */
function groupBySource(items) {
  const groups = new Map();
  for (const item of items) {
    const text = typeof item?.text === 'string' ? item.text : '';
    if (text.length === 0) continue;
    const source = sourceKey(item);
    let group = groups.get(source);
    if (group === undefined) {
      group = { source, label: SOURCE_LABELS[source] ?? UNKNOWN_SOURCE_LABEL, text: '', chars: 0, at: item.at, previous: null };
      groups.set(source, group);
    }
    const continues = group.previous !== null
      && group.previous.segment === item.segment
      && isUnfinishedSentence(group.previous.text);
    group.text = continues ? group.text + text : (group.text.length === 0 ? text : `${group.text}\n${text}`);
    group.chars += text.length;
    group.previous = item;
  }
  return Object.freeze([...groups.values()].map(({ previous, ...rest }) => Object.freeze(rest)));
}


/* ---------------------------------------------------------------------------------------------
 * Factory
 * ------------------------------------------------------------------------------------------- */

/**
 * Create one in-memory dialogue buffer.
 *
 * @param {object} [options]
 * @param {number|Function} [options.now] timestamp or clock returning epoch ms (default Date.now)
 * @param {number} [options.maxWindowMs=120000] time span kept verbatim
 * @param {number} [options.maxChars=1200] character budget of the verbatim window
 * @param {number} [options.summaryEveryChars=200] newly rolled-out chars that warrant a summary
 * @param {number} [options.maxSummaryChars=400] hard cap of the stored rolling summary
 * @param {'mic'|'loopback'} [options.source='mic'] default source of pushed utterances
 * @returns {{
 *   push: (utterance: {text: string, at?: number, source?: string, utteranceId?: string}) => object|null,
 *   snapshot: () => object,
 *   markBoundary: (options?: {reason?: string}) => object,
 *   clear: () => void,
 *   needsSummary: () => boolean,
 *   applySummary: (text: string, options?: {through?: number, generation?: number}) => object,
 *   render: (snapshot?: object) => string,
 * }}
 */
export function createDialogueContext(options = {}) {
  const settings = options && typeof options === 'object' ? options : {};
  const maxWindowMs = positiveInt(settings.maxWindowMs, DIALOGUE_CONTEXT_DEFAULTS.maxWindowMs);
  const maxChars = positiveInt(settings.maxChars, DIALOGUE_CONTEXT_DEFAULTS.maxChars);
  const summaryEveryChars = positiveInt(settings.summaryEveryChars, DIALOGUE_CONTEXT_DEFAULTS.summaryEveryChars);
  const maxSummaryChars = positiveInt(settings.maxSummaryChars, DIALOGUE_CONTEXT_DEFAULTS.maxSummaryChars);
  const defaultSource = SOURCES.has(settings.source) ? settings.source : DIALOGUE_CONTEXT_DEFAULTS.source;
  const clock = createClock(settings.now);

  /** Pending text is already outside the window; keep it bounded even if nobody summarizes. */
  const maxPendingChars = Math.max(maxChars, summaryEveryChars * 2);

  /** @type {{text: string, at: number, utteranceId: string, source: string, segment: number, seq: number}[]} */
  let entries = [];
  /** @type {{text: string, at: number, utteranceId: string, source: string, segment: number, version: number}[]} */
  let pending = [];
  let pendingChars = 0;
  let pendingSerial = 0;
  /**
   * Highest pending version already folded into the stored summary. A request may only move this
   * forward: `through === summaryThrough` refreshes the same prefix, and `through < summaryThrough`
   * is an old summary that would overwrite newer coverage, so it is rejected untouched.
   */
  let summaryThrough = 0;
  let summary = '';
  /** Captures whose text the stored summary describes, in first-appearance order (render labels it). */
  let summarySources = [];
  let summarySegment = 0;
  let summaryTruncated = false;
  let segment = 0;
  let boundaries = [];
  let seq = 0;
  /**
   * Buffer identity for asynchronous summary requests. `clear()` bumps it because it resets the
   * pending version to 0; without this an old request could match a new buffer that happened to
   * reach the same version number. `markBoundary()` keeps it: a boundary does not reset the
   * summary (it only labels it as "another segment"), so pre-boundary summaries stay legitimate.
   */
  let generation = 1;
  let updatedAt = clock();
  const stats = { pushed: 0, rolledOut: 0, summaries: 0, droppedPendingChars: 0 };

  function recentChars() {
    return entries.reduce((total, entry) => total + entry.text.length, 0);
  }

  function currentOpenSentence() {
    const last = entries.length > 0 ? entries[entries.length - 1] : null;
    return last !== null && last.segment === segment && isUnfinishedSentence(last.text);
  }

  function trimPending() {
    while (pendingChars > maxPendingChars && pending.length > 1) {
      const dropped = pending.shift();
      pendingChars -= dropped.text.length;
      stats.droppedPendingChars += dropped.text.length;
    }
  }

  function rollOut(entry) {
    pendingSerial += 1;
    pending.push({
      text: entry.text,
      at: entry.at,
      utteranceId: entry.utteranceId,
      source: entry.source,
      segment: entry.segment,
      version: pendingSerial,
    });
    pendingChars += entry.text.length;
    stats.rolledOut += 1;
    trimPending();
  }

  /** Enforce both window limits. The newest utterance is always kept, even if it alone is long. */
  function prune() {
    if (entries.length === 0) return;
    const newest = entries[entries.length - 1].at;
    while (entries.length > 0 && newest - entries[0].at > maxWindowMs) {
      rollOut(entries.shift());
    }
    let chars = entries.reduce((total, entry) => total + entry.text.length, 0);
    while (chars > maxChars && entries.length > 1) {
      const removed = entries.shift();
      chars -= removed.text.length;
      rollOut(removed);
    }
  }

  function push(input) {
    const payload = input && typeof input === 'object' ? input : {};
    const text = cleanText(payload.text);
    if (text.length === 0) return null;
    const at = Number.isFinite(payload.at) ? payload.at : clock();
    const source = SOURCES.has(payload.source) ? payload.source : defaultSource;
    const utteranceId = typeof payload.utteranceId === 'string' && payload.utteranceId.trim().length > 0
      ? payload.utteranceId.trim()
      : `utt-${seq + 1}`;
    seq += 1;
    let index = entries.length;
    while (index > 0 && entries[index - 1].at > at) index -= 1;
    /**
     * Source independence is automatic: when the entry immediately before this one in time order
     * came from another capture, the pair is a boundary. If a manual boundary already opened a new
     * segment between them, it is reused; otherwise the segment is opened here. Either way the
     * caller is told through `sourceBoundary`, so it can emit `voice.dialogue.source-boundary`.
     */
    const previous = index > 0 ? entries[index - 1] : null;
    let sourceBoundary = null;
    if (previous !== null && sourceKey(previous) !== source) {
      if (previous.segment === segment) {
        segment += 1;
        boundaries.push({ at, reason: 'source-switch', segment, from: previous.source, to: source });
        while (boundaries.length > MAX_BOUNDARIES) boundaries.shift();
      }
      sourceBoundary = { from: previous.source, to: source, at };
    }
    const entry = { text, at, utteranceId, source, segment, seq };
    entries.splice(index, 0, entry);
    stats.pushed += 1;
    prune();
    updatedAt = clock();
    const appended = {
      text: entry.text,
      at: entry.at,
      utteranceId: entry.utteranceId,
      source: entry.source,
      segment: entry.segment,
    };
    if (sourceBoundary !== null) appended.sourceBoundary = sourceBoundary;
    return appended;
  }

  function markBoundary(input) {
    const payload = input && typeof input === 'object' ? input : {};
    const reason = cleanText(payload.reason);
    // A source boundary may name both captures (restart path); a plain boundary carries neither.
    const from = cleanText(payload.from);
    const to = cleanText(payload.to);
    // The summary survives a boundary (it is rendered as "another segment"), so the generation is
    // not bumped: a pre-boundary summary may still land, but only while no post-boundary text has
    // rolled out (the version check rejects it otherwise).
    segment += 1;
    const boundary = { at: clock(), reason, segment };
    if (from.length > 0 && to.length > 0) {
      boundary.from = from;
      boundary.to = to;
    }
    boundaries.push(boundary);
    while (boundaries.length > MAX_BOUNDARIES) boundaries.shift();
    updatedAt = boundary.at;
    return boundaryView(boundary);
  }

  function clear() {
    // A cleared buffer is a new buffer: every request generated from the old contents is stale,
    // however closely its version number matches the restarted counter.
    generation += 1;
    entries = [];
    pending = [];
    pendingChars = 0;
    pendingSerial = 0;
    summaryThrough = 0;
    summary = '';
    summarySources = [];
    summarySegment = 0;
    summaryTruncated = false;
    segment = 0;
    boundaries = [];
    seq = 0;
    stats.pushed = 0;
    stats.rolledOut = 0;
    stats.summaries = 0;
    stats.droppedPendingChars = 0;
    updatedAt = clock();
  }

  /** True once enough newly rolled-out text has accumulated for one summary call. */
  function needsSummary() {
    return pendingChars >= summaryEveryChars;
  }

  /**
   * Store the caller's rolling summary and clear the pending prefix it covers.
   *
   * A request is accepted only in the same buffer generation it was generated from
   * (`generation` mismatch → `stale-generation`) and only for a covered prefix of the current
   * pending queue: `through` must be a safe integer with `0 <= through <= pendingSerial`.
   * `through` is the captured `snapshot().pendingSerial` (or `pendingVersion`), and the summary
   * text describes everything up to that point. Only pending entries with `version <= through`
   * are removed, so text that rolled out while the summary was being generated survives.
   *
   * Coverage never moves backwards: `through < summaryThrough` means an older summary would
   * replace a newer one, so it is rejected as `stale-prefix` without touching any state. The same
   * prefix may be submitted again (`through === summaryThrough`) to refresh its summary text.
   *
   * `text` is the COMPLETE new summary (the caller reads the old one from `snapshot()` and folds
   * the pending text into it), not a delta: the stored summary is replaced. An empty value is
   * ignored so a failed generation cannot silently drop pending text. Over the cap the oldest
   * characters are dropped (`slice(-maxSummaryChars)`), keeping the most recent part.
   *
   * The summary is marked with the newest segment its cleared pending text belonged to: a summary
   * generated after a boundary from the previous segment's text stays labelled "another segment".
   * It also remembers the captures (`mic` / `loopback`) its covered text came from, exposed as
   * `snapshot().summarySources` and tagged on the rendered summary, so a summary of both streams
   * never reads as one speaker.
   */
  function applySummary(value, optionsArg = {}) {
    const settings = optionsArg && typeof optionsArg === 'object' ? optionsArg : {};
    const text = cleanText(value);
    if (text.length === 0) {
      return { ok: false, applied: false, reason: 'empty', summary, truncated: false, pendingChars };
    }
    // Validate the request identity BEFORE touching any state: a rejected summary must leave the
    // summary, the pending queue, the counters and updatedAt exactly as they were. A missing
    // coordinate fails closed, so a caller that does not carry generation can never clobber state.
    if (!Number.isSafeInteger(settings.generation) || settings.generation !== generation) {
      return { ok: false, reason: 'stale-generation' };
    }
    const through = settings.through;
    if (!Number.isSafeInteger(through) || through < 0) {
      return { ok: false, reason: 'invalid-through' };
    }
    if (through > pendingSerial) {
      return { ok: false, reason: 'stale-version' };
    }
    if (through < summaryThrough) {
      return { ok: false, reason: 'stale-prefix' };
    }
    const truncated = Array.from(text).length > maxSummaryChars;
    // Count characters, not UTF-16 units, so an emoji is one character here.
    summary = truncated ? Array.from(text).slice(-maxSummaryChars).join('') : text;
    summaryTruncated = truncated;
    summaryThrough = through;
    const kept = [];
    let keptChars = 0;
    let clearedSegment = -1;
    /** The summary describes the old summary's text too, so its captures stay attached to it. */
    const nextSources = [...summarySources];
    for (const item of pending) {
      if (item.version <= through) {
        if (item.segment > clearedSegment) clearedSegment = item.segment;
        if (!nextSources.includes(item.source)) nextSources.push(item.source);
        continue;
      }
      kept.push(item);
      keptChars += item.text.length;
    }
    pending = kept;
    pendingChars = keptChars;
    summarySources = nextSources;
    if (clearedSegment >= 0) summarySegment = Math.max(summarySegment, clearedSegment);
    stats.summaries += 1;
    updatedAt = clock();
    return { ok: true, applied: true, summary, truncated, pendingChars };
  }

  function snapshot() {
    const latest = boundaries.length > 0 ? boundaries[boundaries.length - 1] : null;
    const recent = Object.freeze(entries.map((entry) => Object.freeze({
      text: entry.text,
      at: entry.at,
      utteranceId: entry.utteranceId,
      source: entry.source,
      segment: entry.segment,
    })));
    const queued = Object.freeze(pending.map((item) => Object.freeze({
      text: item.text,
      at: item.at,
      utteranceId: item.utteranceId,
      source: item.source,
      segment: item.segment,
    })));
    return Object.freeze({
      recent,
      pending: queued,
      summary,
      summaryChars: Array.from(summary).length,
      summaryTruncated,
      summaryFromEarlierSegment: summary.length > 0 && summarySegment < segment,
      /** Captures the stored summary describes; render() tags the summary with them. */
      summarySources: Object.freeze([...summarySources]),
      /**
       * The pending queue grouped by capture (first-appearance = time order), each group already
       * joined within its own source. This is where a summary request keeps the source clue.
       */
      pendingBySource: groupBySource(queued),
      pendingChars,
      /** Highest pending version covered by the stored summary; guarded against going backwards. */
      summaryThrough,
      /** Current tail of the pending queue: the largest `through` a request may cover. */
      pendingSerial,
      /** Alias kept for callers/tests written before `summaryThrough` existed. */
      pendingVersion: pendingSerial,
      /** Buffer identity a summary request must carry back; see `applySummary`. */
      generation,
      recentChars: recentChars(),
      needsSummary: pendingChars >= summaryEveryChars,
      openSentence: currentOpenSentence(),
      updatedAt,
      boundaryMarked: latest ? boundaryView(latest) : null,
      boundaryMarkedAt: latest ? latest.at : null,
      boundaryReason: latest ? latest.reason : '',
      boundaries: Object.freeze(boundaries.map(boundaryView)),
      segment,
      source: defaultSource,
      limits: Object.freeze({ maxWindowMs, maxChars, summaryEveryChars, maxSummaryChars, maxPendingChars }),
      stats: Object.freeze({ ...stats }),
    });
  }

  /**
   * Render the current state (or a provided snapshot) as a system-prompt paragraph. The header
   * says it is an observation, not a user turn; empty state renders as ''.
   *
   * @param {object} [snapshotValue] a value previously returned by `snapshot()`
   * @returns {string}
   */
  function render(snapshotValue) {
    const view = snapshotValue && typeof snapshotValue === 'object' && Array.isArray(snapshotValue.recent)
      ? snapshotValue
      : snapshot();
    const summaryText = typeof view.summary === 'string' ? view.summary : '';
    const pendingItems = Array.isArray(view.pending) ? view.pending : [];
    const recentItems = Array.isArray(view.recent) ? view.recent : [];
    const boundaryList = (Array.isArray(view.boundaries) && view.boundaries.length > 0
      ? view.boundaries
      : (view.boundaryMarked && typeof view.boundaryMarked === 'object' ? [view.boundaryMarked] : []))
      .filter((boundary) => boundary !== null && typeof boundary === 'object' && Number.isInteger(boundary.segment));
    if (summaryText.length === 0 && pendingItems.length === 0 && recentItems.length === 0 && boundaryList.length === 0) {
      return '';
    }
    const parts = [RENDER_HEADER, RENDER_NOTE];
    if (summaryText.length > 0) {
      parts.push(
        '',
        summaryLabelFor(view.summarySources, view.summaryFromEarlierSegment === true),
        summaryText,
      );
    }
    // Pending text and the verbatim window are both transcript: render them as ONE continuous
    // stream so an unfinished sentence stays joined across the window edge and a segment change
    // is still separated by its boundary line.
    const transcript = [...pendingItems, ...recentItems];
    const transcriptText = joinStream(transcript, boundaryList, { trailing: true });
    if (transcriptText.length > 0) {
      parts.push('', pendingItems.length > 0 ? RECENT_LABEL_WITH_PENDING : RECENT_LABEL, transcriptText);
    }
    return parts.join('\n').trimEnd();
  }

  return { push, snapshot, markBoundary, clear, needsSummary, applySummary, render };
}
