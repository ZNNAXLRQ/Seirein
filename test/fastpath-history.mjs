/**
 * R15/R16: the current utterance must reach the model once, and the stored history must be
 * exactly the history the prompt uses.
 *
 * P2: the stored history is a cross-domain window, but the PROMPT is scoped — only the current
 * turn's domain (or the ungrouped bucket when that is the turn's domain) may enter it, so another
 * workspace's lines never reach this request.
 *
 * Run: node --test test/fastpath-history.mjs
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { FastPath, groupByDomain, workspaceDomainId } from '../src/host/session/inference/fastpath.js';

const MAX_HISTORY_TURNS = 8; // mirrors the constant in src/host/session/inference/fastpath.js

const occurrences = (haystack, needle) => haystack.split(needle).length - 1;

async function harness({ config, workspace = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-fastpath-history-'));
  const path = workspace ? join(root, 'workspace') : null;
  const requests = [];
  const events = [];
  let round = 0;
  const llm = {
    async *stream(request) {
      requests.push(request);
      const index = round;
      round += 1;
      yield { type: 'text-delta', index: 0, text: `回复${index}` };
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
  const create = () => new FastPath({ root, config, workspace: path, ...deps });
  return { root, workspace: path, fastPath: create(), create, requests, events };
}

/** Seed the persisted conversation before the instance loads it. */
async function seed(root, lines) {
  await mkdir(join(root, 'data'), { recursive: true });
  await writeFile(
    join(root, 'data', 'conversation.jsonl'),
    lines.map((line) => JSON.stringify(line)).join('\n') + '\n',
    'utf8',
  );
}

/** The fixture every P2 test shares: work 2, home 2, ungrouped 1. */
const MIXED_HISTORY = [
  { ts: 1_700_000_000_000, role: 'user', text: '周一要交周报', domain: 'work' },
  { ts: 1_700_000_000_001, role: 'assistant', text: '工作回答内容', domain: 'work' },
  { ts: 1_700_000_000_002, role: 'user', text: '周末去哪儿玩', domain: 'home' },
  { ts: 1_700_000_000_003, role: 'assistant', text: '家里回答内容', domain: 'home' },
  { ts: 1_700_000_000_004, role: 'user', text: '随口一句' }, // legacy line: no domain field
];
const HOME_TEXTS = ['周末去哪儿玩', '家里回答内容'];
const UNGROUPED_TEXTS = ['随口一句'];

const scopeEvents = (events) => events
  .filter((event) => event.type === 'fastpath.context.scope')
  .map((event) => event.payload);

function requestText(request) {
  const system = String(request.system ?? '');
  const messages = (request.messages ?? [])
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('\n');
  return { system, messages };
}

test('R15: the current utterance appears exactly once in one request', async () => {
  const { fastPath, requests } = await harness();
  const utterance = '今天外面下雨吗';

  await fastPath.askStream(utterance);

  assert.equal(requests.length, 1, 'one LLM request');
  const { system, messages } = requestText(requests[0]);
  assert.equal(occurrences(system, utterance), 0, 'current utterance must not be in the history prompt');
  assert.equal(occurrences(messages, utterance), 1, 'current utterance must be in messages');
  assert.equal(
    occurrences(`${system}\n${messages}`, utterance),
    1,
    'the model must not see the current utterance twice',
  );
});

test('R15: a later turn keeps the previous turn but still contains itself once', async () => {
  const { fastPath, requests } = await harness();

  await fastPath.askStream('第一句话');
  await fastPath.askStream('第二句话');

  const { system, messages } = requestText(requests[1]);
  assert.ok(system.includes('第一句话'), 'previous user turn stays in history');
  assert.ok(system.includes('回复0'), 'previous assistant turn stays in history');
  assert.equal(occurrences(system, '第二句话'), 0, 'current utterance is excluded from history');
  assert.equal(
    occurrences(`${system}\n${messages}`, '第二句话'),
    1,
    'current utterance appears once in the second request',
  );
});

test('R16: history length never exceeds MAX_HISTORY_TURNS and the prompt uses every kept entry', async () => {
  const { fastPath, create, requests } = await harness();

  for (let index = 0; index < 11; index += 1) {
    await fastPath.askStream(`第${index}轮问题`);
  }

  const expected = fastPath.history.slice(-MAX_HISTORY_TURNS);
  assert.equal(expected.length, MAX_HISTORY_TURNS, 'eleven rounds fill the history cap');

  await fastPath.askStream('最后一轮问题');

  assert.ok(fastPath.history.length <= MAX_HISTORY_TURNS, `length ${fastPath.history.length} <= ${MAX_HISTORY_TURNS}`);

  const { system } = requestText(requests.at(-1));
  for (const turn of expected) {
    assert.ok(system.includes(turn.text), `prompt uses kept history entry: ${turn.text}`);
  }
  assert.ok(!system.includes('第0轮问题'), 'entries evicted from the store are not in the prompt either');

  // A fresh instance reloads from JSONL; loadHistory must enforce the same cap.
  const reloaded = create();
  assert.ok(
    reloaded.history.length <= MAX_HISTORY_TURNS,
    `reloaded length ${reloaded.history.length} <= ${MAX_HISTORY_TURNS}`,
  );
});

// ---- P2: the prompt's recent-dialogue block is scoped by domain ------------------------------

test('P2-1: 当前域 work：prompt 只含 work 两条，home 两条与未分组一条都不进入', async () => {
  const { root, create, requests, events } = await harness({ config: { defaultDomain: 'work' } });
  await seed(root, MIXED_HISTORY);
  const fastPath = create(); // constructed after seeding, so the fixture is loaded

  await fastPath.askStream('今天做什么');

  const { system } = requestText(requests[0]);
  assert.ok(system.includes('周一要交周报'), 'work user turn is in the prompt');
  assert.ok(system.includes('工作回答内容'), 'work assistant turn is in the prompt');
  for (const text of [...HOME_TEXTS, ...UNGROUPED_TEXTS]) {
    assert.equal(system.includes(text), false, `another domain's row is excluded: ${text}`);
  }

  // The store and the review keep every row: only the PROMPT is scoped. The turn itself added
  // two more rows (user + assistant), both under the current domain.
  assert.equal(fastPath.history.length, MIXED_HISTORY.length + 2, 'the stored window is unchanged');
  assert.equal(fastPath.readAll().length, MIXED_HISTORY.length + 2, 'the review still lists every row');
  assert.deepEqual(Object.keys(groupByDomain(fastPath.readAll())), ['work', 'home', ''],
    'grouping display is unchanged (all three groups remain)');

  const scopes = scopeEvents(events);
  assert.deepEqual(scopes, [{ domain: 'work', rowsIncluded: 2, rowsExcluded: 3 }]);
  console.log(`P2-1) domain=work included=${scopes[0].rowsIncluded} excluded=${scopes[0].rowsExcluded} `
    + `history=${fastPath.history.length} groups=${Object.keys(groupByDomain(fastPath.readAll())).length}`);
});

test('P2-2: 当前域未分组：prompt 只含未分组那一条，不读其它域', async () => {
  const { root, create, requests, events } = await harness(); // no workspace, no default domain
  await seed(root, MIXED_HISTORY);
  const fastPath = create();

  await fastPath.askStream('随口问一句');

  const { system } = requestText(requests[0]);
  assert.ok(system.includes('随口一句'), 'the ungrouped row is in the prompt');
  for (const text of ['周一要交周报', '工作回答内容', ...HOME_TEXTS]) {
    assert.equal(system.includes(text), false, `a named domain is never read from the ungrouped scope: ${text}`);
  }

  const scopes = scopeEvents(events);
  assert.deepEqual(scopes, [{ domain: '', rowsIncluded: 1, rowsExcluded: 4 }]);
  console.log(`P2-2) domain="" included=${scopes[0].rowsIncluded} excluded=${scopes[0].rowsExcluded}`);
});

test('P2-3: 跨域校验失败回退后，prompt 上下文跟随回退后的域', async () => {
  const { root, workspace, create, requests, events } = await harness({ workspace: true });
  const id = workspaceDomainId(workspace);
  await seed(root, [
    { ts: 1, role: 'user', text: '本工作区问题', domain: id, domainLabel: 'workspace' },
    { ts: 2, role: 'assistant', text: '本工作区回答', domain: id, domainLabel: 'workspace' },
    { ts: 3, role: 'user', text: '家里问题', domain: 'home' },
    { ts: 4, role: 'assistant', text: '家里回答', domain: 'home' },
    { ts: 5, role: 'user', text: '旧行问题' },
  ]);
  const fastPath = create();

  await fastPath.askStream('这句的域越界了', { domain: 'other-workspace' });

  const rejected = events.filter((event) => event.type === 'fastpath.domain.rejected').map((event) => event.payload);
  assert.deepEqual(rejected, [{ domain: 'other-workspace', reason: 'out-of-scope' }], 'the caller domain was rejected');

  const { system } = requestText(requests[0]);
  assert.ok(system.includes('本工作区问题'), 'the fallback workspace domain is in the prompt');
  assert.ok(system.includes('本工作区回答'));
  for (const text of ['家里问题', '家里回答', '旧行问题']) {
    assert.equal(system.includes(text), false, `the fallback context excludes another domain: ${text}`);
  }

  const scopes = scopeEvents(events);
  assert.deepEqual(scopes, [{ domain: id, rowsIncluded: 2, rowsExcluded: 3 }],
    'the context scope follows the domain the turn actually fell back to');
  assert.equal(fastPath.history.at(-1).domain, id, 'the turn is still written under the fallback domain');
  console.log(`P2-3) rejected=other-workspace fallback=${id} included=${scopes[0].rowsIncluded} excluded=${scopes[0].rowsExcluded}`);
});
