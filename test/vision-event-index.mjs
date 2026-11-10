/**
 * P0 本地宏观事件索引 + 两级按需检索。
 *
 * 覆盖：
 *   1. 宏观理解成功后事件写入索引：事件时间/镜头/描述、原帧 cells、媒体 audio IDs；
 *   2. 去重：同一稳定 eventId 的重复分析合并时间/证据，不追加第二条；
 *   3. 当前/上一镜头、关键词、时间窗、frameIds 检索；无命中返回空与原因，不强行关联；
 *   4. 返回原帧引用（无路径）与前后关键帧；
 *   5. TTL / 容量 / 隐私 clear；status 只有计数与时间，不含正文/路径/id；
 *   6. 事件时间与证据不一致时保留不确定性；无法证明时间时标 unknown；
 *   7. 被动概览只排版本地检索结果，不触发第二次模型调用。
 *
 * Run: node --test test/vision-event-index.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import {
  EVENT_INDEX_DEFAULTS,
  createEventIndex,
  renderEventOverview,
} from '../src/host/vision/event-index.js';
import { createUnderstandingRuntime } from '../src/host/vision/understanding-runtime.js';

const BASE = 1_700_000_000_000;
const hostSource = readFileSync(new URL('../src/host/index.js', import.meta.url), 'utf8');

function frame(id, at, shotId = 'shot-a', over = {}) {
  return {
    id,
    capturedAt: at,
    startedAt: at,
    endedAt: at + 2_000,
    shotId,
    file: `C:\\shots\\${id}.png`,
    bytes: 100,
    source: 'desktop',
    sourceEpoch: 1,
    ...over,
  };
}

function cells(prefix, at, shotId = 'shot-a', count = 3) {
  return Array.from({ length: count }, (_, index) => ({
    frameId: `${prefix}-${index}`,
    capturedAt: at + index * 300,
    shotId,
    width: 1920,
    height: 1200,
    bytes: 50,
    file: `C:\\shots\\${prefix}-${index}.png`,
  }));
}

function event(id, from, to, shotId, description, over = {}) {
  return {
    id,
    from,
    to,
    description,
    evidenceFrameIds: [],
    evidenceAudioIds: [],
    uncertainty: '',
    shotId,
    ...over,
  };
}

function indexAt(clock, options = {}) {
  return createEventIndex({ now: () => clock.now, ...options });
}

test('1. ingest：事件引用原帧 cells 与媒体 audioIds，没有路径/正文大段', () => {
  const clock = { now: BASE + 2_000 };
  const index = indexAt(clock);
  const audioLines = [
    { id: 'media-1', audioStartAt: BASE + 500, audioEndAt: BASE + 1_200, text: '你看这个' },
  ];
  const result = index.ingest({
    events: [event('ue-test-0001', BASE + 500, BASE + 1_500, 'shot-a', '人物转身', {
      evidenceFrameIds: ['ev-1'],
      evidenceAudioIds: ['media-1'],
      uncertainty: '',
    })],
    frames: [frame('ev-1', BASE, 'shot-a', { cells: cells('frame-a', BASE) })],
    audioLines,
    shotId: 'shot-a',
    source: 'understanding',
    at: BASE + 2_000,
  });
  assert.equal(result.ok, true);
  assert.equal(result.added, 1);

  const entries = index.list();
  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.equal(entry.eventId, 'ue-test-0001');
  assert.equal(entry.startedAt, BASE + 500);
  assert.equal(entry.endedAt, BASE + 1_500);
  assert.equal(entry.shotId, 'shot-a');
  assert.equal(entry.description, '人物转身');
  assert.equal(entry.keyDialogue, '你看这个');
  assert.deepEqual(entry.frameIds, ['frame-a-0', 'frame-a-1', 'frame-a-2'],
    '事件引用的是独立原帧 cell，而不是故事板 entry id');
  assert.deepEqual(entry.audioIds, ['media-1']);
  assert.equal(entry.source, 'understanding');
  assert.deepEqual(entry.frames.map((ref) => ref.frameId), ['frame-a-0', 'frame-a-1', 'frame-a-2']);
  assert.ok(entry.frames.every((ref) => Number.isFinite(ref.capturedAt) && ref.shotId === 'shot-a'));
  assert.equal('file' in entry.frames[0], false);

  // 整个索引视图都不包含文件路径或 .png；frameId 可以对外，路径不行。
  const serialized = JSON.stringify(index.list());
  assert.equal(serialized.includes('C:\\'), false);
  assert.equal(serialized.includes('.png'), false);
  assert.equal(serialized.includes('shots'), false);

  const status = index.status();
  assert.equal(status.entries, 1);
  assert.equal(status.originalRefs, 3);
  assert.equal(status.audioRefs, 1);
  assert.equal(JSON.stringify(status).includes('C:\\'), false);
  assert.equal(JSON.stringify(status).includes('.png'), false);
  assert.equal(JSON.stringify(status).includes('frame-a-0'), false, 'status 不暴露 frameId');
});

test('2. 去重：同一 eventId 的重复分析合并时间/证据，不追加第二条', () => {
  const clock = { now: BASE + 3_000 };
  const index = indexAt(clock);
  const frames = [frame('ev-1', BASE, 'shot-a', { cells: cells('frame-a', BASE, 'shot-a', 2) })];
  index.ingest({
    events: [event('ue-merge-0001', BASE + 1_000, BASE + 2_000, 'shot-a', '人物挥手', {
      evidenceFrameIds: ['ev-1'],
      evidenceAudioIds: ['media-1'],
    })],
    frames,
    audioLines: [{ id: 'media-1', audioStartAt: BASE + 1_000, audioEndAt: BASE + 1_500, text: '挥手' }],
  });
  index.ingest({
    events: [event('ue-merge-0001', BASE + 500, BASE + 2_500, 'shot-a', '人物挥手', {
      evidenceFrameIds: ['ev-1'],
      evidenceAudioIds: ['media-1', 'media-2'],
      uncertainty: '推断：可能在打招呼',
    })],
    frames,
    audioLines: [
      { id: 'media-1', audioStartAt: BASE + 1_000, audioEndAt: BASE + 1_500, text: '挥手' },
      { id: 'media-2', audioStartAt: BASE + 2_000, audioEndAt: BASE + 2_500, text: '你好' },
    ],
  });

  const entries = index.list();
  assert.equal(entries.length, 1, '同一稳定 id 只留一条');
  assert.deepEqual([entries[0].startedAt, entries[0].endedAt], [BASE + 500, BASE + 2_500]);
  assert.deepEqual(entries[0].audioIds, ['media-1', 'media-2']);
  assert.match(entries[0].uncertainty, /打招呼/);
  assert.equal(index.status().merged, 1);
  assert.equal(index.status().added, 1);
});

test('3. 检索：当前窗口 + 关键词只命中相关事件；上一镜头需显式请求', () => {
  const clock = { now: BASE + 20_000 };
  const index = indexAt(clock);
  const frames = [
    frame('ev-a', BASE, 'shot-a', { cells: cells('frame-a', BASE, 'shot-a', 2) }),
    frame('ev-b', BASE + 10_000, 'shot-b', { cells: cells('frame-b', BASE + 10_000, 'shot-b', 2) }),
  ];
  index.ingest({
    events: [
      event('ue-a-0001', BASE + 500, BASE + 1_500, 'shot-a', '人物站起', { evidenceFrameIds: ['ev-a'] }),
      event('ue-b-0001', BASE + 10_500, BASE + 11_500, 'shot-b', '人物坐下', { evidenceFrameIds: ['ev-b'] }),
    ],
    frames,
    shotId: 'shot-b',
  });

  const current = index.search({
    from: BASE,
    to: BASE + 2_000,
    text: '站起',
  });
  assert.equal(current.reason, 'ok', current.message);
  assert.equal(current.events.length, 1);
  assert.equal(current.events[0].description, '人物站起');
  assert.equal(current.events[0].match.keyword, true);
  assert.equal(current.events[0].match.time, true);

  const noKeywordHit = index.search({ from: BASE, to: BASE + 2_000, text: '今天吃什么' });
  assert.equal(noKeywordHit.reason, 'no-keyword-match', '关键词没命中就不按时间硬关联');
  assert.equal(noKeywordHit.events.length, 0);
  assert.ok(noKeywordHit.message.includes('不按时间强行关联'));

  const noQuery = index.search({});
  assert.equal(noQuery.reason, 'no-query');
  assert.equal(noQuery.events.length, 0);

  // 显式上一镜头：当前镜头 shot-b，仍能按 shot-a 取到旧镜头事件。
  const previous = index.search({
    from: BASE,
    to: BASE + 20_000,
    shotId: 'shot-b',
    previousShot: true,
    retrospective: true,
  });
  assert.equal(previous.reason, 'ok', previous.message);
  assert.equal(previous.events.length, 1);
  assert.equal(previous.events[0].description, '人物站起');
  assert.equal(previous.events[0].shotId, 'shot-a');

  // 没有更早镜头时返回空并说明原因，不拿当前镜头替代。
  const lonely = indexAt(clock);
  lonely.ingest({
    events: [event('ue-only-0001', BASE, BASE + 1_000, 'shot-only', '唯一事件', { evidenceFrameIds: ['ev-only'] })],
    frames: [frame('ev-only', BASE, 'shot-only')],
    shotId: 'shot-only',
  });
  const missingPrevious = lonely.search({ shotId: 'shot-only', previousShot: true });
  assert.equal(missingPrevious.reason, 'no-previous-shot');
  assert.equal(missingPrevious.events.length, 0);

  const missingShot = index.search({ shotId: 'shot-none' });
  assert.equal(missingShot.reason, 'no-shot-match');
  assert.equal(missingShot.events.length, 0);
});

test('4. frameIds 检索、原帧前后关键帧与只读视图', () => {
  const clock = { now: BASE + 21_000 };
  const index = indexAt(clock);
  const frames = [
    frame('ev-before', BASE, 'shot-a', { cells: cells('frame-before', BASE, 'shot-a', 1) }),
    frame('ev-main', BASE + 10_000, 'shot-a', { cells: cells('frame-main', BASE + 10_000, 'shot-a', 3) }),
    frame('ev-after', BASE + 20_000, 'shot-a', { cells: cells('frame-after', BASE + 20_000, 'shot-a', 1) }),
  ];
  index.ingest({
    events: [
      event('ue-before-0001', BASE + 100, BASE + 500, 'shot-a', '起势', { evidenceFrameIds: ['ev-before'] }),
      event('ue-main-0001', BASE + 10_100, BASE + 10_800, 'shot-a', '挥手', { evidenceFrameIds: ['ev-main'] }),
      event('ue-after-0001', BASE + 20_100, BASE + 20_500, 'shot-a', '收势', { evidenceFrameIds: ['ev-after'] }),
    ],
    frames,
    shotId: 'shot-a',
  });

  const byFrame = index.search({ frameIds: ['frame-main-1'] });
  assert.equal(byFrame.reason, 'ok', byFrame.message);
  assert.equal(byFrame.events.length, 1);
  const hit = byFrame.events[0];
  assert.equal(hit.description, '挥手');
  assert.deepEqual(hit.frameIds, ['frame-main-0', 'frame-main-1', 'frame-main-2']);
  assert.deepEqual(hit.keyFrames.inside.map((ref) => ref.frameId),
    ['frame-main-0', 'frame-main-1', 'frame-main-2']);
  assert.equal(hit.keyFrames.before.frameId, 'frame-before-0', '返回前一个关键原帧');
  assert.equal(hit.keyFrames.after.frameId, 'frame-after-0', '返回后一个关键原帧');
  assert.equal(JSON.stringify(hit).includes('C:\\'), false);

  const noFrame = index.search({ frameIds: ['frame-not-exist'] });
  assert.equal(noFrame.reason, 'no-frame-match');
  assert.equal(noFrame.events.length, 0);
});

test('5. 时间不匹配/无法证明：保留事件但明确不确定；不伪造证据时间', () => {
  const clock = { now: BASE + 10_000 };
  const index = indexAt(clock);
  const frames = [frame('ev-1', BASE, 'shot-a', { startedAt: BASE, endedAt: BASE + 1_000 })];
  index.ingest({
    events: [event('ue-mismatch-0001', BASE + 8_000, BASE + 9_000, 'shot-a', '窗口关闭', {
      evidenceFrameIds: ['ev-1'],
    })],
    frames,
  });
  const mismatch = index.list()[0];
  assert.equal(mismatch.timeConfidence, 'low');
  assert.match(mismatch.uncertainty, /时间与引用证据不一致/);

  index.ingest({
    events: [event('ue-unknown-0001', BASE + 2_000, BASE + 3_000, 'shot-a', '旧事件', {
      evidenceFrameIds: ['missing-frame-id'],
    })],
    frames: [],
  });
  const unknown = index.list().find((entry) => entry.eventId === 'ue-unknown-0001');
  assert.ok(unknown !== undefined);
  assert.equal(unknown.timeConfidence, 'unknown');
  assert.match(unknown.uncertainty, /时间来源无法由证据证明/);
});

test('6. TTL / 容量 / 隐私 clear：状态只有计数与时间', () => {
  let clock = { now: BASE };
  const index = indexAt(clock, { ttlMs: 5_000, maxEvents: 2 });
  const add = (id, at, description) => index.ingest({
    events: [event(id, at, at + 500, 'shot-a', description, { evidenceFrameIds: [`ev-${id}`] })],
    frames: [frame(`ev-${id}`, at, 'shot-a')],
    shotId: 'shot-a',
    at,
  });
  add('ue-cap-0001', BASE, '最早');
  clock.now = BASE + 100;
  add('ue-cap-0002', BASE + 100, '中间');
  clock.now = BASE + 200;
  add('ue-cap-0003', BASE + 200, '最新');
  assert.equal(index.status().entries, 2, '容量上限');
  assert.equal(index.list().some((entry) => entry.description === '最早'), false);

  clock.now = BASE + 6_000;
  assert.equal(index.status().entries, 0, 'TTL 到期清空');
  assert.equal(index.list().length, 0);

  clock.now = BASE + 10_000;
  add('ue-privacy-0001', clock.now, '隐私前');
  assert.equal(index.status().entries, 1);
  const cleared = index.clear('privacy');
  assert.equal(cleared.ok, true);
  assert.equal(cleared.cleared, 1);
  assert.equal(index.status().entries, 0);
  assert.equal(index.status().cleared, 1);
  const statusText = JSON.stringify(index.status());
  assert.equal(statusText.includes('C:\\'), false);
  assert.equal(statusText.includes('.png'), false);
  assert.equal(statusText.includes('隐私前'), false, 'status 不含事件描述');
});

test('7. 宏观理解成功后自动写入索引；本地检索不再调用模型', async () => {
  let analyzeCalls = 0;
  const clock = { now: BASE + 5_000 };
  const eventIndex = createEventIndex({ now: () => clock.now });
  const runtime = createUnderstandingRuntime({
    now: () => clock.now,
    eventIndex,
    maxFrames: 8,
    maxAgeMs: 300_000,
    framesBetween: () => [frame('ev-1', BASE, 'shot-a', {
      startedAt: BASE,
      endedAt: BASE + 2_000,
      cells: cells('frame-run', BASE, 'shot-a', 2),
    })],
    audioBetween: () => [
      { id: 'media-1', audioStartAt: BASE + 500, audioEndAt: BASE + 1_200, text: '这就是关键台词' },
    ],
    analyze: async () => {
      analyzeCalls += 1;
      return {
        ok: true,
        reason: 'ok',
        images: 1,
        text: JSON.stringify({
          sceneSummary: '测试场景',
          events: [{
            from: BASE + 500,
            to: BASE + 1_500,
            description: '人物转身',
            evidenceFrameIds: ['ev-1'],
            evidenceAudioIds: ['media-1'],
            uncertainty: '',
          }],
          unresolved: '',
        }),
      };
    },
  });

  const run = await runtime.runNow({ from: BASE, to: BASE + 2_000, reason: 'sheet' });
  assert.equal(run.ok, true);
  assert.equal(analyzeCalls, 1);
  assert.equal(eventIndex.status().entries, 1);
  assert.equal(runtime.status().eventIndex.entries, 1);
  assert.equal(JSON.stringify(runtime.status().eventIndex).includes('frame'), false,
    'understanding status 的 index 投影不含 frame 字样/id');

  const found = eventIndex.search({ text: '关键台词' });
  assert.equal(found.reason, 'ok', found.message);
  assert.equal(found.events.length, 1);

  const local = runtime.searchEvents({ from: BASE, to: BASE + 2_000, text: '转身' });
  assert.equal(local.reason, 'ok', local.message);
  assert.equal(local.events.length, 1);
  assert.equal(local.events[0].description, '人物转身');
  assert.deepEqual(local.events[0].frameIds, ['frame-run-0', 'frame-run-1']);
  assert.equal(local.events[0].keyDialogue, '这就是关键台词');
  assert.equal(analyzeCalls, 1, '本地检索不得触发第二次模型调用');

  const empty = runtime.searchEvents({ from: BASE, to: BASE + 2_000, text: '今天吃什么' });
  assert.equal(empty.reason, 'no-keyword-match');
  assert.equal(empty.events.length, 0);
  assert.equal(analyzeCalls, 1);

  const overview = renderEventOverview(local, { maxEvents: 2, maxChars: 300 });
  assert.ok(overview.includes('【画面事件｜本地索引】'), overview);
  assert.ok(overview.includes('人物转身'), overview);
  assert.ok(overview.includes('这就是关键台词'), overview);
  assert.ok(overview.includes('frame-run-0'), overview);
  assert.equal(overview.includes('C:\\'), false);
  assert.equal(renderEventOverview({ ok: true, events: [] }), '');
  assert.ok(EVENT_INDEX_DEFAULTS.ttlMs > 0 && EVENT_INDEX_DEFAULTS.maxEvents > 0);
});

test('8. Host 接线：索引写入、被动概览、frameId 内部回查与隐私清理', () => {
  // 宏观理解运行时拿到同一个本地索引；成功后由 runtime 写入。
  assert.match(hostSource, /const eventIndex = createEventIndex\(\{ now: Date\.now \}\);/);
  assert.match(hostSource, /eventIndex,\s*\n\s*analyze:/);
  // 被动上下文只做本地检索并渲染概览，不触发模型。
  const overviewAt = hostSource.indexOf('const eventOverviewForContext =');
  assert.ok(overviewAt > 0);
  const overviewRegion = hostSource.slice(overviewAt, overviewAt + 1200);
  assert.match(overviewRegion, /eventIndex\.search\(\{/);
  assert.match(overviewRegion, /renderEventOverview\(result, \{ maxEvents: 2, maxChars: 260 \}\)/);
  assert.match(hostSource, /const overview = eventOverviewForContext\(focus\);/);
  // 细节回查入口：按 frameId 从原帧队列读图，返回 bytes 而不是路径。
  const detailAt = hostSource.indexOf('const visionFrameDetail = async');
  assert.ok(detailAt > 0, '提供内部 frameId 回查入口');
  const detailRegion = hostSource.slice(detailAt, detailAt + 900);
  assert.match(detailRegion, /const ref = originalFrameRefById\(frameId\);/);
  assert.match(detailRegion, /mediaType: 'image\/png'/);
  assert.match(detailRegion, /data,/);
  assert.equal(/file: ref\.file/.test(detailRegion), false, '回查结果不暴露文件路径');
  // 受限 status：只报当前可回查的原帧数量，不暴露 frameId/路径。
  assert.match(hostSource, /detailAvailable: evidenceWindow\.state\(\)\.cells/);
  // 隐私/切源/卸载都会清空索引，旧事件不能跨代次被检索。
  assert.match(hostSource, /eventIndex\.clear\('vision-invalidated'\)/);
  assert.match(hostSource, /eventIndex\.clear\('dispose'\)/);
  assert.match(hostSource, /queryText: proactiveClip\(text, 160\)/,
    '用户原话只保留有界长度供本轮本地检索');
});
