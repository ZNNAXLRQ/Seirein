/**
 * Lexicon v2 — explanation-context injection (reference only, never auto-replacement).
 *
 * Run: node --test test/memory-lexicon-context.mjs
 *
 * The cases mirror the acceptance items:
 *   1. a confirmed hit injects one standalone block with the three public fields (and no
 *      wrongForms / counters / ids / review state), once per turn;
 *   2. unrelated entries, zero entries and non-confirmed entries inject no block (never an empty
 *      one);
 *   3. the independent 400-char cap keeps the most relevant entry, drops lower-ranked entries
 *      whole, and leaves the memory block byte-for-byte unchanged;
 *   4. injection writes no memory and reinforces nothing, even when its message is observed;
 *   5. both the voice and typed entries run the same local recall;
 *   6. without a lexicon provider the old memory-pipeline output is unchanged.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  ASSISTANT_MEMORY_SOURCE,
  LEXICON_CONTEXT_HEADING,
  LEXICON_CONTEXT_MAX_CHARS,
  MEMORY_INJECTION_HEADING,
  createMemoryPreStep,
  recallLexiconContext,
} from '../src/host/index.js';

/** In-memory event sink (the host only needs `emit`). */
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
  return {
    agent,
    turn,
    step,
    signal: signal ?? new AbortController().signal,
    messages,
  };
}

const enterDecision = (messages) => async () => ({kind: 'enter', messages: [...messages]});

function textOf(message) {
  return message?.content?.[0]?.text ?? '';
}

function findLexiconBlock(result) {
  return result.messages.find((message) => textOf(message).startsWith(LEXICON_CONTEXT_HEADING));
}

function findMemoryBlock(result) {
  return result.messages.find((message) => textOf(message).startsWith(MEMORY_INJECTION_HEADING));
}

function confirmed(id, canonical, extra = {}) {
  return {
    id,
    status: 'confirmed',
    text: canonical,
    canonical,
    category: 'unknown',
    usage: '',
    wrongForms: [],
    reading: '',
    at: '2026-11-01T00:00:00.000Z',
    ...extra,
  };
}

function memoryRow(id, text) {
  return {
    id,
    ts: '2026-11-01T00:00:00.000Z',
    role: 'user',
    text,
    importance: 60,
    clarity: 'clear',
    source: 'manual',
    version: 1,
  };
}

/** Minimal memory stand-in; every mutation is counted so a side effect cannot pass unnoticed. */
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

function makePrep({memory, log = eventLog(), lexiconEntries, lane = 'typed', agentId = 'agent', sessionId = 'session'} = {}) {
  const prep = createMemoryPreStep({
    memory,
    log,
    inScope: () => true,
    featureEnabled: () => true,
    laneForSession: () => lane,
    ...(lexiconEntries === undefined ? {} : {lexiconEntries}),
  });
  const agent = {id: agentId, session: {id: sessionId, header: {cwd: 'C:/workspace'}}};
  return {prep, agent, log};
}

async function runTurn({memory, log = eventLog(), lexiconEntries, query, turn = 1, lane = 'typed', agentId = 'agent', sessionId = 'session'}) {
  const {prep, agent} = makePrep({memory, log, lexiconEntries, lane, agentId, sessionId});
  const original = userMessage(query);
  const payload = preStepPayload({agent, turn, messages: [original]});
  const result = await prep.handle(payload, enterDecision(payload.messages));
  return {prep, agent, original, payload, result, log};
}

test('1) a confirmed hit injects one standalone block with only the three public fields', async () => {
  const entries = [
    confirmed('lex-1', '向晚', {
      category: 'person',
      usage: '虚拟主播，粉丝常用称呼。',
      wrongForms: ['香碗'],
      reading: 'xiangwan',
      collections: 9,
      reviewState: 'approved',
    }),
    // Same text as part of this turn's input, but still a candidate: it must never be rendered.
    {...confirmed('lex-2', '星野', {category: 'person', usage: '未确认的候选。'}), status: 'candidate'},
    // `text` and `canonical` may differ; both are public fields and stay inside the 词语 line.
    confirmed('lex-3', '长崎', {text: '长崎酱', category: 'person', usage: '昵称写法。'}),
  ];
  let reads = 0;
  const memory = stubMemory();
  const {prep, agent, original, payload, result} = await runTurn({
    memory,
    lexiconEntries: () => {
      reads += 1;
      return entries;
    },
    query: '向晚、星野和长崎今天直播了吗',
    agentId: 'lex-hit',
    sessionId: 'session-lex-hit',
  });

  const block = findLexiconBlock(result);
  assert.ok(block, 'a confirmed hit produces a lexicon block');
  assert.equal(result.messages.filter((message) => textOf(message).startsWith(LEXICON_CONTEXT_HEADING)).length, 1,
    'exactly one lexicon block is appended');
  assert.equal(block.source.kind, ASSISTANT_MEMORY_SOURCE, 'the block carries the plugin exclusion marker');
  assert.notEqual(block.id, original.id, 'the block is a separate message, not the user utterance');

  const body = textOf(block);
  assert.ok(body.startsWith(`${LEXICON_CONTEXT_HEADING}\n`), 'the block starts with the reference heading');
  assert.match(body, /词语：向晚/u);
  assert.match(body, /类别：person/u);
  assert.match(body, /含义\/用法：虚拟主播，粉丝常用称呼。/u);
  assert.match(body, /词语：长崎（长崎酱）/u, 'a differing text/canonical pair stays in the 词语 line');
  assert.ok(!body.includes('香碗'), 'wrongForms are never rendered');
  assert.ok(!body.includes('星野'), 'non-confirmed entries are never rendered');
  assert.ok(!body.includes('lex-1'), 'internal ids are never rendered');
  assert.ok(!body.includes('confirmed'), 'review status is never rendered');
  assert.ok(!body.includes('xiangwan') && !body.includes('collections') && !body.includes('approved'),
    'reading/counters/review fields are never rendered');
  assert.equal(memory.calls.restore, 0, 'injection itself reinforces nothing');

  // The same turn/agent retry must not append a second copy or re-read the lexicon.
  const retried = await prep.handle(payload, enterDecision(payload.messages));
  assert.equal(retried.messages.length, payload.messages.length, 'a retry appends nothing');
  assert.equal(reads, 1, 'the lexicon is read once for the turn');

  console.log(`[1] one block, ${[...body].length} chars, confirmed-only fields`);
});

test('2) unrelated entries, zero entries and non-confirmed entries inject no block', async () => {
  const unrelated = await runTurn({
    memory: stubMemory(),
    lexiconEntries: () => [confirmed('lex-u', '向晚', {category: 'person', usage: '虚拟主播。'})],
    query: '量子退相干的物理图像是什么',
    agentId: 'lex-unrelated',
    sessionId: 'session-lex-unrelated',
  });
  assert.equal(findLexiconBlock(unrelated.result), undefined, 'an unrelated word injects no block');
  assert.equal(unrelated.log.events.filter((event) => event.type === 'memory.recall').length, 1,
    'the memory lane still ran exactly once');

  const empty = await runTurn({
    memory: stubMemory(),
    lexiconEntries: () => [],
    query: '向晚今天直播了吗',
    agentId: 'lex-empty',
    sessionId: 'session-lex-empty',
  });
  assert.equal(findLexiconBlock(empty.result), undefined, 'zero entries inject no empty header');

  const direct = recallLexiconContext({entries: [], text: '向晚'});
  assert.deepEqual(direct, {text: '', count: 0, candidates: [], ambiguous: false});
  assert.equal(recallLexiconContext({entries: [confirmed('lex-x', '向晚')], text: ''}).text, '',
    'empty input text recalls nothing');

  console.log('[2] unrelated / zero entries → no block, no empty header');
});

test('3) the independent budget keeps the most relevant entry and never spends memory chars', async () => {
  const longUsage = '这是一个很长但完整保留的释义。'.repeat(40);
  const entries = ['向晚', '星野', '长崎'].map((word, index) => confirmed(`lex-${index}`, word, {
    category: 'person',
    usage: longUsage,
  }));

  const fixed = [memoryRow('fixed-1', '固定事实：预算彼此独立。')];
  const withLexicon = await runTurn({
    memory: stubMemory({fixed, hits: []}),
    lexiconEntries: () => entries,
    query: '向晚、星野和长崎今天都直播吗',
    agentId: 'lex-budget',
    sessionId: 'session-lex-budget',
  });
  const baseline = await runTurn({
    memory: stubMemory({fixed, hits: []}),
    query: '向晚、星野和长崎今天都直播吗',
    agentId: 'lex-budget-base',
    sessionId: 'session-lex-budget-base',
  });

  const lexBlock = findLexiconBlock(withLexicon.result);
  assert.ok(lexBlock, 'the most relevant entry still fits inside the independent cap');
  const lexBody = textOf(lexBlock);
  assert.ok(lexBody.length <= LEXICON_CONTEXT_MAX_CHARS,
    `lexicon block is ${lexBody.length} chars (cap ${LEXICON_CONTEXT_MAX_CHARS})`);
  assert.match(lexBody, /词语：向晚/u, 'the top-ranked entry is kept');
  assert.ok(!lexBody.includes('星野') && !lexBody.includes('长崎'),
    'lower-ranked entries are dropped whole instead of breaking the budget');

  const memoryBlock = findMemoryBlock(withLexicon.result);
  const baselineMemoryBlock = findMemoryBlock(baseline.result);
  assert.ok(memoryBlock && baselineMemoryBlock, 'the fixed memory block is present in both runs');
  assert.equal(textOf(memoryBlock), textOf(baselineMemoryBlock),
    'the memory block is byte-for-byte unchanged by the lexicon block');
  assert.ok(!textOf(memoryBlock).includes(LEXICON_CONTEXT_HEADING), 'the lexicon block is not mixed into memory');
  assert.equal(findLexiconBlock(baseline.result), undefined, 'the baseline run has no lexicon block');

  console.log(`[3] lexicon ${lexBody.length}/${LEXICON_CONTEXT_MAX_CHARS} chars, memory block unchanged`);
});

test('4) injection writes no memory and reinforces nothing, even when the message is observed', async () => {
  const memory = stubMemory({hits: [memoryRow('mem-1', '上周我们聊到了向晚的直播。')]});
  const {prep, agent, result} = await runTurn({
    memory,
    lexiconEntries: () => [confirmed('lex-n', '向晚', {category: 'person', usage: '虚拟主播。'})],
    query: '向晚今天直播了吗',
    agentId: 'lex-observe',
    sessionId: 'session-lex-observe',
  });
  const lexBlock = findLexiconBlock(result);
  assert.ok(lexBlock, 'the lexicon block was injected');

  const before = {...memory.calls};
  prep.observe(agent.session, {
    type: 'user/message',
    data: lexBlock,
  });
  assert.deepEqual(memory.calls, before, 'observing the lexicon message neither restores nor writes memory');
  assert.equal(memory.calls.restore, 0, 'no record was reinforced');
  assert.equal(memory.calls.deliverCandidates, 0, 'no candidate delivery ran');
  assert.equal(memory.calls.persistCandidate, 0, 'no candidate was persisted');
  assert.equal(memory.calls.recall, 1, 'the memory lane itself ran once');
  assert.equal(memory.calls.fixedMemories, 1, 'the fixed lane itself ran once');

  console.log('[4] observe(lexicon message) → restore=0, deliver/persist=0');
});

test('5) both the voice and typed entries run the same local lexicon recall', async () => {
  const entries = [confirmed('lex-both', '向晚', {category: 'person', usage: '虚拟主播。'})];
  for (const [lane, sessionId, agentId] of [
    ['voice', 'seirein-2026-11-10', 'lex-voice'],
    ['typed', 'typed-session', 'lex-typed'],
  ]) {
    let reads = 0;
    const run = await runTurn({
      memory: stubMemory(),
      lexiconEntries: () => {
        reads += 1;
        return entries;
      },
      query: '向晚今天直播了吗',
      lane,
      sessionId,
      agentId,
    });
    assert.ok(findLexiconBlock(run.result), `${lane} entry injects the lexicon block`);
    assert.equal(reads, 1, `${lane} entry reads the lexicon exactly once`);
  }
  // The host wires the store once and the pre-step serves both lanes; no speech-only branch exists.
  // The effective view is per confirmed self: public + that self's own voiceprint entries only.
  const source = await readFile(new URL('../src/host/index.js', import.meta.url), 'utf8');
  assert.match(source,
    /lexiconEntries: \(\) => lexiconStore\.listActive\(\{ speakerId: lexiconSelfId\(\) \}\)/u,
    'the host passes the active lexicon for the confirmed self to the pre-step');
  console.log('[5] voice and typed both inject');
});

test('6) without a lexicon provider the old memory-pipeline output is unchanged', async () => {
  const hits = [memoryRow('mem-base', '每周三一起看动画。')];
  const query = '这周三一起看动画好吗';
  const baseline = await runTurn({
    memory: stubMemory({hits}),
    query,
    agentId: 'lex-base-none',
    sessionId: 'session-lex-base-none',
  });
  const emptyProvider = await runTurn({
    memory: stubMemory({hits}),
    lexiconEntries: () => [],
    query,
    agentId: 'lex-base-empty',
    sessionId: 'session-lex-base-empty',
  });

  assert.equal(findLexiconBlock(baseline.result), undefined, 'no provider → no lexicon block');
  assert.equal(findLexiconBlock(emptyProvider.result), undefined, 'empty provider → no lexicon block');
  assert.equal(baseline.result.messages.length, emptyProvider.result.messages.length,
    'the appended message count is unchanged');
  assert.deepEqual(
    baseline.result.messages.map(textOf),
    emptyProvider.result.messages.map(textOf),
    'the rendered memory output is unchanged',
  );
  assert.equal(baseline.log.events.filter((event) => event.type === 'memory.recall').length, 1);
  assert.equal(emptyProvider.log.events.filter((event) => event.type === 'memory.recall').length, 1);

  console.log('[6] memory output identical with/without an empty lexicon provider');
});
