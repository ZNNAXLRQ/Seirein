#!/usr/bin/env node
/**
 * P-71 / 分批回归执行器（test/*.mjs）
 *
 * 为什么需要它
 * ------------
 * 把全部 `test/*.mjs` 一次并行跑完会长时间停滞（`WORKLOG.md` §3.8：>40 min），且并行时长
 * 预算会把工具/语音生命周期类测试误判成超时。这里改成**按前缀分批、每批串行、批间顺序**，
 * 每批时长保持在可解释的范围；单文件失败只记录，不阻断后续批次。
 *
 * 行为
 * ----
 * 1. 只扫描仓库根下 `test/*.mjs`（不递归 helpers / fixtures）。
 * 2. 按文件名前缀分组：voice / subtitle / avatar / profile / vts / spout / memory / asr /
 *    tts / gptsovits / hearing / fastpath / overlay / session / layer / ack / ambient / call /
 *    dialogue / hotkey / perception / speaker / speech / tool / translate / vad / vision /
 *    window / shutdown / sight / utterance / storyboard / other。
 *    每个文件恰好落入一个组；`other` 是兜底组，`--list` 会打印组内文件数，`--only=other`
 *    也能选中它（分组名与文件前缀都可用于 `--only`）。
 * 3. 每个文件单独起 `node --test --test-reporter=tap`，串行执行；单文件失败继续后面的文件/批次；
 *    批与批之间默认停 2000 ms（`--batch-gap=MS` 可调），让上一个批次的临时目录清理落盘，
 *    减少 EBUSY / ENOTEMPTY 争用。
 * 4. 失败输出命中 EBUSY / ENOTEMPTY / EPERM 时，延迟 500 ms 重跑该文件一次：
 *      - 首次与重跑输出都保留（first / retry），日志文件里两段都带时间戳；
 *      - 重跑通过 -> final: flaky-pass，计入 flaky，不混入普通通过，退出码不受影响；
 *      - 重跑仍失败 -> final: failed，计入失败，退出码非 0。
 * 5. 真机 / 重测试脚本默认排除：
 *      - 显式清单 `LIVE_FILES`（spout-layer / spout-dispose / facefound-live / reasoning-off-live）；
 *      - 文件名以 `-live.mjs` 结尾的脚本；
 *      - 文件头注释里带 `@live` / `DANGER` / `Opt-in` / `SKIP` 行首标记的脚本。
 *    用 `--include-live` 才纳入（仍然会逐个串行跑）；`--list` 用 `[live]` 标出这些文件。
 * 6. 每批输出文件数 / 通过 / flaky / 失败 / 跳过 / 用时；最后汇总失败文件（含错误首行）与总耗时，
 *    并把同一份汇总 + 失败清单 + 总耗时写进 `logs/test-batch-<时间戳>.log` 末尾，
 *    避免“日志只有逐文件记录、没有收尾汇总”。
 *
 * 用法
 * ----
 *   node scripts/test-batch.mjs
 *   node scripts/test-batch.mjs --only=voice
 *   node scripts/test-batch.mjs --only=other       # 兜底组：未匹配任何文件前缀的文件
 *   node scripts/test-batch.mjs --repeat=2 --only=tts
 *   node scripts/test-batch.mjs --list
 *   node scripts/test-batch.mjs --include-live
 *   node scripts/test-batch.mjs --batch-gap=5000
 *
 * 参数
 * ----
 *   --only=a,b        只跑文件名前缀匹配 a 或 b 的测试（`--only=tts` => tts-*.mjs）；
 *                     也可传组名（例如 `--only=other` 选中兜底组）。
 *   --repeat=N        整批重复 N 次（稳定性检查），N >= 1，默认 1。
 *   --include-live    纳入默认排除的真机 / 重测试脚本。
 *   --timeout=MS      单文件超时，默认 300000 ms（5 min）。
 *   --batch-gap=MS    批间间隔，默认 2000 ms（0 关闭）；用于避开临时目录清理的 EBUSY 争用。
 *   --list            只列出批次与文件，不执行（真机 / 重测试项标 `[live]`）。
 *   --help            显示帮助。
 *
 * 退出码
 * ------
 *   0 = 所有入选文件都通过（final: flaky-pass 也算通过）
 *   1 = 至少一个未解决失败（final: failed，含超时、非 EBUSY 失败）
 *   2 = 参数错误 / 没有匹配的测试文件
 */

import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testDir = join(repo, 'test');

/** 批次顺序 = 输出顺序；other 永远最后（兜底组）。 */
const GROUPS = [
  { name: 'voice', prefixes: ['voice-'] },
  { name: 'subtitle', prefixes: ['subtitle-'] },
  { name: 'avatar', prefixes: ['avatar-', 'avatarRuntime'] },
  { name: 'profile', prefixes: ['profile-'] },
  { name: 'vts', prefixes: ['vts-'] },
  { name: 'spout', prefixes: ['spout-'] },
  { name: 'memory', prefixes: ['memory-'] },
  { name: 'asr', prefixes: ['asr-'] },
  { name: 'tts', prefixes: ['tts-'] },
  { name: 'gptsovits', prefixes: ['gptsovits-'] },
  { name: 'hearing', prefixes: ['hearing-'] },
  { name: 'fastpath', prefixes: ['fastpath-'] },
  { name: 'overlay', prefixes: ['overlay-'] },
  { name: 'session', prefixes: ['session-'] },
  { name: 'layer', prefixes: ['layer-'] },
  // 2026-11-08 P-71：以下组此前全部落进 other（61 个文件），现按前缀补成独立批次。
  { name: 'ack', prefixes: ['ack-'] },
  { name: 'ambient', prefixes: ['ambient-'] },
  { name: 'call', prefixes: ['call-mode'] },
  { name: 'dialogue', prefixes: ['dialogue-'] },
  { name: 'hotkey', prefixes: ['hotkey-', 'hotkeys-'] },
  { name: 'perception', prefixes: ['perception-'] },
  { name: 'speaker', prefixes: ['speaker-'] },
  { name: 'speech', prefixes: ['speech-'] },
  { name: 'tool', prefixes: ['tool-'] },
  { name: 'translate', prefixes: ['translate'] },
  { name: 'vad', prefixes: ['vad-'] },
  { name: 'vision', prefixes: ['vision-'] },
  { name: 'window', prefixes: ['window-'] },
  { name: 'shutdown', prefixes: ['shutdown'] },
  { name: 'sight', prefixes: ['sight-'] },
  { name: 'utterance', prefixes: ['utterance-'] },
  { name: 'storyboard', prefixes: ['storyboard-'] },
  { name: 'other', prefixes: [] },
];

/** 显式真机 / 重测试清单：启动 Electron、真实 VTS、真实模型或麦克风录制。 */
const LIVE_FILES = new Set([
  'spout-layer.mjs',
  'spout-dispose.mjs',
  'facefound-live.mjs',
  'reasoning-off-live.mjs',
]);
const LIVE_NAME = /-live\.mjs$/i;
/** 文件头（前 80 行）的显式标记；普通测试里的 "skip" 断言不会匹配行首 `* SKIP`。 */
const HEADER_LIVE = /^\s*(?:\*\s*|\/\/\s*|#\s*)(?:@live|DANGER|OPT-?IN|SKIP)\b/im;
const ENV_ERROR = /\b(?:EBUSY|ENOTEMPTY|EPERM)\b/;
const RETRY_DELAY_MS = 500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(message) {
  console.error(`错误: ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = {
    only: [],
    repeat: 1,
    includeLive: false,
    timeoutMs: 300_000,
    batchGapMs: 2000,
    list: false,
    help: false,
  };

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--include-live') {
      opts.includeLive = true;
    } else if (arg === '--list') {
      opts.list = true;
    } else if (arg.startsWith('--only=')) {
      const value = arg.slice('--only='.length).trim();
      if (!value) fail('--only= 不能为空');
      opts.only.push(
        ...value
          .split(',')
          .map((part) => part.trim().replace(/\.mjs$/i, ''))
          .filter(Boolean),
      );
    } else if (arg.startsWith('--repeat=')) {
      const value = Number(arg.slice('--repeat='.length));
      if (!Number.isInteger(value) || value < 1) fail('--repeat 必须是 >= 1 的整数');
      opts.repeat = value;
    } else if (arg.startsWith('--timeout=')) {
      const value = Number(arg.slice('--timeout='.length));
      if (!Number.isFinite(value) || value < 1000) fail('--timeout 必须是 >= 1000 的毫秒数');
      opts.timeoutMs = value;
    } else if (arg.startsWith('--batch-gap=')) {
      const value = Number(arg.slice('--batch-gap='.length));
      if (!Number.isFinite(value) || value < 0) fail('--batch-gap 必须是 >= 0 的毫秒数');
      opts.batchGapMs = value;
    } else {
      fail(`未知参数: ${arg}（用 --help 查看用法）`);
    }
  }

  return opts;
}

function usage() {
  console.log(`用法: node scripts/test-batch.mjs [选项]

  --only=a,b        只跑文件名前缀或组名匹配的测试（例如 --only=voice / --only=other）
  --repeat=N        整批重复 N 次（默认 1）
  --include-live    纳入默认排除的真机 / 重测试脚本
  --timeout=MS      单文件超时（默认 300000）
  --batch-gap=MS    批间间隔（默认 2000，0 关闭）
  --list            只列出批次与文件
  --help            显示本帮助

默认排除: 显式真机 / 重测试清单（spout-layer.mjs、spout-dispose.mjs、facefound-live.mjs、
reasoning-off-live.mjs）、*-live.mjs，以及文件头带 @live / DANGER / Opt-in / SKIP 行首标记的脚本。
失败命中 EBUSY/ENOTEMPTY/EPERM 时延迟 500 ms 重跑一次，保留首次与重跑两段输出；重跑通过记 flaky。
批间默认停 2000 ms，让临时目录清理落盘；日志末尾写入批次汇总、失败清单与总耗时。`);
}

function headerOf(file) {
  return readFileSync(join(testDir, file), 'utf8').split(/\r?\n/, 80).join('\n');
}

function liveReason(file) {
  if (LIVE_FILES.has(file)) return '真机 / 重测试（显式清单）';
  if (LIVE_NAME.test(file)) return '真机 / opt-in（-live 后缀）';
  if (HEADER_LIVE.test(headerOf(file))) return '真机 / 重测试（文件头标记）';
  return null;
}

function groupFor(file) {
  for (const group of GROUPS) {
    if (group.name === 'other') continue;
    if (group.prefixes.some((prefix) => file.startsWith(prefix))) return group.name;
  }
  return 'other';
}

function matchesOnly(file, only) {
  if (only.length === 0) return true;
  const base = file.replace(/\.mjs$/i, '');
  return only.some((prefix) => base.startsWith(prefix));
}

/** 组名也算 `--only` 的匹配目标，否则 `--only=other` 会静默选中 0 个文件。 */
function selectedByOnly(file, only) {
  return matchesOnly(file, only) || only.includes(groupFor(file));
}

function discover(opts) {
  const all = readdirSync(testDir)
    .filter((name) => name.endsWith('.mjs'))
    .sort((a, b) => a.localeCompare(b));

  const included = [];
  const excluded = [];
  const liveFiles = new Set();
  for (const file of all) {
    const reason = liveReason(file);
    if (reason) liveFiles.add(file);
    if (reason && !opts.includeLive) {
      excluded.push({ file, reason });
      continue;
    }
    if (!selectedByOnly(file, opts.only)) continue;
    included.push(file);
  }

  const byGroup = new Map(GROUPS.map((group) => [group.name, []]));
  for (const file of included) byGroup.get(groupFor(file)).push(file);

  return {
    batches: [...byGroup.entries()]
      .filter(([, files]) => files.length > 0)
      .map(([name, files]) => ({ name, files })),
    excluded,
    liveFiles,
  };
}

function parseTap(output) {
  const count = (key) => {
    const match = output.match(new RegExp(`^# ${key} (\\d+)$`, 'm'));
    return match ? Number(match[1]) : null;
  };
  const tests = count('tests');
  return {
    tests: tests ?? 0,
    pass: count('pass') ?? 0,
    fail: count('fail') ?? 0,
    skipped: count('skipped') ?? 0,
    hasSummary: tests !== null,
  };
}

function firstErrorLine(output, result, timeoutMs) {
  if (result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGTERM') {
    return `timeout after ${timeoutMs} ms`;
  }
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  // TAP 的失败详情有两种形状：
  //   error: 'message'
  //   error: |-
  //     message      <- 取块内第一行非空内容
  const errorIndex = lines.findIndex((line) => /^error:\s*/i.test(line));
  if (errorIndex !== -1) {
    const inline = lines[errorIndex].replace(/^error:\s*/i, '').trim();
    if (inline && inline !== '|-' && inline !== '|') return inline;
    for (let index = errorIndex + 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (line === '...' || /^(?:code|name|expected|actual|operator|stack|location):/i.test(line)) break;
      if (line) return line.replace(/^-\s+/, '');
    }
  }

  for (const line of lines) {
    if (/^not ok\b/i.test(line)) return line;
  }
  for (const line of lines) {
    if (/\b(?:Error|EBUSY|ENOTEMPTY|EPERM)\b/.test(line)) return line;
  }
  return lines[0] ?? '(no output)';
}

function runOnce(file, timeoutMs) {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', join('test', file)], {
    cwd: repo,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  const durationMs = Date.now() - started;
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const timedOut = result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGTERM';
  const ok = result.status === 0 && !timedOut;
  // 被超时杀掉的进程可能留下半截 TAP 汇总；不能把半截 pass 数当成完整结果。
  const tap = timedOut
    ? { tests: 0, pass: 0, fail: 0, skipped: 0, hasSummary: false }
    : parseTap(output);

  return {
    file,
    ok,
    exitCode: result.status,
    timedOut,
    durationMs,
    startedAt,
    output,
    ...tap,
    firstError: ok ? null : firstErrorLine(output, result, timeoutMs),
  };
}

/** 保留一次尝试的完整证据；重跑不再覆盖首次输出。 */
function attemptOf(run) {
  return {
    ok: run.ok,
    exitCode: run.exitCode,
    timedOut: run.timedOut,
    durationMs: run.durationMs,
    startedAt: run.startedAt,
    output: run.output,
    firstError: run.firstError,
  };
}

async function runFile(file, timeoutMs) {
  const first = runOnce(file, timeoutMs);
  if (first.ok) {
    return {
      ...first, status: 'pass', final: 'pass', attempts: 1, retried: false,
      first: attemptOf(first), retry: null,
    };
  }

  if (!ENV_ERROR.test(first.output)) {
    return {
      ...first, status: 'fail', final: 'failed', attempts: 1, retried: false,
      first: attemptOf(first), retry: null,
    };
  }

  await sleep(RETRY_DELAY_MS);
  const retry = runOnce(file, timeoutMs);
  const durationMs = first.durationMs + RETRY_DELAY_MS + retry.durationMs;
  const final = retry.ok ? 'flaky-pass' : 'failed';

  return {
    ...retry,
    status: 'flaky-env',
    final,
    attempts: 2,
    retried: true,
    ok: retry.ok,
    durationMs,
    first: attemptOf(first),
    retry: attemptOf(retry),
    note: retry.ok
      ? '匹配 EBUSY/ENOTEMPTY/EPERM，延迟 500 ms 重跑后通过（首次失败证据已保留）'
      : '匹配 EBUSY/ENOTEMPTY/EPERM，延迟 500 ms 重跑后仍失败（两段证据均已保留）',
  };
}

/** 每次执行都为失败 / 重跑留下可追查的文件证据；路径打印在终端，便于直接核对。 */
function createLogFile(opts) {
  const dir = join(repo, 'logs');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(dir, `test-batch-${stamp}.log`);
  writeFileSync(path, [
    `P-71 分批回归日志 @ ${new Date().toISOString()}`,
    `node ${process.version} | cwd ${repo}`,
    `only=${opts.only.length > 0 ? opts.only.join(',') : '(all)'} repeat=${opts.repeat} includeLive=${opts.includeLive}`,
    '',
  ].join('\n'), 'utf8');
  return path;
}

function appendAttempt(logPath, result, label, attempt) {
  const lines = [
    `--- test/${result.file} ${label} @ ${attempt.startedAt ?? '(unknown)'}`,
    `ok=${attempt.ok} exitCode=${attempt.exitCode ?? 'null'} timedOut=${attempt.timedOut} durationMs=${attempt.durationMs}`,
  ];
  if (attempt.output) lines.push(attempt.output.trimEnd());
  appendFileSync(logPath, `${lines.join('\n')}\n\n`, 'utf8');
}

function logResult(logPath, result, runLabel) {
  if (!result.first) return;
  appendFileSync(logPath, [
    `### test/${result.file} | ${runLabel} | status=${result.status} final=${result.final} attempts=${result.attempts}`,
    `first @ ${result.first.startedAt} ok=${result.first.ok} exit=${result.first.exitCode ?? 'null'} durationMs=${result.first.durationMs}`,
    '',
  ].join('\n'), 'utf8');
  // 正常通过只需一行记录；失败或发生重跑时必须留下完整输出（首次失败段 + 重跑段）。
  if (!result.first.ok || result.retry) appendAttempt(logPath, result, 'first', result.first);
  if (result.retry) appendAttempt(logPath, result, 'retry', result.retry);
}

function formatDuration(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/** 记录执行时的 HEAD 与工作区状态：P-71 的结果必须能追溯到代码版本，而不是“某次运行”。 */
function gitSnapshot() {
  try {
    const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const porcelain = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim();
    const changed = porcelain ? porcelain.split(/\r?\n/).length : 0;
    return `HEAD ${head}${changed > 0 ? `，工作区 ${changed} 项未提交变更` : '，工作区干净'}`;
  } catch {
    return 'git 状态不可用';
  }
}

function pad(value, width) {
  return String(value).padEnd(width);
}

function batchSummaryLines(batches) {
  const lines = [`${pad('batch', 12)} ${pad('files', 5)} ${pad('pass', 5)} ${pad('flaky', 5)} ${pad('fail', 5)} ${pad('skip', 5)} ${pad('time', 8)} result`];
  for (const batch of batches) {
    lines.push(
      `${pad(batch.name, 12)} ${pad(batch.files.length, 5)} ${pad(batch.passFiles, 5)} ${pad(batch.flaky, 5)} ${pad(batch.failFiles, 5)} ${pad(batch.skipped, 5)} ${pad(formatDuration(batch.durationMs), 8)} ${batch.ok ? 'PASS' : 'FAIL'}`,
    );
  }
  return lines;
}

function failureLines(results) {
  const failed = results.filter((result) => !result.ok);
  if (failed.length === 0) return ['  (none)'];
  const lines = [];
  for (const result of failed) {
    const suffix = result.status === 'flaky-env' ? ` (${result.note})` : result.timedOut ? ' (timeout)' : '';
    lines.push(`  - test/${result.file} [${result.status}]${suffix}`);
    lines.push(`      ${result.firstError}`);
    if (result.retry && result.first?.firstError && result.first.firstError !== result.firstError) {
      lines.push(`      首次: ${result.first.firstError}`);
    }
  }
  return lines;
}

function flakyLines(results) {
  const flaky = results.filter((result) => result.final === 'flaky-pass');
  if (flaky.length === 0) return [];
  return [
    'flaky（重跑通过，单独计数，不计入普通通过）',
    ...flaky.map((result) => `  - test/${result.file}`),
  ];
}

function runSummaryLines(run, label) {
  return [
    `${label} 结果: ${run.passFiles}/${run.files} 文件通过, flaky ${run.flakyPassed}, fail ${run.failFiles}, ${run.testsPass} tests pass / ${run.testsFail} fail / ${run.skipped} skipped, 用时 ${formatDuration(run.durationMs)} -> ${run.ok ? 'PASS' : 'FAIL'}`,
  ];
}

function printBatchSummary(batches) {
  console.log('\n批次汇总');
  for (const line of batchSummaryLines(batches)) console.log(line);
}

function printFailures(results) {
  console.log('\n失败文件');
  for (const line of failureLines(results)) console.log(line);
}

function printFlaky(results) {
  const lines = flakyLines(results);
  if (lines.length === 0) return;
  console.log(`\n${lines[0]}`);
  for (const line of lines.slice(1)) console.log(line);
}

function appendLogSummary(logPath, lines) {
  appendFileSync(logPath, `${lines.join('\n')}\n`, 'utf8');
}

async function runBatches(batches, opts, runLabel, logPath) {
  const results = [];

  console.log(`\n${'='.repeat(72)}`);
  console.log(`${runLabel} 开始（${batches.reduce((sum, batch) => sum + batch.files.length, 0)} 个文件，${batches.length} 批，批间串行）`);
  console.log('='.repeat(72));

  for (const [batchIndex, batch] of batches.entries()) {
    if (batchIndex > 0 && opts.batchGapMs > 0) {
      console.log(`\n批间间隔 ${formatDuration(opts.batchGapMs)}（等待临时目录清理落盘）...`);
      await sleep(opts.batchGapMs);
    }
    const batchStarted = Date.now();
    console.log(`\n[${batch.name}] ${batch.files.length} 个文件`);
    const batchResults = [];

    for (const [index, file] of batch.files.entries()) {
      const label = `[${batch.name} ${String(index + 1).padStart(2, '0')}/${String(batch.files.length).padStart(2, '0')}]`;
      process.stdout.write(`${label} ${file} ... `);
      const result = await runFile(file, opts.timeoutMs);
      batchResults.push(result);
      results.push(result);
      logResult(logPath, result, runLabel);

      const counts = result.hasSummary ? `${result.pass}/${result.fail}/${result.skipped}` : 'n/a';
      const status = result.ok ? (result.final === 'flaky-pass' ? 'FLAKY-PASS' : 'PASS') : 'FAIL';
      console.log(`${status} ${counts} ${formatDuration(result.durationMs)}`);
      if (!result.ok) console.log(`      ${result.firstError}`);
      if (result.final === 'flaky-pass') console.log(`      ${result.note}`);
    }

    batch.durationMs = Date.now() - batchStarted;
    batch.passFiles = batchResults.filter((result) => result.ok && result.final === 'pass').length;
    batch.flaky = batchResults.filter((result) => result.final === 'flaky-pass').length;
    batch.failFiles = batchResults.filter((result) => !result.ok).length;
    batch.skipped = batchResults.reduce((sum, result) => sum + (result.skipped ?? 0), 0);
    batch.ok = batch.failFiles === 0;
    console.log(
      `  -> ${batch.name}: ${batch.files.length} files, pass ${batch.passFiles}, flaky ${batch.flaky}, fail ${batch.failFiles}, skip ${batch.skipped}, ${formatDuration(batch.durationMs)}`,
    );
  }

  return results;
}

function summarizeRun(results, batches, durationMs) {
  return {
    results,
    batches,
    durationMs,
    files: results.length,
    passFiles: results.filter((result) => result.ok && result.final === 'pass').length,
    flakyPassed: results.filter((result) => result.final === 'flaky-pass').length,
    flakyFailed: results.filter((result) => result.final === 'failed' && result.retry !== null).length,
    failFiles: results.filter((result) => !result.ok).length,
    testsPass: results.reduce((sum, result) => sum + result.pass, 0),
    testsFail: results.reduce((sum, result) => sum + result.fail, 0),
    skipped: results.reduce((sum, result) => sum + result.skipped, 0),
    ok: results.every((result) => result.ok),
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    usage();
    return;
  }

  const { batches, excluded, liveFiles } = discover(opts);
  const selected = batches.reduce((sum, batch) => sum + batch.files.length, 0);
  if (selected === 0 && !opts.list) {
    const excludedMatch = excluded.filter((entry) => matchesOnly(entry.file, opts.only));
    const hint = excludedMatch.length > 0
      ? '（匹配项可能已被默认排除，用 --list 查看 [live] 项；需要时加 --include-live）'
      : '';
    const known = opts.only.length > 0
      ? `可用组名: ${GROUPS.map((group) => group.name).join(', ')}`
      : '';
    fail((opts.only.length > 0 ? `没有匹配 ${opts.only.join(',')} 的 test/*.mjs` : '没有找到 test/*.mjs') + hint + (known ? `\n${known}` : ''));
  }

  if (opts.list) {
    if (batches.length === 0) console.log('没有入选的测试文件（检查下方默认排除）。');
    const total = batches.reduce((sum, batch) => sum + batch.files.length, 0);
    console.log(`批次清单: ${total} 个非 live 文件 / ${batches.length} 批（每组文件数见方括号）\n`);
    for (const batch of batches) {
      console.log(`[${batch.name}] ${batch.files.length} 个文件`);
      for (const file of batch.files) console.log(`  test/${file}${liveFiles.has(file) ? ' [live]' : ''}`);
    }
    const other = batches.find((batch) => batch.name === 'other');
    if (other) {
      console.log(`\n注意: ${other.files.length} 个文件未匹配任何命名前缀，落在兜底组 [other]（用 --only=other 可单独跑）。`);
    }
    if (excluded.length > 0) {
      console.log('\n默认排除（真机 / 重测试）:');
      for (const entry of excluded) console.log(`  [live] test/${entry.file} — ${entry.reason}`);
    }
    console.log(`\n合计: ${total} 个非 live 文件`);
    if (selected === 0) process.exitCode = 2;
    return;
  }

  const snapshot = gitSnapshot();
  const logPath = createLogFile(opts);
  const selectedFiles = batches.reduce((sum, batch) => sum + batch.files.length, 0);
  appendLogSummary(logPath, [
    `代码版本: ${snapshot}`,
    `入选 ${selectedFiles} 个文件 / ${batches.length} 批`,
    `batchGapMs=${opts.batchGapMs} timeoutMs=${opts.timeoutMs}`,
    '',
  ]);
  console.log(`P-71 分批回归 | node ${process.version} | cwd ${repo}`);
  console.log(`代码版本: ${snapshot}`);
  console.log(`日志文件: ${logPath}`);
  console.log(`入选 ${selectedFiles} 个文件 / ${batches.length} 批；每批串行，批间顺序执行，批间间隔 ${formatDuration(opts.batchGapMs)}。`);
  if (excluded.length > 0 && !opts.includeLive) {
    console.log('默认排除真机 / 重测试脚本:');
    for (const entry of excluded) console.log(`  [live] test/${entry.file}（${entry.reason}）`);
  }
  if (opts.includeLive) console.log('注意: --include-live 已开启，真机 / 重测试脚本会被执行。');
  console.log('失败命中 EBUSY/ENOTEMPTY/EPERM 时，延迟 500 ms 重跑一次；首次与重跑输出都会写入日志。');

  const started = Date.now();
  const runs = [];

  for (let repeat = 1; repeat <= opts.repeat; repeat += 1) {
    const label =
      opts.repeat === 1
        ? opts.only.length > 0
          ? '分批执行'
          : '全量分批'
        : `第 ${repeat}/${opts.repeat} 轮`;
    const runStarted = Date.now();
    const results = await runBatches(batches, opts, label, logPath);
    const run = summarizeRun(results, batches, Date.now() - runStarted);
    runs.push(run);

    printBatchSummary(batches);
    printFailures(results);
    printFlaky(results);
    console.log(`\n${runSummaryLines(run, label)[0]}`);

    const flaky = flakyLines(results);
    appendLogSummary(logPath, [
      '',
      '='.repeat(72),
      `${label} 汇总 @ ${new Date().toISOString()}`,
      '='.repeat(72),
      '批次汇总',
      ...batchSummaryLines(batches),
      '',
      '失败文件',
      ...failureLines(results),
      ...(flaky.length > 0 ? ['', ...flaky] : []),
      '',
      ...runSummaryLines(run, label),
      '',
    ]);
  }

  if (opts.repeat > 1) {
    const history = new Map();
    for (const run of runs) {
      for (const result of run.results) {
        const entry = history.get(result.file) ?? { pass: 0, fail: 0, flakyPassed: 0, flakyFailed: 0 };
        if (result.ok) entry.pass += 1;
        else entry.fail += 1;
        if (result.final === 'flaky-pass') entry.flakyPassed += 1;
        if (result.final === 'failed' && result.retry !== null) entry.flakyFailed += 1;
        history.set(result.file, entry);
      }
    }
    const unstable = [...history.entries()].filter(([, entry]) => entry.pass > 0 && entry.fail > 0);
    const alwaysFailed = [...history.entries()].filter(([, entry]) => entry.pass === 0 && entry.fail > 0);

    console.log(`\n${'='.repeat(72)}`);
    console.log(`重复汇总（${opts.repeat} 轮）`);
    console.log('='.repeat(72));
    console.log(`${pad('run', 6)} ${pad('files', 5)} ${pad('pass', 5)} ${pad('flaky', 5)} ${pad('fail', 5)} ${pad('tests', 12)} ${pad('time', 8)} result`);
    for (const [index, run] of runs.entries()) {
      console.log(
        `${pad(index + 1, 6)} ${pad(run.files, 5)} ${pad(run.passFiles, 5)} ${pad(run.flakyPassed, 5)} ${pad(run.failFiles, 5)} ${pad(`${run.testsPass}/${run.testsFail}`, 12)} ${pad(formatDuration(run.durationMs), 8)} ${run.ok ? 'PASS' : 'FAIL'}`,
      );
    }
    const totalFileRuns = runs.reduce((sum, run) => sum + run.files, 0);
    const totalPass = runs.reduce((sum, run) => sum + run.passFiles, 0);
    const totalFail = runs.reduce((sum, run) => sum + run.failFiles, 0);
    const totalFlaky = runs.reduce((sum, run) => sum + run.flakyPassed, 0);
    console.log(
      `\n合计: ${runs.length} 轮 / ${totalFileRuns} file-runs, pass ${totalPass}, flaky ${totalFlaky}, fail ${totalFail}, 用时 ${formatDuration(Date.now() - started)}`,
    );
    if (unstable.length > 0) {
      console.log('不稳定的文件（同一文件多轮结果不一致）:');
      for (const [file, entry] of unstable) console.log(`  - test/${file} pass=${entry.pass} fail=${entry.fail}`);
    }
    if (alwaysFailed.length > 0) {
      console.log('每轮都失败的文件:');
      for (const [file] of alwaysFailed) console.log(`  - test/${file}`);
    }
  }

  // 任意一轮有未解决失败即判 FAIL；同文件跨轮 pass/fail 混合也已经被该条件覆盖，
  // 上面的“重复汇总”会单独列出这些不稳定的文件。
  const overallOk = runs.every((run) => run.ok);

  console.log(`\n总耗时 ${formatDuration(Date.now() - started)}`);
  console.log(`最终结果: ${overallOk ? 'PASS' : 'FAIL'}（退出码 ${overallOk ? 0 : 1}）`);
  appendLogSummary(logPath, [
    '='.repeat(72),
    `最终结果: ${overallOk ? 'PASS' : 'FAIL'}（退出码 ${overallOk ? 0 : 1}）`,
    `总耗时 ${formatDuration(Date.now() - started)}`,
    `日志: ${logPath}`,
    '='.repeat(72),
    '',
  ]);
  process.exitCode = overallOk ? 0 : 1;
}

await main();
