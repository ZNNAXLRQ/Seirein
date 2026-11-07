/**
 * P-69 settings side (A plan, user-final 2026-11-07): review fast-path conversations grouped by
 * domain, where the group key is the stable `ws:<hash>` / allowed domain ID and the header shows
 * the separate `label` (workspace directory name).
 *
 * The shipped review block is evaluated with an injected recording `h` — no DOM and no React
 * needed (same technique as profile-ui.mjs). The host actions (`fastpath.history`,
 * `fastpath.clear`) are exercised through a real plugin mount against a temp root, so the scope
 * filter and clearing are proven against the JSONL file itself.
 *
 * Proves:
 *  1. a workspace group shows its label, a label-less group shows the ID's first 8 characters,
 *     and the empty domain shows 「未分组」;
 *  2. filtering by the stable ID shows only that group, whose header still uses the label;
 *  3. clearing one domain removes only its lines — other domains keep every line;
 *  4. an empty file renders a placeholder instead of throwing;
 *  5. legacy lines without `domain` are read as ungrouped and shown as 「未分组」;
 *  6. after clearing a domain, the very next fast-path request no longer contains that domain's
 *     records (the in-memory history is reloaded, not just the file);
 *  7. a real host domain (config.defaultDomain) lands on new lines and drives the visible groups;
 *  8. with no explicit domain the host writes the current workspace ID + its label — grouping is
 *     by workspace, never by topic or by an inferred name;
 *  9. reading the review only returns domains of the current scope: another workspace's ID and a
 *     non-allowed name are invisible and cannot be cleared.
 *
 * Run: node --test test/fastpath-ui.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { apply } from '../src/host/index.js';
import { workspaceDomainId } from '../src/host/session/inference/fastpath.js';
import { cleanupRoot } from './helpers/cleanup.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const clientSource = readFileSync(join(here, '..', 'client.js'), 'utf8');

// ---- fixture kit ---------------------------------------------------------------------------

/** Minimal style kit so the shipped slice can run without a DOM or React. */
const styles = new Proxy({}, { get: (_target, key) => ({ marker: String(key) }) });
const line = (label, value) => ({ type: 'line', props: { label, value }, children: [] });

/** Recording element factory: every node keeps its type, props and children. */
const h = (type, props, ...children) => ({ type, props: props ?? {}, children });

const walk = (node, visit) => {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node !== 'object') return;
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
};

const collect = (tree, predicate) => {
  const found = [];
  walk(tree, (node) => {
    if (predicate(node)) found.push(node);
  });
  return found;
};

/** All descendant text, in document order (strings only). */
const textOf = (node) => {
  const parts = [];
  walk(node, (item) => {
    for (const child of item.children ?? []) {
      if (typeof child === 'string') parts.push(child);
    }
  });
  return parts.join(' ');
};

/** Extract the shipped fastpath review kit (helpers + body) from client.js. */
const loadFastpathKit = () => {
  const from = clientSource.indexOf('    // ---- fastpath review (快路对话按域审阅)');
  const to = clientSource.indexOf('    // ---- profile library (人设库)', from);
  assert.ok(from > 0 && to > from, 'the shipped fastpath review kit is found in client.js');
  const slice = clientSource.slice(from, to);
  return new Function(
    'styles', 'line', 'MUTED', 'ACCENT', 'BORDER', 'DANGER',
    `${slice}\nreturn {
      fastpathReviewBody,
      fastpathDomainLabel,
      fastpathPreview,
      FASTPATH_GROUP_ALL,
    };`,
  )(styles, line, '#6b7280', '#3b5bdb', '#d8dce3', '#c92a2a');
};

const handlers = (overrides = {}) => ({
  setFilter: () => {},
  toggleGroup: () => {},
  toggleText: () => {},
  requestClear: () => {},
  cancelClear: () => {},
  confirmClear: () => {},
  refresh: () => {},
  close: () => {},
  ...overrides,
});

const render = (groups, state = {}, customHandlers = handlers()) => loadFastpathKit().fastpathReviewBody(h, {
  groups,
  filter: '*',
  open: [],
  expanded: [],
  confirm: null,
  busy: false,
  loading: false,
  ...state,
}, customHandlers);

const entry = (ts, role, text, extra = {}) => ({ ts, role, text, provider: '', model: '', ms: 0, domain: '', domainLabel: '', ...extra });

const WORKSPACE_ID = 'ws:0123456789ab';
const OTHER_WORKSPACE_ID = 'ws:ba9876543210';

/** One workspace group (label), one label-less named group, one ungrouped bucket. */
const fixtureGroups = () => [
  {
    domain: WORKSPACE_ID,
    label: 'Seirein',
    count: 2,
    entries: [
      entry(5_000, 'assistant', '先写周报，再排明天的会', { provider: 'deepseek', model: 'deepseek-flash', ms: 321, domainLabel: 'Seirein' }),
      entry(4_000, 'user', '今天的工作安排', { domainLabel: 'Seirein' }),
    ],
  },
  {
    domain: 'movie',
    label: '',
    count: 1,
    entries: [entry(3_000, 'user', '推荐一部电影', { domain: 'movie' })],
  },
  {
    domain: '',
    label: '',
    count: 1,
    entries: [entry(1_000, 'user', '随口一句')],
  },
];

// ---- host mount (real /assistant/action route) ---------------------------------------------

async function mount(t, { conversation = null, features = null, services = null, config = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-fastpath-ui-'));
  // Seed the persisted conversation and the feature switches before the plugin mounts, so
  // `FastPath` loads this history and `fastpath.test` is enabled.
  if (Array.isArray(conversation) && conversation.length > 0) await writeConversation(root, conversation);
  if (features !== null) {
    await mkdir(join(root, 'data'), { recursive: true });
    await writeFile(join(root, 'data', 'features.json'), JSON.stringify(features), 'utf8');
  }
  const routes = new Map();
  const cleanups = [];
  const effect = (fn) => {
    const cleanup = fn();
    if (typeof cleanup === 'function') cleanups.push(cleanup);
    return cleanup;
  };
  const ctx = {
    effect,
    get: (name) => (services === null ? undefined : services[name]),
    tools: { register: () => () => {} },
    inject: (_deps, registerScope) => {
      registerScope({
        effect,
        systemPrompt: { section: () => () => {} },
        webServer: {
          register(route) {
            routes.set(route.path, route.handler);
            return () => routes.delete(route.path);
          },
        },
      });
    },
  };
  apply(ctx, { root, enabled: true, ...(config ?? {}) });
  t.after(async () => {
    await cleanupRoot(root, cleanups);
  });
  // The host scope defaults to `<root>/workspace`; its path decides the stable domain ID.
  const workspacePath = join(root, 'workspace');
  const act = (body) => new Promise((resolve, reject) => {
    const handler = routes.get('/assistant/action');
    assert.equal(typeof handler, 'function', 'the action route is registered');
    const req = Object.assign(Readable.from([JSON.stringify(body)]), { method: 'POST' });
    const res = { writeHead() {}, end(payload) { resolve(JSON.parse(payload)); } };
    Promise.resolve(handler(req, res)).catch(reject);
  });
  return { root, act, workspacePath, workspaceId: workspaceDomainId(workspacePath) };
}

async function writeConversation(root, lines) {
  await mkdir(join(root, 'data'), { recursive: true });
  await writeFile(
    join(root, 'data', 'conversation.jsonl'),
    lines.map((row) => (typeof row === 'string' ? row : JSON.stringify(row))).join('\n') + '\n',
    'utf8',
  );
}

async function readConversation(root) {
  const text = await readFile(join(root, 'data', 'conversation.jsonl'), 'utf8');
  return text.split('\n').filter(Boolean).map((row) => JSON.parse(row));
}

const groupOf = (groups, domain) => groups.find((group) => group.domain === domain);

// ---- 1. labels -----------------------------------------------------------------------------

test('1. 分组标题显示 label；无 label 显示 ID 前 8 位；空显示「未分组」', () => {
  const groups = fixtureGroups();
  const tree = render(groups);
  const cards = collect(tree, (node) => node.props['data-fastpath-review'] === true);
  assert.equal(cards.length, 1, 'the card renders one review block');

  const headers = collect(tree, (node) => node.type === 'button' && node.props['data-fastpath-action'] === 'toggle-group');
  assert.equal(headers.length, 3, 'one collapsible header per domain');
  const titles = Object.fromEntries(headers.map((node) => [node.props['data-domain'], textOf(node)]));
  assert.match(titles[WORKSPACE_ID], /▸ Seirein（2）/u, 'a workspace group shows its directory-name label');
  assert.match(titles.movie, /▸ movie（1）/u, 'a label-less group shows the first 8 characters of its ID');
  assert.match(titles[''], /▸ 未分组（1）/u, 'the empty domain is 「未分组」');
  assert.doesNotMatch(titles[WORKSPACE_ID], /ws:01234/u, 'the hash is not shown when a label exists');
  assert.deepEqual(
    collect(tree, (node) => node.props['data-fastpath-entries'] !== undefined).length,
    0,
    'every group starts collapsed',
  );
  assert.match(textOf(cards[0]), /对话记录 · 4 条 \/ 3 个域/u);

  const kit = loadFastpathKit();
  assert.equal(kit.fastpathDomainLabel(''), '未分组');
  assert.equal(kit.fastpathDomainLabel('', 'ignored'), '未分组');
  assert.equal(kit.fastpathDomainLabel(WORKSPACE_ID, 'Seirein'), 'Seirein');
  assert.equal(kit.fastpathDomainLabel(WORKSPACE_ID), 'ws:01234', 'no label → first 8 characters of the ID');
  assert.equal(kit.fastpathDomainLabel(WORKSPACE_ID, '   '), 'ws:01234');
  assert.equal(kit.fastpathDomainLabel('work'), 'work');

  // Entry row: time + role + provider/model/ms, long text truncated, expandable.
  const longText = '很长的对话内容'.repeat(20);
  const detail = [{ domain: WORKSPACE_ID, label: 'Seirein', count: 1, entries: [entry(9_000, 'assistant', longText, { provider: 'deepseek', model: 'deepseek-flash', ms: 321, domainLabel: 'Seirein' })] }];
  const collapsed = render(detail, { open: [WORKSPACE_ID] });
  const previewNode = collect(collapsed, (node) => node.props['data-fastpath-text'] !== undefined)[0];
  assert.ok(previewNode, 'an open group renders its entry text');
  assert.match(textOf(previewNode), /…$/u, 'long text is truncated');
  const expandButton = collect(collapsed, (node) => node.props['data-fastpath-action'] === 'toggle-text')[0];
  assert.equal(textOf(expandButton), '展开全文');
  const detailText = textOf(collapsed);
  assert.match(detailText, /\d{2}\/\d{2} \d{2}:\d{2}/u, 'the entry shows its time');
  assert.match(detailText, /助手/u, 'the entry shows its role');
  assert.match(detailText, /deepseek\/deepseek-flash · 321 ms/u, 'the entry shows provider/model/ms');
  const fullTree = render(detail, { open: [WORKSPACE_ID], expanded: [previewNode.props['data-fastpath-text']] });
  assert.equal(textOf(collect(fullTree, (node) => node.props['data-fastpath-text'] !== undefined)[0]), longText,
    'expanded text is shown in full');
  assert.equal(textOf(collect(fullTree, (node) => node.props['data-fastpath-action'] === 'toggle-text')[0]), '收起');

  // The card actually mounts the kit (settings card → review block).
  assert.ok(
    clientSource.lastIndexOf('fastpathReviewBody(h,') > clientSource.indexOf("'闲聊模式（可选）'"),
    'the review block is mounted inside the chat-mode card',
  );
  console.log(`1) groups=${headers.length} titles=${JSON.stringify(titles)}`);
});

// ---- 2. filter -----------------------------------------------------------------------------

test('2. 按稳定 ID 筛选：只剩该域，标题仍显示 label', () => {
  const kit = loadFastpathKit();
  const tree = render(fixtureGroups(), { filter: WORKSPACE_ID });
  const groups = collect(tree, (node) => node.props['data-fastpath-group'] !== undefined);
  assert.equal(groups.length, 1, 'only the filtered workspace group survives');
  assert.equal(groups[0].props['data-fastpath-group'], WORKSPACE_ID, 'the filter key stays the stable ID');
  assert.match(textOf(groups[0]), /Seirein（2）/u, 'the header keeps the label');
  assert.doesNotMatch(textOf(groups[0]), /今天有点累|推荐一部电影|随口一句/u);
  assert.equal(collect(tree, (node) => node.props['data-fastpath-entry'] !== undefined).length, 2,
    'the filtered group is expanded so its entries are visible');

  // 「全部」 + 「未分组」 are always present; named groups use their labels in the options.
  const options = collect(tree, (node) => node.type === 'option');
  assert.deepEqual(options.map((node) => node.props.value), [kit.FASTPATH_GROUP_ALL, '', WORKSPACE_ID, 'movie']);
  assert.deepEqual(options.map((node) => textOf(node)), ['全部', '未分组', 'Seirein', 'movie']);

  const ungrouped = render(fixtureGroups(), { filter: '' });
  assert.match(textOf(collect(ungrouped, (node) => node.props['data-fastpath-group'] !== undefined)[0]), /未分组（1）/u);
  console.log(`2) groups=1 title="${textOf(groups[0]).trim()}" options=${options.map((node) => textOf(node)).join(',')}`);
});

// ---- 3. clear one domain -------------------------------------------------------------------

test('3. 清空某域：该域条目消失、其它域不变（断言文件行数）', async (t) => {
  const { root, act, workspaceId } = await mount(t, { config: { allowedDomains: ['movie'] } });
  await writeConversation(root, [
    { ts: 1, role: 'user', text: '工作问题', domain: workspaceId, domainLabel: 'workspace' },
    { ts: 2, role: 'assistant', text: '工作回答', domain: workspaceId, domainLabel: 'workspace', provider: 'deepseek', model: 'deepseek-flash', ms: 5 },
    { ts: 3, role: 'user', text: '电影问题', domain: 'movie' },
    { ts: 4, role: 'assistant', text: '电影回答', domain: 'movie' },
    { ts: 5, role: 'user', text: '闲聊问题', domain: '' },
    { ts: 6, role: 'user', text: '未分组问题' }, // legacy line: no domain field
  ]);

  const before = await act({ action: 'fastpath.history' });
  assert.equal(before.ok, true);
  assert.equal(before.total, 6);
  assert.deepEqual(
    Object.fromEntries(before.groups.map((group) => [group.domain, group.count])),
    { [workspaceId]: 2, movie: 2, '': 2 },
    'three visible groups with the persisted counts',
  );
  const workspaceGroup = groupOf(before.groups, workspaceId);
  assert.equal(workspaceGroup.label, 'workspace', 'the group carries the display label');
  assert.deepEqual(workspaceGroup.entries.map((row) => row.domainLabel), ['workspace', 'workspace']);
  assert.deepEqual(groupOf(before.groups, 'movie').entries.map((row) => row.text), ['电影回答', '电影问题'],
    'entries are newest first inside a group');

  const cleared = await act({ action: 'fastpath.clear', domain: 'movie' });
  assert.deepEqual({ ok: cleared.ok, domain: cleared.domain, removed: cleared.removed }, { ok: true, domain: 'movie', removed: 2 });

  const lines = await readConversation(root);
  assert.equal(lines.length, 4, 'only the two movie lines were deleted');
  assert.deepEqual(lines.map((row) => row.text), ['工作问题', '工作回答', '闲聊问题', '未分组问题'],
    'other domains keep every line, in the original order');

  const after = await act({ action: 'fastpath.history' });
  assert.equal(after.total, 4);
  assert.equal(after.groups.some((group) => group.domain === 'movie'), false, 'cleared domain is gone from the review');

  // A request without a domain is refused and writes nothing.
  const refused = await act({ action: 'fastpath.clear' });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /请指定/u);
  const invalid = await act({ action: 'fastpath.clear', domain: '../evil' });
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /域不合法/u);
  assert.equal((await readConversation(root)).length, 4, 'refused clears keep the file as-is');
  console.log(`3) before=6 after=${lines.length} removed=${cleared.removed} groups=${JSON.stringify(Object.fromEntries(after.groups.map((group) => [group.domain, group.count])))}`);
});

// ---- 4. empty ------------------------------------------------------------------------------

test('4. 空记录：占位文案，无异常', async (t) => {
  const { act, workspaceId } = await mount(t);
  const history = await act({ action: 'fastpath.history' });
  assert.deepEqual(history, { ok: true, groups: [], total: 0 });

  const tree = render([]);
  const empty = collect(tree, (node) => node.props['data-fastpath-empty'] === true)[0];
  assert.ok(empty, 'an empty file renders the placeholder');
  assert.match(textOf(empty), /没有快路对话记录/u);
  assert.equal(collect(tree, (node) => node.props['data-fastpath-group'] !== undefined).length, 0);

  const filtered = render([], { filter: '' });
  assert.match(textOf(collect(filtered, (node) => node.props['data-fastpath-empty'] === true)[0]), /「未分组」没有记录/u);

  // Clearing an in-scope domain with no conversation file is a no-op success, not a crash.
  const noop = await act({ action: 'fastpath.clear', domain: workspaceId });
  assert.deepEqual({ ok: noop.ok, removed: noop.removed }, { ok: true, removed: 0 });
  console.log(`4) groups=${history.groups.length} empty="${textOf(empty)}"`);
});

// ---- 5. legacy lines -----------------------------------------------------------------------

test('5. 旧记录（无 domain）：归入「未分组」显示，且不被改写', async (t) => {
  const { root, act, workspaceId } = await mount(t);
  await writeConversation(root, [
    { ts: 100, role: 'user', text: '旧问题' },
    { ts: 101, role: 'assistant', text: '旧回答', provider: 'deepseek', model: 'deepseek-flash', ms: 12 },
    { ts: 102, role: 'user', text: '新问题', domain: workspaceId, domainLabel: 'workspace' },
  ]);
  const raw = await readFile(join(root, 'data', 'conversation.jsonl'), 'utf8');

  const history = await act({ action: 'fastpath.history' });
  const ungrouped = groupOf(history.groups, '');
  assert.ok(ungrouped, 'legacy lines land in the ungrouped group');
  assert.equal(ungrouped.count, 2);
  assert.equal(ungrouped.label, '', 'the ungrouped bucket has no label');
  assert.deepEqual(ungrouped.entries.map((row) => row.text), ['旧回答', '旧问题']);
  assert.equal(ungrouped.entries.every((row) => row.domain === ''), true, 'missing domain normalizes to ""');
  assert.equal(groupOf(history.groups, workspaceId).label, 'workspace');

  const tree = render(history.groups, { filter: '' });
  const titles = collect(tree, (node) => node.type === 'button' && node.props['data-fastpath-action'] === 'toggle-group');
  assert.equal(titles.length, 1);
  assert.match(textOf(titles[0]), /未分组（2）/u);
  assert.match(textOf(tree), /旧问题|旧回答/u);
  assert.equal(await readFile(join(root, 'data', 'conversation.jsonl'), 'utf8'), raw,
    'reading the review never rewrites legacy lines');

  // Clearing the ungrouped bucket deletes the legacy lines only; the named domain stays.
  const cleared = await act({ action: 'fastpath.clear', domain: '' });
  assert.deepEqual({ ok: cleared.ok, removed: cleared.removed }, { ok: true, removed: 2 });
  const remaining = await readConversation(root);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].text, '新问题');
  console.log(`5) ungrouped=${ungrouped.count} remaining=${remaining.length}`);
});

// ---- 6. cleared domain leaves the in-memory history immediately ----------------------------

test('6. 清空某域后立即请求：模型输入不再包含该域记录', async (t) => {
  const requests = [];
  const { root, act, workspaceId } = await mount(t, {
    conversation: [
      { ts: 1, role: 'user', text: '电影推荐有什么', domain: 'movie' },
      { ts: 2, role: 'assistant', text: '电影回答内容', domain: 'movie', provider: 'deepseek', model: 'deepseek-flash', ms: 5 },
      { ts: 3, role: 'user', text: '工作安排是什么', domain: 'work' },
    ],
    features: { fastpath: true },
    config: { allowedDomains: ['movie'] },
    services: {
      llm: {
        async *stream(request) {
          requests.push(request);
          yield { type: 'text-delta', index: 0, text: '好的。' };
          yield { type: 'finish', reason: { kind: 'stop' } };
        },
      },
      agentDefaultModel: { currentSelection: () => ({ provider: 'fake-provider', model: 'fake-model' }) },
    },
  });

  const before = await act({ action: 'fastpath.test', text: '清空前的一句话' });
  assert.equal(before.ok, true, before.error ?? 'the fast-path test request succeeds');
  assert.equal(requests.length, 1, 'one LLM request before clearing');
  // P2: the prompt is SCOPED to the turn's own domain, so another domain's rows are not in it.
  assert.doesNotMatch(JSON.stringify(requests[0]), /电影推荐有什么|电影回答内容|工作安排是什么/u,
    'P2: prompt is scoped to the current domain');

  const cleared = await act({ action: 'fastpath.clear', domain: 'movie' });
  assert.deepEqual({ ok: cleared.ok, domain: cleared.domain, removed: cleared.removed },
    { ok: true, domain: 'movie', removed: 2 });
  assert.equal((await readConversation(root)).some((row) => row.domain === 'movie'), false,
    'the movie lines are gone from disk');

  // The very next request must not replay the deleted domain: the in-memory history was reloaded.
  const after = await act({ action: 'fastpath.test', text: '清空后的一句话' });
  assert.equal(after.ok, true, after.error ?? 'the fast-path test request after clearing succeeds');
  assert.equal(requests.length, 2, 'one new LLM request after clearing');
  const requestTextAfter = JSON.stringify(requests[1]);
  assert.doesNotMatch(requestTextAfter, /电影推荐有什么|电影回答内容/u,
    'no cleared-domain record is in the next model input');
  // P2: another domain never enters the prompt, while the same domain's previous turn still does.
  assert.doesNotMatch(requestTextAfter, /工作安排是什么/u,
    'another domain stays out of the prompt (still visible in the review)');
  assert.match(requestTextAfter, /清空前的一句话/u,
    'the same domain\'s previous turn stays in the history');
  // The new turn is grouped under the current workspace, not under a cleared/generated name.
  const lines = await readConversation(root);
  assert.deepEqual(lines.slice(-2).map((row) => row.domain), [workspaceId, workspaceId]);
  console.log(`6) before=1 request with movie history; cleared=${cleared.removed} lines; `
    + `after movie=${/电影推荐有什么|电影回答内容/u.test(String(requests[1].system ?? ''))} `
    + `newDomain=${lines.at(-1).domain}`);
});

// ---- 7. new turns carry config.defaultDomain -----------------------------------------------

test('7. 新条目落 config.defaultDomain：历史行与分组一致（无 label）', async (t) => {
  const requests = [];
  const { root, act } = await mount(t, {
    features: { fastpath: true },
    config: { defaultDomain: 'work' },
    services: {
      llm: {
        async *stream(request) {
          requests.push(request);
          yield { type: 'text-delta', index: 0, text: '好的。' };
          yield { type: 'finish', reason: { kind: 'stop' } };
        },
      },
      agentDefaultModel: { currentSelection: () => ({ provider: 'fake-provider', model: 'fake-model' }) },
    },
  });

  const result = await act({ action: 'fastpath.test', text: '帮我整理周报' });
  assert.equal(result.ok, true, result.error ?? 'the fast-path request succeeds');
  assert.equal(requests.length, 1);

  const lines = await readConversation(root);
  assert.deepEqual(lines.map((row) => row.domain), ['work', 'work'],
    'the configured default wins over the workspace ID');
  assert.deepEqual(lines.map((row) => row.domainLabel), ['', ''], 'a configured name has no display label');

  const history = await act({ action: 'fastpath.history' });
  assert.deepEqual(
    history.groups.map((group) => ({ domain: group.domain, label: group.label, count: group.count })),
    [{ domain: 'work', label: '', count: 2 }],
    'the review groups by the configured domain',
  );

  const tree = render(history.groups);
  const headers = collect(tree, (node) => node.type === 'button' && node.props['data-fastpath-action'] === 'toggle-group');
  assert.equal(headers.length, 1, 'one domain group');
  assert.match(textOf(headers[0]), /work（2）/u);
  assert.doesNotMatch(textOf(headers[0]), /未分组/u);
  console.log(`7) domains=${JSON.stringify(lines.map((row) => row.domain))} `
    + `groups=${JSON.stringify(history.groups.map((group) => [group.domain, group.label, group.count]))}`);
});

// ---- 8. no explicit domain: the workspace ID + label ---------------------------------------

test('8. 无显式域：落当前工作区稳定 ID + 目录名 label，不按话题/名字再分', async (t) => {
  const requests = [];
  const { root, act, workspaceId } = await mount(t, {
    features: { fastpath: true },
    services: {
      llm: {
        async *stream(request) {
          requests.push(request);
          yield { type: 'text-delta', index: 0, text: '好的。' };
          yield { type: 'finish', reason: { kind: 'stop' } };
        },
      },
      agentDefaultModel: { currentSelection: () => ({ provider: 'fake-provider', model: 'fake-model' }) },
    },
  });

  // Two unrelated topics in the same workspace must share one domain.
  await act({ action: 'fastpath.test', text: '帮我看看这个动画' });
  const result = await act({ action: 'fastpath.test', text: '今天有点累' });
  assert.equal(result.ok, true, result.error ?? 'the fast-path request succeeds');
  const lines = await readConversation(root);
  assert.deepEqual(lines.map((row) => row.domain), [workspaceId, workspaceId, workspaceId, workspaceId],
    'one workspace = one domain, whatever the topic');
  assert.deepEqual(lines.map((row) => row.domainLabel),
    [basename(join(root, 'workspace')), basename(join(root, 'workspace')), basename(join(root, 'workspace')), basename(join(root, 'workspace'))]);
  assert.match(workspaceId, /^ws:[0-9a-f]{12}$/u);

  const history = await act({ action: 'fastpath.history' });
  assert.deepEqual(history.groups.map((group) => ({ domain: group.domain, label: group.label, count: group.count })),
    [{ domain: workspaceId, label: 'workspace', count: 4 }], 'the only group is the workspace');

  const kit = loadFastpathKit();
  const tree = render(history.groups);
  const headers = collect(tree, (node) => node.type === 'button' && node.props['data-fastpath-action'] === 'toggle-group');
  assert.equal(headers.length, 1, 'one group header');
  assert.deepEqual(headers.map((node) => node.props['data-domain']), [workspaceId],
    'the rendered key is the stable ID');
  assert.match(textOf(headers[0]), /workspace（4）/u, 'the header shows the directory-name label');
  assert.doesNotMatch(textOf(headers[0]), /ws:[0-9a-f]/u);
  assert.equal(kit.fastpathDomainLabel(''), '未分组');
  console.log(`8) domains=${JSON.stringify(lines.map((row) => row.domain))} `
    + `label="${history.groups[0].label}" header="${textOf(headers[0]).trim()}"`);
});

// ---- 9. cross-scope isolation --------------------------------------------------------------

test('9. 跨作用域隔离：只读当前作用域允许的域，别的工作区域不可见/不可清空', async (t) => {
  const { root, act, workspaceId } = await mount(t, { config: { allowedDomains: ['work'] } });
  const otherId = workspaceDomainId(join(root, 'another-workspace'));
  await writeConversation(root, [
    { ts: 1, role: 'user', text: '本工作区问题', domain: workspaceId, domainLabel: 'workspace' },
    { ts: 2, role: 'assistant', text: '本工作区回答', domain: workspaceId, domainLabel: 'workspace' },
    { ts: 3, role: 'user', text: '允许的域问题', domain: 'work' },
    { ts: 4, role: 'user', text: '旧行问题', domain: '' },
    { ts: 5, role: 'user', text: '别的工作区问题', domain: otherId, domainLabel: 'another-workspace' },
    { ts: 6, role: 'assistant', text: '别的工作区回答', domain: otherId, domainLabel: 'another-workspace' },
    { ts: 7, role: 'user', text: '未允许的域问题', domain: 'movie' },
  ]);
  const before = await readFile(join(root, 'data', 'conversation.jsonl'), 'utf8');

  const history = await act({ action: 'fastpath.history' });
  assert.equal(history.total, 4, 'only this scope\'s domains plus ungrouped are readable');
  assert.deepEqual(history.groups.map((group) => group.domain), ['', 'work', workspaceId],
    'groups keep first-seen order of the newest-first review, and no other scope is present');
  const visible = JSON.stringify(history.groups);
  assert.doesNotMatch(visible, /别的工作区问题|别的工作区回答|未允许的域问题/u,
    'another workspace\'s group never appears');
  assert.equal(visible.includes(otherId), false, 'the other workspace ID is never a group key');

  // Asking for the other scope's domain explicitly returns nothing, it does not reveal rows.
  const filtered = await act({ action: 'fastpath.history', domain: otherId });
  assert.deepEqual({ total: filtered.total, groups: filtered.groups }, { total: 0, groups: [] });

  // It is not deletable either.
  const refused = await act({ action: 'fastpath.clear', domain: otherId });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /作用域/u);
  const refusedName = await act({ action: 'fastpath.clear', domain: 'movie' });
  assert.equal(refusedName.ok, false);
  assert.match(refusedName.error, /作用域/u);
  assert.equal(await readFile(join(root, 'data', 'conversation.jsonl'), 'utf8'), before,
    'a refused clear leaves every line untouched');

  // A domain inside the allow-list is still clearable.
  const cleared = await act({ action: 'fastpath.clear', domain: 'work' });
  assert.deepEqual({ ok: cleared.ok, removed: cleared.removed }, { ok: true, removed: 1 });
  console.log(`9) total=${history.total} groups=${JSON.stringify(history.groups.map((group) => group.domain))} `
    + `otherRefused="${refused.error}" cleared=${cleared.removed}`);
});
