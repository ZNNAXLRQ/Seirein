/**
 * P-187 阶段 6 单元测试：`summarizeAudiovisual` 只做纯数字投影。
 *
 * 覆盖：正常汇总、缺失/畸形输入不抛错、输出不泄漏路径/正文/帧 id、已知/无效 uptime 的速率、
 * 所有计数都是数字。运行：node --test test/vision-audiovisual-metrics.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { summarizeAudiovisual } from '../src/host/vision/audiovisual-metrics.js';

/** 递归断言对象里的每个叶子都是数字（允许在明确列出的字段上为 null）。 */
function assertAllNumbers(value, label, path = '') {
  if (typeof value === 'number') {
    assert.ok(Number.isFinite(value), `${label}${path} 必须是有限数字`);
    return;
  }
  assert.equal(typeof value, 'object', `${label}${path} 应是数字或对象`);
  assert.notEqual(value, null, `${label}${path} 不应是 null`);
  for (const [key, child] of Object.entries(value)) {
    assertAllNumbers(child, label, `${path}.${key}`);
  }
}

test('正常汇总：证据/台词/评论/理解/主动计数与速率', () => {
  const at = 1_700_000_000_000;
  const summary = summarizeAudiovisual({
    evidence: { frames: 3, bytes: 4096, pinnedFrames: 1, recentIds: ['ev-1'], stats: { added: 3 } },
    media: { entries: 4, chars: 120, finals: 2, stats: { upserts: 4 } },
    comment: { sessions: 1, attached: 5, expired: 2, latestAt: at },
    understanding: {
      runs: 5,
      failures: 1,
      droppedEvents: 2,
      hasState: true,
      state: { events: 4, sceneChars: 300, unresolvedChars: 40 },
    },
    proactive: {
      enabled: true,
      pending: 2,
      counts: { spoken: 3, ignored: 1 },
      quietUntil: at + 5_000,
    },
    uptimeMs: 120_000,
    at,
  });

  assert.deepEqual(summary, {
    at,
    cache: { frames: 3, bytes: 4096, pinnedFrames: 1 },
    media: { entries: 4, chars: 120, finals: 2 },
    comment: { sessions: 1, attached: 5, expired: 2 },
    understanding: {
      runs: 5,
      failures: 1,
      droppedEvents: 2,
      eventCount: 4,
      sceneChars: 300,
      hasState: true,
    },
    proactive: { enabled: true, pending: 2, spoken: 3, ignored: 1, quiet: true },
    // 5 次 / 2 分钟 = 2.5；3 次 / (1/30 小时) = 90。
    rates: { understandingPerMinute: 2.5, proactivePerHour: 90 },
  });
});

test('兼容顶层 spoken/ignored/eventCount 与 state.hasState 形状', () => {
  const summary = summarizeAudiovisual({
    understanding: { runs: 1, eventCount: 7, sceneChars: 11, state: { hasState: true } },
    proactive: { enabled: false, pending: 1, spoken: 2, ignored: 3, quiet: true },
  });
  assert.equal(summary.understanding.eventCount, 7);
  assert.equal(summary.understanding.sceneChars, 11);
  assert.equal(summary.understanding.hasState, true);
  assert.equal(summary.proactive.spoken, 2);
  assert.equal(summary.proactive.ignored, 3);
  assert.equal(summary.proactive.quiet, true);
  assert.equal(summary.proactive.enabled, false);
});

test('缺失/畸形输入不抛错，计数给 0、速率给 null', () => {
  assert.doesNotThrow(() => summarizeAudiovisual());

  const empty = summarizeAudiovisual();
  assert.equal(empty.at, null);
  assert.deepEqual(empty.cache, { frames: 0, bytes: 0, pinnedFrames: 0 });
  assert.deepEqual(empty.media, { entries: 0, chars: 0, finals: 0 });
  assert.deepEqual(empty.comment, { sessions: 0, attached: 0, expired: 0 });
  assert.deepEqual(empty.understanding, {
    runs: 0,
    failures: 0,
    droppedEvents: 0,
    eventCount: 0,
    sceneChars: 0,
    hasState: false,
  });
  assert.deepEqual(empty.proactive, { enabled: false, pending: 0, spoken: 0, ignored: 0, quiet: false });
  assert.deepEqual(empty.rates, { understandingPerMinute: null, proactivePerHour: null });

  const malformed = summarizeAudiovisual({
    evidence: null,
    media: 'not-an-object',
    comment: [],
    understanding: {
      runs: '5',
      failures: -1,
      droppedEvents: Number.NaN,
      state: { events: '3', sceneChars: Infinity },
      hasState: 'yes',
    },
    proactive: {
      enabled: 'yes',
      pending: -2,
      counts: { spoken: -1, ignored: Number.POSITIVE_INFINITY },
      quietUntil: 'later',
    },
    uptimeMs: 0,
    at: 'now',
  });
  for (const group of [malformed.cache, malformed.media, malformed.comment]) {
    for (const value of Object.values(group)) {
      assert.equal(value, 0, '畸形计数必须是 0');
    }
  }
  const { hasState: _malformedHasState, ...malformedUnderstandingCounts } = malformed.understanding;
  for (const value of Object.values(malformedUnderstandingCounts)) {
    assert.equal(value, 0, '畸形计数必须是 0');
  }
  assert.equal(malformed.understanding.hasState, false);
  assert.deepEqual(malformed.proactive, { enabled: false, pending: 0, spoken: 0, ignored: 0, quiet: false });
  assert.equal(malformed.at, null);
  assert.deepEqual(malformed.rates, { understandingPerMinute: null, proactivePerHour: null });
});

test('输出不泄漏 sceneSummary、事件描述、路径或帧 id', () => {
  const summary = summarizeAudiovisual({
    evidence: {
      frames: 1,
      bytes: 10,
      pinnedFrames: 0,
      recentIds: ['ev-secret-99'],
      stats: { added: 1 },
      path: 'C:\\Users\\fixture\\cache\\evidence\\secret.png',
    },
    media: { entries: 1, chars: 4, finals: 1, text: '秘密台词', path: 'C:\\fixture\\audio.wav' },
    comment: { sessions: 1, attached: 1, expired: 0, latestAt: 123 },
    understanding: {
      runs: 1,
      failures: 0,
      droppedEvents: 0,
      state: {
        events: 2,
        sceneChars: 8,
        hasState: true,
        sceneSummary: '这是一段不该出现的场景正文',
      },
    },
    proactive: {
      enabled: true,
      pending: 1,
      counts: { spoken: 0, ignored: 0 },
      lastTopicId: 'understand:secret',
      lastTopic: '不该出现的主题正文',
    },
    uptimeMs: 60_000,
  });

  const serialized = JSON.stringify(summary);
  for (const secret of [
    'ev-secret-99',
    'C:\\Users\\fixture',
    'cache\\evidence',
    'secret.png',
    '秘密台词',
    'fixture\\audio.wav',
    '场景正文',
    'understand:secret',
    '不该出现的主题正文',
  ]) {
    assert.equal(serialized.includes(secret), false, `不得泄漏 ${secret}`);
  }
  assert.equal(Object.hasOwn(summary, 'sceneSummary'), false);
  assert.equal(Object.hasOwn(summary, 'recentIds'), false);
  assert.equal(serialized.includes('"id"'), false);
});

test('速率：uptime 已知才算，为 0/负数/畸形给 null；0 次调用给 0', () => {
  const base = {
    understanding: { runs: 3 },
    proactive: { counts: { spoken: 2 } },
  };
  assert.deepEqual(summarizeAudiovisual({ ...base, uptimeMs: 60_000 }).rates, {
    understandingPerMinute: 3,
    proactivePerHour: 120,
  });

  const zeroRuns = summarizeAudiovisual({
    understanding: { runs: 0 },
    proactive: { counts: { spoken: 0 } },
    uptimeMs: 60_000,
  });
  assert.deepEqual(zeroRuns.rates, { understandingPerMinute: 0, proactivePerHour: 0 });

  for (const uptimeMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '60000', null, undefined]) {
    assert.deepEqual(
      summarizeAudiovisual({ ...base, uptimeMs }).rates,
      { understandingPerMinute: null, proactivePerHour: null },
      `uptimeMs=${String(uptimeMs)} 时速率应为 null`,
    );
  }
});

test('四舍五入：每分钟保留 1 位小数，每小时取整', () => {
  // 1 次 / 50 秒 = 1.2 次/分；同一窗口 1 次 / 50 秒 = 72 次/小时。
  const summary = summarizeAudiovisual({
    understanding: { runs: 1 },
    proactive: { counts: { spoken: 1 } },
    uptimeMs: 50_000,
  });
  assert.equal(summary.rates.understandingPerMinute, 1.2);
  assert.equal(summary.rates.proactivePerHour, 72);

  const oneMinute = summarizeAudiovisual({
    understanding: { runs: 11 },
    proactive: { counts: { spoken: 1 } },
    uptimeMs: 7 * 60_000,
  });
  assert.equal(oneMinute.rates.understandingPerMinute, 1.6, '11/7 四舍五入到 1.6');
  assert.equal(oneMinute.rates.proactivePerHour, 9, '1/(7/60) ≈ 8.57 取整为 9');
});

test('计数字段全为数字，布尔字段全为布尔', () => {
  const summary = summarizeAudiovisual({
    evidence: { frames: 1, bytes: 2, pinnedFrames: 0 },
    media: { entries: 1, chars: 2, finals: 1 },
    comment: { sessions: 1, attached: 1, expired: 0 },
    understanding: { runs: 1, failures: 0, droppedEvents: 0, state: { events: 1, sceneChars: 2 } },
    proactive: { enabled: true, pending: 0, counts: { spoken: 1, ignored: 0 } },
    uptimeMs: 60_000,
  });

  for (const group of ['cache', 'media', 'comment']) {
    for (const [key, value] of Object.entries(summary[group])) {
      assert.equal(typeof value, 'number', `${group}.${key} 应是数字`);
      assert.ok(Number.isFinite(value), `${group}.${key} 应是有限数字`);
    }
  }
  const { hasState: _hasStateCount, ...understandingNumbers } = summary.understanding;
  for (const [key, value] of Object.entries(understandingNumbers)) {
    assert.equal(typeof value, 'number', `understanding.${key} 应是数字`);
    assert.ok(Number.isFinite(value), `understanding.${key} 应是有限数字`);
  }
  for (const key of ['pending', 'spoken', 'ignored']) {
    assert.equal(typeof summary.proactive[key], 'number', `proactive.${key} 应是数字`);
  }
  for (const key of ['enabled', 'quiet']) {
    assert.equal(typeof summary.proactive[key], 'boolean', `proactive.${key} 应是布尔`);
  }
  assert.equal(typeof summary.understanding.hasState, 'boolean');
  const { hasState: _hasState, ...understandingCounts } = summary.understanding;
  assertAllNumbers(
    { ...summary.cache, ...summary.media, ...summary.comment, ...understandingCounts },
    'counts',
  );
});
