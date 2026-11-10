/**
 * 声纹登记（客户端）：设置页「声纹」卡片 + 宿主契约调用。
 *
 * 用户定稿（2026-11-09）：先登记 + 影子，不用于硬决策；客户端只按宿主契约读写
 * `speaker.enroll.list / confirm / reject / remove` 与 `speaker.status.shadow`。
 * 做法与 client-diagnostics 相同：把 client.js 里真正发货的区块抽出来，用记录型 `h` 求值，
 * 不需要 DOM、React 或宿主。
 *
 *  1. 四种登记状态展示：未登记 / 待确认 / 已确认 / 已拒绝（selfId、样本数/总时长、确认时间）；
 *  2. [确认] 仅样本 ≥ 3 秒可用；不足时禁用并显示原因；
 *  3. 确认成功固定提示「只用于词库与新增记忆归属，不用于拒收/打断」；渲染不自动确认/拒绝；
 *  4. 影子观测：最近一条 decision/class/quality/score + 三类计数；没有样本显示「暂无样本」；
 *  5. 接口缺失 / 读取失败 / 畸形字段一律降级为一行提示，不崩溃；
 *  6. 无轮询：单次读取（list + shadow 各一次），渲染不发请求，只有「刷新」再读；
 *  7. 回归：client-diagnostics / client-instance-settings / client-polling / smoke。
 *
 * 复制报告只输出状态、计数与分数：标签文本、样本 id、路径与转写都不进报告。
 *
 * Run: node --test test/client-speaker-enrollment.mjs
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

const BLOCK_FROM = clientSource.indexOf('    const SPEAKER_ENROLL_READ_TIMEOUT_MS');
const BLOCK_TO = clientSource.indexOf('    // ---- P-111 客户端诊断', BLOCK_FROM);
assert.ok(BLOCK_FROM > 0 && BLOCK_TO > BLOCK_FROM, 'client.js ships the speaker-enrollment block before diagnostics');
const block = clientSource.slice(BLOCK_FROM, BLOCK_TO);

/** Recording element factory: every node keeps its type, props and children. */
const h = (type, props, ...children) => ({ type, props: props ?? {}, children });
const styles = new Proxy({}, { get: (_target, key) => ({ marker: String(key) }) });

/** Evaluate the shipped block with explicit fetch / timer seams. */
const load = (fetchImpl = async () => { throw new Error('unexpected request'); }) => new Function(
  'styles', 'DANGER', 'fetch', 'setTimeout', 'clearTimeout', 'AbortController',
  `${block}
return {
  SPEAKER_ENROLL_MIN_TOTAL_MS,
  SPEAKER_ENROLL_CONFIRM_NOTICE,
  SPEAKER_ENROLL_RECORD_HINT,
  speakerEnrollView,
  speakerEnrollEntryOf,
  speakerEnrollConfirmReason,
  speakerEnrollOutcome,
  speakerEnrollReportOf,
  speakerEnrollRead,
  speakerEnrollSection,
};`,
)(styles, '#c92a2a', fetchImpl, setTimeout, clearTimeout, AbortController);

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

/** A card row is one div with two element children: label span, value span. */
const rowOf = (tree, label) => {
  const found = nodesOf(tree).find((node) => {
    const elements = (node.children ?? []).filter((child) => child !== null && typeof child === 'object');
    return elements.length >= 2 && (elements[0].children ?? [])[0] === label;
  });
  assert.ok(found !== undefined, `the card renders a «${label}» row`);
  return found;
};

const rowValueOf = (tree, label) => rowOf(tree, label).children[1].children.join('');

const buttonsOf = (tree, label) => nodesOf(tree).filter(
  (node) => node.type === 'button' && (node.children ?? []).some((child) => child === label),
);

const buttonOf = (tree, label) => {
  const found = buttonsOf(tree, label);
  assert.ok(found.length > 0, `the card renders a «${label}» button`);
  return found[0];
};

/** One enrollment entry exactly as the host contract reports it. */
const entryOf = (overrides = {}) => ({
  speakerId: 'self-lin',
  label: '本人',
  status: 'pending',
  samples: 2,
  totalDurationMs: 1200,
  confirmedAt: '',
  ...overrides,
});

const listOf = (overrides = {}) => ({ ok: true, selfId: 'self-lin', entries: [entryOf()], ...overrides });

const lastShadowOf = (overrides = {}) => ({
  decision: 'match',
  class: 'self',
  quality: 'ok',
  score: 0.87,
  speakerId: 'self-lin',
  at: '2026-11-09T03:00:00.000Z',
  ...overrides,
});

const shadowOf = (overrides = {}) => ({
  ok: true,
  lastShadow: lastShadowOf(),
  counts: { match: 4, mismatch: 1, unsure: 2 },
  ...overrides,
});

const dataOf = (list = listOf(), shadow = shadowOf(), extra = {}) => ({
  list,
  shadow,
  loading: false,
  error: '',
  at: 1_700_000_000_000,
  ...extra,
});

const sectionOf = (api, data, extra = {}) => api.speakerEnrollSection(h, {
  data,
  busy: false,
  notice: '',
  onRefresh: () => {},
  onRecord: () => {},
  onConfirm: () => {},
  onReject: () => {},
  onRemove: () => {},
  onCopy: () => {},
  ...extra,
});

// ---------------------------------------------------------------------------
// 1. 登记状态
// ---------------------------------------------------------------------------

test('1. 已登记 / 未登记：selfId、样本数/总时长、四种状态', () => {
  const api = load();
  const observed = [];

  // 未登记：列表可用但没有条目。
  const empty = sectionOf(api, dataOf(listOf({ selfId: '', entries: [] })));
  assert.ok(textsOf(empty).includes('声纹'), 'the card keeps its own title');
  assert.equal(rowValueOf(empty, '本人 speakerId'), '未登记');
  assert.equal(rowValueOf(empty, '状态'), '未登记');
  assert.equal(rowValueOf(empty, '样本'), '—');
  assert.ok(textsOf(empty).some((text) => text.includes('还没有登记条目')), 'empty list spells out the next step');
  observed.push('empty=未登记');

  // 待确认：2 条样本、1.2 秒。
  const pending = sectionOf(api, dataOf());
  assert.equal(rowValueOf(pending, '本人 speakerId'), 'self-lin');
  assert.equal(rowValueOf(pending, '状态'), '待确认');
  assert.equal(rowValueOf(pending, '样本'), '2 条 · 1.2 秒（不足 3 秒，不能确认）');
  assert.equal(rowValueOf(pending, '确认时间'), '—');
  observed.push('pending=待确认/1.2秒');

  // 已确认：样本足够，带确认时间。
  const confirmed = sectionOf(api, dataOf(listOf({
    entries: [entryOf({ status: 'confirmed', samples: 3, totalDurationMs: 4200, confirmedAt: '2026-11-09T03:00:00.000Z' })],
  })));
  assert.equal(rowValueOf(confirmed, '状态'), '已确认');
  assert.equal(rowValueOf(confirmed, '样本'), '3 条 · 4.2 秒');
  assert.equal(rowValueOf(confirmed, '确认时间'), '2026-11-09T03:00:00.000Z');
  assert.ok(textsOf(confirmed).some((text) => text.includes('本人（self-lin） · 已确认')), 'entry row shows label + id + status');
  observed.push('confirmed=已确认/4.2秒');

  // 已拒绝：仍是已登记条目，状态显示已拒绝。
  const rejected = sectionOf(api, dataOf(listOf({
    entries: [entryOf({ status: 'rejected', samples: 1, totalDurationMs: 900 })],
  })));
  assert.equal(rowValueOf(rejected, '状态'), '已拒绝');
  observed.push('rejected=已拒绝');

  // 列表不可用：状态列显示「不可用」，不猜测成「未登记」。
  const missing = sectionOf(api, dataOf({ ok: false, error: 'unknown action' }, shadowOf()));
  assert.equal(rowValueOf(missing, '状态'), '不可用');
  observed.push('unavailable=不可用');

  console.log(`[1] ${observed.join(' ; ')}`);
});

// ---------------------------------------------------------------------------
// 2. 确认门槛
// ---------------------------------------------------------------------------

test('2. 样本不足 3 秒：确认禁用并说明原因；3 秒整可用', () => {
  const api = load();
  const observed = [];

  const short = sectionOf(api, dataOf(listOf({ entries: [entryOf({ totalDurationMs: 1200, samples: 2 })] })));
  const shortButton = buttonOf(short, '确认');
  assert.equal(shortButton.props.disabled, true, 'confirm is disabled below 3000 ms');
  assert.match(shortButton.props.title, /样本不足 3 秒/u);
  assert.ok(
    textsOf(short).some((text) => text.includes('样本不足 3 秒（已 1.2 秒）')),
    'the reason is visible next to the entry',
  );
  observed.push('1200ms=disabled');

  const edge = sectionOf(api, dataOf(listOf({ entries: [entryOf({ totalDurationMs: 2999, samples: 2 })] })));
  assert.equal(buttonOf(edge, '确认').props.disabled, true, '2999 ms is still short');
  observed.push('2999ms=disabled');

  const enough = sectionOf(api, dataOf(listOf({ entries: [entryOf({ totalDurationMs: 3000, samples: 3 })] })));
  const enoughButton = buttonOf(enough, '确认');
  assert.equal(enoughButton.props.disabled, false, 'exactly 3000 ms can be confirmed');
  assert.equal(enoughButton.props.title, '');
  observed.push('3000ms=enabled');

  // 已确认 / 已拒绝的条目不再重复确认，同样给出原因。
  const done = sectionOf(api, dataOf(listOf({
    entries: [entryOf({ status: 'confirmed', totalDurationMs: 5000, samples: 4 })],
  })));
  assert.equal(buttonOf(done, '确认').props.disabled, true);
  assert.match(buttonOf(done, '确认').props.title, /已确认/u);

  const gone = sectionOf(api, dataOf(listOf({
    entries: [entryOf({ status: 'rejected', totalDurationMs: 5000, samples: 4 })],
  })));
  assert.equal(buttonOf(gone, '确认').props.disabled, true);
  assert.match(buttonOf(gone, '确认').props.title, /已拒绝/u);

  // 没有条目时也不崩，并给出一句原因。
  assert.equal(api.speakerEnrollConfirmReason(null), '还没有可确认的条目');
  assert.equal(api.speakerEnrollConfirmReason(api.speakerEnrollEntryOf(entryOf(), 0)), '样本不足 3 秒（已 1.2 秒）');
  observed.push('confirmed/rejected=disabled');

  console.log(`[2] ${observed.join(' ; ')}`);
});

// ---------------------------------------------------------------------------
// 3. 确认文案与「不自动动作」
// ---------------------------------------------------------------------------

test('3. 确认成功文案：之后只用于词库与新增记忆归属，不用于拒收/打断', async () => {
  const api = load();
  const success = api.speakerEnrollOutcome('confirm', { ok: true, speakerId: 'self-lin' });
  assert.equal(success.ok, true);
  assert.equal(success.message, api.SPEAKER_ENROLL_CONFIRM_NOTICE);
  for (const phrase of ['词库', '新增记忆归属', '不用于拒收/打断']) {
    assert.ok(success.message.includes(phrase), `the confirm notice mentions ${phrase}`);
  }

  // 样本不足被宿主拒绝时保留受控 reason 的中文说明，不显示成笼统失败。
  const short = api.speakerEnrollOutcome('confirm', { ok: false, reason: 'insufficient-samples' });
  assert.deepEqual(short, { ok: false, message: '样本不足 3 秒，暂时不能确认' });
  // 未实现的动作换成用户能看懂的一句。
  const unimplemented = api.speakerEnrollOutcome('reject', { ok: false, error: 'unknown action: speaker.enroll.reject' });
  assert.equal(unimplemented.ok, false);
  assert.match(unimplemented.message, /需要宿主支持/u);
  assert.match(api.speakerEnrollOutcome('remove', { ok: true }).message, /已删除/u);

  // 渲染本身绝不触发确认 / 拒绝 / 删除；只有点按钮才会调用一次。
  const calls = { confirm: [], reject: [], remove: [], record: 0 };
  const tree = sectionOf(api, dataOf(listOf({ entries: [entryOf({ totalDurationMs: 3000, samples: 3 })] })), {
    onConfirm: (id) => calls.confirm.push(id),
    onReject: (id) => calls.reject.push(id),
    onRemove: (id) => calls.remove.push(id),
    onRecord: () => { calls.record += 1; },
  });
  for (let index = 0; index < 4; index += 1) sectionOf(api, dataOf());
  assert.deepEqual(calls.confirm, [], 'rendering never confirms');
  assert.deepEqual(calls.reject, [], 'rendering never rejects');
  assert.deepEqual(calls.remove, [], 'rendering never removes');
  assert.equal(calls.record, 0, 'rendering never starts a recording');

  // 旧「登记我的声纹」按钮已移除：日常候选 + 显式确认是唯一入口。
  assert.ok(textsOf(tree).includes(api.SPEAKER_ENROLL_RECORD_HINT), 'the candidate hint is on the card');
  assert.match(api.SPEAKER_ENROLL_RECORD_HINT, /声纹影子|候选/u);
  assert.doesNotMatch(api.SPEAKER_ENROLL_RECORD_HINT, /说 3 句话/u);
  assert.equal(textsOf(tree).includes('登记我的声纹'), false, 'no dedicated recording button');

  await buttonOf(tree, '确认').props.onClick();
  assert.deepEqual(calls.confirm, ['self-lin'], 'one click = one confirm call');
  await buttonOf(tree, '拒绝').props.onClick();
  await buttonOf(tree, '删除条目').props.onClick();
  assert.deepEqual(calls.reject, ['self-lin']);
  assert.deepEqual(calls.remove, ['self-lin']);

  // 成功提示在卡片上原样可见（Panel 把 outcome.message 放进 notice）。
  const notices = sectionOf(api, dataOf(), { notice: success.message });
  assert.ok(textsOf(notices).includes(success.message), 'the success notice is rendered');

  console.log(`[3] success="${success.message}" ; short="${short.message}"`);
});

// ---------------------------------------------------------------------------
// 4. 影子观测
// ---------------------------------------------------------------------------

test('4. 影子观测：最近一条 decision/class/quality/score + 三类计数', () => {
  const api = load();
  const observed = [];

  const tree = sectionOf(api, dataOf());
  assert.equal(
    rowValueOf(tree, '最近一条'),
    '匹配（match） · 本人（self） · 清晰（ok） · 分数 0.87',
  );
  assert.equal(rowValueOf(tree, '三类计数'), '匹配 4 · 不匹配 1 · 不确定 2');
  observed.push(`last=${rowValueOf(tree, '最近一条')}`);
  observed.push(`counts=${rowValueOf(tree, '三类计数')}`);

  // 其它判定/质量词表。
  const other = sectionOf(api, dataOf(listOf(), shadowOf({
    lastShadow: lastShadowOf({ decision: 'mismatch', class: 'other', quality: 'quiet', score: 0.12 }),
    counts: { match: 0, mismatch: 3, unsure: 0 },
  })));
  assert.equal(rowValueOf(other, '最近一条'), '不匹配（mismatch） · 他人（other） · 太轻（quiet） · 分数 0.12');
  observed.push('mismatch=不匹配/他人/太轻');

  // 没有样本（lastShadow 缺失或 decision 为空）→ 「暂无样本」。
  assert.equal(rowValueOf(sectionOf(api, dataOf(listOf(), shadowOf({ lastShadow: null }))), '最近一条'), '暂无样本');
  assert.equal(
    rowValueOf(sectionOf(api, dataOf(listOf(), shadowOf({ lastShadow: { class: 'self' } }))), '最近一条'),
    '暂无样本',
  );
  // 影子接口不可用 → 计数「不可用」+ 一行说明，最近一条仍是「暂无样本」。
  const unavailable = sectionOf(api, dataOf(listOf(), { ok: false, error: 'unknown action' }));
  assert.equal(rowValueOf(unavailable, '三类计数'), '不可用');
  assert.equal(rowValueOf(unavailable, '最近一条'), '暂无样本');
  assert.ok(textsOf(unavailable).some((text) => text.includes('需要宿主支持 speaker.status.shadow')));

  // 未知码不翻译、也不崩；缺 class/quality/score 时只显示已有的部分。
  const odd = sectionOf(api, dataOf(listOf(), shadowOf({
    lastShadow: { decision: 'ghost', class: '', quality: '', score: null },
  })));
  assert.equal(rowValueOf(odd, '最近一条'), 'ghost');
  observed.push('unknown=ghost');
  // 计数缺字段 / 非数字 / 负数 → 0。
  const zero = sectionOf(api, dataOf(listOf(), shadowOf({ counts: { match: 'x', mismatch: -2 } })));
  assert.equal(rowValueOf(zero, '三类计数'), '匹配 0 · 不匹配 0 · 不确定 0');
  // 旧宿主字段名 matches 仍被接受。
  const legacy = sectionOf(api, dataOf(listOf(), shadowOf({ counts: { matches: 7, unsure: 1 } })));
  assert.equal(rowValueOf(legacy, '三类计数'), '匹配 7 · 不匹配 0 · 不确定 1');
  observed.push('zero=0/0/0 ; legacy=7/0/1');

  console.log(`[4] ${observed.join(' ; ')}`);
});

// ---------------------------------------------------------------------------
// 5. 失败 / 畸形输入
// ---------------------------------------------------------------------------

test('5. 接口缺失 / 读取失败 / 畸形字段：不崩溃', async () => {
  const api = load();
  const observed = [];

  // 宿主没有这些动作：整块不可用，提示需要宿主支持，不冒充「未登记」。
  const missingAction = sectionOf(api, dataOf({ ok: false, error: 'unknown action: speaker.enroll.list' }));
  assert.ok(textsOf(missingAction).some((text) => text.includes('需要宿主支持声纹登记')));
  assert.equal(rowValueOf(missingAction, '状态'), '不可用');
  observed.push('no-action=需要宿主支持');

  // fetch 抛错：读取结果里的 error 显示在卡片上，渲染不抛。
  const failedRead = await api.speakerEnrollRead(async () => { throw new Error('Failed to fetch'); });
  const failedTree = sectionOf(api, { ...failedRead, loading: false });
  assert.ok(textsOf(failedTree).some((text) => text === '声纹读取失败：Failed to fetch'));
  observed.push('fetch-fail=提示');

  // 没有 fetch：固定提示，不抛。
  const noFetch = await api.speakerEnrollRead(null);
  assert.deepEqual(noFetch, { list: null, shadow: null, error: '当前环境没有 fetch' });
  assert.equal(api.speakerEnrollView(null).loading, true);
  assert.equal(api.speakerEnrollView(noFetch).available, false);
  observed.push('no-fetch=提示');

  // 超时：abort 收成「请求超时」，不抛。
  const timedOut = await api.speakerEnrollRead((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    });
  }), 10);
  assert.equal(timedOut.list.ok, false);
  assert.equal(timedOut.list.error, '请求超时');
  observed.push('timeout=请求超时');

  // 畸形条目：null / 字符串 / 空 speakerId 被跳过；其余字段降级为 0 / ''。
  const messy = {
    ok: true,
    selfId: 42,
    entries: [
      null,
      'x',
      { speakerId: '' },
      { speakerId: 'a', status: 'weird', samples: 'oops', totalDurationMs: 'NaN', confirmedAt: 5 },
      {},
    ],
  };
  const messyTree = sectionOf(api, dataOf(messy, { ok: true, lastShadow: 'nope', counts: [1, 2] }));
  assert.ok(textsOf(messyTree).some((text) => text.includes('a · weird')), 'the one usable entry is kept');
  assert.ok(textsOf(messyTree).some((text) => text.includes('样本 0 条 · 0.0 秒')));
  assert.equal(rowValueOf(messyTree, '状态'), 'weird');
  observed.push('malformed=降级');

  // 数组样本 vs 数字样本：数组按长度，总时长缺失时按各条 durationMs 求和。
  const arrayEntry = api.speakerEnrollEntryOf({
    speakerId: 'b',
    status: 'pending',
    samples: [{ durationMs: 1500 }, { durationMs: 1800 }],
  }, 0);
  assert.equal(arrayEntry.samples, 2);
  assert.equal(arrayEntry.totalDurationMs, 3300);
  assert.equal(arrayEntry.confirmable, true);
  observed.push('samples-array=2/3300ms');

  // 空对象 / 完全没传 props 的卡片也不崩。
  assert.doesNotThrow(() => api.speakerEnrollSection(h, {}));
  assert.doesNotThrow(() => api.speakerEnrollSection(h, { data: undefined }));
  assert.equal(textsOf(api.speakerEnrollSection(h, {})).includes('正在读取声纹登记…'), true);

  // 报告对空数据仍然是一段合法 JSON。
  const report = JSON.parse(api.speakerEnrollReportOf(null));
  assert.equal(report.schema, 1);
  assert.deepEqual(report.entries, []);
  assert.equal(report.shadow.last, null);

  // 复制报告脱敏：标签文本、样本 id、路径与转写都不进报告；状态/计数/分数保留。
  const leaky = dataOf(
    listOf({
      selfId: 'C:\\Users\\PrivateName\\self',
      entries: [entryOf({
        speakerId: 'C:\\Users\\PrivateName\\voice.wav',
        label: 'PRIVATE LABEL 本人',
        sampleId: 'PRIVATE-SAMPLE',
        status: 'confirmed',
        samples: 3,
        totalDurationMs: 3300,
        confirmedAt: '2026-11-09T03:00:00.000Z',
      })],
    }),
    shadowOf({ lastShadow: lastShadowOf({ at: 'C:\\private\\shadow.json' }) }),
  );
  const leakReport = api.speakerEnrollReportOf(leaky);
  const leakParsed = JSON.parse(leakReport);
  assert.equal(leakParsed.entries.length, 1);
  assert.equal(leakParsed.entries[0].speakerId, '<redacted>');
  assert.equal(leakParsed.entries[0].status, 'confirmed');
  assert.equal(leakParsed.entries[0].samples, 3);
  assert.equal(leakParsed.entries[0].totalDurationMs, 3300);
  assert.equal(leakParsed.entries[0].confirmed, true);
  assert.equal(leakParsed.selfId, '<redacted>');
  assert.equal(leakParsed.shadow.last.at, '<redacted>');
  assert.equal(leakParsed.shadow.last.speakerId, 'self-lin');
  assert.equal(leakParsed.shadow.last.decision, 'match');
  assert.equal(leakParsed.shadow.last.score, 0.87);
  assert.equal(leakParsed.shadow.counts.match, 4);
  for (const secret of ['PRIVATE', 'PrivateName', 'voice.wav', 'C:\\', 'label']) {
    assert.equal(leakReport.includes(secret), false, `the report leaked ${secret}`);
  }
  observed.push('report=脱敏');

  console.log(`[5] ${observed.join(' ; ')}`);
});

// ---------------------------------------------------------------------------
// 6. 无轮询 / 单次读取
// ---------------------------------------------------------------------------

test('6. 无轮询：单次读取（list + shadow），渲染不发请求，只有手动刷新', async () => {
  const api = load();
  const observed = [];

  const requests = [];
  const fetchStub = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, action: body.action });
    return {
      ok: true,
      json: async () => (body.action === 'speaker.enroll.list' ? listOf() : shadowOf()),
    };
  };
  const read = await api.speakerEnrollRead(fetchStub);
  assert.deepEqual(requests.map((item) => item.action), ['speaker.enroll.list', 'speaker.status.shadow']);
  assert.equal(requests.length, 2, 'one read = one list + one shadow request');
  assert.equal(requests[0].url, '/assistant/action');
  assert.equal(read.list.ok, true);
  assert.equal(read.shadow.ok, true);
  observed.push('read=2 requests (list+shadow)');

  for (let index = 0; index < 5; index += 1) sectionOf(api, read);
  assert.equal(requests.length, 2, 'rendering never fetches');

  let refreshed = 0;
  const tree = sectionOf(api, read, { onRefresh: async () => { refreshed += 1; } });
  await buttonOf(tree, '刷新').props.onClick();
  assert.equal(refreshed, 1, 'the refresh button asks the panel to read again');
  assert.equal(requests.length, 2, 'the section itself still sends nothing');
  observed.push('render=0 fetch ; refresh=1 handler');

  // 静态：区块本身没有定时器；Panel 只在挂载时读一次，轮询仍只有那一个 3 秒 load。
  assert.doesNotMatch(block, /setInterval/u, 'the speaker-enrollment block installs no timer');
  assert.doesNotMatch(block, /requestAnimationFrame/u);
  assert.equal((clientSource.match(/setInterval\(load, 3000\)/gu) ?? []).length, 1, 'no second polling source');
  assert.match(
    clientSource,
    /useEffect\(\(\) => \{\s*void loadSpeakerEnroll\(\);\s*\}, \[loadSpeakerEnroll\]\);/u,
    'Panel reads speaker enrollment once on mount',
  );
  assert.equal((clientSource.match(/void loadSpeakerEnroll\(\)/gu) ?? []).length, 2,
    'only the mount effect and the refresh handler read it');
  assert.match(clientSource, /onRefresh: \(\) => void loadSpeakerEnroll\(\)/u, 'refresh is the only other read');
  assert.match(clientSource, /speakerEnrollSection\(h, \{/u, 'the card is mounted in settings');
  assert.match(clientSource, /action: 'speaker\.enroll\.confirm', speakerId/u);
  assert.match(clientSource, /action: 'speaker\.enroll\.reject', speakerId/u);
  assert.match(clientSource, /action: 'speaker\.enroll\.remove', speakerId/u);
  assert.match(clientSource, /action: 'speaker\.status\.shadow'/u);
  // 没有任何自动确认 / 自动拒绝的调用点：确认只来自按钮 handler。
  assert.doesNotMatch(block, /speaker\.enroll\.confirm/u, 'the render block never calls the action itself');
  observed.push('static=no timer, mount-only read');

  console.log(`[6] ${observed.join(' ; ')}`);
});

// ---------------------------------------------------------------------------
// 7. 回归
// ---------------------------------------------------------------------------

test('7. 回归：client-diagnostics / client-instance-settings / client-polling / smoke', async (t) => {
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
  console.log(`[7] ${summary}`);
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
