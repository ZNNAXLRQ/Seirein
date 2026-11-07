/**
 * P-69 host side (A plan, user-final 2026-11-07): a persisted conversation turn carries a real
 * `domain` and a display-only `domainLabel`.
 *
 * Priority: explicit caller domain > config.defaultDomain > `ws:<sha256(path)[0..12]>` > ''
 * (default / ungrouped). The workspace ID is derived from the workspace PATH, never from its
 * directory name; the directory name is only `domainLabel`. A caller domain outside the current
 * scope's allow-list (workspace ID / config.defaultDomain / config.allowedDomains) is rejected
 * and the turn falls back to the workspace ID, so another scope's group is never read or written.
 * Old lines without the field stay readable and ungrouped (''); `groupByDomain` is a stable pure
 * grouping helper.
 *
 * Run: node --test test/fastpath-domain.mjs
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';

import {
  FastPath,
  UNGROUPED_DOMAIN,
  domainScope,
  groupByDomain,
  isTurnDomain,
  normalizeTurnDomain,
  normalizeWorkspacePath,
  resolveTurnDomain,
  workspaceDomainId,
  workspaceDomainLabel,
} from '../src/host/session/inference/fastpath.js';

const WORKSPACE_ID_RE = /^ws:[0-9a-f]{12}$/u;
const reply = (round) => `回复${round}`;

async function harness({ config, workspace, now } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-fastpath-domain-'));
  const path = workspace ?? join(root, 'workspace');
  const requests = [];
  const events = [];
  let round = 0;
  const llm = {
    async *stream(request) {
      requests.push(request);
      const index = round;
      round += 1;
      yield { type: 'text-delta', index: 0, text: reply(index) };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const deps = {
    getLlm: () => llm,
    getSelection: () => ({
      currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-flash' }),
    }),
    persona: { read: () => '' },
    memory: { brief: () => ({ text: '' }) },
    log: {
      emit: async (type, payload) => {
        events.push({ type, payload });
      },
    },
  };
  const make = (overrides = {}) => new FastPath({ root, workspace: path, config, now, ...deps, ...overrides });
  return { root, workspace: path, fastPath: make(), make, requests, events };
}

async function persisted(root) {
  const text = await readFile(join(root, 'data', 'conversation.jsonl'), 'utf8');
  return text
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return []; // a torn write stays on disk but is not a turn
      }
    });
}

async function writeLines(root, lines) {
  await mkdir(join(root, 'data'), { recursive: true });
  return writeFile(join(root, 'data', 'conversation.jsonl'), lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') + '\n', 'utf8');
}

const domainEvents = (events) => events.filter((event) => event.type === 'fastpath.domain').map((event) => event.payload);
const rejectedEvents = (events) => events.filter((event) => event.type === 'fastpath.domain.rejected').map((event) => event.payload);
const scopeEvents = (events) => events.filter((event) => event.type === 'fastpath.context.scope').map((event) => event.payload);

test('P-69 A1: an explicit caller domain wins and is reported as caller', async () => {
  const { root, workspace, fastPath, events } = await harness({
    // 'work' is explicitly allowed; the configured default is a different domain.
    config: { defaultDomain: 'home', allowedDomains: ['work'] },
  });

  await fastPath.askStream('帮我整理周报', { domain: ' Work ' });

  const lines = await persisted(root);
  assert.equal(lines.length, 2, 'one user line and one assistant line');
  assert.deepEqual(lines.map((line) => line.domain), ['work', 'work'], 'the caller domain is persisted');
  assert.deepEqual(lines.map((line) => line.domainLabel), ['', ''], 'a caller domain has no display label');
  assert.equal(lines[0].role, 'user');
  assert.equal(lines[0].text, '帮我整理周报');
  assert.equal(lines[1].role, 'assistant');
  assert.equal(lines[1].text, reply(0));
  // The old fields are still written next to the new ones.
  assert.equal(lines[1].provider, 'deepseek');
  assert.equal(lines[1].model, 'deepseek-flash');
  assert.equal(typeof lines[1].ms, 'number');

  assert.deepEqual(fastPath.readAll().map((entry) => entry.domain), ['work', 'work']);
  assert.deepEqual(fastPath.list().map((entry) => entry.domain), ['work', 'work']);
  assert.equal(fastPath.history.at(-1).domain, 'work');
  assert.deepEqual(domainEvents(events), [{ domain: 'work', label: '', source: 'caller' }]);
  assert.deepEqual(rejectedEvents(events), [], 'an in-scope caller domain is never reported as rejected');

  // The caller wins over config.defaultDomain and is normalized like a memory domain.
  assert.deepEqual(
    resolveTurnDomain({
      requested: ' Work ',
      config: { defaultDomain: 'home', allowedDomains: ['work'] },
      workspace,
    }),
    { domain: 'work', label: '', source: 'caller' },
  );
  assert.equal(normalizeTurnDomain(' Work '), 'work');
  assert.equal(normalizeTurnDomain('movie'), 'movie');
});

test('P-69 A2: without a caller domain, config.defaultDomain is persisted and reported', async () => {
  const { root, workspace, fastPath, events } = await harness({ config: { defaultDomain: 'work' } });

  await fastPath.askStream('帮我整理周报');

  const lines = await persisted(root);
  assert.deepEqual(lines.map((line) => line.domain), ['work', 'work']);
  assert.deepEqual(lines.map((line) => line.domainLabel), ['', '']);
  assert.equal(lines[0].text, '帮我整理周报');
  assert.deepEqual(fastPath.readAll().map((entry) => entry.domain), ['work', 'work']);
  assert.deepEqual(domainEvents(events), [{ domain: 'work', label: '', source: 'config' }]);
  // The configured default is normalized, and a caller domain still wins over it.
  assert.deepEqual(
    resolveTurnDomain({ config: { defaultDomain: ' Work ' }, workspace }),
    { domain: 'work', label: '', source: 'config' },
  );
  assert.deepEqual(
    resolveTurnDomain({ requested: 'movie', config: { defaultDomain: 'work', allowedDomains: ['movie'] }, workspace }),
    { domain: 'movie', label: '', source: 'caller' },
  );
});

test('P-69 A3: without an explicit domain the stable workspace ID groups the turn', async () => {
  const { root, workspace, fastPath, make, events } = await harness();
  const id = workspaceDomainId(workspace);
  assert.match(id, WORKSPACE_ID_RE, 'the workspace domain is ws:<12 hex>');
  assert.notEqual(id, basename(workspace), 'the directory name is not the domain key');

  await fastPath.askStream('帮我看下这个动画');
  await fastPath.askStream('今天有点累');

  const lines = await persisted(root);
  assert.deepEqual(lines.map((line) => line.domain), [id, id, id, id],
    'animation / daily talk in the same workspace share one domain: grouping is by workspace, not by topic');
  assert.deepEqual(lines.map((line) => line.domainLabel), [basename(workspace), basename(workspace), basename(workspace), basename(workspace)],
    'the directory name is stored separately as the display label only');
  assert.deepEqual(domainEvents(events), [{ domain: id, label: basename(workspace), source: 'workspace' }]);

  // Same path twice (and a fresh instance) resolves to the SAME ID; a different path does not.
  assert.equal(resolveTurnDomain({ workspace }).domain, id);
  assert.equal(resolveTurnDomain({ workspace }).domain, workspaceDomainId(workspace));
  const reloaded = make();
  await reloaded.askStream('再看一句');
  assert.equal((await persisted(root)).at(-1).domain, id, 'a fresh instance resolves the same workspace ID');
  assert.notEqual(workspaceDomainId(join(root, 'another')), id);
});

test('P-69 A4: the ID follows the normalized path, not its spelling or directory name', async () => {
  const { root, workspace } = await harness();
  const id = workspaceDomainId(workspace);
  const label = workspaceDomainLabel(workspace);

  // Cosmetic spellings of the same directory normalize to one path and therefore one ID.
  const variants = [
    `${workspace}\\`,
    workspace.replace(/\\/gu, '/'),
    process.platform === 'win32' ? workspace.toUpperCase() : workspace,
    // A parent/child segment pair that cancels out still resolves to the same directory.
    join(workspace, '..', basename(workspace)),
    join(workspace, '.'),
  ];
  for (const variant of variants) {
    assert.equal(workspaceDomainId(variant), id, `same normalized path: ${variant}`);
  }
  assert.equal(normalizeWorkspacePath(`${workspace}\\`), normalizeWorkspacePath(workspace));

  // A different directory (even with the same directory name) is a different workspace.
  assert.notEqual(workspaceDomainId(join(root, 'elsewhere', basename(workspace))), id);
  assert.equal(workspaceDomainLabel(workspace), label, 'the label is the directory name of the path');
  assert.equal(workspaceDomainId(''), UNGROUPED_DOMAIN, 'no path means no workspace ID');
  assert.equal(workspaceDomainLabel(''), '');

  // The stable ID is a legal stored domain; a name is not mistakable for one.
  assert.equal(isTurnDomain(id), true);
  assert.equal(isTurnDomain('ws:not-a-hash'), false);
  assert.equal(isTurnDomain('work'), true);
  assert.equal(normalizeTurnDomain(id.toUpperCase()), id, 'workspace IDs normalize case-insensitively');
});

test('P-69 A5: an out-of-scope caller domain is rejected and falls back to the workspace ID', async () => {
  const { root, workspace, fastPath, events } = await harness();
  const id = workspaceDomainId(workspace);
  const otherWorkspaceId = workspaceDomainId(join(root, 'elsewhere'));

  await fastPath.askStream('这句会被拒绝', { domain: 'other-workspace' });
  await fastPath.askStream('别的域的稳定 ID 也不行', { domain: otherWorkspaceId });

  const lines = await persisted(root);
  assert.deepEqual(lines.map((line) => line.domain), [id, id, id, id],
    'the rejected names never reach the stored line; the turn stays in its own workspace');
  assert.deepEqual(rejectedEvents(events), [
    { domain: 'other-workspace', reason: 'out-of-scope' },
    { domain: otherWorkspaceId, reason: 'out-of-scope' },
  ]);
  // The fallback turn still reports the domain that actually grouped it.
  assert.deepEqual(domainEvents(events), [{ domain: id, label: basename(workspace), source: 'workspace' }]);
  assert.deepEqual(resolveTurnDomain({ requested: 'other-workspace', workspace }), {
    domain: id,
    label: basename(workspace),
    source: 'workspace',
    rejected: { domain: 'other-workspace', reason: 'out-of-scope' },
  });

  // The allow-list is exactly: workspace ID + config.defaultDomain + config.allowedDomains.
  const scope = domainScope({ config: { defaultDomain: 'work', allowedDomains: ['movie', 'ws:not-a-hash'] }, workspace });
  assert.deepEqual(scope.allowed, [id, 'work', 'movie']);
  assert.deepEqual(resolveTurnDomain({ requested: 'movie', config: { allowedDomains: ['movie'] }, workspace }),
    { domain: 'movie', label: '', source: 'caller' });
  assert.deepEqual(resolveTurnDomain({ requested: 'study', config: { allowedDomains: ['movie'] }, workspace }).rejected,
    { domain: 'study', reason: 'out-of-scope' });
  // Naming its own workspace ID is allowed and keeps the display label.
  assert.deepEqual(resolveTurnDomain({ requested: id, workspace }),
    { domain: id, label: basename(workspace), source: 'caller' });
});

test('P-69 A: no workspace means the default (ungrouped) result, and it is legal', async () => {
  const { root, fastPath, events } = await harness({ workspace: '' });

  await fastPath.askStream('随口一句');

  assert.deepEqual((await persisted(root)).map((line) => line.domain), ['', '']);
  assert.deepEqual((await persisted(root)).map((line) => line.domainLabel), ['', '']);
  assert.equal(UNGROUPED_DOMAIN, '');
  assert.deepEqual(domainEvents(events), [{ domain: '', label: '', source: 'default' }]);
  assert.deepEqual(resolveTurnDomain({}), { domain: '', label: '', source: 'default' });
  assert.deepEqual(resolveTurnDomain({ workspace: '' }), { domain: '', label: '', source: 'default' });
  // An unusable configured value does not become a made-up domain either.
  assert.deepEqual(resolveTurnDomain({ config: { defaultDomain: 'My App' } }), { domain: '', label: '', source: 'default' });
});

test('P-69 A: the domain event is throttled for an unchanged domain', async () => {
  let clock = 1_000_000;
  const { fastPath, events, workspace } = await harness({ now: () => clock });

  await fastPath.askStream('第一条');
  await fastPath.askStream('第二条');
  assert.equal(domainEvents(events).length, 1, 'an unchanged domain is reported once per window');

  clock += 60_001;
  await fastPath.askStream('第三条');
  assert.equal(domainEvents(events).length, 2, 'the next window reports it again');
  assert.equal(domainEvents(events)[1].domain, workspaceDomainId(workspace));
});

test('P2: fastpath.context.scope 报告 included/excluded 行数，并按作用域节流', async () => {
  let clock = 2_000_000;
  const { root, make, events, workspace } = await harness({ config: { defaultDomain: 'work' }, now: () => clock });
  assert.match(workspaceDomainId(workspace), WORKSPACE_ID_RE);
  await writeLines(root, [
    { ts: 1, role: 'user', text: '工作问题', domain: 'work' },
    { ts: 2, role: 'assistant', text: '工作回答', domain: 'work' },
    { ts: 3, role: 'user', text: '家里问题', domain: 'home' },
    { ts: 4, role: 'user', text: '随口一句' },
  ]);
  const fastPath = make(); // constructed after seeding, so the fixture is loaded

  await fastPath.askStream('第一个问题');
  assert.deepEqual(scopeEvents(events), [{ domain: 'work', rowsIncluded: 2, rowsExcluded: 2 }]);
  assert.deepEqual(Object.keys(scopeEvents(events)[0]).sort(), ['domain', 'rowsExcluded', 'rowsIncluded'],
    'the scope event carries exactly domain / rowsIncluded / rowsExcluded');
  assert.equal(Object.keys(scopeEvents(events)[0]).includes('label'), false, 'no display label on a scope event');

  // Same scope inside the throttle window: no second line for the same fact.
  await fastPath.askStream('第二个问题');
  assert.equal(scopeEvents(events).length, 1, 'an unchanged scope is throttled');

  // A later window reports the (now larger) window counts: 2 seeded work rows + 4 new work rows.
  clock += 60_001;
  await fastPath.askStream('第三个问题');
  const scopes = scopeEvents(events);
  assert.equal(scopes.length, 2, 'the next window reports the scope again');
  assert.deepEqual(scopes[1], { domain: 'work', rowsIncluded: 6, rowsExcluded: 2 });
  console.log(`P2-event) domain=work first=2/2 second=6/2 events=${scopes.length}`);
});

test('P-69 A6: old lines without a domain stay ungrouped and are not rewritten', async () => {
  const { root, fastPath, make, workspace } = await harness();
  const id = workspaceDomainId(workspace);
  const legacy = [
    { ts: 1_700_000_000_000, role: 'user', text: '旧问题' },
    { ts: 1_700_000_000_001, role: 'assistant', text: '旧回答', provider: 'deepseek', model: 'deepseek-flash', ms: 12 },
    '{"torn":',
    { ts: 1_700_000_000_002, role: 'assistant', text: '域字段非法', domain: 42 },
  ];
  await writeLines(root, legacy);
  const file = join(root, 'data', 'conversation.jsonl');
  const rawBefore = await readFile(file, 'utf8');
  void fastPath; // the instance loaded the empty file before the legacy lines were written

  const reloaded = make(); // constructing must not throw on legacy lines
  const entries = reloaded.readAll();
  assert.equal(entries.length, 3, 'the torn line is skipped, the legacy lines survive');
  assert.deepEqual(entries.map((entry) => entry.domain), ['', '', ''], 'unknown stays ungrouped');
  assert.deepEqual(entries.map((entry) => entry.domainLabel), ['', '', '']);
  assert.equal(entries[0].text, '旧问题');
  assert.equal(entries[1].provider, 'deepseek');
  assert.deepEqual(reloaded.list().map((entry) => entry.domain), ['', '', '']);
  assert.equal(reloaded.history.at(-1).text, '域字段非法');
  assert.equal(await readFile(file, 'utf8'), rawBefore, 'reading never rewrites old lines');
  assert.equal(UNGROUPED_DOMAIN, '');

  const groups = groupByDomain(entries);
  assert.deepEqual(Object.keys(groups), ['']);
  assert.equal(groups[''].length, 3);

  // New turns use the workspace body; the legacy lines keep their ungrouped bucket.
  await reloaded.askStream('新问题');
  assert.deepEqual(reloaded.readAll().map((entry) => entry.domain), ['', '', '', id, id]);
  const mixed = groupByDomain(reloaded.readAll());
  assert.deepEqual(Object.keys(mixed), ['', id]);
  // The raw legacy lines are untouched; only the two new lines carry a domain.
  const rawAfter = await readFile(file, 'utf8');
  assert.equal(rawAfter.split('\n').slice(0, 4).join('\n'), rawBefore.trimEnd().split('\n').slice(0, 4).join('\n'),
    'appending never rewrites the legacy prefix');

  // Deleting one old line rewrites the rest with the normalized field and still works.
  assert.equal(reloaded.remove({ ts: 1_700_000_000_001, role: 'assistant' }), 1);
  const rewritten = await persisted(root);
  assert.deepEqual(rewritten.map((line) => line.domain), ['', '', id, id]);
});

test('P-69 A: groupByDomain groups workspace IDs, names and ungrouped in stable order', () => {
  const entries = [
    { ts: 1, role: 'user', text: 'a', domain: 'work' },
    { ts: 2, role: 'assistant', text: 'b', domain: 'ws:0123456789ab' },
    { ts: 3, role: 'user', text: 'c' }, // legacy shape: no domain at all
    { ts: 4, role: 'assistant', text: 'd', domain: 'work' },
    { ts: 5, role: 'user', text: 'e', domain: '' },
  ];
  const before = entries.map((entry) => entry.text);

  const groups = groupByDomain(entries);
  assert.deepEqual(Object.keys(groups), ['work', 'ws:0123456789ab', ''], 'domains keep first-seen order');
  assert.deepEqual(groups.work.map((entry) => entry.text), ['a', 'd']);
  assert.deepEqual(groups['ws:0123456789ab'].map((entry) => entry.text), ['b']);
  assert.deepEqual(groups[''].map((entry) => entry.text), ['c', 'e']);
  assert.equal(groups[''].length, 2, "'' is the ungrouped bucket");

  // Same input -> same order; input entries are not mutated.
  assert.deepEqual(Object.keys(groupByDomain(entries)), ['work', 'ws:0123456789ab', '']);
  assert.deepEqual(entries.map((entry) => entry.text), before);
  assert.deepEqual(groupByDomain([]), {});
  assert.deepEqual(groupByDomain(null), {});
});

test('P-69 A: the persisted line gains domain + domainLabel; the old schema is unchanged', async () => {
  const { root, fastPath, make, workspace } = await harness();

  await fastPath.askStream('结构检查');

  const [user, assistant] = await persisted(root);
  assert.deepEqual(Object.keys(user).sort(), ['domain', 'domainLabel', 'role', 'text', 'ts']);
  assert.deepEqual(Object.keys(assistant).sort(), [
    'domain',
    'domainLabel',
    'model',
    'ms',
    'provider',
    'role',
    'text',
    'ts',
  ]);
  assert.equal(user.domain, workspaceDomainId(workspace));
  assert.equal(user.domainLabel, basename(workspace));
  assert.equal(typeof user.ts, 'number');
  assert.equal(typeof assistant.ts, 'number');

  const reloaded = make();
  assert.deepEqual(reloaded.readAll().map((entry) => entry.domain), [workspaceDomainId(workspace), workspaceDomainId(workspace)]);
  assert.deepEqual(reloaded.readAll().map((entry) => entry.domainLabel), [basename(workspace), basename(workspace)]);
});
