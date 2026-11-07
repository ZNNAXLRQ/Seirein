/** format — extracted from index.js; no host entry dependency. */
import { formatMessage } from './speech-text.js';
import { looksUnbalanced } from './speech-text.js';
import { sentenceEndIndex } from '../shared/text.js';
import * as speechTextModule from './speech-text.js';
import { splitSentences } from '../shared/text.js';
import { toCaptionText } from './speech-text.js';

/**
 * Close the markers a trailing streamed fragment left open, so its own syntax never reaches TTS.
 * `**未闭合` becomes `**未闭合**`; an unclosed fence is left alone because its body is skipped.
 * @param {string} text
 * @returns {string}
 */
function closeMarkdownTail(text) {
  let out = typeof text === 'string' ? text : '';
  for (const marker of ['**', '__']) {
    if (out.split(marker).length % 2 === 0) out += marker;
  }
  if (!/^ {0,3}(?:`{3,}|~{3,})/mu.test(out) && out.split('`').length % 2 === 0) out += '`';
  if (out.split('(').length > out.split(')').length) out += ')';
  return out;
}


/**
 * Consume the complete, structurally valid part of a streaming Markdown buffer, in order.
 *
 * A streaming boundary is used only when its prefix is still balanced: an open `**`, code span,
 * fence or link target is never split, the scan moves on to the next sentence end and nothing
 * behind it is consumed (the whole span stays buffered otherwise). `final` does not cut at a
 * sentence end: the remainder is parsed first (an open marker is closed, and a code block is
 * skipped by the speech parser), then its already-plain speech is split on sentence punctuation.
 * Each consumed segment is parsed once here: `onSentence` receives speech text without Markdown,
 * `onCaption` the matching caption, so the host only has to queue both — never speak a marker.
 * @param {string} buffer
 * @param {{final?: boolean, onSentence?: Function, onCaption?: Function}} [options]
 * @returns {string} the unprocessed remainder
 */
export function feedMarkdownSentences(buffer, { final = false, onSentence = () => {}, onCaption = () => {} } = {}) {
  const emit = typeof onSentence === 'function' ? onSentence : () => {};
  const caption = typeof onCaption === 'function' ? onCaption : () => {};
  let tail = typeof buffer === 'string' ? buffer : '';
  const consume = (chunk) => {
    const formatted = formatSpeech(chunk);
    if (formatted.caption.trim().length > 0) caption(formatted.caption);
    for (const sentence of splitSentences(formatted.speech)) emit(sentence);
  };
  if (final) {
    if (tail.trim().length > 0) consume(looksUnbalanced(tail) ? closeMarkdownTail(tail) : tail);
    return '';
  }
  for (;;) {
    let end = sentenceEndIndex(tail, 0);
    while (end !== -1 && looksUnbalanced(tail.slice(0, end).trim())) end = sentenceEndIndex(tail, end);
    if (end === -1) break;
    const sentence = tail.slice(0, end).trim();
    tail = tail.slice(end);
    if (sentence.length > 0) consume(sentence);
  }
  return tail;
}


/**
 * `speech-text` records what its final cleanup could not remove (an unmatched `**`, an open code
 * span) as a bounded in-memory buffer. The host drains it at the end of every speech/caption
 * render and forwards it to the event log, at most one row per KIND per minute: a streamed
 * fragment re-renders many times, and one broken fragment must not flood the log. Nothing here may
 * throw into the text lane.
 */
const SPEECH_TEXT_RESIDUAL_THROTTLE_MS = 60_000;

const speechTextResidualAt = new Map();

/** Set by `apply`; the module itself has no event log. */
let speechTextResidualSink = null;


function flushSpeechTextResiduals() {
  try {
    const take = speechTextModule.takeResiduals;
    if (typeof take !== 'function') return;
    const rows = take();
    if (rows.length === 0 || speechTextResidualSink === null) return;
    const at = Date.now();
    for (const row of rows) {
      const kind = String(row?.kind ?? '');
      if (kind.length === 0) continue;
      if (at - (speechTextResidualAt.get(kind) ?? 0) < SPEECH_TEXT_RESIDUAL_THROTTLE_MS) continue;
      speechTextResidualAt.set(kind, at);
      speechTextResidualSink('speech-text.residual', { kind, sample: String(row.sample ?? '') });
    }
  } catch {
    /* diagnostics must never break speech or the subtitle */
  }
}


/**
 * Parse a Markdown line for speech and caption. Deliberately empty speech (a pure code block,
 * parsed successfully) stays empty so nothing is spoken; only a parser failure falls back to the
 * raw text. The caption is always available for the subtitle.
 * @param {string} text
 * @returns {{speech: string, caption: string, empty: boolean, failed: boolean}}
 */
function formatSpeech(text) {
  const source = typeof text === 'string' ? text : '';
  try {
    const formatted = formatMessage(source);
    flushSpeechTextResiduals();
    return {
      speech: formatted.speech,
      caption: formatted.caption,
      empty: source.trim().length > 0 && formatted.speech.trim().length === 0,
      failed: false,
    };
  } catch {
    return { speech: source, caption: source, empty: false, failed: true };
  }
}


/** Caption rendering that survives a parser failure: the raw text is the subtitle, never empty. */
function formatCaption(text) {
  const source = typeof text === 'string' ? text : '';
  try {
    const caption = toCaptionText(source);
    flushSpeechTextResiduals();
    return caption;
  } catch {
    return source;
  }
}

export {
  closeMarkdownTail,
  SPEECH_TEXT_RESIDUAL_THROTTLE_MS,
  speechTextResidualAt,
  speechTextResidualSink,
  flushSpeechTextResiduals,
  formatSpeech,
  formatCaption,
};

/** Bind the mounted host event sink; imports remain read-only. */
export function setSpeechTextResidualSink(sink) { speechTextResidualSink = sink; }
