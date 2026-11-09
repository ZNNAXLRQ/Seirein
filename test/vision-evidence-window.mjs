/**
 * P-186 / P-187 阶段 1：有界画面证据窗口（纯模块，不截图、不调用模型）。
 *
 * 覆盖最小闭环第 ① 步「时间戳对齐 + 有界画面缓存」与第 ② 步的锁定原语：
 * 先按时间/字节淘汰，开口时锁住的帧在滚动缓存压力下仍然保留，释放后恢复普通淘汰。
 *
 * Run: node --test test/vision-evidence-window.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EVIDENCE_WINDOW_DEFAULTS, createEvidenceWindow, normalizeEvidenceFrame,
} from '../src/host/vision/evidence-window.js';

const NOW = 1_700_000_000_000;
const frame = (over = {}) => ({
  file: 'frame.png',
  bytes: 100,
  capturedAt: NOW,
  source: 'desktop',
  sourceEpoch: 1,
  kind: 'shot',
  width: 800,
  height: 450,
  ...over,
});

test('归一化：缺文件/字节/采集时间/来源一律拒绝，原因只给机器码', () => {
  const now = () => NOW;
  assert.equal(normalizeEvidenceFrame(null, { now }).ok, false);
  assert.equal(normalizeEvidenceFrame({}, { now }).reason, 'no-file');
  assert.equal(normalizeEvidenceFrame({ file: 'a.png' }, { now }).reason, 'no-bytes');
  assert.equal(normalizeEvidenceFrame({ file: 'a.png', bytes: 10 }, { now }).reason, 'no-capture-time');
  assert.equal(normalizeEvidenceFrame({ file: 'a.png', bytes: 10, capturedAt: NOW }, { now }).reason, 'no-source');

  const ok = normalizeEvidenceFrame(frame({ kind: 'unknown' }), { now });
  assert.equal(ok.ok, true);
  assert.equal(ok.frame.kind, 'frame', '未知 kind 退回 frame，不拒绝整帧');
  assert.equal(ok.frame.sourceEpoch, 1);
  assert.equal(ok.frame.processedAt, NOW, '处理时间与采集时间分开');
});

test('未来时间戳不可信：夹到当前时刻并留下 future 标记，不丢证据', () => {
  const normalized = normalizeEvidenceFrame(frame({ capturedAt: NOW + 30_000 }), { now: () => NOW });
  assert.equal(normalized.ok, true);
  assert.equal(normalized.frame.capturedAt, NOW);
  assert.equal(normalized.frame.future, true);
});

test('登记与查询：按采集时间排序、来源/代次可过滤、同一文件不重复登记', () => {
  const added = [];
  let clock = NOW + 5_000;
  const window = createEvidenceWindow({
    now: () => clock,
    onEvict: (entry, reason) => added.push([entry.id, reason]),
  });
  const later = window.add(frame({ file: 'b.png', capturedAt: NOW + 2_000 }));
  const earlier = window.add(frame({ file: 'a.png', capturedAt: NOW + 1_000, source: 'obs', sourceEpoch: 2 }));
  assert.equal(window.add(frame({ file: 'b.png', capturedAt: NOW + 2_000 })), null, '同一文件只登记一次');
  assert.ok(later.id.startsWith('ev-') && earlier.id.startsWith('ev-'));
  assert.notEqual(later.id, earlier.id);

  assert.deepEqual(window.between(NOW, NOW + 5_000).map((entry) => entry.file), ['a.png', 'b.png']);
  assert.deepEqual(window.between(NOW, NOW + 5_000, { source: 'obs' }).map((entry) => entry.file), ['a.png']);
  assert.deepEqual(window.between(NOW, NOW + 5_000, { source: 'obs', sourceEpoch: 2 }).length, 1);
  assert.equal(window.latest().file, 'b.png');
  assert.equal(window.latest({ source: 'obs' }).file, 'a.png');
  assert.equal(window.between(NOW + 3_000, NOW + 4_000).length, 0);

  const state = window.state();
  assert.equal(state.frames, 2);
  assert.equal(state.bytes, 200);
  assert.equal(state.newestAt, NOW + 2_000);
  assert.equal(state.stats.added, 2);
  assert.deepEqual(added, [], '还在窗口内，没有淘汰');
});

test('byId：按传入顺序返回副本、去重、缺失/非法跳过，最多 32 条', () => {
  let clock = NOW;
  const window = createEvidenceWindow({
    now: () => clock,
    maxFrames: 400,
    maxAgeMs: 60_000,
    minGapMs: 0,
  });
  const ids = [];
  for (let i = 0; i < 40; i += 1) {
    clock = NOW + i;
    const added = window.add(frame({ file: `frame-${i}.png`, capturedAt: clock }));
    assert.ok(added !== null);
    ids.push(added.id);
  }

  const reversed = window.byId(ids.slice().reverse());
  assert.equal(reversed.length, 32, '最多返回 32 条');
  assert.deepEqual(reversed.map((entry) => entry.id), ids.slice().reverse().slice(0, 32),
    '返回顺序与传入顺序一致');

  assert.deepEqual(window.byId([ids[0], ids[0], ids[1]]).map((entry) => entry.id), [ids[0], ids[1]],
    '重复 id 去重');
  assert.deepEqual(window.byId(ids[1]).map((entry) => entry.id), [ids[1]], '单个字符串也接受');
  assert.deepEqual(window.byId([ids[0], 'ev-missing', 42, null, {}, [], '', '   ']).map((entry) => entry.id),
    [ids[0]], '缺失/非法/空 id 跳过');
  assert.deepEqual(window.byId(''), [], '空字符串返回空数组');
  assert.deepEqual(window.byId(null), []);
  assert.deepEqual(window.byId(undefined), []);
  assert.deepEqual(window.byId([null, {}, [], 3]), []);

  const copy = window.byId([ids[0]])[0];
  copy.file = 'tampered.png';
  assert.equal(window.byId([ids[0]])[0].file, 'frame-0.png', '返回的是记录副本');
  assert.equal(copy.id, ids[0]);
  assert.equal(typeof copy.capturedAt, 'number');
  assert.equal(copy.source, 'desktop');
  assert.equal(copy.kind, 'shot');
  // byId 只读：窗口容量/代次/计数都不因查询改变。
  assert.equal(window.state().frames, 40);
  assert.equal(window.state().generation, 0);
  assert.deepEqual(window.state().recentIds, ids.slice(-5), 'status 只暴露最近 5 个 id');
});

test('byId：淘汰后查不到；查询本身不触发淘汰或事件', () => {
  let clock = NOW;
  const evicted = [];
  const events = [];
  const window = createEvidenceWindow({
    now: () => clock,
    maxFrames: 1,
    maxBytes: 10_000_000,
    maxAgeMs: 60_000,
    onEvict: (entry, reason) => evicted.push({ id: entry.id, reason }),
    emit: (type, payload) => events.push({ type, payload }),
  });
  const first = window.add(frame({ file: 'a.png', capturedAt: NOW }));
  clock = NOW + 1_000;
  const second = window.add(frame({ file: 'b.png', capturedAt: clock }));
  assert.deepEqual(evicted.map((entry) => entry.id), [first.id], '最旧的帧被容量淘汰');

  const evictedBefore = evicted.length;
  const eventsBefore = events.length;
  assert.deepEqual(window.byId([first.id]), [], '已淘汰的 id 返回空数组');
  assert.deepEqual(window.byId([first.id, second.id]).map((entry) => entry.id), [second.id],
    '同一查询里缺失 id 跳过，存在的仍返回');
  assert.equal(evicted.length, evictedBefore, 'byId 不触发淘汰');
  assert.equal(events.length, eventsBefore, 'byId 不发事件');
});

test('去重：同源同代次且落在最小间隔内的帧算同一次变化', () => {
  const window = createEvidenceWindow({ now: () => NOW, minGapMs: 300 });
  assert.ok(window.add(frame({ file: 'a.png', capturedAt: NOW })));
  assert.equal(window.add(frame({ file: 'b.png', capturedAt: NOW + 100 })), null, '间隔 < 300ms');
  assert.ok(window.add(frame({ file: 'c.png', capturedAt: NOW + 400 })));
  assert.equal(window.state().frames, 2);
  assert.equal(window.state().stats.deduped, 1);
});

test('按时长淘汰：超过窗口的未锁定帧被移除，并通知宿主删文件', () => {
  let clock = NOW;
  const evicted = [];
  const window = createEvidenceWindow({
    now: () => clock,
    maxAgeMs: 10_000,
    onEvict: (entry, reason) => evicted.push({ file: entry.file, reason }),
  });
  window.add(frame({ file: 'old.png', capturedAt: NOW }));
  clock = NOW + 11_000;
  window.add(frame({ file: 'new.png', capturedAt: clock }));
  assert.deepEqual(window.between(NOW, clock).map((entry) => entry.file), ['new.png']);
  assert.deepEqual(evicted, [{ file: 'old.png', reason: 'window' }]);
  assert.equal(window.state().frames, 1);
});

test('按字节淘汰：超限从最旧的开始，绝不无限增长', () => {
  let clock = NOW;
  const evicted = [];
  const window = createEvidenceWindow({
    now: () => clock,
    maxBytes: 150,
    maxAgeMs: 60_000,
    onEvict: (entry, reason) => evicted.push({ file: entry.file, reason }),
  });
  window.add(frame({ file: 'a.png', capturedAt: NOW }));
  clock += 1_000;
  window.add(frame({ file: 'b.png', capturedAt: clock }));
  clock += 1_000;
  window.add(frame({ file: 'c.png', capturedAt: clock }));
  assert.equal(window.state().frames, 1);
  assert.equal(window.state().bytes, 100);
  assert.deepEqual(evicted.map((item) => item.file), ['a.png', 'b.png']);
  assert.ok(evicted.every((item) => item.reason === 'window'));
  assert.ok(window.state().bytes <= 150, '缓存字节不超过上限');
});

test('锁定：开口时锁住的帧在滚动淘汰下保留，释放后恢复普通淘汰', () => {
  let clock = NOW;
  const window = createEvidenceWindow({
    now: () => clock,
    maxFrames: 2,
    maxBytes: 10_000_000,
    maxAgeMs: 60_000,
  });
  window.add(frame({ file: 'a.png', capturedAt: NOW }));
  clock = NOW + 1_000;
  window.add(frame({ file: 'b.png', capturedAt: clock }));
  clock = NOW + 2_000;

  const lock = window.lock({ at: NOW, source: 'desktop', sourceEpoch: 1, reason: 'speech-start' });
  assert.equal(lock.reason, 'speech-start');
  assert.ok(lock.from <= NOW, '窗口包含开口前的一段');

  window.add(frame({ file: 'c.png', capturedAt: clock }));
  const files = window.between(NOW, clock).map((entry) => entry.file);
  assert.deepEqual(files, ['a.png', 'c.png'], '锁住的 a.png 存活，未锁的 b.png 被淘汰');
  assert.equal(window.state().pinnedFrames, 1);

  // 解锁后继续超限：a.png 不再受保护，下一个进来时被淘汰。
  window.releaseLock(lock.id);
  clock = NOW + 3_000;
  window.add(frame({ file: 'd.png', capturedAt: clock }));
  assert.equal(window.between(NOW, clock).some((entry) => entry.file === 'a.png'), false);
});

test('锁定范围可随发言结束延长：发言期间到达的帧也进入锁窗', () => {
  let clock = NOW;
  const window = createEvidenceWindow({ now: () => clock, maxFrames: 2, maxBytes: 10_000_000 });
  window.add(frame({ file: 'speech-start.png', capturedAt: NOW }));
  const lock = window.lock({ at: NOW, source: 'desktop', sourceEpoch: 1 });
  clock = NOW + 3_000;
  window.add(frame({ file: 'mid-speech.png', capturedAt: clock }));
  clock = NOW + 5_000;
  window.extendLock(lock.id, { to: clock });
  window.add(frame({ file: 'speech-end.png', capturedAt: clock }));
  // 两帧上限：被锁定覆盖的两帧都留下，最旧的未锁定帧先走。
  const files = window.between(NOW, clock + 1).map((entry) => entry.file);
  assert.ok(files.includes('mid-speech.png'));
  assert.ok(files.includes('speech-end.png'));
  assert.equal(window.state().locks[0].to, clock);
});

test('锁定有寿命与数量上限：过期或超限后不再挡住淘汰', () => {
  let clock = NOW;
  const window = createEvidenceWindow({ now: () => clock, maxFrames: 1, lockTtlMs: 1_000, maxLocks: 2 });
  window.add(frame({ file: 'a.png', capturedAt: NOW }));
  const first = window.lock({ at: NOW, source: 'desktop', sourceEpoch: 1, reason: 'one' });
  const second = window.lock({ at: NOW, source: 'desktop', sourceEpoch: 1, reason: 'two' });
  const third = window.lock({ at: NOW, source: 'desktop', sourceEpoch: 1, reason: 'three' });
  assert.equal(window.state().locks.length, 2, '最多两把锁');
  assert.equal(window.state().locks.some((lock) => lock.id === first.id), false, '最旧的锁被挤出');

  clock = NOW + 2_000;
  assert.equal(window.state().locks.length, 0, '过期锁不再计入有效锁');
  window.add(frame({ file: 'b.png', capturedAt: clock }));
  assert.equal(window.between(NOW, clock).map((entry) => entry.file).join(','), 'b.png');
  assert.ok(second.id !== null && third.id !== null);
});

test('换代次与清空：清空后旧证据读不到，代次加一，宿主收到清理回调', () => {
  let cleared = null;
  const window = createEvidenceWindow({
    now: () => NOW,
    onClear: (reason) => { cleared = reason; },
  });
  window.add(frame());
  window.lock({ at: NOW, source: 'desktop', sourceEpoch: 1 });
  const result = window.clear('privacy');
  assert.deepEqual(result, { ok: true, frames: 1, bytes: 100, generation: 1 });
  assert.equal(cleared, 'privacy');
  assert.equal(window.state().frames, 0);
  assert.equal(window.state().locks.length, 0);
  assert.deepEqual(window.between(NOW - 1_000, NOW + 1_000), []);
});

test('默认参数：30 秒窗口、按字节与帧数双重上限，不是冻结值', () => {
  assert.equal(EVIDENCE_WINDOW_DEFAULTS.maxAgeMs, 30_000);
  assert.equal(EVIDENCE_WINDOW_DEFAULTS.maxBytes, 24 * 1024 * 1024);
  assert.ok(EVIDENCE_WINDOW_DEFAULTS.maxFrames > 0);
  assert.ok(EVIDENCE_WINDOW_DEFAULTS.lockTtlMs > EVIDENCE_WINDOW_DEFAULTS.maxAgeMs);
});
