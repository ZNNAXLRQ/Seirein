/**
 * P-61 固定样本报告工具：解析、分组、分位、缺失字段、并行并集、坏行与 CLI。
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
      },
      {
        name: 'search',
        start: '2026-11-09T14:01:00.600+08:00',
        end: '2026-11-09T14:01:01.600+08:00',
        status: 'ok',
      },
    ],
    memoryHits: [1, 2],
    aborted: true,
    ...overrides,
  };
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
// 1) 解析与缺失字段
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
  assert.equal(first.turnMs, 2000);
  assert.equal(first.firstTextMs, 900);
  assert.equal(first.firstAudioMs, 1500);
  assert.equal(first.toolMs, 0, '空工具数组合法地产生 0，不是缺字段');
  assert.deepEqual(first.toolStatus, { ok: 0, error: 0, unknown: 0 });
  assert.equal(first.toolMissingTiming, 0);
  assert.equal(first.memoryHits, 2);

  const second = parsed.records[1];
  assert.equal(second.toolMs, 1500, '并行工具 [0.1,1.1] 与 [0.6,1.6] 的并集是 1.5 s');
  assert.deepEqual(second.toolStatus, { ok: 2, error: 0, unknown: 0 });
  assert.equal(second.toolMissingTiming, 0);
  assert.equal(second.memoryHits, 2);
  assert.equal(second.aborted, true);
});

test('缺失字段：写 null，不补 0；工具字段缺失与合法空数组可区分', () => {
  const [record] = parseInputText(jsonLine({ scenario: 'chat' })).records;
  assert.equal(record.turn, null);
  assert.equal(record.startedAt, null);
  assert.equal(record.endedAt, null);
  assert.equal(record.turnMs, null);
  assert.equal(record.firstTextMs, null);
  assert.equal(record.firstAudioMs, null);
  assert.equal(record.toolCalls, null);
  assert.equal(record.toolMs, null);
  assert.equal(record.toolStatus, null);
  assert.equal(record.toolMissingTiming, null);
  assert.equal(record.memoryHits, null);
  assert.equal(record.aborted, null);
  assert.deepEqual(record.missingFields, [
    'turn',
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
    'startedAt',
    'endedAt',
    'firstTextAt',
    'firstAudioAt',
    'toolCalls',
    'memoryHits',
    'aborted',
  ]);
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
// 2) 分位与工具区间并集
// ---------------------------------------------------------------------------

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

test('工具区间并集：重叠只算一次，相接、包含与分离都正确', () => {
  assert.equal(unionIntervalsMs([]), 0);
  assert.equal(unionIntervalsMs([{ start: 0, end: 100 }, { start: 50, end: 150 }]), 150);
  assert.equal(unionIntervalsMs([{ start: 0, end: 100 }, { start: 20, end: 40 }]), 100);
  assert.equal(unionIntervalsMs([{ start: 0, end: 100 }, { start: 100, end: 200 }]), 200);
  assert.equal(unionIntervalsMs([{ start: 0, end: 100 }, { start: 200, end: 300 }]), 200);
  assert.equal(unionIntervalsMs([{ start: 10, end: 5 }, { start: Number.NaN, end: 4 }]), 0);
});

// ---------------------------------------------------------------------------
// 3) 分组统计、覆盖与报告
// ---------------------------------------------------------------------------

test('分组：模板场景保留 0 样本；模板外场景单独计数；p50/p95 只统计有效值', () => {
  const template = parseScenarioTemplate({
    repeat: 5,
    scenarios: [
      { id: 'chat', title: '无工具短闲聊', repeat: 5 },
      { id: 'tools', title: '多步骤工具请求', repeat: 5 },
    ],
  });
  const parsed = parseInputText([
    jsonLine(chatLine()),
    jsonLine({
      scenario: 'chat',
      turn: 2,
      startedAt: '2026-11-09T14:02:00+08:00',
      endedAt: '2026-11-09T14:02:04+08:00',
      firstTextAt: '2026-11-09T14:02:01+08:00',
      firstAudioAt: '2026-11-09T14:02:02+08:00',
      memoryHits: 0,
    }),
    jsonLine(toolsLine()),
    jsonLine({ scenario: 'unregistered', turn: 4, startedAt: '2026-11-09T14:03:00+08:00', endedAt: '2026-11-09T14:03:01+08:00' }),
  ].join('\n'));
  const summary = buildSummary({
    parsed,
    template,
    source: { input: 'sample.jsonl', scenarios: 'template.json' },
    variable: '回复长度',
    generatedAt: AT,
  });

  assert.equal(summary.schema, 'seirein.fixed-sample.summary/v1');
  assert.equal(summary.generatedAt, AT_ISO);
  assert.equal(summary.settings.variable, '回复长度');
  assert.equal(summary.totals.samples, 4);
  assert.equal(summary.totals.groups, 3);
  assert.equal(summary.coverage.templateScenarios, 2);
  assert.equal(summary.coverage.expected, 10);
  assert.equal(summary.coverage.metScenarios, 0);
  assert.equal(summary.coverage.allMet, false);
  assert.deepEqual(summary.coverage.unmet.map((item) => item.id), ['chat', 'tools']);

  const chat = summary.scenarios.find((scenario) => scenario.id === 'chat');
  assert.equal(chat.samples, 2);
  assert.equal(chat.expected, 5);
  assert.equal(chat.meetsTarget, false);
  assert.equal(chat.latency.turnMs.count, 2);
  assert.equal(chat.latency.turnMs.p50, 2000);
  assert.equal(chat.latency.turnMs.p95, 4000);
  assert.equal(chat.latency.firstTextMs.p50, 900);
  assert.equal(chat.latency.firstTextMs.p95, 1000);
  assert.equal(chat.quality.memoryHits, 2);
  assert.equal(chat.quality.memoryHitsTurns, 2);
  assert.equal(chat.quality.toolCallTurns, 1, '第二轮的 toolCalls 缺失，不计成空数组');
  assert.equal(chat.quality.turnsMissingToolCalls, 1);
  assert.equal(chat.quality.toolCalls, 0);
  assert.equal(chat.quality.aborted, 0, '第二轮 aborted 缺失，只统计明确 true 的轮次');
  assert.equal(chat.quality.abortedUnknown, 1);

  const tools = summary.scenarios.find((scenario) => scenario.id === 'tools');
  assert.equal(tools.samples, 1);
  assert.equal(tools.latency.toolMs.p50, 1500);
  assert.equal(tools.quality.toolOk, 2);
  assert.equal(tools.quality.toolCalls, 2);

  const unknown = summary.scenarios.find((scenario) => scenario.id === 'unregistered');
  assert.equal(unknown.template, false);
  assert.equal(unknown.expected, null);
  assert.equal(unknown.meetsTarget, null);
  assert.equal(unknown.samples, 1);
  assert.ok(summary.warnings.some((warning) => warning.includes('unregistered')));

  const markdown = renderMarkdown(summary);
  assert.match(markdown, /样本非随机/u);
  assert.match(markdown, /不承诺性能收益/u);
  assert.match(markdown, /一次只改一个变量/u);
  assert.match(markdown, /p50/u);
  assert.match(markdown, /逐轮明细/u);
  assert.match(markdown, /回复长度/u);
  assert.ok(!markdown.includes('undefined'));
  assert.ok(!markdown.includes('NaN'));
});

test('--repeat 覆盖模板占位：所有模板场景使用同一目标数', () => {
  const template = parseScenarioTemplate({
    repeat: 5,
    scenarios: [
      { id: 'chat', title: '无工具短闲聊' },
      { id: 'tools', title: '多步骤工具请求' },
    ],
  });
  const parsed = parseInputText([
    jsonLine(chatLine()),
    jsonLine(toolsLine()),
  ].join('\n'));
  const summary = buildSummary({ parsed, template, repeatOverride: 1 });
  assert.deepEqual(summary.scenarios.map((scenario) => scenario.expected), [1, 1]);
  assert.deepEqual(summary.scenarios.map((scenario) => scenario.meetsTarget), [true, true]);
  assert.equal(summary.coverage.allMet, true);
  assert.equal(summary.coverage.expected, 2);
  assert.deepEqual(summary.warnings, []);
});

test('空输入：不崩溃，五类场景都在，样本数为 0，分位数为 null', async () => {
  const template = await loadScenarioTemplate(DEFAULT_SCENARIOS_PATH);
  const summary = buildSummary({
    parsed: parseInputText(''),
    template,
    source: { input: 'empty.jsonl', scenarios: 'tools/fixtures/fixed-sample-scenarios.json' },
    generatedAt: AT,
  });
  assert.equal(summary.scenarios.length, 5);
  assert.equal(summary.totals.samples, 0);
  assert.equal(summary.totals.badLines, 0);
  assert.equal(summary.coverage.allMet, false);
  assert.equal(summary.coverage.metScenarios, 0);
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
  assert.match(markdown, /0\/5 类达到目标/u);
  assert.ok(!markdown.includes('undefined'));
});

test('场景模板：重复 id 与空场景列表直接报错', () => {
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
});

// ---------------------------------------------------------------------------
// 4) CLI：帮助、参数错误、Markdown + 同名 JSON、空输入与坏行
// ---------------------------------------------------------------------------

test('CLI --help：退出 0，包含输入格式与输入参数', async () => {
  const stdout = capture();
  const stderr = capture();
  const code = await runFixedSample({ argv: ['--help'], stdout, stderr });
  assert.equal(code, 0);
  assert.match(stdout.text, /--input/u);
  assert.match(stdout.text, /toolCalls/u);
  assert.equal(stderr.text, '');
});

test('CLI 参数错误：缺 --input、非法 --repeat 都退出 2', async () => {
  for (const argv of [[], ['--input'], ['--input', 'x.jsonl', '--repeat', '0']]) {
    const stdout = capture();
    const stderr = capture();
    const code = await runFixedSample({ argv, stdout, stderr });
    assert.equal(code, 2, `argv=${JSON.stringify(argv)}`);
    assert.match(stderr.text, /fixed-sample:/u);
  }
});

test('CLI：写 Markdown 与同名 JSON，坏行不影响其余轮次，固定时钟', async () => {
  await withTempDir(async (dir) => {
    const input = join(dir, 'turns.jsonl');
    const out = join(dir, 'report.md');
    await writeFile(input, [
      jsonLine(chatLine()),
      '{bad json',
      jsonLine(toolsLine()),
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
    assert.match(stderr.text, /bad lines/u);

    const markdown = await readFile(out, 'utf8');
    assert.match(markdown, /P-61 固定样本对照实验报告/u);
    assert.match(markdown, /本次唯一变量：回复长度/u);
    assert.match(markdown, /坏行 1/u);
    assert.match(markdown, /sample\.jsonl|turns\.jsonl/u);

    const sidecar = join(dir, 'report.json');
    const summary = JSON.parse(await readFile(sidecar, 'utf8'));
    assert.equal(summary.generatedAt, AT_ISO);
    assert.equal(summary.settings.variable, '回复长度');
    assert.equal(summary.totals.samples, 2);
    assert.equal(summary.totals.badLines, 1);
    assert.equal(summary.source.badLines.length, 1);
    assert.equal(summary.source.badLines[0].line, 2);
    assert.equal(summary.scenarios.find((scenario) => scenario.id === 'tools').latency.toolMs.p50, 1500);
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
