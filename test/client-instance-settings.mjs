/**
 * 设置页两项已定契约的功能（客户端侧）：
 *
 *   A 存放位置：只读显示 status.root，按钮弹窗输入/目录选择 -> `instance.setRoot { root }`；
 *     `restart-required` 是正常提示（不误报失败），成功文案「已保存，需重启 DSH 生效」；
 *     失败只显示受控 reason。不自动重启，不自动迁移数据。
 *   B 恢复语音会话：按钮 -> 二次确认 -> `voice.session.recover { sessionId? }`；成功展示
 *     before→after / freed / mounted，code 映射友好文案。不自动调用，不轮询。
 *
 * 做法与 client-diagnostics 相同：把 client.js 里真正发货的区块抽出来，用记录型 `h` 求值，
 * 不需要 DOM、React 或宿主。第 5 条跑 client-diagnostics / lexicon-ui / client-polling / smoke 回归。
 *
 * Run: node --test test/client-instance-settings.mjs
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

const BLOCK_FROM = clientSource.indexOf('    // ---- 设置页：存放位置 / 恢复语音会话');
const BLOCK_TO = clientSource.indexOf('    function Panel() {', BLOCK_FROM);
assert.ok(BLOCK_FROM > 0 && BLOCK_TO > BLOCK_FROM, 'client.js ships the settings block before Panel');
const settingsBlock = clientSource.slice(BLOCK_FROM, BLOCK_TO);

/** Recording element factory: every node keeps its type, props and children. */
const h = (type, props, ...children) => ({ type, props: props ?? {}, children });
const styles = new Proxy({}, { get: (_target, key) => ({ marker: String(key) }) });

/**
 * Evaluate the shipped block with explicit fetch / timer / AbortController seams. `fetch = null`
 * reproduces a client whose global fetch is missing.
 */
const loadSettings = ({
  fetchImpl = null,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  AbortControllerImpl = AbortController,
} = {}) => new Function(
  'styles', 'DANGER', 'fetch', 'setTimeout', 'clearTimeout', 'AbortController',
  `${settingsBlock}
return {
  instanceRootOf,
  instanceRootParentOf,
  runSettingsAction,
  instanceRootOutcome,
  submitInstanceRoot,
  pickRootDirectory,
  recoverSessionOutcome,
  submitVoiceSessionRecover,
  instanceRootSection,
  recoverSessionSection,
  INSTANCE_ROOT_CODE_TEXT,
  RECOVER_CODE_TEXT,
};`,
)(styles, '#c92a2a', fetchImpl, setTimeoutImpl, clearTimeoutImpl, AbortControllerImpl);

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
  return texts.join(' | ');
};

const buttonOf = (tree, label) => {
  const found = nodesOf(tree).find(
    (node) => node.type === 'button' && (node.children ?? []).some((child) => child === label),
  );
  assert.ok(found !== undefined, `the section renders a «${label}» button`);
  return found;
};

/** The div that renders one notice line: its direct children include the message string. */
const noticeOf = (tree, message) => {
  const found = nodesOf(tree).find(
    (node) => node.type === 'div' && (node.children ?? []).some((child) => child === message),
  );
  assert.ok(found !== undefined, `the section renders the notice «${message}»`);
  return found;
};

const rootSection = (api, overrides = {}) => api.instanceRootSection(h, {
  status: { root: 'C:\\Users\\me\\Seirein' },
  fallbackRoot: '',
  dialog: null,
  notice: null,
  busy: false,
  onOpen: () => {},
  onDraft: () => {},
  onPick: () => {},
  onCancel: () => {},
  onSave: () => {},
  ...overrides,
});

const recoverSection = (api, overrides = {}) => api.recoverSessionSection(h, {
  confirm: false,
  busy: false,
  outcome: null,
  onAsk: () => {},
  onCancel: () => {},
  onConfirm: () => {},
  ...overrides,
});

/** A post stub that records every body and returns one scripted result. */
const postStub = (result) => {
  const calls = [];
  const post = async (body, timeoutMs) => {
    calls.push({ body, timeoutMs });
    return typeof result === 'function' ? result(body) : result;
  };
  return { post, calls };
};

test('1. 显示当前 root；选择后调用参数正确，成功/失败分支文案', async () => {
  const api = loadSettings();

  // 只读 root：status.root 优先，其次 config/paths/instance 上的只读副本；都没有就是空。
  assert.equal(api.instanceRootOf({ root: 'D:\\Data\\Seirein' }), 'D:\\Data\\Seirein');
  assert.equal(api.instanceRootOf({ config: { root: 'E:\\Config\\Seirein' } }), 'E:\\Config\\Seirein');
  assert.equal(api.instanceRootOf({ instance: { root: 'F:\\I\\Seirein' } }), 'F:\\I\\Seirein');
  assert.equal(api.instanceRootOf({ paths: { root: 'G:\\P\\Seirein' } }), 'G:\\P\\Seirein');
  assert.equal(api.instanceRootOf({ root: '  ' }), '', '空白 root 不显示');
  assert.equal(api.instanceRootOf(null), '');
  assert.equal(api.instanceRootOf(undefined, 'H:\\fallback'), 'H:\\fallback');

  // 弹窗里保存的是父目录（host 会补 <parent>\Seirein），避免把当前数据目录再套一层。
  assert.equal(api.instanceRootParentOf('D:\\Data\\Seirein'), 'D:\\Data');
  assert.equal(api.instanceRootParentOf('D:\\Data\\Seirein\\'), 'D:\\Data');
  assert.equal(api.instanceRootParentOf('D:\\Bare'), 'D:\\Bare');
  assert.equal(api.instanceRootParentOf(''), '');

  // 卡片：root 只读显示；关着弹窗时没有输入框；按钮只调 onOpen。
  let opened = 0;
  const cardTree = rootSection(api, { onOpen: () => { opened += 1; } });
  const cardText = textsOf(cardTree);
  assert.ok(cardText.includes('当前存放位置'), 'the card shows the read-only root row');
  assert.ok(cardText.includes('C:\\Users\\me\\Seirein'), 'the card shows the status root verbatim');
  assert.ok(cardText.includes('选择存放位置'), 'the card offers one explicit button');
  assert.equal(nodesOf(cardTree).filter((node) => node.type === 'input').length, 0,
    'no input while the dialog is closed');
  const openButton = buttonOf(cardTree, '选择存放位置');
  await openButton.props.onClick();
  assert.equal(opened, 1, 'opening the dialog is a pure UI action');

  // 弹窗：输入 + 目录选择 + 取消/保存；保存按钮在空草稿时禁用。
  const dialogTree = rootSection(api, {
    dialog: { draft: '', error: '' },
    onDraft: () => {},
    onPick: () => {},
    onCancel: () => {},
    onSave: () => {},
  });
  const inputs = nodesOf(dialogTree).filter((node) => node.type === 'input');
  assert.equal(inputs.length, 1, 'the dialog renders one path input');
  assert.equal(inputs[0].props.value, '', 'the input is controlled by the draft');
  buttonOf(dialogTree, '浏览…');
  buttonOf(dialogTree, '取消');
  const saveButton = buttonOf(dialogTree, '保存');
  assert.equal(saveButton.props.disabled, true, 'an empty draft cannot be saved');

  const typedTree = rootSection(api, { dialog: { draft: 'D:\\Data', error: '' } });
  const typedSave = buttonOf(typedTree, '保存');
  assert.equal(typedSave.props.disabled, false, 'a non-empty draft can be saved');

  // 成功：参数恰好 {action:'instance.setRoot', root:'D:\Data'}，一次请求，提示需重启。
  const ok = postStub({ ok: true, root: 'D:\\Data\\Seirein', applied: false, reason: 'restart-required' });
  const success = await api.submitInstanceRoot('  D:\\Data  ', ok.post);
  assert.equal(ok.calls.length, 1, 'one click is exactly one request');
  assert.deepEqual(ok.calls[0].body, { action: 'instance.setRoot', root: 'D:\\Data' },
    'the action body carries the trimmed chosen directory');
  assert.equal(success.ok, true);
  assert.equal(success.danger, false);
  assert.equal(success.message, '已保存，需重启 DSH 生效');
  assert.equal(success.root, 'D:\\Data\\Seirein');
  const successTree = rootSection(api, { notice: success });
  assert.ok(textsOf(successTree).includes('已保存，需重启 DSH 生效'), 'success notice is rendered');
  assert.ok(textsOf(successTree).includes('存放位置：D:\\Data\\Seirein'), 'the saved root is rendered');

  // 失败：不误报成功，失败分支显示 reason 与原因码。
  const rejected = postStub({ ok: false, code: 'NOT_A_DIRECTORY', error: 'NOT_A_DIRECTORY' });
  const failure = await api.submitInstanceRoot('D:\\Data', rejected.post);
  assert.equal(failure.ok, false);
  assert.equal(failure.danger, true);
  assert.equal(failure.message, '保存失败：所选路径是文件，不是目录');
  assert.equal(failure.detail, '原因码：NOT_A_DIRECTORY');
  const failureTree = rootSection(api, { notice: failure });
  const failureNotice = noticeOf(failureTree, failure.message);
  assert.equal(failureNotice.props.style.color, '#c92a2a', 'a failure is shown in the danger color');
  assert.ok(textsOf(failureTree).includes('原因码：NOT_A_DIRECTORY'));

  // 空输入不发请求；缺失的 post 也不崩。
  const emptyPost = postStub({ ok: true });
  const empty = await api.submitInstanceRoot('   ', emptyPost.post);
  assert.equal(emptyPost.calls.length, 0, 'an empty input never calls the host');
  assert.equal(empty.message, '请先选择或输入存放位置');
  assert.equal((await api.submitInstanceRoot('D:\\Data', null)).ok, false);

  // 目录选择器：正常选择 / 取消 / 缺失 / 抛错。
  const picked = await api.pickRootDirectory({ pickDirectory: async () => '  D:\\Picked  ' });
  assert.deepEqual(picked, { ok: true, path: 'D:\\Picked', error: '' });
  assert.deepEqual(await api.pickRootDirectory({ pickDirectory: async () => null }),
    { ok: false, path: '', error: '' }, '取消不报错');
  assert.equal((await api.pickRootDirectory(undefined)).error, '目录选择器不可用，请手动输入路径');
  assert.equal((await api.pickRootDirectory({})).error, '目录选择器不可用，请手动输入路径');
  const throwingPicker = await api.pickRootDirectory({
    pickDirectory: async () => { throw new Error('dialog closed'); },
  });
  assert.equal(throwingPicker.ok, false);
  assert.equal(throwingPicker.error, '目录选择失败：dialog closed');

  console.log(`[1] root=C:\\Users\\me\\Seirein · body={action:instance.setRoot,root:D:\\Data}`
    + ` · success=已保存，需重启 DSH 生效 · failure=保存失败：所选路径是文件，不是目录 · picker=ok/cancel/missing/throw`);
});

test('2. restart-required 是正常提示，不误报失败', async () => {
  const api = loadSettings();
  const cases = [
    ['applied:\'restart-required\'', { ok: true, root: 'D:\\A\\Seirein', applied: 'restart-required' }],
    ['applied:false + reason', { ok: true, root: 'D:\\A\\Seirein', applied: false, reason: 'restart-required' }],
    ['无 applied 字段', { ok: true, root: 'D:\\A\\Seirein' }],
    ['restartRequired:true', { ok: true, root: 'D:\\A\\Seirein', restartRequired: true }],
    ['ok:false + code restart-required', { ok: false, code: 'restart-required' }],
    ['ok:false + 只有 reason', { ok: false, reason: 'restart-required' }],
  ];
  for (const [label, result] of cases) {
    const outcome = api.instanceRootOutcome(result);
    assert.equal(outcome.ok, true, `${label}: restart-required 不是失败`);
    assert.equal(outcome.danger, false, `${label}: 不标红`);
    assert.equal(outcome.restartRequired, true, `${label}: 记录需重启`);
    assert.equal(outcome.message, '已保存，需重启 DSH 生效', `${label}: 提示需重启`);
    const tree = rootSection(api, { notice: outcome });
    assert.equal(noticeOf(tree, outcome.message).props.style.color, '#2b8a3e', `${label}: 成功色`);
    assert.ok(!textsOf(tree).includes('保存失败'), `${label}: 永不显示失败文案`);
  }

  // 真正应用的宿主仍然显示成功，而不是多余的重启提示。
  const appliedNow = api.instanceRootOutcome({ ok: true, root: 'D:\\A\\Seirein', applied: true });
  assert.equal(appliedNow.restartRequired, false);
  assert.equal(appliedNow.message, '已保存并已生效');

  // 真正的拒绝仍是失败（不会因为 reason 字段被吞掉）。
  const refused = api.instanceRootOutcome({ ok: false, code: 'WRITE_FAILED', error: 'WRITE_FAILED' });
  assert.equal(refused.ok, false);
  assert.equal(refused.message, '保存失败：写入设置失败（检查权限）');

  console.log(`[2] ${cases.length} restart-required 变体 => ok=true danger=false message=已保存，需重启 DSH 生效`);
});

test('3. 恢复按钮二次确认；成功展示 before/after；各 code 友好文案', async () => {
  const api = loadSettings();

  // 第一次点击只武装确认，不发请求。
  let asked = 0;
  let confirmed = 0;
  const idle = recoverSection(api, {
    onAsk: () => { asked += 1; },
    onConfirm: () => { confirmed += 1; },
  });
  const askButton = buttonOf(idle, '恢复当前语音会话');
  assert.ok(textsOf(idle).includes('不会自动调用，也不会轮询'), 'the card states no auto call / no polling');
  assert.equal(nodesOf(idle).filter((node) => (node.children ?? []).includes('确认恢复')).length, 0,
    'no confirm button before arming');
  await askButton.props.onClick();
  assert.equal(asked, 1);
  assert.equal(confirmed, 0, 'the first click never performs the action');

  // 确认态：取消 / 确认恢复都可用；只有 onConfirm 触发动作。
  const armed = recoverSection(api, {
    confirm: true,
    onCancel: () => {},
    onConfirm: () => { confirmed += 1; },
  });
  buttonOf(armed, '取消');
  const confirmButton = buttonOf(armed, '确认恢复');
  await confirmButton.props.onClick();
  assert.equal(confirmed, 1, 'only the second confirmation performs the action');

  // 动作参数：默认恢复当前语音会话，一次请求，一个 30 秒上限。
  const recover = postStub({ ok: true, sessionId: 'seirein-2026-11-09', mounted: true, before: 4000, after: 1200, freed: 2800, compacted: true });
  const success = await api.submitVoiceSessionRecover(recover.post);
  assert.equal(recover.calls.length, 1, 'one confirmation is exactly one request');
  assert.deepEqual(recover.calls[0].body, { action: 'voice.session.recover' });
  assert.equal(recover.calls[0].timeoutMs, 30000);
  assert.equal(success.ok, true);
  assert.equal(success.message, '已恢复 seirein-2026-11-09：4000 → 1200 token，释放 2800');
  assert.equal(success.detail, 'preset 已挂载 · 已压缩一次');
  const successTree = recoverSection(api, { outcome: success });
  const successText = textsOf(successTree);
  assert.ok(successText.includes('4000 → 1200 token'), 'before -> after is rendered');
  assert.ok(successText.includes('释放 2800'), 'freed is rendered');
  assert.ok(successText.includes('preset 已挂载'), 'mounted is rendered');
  assert.equal(noticeOf(successTree, success.message).props.style.color, '#2b8a3e');

  // 传 sessionId 时原样带上（用于显式恢复旧会话）。
  const explicit = postStub({ ok: true, sessionId: 'seirein-2026-11-01', mounted: true, before: 10, after: 5, freed: 5 });
  await api.submitVoiceSessionRecover(explicit.post, '  seirein-2026-11-01  ');
  assert.deepEqual(explicit.calls[0].body, { action: 'voice.session.recover', sessionId: 'seirein-2026-11-01' });

  // 四个必须映射的 code + 其它受控 code。
  const codeText = {
    'agent-owned': '会话仍被占用，请先重启 DSH',
    'preset-missing': '压缩能力未就绪',
    'preset-conflict': '压缩预设冲突（见诊断）',
    'compaction-failed': '压缩失败，历史未删除',
    'resume-failed': '恢复失败，历史未改动',
    'mount-failed': '恢复后压缩能力未挂载',
  };
  for (const [code, text] of Object.entries(codeText)) {
    const outcome = api.recoverSessionOutcome({
      ok: false, code, reason: 'HOST RAW', mounted: false, before: null, after: null, freed: null, compacted: false,
    });
    assert.equal(outcome.ok, false, `${code}: 失败`);
    assert.equal(outcome.danger, true, `${code}: 标红`);
    assert.equal(outcome.message, text, `${code}: 友好文案`);
    assert.equal(outcome.detail, `原因码：${code}`);
    assert.ok(!textsOf(recoverSection(api, { outcome })).includes('HOST RAW'),
      `${code}: 受控文案不夹带宿主原文`);
  }

  // 未知 code 回落到宿主 reason；空结果给出兜底文案。
  const unknown = api.recoverSessionOutcome({ ok: false, code: 'weird-code', reason: '宿主自己的原因' });
  assert.equal(unknown.message, '宿主自己的原因');
  assert.equal(unknown.detail, '原因码：weird-code');
  assert.equal(api.recoverSessionOutcome(null).message, '服务没有响应');

  // 成功但没有压缩范围：历史未改动要说清楚。
  const idleCompaction = api.recoverSessionOutcome({
    ok: true, sessionId: 'seirein-2026-11-09', mounted: true, before: 100, after: 100, freed: 0, compacted: false,
    reason: 'no-compactable-range',
  });
  assert.equal(idleCompaction.detail, 'preset 已挂载 · 本次没有可压缩范围（历史未改动）');

  console.log(`[3] ask=仅武装 confirm=1 request · body={action:voice.session.recover}`
    + ` · 4000 → 1200 freed=2800 mounted=已挂载 · codes=${Object.keys(codeText).length}`);
});

test('4. 异常/超时/接口缺失不崩溃', async () => {
  const api = loadSettings();

  // post 抛异常 / 缺失 / 返回非对象，都只变成一行提示。
  const thrown = await api.submitInstanceRoot('D:\\Data', async () => { throw new Error('boom'); });
  assert.equal(thrown.ok, false);
  assert.equal(thrown.message, '保存失败：请求失败');
  assert.equal((await api.submitInstanceRoot('D:\\Data', null)).message,
    '保存失败：服务未就绪（无法连接 DSH）');
  assert.equal(api.instanceRootOutcome('not-an-object').message, '保存失败：没有返回结果');
  assert.equal(api.instanceRootOutcome([]).message, '保存失败：没有返回结果');

  // fetch 层：非 2xx、畸形 JSON、缺 fetch、超时。
  const api503 = loadSettings({
    fetchImpl: async () => ({ ok: false, status: 503 }),
  });
  const http503 = await api503.runSettingsAction({ action: 'instance.setRoot', root: 'D:\\x' });
  assert.equal(http503.ok, false);
  assert.equal(http503.code, 'HTTP_503');
  assert.equal(http503.error, 'HTTP 503');

  const apiBadJson = loadSettings({
    fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('bad json'); } }),
  });
  assert.equal((await apiBadJson.runSettingsAction({})).code, 'REQUEST_FAILED');

  const apiNullJson = loadSettings({ fetchImpl: async () => ({ ok: true, json: async () => null }) });
  assert.equal((await apiNullJson.runSettingsAction({})).code, 'BAD_RESPONSE');

  const apiNoFetch = loadSettings({ fetchImpl: null });
  assert.equal((await apiNoFetch.runSettingsAction({})).code, 'FETCH_UNAVAILABLE');

  const timeoutFetch = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    });
  });
  const apiTimeout = loadSettings({ fetchImpl: timeoutFetch });
  const timedOut = await apiTimeout.runSettingsAction({ action: 'instance.setRoot', root: 'D:\\x' }, { timeoutMs: 10 });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.code, 'TIMEOUT');
  assert.equal(timedOut.error, '请求超时');
  assert.equal(timedOut.timedOut, true);

  // 没有 AbortController 的运行时也照常发请求（不装 signal）。
  const apiNoAbort = loadSettings({
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, root: 'D:\\A\\Seirein' }) }),
    AbortControllerImpl: undefined,
  });
  const noAbort = await apiNoAbort.runSettingsAction({ action: 'instance.setRoot', root: 'D:\\A' });
  assert.equal(noAbort.ok, true);

  // 恢复动作的异常路径。
  const recoverThrown = await api.submitVoiceSessionRecover(async () => { throw new Error('boom'); });
  assert.equal(recoverThrown.message, '请求失败');
  assert.equal((await api.submitVoiceSessionRecover(null)).message, '服务未就绪（无法连接 DSH）');
  const malformed = await api.submitVoiceSessionRecover(async () => ({ ok: true, before: 'NaN' }));
  assert.equal(malformed.ok, true);
  assert.equal(malformed.before, null, '非数字 token 不会变成 NaN 文案');
  assert.ok(malformed.message.includes('— → —'), `unmeasurable tokens render as —: ${malformed.message}`);

  // 渲染层：空 props / 畸形 dialog / 畸形 notice 都不抛异常。
  const bare = recoverSection(api);
  assert.ok(textsOf(bare).includes('恢复当前语音会话'));
  const weirdRoot = api.instanceRootSection(h, {});
  assert.ok(textsOf(weirdRoot).includes('不可用'), 'a missing status renders «不可用»');
  const weirdDialog = api.instanceRootSection(h, {
    status: null, dialog: { draft: 42, error: null }, notice: { message: 'x', detail: 7, danger: 'yes' },
    busy: false, onOpen: null, onDraft: null, onPick: null, onCancel: null, onSave: null,
  });
  assert.equal(nodesOf(weirdDialog).filter((node) => node.type === 'input').length, 1);
  assert.ok(textsOf(weirdDialog).includes('x'));
  const weirdOutcome = api.recoverSessionSection(h, {
    confirm: true, busy: true, outcome: 'not-an-outcome', onAsk: null, onCancel: null, onConfirm: null,
  });
  assert.ok(textsOf(weirdOutcome).includes('恢复中…'));

  console.log(`[4] throw=请求失败 missing-fetch=服务未就绪 http=HTTP_503 timeout=请求超时`
    + ` bad-json=REQUEST_FAILED null-json=BAD_RESPONSE malformed-before=null · renders=ok`);
});

test('5. 回归：无自动重启/迁移/轮询；client-diagnostics、lexicon-ui、client-polling、smoke', async (t) => {
  t.timeout = 600_000;

  // 静态：两个卡片都接在设置页里，动作名与二次确认接线都在。
  assert.match(clientSource, /instanceRootSection\(h, \{/u, '存放位置卡片挂载在设置页');
  assert.match(clientSource, /recoverSessionSection\(h, \{/u, '恢复卡片挂载在设置页');
  assert.match(clientSource, /instanceRootSection\(h, \{\s*status,/u);
  assert.match(clientSource, /onSave: \(\) => void saveRootDialog\(\)/u);
  assert.match(clientSource, /onConfirm: \(\) => void confirmRecoverSession\(\)/u);
  assert.match(settingsBlock, /action: 'instance\.setRoot', root: value/u);
  assert.match(settingsBlock, /action: 'voice\.session\.recover'/u);

  // 不自动重启 / 不自动迁移 / 不轮询：区块内没有定时器、effect、reload 或迁移动作。
  assert.doesNotMatch(settingsBlock, /setInterval/u, '区块不安装任何定时器');
  assert.doesNotMatch(settingsBlock, /useEffect/u, '区块不自动读取或重试');
  assert.doesNotMatch(settingsBlock, /location\.reload/u, '不自动重启');
  assert.doesNotMatch(settingsBlock, /action: '[^']*restart[^']*'/u, '不调用重启动作');
  assert.doesNotMatch(settingsBlock, /migrat/iu, '区块里没有迁移调用');
  assert.match(settingsBlock, /不会自动重启/u);
  assert.match(settingsBlock, /不会自动迁移已有数据/u);
  assert.match(settingsBlock, /不会自动调用，也不会轮询/u);
  // 恢复只在确认 handler 里调用；第一次点击只武装确认。
  const askBody = clientSource.slice(
    clientSource.indexOf('const askRecoverSession'),
    clientSource.indexOf('const cancelRecoverSession'),
  );
  assert.ok(askBody.length > 0);
  assert.doesNotMatch(askBody, /submitVoiceSessionRecover|postSettingsAction|voice\.session\.recover/u,
    '第一次点击不发请求');
  const confirmBody = clientSource.slice(
    clientSource.indexOf('const confirmRecoverSession'),
    clientSource.indexOf('// 动作预设列表'),
  );
  assert.match(confirmBody, /submitVoiceSessionRecover\(postSettingsAction\)/u,
    '只有确认 handler 才发恢复请求');
  // 状态轮询仍只有 Panel 里那一个 3 秒 load；这两个动作不新增轮询源。
  assert.equal((clientSource.match(/setInterval\(load, 3000\)/gu) ?? []).length, 1);

  // 子套件回归（本文件是新增套件，不会递归自跑）。
  const suites = [
    ['--test', join('test', 'client-diagnostics.mjs')],
    ['--test', join('test', 'lexicon-ui.mjs')],
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
  console.log(`[5] ${summary}`);
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
