/**
 * P-58 (A3 remainder): the fast path's 45 s budget covers generation only, and playback no
 * longer blocks the model read loop.
 *
 * Proves:
 *  1. a reply whose playback is longer than the (scaled) budget is not timed out;
 *  2. generation past the budget emits `fastpath.stream.timeout {phase:'generate'}` and leaves
 *     the sentence that is already playing untouched;
 *  3. a slow `onSentence` (200 ms each) does not stall the stream: generation finishes on its own
 *     schedule instead of paying every sentence delay twice;
 *  4. a full queue MERGES its two oldest waiting blocks instead of dropping a sentence: 12
 *     sentences at limit 4 are all spoken, in order, with only `fastpath.queue.merged` recorded;
 *  5. a single over-long sentence (261 chars) is SPLIT at punctuation / fixed length, and every
 *     chunk is played in order: joining playback reproduces the sentence, `partial:false`;
 *  5b. speech past the shared 1200-character budget is truncated to that budget and reported
 *     (`fastpath.queue.truncated {chars, partial:true}`, `truncatedChars>0`, `partial:true`);
 *  5c. an over-long sentence with clause marks is cut at those marks, still losslessly;
 *  5d. a long run with NO punctuation at all is cut by fixed length and stays whole;
 *  6. when a merge is impossible (a language switch) the turn reports `partial:true` with
 *     `droppedSentences` and `fastpath.queue.dropped {count, reason}` — never a silent skip;
 *  7. a new turn / barge-in clears the pending queue, stops generation, and never rewinds the
 *     sentence that already started playing.
 *
 * Run: node --test test/fastpath-stream.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { FastPath } from '../src/host/session/inference/fastpath.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const since = (start) => Date.now() - start;
const ofType = (events, type) => events.filter((event) => event.type === type);

async function harness({ config = {}, stream }) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-fastpath-stream-'));
  const events = [];
  const llm = {
    async *stream(request) {
      yield* stream(request);
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
      emit(type, payload) {
        events.push({ type, ...payload });
        return Promise.resolve();
      },
    },
    config,
  };
  return { fastPath: new FastPath({ root, ...deps }), events };
}

// ---- 1. playback longer than the budget -----------------------------------------------------

test('P-58-1: 播放超过预算不计入超时（生成 20 ms、播放 180 ms、预算 70 ms，按比例缩放）', async () => {
  const { fastPath, events } = await harness({
    config: { fastpathStreamTimeoutMs: 70 },
    stream: async function* stream() {
      await sleep(20);
      yield { type: 'text-delta', text: '这是一句会播放很久的回答。' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  });

  const startedAt = Date.now();
  const plays = [];
  const result = await fastPath.askStream('慢慢说', {
    onSentence: async (sentence) => {
      plays.push(since(startedAt));
      await sleep(180);
    },
  });
  const totalMs = since(startedAt);

  assert.equal(result.reply, '这是一句会播放很久的回答。');
  assert.deepEqual(plays.map(() => 'played'), ['played'], 'the sentence was played once');
  assert.ok(totalMs >= 170, `askStream waited for playback: ${totalMs} ms`);
  assert.equal(ofType(events, 'fastpath.stream.timeout').length, 0, 'playback must not trip the budget');
  assert.equal(ofType(events, 'fastpath.turn').length, 1, 'the turn still records its normal event');
  console.log(`1) generation<20ms, playback~180ms, budget=70ms, total=${totalMs}ms, timeouts=0`);
});

// ---- 2. generation timeout, playing sentence untouched ---------------------------------------

test("P-58-2: 生成超时记 phase:'generate'，已在播的句子不被切断", async () => {
  let generatorSawAbort = false;
  const { fastPath, events } = await harness({
    config: { fastpathStreamTimeoutMs: 60 },
    stream: async function* stream(request) {
      yield { type: 'text-delta', text: '第一句。' };
      await sleep(120);
      generatorSawAbort = request.signal.aborted;
      if (request.signal.aborted) return;
      yield { type: 'text-delta', text: '第二句。' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  });

  const startedAt = Date.now();
  const plays = [];
  let error = null;
  try {
    await fastPath.askStream('说两句', {
      onSentence: async (sentence) => {
        const play = { sentence, start: since(startedAt) };
        plays.push(play);
        await sleep(220);
        play.end = since(startedAt);
      },
    });
  } catch (caught) {
    error = caught;
  }
  const rejectedAt = since(startedAt);

  const timeouts = ofType(events, 'fastpath.stream.timeout');
  assert.equal(timeouts.length, 1, 'one timeout event');
  assert.equal(timeouts[0].phase, 'generate', 'the budget was exceeded during generation');
  assert.equal(timeouts[0].ms, 60, 'the event reports the configured budget');
  assert.equal(generatorSawAbort, true, 'the generation signal was aborted');
  assert.ok(error !== null, 'the turn reports the timeout');
  assert.match(error.message, /超时/u);

  assert.equal(plays.length, 1, 'no new sentence started after the timeout');
  assert.equal(plays[0].sentence, '第一句。');
  assert.ok(plays[0].end >= 200, `the playing sentence ran to its end: ${plays[0].end} ms`);
  assert.ok(rejectedAt >= plays[0].end - 10, `the timeout waited for the sentence instead of cutting it: rejected at ${rejectedAt} ms`);
  console.log(`2) timeout@60ms phase=generate, play ${plays[0].start}..${plays[0].end}ms, rejected=${rejectedAt}ms`);
});

// ---- 3. a slow onSentence must not stall the read loop --------------------------------------

test('P-58-3: onSentence 每句 200 ms 不阻塞读循环', async () => {
  const SENTENCES = ['第1句。', '第2句。', '第3句。', '第4句。', '第5句。', '第6句。'];
  const startedAt = Date.now();
  let readDoneAt = -1;
  const { fastPath } = await harness({
    config: { fastpathStreamTimeoutMs: 5_000 },
    stream: async function* stream() {
      for (const sentence of SENTENCES) {
        await sleep(200);
        yield { type: 'text-delta', text: sentence };
      }
      // Reaching this line means the consumer asked for the finish chunk after every delta.
      readDoneAt = since(startedAt);
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  });

  const plays = [];
  const result = await fastPath.askStream('说六句', {
    onSentence: async (sentence) => {
      const play = { sentence, start: since(startedAt) };
      plays.push(play);
      await sleep(200);
      play.end = since(startedAt);
    },
  });
  const totalMs = since(startedAt);
  const sentenceSum = 6 * 200;

  assert.equal(result.reply, SENTENCES.join(''));
  assert.equal(plays.length, 6, 'every sentence was handed over exactly once');
  assert.deepEqual(plays.map((play) => play.sentence), SENTENCES, 'playback order is preserved');

  // Generation = sum of the model's own 200 ms gaps (~1200 ms). If the read loop awaited each
  // 200 ms playback it would take ~2400 ms; the queue must not add that second copy.
  assert.ok(readDoneAt >= 1_000, `generation actually took its natural time: ${readDoneAt} ms`);
  assert.ok(readDoneAt < 1_900, `read loop was not blocked by playback: read done at ${readDoneAt} ms`);
  assert.ok(totalMs < 2_000, `total ${totalMs} ms stays near ${sentenceSum} ms, not doubled`);

  // Playback overlaps generation: the first sentence starts long before the model is done.
  assert.ok(plays[0].start < readDoneAt, `first play at ${plays[0].start} ms, read done at ${readDoneAt} ms`);
  for (let index = 1; index < plays.length; index += 1) {
    assert.ok(plays[index].start >= plays[index - 1].end - 10, 'the queue plays one sentence at a time');
  }
  console.log(`3) readDone=${readDoneAt}ms (blocking would be ~2400ms), total=${totalMs}ms vs sentenceSum=${sentenceSum}ms, plays=${plays.length}`);
});

// ---- 4. a full queue merges instead of dropping ----------------------------------------------

test('P-58-4: 队列满载合并最旧两句，12 句全部按序播报且只有 merged 事件', async () => {
  const PUSHES = 12;
  const sentences = Array.from({ length: PUSHES }, (_value, index) => `第${index}句。`);
  const { fastPath, events } = await harness({
    config: { fastpathStreamTimeoutMs: 5_000, fastpathSentenceQueueLimit: 4, fastpathQueueDepthThrottleMs: 200 },
    stream: async function* stream() {
      for (const sentence of sentences) yield { type: 'text-delta', text: sentence };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  });

  const plays = [];
  const result = await fastPath.askStream('说十二句', {
    onSentence: async (sentence) => {
      plays.push(sentence);
      await sleep(80);
    },
  });

  assert.equal(result.reply, sentences.join(''), '正文完整');
  assert.equal(plays.join(''), sentences.join(''), '每一句都被播报，拼接后顺序不变');
  assert.ok(plays.length < PUSHES, `满载的句子被合并成更少的块：${plays.length} 块`);
  assert.equal(ofType(events, 'fastpath.queue.dropped').length, 0, '满载合并，不是跳句');
  assert.equal(ofType(events, 'fastpath.queue.truncated').length, 0, '没有句子超长，不截断');
  const merges = ofType(events, 'fastpath.queue.merged');
  assert.ok(merges.length > 0, '满载时发生了合并');
  assert.ok(merges.every((event) => event.count >= 2), '每次合并至少包含两句');
  assert.equal(result.partial, false);
  assert.equal(result.droppedSentences, 0);
  assert.equal(result.truncatedChars, 0);
  console.log(
    `4) pushes=${PUSHES} limit=4 blocks=${plays.length} merged=${merges.length} counts=${JSON.stringify(merges.map((event) => event.count))} plays=${JSON.stringify(plays)}`,
  );
});

// ---- 5. an over-long sentence is split, never silently cut --------------------------------

test('P-58-5: 261 字单句拆成多块，播放拼接 === 原句，partial:false', async () => {
  const tooLong = `${'长'.repeat(260)}。`; // 261 chars: one sentence, no clause break
  const tail = ['短句一。', '短句二。'];
  const { fastPath, events } = await harness({
    config: { fastpathStreamTimeoutMs: 5_000, fastpathSentenceQueueLimit: 16 },
    stream: async function* stream() {
      yield { type: 'text-delta', text: tooLong };
      for (const sentence of tail) yield { type: 'text-delta', text: sentence };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  });

  const plays = [];
  const result = await fastPath.askStream('说个长句', {
    onSentence: async (sentence) => {
      plays.push(sentence);
      await sleep(5);
    },
  });

  const longPlays = plays.slice(0, -tail.length);
  assert.ok(longPlays.length >= 2, `261 字单句被拆成多块：${longPlays.length} 块`);
  assert.equal(longPlays.join(''), tooLong, '拼接后与原句逐字一致，不丢内容');
  assert.ok(longPlays.every((chunk) => chunk.length <= 200), '每块不超过 200 字');
  assert.deepEqual(plays.slice(-tail.length), tail, '其余句子原样保留');

  const splits = ofType(events, 'fastpath.queue.split');
  assert.equal(splits.length, 1, '超长句上报一次 fastpath.queue.split');
  assert.equal(splits[0].chunks, longPlays.length, 'split 事件的块数与实际播放块数一致');
  assert.equal(ofType(events, 'fastpath.queue.truncated').length, 0, '预算内不截断');
  assert.equal(result.reply, tooLong + tail.join(''), '正文不受影响');
  assert.equal(result.truncatedChars, 0);
  assert.equal(result.partial, false, '内容全播，partial 不置位');
  assert.equal(result.droppedSentences, 0);
  console.log(
    `5) tooLong=${tooLong.length} chars -> ${longPlays.length} chunks sizes=${JSON.stringify(longPlays.map((chunk) => chunk.length))}, joinedMatches=${longPlays.join('') === tooLong}, partial=${result.partial}, truncatedChars=${result.truncatedChars}`,
  );
});

// ---- 5b. the shared total budget is the only thing that truncates -------------------------

test('P-58-5b: 超过 1200 字总预算时截断到预算内，partial:true、truncatedChars>0', async () => {
  const tooLong = '长'.repeat(1_500); // one sentence, no punctuation: fixed-length chunks
  const { fastPath, events } = await harness({
    config: { fastpathStreamTimeoutMs: 5_000, fastpathSentenceQueueLimit: 16 },
    stream: async function* stream() {
      yield { type: 'text-delta', text: tooLong };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  });

  const plays = [];
  const result = await fastPath.askStream('说个超长句', {
    onSentence: async (sentence) => {
      plays.push(sentence);
      await sleep(2);
    },
  });

  const spoken = plays.join('');
  assert.ok(spoken.length <= 1_200, `播放不超过 1200 字总预算：${spoken.length}`);
  assert.equal(spoken, tooLong.slice(0, 1_200), '截断落在预算边界，多出的 300 字不再播');
  assert.equal(result.reply, tooLong, '正文完整，截断只影响播报');
  assert.equal(result.partial, true, '有播报内容被截断，结果必须 partial');
  assert.equal(result.truncatedChars, tooLong.length - 1_200);
  assert.ok(result.truncatedChars > 0);
  assert.equal(result.droppedSentences, 0);

  const truncations = ofType(events, 'fastpath.queue.truncated');
  assert.equal(truncations.length, 1, '预算边界上报一次截断');
  assert.equal(truncations[0].chars, tooLong.length - 1_200);
  assert.equal(truncations[0].partial, true, '截断事件自带 partial:true');
  const splits = ofType(events, 'fastpath.queue.split');
  assert.equal(splits[0]?.chunks, Math.ceil(tooLong.length / 200), '整句先按长度切成块');
  console.log(
    `5b) tooLong=${tooLong.length} chars -> spoken=${spoken.length} chunks=${plays.length}, truncatedChars=${result.truncatedChars}, partial=${result.partial}, event=${JSON.stringify(truncations[0])}`,
  );
});

// ---- 5c. clause marks decide the cut, still lossless -------------------------------------

test('P-58-5c: 超长句优先按标点切块，切点落在标点上且内容完整', async () => {
  // 261 chars with `、` marks but no comma: splitSentences keeps it as one sentence.
  const tooLong = `${'甲'.repeat(100)}、${'乙'.repeat(100)}、${'丙'.repeat(58)}。`;
  const { fastPath, events } = await harness({
    config: { fastpathStreamTimeoutMs: 5_000, fastpathSentenceQueueLimit: 16 },
    stream: async function* stream() {
      yield { type: 'text-delta', text: tooLong };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  });

  const plays = [];
  const result = await fastPath.askStream('说个带顿号的长句', {
    onSentence: async (sentence) => {
      plays.push(sentence);
      await sleep(2);
    },
  });

  assert.ok(plays.length >= 2, `带标点的超长句也被拆块：${plays.length}`);
  assert.equal(plays.join(''), tooLong, '按标点切块同样不丢字');
  assert.ok(plays[0].endsWith('、'), `第一块切在标点后：${JSON.stringify(plays[0].slice(-3))}`);
  assert.ok(plays.every((chunk) => chunk.length <= 200));
  assert.equal(ofType(events, 'fastpath.queue.truncated').length, 0);
  assert.equal(result.partial, false);
  assert.equal(result.truncatedChars, 0);
  console.log(
    `5c) tooLong=${tooLong.length} chars -> ${plays.length} chunks sizes=${JSON.stringify(plays.map((chunk) => chunk.length))}, firstEndsWith=${JSON.stringify(plays[0].slice(-1))}, partial=${result.partial}`,
  );
});

// ---- 5d. no punctuation at all: fixed-length chunks, nothing lost -------------------------

test('P-58-5d: 无标点超长串按固定长度切块，仍保留全部内容', async () => {
  const tooLong = '甲'.repeat(300); // no sentence end, no clause mark: only the flush tail
  const { fastPath, events } = await harness({
    config: { fastpathStreamTimeoutMs: 5_000, fastpathSentenceQueueLimit: 16 },
    stream: async function* stream() {
      yield { type: 'text-delta', text: tooLong };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  });

  const plays = [];
  const result = await fastPath.askStream('说个没有标点的长串', {
    onSentence: async (sentence) => {
      plays.push(sentence);
      await sleep(2);
    },
  });

  assert.ok(plays.length >= 2, `无标点长串也被切块：${plays.length}`);
  assert.equal(plays.join(''), tooLong, '按长度切块不丢任何字符');
  assert.deepEqual(plays.map((chunk) => chunk.length), [200, 100], '按 200 字固定长度切');
  assert.equal(ofType(events, 'fastpath.queue.truncated').length, 0);
  assert.equal(result.partial, false);
  assert.equal(result.truncatedChars, 0);
  console.log(
    `5d) tooLong=${tooLong.length} chars -> ${plays.length} chunks sizes=${JSON.stringify(plays.map((chunk) => chunk.length))}, joinedMatches=${plays.join('') === tooLong}, partial=${result.partial}`,
  );
});

// ---- 6. an impossible merge is reported, never a silent skip ---------------------------------

test('P-58-6: 无法合并（语言切换）时如实报告 partial:true 与 droppedSentences', async () => {
  // '!' ends a sentence for splitSentences (an ASCII '.' does not), so each line is its own push.
  const script = ['中文第一句。', '中文第二句。', 'English third!', 'English fourth!'];
  const { fastPath, events } = await harness({
    config: { fastpathStreamTimeoutMs: 5_000, fastpathSentenceQueueLimit: 2 },
    stream: async function* stream() {
      for (const sentence of script) yield { type: 'text-delta', text: sentence };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  });

  // Hold the first block in "playback" until generation is over, so the queue really fills and the
  // language switch is the only possible outcome (no timing luck involved).
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const plays = [];
  const turn = fastPath.askStream('换语言说', {
    onSentence: async (sentence) => {
      plays.push(sentence);
      await gate;
    },
  });
  await sleep(50);
  release();
  const result = await turn;

  assert.equal(result.reply, script.join(''), '正文完整');
  assert.equal(result.partial, true, '有句子没播报，结果必须如实标记 partial');
  assert.equal(result.droppedSentences, 1, '语言切换丢掉的那一句被计数');
  assert.deepEqual(plays, ['中文第一句。', 'English third!', 'English fourth!'], '跳过的句子不再静默');
  const dropped = ofType(events, 'fastpath.queue.dropped');
  assert.deepEqual(dropped.map((event) => [event.count, event.reason]), [[1, 'language-switch']]);
  assert.equal(ofType(events, 'fastpath.queue.merged').length, 0);
  console.log(
    `6) reply=${result.reply.length}字 complete, partial=${result.partial} dropped=${result.droppedSentences} reason=${dropped[0]?.reason} plays=${JSON.stringify(plays)}`,
  );
});

// ---- 7. cancellation ------------------------------------------------------------------------

test('P-58-7: 新轮/打断清空待播队列并停止生成，已播句子不回溯', async () => {
  const controller = new AbortController();
  const startedAt = Date.now();
  const pulled = [];
  const { fastPath, events } = await harness({
    config: { fastpathStreamTimeoutMs: 5_000, fastpathSentenceQueueLimit: 16 },
    stream: async function* stream(request) {
      for (let index = 0; index < 5; index += 1) {
        if (index > 0) await sleep(30);
        if (request.signal.aborted) return;
        pulled.push(index);
        yield { type: 'text-delta', text: `第${index}句。` };
      }
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  });

  const plays = [];
  setTimeout(() => controller.abort(), 50);
  let error = null;
  try {
    await fastPath.askStream('说五句', {
      signal: controller.signal,
      onSentence: async (sentence) => {
        const play = { sentence, start: since(startedAt) };
        plays.push(play);
        await sleep(plays.length === 1 ? 300 : 20);
        play.end = since(startedAt);
      },
    });
  } catch (caught) {
    error = caught;
  }
  const rejectedAt = since(startedAt);

  assert.ok(error !== null, 'the aborted turn rejects');
  assert.equal(error.name, 'AbortError', 'barge-in keeps the existing abort semantics');
  assert.ok(rejectedAt < 250, `the turn stops without waiting for playback: rejected at ${rejectedAt} ms`);
  assert.ok(pulled.length < 5, `generation stopped early: pulled ${pulled.length} chunks`);
  assert.deepEqual(plays.map((play) => play.sentence), ['第0句。'], 'only the in-flight sentence ran; queued ones were dropped');

  // fastpath never rewinds a sentence it already started: it keeps playing until it ends.
  await sleep(320);
  assert.ok(plays[0].end >= 280, `the already-playing sentence finished on its own: ${plays[0].end} ms`);
  const depths = ofType(events, 'fastpath.queue.depth');
  assert.equal(depths.at(-1)?.depth, 0, 'the cancelled queue reports empty');
  // A barge-in is the other case where queued speech cannot be kept: the cleared sentences are
  // recorded with their reason, so a dropped line is never invisible in the event log.
  const dropped = ofType(events, 'fastpath.queue.dropped');
  assert.ok(dropped.some((event) => event.reason === 'barge-in'), 'the cleared sentences are recorded');
  console.log(`7) abort@50ms rejected=${rejectedAt}ms pulled=${pulled.length}/${5} plays=${plays.length} lastDepth=${depths.at(-1)?.depth} droppedOnBargeIn=${dropped.map((event) => `${event.count}/${event.reason}`).join(',')}`);
});
