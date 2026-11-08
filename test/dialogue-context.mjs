/**
 * Continuous dialogue context: buffering + rolling summary skeleton for segmented ASR.
 *
 * The module is not wired into the host yet; these tests pin the contract only. Everything here
 * is in-memory and synchronous: no model, no memory store, no timer, no I/O.
 *
 * Run: node --test test/dialogue-context.mjs
 * Regression: node test/smoke.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DIALOGUE_CONTEXT_DEFAULTS,
  createDialogueContext,
  isUnfinishedSentence,
} from '../src/host/session/conversation/dialogueContext.js';

const base = 1_000_000;

test('1. three utterances within 10s: sorted recent window, all three rendered', () => {
  const ctx = createDialogueContext({ now: base, maxWindowMs: 120_000, maxChars: 1_200 });
  assert.equal(ctx.render(), '', 'an empty buffer renders nothing');
  assert.equal(ctx.push({ text: '   ', at: base, utteranceId: 'blank' }), null, 'blank text is ignored');

  // A missing `at` falls back to the injected clock.
  const clocked = createDialogueContext({ now: base });
  assert.equal(clocked.push({ text: '没有时间戳的一段' }).at, base);

  // Pushed out of order on purpose: the window is ordered by recognition time.
  assert.ok(ctx.push({ text: '第二段：灯还亮着。', at: base + 5_000, utteranceId: 'u2' }));
  assert.ok(ctx.push({ text: '第一段：门是开着的。', at: base + 1_000, utteranceId: 'u1' }));
  assert.ok(ctx.push({ text: '第三段：里面没有人。', at: base + 9_000, utteranceId: 'u3' }));

  const snapshot = ctx.snapshot();
  assert.deepEqual(snapshot.recent, [
    { text: '第一段：门是开着的。', at: base + 1_000, utteranceId: 'u1', source: 'mic', segment: 0 },
    { text: '第二段：灯还亮着。', at: base + 5_000, utteranceId: 'u2', source: 'mic', segment: 0 },
    { text: '第三段：里面没有人。', at: base + 9_000, utteranceId: 'u3', source: 'mic', segment: 0 },
  ], 'recent is time-sorted and keeps the contracted fields');
  assert.equal(snapshot.needsSummary, false, 'nothing rolled out yet');
  assert.equal(snapshot.openSentence, false);

  const rendered = ctx.render();
  assert.ok(rendered.includes('系统观察，不是用户发言'), 'the explanation is part of render()');
  for (const segment of ['第一段：门是开着的。', '第二段：灯还亮着。', '第三段：里面没有人。']) {
    assert.ok(rendered.includes(segment), `render keeps the utterance: ${segment}`);
  }
  assert.ok(
    rendered.indexOf('第一段') < rendered.indexOf('第二段')
      && rendered.indexOf('第二段') < rendered.indexOf('第三段'),
    'rendered text keeps the chronological order',
  );
});

test('2. text older than maxWindowMs rolls out of the window and needsSummary() turns true', () => {
  const ctx = createDialogueContext({ now: base, maxWindowMs: 30_000, summaryEveryChars: 10, maxSummaryChars: 20 });
  const first = '第十秒的内容。';
  const second = '第二十秒的内容。';
  const third = '第三十秒的内容。';
  const fourth = '第四十五秒的内容。';

  for (const [text, offset, id] of [
    [first, 0, 'a'], [second, 10_000, 'b'], [third, 20_000, 'c'],
  ]) {
    ctx.push({ text, at: base + offset, utteranceId: id });
  }
  assert.equal(ctx.snapshot().recent.length, 3, 'all three are still inside 30s of each other');

  ctx.push({ text: fourth, at: base + 45_000, utteranceId: 'd' });
  const snapshot = ctx.snapshot();
  assert.deepEqual(snapshot.recent.map((item) => item.text), [third, fourth], 'only the last 30s stays verbatim');
  assert.equal(snapshot.pendingChars, first.length + second.length, 'rolled-out text waits for the summary');
  assert.equal(snapshot.pending.length, 2);
  assert.equal(snapshot.needsSummary, true, '10+ characters rolled out');
  assert.equal(ctx.needsSummary(), true);

  // An empty generation result is a failure, not permission to discard the pending text.
  const ignored = ctx.applySummary('', {
    through: snapshot.pendingVersion,
    generation: snapshot.generation,
  });
  assert.equal(ignored.applied, false);
  assert.equal(ignored.reason, 'empty');
  assert.equal(ctx.snapshot().pendingChars, first.length + second.length);
  assert.equal(ctx.needsSummary(), true);

  // The caller generates the summary asynchronously and backfills it; the pending text is then
  // replaced, not appended twice. The cap keeps the most recent part of a long summary.
  const longSummary = '较早内容摘要：门开着，灯亮着，两个人正在找钥匙，之后他们离开了房间，去了楼下。';
  const applied = ctx.applySummary(longSummary, {
    through: snapshot.pendingVersion,
    generation: snapshot.generation,
  });
  assert.equal(applied.ok, true);
  assert.equal(applied.applied, true);
  const after = ctx.snapshot();
  assert.equal(after.needsSummary, false, 'the pending queue was summarized');
  assert.equal(after.pendingChars, 0);
  assert.equal(after.summaryTruncated, true, 'the summary exceeded maxSummaryChars');
  assert.equal(after.summaryChars, 20);
  assert.equal(after.summary, Array.from(longSummary).slice(-20).join(''), 'the newest 20 characters survive');
  assert.equal(ctx.render().includes(after.summary), true, 'render injects the stored summary');
});

test('3. over maxChars: oldest segments roll out first, the newest stays', () => {
  const ctx = createDialogueContext({ now: base, maxWindowMs: 600_000, maxChars: 12, summaryEveryChars: 10 });
  const first = '第一段内容。';
  const second = '第二段内容。';
  const third = '第三段内容。';
  const fourth = '第四段内容。';
  assert.equal(first.length, 6, 'fixture length');

  ctx.push({ text: first, at: base + 1_000, utteranceId: 'u1' });
  ctx.push({ text: second, at: base + 2_000, utteranceId: 'u2' });
  ctx.push({ text: third, at: base + 3_000, utteranceId: 'u3' });

  let snapshot = ctx.snapshot();
  assert.deepEqual(snapshot.recent.map((item) => item.text), [second, third], 'the earliest rolls out until the cap fits');
  assert.equal(snapshot.recentChars, 12);
  assert.equal(snapshot.pendingChars, first.length);

  ctx.push({ text: fourth, at: base + 4_000, utteranceId: 'u4' });
  snapshot = ctx.snapshot();
  assert.deepEqual(snapshot.recent.map((item) => item.text), [third, fourth], 'the newest is always kept');
  assert.equal(snapshot.pendingChars, first.length + second.length, 'the second segment rolled out next');
  assert.equal(snapshot.needsSummary, true);
  const rendered = ctx.render();
  assert.ok(rendered.includes(third) && rendered.includes(fourth), 'render still shows the verbatim window');
  assert.ok(!snapshot.recent.some((item) => item.text === first), 'the oldest text left the recent window');
  assert.ok(rendered.includes(first) && rendered.includes(second), 'rolled-out, not-yet-summarized text is still provided');
  assert.ok(rendered.includes('含较早、尚未摘要的部分'), 'the transcript labels the unsummarized part');
});

test('4. an unfinished sentence keeps its comma and continues on the same line', () => {
  const ctx = createDialogueContext({ now: base, maxWindowMs: 600_000 });
  assert.equal(isUnfinishedSentence('钥匙在柜子里，'), true);
  assert.equal(isUnfinishedSentence('你去拿吧。'), false);
  assert.equal(isUnfinishedSentence('他数了数钱，然后'), true);
  assert.equal(isUnfinishedSentence('“你好，”'), true);
  assert.equal(isUnfinishedSentence('真的吗？'), false);

  ctx.push({ text: '钥匙在柜子里，', at: base + 1_000, utteranceId: 'u1' });
  assert.equal(ctx.snapshot().openSentence, true, 'the last utterance is still open');
  ctx.push({ text: '你去拿吧。', at: base + 4_000, utteranceId: 'u2' });
  assert.equal(ctx.snapshot().openSentence, false);

  const rendered = ctx.render();
  assert.ok(rendered.includes('钥匙在柜子里，你去拿吧。'), 'the comma is kept and the sentence continues');
  assert.ok(!rendered.includes('钥匙在柜子里。'), 'no period is invented after the comma');

  // The join survives the window edge: the first half rolls out into pending, the sentence still
  // renders as one line instead of losing the comma to a section split.
  const rolled = createDialogueContext({ now: base, maxChars: 8 });
  rolled.push({ text: '钥匙在柜子里，', at: base + 1_000, utteranceId: 'r1' });
  rolled.push({ text: '你去拿吧。', at: base + 2_000, utteranceId: 'r2' });
  assert.deepEqual(rolled.snapshot().pending.map((item) => item.text), ['钥匙在柜子里，']);
  assert.deepEqual(rolled.snapshot().recent.map((item) => item.text), ['你去拿吧。']);
  assert.ok(rolled.render().includes('钥匙在柜子里，你去拿吧。'), 'the unfinished sentence stays joined across the window edge');

  // A connector ending is unfinished too, even without punctuation.
  const connector = createDialogueContext({ now: base });
  connector.push({ text: '他数了数钱，然后', at: base + 1_000, utteranceId: 'c1' });
  connector.push({ text: '才出门。', at: base + 2_000, utteranceId: 'c2' });
  assert.ok(connector.render().includes('他数了数钱，然后才出门。'));

  // A finished sentence is not glued to the next one: it starts a new line, with its own tag.
  const finished = createDialogueContext({ now: base });
  finished.push({ text: '我到家了。', at: base + 1_000, utteranceId: 'f1' });
  finished.push({ text: '你呢？', at: base + 2_000, utteranceId: 'f2' });
  assert.ok(
    finished.render().includes('[麦克风] 我到家了。\n[麦克风] 你呢？'),
    'a finished sentence gets a line break, not a join',
  );
});

test('5. markBoundary marks another segment: boundary time in the snapshot, divider in render', () => {
  let now = base;
  const ctx = createDialogueContext({ now: () => now, maxWindowMs: 600_000 });
  ctx.push({ text: '旧视频：他说要走。', at: now, utteranceId: 'old-1' });

  now += 1_000;
  const marked = ctx.markBoundary({ reason: 'source-switch' });
  assert.deepEqual(marked, { at: now, reason: 'source-switch', segment: 1 });

  const before = ctx.snapshot();
  assert.ok(before.boundaryMarked, 'the snapshot carries the boundary');
  assert.equal(before.boundaryMarked.at, now, 'boundaryMarked.at is the boundary time');
  assert.equal(before.boundaryMarked.reason, 'source-switch');
  assert.equal(before.boundaryMarkedAt, now, 'the flat aliases carry the same time');
  assert.equal(before.boundaryReason, 'source-switch');

  const beforeText = ctx.render();
  assert.ok(beforeText.includes('来源切换'), 'render names the source switch');
  assert.ok(beforeText.includes('另一段'), 'render says it is another segment');
  assert.ok(beforeText.includes('旧视频'), 'previous content is still available, only marked as another segment');

  now += 1_000;
  ctx.push({ text: '新视频：这是另一个故事。', at: now, utteranceId: 'new-1' });
  const rendered = ctx.render();
  const oldAt = rendered.indexOf('旧视频');
  const boundaryAt = rendered.indexOf('来源切换');
  const newAt = rendered.indexOf('新视频');
  assert.ok(oldAt >= 0 && boundaryAt > oldAt && newAt > boundaryAt, 'the divider sits between the two segments');
  assert.deepEqual(ctx.snapshot().recent.map((item) => item.segment), [0, 1], 'the window is marked by segment');
  assert.equal(ctx.snapshot().boundaryMarkedAt, now - 1_000);
  assert.equal(ctx.snapshot().segment, 1, 'the snapshot names the current segment');

  // A summary generated after the boundary from the earlier segment's text stays marked as
  // "another segment" instead of silently becoming the current story. The buffer generation is
  // unchanged by a boundary (only clear() starts a new generation), and no new text has rolled
  // out, so the pre-boundary request still matches and lands as an earlier-segment summary.
  const preBoundary = ctx.snapshot();
  ctx.applySummary('旧视频的摘要：他说要走，随后离开了。', {
    through: preBoundary.pendingVersion,
    generation: preBoundary.generation,
  });
  const summarized = ctx.snapshot();
  assert.equal(summarized.summaryFromEarlierSegment, true);
  assert.ok(ctx.render().includes('边界前，属于另一段'), 'the earlier-segment summary is labelled');

  // A boundary also drops the unfinished-sentence continuation: two clips are never spliced.
  const split = createDialogueContext({ now: base });
  split.push({ text: '门开着，', at: base, utteranceId: 's1' });
  split.markBoundary({ reason: 'jump' });
  split.push({ text: '这是新的一段。', at: base + 1_000, utteranceId: 's2' });
  const splitText = split.render();
  assert.ok(!splitText.includes('门开着，这是新的一段。'), 'the open sentence must not continue across a boundary');
  assert.ok(splitText.includes('来源切换'));

  // A small character window rolls the whole old segment out of the verbatim window (still inside
  // maxWindowMs, so read-time idle expiry does not hide it); the boundary line must still separate
  // the pending old text from the new segment instead of being lost.
  now += 1_000;
  const paused = createDialogueContext({ now: () => now, maxWindowMs: 600_000, maxChars: 1 });
  paused.push({ text: '暂停前的最后一句。', at: now, utteranceId: 'p1' });
  now += 20_000;
  paused.markBoundary({ reason: 'resume' });
  paused.push({ text: '恢复后的第一句。', at: now, utteranceId: 'p2' });
  assert.equal(paused.snapshot().recent.length, 1, 'the old segment rolled out of the verbatim window');
  assert.equal(paused.snapshot().pending.length, 1);
  const pausedText = paused.render();
  const pausedOld = pausedText.indexOf('暂停前的最后一句。');
  const pausedDivider = pausedText.indexOf('来源切换');
  assert.ok(
    pausedOld >= 0 && pausedDivider > pausedOld && pausedText.indexOf('恢复后的第一句。') > pausedDivider,
    'the boundary line separates a rolled-out old segment from the new one',
  );
});

test('6. snapshot() is read-only: repeated calls change neither state nor each other', () => {
  const ctx = createDialogueContext({ now: base, maxWindowMs: 600_000 });
  ctx.push({ text: '第一段：门是开着的。', at: base + 1_000, utteranceId: 'u1' });
  ctx.push({ text: '第二段：灯还亮着。', at: base + 2_000, utteranceId: 'u2' });
  ctx.markBoundary({ reason: 'pause' });

  const before = ctx.snapshot();
  const first = ctx.snapshot();
  const second = ctx.snapshot();
  assert.deepEqual(first, before, 'snapshot() does not change the state it reports');
  assert.deepEqual(second, before);
  assert.notEqual(first.recent, second.recent, 'each call returns a fresh array');
  assert.ok(Object.isFrozen(first.recent) && Object.isFrozen(first.recent[0]), 'the snapshot cannot be mutated');
  assert.throws(() => { first.recent.push({}); }, TypeError);
  assert.throws(() => { first.recent[0].text = '改写'; }, TypeError);
  assert.deepEqual(ctx.snapshot(), before, 'the failed mutations left the internal state untouched');

  // Rendering a snapshot neither mutates it nor the underlying buffer.
  const rendered = ctx.render(first);
  assert.equal(typeof rendered, 'string');
  assert.deepEqual(ctx.snapshot(), before, 'render(snapshot) is read-only too');
  assert.deepEqual(first, before);
});

test('7. regression: independent instances, loopback source and a full clear()', () => {
  const mic = createDialogueContext({ now: base });
  const loopback = createDialogueContext({ now: base, source: 'loopback' });

  mic.push({ text: '麦克风这边的一句话。', at: base, utteranceId: 'm1' });
  assert.equal(loopback.snapshot().recent.length, 0, 'another instance shares no state');
  assert.equal(loopback.snapshot().source, 'loopback');
  assert.equal(loopback.snapshot().limits.maxChars, DIALOGUE_CONTEXT_DEFAULTS.maxChars);
  loopback.push({ text: '电脑播放的内容。', at: base, utteranceId: 'l1' });
  assert.equal(loopback.snapshot().recent[0].source, 'loopback');

  mic.markBoundary({ reason: 'pause' });
  mic.applySummary('一段摘要', { through: mic.snapshot().pendingVersion, generation: mic.snapshot().generation });
  mic.clear();
  const cleared = mic.snapshot();
  assert.deepEqual(cleared.recent, []);
  assert.deepEqual(cleared.pending, []);
  assert.equal(cleared.summary, '');
  assert.equal(cleared.boundaryMarked, null);
  assert.equal(cleared.needsSummary, false);
  assert.equal(cleared.stats.pushed, 0);
  assert.equal(mic.render(), '', 'a cleared buffer renders nothing');
  assert.equal(loopback.snapshot().recent.length, 1, 'clear() affects only the instance that called it');
});

test('8. clear() starts a new generation: a late pre-clear summary is rejected with no side effect', () => {
  // maxChars:1 keeps the window tiny, so each new utterance rolls the previous one into pending.
  const ctx = createDialogueContext({ now: base, maxWindowMs: 600_000, maxChars: 1 });
  ctx.push({ text: '清空前的第一句。', at: base, utteranceId: 'old-1' });
  ctx.push({ text: '清空前的第二句。', at: base + 1_000, utteranceId: 'old-2' });

  const stale = ctx.snapshot();
  assert.equal(stale.generation, 1, 'the first buffer generation is 1');
  assert.equal(stale.pendingVersion, 1);
  assert.deepEqual(stale.pending.map((item) => item.text), ['清空前的第一句。']);

  ctx.clear();
  assert.equal(ctx.snapshot().generation, 2, 'clear() starts a new buffer generation');
  assert.equal(ctx.snapshot().pendingVersion, 0, 'while the pending version restarts from 0');

  // The new buffer reaches the SAME pending version the old request captured.
  ctx.push({ text: '清空后的第一句。', at: base, utteranceId: 'new-1' });
  ctx.push({ text: '清空后的第二句。', at: base + 1_000, utteranceId: 'new-2' });
  const fresh = ctx.snapshot();
  assert.equal(fresh.generation, 2);
  assert.equal(fresh.pendingVersion, 1, 'the refreshed version collides with the stale request');
  assert.deepEqual(fresh.pending.map((item) => item.text), ['清空后的第一句。']);

  const before = ctx.render();
  const rejected = ctx.applySummary('迟到的旧摘要', {
    through: stale.pendingVersion,
    generation: stale.generation,
  });
  assert.deepEqual(rejected, { ok: false, reason: 'stale-generation' });

  const after = ctx.snapshot();
  assert.deepEqual(after.pending, fresh.pending, 'the late summary left the new pending queue untouched');
  assert.equal(after.pendingChars, fresh.pendingChars);
  assert.equal(after.summary, '', 'the late summary was not stored');
  assert.equal(after.generation, 2);
  assert.equal(after.stats.summaries, 0, 'the rejection is not counted as a summary');
  assert.equal(ctx.render(), before, 'the rendered context is unchanged');
  assert.ok(ctx.render().includes('清空后的第一句。'), 'the new pending text is still provided');
  assert.ok(!ctx.render().includes('迟到的旧摘要'), 'the stale summary never reaches render()');
});

test('9. same generation, an earlier prefix is accepted; malformed/future through is rejected', () => {
  const ctx = createDialogueContext({ now: base, maxWindowMs: 600_000, maxChars: 1, summaryEveryChars: 100 });
  ctx.push({ text: '第一句。', at: base, utteranceId: 'v-1' });
  ctx.push({ text: '第二句。', at: base + 1_000, utteranceId: 'v-2' });

  const stale = ctx.snapshot();
  assert.equal(stale.generation, 1);
  assert.equal(stale.pendingVersion, 1);
  assert.equal(stale.pendingSerial, 1, 'pendingSerial is the current tail');

  // One more utterance rolls the previous one out; the serial moves on, the generation does not.
  ctx.push({ text: '第三句。', at: base + 2_000, utteranceId: 'v-3' });
  const fresh = ctx.snapshot();
  assert.equal(fresh.generation, stale.generation, 'same buffer generation');
  assert.equal(fresh.pendingVersion, 2, 'the pending serial moved on');
  assert.equal(fresh.pendingSerial, 2);
  assert.equal(fresh.summaryThrough, 0);

  // A request captured one step earlier still covers a prefix: it applies and removes exactly the
  // entries it summarized, keeping the text that rolled out while it was being generated.
  const prefix = ctx.applySummary('覆盖第一句的摘要', {
    through: stale.pendingSerial,
    generation: stale.generation,
  });
  assert.equal(prefix.ok, true, 'an earlier prefix is no longer rejected');
  assert.equal(prefix.pendingChars, '第二句。'.length);
  const afterPrefix = ctx.snapshot();
  assert.equal(afterPrefix.summaryThrough, 1);
  assert.deepEqual(afterPrefix.pending.map((item) => item.text), ['第二句。'], 'later pending text survives');
  assert.equal(afterPrefix.summary, '覆盖第一句的摘要');
  assert.equal(ctx.render().includes('第二句。'), true);

  // A request without a generation fails closed instead of guessing the current one.
  assert.deepEqual(ctx.applySummary('没有代次', { through: fresh.pendingVersion }), {
    ok: false,
    reason: 'stale-generation',
  });
  assert.equal(ctx.snapshot().pendingVersion, 2, 'a rejected request does not advance the serial');

  // A through value ahead of the queue, a negative one, or a non-integer one is rejected untouched.
  for (const [through, reason] of [[fresh.pendingVersion + 1, 'stale-version'], [-1, 'invalid-through'], [1.5, 'invalid-through']]) {
    const rejected = ctx.applySummary(`无效的摘要 ${through}`, { through, generation: fresh.generation });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.reason, reason);
  }
  assert.equal(ctx.snapshot().summaryThrough, 1);
  assert.equal(ctx.snapshot().summary, '覆盖第一句的摘要');

  // The current coordinates are accepted and advance the prefix to the tail.
  const accepted = ctx.applySummary('当前摘要', {
    through: fresh.pendingSerial,
    generation: fresh.generation,
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.pendingChars, 0);
  assert.equal(ctx.snapshot().pending.length, 0);
  assert.equal(ctx.snapshot().summaryThrough, 2);
  assert.equal(ctx.snapshot().summary, '当前摘要');
});

test('10. a matching request is accepted and clears exactly the pending queue', () => {
  const ctx = createDialogueContext({ now: base, maxWindowMs: 600_000, maxChars: 1, summaryEveryChars: 5 });
  ctx.push({ text: '待摘要的第一句。', at: base, utteranceId: 'ok-1' });
  ctx.push({ text: '待摘要的第二句。', at: base + 1_000, utteranceId: 'ok-2' });

  const request = ctx.snapshot();
  assert.equal(request.generation, 1);
  assert.equal(request.pendingVersion, 1);
  assert.equal(request.needsSummary, true);
  assert.equal(ctx.needsSummary(), true);

  const applied = ctx.applySummary('较早：第一句。', {
    through: request.pendingVersion,
    generation: request.generation,
  });
  assert.deepEqual(applied, {
    ok: true,
    applied: true,
    summary: '较早：第一句。',
    truncated: false,
    pendingChars: 0,
  });

  const after = ctx.snapshot();
  assert.equal(after.summary, '较早：第一句。');
  assert.equal(after.summaryChars, Array.from('较早：第一句。').length);
  assert.equal(after.pending.length, 0);
  assert.equal(after.pendingChars, 0);
  assert.equal(after.needsSummary, false);
  assert.equal(after.generation, 1, 'a successful summary never changes the buffer generation');
  assert.equal(after.stats.summaries, 1);
  assert.ok(ctx.render().includes('较早：第一句。'), 'the accepted summary is rendered');
});

test('11. markBoundary keeps the generation: a pre-boundary summary is accepted as "another segment" until new text rolls out', () => {
  // (a) No post-boundary roll-out: the pre-boundary request still matches and is labelled.
  const ctx = createDialogueContext({ now: base, maxWindowMs: 600_000, maxChars: 1 });
  ctx.push({ text: '旧视频第一句。', at: base, utteranceId: 'b-old-1' });
  ctx.push({ text: '旧视频第二句。', at: base + 1_000, utteranceId: 'b-old-2' });
  const preBoundary = ctx.snapshot();
  assert.equal(preBoundary.generation, 1);
  assert.equal(preBoundary.pendingVersion, 1);

  ctx.markBoundary({ reason: 'source-switch' });
  assert.equal(ctx.snapshot().generation, 1, 'a boundary does not reset the summary, so the generation stays');
  assert.equal(ctx.snapshot().pendingVersion, 1, 'nothing rolled out after the boundary');

  const landed = ctx.applySummary('旧视频的摘要。', {
    through: preBoundary.pendingVersion,
    generation: preBoundary.generation,
  });
  assert.equal(landed.ok, true, 'explicit rule: a pre-boundary summary is accepted while its version matches');
  assert.equal(ctx.snapshot().summaryFromEarlierSegment, true);
  assert.ok(ctx.render().includes('边界前，属于另一段'), 'the accepted pre-boundary summary is labelled');

  // (b) Post-boundary text rolls out: the pre-boundary request still describes a prefix, so it is
  // accepted but only removes its own covered entries; the post-boundary pending text survives.
  // Once a newer summary has covered the tail, replaying the old prefix is rejected.
  const other = createDialogueContext({ now: base, maxWindowMs: 600_000, maxChars: 1, summaryEveryChars: 100 });
  other.push({ text: '旧的一。', at: base, utteranceId: 'c-old-1' });
  other.push({ text: '旧的二。', at: base + 1_000, utteranceId: 'c-old-2' });
  const stale = other.snapshot();
  assert.equal(stale.pendingVersion, 1);

  other.markBoundary({ reason: 'source-switch' });
  other.push({ text: '新的一。', at: base + 2_000, utteranceId: 'c-new-1' });
  other.push({ text: '新的二。', at: base + 3_000, utteranceId: 'c-new-2' });
  const fresh = other.snapshot();
  assert.equal(fresh.generation, stale.generation, 'the generation is unchanged by the boundary');
  assert.equal(fresh.pendingSerial, 3, 'post-boundary text advanced the pending serial');
  assert.deepEqual(fresh.pending.map((item) => item.text), ['旧的一。', '旧的二。', '新的一。']);

  const prefix = other.applySummary('边界前的旧摘要', {
    through: stale.pendingVersion,
    generation: stale.generation,
  });
  assert.equal(prefix.ok, true, 'the pre-boundary request covers a valid prefix');
  const afterPrefix = other.snapshot();
  assert.equal(afterPrefix.summaryThrough, 1);
  assert.deepEqual(afterPrefix.pending.map((item) => item.text), ['旧的二。', '新的一。'], 'post-boundary text is not erased');
  assert.equal(afterPrefix.summaryFromEarlierSegment, true, 'the prefix summary still belongs to the earlier segment');

  const tail = other.applySummary('覆盖到边界后的新摘要', {
    through: fresh.pendingSerial,
    generation: fresh.generation,
  });
  assert.equal(tail.ok, true);
  assert.equal(other.snapshot().summaryThrough, 3);
  assert.deepEqual(other.snapshot().pending, []);
  assert.equal(other.snapshot().summary, '覆盖到边界后的新摘要');
  assert.equal(other.snapshot().summaryFromEarlierSegment, false);

  // The old prefix cannot now replace the newer coverage or bring back its removed pending text.
  const before = other.render();
  const replayed = other.applySummary('边界前的旧摘要（重放）', {
    through: stale.pendingVersion,
    generation: stale.generation,
  });
  assert.deepEqual(replayed, { ok: false, reason: 'stale-prefix' });
  assert.deepEqual(other.snapshot().pending, []);
  assert.equal(other.snapshot().summary, '覆盖到边界后的新摘要', 'the newer summary is not overwritten');
  assert.equal(other.render(), before);
  assert.ok(!other.render().includes('边界前的旧摘要（重放）'));
});

test('12. prefix coverage: through advances stepwise, later pending survives, coverage never goes backwards', () => {
  const ctx = createDialogueContext({ now: base, maxWindowMs: 600_000, maxChars: 1, summaryEveryChars: 100 });
  ctx.push({ text: '第一段。', at: base, utteranceId: 'p-1' });
  ctx.push({ text: '第二段。', at: base + 1_000, utteranceId: 'p-2' });
  ctx.push({ text: '第三段。', at: base + 2_000, utteranceId: 'p-3' });
  ctx.push({ text: '第四段。', at: base + 3_000, utteranceId: 'p-4' });

  let snapshot = ctx.snapshot();
  assert.equal(snapshot.pendingSerial, 3, 'three entries wait in the pending queue');
  assert.equal(snapshot.pendingVersion, snapshot.pendingSerial, 'pendingVersion stays as the alias');
  assert.equal(snapshot.summaryThrough, 0, 'nothing has been summarized yet');
  assert.deepEqual(snapshot.pending.map((item) => item.text), ['第一段。', '第二段。', '第三段。']);

  // through=1 covers only the first entry.
  const first = ctx.applySummary('摘要覆盖到第一段。', {
    through: 1,
    generation: snapshot.generation,
  });
  assert.equal(first.ok, true);
  snapshot = ctx.snapshot();
  assert.equal(snapshot.summaryThrough, 1);
  assert.deepEqual(snapshot.pending.map((item) => item.text), ['第二段。', '第三段。'], 'only the covered prefix was removed');
  assert.equal(snapshot.pendingChars, '第二段。'.length + '第三段。'.length);
  assert.equal(snapshot.summary, '摘要覆盖到第一段。');
  assert.ok(ctx.render().includes('摘要覆盖到第一段。'));
  assert.ok(ctx.render().includes('第二段。') && ctx.render().includes('第三段。'), 'uncovered pending still renders');

  // through=2 advances the same generation's prefix; the already-covered first entry is not replayed.
  const second = ctx.applySummary('摘要覆盖到第二段。', {
    through: 2,
    generation: snapshot.generation,
  });
  assert.equal(second.ok, true);
  snapshot = ctx.snapshot();
  assert.equal(snapshot.summaryThrough, 2, 'the prefix advanced');
  assert.deepEqual(snapshot.pending.map((item) => item.text), ['第三段。']);
  assert.equal(snapshot.summary, '摘要覆盖到第二段。');

  // A lower through would replace newer coverage with an older summary: rejected with no change.
  const before = ctx.render();
  const stale = ctx.applySummary('更旧但覆盖更少的摘要', {
    through: 0,
    generation: snapshot.generation,
  });
  assert.deepEqual(stale, { ok: false, reason: 'stale-prefix' });
  assert.equal(ctx.snapshot().summaryThrough, 2, 'the rejected request did not move coverage back');
  assert.equal(ctx.snapshot().summary, '摘要覆盖到第二段。', 'the rejected request did not overwrite the summary');
  assert.deepEqual(ctx.snapshot().pending, snapshot.pending, 'the pending queue is untouched');
  assert.equal(ctx.render(), before);

  // A through ahead of the current serial is not a prefix of anything: rejected untouched.
  const future = ctx.applySummary('未来的摘要', {
    through: snapshot.pendingSerial + 1,
    generation: snapshot.generation,
  });
  assert.equal(future.ok, false);
  assert.equal(future.reason, 'stale-version');
  assert.equal(ctx.snapshot().summaryThrough, 2);
  assert.deepEqual(ctx.snapshot().pending, snapshot.pending);
  assert.equal(ctx.render(), before);
});

test('13. continuous input: a summary in flight applies its prefix while new content keeps arriving', () => {
  const ctx = createDialogueContext({ now: base, maxWindowMs: 600_000, maxChars: 1, summaryEveryChars: 100 });
  let request = null;
  const pendingAfterApply = [];
  const summaries = [];

  for (let round = 1; round <= 5; round += 1) {
    // Two new utterances per round; the previous round's summary request is still "running".
    ctx.push({ text: `第${round}轮第一句。`, at: base + round * 10_000, utteranceId: `r${round}-1` });
    ctx.push({ text: `第${round}轮第二句。`, at: base + round * 10_000 + 1_000, utteranceId: `r${round}-2` });

    if (request !== null) {
      const applied = ctx.applySummary(`摘要推进到第${round - 1}轮。`, {
        through: request.pendingSerial,
        generation: request.generation,
      });
      assert.equal(applied.ok, true, `round ${round}: the in-flight summary still applies its prefix`);
      const after = ctx.snapshot();
      assert.equal(after.summaryThrough, request.pendingSerial, 'coverage advanced exactly to the captured prefix');
      assert.ok(
        after.pending.some((item) => item.text === `第${round}轮第一句。`),
        `round ${round}: text that arrived after the request is still pending`,
      );
      pendingAfterApply.push(after.pending.length);
    }
    request = ctx.snapshot();
    summaries.push(request.pendingSerial);
  }

  // The last request covers the tail, so the queue drains instead of retrying the same batch.
  const tail = ctx.applySummary('摘要推进到最后。', {
    through: request.pendingSerial,
    generation: request.generation,
  });
  assert.equal(tail.ok, true);
  assert.equal(tail.pendingChars, 0);
  const final = ctx.snapshot();
  assert.equal(final.pending.length, 0);
  assert.equal(final.summaryThrough, request.pendingSerial);
  assert.equal(final.pendingSerial, request.pendingSerial, 'no new text arrived after the last request');
  assert.deepEqual(summaries, [1, 3, 5, 7, 9], 'each round captured the current tail');
  assert.ok(Math.max(...pendingAfterApply) <= 2, 'the pending queue stays bounded while summarizing');

  // A summary that covered only the first batch cannot later overwrite the final one.
  const before = ctx.render();
  const replayed = ctx.applySummary('重放的第一批摘要', {
    through: 1,
    generation: request.generation,
  });
  assert.deepEqual(replayed, { ok: false, reason: 'stale-prefix' });
  assert.equal(ctx.snapshot().summary, '摘要推进到最后。');
  assert.equal(ctx.snapshot().summaryThrough, 9);
  assert.equal(ctx.render(), before);
});

test('14. 麦克风一段 + 回环一段：来源标签与分隔线，绝不拼成一句', () => {
  const ctx = createDialogueContext({ now: base });
  const first = ctx.push({ text: '我不舒服，', at: base + 1_000, utteranceId: 'mic-1' });
  assert.equal(first.source, 'mic');
  const second = ctx.push({ text: '你去拿药吧。', at: base + 2_000, source: 'loopback', utteranceId: 'loop-1' });
  assert.equal(second.source, 'loopback');
  assert.deepEqual(
    second.sourceBoundary,
    { from: 'mic', to: 'loopback', at: base + 2_000 },
    'a cross-source push reports the automatic boundary',
  );
  assert.equal(ctx.snapshot().segment, 1, 'the source switch opened a new segment');
  assert.equal(ctx.snapshot().openSentence, false, 'the microphone sentence cannot stay open across a source');

  const rendered = ctx.render();
  assert.ok(rendered.includes('[麦克风] 我不舒服，'), 'the microphone line keeps its source tag');
  assert.ok(rendered.includes('[系统声音] 你去拿药吧。'), 'the loopback line keeps its source tag');
  assert.ok(rendered.includes('来源切换：麦克风 → 系统声音'), 'the source divider names both sides');
  assert.ok(!rendered.includes('我不舒服，你去拿药吧。'), 'two captures are never spliced into one sentence');
  const micAt = rendered.indexOf('[麦克风]');
  const dividerAt = rendered.indexOf('来源切换：麦克风 → 系统声音');
  const loopAt = rendered.indexOf('[系统声音]');
  assert.ok(micAt >= 0 && dividerAt > micAt && loopAt > dividerAt, 'tag → divider → tag ordering');
  assert.deepEqual(
    ctx.snapshot().boundaries.map((boundary) => [boundary.reason, boundary.from, boundary.to]).pop(),
    ['source-switch', 'mic', 'loopback'],
    'the snapshot records who switched to whom',
  );

  // The old failure mode: both items already shared a segment number. The source check alone must
  // stop the join, so a snapshot built before the fix cannot silently merge the two captures.
  const sameSegment = ctx.render({
    recent: [
      { text: '我不舒服，', at: base + 1_000, source: 'mic', segment: 0 },
      { text: '你去拿药吧。', at: base + 2_000, source: 'loopback', segment: 0 },
    ],
    pending: [],
    summary: '',
    boundaries: [],
  });
  assert.ok(!sameSegment.includes('我不舒服，你去拿药吧。'), 'same segment number is not enough to join');
  assert.ok(sameSegment.includes('来源切换：麦克风 → 系统声音'));
});

test('15. 同一来源内未完句仍按原样合并（回归）', () => {
  const ctx = createDialogueContext({ now: base });
  ctx.push({ text: '钥匙在柜子里，', at: base + 1_000, utteranceId: 'mic-1', source: 'mic' });
  ctx.push({ text: '你去拿吧。', at: base + 2_000, utteranceId: 'mic-2', source: 'mic' });
  const rendered = ctx.render();
  assert.ok(rendered.includes('钥匙在柜子里，你去拿吧。'), 'one source still joins an unfinished sentence');
  assert.ok(!rendered.includes('来源切换'), 'no source divider without a source change');
  assert.equal(ctx.snapshot().segment, 0, 'no segment was opened by pushing the same source');
  assert.equal(ctx.snapshot().openSentence, false);
});

test('16. 同来源、不同设备（mic A → mic B）不视为跨来源', () => {
  const ctx = createDialogueContext({ now: base });
  const first = ctx.push({
    text: '钥匙在柜子里，', at: base + 1_000, utteranceId: 'micA-1', source: 'mic', device: '麦克风 A',
  });
  const second = ctx.push({
    text: '你去拿吧。', at: base + 2_000, utteranceId: 'micB-1', source: 'mic', device: '麦克风 B',
  });
  assert.equal(first.sourceBoundary, undefined, 'the first push has nothing to compare');
  assert.equal(second.sourceBoundary, undefined, 'another device of the same source is not a source change');
  assert.equal(ctx.snapshot().segment, 0, 'no source boundary segment was opened');
  const rendered = ctx.render();
  assert.ok(rendered.includes('钥匙在柜子里，你去拿吧。'), 'the sentence still merges inside one source');
  assert.ok(!rendered.includes('来源切换'), 'a device change alone writes no source divider');
  assert.deepEqual(ctx.snapshot().recent.map((entry) => entry.source), ['mic', 'mic']);
});

test('17. 摘要输入按来源分组：pendingBySource 保留两路；摘要标题带来源', () => {
  const ctx = createDialogueContext({ now: base, maxWindowMs: 600_000, maxChars: 1, summaryEveryChars: 100 });
  ctx.push({ text: '麦克风的旧话。', at: base, utteranceId: 'p-mic' });
  ctx.push({ text: '回环的旧话。', at: base + 1_000, source: 'loopback', utteranceId: 'p-loop' });
  ctx.push({ text: '麦克风的新话。', at: base + 2_000, utteranceId: 'p-mic-2' });

  const request = ctx.snapshot();
  assert.deepEqual(
    request.pendingBySource.map((group) => [group.source, group.label, group.text]),
    [
      ['mic', '麦克风', '麦克风的旧话。'],
      ['loopback', '系统声音', '回环的旧话。'],
    ],
    'the pending text a summary must read stays grouped by capture',
  );
  assert.equal(request.pendingBySource[0].chars, '麦克风的旧话。'.length);

  const applied = ctx.applySummary('较早：麦克风说不舒服，回环说拿药。', {
    through: request.pendingSerial,
    generation: request.generation,
  });
  assert.equal(applied.ok, true);
  const after = ctx.snapshot();
  assert.deepEqual(after.pendingBySource, [], 'the summarized text left the pending groups');
  assert.deepEqual(after.summarySources, ['mic', 'loopback'], 'the summary remembers both captures');
  const rendered = ctx.render();
  assert.ok(rendered.includes('来源：麦克风、系统声音'), 'the summary heading names its captures');
  assert.ok(rendered.includes('较早：麦克风说不舒服，回环说拿药。'));
  assert.ok(rendered.includes('[麦克风] 麦克风的新话。'), 'the remaining transcript keeps its tag');
});

test('18. render 中来源顺序与时间顺序一致（交错两路）', () => {
  const ctx = createDialogueContext({ now: base });
  ctx.push({ text: '麦一。', at: base + 1_000, utteranceId: 'm1' });
  ctx.push({ text: '回一。', at: base + 2_000, source: 'loopback', utteranceId: 'l1' });
  ctx.push({ text: '麦二。', at: base + 3_000, utteranceId: 'm2' });
  assert.deepEqual(ctx.snapshot().recent.map((entry) => entry.source), ['mic', 'loopback', 'mic']);
  assert.deepEqual(ctx.snapshot().recent.map((entry) => entry.at), [base + 1_000, base + 2_000, base + 3_000]);
  assert.deepEqual(ctx.snapshot().recent.map((entry) => entry.segment), [0, 1, 2], 'each switch opens a segment');

  const rendered = ctx.render();
  const order = [
    '[麦克风] 麦一。',
    '来源切换：麦克风 → 系统声音',
    '[系统声音] 回一。',
    '来源切换：系统声音 → 麦克风',
    '[麦克风] 麦二。',
  ].map((needle) => rendered.indexOf(needle));
  assert.ok(order.every((at) => at >= 0), `every line is rendered: ${order.join(',')}`);
  assert.deepEqual([...order].sort((left, right) => left - right), order, 'rendered order is time order');
});
