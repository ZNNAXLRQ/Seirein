/**
 * Lightweight task channel: the `assist` purpose of the fast path, addressed by task name.
 *
 * It is NOT a second LLM client. `FastPath` owns the model selection, the `llm` service request
 * and the context assembly; this module only adds the task contract shared by the auxiliary
 * features:
 *
 * - one task name (`translate` | `kana` | `ack` | `waiting-hint` | `tone-repair` | `spoken`), so a
 *   call site can never silently borrow the chat prompt;
 * - ONE total deadline for the first attempt and any fallback attempt (never per attempt);
 * - an optional context-free mode (`context:'none'`) for a prompt that is exactly its own system +
 *   target (the spoken-version rewrite), so no memory retrieval or chat history is assembled;
 * - the explicit PER-REQUEST reasoning control (`GenerateOptions.reasoningEffort`), defaulting to
 *   the shared auxiliary policy `'off'`; a caller may pass `null` to omit it (model default) or
 *   another supported effort. It is proven against the adapter's own capability declaration
 *   (`resolveModelInfo().reasoning`), and reported honestly as `'unsupported'` when the route
 *   refuses/downgrades it. There is no global reasoning switch;
 * - uniform metrics (`firstDeltaMs`, `doneMs`, `reasoningChars`, `retries`, `failed`) and one
 *   `lightweight.request` event per call.
 *
 * Side effects are the fast path's assist purpose: no chat-history write, no memory write, no
 * sentence callback. A translation or a waiting line can therefore never start chat playback.
 *
 * ## Input packages (the explicit channel contract)
 *
 * Every auxiliary task hands the channel ONE explicit input package instead of a hand-built
 * prompt. The channel renders that package into the system/user pair, so a call site can neither
 * forget a needed field nor smuggle in the whole chat context:
 *
 *   translate → { text, targetLang, glossary?, tone?, neighbors?[] }
 *   kana      → { text, names?[] }
 *   spoken    → { answer, persona }                       (`context:'none'` stays supported)
 *   tone      → { fragments, side }                       (task `tone-repair`)
 *   motion    → { personaText, schema }                   (task `motion-style`)
 *   quiz      → { answers, constraints }                  (task `persona-quiz`)
 *   asrPost   → { text, terms?[], previous?[] }           (task `asr-post`)
 *   ack       → { persona, userText, recent?[] }          (no memory retrieval)
 *
 * A packaged call is ALWAYS a direct call (`directAssist`): no persona/profile/memory/chat
 * history is assembled, and a deadline or failure can only retry or fail — it never falls back to
 * `FastPath.assist`, which would attach the full context again.
 */

import {
  BOUNDARY_SYSTEM_RULE,
  STRICT_TRANSLATION_LINE,
  boundaryRepairPrompt,
  normalizeJaSpeechScript,
  normalizeLang,
  normalizeTranslatePurpose,
  translationPrompt,
  translationRepairPrompt,
  wrapTarget,
} from '../../speech/translate.js';
import { buildAckPrompt } from '../../speech/ack-speech.js';
import {
  AUXILIARY_REASONING_EFFORT,
  createReasoningDowngradeReporter,
  isUnsupportedReasoningEffort,
  normalizeReasoningEffort,
} from './fastpath.js';

/** Every feature that may use the assist purpose. An unknown name is a programming error. */
export const LIGHTWEIGHT_TASKS = Object.freeze([
  'translate',
  'kana',
  'ack',
  'waiting-hint',
  'tone-repair',
  'persona-rewrite',
  'persona-quiz',
  'motion-style',
  'asr-post',
  'spoken',
]);

/** Context rule per task. The prompt itself always comes from the caller. */
export const LIGHTWEIGHT_TASK_RULES = Object.freeze({
  translate: Object.freeze({
    instruction: '上下文只用于理解语气和指代：只翻译最后给出的目标正文，不要翻译、复述或回应上下文，不要解释。',
  }),
  kana: Object.freeze({
    instruction: '上下文只用于理解语气和指代：只把最后给出的日语正文改成要求的假名写法，不要改写含义，不要解释。',
  }),
  ack: Object.freeze({
    instruction: '上下文只用于避免重复：只输出一句针对用户这句话的过渡话，不要回应或续写上下文。',
  }),
  'waiting-hint': Object.freeze({
    instruction: '只输出一句针对当前长任务的等待提示，不要承诺进度或结果。',
  }),
  'tone-repair': Object.freeze({
    instruction: '',
  }),
  'persona-rewrite': Object.freeze({
    instruction: '只重写目标正文里的片段；上下文只用于理解语气，不要照抄上下文，不要新增或删除约束。',
  }),
  'persona-quiz': Object.freeze({
    instruction: '只根据目标正文里的问卷回答生成人设；上下文只用于理解语气，不要遗漏问卷中任何一题的内容。',
  }),
  'motion-style': Object.freeze({
    instruction: '只输出目标正文要求的那一个 JSON 对象；上下文只用于理解人设语气，不要复述人设原文。',
  }),
  'asr-post': Object.freeze({
    instruction: '只清洗目标这一句语音识别结果：纠正同音错字、补标点、合并重复片段；不要回答内容，不要解释，不要复述上下文。',
  }),
  spoken: Object.freeze({
    instruction: '只把目标正文改写成可直接朗读的口语版：保留关键结论、必要条件与下一步，省略展开论证、举例和格式标记；不新增事实，不解释，不复述上下文。',
  }),
});

/**
 * The explicit input packages this channel understands, per task type. A package carries exactly
 * the task's own information; `?` marks an optional field, `[]` a list.
 */
export const LIGHTWEIGHT_INPUT_TYPES = Object.freeze({
  translate: Object.freeze(['text', 'targetLang', 'glossary?', 'tone?', 'neighbors?[]']),
  kana: Object.freeze(['text', 'names?[]']),
  spoken: Object.freeze(['answer', 'persona']),
  tone: Object.freeze(['fragments', 'side']),
  motion: Object.freeze(['personaText', 'schema']),
  quiz: Object.freeze(['answers', 'constraints']),
  asrPost: Object.freeze(['text', 'terms?[]', 'previous?[]']),
  ack: Object.freeze(['persona', 'userText', 'recent?[]']),
});

/**
 * Task name → package type. A caller may also name the package type directly (`tone`, `motion`, …)
 * so the exported contract above can be used as-is.
 */
export const LIGHTWEIGHT_TASK_INPUT = Object.freeze({
  translate: 'translate',
  kana: 'kana',
  spoken: 'spoken',
  'tone-repair': 'tone',
  'motion-style': 'motion',
  'persona-quiz': 'quiz',
  'asr-post': 'asrPost',
  ack: 'ack',
});

/** Render hints that only translate/kana use: which round of the translation is being sent. */
export const LIGHTWEIGHT_TRANSLATE_MODES = Object.freeze(['translate', 'boundary-repair', 'script-repair']);

const asText = (value) => (typeof value === 'string' ? value : String(value ?? ''));
const asList = (value) => (Array.isArray(value) ? value.map(asText).filter((item) => item.trim().length > 0) : []);
const asTrimmed = (value) => asText(value).trim();

/** One rendered package: the exact model input the channel sends, never the chat context. */
function renderedPackage(type, task, system, user) {
  const systemText = asText(system);
  const userText = asText(user);
  const chars = [...systemText].length + [...userText].length;
  return {
    type,
    task,
    system: systemText,
    user: userText,
    chars,
    tokensEstimate: estimateTokens(chars),
  };
}

/** CJK-dominant auxiliary prompts run about one token per two characters; reported, never billed. */
export function estimateTokens(chars) {
  const numeric = Math.max(0, Math.floor(Number(chars) || 0));
  return Math.ceil(numeric / 2);
}

/** Optional extra constraints (glossary / tone / neighbouring sentences / proper names). */
function translationExtras(input) {
  const parts = [];
  const glossary = input.glossary;
  if (typeof glossary === 'string' && glossary.trim().length > 0) {
    parts.push(`术语表（这些词必须按给定译法）：${glossary.trim()}`);
  } else if (Array.isArray(glossary) && glossary.length > 0) {
    const rows = glossary.map((entry) => {
      if (entry !== null && typeof entry === 'object') {
        const from = asTrimmed(entry.from ?? entry.source ?? entry.term);
        const to = asTrimmed(entry.to ?? entry.target ?? entry.translation);
        return from.length > 0 && to.length > 0 ? `- ${from} → ${to}` : '';
      }
      return `- ${asTrimmed(entry)}`;
    }).filter((row) => row.length > 0);
    if (rows.length > 0) parts.push(`术语表（这些词必须按给定译法）：\n${rows.join('\n')}`);
  }
  const tone = asTrimmed(input.tone);
  if (tone.length > 0) parts.push(`语气要求：${tone}`);
  const names = asList(input.names ?? input.nameReadings);
  if (names.length > 0) parts.push(`专名与读音约束：\n${names.map((name) => `- ${name}`).join('\n')}`);
  const neighbors = asList(input.neighbors);
  if (neighbors.length > 0) {
    parts.push(`相邻句（只用于理解指代与语气，不要翻译、复述或回应）：\n${neighbors.map((line) => `- ${line}`).join('\n')}`);
  }
  return parts;
}

/**
 * translate / kana: the established translator prompt is reused (single source of truth for the
 * Japanese script rules), and only the package fields decide the target, the round and extras.
 */
function renderTranslatePackage(type, input = {}) {
  const source = asText(input.text);
  const from = normalizeLang(input.from) || 'zh';
  const to = normalizeLang(input.targetLang) || 'ja';
  const purpose = normalizeTranslatePurpose(input.purpose);
  // `translate` is the written/mixed path; `kana` is the kana speech reading.
  const fallbackScript = type === 'kana' ? 'kanaSpaced' : 'mixed';
  const script = input.jaSpeechScript === undefined
    ? fallbackScript
    : normalizeJaSpeechScript(input.jaSpeechScript);
  const mode = LIGHTWEIGHT_TRANSLATE_MODES.includes(input.mode) ? input.mode : 'translate';
  const strict = input.strict === true;
  const boundary = input.boundary !== false;
  let prompt;
  let target = source;
  if (mode === 'boundary-repair') {
    // The original target again, with the previous answer discarded.
    prompt = boundaryRepairPrompt({ from, to, jaSpeechScript: script, purpose, source });
    target = '';
  } else if (mode === 'script-repair') {
    // Only the offending sentences; one output line per sentence.
    const listed = asList(input.sentences);
    const sentences = listed.length > 0
      ? listed
      : source.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
    prompt = translationRepairPrompt({ from, to, sentences, jaSpeechScript: script, purpose });
    target = sentences.join('\n');
  } else {
    prompt = translationPrompt({ from, to, jaSpeechScript: script, purpose });
  }
  const system = [
    prompt.system,
    strict ? STRICT_TRANSLATION_LINE : '',
    boundary && mode !== 'boundary-repair' ? BOUNDARY_SYSTEM_RULE : '',
    ...translationExtras(input),
  ].filter((part) => part.trim().length > 0).join('\n');
  // A boundary/script repair prompt already places its own target; only the normal round wraps.
  let user;
  if (mode === 'boundary-repair') user = prompt.user;
  else user = `${prompt.user}${boundary && target.length > 0 ? wrapTarget(target) : target}`;
  return renderedPackage(type, type === 'kana' ? 'kana' : 'translate', system, user);
}

/** tone-repair: the offending fragments only, with the target side's person rules. */
function renderTonePackage(type, input = {}) {
  const side = input.side === 'agent' ? 'agent' : 'user';
  const fragments = asList(input.fragments);
  const label = side === 'agent' ? '助手人设' : '用户画像';
  const personRule = side === 'agent'
    ? '助手人设一律用第二人称「你……」；只把作主语的「用户」改成「你」（「用户会撒娇」→「你会撒娇」），作宾语或定语的「用户」保留原样（「尊重用户的隐私」保持原句）。'
    : '用户画像一律用第三人称「用户……」，不得出现「我/我们/我的/咱/咱们」（「我喜欢安静」→「用户喜欢安静」）；词语内部的「我」不动（「自我介绍」保持原样）。';
  const list = fragments.map((fragment, index) => `${index + 1}. ${fragment}`).join('\n');
  const system = '你是人设/画像口吻修复器。只输出约定的 JSON 数组，不解释，不新增或删除任何约束。';
  const user = [
    `下面这些${label}句子口吻不合格。只改这些句子，不要重写其他内容。`,
    `规则：${personRule}`,
    '- 意思不变：不得新增或删除任何约束，也不得合并或拆开句子。',
    '- 引号「…」/『…』/“…”里的原话是引用，必须原样保留，不得改写或删除。',
    '只输出一个 JSON 数组，按顺序给出改写后的句子，例如 ["…","…"]，不要解释。',
    fragments.length > 0 ? `句子：\n${list}` : '句子：（空）',
  ].join('\n');
  return renderedPackage(type, 'tone-repair', system, user);
}

/** motion-style: persona text + the required output schema, nothing else. */
function renderMotionPackage(type, input = {}) {
  const personaText = asTrimmed(input.personaText);
  const schema = asTrimmed(input.schema);
  const current = input.currentStyle !== null && typeof input.currentStyle === 'object'
    ? JSON.stringify(input.currentStyle)
    : '';
  const system = [
    schema.length > 0 ? schema : '把助手人设转换成 Live2D 运动风格参数。',
    '只输出一个 JSON 对象：不要解释、不要代码围栏、不要输出人设原文。',
  ].join('\n');
  const user = [
    current.length > 0 ? `当前风格（未提及的字段保持这些值）：${current}` : '',
    personaText.length > 0 ? `人设文本：\n${personaText}` : '人设文本为空：输出 {}。',
    '只输出一个 JSON 对象。',
  ].filter((line) => line.length > 0).join('\n');
  return renderedPackage(type, 'motion-style', system, user);
}

/** quiz: the raw questionnaire answers + the output constraints. */
function renderQuizPackage(type, input = {}) {
  const answers = asList(input.answers);
  const constraints = asTrimmed(input.constraints);
  const system = [
    '你只根据问卷回答生成助手人设条目，不要解释，不要遗漏任何一题的内容。',
    constraints.length > 0 ? `约束：${constraints}` : '',
  ].filter((line) => line.length > 0).join('\n');
  const user = [
    answers.length > 0
      ? `问卷回答：\n${answers.map((answer, index) => `${index + 1}. ${answer}`).join('\n')}`
      : '问卷回答：（空）',
    '只输出人设正文。',
  ].join('\n');
  return renderedPackage(type, 'persona-quiz', system, user);
}

/** asr-post: the raw recognition only; optional terms/previous context may guide, never rewrite. */
function renderAsrPostPackage(type, input = {}) {
  const source = asText(input.text);
  const terms = asList(input.terms);
  const previous = asList(input.previous);
  const system = [
    '你是语音识别后处理。只做三件事：纠正同音错字、补标点、合并重复片段。',
    '不要回答内容，不要解释，只输出清洗后的那一句。',
    '禁止根据上下文擅自改动数字、否定词或用户意图。',
    terms.length > 0 ? `术语（按此写法）：\n${terms.map((term) => `- ${term}`).join('\n')}` : '',
    previous.length > 0
      ? `少量前文（只用于判断同音词，不要回答，不要续写）：\n${previous.map((line) => `- ${line}`).join('\n')}`
      : '',
  ].filter((line) => line.length > 0).join('\n');
  const user = `原始识别文本：\n${source}\n\n只输出清洗后的一句。`;
  return renderedPackage(type, 'asr-post', system, user);
}

/** ack: persona + the current message + a few recent lines; never a memory lookup. */
function renderAckPackage(type, input = {}) {
  const recent = asList(input.recent).slice(-3);
  const { messages } = buildAckPrompt({
    persona: input.persona,
    userText: input.userText,
    language: input.language,
    recent,
  });
  const system = messages.find((message) => message.role === 'system');
  const user = messages.find((message) => message.role === 'user');
  return renderedPackage(type, 'ack', system?.content, user?.content);
}

/** spoken: persona + the confirmed answer (the `context:'none'` prompt, kept as a package). */
function renderSpokenPackage(type, input = {}) {
  const persona = asTrimmed(input.persona);
  const answer = asText(input.answer);
  const system = [
    `【人设】\n${persona.length > 0 ? persona : '自然、简短、口语化。'}`,
    '只输出一段可直接朗读的口语版：保留关键结论、必要条件与下一步，省略展开论证、举例与格式标记。',
    '只使用已确认的正文，不新增事实，不补充尚未出现的结论，不解释。',
  ].join('\n\n');
  const user = `<完整答复>\n${answer}\n</完整答复>`;
  return renderedPackage(type, 'spoken', system, user);
}

const INPUT_RENDERERS = Object.freeze({
  translate: (type, input) => renderTranslatePackage('translate', input),
  kana: (type, input) => renderTranslatePackage('kana', input),
  tone: (type, input) => renderTonePackage('tone', input),
  motion: (type, input) => renderMotionPackage('motion', input),
  quiz: (type, input) => renderQuizPackage('quiz', input),
  asrPost: (type, input) => renderAsrPostPackage('asrPost', input),
  ack: (type, input) => renderAckPackage('ack', input),
  spoken: (type, input) => renderSpokenPackage('spoken', input),
});

/**
 * Render one task's explicit input package into its system/user pair. Unknown tasks and tasks
 * without a package (waiting-hint, persona-rewrite) are programming errors: they must not
 * silently borrow someone else's prompt.
 *
 * @param {string} task task name (`translate`) or package type (`tone`)
 * @param {object} [input]
 * @returns {{type: string, task: string, system: string, user: string, chars: number,
 *   tokensEstimate: number}}
 */
export function renderLightweightInput(task, input = undefined) {
  const name = String(task ?? '');
  const type = LIGHTWEIGHT_TASK_INPUT[name] ?? (LIGHTWEIGHT_INPUT_TYPES[name] !== undefined ? name : '');
  const renderer = type === '' ? undefined : INPUT_RENDERERS[type];
  if (typeof renderer !== 'function') {
    throw new TypeError(`no lightweight input package for task: ${name}`);
  }
  const safe = input !== null && typeof input === 'object' ? input : {};
  return renderer(type, safe);
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 60_000;
// A fallback attempt needs enough of the ONE budget to be worth issuing; below this the call
// reports the original failure instead of spending a second request on a dead deadline.
const MIN_RETRY_BUDGET_MS = 200;
// A capability answer is reused briefly: the adapter declaration rarely changes, and an
// unresponsive probe must not be paid on every auxiliary request.
const CAPABILITY_TTL_MS = 30_000;
// The probe stops waiting after this long (and never uses more than half the ONE budget), so the
// request still has room when the answer is unknown.
const CAPABILITY_PROBE_MS = 500;
// Below this much remaining budget an unknown capability is not worth dispatching a request on.
const MIN_PROBE_CONTINUE_MS = 100;

/** Body text of one stream chunk across the adapter delta shapes. */
function chunkText(chunk) {
  if (typeof chunk === 'string') return chunk;
  for (const key of ['text', 'delta', 'content']) {
    if (typeof chunk?.[key] === 'string') return chunk[key];
  }
  return '';
}
const REASONING_FRAME = /^(reasoning|thinking|thought|analysis|redacted)/u;

/**
 * Context-free dispatch for a task whose prompt is exactly its own system + target text (the
 * spoken-version rewrite). It uses the same model route and the same ONE deadline but never calls
 * `FastPath.assist`, so no memory retrieval or chat history can leak into the rewrite.
 */
async function directAssist(fastpath, { system = '', user = '', maxTokens = 512, signal = undefined, reasoningEffort = null, now }) {
  const service = typeof fastpath.getLlm === 'function' ? fastpath.getLlm() : null;
  if (service === null || service === undefined || typeof service.stream !== 'function') {
    throw new Error('DSH llm service unavailable（插件未拿到 llm）');
  }
  let provider = '';
  let model = '';
  try {
    const selection = typeof fastpath.selection === 'function' ? fastpath.selection() : null;
    provider = String(selection?.provider ?? selection?.route?.provider ?? '');
    model = String(selection?.model ?? selection?.route?.model ?? '');
  } catch {
    /* handled below */
  }
  if (provider.length === 0 || model.length === 0) throw new Error('没有可用的默认模型');
  const startedAt = now();
  let text = '';
  let reasoningChars = 0;
  let firstDeltaMs = null;
  let finishKind = '';
  let truncated = false;
  const options = {
    provider,
    model,
    system: String(system ?? ''),
    messages: [{ role: 'user', content: [{ type: 'text', text: String(user ?? '') }] }],
    maxTokens,
    signal,
    ...reasoningEffort === null || reasoningEffort === undefined ? {} : { reasoningEffort },
  };
  for await (const chunk of service.stream(options)) {
    if (typeof chunk === 'string') {
      text += chunk;
      if (firstDeltaMs === null) firstDeltaMs = Math.max(0, now() - startedAt);
      continue;
    }
    const type = String(chunk?.type ?? '').toLowerCase();
    if (REASONING_FRAME.test(type)) {
      reasoningChars += chunkText(chunk).length;
      continue;
    }
    if (chunk?.truncated === true || chunk?.finish?.truncated === true) truncated = true;
    if (type === 'finish') {
      const reason = chunk?.reason;
      finishKind = String(reason?.kind ?? reason ?? '');
      if (finishKind === 'max-tokens') truncated = true;
      continue;
    }
    const delta = chunkText(chunk);
    if (delta.length === 0) continue;
    text += delta;
    if (firstDeltaMs === null) firstDeltaMs = Math.max(0, now() - startedAt);
  }
  return {
    text,
    provider,
    model,
    context: '',
    contextChars: 0,
    reasoning: reasoningEffort === null || reasoningEffort === undefined ? 'unsupported' : String(reasoningEffort),
    reasoningChars,
    firstDeltaMs,
    doneMs: Math.max(0, now() - startedAt),
    finishKind,
    finish: null,
    truncated,
    complete: finishKind === 'stop' && !truncated,
  };
}

/** Normalize a deadline: finite value clamped into the shared range. */
export function lightweightTimeout(value, fallback = DEFAULT_TIMEOUT_MS) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(numeric)));
}

function abortError(reason) {
  if (reason !== undefined && reason !== null) return reason;
  return new DOMException('Lightweight task aborted', 'AbortError');
}

function timeoutError() {
  return new DOMException('Lightweight task timed out', 'TimeoutError');
}

/** Reject as soon as the lane aborts: a provider stream that ignores its signal cannot outlive
 * the ONE total deadline managed here. */
function raceAbort(promise, lane) {
  if (lane.aborted) return Promise.reject(abortError(lane.reason));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(lane.reason));
    lane.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { lane.removeEventListener('abort', onAbort); resolve(value); },
      (error) => { lane.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

/**
 * @param {{fastpath: object, emit?: Function, options?: object}} input
 *   `fastpath` is the single model owner (selection + llm service + context assembly).
 * @returns {{ask: Function, stats: Function, reasoningSupport: Function, tasks: string[]}}
 */
export function createLightweightChannel({ fastpath, emit = null, options = {} } = {}) {
  if (fastpath === null || typeof fastpath !== 'object' || typeof fastpath.assist !== 'function') {
    throw new TypeError('createLightweightChannel requires a FastPath-like object with assist()');
  }
  const settings = options !== null && typeof options === 'object' ? options : {};
  const timers = settings.timers ?? {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };
  const now = typeof settings.now === 'function' ? settings.now : () => Date.now();
  const defaultTimeoutMs = lightweightTimeout(settings.timeoutMs, DEFAULT_TIMEOUT_MS);

  const stats = { requests: 0, failed: 0, retries: 0, byTask: {} };
  /** `${provider}/${model}/${effort}` -> { supported: true|false|null, at: number } (short-lived). */
  const supportByRoute = new Map();
  const cachedSupport = (key) => {
    const entry = supportByRoute.get(key);
    if (entry === undefined) return undefined;
    if (now() - entry.at >= CAPABILITY_TTL_MS) {
      supportByRoute.delete(key);
      return undefined;
    }
    return entry.supported;
  };
  const rememberSupport = (key, supported) => {
    supportByRoute.set(key, { supported, at: now() });
  };
  const notify = (type, payload) => {
    if (typeof emit !== 'function') return;
    try {
      const task = emit(type, payload);
      if (task !== null && typeof task === 'object' && typeof task.catch === 'function') task.catch(() => {});
    } catch {
      /* observation can never break a task */
    }
  };
  // P-51: the downgrade is a debug event, throttled per (requested, fallback, reason). It is
  // emitted here, not on every auxiliary call, and can never fail the task.
  const reportReasoningDowngraded = createReasoningDowngradeReporter({
    emit: (type, payload) => notify(type, payload),
    now,
  });
  const routeKey = () => {
    try {
      const selection = typeof fastpath.selection === 'function' ? fastpath.selection() : null;
      return `${String(selection?.provider ?? '')}/${String(selection?.model ?? '')}`;
    } catch {
      return '';
    }
  };
  /** The cache key names the exact effort: a route can support `low` but not `off`. */
  const supportKey = (effort) => `${routeKey()}\u0000${String(effort ?? '')}`;
  /** Does the current route declare `effort`? Null when the service cannot answer. */
  const supports = async (effort, signal) => {
    if (typeof fastpath.supportsReasoning !== 'function') return null;
    const key = supportKey(effort);
    const cached = cachedSupport(key);
    if (cached !== undefined) return cached;
    try {
      const supported = await fastpath.supportsReasoning(effort, signal);
      const value = supported === true ? true : supported === false ? false : null;
      rememberSupport(key, value);
      return value;
    } catch (error) {
      // A cancelled probe is not an answer: never cache it, and let the caller end immediately.
      if (signal?.aborted) throw abortError(signal.reason);
      rememberSupport(key, null);
      return null;
    }
  };

  /**
   * Run one task. Rejects on timeout/abort/failure; the effort is a PER-REQUEST parameter
   * (`reasoningEffort`, default `'off'` for every auxiliary task; `null` omits the control).
   * A route that does not support it, or a provider that refuses it, downgrades to the model
   * default without failing the task, and reports `reasoning.downgraded`.
   */
  async function ask({
    task = '',
    input = undefined,
    system = '',
    user = '',
    maxTokens = undefined,
    timeoutMs = undefined,
    signal = undefined,
    instruction = undefined,
    context = 'shared',
    reasoningEffort = AUXILIARY_REASONING_EFFORT,
  } = {}) {
    if (!LIGHTWEIGHT_TASKS.includes(task)) {
      throw new TypeError(`unknown lightweight task: ${String(task)}`);
    }
    const rules = LIGHTWEIGHT_TASK_RULES[task];
    // An explicit input package is rendered here, then sent DIRECT: the package is the whole
    // prompt, so no persona/profile/memory/history assembly can happen behind the caller's back.
    const packaged = input !== null && typeof input === 'object';
    let renderedChars = 0;
    if (packaged) {
      const rendered = renderLightweightInput(task, input);
      system = rendered.system;
      user = rendered.user;
      renderedChars = rendered.chars;
    }
    // `context:'none'` is the spoken-version rewrite: its prompt is exactly persona + target body,
    // so the shared chat context (memory, history) is never assembled for it. Every packaged task
    // is context-free for the same reason.
    const contextFree = context === 'none' || packaged;
    const budget = lightweightTimeout(timeoutMs, defaultTimeoutMs);
    const deadlineAt = now() + budget;
    const remaining = () => Math.max(0, deadlineAt - now());
    const record = stats.byTask[task] ?? { requests: 0, failed: 0, retries: 0 };
    stats.byTask[task] = record;
    stats.requests += 1;
    record.requests += 1;

    const base = {
      task,
      system: String(system ?? ''),
      user: String(user ?? ''),
      maxTokens: positiveInt(maxTokens, 512),
      instruction: typeof instruction === 'string' ? instruction : rules.instruction,
    };
    // The unified telemetry's input size: the rendered package (or the explicit prompt pair) and
    // its rough token count. The shared task-contract instruction is channel overhead, not input.
    const inputChars = packaged
      ? renderedChars
      : [...base.system].length + [...base.user].length;
    const inputMetrics = { chars: inputChars, tokensEstimate: estimateTokens(inputChars) };
    // P-51: this call's effort (never a channel-global switch). `null` means "send no control".
    const requestedEffort = normalizeReasoningEffort(reasoningEffort);
    let activeEffort = requestedEffort;
    let retries = 0;
    let reasoning = activeEffort === null ? 'default' : activeEffort;

    const attempt = async (attemptSignal) => {
      const startedAt = now();
      const result = contextFree
        ? await directAssist(fastpath, {
          system: [base.system, base.instruction].filter((part) => part.length > 0).join('\n\n'),
          user: base.user,
          maxTokens: base.maxTokens,
          signal: attemptSignal,
          reasoningEffort: activeEffort,
          now,
        })
        : await fastpath.assist({
          ...base,
          signal: attemptSignal,
          reasoningEffort: activeEffort,
        });
      return { result, startedAt };
    };

    const controller = new AbortController();
    const forward = () => controller.abort(signal?.reason ?? abortError());
    if (signal !== undefined && signal !== null) {
      if (signal.aborted) forward();
      else signal.addEventListener('abort', forward, { once: true });
    }
    let timer = null;
    const arm = () => {
      if (timer !== null) timers.clearTimeout(timer);
      const left = remaining();
      timer = timers.setTimeout(() => controller.abort(timeoutError()), Math.max(1, left));
      timer?.unref?.();
    };
    const merged = () => (signal === undefined || signal === null
      ? controller.signal
      : AbortSignal.any([signal, controller.signal]));

    /**
     * Probe the route capability under the SAME deadline and cancellation as the request. The
     * probe gets at most half of what is left, so a hung capability query still leaves the
     * request a usable slice; when it does not answer the capability is simply unknown.
     */
    const resolveCapability = async (effort) => {
      const key = supportKey(effort);
      const cached = cachedSupport(key);
      const probeStartedAt = now();
      let status = 'ok';
      let supported = null;
      if (typeof fastpath.supportsReasoning !== 'function') {
        supported = null;
      } else if (cached !== undefined) {
        status = 'cached';
        supported = cached;
      } else {
        const lane = merged();
        if (lane.aborted) throw abortError(lane.reason);
        const windowMs = Math.max(1, Math.min(remaining(), CAPABILITY_PROBE_MS, Math.floor(budget / 2)));
        let probeTimer = null;
        const gaveUp = new Promise((resolve) => {
          probeTimer = timers.setTimeout(() => resolve({ status: 'timeout', supported: null }), windowMs);
          probeTimer?.unref?.();
        });
        try {
          const answer = await Promise.race([
            raceAbort(supports(effort, lane), lane).then((value) => ({ status: 'ok', supported: value })),
            gaveUp,
          ]);
          status = answer.status;
          supported = answer.supported;
        } finally {
          if (probeTimer !== null) timers.clearTimeout(probeTimer);
        }
        // A timeout is an unknown answer, not a fresh route: cache it briefly so it is not probed
        // again on every request, while a late real answer may still replace it.
        if (status === 'timeout') rememberSupport(key, null);
      }
      notify('lightweight.capability', {
        status,
        ms: Math.max(0, now() - probeStartedAt),
      });
      return { status, supported, key };
    };

    let startedAt = now();
    try {
      arm();
      // Only a real effort is probed. `null` is the model's own default: there is nothing to prove.
      const capability = requestedEffort === null
        ? { status: 'skipped', supported: null, key: supportKey('') }
        : await resolveCapability(requestedEffort);
      // Cancellation that landed with the capability answer still ends the call before dispatch.
      if (controller.signal.aborted) throw abortError(controller.signal.reason);
      if (capability.status === 'timeout' && remaining() < MIN_PROBE_CONTINUE_MS) {
        throw timeoutError();
      }
      // The route declares no such effort: downgrade BEFORE dispatch, once, and stay visible.
      if (capability.supported === false && activeEffort !== null) {
        reportReasoningDowngraded({ requested: activeEffort, fallback: 'default', reason: 'capability' });
        activeEffort = null;
        reasoning = 'unsupported';
      }
      for (;;) {
        try {
          const lane = merged();
          const outcome = await raceAbort(attempt(lane), lane);
          const result = outcome.result ?? {};
          const context = typeof result.context === 'string' ? result.context : '';
          const payload = {
            task,
            input: inputMetrics,
            model: String(result.model ?? ''),
            reasoning,
            firstTextMs: Number.isFinite(Number(result.firstDeltaMs)) ? Number(result.firstDeltaMs) : null,
            firstDeltaMs: Number.isFinite(Number(result.firstDeltaMs)) ? Number(result.firstDeltaMs) : null,
            doneMs: Number.isFinite(Number(result.doneMs)) ? Number(result.doneMs) : Math.max(0, now() - startedAt),
            reasoningChars: Number(result.reasoningChars) || 0,
            contextChars: [...context].length,
            targetChars: [...base.user].length,
            retries,
            failed: false,
          };
          notify('lightweight.request', payload);
          return {
            text: String(result.text ?? ''),
            firstTextMs: payload.firstTextMs,
            firstDeltaMs: payload.firstDeltaMs,
            doneMs: payload.doneMs,
            reasoningChars: payload.reasoningChars,
            model: payload.model,
            reasoning,
            context,
            contextChars: payload.contextChars,
            targetChars: payload.targetChars,
            inputChars: inputMetrics.chars,
            task,
            retries,
            complete: result.complete === true,
            truncated: result.truncated === true,
            finishKind: String(result.finishKind ?? ''),
          };
        } catch (error) {
          if (controller.signal.aborted) {
            const reason = controller.signal.reason;
            throw reason?.name === 'TimeoutError' ? reason : abortError(reason);
          }
          // The provider refused the effort: one retry WITHOUT the control, still inside the one
          // deadline, then the flag stays null so a second refusal can never loop.
          if (activeEffort !== null && isUnsupportedReasoningEffort(error) && remaining() > MIN_RETRY_BUDGET_MS) {
            reportReasoningDowngraded({ requested: activeEffort, fallback: 'default', reason: 'unsupported' });
            rememberSupport(supportKey(activeEffort), false);
            activeEffort = null;
            reasoning = 'unsupported';
            retries += 1;
            stats.retries += 1;
            record.retries += 1;
            startedAt = now();
            arm();
            continue;
          }
          throw error;
        }
      }
    } catch (error) {
      stats.failed += 1;
      record.failed += 1;
      notify('lightweight.request', {
        task,
        input: inputMetrics,
        model: '',
        reasoning,
        firstTextMs: null,
        firstDeltaMs: null,
        doneMs: Math.max(0, now() - startedAt),
        reasoningChars: 0,
        retries,
        failed: true,
        reason: String(error?.code ?? error?.name ?? error?.message ?? error),
      });
      throw error;
    } finally {
      if (timer !== null) timers.clearTimeout(timer);
      signal?.removeEventListener?.('abort', forward);
    }
  }

  return {
    ask,
    tasks: [...LIGHTWEIGHT_TASKS],
    stats: () => ({ ...stats, byTask: JSON.parse(JSON.stringify(stats.byTask)) }),
    /** Capability evidence for one effort: `true | false | null` for the current route. */
    reasoningSupport: async (effort = AUXILIARY_REASONING_EFFORT, signal = undefined) => supports(effort, signal),
  };
}

function positiveInt(value, fallback) {
  const numeric = Math.floor(Number(value));
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}
