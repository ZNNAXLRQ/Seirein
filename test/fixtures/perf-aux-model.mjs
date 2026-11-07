/**
 * Controlled fake provider + host for `test/perf-aux-bench.mjs`.
 *
 * The model has no network and no real provider. Its stream follows a plan that injects the
 * first-TEXT delay, the total stream duration and the number of reasoning-frame characters, so
 * the bench can compare the two auxiliary channels without any provider variance.
 *
 * The fake model is deliberately target-deterministic: both channels receive the same target
 * and produce the same canned reply. The only synthetic way to make the fastpath answer differ
 * is the bench's `--drift` option, which exists only to exercise the quality comparator; it is
 * not evidence about a real model. The bench reports that distinction itself.
 *
 * The host is a real `FastPath` + `createLightweightChannel` over this model. `assist()` has no
 * history side effect, so the temp root is never written: the conversation history is seeded in
 * memory and the constructor's file read simply misses.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FastPath } from '../../src/host/session/inference/fastpath.js';
import { createLightweightChannel } from '../../src/host/session/inference/lightweight.js';

export const FAKE_PROVIDER = 'fake-provider';
export const FAKE_MODEL = 'fake-model';

/** Tasks covered by the bench, in report order. */
export const AUX_TASKS = Object.freeze(['translate', 'kana', 'ack', 'spoken']);

/**
 * The task prompts and replies. `system`/`user` are exactly what both paths send; the task
 * contract instruction is appended by the caller (the channel does it for `context:'none'`, the
 * bench passes it explicitly to `FastPath.assist`), so both paths get the same trailing rule.
 */
export const AUX_TASK_FIXTURES = Object.freeze({
  translate: Object.freeze({
    system: '你是中日翻译器。只输出自然、准确的日语译文，不要解释，不要输出原文。',
    user: '<待译正文>明天的会议改到下午三点，请提前十分钟到会议室。</待译正文>',
    reply: '明日の会議は午後3時に変更になりました。10分前に会議室へお越しください。',
    maxTokens: 512,
  }),
  kana: Object.freeze({
    system: '你是日语假名标注器。只把最后给出的日语正文改写成带空格的假名写法，不要解释。',
    user: '<待标正文>明日はいい天気ですね。散歩に行きましょう。</待标正文>',
    reply: 'あしたは いい てんき ですね。さんぽに いきましょう。',
    maxTokens: 512,
  }),
  ack: Object.freeze({
    system: '你是对话过渡句生成器。只输出一句自然、简短的过渡话，不要回答用户的问题。',
    user: '用户说：帮我查一下明天东京的天气。',
    reply: '好的，我这就去查一下，稍等。',
    maxTokens: 256,
  }),
  spoken: Object.freeze({
    system: '【人设】\n温柔、简洁。\n\n只输出可直接朗读的口语版：保留关键结论、必要条件与下一步，省略展开论证、举例与格式标记。',
    user: '<完整答复>\n明天东京多云转晴，最高气温 18 度，早晚偏凉；建议带一件薄外套。出门前我再帮你确认一次降水概率。\n</完整答复>',
    reply: '明天东京多云转晴，最高 18 度，早晚有点凉，记得带件薄外套。出门前我再帮你确认降水概率。',
    maxTokens: 512,
  }),
});

/** The one shared context both channels would see for chat-shaped prompts. */
export const CONTEXT_FIXTURE = Object.freeze({
  persona: '温柔、简洁，偶尔有点俏皮。回答先给结论，再补一句理由。',
  profile: '用户使用中文交流，偏好直接、可执行的建议。',
  memory: '用户最近在准备周报，并预约了体检。',
  history: Object.freeze([
    Object.freeze({ role: 'user', text: '上次你说想把周报改得简短一点。' }),
    Object.freeze({ role: 'assistant', text: '好的，我会尽量用短句。' }),
    Object.freeze({ role: 'user', text: '明天上午我要去体检，可能不在电脑前。' }),
    Object.freeze({ role: 'assistant', text: '明白了，体检顺利。' }),
  ]),
});

/** Extra clauses used only by `--drift`; they simulate context leaking into the fastpath answer. */
export const DRIFT_CLAUSES = Object.freeze({
  translate: '（沿用上一轮对话的语气）',
  kana: '（尊重最近的称呼）',
  ack: '（接着刚才的话题）',
  spoken: '（按你平时的节奏）',
});

const REASONING_SAMPLE = Array.from('先确认任务边界，再核对上下文里的语气和指代，最后只保留目标正文需要的信息。');

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, Math.max(0, ms)); });
const sleepUntil = async (at, now) => {
  const left = at - now();
  if (left > 0) await sleep(left);
};
const charCount = (value) => Array.from(String(value ?? '')).length;

/** Split by code points, not UTF-16 units, so a surrogate pair is never cut in half. */
function chunkByCodePoints(text, width) {
  const chars = Array.from(String(text ?? ''));
  const size = Math.max(1, Math.floor(Number(width) || 1));
  const chunks = [];
  for (let index = 0; index < chars.length; index += size) {
    chunks.push(chars.slice(index, index + size).join(''));
  }
  return chunks;
}

/** A deterministic reasoning body of exactly `chars` code points (0 -> empty). */
export function reasoningText(chars) {
  const size = Math.max(0, Math.floor(Number(chars) || 0));
  if (size === 0) return '';
  const out = [];
  while (out.length < size) out.push(...REASONING_SAMPLE);
  return out.slice(0, size).join('');
}

/** The user message as one string, across the content shapes the adapters use. */
function messageText(options) {
  const content = options?.messages?.[0]?.content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
  }
  return typeof content === 'string' ? content : '';
}

function captureRequest(options, at) {
  const user = messageText(options);
  return {
    at,
    streamStartedAt: at,
    firstTextAt: null,
    endedAt: null,
    provider: String(options?.provider ?? ''),
    model: String(options?.model ?? ''),
    reasoningEffort: options?.reasoningEffort ?? null,
    systemChars: charCount(options?.system),
    userChars: charCount(user),
    inputChars: charCount(options?.system) + charCount(user),
  };
}

async function* generateFromPlan(captured, plan, now) {
  const started = captured.streamStartedAt;
  const firstAt = started + Math.max(0, Number(plan.firstTextMs) || 0);
  const endAt = started + Math.max((Number(plan.firstTextMs) || 0) + 1, Number(plan.totalMs) || 1);

  if (plan.fail === true) {
    // Fail before the first body text, like a provider error that produced nothing audible.
    await sleepUntil(started + Math.max(1, (firstAt - started) / 2), now);
    captured.endedAt = now();
    const error = new Error(plan.errorText ?? 'fake provider failure');
    error.code = 'FAKE_PROVIDER_FAILURE';
    throw error;
  }

  const reasoning = reasoningText(plan.reasoningChars);
  const frames = chunkByCodePoints(reasoning, Math.max(1, Math.ceil(Array.from(reasoning).length / 3)));
  for (let index = 0; index < frames.length; index += 1) {
    const at = started + Math.max(0, (firstAt - started) * 0.8 * ((index + 1) / (frames.length + 1)));
    await sleepUntil(at, now);
    yield { type: 'reasoning-delta', text: frames[index] };
  }

  await sleepUntil(firstAt, now);
  captured.firstTextAt = now();
  const chunks = chunkByCodePoints(plan.text, 8);
  for (let index = 0; index < chunks.length; index += 1) {
    if (index > 0) {
      const at = firstAt + (endAt - firstAt) * (index / Math.max(1, chunks.length - 1));
      await sleepUntil(at, now);
    }
    yield { type: 'text-delta', text: chunks[index] };
  }
  await sleepUntil(endAt, now);
  captured.endedAt = now();
  yield { type: 'finish', reason: { kind: 'stop' } };
}

/**
 * @param {{now?: () => number, honorOff?: boolean}} [options]
 *   `honorOff` false (the default) makes the fake model emit its configured reasoning frames
 *   even when the request carries `reasoningEffort:'off'` — that is how the bench proves the
 *   "requested off" flag is not the same thing as "actually reasoned zero".
 * @returns {{llm: object, requests: object[], enqueue: Function, lastRequest: Function}}
 */
export function createFakeAuxModel({ now = () => performance.now(), honorOff = false } = {}) {
  const requests = [];
  let plan = null;
  const llm = {
    async resolveModelInfo() {
      return {
        provider: FAKE_PROVIDER,
        id: FAKE_MODEL,
        reasoning: { efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }] },
      };
    },
    stream(options) {
      if (plan === null) throw new Error('perf fixture: stream() called without a plan');
      const current = plan;
      plan = null;
      const captured = captureRequest(options, now());
      captured.reasoningEmitted = honorOff && options?.reasoningEffort === 'off'
        ? 0
        : Math.max(0, Math.floor(Number(current.reasoningChars) || 0));
      requests.push(captured);
      return generateFromPlan(captured, { ...current, reasoningChars: captured.reasoningEmitted }, now);
    },
  };
  return {
    llm,
    requests,
    enqueue(next) {
      if (plan !== null) throw new Error('perf fixture: a plan is already queued');
      plan = next;
    },
    lastRequest() {
      return requests[requests.length - 1] ?? null;
    },
  };
}

/** A FastPath + lightweight channel over the fake model, sharing one injected clock. */
export function createAuxBenchHost({ model, now = () => performance.now(), root = join(tmpdir(), 'dsh-aux-bench-host') } = {}) {
  const fastpath = new FastPath({
    root,
    getLlm: () => model.llm,
    getSelection: () => ({ currentSelection: () => ({ provider: FAKE_PROVIDER, model: FAKE_MODEL }) }),
    persona: { read: (which) => (which === 'agent' ? CONTEXT_FIXTURE.persona : CONTEXT_FIXTURE.profile) },
    memory: { brief: () => ({ text: CONTEXT_FIXTURE.memory }) },
    log: { emit: () => Promise.resolve() },
    config: {},
    workspace: null,
    now,
  });
  // `assist` never writes history; seeding it in memory keeps the context identical and means the
  // bench never creates or touches a file under the repository (or even under the temp root).
  fastpath.history = CONTEXT_FIXTURE.history.map((turn, index) => ({
    role: turn.role,
    text: turn.text,
    ts: index + 1,
    domain: '',
    domainLabel: '',
  }));
  const channel = createLightweightChannel({ fastpath, options: { reasoning: 'off', now } });
  return { fastpath, channel };
}
