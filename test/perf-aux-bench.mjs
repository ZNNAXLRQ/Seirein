/**
 * Auxiliary-path performance bench: direct lightweight channel vs FastPath.assist.
 *
 * The comparison the review asks for is NOT "direct is faster" and NOT "direct is reasoning-off".
 * It is: under the SAME model, what does each path's own assembly/context work cost, and what did
 * the model actually emit? Therefore both paths run against one controlled fake provider whose
 * stream injects first-TEXT delay, total stream duration and reasoning-frame characters:
 *
 *   direct    createLightweightChannel(...).ask({ task, context:'none', system, user })
 *             -> directAssist(): no memory/persona/history assembly; the dispatch is still
 *                gated by the channel's one deadline and capability probe. (A packaged task
 *                call takes the same directAssist branch; context:'none' here keeps the prompt
 *                explicit so both paths receive identical system/user text.)
 *   fastpath  FastPath.assist({ task, system, user, instruction })
 *             -> systemPrompt(): persona + profile + relevant memory + recent scoped turns,
 *                then the task prompt; the same stream and finish parsing.
 *
 * Per task and path, N runs produce p50/p95 firstTextMs, p50/p95 doneMs, avg reasoningChars,
 * avg inputChars, median resultChars and the failure rate. `inputChars` is measured from the
 * exact `llm.stream` request (system + user text), not from a caller-side estimate, so the
 * context-assembly difference is visible even when the agent loop is absent from both paths.
 *
 * Quality: for every run pair (same input), the two replies are compared character-wise
 * (normalized Levenshtein distance) and the first differing excerpt (80 chars) is kept. The fake
 * model is target-deterministic by default, so the expected diff is 0; `--drift` is a synthetic
 * context-influence switch whose only purpose is to exercise that comparator.
 *
 * Scope note: a fake model cannot show real provider differences (real reasoning effort, real
 * first-token latency, real quality). This tool only measures the two paths' assembly/context
 * overhead on one synthetic model. A real-provider comparison must be run live separately.
 *
 * Writes only `%TEMP%/aux-bench/<timestamp>.json`; never touches the repository.
 *
 * Usage:
 *   node test/perf-aux-bench.mjs --runs=5
 *   node test/perf-aux-bench.mjs --tasks=translate,kana --runs=10 --json
 *   node test/perf-aux-bench.mjs --firstMs=80 --totalMs=300 --reasoningChars=64
 *
 * Options:
 *   --runs=N            measured runs per task/path (default 30)
 *   --tasks=a,b         subset of translate,kana,ack,spoken (default all)
 *   --json              print the report as JSON instead of the table (the file is still written)
 *   --firstMs=N         injected first-TEXT delay (default 45)
 *   --totalMs=N         injected total stream duration (default 150)
 *   --reasoningChars=N  injected reasoning-frame characters (default 32)
 *   --seed=N            jitter seed (default 20261107)
 *   --jitter=0..0.5     delay jitter ratio (default 0.12)
 *   --failRate=0..1     synthetic failure probability (default 0)
 *   --drift=0..1        synthetic context-influence probability, quality comparator only (default 0)
 *   --honorOff          fake model emits zero reasoning when asked for off (default: it ignores off)
 *   -h, --help
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LIGHTWEIGHT_TASK_RULES } from '../src/host/session/inference/lightweight.js';
import {
  AUX_TASK_FIXTURES,
  AUX_TASKS,
  createAuxBenchHost,
  createFakeAuxModel,
  DRIFT_CLAUSES,
} from './fixtures/perf-aux-model.mjs';

const DEFAULT_RUNS = 30;
const DEFAULT_FIRST_MS = 45;
const DEFAULT_TOTAL_MS = 150;
const DEFAULT_REASONING_CHARS = 32;
const DEFAULT_SEED = 20261107;
const DEFAULT_JITTER = 0.12;
const WARMUP_RUNS = 1;

const DIRECT = 'direct';
const FASTPATH = 'fastpath';
const PATHS = [DIRECT, FASTPATH];

// ---------------------------------------------------------------------------
// small numeric / text helpers
// ---------------------------------------------------------------------------

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/** Only real measurements enter a statistic; null/undefined never becomes a fabricated 0. */
function finiteNumbers(values) {
  return (Array.isArray(values) ? values : [])
    .filter((value) => value !== null && value !== undefined)
    .map(Number)
    .filter((value) => Number.isFinite(value));
}

function round(value, digits = 1) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const factor = 10 ** digits;
  return Math.round(number * factor) / factor;
}

function mean(values) {
  const list = finiteNumbers(values);
  if (list.length === 0) return null;
  return list.reduce((sum, value) => sum + value, 0) / list.length;
}

function median(values) {
  const list = finiteNumbers(values).sort((a, b) => a - b);
  if (list.length === 0) return null;
  const middle = Math.floor(list.length / 2);
  return list.length % 2 === 1 ? list[middle] : (list[middle - 1] + list[middle]) / 2;
}

/** Linear-interpolated percentile, matching the product's own helper semantics. */
function percentile(values, p) {
  const list = finiteNumbers(values).sort((a, b) => a - b);
  if (list.length === 0) return null;
  const rank = (list.length - 1) * clamp(p, 0, 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  const value = low === high ? list[low] : list[low] + (list[high] - list[low]) * (rank - low);
  return round(value, 2);
}

/** Deterministic PRNG (mulberry32) so a seed reproduces the exact timing/failure pattern. */
function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function jittered(base, random, ratio) {
  const factor = 1 + (random() * 2 - 1) * ratio;
  return Math.max(1, Math.round(base * factor));
}

const charCount = (value) => Array.from(String(value ?? '')).length;

function errorText(error) {
  if (error === undefined || error === null) return '';
  const name = typeof error.name === 'string' && error.name.length > 0 ? `${error.name}: ` : '';
  return `${name}${String(error.message ?? error)}`.slice(0, 200);
}

/** Character-level (code point) edit distance, two rows. */
function editDistance(left, right) {
  const a = Array.from(left);
  const b = Array.from(right);
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

/** Normalized character-level difference: 0 = identical, 1 = nothing in common. */
function diffRatio(left, right) {
  const a = Array.from(String(left ?? ''));
  const b = Array.from(String(right ?? ''));
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 0;
  return round(editDistance(a, b) / longest, 4);
}

/** First differing 80-character window (8 characters of shared prefix for context). */
function firstDiffExcerpt(left, right, width = 80) {
  const a = Array.from(String(left ?? ''));
  const b = Array.from(String(right ?? ''));
  let at = 0;
  while (at < a.length && at < b.length && a[at] === b[at]) at += 1;
  const start = Math.max(0, at - 8);
  return {
    at,
    direct: a.slice(start, start + width).join(''),
    fastpath: b.slice(start, start + width).join(''),
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseInteger(name, value, low, high) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < low || number > high) {
    throw new Error(`--${name} 需要 ${low}..${high} 的整数，收到 ${JSON.stringify(value)}`);
  }
  return number;
}

function parseNumber(name, value, low, high) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < low || number > high) {
    throw new Error(`--${name} 需要 ${low}..${high} 的数值，收到 ${JSON.stringify(value)}`);
  }
  return number;
}

function parseTasks(value) {
  const list = String(value ?? '').split(/[,，\s]+/u).map((item) => item.trim()).filter(Boolean);
  const unique = [...new Set(list)];
  if (unique.length === 0) throw new Error('--tasks 不能为空');
  for (const task of unique) {
    if (!AUX_TASKS.includes(task)) {
      throw new Error(`未知任务 ${JSON.stringify(task)}；可用: ${AUX_TASKS.join(', ')}`);
    }
  }
  return unique;
}

function parseCli(argv) {
  const options = {
    runs: DEFAULT_RUNS,
    tasks: [...AUX_TASKS],
    firstMs: DEFAULT_FIRST_MS,
    totalMs: DEFAULT_TOTAL_MS,
    reasoningChars: DEFAULT_REASONING_CHARS,
    seed: DEFAULT_SEED,
    jitter: DEFAULT_JITTER,
    failRate: 0,
    drift: 0,
    honorOff: false,
    json: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') {
      options.json = true;
      continue;
    }
    if (argument === '--honorOff') {
      options.honorOff = true;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    const match = /^--([A-Za-z][A-Za-z0-9-]*)(?:=(.*))?$/u.exec(argument);
    if (match === null) throw new Error(`未知参数: ${argument}`);
    const name = match[1];
    let value = match[2];
    if (value === undefined) {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`参数 --${name} 需要一个值`);
      value = next;
      index += 1;
    }
    switch (name) {
      case 'runs': options.runs = parseInteger('runs', value, 1, 500); break;
      case 'tasks': options.tasks = parseTasks(value); break;
      case 'firstMs': options.firstMs = parseNumber('firstMs', value, 0, 10_000); break;
      case 'totalMs': options.totalMs = parseNumber('totalMs', value, 1, 60_000); break;
      case 'reasoningChars': options.reasoningChars = parseInteger('reasoningChars', value, 0, 100_000); break;
      case 'seed': options.seed = parseInteger('seed', value, 0, 2_147_483_647); break;
      case 'jitter': options.jitter = parseNumber('jitter', value, 0, 0.5); break;
      case 'failRate': options.failRate = parseNumber('failRate', value, 0, 1); break;
      case 'drift': options.drift = parseNumber('drift', value, 0, 1); break;
      default: throw new Error(`未知参数: --${name}`);
    }
  }
  if (options.totalMs <= options.firstMs) {
    throw new Error(`--totalMs (${options.totalMs}) 必须大于 --firstMs (${options.firstMs})`);
  }
  return options;
}

function printUsage() {
  console.log('用法: node test/perf-aux-bench.mjs [选项]');
  console.log('');
  console.log('  --runs=N            每个任务/路径的测量次数（默认 30）');
  console.log('  --tasks=a,b         任务子集: translate,kana,ack,spoken（默认全部）');
  console.log('  --json              stdout 输出 JSON（结果文件仍会写）');
  console.log('  --firstMs=N         注入的首正文延迟（默认 45）');
  console.log('  --totalMs=N         注入的流总时长（默认 150）');
  console.log('  --reasoningChars=N  注入的推理帧字符数（默认 32）');
  console.log('  --seed=N            时序抖动种子（默认 20261107）');
  console.log('  --jitter=0..0.5     时序抖动比例（默认 0.12）');
  console.log('  --failRate=0..1     假模型失败率（默认 0）');
  console.log('  --drift=0..1        合成上下文影响答案的概率，仅用于质量对照（默认 0）');
  console.log('  --honorOff          假模型遵守 off（默认忽略，用来证明“请求 off ≠ 实际零推理”）');
  console.log('  -h, --help');
  console.log('');
  console.log('结果写入 %TEMP%\\aux-bench\\<timestamp>.json；不写仓库。');
}

// ---------------------------------------------------------------------------
// measurement
// ---------------------------------------------------------------------------

function summarize(samples) {
  const successful = samples.filter((sample) => sample.ok);
  const failed = samples.filter((sample) => !sample.ok);
  const firstText = successful.map((sample) => sample.firstTextMs);
  const done = successful.map((sample) => sample.doneMs);
  const inputChars = samples.map((sample) => sample.inputChars);
  return {
    runs: samples.length,
    successes: successful.length,
    failures: failed.length,
    failureRate: samples.length === 0 ? null : round(failed.length / samples.length, 4),
    firstTextMs: {
      p50: percentile(firstText, 0.5),
      p95: percentile(firstText, 0.95),
      min: firstText.length === 0 ? null : round(Math.min(...firstText), 2),
      max: firstText.length === 0 ? null : round(Math.max(...firstText), 2),
    },
    doneMs: {
      p50: percentile(done, 0.5),
      p95: percentile(done, 0.95),
      min: done.length === 0 ? null : round(Math.min(...done), 2),
      max: done.length === 0 ? null : round(Math.max(...done), 2),
    },
    avgReasoningChars: round(mean(successful.map((sample) => sample.reasoningChars)), 1),
    avgInputChars: round(mean(inputChars), 1),
    avgContextChars: round(mean(successful.map((sample) => sample.contextChars)), 1),
    medianResultChars: round(median(successful.map((sample) => sample.resultChars)), 0),
    offRequested: samples.filter((sample) => sample.reasoningEffort === 'off').length,
    reported: {
      firstTextMs: {
        p50: percentile(successful.map((sample) => sample.reportedFirstTextMs), 0.5),
        p95: percentile(successful.map((sample) => sample.reportedFirstTextMs), 0.95),
      },
      doneMs: {
        p50: percentile(successful.map((sample) => sample.reportedDoneMs), 0.5),
        p95: percentile(successful.map((sample) => sample.reportedDoneMs), 0.95),
      },
    },
    failureReasons: [...new Set(failed.map((sample) => sample.error).filter(Boolean))].slice(0, 5),
  };
}

function compareQuality(task, directSamples, fastpathSamples) {
  const pairs = [];
  const count = Math.min(directSamples.length, fastpathSamples.length);
  for (let index = 0; index < count; index += 1) {
    const direct = directSamples[index];
    const fastpath = fastpathSamples[index];
    if (!direct.ok || !fastpath.ok) continue;
    const ratio = diffRatio(direct.text, fastpath.text);
    pairs.push({
      index,
      ratio,
      excerpt: ratio > 0 ? firstDiffExcerpt(direct.text, fastpath.text) : null,
    });
  }
  const differing = pairs.filter((pair) => pair.ratio > 0);
  return {
    task,
    pairs: pairs.length,
    differing: differing.length,
    avgDiffRatio: round(mean(pairs.map((pair) => pair.ratio)), 4),
    maxDiffRatio: round(differing.length === 0 ? 0 : Math.max(...pairs.map((pair) => pair.ratio)), 4),
    sample: differing.length === 0 ? null : differing[0].excerpt,
  };
}

function formatMs(value) {
  return value === null || value === undefined || !Number.isFinite(Number(value))
    ? 'n/a'
    : Number(value).toFixed(1);
}

function formatNumber(value, digits = 1) {
  return value === null || value === undefined || !Number.isFinite(Number(value))
    ? 'n/a'
    : Number(value).toFixed(digits);
}

function formatPercent(value) {
  return value === null || value === undefined || !Number.isFinite(Number(value))
    ? 'n/a'
    : `${(Number(value) * 100).toFixed(1)}%`;
}

function displayRows(report) {
  const rows = report.results.map((row) => [
    row.task,
    row.path,
    formatMs(row.firstTextMs.p50),
    formatMs(row.firstTextMs.p95),
    formatMs(row.doneMs.p50),
    formatMs(row.doneMs.p95),
    formatNumber(row.avgReasoningChars, 1),
    formatNumber(row.avgInputChars, 0),
    formatNumber(row.medianResultChars, 0),
    formatPercent(row.failureRate),
  ]);
  const headers = [
    'task', 'path', 'p50 firstTextMs', 'p95 firstTextMs', 'p50 doneMs', 'p95 doneMs',
    'avg reasoningChars', 'avg inputChars', 'median resultChars', 'failure rate',
  ];
  const widths = headers.map((header, column) => Math.max(
    Array.from(header).length,
    ...rows.map((row) => Array.from(row[column]).length),
  ));
  const line = (cells) => cells.map((cell, column) => {
    const text = String(cell);
    return column === 0 ? text.padEnd(widths[column]) : text.padStart(widths[column]);
  }).join('  ');
  return [line(headers), widths.map((width) => '-'.repeat(width)).join('  '), ...rows.map(line)];
}

function printReport(report) {
  const { meta } = report;
  console.log(`aux-bench  runs=${meta.runs}/task  tasks=${meta.tasks.join(',')}  seed=${meta.seed}`);
  console.log(
    `fake model: firstText=${meta.fakeModel.firstTextMs}ms total=${meta.fakeModel.totalMs}ms `
    + `reasoning=${meta.fakeModel.reasoningChars}chars jitter=${meta.fakeModel.jitter} `
    + `failRate=${meta.fakeModel.failRate} drift=${meta.fakeModel.drift} honorOff=${meta.fakeModel.honorOff}`,
  );
  console.log('');
  for (const line of displayRows(report)) console.log(line);
  console.log('');
  console.log('times are ms; p50/p95 over successful runs; fail over all runs.');
  console.log('firstText/done are measured OUTSIDE the channel (wall clock, includes assembly);');
  console.log('reasoningChars is what the stream actually emitted, not the requested flag.');
  console.log('');
  console.log('quality (same input, character-level diff):');
  for (const item of report.quality) {
    const state = item.sample === null ? 'identical' : `first diff @${item.sample.at}`;
    console.log(
      `  ${item.task.padEnd(10)} avg ${formatNumber(item.avgDiffRatio, 4)}  `
      + `differing ${item.differing}/${item.pairs}  ${state}`,
    );
    if (item.sample !== null) {
      console.log(`    direct:   ${item.sample.direct}`);
      console.log(`    fastpath: ${item.sample.fastpath}`);
    }
  }
  console.log('');
  console.log('context assembly (avg inputChars, fastpath - direct):');
  for (const delta of report.deltas) {
    console.log(
      `  ${delta.task.padEnd(10)} direct ${formatNumber(delta.directInputChars, 0)}  `
      + `fastpath ${formatNumber(delta.fastpathInputChars, 0)}  `
      + `delta ${delta.inputCharsDelta === null ? 'n/a' : `${delta.inputCharsDelta >= 0 ? '+' : ''}${formatNumber(delta.inputCharsDelta, 0)}`}  `
      + `(context ${formatNumber(delta.fastpathContextChars, 0)} chars)`,
    );
  }
  console.log('');
  console.log('NOTE: 假模型不反映真实 provider 差异；本工具只验证「同一模型下两条路径的装配/上下文开销」。');
  console.log('      真实 provider 对比需要另跑 live（不在本工具范围）。');
  if (meta.fakeModel.drift > 0) {
    console.log('      --drift 是合成的“上下文影响答案”实验，只用于验证 diffRatio 对照，不是质量结论。');
  }
  console.log(`      假模型${meta.fakeModel.honorOff ? '遵守' : '忽略'} reasoningEffort:'off'；`
    + `reasoningChars ${meta.fakeModel.honorOff ? '会随 off 归零。' : '仍大于 0（请求 off ≠ 实际零推理）。'}`);
  console.log(`result: ${meta.resultFile}`);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const options = parseCli(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  const clock = () => performance.now();
  const random = createRandom(options.seed);
  const model = createFakeAuxModel({ now: clock, honorOff: options.honorOff });
  const host = createAuxBenchHost({ model, now: clock });

  const runSample = async ({ task, path, plan }) => {
    const fixture = AUX_TASK_FIXTURES[task];
    const requestIndex = model.requests.length;
    model.enqueue(plan);
    const callStartedAt = clock();
    let result = null;
    let error = null;
    try {
      if (path === DIRECT) {
        result = await host.channel.ask({
          task,
          context: 'none',
          system: fixture.system,
          user: fixture.user,
          maxTokens: fixture.maxTokens,
          timeoutMs: 10_000,
        });
      } else {
        result = await host.fastpath.assist({
          task,
          system: fixture.system,
          user: fixture.user,
          maxTokens: fixture.maxTokens,
          instruction: LIGHTWEIGHT_TASK_RULES[task].instruction,
          reasoningEffort: 'off',
        });
      }
    } catch (caught) {
      error = caught;
    }
    const callEndedAt = clock();
    const request = model.requests[requestIndex] ?? null;
    const ok = error === null && result !== null;
    const firstTextAt = request === null ? null : request.firstTextAt;
    return {
      task,
      path,
      ok,
      error: errorText(error),
      firstTextMs: ok && typeof firstTextAt === 'number' ? round(firstTextAt - callStartedAt, 2) : null,
      doneMs: round(callEndedAt - callStartedAt, 2),
      reportedFirstTextMs: ok ? round(result.firstTextMs ?? result.firstDeltaMs, 2) : null,
      reportedDoneMs: ok ? round(result.doneMs, 2) : null,
      reasoningChars: ok ? Number(result.reasoningChars) || 0 : null,
      inputChars: request === null ? null : request.inputChars,
      contextChars: ok ? Number(result.contextChars) || 0 : null,
      resultChars: ok ? charCount(result.text) : null,
      text: ok ? String(result.text ?? '') : '',
      reasoningEffort: request === null ? null : request.reasoningEffort,
    };
  };

  process.stderr.write(
    `aux-bench: ${options.runs} runs/task, tasks=${options.tasks.join(',')}, warmup=${WARMUP_RUNS}/task/path\n`,
  );
  // One unrecorded warm-up per task/path absorbs module/JIT/capability-probe cold costs. The
  // capability answer is then cached by the channel's own TTL for the measured runs.
  for (const task of options.tasks) {
    for (const path of PATHS) {
      await runSample({
        task,
        path,
        plan: {
          text: AUX_TASK_FIXTURES[task].reply,
          firstTextMs: 3,
          totalMs: 10,
          reasoningChars: 2,
          fail: false,
        },
      });
    }
  }

  const samplesByTask = new Map();
  for (const task of options.tasks) {
    const store = { [DIRECT]: [], [FASTPATH]: [] };
    for (let run = 0; run < options.runs; run += 1) {
      const firstTextMs = jittered(options.firstMs, random, options.jitter);
      const totalMs = Math.max(firstTextMs + 1, jittered(options.totalMs, random, options.jitter));
      const fail = options.failRate > 0 && random() < options.failRate;
      const drift = !fail && options.drift > 0 && random() < options.drift;
      const basePlan = { firstTextMs, totalMs, reasoningChars: options.reasoningChars, fail };
      const plans = {
        [DIRECT]: { ...basePlan, text: AUX_TASK_FIXTURES[task].reply },
        [FASTPATH]: {
          ...basePlan,
          text: drift
            ? `${AUX_TASK_FIXTURES[task].reply}${DRIFT_CLAUSES[task]}`
            : AUX_TASK_FIXTURES[task].reply,
        },
      };
      // Alternate which path runs first, so a slow first-call/cache effect cannot favour one path.
      const order = run % 2 === 0 ? PATHS : [...PATHS].reverse();
      for (const path of order) {
        store[path].push(await runSample({ task, path, plan: plans[path] }));
      }
    }
    samplesByTask.set(task, store);
    process.stderr.write(`  ${task}: ${options.runs} runs/path done\n`);
  }

  const results = [];
  const quality = [];
  const deltas = [];
  for (const task of options.tasks) {
    const store = samplesByTask.get(task);
    const directRow = { task, path: DIRECT, ...summarize(store[DIRECT]) };
    const fastpathRow = { task, path: FASTPATH, ...summarize(store[FASTPATH]) };
    results.push(directRow, fastpathRow);
    deltas.push({
      task,
      directInputChars: directRow.avgInputChars,
      fastpathInputChars: fastpathRow.avgInputChars,
      inputCharsDelta: directRow.avgInputChars === null || fastpathRow.avgInputChars === null
        ? null
        : round(fastpathRow.avgInputChars - directRow.avgInputChars, 1),
      directContextChars: directRow.avgContextChars,
      fastpathContextChars: fastpathRow.avgContextChars,
    });
    quality.push(compareQuality(task, store[DIRECT], store[FASTPATH]));
  }

  const outDir = join(tmpdir(), 'aux-bench');
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const resultFile = join(outDir, `${stamp}.json`);
  const report = {
    meta: {
      tool: 'test/perf-aux-bench.mjs',
      generatedAt: new Date().toISOString(),
      resultFile,
      runs: options.runs,
      tasks: options.tasks,
      warmupRuns: WARMUP_RUNS,
      seed: options.seed,
      definitions: {
        firstTextMs: 'wall time from call start to the first TEXT delta (reasoning frames excluded)',
        doneMs: 'wall time from call start to stream completion',
        inputChars: 'characters in system + user text actually passed to llm.stream',
        reasoningChars: 'characters in reasoning/thinking frames actually received',
      },
      fakeModel: {
        provider: 'fake-provider',
        model: 'fake-model',
        firstTextMs: options.firstMs,
        totalMs: options.totalMs,
        reasoningChars: options.reasoningChars,
        jitter: options.jitter,
        failRate: options.failRate,
        drift: options.drift,
        honorOff: options.honorOff,
      },
      note: [
        '假模型不反映真实 provider 差异；本工具只验证「同一模型下两条路径的装配/上下文开销」。',
        '真实 provider 对比需要另跑 live（不在本工具范围）。',
        'reasoningChars 是实际收到的推理帧字符数，不是请求里的 reasoningEffort；默认假模型故意忽略 off。',
        '--drift 是合成的上下文影响答案实验，只用于验证 diffRatio 对照，不是质量结论。',
      ],
    },
    results,
    deltas,
    quality,
  };

  await mkdir(outDir, { recursive: true });
  await writeFile(resultFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }
}

main().catch((error) => {
  console.error(`aux-bench failed: ${errorText(error)}`);
  process.exitCode = 1;
});
