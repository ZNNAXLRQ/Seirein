/**
 * P-111 客户端诊断通道（MVP）+ 自动压缩状态区回归。
 *
 * 从 client.js 抽出真正发货的 `diagnosticsSection` / `diagnosticsView` / `loadDiagnosticsStatus`
 * 等函数，用记录型 `h` 求值（与 hearing-ui / audio-retention-ui 相同的做法）：不需要 DOM、React
 * 或宿主。这里固定用户实际能看到、点到的东西：
 *   1. 各状态渲染：自动压缩 registered / reused / conflict / failed + 既有五分区；
 *   2. 上下文压力 tokens/windowTokens/ratio，ratio > 0.8 显示「接近上限」；
 *   3. requiresRestart 时装配行显示「需重启或执行恢复」；
 *   4. 复制的报告含自动压缩字段、受控码保留，路径/URL/会话 id 不进报告；
 *   5. 缺字段 / 读取失败 / 超时 / 畸形字段一律「不可用」，不崩溃；
 *   6. 回归：单次读取、手动刷新、无新增轮询，lexicon-ui / audio-retention-ui / hearing-ui / smoke。
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
  timelineSection,
  readDiagnosticsTimelines,
  diagnosticsPipelineTimelineOf,
  sanitizeDiagnosticText,
  reportField,
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

/** A diagnostic row is one div with two element children: label span, value span. */
const rowOf = (tree, label) => {
  const found = nodesOf(tree).find((node) => {
    const elements = (node.children ?? []).filter((child) => child !== null && typeof child === 'object');
    return elements.length >= 2 && (elements[0].children ?? [])[0] === label;
  });
  assert.ok(found !== undefined, `the section renders a «${label}» row`);
  return found;
};

const rowValueOf = (tree, label) => rowOf(tree, label).children[1].children.join('');
const rowColorOf = (tree, label) => rowOf(tree, label).children[1].props.style?.color ?? null;

const buttonOf = (tree, label) => {
  const found = nodesOf(tree).find(
    (node) => node.type === 'button' && (node.children ?? []).some((child) => child === label),
  );
  assert.ok(found !== undefined, `the section renders a «${label}» button`);
  return found;
};

/** `status.voiceCompaction` exactly as the host's `presetStatus()` reports it. */
const compactionOf = (overrides = {}) => ({
  presetId: 'seirein-voice-compaction',
  status: 'registered',
  source: 'registered',
  registered: true,
  enabled: true,
  reason: '',
  running: 1,
  mounted: 1,
  active: 1,
  requiresRestart: false,
  note: '',
  nearLimit: false,
  pressure: {
    nearLimit: false,
    sessionId: 'seirein-2026-11-09',
    tokens: 40_000,
    windowTokens: 128_000,
    ratio: 0.313,
    threshold: 0.8,
    at: 1_700_000_000_000,
  },
  ...overrides,
});

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

test('1. 各状态渲染：自动压缩 registered / reused / conflict / failed 与既有五分区', () => {
  const api = loadDiagnostics();
  const cases = [
    {
      id: 'registered',
      compaction: compactionOf(),
      state: '已注册（来源 registered）',
      usable: '可用',
      danger: false,
    },
    {
      id: 'reused',
      compaction: compactionOf({ status: 'reused', source: 'profile', registered: false }),
      state: '复用（来源 profile）',
      usable: '可用',
      danger: false,
    },
    {
      id: 'conflict',
      compaction: compactionOf({
        status: 'conflict',
        source: 'profile',
        registered: false,
        enabled: false,
        reason: '自动压缩不可用：同 ID preset 定义不兼容（多出 persona 行）',
      }),
      state: '冲突（来源 profile）',
      usable: '自动压缩不可用：同 ID preset 定义不兼容',
      danger: true,
    },
    {
      id: 'failed',
      compaction: compactionOf({
        status: 'failed',
        source: '',
        registered: false,
        enabled: false,
        reason: '自动压缩不可用：preset 注册失败（agentPresets.register() is unavailable）',
      }),
      state: '失败',
      usable: '自动压缩不可用：preset 注册失败',
      danger: true,
    },
  ];
  const observed = [];
  for (const item of cases) {
    const tree = sectionOf(api, statusWithData({ voiceCompaction: item.compaction }));
    assert.ok(textsOf(tree).includes('自动压缩'), `${item.id}: the card has a 自动压缩 section`);
    assert.equal(rowValueOf(tree, '状态'), item.state, `${item.id}: status label + source`);
    assert.ok(rowValueOf(tree, '是否可用').includes(item.usable), `${item.id}: enabled is answered by reason`);
    assert.equal(
      rowColorOf(tree, '是否可用') === '#c92a2a',
      item.danger,
      `${item.id}: red only when enable is false`,
    );
    observed.push(`${item.id}=${rowValueOf(tree, '状态')}/${rowValueOf(tree, '是否可用').slice(0, 18)}`);
  }

  // 同一张卡片上既有的五个分区仍然按原样渲染（有数据时不丢失任何行）。
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
  for (const title of ['概况', '语音', '自动压缩', '视觉', '动作', '语言库 / 音频保留']) {
    assert.ok(full.includes(title), `the ${title} section renders`);
  }
  console.log(`[1] ${observed.join(' ; ')}`);
});

test('2. 接近上限：tokens / windowTokens / ratio 与 ratio > 0.8 提示', () => {
  const api = loadDiagnostics();
  const pressureOf = (tokens, windowTokens, ratio, nearLimit = false) => compactionOf({
    nearLimit,
    pressure: { nearLimit, sessionId: 'seirein-2026-11-09', tokens, windowTokens, ratio, threshold: 0.8, at: 1 },
  });
  const pressureRow = (status) => rowValueOf(sectionOf(api, status), '上下文压力');

  // 90%：数值 + 百分比 + 「接近上限」。
  const hot = pressureRow(statusWithData({ voiceCompaction: pressureOf(115_200, 128_000, 0.9) }));
  assert.equal(hot, '115200/128000 tokens · 90% · 接近上限');

  // 50%：只报数值，不制造警告。
  assert.equal(pressureRow(statusWithData({ voiceCompaction: pressureOf(64_000, 128_000, 0.5) })),
    '64000/128000 tokens · 50%');

  // 0.8 本身不算「超过」，0.81 才算。
  assert.equal(pressureRow(statusWithData({ voiceCompaction: pressureOf(102_400, 128_000, 0.8) })),
    '102400/128000 tokens · 80%');
  assert.ok(pressureRow(statusWithData({ voiceCompaction: pressureOf(103_680, 128_000, 0.81) }))
    .includes('接近上限'));

  // 宿主 nearLimit=true 但数值缺失：仍提示接近上限；压力整块缺失：显示不可用。
  const flagOnly = compactionOf({ nearLimit: true, pressure: { nearLimit: true } });
  assert.equal(pressureRow(statusWithData({ voiceCompaction: flagOnly })), '接近上限');
  assert.equal(pressureRow(statusWithData({ voiceCompaction: compactionOf({ pressure: null }) })), '不可用');

  console.log(`[2] 90%=${hot} ; 50%=${pressureRow(statusWithData({ voiceCompaction: pressureOf(64_000, 128_000, 0.5) }))} ; flagOnly=接近上限`);
});

test('3. requiresRestart：装配行显示需重启或执行恢复', () => {
  const api = loadDiagnostics();
  const note = '需重启 DSH 或执行 voice.session.recover 重新装配';
  const restarting = compactionOf({
    status: 'reused',
    source: 'profile',
    registered: false,
    enabled: false,
    running: 1,
    mounted: 0,
    active: 0,
    requiresRestart: true,
    note,
    reason: `自动压缩不可用：已运行的语音会话未装配（${note}）`,
  });
  const tree = sectionOf(api, statusWithData({ voiceCompaction: restarting }));
  const assembly = rowValueOf(tree, '装配（registered / mounted / active / running）');
  assert.equal(assembly, 'registered 否 · mounted 0 · active 0 · running 1 · 需重启或执行恢复');
  assert.ok(textsOf(tree).includes(`恢复说明：${note}`), 'the host note spells out the recovery command');
  assert.ok(rowValueOf(tree, '是否可用').includes('需重启'), 'the usable row points at the restart');
  assert.equal(rowColorOf(tree, '是否可用'), '#c92a2a', 'not usable is red');

  // 已装配：同一行没有重启提示。
  const healthy = sectionOf(api, statusWithData({ voiceCompaction: compactionOf() }));
  assert.equal(rowValueOf(healthy, '装配（registered / mounted / active / running）'),
    'registered 是 · mounted 1 · active 1 · running 1');
  assert.equal(textsOf(healthy).some((text) => text.includes('需重启')), false);
  assert.equal(rowColorOf(healthy, '是否可用'), null, 'usable is not red');

  console.log(`[3] restarting="${assembly}" ; healthy="${rowValueOf(healthy, '装配（registered / mounted / active / running）')}"`);
});

test('4. 复制报告：含自动压缩字段、受控码保留、不含路径与会话 id', async () => {
  const api = loadDiagnostics();
  const hot = compactionOf({
    nearLimit: true,
    pressure: {
      nearLimit: true,
      sessionId: 'seirein-2026-11-09',
      tokens: 115_200,
      windowTokens: 128_000,
      ratio: 0.9,
      threshold: 0.8,
      at: 1,
    },
  });
  const report = api.diagnosticsReportOf(statusWithData({ voiceCompaction: hot }), {
    clientVersion: '0.99.0',
    at: 1_700_000_000_000,
  });
  const parsed = JSON.parse(report);
  assert.equal(parsed.compaction.presetId, 'seirein-voice-compaction');
  assert.equal(parsed.compaction.status, 'registered');
  assert.equal(parsed.compaction.source, 'registered');
  assert.equal(parsed.compaction.registered, true);
  assert.equal(parsed.compaction.enabled, true);
  assert.equal(parsed.compaction.requiresRestart, false);
  assert.equal(parsed.compaction.nearLimit, true);
  assert.equal(parsed.compaction.pressure.tokens, 115_200);
  assert.equal(parsed.compaction.pressure.windowTokens, 128_000);
  assert.equal(parsed.compaction.pressure.ratio, 0.9);
  assert.equal(parsed.compaction.pressure.threshold, 0.8);
  assert.equal(JSON.stringify(parsed.compaction).includes('seirein-2026-11-09'), false,
    'the sampled session id never enters the report');

  // 冲突原因里的本机路径被脱敏，受控码与 note 原样保留。
  const leaky = compactionOf({
    status: 'conflict',
    source: 'profile',
    registered: false,
    enabled: false,
    reason: '自动压缩不可用：preset 注册失败（failed to open C:\\Users\\PrivateName\\voice-private.wav）',
    note: '需重启 DSH 或执行 voice.session.recover 重新装配',
  });
  const leakReport = api.diagnosticsReportOf(statusWithData({ voiceCompaction: leaky }), {
    clientVersion: '0.99.0',
  });
  const leakParsed = JSON.parse(leakReport);
  assert.equal(leakParsed.compaction.status, 'conflict', 'controlled status code survives');
  assert.equal(leakParsed.compaction.source, 'profile', 'controlled source code survives');
  assert.match(leakParsed.compaction.reason, /<path>/u);
  assert.equal(leakParsed.compaction.note, '需重启 DSH 或执行 voice.session.recover 重新装配');
  for (const secret of ['PrivateName', 'voice-private.wav', 'C:\\Users']) {
    assert.equal(leakReport.includes(secret), false, `the copied report leaked ${secret}`);
  }

  // 既有的报告契约不变：纯文本 JSON、白名单字段、无转写/字幕/音频路径。
  assert.equal(typeof report, 'string');
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

  // 读取失败也能复制：压缩块整体标记为不可用，而不是编造字段。
  const failedReport = JSON.parse(api.diagnosticsReportOf(null, { readError: 'HTTP 500' }));
  assert.equal(failedReport.readError, 'HTTP 500');
  assert.equal(failedReport.instanceId, null);
  assert.equal(failedReport.compaction.available, false);
  assert.equal(failedReport.compaction.presetId, null);
  assert.equal(failedReport.compaction.enabled, null);
  assert.equal(Object.hasOwn(failedReport.voice, 'captionText'), false);

  // 脱敏纯函数：路径 / URL / 用户名不进报告，受控码保留，界面仍显示原文。
  assert.equal(api.sanitizeDiagnosticText('C:\\Users\\PrivateName\\voice-private.wav'), '<path>');
  assert.equal(api.sanitizeDiagnosticText('failed to open /home/foo/bar'), 'failed to open <path>');
  assert.equal(api.sanitizeDiagnosticText('see https://x.y/z'), 'see <url>');
  assert.equal(api.sanitizeDiagnosticText('\\\\server\\share\\voice.wav'), '<path>');
  assert.equal(api.sanitizeDiagnosticText('mail: someone@example.com'), 'mail: <email>');
  assert.equal(api.sanitizeDiagnosticText(null), '', 'a non-string never throws');
  assert.equal(api.reportField('BLACK_FRAME'), 'BLACK_FRAME');
  assert.equal(api.reportField('HTTP 503'), 'HTTP 503');
  assert.equal(api.reportField('TTS_ABORTED'), 'TTS_ABORTED');
  assert.equal(api.reportField('no-candidate'), 'no-candidate', 'an enum-like label survives');
  assert.equal(
    api.reportField('ffmpeg: failed to open C:\\Users\\PrivateName\\voice-private.wav', true),
    'ffmpeg: error',
  );

  const hearing = statusWithData().hearing;
  const leakyStatus = statusWithData({
    hearing: { ...hearing, lastError: 'ffmpeg: failed to open C:\\Users\\PrivateName\\voice-private.wav' },
  });
  const leakyParsed = JSON.parse(api.diagnosticsReportOf(leakyStatus, { clientVersion: '0.99.0' }));
  assert.equal(leakyParsed.voice.lastError, 'ffmpeg: error');
  assert.ok(textsOf(sectionOf(api, leakyStatus)).some((text) => (
    text.includes('ffmpeg: failed to open C:\\Users\\PrivateName\\voice-private.wav')
  )), 'the panel still shows the raw detailed error');

  const variants = [
    { lastError: 'capture: failed to open /home/foo/bar', stage: 'capture', needle: '/home' },
    { lastError: 'tts: https://x.y/z', stage: 'tts', needle: 'x.y' },
    { lastError: 'asr: failed \\\\server\\share\\x', stage: 'asr', needle: 'share' },
  ];
  for (const { lastError, stage, needle } of variants) {
    const variant = JSON.parse(api.diagnosticsReportOf(statusWithData({
      hearing: { ...hearing, lastError },
    })));
    assert.equal(variant.voice.lastError, `${stage}: error`, `${lastError} becomes a stage summary`);
    assert.equal(JSON.stringify(variant.voice).includes(needle), false, `${lastError} leaked ${needle}`);
  }

  assert.equal(api.reportField('C:\\shots\\PRIVATE.png'), '<path>');
  const sceneReport = JSON.parse(api.diagnosticsReportOf(statusWithData({
    vision: { ...statusWithData().vision, scene: 'C:\\Users\\PrivateName\\scene.json' },
  })));
  assert.equal(sceneReport.vision.scene, '<path>');
  const failedRestart = JSON.parse(api.diagnosticsReportOf(null, {
    readError: 'HTTP 503',
    localRestart: { ok: false, message: 'ffmpeg: \\\\server\\share\\voice.wav' },
  }));
  assert.equal(failedRestart.readError, 'HTTP 503');
  assert.equal(failedRestart.restart.message, 'ffmpeg: error');
  assert.equal(JSON.stringify(failedRestart.restart).includes('server'), false);
  const abortReport = JSON.parse(api.diagnosticsReportOf(statusWithData({
    vision: { ...statusWithData().vision, virtualCamError: { code: 'TTS_ABORTED' } },
  })));
  assert.equal(abortReport.vision.virtualCamError, 'TTS_ABORTED');

  console.log(`[4] compaction.status=${parsed.compaction.status} source=${parsed.compaction.source} `
    + `ratio=${parsed.compaction.pressure.ratio} pathLeak=false copy=ok`);
});

test('5. 缺字段 / 接口失败 / 畸形字段都显示不可用，不崩溃', async () => {
  const api = loadDiagnostics();

  // 空 status：五个分区 + 自动压缩全部占位，不抛异常。
  const missingTree = sectionOf(api, {});
  const missing = textsOf(missingTree);
  assert.ok(missing.filter((text) => text === '不可用').length >= 16, 'missing fields show 不可用');
  assert.ok(missing.includes('诊断（客户端）'), 'the panel still renders with no status');
  for (const label of ['状态', '是否可用', '上下文压力', '装配（registered / mounted / active / running）']) {
    assert.equal(rowValueOf(missingTree, label), '不可用', `missing compaction field renders 不可用: ${label}`);
  }
  for (const title of ['概况', '语音', '自动压缩', '视觉', '动作', '语言库 / 音频保留']) {
    assert.ok(missing.includes(title), `missing data still renders the ${title} section`);
  }
  assert.equal(rowColorOf(missingTree, '是否可用'), null, 'an absent block is not painted red');

  // 畸形字段（数字当状态、字符串当压力、非布尔当开关）同样不崩溃。
  const odd = sectionOf(api, {
    voiceCompaction: { status: 42, enabled: 'yes', pressure: 'nope', requiresRestart: 'yes', nearLimit: 1 },
  });
  assert.equal(rowValueOf(odd, '状态'), '不可用');
  assert.equal(rowValueOf(odd, '是否可用'), '不可用');
  assert.equal(rowValueOf(odd, '上下文压力'), '不可用');
  assert.match(rowValueOf(odd, '装配（registered / mounted / active / running）'), /^registered — · mounted —/u);

  const nonObject = sectionOf(api, { voiceCompaction: 'oops' });
  assert.equal(rowValueOf(nonObject, '状态'), '不可用');
  assert.equal(rowValueOf(nonObject, '装配（registered / mounted / active / running）'), '不可用');

  // 读取失败：错误可见，所有分区仍是占位。
  const failed = textsOf(api.diagnosticsSection(h, {
    data: { status: null, error: 'HTTP 500', loading: false, at: 0 },
    clientVersion: '0.99.0', restart: null, busy: false, onRefresh: () => {}, onCopy: () => {},
  }));
  assert.ok(failed.some((text) => text.includes('诊断读取失败：HTTP 500')), 'the read error is visible');
  assert.ok(failed.filter((text) => text === '不可用').length >= 16, 'failed read keeps placeholders');

  // 读取中：明确提示，刷新禁用，不冒充数值。
  const loadingTree = api.diagnosticsSection(h, {
    data: { status: null, error: '', loading: true, at: 0 },
    clientVersion: '0.99.0', restart: null, busy: false, onRefresh: () => {}, onCopy: () => {},
  });
  assert.ok(textsOf(loadingTree).includes('正在读取诊断状态…'), 'loading hint');
  assert.equal(buttonOf(loadingTree, '读取中…').props.disabled, true, 'refresh is disabled while loading');

  // 单次拉取：一个面板只发一个 /assistant/status 请求，渲染不再请求。
  const calls = [];
  const api2 = loadDiagnostics(async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => statusWithData() };
  });
  const result = await api2.loadDiagnosticsStatus();
  assert.equal(calls.length, 1, 'exactly one status request');
  assert.equal(calls[0].url, '/assistant/status');
  assert.equal(calls[0].init.cache, 'no-store');
  assert.equal(result.error, '');
  assert.equal(result.status.hearing.instanceId, 'h7-abcd');
  for (let index = 0; index < 5; index += 1) sectionOf(api2, result.status);
  assert.equal(calls.length, 1, 'rendering never fetches');

  // 非 2xx 与超时都返回错误，不向调用方抛出。
  const failedRead = await api2.loadDiagnosticsStatus(async () => ({ ok: false, status: 503 }));
  assert.equal(failedRead.status, null);
  assert.equal(failedRead.error, 'HTTP 503');
  const timingOut = await api2.loadDiagnosticsStatus((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    });
  }), 10);
  assert.equal(timingOut.status, null);
  assert.equal(timingOut.error, '请求超时', 'a timeout is reported, not thrown');

  console.log(`[5] missingRows=4 placeholders>=16 oddFields=handled readError=HTTP 500 timeout=请求超时 requests=1`);
});

test('6. 回归：单次读取、手动刷新、无新增轮询；lexicon-ui / audio-retention-ui / hearing-ui / smoke', async (t) => {
  t.timeout = 420_000;

  // 刷新重新拉取一次；诊断代码不安装定时器，Panel 挂载只读一次。
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

  // 子套件回归（client-diagnostics 本身即本条所在套件，不能递归自跑）。
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
  console.log(`[client-diagnostics 6] ${summary}`);
});

test('7. P-46：首块队列等待进入客户端时间线；0 保留，null/缺失显示「—」，不引入 ttsQueueMs', async () => {
  const api = loadDiagnostics();

  // 1) 投影白名单：宿主字段被保留，0 不被当成「没有」；探针之外的原字段一律丢弃。
  const projected = api.diagnosticsPipelineTimelineOf({
    turn: 3,
    sessionId: 'session-a',
    deliveryMessageId: 'msg-3',
    firstChunkQueueWaitMs: 0,
    ttsQueueMs: 987654,
    firstChunkQueueWaitMsRaw: 'PRIVATE QUEUE RAW',
  });
  assert.equal(projected.firstChunkQueueWaitMs, 0, 'the projection keeps a measured 0');
  assert.equal(Object.hasOwn(projected, 'ttsQueueMs'), false, 'ttsQueueMs is not added to the whitelist');
  assert.equal(Object.hasOwn(projected, 'firstChunkQueueWaitMsRaw'), false,
    'unknown raw fields stay out of the projection');

  // 2) 经过 readDiagnosticsTimelines 后，字段仍在合并行上（含只有 pipeline 的轮次）。
  const read = (pipelineRows, turnRows = []) => api.readDiagnosticsTimelines(async (body) => ({
    ok: true,
    probe: body.probe,
    rows: body.probe === 'turn.timeline' ? turnRows : pipelineRows,
  }));
  const data = await read([
    { turn: 3, sessionId: 'session-a', deliveryMessageId: 'msg-3', firstChunkQueueWaitMs: 7 },
    { turn: 2, sessionId: 'session-a', deliveryMessageId: 'msg-2', firstChunkQueueWaitMs: 0 },
    { turn: 1, sessionId: 'session-a', deliveryMessageId: 'msg-1', firstChunkQueueWaitMs: null },
    { turn: 0, sessionId: 'session-a', deliveryMessageId: 'msg-0' },
  ]);
  assert.deepEqual(
    data.pipeline.map((row) => row.firstChunkQueueWaitMs),
    [7, 0, null, null],
    'value / 0 / explicit null / missing are projected distinctly',
  );
  assert.deepEqual(
    data.rows.map((row) => row.firstChunkQueueWaitMs),
    [7, 0, null, null],
    'the merged timeline rows carry the queue wait',
  );
  assert.equal(JSON.stringify(data.rows).includes('ttsQueueMs'), false,
    'ttsQueueMs never reaches the merged rows');

  const merged = await read(
    [{ turn: 4, sessionId: 'session-a', deliveryMessageId: 'msg-4', totalMs: 900, firstChunkQueueWaitMs: 12 }],
    [{
      turn: 4,
      sessionId: 'session-a',
      deliveryMessageId: 'msg-4',
      status: 'ok',
      counts: { modelRounds: 1 },
      toolKinds: null,
      overlaps: {},
      residualMs: 1,
    }],
  );
  assert.equal(merged.rows.length, 1, 'the two probes still merge into one row');
  assert.equal(merged.rows[0].firstChunkQueueWaitMs, 12, 'the merged row gets the pipeline value');

  // 3) 时间线行：短标签追加在既有「耗时」行末尾，不新增列/行，也不打乱既有顺序。
  const rowText = (row) => textsOf(api.timelineSection(h, {
    data: { loading: false, error: '', rows: [row], at: 1 },
  })).join(' | ');
  const full = {
    turn: 4,
    status: 'ok',
    modelRounds: 1,
    toolKinds: { 'self-speech': 0, 'self-wait': 0, perception: 0, work: 0 },
    toolWallMs: 400,
    totalMs: 900,
    firstAudioMs: 1200,
    residualMs: -12,
    firstChunkQueueWaitMs: 7,
  };
  const fullText = rowText(full);
  assert.ok(fullText.includes('首块队列等待 7ms'), 'the row renders the short label and value');
  assert.ok(fullText.includes('toolWallMs 400ms · 总时长 900ms · 首音 1200ms · 残差 -12ms · 首块队列等待 7ms'),
    'the label is appended after the existing fields, so the existing order is unchanged');
  assert.ok(fullText.includes('首块队列等待 0ms') === false, 'a measured value is not rendered as 0');

  assert.ok(rowText({ ...full, firstChunkQueueWaitMs: 0 }).includes('首块队列等待 0ms'),
    'a measured 0 is shown as 0ms, not hidden');
  assert.ok(rowText({ ...full, firstChunkQueueWaitMs: null }).includes('首块队列等待 —'),
    'an explicit null shows —');
  assert.ok(rowText({ ...full, firstChunkQueueWaitMs: undefined }).includes('首块队列等待 —'),
    'a missing field shows —');
  const missingRow = {};
  assert.ok(rowText(missingRow).includes('首块队列等待 —'), 'a degraded row shows — instead of 0');

  // 4) 既有报告摘要的白名单不因本字段放宽：可复制报告仍不含该字段和 ttsQueueMs。
  const report = JSON.parse(api.diagnosticsReportOf({ version: '0.99.0' }, {
    clientVersion: '0.99.0',
    timeline: data,
  }));
  assert.deepEqual(Object.keys(report.timeline.rows[0]).sort(), [
    'firstAudioMs', 'modelRounds', 'residualMs', 'status', 'toolKinds', 'toolWallMs', 'totalMs', 'turn',
  ], 'the copyable timeline summary keeps its existing field set');
  for (const forbidden of ['firstChunkQueueWaitMs', 'ttsQueueMs', '987654', 'PRIVATE QUEUE RAW']) {
    assert.equal(JSON.stringify(report).includes(forbidden), false, `the report leaked ${forbidden}`);
  }

  console.log('[7] projected=0/7/null/missing merged=7/0/null/null '
    + 'render=首块队列等待 7ms|0ms|— reportWhitelistUnchanged=true ttsQueueMs=false');
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
