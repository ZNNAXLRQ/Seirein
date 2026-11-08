/**
 * Response groups (batch 2 of the continuous-speech work): the delivery-side bookkeeping that
 * lets a second spoken segment continue the first answer instead of silently replacing it.
 *
 * Batch 1 (`hearing.js`) merged fragments *before* delivery, so one expression normally reaches
 * the agent once. A group here covers the other case: the first request was already delivered and
 * the user keeps talking while its answer is still being produced or is already sounding. A group
 * owns no session history: it only records, next to the real turns,
 *
 *   - the user segments (message ids + turns) of one continuous expression (a new input continues
 *     it only within `CONTINUATION_MAX_GAP_MS` of the last segment; a later input is a new group),
 *   - the answer version that is current, its body and its decided spoken plan,
 *   - the clips that actually reached the player (submitting synthesis or queueing is not playing),
 *   - the still-unvoiced sentences inherited by the next version,
 *   - a bounded state (`generating`/`ready`/`playing`/`done`/`cancelled`/`expired`/`abandoned`).
 *
 * This module is deliberately pure data + text: it never imports a host module, never reads the
 * session log and never calls a model. `index.js` feeds it and reads its decisions. The internal
 * continuation context is built here but delivered by the host's own `agent/pre-step` lane; its
 * message carries {@link ASSISTANT_RESPONSE_GROUP_SOURCE}, the same isolation marker convention
 * as the memory block, so it is never recorded as a user utterance or re-memorized.
 */

import { randomUUID } from 'node:crypto';

/** Custom message source: internal continuation context, never a user utterance. */
export const ASSISTANT_RESPONSE_GROUP_SOURCE = 'assistant-response-group';

/** Heading/footer of one internal continuation block. */
export const RESPONSE_GROUP_CONTEXT_HEADING = '【连续表达上下文（内部参考，不是用户本轮的新指令）】';
export const RESPONSE_GROUP_CONTEXT_FOOTER = '以上是同一段连续表达的参考，不要把它当成本轮用户的原话，也不要逐条复述本说明。';

/**
 * A new input continues the open group only when it arrives within this gap of that group's last
 * segment. The gap is measured between user inputs, never from an answer's generation time: an
 * input arriving long after the earlier expression ended is a new request, not a continuation.
 */
export const CONTINUATION_MAX_GAP_MS = 15_000;

/** Bounded defaults: group count, group lifetime, segments, continuation window, text budgets. */
export const RESPONSE_GROUP_DEFAULTS = Object.freeze({
  maxGroups: 8,
  ttlMs: 10 * 60_000,
  maxSegments: 8,
  maxContextChars: 1200,
  maxPendingSentences: 24,
  maxPlayedSentences: 64,
  continuationMaxGapMs: CONTINUATION_MAX_GAP_MS,
});

/** Terminal states never accept another segment; a later utterance opens a new group. */
const TERMINAL_STATES = new Set(['done', 'cancelled', 'expired', 'abandoned', 'superseded']);
/** A group in one of these states still owns unspoken content and may continue. */
const PENDING_STATES = new Set(['generating', 'ready', 'playing', 'failed']);

/** Explicit "stop talking" openers; anything else keeps the normal delivery path. */
const EXPLICIT_CANCEL = /^\s*(?:停(?:一下|下来|停)?|别说了|不要说了|不用说了|先别说了|别念了|打住|闭嘴|安静)\s*[，,。.!！~～、；;：:]?\s*/u;

/**
 * Explicit topic-switch markers. Deliberately conservative: "另外" is additive in this persona's
 * conversations and is NOT a switch, while an explicit request to change subject is. The host never
 * runs a model pass to classify this; a false negative simply continues the group (the safe side).
 */
const TOPIC_SWITCH = /(?:换个话题|换一个话题|换个题目|说点别的|说个别的|另一个话题|新的话题|换个问题)/u;

/**
 * A new instruction, never a continuation, even 2 s after the previous segment. These are the
 * operators that change what the user is asking for (switch/return/open/close/start/stop); the
 * marker is matched anywhere, because "补充一下，打开 OBS 看看" is still a new instruction.
 */
const NEW_INSTRUCTION = /(?:切(?:回|到|换(?:到|成)?)|回到|返回|打开|关闭|关掉|启动|停止|开启|重启|进入|退出)/u;

/**
 * Openers that may continue the same expression. A candidate must ALSO arrive inside the window and
 * the group must still own unvoiced content — a backlog alone is never sufficient. A bare "再" is
 * not accepted (it precedes many new instructions); the additive forms below are.
 */
const CONTINUATION_OPENER = /^\s*(?:还有|补充|再补充|另外|对了|再加|加上|顺便|此外|以及|然后|继续|接着|完整(?:再)?(?:读|念|说|讲)|再读|再念|再讲|再说|再来)/u;

/** An explicit request to resume content that is waiting unplayed ("继续/接着播"). */
const EXPLICIT_RESUME = /^\s*(?:继续|接着|往下)/u;

/**
 * "切回/回到/返回" leaves the subject being discussed (the classic "切回桌面"): for the carry
 * decision it is a topic switch even though the group machine already calls it a new instruction.
 */
const RETURN_TO_TOPIC = /(?:切(?:回|到|换(?:到|成)?)|回到|返回)/u;

/** Is this input an explicit return to another subject (never a same-topic supplement)? */
export function isReturnToTopicInput(text) {
  return RETURN_TO_TOPIC.test(String(text ?? ''));
}

/** Parse one user input for an explicit cancel. `remainder` is the content after the opener. */
export function isExplicitCancelInput(text) {
  const source = String(text ?? '');
  let rest = source;
  let phrase = '';
  for (let guard = 0; guard < 4; guard += 1) {
    const match = EXPLICIT_CANCEL.exec(rest);
    if (match === null || match[0].trim().length === 0) break;
    phrase = phrase.length === 0 ? match[0].trim() : phrase;
    rest = rest.slice(match[0].length);
  }
  if (phrase.length === 0) return { cancel: false, remainder: '', phrase: '' };
  return { cancel: true, phrase, remainder: rest.trim() };
}

/** Is this user input an explicit request to change the subject? */
export function isTopicSwitchInput(text) {
  return TOPIC_SWITCH.test(String(text ?? ''));
}

/** Is this user input a new instruction (switch/return/open/close/start/stop), never a continuation? */
export function isNewInstructionInput(text) {
  return NEW_INSTRUCTION.test(String(text ?? ''));
}

/** Is this user input phrased as a continuation of the same expression? */
export function isContinuationInput(text) {
  return CONTINUATION_OPENER.test(String(text ?? ''));
}

/** Is this user input an explicit "continue / keep speaking" request for waiting content? */
export function isExplicitResumeInput(text) {
  return EXPLICIT_RESUME.test(String(text ?? ''));
}

const SENTENCE_TERMINATORS = new Set(['。', '！', '？', '!', '?', '；', ';', '\n']);
const SENTENCE_RUN = /[。！？!?；;…\n]/u;
const SENTENCE_CLOSERS = /[”’"'）)】\]」』》〉]/u;

/**
 * Sentence split of a spoken plan. One clause with commas stays one sentence: the block splitter
 * (tts.js) is the only thing that cuts a sentence into comma-sized clips, and a group tracks the
 * sentence because that is what the player really completed.
 */
export function splitSpeechSentences(text) {
  const source = String(text ?? '');
  const out = [];
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    const ch = source[index];
    // One ellipsis is an inner pause; two or more close the sentence (same rule as the speaker).
    const terminator = ch === '…' ? source[index + 1] === '…' : SENTENCE_TERMINATORS.has(ch);
    if (!terminator) continue;
    let end = index + 1;
    while (end < source.length && SENTENCE_RUN.test(source[end])) end += 1;
    while (end < source.length && SENTENCE_CLOSERS.test(source[end])) end += 1;
    const piece = source.slice(start, end).trim();
    if (piece.length > 0) out.push(piece);
    start = end;
    index = end - 1;
  }
  const tail = source.slice(start).trim();
  if (tail.length > 0) out.push(tail);
  return out;
}

/** Comparison key: wording, not whitespace/punctuation, so "第二句。" and "第二句" match. */
export function sentenceKey(text) {
  return String(text ?? '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
}

/** Normalized view of a text's sentences, for exact (never fuzzy) overlap checks. */
function sentenceKeys(text) {
  return splitSpeechSentences(text).map(sentenceKey).filter((key) => key.length > 0);
}

/** Function words that say nothing about the subject; they never prove a shared topic. */
const TOPIC_STOP = new Set([
  '什么', '怎么', '这个', '那个', '一下', '可以', '然后', '还是', '就是', '这样', '那样',
  '我们', '你们', '他们', '不是', '没有', '现在', '时候', '知道', '意思', '问题', '回答',
  '看看', '再说', '补充', '还有', '另外', '接着', '继续', '已经', '需要', '应该', '真的',
]);

/**
 * Content tokens of one text: Han character bigrams plus Latin/digit terms. Deliberately coarse —
 * it only has to answer "is this still the same subject", never to understand it.
 */
function topicTokens(text) {
  const out = new Set();
  const runs = String(text ?? '').toLowerCase().match(/[\p{Script=Han}]+|[a-z0-9][a-z0-9._-]*/gu) ?? [];
  for (const run of runs) {
    if (/^\p{Script=Han}/u.test(run)) {
      if (run.length <= 2) {
        if (!TOPIC_STOP.has(run)) out.add(run);
        continue;
      }
      for (let index = 0; index + 2 <= run.length; index += 1) {
        const gram = run.slice(index, index + 2);
        if (!TOPIC_STOP.has(gram)) out.add(gram);
      }
      continue;
    }
    if (run.length >= 2) out.add(run);
  }
  return out;
}

/**
 * Is the new input still about the same thing? The 15 s window is only an upper bound, never
 * evidence: without a continuation opener or real token overlap the answer is NO (no carry).
 */
export function isSameTopicInput(text, priorText) {
  if (isContinuationInput(text)) return true;
  const prior = topicTokens(priorText);
  if (prior.size === 0) return false;
  let shared = 0;
  let sharedTerm = false;
  for (const token of topicTokens(text)) {
    if (!prior.has(token)) continue;
    if (/^\p{Script=Han}/u.test(token)) shared += 1;
    else sharedTerm = true;
  }
  return sharedTerm || shared >= 2;
}

/** The source a pending answer should be read from: its decided plan, else its body. */
function answerSource(answer) {
  if (answer === null || answer === undefined) return '';
  return String(answer.planText ?? '').trim().length > 0 ? answer.planText : String(answer.body ?? '');
}

/**
 * Sentences of one answer that never reached the player. A started sentence counts as covered:
 * a block cut mid-sentence must not make the next version restart that sentence from the top.
 */
export function unspokenSentencesOf(answer, { maxSentences = RESPONSE_GROUP_DEFAULTS.maxPendingSentences } = {}) {
  if (answer === null || answer === undefined) return [];
  const played = new Set((answer.playedSentences ?? []).map(sentenceKey));
  const source = answerSource(answer);
  const unspoken = splitSpeechSentences(source).filter((sentence) => !played.has(sentenceKey(sentence)));
  return unspoken.slice(-Math.max(1, Math.trunc(maxSentences)));
}

/** Was every sentence of this answer's decided plan actually completed? */
function answerFullyPlayed(answer, maxSentences = RESPONSE_GROUP_DEFAULTS.maxPendingSentences) {
  const source = answerSource(answer);
  const sentences = splitSpeechSentences(source);
  if (sentences.length === 0) return false;
  const completed = new Set((answer.completedSentenceIds ?? []).filter((id) => Number.isInteger(id)));
  if (completed.size < sentences.length) return false;
  // A sentence that was only partly heard still leaves that clip's tail unvoiced; it is covered
  // for "do not repeat", but it keeps the group from claiming a clean completion.
  return (answer.partialSentences ?? []).length === 0;
}

/**
 * The spoken plan of a continuation: keep the part of the new answer that was not already heard,
 * and make sure nothing from the previous answer's unvoiced remainder is lost.
 *
 * `priorPlanText`/`priorBodyText` are the previous version's decided plan (preferred) or full body.
 * `playedTexts` are the sentences that really started playing. Leading new sentences that repeat
 * already-played content are dropped (no restart from the top); prior unvoiced sentences that the
 * new plan does not itself contain are prepended (coverage). Exact sentence matching only.
 *
 * @returns {{text: string, prepended: string[], skippedPlayed: string[], unplayedPrior: string[]}}
 */
export function composeContinuationSpeech({
  priorPlanText = '',
  priorBodyText = '',
  playedTexts = [],
  newPlanText = '',
} = {}) {
  const priorSource = String(priorPlanText ?? '').trim().length > 0 ? priorPlanText : priorBodyText;
  const priorSentences = splitSpeechSentences(priorSource);
  const playedKeys = new Set((Array.isArray(playedTexts) ? playedTexts : []).map(sentenceKey).filter(Boolean));
  const unplayedPrior = priorSentences.filter((sentence) => !playedKeys.has(sentenceKey(sentence)));
  const next = splitSpeechSentences(newPlanText);
  // A new plan often opens by repeating the previous opening; drop exactly the played prefix.
  const skippedPlayed = [];
  while (next.length > 0 && playedKeys.has(sentenceKey(next[0]))) {
    skippedPlayed.push(next.shift());
  }
  const nextKeys = new Set(next.map(sentenceKey).filter(Boolean));
  const prepended = unplayedPrior.filter((sentence) => {
    const key = sentenceKey(sentence);
    if (key.length === 0) return false;
    if (nextKeys.has(key)) return false;
    nextKeys.add(key);
    return true;
  });
  const final = [...prepended, ...next];
  return {
    text: final.join(''),
    prepended,
    skippedPlayed,
    unplayedPrior,
  };
}

/**
 * B: the previous round's never-spoken points are carried as "待传达" material for the next
 * round's spoken organization. They are NOT a user message, NOT merged into the visible answer
 * and NOT a copy of the body: the organizer weaves them into the one spoken version it produces.
 */
export const CARRY_CONVEY_SYSTEM_NOTE = '如有【待传达】，用一两句把其中仍有效的信息自然融入本次口语回复；不逐句复述、不重复；相互矛盾时以新回答为准。';

/** The organizer's user block: the carried points, then the complete body (never truncated). */
export function composeCarryConveyUser(carryText, source) {
  return `<上一轮待传达>\n${String(carryText ?? '')}\n</上一轮待传达>\n<完整答复>\n${String(source ?? '')}\n</完整答复>`;
}

/** Explicit correction in the NEW answer: old points must not be replayed over it. */
const CARRY_CORRECTION = /(?:更正|纠正|改为|(?:不是|并非)[^。！？；;]{0,24}?(?:而是|是)|以[^。！？；;]{0,12}为准)/u;

/**
 * Deterministic merge used when the organizer is unavailable: the carried points, then the new
 * answer with exactly repeated sentences dropped. Nothing is cut or reworded (no char budget).
 */
export function composeCarryConveyText(carryText, newText) {
  const carried = splitSpeechSentences(carryText);
  const seen = new Set(carried.map(sentenceKey).filter((key) => key.length > 0));
  const fresh = splitSpeechSentences(newText).filter((sentence) => {
    const key = sentenceKey(sentence);
    if (key.length === 0 || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return [...carried, ...fresh].join('');
}

/**
 * Budget-aware fallback when the organizer is unavailable (or refused): the CURRENT answer keeps
 * its place, and carried points only ride along when they fit the speech budget and the new answer
 * does not correct them. Otherwise they stay pending for a later round, never forced into this
 * playback (the old "old + new" hard merge could spend the whole budget on the old points).
 *
 * @returns {{text: string, pending: string[], merged: boolean}}
 */
export function composeCarryConveyFallback(carryText, newText, { maxChars = 0 } = {}) {
  const fresh = splitSpeechSentences(newText);
  const freshKeys = new Set(fresh.map(sentenceKey).filter(Boolean));
  const carried = splitSpeechSentences(carryText).filter((sentence) => {
    const key = sentenceKey(sentence);
    return key.length > 0 && !freshKeys.has(key);
  });
  // A correction in the new answer wins: replaying the old point would contradict it.
  const corrected = CARRY_CORRECTION.test(String(newText ?? ''));
  const merged = corrected ? [] : [...carried, ...fresh];
  const budget = Number(maxChars) > 0 ? Math.trunc(Number(maxChars)) : 0;
  const fits = budget === 0 || [...merged.join('')].length <= budget;
  if (!fits || merged.length === 0) {
    return { text: fresh.join(''), pending: carried, merged: false };
  }
  return { text: merged.join(''), pending: [], merged: true };
}

/**
 * The internal context appended to the next turn's first pre-step. It is reference material, not a
 * user message: the host marks it with {@link ASSISTANT_RESPONSE_GROUP_SOURCE} and every memory /
 * ack / typed-voice lane already excludes that marker.
 *
 * @param {object} options
 * @param {object} options.group response group record
 * @param {string} options.newInput the newly delivered segment
 * @param {number} [options.maxChars]
 */
export function composeResponseGroupContext({ group, newInput = '', maxChars = RESPONSE_GROUP_DEFAULTS.maxContextChars } = {}) {
  if (group === null || group === undefined || typeof group !== 'object') return '';
  const budget = Math.max(200, Math.trunc(Number(maxChars) || RESPONSE_GROUP_DEFAULTS.maxContextChars));
  const segments = Array.isArray(group.segments) ? group.segments : [];
  const prior = group.priorAnswer ?? null;
  const priorPlayed = (Array.isArray(group.played) ? group.played : []).slice(-6);
  const pending = Array.isArray(group.pendingSentences) && group.pendingSentences.length > 0
    ? group.pendingSentences.slice(-8)
    : unspokenSentencesOf(prior, { maxSentences: 8 });
  const lines = [RESPONSE_GROUP_CONTEXT_HEADING];
  lines.push('同一段连续表达被分成了几段，请把它们当成一次请求，连贯地回应。');
  if (segments.length > 0) {
    lines.push('已收到的用户输入（按时间顺序）：');
    for (let index = 0; index < segments.length; index += 1) {
      const text = String(segments[index]?.text ?? '').trim();
      if (text.length === 0) continue;
      lines.push(`${index + 1}. ${text}`);
    }
  }
  if (pending.length > 0) {
    lines.push('上一轮已经生成、但还没有口头说出的内容（这次要覆盖）：');
    for (const sentence of pending) lines.push(`- ${sentence}`);
  }
  if (priorPlayed.length > 0) {
    lines.push('已经实际播出、不要从头重复的内容：');
    for (const sentence of priorPlayed) lines.push(`- ${sentence}`);
  }
  lines.push(`本次新增输入：${String(newInput ?? '').trim()}`);
  lines.push('要求：把前后内容合成一次回应，覆盖上面尚未口头说出的部分；已经播出的内容不要从头重复，也不要只总结前一轮。');
  lines.push(RESPONSE_GROUP_CONTEXT_FOOTER);
  let text = lines.join('\n');
  if (text.length > budget) text = `${text.slice(0, Math.max(0, budget - 1))}…`;
  return text;
}

/** The pre-step message carrying the continuation context (never recorded as a user utterance). */
export function responseGroupContextMessage(text, { groupId = '', version = 0 } = {}) {
  return {
    id: randomUUID(),
    role: 'user',
    source: { kind: ASSISTANT_RESPONSE_GROUP_SOURCE, groupId, version },
    content: [{ type: 'text', text: String(text ?? '') }],
  };
}

/** True for this module's internal context message (the one exclusion marker every lane uses). */
export function isResponseGroupContextMessage(message) {
  return message?.source?.kind === ASSISTANT_RESPONSE_GROUP_SOURCE;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 1 ? Math.floor(number) : fallback;
}

function createAnswer(version, { at }) {
  return {
    version,
    state: 'generating',
    createdAt: at,
    updatedAt: at,
    turn: null,
    body: '',
    bodyChars: 0,
    planText: '',
    planChars: 0,
    feedText: '',
    source: '',
    playedSentences: [],
    completedSentenceIds: [],
    partialSentences: [],
    clips: [],
    progress: { started: 0, completed: 0, partial: 0 },
    inheritedVersion: null,
    error: '',
    completedReason: '',
  };
}

function groupView(group, extra = {}) {
  return {
    groupId: group.id,
    sessionId: group.sessionId,
    generation: group.generation,
    answerVersion: group.answerVersion,
    state: group.state,
    reason: group.reason,
    segments: Array.isArray(group.segments) ? group.segments.length : 0,
    turns: Array.isArray(group.turns) ? group.turns.length : 0,
    played: Array.isArray(group.played) ? group.played.length : 0,
    pending: Array.isArray(group.pendingSentences) ? group.pendingSentences.length : 0,
    /** Answer text done but voice not finished; never inherited by a different group. */
    speechPending: group.speechPending === null || group.speechPending === undefined
      ? 0
      : group.speechPending.sentences.length,
    /** B: has any sentence of this group actually started sounding? (played=0 ⇔ false) */
    speechStarted: group.speechStarted === true,
    /** B: points this group's speech must convey from the previous never-spoken round. */
    carry: group.carryConvey === null || group.carryConvey === undefined
      ? 0
      : group.carryConvey.sentences.length,
    ...extra,
  };
}

/**
 * The response-group state machine. All methods are synchronous and bounded; the host calls them
 * from its voice lanes and emits the returned decisions as its own events.
 *
 * @param {object} [options]
 * @param {Function} [options.now] clock seam (tests may advance time)
 * @param {number} [options.maxGroups] hard cap on retained groups (default 8)
 * @param {number} [options.ttlMs] group lifetime from creation (default 10 minutes)
 * @param {number} [options.maxSegments] segments one group may accept (default 8)
 * @param {number} [options.maxContextChars] internal-context budget (default 1200)
 * @param {number} [options.maxPendingSentences] unvoiced-sentence bound per answer (default 24)
 * @param {number} [options.maxPlayedSentences] played-sentence history bound (default 64)
 * @param {number} [options.continuationMaxGapMs] max input gap that may still continue (default 15 s)
 * @param {Function} [options.emit] `(type, payload) => void`, the host's observability outlet
 */
export function createResponseGroupStore({
  now = () => Date.now(),
  maxGroups = RESPONSE_GROUP_DEFAULTS.maxGroups,
  ttlMs = RESPONSE_GROUP_DEFAULTS.ttlMs,
  maxSegments = RESPONSE_GROUP_DEFAULTS.maxSegments,
  maxContextChars = RESPONSE_GROUP_DEFAULTS.maxContextChars,
  maxPendingSentences = RESPONSE_GROUP_DEFAULTS.maxPendingSentences,
  maxPlayedSentences = RESPONSE_GROUP_DEFAULTS.maxPlayedSentences,
  continuationMaxGapMs = RESPONSE_GROUP_DEFAULTS.continuationMaxGapMs,
  emit = null,
} = {}) {
  const groups = new Map();
  const groupLimit = positiveInteger(maxGroups, RESPONSE_GROUP_DEFAULTS.maxGroups);
  const lifetime = positiveInteger(ttlMs, RESPONSE_GROUP_DEFAULTS.ttlMs);
  const segmentLimit = positiveInteger(maxSegments, RESPONSE_GROUP_DEFAULTS.maxSegments);
  const contextChars = positiveInteger(maxContextChars, RESPONSE_GROUP_DEFAULTS.maxContextChars);
  const pendingLimit = positiveInteger(maxPendingSentences, RESPONSE_GROUP_DEFAULTS.maxPendingSentences);
  const playedLimit = positiveInteger(maxPlayedSentences, RESPONSE_GROUP_DEFAULTS.maxPlayedSentences);
  const gapLimit = positiveInteger(continuationMaxGapMs, RESPONSE_GROUP_DEFAULTS.continuationMaxGapMs);
  let sequence = 0;
  let pendingInternal = null;

  const publish = (type, payload) => {
    try {
      emit?.(type, payload);
    } catch {
      /* observation only: a broken sink never changes the state machine */
    }
  };

  const sessionsActive = () => {
    const counts = new Map();
    for (const group of groups.values()) {
      if (TERMINAL_STATES.has(group.state)) continue;
      counts.set(group.sessionId, (counts.get(group.sessionId) ?? 0) + 1);
    }
    return counts;
  };

  const expireGroup = (group, at, reason = 'ttl') => {
    if (TERMINAL_STATES.has(group.state)) return false;
    // An expired expression may still hold generated-but-unvoiced text: keep it as speechPending,
    // never silently drop it into "unanswered".
    markSpeechPending(group, at, reason);
    group.state = 'expired';
    group.reason = reason;
    group.updatedAt = at;
    if (group.currentAnswer !== null && group.currentAnswer !== undefined
      && !TERMINAL_STATES.has(group.currentAnswer.state)) {
      group.currentAnswer.state = 'expired';
    }
    publish('voice.response.group.expired', {
      ...groupView(group),
      reason,
      ageMs: Math.max(0, at - group.createdAt),
      retained: true,
    });
    return true;
  };

  const abandonGroup = (group, at, reason, extra = {}) => {
    if (TERMINAL_STATES.has(group.state)) return false;
    // Leaving the group is not a cancel: text that was already answered but never voiced stays
    // available as `speechPending` (explicit resume only), and is never mixed into a new group.
    markSpeechPending(group, at, reason);
    group.state = 'abandoned';
    group.reason = reason;
    group.updatedAt = at;
    publish('voice.response.group.abandoned', {
      ...groupView(group),
      reason,
      retained: true,
      ...extra,
    });
    return true;
  };

  /** Bounded retention: terminal groups go first; otherwise the oldest active group is abandoned. */
  const trim = (at) => {
    while (groups.size > groupLimit) {
      let victim = null;
      for (const group of groups.values()) {
        if (TERMINAL_STATES.has(group.state)) {
          victim = group;
          break;
        }
      }
      if (victim === null) {
        victim = groups.values().next().value ?? null;
        if (victim === null) return;
        abandonGroup(victim, at, 'group-limit');
      }
      groups.delete(victim.id);
      publish('voice.response.group.evicted', {
        groupId: victim.id,
        sessionId: victim.sessionId,
        reason: 'limit',
        priorState: victim.state,
        groups: groups.size,
      });
    }
  };

  const sweep = (at) => {
    for (const group of groups.values()) {
      if (TERMINAL_STATES.has(group.state)) continue;
      if (at >= group.expiresAt) expireGroup(group, at, 'ttl');
    }
  };

  const newestFor = (sessionId) => {
    let found = null;
    for (const group of groups.values()) {
      if (group.sessionId !== sessionId) continue;
      found = group;
    }
    return found;
  };

  /** Played keys of one group: exact sentence wording, so punctuation never changes coverage. */
  const playedKeySet = (group) => new Set((group.played ?? []).map(sentenceKey).filter(Boolean));

  /** Remember generated-but-unvoiced sentences (body or plan), bounded and punctuation-insensitive. */
  const rememberPending = (group, text) => {
    const played = playedKeySet(group);
    const known = new Set(group.pendingSentences.map(sentenceKey));
    for (const sentence of splitSpeechSentences(text)) {
      const key = sentenceKey(sentence);
      if (key.length === 0 || played.has(key) || known.has(key)) continue;
      known.add(key);
      group.pendingSentences.push(sentence);
    }
    while (group.pendingSentences.length > pendingLimit) group.pendingSentences.shift();
  };

  /** Replace the unvoiced set with the sentences of one adjusted plan (what will really be said). */
  const replacePendingFromPlan = (group, text) => {
    const played = playedKeySet(group);
    const seen = new Set();
    const next = [];
    for (const sentence of splitSpeechSentences(text)) {
      const key = sentenceKey(sentence);
      if (key.length === 0 || played.has(key) || seen.has(key)) continue;
      seen.add(key);
      next.push(sentence);
    }
    group.pendingSentences = next.slice(-pendingLimit);
  };

  /** A sentence actually started: it is no longer pending, whatever version announced it. */
  const forgetPendingPlayed = (group, text) => {
    const key = sentenceKey(text);
    if (key.length === 0) return;
    group.pendingSentences = group.pendingSentences.filter((sentence) => sentenceKey(sentence) !== key);
  };

  const hasPending = (group) => {
    if (Array.isArray(group.pendingSentences) && group.pendingSentences.length > 0) return true;
    if (group.currentAnswer !== null && group.currentAnswer !== undefined
      && group.currentAnswer.state === 'generating') return true;
    return false;
  };

  /**
   * The part of a group whose TEXT answer is already produced but whose voice never finished.
   * This is deliberately a separate set from `pendingSentences` (which may also cover an answer
   * that was never generated at all): it is retained for an explicit resume, never merged into a
   * different group and never played automatically.
   */
  const pendingSpeechOf = (group) => {
    const answer = group.currentAnswer ?? null;
    const rows = [];
    const seen = new Set();
    const played = playedKeySet(group);
    const push = (sentence) => {
      const key = sentenceKey(sentence);
      if (key.length === 0 || seen.has(key) || played.has(key)) return;
      seen.add(key);
      rows.push(String(sentence));
    };
    const carry = group.carryConvey ?? null;
    // An unfulfilled carry is still unspoken material of this group. A third input arriving before
    // the next spoken plan is back must inherit the original points too (A -> B -> C), never drop
    // them just because `pendingSentences`/the current body no longer mention them.
    for (const sentence of carry?.sentences ?? []) push(sentence);
    for (const sentence of group.pendingSentences ?? []) push(sentence);
    if (answer !== null) {
      for (const sentence of unspokenSentencesOf(answer, { maxSentences: pendingLimit })) push(sentence);
      // A sentence that STARTED but never completed still leaves an unvoiced tail. Its id is not
      // in `completedSentenceIds`, so it belongs to speechPending even when it is no longer
      // "unspoken" by wording. (The id is the split index the speaker was given.)
      const sourceSentences = splitSpeechSentences(answerSource(answer));
      const completed = new Set((answer.completedSentenceIds ?? []).filter((id) => Number.isInteger(id)));
      for (let index = 0; index < sourceSentences.length; index += 1) {
        if (!completed.has(index)) push(sourceSentences[index]);
      }
    }
    if (rows.length === 0) return null;
    const bounded = rows.slice(-pendingLimit);
    return { sentences: bounded, chars: bounded.join('').length };
  };

  /**
   * Mark "answer text done, speech incomplete" without clearing anything: the content stays on the
   * old group as `speechPending`, and only an explicit resume request may restore it. The event is
   * `voice.response.group.speech-pending`; it is never emitted for an unanswered (empty) answer.
   */
  const markSpeechPending = (group, at, reason) => {
    if (group === null || group === undefined) return false;
    const pending = pendingSpeechOf(group);
    if (pending === null) return false;
    const prior = group.speechPending;
    // A repeated mark with the same content is not a second event (late output may call this again).
    if (prior !== null && prior !== undefined && prior.version === group.answerVersion
      && prior.chars === pending.chars && prior.sentences.length === pending.sentences.length) {
      return false;
    }
    group.speechPending = {
      sentences: pending.sentences,
      chars: pending.chars,
      at,
      reason: String(reason ?? ''),
      version: group.answerVersion,
    };
    publish('voice.response.group.speech-pending', {
      groupId: group.id,
      sessionId: group.sessionId,
      sentences: pending.sentences.length,
      chars: pending.chars,
      answerVersion: group.answerVersion,
      reason: String(reason ?? ''),
    });
    return true;
  };

  /** The newest group of this session that still has unplayed, already-generated answer text. */
  const newestSpeechPending = (sessionId) => {
    let found = null;
    for (const group of groups.values()) {
      if (group.sessionId !== sessionId) continue;
      if (group.speechPending === null || group.speechPending === undefined) continue;
      found = group;
    }
    return found;
  };

  const decide = (group, text, at) => {
    if (TERMINAL_STATES.has(group.state)) return { continuation: false, reason: `prior-${group.state}` };
    if (at >= group.expiresAt) {
      expireGroup(group, at, 'ttl');
      return { continuation: false, reason: 'prior-expired' };
    }
    // The window is between the two user inputs. A group may still hold unvoiced content, but an
    // input arriving after `continuationMaxGapMs` is a new request: it never inherits or merges the
    // earlier answer. The group is retained (abandoned) so its pending content stays diagnosable.
    const lastSegment = group.segments[group.segments.length - 1] ?? null;
    const gapMs = Math.max(0, at - (Number(lastSegment?.at) || group.createdAt));
    if (gapMs > gapLimit) return { continuation: false, reason: 'prior-idle', gapMs };
    // A new instruction or an explicit subject change ALWAYS opens a new group, even 2 s later.
    if (isTopicSwitchInput(text)) return { continuation: false, reason: 'topic-switch' };
    if (isNewInstructionInput(text)) return { continuation: false, reason: 'new-instruction' };
    // Inside the window the input must still be phrased as a continuation. A separate request
    // ("新回答" / "明天天气怎么样") is never merged just because this group still has a backlog.
    if (!isContinuationInput(text)) return { continuation: false, reason: 'not-continuation' };
    if (group.generation >= segmentLimit) return { continuation: false, reason: 'segment-limit' };
    if (group.state === 'done') return { continuation: false, reason: 'prior-complete' };
    if (PENDING_STATES.has(group.state) || hasPending(group)) {
      return { continuation: true, reason: `continue-${group.state}` };
    }
    return { continuation: false, reason: `prior-${group.state}` };
  };

  /**
   * B: may this input carry the previous round's never-spoken points into its own speech?
   * Only "previous round never started sounding + inside the 15 s window + still the same subject"
   * merges. A budget-deferred point was excluded from its round's plan, so it is still unspoken
   * even after that round started speaking. Every uncertain answer is NO.
   */
  const carryDecision = (group, text, at) => {
    // The unvoiced remainder of the previous round: an answer that was streamed straight to the
    // speaker never populated `pendingSentences`, so the decided plan/body is the source of truth.
    const pending = pendingSpeechOf(group);
    const sentences = pending === null ? [] : pending.sentences;
    // A budget-deferred carry was excluded from its round's plan, so it never sounded: it may still
    // ride the next round even after that round started speaking. Every other point is replayed
    // only while the round was still silent.
    const played = playedKeySet(group);
    const seen = new Set();
    const deferredSentences = (group.carryConvey?.deferred === true ? group.carryConvey.sentences ?? [] : [])
      .map((sentence) => String(sentence ?? ''))
      .filter((sentence) => {
        const key = sentenceKey(sentence);
        if (key.length === 0 || played.has(key) || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    // A round with nothing unvoiced has nothing to decide (and no event is written).
    if (sentences.length === 0) return null;
    const base = {
      priorGroupId: group.id,
      sentences,
      chars: sentences.join('').length,
      gapMs: Math.max(0, at - (Number(group.segments[group.segments.length - 1]?.at) || group.createdAt)),
    };
    if (base.gapMs > gapLimit) return { ...base, merged: false, reason: 'prior-idle' };
    // A round that already sounded is never re-spoken automatically, whatever the new input says.
    // Deferred points are the one exception: no spoken plan ever contained them.
    if (group.speechStarted === true && deferredSentences.length === 0) {
      return { ...base, merged: false, reason: 'prior-played' };
    }
    if (isTopicSwitchInput(text) || isReturnToTopicInput(text)) {
      return { ...base, merged: false, reason: 'topic-switch' };
    }
    if (isNewInstructionInput(text)) return { ...base, merged: false, reason: 'new-instruction' };
    const priorText = `${group.lastUserInput}\n${answerSource(group.currentAnswer ?? group.priorAnswer)}`;
    if (!isSameTopicInput(text, priorText)) return { ...base, merged: false, reason: 'not-same-topic' };
    // Once a round sounded, only its never-planned deferred points may be carried.
    const carried = group.speechStarted === true ? deferredSentences : sentences;
    return { ...base, sentences: carried, chars: carried.join('').length, merged: true, reason: 'same-topic' };
  };

  /** Attach the carried points to this group/version and report the decision (one row per input). */
  const applyCarry = (group, carry, version) => {
    if (carry === null || carry === undefined) return;
    group.carryConvey = carry.merged === true && carry.sentences.length > 0
      ? {
        priorGroupId: carry.priorGroupId,
        sentences: carry.sentences.slice(),
        chars: carry.chars,
        version,
        reason: carry.reason,
        at: now(),
      }
      : null;
    publish('voice.carry.convey', {
      groupId: group.id,
      priorGroupId: carry.priorGroupId,
      sentences: carry.sentences.length,
      chars: carry.chars,
      merged: carry.merged === true,
      reason: carry.reason,
      gapMs: carry.gapMs,
      answerVersion: version,
    });
  };

  /**
   * A fallback plan could not convey the carried points inside the speech budget: keep exactly
   * those points as still-unfulfilled carry material for a later round.
   */
  const deferCarry = ({ group, version, sentences = [] } = {}) => {
    if (group === null || group === undefined) return null;
    const rows = (Array.isArray(sentences) ? sentences : [])
      .map((sentence) => String(sentence ?? '').trim())
      .filter((sentence) => sentenceKey(sentence).length > 0);
    if (rows.length === 0) return null;
    const prior = group.carryConvey ?? null;
    group.carryConvey = {
      priorGroupId: prior?.priorGroupId ?? group.id,
      sentences: rows.slice(-pendingLimit),
      chars: rows.join('').length,
      version,
      reason: 'budget-deferred',
      deferred: true,
      at: now(),
    };
    return group.carryConvey;
  };

  /** The carried points this answer version's spoken organization must convey (null when none). */
  const carryForSpeech = (group, version) => {
    if (group === null || group === undefined) return null;
    const carry = group.carryConvey;
    if (carry === null || carry === undefined) return null;
    if (carry.version !== version || !isCurrentAnswer(group, version)) return null;
    const sentences = carry.sentences.filter((row) => String(row).trim().length > 0);
    if (sentences.length === 0) return null;
    return { priorGroupId: carry.priorGroupId, sentences, chars: sentences.join('').length };
  };

  const createGroup = ({ sessionId, speakerId, text, at, reason }) => {
    sequence += 1;
    const answer = createAnswer(1, { at });
    const group = {
      id: `rg-${sequence}`,
      sessionId,
      speakerId: typeof speakerId === 'string' ? speakerId : '',
      state: 'generating',
      reason,
      generation: 1,
      answerVersion: 1,
      segments: [{ text: String(text ?? ''), at, generation: 1, messageId: '', turn: null }],
      turns: [],
      messageIds: [],
      createdAt: at,
      updatedAt: at,
      expiresAt: at + lifetime,
      currentAnswer: answer,
      priorAnswer: null,
      played: [],
      /** Generated-but-unvoiced sentences carried across answer versions (bounded). */
      pendingSentences: [],
      /**
       * Answer text done but voice not finished. It is never inherited by another group and is
       * only restored by an explicit "继续/接着播". Null while the group is live.
       */
      speechPending: null,
      /** B: did any sentence of this group really start sounding? (the carry gate) */
      speechStarted: false,
      /**
       * B: the previous round's never-spoken points, kept for THIS group's spoken organization
       * only. It is not a user message, not a body, and not written into memory.
       */
      carryConvey: null,
      cancelReason: '',
      // Cached copies for the bounded continuation context (the message itself is never stored).
      lastUserInput: String(text ?? ''),
    };
    groups.set(group.id, group);
    trim(at);
    publish('voice.response.group.created', {
      ...groupView(group),
      reason,
      groups: groups.size,
      ttlMs: lifetime,
    });
    return group;
  };

  /**
   * Open the next answer version of a group. Used by both a genuine continuation and an explicit
   * resume of `speechPending`; the only difference is the source of the covered sentences.
   */
  const continueGroup = (group, text, at, reason) => {
    const prior = group.currentAnswer;
    const resuming = group.speechPending !== null && group.speechPending !== undefined;
    if (resuming) {
      // Explicit resume: restore exactly what was waiting, in transcript order, never a played
      // sentence. This is the ONLY path that turns speechPending back into pending coverage.
      const played = playedKeySet(group);
      const seen = new Set();
      const restored = [];
      for (const sentence of group.speechPending.sentences) {
        const key = sentenceKey(sentence);
        if (key.length === 0 || played.has(key) || seen.has(key)) continue;
        seen.add(key);
        restored.push(sentence);
      }
      group.pendingSentences = restored.slice(-pendingLimit);
      group.speechPending = null;
      // A resumed group may already be past its original lifetime; give this new version its own.
      group.expiresAt = at + lifetime;
    }
    // The superseded version's generated-but-unvoiced sentences become the group's pending
    // coverage; its playback coverage is already in `played`.
    rememberPending(group, answerSource(prior));
    prior.updatedAt = at;
    const version = group.answerVersion + 1;
    const answer = createAnswer(version, { at });
    answer.inheritedVersion = prior.version;
    group.priorAnswer = prior;
    group.currentAnswer = answer;
    group.answerVersion = version;
    group.generation += 1;
    group.state = 'generating';
    group.reason = reason;
    group.updatedAt = at;
    group.segments.push({ text: String(text ?? ''), at, generation: group.generation, messageId: '', turn: null });
    group.lastUserInput = String(text ?? '');
    const priorUnspoken = unspokenSentencesOf(prior, { maxSentences: pendingLimit });
    publish('voice.response.group.continued', {
      ...groupView(group),
      priorVersion: prior.version,
      priorState: prior.state,
      playedSentences: (prior.playedSentences ?? []).length,
      unplayedSentences: Math.max(priorUnspoken.length, group.pendingSentences.length),
      newChars: String(text ?? '').length,
    });
    return {
      group,
      generation: group.generation,
      answerVersion: version,
      continuation: true,
      priorVersion: prior.version,
      reason,
    };
  };

  /**
   * Register one delivered segment: either continue the session's open group or open a new one.
   * @returns {{group: object, generation: number, answerVersion: number, continuation: boolean,
   *            priorVersion: number, reason: string, gapMs?: number}}
   */
  const beginInput = ({ sessionId, text, speakerId = '', at = now() } = {}) => {
    sweep(at);
    // B: "继续/接着播" is the only request that restores speech that was already answered but
    // never voiced. Without it the content stays speechPending and a new group never sees it.
    if (isExplicitResumeInput(text)) {
      const pending = newestSpeechPending(sessionId);
      if (pending !== null) {
        // An explicit resume restores the unplayed text verbatim: it is never re-organized.
        const resumed = continueGroup(pending, text, at, 'resume-pending');
        resumed.group.carryConvey = null;
        return resumed;
      }
    }
    const current = newestFor(sessionId);
    // B: the carry decision is taken against the previous round BEFORE it is retired.
    const carry = current === null ? null : carryDecision(current, text, at);
    let decision = { continuation: false, reason: 'new' };
    if (current !== null) {
      decision = decide(current, text, at);
      if (decision.continuation === true) {
        // A same-group continuation is already an explicit continuation decision; it may keep
        // the unvoiced remainder of the previous version.
        const continued = continueGroup(current, text, at, decision.reason);
        applyCarry(continued.group, carry, continued.answerVersion);
        return continued;
      }
      // Any non-continuation path retires the old group. Its answered-but-unvoiced content is
      // kept as speechPending (not merged, not auto-played) before the group becomes terminal.
      if (decision.reason === 'prior-idle') {
        abandonGroup(current, at, 'prior-idle', { gapMs: decision.gapMs });
      } else if (decision.reason === 'topic-switch' || decision.reason === 'new-instruction'
        || decision.reason === 'not-continuation' || decision.reason === 'segment-limit') {
        abandonGroup(current, at, decision.reason);
      }
    }
    const group = createGroup({ sessionId, speakerId, text, at, reason: decideReason(current, decision) });
    applyCarry(group, carry, 1);
    return {
      group,
      generation: group.generation,
      answerVersion: 1,
      continuation: false,
      priorVersion: 0,
      reason: group.reason,
      ...(Number.isFinite(decision.gapMs) ? { gapMs: decision.gapMs } : {}),
    };
  };

  const decideReason = (current, decision) => {
    if (current === null) return 'new';
    if (decision.reason === 'topic-switch') return 'topic-switch';
    if (decision.reason === 'segment-limit') return 'segment-limit';
    if (decision.reason === 'new-instruction') return 'new-instruction';
    if (decision.reason === 'not-continuation') return 'not-continuation';
    return decision.reason;
  };

  const find = (groupId) => groups.get(String(groupId ?? '')) ?? null;

  /** Associate the injected message id and the accepted turn with this segment/version. */
  const attachDelivery = ({ group, version, messageId = '', turn = null } = {}) => {
    if (group === null || group === undefined) return;
    const segment = group.segments[group.segments.length - 1];
    if (segment !== undefined && segment !== null) {
      if (typeof messageId === 'string' && messageId.length > 0) segment.messageId = messageId;
      if (Number.isInteger(turn)) segment.turn = turn;
    }
    if (typeof messageId === 'string' && messageId.length > 0 && !group.messageIds.includes(messageId)) {
      group.messageIds.push(messageId);
      if (group.messageIds.length > segmentLimit) group.messageIds.shift();
    }
    if (Number.isInteger(turn) && !group.turns.includes(turn)) {
      group.turns.push(turn);
      if (group.turns.length > segmentLimit) group.turns.shift();
    }
    const answer = findAnswer(group, version);
    if (answer !== null && Number.isInteger(turn)) answer.turn = turn;
  };

  const findAnswer = (group, version) => {
    if (group === null || group === undefined) return null;
    if (group.currentAnswer?.version === version) return group.currentAnswer;
    if (group.priorAnswer?.version === version) return group.priorAnswer;
    return null;
  };

  const isCurrentAnswer = (group, version) => (
    group !== null && group !== undefined
    && group.currentAnswer?.version === version
    && !TERMINAL_STATES.has(group.state)
    && group.currentAnswer.state !== 'cancelled'
    && group.currentAnswer.state !== 'failed'
  );

  /**
   * A retired group can still receive its own turn's late body/plan. Keep that content on the old
   * group as speechPending (joinable by an explicit resume); it never moves into a newer group.
   */
  const refreshRetiredSpeechPending = (group) => {
    if (group === null || group === undefined) return;
    if (group.state !== 'abandoned' && group.state !== 'expired') return;
    markSpeechPending(group, now(), group.speechPending?.reason || 'late-result');
  };

  /** Store the committed body once the agent turn succeeded (it still enters memory normally). */
  const noteAnswerBody = ({ group, version, turn = null, text = '' } = {}) => {
    const answer = findAnswer(group, version);
    if (answer === null) return;
    answer.body = String(text ?? '');
    answer.bodyChars = answer.body.length;
    answer.updatedAt = now();
    if (Number.isInteger(turn)) answer.turn = turn;
    if (answer.state === 'generating') answer.state = 'ready';
    // Only a version that is already superseded contributes pending coverage, and only when it has
    // no decided plan yet: the plan (possibly condensed) is the authoritative spoken share.
    if (!isCurrentAnswer(group, version) && String(answer.planText ?? '').trim().length === 0) {
      rememberPending(group, answer.body);
    }
    refreshRetiredSpeechPending(group);
    publish('voice.response.group.body', {
      ...groupView(group),
      version,
      turn: Number.isInteger(turn) ? turn : null,
      chars: answer.bodyChars,
      playedChars: (answer.playedSentences ?? []).join('').length,
    });
  };

  /** Store the decided spoken plan (what the voice would say), even if a newer version took over. */
  const noteAnswerPlan = ({ group, version, turn = null, text = '', feedText = '', source = '', chars = 0 } = {}) => {
    const answer = findAnswer(group, version);
    if (answer === null) return null;
    answer.planText = String(text ?? '');
    answer.feedText = String(feedText ?? answer.planText);
    answer.planChars = Number(chars) > 0 ? Number(chars) : answer.planText.length;
    answer.source = String(source ?? '');
    answer.updatedAt = now();
    if (Number.isInteger(turn)) answer.turn = turn;
    if (answer.state === 'generating') answer.state = 'ready';
    // A superseded version that decides its plan late still contributes its unvoiced sentences;
    // the current version's plan is handled by adjustSpeech (condensed share, exact coverage).
    if (!isCurrentAnswer(group, version)) rememberPending(group, answer.planText);
    refreshRetiredSpeechPending(group);
    if (isCurrentAnswer(group, version)) {
      group.state = group.state === 'playing' ? 'playing' : 'ready';
      publish('voice.response.group.ready', {
        ...groupView(group),
        version,
        turn: Number.isInteger(turn) ? turn : null,
        chars: answer.planChars,
        source: answer.source,
      });
    }
    return answer;
  };

  /**
   * Continue the new version's spoken plan past what was already heard. Returns the text the
   * speaker should play; exact sentence matching only, no semantic guessing.
   */
  const adjustSpeech = ({ group, version, text = '', turn = null } = {}) => {
    const answer = findAnswer(group, version);
    const original = String(text ?? '');
    if (answer === null || !Array.isArray(group.pendingSentences)) {
      return { text: original, prepended: [], skippedPlayed: [], unplayedPrior: [], changed: false };
    }
    // B: the carried points were already woven into THIS plan by the spoken organizer; prepending
    // the old sentences again would say them twice. The plan owns the pending coverage instead.
    if (carryForSpeech(group, version) !== null) {
      replacePendingFromPlan(group, original);
      if (Number.isInteger(turn)) answer.turn = turn;
      // A budget-deferred fallback did NOT convey them: keep the points pending for a later round.
      const deferred = group.carryConvey?.deferred === true;
      if (!deferred) group.carryConvey = null;
      return {
        text: original, prepended: [], skippedPlayed: [], unplayedPrior: [], changed: false,
        carried: !deferred, deferred,
      };
    }
    const priorUnspoken = group.pendingSentences.slice();
    const composed = composeContinuationSpeech({
      priorPlanText: priorUnspoken.join(''),
      playedTexts: group.played ?? [],
      newPlanText: original,
    });
    // Every sentence of the new plan was already heard and there is no unvoiced remainder: staying
    // silent would drop a legitimately new answer, so speak the decided plan (the user asked
    // again). This is reported as `repeated`, never as an already-played completion.
    if (composed.text.length === 0 && original.trim().length > 0) {
      replacePendingFromPlan(group, original);
      if (Number.isInteger(turn)) answer.turn = turn;
      return {
        text: original,
        prepended: [],
        skippedPlayed: composed.skippedPlayed,
        unplayedPrior: priorUnspoken,
        changed: false,
        repeated: true,
      };
    }
    if (composed.text !== original) {
      answer.planText = composed.text;
      answer.feedText = composed.text;
      answer.planChars = composed.text.length;
      answer.updatedAt = now();
    }
    // The adjusted plan is exactly what this version will say: it now owns the pending coverage,
    // so body sentences the plan intentionally omits (a condensed share) stop being pending.
    replacePendingFromPlan(group, composed.text);
    if (Number.isInteger(turn)) answer.turn = turn;
    return {
      ...composed,
      unplayedPrior: priorUnspoken,
      changed: composed.text !== original,
      text: composed.text,
    };
  };

  /** One clip really started (first audio). Submitting synthesis or queueing never reaches here. */
  const notePlaybackStart = ({
    group, version, sentenceId = null, chunkIndex = 0, chunkCount = 1, text = '', chars = 0,
  } = {}) => {
    // A terminal group never revives: a late block from a superseded version must not turn an
    // abandoned/expired group back into `playing` (nor steal the new group's coverage).
    if (group === null || group === undefined || TERMINAL_STATES.has(group.state)) return;
    const answer = findAnswer(group, version);
    if (answer === null) return;
    const at = now();
    const sentence = String(text ?? '').trim();
    answer.state = 'speaking';
    group.state = 'playing';
    // B: the never-started window closes at the first real sound; after this the carry gate is off.
    group.speechStarted = true;
    // A normal carry was already fulfilled by its spoken plan; never let it be inherited again.
    if (group.carryConvey !== null && group.carryConvey.deferred !== true) group.carryConvey = null;
    group.updatedAt = at;
    answer.updatedAt = at;
    if (sentence.length > 0 && !answer.playedSentences.some((row) => sentenceKey(row) === sentenceKey(sentence))) {
      answer.playedSentences.push(sentence);
      if (answer.playedSentences.length > playedLimit) answer.playedSentences.shift();
    }
    if (sentence.length > 0 && !group.played.some((row) => sentenceKey(row) === sentenceKey(sentence))) {
      group.played.push(sentence);
      if (group.played.length > playedLimit) group.played.shift();
    }
    // A sentence that really started is no longer pending coverage.
    if (sentence.length > 0) forgetPendingPlayed(group, sentence);
    const existing = answer.clips.find((clip) => clip.sentenceId === sentenceId && clip.chunkIndex === chunkIndex);
    if (existing === undefined) {
      answer.clips.push({
        sentenceId,
        chunkIndex,
        chunkCount,
        chars: Number(chars) > 0 ? Number(chars) : sentence.length,
        status: 'started',
        at,
      });
      if (answer.clips.length > playedLimit) answer.clips.shift();
      answer.progress.started += 1;
    } else {
      existing.status = 'started';
      existing.at = at;
    }
    publish('voice.response.playback', {
      groupId: group.id,
      sessionId: group.sessionId,
      groupVersion: group.answerVersion,
      answerVersion: version,
      speechId: null,
      sentenceId,
      chunkIndex,
      chunkCount,
      status: 'started',
      chars: Number(chars) > 0 ? Number(chars) : sentence.length,
    });
  };

  /** One clip ended: completed, or partial when the user interrupted it mid-sentence. */
  const notePlaybackEnd = ({
    group, version, sentenceId = null, chunkIndex = 0, chunkCount = 1, status = 'completed', text = '',
  } = {}) => {
    if (group === null || group === undefined || TERMINAL_STATES.has(group.state)) return;
    const answer = findAnswer(group, version);
    if (answer === null) return;
    const at = now();
    answer.updatedAt = at;
    group.updatedAt = at;
    const existing = answer.clips.find((clip) => clip.sentenceId === sentenceId && clip.chunkIndex === chunkIndex);
    if (existing !== undefined) existing.status = status === 'partial' ? 'partial' : 'completed';
    if (status === 'partial') {
      answer.progress.partial += 1;
      const sentence = String(text ?? answer.planText ?? '').trim();
      if (sentence.length > 0 && !answer.partialSentences.some((row) => sentenceKey(row) === sentenceKey(sentence))) {
        answer.partialSentences.push(sentence);
        if (answer.partialSentences.length > playedLimit) answer.partialSentences.shift();
      }
    } else {
      answer.progress.completed += 1;
      // Only the sentence's LAST block completes it; an earlier block of the same sentence is not
      // the end of the sentence and must never close the group.
      if (chunkIndex >= chunkCount - 1 && Number.isInteger(sentenceId)
        && !answer.completedSentenceIds.includes(sentenceId)) {
        answer.completedSentenceIds.push(sentenceId);
      }
    }
    publish('voice.response.playback', {
      groupId: group.id,
      sessionId: group.sessionId,
      groupVersion: group.answerVersion,
      answerVersion: version,
      speechId: null,
      sentenceId,
      chunkIndex,
      chunkCount,
      status: status === 'partial' ? 'partial' : 'completed',
      chars: Number(answer.clips.find((clip) => clip.sentenceId === sentenceId)?.chars) || 0,
    });
    if (status === 'partial') return;
    // The last block of the plan that really finished closes the group. A partial sentence keeps
    // it open: its tail was never heard and must stay available.
    if (isCurrentAnswer(group, version) && answerFullyPlayed(answer, pendingLimit)
      && group.pendingSentences.length === 0) {
      completeAnswer({ group, version, reason: 'played' });
    }
  };

  /** A stale version's queued block never reached the player: record it, emit, never revive it. */
  const notePlaybackSkipped = ({ group, version, sentenceId = null, chunkIndex = 0, chunkCount = 1 } = {}) => {
    const answer = findAnswer(group, version);
    if (answer === null) return;
    publish('voice.response.playback', {
      groupId: group.id,
      sessionId: group.sessionId,
      groupVersion: group.answerVersion,
      answerVersion: version,
      speechId: null,
      sentenceId,
      chunkIndex,
      chunkCount,
      status: 'skipped-stale',
      chars: 0,
    });
  };

  const completeAnswer = ({ group, version, reason = 'played' } = {}) => {
    const answer = findAnswer(group, version);
    if (answer === null) return;
    if (answer.state === 'cancelled' || answer.state === 'failed' || answer.state === 'done') return;
    answer.state = 'done';
    answer.completedReason = reason;
    answer.updatedAt = now();
    // A completed answer has no pending coverage left, whichever path closed it (streamed blocks
    // or the whole-reply fallback's single clip).
    group.pendingSentences = [];
    // A played/concluded answer fulfilled a normal carry; a deferred one was never spoken.
    if (group.carryConvey !== null && group.carryConvey.deferred !== true) group.carryConvey = null;
    if (group.currentAnswer?.version === version) {
      group.state = 'done';
      group.reason = reason;
      group.updatedAt = answer.updatedAt;
    }
    publish('voice.response.group.done', {
      ...groupView(group),
      version,
      reason,
      playedSentences: (answer.playedSentences ?? []).length,
      chars: answer.planChars,
    });
  };

  /** A normal answer failure: keep every unvoiced sentence for the next input. */
  const failAnswer = ({ group, version, status = 'failed', error = '' } = {}) => {
    const answer = findAnswer(group, version);
    if (answer === null) return;
    const at = now();
    answer.state = 'failed';
    answer.error = String(error ?? '');
    answer.updatedAt = at;
    // Whatever this version generated but never voiced stays available to the next input.
    rememberPending(group, answerSource(answer));
    if (group.currentAnswer?.version === version) {
      group.state = 'failed';
      group.reason = String(status ?? 'failed');
      group.updatedAt = at;
    }
    const priorUnspoken = unspokenSentencesOf(answer, { maxSentences: pendingLimit });
    // A failed answer usually produced no body/plan of its own; the group's pending set already
    // carries the earlier versions' unvoiced sentences. Report that retained total.
    publish('voice.response.group.failed', {
      ...groupView(group),
      version,
      status: String(status ?? 'failed'),
      error: String(error ?? ''),
      retained: true,
      pendingSentences: Math.max(priorUnspoken.length, group.pendingSentences.length),
    });
  };

  /** An explicit cancel (or a lane teardown): terminal, retained, never automatically resumed. */
  const cancelAnswer = ({ group, version, reason = 'cancelled', explicit = false } = {}) => {
    const answer = findAnswer(group, version);
    if (answer === null) return null;
    const at = now();
    answer.state = 'cancelled';
    answer.updatedAt = at;
    if (group.currentAnswer?.version === version) {
      group.state = 'cancelled';
      group.reason = String(reason ?? 'cancelled');
      group.cancelReason = String(reason ?? 'cancelled');
      group.updatedAt = at;
    }
    publish('voice.response.group.cancelled', {
      ...groupView(group),
      version,
      reason: String(reason ?? 'cancelled'),
      explicit: explicit === true,
    });
    return group;
  };

  /** The user said stop: cancel the newest non-terminal group of the session (if any). */
  const cancelByUserInput = ({ sessionId, text = '' } = {}) => {
    const at = now();
    sweep(at);
    let target = null;
    for (const group of groups.values()) {
      if (group.sessionId !== sessionId) continue;
      if (!TERMINAL_STATES.has(group.state)) target = group;
    }
    if (target === null) return null;
    return cancelAnswer({
      group: target,
      version: target.answerVersion,
      reason: 'user-cancel',
      explicit: true,
    });
  };

  /** Compose the next turn's internal context now; `takePendingInternal` consumes it at pre-step. */
  const preparePendingInternal = ({ group, version, newInput = '' } = {}) => {
    if (group === null || group === undefined) return null;
    const text = composeResponseGroupContext({ group, newInput, maxChars: contextChars });
    if (text.length === 0) return null;
    pendingInternal = {
      sessionId: group.sessionId,
      groupId: group.id,
      version,
      text,
      at: now(),
      chars: text.length,
      priorVersion: group.priorAnswer?.version ?? 0,
      playedSentences: (group.priorAnswer?.playedSentences ?? []).length,
      unplayedSentences: group.pendingSentences.length,
      newChars: String(newInput ?? '').length,
    };
    publish('voice.response.internal-context', {
      groupId: group.id,
      sessionId: group.sessionId,
      answerVersion: version,
      chars: pendingInternal.chars,
      priorSegments: group.segments.length,
      priorVersion: pendingInternal.priorVersion,
      playedSentences: pendingInternal.playedSentences,
      unplayedSentences: pendingInternal.unplayedSentences,
      newChars: pendingInternal.newChars,
      source: ASSISTANT_RESPONSE_GROUP_SOURCE,
    });
    return pendingInternal;
  };

  /** Consume the pending block at the next first pre-step of that session (one turn only). */
  const takePendingInternal = ({ sessionId } = {}) => {
    if (pendingInternal === null) return null;
    if (now() - pendingInternal.at > 30_000) {
      pendingInternal = null;
      return null;
    }
    if (pendingInternal.sessionId !== sessionId) return null;
    const taken = pendingInternal;
    pendingInternal = null;
    publish('voice.response.internal-context.consumed', {
      groupId: taken.groupId,
      sessionId,
      answerVersion: taken.version,
      chars: taken.chars,
    });
    return taken;
  };

  return {
    beginInput,
    attachDelivery,
    noteAnswerBody,
    noteAnswerPlan,
    adjustSpeech,
    carryForSpeech,
    deferCarry,
    notePlaybackStart,
    notePlaybackEnd,
    notePlaybackSkipped,
    completeAnswer,
    failAnswer,
    cancelAnswer,
    cancelByUserInput,
    preparePendingInternal,
    takePendingInternal,
    isCurrentAnswer,
    groupView: (group) => groupView(group),
    get: find,
    size: () => groups.size,
    activeSessions: sessionsActive,
    /** Test/diagnostic helper: a bounded plain snapshot of one group. */
    snapshot: (groupId) => {
      const group = find(groupId);
      if (group === null) return null;
      return {
        ...groupView(group),
        segments: group.segments.map((segment) => ({ ...segment })),
        turns: [...group.turns],
        messageIds: [...group.messageIds],
        played: [...group.played],
        speechPending: group.speechPending === null || group.speechPending === undefined ? null : {
          sentences: [...group.speechPending.sentences],
          chars: group.speechPending.chars,
          version: group.speechPending.version,
          reason: group.speechPending.reason,
        },
        carryConvey: group.carryConvey === null || group.carryConvey === undefined ? null : {
          priorGroupId: group.carryConvey.priorGroupId,
          sentences: [...group.carryConvey.sentences],
          chars: group.carryConvey.chars,
          version: group.carryConvey.version,
          reason: group.carryConvey.reason,
          deferred: group.carryConvey.deferred === true,
        },
        currentAnswer: group.currentAnswer === null ? null : {
          version: group.currentAnswer.version,
          state: group.currentAnswer.state,
          turn: group.currentAnswer.turn,
          bodyChars: group.currentAnswer.bodyChars,
          planChars: group.currentAnswer.planChars,
          source: group.currentAnswer.source,
          playedSentences: [...group.currentAnswer.playedSentences],
          partialSentences: [...group.currentAnswer.partialSentences],
          unspoken: unspokenSentencesOf(group.currentAnswer, { maxSentences: pendingLimit }),
          progress: { ...group.currentAnswer.progress },
        },
        priorAnswer: group.priorAnswer === null ? null : {
          version: group.priorAnswer.version,
          state: group.priorAnswer.state,
          bodyChars: group.priorAnswer.bodyChars,
          planChars: group.priorAnswer.planChars,
          playedSentences: [...group.priorAnswer.playedSentences],
          unspoken: unspokenSentencesOf(group.priorAnswer, { maxSentences: pendingLimit }),
        },
      };
    },
    /** Bounded plain list, newest last; used by diagnostics and tests. */
    list: () => [...groups.values()].map((group) => groupView(group)),
  };
}
