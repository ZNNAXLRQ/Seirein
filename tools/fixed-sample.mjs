#!/usr/bin/env node
/**
 * P-61 固定样本对照实验：离线样本报告工具（只读）。
 *
 * ============================================================================
 * 输入格式（本文件的 README 式顶部注释；--help 同步说明）
 * ============================================================================
 * `--input <file>` 读取 JSON Lines（一行一个轮次，UTF-8，允许空行）：
 *
 *   {
 *     "scenario": "chat",                       // 必填；模板 id 或模板 title
 *     "turn": 1,                                // 必填；轮次号（数字或字符串）
 *     "origin": "assistant",                    // 助手归属：assistant | coding-agent | unknown
 *     "sessionKind": "assistant",               // 兼容字段；origin 缺失时回退读取
 *     "lane": "voice",                          // voice | typed
 *     "phase": "body",                          // ack | body
 *     "version": "v0.99.0",                     // 可选；版本标签
 *     "startedAt": "2026-11-09T14:00:00+08:00", // 必填；ISO 8601
 *     "endedAt": "2026-11-09T14:00:02+08:00",   // 必填；ISO 8601
 *     "firstTextAt": "...",                     // 可选；必须是实际正文流时间，不从整步提交倒推
 *     "firstAudioAt": "...",                    // 可选；首音到达时间
 *     "toolCalls": [                            // 可选；缺失写 null，不补 []
 *       { "name": "read", "start": "...", "end": "...", "status": "ok", "timeout": false }
 *     ],
 *     "memoryHits": 2,                          // 可选；数字或数组（数组取长度）
 *     "aborted": false                          // 可选；布尔值
 *   }
 *
 * 统计口径：
 *   - 默认只统计 origin=assistant（sessionKind 可回退）；coding-agent / unknown /
 *     缺失 origin 都不算助手样本，报告写“样本不足”，绝不用编码代理样本补齐。
 *   - `--include-non-assistant` 才把非助手样本纳入，且放入独立的 non-assistant 组；
 *     两组、以及 lane×phase 各自统计，不混算。
 *   - 五类场景的目标次数来自模板 repeat（默认每类 5），`--repeat` 可覆盖。
 *   - 缺失 / 无法解析的字段在报告里一律写 `null`，**不补 0**。
 *   - 轮次耗时 = endedAt - startedAt；首字 / 首音 = 对应时间 - startedAt。
 *   - firstTextAt 只读输入里的实际正文流字段；只有 assistantMessageAt（整步提交）时
 *     保持 null 并在报告标 `firstTextAt: missing`，不倒推。
 *   - 工具耗时按同一轮内区间**并集**计算；普通工具与主动等待类工具（job_output /
 *     wait_agent 等）分别成 waits，并分别计算并集。
 *   - toolCalls[].status / timeout 只保留实际来源；缺失写 null，不按耗时长推定 timeout。
 *   - p50 / p95 使用 nearest-rank；没有有效样本时为 `null`；每个 lane×phase 少于 5 个
 *     样本时明确写“样本不足（n<5）”。
 *   - 报告只描述本批固定样本；样本非随机，不承诺任何性能收益。
 *   - 一次只改一个变量：每份报告只应记录一个变量变更，报告头会再次提示。
 *
 * 用法：
 *   node tools/fixed-sample.mjs --input sample.jsonl
 *   node tools/fixed-sample.mjs --input sample.jsonl --out report.md --variable "回复长度"
 *   node tools/fixed-sample.mjs --input sample.jsonl --include-non-assistant
 *   node tools/fixed-sample.mjs --input sample.jsonl --repeat 7 --json summary.json
 *   node tools/fixed-sample.mjs --help
 *
 * 退出码：
 *   0  报告已生成（空输入、坏行、样本不足都仍生成报告）
 *   1  输入 / 模板读取失败，或写报告失败
 *   2  参数错误
 *
 * 本工具不调用模型、不发送真实请求、不生成样本；只读本地 JSONL。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
export const DEFAULT_SCENARIOS_PATH = resolve(dirname(SCRIPT_PATH), 'fixtures', 'fixed-sample-scenarios.json');

export const MIN_REPEAT = 1;
export const MAX_REPEAT = 1000;
export const REPORT_SCHEMA = 'seirein.fixed-sample.summary/v1';
export const SCENARIO_SCHEMA = 'seirein.fixed-sample.scenarios/v1';

/** 单个 lane×phase 组合低于该样本数时，报告明确写“样本不足（n<5）”。 */
export const MIN_GROUP_SAMPLES = 5;
export const ORIGIN_VALUES = Object.freeze(['assistant', 'coding-agent', 'unknown']);
export const LANE_VALUES = Object.freeze(['voice', 'typed']);
export const PHASE_VALUES = Object.freeze(['ack', 'body']);

/**
 * 主动等待类工具：它们的时间是“等待窗口”，不是工具执行时间。
 * 与普通工具分开统计，避免把 120 s 的 job_output 当成工具 CPU 或超时。
 */
export const WAIT_TOOL_NAMES = Object.freeze([
  'job_output',
  'wait_agent',
  'wait_for_agent',
  'agent_wait',
  'wait_job',
  'job_wait',
  'wait',
  'sleep',
]);

const REQUIRED_FIELDS = ['scenario', 'turn', 'startedAt', 'endedAt', 'origin'];
const OK_STATUSES = new Set(['ok', 'success', 'succeeded', 'done', 'completed', 'passed']);
const ERROR_STATUSES = new Set([
  'error',
  'failed',
  'failure',
  'timeout',
  'timedout',
  'cancelled',
  'canceled',
  'aborted',
  'denied',
  'rejected',
]);

export const REPORT_NOTES = [
  '样本非随机：来自固定场景模板的逐轮日志，只描述本批样本，不能外推到总体或未测场景。',
  '不承诺性能收益：本报告不声称首字延迟、合成延迟或任何倍数收益；p50/p95 只是本批样本的描述统计。',
  '一次只改一个变量：每份报告只对应一个变量变更；同时改多个变量的样本不得混在同一组对比里。',
  '助手归属默认严格限定 assistant：缺失 / unknown 不算助手样本；非助手样本只有 --include-non-assistant 才纳入，并单独成组，绝不用编码代理样本补齐。',
  'lane×phase 分开统计：voice/typed 与 ack/body 各自算 p50/p95，不跨组合混算；任一组合少于 5 个样本时写“样本不足（n<5）”。',
  'firstTextAt 只取实际正文流时间：输入只有整步提交（如 assistantMessageAt）时保持 null，不倒推，报告标 firstTextAt: missing。',
  '工具 status/timeout 只记实际来源：没有就写 null，不按耗时长推定 timeout；主动等待类工具（job_output / wait_agent 等）单列为 waits，与普通工具分开。',
  '缺失字段一律写 null，不补 0；无法解析的时间同样写 null，不静默钳到 0。',
  '并行工具耗时按区间并集计算，重叠部分只计一次；等待工具另算等待并集，不混入普通工具并集。',
  'p50/p95 使用 nearest-rank（第 ceil(q*n) 个排序值）；有效样本为 0 时为 null。',
  '工具只读本地 JSONL，不调用模型、不发送真实请求、不生成样本；样本不足只标记未达成，不补造轮次。',
];

export const USAGE = `P-61 固定样本对照实验（离线，只读）

用法:
  node tools/fixed-sample.mjs --input <file> [选项]

输入:
  JSON Lines，一行一个轮次。字段:
    scenario      必填；模板 id 或模板 title
    turn          必填；轮次号（数字或字符串）
    origin        助手归属：assistant | coding-agent | unknown（缺失按 unknown）
    sessionKind   兼容字段；origin 缺失时回退读取
    lane          voice | typed
    phase         ack | body
    version       可选；版本标签
    startedAt     必填；ISO 8601 时间
    endedAt       必填；ISO 8601 时间
    firstTextAt   可选；必须是实际正文流时间，不从 assistantMessageAt 倒推
    firstAudioAt  可选；首音到达时间
    toolCalls     可选；[{name,start,end,status,timeout}]，缺失写 null（不补 []）
    memoryHits    可选；数字或数组（数组取长度）
    aborted       可选；布尔值
  默认只统计 origin=assistant；缺失 / unknown 不算助手样本，报告“样本不足”。
  非助手样本需 --include-non-assistant 才纳入，并单独成组；不会用来补齐助手样本。
  缺失或无法解析的字段在报告中写 null，不补 0；工具耗时用区间并集，
  job_output / wait_agent 等主动等待工具单列为 waits。
  示例:
    {"scenario":"chat","turn":1,"origin":"assistant","lane":"voice","phase":"body","version":"v1","startedAt":"2026-11-09T14:00:00+08:00","endedAt":"2026-11-09T14:00:02+08:00","firstTextAt":"2026-11-09T14:00:00.900+08:00","firstAudioAt":"2026-11-09T14:00:01.500+08:00","toolCalls":[],"memoryHits":1,"aborted":false}

选项:
  --input <file>       必填；'-' 表示从 stdin 读取
  --out <file>         写 Markdown 报告；省略或 '-' 写 stdout
  --json <file>        写纯 JSON 摘要；省略时若 --out 是文件则写同名 .json
  --repeat <n>         覆盖模板每类占位次数（${MIN_REPEAT}–${MAX_REPEAT}；模板默认 5）
  --scenarios <file>   场景模板，默认 tools/fixtures/fixed-sample-scenarios.json
  --variable <text>    本次唯一变量（只写入报告元数据，不改变样本）
  --include-non-assistant
                       显式纳入非助手样本；单独成组，不影响 assistant 组
  -h, --help           显示本帮助

输出:
  Markdown（两组归属 / lane×phase 样本数 / 场景 / 逐轮明细 / p50/p95 / 质量列）
  并附 JSON 摘要；--json 可另存一份纯 JSON。报告会再次强调样本非随机、
  不承诺性能收益、一次只改一个变量；每个 lane×phase 少于 5 个样本时写
  “样本不足（n<5）”。

退出码:
  0 报告已生成（空输入、坏行、样本不足仍生成）
  1 读取输入 / 模板失败，或写报告失败
  2 参数错误
`;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function writeTo(stream, text) {
  if (stream !== null && stream !== undefined && typeof stream.write === 'function') {
    stream.write(text);
  }
}

function describeError(error) {
  const message = String(error?.message ?? error ?? 'unknown error');
  const code = error?.code;
  return code !== undefined && !message.includes(String(code)) ? `${message} (${code})` : message;
}

function textOrNull(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text === '' ? null : text;
}

function labelOrNull(value) {
  if (typeof value === 'string') return textOrNull(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function readStatus(value) {
  return textOrNull(value);
}

function readTurn(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return textOrNull(value);
}

function canonicalToken(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[\s_]+/gu, '-');
}

/**
 * 归属只认三类。`sessionKind` 是 origin 缺失时的兼容回退；不把任意字符串猜成助手。
 * 返回 null 表示无法判定（最终按 unknown 处理）。
 */
function classifyOrigin(value) {
  const token = canonicalToken(value);
  if (token === '') return null;
  if (token === 'assistant' || token === 'companion') {
    return 'assistant';
  }
  if (
    token === 'coding-agent'
    || token === 'codingagent'
    || token === 'coding'
    || token === 'code-agent'
  ) {
    return 'coding-agent';
  }
  if (token === 'unknown' || token === 'unattributed' || token === 'n/a' || token === 'na') {
    return 'unknown';
  }
  return null;
}

function readOrigin(raw) {
  const explicit = textOrNull(raw.origin);
  if (explicit !== null) {
    return { origin: classifyOrigin(explicit) ?? 'unknown', originSource: 'origin' };
  }
  const sessionKind = textOrNull(raw.sessionKind);
  if (sessionKind !== null) {
    return { origin: classifyOrigin(sessionKind) ?? 'unknown', originSource: 'sessionKind' };
  }
  return { origin: 'unknown', originSource: null };
}

function classifyLane(value) {
  const token = canonicalToken(value);
  if (token === 'voice') return 'voice';
  if (token === 'typed' || token === 'text' || token === 'typing') return 'typed';
  return null;
}

function classifyPhase(value) {
  const token = canonicalToken(value);
  if (token === 'ack' || token === 'acknowledgement' || token === 'acknowledgment') return 'ack';
  if (token === 'body' || token === 'answer' || token === 'reply') return 'body';
  return null;
}

function isWaitingToolName(name) {
  if (name === null) return false;
  const token = String(name).trim().toLowerCase().replace(/[\s_]+/gu, '-');
  if (WAIT_TOOL_NAMES.some((entry) => entry.toLowerCase().replace(/[\s_]+/gu, '-') === token)) {
    return true;
  }
  return /^(?:wait|sleep)(?:-|$)/u.test(token);
}

function readTimeout(value) {
  return typeof value === 'boolean' ? value : null;
}

/**
 * 只接受可解析的字符串时间，并保留原文本。
 * 返回 { text, ms }；缺失或不可解析时两者都是 null。
 */
function readTimestamp(value) {
  const text = textOrNull(value);
  if (text === null) return { text: null, ms: null };
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? { text, ms } : { text: null, ms: null };
}

function readMemoryHits(value) {
  if (Array.isArray(value)) return value.length;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  return null;
}

function classifyToolStatus(status) {
  if (status === null) return 'missing';
  const text = status.trim().toLowerCase();
  if (OK_STATUSES.has(text)) return 'ok';
  if (ERROR_STATUSES.has(text)) return 'error';
  return 'unknown';
}

/** 区间并集长度；无效区间忽略。空数组合法返回 0。 */
export function unionIntervalsMs(intervals = []) {
  const valid = [];
  for (const interval of intervals) {
    if (!isPlainObject(interval)) continue;
    const { start, end } = interval;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    valid.push({ start, end });
  }
  valid.sort((left, right) => left.start - right.start || left.end - right.end);
  let total = 0;
  let currentStart = null;
  let currentEnd = null;
  for (const interval of valid) {
    if (currentStart === null) {
      currentStart = interval.start;
      currentEnd = interval.end;
      continue;
    }
    if (interval.start > currentEnd) {
      total += currentEnd - currentStart;
      currentStart = interval.start;
      currentEnd = interval.end;
    } else if (interval.end > currentEnd) {
      currentEnd = interval.end;
    }
  }
  if (currentStart !== null) total += currentEnd - currentStart;
  return total;
}

function normalizeToolCalls(rawCalls) {
  const allCalls = [];
  const normalCalls = [];
  const waits = [];
  const intervals = [];
  const waitIntervals = [];
  let ok = 0;
  let error = 0;
  let unknown = 0;
  let missingStatus = 0;
  let timeoutTrue = 0;
  let timeoutFalse = 0;
  let timeoutMissing = 0;
  for (const rawCall of rawCalls) {
    const call = isPlainObject(rawCall) ? rawCall : {};
    const name = labelOrNull(call.name);
    const start = readTimestamp(call.start);
    const end = readTimestamp(call.end);
    const durationMs = start.ms !== null && end.ms !== null && end.ms >= start.ms
      ? end.ms - start.ms
      : null;
    // 只保留输入里真实存在的 status / timeout；不用耗时或状态文本反推 timeout。
    const status = readStatus(call.status);
    const statusClass = classifyToolStatus(status);
    if (statusClass === 'ok') ok += 1;
    else if (statusClass === 'error') error += 1;
    else if (statusClass === 'unknown') unknown += 1;
    else missingStatus += 1;
    const timeout = readTimeout(call.timeout);
    if (timeout === true) timeoutTrue += 1;
    else if (timeout === false) timeoutFalse += 1;
    else timeoutMissing += 1;
    const waiting = isWaitingToolName(name);
    const entry = {
      name,
      start: start.text,
      end: end.text,
      status,
      timeout,
      durationMs,
      waiting,
    };
    allCalls.push(entry);
    if (waiting) waits.push(entry);
    else normalCalls.push(entry);
    if (durationMs !== null) {
      if (waiting) waitIntervals.push({ start: start.ms, end: end.ms });
      else intervals.push({ start: start.ms, end: end.ms });
    }
  }
  const allIntervals = [...intervals, ...waitIntervals];
  const timing = {
    toolMs: normalCalls.length === 0 ? 0 : intervals.length > 0 ? unionIntervalsMs(intervals) : null,
    waitMs: waits.length === 0 ? 0 : waitIntervals.length > 0 ? unionIntervalsMs(waitIntervals) : null,
    allToolMs: allCalls.length === 0 ? 0 : allIntervals.length > 0 ? unionIntervalsMs(allIntervals) : null,
  };
  return {
    calls: normalCalls,
    allCalls,
    normalCalls,
    waits,
    ...timing,
    toolStatus: { ok, error, unknown, missing: missingStatus },
    toolTimeout: { true: timeoutTrue, false: timeoutFalse, missing: timeoutMissing },
    toolMissingTiming: allCalls.length - allIntervals.length,
  };
}

/**
 * 规范化一条输入记录。缺失 / 非法字段写成 null；不补 0。
 * 不修改原始对象，也不读取格式化以外的字段。
 */
export function normalizeRecord(raw, line = null) {
  const source = isPlainObject(raw) ? raw : {};
  const scenario = textOrNull(source.scenario);
  const turn = readTurn(source.turn);
  const { origin, originSource } = readOrigin(source);
  const lane = classifyLane(source.lane);
  const phase = classifyPhase(source.phase);
  const version = labelOrNull(source.version);
  const started = readTimestamp(source.startedAt);
  const ended = readTimestamp(source.endedAt);
  // firstTextAt 只认实际正文流字段。assistantMessageAt 是整步提交时间，
  // 即使存在也不得倒推首正文时间；这里只记录它，不参与 firstTextMs。
  const firstText = readTimestamp(source.firstTextAt);
  const firstAudio = readTimestamp(source.firstAudioAt);
  const assistantMessage = readTimestamp(source.assistantMessageAt);

  const turnMs = started.ms !== null && ended.ms !== null && ended.ms >= started.ms
    ? ended.ms - started.ms
    : null;
  const firstTextMs = started.ms !== null && firstText.ms !== null && firstText.ms >= started.ms
    ? firstText.ms - started.ms
    : null;
  const firstAudioMs = started.ms !== null && firstAudio.ms !== null && firstAudio.ms >= started.ms
    ? firstAudio.ms - started.ms
    : null;

  let toolCalls = null;
  let allToolCalls = null;
  let normalToolCalls = null;
  let waits = null;
  let toolMs = null;
  let waitMs = null;
  let allToolMs = null;
  let toolStatus = null;
  let toolTimeout = null;
  let toolMissingTiming = null;
  if (Array.isArray(source.toolCalls)) {
    const normalized = normalizeToolCalls(source.toolCalls);
    toolCalls = normalized.calls;
    allToolCalls = normalized.allCalls;
    normalToolCalls = normalized.normalCalls;
    waits = normalized.waits;
    toolMs = normalized.toolMs;
    waitMs = normalized.waitMs;
    allToolMs = normalized.allToolMs;
    toolStatus = normalized.toolStatus;
    toolTimeout = normalized.toolTimeout;
    toolMissingTiming = normalized.toolMissingTiming;
  }

  const memoryHits = readMemoryHits(source.memoryHits);
  const aborted = typeof source.aborted === 'boolean' ? source.aborted : null;

  const missingFields = [];
  if (scenario === null) missingFields.push('scenario');
  if (turn === null) missingFields.push('turn');
  if (originSource === null) missingFields.push('origin');
  if (lane === null) missingFields.push('lane');
  if (phase === null) missingFields.push('phase');
  if (started.text === null) missingFields.push('startedAt');
  if (ended.text === null) missingFields.push('endedAt');
  if (firstText.text === null) missingFields.push('firstTextAt');
  if (firstAudio.text === null) missingFields.push('firstAudioAt');
  if (toolCalls === null) missingFields.push('toolCalls');
  if (memoryHits === null) missingFields.push('memoryHits');
  if (aborted === null) missingFields.push('aborted');

  return {
    line,
    scenario,
    turn,
    origin,
    originSource,
    isAssistant: origin === 'assistant',
    lane,
    phase,
    version,
    startedAt: started.text,
    endedAt: ended.text,
    firstTextAt: firstText.text,
    firstTextSource: firstText.text === null ? null : 'text-stream',
    firstAudioAt: firstAudio.text,
    assistantMessageAt: assistantMessage.text,
    firstTextMissing: firstText.text === null,
    turnMs,
    firstTextMs,
    firstAudioMs,
    toolCalls,
    allToolCalls,
    normalToolCalls,
    waits,
    toolMs,
    waitMs,
    allToolMs,
    toolStatus,
    toolTimeout,
    toolMissingTiming,
    memoryHits,
    aborted,
    missingFields,
  };
}

/**
 * 解析 JSONL。坏行进入 badLines 并跳过，不中断其余行。
 * 行号从 1 开始；空行计入 blankLines。
 */
export function parseInputText(text, { input = null } = {}) {
  const rawText = String(text ?? '').replace(/^\uFEFF/u, '');
  const lines = rawText.split(/\r?\n/u);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const records = [];
  const badLines = [];
  let blankLines = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '') {
      blankLines += 1;
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      // 不回显原始行内容，避免把日志正文带进报告。
      badLines.push({
        line: index + 1,
        message: 'invalid JSON',
      });
      continue;
    }
    if (!isPlainObject(parsed)) {
      badLines.push({
        line: index + 1,
        message: 'line is not a JSON object',
      });
      continue;
    }
    records.push(normalizeRecord(parsed, index + 1));
  }
  return {
    input,
    records,
    badLines,
    blankLines,
    totalLines: lines.length,
    nonEmptyLines: records.length + badLines.length,
  };
}

function readScenarioList(raw) {
  if (!isPlainObject(raw)) throw new Error('scenario template must be a JSON object');
  if (!Array.isArray(raw.scenarios) || raw.scenarios.length === 0) {
    throw new Error('scenario template must contain a non-empty scenarios array');
  }
  const defaultRepeat = raw.repeat ?? 5;
  if (!Number.isInteger(defaultRepeat) || defaultRepeat < MIN_REPEAT || defaultRepeat > MAX_REPEAT) {
    throw new Error(`scenario template repeat must be an integer from ${MIN_REPEAT} to ${MAX_REPEAT}`);
  }
  const seenIds = new Set();
  const scenarios = raw.scenarios.map((entry, index) => {
    if (!isPlainObject(entry)) throw new Error(`scenario #${index + 1} must be an object`);
    const id = textOrNull(entry.id);
    if (id === null) throw new Error(`scenario #${index + 1} is missing a string id`);
    if (seenIds.has(id)) throw new Error(`duplicate scenario id: ${id}`);
    seenIds.add(id);
    const repeat = entry.repeat ?? defaultRepeat;
    if (!Number.isInteger(repeat) || repeat < MIN_REPEAT || repeat > MAX_REPEAT) {
      throw new Error(`scenario ${id} repeat must be an integer from ${MIN_REPEAT} to ${MAX_REPEAT}`);
    }
    return {
      id,
      title: textOrNull(entry.title) ?? id,
      repeat,
      variableHint: textOrNull(entry.variableHint),
      qualityFocus: textOrNull(entry.qualityFocus),
      placeholders: Array.isArray(entry.placeholders) ? entry.placeholders.length : 0,
    };
  });
  return {
    schema: textOrNull(raw.schema) ?? SCENARIO_SCHEMA,
    name: textOrNull(raw.name),
    description: textOrNull(raw.description),
    repeat: defaultRepeat,
    scenarios,
  };
}

/** 校验并规范化场景模板（纯函数，便于测试）。 */
export function parseScenarioTemplate(raw) {
  return readScenarioList(raw);
}

/** 读取场景模板；文件缺失或结构非法由调用方转成退出码 1。 */
export async function loadScenarioTemplate(filePath, { readText } = {}) {
  const reader = typeof readText === 'function' ? readText : (path) => readFile(path, 'utf8');
  const text = await reader(filePath);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`scenario template is not valid JSON: ${describeError(error)}`);
  }
  return parseScenarioTemplate(parsed);
}

/** nearest-rank 分位数；空样本返回 null。 */
export function percentile(values = [], ratio = 0.5) {
  const numbers = [];
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) numbers.push(value);
  }
  if (numbers.length === 0) return null;
  numbers.sort((left, right) => left - right);
  const q = Math.min(1, Math.max(0, Number.isFinite(ratio) ? ratio : 0.5));
  const rank = Math.ceil(q * numbers.length);
  const index = Math.min(numbers.length - 1, Math.max(0, rank - 1));
  return numbers[index];
}

export function latencyStats(values = []) {
  return {
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    count: values.filter((value) => typeof value === 'number' && Number.isFinite(value)).length,
  };
}

function qualityFor(records) {
  let aborted = 0;
  let abortedUnknown = 0;
  let toolCallTurns = 0;
  let toolCalls = 0;
  let allToolCalls = 0;
  let normalToolCalls = 0;
  let waitCalls = 0;
  let waitTurns = 0;
  let toolOk = 0;
  let toolError = 0;
  let toolUnknown = 0;
  let toolStatusMissing = 0;
  let toolTimeoutTrue = 0;
  let toolTimeoutFalse = 0;
  let toolTimeoutMissing = 0;
  let toolMissingTiming = 0;
  let memoryHits = 0;
  let memoryHitsTurns = 0;
  let turnsMissingRequired = 0;
  let turnsMissingTurnDuration = 0;
  let turnsMissingFirstText = 0;
  let turnsMissingFirstAudio = 0;
  let turnsMissingToolCalls = 0;
  let turnsMissingMemoryHits = 0;

  for (const record of records) {
    if (record.aborted === true) aborted += 1;
    else if (record.aborted !== false) abortedUnknown += 1;

    if (record.toolCalls !== null) {
      toolCallTurns += 1;
      toolCalls += record.toolCalls.length;
      allToolCalls += Array.isArray(record.allToolCalls) ? record.allToolCalls.length : record.toolCalls.length;
      normalToolCalls += record.toolCalls.length;
      waitCalls += Array.isArray(record.waits) ? record.waits.length : 0;
      if (Array.isArray(record.waits) && record.waits.length > 0) waitTurns += 1;
      if (record.toolStatus !== null) {
        toolOk += record.toolStatus.ok;
        toolError += record.toolStatus.error;
        toolUnknown += record.toolStatus.unknown;
        toolStatusMissing += record.toolStatus.missing ?? 0;
      }
      if (record.toolTimeout !== null) {
        toolTimeoutTrue += record.toolTimeout.true ?? 0;
        toolTimeoutFalse += record.toolTimeout.false ?? 0;
        toolTimeoutMissing += record.toolTimeout.missing ?? 0;
      }
      toolMissingTiming += record.toolMissingTiming ?? 0;
    } else {
      turnsMissingToolCalls += 1;
    }

    if (record.memoryHits !== null) {
      memoryHitsTurns += 1;
      memoryHits += record.memoryHits;
    } else {
      turnsMissingMemoryHits += 1;
    }

    if (record.missingFields.some((field) => REQUIRED_FIELDS.includes(field))) {
      turnsMissingRequired += 1;
    }
    if (record.turnMs === null) turnsMissingTurnDuration += 1;
    if (record.firstTextMs === null) turnsMissingFirstText += 1;
    if (record.firstAudioMs === null) turnsMissingFirstAudio += 1;
  }

  const hasToolData = toolCallTurns > 0;
  return {
    aborted,
    abortedUnknown,
    toolCallTurns,
    toolCalls: hasToolData ? toolCalls : null,
    allToolCalls: hasToolData ? allToolCalls : null,
    normalToolCalls: hasToolData ? normalToolCalls : null,
    waitCalls: hasToolData ? waitCalls : null,
    waitTurns: hasToolData ? waitTurns : null,
    toolOk: hasToolData ? toolOk : null,
    toolError: hasToolData ? toolError : null,
    toolUnknown: hasToolData ? toolUnknown : null,
    toolStatusMissing: hasToolData ? toolStatusMissing : null,
    toolTimeoutTrue: hasToolData ? toolTimeoutTrue : null,
    toolTimeoutFalse: hasToolData ? toolTimeoutFalse : null,
    toolTimeoutMissing: hasToolData ? toolTimeoutMissing : null,
    toolMissingTiming: hasToolData ? toolMissingTiming : null,
    memoryHits: memoryHitsTurns === 0 ? null : memoryHits,
    memoryHitsTurns,
    memoryHitsMissing: turnsMissingMemoryHits,
    turnsMissingRequired,
    turnsMissingTurnDuration,
    turnsMissingFirstText,
    turnsMissingFirstAudio,
    turnsMissingToolCalls,
    turnsMissingMemoryHits,
  };
}

function latencyFor(records) {
  return {
    turnMs: latencyStats(records.map((record) => record.turnMs)),
    firstTextMs: latencyStats(records.map((record) => record.firstTextMs)),
    firstAudioMs: latencyStats(records.map((record) => record.firstAudioMs)),
    toolMs: latencyStats(records.map((record) => record.toolMs)),
    waitMs: latencyStats(records.map((record) => record.waitMs)),
    allToolMs: latencyStats(records.map((record) => record.allToolMs)),
  };
}

function groupLabel(lane, phase) {
  return `${lane ?? '未标注'}/${phase ?? '未标注'}`;
}

/**
 * p50/p95 只在同一个 lane×phase 组合内计算。未标注 lane/phase 的记录进入独立的
 * “未标注”桶，不并入 voice/typed 或 ack/body。
 */
function lanePhaseFor(records) {
  const buckets = new Map();
  const ensure = (lane, phase) => {
    const key = `${lane ?? 'null'}\u0000${phase ?? 'null'}`;
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = {
        lane,
        phase,
        key,
        label: groupLabel(lane, phase),
        records: [],
      };
      buckets.set(key, bucket);
    }
    return bucket;
  };
  for (const lane of LANE_VALUES) {
    for (const phase of PHASE_VALUES) ensure(lane, phase);
  }
  for (const record of records) {
    ensure(record.lane, record.phase).records.push(record);
  }
  const rows = [];
  for (const bucket of buckets.values()) {
    const samples = bucket.records.length;
    rows.push({
      lane: bucket.lane,
      phase: bucket.phase,
      label: bucket.label,
      samples,
      sufficient: samples >= MIN_GROUP_SAMPLES,
      note: samples >= MIN_GROUP_SAMPLES ? null : '样本不足（n<5）',
      latency: latencyFor(bucket.records),
      quality: qualityFor(bucket.records),
    });
  }
  // 固定顺序：voice/typed × ack/body 在前，未标注桶按首次出现追加。
  const order = (row) => {
    const laneIndex = row.lane === null ? 99 : LANE_VALUES.indexOf(row.lane);
    const phaseIndex = row.phase === null ? 99 : PHASE_VALUES.indexOf(row.phase);
    return laneIndex * 10 + phaseIndex;
  };
  rows.sort((left, right) => order(left) - order(right));
  const byLane = { voice: 0, typed: 0, unclassified: 0 };
  const byPhase = { ack: 0, body: 0, unclassified: 0 };
  for (const record of records) {
    if (record.lane === null) byLane.unclassified += 1;
    else byLane[record.lane] += 1;
    if (record.phase === null) byPhase.unclassified += 1;
    else byPhase[record.phase] += 1;
  }
  return { rows, byLane, byPhase };
}

function groupStats(records, { included = true, originCounts = null } = {}) {
  const lanePhase = lanePhaseFor(records);
  return {
    included,
    samples: records.length,
    inputSamples: records.length,
    originCounts,
    lanes: lanePhase.byLane,
    phases: lanePhase.byPhase,
    lanePhase: lanePhase.rows,
    latency: latencyFor(records),
    quality: qualityFor(records),
    insufficient: records.length < MIN_GROUP_SAMPLES,
    note: records.length < MIN_GROUP_SAMPLES ? '样本不足（n<5）' : null,
  };
}

function originCountsFor(records) {
  const counts = {
    assistant: 0,
    codingAgent: 0,
    unknown: 0,
    unknownExplicit: 0,
    unknownMissing: 0,
  };
  for (const record of records) {
    if (record.origin === 'assistant') counts.assistant += 1;
    else if (record.origin === 'coding-agent') counts.codingAgent += 1;
    else {
      counts.unknown += 1;
      if (record.originSource === null) counts.unknownMissing += 1;
      else counts.unknownExplicit += 1;
    }
  }
  counts.nonAssistant = counts.codingAgent + counts.unknown;
  counts.total = records.length;
  return counts;
}

function lanePhaseCountsFor(records) {
  const lanePhase = lanePhaseFor(records);
  return {
    rows: lanePhase.rows.map((row) => ({
      lane: row.lane,
      phase: row.phase,
      label: row.label,
      samples: row.samples,
      sufficient: row.sufficient,
      note: row.note,
      latency: null,
      quality: null,
    })),
    byLane: lanePhase.byLane,
    byPhase: lanePhase.byPhase,
  };
}

function scenarioIndex(template) {
  const byId = new Map();
  const byTitle = new Map();
  for (const scenario of template.scenarios) {
    byId.set(scenario.id, scenario.id);
    byTitle.set(scenario.title, scenario.id);
  }
  return { byId, byTitle };
}

function resolveScenarioId(value, index) {
  if (value === null) return null;
  return index.byId.get(value) ?? index.byTitle.get(value) ?? value;
}

function toIsoOrNull(value) {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/**
 * 汇总记录。模板场景永远保留（即使 0 样本）；模板外场景按首次出现顺序追加。
 * 不修改传入记录，只做场景 id 映射并复制。
 */
export function buildSummary({
  parsed = null,
  template = null,
  repeatOverride = null,
  source = {},
  variable = null,
  generatedAt = null,
  includeNonAssistant = false,
} = {}) {
  if (!isPlainObject(template) || !Array.isArray(template.scenarios)) {
    throw new Error('buildSummary requires a normalized scenario template');
  }
  if (repeatOverride !== null
    && (!Number.isInteger(repeatOverride) || repeatOverride < MIN_REPEAT || repeatOverride > MAX_REPEAT)) {
    throw new Error(`repeatOverride must be null or an integer from ${MIN_REPEAT} to ${MAX_REPEAT}`);
  }
  const records = Array.isArray(parsed?.records) ? parsed.records : [];
  const badLines = Array.isArray(parsed?.badLines) ? parsed.badLines : [];
  const blankLines = Number.isInteger(parsed?.blankLines) ? parsed.blankLines : 0;
  const totalLines = Number.isInteger(parsed?.totalLines) ? parsed.totalLines : 0;
  const include = includeNonAssistant === true;
  const originCounts = originCountsFor(records);
  const assistantRecords = records.filter((record) => record.origin === 'assistant');
  const nonAssistantInput = records.filter((record) => record.origin !== 'assistant');
  const index = scenarioIndex(template);
  const groups = new Map();

  for (const scenario of template.scenarios) {
    const expected = repeatOverride ?? scenario.repeat ?? template.repeat ?? 5;
    if (!Number.isInteger(expected) || expected < MIN_REPEAT || expected > MAX_REPEAT) {
      throw new Error(`scenario ${scenario.id ?? '(missing id)'} has an invalid target count`);
    }
    groups.set(scenario.id, {
      id: scenario.id,
      title: scenario.title ?? scenario.id,
      template: true,
      expected,
      meetsTarget: null,
      variableHint: scenario.variableHint,
      qualityFocus: scenario.qualityFocus,
      placeholders: scenario.placeholders,
      records: [],
    });
  }

  // 场景与覆盖目标只使用 assistant 记录；非助手样本永远不会补齐这些目标。
  for (const record of assistantRecords) {
    const id = resolveScenarioId(record.scenario, index);
    const key = id === null ? null : id;
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        id,
        title: id === null ? '缺少场景字段' : '未登记场景',
        template: false,
        expected: null,
        meetsTarget: null,
        variableHint: null,
        qualityFocus: null,
        placeholders: 0,
        records: [],
      };
      groups.set(key, group);
    }
    group.records.push({ ...record, scenario: id });
  }

  const scenarioSummaries = [];
  const unknownScenarios = [];
  let expectedTotal = 0;
  for (const group of groups.values()) {
    const samples = group.records.length;
    const meetsTarget = group.expected === null ? null : samples >= group.expected;
    if (group.expected !== null) expectedTotal += group.expected;
    if (!group.template) unknownScenarios.push(group.id);
    const lanePhase = lanePhaseFor(group.records);
    scenarioSummaries.push({
      id: group.id,
      title: group.title,
      template: group.template,
      expected: group.expected,
      samples,
      meetsTarget,
      variableHint: group.variableHint,
      qualityFocus: group.qualityFocus,
      placeholders: group.placeholders,
      lanePhase: lanePhase.rows,
      lanes: lanePhase.byLane,
      phases: lanePhase.byPhase,
      latency: latencyFor(group.records),
      quality: qualityFor(group.records),
      turns: group.records,
    });
  }

  const assistantGroup = groupStats(assistantRecords, {
    included: true,
    originCounts: originCountsFor(assistantRecords),
  });
  const nonAssistantCounts = originCountsFor(nonAssistantInput);
  const nonAssistantGroup = include
    ? groupStats(nonAssistantInput, { included: true, originCounts: nonAssistantCounts })
    : (() => {
      const counts = lanePhaseCountsFor(nonAssistantInput);
      return {
        included: false,
        samples: 0,
        inputSamples: nonAssistantInput.length,
        originCounts: nonAssistantCounts,
        lanes: counts.byLane,
        phases: counts.byPhase,
        lanePhase: counts.rows,
        latency: null,
        quality: null,
        insufficient: nonAssistantInput.length < MIN_GROUP_SAMPLES,
        note: nonAssistantInput.length > 0 ? '未纳入（需 --include-non-assistant）' : '无样本',
      };
    })();

  const allRecords = scenarioSummaries.flatMap((scenario) => scenario.turns);
  const unmet = scenarioSummaries
    .filter((scenario) => scenario.template && scenario.meetsTarget === false)
    .map((item) => ({
      id: item.id,
      expected: item.expected,
      samples: item.samples,
    }));
  const templateScenarios = template.scenarios.length;
  const allMet = unmet.length === 0;

  const warnings = [];
  if (records.length === 0) {
    warnings.push('输入没有有效轮次；分位数与缺失字段按 null 呈现，未补 0。');
  }
  if (assistantRecords.length === 0) {
    warnings.push('助手归属样本不足（n=0<5）：默认只统计 origin=assistant；缺失 / unknown 不算助手样本，也不用编码代理样本补齐。');
  } else if (assistantRecords.length < MIN_GROUP_SAMPLES) {
    warnings.push(`助手归属样本不足（n=${assistantRecords.length}<5）；p50/p95 只描述这些样本，不补造轮次。`);
  }
  if (!include && nonAssistantInput.length > 0) {
    warnings.push(
      `输入有 ${nonAssistantInput.length} 条非助手样本（coding-agent ${nonAssistantCounts.codingAgent} / unknown ${nonAssistantCounts.unknown}），`
      + '默认未纳入统计；只有 --include-non-assistant 才单独成组，绝不用于补齐 assistant 样本。',
    );
  }
  if (nonAssistantCounts.unknown > 0) {
    warnings.push(
      `有 ${nonAssistantCounts.unknown} 条样本归属为 unknown（其中缺失 origin ${nonAssistantCounts.unknownMissing} 条），均不算助手样本。`,
    );
  }
  if (badLines.length > 0) {
    warnings.push(`输入有 ${badLines.length} 行不是可解析的 JSON 对象，已跳过（行号见 source.badLines）。`);
  }
  if (unknownScenarios.length > 0) {
    warnings.push(`输入含模板外场景 ${unknownScenarios.map((id) => (id === null ? 'null' : id)).join(', ')}，已单独计数。`);
  }
  for (const item of unmet) {
    warnings.push(`场景 ${item.id} 样本 ${item.samples}/${item.expected}，未达模板占位目标；不补造轮次。`);
  }
  const missingFirstText = assistantRecords.filter((record) => record.firstTextMissing).length;
  if (missingFirstText > 0) {
    warnings.push(
      `firstTextAt: missing（assistant ${missingFirstText} 轮）：首正文时间只取实际正文流事件，`
      + '不从 assistantMessageAt 等整步提交倒推；相应首字分位为 null。',
    );
  }
  const missingFirstTextNonAssistant = nonAssistantInput.filter((record) => record.firstTextMissing).length;
  if (include && missingFirstTextNonAssistant > 0) {
    warnings.push(`firstTextAt: missing（non-assistant ${missingFirstTextNonAssistant} 轮）；同样不倒推整步提交时间。`);
  }
  const insufficientGroups = [];
  for (const group of [assistantGroup, ...(include ? [nonAssistantGroup] : [])]) {
    const groupName = group === assistantGroup ? 'assistant' : 'non-assistant';
    for (const row of group.lanePhase) {
      if (row.samples < MIN_GROUP_SAMPLES) {
        insufficientGroups.push(`${groupName} ${row.label} n=${row.samples}`);
      }
    }
  }
  if (insufficientGroups.length > 0) {
    warnings.push(`lane×phase 样本不足（n<5）：${insufficientGroups.join('；')}。`);
  }
  for (const [groupName, group] of [['assistant', assistantGroup], ['non-assistant', nonAssistantGroup]]) {
    if (group.included && (group.quality?.waitCalls ?? 0) > 0) {
      warnings.push(`${groupName} 组含 ${group.quality.waitCalls} 次主动等待工具，等待时间单列于 waits。`);
    }
  }

  return {
    schema: REPORT_SCHEMA,
    generatedAt: toIsoOrNull(generatedAt),
    source: {
      input: source.input ?? parsed?.input ?? null,
      scenarios: source.scenarios ?? null,
      lines: totalLines,
      nonEmptyLines: records.length + badLines.length,
      blankLines,
      records: records.length,
      badLines,
    },
    settings: {
      repeatOverride,
      templateDefaultRepeat: template.repeat ?? null,
      variable: textOrNull(variable),
      quantile: 'nearest-rank',
      includeNonAssistant: include,
      minGroupSamples: MIN_GROUP_SAMPLES,
    },
    notes: [...REPORT_NOTES],
    warnings,
    attribution: {
      mode: include ? 'include-non-assistant' : 'assistant-only',
      includeNonAssistant: include,
      counts: originCounts,
      assistantSamples: assistantRecords.length,
      nonAssistantInputSamples: nonAssistantInput.length,
      nonAssistantSamples: include ? nonAssistantInput.length : 0,
      nonAssistantExcluded: include ? 0 : nonAssistantInput.length,
    },
    groups: {
      assistant: assistantGroup,
      nonAssistant: nonAssistantGroup,
    },
    coverage: {
      allMet,
      metScenarios: templateScenarios - unmet.length,
      templateScenarios,
      expected: expectedTotal,
      samples: assistantRecords.length,
      includedSamples: assistantRecords.length + (include ? nonAssistantInput.length : 0),
      assistantSamples: assistantRecords.length,
      nonAssistantSamples: include ? nonAssistantInput.length : 0,
      nonAssistantExcluded: include ? 0 : nonAssistantInput.length,
      unmet,
    },
    totals: {
      scenarios: templateScenarios,
      groups: scenarioSummaries.length,
      samples: assistantRecords.length,
      includedSamples: assistantRecords.length + (include ? nonAssistantInput.length : 0),
      inputRecords: records.length,
      assistantSamples: assistantRecords.length,
      nonAssistantInputSamples: nonAssistantInput.length,
      nonAssistantSamples: include ? nonAssistantInput.length : 0,
      nonAssistantExcluded: include ? 0 : nonAssistantInput.length,
      expected: expectedTotal,
      badLines: badLines.length,
      blankLines,
      lines: totalLines,
      latency: assistantGroup.latency,
      quality: assistantGroup.quality,
    },
    scenarios: scenarioSummaries,
  };
}

function formatValue(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'null';
    return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
  }
  return String(value);
}

function cell(value) {
  const text = formatValue(value).replace(/\r?\n/gu, ' ');
  return text.replace(/\|/gu, '\\|');
}

function markdownRow(cells) {
  return `| ${cells.map(cell).join(' | ')} |`;
}

function scenarioLabel(scenario) {
  return scenario.id === null ? 'null' : scenario.id;
}

function metricRows(latency) {
  return [
    { label: '轮次耗时', stats: latency.turnMs },
    { label: '首字', stats: latency.firstTextMs },
    { label: '首音', stats: latency.firstAudioMs },
    { label: '普通工具并集', stats: latency.toolMs },
    { label: '等待并集', stats: latency.waitMs ?? latency.toolMs },
  ];
}

function groupStatus(group) {
  if (!group.included) return group.note ?? '未纳入';
  return group.insufficient ? '样本不足（n<5）' : '满足';
}

function rowStatus(row, included) {
  if (!included) return '未纳入';
  return row.sufficient === false || row.samples < MIN_GROUP_SAMPLES ? '样本不足（n<5）' : '满足';
}

function renderLanePhaseLatency(lines, groupName, lanePhase, included) {
  for (const row of lanePhase) {
    for (const metric of metricRows(row.latency)) {
      lines.push(markdownRow([
        groupName,
        row.lane ?? '未标注',
        row.phase ?? '未标注',
        metric.label,
        metric.stats.count,
        metric.stats.p50,
        metric.stats.p95,
        rowStatus(row, included),
      ]));
    }
  }
}

/** 生成 Markdown 报告；末尾嵌入同一份 JSON 摘要。 */
export function renderMarkdown(summary) {
  const lines = [];
  const assistantGroup = summary.groups?.assistant ?? null;
  const nonAssistantGroup = summary.groups?.nonAssistant ?? null;
  const originCounts = summary.attribution?.counts ?? {
    assistant: summary.totals?.assistantSamples ?? summary.totals?.samples ?? 0,
    codingAgent: 0,
    unknown: 0,
    unknownMissing: 0,
    nonAssistant: summary.totals?.nonAssistantInputSamples ?? 0,
    total: summary.totals?.inputRecords ?? summary.totals?.samples ?? 0,
  };
  const missingFirstText = (summary.scenarios ?? [])
    .flatMap((scenario) => scenario.turns ?? [])
    .filter((turn) => turn.firstTextAt == null).length;

  lines.push('# P-61 固定样本对照实验报告', '');
  lines.push('> 离线生成：只读本地 JSONL 并汇总；不调用模型、不发送真实请求、不生成样本。', '');
  lines.push('> **阅读口径（先读）**', '>');
  for (const note of summary.notes ?? []) lines.push(`> - ${note}`);
  lines.push('');
  lines.push(`- 生成时间：${formatValue(summary.generatedAt)}`);
  lines.push(`- 输入：${formatValue(summary.source.input)}（输入 ${originCounts.total} 轮 / assistant 纳入 ${summary.totals.samples} 轮 / non-assistant 纳入 ${summary.totals.nonAssistantSamples ?? 0} 轮 / 坏行 ${summary.totals.badLines} / 空行 ${summary.totals.blankLines} / 总行 ${summary.totals.lines}）`);
  lines.push(`- 场景模板：${formatValue(summary.source.scenarios)}（${summary.coverage.templateScenarios} 类）`);
  lines.push(`- 本次唯一变量：${formatValue(summary.settings.variable)}（未声明时为 null，不会自动推断）`);
  lines.push(`- 样本覆盖（仅 assistant）：${summary.coverage.metScenarios}/${summary.coverage.templateScenarios} 类达到目标；报告只汇总事实，不代表实验通过。`);
  lines.push(`- 样本归属：${summary.attribution?.mode ?? 'assistant-only'}；origin 分布 assistant ${originCounts.assistant} / coding-agent ${originCounts.codingAgent} / unknown ${originCounts.unknown}（缺失 origin ${originCounts.unknownMissing}）；非助手纳入 ${summary.attribution?.nonAssistantSamples ?? 0} 条、排除 ${summary.attribution?.nonAssistantExcluded ?? 0} 条。`);
  lines.push(`- 首字口径：firstTextAt 只取实际正文流时间（firstTextAt: missing ${missingFirstText} 轮）；不从 assistantMessageAt 等整步提交倒推。`);
  lines.push(`- 分组门槛：每个 lane×phase 少于 ${summary.settings?.minGroupSamples ?? MIN_GROUP_SAMPLES} 个样本时明确写“样本不足（n<5）”。`);
  lines.push('');

  lines.push('## 样本归属（两组）', '');
  lines.push('| 组 | origin | 输入条数 | 纳入统计 | coding-agent | unknown（缺失） | 说明 |');
  lines.push('| --- | --- | ---: | ---: | ---: | ---: | --- |');
  if (assistantGroup !== null) {
    const counts = assistantGroup.originCounts ?? {};
    lines.push(markdownRow([
      'assistant',
      'assistant',
      assistantGroup.inputSamples,
      assistantGroup.samples,
      counts.codingAgent ?? 0,
      `${counts.unknown ?? 0}（${counts.unknownMissing ?? 0}）`,
      '默认唯一统计组',
    ]));
  }
  if (nonAssistantGroup !== null) {
    const counts = nonAssistantGroup.originCounts ?? {};
    lines.push(markdownRow([
      'non-assistant',
      'coding-agent / unknown',
      nonAssistantGroup.inputSamples,
      nonAssistantGroup.samples,
      counts.codingAgent ?? 0,
      `${counts.unknown ?? 0}（${counts.unknownMissing ?? 0}）`,
      nonAssistantGroup.included ? '显式纳入，独立成组' : '未纳入（需 --include-non-assistant）',
    ]));
  }
  lines.push(markdownRow([
    '合计',
    '—',
    originCounts.total,
    summary.totals.includedSamples ?? (summary.totals.samples + (summary.totals.nonAssistantSamples ?? 0)),
    originCounts.codingAgent,
    `${originCounts.unknown}（${originCounts.unknownMissing}）`,
    '不混算',
  ]));
  lines.push('');
  lines.push(`- assistant：${groupStatus(assistantGroup ?? {
    included: true,
    samples: summary.totals.samples,
    insufficient: summary.totals.samples < MIN_GROUP_SAMPLES,
    note: summary.totals.samples < MIN_GROUP_SAMPLES ? '样本不足（n<5）' : null,
  })}`);
  if (nonAssistantGroup !== null) lines.push(`- non-assistant：${groupStatus(nonAssistantGroup)}`);
  lines.push('');

  lines.push('## lane × phase 样本数', '');
  lines.push('| 组 | lane | phase | n | 状态 |');
  lines.push('| --- | --- | --- | ---: | --- |');
  if (assistantGroup !== null) {
    for (const row of assistantGroup.lanePhase) {
      lines.push(markdownRow(['assistant', row.lane ?? '未标注', row.phase ?? '未标注', row.samples, rowStatus(row, true)]));
    }
  }
  if (nonAssistantGroup !== null) {
    for (const row of nonAssistantGroup.lanePhase) {
      lines.push(markdownRow([
        'non-assistant',
        row.lane ?? '未标注',
        row.phase ?? '未标注',
        row.samples,
        nonAssistantGroup.included ? rowStatus(row, true) : '未纳入',
      ]));
    }
  }
  lines.push('');

  lines.push('## 延迟分位（组 × lane × phase，ms，nearest-rank）', '');
  lines.push('| 组 | lane | phase | 指标 | n | p50 | p95 | 状态 |');
  lines.push('| --- | --- | --- | --- | ---: | ---: | ---: | --- |');
  if (assistantGroup !== null) renderLanePhaseLatency(lines, 'assistant', assistantGroup.lanePhase, true);
  if (nonAssistantGroup !== null && nonAssistantGroup.included) {
    renderLanePhaseLatency(lines, 'non-assistant', nonAssistantGroup.lanePhase, true);
  }
  lines.push('');

  lines.push('## 场景与样本数（仅 assistant）', '');
  lines.push('| 场景 | 说明 | 目标 | 样本 | 达成 |');
  lines.push('| --- | --- | ---: | ---: | --- |');
  for (const scenario of summary.scenarios) {
    lines.push(markdownRow([
      scenarioLabel(scenario),
      scenario.title,
      scenario.expected,
      scenario.samples,
      scenario.meetsTarget === null ? null : scenario.meetsTarget ? '是' : '否',
    ]));
  }
  lines.push(markdownRow([
    '合计',
    '—',
    summary.totals.expected,
    summary.totals.samples,
    summary.coverage.allMet ? '是' : '否',
  ]));
  lines.push('');

  lines.push('## 场景 × lane × phase 延迟分位（assistant，ms）', '');
  lines.push('| 场景 | lane | phase | 指标 | n | p50 | p95 | 状态 |');
  lines.push('| --- | --- | --- | --- | ---: | ---: | ---: | --- |');
  for (const scenario of summary.scenarios) {
    for (const row of scenario.lanePhase ?? []) {
      for (const metric of metricRows(row.latency)) {
        lines.push(markdownRow([
          scenarioLabel(scenario),
          row.lane ?? '未标注',
          row.phase ?? '未标注',
          metric.label,
          metric.stats.count,
          metric.stats.p50,
          metric.stats.p95,
          rowStatus(row, true),
        ]));
      }
    }
  }
  lines.push('');

  lines.push('## 质量列（仅 assistant）', '');
  lines.push('| 场景 | 中止（未知） | 工具 ok/错/未知/缺状态 | 超时 有/无/缺 | 普通/等待 | 工具缺时序 | 记忆命中（有值轮） | 缺 轮次/首字/首音 | 缺必需字段 | 缺工具数据 | 质量关注点 |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |');
  for (const scenario of summary.scenarios) {
    const quality = scenario.quality;
    lines.push(markdownRow([
      scenarioLabel(scenario),
      `${formatValue(quality.aborted)}（${quality.abortedUnknown}）`,
      `${formatValue(quality.toolOk)}/${formatValue(quality.toolError)}/${formatValue(quality.toolUnknown)}/${formatValue(quality.toolStatusMissing)}`,
      `${formatValue(quality.toolTimeoutTrue)}/${formatValue(quality.toolTimeoutFalse)}/${formatValue(quality.toolTimeoutMissing)}`,
      `${formatValue(quality.normalToolCalls)}/${formatValue(quality.waitCalls)}`,
      quality.toolMissingTiming,
      `${formatValue(quality.memoryHits)}（${quality.memoryHitsTurns}）`,
      `${quality.turnsMissingTurnDuration}/${quality.turnsMissingFirstText}/${quality.turnsMissingFirstAudio}`,
      quality.turnsMissingRequired,
      quality.turnsMissingToolCalls,
      scenario.qualityFocus,
    ]));
  }
  lines.push('');

  lines.push('## 逐轮明细（仅 assistant）', '');
  lines.push('| 场景 | 轮次 | origin | lane/phase | version | 轮次耗时 | 首字 | 首音 | 普通工具 | 等待 | 普通并集 | 等待并集 | 工具状态 ok/错/未知/缺 | 超时 有/无/缺 | 记忆 | 中止 | 缺失字段 |');
  lines.push('| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |');
  for (const scenario of summary.scenarios) {
    for (const turn of scenario.turns) {
      lines.push(markdownRow([
        scenarioLabel(scenario),
        turn.turn,
        turn.origin,
        `${turn.lane ?? '未标注'}/${turn.phase ?? '未标注'}`,
        turn.version,
        turn.turnMs,
        turn.firstTextAt == null ? 'null（firstTextAt: missing）' : turn.firstTextMs,
        turn.firstAudioMs,
        turn.normalToolCalls == null ? null : turn.normalToolCalls.length,
        turn.waits == null ? null : turn.waits.length,
        turn.toolMs,
        turn.waitMs,
        turn.toolStatus == null
          ? null
          : `${turn.toolStatus.ok}/${turn.toolStatus.error}/${turn.toolStatus.unknown}/${turn.toolStatus.missing}`,
        turn.toolTimeout == null
          ? null
          : `${turn.toolTimeout.true}/${turn.toolTimeout.false}/${turn.toolTimeout.missing}`,
        turn.memoryHits,
        turn.aborted,
        turn.missingFields.length === 0 ? '—' : turn.missingFields.join(', '),
      ]));
    }
  }
  lines.push('');

  lines.push('## JSON 摘要', '');
  lines.push('```json');
  lines.push(JSON.stringify(summary, null, 2));
  lines.push('```', '');
  return `${lines.join('\n')}\n`;
}

function sidecarJsonPath(markdownPath) {
  return /\.md$/iu.test(markdownPath) ? markdownPath.replace(/\.md$/iu, '.json') : `${markdownPath}.json`;
}

function isDirectInvocation() {
  if (typeof process.argv[1] !== 'string' || process.argv[1] === '') return false;
  const invoked = resolve(process.argv[1]);
  const self = resolve(SCRIPT_PATH);
  return process.platform === 'win32'
    ? invoked.toLowerCase() === self.toLowerCase()
    : invoked === self;
}

async function readStream(stream) {
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
    throw new Error('stdin is not readable');
  }
  let text = '';
  for await (const chunk of stream) text += String(chunk);
  return text;
}

export function parseArgs(argv = []) {
  const args = {
    input: null,
    out: null,
    json: null,
    repeat: null,
    scenarios: DEFAULT_SCENARIOS_PATH,
    variable: null,
    includeNonAssistant: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index]);
    const eq = token.startsWith('--') ? token.indexOf('=') : -1;
    const name = eq >= 0 ? token.slice(0, eq) : token;
    const inline = eq >= 0 ? token.slice(eq + 1) : null;
    const takeValue = (label) => {
      if (inline !== null) {
        if (inline === '') throw new Error(`${label} needs a value`);
        return inline;
      }
      const next = argv[index + 1];
      if (next === undefined || String(next).startsWith('--')) {
        throw new Error(`${label} needs a value`);
      }
      index += 1;
      return String(next);
    };
    switch (name) {
      case '--input':
        args.input = takeValue('--input');
        break;
      case '--out':
        args.out = takeValue('--out');
        break;
      case '--json':
        args.json = takeValue('--json');
        break;
      case '--repeat': {
        const raw = takeValue('--repeat');
        const repeat = Number(raw);
        if (!Number.isInteger(repeat) || repeat < MIN_REPEAT || repeat > MAX_REPEAT) {
          throw new Error(`--repeat must be an integer from ${MIN_REPEAT} to ${MAX_REPEAT}`);
        }
        args.repeat = repeat;
        break;
      }
      case '--scenarios':
        args.scenarios = takeValue('--scenarios');
        break;
      case '--variable':
        args.variable = takeValue('--variable');
        break;
      case '--include-non-assistant':
        if (inline !== null) {
          throw new Error('--include-non-assistant does not take a value');
        }
        args.includeNonAssistant = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        if (token.startsWith('-')) throw new Error(`unknown argument: ${token}`);
        throw new Error(`unexpected argument: ${token}`);
    }
  }
  return args;
}

/**
 * CLI 主体。依赖可注入，测试不需要真实模型、网络或仓库数据。
 *
 * @returns {Promise<number>} 退出码。
 */
export async function runFixedSample({
  argv = [],
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
  stdin = process.stdin,
  now = () => new Date(),
  readText = (filePath) => readFile(filePath, 'utf8'),
} = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    writeTo(stderr, `fixed-sample: ${error.message}\n`);
    writeTo(stderr, USAGE);
    return 2;
  }
  if (args.help) {
    writeTo(stdout, USAGE);
    return 0;
  }
  if (args.input === null) {
    writeTo(stderr, 'fixed-sample: --input is required (use --help for the input format)\n');
    return 2;
  }

  const markdownTarget = args.out === null || args.out === '-'
    ? '-'
    : resolve(cwd, args.out);
  let jsonTarget = null;
  if (args.json === '-') {
    jsonTarget = '-';
  } else if (args.json !== null) {
    jsonTarget = resolve(cwd, args.json);
  } else if (markdownTarget !== '-') {
    jsonTarget = sidecarJsonPath(markdownTarget);
  }
  if (jsonTarget === '-' && markdownTarget === '-') {
    writeTo(stderr, 'fixed-sample: --json - needs --out <file>; Markdown already uses stdout\n');
    return 2;
  }
  if (jsonTarget !== null && jsonTarget !== '-' && jsonTarget === markdownTarget) {
    writeTo(stderr, 'fixed-sample: --json must not overwrite the Markdown report\n');
    return 2;
  }

  const scenariosPath = resolve(cwd, args.scenarios);
  let template;
  try {
    template = await loadScenarioTemplate(scenariosPath, { readText });
  } catch (error) {
    writeTo(stderr, `fixed-sample: cannot read scenario template ${scenariosPath}: ${describeError(error)}\n`);
    return 1;
  }

  const inputLabel = args.input === '-' ? '<stdin>' : args.input;
  let inputText;
  try {
    inputText = args.input === '-'
      ? await readStream(stdin)
      : await readText(resolve(cwd, args.input));
  } catch (error) {
    writeTo(stderr, `fixed-sample: cannot read input ${inputLabel}: ${describeError(error)}\n`);
    return 1;
  }

  const parsed = parseInputText(inputText, { input: inputLabel });
  let generatedAt = null;
  try {
    generatedAt = now();
  } catch {
    generatedAt = null;
  }
  const summary = buildSummary({
    parsed,
    template,
    repeatOverride: args.repeat,
    source: {
      input: inputLabel,
      scenarios: args.scenarios,
    },
    variable: args.variable,
    generatedAt,
    includeNonAssistant: args.includeNonAssistant,
  });
  const markdown = renderMarkdown(summary);
  const json = `${JSON.stringify(summary, null, 2)}\n`;

  if (markdownTarget === '-') {
    writeTo(stdout, markdown);
  } else {
    try {
      await mkdir(dirname(markdownTarget), { recursive: true });
      await writeFile(markdownTarget, markdown, 'utf8');
    } catch (error) {
      writeTo(stderr, `fixed-sample: cannot write ${markdownTarget}: ${describeError(error)}\n`);
      return 1;
    }
    writeTo(stderr, `fixed-sample: wrote ${markdownTarget}\n`);
  }

  if (jsonTarget === '-') {
    writeTo(stdout, json);
  } else if (jsonTarget !== null) {
    try {
      await mkdir(dirname(jsonTarget), { recursive: true });
      await writeFile(jsonTarget, json, 'utf8');
    } catch (error) {
      writeTo(stderr, `fixed-sample: cannot write ${jsonTarget}: ${describeError(error)}\n`);
      return 1;
    }
    writeTo(stderr, `fixed-sample: wrote ${jsonTarget}\n`);
  }

  writeTo(stderr, `fixed-sample: assistant ${summary.totals.assistantSamples} samples, `
    + `non-assistant ${summary.totals.nonAssistantSamples} included / `
    + `${summary.totals.nonAssistantExcluded} excluded, ${summary.totals.badLines} bad lines, `
    + `${summary.coverage.metScenarios}/${summary.coverage.templateScenarios} scenarios met target\n`);
  for (const warning of summary.warnings) writeTo(stderr, `fixed-sample: warning: ${warning}\n`);
  return 0;
}

if (isDirectInvocation()) {
  runFixedSample({ argv: process.argv.slice(2) })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`fixed-sample: unexpected failure: ${error?.stack ?? error}`);
      process.exitCode = 1;
    });
}
