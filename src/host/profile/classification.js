/** classification — extracted from profileMaintain.js; no host entry dependency. */
import { SIDES, categoryKey, cleanText } from './maintain-config.js';
import { checkProfileTone, fallbackToneText } from './tone.js';

/**
 * Pronoun-prefix normalization for a cross-side move — the ONLY text change this path may make.
 * A move to agent rewrites a subject 「用户」 to 「你」 (object/attributive occurrences stay, the
 * quote rule stays); a move to user turns a leading 「你(的)」 into 「用户(的)」 and strips any
 * first-person pronoun, so the sentence opens with 「用户」. A category-only change never uses this.
 */
export function normalizeReclassifyText(value, side) {
  const text = cleanText(value);
  if (text.length === 0) return text;
  if (side === 'agent') {
    let next = text;
    // A legacy first-person sentence becomes the assistant's own 「你……」 voice.
    const leading = next.match(/^(咱们|我们|咱|我)(的)?/u);
    if (leading !== null) next = `你${leading[2] ?? ''}${next.slice(leading[0].length)}`;
    if (!checkProfileTone(next, 'agent').ok) next = fallbackToneText(next, 'agent');
    if (!next.startsWith('你') && !/^[「『“‘"']/u.test(next)) next = `你${next}`;
    return next;
  }
  let next = text;
  const leading = next.match(/^你(的)?/u);
  if (leading !== null) next = `用户${leading[1] ?? ''}${next.slice(leading[0].length)}`;
  if (!checkProfileTone(next, 'user').ok) next = fallbackToneText(next, 'user');
  if (!next.startsWith('用户') && !/^[「『“‘"']/u.test(next)) next = `用户${next}`;
  return next;
}


/** The category a persona/assistant-behaviour preference is always filed under. */
export const PROFILE_PERSONA_CATEGORY = '人设参考';


/**
 * Person-related preference words. The final rule is content-based, not intent-based: a preference
 * about a character's personality / speaking / interaction / handling style belongs to the persona
 * side even when the user never says 「希望助手这样表现」. Life preferences (food, sport,
 * entertainment, habits) have none of these words and stay on the user side.
 */
const PROFILE_PERSONA_WORDS = /(?:角色|人设|形象|口吻|语气|说话方式|说话|相处方式|互动方式|处事方式|称呼|撒娇|性格|气质|外表|外貌|长相|表现方式)/u;

const PROFILE_PREFERENCE_WORDS = /(?:偏好|偏爱|喜欢|希望|想要|倾向于|欣赏|亲近|爱看|爱听)/u;

const PROFILE_USER_LIFE_WORDS = /(?:吃|喝|饮食|口味|作息|睡眠|运动|健身|通勤|居住|生活|习惯|工作|学习|游戏|电影|音乐|动漫|小说)/u;

const PROFILE_ROLE_PLAY_GAME = /角色扮演/u;


/**
 * 用户对自己言行的澄清／即时反应。这类句子哪怕带着「角色/偏好」等词也一律留在画像侧，
 * 不得被改写成「你不要…」的助手规则；归属不明时同样不迁移。
 */
const PROFILE_SELF_DESCRIPTION = /(?:不代表|并不代表|不能代表|仅代表|澄清|我是说|我的意思是|并不是说|不是说|别误会|不要误会|解释一下|补充一下|更正|准确地说|换句话说|与[^，。！？!?]{0,8}无关)/u;

const PROFILE_IMMEDIATE_REACTION = /(?:即时|当时|刚才|观剧|看剧|追剧|随口|临时|一时)[^，。！？!?]{0,10}(?:反应|评价|看法|觉得|说|感觉)|(?:反应|评价|看法)[^，。！？!?]{0,6}(?:即时|当时|刚才|观剧|看剧|随口|临时|一时)/u;

/** 把用户原话改写成规则时常见的回声句式（「仅凭…推断…」）。 */
const PROFILE_RULE_ECHO = /仅凭[^，。！？!?]{0,24}推断/u;

/** 明确对助手提出的长期要求（「以后都这样」）；当次指令不算。 */
const PROFILE_LONG_TERM_REQUEST = /(?:以后|今后|从今往后|从现在起|往后|永远|一直|总是|每次都|每次|长期)[^，。！？!?]{0,18}(?:说话|语气|口吻|称呼|相处|互动|回复|回答|表现|态度|方式|温柔|安静|简短|主动|耐心)/u;

/** 当次/临时指令（「这次简短点」），不进入长期人设。 */
const PROFILE_ONE_OFF = /(?:这次|这一回|这一轮|这一次|今天先|今天|暂时|临时|就这一次|仅此一次|先这样)/u;

const PROFILE_BEHAVIOR_WORD = /(?:说话|语气|口吻|称呼|相处|互动|回复|回答|表现|态度|方式|简短|温柔|安静|耐心|主动|多说|少说)/u;

const PROFILE_AGENT_IMPERATIVE = /^(?:你(?:不要|别|要|应该|应当|必须)|请(?:不要|别|你)?|不要|别)/u;


/** True when the text is the user's own clarification or an immediate reaction to a story. */
export function isUserSelfDescription(value) {
  const text = cleanText(value);
  if (text.length === 0) return false;
  return PROFILE_SELF_DESCRIPTION.test(text)
    || PROFILE_IMMEDIATE_REACTION.test(text)
    || PROFILE_RULE_ECHO.test(text);
}


/** True when the user explicitly asks for a lasting assistant behaviour (not a one-off command). */
export function isExplicitLongTermRequest(value) {
  const text = cleanText(value);
  if (text.length === 0 || isOneOffInstruction(text)) return false;
  return PROFILE_LONG_TERM_REQUEST.test(text);
}


/** True when the text is a one-off/temporary instruction rather than a lasting preference. */
export function isOneOffInstruction(value) {
  const text = cleanText(value);
  if (text.length === 0) return false;
  return PROFILE_ONE_OFF.test(text) && PROFILE_BEHAVIOR_WORD.test(text);
}


/**
 * Defence for a rewritten user self-description: an agent entry that opens like a command
 * (「你不要/你要/请不要」) but reads as the user's own clarification, with no explicit long-term
 * request, is misplaced. It is moved back to the user side instead of being kept as a rule.
 */
export function isMisplacedAgentRule(value) {
  const text = cleanText(value);
  if (text.length === 0 || !PROFILE_AGENT_IMPERATIVE.test(text)) return false;
  if (isExplicitLongTermRequest(text)) return false;
  return isUserSelfDescription(text);
}


/**
 * Deterministic user-side sentence for a misplaced rule. The imperative frame is removed and a
 * rule echo 「仅凭X推断Y」 becomes the user's clarification 「X不代表Y」; no new fact is added.
 */
export function restoreUserStatement(value) {
  let text = cleanText(value)
    .replace(PROFILE_AGENT_IMPERATIVE, '')
    .replace(/^仅凭(.+?)推断(.+)$/u, (_, fact, guess) => `${fact}不代表${guess}`)
    .replace(/^把(.+?)当成(.+)$/u, (_, fact, guess) => `${fact}不是${guess}`)
    .replace(/^将(.+?)当作(.+)$/u, (_, fact, guess) => `${fact}不是${guess}`)
    .trim();
  text = text.replace(/^你(的)?/u, (_, possessive) => (possessive ? '用户的' : '用户')).replace(/你/u, '用户');
  if (!text.startsWith('用户')) text = `用户${text}`;
  text = text.replace(/^用户(?:不要|别|请|应该|应当|必须)/u, '用户不');
  if (!/[。！？!?…]$/u.test(text)) text = `${text}。`;
  return text;
}


/**
 * Deterministic signature of a temporary testing behaviour ("频繁测试功能", "更换语音合成",
 * "让助手多说几句"). These rows describe a test session, never a lasting preference; the preview
 * only NAMES them, and `removeNoise()` requires an explicit call before anything is deleted.
 */
const NOISE_MORE_SPEECH = /(?:让|叫|请)?助手(?:多|再|少)?说(?:几|一|两)?句|多说几句|少说几句/u;

const NOISE_SWITCH = /(?:更换|切换|换|调整|修改)[^，。]{0,8}(?:语音|音色|合成|TTS|模型)|(?:语音|音色|合成|TTS|模型)[^，。]{0,8}(?:更换|切换|换|调整|修改)/iu;

const NOISE_FREQUENT = /(?:频繁|反复|多次|不断|经常)[^，。]{0,10}(?:测试|调试|试|更换|切换)/u;

const NOISE_TEST = /(?:测试|调试|试验|试用|试一下|试一试)/u;

const NOISE_TEST_TARGET = /(?:功能|语音|音色|合成|TTS|助手|对话|界面|设置|模型|播放|流程|系统)/iu;


export function noiseReason(value) {
  const text = cleanText(value);
  if (text.length === 0) return null;
  if (NOISE_MORE_SPEECH.test(text) || NOISE_SWITCH.test(text) || NOISE_FREQUENT.test(text)) {
    return 'test-behavior';
  }
  if (NOISE_TEST.test(text) && NOISE_TEST_TARGET.test(text)) return 'test-behavior';
  if (/(?:临时|暂时)[^，。]{0,10}(?:试试|测试|用一下|让助手)/u.test(text)) return 'temporary';
  return null;
}


/** True when the sentence is a preference about a character/person (persona reference). */
export function isPersonaReferencePreference(value) {
  const text = cleanText(value);
  if (text.length === 0) return false;
  // 用户自述/澄清永远是画像材料，不能因为里面出现「角色/偏好」就搬到人设。
  if (isUserSelfDescription(text)) return false;
  if (!PROFILE_PERSONA_WORDS.test(text) || !PROFILE_PREFERENCE_WORDS.test(text)) return false;
  // 「角色扮演游戏」 is entertainment, not a character preference.
  if (PROFILE_ROLE_PLAY_GAME.test(text)
    && !/(?:人设|性格|口吻|语气|说话方式|相处方式|互动方式|处事方式|称呼|撒娇|气质)/u.test(text)) {
    return false;
  }
  // A sentence with a life-preference word and no person/behaviour cue stays a user fact.
  if (PROFILE_USER_LIFE_WORDS.test(text)
    && !/(?:角色|人设|形象|口吻|语气|说话方式|相处方式|互动方式|处事方式|称呼|撒娇|性格|气质)/u.test(text)) {
    return false;
  }
  return true;
}


/**
 * Agent-side category a persona preference is filed under: a speaking/interaction preference keeps
 * the stack's own 语言模式/说话方式/相处方式 name when that category exists, so the same fact is
 * never re-filed under a different category on every round; a character/image preference falls
 * back to 人设参考.
 */
function personaCategoryForText(text, stack) {
  const valid = (name) => (stack.get(categoryKey(name))?.parent === 'agent' ? name : null);
  if (/(?:口吻|语气|说话方式|说话|语言|表达方式)/u.test(text)) {
    return valid('语言模式') ?? valid('说话方式') ?? PROFILE_PERSONA_CATEGORY;
  }
  if (/(?:互动方式|相处方式|处事方式|互动|相处|处事)/u.test(text)) {
    return valid('相处方式') ?? PROFILE_PERSONA_CATEGORY;
  }
  return PROFILE_PERSONA_CATEGORY;
}


/**
 * User-side category for a statement that is being moved back: the stack's own matching category
 * when it exists (娱乐 for a story/character remark, 饮食/运动/生活习惯 by topic), else the first
 * user category. The category name is always one of the stack's (never invented here).
 */
function userCategoryForText(text, stack, fallback = '') {
  const valid = (name) => (stack.get(categoryKey(name))?.parent === 'user' ? stack.get(categoryKey(name)).name : null);
  const first = [...stack.values()].find((row) => row.parent === 'user')?.name;
  if (/(?:动画|动漫|角色|电影|电视|剧|游戏|音乐|作品|小说)/u.test(text)) {
    return valid('娱乐') ?? first ?? fallback;
  }
  if (/(?:吃|喝|饮食|口味|咖啡|茶)/u.test(text)) return valid('饮食') ?? first ?? fallback;
  if (/(?:运动|健身|跑步|锻炼)/u.test(text)) return valid('运动') ?? first ?? fallback;
  if (/(?:作息|睡眠|习惯|生活)/u.test(text)) return valid('生活习惯') ?? first ?? fallback;
  return first ?? fallback;
}


/**
 * One final entry → `{side, category}` under the existing category stack + semantic rules.
 * - 用户自述/澄清 stays user (never rewritten into an agent rule);
 * - 明确长期要求（「以后都这样」）→ agent; 当次指令（「这次简短点」）is dropped;
 * - a persona-reference preference goes to agent; category parent follows the stack;
 * - anything ambiguous keeps its current side/category (no migration, no strengthening).
 * Returns null when nothing should change.
 */
export function classifyProfileEntrySide(entry, categories = []) {
  const text = cleanText(entry?.text);
  const side = SIDES.includes(entry?.side) ? entry.side : 'user';
  const category = cleanText(entry?.category);
  const stack = new Map((Array.isArray(categories) ? categories : [])
    .map((row) => [categoryKey(row.name), row]));
  const hit = stack.get(categoryKey(category));
  if (side === 'agent' && isOneOffInstruction(text)) {
    // A one-off instruction is not a lasting persona tendency: the caller drops the candidate.
    return { drop: true, side, category, reason: 'one-off-instruction' };
  }
  if (side === 'agent' && isMisplacedAgentRule(text)) {
    // Defence: a user clarification rewritten as 「你不要…」 returns to the user side, in the
    // user's own voice, with no rule frame left behind.
    return {
      side: 'user',
      category: userCategoryForText(text, stack, category),
      text: restoreUserStatement(text),
      reason: 'misplaced-rule',
    };
  }
  let targetSide = side;
  let targetCategory = category;
  const selfDescription = isUserSelfDescription(text);
  if (side === 'user' && !selfDescription && isExplicitLongTermRequest(text)) {
    targetSide = 'agent';
    targetCategory = personaCategoryForText(text, stack);
  } else if (side === 'user' && !selfDescription && isPersonaReferencePreference(text)) {
    targetSide = 'agent';
    targetCategory = personaCategoryForText(text, stack);
  } else if (hit !== undefined && hit.parent !== side) {
    // The category stack is itself a semantic rule: a category can only file its own side.
    targetSide = hit.parent;
    targetCategory = hit.name;
  }
  if (targetSide === 'agent' && (targetCategory.length === 0 || stack.get(categoryKey(targetCategory))?.parent !== 'agent')) {
    targetCategory = PROFILE_PERSONA_CATEGORY;
  }
  const resolved = stack.get(categoryKey(targetCategory));
  const categoryForSide = resolved !== undefined && resolved.parent === targetSide
    ? resolved.name
    : null;
  // Nothing changes: same side and the same category (formatting-insensitive) is a no-op.
  if (targetSide === side && categoryKey(targetCategory) === categoryKey(category)) return null;
  return { side: targetSide, category: categoryForSide ?? targetCategory };
}

export {
  PROFILE_PERSONA_WORDS,
  PROFILE_PREFERENCE_WORDS,
  PROFILE_USER_LIFE_WORDS,
  PROFILE_ROLE_PLAY_GAME,
  PROFILE_SELF_DESCRIPTION,
  PROFILE_IMMEDIATE_REACTION,
  PROFILE_RULE_ECHO,
  PROFILE_LONG_TERM_REQUEST,
  PROFILE_ONE_OFF,
  PROFILE_BEHAVIOR_WORD,
  PROFILE_AGENT_IMPERATIVE,
  NOISE_MORE_SPEECH,
  NOISE_SWITCH,
  NOISE_FREQUENT,
  NOISE_TEST,
  NOISE_TEST_TARGET,
  personaCategoryForText,
  userCategoryForText,
};
