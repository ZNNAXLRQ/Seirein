/**
 * Speech and caption text derived from the assistant's Markdown reply.
 *
 * The chat bubble keeps the raw Markdown. TTS and the subtitle overlay both need plain text,
 * but not the same one: speech gets pauses and no code fences, captions keep line breaks and
 * (by default) link targets. A single `parse` pass builds the block/inline tree and the two
 * renderers only read it, so one streamed fragment is parsed once per rendering decision.
 *
 * Cleaning is structural, never a global strip of `*`, `#`, `_` or `-`: only a marker in a
 * syntax position (a line-leading `#`, `>` or list marker, a matched `**`/`__`/`~~`, a
 * `[…](…)` link, a code span, a table row, an HTML tag) is removed. `C#`, `2*3`, `-5`,
 * `2026-11-05`, `$3.50`, `file_name.py` and `a-b` therefore come out unchanged.
 *
 * Incomplete input is kept verbatim: an unmatched `**`, an open code span, an unclosed link or
 * an unterminated fence is emitted as literal text, so cleaning a streamed half sentence can
 * never destroy characters. `looksUnbalanced` exposes the same scan so the caller can decide to
 * wait for the next fragment instead of rendering now.
 *
 * Literal regions are identified in the parser, not guessed again after rendering. A code span,
 * a code block body, an escaped character (`\*`, `\|`) and HTML written inside code are swapped
 * for an opaque placeholder while the lane is rendered; `ensurePlain` cleans only what is left
 * outside the placeholders and restores them afterwards, so the last pass can never strip a
 * character that was already plain text. Restoring changes no character (speech only turns a
 * line break into a space).
 *
 * Every rendered lane (speech, caption, plain) ends in `ensurePlain`: a structure scan over the
 * *finished* text, a context-free cleanup of whatever is still syntactically Markdown, and a
 * repeat until no change is left. This is the guarantee that does not depend on the list of known
 * formats: a format the parser has never seen still loses its markers, keeps its words. What the
 * cleanup refuses to remove (an unmatched delimiter that may still be streaming) stays verbatim
 * and is recorded as `speech-text.residual {kind, sample}` for later discovery instead of leaking
 * silently. `C#`, `2*3`, `-5`, `2026-11-05`, `$3.50`, `file_name.py`, `a-b` and ordinary
 * parentheses are not syntax and pass unchanged.
 *
 * Tables lose their `|` borders and separator row: a caption keeps one row per line and joins
 * cells with `，`; speech reads each row as `表头：值；…` (or cells only with `tableMode: 'plain'`).
 * Link and image syntax drops its target: `[文字](url)` and `![图](url)` become `文字`/`图`.
 *
 * Options (all optional):
 *   - `tableMode`: `'ordered'` (default, "姓名：张三；年龄：30") or `'plain'` (cells only).
 *   - `codeBlocks`: `'skip'` (default) or `'read-first-line'`.
 *   - `links`: speech `'text-only'` (default) / `'read-url'`; caption `'text-only'` (default) /
 *     `'with-url'`. Link text is kept in both; the target is optional and never needed for a
 *     clean subtitle.
 *   - `parse`: test seam, replaces the internal parser in `formatMessage` so a single call to it
 *     can be counted.
 *
 * `ensurePlain(text, {lane})` is exported for a caller that renders text itself; `takeResiduals()`
 * drains the in-memory residual buffer so a host can forward it to its event log. The module does
 * no I/O, timers or playback, and keeps no state beyond that bounded diagnostic buffer.
 */

const ESCAPABLE = new Set('\\`*_{}[]()#+-.!>~|'.split(''));

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/u;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/u;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/u;
const THEMATIC = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/u;
const QUOTE = /^ {0,3}>/u;
const LIST_ITEM = /^ {0,3}([-*+]|\d{1,9}[.)])([ \t]+)(.*)$/u;
const TASK_BOX = /^\[[ xX]?\][ \t]+/u;
const BARE_URL = /^https?:\/\/[^\s<>"`（）【】《》「」]+/iu;
const SENTENCE_END = /[。！？!?；;…]$/u;
const SOFT_END = /[，,、；;：:。！？!?…]$/u;

/* Unknown block syntax the parser degrades instead of guessing: drop the marker, keep the text. */
const CALLOUT = /^ {0,3}\[![A-Za-z][^\]]*\][ \t]*$/u;
const FOOTNOTE_DEF = /^ {0,3}\[\^([^\]]+)\]:[ \t]*(.*)$/u;
const REF_DEF = /^ {0,3}\[[^\]]+\]:[ \t]*\S*.*$/u;
const DEF_MARKER = /^ {0,3}:[ \t]+(.*)$/u;
const INDENT_CODE = /^ {4,}(.*)$/u;
const ENTITY = /^&(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/iu;

/** Opaque marker for one literal region; `\u0000` never occurs in rendered prose. */
const LITERAL_PLACEHOLDER = /\u0000L(\d+)\u0000/gu;

/** Elements that break the flow; removing them leaves a line break instead of gluing words. */
const BLOCK_HTML = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'dd', 'details', 'div', 'dl', 'dt',
  'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li',
  'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th',
  'thead', 'tr', 'ul',
]);
const HTML_COMMENT = /^<!--[\s\S]*?-->/u;
const HTML_DECL = /^<![^>]*>/u;
const HTML_TAG = /^<(\/?)([A-Za-z][A-Za-z0-9-]*)((?:"[^"]*"|'[^']*'|[^<>"'])*?)(\/?)>/u;

const SPEECH_DEFAULTS = Object.freeze({
  tableMode: 'ordered',
  codeBlocks: 'skip',
  links: 'text-only',
});
const CAPTION_DEFAULTS = Object.freeze({
  tableMode: 'rows',
  links: 'text-only',
});
const SHARED_KEYS = Object.freeze(['tableMode', 'codeBlocks', 'links']);

/* ---------------------------------------------------------------------------------------------
 * Speech budget — the one cap every speaking lane shares
 * ------------------------------------------------------------------------------------------- */

/** Long-answer speech cap, in characters. `voice.speechMaxChars` overrides it. */
export const DEFAULT_SPEECH_MAX_CHARS = 1200;

/** Its own caption line when the spoken share ends before the reply does. */
export const SPEECH_TRUNCATION_NOTE = '（后文见文字）';

/**
 * Resolve the spoken-reply budget. This is the single rule behind all three lanes:
 * `assistant_say`, the automatic reply speaker and the typed round-end speaker.
 *
 * A missing/invalid value keeps the default. A non-positive value (`speechMaxChars: 0`) means
 * "no cap": the whole reply is spoken and no sentence boundary is applied.
 *
 * @param {{maxChars?: number|string}} [options]
 * @returns {{maxChars: number, unbounded: boolean}}
 */
export function resolveSpeechBudget({ maxChars = DEFAULT_SPEECH_MAX_CHARS } = {}) {
  const numeric = typeof maxChars === 'number'
    ? maxChars
    : (typeof maxChars === 'string' && maxChars.trim().length > 0 ? Number(maxChars) : Number.NaN);
  if (numeric === Infinity) return { maxChars: 0, unbounded: true };
  if (!Number.isFinite(numeric)) return { maxChars: DEFAULT_SPEECH_MAX_CHARS, unbounded: false };
  const rounded = Math.floor(numeric);
  return rounded > 0 ? { maxChars: rounded, unbounded: false } : { maxChars: 0, unbounded: true };
}

/* ---------------------------------------------------------------------------------------------
 * Small text helpers
 * ------------------------------------------------------------------------------------------- */

function isAsciiWord(char) {
  return typeof char === 'string' && char.length > 0 && /[0-9A-Za-z_]/u.test(char);
}

/** Length of the run of `char` starting at `index`. */
function runLength(source, index, char) {
  let end = index;
  while (source[end] === char) end += 1;
  return end - index;
}

function countOf(text, char) {
  let count = 0;
  for (const current of text) if (current === char) count += 1;
  return count;
}

/**
 * `2*3`, `file_name.py`, `a_b`: the delimiter touches ASCII word characters on both sides, so it
 * is arithmetic/an identifier rather than emphasis.
 */
function isIntraword(source, index, length) {
  return isAsciiWord(source[index - 1]) && isAsciiWord(source[index + length]);
}

function canOpenAt(source, index, length) {
  const next = source[index + length];
  if (next === undefined || /\s/u.test(next)) return false;
  return !isIntraword(source, index, length);
}

/**
 * Whether an opener without a closer should make `looksUnbalanced` true. An `_` run directly in
 * front of a word is an identifier (`__init__.py`), not a half-typed emphasis.
 */
function reportUnclosed(char, source, index, width) {
  return char === '*' || !isAsciiWord(source[index + width]);
}

/** Index of the closing run of `` ` `` with exactly `length` characters, or -1. */
function findCodeEnd(source, from, length) {
  let i = from;
  while (i < source.length) {
    if (source[i] === '`') {
      const run = runLength(source, i, '`');
      if (run === length) return i;
      i += run;
      continue;
    }
    i += 1;
  }
  return -1;
}

/**
 * Index of a closing delimiter run of at least `length` copies of `char`, or -1. Code spans and
 * escapes are skipped so ``**a `x*y` b**`` closes on the right pair.
 */
function findCloser(source, from, char, length) {
  let i = from;
  while (i < source.length) {
    const current = source[i];
    if (current === '\\') {
      i += 2;
      continue;
    }
    if (current === '`') {
      const run = runLength(source, i, '`');
      const end = findCodeEnd(source, i + run, run);
      i = end === -1 ? i + run : end + run;
      continue;
    }
    if (current !== char) {
      i += 1;
      continue;
    }
    const run = runLength(source, i, char);
    // A closer must follow a non-space. `*` may close before a letter (`**a**b`), but `_` may
    // not, so `__init__.py` and `file_name.py` never lose their underscores.
    const wordSafe = char === '_' ? !isIntraword(source, i, run) : true;
    if (run >= length && !/\s/u.test(source[i - 1] ?? ' ') && wordSafe) return i;
    i += run;
  }
  return -1;
}

function trimCodeSpan(value) {
  if (value.length > 2 && value.startsWith(' ') && value.endsWith(' ') && value.trim().length > 0) {
    return value.slice(1, -1);
  }
  return value;
}

/** Code-span content: trim the padding, resolve escapes, then the result is protected verbatim. */
function codeSpanValue(raw) {
  return trimCodeSpan(raw).replace(/\\([\\`*_{}[\]()#+\-.!>~|])/gu, '$1');
}

function ensureEnd(text, punctuation) {
  if (text.length === 0) return text;
  return SENTENCE_END.test(text) ? text : `${text}${punctuation}`;
}

/** Common HTML entities; an unknown named entity keeps its name and loses only `&`/`;`. */
const ENTITY_NAMES = Object.freeze({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—',
  ndash: '–', times: '×', divide: '÷', copy: '©', reg: '®', middot: '·',
});

function decodeEntity(body) {
  if (body[0] === '#') {
    const code = body[1] === 'x' || body[1] === 'X'
      ? Number.parseInt(body.slice(2), 16)
      : Number.parseInt(body.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  }
  return ENTITY_NAMES[body.toLowerCase()] ?? body;
}

/**
 * Side table for literal regions. `protect` hides a string behind an opaque placeholder while a
 * lane is rendered; `restore` puts it back after `ensurePlain` has finished, adding no cleanup.
 * A placeholder that broke would be visible in the output, so tests assert none leaks.
 */
function createLiterals() {
  const values = [];
  return {
    protect(value) {
      if (typeof value !== 'string' || value.length === 0) return '';
      values.push(value);
      return `\u0000L${values.length - 1}\u0000`;
    },
    restore(text, lane) {
      return text.replace(LITERAL_PLACEHOLDER, (match, index) => {
        const value = values[Number(index)];
        if (value === undefined) return '';
        // Speech may drop a line break; every other character is restored untouched.
        return lane === 'speech' ? value.replace(/\n+/gu, ' ') : value;
      });
    },
  };
}

/** Hide one already-parsed literal from the rendered-text cleanup. */
function protectLiteral(options, value) {
  const literals = options && options.literals;
  return literals ? literals.protect(value) : value;
}

/* ---------------------------------------------------------------------------------------------
 * Inline parsing
 * ------------------------------------------------------------------------------------------- */

/** Index of the `]` matching the `[` at `from - 1`, or -1 when the label is not closed. */
function findBracketEnd(source, from) {
  let depth = 1;
  let i = from;
  while (i < source.length) {
    const char = source[i];
    if (char === '\\') {
      i += 2;
      continue;
    }
    if (char === '`') {
      const run = runLength(source, i, '`');
      const end = findCodeEnd(source, i + run, run);
      i = end === -1 ? i + run : end + run;
      continue;
    }
    if (char === '[') depth += 1;
    else if (char === ']') {
      depth -= 1;
      if (depth === 0) return i;
    } else if (char === '\n') return -1;
    i += 1;
  }
  return -1;
}

/** Index of the `)` matching the `(` at `from - 1`, or -1 while the target is still open. */
function findParenEnd(source, from) {
  let depth = 1;
  let quote = '';
  let i = from;
  while (i < source.length) {
    const char = source[i];
    if (char === '\\') {
      i += 2;
      continue;
    }
    if (quote.length > 0) {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0) return i;
    } else if (char === '\n') {
      return -1;
    }
    i += 1;
  }
  return -1;
}

function parseLinkTarget(raw) {
  const target = raw.trim();
  const angle = /^<([^>]*)>/u.exec(target);
  if (angle) return angle[1].trim();
  const first = /^(\S+)/u.exec(target);
  return first ? first[1] : '';
}

/**
 * Read `[label](target)` at `open` (the `[`). Returns `{kind:'link'}`, `{kind:'incomplete'}` when
 * the fragment clearly stops inside the link, or `{kind:'text'}` when this bracket is not a link
 * (an ordinary `[0]`, a reference link, …).
 */
function readInlineLink(source, open) {
  const close = findBracketEnd(source, open + 1);
  if (close === -1) return { kind: 'incomplete' };
  if (source[close + 1] !== '(') return { kind: 'text', close };
  const end = findParenEnd(source, close + 2);
  if (end === -1) return { kind: 'incomplete' };
  return {
    kind: 'link',
    label: source.slice(open + 1, close),
    url: parseLinkTarget(source.slice(close + 2, end)),
    end: end + 1,
  };
}

function readAutolink(source, index) {
  const end = source.indexOf('>', index + 1);
  if (end === -1) return null;
  const inner = source.slice(index + 1, end);
  if (/\s/u.test(inner)) return null;
  if (!/^(?:https?:\/\/|mailto:)/iu.test(inner)) return null;
  return { url: inner, end: end + 1 };
}

/**
 * Read an HTML tag/comment at `index` (the `<`). Tags are syntax, their text content is content:
 * the renderers drop the tag and keep what is written between tags. A lone `<` stays literal.
 */
function readHtmlTag(source, index) {
  const rest = source.slice(index);
  const comment = HTML_COMMENT.exec(rest);
  if (comment) return { kind: 'comment', end: index + comment[0].length, block: false };
  const decl = HTML_DECL.exec(rest);
  if (decl) return { kind: 'comment', end: index + decl[0].length, block: false };
  const tag = HTML_TAG.exec(rest);
  if (!tag) return null;
  const name = tag[2].toLowerCase();
  return { kind: 'tag', name, block: BLOCK_HTML.has(name), end: index + tag[0].length };
}

/** A raw URL in prose. Speech drops it by default; captions keep it. */
function readBareUrl(source, index) {
  if (index > 0 && isAsciiWord(source[index - 1])) return null;
  const match = BARE_URL.exec(source.slice(index));
  if (!match) return null;
  let url = match[0];
  url = url.replace(/[.,;:!?…，。；：！？、]+$/u, '');
  for (let guard = 0; guard < 8; guard += 1) {
    const last = url.at(-1);
    if (last === ')' && countOf(url, '(') < countOf(url, ')')) {
      url = url.slice(0, -1);
      continue;
    }
    if (last === ']' && countOf(url, '[') < countOf(url, ']')) {
      url = url.slice(0, -1);
      continue;
    }
    if (last === '}' && countOf(url, '{') < countOf(url, '}')) {
      url = url.slice(0, -1);
      continue;
    }
    break;
  }
  if (url.length < 8) return null;
  return { url, end: index + url.length };
}

/**
 * Tokenize inline Markdown. Every marker is removed only together with its counterpart; an
 * unmatched delimiter stays literal text and is reported in `issues`.
 *
 * Token types: `text`, `code`, `url`, `link` (label/url/image), `strong`, `em`.
 */
function scanInline(source, issues) {
  const tokens = [];
  let text = '';
  let i = 0;

  const flush = () => {
    if (text.length === 0) return;
    tokens.push({ type: 'text', value: text });
    text = '';
  };

  while (i < source.length) {
    const char = source[i];

    if (char === '\\') {
      const next = source[i + 1];
      if (next !== undefined && ESCAPABLE.has(next)) {
        flush();
        tokens.push({ type: 'literal', value: next });
        i += 2;
        continue;
      }
      text += char;
      i += 1;
      continue;
    }

    if (char === '`') {
      const run = runLength(source, i, '`');
      const end = findCodeEnd(source, i + run, run);
      if (end === -1) {
        issues.push('code-span');
        text += '`'.repeat(run);
        i += run;
        continue;
      }
      flush();
      // A backslash escape (notably the `\|` used inside a table cell) is resolved before the
      // result is protected, exactly as the rendered fallback used to read it.
      tokens.push({ type: 'code', value: codeSpanValue(source.slice(i + run, end)) });
      i = end + run;
      continue;
    }

    if (char === '[' || (char === '!' && source[i + 1] === '[')) {
      const open = char === '!' ? i + 1 : i;

      // A footnote reference `[^1]` is a marker without words of its own.
      if (char === '[' && source[i + 1] === '^') {
        const footnoteEnd = findBracketEnd(source, i + 1);
        if (footnoteEnd !== -1) {
          i = footnoteEnd + 1;
          continue;
        }
      }

      const link = readInlineLink(source, open);
      if (link.kind === 'link') {
        flush();
        tokens.push({
          type: 'link',
          label: scanInline(link.label, issues).tokens,
          url: link.url,
          image: char === '!',
        });
        i = link.end;
        continue;
      }
      if (link.kind === 'incomplete') {
        // Keep the rest verbatim: there is no valid boundary inside an unfinished link target.
        issues.push('link');
        text += source.slice(i);
        i = source.length;
        continue;
      }
      // Reference link `[text][ref]` / image `![alt][ref]`: the label is text, the id is syntax.
      const refEnd = link.close !== undefined && source[link.close + 1] === '['
        ? findBracketEnd(source, link.close + 2)
        : -1;
      if (refEnd !== -1) {
        flush();
        tokens.push({
          type: 'link',
          label: scanInline(source.slice(open + 1, link.close), issues).tokens,
          url: '',
          image: char === '!',
        });
        i = refEnd + 1;
        continue;
      }
      // A callout label `[!NOTE]` is metadata the surrounding block already names.
      if (source[open + 1] === '!') {
        i = link.close + 1;
        continue;
      }
      text += char;
      i += 1;
      continue;
    }

    if (char === '<') {
      const autolink = readAutolink(source, i);
      if (autolink) {
        flush();
        tokens.push({ type: 'url', value: autolink.url });
        i = autolink.end;
        continue;
      }
      const html = readHtmlTag(source, i);
      if (html) {
        if (html.kind === 'tag' && html.block) {
          flush();
          tokens.push({ type: 'text', value: '\n' });
        }
        i = html.end;
        continue;
      }
      text += char;
      i += 1;
      continue;
    }

    if (char === '~') {
      const run = runLength(source, i, '~');
      if (run < 2) {
        text += char;
        i += 1;
        continue;
      }
      if (!canOpenAt(source, i, 2)) {
        text += '~~';
        i += 2;
        continue;
      }
      const end = findCloser(source, i + 2, '~', 2);
      if (end === -1) {
        if (reportUnclosed('~', source, i, 2)) issues.push('del');
        text += '~~';
        i += 2;
        continue;
      }
      flush();
      tokens.push({ type: 'del', children: scanInline(source.slice(i + 2, end), issues).tokens });
      i = end + 2;
      continue;
    }

    if (char === '*' || char === '_') {
      const run = runLength(source, i, char);
      const width = run >= 3 ? 3 : run;
      if (width > 1) {
        if (!canOpenAt(source, i, width)) {
          text += char.repeat(width);
          i += width;
          continue;
        }
        const end = findCloser(source, i + width, char, width);
        if (end === -1) {
          if (reportUnclosed(char, source, i, width)) issues.push('strong');
          text += char.repeat(width);
          i += width;
          continue;
        }
        flush();
        tokens.push({
          type: width > 2 ? 'em' : 'strong',
          children: scanInline(source.slice(i + width, end), issues).tokens,
        });
        i = end + width;
        continue;
      }
      if (!canOpenAt(source, i, 1)) {
        text += char;
        i += 1;
        continue;
      }
      const end = findCloser(source, i + 1, char, 1);
      if (end === -1) {
        if (reportUnclosed(char, source, i, 1)) issues.push('em');
        text += char;
        i += 1;
        continue;
      }
      flush();
      tokens.push({ type: 'em', children: scanInline(source.slice(i + 1, end), issues).tokens });
      i = end + 1;
      continue;
    }

    if (char === '&') {
      const entity = ENTITY.exec(source.slice(i));
      if (entity) {
        text += decodeEntity(entity[1]);
        i += entity[0].length;
        continue;
      }
    }

    // `^上标^` is not Markdown either: the carets are markers, the words are content.
    if (char === '^') {
      const end = source.indexOf('^', i + 1);
      const inner = end === -1 ? '' : source.slice(i + 1, end);
      if (inner.length > 0 && !/\s/u.test(inner)) {
        text += inner;
        i = end + 1;
        continue;
      }
    }

    if (char === 'h' || char === 'H') {
      const url = readBareUrl(source, i);
      if (url) {
        flush();
        tokens.push({ type: 'url', value: url.url });
        i = url.end;
        continue;
      }
    }

    text += char;
    i += 1;
  }

  flush();
  return { tokens };
}

/* ---------------------------------------------------------------------------------------------
 * Block parsing
 * ------------------------------------------------------------------------------------------- */

function isOrderedMarker(marker) {
  return /^\d/u.test(marker);
}

function splitTableRow(line) {
  const cells = [];
  let current = '';
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '\\' && line[i + 1] === '|') {
      current += '\\|';
      i += 1;
      continue;
    }
    if (char === '|') {
      cells.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current);
  let normalized = cells.map((cell) => cell.trim());
  if (normalized.length > 1 && normalized[0] === '') normalized = normalized.slice(1);
  if (normalized.length > 1 && normalized[normalized.length - 1] === '') normalized = normalized.slice(0, -1);
  return normalized;
}

function isTableDelimiter(line) {
  if (typeof line !== 'string' || !line.includes('|')) return false;
  const cells = splitTableRow(line);
  if (cells.length === 0) return false;
  return cells.every((cell) => /^:?-+:?$/u.test(cell));
}

/** Number of unescaped `|` characters in one line (a `\|` is content, not a cell border). */
function tablePipeCount(line) {
  let count = 0;
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === '\\') {
      i += 1;
      continue;
    }
    if (line[i] === '|') count += 1;
  }
  return count;
}

/**
 * A pipe row whose outer border is present (`| a | b |`, `a | b |`, `| a | b`). Prose that merely
 * contains one `|` is not a table, so a streamed table fragment is still cleaned as a table.
 */
function looksLikeTableRow(line) {
  const trimmed = line.trim();
  if (trimmed.length === 0 || tablePipeCount(trimmed) < 2) return false;
  if (isTableDelimiter(line)) return false;
  return trimmed.startsWith('|') || trimmed.endsWith('|');
}

function isTableStart(lines, index) {
  if (tablePipeCount(lines[index]) === 0) return false;
  if (index + 1 < lines.length && isTableDelimiter(lines[index + 1])) return true;
  return looksLikeTableRow(lines[index]);
}

function startsBlock(lines, index) {
  const line = lines[index];
  if (FENCE_OPEN.test(line) || HEADING.test(line) || THEMATIC.test(line) || QUOTE.test(line)) return true;
  if (LIST_ITEM.test(line)) return true;
  if (CALLOUT.test(line) || FOOTNOTE_DEF.test(line) || REF_DEF.test(line)) return true;
  if (DEF_MARKER.test(line)) return true;
  // An indented line starts a code block only after a blank line; otherwise it is a continuation.
  if (INDENT_CODE.test(line)) return index > 0 && lines[index - 1].trim().length === 0;
  return isTableStart(lines, index);
}

function readTable(lines, index, issues) {
  if (!isTableStart(lines, index)) return null;
  const header = splitTableRow(lines[index]);
  const rows = [];
  let j = index + 1;
  if (j < lines.length && isTableDelimiter(lines[j])) j += 1;
  while (j < lines.length) {
    const line = lines[j];
    if (line.trim().length === 0 || tablePipeCount(line) === 0) break;
    if (FENCE_OPEN.test(line) || HEADING.test(line) || QUOTE.test(line) || isTableDelimiter(line)) break;
    rows.push(splitTableRow(line));
    j += 1;
  }
  return {
    block: {
      type: 'table',
      header: header.map((cell) => scanInline(cell, issues).tokens),
      rows: rows.map((row) => row.map((cell) => scanInline(cell, issues).tokens)),
    },
    next: j,
  };
}

/** Parse a list of lines into block nodes; `issues` collects the unbalanced-fragment reasons. */
function parseBlocks(lines, issues) {
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().length === 0) {
      i += 1;
      continue;
    }

    const fence = FENCE_OPEN.exec(line);
    if (fence) {
      const marker = fence[1][0];
      const length = fence[1].length;
      const info = fence[2].trim();
      const content = [];
      let j = i + 1;
      let closed = false;
      while (j < lines.length) {
        const closing = FENCE_CLOSE.exec(lines[j]);
        if (closing && closing[1][0] === marker && closing[1].length >= length) {
          closed = true;
          break;
        }
        content.push(lines[j]);
        j += 1;
      }
      if (!closed) issues.push('fence');
      blocks.push({ type: 'code', lang: info.split(/\s+/u)[0] ?? '', info, lines: content });
      i = closed ? j + 1 : j;
      continue;
    }

    // Unknown block syntax degrades to plain text: the marker is dropped, the words are kept.
    if (CALLOUT.test(line)) {
      i += 1;
      continue;
    }
    const footnoteDef = FOOTNOTE_DEF.exec(line);
    if (footnoteDef) {
      blocks.push({ type: 'paragraph', inline: scanInline(footnoteDef[2], issues).tokens });
      i += 1;
      continue;
    }
    if (REF_DEF.test(line)) {
      i += 1;
      continue;
    }
    const definition = DEF_MARKER.exec(line);
    if (definition) {
      blocks.push({ type: 'paragraph', inline: scanInline(definition[1], issues).tokens });
      i += 1;
      continue;
    }
    // Indented code is code only when a blank line separates it from the preceding block;
    // otherwise the paragraph collector keeps the indented line as ordinary prose.
    if (INDENT_CODE.test(line) && (i === 0 || lines[i - 1].trim().length === 0)) {
      const indented = [];
      let j = i;
      while (j < lines.length) {
        if (INDENT_CODE.test(lines[j])) {
          indented.push(INDENT_CODE.exec(lines[j])[1]);
          j += 1;
          continue;
        }
        // A blank line inside the block is content, but only when code follows it.
        if (lines[j].trim().length === 0 && j + 1 < lines.length && INDENT_CODE.test(lines[j + 1])) {
          indented.push('');
          j += 1;
          continue;
        }
        break;
      }
      blocks.push({ type: 'code', lang: '', info: '', lines: indented });
      i = j;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const content = (heading[2] ?? '').replace(/[ \t]+#+[ \t]*$/u, '').trim();
      blocks.push({ type: 'heading', level: heading[1].length, inline: scanInline(content, issues).tokens });
      i += 1;
      continue;
    }

    if (THEMATIC.test(line)) {
      blocks.push({ type: 'hr' });
      i += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const inner = [];
      let j = i;
      while (j < lines.length) {
        const current = lines[j];
        if (QUOTE.test(current)) {
          inner.push(current.replace(/^ {0,3}>[ \t]?/u, ''));
          j += 1;
          continue;
        }
        if (current.trim().length === 0) break;
        inner.push(current);
        j += 1;
      }
      blocks.push({ type: 'quote', blocks: parseBlocks(inner, issues) });
      i = j;
      continue;
    }

    const first = LIST_ITEM.exec(line);
    if (first) {
      const items = [];
      let j = i;
      while (j < lines.length) {
        const current = LIST_ITEM.exec(lines[j]);
        if (!current) {
          if (/^\s*$/u.test(lines[j]) && j + 1 < lines.length && LIST_ITEM.test(lines[j + 1])) {
            j += 1;
            continue;
          }
          break;
        }
        items.push({
          marker: current[1],
          ordered: isOrderedMarker(current[1]),
          inline: scanInline(current[3].replace(TASK_BOX, ''), issues).tokens,
        });
        j += 1;
      }
      blocks.push({ type: 'list', ordered: isOrderedMarker(first[1]), items });
      i = j;
      continue;
    }

    // A separator row on its own is table syntax with no content: drop it entirely.
    if (isTableDelimiter(line)) {
      i += 1;
      continue;
    }

    const table = readTable(lines, i, issues);
    if (table) {
      blocks.push(table.block);
      i = table.next;
      continue;
    }

    const collected = [line];
    let j = i + 1;
    let setext = 0;
    while (j < lines.length) {
      if (lines[j].trim().length === 0) break;
      if (SETEXT.test(lines[j])) {
        setext = lines[j].trim()[0] === '=' ? 1 : 2;
        break;
      }
      if (startsBlock(lines, j)) break;
      collected.push(lines[j]);
      j += 1;
    }
    if (setext > 0) {
      blocks.push({ type: 'heading', level: setext, inline: scanInline(collected.join(' '), issues).tokens });
      i = j + 1;
      continue;
    }
    blocks.push({ type: 'paragraph', inline: scanInline(collected.join('\n'), issues).tokens });
    i = j;
  }

  return blocks;
}

function analyze(markdown) {
  const source = typeof markdown === 'string' ? markdown : '';
  const lines = source.replace(/\r\n?/gu, '\n').split('\n');
  const issues = [];
  const blocks = parseBlocks(lines, issues);
  return { blocks, issues };
}

/* ---------------------------------------------------------------------------------------------
 * Speech rendering
 * ------------------------------------------------------------------------------------------- */

function plainInline(tokens, options = {}) {
  let out = '';
  for (const token of tokens) {
    if (token.type === 'text' || token.type === 'url') out += token.value;
    else if (token.type === 'code' || token.type === 'literal') out += protectLiteral(options, token.value);
    else if (token.type === 'link') out += plainInline(token.label, options);
    else if (token.type === 'strong' || token.type === 'em' || token.type === 'del') out += plainInline(token.children, options);
  }
  return out;
}

function speechInline(tokens, options) {
  let out = '';
  for (const token of tokens) {
    if (token.type === 'text') {
      out += token.value;
    } else if (token.type === 'code' || token.type === 'literal') {
      out += protectLiteral(options, token.value);
    } else if (token.type === 'url') {
      if (options.links === 'read-url') out += token.value;
    } else if (token.type === 'link') {
      out += speechInline(token.label, options);
      if (options.links === 'read-url' && token.image !== true && token.url.length > 0) {
        out += `（${token.url}）`;
      }
    } else if (token.type === 'strong' || token.type === 'em' || token.type === 'del') {
      out += speechInline(token.children, options);
    }
  }
  return out;
}

function speechCode(block, options) {
  if (options.codeBlocks !== 'read-first-line') return '';
  const first = block.lines.find((line) => line.trim().length > 0);
  return first === undefined ? '' : protectLiteral(options, first.trim());
}

function speechList(block, options) {
  const items = block.items
    .map((item) => speechInline(item.inline, options).trim())
    .filter((item) => item.length > 0);
  if (items.length === 0) return '';
  let out = items[0];
  for (const item of items.slice(1)) {
    out += SOFT_END.test(out) ? item : `；${item}`;
  }
  return ensureEnd(out, '。');
}

function speechTable(block, options) {
  const header = block.header.map((cell) => speechInline(cell, options).trim());
  if (options.tableMode === 'plain') {
    const plain = block.rows
      .map((row) => row.map((cell) => speechInline(cell, options).trim()).filter(Boolean).join('；'))
      .filter(Boolean);
    return (plain.length > 0 ? plain : [header.filter(Boolean).join('；')]).join('\n');
  }
  const rows = block.rows
    .map((row) => row
      .map((cell, index) => {
        const value = speechInline(cell, options).trim();
        if (value.length === 0) return '';
        const label = header[index] && header[index].length > 0 ? header[index] : `第${index + 1}列`;
        return `${label}：${value}`;
      })
      .filter(Boolean)
      .join('；'))
    .filter(Boolean);
  // A header-only table (a streamed fragment, or a one-line pipe list) still has to be read.
  return (rows.length > 0 ? rows : [header.filter(Boolean).join('，')]).join('\n');
}

function speechBlock(block, options) {
  switch (block.type) {
    case 'heading': return ensureEnd(speechInline(block.inline, options).trim(), '。');
    case 'paragraph': return speechInline(block.inline, options).trim();
    case 'quote': return speechBlocks(block.blocks, options).join('\n');
    case 'list': return speechList(block, options);
    case 'code': return speechCode(block, options);
    case 'table': return speechTable(block, options);
    default: return '';
  }
}

function speechBlocks(blocks, options) {
  const parts = [];
  for (const block of blocks) {
    const text = speechBlock(block, options).trim();
    if (text.length === 0) continue;
    // A heading is a pause: the preceding sentence gets its closing punctuation if it had none.
    if (block.type === 'heading' && parts.length > 0 && !SENTENCE_END.test(parts[parts.length - 1])) {
      parts[parts.length - 1] = ensureEnd(parts[parts.length - 1], '。');
    }
    parts.push(text);
  }
  return parts;
}

function normalizeSpeech(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/gu, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n')
    .replace(/[ \t]+([，。！？；：、）】」』”’])/gu, '$1')
    .replace(/([（【「『“‘])[ \t]+/gu, '$1')
    .trim();
}

/* ---------------------------------------------------------------------------------------------
 * Caption rendering
 * ------------------------------------------------------------------------------------------- */

function captionInline(tokens, options) {
  let out = '';
  for (const token of tokens) {
    if (token.type === 'text' || token.type === 'url') {
      out += token.value;
    } else if (token.type === 'code' || token.type === 'literal') {
      out += protectLiteral(options, token.value);
    } else if (token.type === 'link') {
      out += captionInline(token.label, options);
      if (token.image !== true && options.links !== 'text-only' && token.url.length > 0) {
        out += `（${token.url}）`;
      }
    } else if (token.type === 'strong' || token.type === 'em' || token.type === 'del') {
      out += captionInline(token.children, options);
    }
  }
  return out;
}

function captionTable(block, options) {
  const rows = [block.header, ...block.rows];
  return rows
    .map((row) => row.map((cell) => captionInline(cell, options).trim()).filter(Boolean).join('，'))
    .filter((line) => line.length > 0)
    .join('\n');
}

function captionBlock(block, options) {
  switch (block.type) {
    case 'heading': return captionInline(block.inline, options).trim();
    case 'paragraph': return captionInline(block.inline, options).trim();
    case 'quote': return captionBlocks(block.blocks, options).join('\n');
    case 'list': return block.items
      .map((item) => captionInline(item.inline, options).trim())
      .filter(Boolean)
      .join('\n');
    case 'code': return protectLiteral(options, block.lines.join('\n').replace(/[ \t]+$/u, ''));
    case 'table': return captionTable(block, options);
    default: return '';
  }
}

function captionBlocks(blocks, options) {
  const parts = [];
  for (const block of blocks) {
    const text = captionBlock(block, options);
    if (text.trim().length > 0) parts.push(text);
  }
  return parts;
}

function normalizeCaption(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/u, ''))
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

/* ---------------------------------------------------------------------------------------------
 * Zero-Markdown guarantee — the last pass over every rendered lane
 * ------------------------------------------------------------------------------------------- */

const RESIDUAL_LOG_LIMIT = 20;
const residualLog = [];

/** `speech-text.residual` keeps at most 40 characters of the offending fragment. */
function residualSample(text, index, length) {
  return text
    .slice(index, index + Math.max(length, 40))
    .replace(LITERAL_PLACEHOLDER, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 40);
}

function recordResidual(kind, sample) {
  const last = residualLog[residualLog.length - 1];
  if (last && last.kind === kind && last.sample === sample) return;
  residualLog.push({ type: 'speech-text.residual', kind, sample: sample.slice(0, 40) });
  while (residualLog.length > RESIDUAL_LOG_LIMIT) residualLog.shift();
}

/**
 * Drain the residual events recorded since the previous call. The module itself never writes to
 * the host event log; a caller that has one can forward these rows as `log.emit(type, payload)`.
 *
 * @returns {{type: string, kind: string, sample: string}[]}
 */
export function takeResiduals() {
  return residualLog.splice(0);
}

/**
 * Structure classes the fallback looks for after rendering. Each rule is a *shape*, not a known
 * format: line-leading markers, paired delimiters, table borders, fences, tags, link brackets,
 * escapes and entities. A future Markdown extension that matches a shape is cleaned; one that
 * cannot be cleaned (an unmatched delimiter) is recorded instead of being dropped.
 */
const RESIDUAL_RULES = [
  ['fence', /^ {0,3}(?:`{3,}|~{3,})/gmu],
  ['heading', /^ {0,3}#{1,6}(?:[ \t]+|$)/gmu],
  ['quote', /^ {0,3}>/gmu],
  ['list', /^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+/gmu],
  ['table', /\|/gu],
  ['html', /<!--|<![^>]*>|<\/?[A-Za-z][A-Za-z0-9-]*(?:"[^"]*"|'[^']*'|[^<>"'])*\/?>/gu],
  ['autolink', /<https?:\/\/[^>\s]+>/giu],
  ['link', /!?\[[^\]\n]*\]\([^)\n]*\)/gu],
  ['reference', /\[[^\]\n]+\]\[[^\]\n]*\]/gu],
  ['footnote', /\[\^[^\]\n]+\]/gu],
  ['callout', /\[![A-Za-z][^\]]*\]/gu],
  ['entity', /&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/giu],
  ['escape', /\\[\\`*_{}[\]()#+\-.!>~|]/gu],
  ['code-span', /`+/gu],
  ['emphasis', /\*\*|__|~~|==/gu],
  ['superscript', /\^[^\s^]+\^/gu],
];

function scanResidual(text) {
  const hits = [];
  for (const [kind, pattern] of RESIDUAL_RULES) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      hits.push({ kind, sample: residualSample(text, match.index, match[0].length) });
      if (hits.length >= 12) return hits;
      if (match[0].length === 0) break;
    }
  }
  return hits;
}

/** One context-free cleanup pass: every known marker shape loses only its marker. */
function cleanLine(line) {
  let out = line;

  // Fences, underlines, horizontal rules and separator rows carry no words of their own.
  if (/^ {0,3}(?:`{3,}|~{3,})[^\n]*$/u.test(out)) return '';
  if (/^ {0,3}(?:=+|-{2,}|\*{2,}|_{2,})[ \t]*$/u.test(out)) return '';
  if (isTableDelimiter(out)) return '';

  // Indented code degrades to text: the indent is a marker, the line is content.
  out = out.replace(/^ {4}/u, '');

  const wasHeading = /^ {0,3}#{1,6}[ \t]+/u.test(out);
  out = out
    .replace(/^(?: {0,3}>[ \t]?)+/u, '')
    .replace(/^ {0,3}#{1,6}[ \t]+/u, '')
    .replace(/^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+/u, '')
    .replace(/^ {0,3}\[[ xX]\][ \t]+/u, '')
    .replace(/^ {0,3}\[\^[^\]]+\]:[ \t]*/u, '')
    .replace(/^ {0,3}\[[^\]]+\]:.*$/u, '')
    .replace(/^ {0,3}: [ \t]+/u, '')
    .replace(/^ {0,3}\[![A-Za-z][^\]]*\][ \t]*/u, '');
  if (wasHeading) out = out.replace(/[ \t]+#+[ \t]*$/u, '');

  // A table row keeps its cells and loses the borders/separator grammar. One pipe is prose
  // (the parser does not call it a table either), so `a | b` from a protected code span is safe.
  if (tablePipeCount(out) >= 2) {
    out = splitTableRow(out).map((cell) => cell.trim()).filter((cell) => cell.length > 0).join('，');
  }

  return out
    .replace(/<!--[\s\S]*?-->/gu, '')
    .replace(/<https?:\/\/[^>\s]+>/giu, (match) => match.slice(1, -1))
    .replace(/<![^>]*>/gu, '')
    .replace(/<\/?[A-Za-z][A-Za-z0-9-]*(?:"[^"]*"|'[^']*'|[^<>"'])*\/?>/gu, '')
    .replace(/!\[([^\]\n]*)\]\([^)\n]*\)/gu, '$1')
    .replace(/\[([^\]\n]*)\]\([^)\n]*\)/gu, '$1')
    .replace(/!\[([^\]\n]*)\]\[[^\]\n]*\]/gu, '$1')
    .replace(/\[([^\]\n]*)\]\[[^\]\n]*\]/gu, '$1')
    .replace(/\[\^[^\]\n]*\]/gu, '')
    .replace(/\[![A-Za-z][^\]]*\]/gu, '')
    .replace(/\[\[([^\]\n]*)\]\]/gu, '$1')
    .replace(/(`+)([^`]*?)\1/gu, (match, ticks, body) => (
      body.length > 2 && body.startsWith(' ') && body.endsWith(' ') ? body.slice(1, -1) : body
    ))
    .replace(/\*\*\*(.+?)\*\*\*/gu, '$1')
    .replace(/\*\*(.+?)\*\*/gu, '$1')
    .replace(/~~(.+?)~~/gu, '$1')
    .replace(/==(.+?)==/gu, '$1')
    .replace(/\^([^\s^]+)\^/gu, '$1')
    .replace(/(?<![0-9A-Za-z_])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![0-9A-Za-z_])/gu, '$1')
    .replace(/(?<![0-9A-Za-z_])__(?!\s)([^_\n]+?)(?<!\s)__(?![0-9A-Za-z_])/gu, '$1')
    .replace(/(?<![0-9A-Za-z_])_(?!\s)([^_\n]+?)(?<!\s)_(?![0-9A-Za-z_])/gu, '$1')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/giu, (match, body) => decodeEntity(body))
    .replace(/\\([\\`*_{}[\]()#+\-.!>~|])/gu, '$1');
}

function cleanOnePass(text) {
  const out = [];
  // Comments are removed across lines first, before the text is split for line-level markers.
  for (const line of text.replace(/<!--[\s\S]*?-->/gu, '').split('\n')) {
    const cleaned = cleanLine(line);
    // A line that existed only to hold syntax (`---`, a lone fence, `[!NOTE]`) disappears.
    if (cleaned.trim().length === 0 && line.trim().length > 0) continue;
    out.push(cleaned);
  }
  return out.join('\n');
}

/**
 * Remove every Markdown control shape from an already-rendered string, whatever produced it.
 *
 * The cleanup repeats until a pass changes nothing, which also makes the function idempotent.
 * Text the cleaner cannot remove without guessing (an unmatched `**`, an open fence) is kept
 * verbatim and reported through `speech-text.residual`; it is visible, never silent.
 *
 * @param {string} text
 * @param {{lane?: 'speech'|'caption', literals?: {restore: Function}}} [options]
 *   `speech` also drops blank lines; `literals` is the internal side table restored last
 * @returns {string}
 */
export function ensurePlain(text, options = {}) {
  const settings = options && typeof options === 'object' ? options : {};
  const literals = settings.literals;
  let out = typeof text === 'string' ? text : '';
  for (let pass = 0; pass < 8; pass += 1) {
    const next = cleanOnePass(out);
    if (next === out) break;
    out = next;
  }
  // Placeholders carry no Markdown shape, so leftover markers are found outside them only.
  for (const hit of scanResidual(out)) recordResidual(hit.kind, hit.sample);
  const lane = settings.lane;
  const normalized = lane === 'speech'
    ? out.split('\n').map((line) => line.replace(/[ \t]+/gu, ' ').trim()).filter(Boolean).join('\n').trim()
    : out.split('\n').map((line) => line.replace(/[ \t]+$/u, '')).join('\n').replace(/\n{3,}/gu, '\n\n').trim();
  // The literal side table is restored last, character for character (speech may drop line breaks).
  return literals && typeof literals.restore === 'function' ? literals.restore(normalized, lane) : normalized;
}

/* ---------------------------------------------------------------------------------------------
 * Public API
 * ------------------------------------------------------------------------------------------- */

function isDocument(value) {
  return Boolean(value) && typeof value === 'object' && Array.isArray(value.blocks);
}

function documentFor(input, options) {
  if (isDocument(input)) return input;
  const parseImpl = typeof options.parse === 'function' ? options.parse : parse;
  const document = parseImpl(typeof input === 'string' ? input : '');
  return isDocument(document) ? document : { blocks: [] };
}

/**
 * Parse Markdown once into block/inline nodes. Unmatched markers stay literal text.
 * @param {string} markdown
 * @returns {{blocks: object[]}}
 */
export function parse(markdown) {
  return { blocks: analyze(markdown).blocks };
}

/**
 * Render the spoken form of a Markdown fragment.
 *
 * `markdown` may also be a document returned by `parse`, so a caller that renders speech and
 * captions for the same fragment can parse once and pass the tree to both renderers.
 *
 * @param {string|{blocks: object[]}} markdown
 * @param {{tableMode?: 'ordered'|'plain', codeBlocks?: 'skip'|'read-first-line',
 *          links?: 'text-only'|'read-url', parse?: Function}} [options]
 * @returns {string} plain text for TTS: no Markdown markers, no code fences, no blank lines
 */
export function toSpeechText(markdown, options = {}) {
  const literals = createLiterals();
  const settings = { ...SPEECH_DEFAULTS, ...(options && typeof options === 'object' ? options : {}), literals };
  const rendered = normalizeSpeech(speechBlocks(documentFor(markdown, settings).blocks, settings).join('\n'));
  return ensurePlain(rendered, { lane: 'speech', literals });
}

/**
 * Render the subtitle form of a Markdown fragment: plain text that keeps line structure.
 *
 * @param {string|{blocks: object[]}} markdown
 * @param {{links?: 'with-url'|'text-only', parse?: Function}} [options]
 * @returns {string}
 */
export function toCaptionText(markdown, options = {}) {
  const literals = createLiterals();
  const settings = { ...CAPTION_DEFAULTS, ...(options && typeof options === 'object' ? options : {}), literals };
  const parts = captionBlocks(documentFor(markdown, settings).blocks, settings);
  return ensurePlain(normalizeCaption(parts.join('\n\n')), { lane: 'caption', literals });
}

/**
 * Render both forms from one parse. Shared options go at the top level; `speech` and `caption`
 * override them per renderer. `options.parse` replaces the internal parser (test seam).
 *
 * @param {string} markdown
 * @param {{tableMode?: string, codeBlocks?: string, links?: string,
 *          speech?: object, caption?: object, parse?: Function}} [options]
 * @returns {{speech: string, caption: string}}
 */
export function formatMessage(markdown, options = {}) {
  const shared = {};
  for (const key of SHARED_KEYS) {
    if (options && typeof options === 'object' && options[key] !== undefined) shared[key] = options[key];
  }
  const literals = createLiterals();
  const speechOptions = {
    ...SPEECH_DEFAULTS,
    ...shared,
    ...(options && typeof options.speech === 'object' && options.speech !== null ? options.speech : {}),
    literals,
  };
  const captionOptions = {
    ...CAPTION_DEFAULTS,
    ...shared,
    ...(options && typeof options.caption === 'object' && options.caption !== null ? options.caption : {}),
    literals,
  };
  const document = documentFor(markdown, options);
  return {
    speech: ensurePlain(normalizeSpeech(speechBlocks(document.blocks, speechOptions).join('\n')), { lane: 'speech', literals }),
    caption: ensurePlain(normalizeCaption(captionBlocks(document.blocks, captionOptions).join('\n\n')), { lane: 'caption', literals }),
  };
}

/**
 * True when a fragment is not valid Markdown yet (an open fence, code span, link target, or an
 * unmatched `**`/`__`/`*`/`_` emphasis). The caller should then wait for the next streamed
 * fragment instead of cleaning this one.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function looksUnbalanced(text) {
  if (typeof text !== 'string' || text.trim().length === 0) return false;
  return analyze(text).issues.length > 0;
}
