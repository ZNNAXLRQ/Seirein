/**
 * Personal lexicon — stage 1: candidate extraction and the confirmation data model (pure module).
 *
 * The user's fixed rules (2026-11-08):
 *   candidate → confirm → effective
 *   sources: the user's own utterances + explicit corrections ("不是甲，是乙");
 *   an ordinary transcript only ever produces a CANDIDATE — never a trusted answer;
 *   a confirmed entry stores the correct spelling + the misrecognised forms + sources;
 *   when the speaker is not confirmed the word belongs to the unassigned area and is not a
 *   personal lexicon entry; confirmed words can be listed, modified and deleted.
 *
 * This file is the data model for that pipeline. It is deliberately NOT wired to the host:
 *   - no file, database, network or event access; the state is a plain JSON object the caller owns;
 *   - no clock read except the `now` argument (default: the current instant at call time);
 *   - no ASR/TTS/Memory/Profile/vision import and no `index.js` import.
 *
 * Trust rules:
 *   - an explicit correction (`explicit === true`) becomes kind `correction`; its `wrong` is a
 *     misrecognised form and it is assigned only when the correction names a confirmed speaker;
 *   - an ordinary transcript becomes kind `proper-noun`, always `assigned:false` and
 *     `speakerId:null`, even when the utterance carries a speakerId: a transcript cannot prove
 *     who the word belongs to. It needs `threshold` (default 2) observed occurrences;
 *   - both kinds are still CANDIDATES. Only `confirmCandidate()` with a speakerId makes an entry
 *     effective, and only `listEntries()` returns effective entries.
 *
 * Correction tightening: only a word-form/reading correction ("不是小满，是向晚" with 写法/读作/…
 * or two short name-shaped sides), a unique target and a confirmed speaker may take effect. A
 * fact correction ("不是周五，是周六", "不是3个，是4个") is returned as kind `fact-correction`
 * with `ignored:true` and a reason; it never enters the lexicon. Every correction entry carries a
 * replacement `context` ({before, after}), and `applyCorrection()` refuses to replace anything
 * when that context does not match — there is no whole-text replacement.
 *
 * Normalization: `lexiconKey` is NFKC + case fold + whitespace removal. The requested
 * `shared/host-text.js` does not exist in this checkout (the shared text module is
 * `shared/text.js`), and neither it nor `memory-normalize.js` exports a width/case/space fold
 * (memory-normalize handles pronouns and dates), so the three name-specific operations live here
 * instead of importing date/pronoun logic that does not apply to a name.
 *
 * Extraction is a deterministic heuristic (no model call): titles 《…》, naming cues (叫/昵称…),
 * name-shaped Han words (a common surname + given name, or a 小/老/阿 nickname), Latin terms /
 * acronyms and katakana runs. Mentions are counted after normalization, and a form found in one
 * of those shapes also counts later plain mentions of the same form. This is precision-first,
 * not NER: bare Chinese common nouns are not guessed, and the stoplists below are guards against
 * obvious false candidates, not a dictionary. All of it can be replaced by a real extractor later
 * without changing the state model.
 *
 * Mutation contract: the state is a plain object created by `createLexiconState()`; mutators edit
 * it in place and return `{ok, ...}`; list functions return fresh copies. `JSON.stringify(state)`
 * is the persistence format (this module never reads or writes it). Rejected entries stay as
 * tombstones so re-extraction cannot silently resurrect them; `removeEntry()` deletes the row.
 *
 * Stage-1 wiring shape (the host is NOT wired yet):
 *
 *   const state = createLexiconState();
 *   mergeCandidates(state, extractLexiconCandidates({ utterances, corrections }));
 *   confirmCandidate(state, { text: '向晚', speakerId: 'spk-1', canonical: '向晚' });
 *   listEntries(state);    // effective words
 *   listUnassigned(state); // reviewed but not yet a personal word
 */

export const LEXICON_STATE_VERSION = 1;

export const LEXICON_DEFAULTS = Object.freeze({
  threshold: 2,
  maxTextChars: 40,
  contextWindow: 4,
});

/** Upper bound for a stored replacement context, so one entry cannot carry a whole sentence. */
const CONTEXT_MAX_CHARS = 16;

export const LEXICON_KINDS = Object.freeze({
  PROPER_NOUN: 'proper-noun',
  CORRECTION: 'correction',
});

export const LEXICON_STATUS = Object.freeze({
  CANDIDATE: 'candidate',
  CONFIRMED: 'confirmed',
  REJECTED: 'rejected',
});

const KIND_PROPER_NOUN = LEXICON_KINDS.PROPER_NOUN;
const KIND_CORRECTION = LEXICON_KINDS.CORRECTION;
const STATUS_CANDIDATE = LEXICON_STATUS.CANDIDATE;
const STATUS_CONFIRMED = LEXICON_STATUS.CONFIRMED;
const STATUS_REJECTED = LEXICON_STATUS.REJECTED;

// ---- heuristic word lists -------------------------------------------------
// A small, deliberately conservative guard. These are not claims about Chinese names; they
// only keep the frequent function words / time words / ordinary nouns from becoming candidates.

/** The most frequent Chinese surnames; a 2–3 character segmented word starting with one is name-shaped. */
const HAN_SURNAMES = new Set([
  ...'王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤',
]);

/** Nickname prefixes: 小满, 老张, 阿杰. */
const NICKNAME_PREFIXES = new Set(['小', '老', '阿']);

/** Lexical words that pass the shape test but are not personal names. */
const HAN_NAME_BLOCKED = new Set(`
  高兴 高级 高中 高考 高手 高山 高温 高价 高速 马路 马车 马甲 黄色 黄金 白天 白云 明白
  王子 王国 国王 王牌 李子 张力 张开 张罗 陈旧 陈述 阳光 阳台 杨梅 杨柳 朱红 朱砂
  何必 何况 许多 许可 谢谢 感谢 严重 严格 严肃 颜色 项目 项链 方向 方法 方面 方式
  方案 房间 房子 房东 放松 石头 石油 时间 时候 时常 温柔 温暖 温度 安全 安静 安排
  安心 成功 成长 成为 成语 江湖 江水 江面 夏天 夏季 节目 节日 节约 花朵 花园 花钱
  山谷 山水 山头 火车 车站 车子 段落 阶段 雷雨 雷声 毛病 毛巾 文章 文化 文学 文明
  文字 常常 常见 家庭 家长 家具 方便 复习 复制 范围 关于 关注 关闭 关心 关系 顾客
  钱包 钟表 钟头 陆地 陆续 任务 任何 程度 程序 工程 课程 过程 陶瓷 陶醉 贺卡 祝贺
  孔雀 孔子 向导 向前 汤圆 鸡汤 武器 武术 莫非 莫名 林子 常识
  白酒 白纸 白菜 白饭 白水 白发 白领 白板 黄瓜 黄昏 黄土 黄油 高楼 高原 高音 高个
  高个子 马桶 马虎 马戏 刘海 许久 陈年 陈皮 杨树 苏醒 苏打 丁香 钉子 丁点 分钟
  钟声 闹钟 大陆 陆军 着陆 付费 付出 支付 应付 平方 地方 远方 对方 前方 后方 方才
  江边 江河 手段 片段 龙头 龙虾 史书 史诗 史前 顾问 照顾 回顾 毛毛 羽毛 眉毛 万一
  万分 万岁 千万 金钱 价钱 有钱 严冬 严寒 武力 莫大 汤水 林场 林业 任命 任性 任职
  姜茶 姜片 汪洋 汪汪 模范 规范 示范 金子 金色 金融 金鱼 石桥 钻石 宝石 熊猫
  阿姨 阿胶 阿爸 阿妈 阿拉 阿门 阿司 阿片
`.trim().split(/\s+/u));

/** Function-word / time / measure suffixes: a personal name almost never ends with one. */
const HAN_BAD_TAIL = new Set([
  ...'的了着过吗呢吧啊呀哦嘛啦咯呗嗯哈嘿喂是在有和与及或但而就才也都还又再只把被让给对向从到为以于之其这那哪什么上下里外头天时年月日点分秒一二三四五六七八九十零两来去说看想做要会能可很太最更已经得地个们些每各第初力法式务何度序续间重格部件物品种样款条片块台架艘用',
]);

/** Very common English words: capitalisation alone must not make them a name. */
const LATIN_STOP = new Set(`
  i a an the this that these those there here they them their we us our you your he him his
  she her it its and but or nor so if then than when while what which who whom whose why how
  where yes no not ok okay oh ah eh um umm hmm hi hello hey bye thanks thank please sorry today
  tomorrow yesterday tonight now later maybe perhaps also just very really actually basically
  well anyway however because since though although still even only much many more most some any
  all both each every other another same different good great nice bad new old big small first
  last next one two three do does did done is are am was were be been being have has had can
  could will would shall should may might must let lets don't i'm i've it's that's what's id ids
`.trim().split(/\s+/u));

/** Complements by a naming cue: "叫什么名字" must not become a name. */
const CUE_NAME_BLOCKED = new Set([
  '什么', '啥', '名字', '小名', '大名', '我们', '你们', '他们', '她们', '它们', '大家', '自己',
  '别人', '我', '你', '他', '她', '它', '谁', '这个', '那个', '哪个', '这些', '那些',
]);

// ---- patterns -------------------------------------------------------------

const TITLE_RE = /[《〈]([^》〉\n]{1,60})[》〉]/gdu;

const CUE_RE = /(?:叫做?|名叫|名字(?:是|叫)|昵称(?:是|叫)|网名(?:是|叫)|笔名(?:是|叫)|艺名(?:是|叫)|(?<![a-z0-9])id\s*(?:是|为|叫)|账号(?:是|叫|名))\s*[「『《"'“]?\s*([A-Za-z][A-Za-z0-9._'’\-]{0,23}|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー・]{2,4})/gdu;

const HAN_WORD_RE = /^[\p{Script=Han}]{2,4}$/u;

const KATAKANA_RE = /[\p{Script=Katakana}ー・]{2,}/gdu;

// ICU groups 小满/老张 but not every 阿X nickname (阿杰 can arrive as 阿|杰), so a tiny
// two-character fallback keeps that common nickname shape. 阿姨/阿胶/… are blocked above.
const A_NICKNAME_RE = /阿[\p{Script=Han}]/gdu;

const LATIN_PHRASE_RE = /\b[A-Z][A-Za-z0-9]*(?:[._'’\-][A-Za-z0-9]+)*(?:[ \t]+[A-Z][A-Za-z0-9]*(?:[._'’\-][A-Za-z0-9]+)*)+\b/gdu;

const LATIN_TOKEN_RE = /\b[A-Za-z][A-Za-z0-9]*(?:[._'’\-][A-Za-z0-9]+)*\b/gdu;

const ASCII_ALNUM_RE = /[a-z0-9]/u;
const WHITESPACE_RE = /\s/u;

/**
 * Han word segmentation for the bare-name heuristic. ICU is part of Node, so no dependency and
 * no I/O; the module stays usable without a model. If the platform lacks it, cue/title/Latin
 * extraction still works and bare Han names are simply not guessed.
 */
const SEGMENTER = typeof Intl?.Segmenter === 'function'
  ? new Intl.Segmenter('zh-CN', { granularity: 'word' })
  : null;

// ---- normalization --------------------------------------------------------

/** Strip surrounding quotes/brackets and sentence punctuation, keeping the written form. */
function cleanForm(value) {
  if (typeof value !== 'string') return '';
  let text = value.trim();
  let previous = null;
  while (previous !== text && text.length > 0) {
    previous = text;
    text = text.replace(/^[「『《〈"'“‘]+/u, '')
      .replace(/[」』》〉"'”’]+$/u, '')
      .replace(/[。！？；，、!?;,：:.…]+$/u, '')
      .trim();
  }
  return text;
}

/**
 * Formatting-insensitive identity of a lexicon form: NFKC (full/half width), case fold and
 * whitespace removal. A hyphen/dot is significant, so 「GPT-4」 and 「GPT4」 stay distinct.
 * @param {unknown} value
 * @returns {string}
 */
export function lexiconKey(value) {
  return cleanForm(value).normalize('NFKC').replace(/\s+/gu, '').toLowerCase();
}

/** A usable candidate display form; short/oversized fragments are not names. */
function usableDisplay(value, maxChars) {
  const text = cleanForm(value);
  const length = [...text].length;
  if (length < 2 || length > maxChars) return '';
  return text;
}

/** One instant from a Date / epoch ms / ISO string; invalid input falls back. */
function instant(value, fallback) {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : fallback;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : fallback;
  }
  return fallback;
}

function isoOf(value, fallbackMs) {
  return new Date(instant(value, fallbackMs)).toISOString();
}

function normalizeSpeaker(value) {
  if (typeof value === 'string') {
    const text = value.trim();
    return text.length === 0 ? null : text;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

// ---- projections ----------------------------------------------------------
// Every heuristic runs on a normalized projection, but the source text is preserved for the
// candidate's display form. `map` takes a projection index back to a raw UTF-16 offset, so the
// same occurrence found by two heuristics is de-duplicated by `key@rawStart` instead of counting
// twice (e.g. a title plus the segmented word inside it).

function project(raw, { lower = false } = {}) {
  let text = '';
  const map = [];
  let rawIndex = 0;
  for (const char of raw) {
    let piece = char.normalize('NFKC');
    if (lower) piece = piece.toLowerCase();
    for (let offset = 0; offset < piece.length; offset += 1) map.push(rawIndex);
    text += piece;
    rawIndex += char.length;
  }
  map.push(raw.length);
  return { text, map };
}

/** NFKC/lowercase projection with all whitespace removed: seed matching ignores spacing. */
function squash(projection) {
  let text = '';
  const map = [];
  for (let index = 0; index < projection.text.length; index += 1) {
    const char = projection.text[index];
    if (WHITESPACE_RE.test(char)) continue;
    text += char;
    map.push(projection.map[index]);
  }
  map.push(projection.map[projection.text.length] ?? 0);
  return { text, map };
}

function rawSlice(utterance, projection, start, end) {
  const from = projection.map[start] ?? utterance.raw.length;
  const to = projection.map[end] ?? utterance.raw.length;
  return utterance.raw.slice(from, Math.max(from, to));
}

function projectUtterance(utterance, index, nowMs) {
  if (utterance === null || typeof utterance !== 'object') return null;
  const raw = typeof utterance.text === 'string' ? utterance.text : '';
  if (raw.trim().length === 0) return null;
  const folded = project(raw, { lower: true });
  const nfkc = project(raw, { lower: false });
  const atMs = instant(utterance.at, nowMs);
  const rawId = utterance.id === null || utterance.id === undefined ? '' : String(utterance.id);
  return {
    id: rawId.length === 0 ? `utterance-${index}` : rawId,
    raw,
    folded,
    nfkc,
    squashed: squash(folded),
    at: new Date(atMs).toISOString(),
    atMs,
  };
}

// ---- candidate extraction -------------------------------------------------

/** Is a Han word name-shaped by the stage-1 heuristic? */
function nameShaped(word) {
  if (HAN_NAME_BLOCKED.has(word)) return false;
  if (word.length === 0) return false;
  const last = word[word.length - 1];
  if (HAN_BAD_TAIL.has(last)) return false;
  if (NICKNAME_PREFIXES.has(word[0])) return true;
  return word.length <= 3 && HAN_SURNAMES.has(word[0]);
}

/** Does a Latin token carry a proper-noun/term signal? */
function latinTokenWanted(token, maxChars) {
  const length = [...token].length;
  if (length < 2 || length > maxChars) return false;
  const lower = token.toLowerCase();
  if (LATIN_STOP.has(lower)) return false;
  // A capital letter is the main signal (Seirein, VOCALOID, VTube, Node.js).
  if (/[A-Z]/u.test(token)) return true;
  // Mixed letters+digits are technical terms (gpt4, mp3), except version-like v1.2.
  if (/[0-9]/u.test(token) && /[A-Za-z]/u.test(token) && !/^v\d/iu.test(token)) return true;
  return false;
}

function addMention(mentions, utterance, key, text, rawStart) {
  if (key.length === 0 || text.length === 0) return;
  const id = `${key}@${rawStart}`;
  if (mentions.has(id)) return;
  mentions.set(id, { key, text, rawStart, at: utterance.at, atMs: utterance.atMs });
}

/**
 * All direct mentions of one utterance, plus every form that should also be searched in the
 * rest of the batch (a name introduced once can be repeated plainly later).
 */
function collectDirectMentions(utterance, maxChars) {
  const mentions = new Map();
  const seeds = new Map();

  const addFound = (value, rawStart) => {
    const text = usableDisplay(value, maxChars);
    if (text.length === 0) return;
    const key = lexiconKey(text);
    if (key.length === 0) return;
    addMention(mentions, utterance, key, text, rawStart);
    if (!seeds.has(key)) seeds.set(key, { key, text });
  };

  // 《work title》 / 〈work title〉
  for (const match of utterance.folded.text.matchAll(TITLE_RE)) {
    const content = cleanForm(match[1]);
    if (content.length === 0 || [...content].length > maxChars) continue;
    const [start, end] = match.indices[1];
    // cleanForm trims leading spaces/quotes; anchor the occurrence where the cleaned form
    // starts, otherwise the seed scan below would count the same mention a second time.
    let anchor = start;
    while (anchor < end && /[\s「『《〈"'“‘]/u.test(utterance.folded.text[anchor])) anchor += 1;
    const display = cleanForm(rawSlice(utterance, utterance.folded, start, end)) || content;
    addFound(display, utterance.folded.map[anchor] ?? utterance.raw.length);
  }

  // Naming cues: 她叫小满 / 昵称是向晚 / ID 是 …
  for (const match of utterance.folded.text.matchAll(CUE_RE)) {
    const content = cleanForm(match[1]);
    if (content.length === 0 || CUE_NAME_BLOCKED.has(content) || /^(?:什么|啥)/u.test(content)) continue;
    if ([...content].length > maxChars) continue;
    const [start, end] = match.indices[1];
    const display = cleanForm(rawSlice(utterance, utterance.folded, start, end)) || content;
    addFound(display, utterance.folded.map[start] ?? utterance.raw.length);
  }

  // A bare Han name: 向晚今天来了 / 我见过向晚 / 小满来了
  if (SEGMENTER !== null) {
    for (const segment of SEGMENTER.segment(utterance.folded.text)) {
      if (segment.isWordLike !== true) continue;
      const word = segment.segment;
      if (!HAN_WORD_RE.test(word) || !nameShaped(word)) continue;
      if ([...word].length > maxChars) continue;
      const start = segment.index;
      const end = segment.index + word.length;
      const display = cleanForm(rawSlice(utterance, utterance.folded, start, end)) || word;
      addFound(display, utterance.folded.map[start] ?? utterance.raw.length);
    }
  }

  // Katakana names/terms (初音ミク is not split for us; ミク still carries the name signal).
  for (const match of utterance.folded.text.matchAll(KATAKANA_RE)) {
    const content = cleanForm(match[0]);
    if (content.length === 0 || [...content].length > maxChars) continue;
    const display = cleanForm(rawSlice(utterance, utterance.folded, match.index, match.index + match[0].length)) || content;
    addFound(display, utterance.folded.map[match.index] ?? utterance.raw.length);
  }

  // 阿杰 / 阿明: only when the two-character word is still name-shaped.
  for (const match of utterance.folded.text.matchAll(A_NICKNAME_RE)) {
    const word = match[0];
    if (!HAN_WORD_RE.test(word) || !nameShaped(word)) continue;
    const start = match.index;
    const display = cleanForm(rawSlice(utterance, utterance.folded, start, start + word.length)) || word;
    addFound(display, utterance.folded.map[start] ?? utterance.raw.length);
  }

  // Capitalized Latin phrases first, then single terms outside those spans.
  const phraseSpans = [];
  for (const match of utterance.nfkc.text.matchAll(LATIN_PHRASE_RE)) {
    const text = cleanForm(match[0]);
    const words = text.split(/[ \t]+/u).filter((word) => word.length > 0);
    if (words.length < 2) continue;
    if (words.every((word) => LATIN_STOP.has(word.toLowerCase()))) continue;
    if (text.length === 0 || [...text].length > maxChars) continue;
    const start = match.index;
    const end = match.index + match[0].length;
    phraseSpans.push([start, end]);
    const display = cleanForm(rawSlice(utterance, utterance.nfkc, start, end)) || text;
    addFound(display, utterance.nfkc.map[start] ?? utterance.raw.length);
  }
  for (const match of utterance.nfkc.text.matchAll(LATIN_TOKEN_RE)) {
    const token = match[0];
    if (!latinTokenWanted(token, maxChars)) continue;
    const start = match.index;
    const end = start + token.length;
    if (phraseSpans.some(([from, to]) => start >= from && end <= to)) continue;
    const display = cleanForm(rawSlice(utterance, utterance.nfkc, start, end)) || token;
    addFound(display, utterance.nfkc.map[start] ?? utterance.raw.length);
  }

  return { mentions, seeds };
}

/** Occurrences of a seed in one utterance, matched on the whitespace-free projection. */
function findSeedOccurrences(utterance, seed, mentions) {
  const haystack = utterance.squashed.text;
  const key = seed.key;
  if (key.length === 0 || haystack.length < key.length) return;
  const startsAlnum = ASCII_ALNUM_RE.test(key[0]);
  const endsAlnum = ASCII_ALNUM_RE.test(key[key.length - 1]);
  let from = 0;
  while (from <= haystack.length - key.length) {
    const index = haystack.indexOf(key, from);
    if (index === -1) break;
    const before = index > 0 ? haystack[index - 1] : '';
    const after = index + key.length < haystack.length ? haystack[index + key.length] : '';
    const leftOk = !startsAlnum || before.length === 0 || !ASCII_ALNUM_RE.test(before);
    const rightOk = !endsAlnum || after.length === 0 || !ASCII_ALNUM_RE.test(after);
    if (leftOk && rightOk) {
      const rawStart = utterance.squashed.map[index] ?? utterance.raw.length;
      const rawEnd = utterance.squashed.map[index + key.length] ?? utterance.raw.length;
      const display = cleanForm(utterance.raw.slice(rawStart, rawEnd));
      if (display.length > 0) addMention(mentions, utterance, key, display, rawStart);
    }
    from = index + Math.max(1, key.length);
  }
}

/** Per-key count of normal-transcript observations. */
function collectNormalEvidence(projected, direct) {
  const counts = new Map();
  for (let index = 0; index < projected.length; index += 1) {
    const utterance = projected[index];
    for (const mention of direct[index].mentions.values()) {
      let record = counts.get(mention.key);
      if (record === undefined) {
        record = {
          key: mention.key,
          text: mention.text,
          count: 0,
          sourceIds: [],
          sourceSet: new Set(),
          at: mention.at,
          atMs: mention.atMs,
        };
        counts.set(mention.key, record);
      }
      record.count += 1;
      if (!record.sourceSet.has(utterance.id)) {
        record.sourceSet.add(utterance.id);
        record.sourceIds.push(utterance.id);
      }
      if (mention.atMs < record.atMs) {
        record.atMs = mention.atMs;
        record.at = mention.at;
        record.text = mention.text;
      }
    }
  }
  return counts;
}

/** Explicit corrections, already trusted: they do not need the frequency threshold. */
function collectCorrectionEvidence(corrections, { nowMs, maxChars }) {
  const records = new Map();
  for (const correction of corrections) {
    if (correction === null || typeof correction !== 'object') continue;
    // Only a user-explicit correction is high trust; an inferred edit must not enter this lane.
    if (correction.explicit !== true) continue;
    // A fact correction (周五 → 周六) and an unclear fragment are not language rules; a caller
    // that forwards a raw `parseExplicitCorrection` result must not smuggle one into the lexicon.
    if (correction.ignored === true) continue;
    if (correction.kind !== undefined && correction.kind !== KIND_CORRECTION) continue;
    const wrong = cleanForm(correction.wrong);
    const right = cleanForm(correction.right);
    if (wrong.length === 0 || right.length === 0) continue;
    if ([...wrong].length > maxChars || [...right].length > maxChars) continue;
    const key = lexiconKey(right);
    const wrongKey = lexiconKey(wrong);
    if (key.length === 0 || wrongKey.length === 0 || key === wrongKey) continue;
    const ambiguous = correction.ambiguous === true;
    const context = normalizeContext(correction.context);

    const atMs = instant(correction.at, nowMs);
    let record = records.get(key);
    if (record === undefined) {
      record = {
        key,
        text: right,
        wrongForms: [],
        wrongKeys: new Set(),
        sourceIds: [],
        sourceSet: new Set(),
        speakers: new Set(),
        context: null,
        ambiguous: false,
        at: new Date(atMs).toISOString(),
        atMs,
      };
      records.set(key, record);
    }
    if (atMs < record.atMs) {
      record.atMs = atMs;
      record.at = new Date(atMs).toISOString();
      record.text = right;
    }
    if (!record.wrongKeys.has(wrongKey)) {
      record.wrongKeys.add(wrongKey);
      record.wrongForms.push(wrong);
    }
    // One context is enough for the replacement gate; the first correction's context wins.
    if (record.context === null && context !== null) record.context = context;
    if (ambiguous) record.ambiguous = true;
    const correctionId = correction.id ?? correction.sourceId;
    if (correctionId !== null && correctionId !== undefined) {
      const sourceId = String(correctionId);
      if (sourceId.length > 0 && !record.sourceSet.has(sourceId)) {
        record.sourceSet.add(sourceId);
        record.sourceIds.push(sourceId);
      }
    }
    // An ambiguous target is not attributed: uniqueness is part of the confirmation condition.
    if (!ambiguous) {
      const speaker = normalizeSpeaker(correction.speakerId);
      if (speaker !== null) record.speakers.add(speaker);
    }
  }
  return records;
}

/**
 * Extract candidates from a batch of the user's own utterances and explicit corrections.
 *
 * @param {object} [options]
 * @param {Array<{id?: string, text?: string, at?: string|number|Date, speakerId?: string|null,
 *   source?: string}>} [options.utterances] the user's original utterances. `speakerId` is never
 *   used as attribution evidence for an ordinary transcript.
 * @param {Array<{wrong?: string, right?: string, at?: string|number|Date,
 *   speakerId?: string|null, explicit?: boolean, id?: string}>} [options.corrections] explicit
 *   "不是甲，是乙" corrections. Only `explicit:true` is trusted.
 * @param {string|number|Date} [options.now] fallback instant for entries without a time.
 * @param {number} [options.threshold] normal-transcript occurrences needed (default 2, min 1).
 * @param {number} [options.maxTextChars] longest accepted form (default 40 code points).
 * @returns {Array<{text: string, kind: 'proper-noun'|'correction', sourceIds: string[],
 *   wrongForms: string[], speakerId: string|null, assigned: boolean, at: string}>}
 *   Candidates only: nothing here is effective until `confirmCandidate()` is called.
 */
export function extractLexiconCandidates({
  utterances = [],
  corrections = [],
  now = new Date(),
  threshold = LEXICON_DEFAULTS.threshold,
  maxTextChars = LEXICON_DEFAULTS.maxTextChars,
} = {}) {
  const nowMs = instant(now, Date.now());
  const limit = Number.isFinite(threshold) ? Math.max(1, Math.floor(threshold)) : LEXICON_DEFAULTS.threshold;
  const maxChars = Number.isFinite(maxTextChars)
    ? Math.max(2, Math.floor(maxTextChars))
    : LEXICON_DEFAULTS.maxTextChars;

  const projected = (Array.isArray(utterances) ? utterances : [])
    .map((utterance, index) => projectUtterance(utterance, index, nowMs))
    .filter((utterance) => utterance !== null);
  const direct = projected.map((utterance) => collectDirectMentions(utterance, maxChars));

  // A form introduced by a title/cue/name shape counts every later plain mention, so
  // "她叫小满" + "小满今天来了" reaches the same threshold as two explicit mentions.
  const seeds = new Map();
  for (const item of direct) {
    for (const [key, seed] of item.seeds) if (!seeds.has(key)) seeds.set(key, seed);
  }
  for (let index = 0; index < projected.length; index += 1) {
    for (const seed of seeds.values()) {
      findSeedOccurrences(projected[index], seed, direct[index].mentions);
    }
  }

  const normal = collectNormalEvidence(projected, direct);
  const correctionRecords = collectCorrectionEvidence(
    Array.isArray(corrections) ? corrections : [],
    { nowMs, maxChars },
  );

  const candidates = new Map();
  for (const [key, record] of correctionRecords) {
    // A correction is trusted evidence, but a word attributed to two different speakers is not
    // one person's personal word: it stays unassigned rather than silently pick a side. An
    // ambiguous target is not attributed at all, even when the correction carries a speakerId.
    const speakers = [...record.speakers];
    const assigned = !record.ambiguous && speakers.length === 1;
    candidates.set(key, {
      key,
      text: record.text,
      kind: KIND_CORRECTION,
      wrongForms: [...record.wrongForms],
      sourceIds: [...record.sourceIds],
      speakerId: assigned ? speakers[0] : null,
      assigned,
      at: record.at,
      atMs: record.atMs,
      context: record.context,
      ambiguous: record.ambiguous,
    });
  }
  for (const [key, record] of normal) {
    const existing = candidates.get(key);
    if (existing !== undefined) {
      // A plain mention can add evidence to a correction, but never downgrade its trust.
      for (const sourceId of record.sourceIds) {
        if (!existing.sourceIds.includes(sourceId)) existing.sourceIds.push(sourceId);
      }
      if (record.atMs < existing.atMs) {
        existing.atMs = record.atMs;
        existing.at = record.at;
      }
      continue;
    }
    if (record.count < limit) continue;
    candidates.set(key, {
      key,
      text: record.text,
      kind: KIND_PROPER_NOUN,
      wrongForms: [],
      sourceIds: [...record.sourceIds],
      speakerId: null,
      assigned: false,
      at: record.at,
      atMs: record.atMs,
    });
  }

  return [...candidates.values()]
    .sort((left, right) => {
      if (left.atMs !== right.atMs) return left.atMs - right.atMs;
      return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
    })
    .map((candidate) => {
      const output = {
        text: candidate.text,
        kind: candidate.kind,
        sourceIds: candidate.sourceIds,
        wrongForms: candidate.wrongForms,
        speakerId: candidate.speakerId,
        assigned: candidate.assigned,
        at: candidate.at,
      };
      // Replacement context and the ambiguity flag only apply to correction candidates; the
      // proper-noun candidate surface stays the seven fields stage 1 already promised.
      if (candidate.kind === KIND_CORRECTION) {
        output.context = candidate.context ?? null;
        output.ambiguous = candidate.ambiguous === true;
      }
      return output;
    });
}

// ---- explicit correction parser (convenience for callers) -----------------
//
// A "不是甲，是乙" utterance is only a lexicon correction when it names a word form/reading:
//   - form/reading: the object is name-like (person/work/term/acronym/form of address) and either
//     a form cue (写法/读作/叫/名字是/拼写/说的是) is present or both sides are short nouns;
//   - fact: either side is a time/date, quantity, state or action (周五/周六, 3个/4个, 去了/没去)
//     → kind `fact-correction`, ignored: true, reason `fact-correction`; it never enters the
//     lexicon and never becomes a replacement rule;
//   - unclear: neither a fact nor a name-shaped word form → ignored with `no-word-form-cue`.
// A target that is not unique (two 不是…是… in one sentence, or a pronoun side) still becomes a
// candidate, but it is marked `ambiguous` and is never auto-assigned or confirmable.

const CORRECTION_PATTERNS = [
  // 不是小满，是向晚
  /不是\s*([^，,。！？!?；;\n]{1,40}?)\s*[，,]\s*(?:而是|是|应该是|其实是)\s*([^，,。！？!?；;\n]{1,40})/du,
  // 不是小满而是向晚
  /不是\s*([^，,。！？!?；;\n]{1,40}?)\s*(?:而是|是)\s*([^，,。！？!?；;\n]{1,40})/du,
  // 是向晚，不是小满
  /(?:而是|是|应该是|其实是)\s*([^，,。！？!?；;\n]{1,40})\s*[，,]\s*不是\s*([^，,。！？!?；;\n]{1,40})/du,
];

const FORM_CUE_RE = /(?:写法|读法|读音|读作|读成|拼写|拼作|写成|写作|名字(?:是|叫)|名叫|叫做|叫|说的是|指的是|正确(?:的)?(?:写法|读法|拼写))/u;

const PRONOUN_RE = /^(?:这个|那个|哪个|这些|那些|这边|那边|这里|那里|他|她|它|他们|她们|它们|我|你|您|我们|你们|人家|对方)$/u;

const LATIN_NAME_RE = /^[A-Za-z][A-Za-z0-9._'’\-]*(?:[ \t]+[A-Za-z][A-Za-z0-9._'’\-]*)*$/u;
const KATAKANA_NAME_RE = /[\p{Script=Katakana}ー・]{2,}/u;

const WEEKDAY_RE = /(?:周|星期|礼拜)[一二三四五六日天末1-7]/u;
const DATE_RE = /(?:\d{1,4}\s*[年月日号]|[一二三四五六七八九十]{1,3}\s*[月日号]|今天|明天|昨天|前天|后天|今晚|今早|明早|明晚|早上|上午|中午|下午|晚上|凌晨|半夜|现在|刚才|之前|之后|以前|以后|周末|工作日|月底|月初|年底|年初|时间)/u;
const QUANTITY_RE = /(?:\d+|[一二三四五六七八九十百千万两半]+)\s*(?:个|只|次|遍|条|张|份|位|名|本|台|辆|双|套|杯|瓶|斤|公斤|克|米|公里|岁|年|月|天|小时|分钟|分|秒|块|元|毛|件|头|匹|颗|粒|根|支|把|间|栋|层|页|章|节|段|句|字|人|倍|成|折|楼|号|点)/u;
const PURE_NUMBER_RE = /^[一二三四五六七八九十百千万两\d]+$/u;

const ACTION_VERBS = new Set([...'去来走吃看做说买卖写读听睡起坐站跑跳玩学教给拿放开关想要会能在有']);
const ACTION_PHRASES = new Set([
  '喜欢', '讨厌', '知道', '记得', '忘记', '同意', '反对', '开始', '结束', '在家', '出门',
  '上班', '下班', '加班', '休息', '睡觉', '起床', '吃饭', '喝水', '开会', '上课', '放学',
  '回家', '出去', '进来', '可以', '不行', '行', '对的', '错的', '好的', '真的', '假的',
]);
const ACTION_COMBO_RE = /(?:想|要|会|能|敢|肯|喜欢|讨厌|在)(?:去|来|做|说|看|吃|买|走|睡|玩|学)/u;

/** One side of the correction as an action/state phrase (去了 / 没去 / 想去 / 会做). */
function actionLike(value) {
  const text = cleanForm(value);
  if (text.length === 0) return false;
  if (ACTION_PHRASES.has(text)) return true;
  if (ACTION_COMBO_RE.test(text)) return true;
  const core = text.replace(/^(?:不|没|没有|别)/u, '').replace(/(?:了|过|着|完|成|好)$/u, '');
  return [...core].length === 1 && ACTION_VERBS.has(core);
}

/** The fact category of one side, or null when it does not look like a fact. */
function factSide(value) {
  const text = cleanForm(value);
  if (text.length === 0) return null;
  if (WEEKDAY_RE.test(text) || DATE_RE.test(text)) return 'time';
  if (QUANTITY_RE.test(text) || PURE_NUMBER_RE.test(text)) return 'quantity';
  if (actionLike(text)) return 'action';
  return null;
}

/** A short noun-like side with no time/quantity/action phrase and no sentence particle. */
function shortNounLike(value) {
  const text = cleanForm(value);
  const chars = [...text];
  if (chars.length === 0 || chars.length > 8) return false;
  if (factSide(text) !== null || PRONOUN_RE.test(text)) return false;
  if (/[，,。！？!?；;：:、\n]/u.test(text)) return false;
  if (chars.length > 2 && /[的了着过吗呢吧啊呀哦嘛啦]/u.test(text)) return false;
  return true;
}

/** Does one side look like a name / title / term / acronym / form of address? */
function nameClassLike(value, maxChars = LEXICON_DEFAULTS.maxTextChars) {
  const text = cleanForm(value);
  if (text.length === 0) return false;
  if (/[《〈》〉]/u.test(text)) return true;
  if (KATAKANA_NAME_RE.test(text)) return true;
  if (LATIN_NAME_RE.test(text)) return latinTokenWanted(text, maxChars);
  return [...text].length <= 4 && HAN_WORD_RE.test(text) && nameShaped(text);
}

/** The classification that decides whether this correction may become a lexicon rule. */
function classifyCorrection(value, wrong, right, ambiguous) {
  if (factSide(wrong) !== null || factSide(right) !== null) {
    return { kind: 'fact-correction', ignored: true, reason: 'fact-correction' };
  }
  const cue = FORM_CUE_RE.test(value);
  const shortPair = shortNounLike(wrong) && shortNounLike(right);
  const named = nameClassLike(wrong) || nameClassLike(right);
  if ((cue && shortPair) || (named && (cue || shortPair || ambiguous))) {
    return { kind: KIND_CORRECTION, ignored: false };
  }
  return { kind: 'unclear-correction', ignored: true, reason: 'no-word-form-cue' };
}

/** Keep at most `window` characters on each side of a span of the original sentence. */
function contextAround(value, start, end, window = LEXICON_DEFAULTS.contextWindow) {
  const limit = Math.max(1, Math.min(CONTEXT_MAX_CHARS, Math.floor(window)));
  return {
    before: value.slice(Math.max(0, start - limit), start),
    after: value.slice(end, end + limit),
  };
}

/** A stored replacement context; both sides empty means "no context", which is not usable. */
function normalizeContext(value) {
  if (value === null || typeof value !== 'object') return null;
  const before = [...(typeof value.before === 'string' ? value.before : '')]
    .slice(-CONTEXT_MAX_CHARS)
    .join('');
  const after = [...(typeof value.after === 'string' ? value.after : '')]
    .slice(0, CONTEXT_MAX_CHARS)
    .join('');
  if (before.length === 0 && after.length === 0) return null;
  return { before, after };
}

function contextWindowLimit(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return LEXICON_DEFAULTS.contextWindow;
  return Math.max(0, Math.min(CONTEXT_MAX_CHARS, Math.floor(value)));
}

/**
 * Apply a correction entry to one text, but only where the stored context still matches.
 *
 * A replacement is a pure transformation: no state, no clock, no I/O. An entry without a usable
 * `context` is refused (`context-required`) — there is deliberately no whole-text replacement.
 * `contextWindow` is how many stored context characters must match on each side (default 4).
 *
 * @param {unknown} text the transcript to correct
 * @param {{text?: string, canonical?: string, wrongForms?: string[], wrong?: string,
 *   context?: {before?: string, after?: string}}} entry
 * @param {{contextWindow?: number}} [options]
 * @returns {{ok: true, text: string, replaced: number, changed: boolean}
 *   | {ok: false, reason: string, text: string, replaced: 0, changed: false}}
 */
export function applyCorrection(text, entry, { contextWindow = LEXICON_DEFAULTS.contextWindow } = {}) {
  const source = typeof text === 'string' ? text : '';
  const refuse = (reason) => ({ ok: false, reason, text: source, replaced: 0, changed: false });
  if (source.length === 0) return refuse('invalid-text');
  if (entry === null || typeof entry !== 'object') return refuse('invalid-entry');
  const right = cleanForm(entry.canonical) || cleanForm(entry.text) || cleanForm(entry.right);
  const wrongForms = normalizeWrongForms(
    Array.isArray(entry.wrongForms) ? entry.wrongForms : (typeof entry.wrong === 'string' ? [entry.wrong] : []),
  );
  if (right.length === 0) return refuse('canonical-empty');
  if (wrongForms.length === 0) return refuse('wrong-forms-empty');
  const context = normalizeContext(entry.context);
  if (context === null) return refuse('context-required');
  const window = contextWindowLimit(contextWindow);
  if (window < 1) return refuse('context-required');
  const beforeNeed = [...context.before].slice(-window).join('');
  const afterNeed = [...context.after].slice(0, window).join('');
  if (beforeNeed.length === 0 && afterNeed.length === 0) return refuse('context-required');

  const spans = [];
  for (const wrong of wrongForms) {
    let from = 0;
    while (from <= source.length - wrong.length) {
      const start = source.indexOf(wrong, from);
      if (start === -1) break;
      const end = start + wrong.length;
      const beforeOk = beforeNeed.length === 0 || source.slice(0, start).endsWith(beforeNeed);
      const afterOk = afterNeed.length === 0 || source.slice(end).startsWith(afterNeed);
      if (beforeOk && afterOk) spans.push({ start, end });
      from = start + Math.max(1, wrong.length);
    }
  }
  spans.sort((left, rightSpan) => left.start - rightSpan.start || rightSpan.end - left.end);
  let output = '';
  let cursor = 0;
  let replaced = 0;
  for (const span of spans) {
    if (span.start < cursor) continue;
    output += source.slice(cursor, span.start) + right;
    cursor = span.end;
    replaced += 1;
  }
  output += source.slice(cursor);
  return { ok: true, text: output, replaced, changed: replaced > 0 };
}

/**
 * Parse one explicit spoken correction into the `corrections` shape this module consumes.
 * This is a convenience only: extraction never parses utterances on its own, so an ordinary
 * transcript cannot accidentally become a correction.
 *
 * @param {unknown} text one utterance ("不是小满，是向晚")
 * @returns {{wrong: string, right: string, explicit: true, kind: string,
 *   context: {before: string, after: string}, ambiguous: boolean, ignored?: true,
 *   reason?: string}|null}
 */
export function parseExplicitCorrection(text) {
  const value = typeof text === 'string' ? text : '';
  if (value.trim().length === 0) return null;
  for (let index = 0; index < CORRECTION_PATTERNS.length; index += 1) {
    const match = CORRECTION_PATTERNS[index].exec(value);
    if (match === null) continue;
    // The reversed pattern has [right, wrong]; the first two have [wrong, right].
    const reversed = index === 2;
    const wrongSpan = match.indices[reversed ? 2 : 1];
    const wrong = cleanForm(reversed ? match[2] : match[1]);
    const right = cleanForm(reversed ? match[1] : match[2]);
    if (wrong.length === 0 || right.length === 0) continue;
    if (lexiconKey(wrong) === lexiconKey(right)) continue;
    const occurrenceCount = (value.match(/不是/gu) ?? []).length;
    const ambiguous = occurrenceCount > 1 || PRONOUN_RE.test(wrong) || PRONOUN_RE.test(right);
    const verdict = classifyCorrection(value, wrong, right, ambiguous);
    const result = {
      wrong,
      right,
      explicit: true,
      kind: verdict.kind,
      context: contextAround(value, wrongSpan[0], wrongSpan[1]),
      ambiguous,
    };
    if (verdict.ignored) {
      result.ignored = true;
      result.reason = verdict.reason;
    } else if (ambiguous) {
      result.reason = 'ambiguous-target';
    }
    return result;
  }
  return null;
}

// ---- serializable state ---------------------------------------------------

/**
 * A fresh, JSON-serializable lexicon state.
 * @returns {{version: number, nextId: number, entries: object[]}}
 */
export function createLexiconState() {
  return { version: LEXICON_STATE_VERSION, nextId: 1, entries: [] };
}

function entriesOf(state) {
  return state !== null && typeof state === 'object' && Array.isArray(state.entries)
    ? state.entries
    : null;
}

function ensureEntry(entry) {
  if (entry === null || typeof entry !== 'object') return;
  if (typeof entry.text !== 'string') entry.text = '';
  if (typeof entry.key !== 'string' || entry.key.length === 0) entry.key = lexiconKey(entry.text);
  if (entry.kind !== KIND_CORRECTION) entry.kind = KIND_PROPER_NOUN;
  if (![STATUS_CANDIDATE, STATUS_CONFIRMED, STATUS_REJECTED].includes(entry.status)) {
    entry.status = STATUS_CANDIDATE;
  }
  if (typeof entry.canonical !== 'string') entry.canonical = '';
  if (!Array.isArray(entry.wrongForms)) entry.wrongForms = [];
  if (!Array.isArray(entry.sourceIds)) entry.sourceIds = [];
  entry.context = normalizeContext(entry.context);
  entry.ambiguous = entry.ambiguous === true;
  entry.speakerId = normalizeSpeaker(entry.speakerId);
  entry.assigned = entry.assigned === true;
  if (typeof entry.at !== 'string' || entry.at.length === 0) entry.at = new Date(0).toISOString();
  if (typeof entry.confirmedAt !== 'string') entry.confirmedAt = '';
  if (typeof entry.rejectedAt !== 'string') entry.rejectedAt = '';
  if (typeof entry.id !== 'string') entry.id = '';
}

function ensureState(state) {
  const entries = entriesOf(state);
  if (entries === null) return null;
  if (!Number.isSafeInteger(state.version)) state.version = LEXICON_STATE_VERSION;
  if (!Number.isSafeInteger(state.nextId) || state.nextId < 1) state.nextId = 1;
  for (const entry of entries) ensureEntry(entry);
  return entries;
}

function nextEntryId(state) {
  let highest = 0;
  for (const entry of state.entries) {
    const match = /^lex-(\d+)$/u.exec(String(entry?.id ?? ''));
    if (match !== null) highest = Math.max(highest, Number(match[1]));
  }
  const next = Math.max(state.nextId, highest + 1);
  state.nextId = next + 1;
  return `lex-${next}`;
}

function normalizeIds(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const ids = [];
  for (const item of value) {
    if (item === null || item === undefined) continue;
    const id = String(item);
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function normalizeWrongForms(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const forms = [];
  for (const item of value) {
    const form = cleanForm(item);
    const key = lexiconKey(form);
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    forms.push(form);
  }
  return forms;
}

function addSourceIds(entry, ids) {
  for (const id of ids) {
    if (!entry.sourceIds.includes(id)) entry.sourceIds.push(id);
  }
}

function addWrongForms(entry, forms) {
  for (const form of forms) {
    const key = lexiconKey(form);
    if (key.length === 0) continue;
    if (entry.wrongForms.some((existing) => lexiconKey(existing) === key)) continue;
    entry.wrongForms.push(form);
  }
}

function publicEntry(entry) {
  return {
    id: typeof entry.id === 'string' ? entry.id : '',
    text: typeof entry.text === 'string' ? entry.text : '',
    canonical: typeof entry.canonical === 'string' ? entry.canonical : '',
    kind: entry.kind === KIND_CORRECTION ? KIND_CORRECTION : KIND_PROPER_NOUN,
    status: entry.status,
    assigned: entry.assigned === true,
    speakerId: normalizeSpeaker(entry.speakerId),
    wrongForms: Array.isArray(entry.wrongForms) ? [...entry.wrongForms] : [],
    sourceIds: Array.isArray(entry.sourceIds) ? [...entry.sourceIds] : [],
    context: normalizeContext(entry.context),
    ambiguous: entry.ambiguous === true,
    at: typeof entry.at === 'string' ? entry.at : '',
    confirmedAt: typeof entry.confirmedAt === 'string' ? entry.confirmedAt : '',
    rejectedAt: typeof entry.rejectedAt === 'string' ? entry.rejectedAt : '',
  };
}

function findEntry(entries, { text = '', id = undefined } = {}) {
  if (entries === null) return null;
  if (id !== undefined && id !== null) {
    const wanted = String(id);
    const byId = entries.find((entry) => String(entry?.id ?? '') === wanted);
    if (byId !== undefined) return byId;
  }
  const key = lexiconKey(text);
  if (key.length === 0) return null;
  return entries.find((entry) => {
    if (entry === null || typeof entry !== 'object') return false;
    if (entry.key === key) return true;
    return typeof entry.canonical === 'string'
      && entry.canonical.length > 0
      && lexiconKey(entry.canonical) === key;
  }) ?? null;
}

/**
 * Merge extraction output into a state. New keys are added as candidates; existing candidates
 * get the extra source ids / wrong forms / earlier timestamp; a rejected key stays rejected
 * (the tombstone blocks resurrection); a confirmed entry only gains evidence, its canonical
 * spelling and confirmed speaker are never changed by later extraction.
 *
 * @param {{version?: number, nextId?: number, entries?: object[]}} state
 * @param {object|object[]} candidates one or more `extractLexiconCandidates` results
 * @returns {{ok: true, added: number, merged: number, skipped: number}|{ok: false, reason: string}}
 */
export function mergeCandidates(state, candidates) {
  const entries = ensureState(state);
  if (entries === null) return { ok: false, reason: 'invalid-state' };
  const list = Array.isArray(candidates) ? candidates : (candidates ? [candidates] : []);
  const byKey = new Map();
  const byCanonical = new Map();
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object' || typeof entry.key !== 'string') continue;
    if (!byKey.has(entry.key)) byKey.set(entry.key, entry);
    if (typeof entry.canonical === 'string' && entry.canonical.length > 0) {
      const canonicalKey = lexiconKey(entry.canonical);
      if (canonicalKey.length > 0 && !byCanonical.has(canonicalKey)) {
        byCanonical.set(canonicalKey, entry);
      }
    }
  }

  let added = 0;
  let merged = 0;
  let skipped = 0;
  for (const candidate of list) {
    if (candidate === null || typeof candidate !== 'object') continue;
    const text = cleanForm(candidate.text);
    const key = lexiconKey(text);
    if (key.length === 0) continue;
    const kind = candidate.kind === KIND_CORRECTION ? KIND_CORRECTION : KIND_PROPER_NOUN;
    const speakerId = kind === KIND_CORRECTION ? normalizeSpeaker(candidate.speakerId) : null;
    const incoming = {
      text,
      kind,
      speakerId,
      wrongForms: kind === KIND_CORRECTION ? normalizeWrongForms(candidate.wrongForms) : [],
      sourceIds: normalizeIds(candidate.sourceIds),
      context: kind === KIND_CORRECTION ? normalizeContext(candidate.context) : null,
      ambiguous: kind === KIND_CORRECTION && candidate.ambiguous === true,
      at: isoOf(candidate.at, Date.now()),
    };

    const existing = byKey.get(key) ?? byCanonical.get(key);
    if (existing === undefined) {
      const assigned = kind === KIND_CORRECTION && speakerId !== null && !incoming.ambiguous;
      const entry = {
        id: nextEntryId(state),
        key,
        text,
        kind,
        status: STATUS_CANDIDATE,
        canonical: '',
        wrongForms: [...incoming.wrongForms],
        sourceIds: [...incoming.sourceIds],
        context: incoming.context,
        ambiguous: incoming.ambiguous,
        speakerId: assigned ? speakerId : null,
        assigned,
        at: incoming.at,
        confirmedAt: '',
        rejectedAt: '',
      };
      entries.push(entry);
      byKey.set(key, entry);
      added += 1;
      continue;
    }
    if (existing.status === STATUS_REJECTED) {
      skipped += 1;
      continue;
    }

    addSourceIds(existing, incoming.sourceIds);
    if (instant(incoming.at, 0) < instant(existing.at, 0)) existing.at = incoming.at;
    if (existing.context === null && incoming.context !== null) existing.context = incoming.context;
    if (incoming.kind === KIND_CORRECTION) {
      if (existing.status !== STATUS_CONFIRMED) {
        if (existing.kind !== KIND_CORRECTION) {
          existing.kind = KIND_CORRECTION;
          if (incoming.text.length > 0) existing.text = incoming.text;
        }
        // Two different confirmed speakers make this not one person's word; stay unassigned.
        const speakers = new Set();
        if (existing.speakerId !== null) speakers.add(existing.speakerId);
        if (incoming.speakerId !== null) speakers.add(incoming.speakerId);
        if (existing.ambiguous === true || incoming.ambiguous) {
          existing.ambiguous = true;
          existing.speakerId = null;
          existing.assigned = false;
        } else if (speakers.size === 1) {
          existing.speakerId = [...speakers][0];
          existing.assigned = true;
        } else {
          existing.speakerId = null;
          existing.assigned = false;
        }
      } else if (existing.kind !== KIND_CORRECTION) {
        // A confirmed word keeps its user-confirmed canonical/speaker; only the better kind and
        // the newly learned misrecognised forms are taken.
        existing.kind = KIND_CORRECTION;
      }
      addWrongForms(existing, incoming.wrongForms);
    }
    merged += 1;
  }
  return { ok: true, added, merged, skipped };
}

/**
 * Confirm a candidate: it becomes an effective entry, attributed to `speakerId`.
 *
 * A missing/blank speakerId is refused without touching the state. The canonical spelling
 * defaults to the candidate's text; confirming again edits it (the only "modify" operation
 * stage 1 needs) while keeping the stable id.
 *
 * @param {object} state
 * @param {{text?: string, id?: string, speakerId?: string|null, canonical?: string,
 *   now?: string|number|Date}} options
 * @returns {{ok: true, entry: object}|{ok: false, reason: string}}
 */
export function confirmCandidate(state, { text = '', id = undefined, speakerId = null, canonical = '', now = undefined } = {}) {
  const entries = ensureState(state);
  if (entries === null) return { ok: false, reason: 'invalid-state' };
  const entry = findEntry(entries, { text, id });
  if (entry === null) return { ok: false, reason: 'not-found' };
  if (entry.status === STATUS_REJECTED) return { ok: false, reason: 'rejected' };
  // "不是甲，是乙" with two possible targets is not confirmable, even manually.
  if (entry.ambiguous === true) return { ok: false, reason: 'ambiguous-target' };
  const speaker = normalizeSpeaker(speakerId);
  if (speaker === null) return { ok: false, reason: 'speaker-required' };
  const display = cleanForm(canonical) || entry.text;
  if (display.length === 0) return { ok: false, reason: 'canonical-empty' };
  if (entry.text.length === 0) entry.text = display;
  entry.canonical = display;
  entry.assigned = true;
  entry.speakerId = speaker;
  entry.status = STATUS_CONFIRMED;
  entry.confirmedAt = isoOf(now, Date.now());
  return { ok: true, entry: publicEntry(entry) };
}

/**
 * Reject a candidate. A tombstone is kept (status `rejected`) so re-extraction cannot silently
 * bring the same form back; `removeEntry()` is the explicit purge.
 *
 * @param {object} state
 * @param {{text?: string, id?: string, now?: string|number|Date}} options
 * @returns {{ok: true, entry: object}|{ok: false, reason: string}}
 */
export function rejectCandidate(state, { text = '', id = undefined, now = undefined } = {}) {
  const entries = ensureState(state);
  if (entries === null) return { ok: false, reason: 'invalid-state' };
  const entry = findEntry(entries, { text, id });
  if (entry === null) return { ok: false, reason: 'not-found' };
  if (entry.status === STATUS_CONFIRMED) return { ok: false, reason: 'confirmed' };
  if (entry.status === STATUS_REJECTED) return { ok: true, entry: publicEntry(entry) };
  entry.status = STATUS_REJECTED;
  entry.rejectedAt = isoOf(now, Date.now());
  return { ok: true, entry: publicEntry(entry) };
}

/**
 * Delete one entry (candidate, rejected tombstone or effective word) by text/key or stable id.
 *
 * @param {object} state
 * @param {{text?: string, id?: string}} options
 * @returns {{ok: true, entry: object}|{ok: false, reason: string}}
 */
export function removeEntry(state, { text = '', id = undefined } = {}) {
  const entries = ensureState(state);
  if (entries === null) return { ok: false, reason: 'invalid-state' };
  const entry = findEntry(entries, { text, id });
  if (entry === null) return { ok: false, reason: 'not-found' };
  const index = entries.indexOf(entry);
  if (index >= 0) entries.splice(index, 1);
  return { ok: true, entry: publicEntry(entry) };
}

function compareViews(left, right, field) {
  const a = typeof left[field] === 'string' ? left[field] : '';
  const b = typeof right[field] === 'string' ? right[field] : '';
  if (a !== b) return a < b ? -1 : 1;
  if (left.text !== right.text) return left.text < right.text ? -1 : 1;
  return 0;
}

/**
 * Every pending candidate, optionally filtered by status. Not required by the pipeline, but the
 * UI needs the assigned-but-unconfirmed bucket that neither listEntries nor listUnassigned shows.
 *
 * @param {object} state
 * @param {{status?: 'candidate'|'confirmed'|'rejected'}} [options]
 * @returns {object[]}
 */
export function listCandidates(state, { status = STATUS_CANDIDATE } = {}) {
  const entries = entriesOf(state);
  if (entries === null) return [];
  return entries
    .filter((entry) => entry !== null && typeof entry === 'object' && entry.status === status)
    .map(publicEntry)
    .sort((left, right) => compareViews(left, right, 'at'));
}

/**
 * The effective personal lexicon: confirmed entries only.
 * @param {object} state
 * @returns {object[]}
 */
export function listEntries(state) {
  const entries = entriesOf(state);
  if (entries === null) return [];
  return entries
    .filter((entry) => entry !== null && typeof entry === 'object' && entry.status === STATUS_CONFIRMED)
    .map(publicEntry)
    .sort((left, right) => compareViews(left, right, 'confirmedAt'));
}

/**
 * The unassigned area: pending candidates whose speaker identity is not confirmed. Nothing here
 * is a personal word yet; ordinary transcripts always land here.
 * @param {object} state
 * @returns {object[]}
 */
export function listUnassigned(state) {
  const entries = entriesOf(state);
  if (entries === null) return [];
  return entries
    .filter((entry) => entry !== null
      && typeof entry === 'object'
      && entry.status === STATUS_CANDIDATE
      && entry.assigned !== true)
    .map(publicEntry)
    .sort((left, right) => compareViews(left, right, 'at'));
}
