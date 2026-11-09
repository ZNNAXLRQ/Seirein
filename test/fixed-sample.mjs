/**
 * P-61 固定样本报告工具：归属过滤、lane×phase、首正文口径、工具状态/等待、
 * 解析、分位、并行并集、坏行与 CLI。
 *
 * 全部测试使用内存数据或系统临时目录；不调用模型、不发送真实请求、
 * 不读取仓库运行数据、不生成真实样本。
 *
 * Run: node --test test/fixed-sample.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_SCENARIOS_PATH,
  MIN_GROUP_SAMPLES,
  buildSummary,
  latencyStats,
  loadScenarioTemplate,
  normalizeRecord,
  parseArgs,
  parseInputText,
  parseScenarioTemplate,
  percentile,
  renderMarkdown,
  runFixedSample,
  unionIntervalsMs,
} from '../tools/fixed-sample.mjs';

const AT = '2026-11-09T17:00:00+08:00';
const AT_ISO = '2026-11-09T09:00:00.000Z';

function capture() {
  const chunks = [];
  return {
    chunks,
    write(chunk) {
      chunks.push(String(chunk));
    },
    get text() {
      return chunks.join('');
    },
  };
}

function jsonLine(value) {
  return JSON.stringify(value);
}

function chatLine(overrides = {}) {
  return {
    scenario: 'chat',
    turn: 1,
    origin: 'assistant',
    lane: 'voice',
    phase: 'body',
    version: 'v1',
    startedAt: '2026-11-09T14:00:00+08:00',
    endedAt: '2026-11-09T14:00:02+08:00',
    firstTextAt: '2026-11-09T14:00:00.900+08:00',
    firstAudioAt: '2026-11-09T14:00:01.500+08:00',
    toolCalls: [],
    memoryHits: 2,
    aborted: false,
    ...overrides,
  };
}

function toolsLine(overrides = {}) {
  return {
    scenario: 'tools',
    turn: 2,
    origin: 'assistant',
    lane: 'voice',
    phase: 'ack',
    version: 'v1',
    startedAt: '2026-11-09T14:01:00+08:00',
    endedAt: '2026-11-09T14:01:03+08:00',
    firstTextAt: '2026-11-09T14:01:00.500+08:00',
    firstAudioAt: '2026-11-09T14:01:01.000+08:00',
    toolCalls: [
      {
        name: 'read',
        start: '2026-11-09T14:01:00.100+08:00',
        end: '2026-11-09T14:01:01.100+08:00',
        status: 'ok',
        timeout: false,
      },
      {
        name: 'search',
        start: '2026-11-09T14:01:00.600+08:00',
        end: '2026-11-09T14:01:01.600+08:00',
        status: 'ok',
        timeout: false,
      },
    ],
    memoryHits: [1, 2],
    aborted: true,
    ...overrides,
  };
}

function scenarioTemplate(overrides = {}) {
  return parseScenarioTemplate({
    repeat: 5,
    scenarios: [
      { id: 'chat', title: '无工具短闲聊', repeat: 5 },
      { id: 'tools', title: '多步骤工具请求', repeat: 5 },
    ],
    ...overrides,
  });
}

function groupRow(group, lane, phase) {
  return group.lanePhase.find((row) => row.lane === lane && row.phase === phase);
}

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'fixed-sample-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 1) 解析、归属与缺失字段
// ---------------------------------------------------------------------------

test('解析：有效行、空行、坏 JSON、非对象行都按行号统计，后续行继续解析', () => {
  const text = [
    `\uFEFF${jsonLine(chatLine())}`,
    '',
    jsonLine(toolsLine()),
    '{bad json',
    '[1,2]',
  ].join('\r\n');
  const parsed = parseInputText(text, { input: 'sample.jsonl' });
  assert.equal(parsed.input, 'sample.jsonl');
  assert.equal(parsed.records.length, 2);
  assert.deepEqual(parsed.badLines.map((entry) => entry.line), [4, 5]);
  assert.match(parsed.badLines[0].message, /invalid JSON/u);
  assert.match(parsed.badLines[1].message, /not a JSON object/u);
  assert.equal(parsed.blankLines, 1);
  assert.equal(parsed.totalLines, 5);
  assert.equal(parsed.nonEmptyLines, 4);

  const first = parsed.records[0];
  assert.equal(first.origin, 'assistant');
  assert.equal(first.originSource, 'origin');
  assert.equal(first.lane, 'voice');
  assert.equal(first.phase, 'body');
  assert.equal(first.version, 'v1');
  assert.equal(first.turnMs, 2000);
  assert.equal(first.firstTextMs, 900);
  assert.equal(first.firstAudioMs, 1500);
  assert.equal(first.firstTextMissing, false);
  assert.equal(first.toolMs, 0, '空工具数组合法地产生 0，不是缺字段');
  assert.equal(first.waitMs, 0);
  assert.deepEqual(first.toolStatus, { ok: 0, error: 0, unknown: 0, missing: 0 });
  assert.deepEqual(first.toolTimeout, { true: 0, false: 0, missing: 0 });
  assert.deepEqual(first.waits, []);
  assert.equal(first.toolMissingTiming, 0);
  assert.equal(first.memoryHits, 2);

  const second = parsed.records[1];
  assert.equal(second.toolMs, 1500, '并行工具 [0.1,1.1] 与 [0.6,1.6] 的并集是 1.5 s');
  assert.deepEqual(second.toolStatus, { ok: 2, error: 0, unknown: 0, missing: 0 });
  assert.equal(second.toolMissingTiming, 0);
  assert.equal(second.memoryHits, 2);
  assert.equal(second.aborted, true);
  assert.deepEqual(second.waits, []);
});

test('归属：origin 优先，sessionKind 回退，缺失/unknown 不算助手；lane/phase/version 规范化', () => {
  const explicit = parseInputText(jsonLine(chatLine({ origin: 'coding-agent' }))).records[0];
  assert.equal(explicit.origin, 'coding-agent');
  assert.equal(explicit.originSource, 'origin');
  assert.ok(!explicit.missingFields.includes('origin'));

  const { origin: _origin, ...withoutOrigin } = chatLine();
  const fallback = parseInputText(jsonLine({ ...withoutOrigin, sessionKind: 'coding-agent' })).records[0];
  assert.equal(fallback.origin, 'coding-agent');
  assert.equal(fallback.originSource, 'sessionKind');
  assert.ok(!fallback.missingFields.includes('origin'));

  const fallbackAssistant = parseInputText(jsonLine({ ...withoutOrigin, sessionKind: 'assistant' })).records[0];
  assert.equal(fallbackAssistant.origin, 'assistant');
  assert.equal(fallbackAssistant.originSource, 'sessionKind');

  const unknown = parseInputText(jsonLine(chatLine({ origin: 'unknown' }))).records[0];
  assert.equal(unknown.origin, 'unknown');
  assert.equal(unknown.originSource, 'origin');

  const missing = parseInputText(jsonLine(withoutOrigin)).records[0];
  assert.equal(missing.origin, 'unknown');
  assert.equal(missing.originSource, null);
  assert.ok(missing.missingFields.includes('origin'));

  const custom = parseInputText(jsonLine(chatLine({
    lane: 'typed',
    phase: 'ack',
    version: 'v2',
  }))).records[0];
  assert.equal(custom.lane, 'typed');
  assert.equal(custom.phase, 'ack');
  assert.equal(custom.version, 'v2');

  const unclassified = parseInputText(jsonLine(chatLine({ lane: 'other', phase: 'other' }))).records[0];
  assert.equal(unclassified.lane, null);
  assert.equal(unclassified.phase, null);
  assert.ok(unclassified.missingFields.includes('lane'));
  assert.ok(unclassified.missingFields.includes('phase'));
});

test('缺失字段：写 null，不补 0；工具字段缺失与合法空数组可区分', () => {
  const [record] = parseInputText(jsonLine({ scenario: 'chat' })).records;
  assert.equal(record.turn, null);
  assert.equal(record.origin, 'unknown');
  assert.equal(record.originSource, null);
  assert.equal(record.lane, null);
  assert.equal(record.phase, null);
  assert.equal(record.version, null);
  assert.equal(record.startedAt, null);
  assert.equal(record.endedAt, null);
  assert.equal(record.turnMs, null);
  assert.equal(record.firstTextAt, null);
  assert.equal(record.firstTextMs, null);
  assert.equal(record.firstAudioMs, null);
  assert.equal(record.toolCalls, null);
  assert.equal(record.allToolCalls, null);
  assert.equal(record.normalToolCalls, null);
  assert.equal(record.waits, null);
  assert.equal(record.toolMs, null);
  assert.equal(record.waitMs, null);
  assert.equal(record.toolStatus, null);
  assert.equal(record.toolTimeout, null);
  assert.equal(record.toolMissingTiming, null);
  assert.equal(record.memoryHits, null);
  assert.equal(record.aborted, null);
  assert.deepEqual(record.missingFields, [
    'turn',
    'origin',
    'lane',
    'phase',
    'startedAt',
    'endedAt',
    'firstTextAt',
    'firstAudioAt',
    'toolCalls',
    'memoryHits',
    'aborted',
  ]);

  const [empty] = parseInputText('{}').records;
  assert.deepEqual(empty.missingFields, [
    'scenario',
    'turn',
    'origin',
    'lane',
    'phase',
    'startedAt',
    'endedAt',
    'firstTextAt',
    'firstAudioAt',
    'toolCalls',
    'memoryHits',
    'aborted',
  ]);
});

test('首正文：只有 assistantMessageAt 时 firstTextAt 保持 null，不倒推', () => {
  const { firstTextAt: _firstTextAt, ...withoutFirstText } = chatLine();
  const [record] = parseInputText(jsonLine({
    ...withoutFirstText,
    assistantMessageAt: '2026-11-09T14:00:02+08:00',
  })).records;
  assert.equal(record.assistantMessageAt, '2026-11-09T14:00:02+08:00');
  assert.equal(record.firstTextAt, null);
  assert.equal(record.firstTextMs, null);
  assert.equal(record.firstTextMissing, true);
  assert.equal(record.firstTextSource, null);
  assert.ok(record.missingFields.includes('firstTextAt'));
});

test('非法时间与结束早于开始：相应耗时写 null，不钳到 0', () => {
  const [record] = parseInputText(jsonLine(chatLine({
    startedAt: 'not-a-date',
    endedAt: '2026-11-09T14:00:02+08:00',
    firstTextAt: '2026-11-09T14:00:01+08:00',
  }))).records;
  assert.equal(record.startedAt, null);
  assert.equal(record.turnMs, null);
  assert.equal(record.firstTextMs, null);
  assert.equal(record.firstAudioMs, null);
  assert.ok(record.missingFields.includes('startedAt'));

  const [reversed] = parseInputText(jsonLine(chatLine({
    startedAt: '2026-11-09T14:00:02+08:00',
    endedAt: '2026-11-09T14:00:00+08:00',
  }))).records;
  assert.equal(reversed.turnMs, null);
  assert.equal(reversed.firstTextMs, null);
  assert.equal(reversed.firstAudioMs, null);

  const normalized = normalizeRecord({ scenario: 'chat', turn: 1 }, 9);
  assert.equal(normalized.line, 9);
  assert.equal(normalized.turnMs, null);
});

// ---------------------------------------------------------------------------
// 2) 工具状态、超时、等待与区间并集
// ---------------------------------------------------------------------------

test('工具 status/timeout：实际有才记，缺失写 null；长耗时/状态 timeout 都不推定 timeout', () => {
  const [record] = parseInputText(jsonLine(chatLine({
    toolCalls: [
      {
        name: 'read',
        start: '2026-11-09T14:00:00.100+08:00',
        end: '2026-11-09T14:00:01.100+08:00',
      },
      {
        name: 'slow',
        start: '2026-11-09T14:00:00.200+08:00',
        end: '2026-11-09T14:00:01.900+08:00',
        status: 'timeout',
      },
      {
        name: 'explicit',
        start: '2026-11-09T14:00:00.300+08:00',
        end: '2026-11-09T14:00:00.400+08:00',
        status: 'ok',
        timeout: false,
      },
    ],
  }))).records;
  assert.equal(record.toolCalls[0].status, null);
  assert.equal(record.toolCalls[0].timeout, null);
  assert.equal(record.toolCalls[1].status, 'timeout');
  assert.equal(record.toolCalls[1].timeout, null, '状态文本不能反推 timeout 字段');
  assert.equal(record.toolCalls[1].durationMs, 1700);
  assert.equal(record.toolCalls[2].timeout, false);
  assert.deepEqual(record.toolStatus, { ok: 1, error: 1, unknown: 0, missing: 1 });
  assert.deepEqual(record.toolTimeout, { true: 0, false: 1, missing: 2 });
});

test('等待工具：job_output / wait_agent 单列 waits，普通工具与等待分别算并集', () => {
  const [record] = parseInputText(jsonLine(chatLine({
    toolCalls: [
      {
        name: 'read',
        start: '2026-11-09T14:00:00.100+08:00',
        end: '2026-11-09T14:00:00.600+08:00',
        status: 'ok',
      },
      {
        name: 'search',
        start: '2026-11-09T14:00:00.400+08:00',
        end: '2026-11-09T14:00:01.000+08:00',
        status: 'ok',
      },
      {
        name: 'job_output',
        start: '2026-11-09T14:00:01.000+08:00',
        end: '2026-11-09T14:00:03.000+08:00',
        status: 'ok',
      },
      {
        name: 'wait_agent',
        start: '2026-11-09T14:00:02.000+08:00',
        end: '2026-11-09T14:00:04.000+08:00',
      },
    ],
  }))).records;
  assert.deepEqual(record.waits.map((call) => call.name), ['job_output', 'wait_agent']);
  assert.equal(record.waits[1].status, null);
  assert.equal(record.waits[1].timeout, null);
  assert.equal(record.toolCalls.length, 2, '工具集合只放普通工具');
  assert.equal(record.normalToolCalls.length, 2);
  assert.equal(record.allToolCalls.length, 4, '全部调用仍可追溯');
  assert.equal(record.toolMs, 900, '普通工具并集 0.1–1.0 s');
  assert.equal(record.waitMs, 3000, '等待工具并集 1.0–4.0 s');
  assert.equal(record.allToolMs, 3900, '全部工具并集 0.1–4.0 s');
  assert.equal(record.toolMissingTiming, 0);
});

test('工具区间并集：重叠只算一次，相接、包含与分离都正确', () => {
  assert.equal(unionIntervalsMs([]), 0);
  assert.equal(unionIntervalsMs([{ start: 0, end: 100 }, { start: 50, end: 150 }]), 150);
  assert.equal(unionIntervalsMs([{ start: 0, end: 100 }, { start: 20, end: 40 }]), 100);
  assert.equal(unionIntervalsMs([{ start: 0, end: 100 }, { start: 100, end: 200 }]), 200);
  assert.equal(unionIntervalsMs([{ start: 0, end: 100 }, { start: 200, end: 300 }]), 200);
  assert.equal(unionIntervalsMs([{ start: 10, end: 5 }, { start: Number.NaN, end: 4 }]), 0);
});

test('p50/p95：nearest-rank，空样本为 null，忽略非数字', () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([null, undefined, Number.NaN], 0.5), null);
  assert.equal(percentile([10, 20, 30, 40, 50], 0.5), 30);
  assert.equal(percentile([10, 20, 30, 40, 50], 0.95), 50);
  assert.equal(percentile([50, 10, 20], 0.5), 20);
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2);
  assert.equal(percentile([1, 2, 3, 4], 0.95), 4);
  assert.equal(percentile([null, Number.NaN, 5, 6], 0.5), 5);
  assert.deepEqual(latencyStats([100, 200, 300]), { p50: 200, p95: 300, count: 3 });
  assert.deepEqual(latencyStats([null, undefined]), { p50: null, p95: null, count: 0 });
});

// ---------------------------------------------------------------------------
// 3) 归属过滤、lane×phase、场景与报告
// ---------------------------------------------------------------------------

function mixedLines() {
  return [
    jsonLine(chatLine({ turn: 1, lane: 'voice', phase: 'ack', startedAt: '2026-11-09T14:00:00+08:00', endedAt: '2026-11-09T14:00:01+08:00', firstTextAt: '2026-11-09T14:00:00.100+08:00' })),
    jsonLine(chatLine({ turn: 2, lane: 'voice', phase: 'body', startedAt: '2026-11-09T14:00:00+08:00', endedAt: '2026-11-09T14:00:03+08:00', firstTextAt: '2026-11-09T14:00:00.900+08:00' })),
    jsonLine(chatLine({
      turn: 3,
      lane: 'typed',
      phase: 'body',
      startedAt: '2026-11-09T14:00:00+08:00',
      endedAt: '2026-11-09T14:00:02+08:00',
      firstTextAt: undefined,
      assistantMessageAt: '2026-11-09T14:00:02+08:00',
    })),
    jsonLine(toolsLine()),
    jsonLine(chatLine({
      turn: 5,
      origin: 'coding-agent',
      lane: 'voice',
      phase: 'body',
      startedAt: '2026-11-09T14:00:00+08:00',
      endedAt: '2026-11-09T14:00:09+08:00',
      firstTextAt: '2026-11-09T14:00:00.001+08:00',
    })),
    jsonLine({
      scenario: 'chat',
      turn: 6,
      lane: 'typed',
      phase: 'ack',
      startedAt: '2026-11-09T14:00:00+08:00',
      endedAt: '2026-11-09T14:00:08+08:00',
      firstTextAt: '2026-11-09T14:00:00.002+08:00',
    }),
  ].join('\n');
}

test('默认严格只统计 assistant：coding-agent / unknown 不进入任何统计，也不补齐场景目标', () => {
  const parsed = parseInputText(mixedLines());
  const summary = buildSummary({
    parsed,
    template: scenarioTemplate(),
    source: { input: 'sample.jsonl', scenarios: 'template.json' },
    variable: '回复长度',
    generatedAt: AT,
  });

  assert.equal(summary.schema, 'seirein.fixed-sample.summary/v1');
  assert.equal(summary.generatedAt, AT_ISO);
  assert.equal(summary.settings.variable, '回复长度');
  assert.equal(summary.settings.includeNonAssistant, false);
  assert.equal(summary.attribution.mode, 'assistant-only');
  assert.deepEqual(summary.attribution.counts, {
    assistant: 4,
    codingAgent: 1,
    unknown: 1,
    unknownExplicit: 0,
    unknownMissing: 1,
    nonAssistant: 2,
    total: 6,
  });
  assert.equal(summary.totals.inputRecords, 6);
  assert.equal(summary.totals.samples, 4, '非助手样本不进入统计');
  assert.equal(summary.totals.assistantSamples, 4);
  assert.equal(summary.totals.nonAssistantSamples, 0);
  assert.equal(summary.totals.nonAssistantExcluded, 2);
  assert.equal(summary.coverage.samples, 4);
  assert.equal(summary.coverage.templateScenarios, 2);
  assert.equal(summary.coverage.expected, 10);
  assert.equal(summary.coverage.metScenarios, 0);
  assert.equal(summary.coverage.allMet, false);
  assert.deepEqual(summary.coverage.unmet.map((item) => item.id), ['chat', 'tools']);

  assert.equal(summary.groups.assistant.samples, 4);
  assert.equal(summary.groups.nonAssistant.samples, 0);
  assert.equal(summary.groups.nonAssistant.inputSamples, 2);
  assert.equal(summary.groups.nonAssistant.latency, null);
  assert.equal(summary.groups.nonAssistant.quality, null);

  const chat = summary.scenarios.find((scenario) => scenario.id === 'chat');
  assert.equal(chat.samples, 3, 'coding-agent 与 unknown 不补进 chat');
  assert.equal(chat.expected, 5);
  assert.equal(chat.meetsTarget, false);
  assert.equal(chat.latency.turnMs.p95, 3000, '9999 ms 的编码代理样本没有混入');
  assert.equal(chat.quality.turnsMissingFirstText, 1);
  assert.equal(chat.quality.toolCallTurns, 3);
  assert.equal(chat.quality.toolCalls, 0);

  const tools = summary.scenarios.find((scenario) => scenario.id === 'tools');
  assert.equal(tools.samples, 1);
  assert.equal(tools.latency.toolMs.p50, 1500);

  const voiceAck = groupRow(summary.groups.assistant, 'voice', 'ack');
  const voiceBody = groupRow(summary.groups.assistant, 'voice', 'body');
  const typedBody = groupRow(summary.groups.assistant, 'typed', 'body');
  assert.equal(voiceAck.samples, 2);
  assert.equal(voiceAck.latency.firstTextMs.p50, 100);
  assert.equal(voiceBody.samples, 1);
  assert.equal(voiceBody.latency.firstTextMs.p50, 900);
  assert.equal(typedBody.samples, 1);
  assert.equal(typedBody.latency.firstTextMs.p50, null, '只有 assistantMessageAt 时不倒推首字');
  assert.equal(typedBody.latency.firstTextMs.count, 0);

  assert.ok(summary.warnings.some((warning) => warning.includes('非助手样本')));
  assert.ok(summary.warnings.some((warning) => warning.includes('样本不足（n<5）')));
  assert.ok(summary.warnings.some((warning) => warning.includes('firstTextAt: missing')));

  const markdown = renderMarkdown(summary);
  assert.match(markdown, /样本非随机/u);
  assert.match(markdown, /不承诺性能收益/u);
  assert.match(markdown, /一次只改一个变量/u);
  assert.match(markdown, /## 样本归属（两组）/u);
  assert.match(markdown, /## lane × phase 样本数/u);
  assert.match(markdown, /## 延迟分位（组 × lane × phase/u);
  assert.match(markdown, /non-assistant/u);
  assert.match(markdown, /未纳入（需 --include-non-assistant）/u);
  assert.match(markdown, /样本不足（n<5）/u);
  assert.match(markdown, /firstTextAt: missing/u);
  assert.match(markdown, /回复长度/u);
  assert.ok(!markdown.includes('undefined'));
  assert.ok(!markdown.includes('NaN'));
  assert.ok(!markdown.includes('9999'), '编码代理的 9 s 时长不应出现在报告中');
});

test('--include-non-assistant：非助手单独成组，assistant 统计与场景覆盖不变', () => {
  const parsed = parseInputText(mixedLines());
  const template = scenarioTemplate();
  const base = buildSummary({ parsed, template });
  const included = buildSummary({ parsed, template, includeNonAssistant: true });

  assert.equal(included.attribution.mode, 'include-non-assistant');
  assert.equal(included.totals.samples, base.totals.samples);
  assert.equal(included.totals.assistantSamples, base.totals.samples);
  assert.equal(included.totals.nonAssistantSamples, 2);
  assert.equal(included.totals.nonAssistantExcluded, 0);
  assert.deepEqual(included.groups.assistant.latency, base.groups.assistant.latency);
  assert.equal(included.groups.nonAssistant.included, true);
  assert.equal(included.groups.nonAssistant.samples, 2);
  assert.equal(included.groups.nonAssistant.inputSamples, 2);
  assert.equal(included.groups.nonAssistant.latency.turnMs.p50, 8000);
  assert.equal(included.groups.nonAssistant.originCounts.codingAgent, 1);
  assert.equal(included.groups.nonAssistant.originCounts.unknown, 1);
  assert.equal(included.coverage.samples, base.coverage.samples, '非助手不补齐场景目标');
  assert.equal(included.scenarios.find((scenario) => scenario.id === 'chat').samples, 3);

  const nonassistant = included.groups.nonAssistant;
  assert.equal(groupRow(nonassistant, 'voice', 'body').samples, 1);
  assert.equal(groupRow(nonassistant, 'typed', 'ack').samples, 1);
  assert.equal(groupRow(nonassistant, 'voice', 'body').latency.turnMs.p50, 9000);
  assert.equal(groupRow(nonassistant, 'typed', 'ack').latency.turnMs.p50, 8000);

  const markdown = renderMarkdown(included);
  assert.match(markdown, /显式纳入，独立成组/u);
  assert.match(markdown, /non-assistant \| coding-agent \/ unknown \| 2 \| 2/u);
});

test('lane×phase 分开统计：同组不同组合的 p50/p95 不混算，样本不足明确标记', () => {
  const template = scenarioTemplate();
  const parsed = parseInputText([
    jsonLine(chatLine({ turn: 1, lane: 'voice', phase: 'ack', firstTextAt: '2026-11-09T14:00:00.100+08:00', startedAt: '2026-11-09T14:00:00+08:00', endedAt: '2026-11-09T14:00:01+08:00' })),
    jsonLine(chatLine({ turn: 2, lane: 'voice', phase: 'body', firstTextAt: '2026-11-09T14:00:00.900+08:00', startedAt: '2026-11-09T14:00:00+08:00', endedAt: '2026-11-09T14:00:03+08:00' })),
    jsonLine(chatLine({ turn: 3, lane: 'typed', phase: 'body', firstTextAt: '2026-11-09T14:00:00.500+08:00', startedAt: '2026-11-09T14:00:00+08:00', endedAt: '2026-11-09T14:00:02+08:00' })),
  ].join('\n'));
  const summary = buildSummary({ parsed, template });
  const rows = summary.groups.assistant.lanePhase;
  assert.deepEqual(
    rows.map((row) => [row.lane, row.phase, row.samples]),
    [['voice', 'ack', 1], ['voice', 'body', 1], ['typed', 'ack', 0], ['typed', 'body', 1]],
  );
  assert.equal(groupRow(summary.groups.assistant, 'voice', 'ack').latency.firstTextMs.p50, 100);
  assert.equal(groupRow(summary.groups.assistant, 'voice', 'body').latency.firstTextMs.p50, 900);
  assert.equal(groupRow(summary.groups.assistant, 'typed', 'body').latency.firstTextMs.p50, 500);
  for (const row of rows) {
    assert.equal(row.sufficient, row.samples >= MIN_GROUP_SAMPLES);
    if (row.samples < MIN_GROUP_SAMPLES) assert.equal(row.note, '样本不足（n<5）');
  }
  assert.equal(summary.groups.assistant.latency.firstTextMs.p50, 500, '整体 p50 仍只是描述统计，报告分位按组合给出');
});

test('场景模板：重复 id 与空场景列表直接报错；空输入保留模板场景且分位 null', async () => {
  assert.throws(
    () => parseScenarioTemplate({ scenarios: [] }),
    /non-empty scenarios array/u,
  );
  assert.throws(
    () => parseScenarioTemplate({
      scenarios: [
        { id: 'chat', title: 'A' },
        { id: 'chat', title: 'B' },
      ],
    }),
    /duplicate scenario id/u,
  );

  const template = await loadScenarioTemplate(DEFAULT_SCENARIOS_PATH);
  const summary = buildSummary({
    parsed: parseInputText(''),
    template,
    source: { input: 'empty.jsonl', scenarios: 'tools/fixtures/fixed-sample-scenarios.json' },
    generatedAt: AT,
  });
  assert.equal(summary.scenarios.length, 5);
  assert.equal(summary.totals.inputRecords, 0);
  assert.equal(summary.totals.samples, 0);
  assert.equal(summary.totals.badLines, 0);
  assert.equal(summary.attribution.counts.assistant, 0);
  assert.equal(summary.attribution.counts.nonAssistant, 0);
  assert.equal(summary.coverage.allMet, false);
  assert.equal(summary.coverage.metScenarios, 0);
  assert.equal(summary.groups.assistant.samples, 0);
  assert.equal(summary.groups.assistant.insufficient, true);
  for (const scenario of summary.scenarios) {
    assert.equal(scenario.samples, 0);
    assert.equal(scenario.expected, 5);
    assert.equal(scenario.meetsTarget, false);
    assert.deepEqual(scenario.latency.turnMs, { p50: null, p95: null, count: 0 });
    assert.equal(scenario.quality.toolCalls, null);
    assert.equal(scenario.quality.memoryHits, null);
  }
  const markdown = renderMarkdown(summary);
  assert.match(markdown, /null/u);
  assert.match(markdown, /样本不足（n<5）/u);
  assert.match(markdown, /0\/5 类达到目标/u);
  assert.ok(!markdown.includes('undefined'));
});

// ---------------------------------------------------------------------------
// 4) CLI：帮助、参数错误、默认过滤、显式纳入、Markdown + 同名 JSON
// ---------------------------------------------------------------------------

test('CLI --help：退出 0，包含 origin、lane/phase 与 --include-non-assistant', async () => {
  const stdout = capture();
  const stderr = capture();
  const code = await runFixedSample({ argv: ['--help'], stdout, stderr });
  assert.equal(code, 0);
  assert.match(stdout.text, /--input/u);
  assert.match(stdout.text, /origin/u);
  assert.match(stdout.text, /lane/u);
  assert.match(stdout.text, /--include-non-assistant/u);
  assert.match(stdout.text, /firstTextAt/u);
  assert.equal(stderr.text, '');
});

test('CLI 参数错误：缺 --input、非法 --repeat、布尔参数带值都退出 2', async () => {
  for (const argv of [
    [],
    ['--input'],
    ['--input', 'x.jsonl', '--repeat', '0'],
    ['--input', 'x.jsonl', '--include-non-assistant=true'],
  ]) {
    const stdout = capture();
    const stderr = capture();
    const code = await runFixedSample({ argv, stdout, stderr });
    assert.equal(code, 2, `argv=${JSON.stringify(argv)}`);
    assert.match(stderr.text, /fixed-sample:/u);
  }
});

test('CLI 默认排除 coding-agent；--include-non-assistant 才纳入并分组', async () => {
  await withTempDir(async (dir) => {
    const input = join(dir, 'turns.jsonl');
    const out = join(dir, 'report.md');
    await writeFile(input, [
      jsonLine(chatLine({ turn: 1 })),
      jsonLine(chatLine({
        turn: 2,
        origin: 'coding-agent',
        lane: 'typed',
        phase: 'body',
        startedAt: '2026-11-09T14:00:00+08:00',
        endedAt: '2026-11-09T14:00:09+08:00',
      })),
    ].join('\n'), 'utf8');

    const stdout = capture();
    const stderr = capture();
    const code = await runFixedSample({
      argv: ['--input', input, '--out', out, '--variable', '回复长度'],
      stdout,
      stderr,
      now: () => new Date(AT),
    });
    assert.equal(code, 0);
    assert.equal(stdout.text, '');
    assert.match(stderr.text, /assistant 1 samples/u);
    assert.match(stderr.text, /non-assistant 0 included \/ 1 excluded/u);

    const markdown = await readFile(out, 'utf8');
    assert.match(markdown, /P-61 固定样本对照实验报告/u);
    assert.match(markdown, /本次唯一变量：回复长度/u);
    assert.match(markdown, /未纳入（需 --include-non-assistant）/u);

    const summary = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8'));
    assert.equal(summary.generatedAt, AT_ISO);
    assert.equal(summary.totals.samples, 1);
    assert.equal(summary.totals.inputRecords, 2);
    assert.equal(summary.totals.nonAssistantSamples, 0);
    assert.equal(summary.totals.nonAssistantExcluded, 1);
    assert.equal(summary.groups.nonAssistant.samples, 0);
    assert.equal(summary.groups.assistant.lanes.typed, 0, '编码代理的 typed 样本没有混入 assistant 组');
  });
});

test('CLI --include-non-assistant：两组同时出现，assistant 组不变', async () => {
  await withTempDir(async (dir) => {
    const input = join(dir, 'turns.jsonl');
    const out = join(dir, 'report.md');
    const json = join(dir, 'summary.json');
    await writeFile(input, [
      jsonLine(chatLine({ turn: 1, firstTextAt: '2026-11-09T14:00:00.100+08:00' })),
      jsonLine(chatLine({
        turn: 2,
        origin: 'coding-agent',
        lane: 'typed',
        phase: 'body',
        startedAt: '2026-11-09T14:00:00+08:00',
        endedAt: '2026-11-09T14:00:09+08:00',
        firstTextAt: '2026-11-09T14:00:00.002+08:00',
      })),
    ].join('\n'), 'utf8');

    const stdout = capture();
    const stderr = capture();
    const code = await runFixedSample({
      argv: ['--input', input, '--out', out, '--json', json, '--include-non-assistant'],
      stdout,
      stderr,
      now: () => new Date(AT),
    });
    assert.equal(code, 0);
    assert.match(stderr.text, /non-assistant 1 included \/ 0 excluded/u);

    const markdown = await readFile(out, 'utf8');
    assert.match(markdown, /显式纳入，独立成组/u);
    assert.match(markdown, /non-assistant/u);

    const summary = JSON.parse(await readFile(json, 'utf8'));
    assert.equal(summary.totals.samples, 1);
    assert.equal(summary.totals.nonAssistantSamples, 1);
    assert.equal(summary.groups.assistant.samples, 1);
    assert.equal(summary.groups.nonAssistant.samples, 1);
    assert.equal(summary.groups.nonAssistant.latency.turnMs.p50, 9000);
    assert.equal(summary.groups.assistant.latency.turnMs.p50, 2000);
    assert.equal(summary.scenarios.find((scenario) => scenario.id === 'chat').samples, 1);
  });
});

test('CLI：仅 assistantMessageAt 时 firstTextAt 保持 null、报告标 missing；坏行不影响其余轮次', async () => {
  await withTempDir(async (dir) => {
    const input = join(dir, 'turns.jsonl');
    const out = join(dir, 'report.md');
    const { firstTextAt: _firstTextAt, ...withoutFirstText } = chatLine();
    await writeFile(input, [
      jsonLine({ ...withoutFirstText, assistantMessageAt: '2026-11-09T14:00:02+08:00' }),
      '{bad json',
      jsonLine(toolsLine()),
    ].join('\n'), 'utf8');

    const stdout = capture();
    const stderr = capture();
    const code = await runFixedSample({
      argv: ['--input', input, '--out', out],
      stdout,
      stderr,
      now: () => new Date(AT),
    });
    assert.equal(code, 0);
    assert.match(stderr.text, /bad lines/u);

    const markdown = await readFile(out, 'utf8');
    assert.match(markdown, /firstTextAt: missing/u);
    assert.match(markdown, /坏行 1/u);
    assert.match(markdown, /null（firstTextAt: missing）/u);

    const summary = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8'));
    assert.equal(summary.totals.samples, 2);
    assert.equal(summary.totals.badLines, 1);
    assert.equal(summary.source.badLines[0].line, 2);
    const first = summary.scenarios.find((scenario) => scenario.id === 'chat').turns[0];
    assert.equal(first.firstTextAt, null);
    assert.equal(first.firstTextMs, null);
    assert.equal(first.assistantMessageAt, '2026-11-09T14:00:02+08:00');
  });
});

test('CLI：空输入仍退出 0 并写 null 分位；--json 可另存纯 JSON', async () => {
  await withTempDir(async (dir) => {
    const input = join(dir, 'empty.jsonl');
    const out = join(dir, 'empty.md');
    const json = join(dir, 'summary.json');
    await writeFile(input, '', 'utf8');

    const stdout = capture();
    const stderr = capture();
    const code = await runFixedSample({
      argv: ['--input', input, '--out', out, '--json', json, '--repeat', '5'],
      stdout,
      stderr,
      now: () => new Date(AT),
    });
    assert.equal(code, 0);
    assert.match(await readFile(out, 'utf8'), /null/u);
    assert.ok(!(await readFile(out, 'utf8')).includes('NaN'));
    const summary = JSON.parse(await readFile(json, 'utf8'));
    assert.equal(summary.totals.samples, 0);
    assert.equal(summary.scenarios.length, 5);
    assert.equal(summary.scenarios[0].latency.turnMs.p50, null);
    assert.equal(summary.scenarios[0].latency.turnMs.p95, null);
    assert.equal(summary.scenarios[0].quality.toolCalls, null);
  });
});
