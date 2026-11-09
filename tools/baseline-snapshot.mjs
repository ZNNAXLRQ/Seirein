#!/usr/bin/env node
/**
 * P-47 基线快照 CLI（只读）。
 *
 * 一条命令读取 `/assistant/status`，产出稳定的基线 JSON：
 *
 *   node tools/baseline-snapshot.mjs
 *   node tools/baseline-snapshot.mjs --out reports/baseline-<timestamp>.json
 *   node tools/baseline-snapshot.mjs --url http://127.0.0.1:52524/assistant/status
 *   node tools/baseline-snapshot.mjs --commit <sha>
 *
 * 只做三件事：GET status、从本机读取可选版本（git / Electron manifest / 进程事实）、
 * 写 JSON。**不启动 VTS/OBS，不读 events，不写事件，不修改 settings。**
 *
 * 退出码：
 *   0  成功（或 --help）
 *   1  请求失败、响应非法、写文件失败
 *   2  参数错误
 *
 * 宿主事件接线尚未实现；成功时会在 stderr 说明这一事实，stdout 始终只有 JSON。
 */
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { release as osRelease, type as osType } from 'node:os';
import { fileURLToPath } from 'node:url';

import { buildBaselineSnapshot } from '../src/host/runtime/baseline.js';

export const DEFAULT_STATUS_URL = 'http://127.0.0.1:52524/assistant/status';
export const DEFAULT_TIMEOUT_MS = 5000;
export const MIN_TIMEOUT_MS = 1;
export const MAX_TIMEOUT_MS = 120000;

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COMMIT_PATTERN = /^[0-9a-f]{7,64}$/iu;

export const USAGE = `P-47 基线快照（只读）

用法:
  node tools/baseline-snapshot.mjs [选项]

选项:
  --url <url>       读取状态接口，默认 ${DEFAULT_STATUS_URL}
  --out <file>      写 JSON 文件；省略或传 - 时写到 stdout
  --commit [sha]    读取 git rev-parse HEAD，或显式指定 7–64 位十六进制 commit
  --no-commit       不读取 commit（输出 null）
  --timeout <ms>    状态请求超时，1–${MAX_TIMEOUT_MS}，默认 ${DEFAULT_TIMEOUT_MS}
  -h, --help        显示本帮助

说明:
  - 只读：不启动 VTS/OBS，不读事件，不写事件，不修改 settings。
  - 宿主事件接线尚未实现；本命令只产出基线 JSON。
  - 拿不到的字段写 null；不猜、不透传 status 的路径 / token / 对话正文。
`;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function writeTo(stream, text) {
  if (stream !== null && stream !== undefined && typeof stream.write === 'function') {
    stream.write(text);
  }
}

/** 把异常压成一行，保留 cause 消息与 `ECONNREFUSED` 这类可操作的错误码。 */
function describeError(error) {
  const cause = error?.cause;
  const code = cause?.code ?? cause?.errno ?? error?.code;
  const parts = [String(error?.message ?? error ?? 'unknown error')];
  const causeMessage = cause?.message;
  if (typeof causeMessage === 'string' && causeMessage.trim() !== ''
    && !parts[0].includes(causeMessage)) {
    parts.push(causeMessage);
  }
  const message = parts.join(': ');
  return code !== undefined && !message.includes(String(code)) ? `${message} (${code})` : message;
}

/** 展示给用户的 URL：去掉 userinfo / query / hash，避免把 token 回显到 stderr。 */
function displayUrl(url) {
  return `${url.origin}${url.pathname}`;
}

/**
 * 解析参数。显式抛错，调用方统一转成退出码 2。
 *
 * `--commit` 可带值也可不带：带值表示显式 commit，不带值表示运行时执行 `git rev-parse HEAD`。
 */
export function parseArgs(argv = []) {
  const args = {
    url: DEFAULT_STATUS_URL,
    out: null,
    commit: true,
    timeoutMs: DEFAULT_TIMEOUT_MS,
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
      case '--url':
        args.url = takeValue('--url');
        break;
      case '--out':
        args.out = takeValue('--out');
        break;
      case '--timeout': {
        const raw = takeValue('--timeout');
        const timeoutMs = Number(raw);
        if (!Number.isInteger(timeoutMs)
          || timeoutMs < MIN_TIMEOUT_MS
          || timeoutMs > MAX_TIMEOUT_MS) {
          throw new Error(`--timeout must be an integer from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS} ms`);
        }
        args.timeoutMs = timeoutMs;
        break;
      }
      case '--commit': {
        if (inline !== null) {
          args.commit = inline === '' ? true : inline;
          break;
        }
        const next = argv[index + 1];
        if (next !== undefined && !String(next).startsWith('-')) {
          args.commit = String(next);
          index += 1;
        } else {
          args.commit = true;
        }
        break;
      }
      case '--no-commit':
        args.commit = false;
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
  if (typeof args.commit === 'string') {
    const value = args.commit.trim();
    if (!COMMIT_PATTERN.test(value)) {
      throw new Error('--commit must be a 7-64 character hexadecimal commit');
    }
    args.commit = value.toLowerCase();
  }
  return args;
}

/** 读取 HEAD；git 不可用、超时或不在仓库内都只返回 null，不阻塞主流程。 */
export function readGitCommit(repoRoot) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
    }).trim();
  } catch {
    return null;
  }
}

/** 本地 Electron 版本（可选）：CLI 本身跑在 Node 下，只能从已安装 manifest 读。 */
export async function readLocalElectron(repoRoot) {
  try {
    const text = await readFile(resolve(repoRoot, 'node_modules', 'electron', 'package.json'), 'utf8');
    const manifest = JSON.parse(text);
    return typeof manifest.version === 'string' && manifest.version.trim() !== ''
      ? manifest.version.trim()
      : null;
  } catch {
    return null;
  }
}

/**
 * 带硬超时的 GET。除了 AbortController，还和定时器竞速：
 * 即使注入的 fetch 不响应 abort，调用也不会挂起。
 */
async function fetchStatus(url, fetchImpl, timeoutMs) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is not available');
  const controller = new AbortController();
  let timedOut = false;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      const error = new Error(`timed out after ${timeoutMs} ms`);
      error.name = 'TimeoutError';
      reject(error);
    }, timeoutMs);
  });
  try {
    const response = await Promise.race([
      fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        cache: 'no-store',
        signal: controller.signal,
      }),
      timeout,
    ]);
    return response;
  } catch (error) {
    if (timedOut) {
      const timeoutError = new Error(`timed out after ${timeoutMs} ms`);
      timeoutError.name = 'TimeoutError';
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 读取响应体也带硬超时：服务端可以只发响应头、不结束 body，不能让 CLI 卡在 `json()`。
 */
async function readResponseJson(response, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`timed out after ${timeoutMs} ms while reading the response body`);
      error.name = 'TimeoutError';
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([response.json(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * CLI 主体。所有外部依赖都可注入，测试不需要真实网络、git 或 Electron。
 *
 * @returns {Promise<number>} 退出码。
 */
export async function runBaselineSnapshot({
  argv = [],
  fetchImpl = globalThis.fetch,
  cwd = process.cwd(),
  repoRoot = SCRIPT_ROOT,
  env = null,
  stdout = process.stdout,
  stderr = process.stderr,
  now = () => new Date(),
  readCommit = readGitCommit,
  readElectron = readLocalElectron,
} = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    writeTo(stderr, `baseline-snapshot: ${error.message}\n`);
    writeTo(stderr, USAGE);
    return 2;
  }
  if (args.help) {
    writeTo(stdout, USAGE);
    return 0;
  }

  let url;
  try {
    url = new URL(args.url);
  } catch {
    writeTo(stderr, 'baseline-snapshot: --url is not a valid URL\n');
    return 2;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    writeTo(stderr, 'baseline-snapshot: --url must use http or https\n');
    return 2;
  }
  if (url.username !== '' || url.password !== '') {
    writeTo(stderr, 'baseline-snapshot: --url must not contain credentials\n');
    return 2;
  }
  const target = displayUrl(url);

  let response;
  try {
    response = await fetchStatus(url.href, fetchImpl, args.timeoutMs);
  } catch (error) {
    writeTo(stderr, `baseline-snapshot: cannot read status from ${target}: ${describeError(error)}\n`);
    return 1;
  }
  if (response === null || response === undefined || response.ok !== true) {
    const status = response?.status ?? 'unknown';
    const statusText = response?.statusText ? ` ${response.statusText}` : '';
    writeTo(stderr, `baseline-snapshot: status endpoint ${target} returned HTTP ${status}${statusText}\n`);
    return 1;
  }

  let status;
  try {
    status = await readResponseJson(response, args.timeoutMs);
  } catch (error) {
    if (error?.name === 'TimeoutError') {
      writeTo(stderr, `baseline-snapshot: cannot read status from ${target}: ${describeError(error)}\n`);
    } else {
      writeTo(stderr, `baseline-snapshot: status from ${target} is not valid JSON: ${describeError(error)}\n`);
    }
    return 1;
  }
  if (!isPlainObject(status)) {
    writeTo(stderr, `baseline-snapshot: status from ${target} is not a JSON object\n`);
    return 1;
  }
  if (status.ok === false) {
    writeTo(stderr, `baseline-snapshot: status endpoint ${target} reported ok:false\n`);
    return 1;
  }

  let commit = null;
  if (args.commit === true) {
    commit = typeof readCommit === 'function' ? readCommit(repoRoot) : null;
  } else if (typeof args.commit === 'string') {
    commit = args.commit;
  }

  let environment = env;
  if (!isPlainObject(environment)) {
    let electron = process.versions.electron ?? null;
    if (electron === null && typeof readElectron === 'function') {
      try {
        electron = await readElectron(repoRoot);
      } catch {
        electron = null;
      }
    }
    environment = {
      electron,
      node: process.version,
      os: `${osType()} ${osRelease()}`,
    };
  }

  let at;
  try {
    at = now();
  } catch {
    at = null;
  }

  const snapshot = buildBaselineSnapshot({
    commit,
    status,
    env: environment,
    at,
  });
  const json = `${JSON.stringify(snapshot, null, 2)}\n`;

  if (args.out === null || args.out === '-') {
    writeTo(stdout, json);
  } else {
    const outPath = resolve(cwd, args.out);
    try {
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, json, 'utf8');
    } catch (error) {
      writeTo(stderr, `baseline-snapshot: cannot write ${outPath}: ${describeError(error)}\n`);
      return 1;
    }
    writeTo(stderr, `baseline-snapshot: wrote ${outPath}\n`);
  }
  // 事件接线留给后续；明确说明没有写事件，避免把“没写”误读成“写失败”。
  writeTo(stderr, 'baseline-snapshot: host event not written (host wiring pending)\n');
  return 0;
}

function isDirectInvocation() {
  if (typeof process.argv[1] !== 'string' || process.argv[1] === '') return false;
  const invoked = resolve(process.argv[1]);
  const self = resolve(fileURLToPath(import.meta.url));
  return process.platform === 'win32'
    ? invoked.toLowerCase() === self.toLowerCase()
    : invoked === self;
}

if (isDirectInvocation()) {
  runBaselineSnapshot({ argv: process.argv.slice(2) })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`baseline-snapshot: unexpected failure: ${error?.stack ?? error}`);
      process.exitCode = 1;
    });
}
