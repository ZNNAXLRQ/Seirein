import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assistantMessageText,
  createVoiceFollowup,
  voiceFollowupSource,
} from '../src/host/session/delivery/followup.js';

const session = { id: 'seirein-2026-11-11' };

const event = (type, data = {}, seq = 1, time = Date.now()) => ({ type, seq, time, data });

const assistant = (text, extra = {}) => event('assistant/message', {
  turn: 2,
  message: {
    role: 'assistant',
    content: [{ type: 'text', text }],
    ...extra,
  },
});

const source = (kind = 'subagent-settled', summary = '查天气') => event('user/message', {
  turn: 2,
  message: {
    role: 'user',
    content: [{ type: 'text', text: 'task settled' }],
    source: { kind, form: 'notice', summary, senderSessionId: 'child-1' },
  },
});

function fakeCtx() {
  const handlers = new Set();
  return {
    handlers,
    on(type, handler) {
      assert.equal(type, 'session/event');
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    emit(sessionValue, eventValue) {
      for (const handler of [...handlers]) handler(sessionValue, eventValue);
    },
  };
}

test('source detection reads the nested message source and label', () => {
  const found = voiceFollowupSource(source('subagent-settled', '查天气'));
  assert.equal(found.kind, 'subagent-settled');
  assert.equal(found.label, '查天气');
  assert.equal(voiceFollowupSource(event('assistant/message')), null);
});

test('assistant text excludes reasoning blocks', () => {
  const text = assistantMessageText(event('assistant/message', {
    message: { content: [
      { type: 'reasoning', text: 'private' },
      { type: 'text', text: '完成：' },
      { type: 'text', text: '晴天' },
    ] },
  }));
  assert.equal(text, '完成：晴天');
});

test('speaks once after a settled source, not before it', () => {
  const ctx = fakeCtx();
  const results = [];
  const watcher = createVoiceFollowup({
    ctx, sessionId: session.id, afterSeq: 0,
    onResult: (value) => results.push(value),
  });
  ctx.emit(session, assistant('not the task'));
  assert.equal(results.length, 0, 'an ordinary assistant message before the source is ignored');
  ctx.emit(session, source('subagent-settled', '查天气'));
  ctx.emit(session, assistant('北京今天晴，25 度'));
  assert.equal(results.length, 1);
  assert.equal(results[0].text, '北京今天晴，25 度');
  assert.equal(results[0].source.label, '查天气');
  assert.equal(watcher.live(), false);
  assert.equal(ctx.handlers.size, 0, 'the listener is removed after the one result');
});

test('a tool step after the source does not become the spoken result', () => {
  const ctx = fakeCtx();
  const results = [];
  createVoiceFollowup({ ctx, sessionId: session.id, onResult: (value) => results.push(value) });
  ctx.emit(session, source('goal', '整理资料'));
  ctx.emit(session, event('tool/call', { name: 'todo_write' }));
  ctx.emit(session, assistant('中间步骤'));
  assert.equal(results.length, 0);
  ctx.emit(session, event('tool/result', { name: 'todo_write' }));
  ctx.emit(session, assistant('资料整理完成'));
  assert.equal(results.length, 1);
  assert.equal(results[0].text, '资料整理完成');
});

test('an assistant message with a tool-call block is not a result', () => {
  const ctx = fakeCtx();
  const results = [];
  createVoiceFollowup({ ctx, sessionId: session.id, onResult: (value) => results.push(value) });
  ctx.emit(session, source('tool-jobs', '构建'));
  ctx.emit(session, event('assistant/message', {
    message: { content: [{ type: 'text', text: '继续' }, { type: 'tool-call' }] },
  }));
  assert.equal(results.length, 0);
});

test('cancel removes the listener and prevents later speech', () => {
  const ctx = fakeCtx();
  const results = [];
  const watcher = createVoiceFollowup({ ctx, sessionId: session.id, onResult: (value) => results.push(value) });
  watcher.cancel();
  ctx.emit(session, source());
  ctx.emit(session, assistant('迟到结果'));
  assert.equal(results.length, 0);
  assert.equal(ctx.handlers.size, 0);
});
