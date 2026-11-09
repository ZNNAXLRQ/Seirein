/**
 * P-47 基线快照：纯构建器 + CLI 参数/输出/失败路径。
 *
 * 测试不联网、不启动 VTS/OBS、不读写仓库里的运行数据：
 * - 构建器用内存里的 status 对象验证字段来源、缺省值与隐私边界；
 * - CLI 注入 fake fetch / fake commit / 固定时钟，输出写到内存流或临时目录；
 * - 失败路径包括连接错误、HTTP 非 2xx、坏 JSON、超时与参数错误。
 *
 * Run: node --test test/baseline-snapshot.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildBaselineSnapshot } from '../src/host/runtime/diagnostics/baseline.js';
import {
  DEFAULT_STATUS_URL,
  DEFAULT_TIMEOUT_MS,
  parseArgs,
  runBaselineSnapshot,
} from '../tools/baseline-snapshot.mjs';

const COMMIT = 'c0b0f8de5e45bcad9fcebf26b0e9d639cbcbf1c1';
const AT = '2026-11-09T16:52:38+08:00';
const AT_ISO = '2026-11-09T08:52:38.000Z';
const TOP_LEVEL_KEYS = [
  'commit',
  'version',
  'model',
  'protocol',
  'reasoning',
  'input',
  'tts',
  'versions',
  'at',
];

/** 内存流：CLI 测试不碰真实 stdout/stderr。 */
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

/** 返回固定 status 的 fake fetch，并记录调用参数。 */
function statusFetch(status, calls = []) {
  return async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => status,
    };
  };
}

/** 统一的 CLI 运行器：固定时钟 / commit / 环境，其余依赖按需覆盖。 */
async function run(options = {}) {
  const stdout = capture();
  const stderr = capture();
  const code = await runBaselineSnapshot({
    stdout,
    stderr,
    now: () => new Date(AT),
    readCommit: () => COMMIT,
    readElectron: async () => null,
    env: {
      electron: null,
      node: 'v24.22.2',
      os: 'Windows_NT 10.0.26100',
    },
    ...options,
  });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

function assertShape(snapshot) {
  assert.deepEqual(Object.keys(snapshot), TOP_LEVEL_KEYS);
  assert.deepEqual(Object.keys(snapshot.model), ['provider', 'id']);
  assert.deepEqual(Object.keys(snapshot.reasoning), ['requested', 'applied']);
  assert.deepEqual(Object.keys(snapshot.input), ['tokensAvailable', 'cacheStatsAvailable']);
  assert.deepEqual(Object.keys(snapshot.tts), ['backend', 'voice', 'weightsCold']);
  assert.deepEqual(Object.keys(snapshot.versions), ['electron', 'vts', 'obs', 'node', 'os']);
}

// ---------------------------------------------------------------------------
// 1) 纯构建器
// ---------------------------------------------------------------------------

test('构建器：正常输入产出固定结构，显式参数优先', () => {
  const snapshot = buildBaselineSnapshot({
    commit: COMMIT.toUpperCase(),
    status: { version: '0.99.0' },
    env: { electron: '45.2.3', node: 'v24.22.2', os: 'Windows_NT 10.0.26100' },
    versions: { vts: '1.0', obs: '31.0.1' },
    model: { provider: 'deepseek-account', id: 'deepseek-flash' },
    tts: { backend: 'gpt-sovits', voice: 'Hina', weightsCold: false },
    at: AT,
  });
  assertShape(snapshot);
  assert.equal(snapshot.commit, COMMIT);
  assert.equal(snapshot.version, '0.99.0');
  assert.deepEqual(snapshot.model, { provider: 'deepseek-account', id: 'deepseek-flash' });
  assert.equal(snapshot.protocol, null);
  assert.deepEqual(snapshot.reasoning, { requested: null, applied: null });
  assert.deepEqual(snapshot.input, { tokensAvailable: null, cacheStatsAvailable: false });
  assert.deepEqual(snapshot.tts, { backend: 'gpt-sovits', voice: 'Hina', weightsCold: false });
  assert.deepEqual(snapshot.versions, {
    electron: '45.2.3',
    vts: '1.0',
    obs: '31.0.1',
    node: 'v24.22.2',
    os: 'Windows_NT 10.0.26100',
  });
  assert.equal(snapshot.at, AT_ISO);
});

test('构建器：能从 status 读到的字段全部落位，未知字段保持 null', () => {
  const snapshot = buildBaselineSnapshot({
    status: {
      version: '0.99.0',
      model: { provider: 'deepseek-account', id: 'deepseek-flash' },
      protocol: 'openai-chat',
      reasoning: { requested: 'off', applied: 'unsupported' },
      input: { tokensAvailable: true, cacheStatsAvailable: true },
      tts: {
        voice: 'zh-CN-XiaoxiaoNeural',
        gptSovits: { enabled: true },
      },
      live2d: { spoutLayer: { versions: { electron: '45.2.3', node: '24.22.2' } } },
      obsVersion: '31.0.1',
    },
    env: { node: 'v24.0.0', os: 'Windows_NT 10.0' },
    at: AT,
  });
  assertShape(snapshot);
  assert.equal(snapshot.version, '0.99.0');
  assert.deepEqual(snapshot.model, { provider: 'deepseek-account', id: 'deepseek-flash' });
  assert.equal(snapshot.protocol, 'openai-chat');
  assert.deepEqual(snapshot.reasoning, { requested: 'off', applied: 'unsupported' });
  assert.deepEqual(snapshot.input, { tokensAvailable: true, cacheStatsAvailable: true });
  assert.deepEqual(snapshot.tts, {
    backend: 'gpt-sovits',
    voice: 'zh-CN-XiaoxiaoNeural',
    weightsCold: null,
  });
  // Electron 用 Spout 的明确版本；Node 用 CLI 进程事实（不拿 Spout 子进程的 Node 冒充宿主）。
  assert.equal(snapshot.versions.electron, '45.2.3');
  assert.equal(snapshot.versions.node, 'v24.0.0');
  assert.equal(snapshot.versions.obs, '31.0.1');
  assert.equal(snapshot.versions.vts, null);
  assert.equal(snapshot.versions.os, 'Windows_NT 10.0');
});

test('构建器：缺字段 / 脏值给 null，不猜、不把占位值当观测值', () => {
  const empty = buildBaselineSnapshot();
  assertShape(empty);
  assert.deepEqual(empty, {
    commit: null,
    version: null,
    model: { provider: null, id: null },
    protocol: null,
    reasoning: { requested: null, applied: null },
    input: { tokensAvailable: null, cacheStatsAvailable: false },
    tts: { backend: null, voice: null, weightsCold: null },
    versions: { electron: null, vts: null, obs: null, node: null, os: null },
    at: null,
  });
  // 空参数与 null 参数形状一致（纯函数不因调用形式改变输出）。
  assert.deepEqual(buildBaselineSnapshot(null), empty);

  const dirty = buildBaselineSnapshot({
    commit: 'not-a-commit',
    status: {
      version: 42,
      model: { provider: 'file:///C:/Users/alice/Seirein', id: 'alice@example.com' },
      protocol: { foo: 'bar' },
      reasoning: { requested: 'unknown', applied: '' },
      input: { tokensAvailable: 'yes', cacheStatsAvailable: null },
      tts: { backend: 'D:\\tts\\backend.exe', gptSovits: { enabled: null } },
    },
    at: 'not-a-date',
  });
  assertShape(dirty);
  assert.equal(dirty.commit, null);
  assert.equal(dirty.version, null);
  assert.deepEqual(dirty.model, { provider: null, id: null });
  assert.equal(dirty.protocol, null);
  assert.deepEqual(dirty.reasoning, { requested: null, applied: null });
  assert.deepEqual(dirty.input, { tokensAvailable: null, cacheStatsAvailable: false });
  assert.deepEqual(dirty.tts, { backend: null, voice: null, weightsCold: null });
  assert.equal(dirty.at, null);
});

test('构建器：输出不含路径、邮箱、token 或对话正文', () => {
  const snapshot = buildBaselineSnapshot({
    status: {
      version: '0.99.0',
      root: 'C:\\Users\\alice\\Seirein',
      token: 'sk-very-secret-token',
      email: 'alice@example.com',
      messages: [{ role: 'user', text: 'private dialogue' }],
      live2d: {
        model: 'hiyori',
        spoutLayer: { versions: { electron: '45.2.3', bridgePath: 'D:\\Programs\\Seirein\\bridge.node' } },
      },
      tts: {
        gptSovits: {
          enabled: true,
          voice: 'Hina',
          refAudioPath: 'G:\\Seirein\\voice\\secret.wav',
        },
      },
      autostart: { obs: { path: 'D:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe' } },
    },
    at: AT,
  });
  const text = JSON.stringify(snapshot);
  for (const leak of [
    'C:\\Users',
    'G:\\Seirein',
    'D:\\Program',
    'sk-very-secret-token',
    'alice@example.com',
    'private dialogue',
    'bridgePath',
    'refAudioPath',
    'obs-studio',
    'hiyori',
  ]) {
    assert.equal(text.includes(leak), false, `unexpected leak: ${leak}`);
  }
  assert.equal(snapshot.tts.backend, 'gpt-sovits');
  assert.equal(snapshot.tts.voice, 'Hina');
  assert.equal(snapshot.versions.electron, '45.2.3');
});

// ---------------------------------------------------------------------------
// 2) CLI 参数解析
// ---------------------------------------------------------------------------

test('CLI 参数：默认值、显式值与错误输入', () => {
  assert.deepEqual(parseArgs([]), {
    url: DEFAULT_STATUS_URL,
    out: null,
    commit: true,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    help: false,
  });
  const explicit = parseArgs([
    '--url', 'http://127.0.0.1:1234/assistant/status',
    '--out', 'reports/baseline.json',
    '--commit', 'C0B0F8D',
    '--timeout', '2500',
  ]);
  assert.equal(explicit.url, 'http://127.0.0.1:1234/assistant/status');
  assert.equal(explicit.out, 'reports/baseline.json');
  assert.equal(explicit.commit, 'c0b0f8d');
  assert.equal(explicit.timeoutMs, 2500);

  assert.equal(parseArgs(['--commit']).commit, true);
  assert.equal(parseArgs(['--commit=deadbeef']).commit, 'deadbeef');
  assert.equal(parseArgs(['--no-commit']).commit, false);
  assert.equal(parseArgs(['--out', '-']).out, '-');
  assert.equal(parseArgs(['--help']).help, true);

  for (const argv of [
    ['--bogus'],
    ['--url'],
    ['--out'],
    ['--timeout', '0'],
    ['--timeout', 'abc'],
    ['--timeout', '120001'],
    ['--commit', 'HEAD'],
    ['--commit', 'deadbe'],
    ['positional'],
  ]) {
    assert.throws(() => parseArgs(argv), Error, `expected parse failure: ${argv.join(' ')}`);
  }
});

// ---------------------------------------------------------------------------
// 3) CLI 成功路径
// ---------------------------------------------------------------------------

test('CLI：默认 URL、stdout JSON、结构稳定且不写事件', async () => {
  const calls = [];
  const status = {
    version: '0.99.0',
    model: { provider: 'deepseek-account', id: 'deepseek-flash' },
    protocol: 'openai-chat',
    reasoning: { requested: 'off', applied: 'off' },
    input: { tokensAvailable: true, cacheStatsAvailable: true },
    tts: { gptSovits: { enabled: false } },
    live2d: { spoutLayer: { versions: { electron: '45.2.3' } } },
    obsVersion: '31.0.1',
  };
  const first = await run({ fetchImpl: statusFetch(status, calls) });
  assert.equal(first.code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, DEFAULT_STATUS_URL);
  assert.match(first.stderr, /host event not written \(host wiring pending\)/);
  assert.doesNotMatch(first.stdout, /host event/);

  const snapshot = JSON.parse(first.stdout);
  assertShape(snapshot);
  assert.equal(snapshot.commit, COMMIT);
  assert.equal(snapshot.version, '0.99.0');
  assert.deepEqual(snapshot.model, { provider: 'deepseek-account', id: 'deepseek-flash' });
  assert.equal(snapshot.protocol, 'openai-chat');
  assert.deepEqual(snapshot.reasoning, { requested: 'off', applied: 'off' });
  assert.deepEqual(snapshot.input, { tokensAvailable: true, cacheStatsAvailable: true });
  assert.deepEqual(snapshot.tts, { backend: 'edge-tts', voice: null, weightsCold: null });
  assert.equal(snapshot.versions.electron, '45.2.3');
  assert.equal(snapshot.versions.obs, '31.0.1');
  assert.equal(snapshot.versions.node, 'v24.22.2');
  assert.equal(snapshot.versions.os, 'Windows_NT 10.0.26100');
  assert.equal(snapshot.at, AT_ISO);
  assert.ok(first.stdout.endsWith('\n'));
  assert.equal(first.stdout, `${JSON.stringify(snapshot, null, 2)}\n`);

  // 同一输入、同一时钟 → 同一份 JSON（字段顺序与格式稳定）。
  const second = await run({ fetchImpl: statusFetch(status, []) });
  assert.equal(second.stdout, first.stdout);
});

test('CLI：--out 写文件、自动建父目录，stdout 为空', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'baseline-snapshot-test-'));
  try {
    const out = join(dir, 'nested', 'baseline.json');
    const result = await run({
      argv: ['--out', out],
      fetchImpl: statusFetch({ version: '0.99.0' }),
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /wrote /);
    const text = await readFile(out, 'utf8');
    assert.ok(text.endsWith('\n'));
    const snapshot = JSON.parse(text);
    assertShape(snapshot);
    assert.equal(snapshot.version, '0.99.0');
    assert.equal(snapshot.commit, COMMIT);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('CLI：--no-commit 与显式 --commit', async () => {
  const noCommit = await run({
    argv: ['--no-commit'],
    fetchImpl: statusFetch({ version: '0.99.0' }),
  });
  assert.equal(noCommit.code, 0);
  assert.equal(JSON.parse(noCommit.stdout).commit, null);

  const explicit = await run({
    argv: ['--commit', 'ABCDEF1'],
    fetchImpl: statusFetch({ version: '0.99.0' }),
  });
  assert.equal(explicit.code, 0);
  assert.equal(JSON.parse(explicit.stdout).commit, 'abcdef1');
});

test('CLI：--help 不请求 status', async () => {
  const result = await run({
    argv: ['--help'],
    fetchImpl: async () => {
      throw new Error('help must not fetch');
    },
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /P-47 基线快照/);
  assert.match(result.stdout, /--url <url>/);
  assert.equal(result.stderr, '');
});

// ---------------------------------------------------------------------------
// 4) CLI 失败路径
// ---------------------------------------------------------------------------

test('CLI：连接失败退出非 0、错误清晰且不挂起', async () => {
  const failure = new TypeError('fetch failed');
  failure.cause = { code: 'ECONNREFUSED' };
  const result = await run({
    argv: ['--url', 'http://127.0.0.1:1/assistant/status'],
    fetchImpl: async () => {
      throw failure;
    },
  });
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /http:\/\/127\.0\.0\.1:1\/assistant\/status/);
  assert.match(result.stderr, /ECONNREFUSED/);
  assert.doesNotMatch(result.stderr, /host event not written/);
});

test('CLI：HTTP 非 2xx / 坏 JSON / 非对象响应都退出 1', async () => {
  const http = await run({
    fetchImpl: async () => ({ ok: false, status: 503, statusText: 'Service Unavailable' }),
  });
  assert.equal(http.code, 1);
  assert.match(http.stderr, /HTTP 503 Service Unavailable/);

  const badJson = await run({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('bad json');
      },
    }),
  });
  assert.equal(badJson.code, 1);
  assert.match(badJson.stderr, /not valid JSON/);
  assert.match(badJson.stderr, /bad json/);

  const notObject = await run({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => [] }),
  });
  assert.equal(notObject.code, 1);
  assert.match(notObject.stderr, /not a JSON object/);

  const reportedFailure = await run({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: false }) }),
  });
  assert.equal(reportedFailure.code, 1);
  assert.match(reportedFailure.stderr, /reported ok:false/);
});

test('CLI：请求超时退出 1 且提示毫秒数', async () => {
  const result = await run({
    argv: ['--timeout', '20'],
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      // 不主动完成；只响应 abort，模拟一个已经连上但不返回的对端。
      init.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    }),
  });
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /timed out after 20 ms/);
});

test('CLI：响应体读取超时也不会挂起', async () => {
  const result = await run({
    argv: ['--timeout', '20'],
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      // 响应头到了但 body 永远不结束。
      json: () => new Promise(() => {}),
    }),
  });
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /timed out after 20 ms while reading the response body/);
});

test('CLI：参数错误退出 2，且不请求 status', async () => {
  let fetched = false;
  const result = await run({
    argv: ['--bogus'],
    fetchImpl: async () => {
      fetched = true;
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  assert.equal(result.code, 2);
  assert.equal(fetched, false);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /unknown argument: --bogus/);
  assert.match(result.stderr, /P-47 基线快照/);

  const badUrl = await run({
    argv: ['--url', 'not a url'],
    fetchImpl: async () => {
      fetched = true;
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  assert.equal(badUrl.code, 2);
  assert.equal(fetched, false);
  assert.match(badUrl.stderr, /not a valid URL/);

  const credentials = await run({
    argv: ['--url', 'http://user:token@127.0.0.1:1/assistant/status'],
    fetchImpl: async () => {
      fetched = true;
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  assert.equal(credentials.code, 2);
  assert.equal(fetched, false);
  assert.match(credentials.stderr, /must not contain credentials/);
});
