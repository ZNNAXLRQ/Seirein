/**
 * P-111 客户端诊断通道（MVP）回归。
 *
 * 从 client.js 抽出真正发货的 `diagnosticsSection` / `diagnosticsView` / `loadDiagnosticsStatus`
 * 等函数，用记录型 `h` 求值（与 hearing-ui / audio-retention-ui 相同的做法）：不需要 DOM、React
 * 或宿主。这里固定用户实际能看到、点到的东西：
 *   1. 五个分区在有数据 / 缺字段 / 读取失败时的渲染；
 *   2. 打开一次只发一个 `/assistant/status` 请求，渲染不会额外发请求；
 *   3. 复制的报告是纯文本 JSON，且不含转写/字幕/音频等用户内容；
 *   4. 「刷新」重新拉取一次，诊断代码里没有 setInterval；
 *   5. 回归：lexicon-ui、audio-retention-ui、hearing-ui、smoke。
 *
 * Run: node --test test/client-diagnostics.mjs
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, '..');
const clientSource = readFileSync(join(projectRoot, 'client.js'), 'utf8');

const BLOCK_FROM = clientSource.indexOf('    const DIAGNOSTICS_READ_TIMEOUT_MS');
const BLOCK_TO = clientSource.indexOf('    function Panel() {', BLOCK_FROM);
assert.ok(BLOCK_FROM > 0 && BLOCK_TO > BLOCK_FROM, 'client.js ships the diagnostics block before Panel');
const diagnosticsBlock = clientSource.slice(BLOCK_FROM, BLOCK_TO);

/** Recording element factory: every node keeps its type, props and children. */
const h = (type, props, ...children) => ({ type, props: props ?? {}, children });
const styles = new Proxy({}, { get: (_target, key) => ({ marker: String(key) }) });

/**
 * Evaluate the shipped block with an explicit fetch and clipboard seam. `navigator` is passed as
 * undefined so `copyDiagnosticsReport` uses the injected clipboard only.
 */
const loadDiagnostics = (fetchImpl = async () => {
  throw new Error('unexpected fetch');
}) => new Function(
  'styles', 'DANGER', 'CLIENT_VERSION', 'fetch', 'setTimeout', 'clearTimeout', 'navigator',
  `${diagnosticsBlock}
return {
  diagnosticsView,
  diagnosticsReportOf,
  copyDiagnosticsReport,
  loadDiagnosticsStatus,
  diagnosticsSection,
};`,
)(styles, '#c92a2a', '0.99.0', fetchImpl, setTimeout, clearTimeout, undefined);

const walk = (node, visit) => {
  if (node === null || node === undefined || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
};

const nodesOf = (tree) => {
  const nodes = [];
  walk(tree, (node) => nodes.push(node));
  return nodes;
};

const textsOf = (tree) => {
  const texts = [];
  walk(tree, (node) => {
    for (const child of node.children ?? []) if (typeof child === 'string') texts.push(child);
  });
  return texts;
};

const buttonOf = (tree, label) => {
  const found = nodesOf(tree).find(
    (node) => node.type === 'button' && (node.children ?? []).some((child) => child === label),
  );
  assert.ok(found !== undefined, `the section renders a «${label}» button`);
  return found;
};

const statusWithData = (overrides = {}) => ({
  version: '0.99.0',
  uptimeMs: 120_000,
  hearing: {
    instanceId: 'h7-abcd',
    thresholdDb: -35,
    lastError: 'final pass failed: recognizer timeout',
    lastRestart: { ok: true, restarted: true, instanceId: 'h7-abcd', at: 1_700_000_000_000 },
  },
  voiceAck: [{
    turn: 4,
    phase: 'played',
    source: 'warm',
    reason: '',
    warmKey: 'warm-1',
    captionText: 'PRIVATE TRANSCRIPT',
    speechText: 'PRIVATE SPEECH TEXT',
    ackFirstAudioMs: 180,
  }],
  voiceLatency: {
    samples: 2,
    recent: [{ firstAudibleMs: 320, firstAudibleLane: 'reply' }],
  },
  vision: {
    source: 'obs',
    scene: 'Main Scene',
    locked: false,
    virtualCam: true,
    virtualCamError: { code: 'BLACK_FRAME', reason: 'black frame at 4%', at: 1_700_000_000_000 },
    lastShot: { path: 'C:\\seirein\\cache\\PRIVATE-AUDIO.png' },
  },
  privacy: { active: false, scene: 'Privacy' },
  live2d: {
    runtime: {
      motion: {
        presets: {
          enabled: true,
          decisions: 12,
          skips: 3,
          lastEvent: 'idle',
          lastSelection: { reasons: ['no-candidate', 'state:idle'] },
          byAction: { lastActionId: 'action-9', lastCommitCount: 4, lastEvent: 'answer-start' },
        },
      },
    },
  },
  lexicon: { enabled: true, count: 8 },
  retention: { enabled: false, items: [{ id: 'clip-1' }, { id: 'clip-2' }] },
  voicePending: 'PRIVATE TRANSCRIPT',
  ambient: { recent: ['PRIVATE AMBIENT AUDIO'] },
  ...overrides,
});

const sectionOf = (api, status, extra = {}) => api.diagnosticsSection(h, {
  data: { status, error: '', loading: false, at: 1_700_000_000_000 },
  clientVersion: '0.99.0',
  restart: null,
  busy: false,
  onRefresh: () => {},
  onCopy: () => {},
  ...extra,
});

test('1. 五个分区：有数据 / 缺字段 / 读取失败都渲染，占位不崩溃', () => {
  const api = loadDiagnostics();

  const full = textsOf(sectionOf(api, statusWithData()));
  assert.ok(full.includes('诊断（客户端）'), 'the panel has its own title');
  assert.ok(full.some((text) => text.includes('v0.99.0 / v0.99.0')), 'client/server versions');
  assert.ok(full.some((text) => text.includes('h7-abcd')), 'hearing instance id');
  assert.ok(full.some((text) => text.includes('-35 dB')), 'effective threshold');
  assert.ok(full.some((text) => text.includes('成功（新实例 h7-abcd）')), 'last restart result');
  assert.ok(full.some((text) => text.includes('final pass failed')), 'last voice error');
  assert.ok(full.includes('预热池'), 'ack source label');
  assert.ok(full.some((text) => text.includes('预热池命中')), 'ack hit');
  assert.ok(full.some((text) => text.includes('320ms')), 'first audible time');
  assert.ok(full.some((text) => text.includes('reply')), 'first audible lane');
  assert.ok(full.includes('OBS 场景'), 'vision source');
  assert.ok(full.includes('Main Scene'), 'vision scene');
  assert.ok(full.some((text) => text.includes('BLACK_FRAME')), 'virtual camera error');
  assert.ok(full.some((text) => text.includes('预设开关')), 'motion section');
  assert.ok(full.includes('已开启'), 'presets.enabled');
  assert.ok(full.some((text) => text.includes('select 12') && text.includes('skip 3')
    && text.includes('commit 4')), 'select/skip/commit counts');
  assert.ok(full.some((text) => text.includes('no-candidate')), 'last skip reason');
  assert.ok(full.some((text) => text.includes('8 条')), 'lexicon count');
  assert.ok(full.some((text) => text.includes('2 条')), 'retention count');

  // Missing every optional field: the panel renders placeholders instead of throwing.
  const missing = textsOf(sectionOf(api, {}));
  assert.ok(missing.filter((text) => text === '不可用').length >= 8, 'missing fields show 不可用');
  assert.ok(missing.includes('诊断（客户端）'), 'the panel still renders with no status');
  for (const title of ['概况', '语音', '视觉', '动作', '语言库 / 音频保留']) {
    assert.ok(missing.includes(title), `missing data still renders the ${title} section`);
  }

  // A failed read shows the error and still renders every section with placeholders.
  const failed = textsOf(api.diagnosticsSection(h, {
    data: { status: null, error: 'HTTP 500', loading: false, at: 0 },
    clientVersion: '0.99.0', restart: null, busy: false, onRefresh: () => {}, onCopy: () => {},
  }));
  assert.ok(failed.some((text) => text.includes('诊断读取失败：HTTP 500')), 'the read error is visible');
  assert.ok(failed.filter((text) => text === '不可用').length >= 8, 'failed read keeps placeholders');

  // Loading is explicit and never claims a value.
  const loading = textsOf(api.diagnosticsSection(h, {
    data: { status: null, error: '', loading: true, at: 0 },
    clientVersion: '0.99.0', restart: null, busy: false, onRefresh: () => {}, onCopy: () => {},
  }));
  assert.ok(loading.includes('正在读取诊断状态…'), 'loading hint');
  assert.equal(buttonOf(api.diagnosticsSection(h, {
    data: { status: null, error: '', loading: true, at: 0 },
    clientVersion: '0.99.0', restart: null, busy: false, onRefresh: () => {}, onCopy: () => {},
  }), '读取中…').props.disabled, true, 'refresh is disabled while loading');
});

test('2. 单次拉取：一个面板只发一个 /assistant/status 请求，渲染不再请求', async () => {
  const calls = [];
  const api = loadDiagnostics(async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => statusWithData() };
  });

  const result = await api.loadDiagnosticsStatus();
  assert.equal(calls.length, 1, 'exactly one status request');
  assert.equal(calls[0].url, '/assistant/status');
  assert.equal(calls[0].init.cache, 'no-store');
  assert.equal(result.error, '');
  assert.equal(result.status.hearing.instanceId, 'h7-abcd');

  // Rendering every section is pure: no second request, no matter how often it renders.
  for (let index = 0; index < 5; index += 1) sectionOf(api, result.status);
  assert.equal(calls.length, 1, 'rendering never fetches');

  // A non-2xx answer and a timeout are returned as errors, never thrown at the caller.
  const failed = await api.loadDiagnosticsStatus(async () => ({ ok: false, status: 503 }));
  assert.equal(failed.status, null);
  assert.equal(failed.error, 'HTTP 503');

  const apiTimeout = loadDiagnostics();
  const timingOut = await apiTimeout.loadDiagnosticsStatus((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    });
  }), 10);
  assert.equal(timingOut.status, null);
  assert.equal(timingOut.error, '请求超时', 'a timeout is reported, not thrown');
});

test('3. 复制报告：纯文本 JSON，不含转写/字幕/音频等用户内容', async () => {
  const api = loadDiagnostics();
  const report = api.diagnosticsReportOf(statusWithData(), {
    clientVersion: '0.99.0',
    at: 1_700_000_000_000,
  });
  assert.equal(typeof report, 'string');
  const parsed = JSON.parse(report);
  assert.equal(parsed.schema, 1);
  assert.equal(parsed.readError, null);
  assert.equal(parsed.instanceId, 'h7-abcd');
  assert.equal(parsed.thresholdDb, -35);
  assert.equal(parsed.voice.ackHit, '预热池命中');
  assert.equal(parsed.vision.virtualCamError, 'BLACK_FRAME');
  assert.equal(parsed.motion.skip, 3);
  assert.equal(parsed.motion.lastSkipReason, 'no-candidate');
  assert.equal(parsed.libraries.lexicon.count, 8);

  for (const secret of [
    'PRIVATE TRANSCRIPT', 'PRIVATE SPEECH TEXT', 'PRIVATE AMBIENT AUDIO',
    'PRIVATE-AUDIO', 'captionText', 'speechText', 'voicePending', 'ambient.recent',
  ]) {
    assert.equal(report.includes(secret), false, `report leaked ${secret}`);
  }
  assert.equal(Object.hasOwn(parsed.voice, 'captionText'), false);
  assert.equal(Object.hasOwn(parsed.voice, 'speechText'), false);
  assert.equal(Object.hasOwn(parsed.vision, 'lastShot'), false);

  const written = [];
  const copied = await api.copyDiagnosticsReport(report, {
    writeText: async (text) => { written.push(text); },
  });
  assert.deepEqual(copied, { ok: true, error: '' });
  assert.deepEqual(written, [report], 'the clipboard receives exactly the report');

  const unavailable = await api.copyDiagnosticsReport(report, null);
  assert.equal(unavailable.ok, false, 'no clipboard returns an error, never throws');
  assert.equal(typeof unavailable.error, 'string');

  // Even a failed read can be copied: the error text is part of the diagnostic summary.
  const failedReport = JSON.parse(api.diagnosticsReportOf(null, { readError: 'HTTP 500' }));
  assert.equal(failedReport.readError, 'HTTP 500');
  assert.equal(failedReport.instanceId, null);
  assert.equal(Object.hasOwn(failedReport.voice, 'captionText'), false);
});

test('4. 刷新重新拉取一次；诊断代码没有新增轮询', async () => {
  let calls = 0;
  const api = loadDiagnostics(async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ version: calls === 1 ? 'first' : 'second' }),
    };
  });

  const first = await api.loadDiagnosticsStatus();
  assert.equal(first.status.version, 'first');
  assert.equal(calls, 1);

  let refreshed = 0;
  const tree = api.diagnosticsSection(h, {
    data: { status: first.status, error: '', loading: false, at: 1 },
    clientVersion: '0.99.0',
    restart: null,
    busy: false,
    onRefresh: () => { refreshed += 1; },
    onCopy: () => {},
  });
  await buttonOf(tree, '刷新').props.onClick();
  assert.equal(refreshed, 1, 'the refresh button invokes its handler once');

  const second = await api.loadDiagnosticsStatus();
  assert.equal(second.status.version, 'second');
  assert.equal(calls, 2, 'each refresh is exactly one request');

  assert.doesNotMatch(diagnosticsBlock, /setInterval/u, 'the diagnostics block installs no timer');
  assert.doesNotMatch(diagnosticsBlock, /requestAnimationFrame/u);
  assert.match(clientSource,
    /useEffect\(\(\) => \{\s*void loadDiagnostics\(\);\s*\}, \[loadDiagnostics\]\);/u,
    'Panel reads diagnostics once on mount');
  assert.match(clientSource, /diagnosticsSection\(h, \{/u, 'the panel is mounted in settings');
  assert.match(clientSource, /onRefresh: \(\) => void loadDiagnostics\(\)/u);
  assert.match(clientSource, /onCopy: \(\) => void copyDiagnostics\(\)/u);
});

/** Run one child suite and report its tail when it fails. */
const runNode = (args) => new Promise((resolve) => {
  // A nested `node --test` refuses to run when NODE_TEST_CONTEXT is inherited ("recursive run").
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, args, {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (bytes) => { stdout += bytes; });
  child.stderr.on('data', (bytes) => { stderr += bytes; });
  child.once('error', (error) => resolve({ code: -1, stdout, stderr: String(error) }));
  child.once('close', (code) => resolve({ code, stdout, stderr }));
});

test('5. 回归：lexicon-ui / audio-retention-ui / hearing-ui / smoke', async (t) => {
  t.timeout = 420_000;
  const suites = [
    ['--test', join('test', 'lexicon-ui.mjs')],
    ['--test', join('test', 'audio-retention-ui.mjs')],
    ['--test', join('test', 'hearing-ui.mjs')],
    [join('test', 'smoke.mjs')],
  ];
  const results = [];
  for (const args of suites) {
    // eslint-disable-next-line no-await-in-loop -- these suites are run one at a time on purpose.
    const result = await runNode(args);
    results.push({ args, ...result });
    assert.equal(result.code, 0,
      `${args.join(' ')} failed\n${result.stderr.slice(-4000)}\n${result.stdout.slice(-4000)}`);
    if (args[0] === '--test') {
      assert.match(result.stdout, /ℹ fail 0/u, `${args[1]} reports no failures`);
    } else {
      assert.ok(result.stdout.includes('SMOKE TEST PASSED'), 'smoke reports its pass line');
    }
  }
  const summary = results.map(({ args, code }) => `${args.join(' ')} => exit ${code}`).join('; ');
  console.log(`[client-diagnostics 5] ${summary}`);
});
