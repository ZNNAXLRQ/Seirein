/** compose — extracted from profileMaintain.js; no host entry dependency. */
import {
  PROFILE_CATEGORY_PRESETS,
  PROFILE_PROMPT_BUDGET_TOKENS,
  categoryKey,
  cleanText,
  positiveInt,
} from './maintain-config.js';
import { normalizeReclassifyText } from './classification.js';
import { parseJsonPayload } from './evidence.js';
import { toneSentences } from './tone.js';

/**
 * Compose quality gate (host-enforced, not prompt-only). Several signals, none of which edits a
 * rewrite word by word:
 *  - length: a produced clause above 1.5× the entry it rewrites is an anomaly signal (a short
 *    entry gets an 8-character grammar allowance); the rewrite is rejected, never trimmed;
 *  - duplicates: punctuation-free 3-gram Jaccard ≥ 0.8 is only a suspected duplicate; merging is
 *    allowed only when subject, object, polarity and condition are identical;
 *  - filler: evaluative/metadiscourse patterns are forbidden by the prompt and their presence
 *    rejects the rewrite (the host never deletes words itself);
 *  - cross-side leakage: a clause matching the other box's entry also rejects the rewrite.
 * Any rejection falls back to the original entry texts and writes no rewrite.
 */
export const PROFILE_COMPOSE_LENGTH_RATIO = 1.5;

// A short fragment legitimately needs more characters to become a complete sentence; this is an
// expansion allowance, never a licence to drop information (the ratio still caps long inputs).
export const PROFILE_COMPOSE_SHORT_ENTRY_SLACK = 8;

export const PROFILE_COMPOSE_DUPLICATE_SIMILARITY = 0.8;

/** Merge diagnostics are debug-level and throttled: one window per instance, a few rows per window. */
export const PROFILE_COMPOSE_MERGE_THROTTLE_MS = 60_000;

export const PROFILE_COMPOSE_MERGE_LOG_LIMIT = 5;

/** Cross-side leakage is detected a little earlier than a duplicate (the pronoun prefix differs). */
const PROFILE_COMPOSE_CROSS_SIDE_SIMILARITY = 0.6;


/**
 * Presentation: the two boxes must READ AS PROSE, not as a per-item list. A rewrite is therefore
 * at most three paragraphs, no line may open with a bullet/number marker, and every paragraph must
 * be complete sentences (only a single-paragraph answer may be one sentence without terminator).
 */
export const PROFILE_COMPOSE_MAX_PARAGRAPHS = 3;


/** Total budget of one rewrite: the concatenated sources may not be padded beyond this ratio. */
export const PROFILE_COMPOSE_TOTAL_RATIO = 1.2;


/**
 * A source shorter than this carries no distinctive keyword (a 2–4 character fragment matches
 * almost any sentence), so its retention cannot be asserted deterministically.
 */
export const PROFILE_COMPOSE_COVERAGE_MIN_CHARS = 5;


/** One entry yields at most this many keywords; coverage needs only ONE of them. */
export const PROFILE_COMPOSE_KEYWORD_MAX = 4;


/** A clause must match one own entry at least this much before its length is measured. */
const PROFILE_COMPOSE_ENTRY_MATCH = 0.25;


/** Evaluation/echo patterns: presence rejects the rewrite; the host NEVER deletes words itself. */
export const PROFILE_COMPOSE_FILLER_RULES = Object.freeze([
  Object.freeze({
    reason: 'meta-evaluation',
    pattern: /(?:对|对于)[^，,。！？!?；;]{0,16}(?:期待|期望|要求)[^，,。！？!?；;]{0,6}(?:比较|较为|很|非常|尤为)?明显/u,
  }),
  Object.freeze({ reason: 'vague-degree', pattern: /(?:比较|较为|很|非常|尤为)明显/u }),
  Object.freeze({ reason: 'vague-degree', pattern: /一定程度/u }),
  Object.freeze({
    reason: 'echo',
    pattern: /^(?:也|还|同时|另外|此外)?(?:比较|较为|很|非常)?(?:亲近|喜欢|接受|认可)(?:这种|这类|这样的)(?:口吻|语气|方式|说法|表达)/u,
  }),
]);


/** Punctuation-free lowercase form used only for similarity/length quality checks. */
const composeKey = (value) => cleanText(value).replace(/[\s\p{P}\p{S}]+/gu, '').toLowerCase();


/** Number of content characters (CJK/letters/digits), the unit the length gate measures. */
const composeLength = (value) => (cleanText(value).match(/[\p{L}\p{N}]/gu) ?? []).length;


/** Character n-grams of the punctuation-free text; short texts collapse to their whole string. */
function composeGrams(value, size = 3) {
  const chars = [...composeKey(value)];
  if (chars.length === 0) return new Set();
  if (chars.length <= size) return new Set([chars.join('')]);
  const grams = new Set();
  for (let index = 0; index + size <= chars.length; index += 1) {
    grams.add(chars.slice(index, index + size).join(''));
  }
  return grams;
}


/** 0..1 punctuation-free 3-gram Jaccard similarity (the duplicate rule). */
export function composeSimilarity(left, right) {
  const a = composeGrams(left);
  const b = composeGrams(right);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared += 1;
  return shared / (a.size + b.size - shared);
}


/** One clause per sentence/comma, delimiter included, so dropped clauses leave a clean join. */
function composeClauses(text) {
  const value = String(text ?? '');
  const clauses = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (!'，,。！？!?；;、\n'.includes(value[index])) continue;
    let end = index + 1;
    while (end < value.length && '，,。！？!?；;、\n'.includes(value[end])) end += 1;
    clauses.push({ text: value.slice(start, end), start, end });
    start = end;
    index = end - 1;
  }
  if (start < value.length) clauses.push({ text: value.slice(start), start, end: value.length });
  return clauses.filter((clause) => composeKey(clause.text).length > 0);
}


/**
 * A line that opens with a bullet, a middle dot or a number is a list item, never prose. The
 * rewrite is normalized first (no leading indentation, no blank line at either end), so an
 * INDENTED bullet is still recognized and still rejected.
 */
const COMPOSE_LIST_MARKER = /^(?:[-*+·•●○◦▪‣※]|\d+[.)、]|\(\d+\)|（\d+）|[一二三四五六七八九十]+[、.])/u;

const COMPOSE_SENTENCE_END = /[。！？!?；;…]/u;


function normalizeComposeProse(value) {
  return String(value ?? '')
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.replace(/^[\s\u3000]+/u, '').replace(/[\s\u3000]+$/u, ''))
    .filter((line) => line.length > 0)
    .join('\n');
}


/**
 * Presentation verdict of one normalized rewrite: null when it reads as prose, else the reason.
 * At most three paragraphs, no list marker anywhere, and every paragraph of a multi-paragraph
 * answer must be complete sentences (a single paragraph may be one unpunctuated sentence, so a
 * short fragment keeps its original wording).
 */
function composePresentationReason(prose) {
  const lines = String(prose ?? '').split('\n').filter((line) => line.length > 0);
  if (lines.length === 0) return 'empty';
  if (lines.length > PROFILE_COMPOSE_MAX_PARAGRAPHS) return 'list';
  if (lines.some((line) => COMPOSE_LIST_MARKER.test(line))) return 'list';
  if (lines.length > 1 && lines.some((line) => !COMPOSE_SENTENCE_END.test(line))) return 'list';
  return null;
}


/**
 * Framing words dropped before an entry's keywords are chosen. Only framing and pure connective
 * words are listed: a content word (喜欢/温柔/安静/无糖…) always stays part of a keyword, and a
 * negation is never removed (it belongs to the protected fields below).
 */
const COMPOSE_STOPWORDS = Object.freeze([
  '用户', '我们', '咱们', '自己', '本人', '希望', '想要', '倾向于', '偏爱', '偏好',
  '对于', '关于', '一下', '一些', '这种', '那种', '这样', '那样', '的时候',
  '比较', '非常', '经常', '偶尔', '同时', '另外', '而且', '并且',
]);


/**
 * Up to `PROFILE_COMPOSE_KEYWORD_MAX` deterministic keywords of one entry: framing words removed,
 * the content run itself when short, otherwise three windows spread through it, plus tail bigrams
 * so a faithful paraphrase that keeps the fact still matches. This is an Omission RISK signal
 * only — it is never the proof that the fact survived (see `composeFidelityVerdict`).
 */
export function composeKeywords(value) {
  const body = cleanText(value).toLowerCase();
  if (body.length === 0) return [];
  let stripped = body;
  for (const stopword of COMPOSE_STOPWORDS) stripped = stripped.split(stopword).join('\u0001');
  const runs = stripped.split(/[\s\p{P}\p{S}\u0001]+/u).filter((run) => run.length >= 2);
  const keywords = [];
  const add = (token) => {
    const keyword = cleanText(token);
    if (keyword.length >= 2 && keywords.length < PROFILE_COMPOSE_KEYWORD_MAX && !keywords.includes(keyword)) {
      keywords.push(keyword);
    }
  };
  for (const run of runs) {
    const chars = [...run];
    if (chars.length <= 8) {
      add(run);
      for (let index = chars.length - 2; index >= 0; index -= 1) add(chars.slice(index, index + 2).join(''));
    } else {
      for (const at of [0, Math.floor((chars.length - 3) / 2), chars.length - 3]) {
        add(chars.slice(at, at + 3).join(''));
      }
    }
  }
  return keywords;
}


/**
 * Numbers are literal facts, but a bare CJK numeral is usually a word (一点 / 一起 / 一直), so a
 * CJK quantity is only recognized together with its unit (一次 / 三十岁 / 一个月). Arabic digits
 * are always a number. Both spellings normalize to the same token, so 「十次」 and 「10次」 match.
 */
const COMPOSE_ARABIC_NUMBER = /\d+(?:\.\d+)?/gu;

const COMPOSE_CJK_NUMBER = /([一二两三四五六七八九十百半]+)(年|月|日|号|岁|次|杯|分钟|小时|天|周|个月|元|块)/gu;

const COMPOSE_CJK_DIGITS = Object.freeze({
  一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 百: 100, 半: 0.5,
});


/** Multi-character negations first, so 「并非」/「没有」 are one token and not a bare 「非」/「没」. */
const COMPOSE_NEGATIONS = Object.freeze(['并非', '没有', '不再', '不会', '不能', '不是', '从不', '不', '没', '别', '勿', '非', '未']);


function composeNumberTokens(value) {
  const text = String(value ?? '');
  const tokens = [];
  for (const match of text.matchAll(COMPOSE_ARABIC_NUMBER)) tokens.push(String(Number(match[0])));
  for (const match of text.matchAll(COMPOSE_CJK_NUMBER)) {
    const digits = [...match[1]]
      .map((char) => (COMPOSE_CJK_DIGITS[char] !== undefined ? String(COMPOSE_CJK_DIGITS[char]) : char))
      .join('');
    tokens.push(`${digits}${match[2]}`);
  }
  return tokens;
}


/** The negation tokens of one text, longest-first, sorted — the "who is against what" fingerprint. */
function composeNegationTokens(value) {
  const text = composeKey(value);
  const tokens = [];
  for (let index = 0; index < text.length;) {
    const hit = COMPOSE_NEGATIONS.find((token) => text.startsWith(token, index));
    if (hit === undefined) {
      index += 1;
      continue;
    }
    tokens.push(hit);
    index += hit.length;
  }
  return tokens.sort();
}


/**
 * Scene conditions such as 「学习时」/「工作时」. The condition-phrase table below only catches
 * 「X的时候」 and 如果…; a bare 「X时」 is a condition too, and a rewrite may not turn 学习时 into
 * 工作时. Both spellings normalize to the same scene key.
 */
const COMPOSE_SCENE_WORDS = Object.freeze([
  '学习', '工作', '上班', '加班', '通勤', '吃饭', '运动', '健身', '睡前', '起床', '在家',
  '出差', '旅行', '周末', '假期', '白天', '晚上', '夜里', '深夜', '早上', '早晨', '上午',
  '中午', '下午', '傍晚', '平时', '独处', '考试', '开会', '休息', '约会',
]);


/** Scene keys of one text: `scene:学习` for both 「学习时」 and 「学习的时候」. */
function composeSceneTokens(value) {
  const text = composeKey(value);
  const tokens = new Set();
  for (const scene of COMPOSE_SCENE_WORDS) {
    if (text.includes(`${scene}时`) || text.includes(`${scene}的时候`)) tokens.add(`scene:${scene}`);
  }
  return [...tokens].sort();
}


/**
 * Deterministic FIDELITY verdict of one rewrite against its own sources. The keyword check is
 * only an omission RISK signal; these are the facts a rewrite may never change: the numbers/dates
 * (no invented figure, no dropped figure), the negation set (「并非讨厌」 is not 「喜欢」 — and the
 * other way round), the subject (who), and the condition/exception phrases (a conditional fact may
 * not become unconditional; 「学习时」 may not become 「工作时」). A mismatch rejects the rewrite;
 * the source sentences are written instead. An entry with no protected field and no matching
 * sentence is left to the semantic cross-check, never rejected on a similarity alone.
 *
 * @returns {{ok: boolean, reason: string|null, entry?: string, token?: string}}
 */
export function composeFidelityVerdict({ text = '', entries = [] } = {}) {
  const own = (Array.isArray(entries) ? entries : []).filter((entry) => cleanText(entry?.text).length > 0);
  const prose = String(text ?? '');
  const sentences = toneSentences(prose).map((piece) => ({ text: cleanText(piece.text) })).filter((piece) => piece.text.length > 0);
  if (own.length === 0 || sentences.length === 0) return { ok: true, reason: null };
  const sourceNumbers = new Set(own.flatMap((entry) => composeNumberTokens(entry?.text)));
  for (const entry of own) {
    const source = cleanText(entry?.text);
    const match = bestEntryMatch(source, sentences);
    const protectedSource = composeNumberTokens(source).length > 0
      || composeNegationTokens(source).length > 0
      || composeConditionPhrases(source).length > 0;
    if (match.entry === null || match.score < PROFILE_COMPOSE_ENTRY_MATCH) {
      // A protected fact with no sentence carrying it was dropped from the rewrite.
      if (protectedSource) return { ok: false, reason: 'dropped', entry: source };
      continue;
    }
    const sentence = match.entry.text;
    const numbers = composeNumberTokens(sentence);
    for (const token of composeNumberTokens(source)) {
      if (!numbers.includes(token)) return { ok: false, reason: 'number', entry: source, token };
    }
    if (composeNegationTokens(sentence).join('|') !== composeNegationTokens(source).join('|')) {
      return { ok: false, reason: 'polarity', entry: source };
    }
    const subject = composeSubjectRole(source);
    if (subject.length > 0 && composeSubjectRole(sentence).length > 0 && composeSubjectRole(sentence) !== subject) {
      return { ok: false, reason: 'subject', entry: source };
    }
    for (const phrase of composeConditionPhrases(source)) {
      const raw = phrase.slice(phrase.indexOf(':') + 1);
      if (raw.length > 0 && !composeKey(sentence).includes(raw)) {
        return { ok: false, reason: 'condition', entry: source };
      }
    }
    // 「学习时」/「工作时」: both sides name a scene and the scenes differ. One side missing a scene
    // is left to the semantic check, never inferred here.
    const sourceScenes = composeSceneTokens(source);
    const sentenceScenes = composeSceneTokens(sentence);
    if (sourceScenes.length > 0 && sentenceScenes.length > 0
      && sourceScenes.join('|') !== sentenceScenes.join('|')) {
      return { ok: false, reason: 'condition', entry: source };
    }
  }
  // An invented number is a new fact even when every source fact survived. An invented NEGATION is
  // a changed attitude in the same way: 「喜欢」 may not become 「并非讨厌」 just because the
  // sentence stays similar (see the reverse direction in `composeFactVerdict`).
  for (const token of composeNumberTokens(prose)) {
    if (!sourceNumbers.has(token)) return { ok: false, reason: 'new-fact', token };
  }
  const sourceNegations = new Set(own.flatMap((entry) => composeNegationTokens(entry?.text)));
  for (const token of composeNegationTokens(prose)) {
    if (!sourceNegations.has(token)) return { ok: false, reason: 'new-fact', token, detail: 'negation' };
  }
  return { ok: true, reason: null };
}


/** True when a clause contains an evaluative/filler pattern (used to REJECT, never to delete). */
function composeFillerReason(clause) {
  const body = cleanText(clause).replace(/[，,。！？!?；;、\s]+$/u, '').trim();
  for (const rule of PROFILE_COMPOSE_FILLER_RULES) {
    if (rule.pattern.test(body)) return rule.reason;
  }
  return null;
}


/**
 * A ≥0.8 3-gram pair is only a SUSPECTED duplicate. Two clauses are merged only when subject,
 * object, polarity and the CONDITION PHRASE all agree: 「喜欢主动提醒」/「不喜欢主动提醒」 are
 * similar but opposite and must both survive, and 「…学习的时候…」/「…工作的时候…」 are different
 * facts even though the same keyword (的时候) appears on both sides. The complete condition phrase
 * is compared, never a keyword set, and anything the host cannot confirm is kept as two entries.
 */
const COMPOSE_NEGATION = /(?:不|没|没有|别|勿|非|未)/u;

/** AUXILIARY only: a time/scene word may prove two conditions DIFFER, never that they are equal. */
const COMPOSE_CONDITION = /(?:凌晨|清晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里|夜晚|深夜|睡前|白天|工作日|周末|假期|节假日|平时|每天|经常|偶尔|有时|工作时|上班时|学习时|通勤时|吃饭时|运动时|在家时|的时候|时分|如果|假如|若|当|只要|除非|否则|一旦|才|再)/gu;

const COMPOSE_SUBJECT = /^(?:用户|你|我|我们|咱们|咱)/u;

const COMPOSE_CLAUSE_END = '[^，,。！？!?；;、\\n]';


function composePolarity(text) {
  return COMPOSE_NEGATION.test(composeKey(text)) ? 'negative' : 'positive';
}


/**
 * The condition phrases of one clause, normalized. 「…的时候」 keeps the whole scene before the
 * marker (「用户学习」 vs 「用户工作」), 「如果/当/一旦…」 keeps the clause after the marker; the
 * marker words themselves are never the comparison — a shared keyword is not a shared condition.
 */
function composeConditionPhrases(text) {
  const body = cleanText(text);
  const phrases = new Set();
  for (const match of body.matchAll(new RegExp(`(${COMPOSE_CLAUSE_END}*)的时候`, 'gu'))) {
    phrases.add(`前:${composeKey(match[1])}`);
  }
  for (const match of body.matchAll(new RegExp(`(?:如果|假如|一旦|只要|除非|否则|当)(${COMPOSE_CLAUSE_END}*)`, 'gu'))) {
    phrases.add(`后:${composeKey(match[1])}`);
  }
  return [...phrases].sort();
}


function composeConditionTokens(text) {
  return [...new Set(composeKey(text).match(COMPOSE_CONDITION) ?? [])].sort();
}


/**
 * Same-condition verdict: phrases must be word-for-word equal (or both absent). With no phrase on
 * either side the keyword table may only prove a DIFFERENCE — equal/stray keywords stay
 * unconfirmed, so rule 3 holds: the keyword table never decides "the condition is the same".
 */
function composeConditionVerdict(left, right) {
  const leftPhrases = composeConditionPhrases(left);
  const rightPhrases = composeConditionPhrases(right);
  if (leftPhrases.length > 0 || rightPhrases.length > 0) {
    const same = leftPhrases.length === rightPhrases.length
      && leftPhrases.every((phrase) => rightPhrases.includes(phrase));
    return same ? 'same-condition' : null;
  }
  const leftTokens = composeConditionTokens(left);
  const rightTokens = composeConditionTokens(right);
  if (leftTokens.length === 0 && rightTokens.length === 0) return 'no-condition';
  return leftTokens.join('|') === rightTokens.join('|') ? 'unconfirmed' : null;
}


function composeSubject(text) {
  return composeKey(text).match(COMPOSE_SUBJECT)?.[0] ?? '';
}


/**
 * The same person may be addressed as 用户 / 你 / 我: a rewrite that keeps the role but changes
 * the address is still faithful. Any other subject (e.g. 助手) stays distinct, so swapping the
 * user for the assistant is still caught.
 */
function composeSubjectRole(text) {
  const subject = composeSubject(text);
  if (subject.length === 0) return '';
  return /^(?:用户|你|您|我|我们|咱们|咱)$/u.test(subject) ? 'self' : subject;
}


/** What is left once subject, condition phrase and negation are removed: the object/predicate. */
function composeObject(text) {
  let body = composeKey(text);
  for (const phrase of composeConditionPhrases(text)) {
    const raw = phrase.slice(phrase.indexOf(':') + 1);
    if (raw.length > 0) body = body.split(raw).join('');
  }
  return body.replace(COMPOSE_SUBJECT, '').replace(COMPOSE_NEGATION, '');
}


/**
 * Deterministic AFFECT lexicon. Words of the same group are one dimension, so a rewrite may not
 * move the same object to the opposite side (喜欢无糖茶 → 讨厌无糖茶). A negator directly before
 * a word flips its sign (「不喜欢」 = negative), while lexicalized negatives (讨厌/反对) carry
 * their own. Bare 爱/恨 are guarded so compounds such as 可爱/爱好/仇恨 never count as an
 * attitude. When either the polarity word or the object is missing NOTHING is inferred.
 */
const COMPOSE_POLARITY_LEXICON = Object.freeze([
  { word: '喜欢', group: 'like', sign: 'positive' },
  { word: '喜爱', group: 'like', sign: 'positive' },
  { word: '热爱', group: 'like', sign: 'positive' },
  { word: '偏爱', group: 'like', sign: 'positive' },
  { word: '偏好', group: 'like', sign: 'positive' },
  { word: '钟爱', group: 'like', sign: 'positive' },
  { word: '中意', group: 'like', sign: 'positive' },
  { word: '青睐', group: 'like', sign: 'positive' },
  { word: '欣赏', group: 'like', sign: 'positive' },
  { word: '爱看', group: 'like', sign: 'positive' },
  { word: '爱听', group: 'like', sign: 'positive' },
  { word: '爱吃', group: 'like', sign: 'positive' },
  { word: '爱喝', group: 'like', sign: 'positive' },
  { word: '爱玩', group: 'like', sign: 'positive' },
  { word: '爱读', group: 'like', sign: 'positive' },
  { word: '爱穿', group: 'like', sign: 'positive' },
  { word: '爱用', group: 'like', sign: 'positive' },
  { word: '讨厌', group: 'like', sign: 'negative' },
  { word: '厌恶', group: 'like', sign: 'negative' },
  { word: '反感', group: 'like', sign: 'negative' },
  { word: '想要', group: 'want', sign: 'positive' },
  { word: '希望', group: 'want', sign: 'positive' },
  { word: '愿意', group: 'want', sign: 'positive' },
  { word: '渴望', group: 'want', sign: 'positive' },
  { word: '期待', group: 'want', sign: 'positive' },
  { word: '不想', group: 'want', sign: 'negative' },
  { word: '支持', group: 'support', sign: 'positive' },
  { word: '赞成', group: 'support', sign: 'positive' },
  { word: '认同', group: 'support', sign: 'positive' },
  { word: '同意', group: 'support', sign: 'positive' },
  { word: '拥护', group: 'support', sign: 'positive' },
  { word: '接受', group: 'support', sign: 'positive' },
  { word: '反对', group: 'support', sign: 'negative' },
  { word: '抵制', group: 'support', sign: 'negative' },
  { word: '拒绝', group: 'support', sign: 'negative' },
  { word: '爱', group: 'like', sign: 'positive' },
  { word: '恨', group: 'like', sign: 'negative' },
].map((entry) => Object.freeze(entry)).sort((left, right) => right.word.length - left.word.length));


/** Bare 爱/恨 only count as an attitude outside these common compounds. */
const COMPOSE_POLARITY_GUARD = Object.freeze({
  爱: Object.freeze({ before: /[可亲宠怜疼恩]/u, after: /[好心护情意]/u }),
  恨: Object.freeze({ before: /[仇悔怨]/u, after: /[不]/u }),
});


/** Polarity words of one text, longest-first, with a negator directly before them flipping the sign. */
function composePolarityHits(value) {
  const text = composeKey(value);
  const hits = [];
  for (let index = 0; index < text.length;) {
    const entry = COMPOSE_POLARITY_LEXICON.find((item) => text.startsWith(item.word, index));
    if (entry === undefined) {
      index += 1;
      continue;
    }
    const guard = COMPOSE_POLARITY_GUARD[entry.word];
    const before = index > 0 ? text[index - 1] : '';
    const after = text[index + entry.word.length] ?? '';
    if (guard !== undefined && (guard.before.test(before) || guard.after.test(after))) {
      index += 1;
      continue;
    }
    const negated = COMPOSE_NEGATIONS.some((token) => text.slice(0, index).endsWith(token));
    const positive = entry.sign === 'positive' ? !negated : negated;
    hits.push({ group: entry.group, sign: positive ? 'positive' : 'negative', word: entry.word });
    index += entry.word.length;
  }
  return hits;
}


/** One sentence/clause per conjunction or punctuation mark, so each attitude keeps its own object. */
const COMPOSE_POLARITY_SPLIT = /[，,。；;！？!?\n、]+|但是|不过|然而|而且|反而|从而|进而|但|却|同时|而/u;


function composePolarityClauses(value) {
  return String(value ?? '')
    .split(COMPOSE_POLARITY_SPLIT)
    .map((part) => cleanText(part))
    .filter((part) => part.length > 0);
}


/** What is left of one clause once subject, polarity words and negations are removed: the object. */
function composePolarityObject(clause) {
  let text = composeKey(clause).replace(COMPOSE_SUBJECT, '');
  for (const hit of composePolarityHits(clause)) text = text.split(hit.word).join('');
  for (const token of COMPOSE_NEGATIONS) text = text.split(token).join('');
  return text;
}


/**
 * `(group|object) → {group, object, signs}` over every clause of the given texts. Only a clause
 * that has BOTH a polarity word and a non-empty object is recorded; everything else is skipped.
 */
function composePolaritySignMap(values) {
  const map = new Map();
  for (const value of values) {
    for (const clause of composePolarityClauses(value)) {
      const hits = composePolarityHits(clause);
      if (hits.length === 0) continue;
      const object = composePolarityObject(clause);
      if (object.length === 0) continue;
      for (const hit of hits) {
        const key = `${hit.group}|${object}`;
        if (!map.has(key)) map.set(key, { group: hit.group, object, signs: new Set() });
        map.get(key).signs.add(hit.sign);
      }
    }
  }
  return map;
}


/**
 * Deterministic ANTONYM guard: for the same attitude group and the same object, a rewrite may not
 * add the opposite sign or lose every sign the sources had (「喜欢无糖茶」→「讨厌无糖茶」；
 * 「不喜欢甜食但喜欢辣食」对调). No polarity word or no object anywhere → no inference.
 *
 * @returns {{ok: boolean, reason: string|null, group?: string, object?: string,
 *   source?: string[], rewritten?: string[]}}
 */
export function composeAntonymVerdict({ text = '', entries = [] } = {}) {
  const source = composePolaritySignMap((Array.isArray(entries) ? entries : []).map((entry) => entry?.text));
  const rewritten = composePolaritySignMap([text]);
  for (const [key, row] of source) {
    const other = rewritten.get(key);
    if (other === undefined || other.signs.size === 0) continue;
    const addedOpposite = [...other.signs].some((sign) => !row.signs.has(sign));
    const lostEverySign = [...row.signs].every((sign) => !other.signs.has(sign));
    if (addedOpposite || lostEverySign) {
      return {
        ok: false,
        reason: 'antonym',
        group: row.group,
        object: row.object,
        source: [...row.signs].sort(),
        rewritten: [...other.signs].sort(),
      };
    }
  }
  return { ok: true, reason: null };
}


/**
 * True when the produced text differs from the concatenated sources once whitespace and
 * punctuation are ignored: a real rewording, not a formatting-only copy of the source.
 */
export function composeReworded(entries = [], text = '') {
  const source = (Array.isArray(entries) ? entries : []).map((entry) => cleanText(entry?.text)).join('');
  return composeKey(source) !== composeKey(text);
}


/**
 * Conservative merge verdict of one pair with the reason: `identical` / `same-condition` /
 * `no-condition` when they merge, else the first failed check (`similarity`, `polarity`,
 * `subject`, `condition`, `object`). Any check the host cannot confirm rejects the merge, so a
 * duplicate is preferred over a wrong merge.
 */
export function composeFactVerdict(left, right) {
  const keyLeft = composeKey(left);
  const keyRight = composeKey(right);
  if (keyLeft.length === 0 || keyRight.length === 0) return { same: false, reason: 'empty' };
  if (composeSimilarity(left, right) < PROFILE_COMPOSE_DUPLICATE_SIMILARITY) {
    return { same: false, reason: 'similarity' };
  }
  if (composePolarity(left) !== composePolarity(right)) return { same: false, reason: 'polarity' };
  if (composeSubject(left) !== composeSubject(right)) return { same: false, reason: 'subject' };
  const condition = composeConditionVerdict(left, right);
  if (condition === null || condition === 'unconfirmed') {
    // Unconfirmed condition: only an identical text is safe; anything else stays two entries.
    return keyLeft === keyRight
      ? { same: true, reason: 'identical' }
      : { same: false, reason: 'condition' };
  }
  if (composeObject(left) !== composeObject(right)) return { same: false, reason: 'object' };
  return { same: true, reason: condition };
}


export function composeSameFact(left, right) {
  return composeFactVerdict(left, right).same;
}


/** Keep one entry per fact; a similar-but-different tendency is kept, never merged. */
export function dedupeComposeEntries(entries = []) {
  const kept = [];
  const dropped = [];
  const merges = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const text = cleanText(entry?.text);
    if (text.length === 0) continue;
    const verdicts = kept.map((item) => composeFactVerdict(item.text, text));
    const index = verdicts.findIndex((verdict) => verdict.same);
    if (index < 0) {
      kept.push(entry);
      continue;
    }
    merges.push({ left: cleanText(kept[index].text), right: text, reason: verdicts[index].reason });
    if (composeLength(text) > composeLength(kept[index].text)) {
      dropped.push(kept[index]);
      kept[index] = entry;
    } else {
      dropped.push(entry);
    }
  }
  return { entries: kept, dropped, merges };
}


/** Length budget of one produced fact: 1.5× its source, plus a short-entry grammar allowance. */
function composeLengthBudget(source) {
  const length = composeLength(source);
  return Math.max(Math.ceil(length * PROFILE_COMPOSE_LENGTH_RATIO), length + PROFILE_COMPOSE_SHORT_ENTRY_SLACK);
}


/** The best-matching entry of one pool (own or the other side) for a produced clause. */
function bestEntryMatch(clause, entries) {
  let best = null;
  let bestScore = 0;
  for (const entry of Array.isArray(entries) ? entries : []) {
    const score = composeSimilarity(clause, entry?.text);
    if (score > bestScore) {
      best = entry;
      bestScore = score;
    }
  }
  return { entry: best, score: bestScore };
}


/**
 * Host quality gate of one composed side. The rewrite is accepted only after several signals:
 * filler/metadiscourse presence (rejected, never deleted), unsafe duplicate merging (only an
 * exact same-fact duplicate is merged, never an opposite tendency), cross-side leakage, the
 * numbers/negations/subject/condition fidelity, the deterministic same-object affect guard, and
 * the length ratio (an anomaly signal, not a trimming rule). A matched keyword is only an omission
 * HINT and is never a proof of fidelity: `composeReworded` + the caller's semantic check decide.
 * Any rejection falls back to the original entries; the rewrite is never partially censored.
 *
 * @returns {{ok: boolean, text: string, reason?: string, dropped: object[], lengths: object[],
 *   maxRatio: number, omitted?: string[], risk?: boolean}}
 */
export function validateComposeText({
  text = '',
  entries = [],
  side = 'user',
  otherEntries = [],
} = {}) {
  const own = Array.isArray(entries) ? entries : [];
  const other = Array.isArray(otherEntries) ? otherEntries : [];
  // Presentation first: a rewrite that is still a list never reaches the box.
  const prose = normalizeComposeProse(text);
  const presentation = composePresentationReason(prose);
  if (presentation !== null) {
    return {
      ok: false, reason: presentation, text: prose, dropped: [], merges: [], lengths: [], maxRatio: 0,
    };
  }
  const clauses = composeClauses(prose);
  const dropped = [];
  const merges = [];
  const kept = [];
  // Filler/metadiscourse is NOT deleted from a rewrite: the model is told not to add it, and a
  // rewrite that still contains it is rejected wholesale (the original entries are written).
  for (const clause of clauses) {
    const filler = composeFillerReason(clause.text);
    if (filler !== null) {
      return {
        ok: false,
        reason: 'filler',
        text: String(text ?? '').trim(),
        dropped,
        merges,
        lengths: [],
        maxRatio: 0,
        clause: cleanText(clause.text),
        detail: filler,
      };
    }
  }
  for (const clause of clauses) {
    // A ≥0.8-similar clause is only a suspected duplicate; it is merged ONLY when subject,
    // object, polarity and the full condition phrase all agree (see `composeFactVerdict`).
    const verdicts = kept.map((item) => composeFactVerdict(item.text, clause.text));
    const duplicate = verdicts.findIndex((verdict) => verdict.same);
    if (duplicate >= 0) {
      merges.push({
        left: cleanText(kept[duplicate].text), right: cleanText(clause.text), reason: verdicts[duplicate].reason,
      });
      if (composeLength(clause.text) > composeLength(kept[duplicate].text)) {
        dropped.push({ text: cleanText(kept[duplicate].text), reason: 'duplicate' });
        kept[duplicate] = clause;
      } else {
        dropped.push({ text: cleanText(clause.text), reason: 'duplicate' });
      }
      continue;
    }
    kept.push(clause);
  }
  // With no duplicate merged the rewrite is kept verbatim (preserving the original wording); a
  // merged rewrite is rebuilt and its dangling separators are tidied.
  let rebuilt = dropped.length === 0
    ? prose
    : kept.map((clause) => clause.text).join('').replace(/^[，,。！？!?；;、\s]+/u, '').trim();
  if (dropped.length > 0 && rebuilt.length > 0) {
    rebuilt = rebuilt.replace(/[，,、；;\s]+$/u, '');
    if (!/[。！？!?]$/u.test(rebuilt)) rebuilt = `${rebuilt}。`;
  }
  if (composeKey(rebuilt).length === 0) {
    return { ok: false, reason: 'empty', text: '', dropped, merges, lengths: [], maxRatio: 0 };
  }
  // A clause that is clearly the OTHER side's entry must never stay in this box (a crossed
  // sentence would otherwise be accepted by the pure tone check when both sides use 用户…).
  for (const clause of kept) {
    const ownMatch = bestEntryMatch(clause.text, own);
    const otherMatch = bestEntryMatch(clause.text, other);
    if (otherMatch.score >= PROFILE_COMPOSE_CROSS_SIDE_SIMILARITY && otherMatch.score > ownMatch.score + 0.1) {
      return {
        ok: false,
        reason: 'cross-side',
        text: rebuilt,
        dropped,
        merges,
        lengths: [],
        maxRatio: 0,
        clause: cleanText(clause.text),
      };
    }
  }
  // Length per fact: only clauses that map to an own entry are measured; an unmatched connective
  // never makes an otherwise faithful rewrite fail.
  const measured = new Map();
  for (const clause of kept) {
    const match = bestEntryMatch(clause.text, own);
    if (match.entry === null || match.score < PROFILE_COMPOSE_ENTRY_MATCH) continue;
    const key = String(match.entry.id ?? match.entry.text);
    measured.set(key, (measured.get(key) ?? 0) + composeLength(clause.text));
  }
  const lengths = [];
  let maxRatio = 0;
  for (const entry of own) {
    const key = String(entry.id ?? entry.text);
    const produced = measured.get(key) ?? 0;
    if (produced === 0) continue;
    const source = composeLength(entry.text);
    const budget = composeLengthBudget(entry.text);
    const ratio = source === 0 ? 0 : produced / source;
    maxRatio = Math.max(maxRatio, ratio);
    lengths.push({ text: cleanText(entry.text), source, produced, budget, ratio });
    if (produced > budget) {
      return { ok: false, reason: 'length', text: rebuilt, dropped, merges, lengths, maxRatio };
    }
  }
  // Hard fidelity: the numbers/dates, the negation set, the subject and the condition phrases may
  // never change (keywords are only the omission risk below, never a proof of fidelity).
  const fidelity = composeFidelityVerdict({ text: rebuilt, entries: own });
  if (fidelity.ok !== true) {
    return {
      ok: false,
      reason: 'fidelity',
      detail: fidelity.reason,
      entry: fidelity.entry,
      token: fidelity.token,
      text: rebuilt,
      dropped,
      merges,
      lengths,
      maxRatio,
    };
  }
  // Deterministic AFFECT guard (no model): the same object may not flip to the opposite attitude,
  // and a source sign may not vanish for that object. No polarity word or no object → no inference.
  const antonym = composeAntonymVerdict({ text: rebuilt, entries: own });
  if (antonym.ok !== true) {
    return {
      ok: false,
      reason: 'fidelity',
      detail: 'antonym',
      group: antonym.group,
      object: antonym.object,
      source: antonym.source,
      rewritten: antonym.rewritten,
      text: rebuilt,
      dropped,
      merges,
      lengths,
      maxRatio,
    };
  }
  // INFLATION check only: a phrase may become a complete sentence (hence the short-source
  // allowance), but the rewrite may not pad the concatenated sources beyond 1.2×. Nothing is ever
  // deleted from the rewrite to satisfy this ratio.
  const sourceChars = own.reduce((sum, entry) => sum + composeLength(entry?.text), 0);
  const totalBudget = Math.max(
    Math.ceil(sourceChars * PROFILE_COMPOSE_TOTAL_RATIO),
    sourceChars + PROFILE_COMPOSE_SHORT_ENTRY_SLACK,
  );
  const rebuiltChars = composeLength(rebuilt);
  if (sourceChars > 0 && rebuiltChars > totalBudget) {
    return {
      ok: false,
      reason: 'length',
      total: { source: sourceChars, produced: rebuiltChars, budget: totalBudget },
      text: rebuilt,
      dropped,
      merges,
      lengths,
      maxRatio,
    };
  }
  // Omission RISK (not a proof): every real entry should keep at least one of its keywords. A miss
  // is reported so the semantic cross-check can decide; it is never used to delete or to fail here.
  const rebuiltKey = composeKey(rebuilt);
  const omitted = own
    .filter((entry) => composeLength(entry?.text) >= PROFILE_COMPOSE_COVERAGE_MIN_CHARS)
    .filter((entry) => {
      const keywords = composeKeywords(entry?.text);
      return keywords.length > 0 && !keywords.some((keyword) => rebuiltKey.includes(keyword));
    })
    .map((entry) => cleanText(entry?.text));
  return {
    ok: true, text: rebuilt, dropped, merges, lengths, maxRatio, omitted, risk: omitted.length > 0,
  };
}


/**
 * Deterministic prose fallback: the SAME entries, re-ordered by category (the side's preset order,
 * then first-seen) and completed into full sentences — a phrase that lacks a terminator gets 「。」
 * so the fallback never joins bare phrases with a semicolon. Sentences are grouped by category into
 * at most `PROFILE_COMPOSE_MAX_PARAGRAPHS` paragraphs, so the box always reads as prose.
 */
export function composeFallbackText(entries = [], side = 'user') {
  const which = side === 'agent' ? 'agent' : 'user';
  const rows = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const body = cleanText(normalizeReclassifyText(entry?.text, which)).replace(/[。！？!?；;…，,、\s]+$/u, '');
    if (body.length === 0) continue;
    rows.push({ sentence: `${body}。`, category: cleanText(entry?.category) });
  }
  if (rows.length === 0) return '';
  const presetOrder = PROFILE_CATEGORY_PRESETS
    .filter((preset) => preset.parent === which)
    .map((preset) => categoryKey(preset.name));
  const rank = (category) => {
    const index = presetOrder.indexOf(categoryKey(category));
    return index < 0 ? presetOrder.length : index;
  };
  const sorted = rows
    .map((row, index) => ({ ...row, index }))
    .sort((left, right) => rank(left.category) - rank(right.category) || left.index - right.index);
  // Group the complete sentences by category; more categories than the paragraph ceiling collapse
  // into one paragraph, never into a per-line list.
  const groups = [];
  for (const row of sorted) {
    const last = groups[groups.length - 1];
    if (last !== undefined && categoryKey(last.category) === categoryKey(row.category)) last.sentences.push(row.sentence);
    else groups.push({ category: row.category, sentences: [row.sentence] });
  }
  if (groups.length > PROFILE_COMPOSE_MAX_PARAGRAPHS) {
    return groups.flatMap((group) => group.sentences).join('');
  }
  return groups.map((group) => group.sentences.join('')).join('\n');
}


/**
 * Markdown → plain prose for a text box that is about to be written. Existing boxes may already
 * contain `- `/`* `/`1. `/`· ` items and inline `**`/backticks; a rewrite must not copy that
 * presentation. Every line keeps its CONTENT (dropping a marker never drops the sentence): the
 * sentence is completed with 「。」 when it has no terminator and consecutive lines are merged into
 * a paragraph, so a "one item per line" residue ends up as prose. The compiled section's heading,
 * `[分类]` prefix and `（C=…, E=…）` decoration are display-only and dropped as well.
 */
export function ensurePlainProse(value) {
  const paragraphs = [];
  let current = [];
  const flush = () => {
    if (current.length === 0) return;
    paragraphs.push(current
      .map((line) => (/[。！？!?…]$/u.test(line) ? line : `${line}。`))
      .join(''));
    current = [];
  };
  for (const raw of String(value ?? '').replace(/\r\n?/gu, '\n').split('\n')) {
    let line = cleanText(raw);
    if (line.length === 0) {
      flush();
      continue;
    }
    line = line.replace(/^#{1,6}\s*/u, '').trim();
    line = line.replace(COMPOSE_LIST_MARKER, '').trim();
    line = line.replace(/^\[[^\]\n]{1,20}\]\s*/u, '').trim();
    line = line.replace(/[（(]\s*C\s*=\s*\d+\s*[,，]\s*E\s*=\s*\d+\s*[）)]\s*$/iu, '').trim();
    line = line.replace(/(\*\*|__|`+|~~|\*)/gu, '').trim();
    if (line.length === 0) continue;
    current.push(line);
  }
  flush();
  if (paragraphs.length === 0) return '';
  // More paragraphs than the ceiling collapse into one: always prose, never a list.
  if (paragraphs.length > PROFILE_COMPOSE_MAX_PARAGRAPHS) return paragraphs.join('');
  return paragraphs.join('\n');
}


/**
 * The prompt the compose step sends: the selected fragments plus the user's existing tone. The
 * agent writes 1–3 natural paragraphs of complete sentences; it may merge/dedupe wording but must
 * not add or drop a fragment and must stay close to the original wording. A throw/empty/invalid
 * result makes the caller fall back to the source sentences (never the rewrite).
 */
export function buildComposePrompt({
  side = 'agent',
  entries = [],
  tone = '',
  maxChars = PROFILE_PROMPT_BUDGET_TOKENS,
} = {}) {
  const label = side === 'user' ? '用户画像' : '助手人设';
  const limit = positiveInt(maxChars, PROFILE_PROMPT_BUDGET_TOKENS);
  const lines = (Array.isArray(entries) ? entries : [])
    .map((entry) => `- [${cleanText(entry.category) || '未分类'}] ${cleanText(entry.text)}`)
    .join('\n');
  return [
    `把下面的${label}碎片写成 1–${PROFILE_COMPOSE_MAX_PARAGRAPHS} 个自然段，像人说话那样用通顺的完整句子表达。`,
    '写法要求：',
    '- 同类信息合并成完整句子，句子之间用逗号、分号、句号自然衔接，例如「你说话温柔自然，略带撒娇感；解释问题时会耐心说明。」；',
    `- 禁止列表：不得逐条换行列举，段首不得出现「-」「*」「·」或数字编号，不得一行一条地罗列；最多 ${PROFILE_COMPOSE_MAX_PARAGRAPHS} 段，每段都必须是完整句子；`,
    '- 信息不丢：保留原句的结论、条件和否定（「并非讨厌」不等于「喜欢」），不得改写事实、数字、时间或条件，不得新增或删除任何一条倾向，尽量沿用原句措辞；',
    '- 不添加同义铺陈：同一件事只说一次，不重复解释、不扩写、不写「也亲近这种口吻」这类回声；',
    '- 不写评价性或元话语（「对…期待比较明显」「一定程度」「比较明显」「这说明…」），只写事实本身；',
    `- 膨胀检查：总长度不超过原碎片合计字数的 ${PROFILE_COMPOSE_TOTAL_RATIO} 倍，也不超过 ${limit} 字（含标点）；超出视为铺陈，整段重写会被丢弃；`,
    `- 口吻：${side === 'user' ? '一律第三人称「用户……」，不得出现「我/我们/我的/咱/咱们」' : '一律第二人称「你……」，不得用「用户」指代'}；引号里的原话保持原样。`,
    '- 不要出现分数、C/E、分类标签或任何标题；尽量延续用户已有文本的语气与称呼，但不要照抄无关内容。',
    `碎片：\n${lines.length > 0 ? lines : '（无）'}`,
    cleanText(tone).length > 0 ? `用户已有文本（仅供语气参考）：\n${cleanText(tone)}` : '用户已有文本：无。',
    '只输出重写后的正文，直接分段。',
  ].join('\n');
}


const COMPOSE_VERIFY_SYSTEM = '你是人设提示词核对器。只输出约定的 JSON，不解释，不输出分数或任何 0-100 的数值。';


/**
 * The one semantic cross-check of a rewrite: the model compares the produced paragraph with the
 * source entries and answers whether a fact was added/dropped or an attitude/condition changed.
 * Wording, merging and sentence order are explicitly not problems.
 */
export function buildComposeVerifyPrompt({ side = 'agent', entries = [], text = '' } = {}) {
  const which = side === 'user' ? '用户画像' : '助手人设';
  const sources = (Array.isArray(entries) ? entries : [])
    .map((entry, index) => `${index + 1}. ${cleanText(entry?.text)}`)
    .join('\n');
  return [
    `下面是${which}的来源条目，以及一段把它们写成的正文。请核对正文是否忠实于来源。`,
    '只关注四件事：',
    '- 是否新增了来源里没有的事实、数字、时间、地点或人物；',
    '- 是否漏掉了某条来源的结论、条件或否定；「并非讨厌」写成「喜欢」也算改变了态度，反过来同样不允许；',
    '- 是否改变了「谁、对什么、持什么态度、在什么条件下、范围（只有/通常/偶尔）」；「喜欢无糖茶」写成「讨厌无糖茶」、「喜欢甜食但不喜欢辣食」把两种态度对调，都算改变；',
    '- 是否把有条件的说法写成了无条件（「学习时」写成「工作时」也一样），或把无条件写成了有条件。',
    '改写措辞、合并同类信息、调整句序都不算问题。',
    '只输出一个 JSON 对象：{"ok":true|false,"issues":["一句话"]}；无法确定时输出 {"ok":false,"issues":["不确定"]}。',
    `来源条目：\n${sources.length > 0 ? sources : '（无）'}`,
    `正文：\n${cleanText(text)}`,
  ].join('\n');
}


/**
 * Verify output → `{ok, issues}`. `ok` is `true`/`false` only when the model clearly decided;
 * anything unparseable or ambiguous is `null` (uncertain), which the caller treats as "keep the
 * source sentences". The verifier never edits text.
 */
export function parseComposeVerify(value) {
  let payload = value;
  if (typeof value === 'string') {
    try {
      payload = parseJsonPayload(value, 'profile compose verify: model returned non-JSON text');
    } catch {
      return { ok: null, issues: [] };
    }
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: null, issues: [] };
  }
  const issues = (Array.isArray(payload.issues) ? payload.issues : [])
    .map((issue) => cleanText(typeof issue === 'string' ? issue : issue?.text ?? issue?.reason ?? ''))
    .filter((issue) => issue.length > 0);
  const raw = payload.ok ?? payload.valid ?? payload.faithful ?? payload.same;
  if (typeof raw !== 'boolean') return { ok: null, issues };
  return { ok: raw, issues };
}


/** Compose output → plain prompt text; an empty answer throws so the caller can fall back. */
export function parseComposeText(value, details = null) {
  const text = String(value ?? '')
    .replace(/^```(?:markdown|md|text)?/iu, '')
    .replace(/```$/u, '')
    .trim();
  if (text.length === 0) {
    const scene = details !== null && typeof details === 'object' ? details : null;
    const error = new Error(scene === null
      ? 'profile compose: model returned no text (EMPTY_TEXT)'
      : `profile compose: model returned no text (EMPTY_TEXT) ${JSON.stringify(scene)}`);
    error.code = 'EMPTY_TEXT';
    if (scene !== null) error.details = scene;
    throw error;
  }
  return text;
}

export {
  PROFILE_COMPOSE_CROSS_SIDE_SIMILARITY,
  PROFILE_COMPOSE_ENTRY_MATCH,
  composeKey,
  composeLength,
  composeGrams,
  composeClauses,
  COMPOSE_LIST_MARKER,
  COMPOSE_SENTENCE_END,
  normalizeComposeProse,
  composePresentationReason,
  COMPOSE_STOPWORDS,
  COMPOSE_ARABIC_NUMBER,
  COMPOSE_CJK_NUMBER,
  COMPOSE_CJK_DIGITS,
  COMPOSE_NEGATIONS,
  composeNumberTokens,
  composeNegationTokens,
  COMPOSE_SCENE_WORDS,
  composeSceneTokens,
  composeFillerReason,
  COMPOSE_NEGATION,
  COMPOSE_CONDITION,
  COMPOSE_SUBJECT,
  COMPOSE_CLAUSE_END,
  composePolarity,
  composeConditionPhrases,
  composeConditionTokens,
  composeConditionVerdict,
  composeSubject,
  composeSubjectRole,
  composeObject,
  COMPOSE_POLARITY_LEXICON,
  COMPOSE_POLARITY_GUARD,
  composePolarityHits,
  COMPOSE_POLARITY_SPLIT,
  composePolarityClauses,
  composePolarityObject,
  composePolaritySignMap,
  composeLengthBudget,
  bestEntryMatch,
  COMPOSE_VERIFY_SYSTEM,
};
