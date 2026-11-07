/**
 * Voice correction tone: the system prompt must tell the agent to use the corrected meaning
 * directly instead of reciting the correction or asking whether to correct. It also proves that
 * only the corrected transcript reaches the user message, so no raw transcript or "我听到的是 X…"
 * template can be delivered.
 *
 * The prompt tests read the host source; the delivery test drives the real prepareVoiceTurn →
 * deliverVoiceRequest path and inspects the message the agent actually receives. No model, TTS,
 * player, network or child process is used.
 *
 * Run: node --test test/voice-correction-tone.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import { annotateTranscript } from '../src/host/hearing/hearing.js';
import { deliverVoiceRequest, prepareVoiceTurn } from '../src/host/index.js';

const source = await readFile(new URL('../src/host/index.js', import.meta.url), 'utf8');

/** The HEARING_CONVENTION array literal, indentation and quotes included. */
function hearingConvention(text) {
  const match = /const HEARING_CONVENTION = \[[\s\S]*?\]\.join\('\\n'\);/u.exec(text);
  assert.ok(match, 'index.js declares the HEARING_CONVENTION prompt section');
  return match[0];
}

const RULES = [
  '- 语音识别可能有同音错字：按上下文理解为正确含义后**直接使用**，不要复述纠错过程，不要询问是否纠正。',
  '- 只有在你无法判断真实意图、且错误会导致严重后果（数字、人名、金额、命令、时间）时，才用一句话复述确认。',
  '- 不要解释“我听到的是 X，但我理解为 Y”。',
];

test('prompt: the voice section tells the agent to use corrected meaning without reciting it', () => {
  const block = hearingConvention(source);
  assert.ok(block.includes('## 语音输入处理'), 'the prompt carries its own voice-input section');
  for (const rule of RULES) {
    assert.ok(block.includes(rule), `missing voice rule: ${rule}`);
  }
  // The old unconditional "repeat to confirm" instructions must not survive next to the new rule.
  assert.ok(!block.includes('不确定时用一句话复述确认'), 'the unconditional confirm rule is gone');
  assert.ok(!block.includes('一律复述确认'), 'the blanket confirm-before-execute rule is gone');
});

test('delivery: no invented "我听到的是 X" correction template is sent to the model', () => {
  const block = hearingConvention(source);
  const outsidePrompt = source.replace(block, '');
  // The only occurrence of that phrasing is the prohibition inside the prompt itself.
  assert.ok(
    !outsidePrompt.includes('我听到的是'),
    'nothing outside the prompt builds a "我听到的是 X, 但我理解为 Y" delivery template',
  );
  assert.ok(
    !/[^「“]我听到的是[^」”]*(纠正|理解为)/u.test(outsidePrompt),
    'the host never wraps a corrected utterance in a hear/correct explanation',
  );
});

/** A Cordis-like ctx: `on` records listeners and returns the unsubscribe handle. */
function fakeCtx() {
  const listeners = new Set();
  return {
    ctx: {
      get: () => undefined,
      on(type, fn) {
        const entry = { type, fn };
        listeners.add(entry);
        return () => listeners.delete(entry);
      },
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

function fakeLog() {
  const events = [];
  return {
    events,
    emit: async (type, payload) => {
      events.push({ type, payload });
    },
  };
}

/** One text part of a delivered message, exactly as the model would read it. */
function messageText(message) {
  return (message.content ?? [])
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

test('delivery: the user message carries the corrected transcript and never the raw ASR text', async () => {
  // ASR misheard 文件 as 稳件; the agent corrects it before the host builds the message.
  const rawText = '帮我打开那个稳件';
  const corrected = '帮我打开那个文件';
  const deliveredText = annotateTranscript(corrected, {});

  const sessionId = 'voice-correction-delivery';
  const ctx = fakeCtx();
  const log = fakeLog();
  const followups = [];
  const session = {
    created: false,
    agent: {
      followup(message) {
        followups.push(message);
      },
    },
  };

  const prepared = await prepareVoiceTurn({
    ctx: ctx.ctx,
    sessionId,
    // The host delivers the corrected text; the bare (pre-correction) transcript travels separately.
    text: deliveredText,
    spoken: rawText,
    memory: { brief: () => { throw new Error('the voice lane must not recall here'); } },
    log,
    speakLine: async () => {},
    inScope: true,
    enabled: true,
    timeoutMs: 5_000,
  });
  assert.equal(prepared.refused, false, 'the turn is prepared');

  const delivered = await deliverVoiceRequest({
    resultPromise: prepared.resultPromise,
    session,
    sessionId,
    request: prepared.request,
    log,
    speakLine: async () => {},
  });
  assert.equal(delivered, true, 'the turn is delivered');
  assert.equal(followups.length, 1, 'exactly one user message reaches the agent');
  assert.equal(followups[0], prepared.request, 'the delivered message is the prepared userMessage');

  const message = followups[0];
  const text = messageText(message);
  assert.equal(message.role, 'user', 'the delivered message is a user message');
  assert.equal(text, corrected, 'the message text is exactly the corrected transcript');
  assert.ok(text.includes('文件'), 'the corrected word is what the model reads');
  assert.ok(!text.includes(rawText), 'the raw ASR sentence never enters the message');
  assert.ok(!text.includes('稳件'), 'the misheard token never enters the message');
  assert.ok(!text.includes('我听到的是'), 'no hear/correct template wraps the transcript');
  assert.deepEqual(message.content, [{ type: 'text', text: corrected }], 'the message has one plain text part');

  prepared.resultPromise.cancel();
  await prepared.resultPromise;
  assert.equal(ctx.listenerCount, 0, 'the delivery test leaves no session listener behind');
});
