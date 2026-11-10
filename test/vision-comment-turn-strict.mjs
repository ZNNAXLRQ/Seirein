/**
 * P2-2：评论证据严格按轮。
 *
 * 覆盖：
 *   1. `take/render` 带 turnId 时只认该轮记录；本轮没有记录就 null/''，绝不回退到会话最近一条；
 *   2. 旧记录兼容只能显式 `allowLegacy:true`，且只返回没有 turnId 的记录；
 *   3. 宿主回归：语音渲染传本轮 turnId。第 1 轮有证据、第 2 轮没有 → 第 2 轮为空，
 *      即便第 2 轮之前（以及会话里）仍留着第 1 轮的记录。
 *
 * 全部使用假时钟 / 注入的 commentEvidence，不采集屏幕、不调用模型。
 *
 * Run: node --test test/vision-comment-turn-strict.mjs
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { disposeAll } from './helpers/cleanup.mjs';
import { createCommentEvidence } from '../src/host/vision/comment-evidence.js';

const BASE = 1_700_000_000_000;

function alignment(over = {}) {
  return {
    confidence: 'high',
    reason: 'window',
    window: { from: BASE - 8_000, to: BASE - 4_000 },
    cues: { retrospective: false, current: false },
    relatedFrameIds: ['ev-turn-1'],
    afterSpeechFrameIds: [],
    latestFrameId: 'ev-turn-1',
    timeSource: 'audio',
    ...over,
  };
}

function attachInput(over = {}) {
  return {
    sessionId: 'companion',
    turnId: '1',
    utteranceId: 'u-turn-1',
    sentAt: BASE - 4_000,
    timeSource: 'audio',
    startedAt: BASE - 4_000,
    endedAt: BASE - 1_000,
    alignment: alignment(),
    latestId: 'ev-turn-1',
    latestAt: BASE,
    frameCount: 1,
    ...over,
  };
}

// ---------------------------------------------------------------------------------------------
// 1. strict turnId: no cross-turn fallback
// ---------------------------------------------------------------------------------------------
test('1. 带 turnId 查询：本轮没有记录 → null/空，不回退到会话最近一条', () => {
  const clock = { now: BASE + 30_000 };
  const evidence = createCommentEvidence({ now: () => clock.now });
  evidence.attach(attachInput());

  assert.ok(evidence.render('companion', { turnId: '1' }).includes('【视听证据｜本轮评论对齐】'));
  assert.equal(evidence.take('companion', { turnId: '2' }), null,
    'turn 2 has no record; the turn 1 record must not answer for it');
  assert.equal(evidence.render('companion', { turnId: '2' }), '');
  assert.equal(evidence.take('companion', { turnId: '1' }).turnId, '1');

  // The old no-query API still means "latest record"; strictness is opt-in via the query shape.
  assert.equal(evidence.take('companion').turnId, '1');

  // First turn has evidence, second has none: the second render stays empty even though the
  // first record is still live in the same session.
  clock.now = BASE + 31_000;
  assert.equal(evidence.render('companion', { turnId: '2' }), '');
});

// ---------------------------------------------------------------------------------------------
// 2. allowLegacy must be explicit and only matches records WITHOUT a turnId
// ---------------------------------------------------------------------------------------------
test('2. 旧记录兼容：只有显式 allowLegacy 且旧记录没有 turnId 才返回', () => {
  const evidence = createCommentEvidence({ now: () => BASE + 30_000 });
  // A pre-turnId record: no turnId at all.
  evidence.attach(attachInput({
    turnId: undefined,
    utteranceId: 'u-legacy',
    alignment: alignment({ relatedFrameIds: ['ev-legacy'] }),
    latestId: 'ev-legacy',
  }));
  // A later turn-tagged record exists in the same session and is the latest record.
  evidence.attach(attachInput({
    turnId: '1',
    utteranceId: 'u-turn-1',
    alignment: alignment({ relatedFrameIds: ['ev-turn-1'] }),
  }));

  // Default strict query for another turn: no fallback to either record.
  assert.equal(evidence.take('companion', { turnId: '2' }), null);
  assert.equal(evidence.render('companion', { turnId: '2' }), '');

  // Explicit compatibility returns only the turnId-less legacy record.
  const legacy = evidence.take('companion', { turnId: '2', allowLegacy: true });
  assert.ok(legacy !== null, 'allowLegacy returns the old record');
  assert.equal(legacy.turnId, null);
  assert.equal(legacy.utteranceId, 'u-legacy');
  const legacyText = evidence.render('companion', { turnId: '2', allowLegacy: true });
  assert.ok(legacyText.includes('本轮评论对齐'), legacyText);
  assert.ok(legacyText.includes('ev-legacy'), legacyText);

  // The exact-turn record still wins over the legacy fallback.
  assert.equal(evidence.take('companion', { turnId: '1', allowLegacy: true }).turnId, '1');

  // allowLegacy never falls back to a DIFFERENT turn-tagged record.
  const onlyTurnRecords = createCommentEvidence({ now: () => BASE + 30_000 });
  onlyTurnRecords.attach(attachInput({ sessionId: 'only-turn', turnId: '1' }));
  assert.equal(onlyTurnRecords.take('only-turn', { turnId: '2', allowLegacy: true }), null,
    'a turn-tagged record is not a legacy record');
  assert.equal(onlyTurnRecords.render('only-turn', { turnId: '2', allowLegacy: true }), '');
});

// ---------------------------------------------------------------------------------------------
// 3. Host regression: current-turn render passes turnId, no cross-turn fallback
// ---------------------------------------------------------------------------------------------
test('3. 宿主回归：第 1 轮有证据、第 2 轮无证据 → 第 2 轮空', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'vision-comment-strict-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  await mkdir(join(root, 'data'), { recursive: true });
  await writeFile(join(root, 'data', 'features.json'), `${JSON.stringify({
    hearing: false, ambient: false, voice: false, vision: true,
    subtitle: false, avatar: false, memory: false, fastpath: false,
  })}\n`, 'utf8');
  await writeFile(join(root, 'data', 'settings.json'), `${JSON.stringify({
    vision: { continuousView: false },
  })}\n`, 'utf8');

  const listeners = new Map();
  const promptContexts = new Map();
  const disposers = [];
  const effect = (fn) => {
    const dispose = fn();
    if (typeof dispose === 'function') disposers.push(dispose);
    return dispose;
  };
  const on = (type, handler) => {
    const list = listeners.get(type) ?? [];
    list.push(handler);
    listeners.set(type, list);
    return () => {
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    };
  };
  const commentEvidence = createCommentEvidence({ now: () => Date.now() });
  const { apply, voiceSessionTarget } = await import('../src/host/index.js');
  apply({
    effect,
    on,
    get: (service) => (service === 'attachments'
      ? { async saveImage() { return { id: 'att-1', mediaType: 'image/png', name: 'x', bytes: 1 }; }, async deleteImage() {} }
      : (service === 'llm'
        ? { async resolveModelInfo(provider, model) { return { provider, id: model, name: model, inputModalities: ['text', 'image'] }; } }
        : undefined)),
    tools: { register: () => () => {} },
    inject: (_dependencies, register) => register({
      effect,
      systemPrompt: {
        section: () => () => {},
        context(definition) {
          promptContexts.set(definition.name, definition);
          return () => {};
        },
      },
      webServer: { register: () => () => {} },
    }),
  }, {
    root,
    enabled: true,
    defaultDomain: 'chat',
    privacyScene: 'Privacy',
    commentEvidence,
    // The fixture's single session is the voice companion: force the voice lane without needing
    // a real microphone turn.
    contextLaneOverride: () => 'voice',
    // No real analyzer / capture: this regression only exercises prompt rendering.
    understandingAnalyzer: async () => ({ ok: false, text: '', reason: 'test', images: 0 }),
    understandingMinIntervalMs: 60_000,
    evidenceCaptureBootDelayMs: 60_000,
  });

  t.after(async () => {
    await disposeAll(disposers.splice(0));
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  const handler = listeners.get('agent/pre-step')?.[0];
  assert.ok(handler !== undefined, 'Host registered agent/pre-step');
  const context = promptContexts.get('assistant:audiovisual');
  assert.ok(context !== undefined, 'Host registered the audiovisual context');

  const companionId = voiceSessionTarget({ root }).sessionId;
  const agent = {
    id: companionId,
    session: { id: companionId, header: { cwd: workspace } },
  };
  const next = async () => ({ kind: 'enter', messages: [] });
  const message = (id, text) => [{
    id,
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  }];
  const preStep = (turn, id, text) => handler({
    agent,
    turn,
    step: 1,
    signal: new AbortController().signal,
    messages: message(id, text),
  }, next);

  // Turn 1: pre-step opens the turn; its evidence is attached and must render for turn 1.
  await preStep(1, 'strict-turn-1', '这个表情好搞笑');
  commentEvidence.attach(attachInput({
    sessionId: companionId,
    turnId: '1',
    alignment: alignment({ relatedFrameIds: ['ev-turn-1'] }),
  }));
  const firstText = context.text({ agent });
  assert.ok(firstText.includes('【视听证据｜本轮评论对齐】'), firstText);
  assert.ok(firstText.includes('ev-turn-1'), firstText);

  // Turn 2: unrelated text attaches no evidence for this turn. The turn 1 record is still live,
  // but the current-turn render must not borrow it.
  await preStep(2, 'strict-turn-2', '今天吃什么');
  assert.equal(commentEvidence.take(companionId, { turnId: '2' }), null);
  assert.equal(commentEvidence.render(companionId, { turnId: '2' }), '');
  assert.equal(context.text({ agent }), '',
    'turn 2 renders empty even though turn 1 evidence is still in this session');
  console.log('3) turn1=evidence turn2=empty (strict current-turn render)');
});
