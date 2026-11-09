/**
 * P-187 阶段 1：连续媒体台词时间线（纯模块，不采音、不识别）。
 *
 * 关键契约：同一片段 partial→final 是**更新**而不是追加；终稿不会被迟到的部分结果降级；
 * 切源/重启的代次边界不允许跨代拼接；条数、字符与时长都有上限。
 *
 * Run: node --test test/hearing-media-timeline.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MEDIA_TIMELINE_DEFAULTS, createMediaTimeline,
} from '../src/host/hearing/media-timeline.js';

const NOW = 1_700_000_000_000;
const seg = (over = {}) => ({
  id: 'seg-1',
  audioStartAt: NOW,
  audioEndAt: NOW + 2_000,
  text: '你听见了吗',
  status: 'partial',
  sourceEpoch: 3,
  ...over,
});

test('同一片段 partial→final 原地更新：一条台词、终稿状态、音频区间取并集', () => {
  const timeline = createMediaTimeline({ now: () => NOW + 3_000 });
  assert.equal(timeline.upsert(seg()).status, 'partial');
  const final = timeline.upsert(seg({
    status: 'final',
    text: '你听见了吗？',
    audioEndAt: NOW + 2_500,
    audioStartAt: NOW + 300,
  }));
  assert.equal(final.status, 'final');
  assert.equal(final.text, '你听见了吗？');
  assert.equal(final.audioStartAt, NOW, '开始时间取更早的那次，不因更新丢开头');
  assert.equal(final.audioEndAt, NOW + 2_500);
  assert.equal(final.finalAt, NOW + 3_000);
  assert.equal(timeline.state().entries, 1, '同一 id 只有一条');
  assert.equal(timeline.state().finals, 1);
});

test('终稿不被迟到的 partial 降级；空终稿不擦掉已有台词', () => {
  const timeline = createMediaTimeline({ now: () => NOW });
  timeline.upsert(seg({ status: 'final', text: '这是最终一句' }));
  const late = timeline.upsert(seg({ status: 'partial', text: '这是' }));
  assert.equal(late.status, 'final');
  assert.equal(late.text, '这是最终一句', 'partial 不能把终稿改短');
  const empty = timeline.upsert(seg({ status: 'final', text: '', audioEndAt: NOW + 4_000 }));
  assert.equal(empty.text, '这是最终一句', '空文本不擦除已有转写');
  assert.equal(empty.audioEndAt, NOW + 4_000, '时间范围仍然更新');
});

test('不同 id 即使文本相同也是两段：角色真的重复同一句话要保留', () => {
  const timeline = createMediaTimeline({ now: () => NOW });
  timeline.upsert(seg({ id: 'a', text: '走吧' }));
  timeline.upsert(seg({ id: 'b', text: '走吧', audioStartAt: NOW + 5_000, audioEndAt: NOW + 6_000 }));
  assert.equal(timeline.state().entries, 2);
});

test('非法输入只拒绝不抛错：缺 id、缺时间、结束早于开始', () => {
  const timeline = createMediaTimeline({ now: () => NOW });
  assert.equal(timeline.upsert(null), null);
  assert.equal(timeline.upsert(seg({ id: '' })), null);
  assert.equal(timeline.upsert(seg({ audioStartAt: undefined })), null);
  assert.equal(timeline.upsert(seg({ audioStartAt: NOW + 10, audioEndAt: NOW })), null);
  assert.equal(timeline.state().entries, 0);
  assert.equal(timeline.state().stats.rejected, 4);
});

test('代次边界：切源/重启后旧代次台词整段作废，不与新代次拼接', () => {
  const timeline = createMediaTimeline({ now: () => NOW });
  timeline.upsert(seg({ id: 'old', sourceEpoch: 3 }));
  const result = timeline.setEpoch(4);
  assert.deepEqual([result.epoch, result.dropped], [4, 1]);
  assert.equal(timeline.state().entries, 0);
  // 新的 epoch 直接由 upsert 带进来，也走同一套作废逻辑。
  timeline.upsert(seg({ id: 'v4', sourceEpoch: 4 }));
  const switched = timeline.upsert(seg({ id: 'v5', sourceEpoch: 5, audioStartAt: NOW + 9_000, audioEndAt: NOW + 10_000 }));
  assert.equal(switched.sourceEpoch, 5);
  assert.equal(timeline.state().entries, 1, '旧代次台词被清掉');
  assert.equal(timeline.state().epoch, 5);
});

test('有界：条数超限从最旧淘汰，字符上限同样生效', () => {
  let clock = NOW;
  const timeline = createMediaTimeline({ now: () => clock, maxEntries: 2 });
  timeline.upsert(seg({ id: 'a', text: '一', audioStartAt: NOW, audioEndAt: NOW + 1_000 }));
  timeline.upsert(seg({ id: 'b', text: '二', audioStartAt: NOW + 2_000, audioEndAt: NOW + 3_000 }));
  timeline.upsert(seg({ id: 'c', text: '三', audioStartAt: NOW + 4_000, audioEndAt: NOW + 5_000 }));
  assert.equal(timeline.state().entries, 2);
  assert.deepEqual(timeline.between(NOW, NOW + 9_000).map((entry) => entry.id), ['b', 'c']);

  clock = NOW + 10_000;
  const small = createMediaTimeline({ now: () => clock, maxChars: 6, maxEntryChars: 800 });
  small.upsert(seg({ id: 'x', text: '四个字啊', audioStartAt: NOW, audioEndAt: NOW + 1_000 }));
  small.upsert(seg({ id: 'y', text: '五个字啊呀', audioStartAt: NOW + 2_000, audioEndAt: NOW + 3_000 }));
  assert.ok(small.state().chars <= 6, '总字符不超过上限');
  assert.deepEqual(small.between(NOW, clock).map((entry) => entry.id), ['y']);
});

test('按时长淘汰：超过保留窗口的台词不再属于「现在」', () => {
  let clock = NOW;
  const timeline = createMediaTimeline({ now: () => clock, maxAgeMs: 10_000 });
  timeline.upsert(seg({ id: 'old', audioStartAt: NOW, audioEndAt: NOW + 1_000 }));
  clock = NOW + 12_000;
  timeline.upsert(seg({ id: 'new', audioStartAt: clock, audioEndAt: clock + 1_000 }));
  assert.deepEqual(timeline.between(NOW, clock + 1_000).map((entry) => entry.id), ['new']);
});

test('按时间查询：区间相交即命中；nearest 优先包含该时刻的片段', () => {
  const timeline = createMediaTimeline({ now: () => NOW });
  timeline.upsert(seg({ id: 'a', audioStartAt: NOW, audioEndAt: NOW + 2_000 }));
  timeline.upsert(seg({ id: 'b', audioStartAt: NOW + 5_000, audioEndAt: NOW + 7_000 }));
  assert.deepEqual(timeline.between(NOW + 1_900, NOW + 2_100).map((entry) => entry.id), ['a'], '端点相交也算命中');
  assert.deepEqual(timeline.between(NOW + 3_000, NOW + 4_000), []);
  assert.equal(timeline.nearest(NOW + 6_000).id, 'b');
  assert.equal(timeline.nearest(NOW + 3_000).id, 'a', '落在间隙里取更近的一段');
  assert.equal(timeline.nearest(NaN), null);
});

test('清空：条目与索引一起释放，状态归零', () => {
  const timeline = createMediaTimeline({ now: () => NOW });
  timeline.upsert(seg({ id: 'a' }));
  const cleared = timeline.clear('privacy');
  assert.deepEqual(cleared, { ok: true, entries: 1 });
  assert.equal(timeline.state().entries, 0);
  assert.deepEqual(timeline.between(NOW, NOW + 9_000), []);
});

test('默认参数：5 分钟保留、条数/字符都有上限，不是冻结值', () => {
  assert.equal(MEDIA_TIMELINE_DEFAULTS.maxAgeMs, 5 * 60_000);
  assert.ok(MEDIA_TIMELINE_DEFAULTS.maxEntries > 0);
  assert.ok(MEDIA_TIMELINE_DEFAULTS.maxChars > 0);
  assert.ok(MEDIA_TIMELINE_DEFAULTS.maxEntryChars > 0);
});
