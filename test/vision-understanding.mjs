/**
 * P-187 阶段 3：连续视听理解的纯计算核心（输入组装 + 模型输出校验 + 有界状态）。
 *
 * 关键契约：事件必须至少引用一个真实存在的 frame/audio id；时间必须落在本次 interval 内（越界
 * **丢弃**，不夹取）；空描述丢弃；scene/description/unresolved 都有字符上限；输入畸形
 * 只返回 ok:false + reason，不抛错；覆盖缺口按采集时间计算；状态事件与覆盖区间有界。
 *
 * Run: node --test test/vision-understanding.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  UNDERSTANDING_DEFAULTS,
  advanceUnderstanding,
  buildUnderstandingInput,
  parseUnderstanding,
} from '../src/host/vision/understanding.js';

const BASE = 1_700_000_000_000;
const interval = (from = BASE, to = BASE + 10_000) => ({ from, to });
const frame = (index, over = {}) => ({
  id: `f${index}`,
  capturedAt: BASE + index * 1_000,
  source: 'desktop',
  sourceEpoch: 1,
  ...over,
});
const audio = (index, over = {}) => ({
  id: `a${index}`,
  audioStartAt: BASE + index * 1_000,
  audioEndAt: BASE + index * 1_000 + 800,
  text: `台词 ${index}`,
  ...over,
});
const event = (over = {}) => ({
  from: BASE + 1_000,
  to: BASE + 2_000,
  description: '两个人走进房间',
  evidenceFrameIds: [],
  evidenceAudioIds: [],
  uncertainty: '',
  ...over,
});

test('正常组装：帧按采集时间升序并受 maxFrames 限制，台词相交区间、按时间排序；证据齐全的事件保留', () => {
  const built = buildUnderstandingInput({
    interval: interval(),
    // 故意乱序，并混入区间外、重复 id 和畸形条目。
    frames: [
      frame(5), frame(0), frame(3), null, frame(1), frame(4), frame(2),
      { id: 'f0', capturedAt: BASE + 9_000 }, // 同一 id 只留最早一条
      { id: 'no-time' },
      frame(9_999), // capturedAt 超出 interval（10 s）
    ],
    audioLines: [
      audio(2), audio(0), audio(1),
      { id: 'old', audioStartAt: BASE - 5_000, audioEndAt: BASE - 4_000, text: '区间外' },
      { id: 'late', audioStartAt: BASE + 15_000, audioEndAt: BASE + 16_000, text: '区间外' },
      null,
      { id: 'no-time', audioStartAt: undefined, audioEndAt: BASE, text: '坏条目' },
    ],
    previousScene: '上一段：两个人在门口',
    focus: '他们在做什么',
  });

  assert.equal(built.ok, true);
  assert.equal(built.reason, 'ok');
  assert.deepEqual(built.interval, interval());
  assert.deepEqual(built.frameIds, ['f0', 'f1', 'f2', 'f3', 'f4', 'f5']);
  assert.deepEqual(built.frames.map((entry) => entry.id), built.frameIds);
  assert.deepEqual(built.frames[0], { id: 'f0', capturedAt: BASE }, '只输出 id 与采集时间');
  assert.deepEqual(built.audioLines.map((entry) => entry.id), ['a0', 'a1', 'a2'], '按 audioStartAt 升序');
  assert.deepEqual(built.audioLines.map((entry) => entry.text), ['台词 0', '台词 1', '台词 2']);
  assert.deepEqual(built.gaps, [], '1 s 间隔是紧密序列');
  assert.equal(built.previousScene, '上一段：两个人在门口');
  assert.equal(built.focus, '他们在做什么');
  // previousScene 只做上下文：不混进帧或台词证据。
  assert.equal(built.frameIds.includes('上一段：两个人在门口'), false);
  assert.equal(built.audioLines.some((entry) => entry.text.includes('上一段')), false);

  // 帧预算：超过上限时均匀取样，首尾一定保留。
  const sampled = buildUnderstandingInput({ interval: interval(), frames: [frame(0), frame(1), frame(2), frame(3), frame(4), frame(5)], maxFrames: 4 });
  assert.deepEqual(sampled.frameIds, ['f0', 'f2', 'f3', 'f5']);
  // 台词预算：超预算时保留最近几句（更早的连续性由 previousScene 承担）。
  const audioCapped = buildUnderstandingInput({ interval: interval(), frames: [frame(0)], audioLines: [audio(0), audio(1), audio(2)], maxAudioLines: 2 });
  assert.deepEqual(audioCapped.audioLines.map((entry) => entry.id), ['a1', 'a2']);

  const parsed = parseUnderstanding({
    raw: {
      sceneSummary: '两人进入房间并坐下',
      events: [event({ evidenceFrameIds: ['f0', 'f5'], evidenceAudioIds: ['a1'], uncertainty: 'low' })],
      unresolved: '看不清手里拿的是什么',
    },
    interval: built.interval,
    frameIds: built.frameIds,
    audioIds: built.audioLines.map((entry) => entry.id),
  });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.events.length, 1);
  assert.deepEqual(parsed.events[0].evidenceFrameIds, ['f0', 'f5']);
  assert.deepEqual(parsed.events[0].evidenceAudioIds, ['a1']);
  assert.equal(parsed.droppedEvents, 0);
  assert.deepEqual(parsed.unknownEvidenceIds, []);
});

test('模型输出两种形态：对象与 JSON 字符串（含 ```json 围栏）解析结果一致', () => {
  const raw = {
    sceneSummary: '两人坐在沙发上',
    events: [event({
      from: BASE + 2_000,
      to: BASE + 4_000,
      description: '其中一人把杯子放下',
      evidenceFrameIds: ['f2', 'f3'],
      evidenceAudioIds: ['a2'],
      uncertainty: 0.4,
    })],
    unresolved: '杯子放在桌子的哪一侧',
  };
  const fromObject = parseUnderstanding({
    raw,
    interval: interval(),
    frameIds: ['f0', 'f1', 'f2', 'f3'],
    audioIds: ['a0', 'a1', 'a2'],
  });
  const fromString = parseUnderstanding({
    raw: JSON.stringify(raw),
    interval: interval(),
    frameIds: ['f0', 'f1', 'f2', 'f3'],
    audioIds: ['a0', 'a1', 'a2'],
  });
  const fromFence = parseUnderstanding({
    raw: `\`\`\`json\n${JSON.stringify(raw, null, 2)}\n\`\`\``,
    interval: interval(),
    frameIds: ['f0', 'f1', 'f2', 'f3'],
    audioIds: ['a0', 'a1', 'a2'],
  });

  assert.equal(fromObject.ok, true);
  assert.deepEqual(fromString, fromObject);
  assert.deepEqual(fromFence, fromObject);
  assert.equal(fromObject.events[0].uncertainty, 0.4, '数字不确定性原样保留');
});

test('编造证据：引用不存在的 frameId/audioId 的事件整条丢弃，计数并保留有限的未知 id 诊断', () => {
  const parsed = parseUnderstanding({
    raw: {
      sceneSummary: '房间里的对话',
      events: [
        event({ description: '有效事件', evidenceFrameIds: ['f0'], evidenceAudioIds: ['a0'] }),
        event({ description: '编造帧', evidenceFrameIds: ['f-ghost'] }),
        event({ description: '编造台词', evidenceAudioIds: ['a-ghost'] }),
        event({ description: '把帧 id 当台词', evidenceAudioIds: ['f0'] }),
        event({ description: '非字符串证据', evidenceFrameIds: [42] }),
      ],
    },
    interval: interval(),
    frameIds: ['f0'],
    audioIds: ['a0'],
  });

  assert.equal(parsed.ok, true);
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.events[0].description, '有效事件');
  assert.equal(parsed.droppedEvents, 4);
  assert.deepEqual(parsed.unknownEvidenceIds, ['f-ghost', 'a-ghost', 'f0', '42']);

  // 未知 id 诊断最多 12 个，避免一次坏输出把计数撑爆。
  const many = parseUnderstanding({
    raw: {
      sceneSummary: '很多编造证据',
      events: Array.from({ length: 15 }, (_, index) => event({
        description: `编造 ${index}`,
        evidenceFrameIds: [`ghost-${index}`],
      })),
    },
    interval: interval(),
    frameIds: ['f0'],
    audioIds: [],
  });
  assert.equal(many.events.length, 0);
  assert.equal(many.droppedEvents, 15);
  assert.equal(many.unknownEvidenceIds.length, 12);
  assert.equal(many.unknownEvidenceIds[0], 'ghost-0');
  assert.equal(many.unknownEvidenceIds[11], 'ghost-11');
});

test('没有证据的事件只是推断：两个证据数组都为空或缺省 → 整条丢弃', () => {
  const parsed = parseUnderstanding({
    raw: {
      sceneSummary: '有人可能站起来了',
      events: [
        event({ description: '纯推断', evidenceFrameIds: [], evidenceAudioIds: [] }),
        event({ description: '字段缺省', evidenceFrameIds: undefined, evidenceAudioIds: undefined }),
        event({ description: '只有帧证据', evidenceFrameIds: ['f0'], evidenceAudioIds: [] }),
        event({ description: '只有台词证据', evidenceFrameIds: [], evidenceAudioIds: ['a0'] }),
      ],
      unresolved: '是否站起来还不确定',
    },
    interval: interval(),
    frameIds: ['f0'],
    audioIds: ['a0'],
  });

  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.events.map((entry) => entry.description), ['只有帧证据', '只有台词证据']);
  assert.equal(parsed.droppedEvents, 2);
  assert.deepEqual(parsed.unknownEvidenceIds, []);
  assert.equal(parsed.unresolved, '是否站起来还不确定', '纯推断应由 unresolved/sceneSummary 承载');
});

test('事件时间：越界一律丢弃（不夹到边界），from > to 也丢弃，边界值保留', () => {
  const parsed = parseUnderstanding({
    raw: {
      sceneSummary: '时间校验',
      events: [
        event({ description: '区间之前', from: BASE - 2_000, to: BASE - 1_000, evidenceFrameIds: ['f0'] }),
        event({ description: '区间之后', from: BASE + 10_500, to: BASE + 11_000, evidenceFrameIds: ['f0'] }),
        event({ description: '结束早于开始', from: BASE + 3_000, to: BASE + 2_000, evidenceFrameIds: ['f0'] }),
        event({ description: '时间不可用', from: 'soon', to: BASE + 3_000, evidenceFrameIds: ['f0'] }),
        event({ description: '正好覆盖整个区间', from: BASE, to: BASE + 10_000, evidenceFrameIds: ['f0'] }),
      ],
    },
    interval: interval(),
    frameIds: ['f0'],
    audioIds: ['a0'],
  });

  assert.equal(parsed.ok, true);
  assert.equal(parsed.droppedEvents, 4);
  assert.deepEqual(parsed.events.map((entry) => entry.description), ['正好覆盖整个区间']);
  assert.deepEqual([parsed.events[0].from, parsed.events[0].to], [BASE, BASE + 10_000], '边界不夹取、不改写');
});

test('文本上限：空/纯空白描述丢弃，描述、scene、unresolved 截到字符上限，事件条数受限', () => {
  const parsed = parseUnderstanding({
    raw: {
      sceneSummary: `  ${'场'.repeat(900)}  `,
      events: [
        event({ description: '   ', evidenceFrameIds: ['f0'] }),
        event({ description: 123, evidenceFrameIds: ['f0'] }),
        event({ description: '  有效描述  ', evidenceFrameIds: ['f0'] }),
        event({ description: '长'.repeat(300), evidenceFrameIds: ['f0'] }),
        event({ description: '😀'.repeat(300), evidenceFrameIds: ['f0'] }),
      ],
      unresolved: '未'.repeat(500),
    },
    interval: interval(),
    frameIds: ['f0'],
    audioIds: [],
  });

  assert.equal(parsed.ok, true);
  assert.equal(parsed.droppedEvents, 2);
  assert.equal(parsed.sceneSummary.length, UNDERSTANDING_DEFAULTS.maxSceneChars);
  assert.equal(parsed.unresolved.length, UNDERSTANDING_DEFAULTS.maxUnresolvedChars);
  assert.equal(parsed.events[0].description, '有效描述', '首尾空白先去掉');
  assert.equal(parsed.events[1].description.length, UNDERSTANDING_DEFAULTS.maxEventChars);
  assert.equal(Array.from(parsed.events[1].description).length, UNDERSTANDING_DEFAULTS.maxEventChars);
  assert.equal(Array.from(parsed.events[2].description).length, 240, '按 Unicode 码点截断，不劈开 emoji');

  const many = parseUnderstanding({
    raw: {
      sceneSummary: '事件很多',
      events: Array.from({ length: 12 }, (_, index) => event({
        description: `事件 ${index}`,
        evidenceFrameIds: ['f0'],
      })),
    },
    interval: interval(),
    frameIds: ['f0'],
    audioIds: [],
    maxEvents: 3,
  });
  assert.equal(many.events.length, 3);
  assert.equal(many.droppedEvents, 0, '超出保留预算的事件不计入“坏事件”');

  const defaultBudget = parseUnderstanding({
    raw: {
      sceneSummary: '默认预算',
      events: Array.from({ length: 12 }, (_, index) => event({
        description: `默认 ${index}`,
        evidenceFrameIds: ['f0'],
      })),
    },
    interval: interval(),
    frameIds: ['f0'],
  });
  assert.equal(defaultBudget.events.length, UNDERSTANDING_DEFAULTS.maxEvents);
});

test('reaction：可选反应角度保留并截到 80 字，空白/非字符串/缺失不写字段，advance 原样保留', () => {
  const parsed = parseUnderstanding({
    raw: {
      sceneSummary: '剧情出现反转',
      events: [
        event({ description: '反转', evidenceFrameIds: ['f0'], reaction: '  原来他早就知道  ' }),
        event({ description: '超长反应', evidenceFrameIds: ['f0'], reaction: '反'.repeat(120) }),
        event({ description: 'emoji 反应', evidenceFrameIds: ['f0'], reaction: '😀'.repeat(100) }),
        event({ description: '空白反应', evidenceFrameIds: ['f0'], reaction: '   ' }),
        event({ description: '非字符串反应', evidenceFrameIds: ['f0'], reaction: 42 }),
        event({ description: '没有反应', evidenceFrameIds: ['f0'] }),
      ],
    },
    interval: interval(),
    frameIds: ['f0'],
    audioIds: [],
  });

  assert.equal(parsed.ok, true);
  assert.equal(parsed.droppedEvents, 0, 'reaction 畸形只丢字段，不丢事件');
  assert.equal(parsed.events[0].reaction, '原来他早就知道', '先 trim');
  assert.equal(parsed.events[1].reaction.length, 80);
  assert.equal(Array.from(parsed.events[1].reaction).length, 80);
  assert.equal(Array.from(parsed.events[2].reaction).length, 80, '按 Unicode 码点截断，不劈开 emoji');
  for (const index of [3, 4, 5]) {
    assert.equal('reaction' in parsed.events[index], false, '空白/畸形/缺失都不写空串字段');
  }

  const state = advanceUnderstanding({}, { events: parsed.events });
  assert.equal(state.events[0].reaction, '原来他早就知道', '状态推进原样保留 reaction');
  assert.equal('reaction' in state.events[5], false);
  // 推进不修改传入的事件。
  state.events[0].reaction = '被测试改掉';
  assert.equal(parsed.events[0].reaction, '原来他早就知道');
});

test('畸形输入一律 ok:false + 机器可读 reason，且不抛错', () => {
  assert.deepEqual(
    [buildUnderstandingInput().ok, buildUnderstandingInput().reason],
    [false, 'no-interval'],
  );
  assert.equal(buildUnderstandingInput(null).reason, 'bad-input');
  assert.equal(buildUnderstandingInput({ interval: { from: BASE + 1, to: BASE } }).reason, 'no-interval');
  assert.equal(buildUnderstandingInput({ interval: interval(), frames: [] }).reason, 'no-frames');
  assert.equal(buildUnderstandingInput({ interval: interval(), frames: [frame(0, { capturedAt: BASE - 1 })] }).reason, 'no-frames');
  assert.equal(buildUnderstandingInput({ interval: interval(), frames: 'nope' }).reason, 'no-frames');

  assert.equal(parseUnderstanding().reason, 'no-interval');
  assert.equal(parseUnderstanding(null).reason, 'bad-input');
  assert.equal(
    parseUnderstanding({ raw: { sceneSummary: 'x' }, interval: { from: BASE + 1, to: BASE } }).reason,
    'no-interval',
  );
  assert.equal(parseUnderstanding({ raw: '{oops', interval: interval() }).reason, 'bad-json');
  assert.equal(parseUnderstanding({ raw: 'null', interval: interval() }).reason, 'not-object');
  assert.equal(parseUnderstanding({ raw: [], interval: interval() }).reason, 'not-object');
  assert.equal(parseUnderstanding({ raw: { events: [] }, interval: interval() }).reason, 'no-scene');
  assert.equal(parseUnderstanding({ raw: { sceneSummary: '  ' }, interval: interval() }).reason, 'no-scene');
  assert.equal(
    parseUnderstanding({ raw: { sceneSummary: 'ok', events: 'not-array' }, interval: interval() }).reason,
    'bad-events',
  );

  // 空状态推进也不抛错。
  const empty = advanceUnderstanding(null, null);
  assert.deepEqual(empty, { sceneSummary: '', events: [], unresolved: '', coverage: [] });
});

test('advanceUnderstanding：事件/覆盖有界环形，覆盖合并保留缺口，摘要与未解决项延续', () => {
  let state = {};
  for (let index = 0; index < 33; index += 1) {
    state = advanceUnderstanding(state, {
      sceneSummary: `场景 ${index}`,
      events: [event({ description: `事件 ${index}`, evidenceFrameIds: ['f0'] })],
      coverage: [{ from: BASE + index, to: BASE + index + 1 }],
    });
  }
  assert.equal(state.events.length, 32, '事件环形上限 32');
  assert.equal(state.events[0].description, '事件 1', '最旧的事件被淘汰');
  assert.equal(state.events[31].description, '事件 32');
  assert.equal(state.coverage.length, 1, '首尾相接的覆盖区间合并为一段');
  assert.deepEqual(state.coverage[0], { from: BASE, to: BASE + 33 });
  assert.equal('updatedAt' in state, false, '没有 opts.now 时不写 updatedAt');

  // 缺口被扣掉：区间 0..100 中间 30..50 没覆盖，状态里保留两段，不声称全程看懂。
  const first = advanceUnderstanding({}, {
    sceneSummary: '第一段',
    unresolved: '还是看不清',
    interval: { from: 0, to: 100 },
    gaps: [{ from: 30, to: 50 }],
  });
  assert.deepEqual(first.coverage, [{ from: 0, to: 30 }, { from: 50, to: 100 }]);
  assert.equal(first.unresolved, '还是看不清');

  const second = advanceUnderstanding(first, {
    sceneSummary: '',
    unresolved: '',
    interval: { from: 100, to: 200 },
    gaps: [],
  });
  assert.deepEqual(second.coverage, [{ from: 0, to: 30 }, { from: 50, to: 200 }], '相接的覆盖片段继续合并');
  assert.equal(second.sceneSummary, '第一段', '新摘要为空时沿用上一段，保住连续性');
  assert.equal(second.unresolved, '还是看不清');

  // 覆盖区间同样是环形：40 段互不相接，只保留最近 32 段。
  const bounded = advanceUnderstanding({}, {
    coverage: Array.from({ length: 40 }, (_, index) => ({ from: index * 10, to: index * 10 + 5 })),
  });
  assert.equal(bounded.coverage.length, 32);
  assert.equal(bounded.coverage[0].from, 80);
  assert.equal(bounded.coverage[31].from, 390);

  // 不修改传入对象。
  const previous = {
    sceneSummary: '旧',
    events: [event({ description: '旧事件', evidenceFrameIds: ['f0'] })],
    coverage: [],
  };
  advanceUnderstanding(previous, { events: [event({ description: '新事件', evidenceFrameIds: ['f0'] })] });
  assert.equal(previous.events.length, 1);
});

test('updatedAt 只在 opts.now 可解析时写入，不复用旧值', () => {
  const noNow = advanceUnderstanding(
    { updatedAt: BASE + 1, sceneSummary: '旧场景', events: [], coverage: [] },
    { sceneSummary: '新场景' },
  );
  assert.equal('updatedAt' in noNow, false, '没有 opts.now 时结果不带 updatedAt');
  assert.equal(noNow.sceneSummary, '新场景');

  const numeric = advanceUnderstanding({}, { sceneSummary: '新场景' }, { now: BASE + 5_000 });
  assert.equal(numeric.updatedAt, BASE + 5_000);

  const fromClock = advanceUnderstanding({}, { sceneSummary: '新场景' }, { now: () => BASE + 6_000 });
  assert.equal(fromClock.updatedAt, BASE + 6_000);

  const bad = advanceUnderstanding(
    { updatedAt: BASE + 1 },
    { sceneSummary: '新场景' },
    { now: 'soon' },
  );
  assert.equal('updatedAt' in bad, false, 'now 不可解析时也不回退旧值');

  const throwing = advanceUnderstanding(
    { updatedAt: BASE + 1 },
    { sceneSummary: '新场景' },
    { now: () => { throw new Error('clock failed'); } },
  );
  assert.equal('updatedAt' in throwing, false);
});

test('覆盖缺口：相邻选中帧间隔严格大于 2 s 才记缺口；首尾不补外部缺口', () => {
  const tight = buildUnderstandingInput({
    interval: interval(),
    frames: [frame(0), frame(1), frame(2)],
  });
  assert.deepEqual(tight.gaps, []);

  const exact = buildUnderstandingInput({
    interval: interval(),
    frames: [frame(0), { id: 'f2s', capturedAt: BASE + 2_000 }],
  });
  assert.deepEqual(exact.gaps, [], '恰好 2 s 不算缺口');

  const sparse = buildUnderstandingInput({
    interval: interval(),
    frames: [frame(0), frame(1), { id: 'f3501', capturedAt: BASE + 3_501 }],
  });
  assert.deepEqual(sparse.gaps, [{ from: BASE + 1_000, to: BASE + 3_501 }]);

  const single = buildUnderstandingInput({
    interval: interval(),
    frames: [{ id: 'only', capturedAt: BASE + 5_000 }],
  });
  assert.deepEqual(single.gaps, [], '只有一帧时没有“帧之间”的缺口');

  const sampled = buildUnderstandingInput({
    interval: interval(),
    frames: [frame(0), frame(1), frame(2), frame(3), frame(4), frame(5)],
    maxFrames: 2,
  });
  assert.deepEqual(sampled.frameIds, ['f0', 'f5']);
  assert.deepEqual(sampled.gaps, [{ from: BASE, to: BASE + 5_000 }], '缺口按实际选中的帧计算');
});
