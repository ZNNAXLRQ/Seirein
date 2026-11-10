/**
 * P0：时间完整性 + 语音窗口（不碰 typed/companion 门、不启动真实采集/模型）。
 *
 * 覆盖：
 *   1. 语音窗口优先 hearing 的 audioStartAt；缺字段才回退首个 partial 并标 fallback；
 *   2. 故事板保留 startedAt/endedAt/shotId/frameTimes，理解事件不再零宽；
 *   3. 事件时间离所引用证据很远时降为 low/uncertain（不强行认定）；
 *   4. 切镜后 8/16 秒窗口仍能按 shotId/窗口选到上一镜头事件；
 *   5. 旧镜头事件/摘要不被最新摘要覆盖；
 *   6. 无关闲聊判为 unrelated，不强行关联；
 *   7. 重复分析产出同一稳定事件 id 时合并去重；
 *   8. 现有 vision 测试另行运行（见任务验证命令）。
 *
 * 全部使用假时钟与注入的 framesBetween/audioBetween/analyze。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { createEvidenceWindow, normalizeEvidenceFrame } from '../src/host/vision/evidence-window.js';
import {
  advanceUnderstanding,
  parseUnderstanding,
} from '../src/host/vision/understanding.js';
import { createUnderstandingRuntime } from '../src/host/vision/understanding-runtime.js';
import { resolveSpeechWindow, speechReferenceOf } from '../src/host/index.js';

const BASE = 1_700_000_000_000;
const hostSource = readFileSync(new URL('../src/host/index.js', import.meta.url), 'utf8');

function frame(id, at, shotId, over = {}) {
  return {
    id,
    capturedAt: at,
    startedAt: at,
    endedAt: at,
    shotId,
    file: `C:\\shots\\${id}.png`,
    source: 'desktop',
    sourceEpoch: 1,
    ...over,
  };
}

function makeRuntime(clock, { frames, analyze }) {
  return createUnderstandingRuntime({
    now: () => clock.now,
    framesBetween: (from, to) => frames(from, to),
    audioBetween: () => [],
    analyze,
    maxFrames: 8,
    maxEventsShown: 3,
    maxAgeMs: 300_000,
  });
}

test('1. 语音窗口：audioStartAt 优先，转写完成时刻不参与；只有旧 hearing 才 fallback', () => {
  const audio = resolveSpeechWindow({
    startedAt: BASE + 500,
    endedAt: BASE + 3_000,
    partialStartedAt: BASE + 1_500,
    now: BASE + 30_000,
  });
  assert.deepEqual(audio, {
    startedAt: BASE + 500,
    endedAt: BASE + 3_000,
    timeSource: 'audio',
  }, '真实采集区间优先，not partial / not completion time');

  const lateFinish = resolveSpeechWindow({
    startedAt: BASE + 500,
    endedAt: BASE + 3_000,
    partialStartedAt: BASE + 1_500,
    now: BASE + 60_000,
  });
  assert.equal(lateFinish.endedAt, BASE + 3_000, '转写晚 57 秒也不把窗口推到 now');
  assert.equal(lateFinish.startedAt, BASE + 500);

  const fallback = resolveSpeechWindow({
    startedAt: null,
    endedAt: BASE + 3_000,
    partialStartedAt: BASE + 1_500,
    now: BASE + 4_000,
  });
  assert.deepEqual(fallback, {
    startedAt: BASE + 1_500,
    endedAt: BASE + 3_000,
    timeSource: 'fallback',
  }, '旧 hearing 无 audioStartAt：回退 partial 并明确标 fallback');

  // 接线：终稿把 hearing 的 audioStartAt 交给 finishSpeechEvidence，窗口由纯函数决定。
  assert.match(hostSource, /startedAt: event\.audioStartAt/, '终稿调用接 audioStartAt');
  assert.match(hostSource, /resolveSpeechWindow\(\{\s*startedAt,\s*endedAt,\s*partialStartedAt: pending\.startedAt/s,
    'finishSpeechEvidence 使用真实语音窗口纯函数');
  assert.match(hostSource, /alignment\.timeSource = speech\.timeSource/, 'fallback 来源写入对齐结果');
  assert.match(hostSource, /时间来源：fallback/, '回退来源在评论块里可见');
});

test('6. 无关闲聊判 unrelated；画面指代判 related', () => {
  assert.equal(speechReferenceOf('今天吃什么'), 'unrelated');
  assert.equal(speechReferenceOf('晚饭随便吧'), 'unrelated');
  assert.equal(speechReferenceOf('这个表情好搞笑'), 'related');
  assert.equal(speechReferenceOf('他刚才说的那句是什么意思'), 'related');
  assert.equal(speechReferenceOf('现在右边那个是什么'), 'related');
  // 接线：unrelated 不 attach，清掉同会话旧评论证据并留下机器可读原因。
  const finishAt = hostSource.indexOf('const finishSpeechEvidence =');
  assert.ok(finishAt > 0);
  const finishRegion = hostSource.slice(finishAt, finishAt + 5000);
  assert.match(finishRegion, /if \(speechReferenceOf\(text\) === 'unrelated'\)/);
  assert.match(finishRegion, /commentEvidence\.clear\(target\.sessionId\)/);
  assert.match(finishRegion, /vision\.comment\.unrelated/);
});

test('2. 故事板保留真实范围/shotId/frameTimes，事件时间不零宽', () => {
  const normalized = normalizeEvidenceFrame({
    file: 'sheet.png',
    bytes: 100,
    capturedAt: BASE,
    startedAt: BASE,
    endedAt: BASE + 5_000,
    shotId: 'shot-7',
    frameTimes: [BASE, BASE + 2_000, BASE + 5_000],
    kind: 'storyboard',
    source: 'desktop',
    sourceEpoch: 1,
  }, { now: () => BASE + 6_000 });
  assert.equal(normalized.ok, true);
  assert.equal(normalized.frame.startedAt, BASE);
  assert.equal(normalized.frame.endedAt, BASE + 5_000);
  assert.equal(normalized.frame.shotId, 'shot-7');
  assert.deepEqual(normalized.frame.frameTimes, [BASE, BASE + 2_000, BASE + 5_000]);

  const window = createEvidenceWindow({ now: () => BASE + 6_000 });
  const added = window.add({
    file: 'sheet.png',
    bytes: 100,
    capturedAt: BASE,
    startedAt: BASE,
    endedAt: BASE + 5_000,
    shotId: 'shot-7',
    kind: 'storyboard',
    source: 'desktop',
    sourceEpoch: 1,
  });
  assert.ok(added !== null);
  // 采集点 BASE 不在 [BASE+2s, BASE+3s]，但故事板真实覆盖该区间：必须命中。
  assert.equal(window.between(BASE + 2_000, BASE + 3_000).length, 1,
    'between 用可见范围相交，而不是采集点');

  const parsed = parseUnderstanding({
    raw: {
      sceneSummary: '人物在画面里转身',
      events: [{
        from: BASE + 2_000,
        to: BASE + 3_000,
        description: '人物转身',
        evidenceFrameIds: ['ev-1'],
        evidenceAudioIds: [],
        uncertainty: '',
      }],
    },
    interval: { from: BASE, to: BASE + 5_000 },
    frameIds: ['ev-1'],
    frames: window.byId(['ev-1']),
  });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.events.length, 1);
  assert.deepEqual([parsed.events[0].from, parsed.events[0].to], [BASE + 2_000, BASE + 3_000],
    '事件区间保持真实多秒范围，不压成零宽');
  assert.equal(parsed.events[0].shotId, 'shot-7');
  assert.equal(parsed.events[0].timeSource, 'evidence');
  assert.equal(parsed.events[0].timeConfidence, 'high');
  assert.equal(parsed.events[0].evidenceAvailable, true);
  assert.match(parsed.events[0].id, /^ue-[0-9a-f]{16}$/);
});

test('3. 事件时间不靠近所引用证据：保留但标 low/uncertain，不强行认定', () => {
  const parsed = parseUnderstanding({
    raw: {
      sceneSummary: '一个窗口',
      events: [{
        from: BASE + 8_000,
        to: BASE + 9_000,
        description: '窗口关闭',
        evidenceFrameIds: ['f0'],
        evidenceAudioIds: [],
        uncertainty: '',
      }],
    },
    interval: { from: BASE, to: BASE + 10_000 },
    frameIds: ['f0'],
    frames: [frame('f0', BASE, 'shot-a', { startedAt: BASE, endedAt: BASE + 1_000 })],
  });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.events.length, 1, '不静默曲解时间；降级而不是剪成证据时刻');
  assert.equal(parsed.events[0].timeSource, 'model');
  assert.equal(parsed.events[0].timeConfidence, 'low');
  assert.match(parsed.events[0].uncertainty, /时间与引用证据不一致/);
});

test('4. 切镜后 8/16 秒窗口仍能按 shotId 选到上一镜头事件', async () => {
  const clock = { now: BASE + 20_000 };
  let run = 0;
  const runtime = makeRuntime(clock, {
    frames: (from) => (from >= BASE + 10_000
      ? [frame('b1', BASE + 10_500, 'shot-b')]
      : [frame('a1', BASE + 1_000, 'shot-a')]),
    analyze: async () => {
      run += 1;
      if (run === 1) {
        return JSON.stringify({
          sceneSummary: '镜头A：人物站起',
          events: [{
            from: BASE + 1_000,
            to: BASE + 2_000,
            description: 'A站起',
            evidenceFrameIds: ['a1'],
            evidenceAudioIds: [],
            uncertainty: '',
          }],
          unresolved: '',
        });
      }
      return JSON.stringify({
        sceneSummary: '镜头B：人物坐下',
        events: [{
          from: BASE + 10_500,
          to: BASE + 11_000,
          description: 'B坐下',
          evidenceFrameIds: ['b1'],
          evidenceAudioIds: [],
          uncertainty: '',
        }],
        unresolved: '',
      });
    },
  });

  assert.equal((await runtime.runNow({ from: BASE, to: BASE + 5_000 })).ok, true);
  clock.now = BASE + 20_000;
  assert.equal((await runtime.runNow({ from: BASE + 10_000, to: BASE + 15_000 })).ok, true);
  assert.equal(runtime.current().events.length, 2);

  const rendered = runtime.render({
    from: BASE,
    to: BASE + 16_000,
    shotId: 'shot-a',
    retrospective: true,
  });
  assert.ok(rendered.includes('A站起'), `上一镜头事件应仍可选：${rendered}`);
  assert.equal(rendered.includes('B坐下'), false, '当前镜头事件不冒充上一镜头');
  assert.ok(rendered.includes('镜头A'), '摘要按镜头选，不是只看最新摘要');
});

test('5. 旧镜头事件/摘要不被最新摘要覆盖；窗口命中时仍可选', async () => {
  const clock = { now: BASE + 20_000 };
  let run = 0;
  const runtime = makeRuntime(clock, {
    frames: (from) => (from >= BASE + 10_000
      ? [frame('b1', BASE + 10_500, 'shot-b')]
      : [frame('a1', BASE + 1_000, 'shot-a')]),
    analyze: async () => {
      run += 1;
      return JSON.stringify({
        sceneSummary: run === 1 ? '镜头A摘要' : '镜头B摘要',
        events: [run === 1
          ? {
            from: BASE + 1_000,
            to: BASE + 2_000,
            description: 'A事件',
            evidenceFrameIds: ['a1'],
            evidenceAudioIds: [],
            uncertainty: '',
          }
          : {
            from: BASE + 10_500,
            to: BASE + 11_000,
            description: 'B事件',
            evidenceFrameIds: ['b1'],
            evidenceAudioIds: [],
            uncertainty: '',
          }],
        unresolved: '',
      });
    },
  });

  await runtime.runNow({ from: BASE, to: BASE + 5_000 });
  await runtime.runNow({ from: BASE + 10_000, to: BASE + 15_000 });

  const state = runtime.current();
  assert.equal(state.sceneSummary, '镜头B摘要', '最新摘要仍是最新');
  assert.equal(state.events.length, 2, '旧事件没有被最新摘要覆盖/淘汰');
  assert.equal(state.summaries.length, 2, '旧镜头摘要留在有界摘要环里');

  // 只按上一镜头窗口取，不依赖“最后 3 条”：A事件仍应被选中。
  const rendered = runtime.render({
    from: BASE - 500,
    to: BASE + 2_500,
    shotId: 'shot-a',
    retrospective: true,
  });
  assert.ok(rendered.includes('A事件'), rendered);
  assert.ok(rendered.includes('镜头A摘要'), rendered);
  assert.equal(rendered.includes('B事件'), false, rendered);
});

test('7. 重复分析：同描述/证据/镜头产出稳定 id，状态里只留一条并合并时间', () => {
  const evidence = [frame('f0', BASE, 'shot-a', { startedAt: BASE, endedAt: BASE + 5_000 })];
  const first = parseUnderstanding({
    raw: {
      sceneSummary: '重复分析',
      events: [{
        from: BASE + 1_000,
        to: BASE + 2_000,
        description: '人物挥手',
        evidenceFrameIds: ['f0'],
        evidenceAudioIds: [],
        uncertainty: '',
      }],
    },
    interval: { from: BASE, to: BASE + 5_000 },
    frameIds: ['f0'],
    frames: evidence,
  });
  const second = parseUnderstanding({
    raw: {
      sceneSummary: '重复分析',
      events: [{
        from: BASE + 1_500,
        to: BASE + 2_500,
        description: '人物挥手',
        evidenceFrameIds: ['f0'],
        evidenceAudioIds: [],
        uncertainty: '',
      }],
    },
    interval: { from: BASE, to: BASE + 5_000 },
    frameIds: ['f0'],
    frames: evidence,
  });
  assert.equal(first.events[0].id, second.events[0].id, '不含漂移的 from/to，id 稳定');

  let state = advanceUnderstanding({}, {
    sceneSummary: first.sceneSummary,
    events: first.events,
    interval: { from: BASE, to: BASE + 5_000 },
  });
  state = advanceUnderstanding(state, {
    sceneSummary: second.sceneSummary,
    events: second.events,
    interval: { from: BASE, to: BASE + 5_000 },
  });
  assert.equal(state.events.length, 1, '重复分析不追加第二条');
  assert.deepEqual([state.events[0].from, state.events[0].to], [BASE + 1_000, BASE + 2_500],
    '合并为覆盖两次分析的真实范围');
});

test('兼容：没有证据时间元数据的事件标 fallback，不因缺少元数据被误杀', () => {
  const parsed = parseUnderstanding({
    raw: {
      sceneSummary: '旧调用',
      events: [{
        from: BASE + 1_000,
        to: BASE + 2_000,
        description: '旧事件',
        evidenceFrameIds: ['f0'],
        evidenceAudioIds: [],
        uncertainty: '',
      }],
    },
    interval: { from: BASE, to: BASE + 5_000 },
    frameIds: ['f0'],
  });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.events[0].timeSource, 'fallback');
  assert.equal(parsed.events[0].timeConfidence, 'unknown');
});
