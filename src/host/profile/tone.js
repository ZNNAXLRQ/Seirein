/** tone — extracted from profileMaintain.js; no host entry dependency. */
import { cleanText } from './maintain-config.js';
import { parseJsonPayload } from './evidence.js';

/**
 * Tone rules (host-enforced, not prompt-only):
 *  - 助手人设: always second person 「你……」 — 「用户」 may never be the SUBJECT. When it is the
 *    object or an attributive (`你应尊重用户的隐私`, `用户的自述`) it is left exactly as written;
 *  - 用户画像: always third person 「用户……」 — 「我/我们/我的/咱/咱们」 is not allowed, but only as a
 *    PRONOUN: a 「我」 inside a word (`自我介绍` / `自我`) is never rewritten.
 * Quoted speech (`「…」`/`『…』`/`“…”`/`"…"`) is the user's own words: it is reported under
 * `quoted`, but it is never a violation and the repair/fallback steps keep it verbatim.
 * A case the host cannot classify safely is never rewritten — it is reported under `unresolved`
 * (event `profile.tone.unresolved`) and the sentence keeps its original meaning.
 */
export const PROFILE_TONE_FIRST_PERSON = Object.freeze(['咱们', '我们', '我的', '我', '咱']);


/** Third-person wording a persona must replace with 「你」 — only when it is the subject. */
export const PROFILE_TONE_USER_TOKEN = '用户';


const TONE_QUOTE_CLOSERS = Object.freeze({
  '「': '」',
  '『': '』',
  '“': '”',
  '"': '"',
  '‘': '’',
  "'": "'",
});


const TONE_SENTENCE_BREAKS = '。！？!?；;\n';


/** Per-character mask: true for every character inside a quoted span (delimiters included). */
function quotedMask(text) {
  const mask = new Array(text.length).fill(false);
  let closing = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (closing === null) {
      if (!Object.prototype.hasOwnProperty.call(TONE_QUOTE_CLOSERS, char)) continue;
      closing = TONE_QUOTE_CLOSERS[char];
      mask[index] = true;
      continue;
    }
    mask[index] = true;
    if (char === closing) closing = null;
  }
  return mask;
}


/** One sentence per piece, including its terminator/trailing whitespace, with absolute offsets. */
function toneSentences(text) {
  const pieces = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (!TONE_SENTENCE_BREAKS.includes(text[index])) continue;
    let end = index + 1;
    while (end < text.length && TONE_SENTENCE_BREAKS.includes(text[end])) end += 1;
    pieces.push({ text: text.slice(start, end), start, end });
    start = end;
    index = end - 1;
  }
  if (start < text.length) pieces.push({ text: text.slice(start), start, end: text.length });
  return pieces.filter((piece) => piece.text.trim().length > 0);
}


const insideQuote = (mask, start, length) => {
  for (let index = start; index < start + length; index += 1) {
    if (mask[index] === true) return true;
  }
  return false;
};


/**
 * Morphemes that form one fixed word with 「我」 (自我 / 自我介绍 / 忘我 / 敌我 / 尔虞我诈 …). A 「我」
 * directly behind one of them is part of the word, never a first-person pronoun: rewriting it used
 * to produce 「用户喜欢自介绍」.
 */
const FIRST_PERSON_COMPOUND_TAIL = new Set([
  '自', '忘', '敌', '唯', '无', '故', '真', '本', '小', '大', '虞', '死', '追', '卿', '尔',
]);


/**
 * The first-person pronoun starting at `at`, or null. Longest token wins (`我的` before `我`), and a
 * 「我」 that belongs to a compound word returns null: the boundary rule is what keeps
 * 「自我介绍」 intact.
 */
function firstPersonAt(text, at) {
  const token = PROFILE_TONE_FIRST_PERSON.find((candidate) => text.startsWith(candidate, at));
  if (token === undefined) return null;
  if (token.startsWith('我') && at > 0 && FIRST_PERSON_COMPOUND_TAIL.has(text[at - 1])) return null;
  return token;
}


/**
 * Classify one 「用户」 occurrence on the persona side.
 *   subject     — starts a clause and is not an attributive (`用户会撒娇`) → 「你」;
 *   attributive — followed by 「的」 (`尊重用户的隐私`, `用户的猫`) → safe, keep verbatim;
 *   unclear      — anything else (`请告诉用户`, `其实用户…`) → keep and report, never rewrite.
 *
 * A clause starts where the previous character is not a word character (space, punctuation, a
 * bullet, a closing quote). A word character before it (`对用户`, `请用户`, `实用户`) means the
 * phrase is not the subject, and the host refuses to guess.
 */
function userTokenRole(text, at) {
  const next = text[at + PROFILE_TONE_USER_TOKEN.length] ?? '';
  if (next === '的') return 'attributive';
  if (next.length === 0) return 'unclear';
  if (at === 0) return 'subject';
  return /[\p{L}\p{N}]/u.test(text[at - 1]) ? 'unclear' : 'subject';
}


/**
 * Pure tone check for one model-produced text. Violations carry the exact sentence and offsets
 * so the repair path can send only that sentence and put the answer back in place.
 *
 * @returns {{ok: boolean, side: string, violations: object[], quoted: object[], unresolved: object[]}}
 *   `violations` — `[{text, tokens, start, end}]`; `quoted` — quoted sentences that merely
 *   mention a token (never a violation, never rewritten); `unresolved` — occurrences the host
 *   could not classify (never a violation, never rewritten, reported as `profile.tone.unresolved`).
 */
export function checkProfileTone(value, side = 'user') {
  const which = side === 'agent' ? 'agent' : 'user';
  const text = cleanText(value);
  const mask = quotedMask(text);
  const violations = [];
  const quoted = [];
  const unresolved = [];
  const add = (bucket, token) => {
    if (!bucket.includes(token)) bucket.push(token);
  };
  for (const piece of toneSentences(text)) {
    const offenders = [];
    const references = [];
    const unsure = [];
    for (let index = 0; index < piece.text.length; index += 1) {
      const at = piece.start + index;
      if (which === 'agent') {
        if (!piece.text.startsWith(PROFILE_TONE_USER_TOKEN, index)) continue;
        const length = PROFILE_TONE_USER_TOKEN.length;
        if (insideQuote(mask, at, length)) add(references, PROFILE_TONE_USER_TOKEN);
        else {
          const role = userTokenRole(piece.text, index);
          if (role === 'subject') add(offenders, PROFILE_TONE_USER_TOKEN);
          else if (role === 'unclear') add(unsure, PROFILE_TONE_USER_TOKEN);
        }
        index += length - 1;
        continue;
      }
      const token = firstPersonAt(piece.text, index);
      if (token === null) continue;
      if (insideQuote(mask, at, token.length)) add(references, token);
      else add(offenders, token);
      index += token.length - 1;
    }
    if (offenders.length > 0) {
      violations.push({ text: piece.text.trim(), tokens: offenders, start: piece.start, end: piece.end });
    }
    if (references.length > 0) quoted.push({ text: piece.text.trim(), tokens: references });
    if (unsure.length > 0) {
      unresolved.push({ text: piece.text.trim(), tokens: unsure, start: piece.start, end: piece.end });
    }
  }
  return { ok: violations.length === 0, side: which, violations, quoted, unresolved };
}


/**
 * Deterministic, meaning-preserving rewrite of one violating sentence: on the user side the
 * first-person pronouns are dropped and the sentence is reported as 「用户…」; on the persona side
 * a SUBJECT 「用户」 becomes 「你」. Object/attributive 「用户」 and an ambiguous occurrence are left
 * exactly as written — the fallback never guesses. Quoted spans are copied verbatim (a quote-only
 * sentence is kept as reported speech, 「用户说过『…』」).
 */
export function fallbackToneText(value, side = 'user') {
  const which = side === 'agent' ? 'agent' : 'user';
  const text = cleanText(value);
  const mask = quotedMask(text);
  if (which === 'agent') {
    let output = '';
    for (let index = 0; index < text.length; index += 1) {
      const length = PROFILE_TONE_USER_TOKEN.length;
      if (text.startsWith(PROFILE_TONE_USER_TOKEN, index)
        && mask[index] !== true && mask[index + 1] !== true
        && userTokenRole(text, index) === 'subject') {
        output += '你';
        index += length - 1;
        continue;
      }
      output += text[index];
    }
    return output;
  }
  let stripped = '';
  for (let index = 0; index < text.length;) {
    const token = firstPersonAt(text, index);
    if (token !== null && !insideQuote(mask, index, token.length)) {
      // Drop the whole pronoun, except the possessive 「我的」: keeping 「的」 makes the template
      // produce 「用户的猫…」 instead of the ungrammatical 「用户猫…」.
      index += token === '我的' ? 1 : token.length;
      continue;
    }
    stripped += text[index];
    index += 1;
  }
  const body = cleanText(stripped).replace(/^[，,、：:。\s]+/u, '').trim();
  if (body.length === 0) return '用户';
  if (body.startsWith('用户')) return body;
  if (/^[「『“‘"']/u.test(body)) return `用户说过${body}`;
  return `用户${body}`;
}


/** The single targeted repair prompt: only the offending sentences, with the side's rule. */
export function buildToneRepairPrompt({ side = 'user', sentences = [] } = {}) {
  const which = side === 'agent' ? 'agent' : 'user';
  const label = which === 'agent' ? '助手人设' : '用户画像';
  const rule = which === 'agent'
    ? '助手人设一律用第二人称「你……」；只把作主语的「用户」改成「你」（「用户会撒娇」→「你会撒娇」），作宾语或定语的「用户」保留原样（「尊重用户的隐私」保持原句）。'
    : '用户画像一律用第三人称「用户……」，不得出现「我/我们/我的/咱/咱们」（「我喜欢安静」→「用户喜欢安静」）；词语内部的「我」不动（「自我介绍」保持原样）。';
  const list = (Array.isArray(sentences) ? sentences : [])
    .map((sentence, index) => `${index + 1}. ${cleanText(sentence)}`)
    .join('\n');
  return [
    `下面这些${label}句子口吻不合格。只改这些句子，不要重写其他内容。`,
    `规则：${rule}`,
    '- 意思不变：不得新增或删除任何约束，也不得合并或拆开句子。',
    '- 引号「…」/『…』/“…”里的原话是引用，必须原样保留，不得改写或删除；画像里仍作为「用户说过」保留。',
    '只输出一个 JSON 数组，按顺序给出改写后的句子，例如 ["…","…"]，不要解释。',
    `句子：\n${list}`,
  ].join('\n');
}


/** Repair-model output → the rewritten sentences; order matters (a length mismatch is failure). */
export function parseToneRepair(value) {
  const pick = (candidate) => {
    if (Array.isArray(candidate)) return candidate;
    if (candidate !== null && typeof candidate === 'object' && Array.isArray(candidate.sentences)) {
      return candidate.sentences;
    }
    return null;
  };
  let list = pick(value);
  if (list === null) {
    list = pick(parseJsonPayload(value, 'profile tone: repair returned non-JSON text'));
    if (list === null) throw new Error('profile tone: repair returned no sentence list');
  }
  return list.map((item) => cleanText(
    typeof item === 'string' ? item : item?.text ?? item?.sentence ?? item?.value ?? '',
  ));
}


/** Put repaired sentences back in place; every other sentence and the terminator is preserved. */
function replaceToneSentences(text, offenders, replacements) {
  let output = '';
  let cursor = 0;
  for (let index = 0; index < offenders.length; index += 1) {
    const piece = offenders[index];
    if (piece.start < cursor) continue;
    output += text.slice(cursor, piece.start);
    const tail = piece.text.match(/[。！？!?；;]+[\s]*$/u)?.[0]
      ?? piece.text.match(/\s+$/u)?.[0]
      ?? '';
    let body = cleanText(replacements[index] ?? '');
    if (body.length === 0) {
      output += piece.text;
      cursor = piece.end;
      continue;
    }
    if (tail.length > 0 && /[。！？!?；;]/u.test(tail)) body = body.replace(/[。！？!?；;]+$/u, '');
    output += `${body}${tail}`;
    cursor = piece.end;
  }
  return output + text.slice(cursor);
}

export {
  TONE_QUOTE_CLOSERS,
  TONE_SENTENCE_BREAKS,
  quotedMask,
  toneSentences,
  insideQuote,
  FIRST_PERSON_COMPOUND_TAIL,
  firstPersonAt,
  userTokenRole,
  replaceToneSentences,
};
