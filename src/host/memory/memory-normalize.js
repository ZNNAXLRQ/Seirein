/**
 * Memory write normalization — stage 2: make one sentence understandable without the
 * conversation it came from, WITHOUT adding an explanation.
 *
 * Two transformations, both reversible through `rawText`:
 *   1. anaphora: a pronoun/demonstrative is replaced by the object the SAME sentence names
 *      (`我朋友叫小明，他…` → `小明`), or else by the one compatible object the previous turns
 *      name (`她最近不爱吃饭` + `我养了一只猫，叫团子` → `团子最近不爱吃饭`). A quoted first
 *      person keeps its original speaker (`小王说「我明天去」` → `小王`). Never
 *      `团子（用户养的猫）`: the relationship belongs to relevance retrieval and to stage-3
 *      links. Reference and referent must also agree in kind — 这个/那个/它 never resolve to a
 *      person or an animal, 他/她 never to an artifact. An unclear reference, a kind mismatch
 *      or a supposition (如果/假如/要是/万一) leave the original words untouched and set
 *      `unresolved = 1` instead of guessing; uniqueness of a history candidate is never enough.
 *   2. time: 今天/明天/后天/昨天/前天 and 本周X/下周X/上周X become `YYYY-MM-DD`, resolved against
 *      the LOCAL wall clock of the utterance instant in the configured zone (`memory.timeZone`,
 *      default Asia/Shanghai). Inside 《…》 nothing is rewritten (a title is a name). Inside
 *      reported speech the date is resolved against the speaker's own speech instant
 *      (`昨天小王说「我明天去」` → 小王's tomorrow), and when that instant cannot be established
 *      the words stay and `unresolved = 1`. Vague expressions (改天/找个时间/下周 without a
 *      weekday) stay as written and set `unresolved = 1`.
 *
 *      The automatic evidence lane is the exception (§6.4): its body is what the user actually
 *      said, so relative wording stays verbatim. The recorder is the only caller that supplies a
 *      captured context without an explicit `expand` decision; every manual/comparison caller
 *      states `expand` (or `resolveTime`), so this inference is stable. A caller can always state
 *      `resolveTime` to override it.
 *
 * Pure and store-free: the auto recorder, `assistant_remember` and the correction replacement
 * all call this one function. Idempotent — normalizing an already-normalized body changes
 * nothing and reports no change.
 */

export const DEFAULT_MEMORY_TIME_ZONE = 'Asia/Shanghai';

/** Change kinds reported in `memory.normalize.changes` (never the changed text). */
export const NORMALIZE_CHANGES = Object.freeze({
  PRONOUN: 'pronoun',
  QUOTE: 'quote',
  TIME: 'time',
});

const DAY_MS = 86_400_000;
const formatters = new Map();
const zoneNames = new Map();

/** A usable IANA zone name, or the default; an invalid config never throws. */
export function resolveMemoryTimeZone(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (name.length === 0) return DEFAULT_MEMORY_TIME_ZONE;
  if (zoneNames.has(name)) return zoneNames.get(name);
  let resolved = DEFAULT_MEMORY_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name }).format(0);
    resolved = name;
  } catch {
    /* invalid zone: keep the default */
  }
  zoneNames.set(name, resolved);
  return resolved;
}

function formatterFor(timeZone) {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

function instantOf(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : new Date();
  if (typeof value === 'number') return Number.isFinite(value) ? new Date(value) : new Date();
  if (typeof value === 'string') {
    const stamp = Date.parse(value);
    return Number.isFinite(stamp) ? new Date(stamp) : new Date();
  }
  return new Date();
}

function pad(value) {
  return String(value).padStart(2, '0');
}

/** Local calendar parts of one instant in `timeZone` (never UTC). */
export function zonedDateParts(at = new Date(), timeZone = DEFAULT_MEMORY_TIME_ZONE) {
  const tz = resolveMemoryTimeZone(timeZone);
  const parts = formatterFor(tz).formatToParts(instantOf(at));
  const pick = (type) => Number(parts.find((part) => part.type === type)?.value);
  return { year: pick('year'), month: pick('month'), day: pick('day'), timeZone: tz };
}

/** `YYYY-MM-DD` of one instant in `timeZone`: a 01:30 Beijing moment keeps its Beijing date. */
export function zonedDateStamp(at = new Date(), timeZone = DEFAULT_MEMORY_TIME_ZONE) {
  const parts = zonedDateParts(at, timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

function stampOf(parts) {
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

function shiftDays(parts, days) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day) + days * DAY_MS);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

/** Monday-based weekday: 1 = Monday … 7 = Sunday. */
function weekdayNumber(parts) {
  const day = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  return ((day + 6) % 7) + 1;
}

// ---- 1. relative time ------------------------------------------------------

const DAY_OFFSETS = new Map([
  ['大后天', 3],
  ['大前天', -3],
  ['今天', 0],
  ['今日', 0],
  ['明天', 1],
  ['明日', 1],
  ['后天', 2],
  ['昨天', -1],
  ['昨日', -1],
  ['前天', -2],
]);
const DAY_RE = /(大后天|大前天|今天|今日|明天|明日|后天|昨天|昨日|前天)/gu;

const WEEK_RE = /(本|这|下|上)\s*个?\s*(?:周|星期|礼拜)\s*([一二三四五六日天])/gu;
const WEEKDAY_NUMBERS = new Map([
  ['一', 1],
  ['二', 2],
  ['三', 3],
  ['四', 4],
  ['五', 5],
  ['六', 6],
  ['日', 7],
  ['天', 7],
]);

/** An expression that names a moment but cannot be turned into one date. */
const VAGUE_TIME_RE = /(改天|改日|找个时间|找时间|抽空|有空的时候|有空|哪天|某天|某日|回头|过几天|过阵子|以后再说|另约|再约|周末|这几天|前段时间|前一阵|前阵子|前几天|有一阵|上个月|下个月|这个月|月底|月初|年底|明年|去年|到时候)/u;
/** 本周/下周/上周 without a weekday: a range, not a date. */
const BARE_WEEK_RE = /(?:本|这|下|上)\s*个?\s*(?:周|星期|礼拜)(?![一二三四五六日天])/u;

// ---- 2. anaphora -----------------------------------------------------------

/**
 * Personal pronouns and the demonstratives that can stand alone. `(?<!其)` keeps 其他/其它 and
 * `(?!们)` keeps 他们 out; a bare 这个/那个 only counts when it is not followed by the noun it
 * modifies (这个方案 is self-contained, so it is neither expanded nor reported).
 */
const ANAPHOR_SOURCE = String.raw`(?<!其)(?:她|他|它)(?!们)|(?:这个文件|那个文件)|(?:这里|那里|这儿|那儿)|(?:这个|那个|这只|那只|这件|那件)(?=[，。！？、；：,.!?;:\s]|的|是|不|很|太|真|也|又|还|就|要|得|能|会|行|好|吧|呢|啊|呀|嘛|在|有|没|放|坏|丢|怎么|为什么|$)`;
const ANAPHOR_RE = new RegExp(ANAPHOR_SOURCE, 'gu');
const ANAPHOR_TEST = new RegExp(ANAPHOR_SOURCE, 'u');

/** A supposition must never be turned into an established fact. */
const HYPOTHETICAL_RE = /(如果|假如|要是|万一|倘若|假设|若是|除非)/u;

const QUOTE_DELIMITERS = [
  ['「', '」'],
  ['『', '』'],
  ['“', '”'],
  ['"', '"'],
];
const SPEECH_ATTRIBUTION_RE = /(?:说道|说|讲|问|表示|回复|写道)\s*[：:]?\s*[「『“"]/u;

const NAMED_RE = /(?:名字是|名字叫|叫做|名叫|叫)([^\s，。,.!?！？、的]{1,6})/gu;
const GENERIC_RE = /(?:我|我们)(?:养|买|领养|收养|有|捡到|捡了)了?(?:一|两|几|半)?(?:只|个|条|台|辆|部|本|张|双|支|件|套|瓶|盆|棵|块|把)?([\u4e00-\u9fa5A-Za-z0-9_.\-]{2,8})/gu;

/** Prefixes that carry no object information once they are removed. */
const NAME_FILLERS = /^(?:今天|昨天|明天|后天|前天|刚才|刚刚|然后|后来|随后|所以|但是|不过|而且|另外|还有|于是|如果|假如|要是|万一|朋友|同事|同学|老板|领导|老师|家人|据说|最近|近期|前段时间|前一阵|前阵子|前些天|前些日子|上一次|上回)/u;
/** A capture that starts like this is a verb phrase or a predicate, not an object name. */
const NAME_STOP_START = /^(?:我|你|他|她|它|我们|你们|他们|她们|它们|什么|这个|那个|这里|那里|这样|那样|自己|人家|现在|以后|不要|没有|别)/u;
/** A capture that ends like this swallowed the following verb. */
const NAME_STOP_END = /(?:来|去|说|讲|问|做|走|看|吃|玩|买|给|帮|过|了|的|吧|呢|吗|啊|呀)$/u;
const NOUN_STOP = new Set([
  '问题', '事情', '事', '想法', '感觉', '办法', '计划', '消息', '东西', '地方', '时间', '时候',
  '机会', '任务', '目标', '决定', '习惯', '要求', '理由', '原因', '印象', '经历', '故事', '话',
  '活', '人', '朋友', '意思', '状态', '情况', '结果', '过程', '方式', '方法', '内容', '记录',
]);

// ---- 1b. referent kinds ----------------------------------------------------
// A pronoun and its referent must agree in kind: 这个文件/它 is a thing, 他/她 is a living
// being, and 这只/那只 is an animal. Uniqueness alone is not evidence of identity.
const PERSON_NOUN_RE = /(?:朋友|同事|同学|老板|领导|老师|家人|爸爸|妈妈|父亲|母亲|哥哥|姐姐|弟弟|妹妹|儿子|女儿|老公|老婆|男朋友|女朋友|男友|女友|先生|女士|医生|护士|司机|邻居|室友|舍友|客户|孩子|对象)/u;
const ANIMAL_NOUN_RE = /(?:猫|狗|兔|仓鼠|鹦鹉|鸟|鱼|龟|猪|马|牛|羊|鸡|鸭|鹅|宠物)/u;
const OBJECT_NOUN_RE = /(?:文件|文档|报告|表格|合同|发票|截图|照片|图片|视频|手机|电脑|笔记本|平板|相机|耳机|键盘|鼠标|屏幕|显示器|书|本子|包|钥匙|钱包|杯子|水杯|衣服|鞋|车|自行车|手表|眼镜|空调|冰箱|洗衣机|桌子|椅子|灯|门|窗|快递|包裹)/u;
const FILE_EXT_RE = /\.(?:docx?|xlsx?|pptx?|pdf|txt|md|markdown|png|jpe?g|gif|webp|svg|zip|rar|7z|tar|gz|mp4|mov|mp3|wav|csv|json|ya?ml|js|mjs|ts|tsx|jsx|py|html?|css|sh|ps1)$/iu;

/** The kind of an object, from its name and the nouns that introduced it. */
function entityKindOf(name, nouns = []) {
  const whole = [name, ...nouns].filter((part) => typeof part === 'string' && part.length > 0).join(' ');
  if (whole.length === 0) return 'unknown';
  if (PERSON_NOUN_RE.test(whole)) return 'person';
  if (ANIMAL_NOUN_RE.test(whole)) return 'animal';
  if (FILE_EXT_RE.test(name) || OBJECT_NOUN_RE.test(whole)) return 'object';
  return 'unknown';
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * The speaker name must start at the beginning, after punctuation, or right after a time
 * expression — never in the middle of one (`前段时间小王说` used to capture `时间小王`).
 * An absolute day (`2026-11-01`, `2026年11月1日`) and a week+weekday (`上周三`) are time
 * expressions too, so the name that follows them is the speaker and not part of the date.
 */
const SPEAKER_TIME = String.raw`(?:今天|昨天|明天|后天|前天|大后天|大前天|刚才|刚刚|然后|后来|随后|当时|之前|以前|上次|上回|那天|那次|最近|近期|前段时间|前一阵|前阵子|前些天|前些日子|前几天|上个月|这个月|下个月|去年|明年|早上|上午|中午|下午|晚上)|(?:上周|本周|下周)(?![一二三四五六日天])|(?:本|这|下|上)\s*个?\s*(?:周|星期|礼拜)\s*[一二三四五六日天]|\d{4}\s*[年./-]\s*\d{1,2}\s*[月./-]\s*\d{1,2}\s*[日号]|\d{4}\s*[年./-]\s*\d{1,2}\s*[月./-]\s*\d{1,2}(?![日号])|\d{1,2}\s*月\s*\d{1,2}\s*[日号]|\d{1,2}\s*月\s*\d{1,2}(?![日号])`;
const SPEAKER_LEAD = String.raw`(?:^|(?<=[，。！？；：,.!?;:\s])|(?<=(?:${SPEAKER_TIME})))`;

function quotePattern(open, close) {
  return new RegExp(
    `${SPEAKER_LEAD}([\\u4e00-\\u9fa5]{2,4})(说道|说|讲|问|表示|回复|写道)(\\s*[：:]?\\s*)`
      + `${escapeRegExp(open)}([^${escapeRegExp(close)}]{1,200})${escapeRegExp(close)}`,
    'gu',
  );
}
const QUOTE_PATTERNS = QUOTE_DELIMITERS.map(([open, close]) => ({ open, close, pattern: quotePattern(open, close) }));

function cleanName(value) {
  let name = typeof value === 'string' ? value.trim() : '';
  if (name.length === 0) return '';
  name = name.replace(NAME_FILLERS, '');
  if (name.length === 0 || name.length > 12) return '';
  if (NAME_STOP_START.test(name)) return '';
  if (NAME_STOP_END.test(name)) return '';
  return name;
}

function stripMeasure(value) {
  return value
    .replace(/^[了过的]+/u, '')
    .replace(
      /^(?:我|我的|家里|家|这|那|一|两|几|半|多)?(?:只|个|条|台|辆|部|本|张|双|支|件|套|瓶|盆|棵|块|把|顶|副)?/u,
      '',
    );
}

function usefulNoun(value) {
  const noun = stripMeasure(typeof value === 'string' ? value : '');
  if (noun.length === 0 || noun.length > 8) return '';
  if (NOUN_STOP.has(noun)) return '';
  if (ANAPHOR_TEST.test(noun)) return '';
  return noun;
}

/** The object immediately introduced by 叫: `我养了一只猫，叫团子` → 猫. */
function trailingNoun(clause) {
  const match = /([\u4e00-\u9fa5]{1,4})[，,]?\s*$/u.exec(clause);
  if (match === null) return '';
  const bare = stripMeasure(match[1]);
  // 朋友/同事/老师 are person nouns, but NOUN_STOP drops them as object names.
  if (bare.length > 0 && PERSON_NOUN_RE.test(bare)) return bare;
  return usefulNoun(match[1]);
}

function addEntity(list, name, nouns, id = '') {
  const sourceId = typeof id === 'string' ? id : '';
  const existing = list.find((entity) => entity.name === name);
  if (existing !== undefined) {
    for (const noun of nouns) {
      if (noun.length > 0 && !existing.nouns.includes(noun)) existing.nouns.push(noun);
    }
    // A candidate keeps the record it was first seen in; that id is the `referent` basis.
    if (existing.id.length === 0 && sourceId.length > 0) existing.id = sourceId;
    existing.kind = entityKindOf(existing.name, existing.nouns);
    return;
  }
  const kept = nouns.filter((noun) => noun.length > 0);
  list.push({ name, nouns: kept, kind: entityKindOf(name, kept), id: sourceId });
}

/**
 * Names the previous turns mention. A name introduced by 叫 wins and absorbs the noun in front
 * of it (`猫` → the same object as `团子`), so one introduction yields ONE candidate; two
 * introductions (or two different objects) yield two, which is exactly when we must not guess.
 * `context.entities` is an explicit override for callers/tests that know the referents.
 *
 * Every candidate carries `id`: the record it was read from (`context.records`, matched by the
 * same text). That is the `referent` basis, handed to the link writer instead of being guessed
 * afterwards from "which record happens to contain this name".
 */
export function memoryCandidates(context) {
  const explicit = Array.isArray(context?.entities) ? context.entities : [];
  if (explicit.length > 0) {
    const list = [];
    for (const entry of explicit) {
      const name = cleanName(typeof entry === 'string' ? entry : entry?.name);
      if (name.length === 0) continue;
      const nouns = Array.isArray(entry?.nouns) ? entry.nouns.map(String) : [];
      const id = entry !== null && typeof entry === 'object' && typeof entry.id === 'string'
        ? entry.id
        : '';
      addEntity(list, name, nouns.map((noun) => usefulNoun(noun)).filter((noun) => noun.length > 0), id);
    }
    return list;
  }
  const previous = Array.isArray(context?.previous)
    ? context.previous
    : (typeof context?.previous === 'string' ? [context.previous] : []);
  const texts = previous.filter((text) => typeof text === 'string' && text.trim().length > 0).slice(-4);
  // `records` is newest-first, so the last write for a duplicated body is the OLDEST row — the
  // introduction, not a later restatement of the same name.
  const idOfText = new Map();
  for (const row of Array.isArray(context?.records) ? context.records : []) {
    if (typeof row?.id === 'string' && row.id.length > 0 && typeof row?.text === 'string') {
      idOfText.set(row.text, row.id);
    }
  }
  const list = [];
  for (const text of texts) {
    const sourceId = idOfText.get(text) ?? '';
    for (const match of text.matchAll(NAMED_RE)) {
      const name = cleanName(match[1]);
      if (name.length === 0) continue;
      const clause = text.slice(0, match.index).split(/[。！？；\n]/u).pop() ?? '';
      const noun = trailingNoun(clause);
      addEntity(list, name, noun.length > 0 ? [noun] : [], sourceId);
    }
    for (const match of text.matchAll(GENERIC_RE)) {
      const noun = usefulNoun(match[1]);
      if (noun.length === 0) continue;
      const covered = list.some(
        (entity) => entity.name === noun || entity.nouns.includes(noun)
          || entity.name.includes(noun) || noun.includes(entity.name),
      );
      if (!covered) addEntity(list, noun, [], sourceId);
    }
  }
  return list;
}

/**
 * Reported speech: 小王说「我明天去」 — the quoted 我 is the speaker, not the user. The quoted
 * body is left alone when the speaker is unnamed or is itself a pronoun: that is unresolved.
 */
function expandQuotedSpeakers(text) {
  let body = text;
  let changed = false;
  let ambiguous = false;
  for (const { open, close, pattern } of QUOTE_PATTERNS) {
    body = body.replace(pattern, (match, speakerRaw, verb, gap, content) => {
      if (!content.includes('我')) return match;
      const speaker = cleanName(speakerRaw);
      if (speaker.length === 0) {
        ambiguous = true;
        return match;
      }
      changed = true;
      return `${speakerRaw}${verb}${gap}${open}${content.replace(/我(?!们)/gu, speaker)}${close}`;
    });
  }
  return { text: body, changed, ambiguous };
}

/** Named objects introduced by the current sentence, in reading order. */
function localEntities(sentence) {
  const list = [];
  for (const match of sentence.matchAll(NAMED_RE)) {
    const name = cleanName(match[1]);
    if (name.length === 0) continue;
    const clause = sentence.slice(0, match.index).split(/[。！？；\n]/u).pop() ?? '';
    const noun = trailingNoun(clause);
    const nouns = noun.length > 0 ? [noun] : [];
    list.push({ name, nouns, kind: entityKindOf(name, nouns), index: match.index });
  }
  for (const match of sentence.matchAll(GENERIC_RE)) {
    const noun = usefulNoun(match[1]);
    if (noun.length === 0) continue;
    if (list.some((entity) => entity.name === noun || entity.nouns.includes(noun))) continue;
    list.push({ name: noun, nouns: [], kind: entityKindOf(noun, []), index: match.index });
  }
  return list.sort((left, right) => left.index - right.index);
}

const PERSON_ANAPHOR = /^(?:他|她)$/u;
const ANIMAL_DEMONSTRATIVE = /^(?:这只|那只)$/u;
const PLACE_ANAPHOR = /^(?:这里|那里|这儿|那儿)$/u;

/** What a pronoun/demonstrative claims about its referent. */
function anaphorKind(surface) {
  if (PERSON_ANAPHOR.test(surface)) return 'person';
  if (ANIMAL_DEMONSTRATIVE.test(surface)) return 'animal';
  if (PLACE_ANAPHOR.test(surface)) return 'place';
  return 'object'; // 它 / 这个 / 那个 / 这个文件 / 那个文件 / 这件 / 那件
}

/**
 * A kind match keeps the reference honest: a thing is never a person or an animal, and a person
 * pronoun is never an artifact (an unknown bare name may still be a person or a pet).
 */
function kindAccepts(referenceKind, entityKind) {
  if (referenceKind === 'person') return entityKind === 'person' || entityKind === 'animal' || entityKind === 'unknown';
  if (referenceKind === 'object') return entityKind === 'object';
  if (referenceKind === 'animal') return entityKind === 'animal' || entityKind === 'unknown';
  if (referenceKind === 'place') return entityKind === 'place';
  return false;
}

/** The closest named object BEFORE the pronoun in the same sentence, kind-compatible. */
function nearestLocalEntity(entities, offset, referenceKind) {
  for (let index = entities.length - 1; index >= 0; index -= 1) {
    const entity = entities[index];
    if (entity.index >= offset) continue;
    if (kindAccepts(referenceKind, entity.kind)) return entity;
  }
  return null;
}

/**
 * Sentence-wise replacement. The same sentence's own subject wins over the previous turns; a
 * supposition or an attributed quotation keeps its pronouns (a guess is not a fact, and a
 * quote's pronouns belong to its speaker). A lone history candidate is used only when its kind
 * agrees with the pronoun, never because it happens to be the only one.
 *
 * The returned `referentId` is the record that history candidate was read from — the basis the
 * `referent` link must point at. Empty when the subject came from the same sentence (no stored
 * basis) or when the candidate carries no id.
 */
function expandPronouns(body, candidates) {
  let changed = false;
  let referentId = '';
  const pieces = body.split(/(?<=[。！？!?\n])/u);
  const next = pieces.map((sentence) => {
    if (HYPOTHETICAL_RE.test(sentence) || SPEECH_ATTRIBUTION_RE.test(sentence)) return sentence;
    const local = localEntities(sentence);
    // A title or a non-reported quotation is a name/verbatim citation: its characters are never
    // rewritten, so only plain nodes are searched for anaphora.
    return splitProtected(sentence).map((node) => {
      if (node.type !== 'text') return node.raw;
      return node.text.replace(ANAPHOR_RE, (match, offset) => {
        const position = node.start + offset;
        const referenceKind = anaphorKind(match);
        const nearby = nearestLocalEntity(local, position, referenceKind);
        if (nearby !== null) {
          changed = true;
          return nearby.name;
        }
        const usable = candidates.filter((entity) => kindAccepts(referenceKind, entity.kind));
        if (usable.length !== 1) return match;
        changed = true;
        if (referentId.length === 0 && typeof usable[0].id === 'string') referentId = usable[0].id;
        return usable[0].name;
      });
    }).join('');
  });
  return { text: next.join(''), changed, referentId };
}

// ---- 1c. protected spans ---------------------------------------------------
// A title is a name, never a date; a quotation's dates belong to its speaker's clock.
const OPEN_TO_CLOSE = new Map([
  ['《', '》'],
  ['「', '」'],
  ['『', '』'],
  ['“', '”'],
  ['"', '"'],
]);
const SPEECH_ATTRIBUTION_TAIL_RE = /(?:说道|说|讲|问|表示|回复|写道)\s*[：:，,]?\s*$/u;
/** A speech instant these markers name cannot be pinned to one day. */
const SPEECH_TIME_VAGUE_RE = /(?:上个月|这个月|下个月|上个?星期|上个?礼拜|上周|本周|下周|前段时间|前一阵|前阵子|前几天|前些天|前些日子|有一阵|有一段时间|最近|近期|这段时间|某天|某日|有一天|那天|那次|那回|上次|上回|以前|之前|当初|当时|曾经|后来|随后|回头|改天|过几天|过阵子|月底|月初|年底|年初|明年|去年)/u;
const DAY_TEST = new RegExp(DAY_RE.source, 'u');
const WEEK_TEST = new RegExp(WEEK_RE.source, 'u');

/**
 * Split text into plain / book-title / quotation nodes so a protected span is never rewritten.
 * An unmatched opener is plain text (there is no reliable span to protect).
 */
function splitProtected(text) {
  const nodes = [];
  let index = 0;
  let plainStart = 0;
  while (index < text.length) {
    const open = text[index];
    const close = OPEN_TO_CLOSE.get(open);
    if (close === undefined) {
      index += 1;
      continue;
    }
    const closeIndex = text.indexOf(close, index + 1);
    if (closeIndex < 0) {
      index += 1;
      continue;
    }
    if (index > plainStart) nodes.push({ type: 'text', text: text.slice(plainStart, index), start: plainStart });
    nodes.push({
      type: open === '《' ? 'title' : 'quote',
      open,
      close,
      text: text.slice(index + 1, closeIndex),
      raw: text.slice(index, closeIndex + 1),
      start: index,
    });
    index = closeIndex + 1;
    plainStart = index;
  }
  if (plainStart < text.length) nodes.push({ type: 'text', text: text.slice(plainStart), start: plainStart });
  return nodes;
}

/** True when `text` carries a relative date outside any book title. */
function hasRelativeDate(text) {
  for (const node of splitProtected(text)) {
    if (node.type === 'title') continue;
    if (node.type === 'quote') {
      if (hasRelativeDate(node.text)) return true;
      continue;
    }
    if (DAY_TEST.test(node.text) || WEEK_TEST.test(node.text)) return true;
  }
  return false;
}

/** True when a pronoun outside a book title is still unexpanded (a title is a name, not a gap). */
function hasLooseAnaphor(text) {
  for (const node of splitProtected(text)) {
    if (node.type === 'title') continue;
    if (node.type === 'quote' ? hasLooseAnaphor(node.text) : ANAPHOR_TEST.test(node.text)) return true;
  }
  return false;
}

/** Rewrite relative dates inside `text` against `base`; titles keep their wording verbatim. */
function replaceRelativeDates(text, base) {
  let changed = false;
  const pieces = splitProtected(text).map((node) => {
    if (node.type === 'title') return node.raw;
    if (node.type === 'quote') {
      const inner = replaceRelativeDates(node.text, base);
      if (inner.changed) changed = true;
      return `${node.open}${inner.text}${node.close}`;
    }
    const weeks = node.text.replace(WEEK_RE, (match, marker, weekdayText) => {
      const weekday = WEEKDAY_NUMBERS.get(weekdayText);
      if (weekday === undefined) return match;
      const shift = marker === '下' ? 7 : marker === '上' ? -7 : 0;
      changed = true;
      return stampOf(shiftDays(base, shift + (weekday - weekdayNumber(base))));
    });
    return weeks.replace(DAY_RE, (match, word) => {
      const offset = DAY_OFFSETS.get(word);
      if (offset === undefined) return match;
      changed = true;
      return stampOf(shiftDays(base, offset));
    });
  });
  return { text: pieces.join(''), changed };
}

/** An absolute day written before the attribution: 2026-11-01 / 2026年11月1日 / 11月1日. */
const ABSOLUTE_DATE_RE = /(?<!\d)(?:(\d{4})\s*[年./-]\s*(\d{1,2})\s*[月./-]\s*(\d{1,2})\s*[日号]?|(\d{1,2})\s*月\s*(\d{1,2})\s*[日号])/u;

/**
 * The first absolute day in the plain part of `text`, as calendar parts. A date-like token that
 * names no real day reports `invalid` (the instant cannot be pinned); no token reports null.
 */
function absoluteDateBase(text, today) {
  for (const node of splitProtected(text)) {
    if (node.type !== 'text') continue;
    const match = ABSOLUTE_DATE_RE.exec(node.text);
    if (match === null) continue;
    const withYear = match[1] !== undefined;
    const year = withYear ? Number(match[1]) : today.year;
    const month = Number(withYear ? match[2] : match[4]);
    const day = Number(withYear ? match[3] : match[5]);
    const date = new Date(Date.UTC(year, month - 1, day));
    const valid = month >= 1 && month <= 12 && day >= 1 && day <= 31
      && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
    return valid ? { base: { year, month, day } } : { invalid: true };
  }
  return null;
}

/**
 * The speaker's own clock for a quotation: an absolute date written before 说 (`2026-11-01小王说`),
 * else an explicit relative day (`昨天小王说`), today when nothing contradicts it, or null when
 * only a vague/unparseable marker names the instant (never a silent "today" in that case).
 */
function speechTimeBase(prefix, today) {
  const clause = prefix.split(/[。！？!?\n]/u).pop() ?? '';
  if (!SPEECH_ATTRIBUTION_TAIL_RE.test(clause)) return { attributed: false, base: null };
  const absolute = absoluteDateBase(clause, today);
  if (absolute?.base !== undefined) return { attributed: true, base: absolute.base };
  let base = null;
  for (const match of clause.matchAll(DAY_RE)) {
    const offset = DAY_OFFSETS.get(match[1]);
    if (offset !== undefined) base = shiftDays(today, offset);
  }
  if (base !== null) return { attributed: true, base };
  if (absolute?.invalid === true || SPEECH_TIME_VAGUE_RE.test(clause) || BARE_WEEK_RE.test(clause)) {
    return { attributed: true, base: null };
  }
  return { attributed: true, base: today };
}

/**
 * Normalize one memory body before it is written.
 *
 * @param {string} text the sentence as spoken / as the model wrote it
 * @param {{now?: Date|number|string, timeZone?: string, context?: object, expand?: boolean,
 *          resolveTime?: boolean}} [options]
 *   `now` is the utterance instant (default: now); `context.previous` is the recent conversation
 *   (chronological) and `context.entities` an explicit candidate list; `expand:false` turns off
 *   pronoun expansion (used by the correction replacement).
 *   `resolveTime` states whether relative dates are absolutized. When it is omitted, the
 *   automatic evidence lane (a captured `context` with no explicit `expand`) keeps the words
 *   verbatim (§6.4); every other call resolves them as before.
 * @returns {{text: string, rawText: string, changes: string[], unresolved: 0|1, tz: string,
 *            referentId: string}} `referentId` is the stored record the expanded pronoun was
 *   read from (the `referent` link basis), or '' when there is none.
 */
export function normalizeForMemory(text, options = {}) {
  const {
    now = new Date(),
    timeZone = DEFAULT_MEMORY_TIME_ZONE,
    context = null,
    expand = true,
  } = options;
  // §6.4 lane decision. The recorder supplies the captured context but never an `expand`
  // decision; manual remember/correction and the dedup projection all state `expand`, so they
  // keep resolving. `resolveTime` is the explicit override (and the only stable contract for a
  // future caller that happens to look recorder-shaped).
  const resolveTime = options.resolveTime === undefined
    ? !(options.context !== undefined && options.context !== null && options.expand === undefined)
    : options.resolveTime === true;
  const rawText = typeof text === 'string' ? text : '';
  const tz = resolveMemoryTimeZone(timeZone);
  if (rawText.trim().length === 0) {
    return { text: rawText, rawText, changes: [], unresolved: 0, tz, referentId: '' };
  }

  const changes = [];
  const today = zonedDateParts(now, tz);
  let body = rawText;
  let unresolved = 0;
  let referentId = '';

  if (expand === true) {
    const quoted = expandQuotedSpeakers(body);
    if (quoted.changed) {
      body = quoted.text;
      changes.push(NORMALIZE_CHANGES.QUOTE);
    }
    if (quoted.ambiguous) unresolved = 1;

    const candidates = memoryCandidates(context);
    const expanded = expandPronouns(body, candidates);
    if (expanded.changed) {
      body = expanded.text;
      changes.push(NORMALIZE_CHANGES.PRONOUN);
    }
    referentId = expanded.referentId;
    // A pronoun the sentence and the history cannot pin down stays in place and is marked
    // unresolved below; the single history candidate is used only on a kind match.
  }

  // Relative dates are resolved against the utterance's LOCAL date, then written absolutely.
  // The automatic evidence lane skips this block entirely: its wording is the record.
  let timeChanged = false;
  let quoteTimeUnknown = false;
  if (resolveTime) {
    const timePieces = [];
    for (const node of splitProtected(body)) {
      if (node.type === 'text') {
        const replaced = replaceRelativeDates(node.text, today);
        if (replaced.changed) timeChanged = true;
        timePieces.push(replaced.text);
        continue;
      }
      if (node.type === 'title') {
        // 《明天会更好》 is a title, not a date.
        timePieces.push(node.raw);
        continue;
      }
      const speech = speechTimeBase(body.slice(0, node.start), today);
      if (!speech.attributed || speech.base === null) {
        // Without a speaker time base a quoted date is left as spoken, never guessed.
        if (hasRelativeDate(node.text)) quoteTimeUnknown = true;
        timePieces.push(node.raw);
        continue;
      }
      const replaced = replaceRelativeDates(node.text, speech.base);
      if (replaced.changed) timeChanged = true;
      timePieces.push(`${node.open}${replaced.text}${node.close}`);
    }
    body = timePieces.join('');
  }
  if (timeChanged) changes.push(NORMALIZE_CHANGES.TIME);
  if (quoteTimeUnknown) unresolved = 1;

  // Leftover anaphora (ambiguous reference, supposition, quoted speech) and a time expression
  // that names no date keep the original wording and are reported, never guessed.
  if (hasLooseAnaphor(body)) unresolved = 1;
  if (VAGUE_TIME_RE.test(body) || BARE_WEEK_RE.test(body)) unresolved = 1;

  return { text: body, rawText, changes, unresolved, tz, referentId };
}
