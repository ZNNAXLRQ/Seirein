/**
 * P-187 后续修复：
 *
 * A. 被动 understanding block 不再只属于 voice lane：同一陪伴会话里的文字轮也能看到已经
 *    理解出的画面。recent / nonverbal / audiovisual 仍是 voice-only；understanding 仍要求
 *    工作区、companion、vision 开启、非隐私、非 subagent，并且有真实状态。
 *
 * B. 失败诊断：analyzer 的 `{ok:false,reason,errorCode}` 把 errorCode 透传到
 *    `understanding-run` 与 status；没有 errorCode 时保持空。bad-json 只记录 rawChars/rawHash，
 *    绝不把原始文本/画面内容带进事件或 status。JSON 外少量说明/围栏现在可以容错解析。
 *
 * 全部用假时钟/假 analyzer；不碰屏幕、不发模型请求。
 *
 * Run: node --test test/vision-understanding-typed.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createUnderstandingMaterialGate,
  understandingBlockAllowed,
  understandingEphemeralBlock,
} from '../src/host/index.js';
import { assembleLayerPlan } from '../src/host/memory/context-layers.js';
import { parseUnderstanding } from '../src/host/vision/understanding.js';
import { createUnderstandingRuntime } from '../src/host/vision/understanding-runtime.js';

const FRAME = { id: 'frame-a', capturedAt: 1_000_000, file: 'C:\\shots\\frame-a.png' };
const WINDOW = { from: 1_000_000, to: 1_020_000 };

const ELIGIBLE = Object.freeze({
  inScope: true,
  companion: true,
  typedCompanion: true,
  subagent: false,
  visionEnabled: true,
  privacy: false,
});

function sceneJson(description = '窗口出现') {
  return JSON.stringify({
    sceneSummary: '桌面上有一个打开的窗口',
    events: [{
      from: 1_000_000,
      to: 1_001_000,
      description,
      evidenceFrameIds: ['frame-a'],
      evidenceAudioIds: [],
    }],
    unresolved: '',
  });
}

function makeRuntime(analyze, events = []) {
  return createUnderstandingRuntime({
    analyze,
    framesBetween: async () => [FRAME],
    audioBetween: async () => [],
    emit: (event) => events.push(event),
    now: () => 1_000_500,
    setTimer: (fn) => ({ fn, unref() {} }),
    clearTimer: () => {},
    minIntervalMs: 15_000,
  });
}

// ---------------------------------------------------------------------------
// A. typed companion gate + budget
// ---------------------------------------------------------------------------

test('A1. typed/voice 陪伴轮都注入 understanding；non-companion/subagent/vision-off/privacy/无状态不注入', () => {
  assert.equal(understandingBlockAllowed({ ...ELIGIBLE, lane: 'voice', hasState: true }), true);
  assert.equal(understandingBlockAllowed({ ...ELIGIBLE, lane: 'typed', hasState: true }), true,
    '文字陪伴轮（含普通主 GUI typed）也拿到后台理解');
  assert.equal(understandingBlockAllowed({ ...ELIGIBLE, lane: null, hasState: true }), true,
    '不按 lane 限定的渲染路径仍可用');

  // 身份按 lane 分开：voice 只认当天陪伴会话，typed 只认 typed companion；
  // 其中一个为真不能借给另一个 lane。
  assert.equal(understandingBlockAllowed({
    ...ELIGIBLE, lane: 'voice', companion: false, typedCompanion: true, hasState: true,
  }), false, 'voice lane 不接受 typed-only 身份');
  assert.equal(understandingBlockAllowed({
    ...ELIGIBLE, lane: 'typed', companion: true, typedCompanion: false, hasState: true,
  }), false, 'typed lane 不接受 voice-only 身份');

  // lane 仍受限制：fastpath 与未知 lane 不走这个块。
  assert.equal(understandingBlockAllowed({ ...ELIGIBLE, lane: 'fastpath', hasState: true }), false);
  assert.equal(understandingBlockAllowed({ ...ELIGIBLE, lane: 'subagent', hasState: true }), false);

  const denied = [
    ['outside workspace', { inScope: false }],
    ['not companion', { companion: false, typedCompanion: false }],
    ['subagent', { subagent: true }],
    ['vision off', { visionEnabled: false }],
    ['privacy', { privacy: true }],
    ['no state', { hasState: false }],
  ];
  for (const [label, override] of denied) {
    assert.equal(
      understandingBlockAllowed({ ...ELIGIBLE, lane: 'typed', hasState: true, ...override }),
      false,
      label,
    );
  }

  const block = understandingEphemeralBlock('【场景】桌面上有一个打开的窗口', {
    ...ELIGIBLE, lane: 'typed',
  });
  assert.deepEqual(block, {
    name: 'understanding',
    text: '【场景】桌面上有一个打开的窗口',
    separator: '\n',
    keep: 'head',
  }, 'typed 陪伴轮有状态时生成真实 ephemeral block');
  assert.equal(
    understandingEphemeralBlock('', { ...ELIGIBLE, lane: 'typed' }),
    null,
    '无状态不产生空块',
  );
});

test('A2. 文字轮 understanding 仍走同一份 ephemeral 预算：额度不足时整块被裁掉', () => {
  const text = '【场景】桌面上有一个打开的窗口';
  const block = understandingEphemeralBlock(text, { ...ELIGIBLE, lane: 'typed' });
  assert.ok(block !== null);
  const layers = {
    persona: { items: ['人设'] },
    fixed: { items: ['固定'] },
    recent: { text: '', headingLines: 1, keep: 'tail' },
    ephemeralBlocks: [
      { name: 'environment', text: '环境事实', separator: '\n', keep: 'head' },
      block,
    ],
  };

  const roomy = assembleLayerPlan({
    lane: 'typed',
    layers,
    budget: { lane: 'typed', persona: 100, fixed: 100, memory: 0, recent: 0, ephemeral: 200, totalChars: 500 },
  });
  assert.equal(roomy.temporary.understanding, text, '预算足够时文字轮保留 understanding');
  assert.ok(roomy.blocks.ephemeral.includes(text));

  const tight = assembleLayerPlan({
    lane: 'typed',
    layers,
    budget: { lane: 'typed', persona: 100, fixed: 100, memory: 0, recent: 0, ephemeral: 6, totalChars: 500 },
  });
  assert.equal(tight.temporary.understanding, '', '额度不足时 understanding 被裁成空串');
  assert.ok(tight.layers.ephemeral.dropped > 0, '裁剪计入 ephemeral dropped，可观测');

  // 同一材料签名只触发一次：typed 轮没有绕开已有的材料去重门。
  const signature = 'storyboard:2026-11-10T12:00:00.000Z:sheet.png:4096:6';
  const gate = createUnderstandingMaterialGate();
  assert.equal(gate.accept(signature, 1_000_000), true);
  assert.equal(gate.accept(signature, 1_000_000), false, '重复投递的同一份材料不会再次注入');
  assert.equal(gate.accept('', 1_000_001), true, '无签名的评论路径仍放行');
});

// ---------------------------------------------------------------------------
// B. failure diagnostics: errorCode / rawChars / rawHash
// ---------------------------------------------------------------------------

test('B1. analyzer 失败带 errorCode：understanding-run 与 status 透传机器码', async () => {
  const events = [];
  const runtime = makeRuntime(async () => ({
    ok: false,
    text: '',
    reason: 'stream-error',
    errorCode: 'rate_limited',
    images: 2,
  }), events);

  const result = await runtime.runNow({ ...WINDOW, reason: 'change' });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'stream-error');
  assert.equal(result.errorCode, 'rate_limited');
  const outcome = events.find((event) => event.type === 'understanding-run');
  assert.ok(outcome, '失败必须留下 understanding-run 诊断');
  assert.equal(outcome.reason, 'stream-error');
  assert.equal(outcome.errorCode, 'rate_limited');
  assert.equal(outcome.rawChars, 0);
  assert.equal(outcome.rawHash, '');
  assert.equal(JSON.stringify(outcome).includes('frame-a'), false, '事件不带帧 id');
  assert.equal(JSON.stringify(outcome).includes('C:\\'), false, '事件不带路径');

  const status = runtime.status();
  assert.equal(status.lastReasonCode, 'stream-error');
  assert.equal(status.lastErrorCode, 'rate_limited');
  assert.equal(status.rawChars, 0);
  assert.equal(status.rawHash, '');
});

test('B2. 没有 errorCode 时保持空；失败不阻塞下一次分析', async () => {
  const events = [];
  let fail = true;
  const runtime = makeRuntime(async (input) => (fail
    ? { ok: false, text: '', reason: 'stream-error', images: 0 }
    : { ok: true, text: sceneJson(), reason: 'ok', images: 1 }), events);

  const failed = await runtime.runNow({ ...WINDOW, reason: 'change' });
  assert.equal(failed.ok, false);
  assert.equal(failed.errorCode, '');
  assert.equal(runtime.status().lastErrorCode, '', '没有 errorCode 时 status 为空串');
  assert.equal(runtime.status().lastReasonCode, 'stream-error');

  // 一次失败不会占住单在途锁，也不会阻止后续采集触发的分析。
  fail = false;
  const recovered = await runtime.runNow({ ...WINDOW, reason: 'change' });
  assert.equal(recovered.ok, true, '失败后仍可继续分析');
  assert.ok(runtime.current() !== null, '后续成功结果正常写回状态');
  assert.equal(runtime.status().lastErrorCode, '', '成功轮清空上一轮错误码');
  assert.equal(runtime.status().lastReasonCode, 'ok');
});

test('B3. bad-json 只记 rawChars/rawHash，事件与 status 都不带原文', async () => {
  const raw = '这不是 JSON，只是一段模型说明';
  const events = [];
  const runtime = makeRuntime(async () => raw, events);

  const result = await runtime.runNow({ ...WINDOW, reason: 'change' });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'bad-json');
  assert.equal(result.rawChars, raw.length);
  assert.match(result.rawHash, /^[0-9a-f]{16}$/u);
  const outcome = events.find((event) => event.type === 'understanding-run');
  assert.equal(outcome.reason, 'bad-json');
  assert.equal(outcome.errorCode, '');
  assert.equal(outcome.rawChars, raw.length);
  assert.equal(outcome.rawHash, result.rawHash);
  assert.equal(JSON.stringify(outcome).includes(raw), false, '事件绝不记录原始文本');

  const status = runtime.status();
  assert.equal(status.lastReasonCode, 'bad-json');
  assert.equal(status.rawChars, raw.length);
  assert.equal(status.rawHash, result.rawHash);
  assert.equal(JSON.stringify(status).includes(raw), false, 'status 绝不记录原始文本');
});

// ---------------------------------------------------------------------------
// C. decodeRaw tolerance: pure / fenced / surrounded JSON vs real non-JSON
// ---------------------------------------------------------------------------

test('C1. 纯 JSON、fenced JSON、前后有说明的 JSON 都能解析；真正非 JSON 仍是 bad-json', () => {
  const interval = { from: 1_000_000, to: 1_020_000 };
  const json = sceneJson('容错事件');
  const parse = (raw) => parseUnderstanding({
    raw,
    interval,
    frameIds: ['frame-a'],
    audioIds: [],
  });

  const plain = parse(json);
  assert.equal(plain.ok, true);
  assert.equal(plain.sceneSummary, '桌面上有一个打开的窗口');
  assert.equal(plain.events.length, 1);

  const fenced = parse(`\`\`\`json\n${json}\n\`\`\``);
  assert.equal(fenced.ok, true);
  assert.equal(fenced.events[0].description, '容错事件');

  const surrounded = parse(`模型输出如下：\n${json}\n以上是本次结果。`);
  assert.equal(surrounded.ok, true);
  assert.equal(surrounded.events[0].description, '容错事件');

  const fencedWithProse = parse(`说明\n\`\`\`json\n${json}\n\`\`\`\n结束`);
  assert.equal(fencedWithProse.ok, true);

  for (const raw of ['这真的不是 JSON', '{oops']) {
    const failed = parse(raw);
    assert.equal(failed.ok, false);
    assert.equal(failed.reason, 'bad-json');
    assert.equal(failed.rawChars, raw.length);
    assert.match(failed.rawHash, /^[0-9a-f]{16}$/u);
    assert.equal(JSON.stringify(failed).includes(raw), false, '解析失败结果不携带原文');
  }
});
