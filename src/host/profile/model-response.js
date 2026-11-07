/** model-response — extracted from profileMaintain.js; no host entry dependency. */
import { positiveInt } from './maintain-config.js';

/** Default budget of one maintenance request: extract / split / compose / questionnaire. */
export const PROFILE_MAINTAIN_DEFAULT_MAX_TOKENS = 4096;


/**
 * The single retry after an empty answer raises the ceiling instead of reusing the first one:
 * a `max-tokens` truncation means the whole budget went into reasoning, so the retry needs a
 * much larger budget (4x, at least 8192); any other empty answer only doubles. Both are clamped
 * to the hard ceiling, and a retry never asks for less than the first attempt.
 */
const MODEL_EMPTY_RETRY_MIN_TOKENS = 3200;

const MODEL_TRUNCATED_RETRY_MIN_TOKENS = 8192;

const MODEL_RETRY_MAX_TOKENS = 16384;


/** True when the provider stopped because the token budget ran out, not because it finished. */
function modelTruncatedFinish(finish) {
  const kind = modelFinishKind(finish).replace(/[^a-z]/gu, '');
  return kind === 'maxtokens' || kind === 'length';
}


/** The only finishes that prove the whole answer arrived; anything else is unfinished. */
const MODEL_COMPLETE_FINISHES = new Set(['completed', 'complete', 'stop', 'end', 'eos', 'success', 'finished']);


/**
 * A normal finish is not enough: a `truncated` flag means the provider cut the body off even
 * though it reported a reason. Any unfinished answer's body is a partial line, never a success.
 */
function modelFinishCompleted(finish, truncated = false) {
  if (truncated === true) return false;
  if (finish !== null && typeof finish === 'object' && finish.truncated === true) return false;
  return !modelTruncatedFinish(finish)
    && MODEL_COMPLETE_FINISHES.has(modelFinishKind(finish).replace(/[^a-z]/gu, ''));
}


/** Ceiling of the one empty retry: larger than the first attempt, clamped to the hard ceiling. */
function modelRetryMaxTokens(current, truncated = false) {
  const base = positiveInt(current, 1);
  const raised = truncated
    ? Math.max(MODEL_TRUNCATED_RETRY_MIN_TOKENS, base * 4)
    : Math.max(MODEL_EMPTY_RETRY_MIN_TOKENS, base * 2);
  return Math.max(base, Math.min(MODEL_RETRY_MAX_TOKENS, raised));
}


/** A provider finishes with a string or `{kind|type|reason}`; normalize both to a lowercase kind. */
function modelFinishKind(value) {
  if (typeof value === 'string') return value.trim().toLowerCase();
  if (value !== null && typeof value === 'object') {
    return String(value.kind ?? value.type ?? value.reason ?? '').trim().toLowerCase();
  }
  return '';
}


/** The finish kind of one stream frame (empty when the frame carries none). */
function modelChunkFinish(chunk) {
  if (chunk === null || typeof chunk !== 'object') return '';
  if (String(chunk.type ?? '').toLowerCase() === 'error') return 'error';
  return modelFinishKind(chunk.reason ?? chunk.finishReason ?? chunk.finish);
}


/**
 * Body text of one frame. Providers ship the delta as `text`, `delta` or `content` (string or
 * content blocks); the first non-empty source wins, exactly like the dispatch body-frame reader.
 */
function modelChunkText(chunk) {
  if (chunk === null || typeof chunk !== 'object') return '';
  for (const key of ['text', 'delta', 'content']) {
    const value = chunk[key];
    let text = '';
    if (typeof value === 'string') {
      text = value;
    } else if (Array.isArray(value)) {
      text = value
        .map((part) => (typeof part === 'string' ? part : (typeof part?.text === 'string' ? part.text : '')))
        .join('');
    } else if (value !== null && typeof value === 'object' && typeof value.text === 'string') {
      text = value.text;
    }
    if (text.length > 0) return text;
  }
  return '';
}


/** The diagnostic scene of one completion. Body content is never part of it. */
function modelDetails({ finish, chunks, text, reasoningChars, model, provider }) {
  return {
    finish: String(finish ?? ''),
    chunks: Number(chunks) || 0,
    textChars: String(text ?? '').length,
    reasoningChars: Number(reasoningChars) || 0,
    model: String(model ?? ''),
    provider: String(provider ?? ''),
  };
}


/** Empty-answer error: an explicit EMPTY_TEXT code plus the scene, never the generated text. */
function modelEmptyError(details) {
  const error = new Error(`profile maintain: model returned no text (EMPTY_TEXT) ${JSON.stringify(details)}`);
  error.code = 'EMPTY_TEXT';
  error.details = details;
  return error;
}


/**
 * Unfinished-answer error: the provider failed/aborted or reported a non-normal finish, so even a
 * non-empty body is only half an answer. The scene is kept, the generated text never is.
 */
function modelIncompleteError(details) {
  const error = new Error(`profile maintain: model answer did not finish (MODEL_INCOMPLETE) ${JSON.stringify(details)}`);
  error.code = 'MODEL_INCOMPLETE';
  error.details = details;
  return error;
}


/**
 * Phases whose answer is a plain final body, never JSON. The persona questionnaire is generated as
 * 人设正文, so its retry must not demand JSON (that contradiction made the retry fail too).
 */
const BODY_PHASES = new Set(['compose', 'persona']);


/** The retry prompt must forbid the reasoning that produced the empty first answer. */
function strictModelSystem(phase, system, { truncated = false } = {}) {
  const rule = BODY_PHASES.has(phase)
    ? '严格模式：只输出最终正文，不要解释、不要推理过程，不要输出任何思考或说明。'
    : '严格模式：只输出 JSON，不要解释、不要推理过程，不要输出 JSON 以外的任何文字。';
  // A truncated first attempt spent its whole budget on reasoning: the retry must answer directly.
  const direct = truncated ? '\n直接给出结果，不要输出推理过程，不要写思考、分析或自检。' : '';
  const base = String(system ?? '').trim();
  return `${base.length > 0 ? `${base}\n${rule}` : rule}${direct}`;
}

export {
  MODEL_EMPTY_RETRY_MIN_TOKENS,
  MODEL_TRUNCATED_RETRY_MIN_TOKENS,
  MODEL_RETRY_MAX_TOKENS,
  modelTruncatedFinish,
  MODEL_COMPLETE_FINISHES,
  modelFinishCompleted,
  modelRetryMaxTokens,
  modelFinishKind,
  modelChunkFinish,
  modelChunkText,
  modelDetails,
  modelEmptyError,
  modelIncompleteError,
  BODY_PHASES,
  strictModelSystem,
};
