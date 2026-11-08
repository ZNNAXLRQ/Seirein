/**
 * 诊断页两块新展示（客户端）：
 *
 *   A 最近一轮时间线：一次读取 turn.timeline + pipeline.timeline（limit 5），按轮次合并展示
 *     轮次 / 状态 / 模型轮数 / 四类工具计数 / toolWallMs / 总时长 / 首音 / 残差；缺字段「—」，
 *     无数据「暂无时间线（尚未产生或未重启）」，失败只显示原因；渲染不请求、无定时器。
 *   B 容量建议：voice.session.recover 的 stillNearLimit / compressionEffective / recommendation
 *     在恢复结果与诊断压缩区都只做黄字提示，不自动滚动、不自动压缩、不自动新建会话。
 *
 * 做法与 client-diagnostics / client-instance-settings 相同：把 client.js 里真正发货的区块
 * 抽出来，用记录型 `h` 求值（不需要 DOM、React 或宿主）。第 6 条跑要求的回归套件。
 *
 * Run: node --test test/diagnostics-ui-timeline.mjs
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

const SETTINGS_MARKER = '    // ---- 设置页：存放位置 / 恢复语音会话';
const DIAG_FROM = clientSource.indexOf('    const DIAGNOSTICS_READ_TIMEOUT_MS');
const DIAG_TO = clientSource.indexOf(SETTINGS_MARKER, DIAG_FROM);
assert.ok(DIAG_FROM > 0 && DIAG_TO > DIAG_FROM, 'client.js ships the diagnostics block before settings');
const diagnosticsBlock = clientSource.slice(DIAG_FROM, DIAG_TO);

const SET_FROM = clientSource.indexOf(SETTINGS_MARKER);
const SET_TO = clientSource.indexOf('    function Panel() {', SET_FROM);
assert.ok(SET_FROM > 0 && SET_TO > SET_FROM, 'client.js ships the settings block before Panel');
const settingsBlock = clientSource.slice(SET_FROM, SET_TO);

/** Recording element factory: every node keeps its type, props and children. */
const h = (type, props, ...children) => ({ type, props: props ?? {}, children });
const styles = new Proxy({}, { get: (_target, key) => ({ marker: String(key) }) });

const loadDiagnosticsApi = () => new Function(
  'styles', 'DANGER', 'CLIENT_VERSION', 'fetch', 'setTimeout', 'clearTimeout', 'navigator',
  `${diagnosticsBlock}
return {
  diagnosticsSection,
  diagnosticsReportOf,
  timelineSection,
  readDiagnosticsTimelines,
  diagnosticsTimelineOf,
  mergeDiagnosticsTimeline,
  copyDiagnosticsReport,
  DIAGNOSTICS_TIMELINE_LIMIT,
};`,
)(styles, '#c92a2a', '0.99.0', async () => {
  throw new Error('unexpected fetch');
}, setTimeout, clearTimeout, undefined);

const loadSettingsApi = () => new Function(
  'styles', 'DANGER', 'fetch', 'setTimeout', 'clearTimeout', 'AbortController',
  `${settingsBlock}
return { recoverSessionOutcome, recoverSessionSection, recoverCapacityOf };`,
)(styles, '#c92a2a', null, setTimeout, clearTimeout, AbortController);

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

const textOf = (tree) => textsOf(tree).join(' | ');

/** A diagnostic row is one div whose first two element children are the label and value spans. */
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

const buttonLabelsOf = (tree) => nodesOf(tree)
  .filter((node) => node.type === 'button')
  .map((node) => (node.children ?? []).filter((child) => typeof child === 'string').join(''));

/** One projected turn.timeline row, shaped like the host probe's answer. */
const turnRow = (overrides = {}) => ({
  timelineId: 'session-a#msg-3',
  sessionId: 'session-a',
  turn: 3,
  acceptTurn: 3,
  status: 'ok',
  reason: null,
  counts: {
    modelRounds: 2, attempts: 2, attemptFailures: 0, toolCalls: 3, toolFailures: 0, retries: 0,
  },
  overlaps: { toolMsSum: 900, toolWallMs: 700, parallelTools: 2 },
  residualMs: -12,
  phaseCount: 4,
  phaseNames: ['model', 'tool', 'audio'],
  longestPhase: { name: 'tool', durMs: 500 },
  toolKinds: { 'self-speech': 2, 'self-wait': 1, perception: 1, work: 1 },
  ...overrides,
});

/** One projected pipeline.timeline row. */
const pipelineRow = (overrides = {}) => ({
  turn: 3,
  sessionId: 'session-a',
  deliveryMessageId: 'msg-3',
  bodyReadyMs: 803,
  spokenFirstSentenceMs: 1203,
  translatedFirstMs: 1253,
  firstChunkSynthMs: 1503,
  firstAudioMs: 2103,
  totalMs: 2600,
  asrMs: 400,
  injectToAckMs: 60,
  ackToFirstTextMs: 300,
  ...overrides,
});

const EMPTY_PROBE = (probe) => ({ ok: true, probe, rows: [] });

test('1. 有数据：按轮次合并，渲染四类工具计数、toolWallMs、总时长、首音与残差', async () => {
  const api = loadDiagnosticsApi();
  assert.equal(api.DIAGNOSTICS_TIMELINE_LIMIT, 5);

  const timeline = await api.readDiagnosticsTimelines(async (body) => ({
    ok: true,
    probe: body.probe,
    rows: body.probe === 'turn.timeline' ? [turnRow()] : [pipelineRow()],
  }));

  assert.equal(timeline.ok, true);
  assert.equal(timeline.error, '');
  assert.equal(timeline.rows.length, 1, 'the same turn is one merged row');
  const merged = timeline.rows[0];
  assert.equal(merged.turn, 3);
  assert.equal(merged.status, 'ok');
  assert.equal(merged.modelRounds, 2);
  assert.deepEqual(merged.toolKinds, { 'self-speech': 2, 'self-wait': 1, perception: 1, work: 1 });
  assert.equal(merged.toolWallMs, 700);
  assert.equal(merged.totalMs, 2600, 'totalMs comes from pipeline.timeline');
  assert.equal(merged.firstAudioMs, 2103, 'firstAudioMs comes from pipeline.timeline');
  assert.equal(merged.residualMs, -12, 'a negative residual is kept, not clamped to 0');
  assert.equal(merged.hasTurn, true);
  assert.equal(merged.hasPipeline, true);

  const tree = api.timelineSection(h, { data: timeline });
  const text = textOf(tree);
  assert.ok(text.includes('最近一轮时间线'), 'the card has its own title');
  assert.ok(text.includes('轮次 3'), 'turn number');
  assert.ok(text.includes('状态 ok'), 'status');
  assert.ok(text.includes('模型 2 轮'), 'model rounds');
  for (const kind of ['self-speech 2', 'self-wait 1', 'perception 1', 'work 1']) {
    assert.ok(text.includes(kind), `tool count ${kind}`);
  }
  assert.ok(text.includes('toolWallMs 700ms'));
  assert.ok(text.includes('总时长 2600ms'));
  assert.ok(text.includes('首音 2103ms'));
  assert.ok(text.includes('残差 -12ms'));
  assert.equal(text.includes('暂无时间线'), false, 'data means no empty hint');
  assert.equal(text.includes('时间线读取失败'), false, 'data means no failure hint');

  // 多轮合并：只在一侧出现的轮次保留为一行，按轮次倒序；重复轮次不重复渲染。
  const multi = await api.readDiagnosticsTimelines(async (body) => ({
    ok: true,
    probe: body.probe,
    rows: body.probe === 'turn.timeline'
      ? [turnRow({ turn: 5, status: 'ok' }), turnRow({ turn: 4, status: 'no-audio', residualMs: 0 })]
      : [pipelineRow({ turn: 4, totalMs: 1800, firstAudioMs: null }), pipelineRow({ turn: 6, totalMs: 900 })],
  }));
  assert.deepEqual(multi.rows.map((row) => row.turn), [6, 5, 4], 'newest first; unions both probes');
  const six = multi.rows[0];
  assert.equal(six.hasTurn, false, 'pipeline-only turn has no timeline row');
  assert.equal(six.modelRounds, null, 'missing fields are null, never fabricated');
  const four = multi.rows[2];
  assert.equal(four.status, 'no-audio');
  assert.equal(four.totalMs, 1800);
  assert.equal(four.firstAudioMs, null);
  assert.equal(four.residualMs, 0, 'a real 0 is kept as 0');

  console.log(`[1] turn=3 status=ok model=2 tools=self-speech 2/self-wait 1/perception 1/work 1 `
    + `toolWallMs=700 totalMs=2600 firstAudioMs=2103 residualMs=-12 merged=[${multi.rows.map((row) => row.turn).join(',')}]`);
});

test('2. 无数据 / 失败 / 缺字段都降级，不崩溃、不猜数值', async () => {
  const api = loadDiagnosticsApi();

  // 尚未读取：加载提示，不冒充数据。
  const loading = api.timelineSection(h, { data: null });
  assert.ok(textOf(loading).includes('正在读取时间线…'));
  assert.ok(textOf(loading).includes('最近一轮时间线'));

  // 两个 probe 都成功但没有行：明确说明「尚未产生或未重启」。
  const emptyData = await api.readDiagnosticsTimelines(async (body) => EMPTY_PROBE(body.probe));
  assert.equal(emptyData.ok, true);
  assert.deepEqual(emptyData.rows, []);
  const empty = textOf(api.timelineSection(h, { data: emptyData }));
  assert.ok(empty.includes('暂无时间线（尚未产生或未重启）'));

  // 接口失败：显示原因，不抛异常。
  const disabled = await api.readDiagnosticsTimelines(async (body) => ({
    ok: false, probe: body.probe, reason: 'disabled', rows: [],
  }));
  assert.equal(disabled.ok, false);
  assert.equal(disabled.error, '诊断通道未启用');
  const failedText = textOf(api.timelineSection(h, { data: disabled }));
  assert.ok(failedText.includes('时间线读取失败：诊断通道未启用'));
  assert.equal(failedText.includes('暂无时间线'), false, 'a failure is not painted as empty data');

  const thrown = await api.readDiagnosticsTimelines(async () => { throw new Error('boom'); });
  assert.equal(thrown.ok, false);
  assert.equal(thrown.rows.length, 0);
  assert.equal(thrown.error.includes('boom'), true, 'the reason survives, without a throw');
  assert.doesNotMatch(thrown.error, /\n/u);

  const missingPost = await api.readDiagnosticsTimelines(null);
  assert.equal(missingPost.ok, false);
  assert.equal(missingPost.error, '时间线读取接口不可用');

  const malformed = await api.readDiagnosticsTimelines(async () => ({ ok: true, rows: 'nope' }));
  assert.equal(malformed.ok, true);
  assert.deepEqual(malformed.rows, [], 'a non-array rows field degrades to no rows');

  // 一侧失败、一侧成功：保留成功侧的行，同时显示失败原因。
  const partial = await api.readDiagnosticsTimelines(async (body) => (
    body.probe === 'turn.timeline'
      ? { ok: true, probe: body.probe, rows: [turnRow()] }
      : { ok: false, probe: body.probe, reason: 'read-failed', rows: [] }
  ));
  assert.equal(partial.rows.length, 1, 'the healthy probe still renders');
  assert.equal(partial.error, '读取事件日志失败');
  const partialText = textOf(api.timelineSection(h, { data: partial }));
  assert.ok(partialText.includes('轮次 3'));
  assert.ok(partialText.includes('时间线读取失败：读取事件日志失败'));

  // 缺字段 / 畸形行：全部「—」，不补 0、不崩溃。
  const missingRow = {
    turn: null,
    status: '',
    modelRounds: null,
    toolKinds: null,
    toolWallMs: null,
    totalMs: null,
    firstAudioMs: null,
    residualMs: null,
  };
  const degraded = textOf(api.timelineSection(h, {
    data: { loading: false, error: '', rows: [missingRow, null, 42, {}], at: 1 },
  }));
  assert.ok(degraded.includes('轮次 —'));
  assert.ok(degraded.includes('状态 —'));
  assert.ok(degraded.includes('模型 — 轮'));
  assert.ok(degraded.includes('工具 —'), 'a missing toolKinds block is one —, not four invented zeros');
  assert.ok(degraded.includes('toolWallMs —'));
  assert.ok(degraded.includes('总时长 —'));
  assert.ok(degraded.includes('首音 —'));
  assert.ok(degraded.includes('残差 —'));
  assert.equal(degraded.includes('0ms'), false, 'a missing field is never shown as 0');

  // 单个计数字段缺失：四类都出现，但各自是「—」，不是 0。
  const nullCounts = textOf(api.timelineSection(h, {
    data: {
      loading: false,
      error: '',
      rows: [{
        turn: 2,
        status: 'ok',
        modelRounds: null,
        toolKinds: { 'self-speech': null, 'self-wait': null, perception: null, work: null },
        toolWallMs: null,
        totalMs: null,
        firstAudioMs: null,
        residualMs: null,
      }],
      at: 1,
    },
  }));
  assert.ok(nullCounts.includes('self-speech — · self-wait — · perception — · work —'));

  console.log(`[2] empty=暂无时间线（尚未产生或未重启） disabled=诊断通道未启用 `
    + `partialRows=${partial.rows.length} missingTurn=轮次 — boom=caught`);
});

test('3. 一次刷新只读一轮：每个 probe 各 1 个请求、不重复；渲染不发请求、无定时器', async () => {
  const api = loadDiagnosticsApi();
  const calls = [];
  const post = async (body, timeoutMs) => {
    calls.push({ body, timeoutMs });
    return { ok: true, probe: body.probe, rows: [] };
  };

  await api.readDiagnosticsTimelines(post);
  assert.equal(calls.length, 2, 'exactly one request per probe');
  assert.deepEqual(calls[0].body, { action: 'diagnostics.query', probe: 'turn.timeline', limit: 5 });
  assert.deepEqual(calls[1].body, { action: 'diagnostics.query', probe: 'pipeline.timeline', limit: 5 });
  assert.equal(calls[0].timeoutMs, 4000, 'the probe read keeps the 4s hard timeout');
  assert.equal(calls[1].timeoutMs, 4000);

  // 渲染不是读取入口：多渲染几次也不会新增请求。
  const data = { loading: false, error: '', rows: [], turn: [], pipeline: [], at: 1 };
  for (let index = 0; index < 5; index += 1) api.timelineSection(h, { data });
  assert.equal(calls.length, 2, 'rendering never fetches');

  // 第二次刷新 = 再读一轮（每个 probe 各一次），不会叠加或重复请求。
  await api.readDiagnosticsTimelines(post);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map((call) => call.body.probe),
    ['turn.timeline', 'pipeline.timeline', 'turn.timeline', 'pipeline.timeline']);

  // limit 可显式覆盖；两个 probe 使用同一个值。
  const capped = [];
  await api.readDiagnosticsTimelines(async (body) => {
    capped.push(body);
    return { ok: true, probe: body.probe, rows: [] };
  }, 3);
  assert.deepEqual(capped.map((body) => body.limit), [3, 3]);

  // 时间线区块没装任何定时器，也没有自动轮询入口。
  assert.doesNotMatch(diagnosticsBlock, /setInterval/u, 'the diagnostics block installs no timer');
  assert.doesNotMatch(diagnosticsBlock, /requestAnimationFrame/u);
  assert.doesNotMatch(diagnosticsBlock, /addEventListener\(['"]visibilitychange/u);

  // Panel 仍只有一次挂载读取与一个「刷新」入口：时间线跟随同一次读取。
  assert.match(clientSource, /const loadTimeline = useCallback\(async \(\) => \{/u);
  assert.match(clientSource, /const \[result\] = await Promise\.all\(\[loadDiagnosticsStatus\(\), loadTimeline\(\)\]\);/u);
  assert.match(clientSource,
    /useEffect\(\(\) => \{\s*void loadDiagnostics\(\);\s*\}, \[loadDiagnostics\]\);/u,
    'Panel reads diagnostics + timeline once on mount');
  assert.match(clientSource, /onRefresh: \(\) => void loadDiagnostics\(\)/u);
  assert.equal((clientSource.match(/setInterval\(load, 3000\)/gu) ?? []).length, 1,
    'the existing 3s status poll stays the only timer');

  console.log(`[3] refresh=1 read pass: turn.timeline x1 + pipeline.timeline x1 `
    + `(requests=${calls.length / 2} rounds) renderRequests=0 timers=0`);
});

test('4. 复制报告：时间线只含脱敏摘要，不含 phases 明细、路径或文本', async () => {
  const api = loadDiagnosticsApi();
  const dirty = {
    loading: false,
    error: 'failed to open C:\\Users\\PrivateName\\voice.wav',
    at: 1,
    rows: [{
      turn: 3,
      status: 'ok',
      modelRounds: 2,
      toolKinds: { 'self-speech': 2, 'self-wait': 1, perception: 1, work: 1 },
      toolWallMs: 700,
      totalMs: 2600,
      firstAudioMs: 2103,
      residualMs: -12,
      // Extra fields a naive projection would copy: none may reach the report.
      phases: [{ name: 'model', text: 'PRIVATE PHASE TEXT', path: 'C:\\private\\phase.wav' }],
      phaseNames: ['model', 'tool'],
      path: 'C:\\Users\\PrivateName\\secret.wav',
      text: 'PRIVATE TIMELINE TEXT',
    }],
  };

  const report = api.diagnosticsReportOf({ version: '0.99.0' }, {
    clientVersion: '0.99.0',
    at: 1_700_000_000_000,
    timeline: dirty,
  });
  const parsed = JSON.parse(report);
  assert.equal(parsed.timeline.rows.length, 1);
  const row = parsed.timeline.rows[0];
  assert.deepEqual(Object.keys(row).sort(), [
    'firstAudioMs', 'modelRounds', 'residualMs', 'status', 'toolKinds', 'toolWallMs', 'totalMs', 'turn',
  ]);
  assert.equal(row.turn, 3);
  assert.equal(row.status, 'ok');
  assert.equal(row.modelRounds, 2);
  assert.deepEqual(row.toolKinds, { 'self-speech': 2, 'self-wait': 1, perception: 1, work: 1 });
  assert.equal(row.toolWallMs, 700);
  assert.equal(row.totalMs, 2600);
  assert.equal(row.firstAudioMs, 2103);
  assert.equal(row.residualMs, -12);
  assert.match(parsed.timeline.error, /<path>/u, 'the path in the read error is sanitized');

  for (const forbidden of [
    'PRIVATE PHASE TEXT', 'PRIVATE TIMELINE TEXT', 'PrivateName', 'C:\\Users', 'secret.wav',
    'phase.wav', 'phases', 'phaseNames',
  ]) {
    assert.equal(report.includes(forbidden), false, `the copied report leaked ${forbidden}`);
  }

  // 没有时间线数据时报告仍完整，字段不缺失。
  const plain = JSON.parse(api.diagnosticsReportOf({ version: '0.99.0' }, { clientVersion: '0.99.0' }));
  assert.deepEqual(plain.timeline, { error: null, rows: [] });

  // 剪贴板收到与生成文本完全一致的内容。
  const written = [];
  const copied = await api.copyDiagnosticsReport(report, {
    writeText: async (text) => { written.push(text); },
  });
  assert.deepEqual(copied, { ok: true, error: '' });
  assert.deepEqual(written, [report]);

  console.log(`[4] timelineChars=${JSON.stringify(parsed.timeline).length} `
    + `phasesLeak=false pathLeak=false copy=ok error=${parsed.timeline.error}`);
});

test('5. 容量建议：stillNearLimit / recommendation / compressionEffective 黄字展示，不自动动作', async () => {
  const settings = loadSettingsApi();
  const hot = settings.recoverSessionOutcome({
    ok: true,
    sessionId: 'seirein-2026-11-09',
    mounted: true,
    before: 4_000,
    after: 3_900,
    freed: 100,
    compacted: true,
    stillNearLimit: true,
    compressionEffective: false,
    recommendation: 'new-session',
  });
  assert.equal(hot.stillNearLimit, true);
  assert.equal(hot.compressionEffective, false);
  assert.equal(hot.recommendation, 'new-session');
  assert.deepEqual(hot.warnings, [
    '压缩后仍接近上限',
    '建议新建会话+交接摘要',
    '本次压缩未明显释放容量',
  ]);

  const recoverTree = settings.recoverSessionSection(h, {
    confirm: false, busy: false, outcome: hot, onAsk: () => {}, onCancel: () => {}, onConfirm: () => {},
  });
  const warnNode = nodesOf(recoverTree).find((node) => node.type === 'div'
    && (node.children ?? []).some(
      (child) => typeof child === 'string' && child.includes('压缩后仍接近上限'),
    ));
  assert.ok(warnNode !== undefined, 'the recover card shows the capacity warning');
  assert.equal(warnNode.props.style.color, '#b8860b', 'the warning is yellow');
  const recoverText = textOf(recoverTree);
  assert.ok(recoverText.includes('建议新建会话+交接摘要'));
  assert.ok(recoverText.includes('本次压缩未明显释放容量'));
  assert.equal(buttonLabelsOf(recoverTree).some((label) => label.includes('新建会话')), false,
    'the card offers no new-session button');
  assert.equal(buttonLabelsOf(recoverTree).length, 1, 'only the manual ask button exists');

  // 诊断压缩区同样展示（只读，经 Panel 的 recover 结果传入）。
  const diagnostics = loadDiagnosticsApi();
  const card = diagnostics.diagnosticsSection(h, {
    data: { status: {}, error: '', loading: false, at: 1 },
    clientVersion: '0.99.0',
    restart: null,
    busy: false,
    recover: hot,
    onRefresh: () => {},
    onCopy: () => {},
  });
  assert.equal(rowValueOf(card, '恢复后容量'),
    '压缩后仍接近上限 · 建议新建会话+交接摘要 · 本次压缩未明显释放容量');
  assert.equal(rowColorOf(card, '恢复后容量'), '#b8860b');

  // 尚未恢复：不显示任何推测出来的容量结论。
  const fresh = diagnostics.diagnosticsSection(h, {
    data: { status: {}, error: '', loading: false, at: 1 },
    clientVersion: '0.99.0',
    restart: null,
    busy: false,
    onRefresh: () => {},
    onCopy: () => {},
  });
  assert.equal(rowValueOf(fresh, '恢复后容量'), '尚未恢复');
  assert.equal(rowColorOf(fresh, '恢复后容量'), null, 'no warning colour before a recovery');

  // manual-compact / 仅「未释放」/ 健康三种情况。
  const manual = settings.recoverSessionOutcome({
    ok: true, sessionId: 's', mounted: true, before: 100, after: 100, freed: 0, compacted: true,
    stillNearLimit: true, compressionEffective: false, recommendation: 'manual-compact',
  });
  assert.deepEqual(manual.warnings, ['压缩后仍接近上限', '建议手动再压缩一次', '本次压缩未明显释放容量']);

  const ineffective = settings.recoverSessionOutcome({
    ok: true, sessionId: 's', mounted: true, before: 100, after: 100, freed: 0,
    compacted: true, stillNearLimit: false, compressionEffective: false, recommendation: '',
  });
  assert.deepEqual(ineffective.warnings, ['本次压缩未明显释放容量']);

  const healthy = settings.recoverSessionOutcome({
    ok: true, sessionId: 's', mounted: true, before: 5_000, after: 1_000, freed: 4_000,
    compacted: true, stillNearLimit: false, compressionEffective: true, recommendation: '',
  });
  assert.deepEqual(healthy.warnings, []);
  const healthyCard = diagnostics.diagnosticsSection(h, {
    data: { status: {}, error: '', loading: false, at: 1 },
    clientVersion: '0.99.0', restart: null, busy: false, recover: healthy,
    onRefresh: () => {}, onCopy: () => {},
  });
  assert.equal(rowValueOf(healthyCard, '恢复后容量'), '压缩有效，容量正常');
  assert.equal(rowColorOf(healthyCard, '恢复后容量'), null);

  // 失败结果也带上容量字段（压缩失败 → 建议新会话），但同样只展示。
  const failed = settings.recoverSessionOutcome({
    ok: false, code: 'compaction-failed', reason: 'boom', compressionEffective: false,
    recommendation: 'new-session',
  });
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.warnings, ['建议新建会话+交接摘要', '本次压缩未明显释放容量']);

  // 不自动动作：恢复区块没有定时器 / effect / 自动建会话调用。
  const recoverBlock = clientSource.slice(
    clientSource.indexOf('    // ---- 恢复结果的容量建议'),
    clientSource.indexOf('    function Panel() {', clientSource.indexOf('    // ---- 恢复结果的容量建议')),
  );
  assert.doesNotMatch(recoverBlock, /setInterval|useEffect|startSession|newSession/u);
  assert.doesNotMatch(recoverBlock, /scrollIntoView|location\.reload/u);

  console.log(`[5] stillNearLimit=true warnings=[压缩后仍接近上限, 建议新建会话+交接摘要, 本次压缩未明显释放容量] `
    + `colour=#b8860b manual=${manual.warnings.length} healthy=${healthy.warnings.length} autoActions=0`);
});

test('6. 回归：client-diagnostics / client-instance-settings / client-polling / smoke', async (t) => {
  t.timeout = 600_000;
  const suites = [
    ['--test', join('test', 'client-diagnostics.mjs')],
    ['--test', join('test', 'client-instance-settings.mjs')],
    ['--test', join('test', 'client-polling.mjs')],
    [join('test', 'smoke.mjs')],
  ];
  const results = [];
  for (const args of suites) {
    // eslint-disable-next-line no-await-in-loop -- one child suite at a time on purpose.
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
  console.log(`[6] ${summary}`);
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
