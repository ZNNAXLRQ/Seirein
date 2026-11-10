/**
 * Memory-linked lexicon entries — pre-step injection.
 *
 * Run: node --test test/memory-lexicon-linked.mjs
 *
 * Acceptance covered here:
 *   1. direct lexicon recall (词语参考) and memory-linked words (关联词语) can both enter one turn;
 *   2. the same stable entry id appears once per turn — a linked word already rendered by the
 *      词语参考 block is skipped, not repeated;
 *   3. at most 3 linked entries / 200 chars, whole entries only (no partial key fields);
 *   4. missing / deleted / non-confirmed / changed entries are resolved against the CURRENT list
 *      and skipped when no longer valid;
 *   5. composing/observing the linked block writes no memory and reinforces nothing;
 *   6. without links the old memory output is byte-for-byte unchanged.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LEXICON_CONTEXT_HEADING,
  LINKED_LEXICON_CONTEXT_HEADING,
  LINKED_LEXICON_MAX_CHARS,
  LINKED_LEXICON_MAX_ENTRIES,
  composeLinkedLexiconContext,
  createMemoryPreStep,
} from '../src/host/memory/pre-step.js';
import { MEMORY_INJECTION_HEADING } from '../src/host/memory/memory-injection.js';

function eventLog() {
  const events = [];
  return {
    events,
    async emit(type, payload) {
      events.push({type, payload});
      return {type, payload};
    },
  };
}

function userMessage(text, id = `u-${Math.random().toString(36).slice(2)}`) {
  return {id, role: 'user', source: {kind: 'user'}, content: [{type: 'text', text}]};
}

function preStepPayload({agent, turn = 1, step = 1, messages = [], signal = null}) {
  return {agent, turn, step, signal: signal ?? new AbortController().signal, messages};
}

const enterDecision = (messages) => async () => ({kind: 'enter', messages: [...messages]});

function textOf(message) {
  return message?.content?.[0]?.text ?? '';
}

function blocksWith(messageList, heading) {
  return messageList.filter((message) => textOf(message).startsWith(heading));
}

function blockWith(messageList, heading) {
  return blocksWith(messageList, heading)[0];
}

function confirmed(id, canonical, extra = {}) {
  return {
    id,
    status: 'confirmed',
    text: canonical,
    canonical,
    category: 'person',
    usage: '',
    wrongForms: [],
    reading: '',
    at: '2026-11-01T00:00:00.000Z',
    ...extra,
  };
}

function memoryRow(id, text, extra = {}) {
  return {
    id,
    ts: '2026-11-01T00:00:00.000Z',
    role: 'user',
    text,
    importance: 60,
    clarity: 'clear',
    source: 'manual',
    version: 1,
    ...extra,
  };
}

/** Memory stand-in: no retrieval logic, but every mutation is counted. */
function stubMemory({fixed = [], hits = []} = {}) {
  const calls = {
    fixedMemories: 0,
    recall: 0,
    restore: 0,
    deliverCandidates: 0,
    persistCandidate: 0,
  };
  return {
    calls,
    fixedMemories() {
      calls.fixedMemories += 1;
      return fixed;
    },
    recall() {
      calls.recall += 1;
      return {hits, mode: 'keyword'};
    },
    restore() {
      calls.restore += 1;
    },
    deliverCandidates() {
      calls.deliverCandidates += 1;
      return {delivered: []};
    },
    persistCandidate() {
      calls.persistCandidate += 1;
    },
  };
}

async function runTurn({
  memory,
  log = eventLog(),
  lexiconEntries,
  query,
  turn = 1,
  lane = 'typed',
  agentId = 'agent',
  sessionId = 'session',
} = {}) {
  let reads = 0;
  const provider = lexiconEntries === undefined
    ? undefined
    : () => {
      reads += 1;
      return lexiconEntries;
    };
  const prep = createMemoryPreStep({
    memory,
    log,
    inScope: () => true,
    featureEnabled: () => true,
    laneForSession: () => lane,
    ...(provider === undefined ? {} : {lexiconEntries: provider}),
  });
  const agent = {id: agentId, session: {id: sessionId, header: {cwd: 'C:/workspace'}}};
  const original = userMessage(query);
  const payload = preStepPayload({agent, turn, messages: [original]});
  const result = await prep.handle(payload, enterDecision(payload.messages));
  return {prep, agent, original, payload, result, log, reads: () => reads};
}

test('1. direct wording + memory-linked wording both enter the preparation', async () => {
  const memory = stubMemory({
    hits: [memoryRow('mem-1', '我们约好每周三一起看动画', {lexiconIds: ['lex-linked']})],
  });
  const entries = [
    confirmed('lex-direct', '向晚', {usage: '直接出现在本轮问题里的词。'}),
    confirmed('lex-linked', '星野', {usage: '通过记忆关联进入本轮参考。'}),
  ];
  const run = await runTurn({
    memory,
    lexiconEntries: entries,
    query: '向晚这周三一起看动画好吗',
    agentId: 'linked-direct',
    sessionId: 'session-linked-direct',
  });

  const memoryBlock = blockWith(run.result.messages, MEMORY_INJECTION_HEADING);
  const directBlock = blockWith(run.result.messages, LEXICON_CONTEXT_HEADING);
  const linkedBlock = blockWith(run.result.messages, LINKED_LEXICON_CONTEXT_HEADING);
  assert.ok(memoryBlock, 'the memory block is present');
  assert.ok(directBlock, 'the direct 词语参考 block is present');
  assert.ok(linkedBlock, 'the memory-linked 关联词语 block is present');
  assert.match(textOf(directBlock), /词语：向晚/u);
  assert.match(textOf(linkedBlock), /词语：星野/u);
  assert.match(textOf(linkedBlock), /编号：lex-linked/u);
  assert.match(textOf(linkedBlock), /类别：person/u);
  assert.match(textOf(linkedBlock), /含义\/用法：通过记忆关联进入本轮参考。/u);

  const order = run.result.messages.map(textOf);
  assert.ok(order.indexOf(textOf(memoryBlock)) < order.indexOf(textOf(linkedBlock)),
    '关联词语 is appended after the memory block');
  assert.ok(order.indexOf(textOf(linkedBlock)) < order.indexOf(textOf(directBlock)),
    '关联词语 is its own block before 词语参考');
  assert.equal(run.reads(), 1, 'the lexicon is read once for the whole turn');
  console.log('1) direct + memory-linked words both injected; lexicon reads=1');
});

test('2. the same stable id is rendered once — linked word already in 词语参考 is skipped', async () => {
  const memory = stubMemory({
    hits: [memoryRow('mem-1', '我们约好每周三一起看动画', {lexiconIds: ['lex-a']})],
  });
  const entries = [confirmed('lex-a', '向晚', {usage: '同一个词条的释义。'})];
  const run = await runTurn({
    memory,
    lexiconEntries: entries,
    query: '向晚这周三一起看动画好吗',
    agentId: 'linked-dedupe',
    sessionId: 'session-linked-dedupe',
  });
  const directBlock = blockWith(run.result.messages, LEXICON_CONTEXT_HEADING);
  const linkedBlock = blockWith(run.result.messages, LINKED_LEXICON_CONTEXT_HEADING);
  assert.ok(directBlock, 'the direct block owns the word');
  assert.equal(linkedBlock, undefined, 'the linked block does not repeat it');
  const appended = run.result.messages.filter((message) => message.source?.kind !== 'user');
  assert.equal(appended.filter((message) => textOf(message).includes('词语：向晚')).length, 1,
    '词语：向晚 appears exactly once this turn');

  // Two memories linking the same id also collapse to one reference entry.
  const twice = stubMemory({
    hits: [
      memoryRow('mem-1', '第一段相关记忆', {lexiconIds: ['lex-b']}),
      memoryRow('mem-2', '第二段相关记忆', {lexiconIds: ['lex-b']}),
    ],
  });
  const twiceRun = await runTurn({
    memory: twice,
    lexiconEntries: [confirmed('lex-b', '长崎', {usage: '只出现一次。'})],
    query: '这周三一起看动画好吗',
    agentId: 'linked-dedupe-two',
    sessionId: 'session-linked-dedupe-two',
  });
  const twiceLinked = blockWith(twiceRun.result.messages, LINKED_LEXICON_CONTEXT_HEADING);
  assert.ok(twiceLinked, 'the linked block is present');
  assert.equal((textOf(twiceLinked).match(/词语：长崎/gu) ?? []).length, 1,
    'two linked memories still produce one entry');
  console.log('2) direct/linked and two-memory duplicates both collapse to one entry');
});

test('3. at most 3 entries / 200 chars; whole entries only, no partial fields', async () => {
  const entries = ['甲', '乙', '丙', '丁'].map((word, index) => confirmed(`lex-${index}`, word, {
    usage: `第${index}个释义。`,
  }));
  const memory = stubMemory({
    hits: [memoryRow('mem-1', '一段相关记忆', {
      lexiconIds: entries.map((entry) => entry.id),
    })],
  });
  const run = await runTurn({
    memory,
    lexiconEntries: entries,
    query: '这周三一起看动画好吗',
    agentId: 'linked-limit',
    sessionId: 'session-linked-limit',
  });
  const linkedBlock = blockWith(run.result.messages, LINKED_LEXICON_CONTEXT_HEADING);
  assert.ok(linkedBlock, 'the linked block is present');
  const body = textOf(linkedBlock);
  assert.ok(body.length <= LINKED_LEXICON_MAX_CHARS,
    `linked block ${body.length} chars <= ${LINKED_LEXICON_MAX_CHARS}`);
  assert.ok((body.match(/词语：/gu) ?? []).length <= LINKED_LEXICON_MAX_ENTRIES,
    `at most ${LINKED_LEXICON_MAX_ENTRIES} entries`);
  assert.match(body, /词语：甲/u, 'the first linked entry is kept');

  // An over-long entry is skipped whole instead of truncating its key fields/definition.
  const long = composeLinkedLexiconContext([{
    id: 'lex-long',
    text: '长',
    canonical: '长',
    category: 'term',
    usage: '很长的释义。'.repeat(100),
  }]);
  assert.equal(long.count, 0, 'an over-budget entry is skipped, not truncated');
  assert.equal(long.text, '', 'no header-only fragment for an over-budget entry');
  const short = composeLinkedLexiconContext([{
    id: 'lex-long',
    text: '长',
    canonical: '长',
    category: 'term',
    usage: '很长的释义。'.repeat(100),
  }, {
    id: 'lex-short',
    text: '短',
    canonical: '短',
    category: 'term',
    usage: '短释义。',
  }]);
  assert.ok(short.text.length <= LINKED_LEXICON_MAX_CHARS);
  assert.ok(!short.text.includes('词语：长'), 'the over-budget entry contributes nothing');
  assert.match(short.text, /词语：短/u, 'a later whole entry can still fit');
  assert.match(short.text, /含义\/用法：短释义。/u, 'the kept entry is not truncated');
  console.log(`3) linked block ${body.length}/${LINKED_LEXICON_MAX_CHARS} chars, entries<=${LINKED_LEXICON_MAX_ENTRIES}`);
});

test('4. missing / deleted / non-confirmed entries are skipped; all-missing produces no empty block', async () => {
  const entries = new Map([
    ['lex-live', confirmed('lex-live', '向晚', {usage: '当前有效。'})],
    ['lex-candidate', confirmed('lex-candidate', '候选', {usage: '未确认。'})],
    ['lex-rejected', confirmed('lex-rejected', '拒绝', {usage: '已拒绝。'})],
    ['lex-deleted', confirmed('lex-deleted', '删除', {deleted: true})],
  ]);
  entries.get('lex-candidate').status = 'candidate';
  entries.get('lex-rejected').status = 'rejected';
  const memory = stubMemory({
    hits: [memoryRow('mem-1', '一段相关记忆', {
      lexiconIds: ['missing', 'lex-candidate', 'lex-rejected', 'lex-deleted', 'lex-live'],
    })],
  });
  const run = await runTurn({
    memory,
    lexiconEntries: [...entries.values()],
    query: '这周三一起看动画好吗',
    agentId: 'linked-missing',
    sessionId: 'session-linked-missing',
  });
  const linkedBlock = blockWith(run.result.messages, LINKED_LEXICON_CONTEXT_HEADING);
  assert.ok(linkedBlock, 'the current valid entry is still injected');
  const body = textOf(linkedBlock);
  assert.match(body, /词语：向晚/u);
  assert.ok(!body.includes('候选') && !body.includes('拒绝') && !body.includes('删除'),
    'non-current entries never enter the linked block');

  const allMissing = stubMemory({
    hits: [memoryRow('mem-1', '一段相关记忆', {lexiconIds: ['missing']})],
  });
  const missingRun = await runTurn({
    memory: allMissing,
    lexiconEntries: [confirmed('lex-live', '向晚')],
    query: '这周三一起看动画好吗',
    agentId: 'linked-none',
    sessionId: 'session-linked-none',
  });
  assert.equal(blockWith(missingRun.result.messages, LINKED_LEXICON_CONTEXT_HEADING), undefined,
    'no linked block when every linked entry is gone');
  assert.ok(blockWith(missingRun.result.messages, MEMORY_INJECTION_HEADING),
    'the memory block itself is untouched');
  console.log('4) missing/deleted/non-confirmed skipped; all-missing → no empty block');
});

test('5. composing/observing the linked block writes no memory and reinforces nothing', async () => {
  const memory = stubMemory({
    hits: [memoryRow('mem-1', '一段相关记忆', {lexiconIds: ['lex-a']})],
  });
  const run = await runTurn({
    memory,
    lexiconEntries: [confirmed('lex-a', '向晚', {usage: '参考。'})],
    query: '这周三一起看动画好吗',
    agentId: 'linked-observe',
    sessionId: 'session-linked-observe',
  });
  const linkedBlock = blockWith(run.result.messages, LINKED_LEXICON_CONTEXT_HEADING);
  assert.ok(linkedBlock, 'the linked block was injected');
  const before = {...memory.calls};
  run.prep.observe(run.agent.session, {type: 'user/message', data: linkedBlock});
  assert.deepEqual(memory.calls, before,
    'observing the linked message neither restores nor writes memory');
  assert.equal(memory.calls.restore, 0, 'no record was reinforced');
  assert.equal(memory.calls.deliverCandidates, 0, 'no candidate delivery ran');
  assert.equal(memory.calls.persistCandidate, 0, 'no candidate was persisted');
  console.log('5) observe(linked message) → restore=0, deliver/persist=0');
});

test('6. a changed entry takes effect next turn; without links the old output is byte-identical', async () => {
  const makeEntries = (usage) => [confirmed('lex-a', '向晚', {usage})];
  const memory = stubMemory({
    hits: [memoryRow('mem-1', '一段相关记忆', {lexiconIds: ['lex-a']})],
  });
  const first = await runTurn({
    memory,
    lexiconEntries: makeEntries('旧释义。'),
    query: '这周三一起看动画好吗',
    turn: 1,
    agentId: 'linked-version',
    sessionId: 'session-linked-version',
  });
  assert.match(textOf(blockWith(first.result.messages, LINKED_LEXICON_CONTEXT_HEADING)), /旧释义。/u);

  const second = await runTurn({
    memory,
    lexiconEntries: makeEntries('新释义。'),
    query: '这周三一起看动画好吗',
    turn: 2,
    agentId: 'linked-version',
    sessionId: 'session-linked-version',
  });
  const secondBody = textOf(blockWith(second.result.messages, LINKED_LEXICON_CONTEXT_HEADING));
  assert.match(secondBody, /新释义。/u, 'the current version is used next turn');
  assert.ok(!secondBody.includes('旧释义。'), 'the previous definition is not replayed');

  // No links: a provider with entries must not change one byte of the memory output.
  const noLinks = memoryRow('mem-1', '一段相关记忆');
  const baseline = await runTurn({
    memory: stubMemory({hits: [noLinks]}),
    query: '这周三一起看动画好吗',
    agentId: 'linked-baseline',
    sessionId: 'session-linked-baseline',
  });
  const withProvider = await runTurn({
    memory: stubMemory({hits: [noLinks]}),
    lexiconEntries: [confirmed('lex-a', '向晚', {usage: '不会被动用。'})],
    query: '这周三一起看动画好吗',
    agentId: 'linked-provider',
    sessionId: 'session-linked-provider',
  });
  assert.equal(blockWith(withProvider.result.messages, LINKED_LEXICON_CONTEXT_HEADING), undefined,
    'no lexiconIds → no linked block');
  assert.deepEqual(
    baseline.result.messages.map(textOf),
    withProvider.result.messages.map(textOf),
    'without links the old memory output is unchanged even with a lexicon provider',
  );
  console.log('6) changed definition applies next turn; no links → byte-identical output');
});
