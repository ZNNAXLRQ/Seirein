/**
 * Call mode plus the address gate (phase 1a: pure logic, no Host wiring).
 *
 * Two independent pieces live here:
 *
 *  - `createCallMode()` remembers normal/call mode. Entering call mode requires at least one
 *    enabled assistant name; nothing else changes the mode. Missing address evidence must not
 *    exit call mode, and a just-finished reply must not open an unaddressed window. The mode is
 *    runtime state only: every new instance starts in `normal`.
 *  - `detectAddress()` is the conservative v1 matcher. A name counts only at the start of a
 *    sentence (optionally after an interjection such as 那个/诶/喂). A name merely mentioned
 *    mid-sentence is not an address.
 *
 * `createSpeakerRegistry()` keeps identity by `speakerId`; names are display-only aliases.
 * Assistant names and user self-names share one namespace, so duplicates are rejected across
 * both classes. No file, network, timer or Host access: importing this module has no side
 * effects.
 */

/** Characters that end a sentence, so the next non-space position is a candidate sentence start. */
const SENTENCE_END = new Set(['。', '！', '？', '!', '?', '…', '\n', '\r', '.']);

/** Punctuation/space skipped before a name (and after an interjection). */
const LEADING_SKIP = /[\s,，.。!！?？:：;；、…—~～"'“”‘’「」『』（）()【】\[\]{}<>《》]/u;

/** ASCII word characters: an English name must not touch one of these on either side. */
const WORD_CHAR = /[A-Za-z0-9_]/;

/** Diminutive/persona suffixes that turn a bare name into a different, longer name (小满子). */
const NAME_SUFFIX = /^(?:子|儿|仔|酱|君|桑)/;

/** Marker for "the name starts here but its word boundary fails". */
const BOUNDARY_BLOCKED = Symbol('word-boundary');

/** Leading interjections that may precede an address without making it a mid-sentence mention. */
const ADDRESS_FILLERS = [
  '那个',
  '我说',
  '哎呀',
  '哈喽',
  '诶',
  '欸',
  '喂',
  '哎',
  '唉',
  '嗯',
  '呃',
  '啊',
  '哦',
  '噢',
  '嘿',
  '嗨',
]
  .map((value) => value.normalize('NFKC').toLowerCase())
  .sort((left, right) => right.length - left.length);

/** Accept either a clock function or a fixed timestamp; both are handy in pure tests. */
function clockOf(now) {
  if (typeof now === 'function') return now;
  if (typeof now === 'number' && Number.isFinite(now)) return () => now;
  return Date.now;
}

/** Case- and width-insensitive key. Names are compared only through this key. */
function fold(value) {
  return String(value).normalize('NFKC').toLowerCase();
}

/**
 * Fold a text while keeping a normalized-index -> original-index map, so a hit still points at
 * the caller's original string even when NFKC expands a character.
 */
function foldWithMap(value) {
  let text = '';
  const indexMap = [];
  for (let index = 0; index < value.length; ) {
    const codePoint = value.codePointAt(index);
    const character = String.fromCodePoint(codePoint);
    const folded = fold(character);
    for (let offset = 0; offset < folded.length; offset += 1) indexMap.push(index);
    text += folded;
    index += character.length;
  }
  return { text, indexMap };
}

/** Trim, drop blanks/non-strings and dedupe by folded key, keeping the first display form. */
function cleanNames(names) {
  const list = Array.isArray(names) ? names : [];
  const seen = new Set();
  const cleaned = [];
  for (const value of list) {
    if (typeof value !== 'string') continue;
    const name = value.trim();
    if (name.length === 0) continue;
    const key = fold(name);
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    cleaned.push({ name, key });
  }
  return cleaned;
}

function sentenceStarts(text) {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (SENTENCE_END.has(text[index])) starts.push(index + 1);
  }
  return starts;
}

function skipLeading(text, start) {
  let cursor = start;
  while (cursor < text.length && LEADING_SKIP.test(text[cursor])) cursor += 1;
  return cursor;
}

/** Longest enabled name wins, so "小满老师" is not read as "小满" when both are enabled. */
function matchNameAt(text, start, candidates) {
  let blocked = null;
  for (const candidate of candidates) {
    if (!text.startsWith(candidate.key, start)) continue;
    const end = start + candidate.key.length;
    // Latin-first names need ASCII word boundaries; CJK-first names keep sentence-start matching,
    // but must not swallow a bare name extended by a diminutive suffix (小满子).
    const bounded = WORD_CHAR.test(candidate.key[0])
      ? !WORD_CHAR.test(text[start - 1] ?? '') && !WORD_CHAR.test(text[end] ?? '')
      : !NAME_SUFFIX.test(text.slice(end));
    if (!bounded) {
      blocked = BOUNDARY_BLOCKED;
      continue;
    }
    return { name: candidate.name, index: start };
  }
  return blocked;
}

function matchAddressAt(text, start, candidates) {
  let cursor = skipLeading(text, start);
  while (cursor < text.length) {
    const hit = matchNameAt(text, cursor, candidates);
    if (hit === BOUNDARY_BLOCKED || hit !== null) return hit;
    const filler = ADDRESS_FILLERS.find((value) => text.startsWith(value, cursor));
    if (filler === undefined) return null;
    cursor = skipLeading(text, cursor + filler.length);
  }
  return null;
}

/**
 * Conservative address detection.
 *
 * Accepted: a name at a sentence start, possibly after 那个/诶/喂-style interjections and
 * punctuation (so "小满，在吗", "那个小满在吗", "今天下雨。小满，在吗" all count).
 * Rejected: a name that only appears inside the sentence ("今天和小满说了"), blank text and an
 * empty enabled-name list. A Latin-first name also needs whole-word boundaries, so "Sei" does
 * not match "Seize"; a CJK-first name is not matched when a diminutive suffix extends it.
 *
 * @param {string} text
 * @param {string[]} names - enabled assistant names
 * @returns {{addressed: true, name: string, index: number}|{addressed: false, reason: string}}
 */
export function detectAddress(text, names = []) {
  const source = typeof text === 'string' ? text : '';
  const folded = foldWithMap(source);
  if (folded.text.trim().length === 0) return { addressed: false, reason: 'empty-text' };

  const candidates = cleanNames(names).sort((left, right) => right.key.length - left.key.length);
  if (candidates.length === 0) return { addressed: false, reason: 'no-address-name' };

  let boundaryBlocked = false;
  for (const start of sentenceStarts(folded.text)) {
    const hit = matchAddressAt(folded.text, start, candidates);
    if (hit === BOUNDARY_BLOCKED) {
      boundaryBlocked = true;
      continue;
    }
    if (hit !== null) {
      return {
        addressed: true,
        name: hit.name,
        index: folded.indexMap[hit.index] ?? hit.index,
      };
    }
  }

  if (boundaryBlocked) return { addressed: false, reason: 'word-boundary' };
  const mentioned = candidates.some((candidate) => folded.text.includes(candidate.key));
  return { addressed: false, reason: mentioned ? 'name-not-at-sentence-start' : 'name-not-present' };
}

/**
 * Runtime mode switch. Defaults to normal and never persists across instances.
 *
 * @param {{names?: string[], now?: (() => number)|number}} [options]
 */
export function createCallMode({ names = [], now = Date.now } = {}) {
  const clock = clockOf(now);
  const enabledNames = cleanNames(names).map((entry) => entry.name);
  let mode = 'normal';
  let enteredAt = null;

  return {
    get mode() {
      return mode;
    },

    /** Entering call mode requires an enabled address name. Re-entry keeps the original time. */
    enter() {
      if (enabledNames.length === 0) {
        return { ok: false, mode, reason: 'no-address-name' };
      }
      if (mode !== 'call') {
        mode = 'call';
        enteredAt = clock();
      }
      return { ok: true, mode: 'call' };
    },

    /** Only an explicit exit returns to normal; nothing here reacts to address detection. */
    exit() {
      mode = 'normal';
      enteredAt = null;
      return { mode: 'normal' };
    },

    status() {
      return { mode, names: [...enabledNames], enteredAt };
    },
  };
}

/**
 * In-memory speaker registry. `speakerId` is the identity; aliases are display labels only.
 * Assistant names (`assistantNames`) and user self-names share the duplicate-name namespace.
 *
 * @param {{now?: (() => number)|number, assistantNames?: string[]}} [options]
 */
export function createSpeakerRegistry({ now = Date.now, assistantNames = [] } = {}) {
  const clock = clockOf(now);
  const speakers = new Map();
  let nextOrdinal = 1;
  let assistant = { list: [] };

  function labelOf(record) {
    return record.names.length > 0 ? record.names[0].name : `说话人 ${record.ordinal}`;
  }

  function viewSpeaker(record) {
    return {
      speakerId: record.speakerId,
      names: record.names.map((entry) => entry.name),
      ordinal: record.ordinal,
      label: labelOf(record),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  function speakerConflict(key) {
    for (const record of speakers.values()) {
      const hit = record.names.find((entry) => entry.key === key);
      if (hit !== undefined) {
        return {
          kind: 'speaker',
          speakerId: record.speakerId,
          name: hit.name,
          label: labelOf(record),
        };
      }
    }
    return null;
  }

  /**
   * Cross-class lookup: assistant name first, then every user self-name.
   * Returns null when the name is free (or blank).
   *
   * @param {string} name
   * @param {{exceptSpeakerId?: string}} [options]
   */
  function findConflict(name, { exceptSpeakerId } = {}) {
    if (typeof name !== 'string') return null;
    const key = fold(name.trim());
    if (key.length === 0) return null;

    const assistantHit = assistant.list.find((entry) => entry.key === key);
    if (assistantHit !== undefined) return { kind: 'assistant', name: assistantHit.name };

    for (const record of speakers.values()) {
      if (record.speakerId === exceptSpeakerId) continue;
      const hit = record.names.find((entry) => entry.key === key);
      if (hit !== undefined) {
        return {
          kind: 'speaker',
          speakerId: record.speakerId,
          name: hit.name,
          label: labelOf(record),
        };
      }
    }
    return null;
  }

  /**
   * Replace the enabled assistant names used for duplicate checks. A name already used by a
   * registered speaker is rejected, so the registry and the call-mode name list cannot drift.
   */
  function setAssistantNames(names) {
    const cleaned = cleanNames(names);
    for (const entry of cleaned) {
      const conflict = speakerConflict(entry.key);
      if (conflict !== null) {
        return { ok: false, reason: 'duplicate-name', name: entry.name, conflict };
      }
    }
    assistant = { list: cleaned };
    return { ok: true, names: cleaned.map((entry) => entry.name) };
  }

  // The constructor's assistant names are initial state, not a conflict source (registry is empty).
  setAssistantNames(assistantNames);

  return {
    /** Register one speaker. `speakerId` is stable even when all names change. */
    addSpeaker({ speakerId, names } = {}) {
      const id = typeof speakerId === 'string' ? speakerId.trim() : '';
      if (id.length === 0) return { ok: false, reason: 'speaker-id-required' };
      if (speakers.has(id)) return { ok: false, reason: 'duplicate-speaker' };

      const cleaned = cleanNames(names);
      for (const entry of cleaned) {
        const conflict = findConflict(entry.name);
        if (conflict !== null) {
          return { ok: false, reason: 'duplicate-name', name: entry.name, conflict };
        }
      }

      const record = {
        speakerId: id,
        names: cleaned,
        ordinal: nextOrdinal,
        createdAt: clock(),
        updatedAt: clock(),
      };
      nextOrdinal += 1;
      speakers.set(id, record);
      return { ok: true, speaker: viewSpeaker(record) };
    },

    /** Replace aliases only; the speakerId and its ordinal (default label number) stay. */
    rename(speakerId, names) {
      const record = speakers.get(speakerId);
      if (record === undefined) return { ok: false, reason: 'unknown-speaker' };

      const cleaned = cleanNames(names);
      for (const entry of cleaned) {
        const conflict = findConflict(entry.name, { exceptSpeakerId: speakerId });
        if (conflict !== null) {
          return { ok: false, reason: 'duplicate-name', name: entry.name, conflict };
        }
      }

      record.names = cleaned;
      record.updatedAt = clock();
      return { ok: true };
    },

    list() {
      return [...speakers.values()].map(viewSpeaker);
    },

    get(speakerId) {
      const record = speakers.get(speakerId);
      return record === undefined ? null : viewSpeaker(record);
    },

    /** First alias, or the stable 「说话人 N」 label; null for an unknown speakerId. */
    defaultLabel(speakerId) {
      const record = speakers.get(speakerId);
      return record === undefined ? null : labelOf(record);
    },

    findConflict,

    /** Stage 1b hook: keep the duplicate namespace in sync when call names change at runtime. */
    setAssistantNames,
  };
}
