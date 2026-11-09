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
 *     "startedAt": "2026-11-09T14:00:00+08:00", // 必填；ISO 8601
 *     "endedAt": "2026-11-09T14:00:02+08:00",   // 必填；ISO 8601
 *     "firstTextAt": "...",                     // 可选；首字到达时间
 *     "firstAudioAt": "...",                    // 可选；首音到达时间
 *     "toolCalls": [                            // 可选；缺失写 null，不补 []
 *       { "name": "read", "start": "...", "end": "...", "status": "ok" }
 *     ],
 *     "memoryHits": 2,                          // 可选；数字或数组（数组取长度）
 *     "aborted": false                          // 可选；布尔值
 *   }
 *
 * 统计口径：
 *   - 五类场景的目标次数来自模板 repeat（默认每类 5），`--repeat` 可覆盖。
 *   - 缺失 / 无法解析的字段在报告里一律写 `null`，**不补 0**。
 *   - 轮次耗时 = endedAt - startedAt；首字 / 首音 = 对应时间 - startedAt。
 *   - 工具耗时按同一轮内所有工具区间的**并集**计算，重叠区间只算一次。
 *   - p50 / p95 使用 nearest-rank；没有有效样本时为 `null`。
 *   - 报告只描述本批固定样本；样本非随机，不承诺任何性能收益。
 *   - 一次只改一个变量：每份报告只应记录一个变量变更，报告头会再次提示。
 *
 * 用法：
 *   node tools/fixed-sample.mjs --input sample.jsonl
 *   node tools/fixed-sample.mjs --input sample.jsonl --out report.md --variable "回复长度"
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

const REQUIRED_FIELDS = ['scenario', 'turn', 'startedAt', 'endedAt'];
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
  '缺失字段一律写 null，不补 0；无法解析的时间同样写 null，不静默钳到 0。',
  '并行工具耗时按区间并集计算，重叠部分只计一次；跨越轮次边界的工具区间不做裁剪。',
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
    startedAt     必填；ISO 8601 时间
    endedAt       必填；ISO 8601 时间
    firstTextAt   可选；首字到达时间
    firstAudioAt  可选；首音到达时间
    toolCalls     可选；[{name,start,end,status}]，缺失写 null（不补 []）
    memoryHits    可选；数字或数组（数组取长度）
    aborted       可选；布尔值
  缺失或无法解析的字段在报告中写 null，不补 0；工具耗时用区间并集。
  示例:
    {"scenario":"chat","turn":1,"startedAt":"2026-11-09T14:00:00+08:00","endedAt":"2026-11-09T14:00:02+08:00","firstTextAt":"2026-11-09T14:00:00.900+08:00","firstAudioAt":"2026-11-09T14:00:01.500+08:00","toolCalls":[],"memoryHits":1,"aborted":false}

选项:
  --input <file>       必填；'-' 表示从 stdin 读取
  --out <file>         写 Markdown 报告；省略或 '-' 写 stdout
  --json <file>        写纯 JSON 摘要；省略时若 --out 是文件则写同名 .json
  --repeat <n>         覆盖模板每类占位次数（${MIN_REPEAT}–${MAX_REPEAT}；模板默认 5）
  --scenarios <file>   场景模板，默认 tools/fixtures/fixed-sample-scenarios.json
  --variable <text>    本次唯一变量（只写入报告元数据，不改变样本）
  -h, --help           显示本帮助

输出:
  Markdown（场景 / 样本数 / 逐轮明细 / p50/p95 / 质量列）并附 JSON 摘要；
  --json 可另存一份纯 JSON。报告会再次强调样本非随机、不承诺性能收益、
  一次只改一个变量。

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
  const text = typeof status === 'string' ? status.trim().toLowerCase() : '';
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
  const calls = [];
  const intervals = [];
  let ok = 0;
  let error = 0;
  let unknown = 0;
  for (const rawCall of rawCalls) {
    const call = isPlainObject(rawCall) ? rawCall : {};
    const name = labelOrNull(call.name);
    const start = readTimestamp(call.start);
    const end = readTimestamp(call.end);
    const durationMs = start.ms !== null && end.ms !== null && end.ms >= start.ms
      ? end.ms - start.ms
      : null;
    const status = readStatus(call.status);
    const statusClass = classifyToolStatus(status);
    if (statusClass === 'ok') ok += 1;
    else if (statusClass === 'error') error += 1;
    else unknown += 1;
    calls.push({
      name,
      start: start.text,
      end: end.text,
      status,
      durationMs,
    });
    if (durationMs !== null) intervals.push({ start: start.ms, end: end.ms });
  }
  let toolMs = null;
  if (calls.length === 0) toolMs = 0;
  else if (intervals.length > 0) toolMs = unionIntervalsMs(intervals);
  return {
    calls,
    toolMs,
    toolStatus: { ok, error, unknown },
    toolMissingTiming: calls.length - intervals.length,
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
  const started = readTimestamp(source.startedAt);
  const ended = readTimestamp(source.endedAt);
  const firstText = readTimestamp(source.firstTextAt);
  const firstAudio = readTimestamp(source.firstAudioAt);

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
  let toolMs = null;
  let toolStatus = null;
  let toolMissingTiming = null;
  if (Array.isArray(source.toolCalls)) {
    const normalized = normalizeToolCalls(source.toolCalls);
    toolCalls = normalized.calls;
    toolMs = normalized.toolMs;
    toolStatus = normalized.toolStatus;
    toolMissingTiming = normalized.toolMissingTiming;
  }

  const memoryHits = readMemoryHits(source.memoryHits);
  const aborted = typeof source.aborted === 'boolean' ? source.aborted : null;

  const missingFields = [];
  if (scenario === null) missingFields.push('scenario');
  if (turn === null) missingFields.push('turn');
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
    startedAt: started.text,
    endedAt: ended.text,
    firstTextAt: firstText.text,
    firstAudioAt: firstAudio.text,
    turnMs,
    firstTextMs,
    firstAudioMs,
    toolCalls,
    toolMs,
    toolStatus,
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
  let toolOk = 0;
  let toolError = 0;
  let toolUnknown = 0;
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
      if (record.toolStatus !== null) {
        toolOk += record.toolStatus.ok;
        toolError += record.toolStatus.error;
        toolUnknown += record.toolStatus.unknown;
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

  return {
    aborted,
    abortedUnknown,
    toolCallTurns,
    toolCalls: toolCallTurns === 0 ? null : toolCalls,
    toolOk: toolCallTurns === 0 ? null : toolOk,
    toolError: toolCallTurns === 0 ? null : toolError,
    toolUnknown: toolCallTurns === 0 ? null : toolUnknown,
    toolMissingTiming: toolCallTurns === 0 ? null : toolMissingTiming,
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

  for (const record of records) {
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
      latency: latencyFor(group.records),
      quality: qualityFor(group.records),
      turns: group.records,
    });
  }

  const allRecords = scenarioSummaries.flatMap((scenario) => scenario.turns);
  const unmet = scenarioSummaries
    .filter((scenario) => scenario.template && scenario.meetsTarget === false)
    .map((scenario) => ({
      id: scenario.id,
      expected: scenario.expected,
      samples: scenario.samples,
    }));
  const templateScenarios = template.scenarios.length;
  const allMet = unmet.length === 0;

  const warnings = [];
  if (!allRecords.length) {
    warnings.push('输入没有有效轮次；分位数与缺失字段按 null 呈现，未补 0。');
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
    },
    notes: [...REPORT_NOTES],
    warnings,
    coverage: {
      allMet,
      metScenarios: templateScenarios - unmet.length,
      templateScenarios,
      expected: expectedTotal,
      samples: allRecords.length,
      unmet,
    },
    totals: {
      scenarios: templateScenarios,
      groups: scenarioSummaries.length,
      samples: allRecords.length,
      expected: expectedTotal,
      badLines: badLines.length,
      blankLines,
      lines: totalLines,
      latency: latencyFor(allRecords),
      quality: qualityFor(allRecords),
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

function metricRows(scenario) {
  return [
    { label: '轮次耗时', stats: scenario.latency.turnMs },
    { label: '首字', stats: scenario.latency.firstTextMs },
    { label: '首音', stats: scenario.latency.firstAudioMs },
    { label: '工具并集', stats: scenario.latency.toolMs },
  ];
}

/** 生成 Markdown 报告；末尾嵌入同一份 JSON 摘要。 */
export function renderMarkdown(summary) {
  const lines = [];
  lines.push('# P-61 固定样本对照实验报告', '');
  lines.push('> 离线生成：只读本地 JSONL 并汇总；不调用模型、不发送真实请求、不生成样本。', '');
  lines.push('> **阅读口径（先读）**', '>');
  for (const note of summary.notes ?? []) lines.push(`> - ${note}`);
  lines.push('');
  lines.push(`- 生成时间：${formatValue(summary.generatedAt)}`);
  lines.push(`- 输入：${formatValue(summary.source.input)}（有效 ${summary.totals.samples} 轮 / 坏行 ${summary.totals.badLines} / 空行 ${summary.totals.blankLines} / 总行 ${summary.totals.lines}）`);
  lines.push(`- 场景模板：${formatValue(summary.source.scenarios)}（${summary.coverage.templateScenarios} 类）`);
  lines.push(`- 本次唯一变量：${formatValue(summary.settings.variable)}（未声明时为 null，不会自动推断）`);
  lines.push(`- 样本覆盖：${summary.coverage.metScenarios}/${summary.coverage.templateScenarios} 类达到目标；报告只汇总事实，不代表实验通过。`);
  lines.push('');

  lines.push('## 场景与样本数', '');
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

  lines.push('## 延迟分位（ms，nearest-rank）', '');
  lines.push('| 场景 | 指标 | n | p50 | p95 |');
  lines.push('| --- | --- | ---: | ---: | ---: |');
  for (const scenario of summary.scenarios) {
    for (const row of metricRows(scenario)) {
      lines.push(markdownRow([
        scenarioLabel(scenario),
        row.label,
        row.stats.count,
        row.stats.p50,
        row.stats.p95,
      ]));
    }
  }
  lines.push('');

  lines.push('## 质量列', '');
  lines.push('| 场景 | 中止（未知） | 工具 ok/错/未知 | 工具缺时序 | 记忆命中（有值轮） | 缺 轮次/首字/首音 | 缺必需字段 | 缺工具数据 | 质量关注点 |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |');
  for (const scenario of summary.scenarios) {
    const quality = scenario.quality;
    lines.push(markdownRow([
      scenarioLabel(scenario),
      `${formatValue(quality.aborted)}（${quality.abortedUnknown}）`,
      `${formatValue(quality.toolOk)}/${formatValue(quality.toolError)}/${formatValue(quality.toolUnknown)}`,
      quality.toolMissingTiming,
      `${formatValue(quality.memoryHits)}（${quality.memoryHitsTurns}）`,
      `${quality.turnsMissingTurnDuration}/${quality.turnsMissingFirstText}/${quality.turnsMissingFirstAudio}`,
      quality.turnsMissingRequired,
      quality.turnsMissingToolCalls,
      scenario.qualityFocus,
    ]));
  }
  lines.push('');

  lines.push('## 逐轮明细', '');
  lines.push('| 场景 | 轮次 | 轮次耗时 | 首字 | 首音 | 工具数 | 工具并集 | 工具 ok/错/未知 | 记忆 | 中止 | 缺失字段 |');
  lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |');
  for (const scenario of summary.scenarios) {
    for (const turn of scenario.turns) {
      lines.push(markdownRow([
        scenarioLabel(scenario),
        turn.turn,
        turn.turnMs,
        turn.firstTextMs,
        turn.firstAudioMs,
        turn.toolCalls === null ? null : turn.toolCalls.length,
        turn.toolMs,
        turn.toolStatus === null ? null : `${turn.toolStatus.ok}/${turn.toolStatus.error}/${turn.toolStatus.unknown}`,
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

  writeTo(stderr, `fixed-sample: ${summary.totals.samples} samples, ${summary.totals.badLines} bad lines, `
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
