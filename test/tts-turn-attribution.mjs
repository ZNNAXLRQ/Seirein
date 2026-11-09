/**
 * P-46 stage 2: turn attribution on `voice.tts.request`.
 *
 * The timeline can only attribute a synthesis cost to a turn if the request row names that turn.
 * `synthesize()` / `speakStreaming()` / `speakSentences()` therefore accept optional
 * `turn` / `deliveryMessageId` / `sessionId` (plus the existing `sentenceId` / `chunkIndex`) and
 * copy them onto the row verbatim; a caller that passes nothing keeps null on every new field and
 * the exact old row for every old field. Nothing here changes slot waiting, synthesis or caching:
 * the hook stays fire-and-forget and the old fields are asserted field by field.
 *
 * Covered:
 *   1. synthesize() carries turn/deliveryMessageId/sessionId (+ sentenceId/chunkIndex) verbatim
 *   2. no attribution: all three are null and every pre-existing field is unchanged
 *   3. a value of the wrong type is never coerced into a fabricated id
 *   4. the inline streamed path carries the same attribution (streamed: true)
 *   5. speakStreaming's file fallback carries it through synthesize()
 *   6. speakSentences() forwards it to every sentence's synthesize() call
 *
 * Run: node --test test/tts-turn-attribution.mjs
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

const state = { spawn: null, streamDelayMs: 0 };
globalThis.__ttsTurnAttribution = state;
// A real Edge socket and a real player are both replaced before tts.js is imported.
const hooks = registerHooks({ load(url, context, next) {
  if (url === 'node:child_process') return { format: 'module', shortCircuit: true,
    source: `export const spawn = (...a) => globalThis.__ttsTurnAttribution.spawn(...a);
      export const execFile = () => { throw new Error('real exec forbidden'); };` };
  if (url.endsWith('/msedge-tts/dist/index.js')) return { format: 'module', shortCircuit: true,
    source: `import { Readable } from 'node:stream';
      class FakeMsEdgeTTS {
        async setMetadata() {}
        async toStream() {
          let sent = false;
          const audioStream = new Readable({
            read() {
              if (sent) return;
              sent = true;
              setTimeout(() => { this.push(Buffer.from('fake-audio-bytes')); this.push(null); },
                Number(globalThis.__ttsTurnAttribution.streamDelayMs) || 0);
            },
          });
          return { audioStream };
        }
        close() {}
      }
      export default { MsEdgeTTS: FakeMsEdgeTTS };` };
  return next(url, context);
} });
const tts = await import('../src/host/speech/tts.js');
hooks.deregister();
after(() => { delete globalThis.__ttsTurnAttribution; });

/** Recording hook plus an Edge double; every fixture is a fresh provider generation. */
async function fixture(t, { gpt = null } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tts-turn-'));
  const events = [];
  tts.configureTts({
    gptSovits: () => gpt,
    onTtsRequest: (payload) => events.push(payload),
    edgeSynthesize: async ({ signal }) => {
      if (signal?.aborted) throw signal.reason ?? Object.assign(new Error('aborted'), { name: 'AbortError' });
      return { file: join(dir, 'edge.mp3'), bytes: 10, durationMs: 1000, provider: 'edge-tts' };
    },
  });
  t.after(async () => {
    tts.stopTts();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  return { dir, events };
}

/** The player double; a file transport has no stdin, so it ends on its own timer. */
function fakePlayer() {
  state.spawn = (_command, _args, options) => {
    const player = new EventEmitter();
    player.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    player.stdin.on('finish', () => setImmediate(() => player.emit('close', 0)));
    player.kill = () => setImmediate(() => player.emit('close', 1));
    setImmediate(() => player.emit('spawn'));
    if (!Array.isArray(options?.stdio)) {
      const timer = setTimeout(() => player.emit('close', 0), 30);
      timer.unref?.();
      player.once('close', () => clearTimeout(timer));
    }
    return player;
  };
}

/** Every field this row had before P-46; a missing one would be a regression. */
const OLD_FIELDS = [
  'level', 'purpose', 'engine', 'chars', 'slotWaitMs', 'requestMs', 'totalMs', 'ok', 'errorCode',
  'cached', 'chunkIndex', 'sentenceId', 'coldStart', 'retried', 'retries', 'retryErrorCode',
  'queueDepth', 'priority', 'streamed',
];

test('1. synthesize carries turn/deliveryMessageId/sessionId (and the block ids) verbatim', async (t) => {
  const app = await fixture(t);
  await tts.synthesize({
    text: '你好', lang: 'zh', dir: app.dir, purpose: 'answer',
    turn: 12, deliveryMessageId: 'msg-abc', sessionId: 'session-xyz', sentenceId: 2, chunkIndex: 1,
  });

  assert.equal(app.events.length, 1);
  const event = app.events[0];
  assert.equal(event.turn, 12);
  assert.equal(event.deliveryMessageId, 'msg-abc');
  assert.equal(event.sessionId, 'session-xyz');
  assert.equal(event.sentenceId, 2);
  assert.equal(event.chunkIndex, 1);
  // The attribution is additive: the old observations still describe the same request.
  assert.equal(event.purpose, 'answer');
  assert.equal(event.chars, 2);
  assert.equal(event.ok, true);
  assert.equal(event.engine, 'edge');
  assert.ok(!JSON.stringify(event).includes('你好'), 'the row still never carries the text');
  console.log(`1. turn=${event.turn} msg=${event.deliveryMessageId} session=${event.sessionId} sentence=${event.sentenceId} chunk=${event.chunkIndex}`);
});

test('2. no attribution: the four attribution fields are null and every old field is unchanged', async (t) => {
  const app = await fixture(t);
  await tts.synthesize({ text: '测试', lang: 'zh', dir: app.dir });

  assert.equal(app.events.length, 1);
  const event = app.events[0];
  for (const field of OLD_FIELDS) assert.ok(field in event, `missing old field: ${field}`);
  assert.deepEqual(
    Object.keys(event).sort(),
    [...OLD_FIELDS, 'turn', 'deliveryMessageId', 'sessionId', 'speechId'].sort(),
    'exactly the old fields plus the four optional attribution fields',
  );
  assert.equal(event.turn, null);
  assert.equal(event.deliveryMessageId, null);
  assert.equal(event.sessionId, null);
  assert.equal(event.speechId, null, 'a lane without a ledger id reports null, never a guess');

  // Strict old-row assertions: no re-measurement, no reordering, no fabricated time.
  assert.equal(event.level, 'debug');
  assert.equal(event.purpose, 'speech');
  assert.equal(event.engine, 'edge');
  assert.equal(event.chars, 2);
  assert.equal(event.slotWaitMs, 0);
  assert.ok(Number.isInteger(event.requestMs) && event.requestMs >= 0, `requestMs ${event.requestMs}`);
  assert.equal(event.totalMs, event.slotWaitMs + event.requestMs);
  assert.equal(event.ok, true);
  assert.equal(event.errorCode, null);
  assert.equal(event.cached, false);
  assert.equal(event.chunkIndex, null);
  assert.equal(event.sentenceId, null);
  assert.equal(event.coldStart, true);
  assert.equal(event.retried, false);
  assert.equal(event.retries, 0);
  assert.equal(event.retryErrorCode, null);
  assert.equal(event.queueDepth, 0);
  assert.equal(event.priority, 0);
  assert.equal(event.streamed, false);
  console.log(`2. turn=${event.turn} deliveryMessageId=${event.deliveryMessageId} sessionId=${event.sessionId} purpose=${event.purpose} chars=${event.chars} engine=${event.engine}`);
});

test('3. a wrong-typed value is never coerced into a fabricated id', async (t) => {
  const app = await fixture(t);
  await tts.synthesize({
    text: '类型', lang: 'zh', dir: app.dir,
    turn: '12', deliveryMessageId: '', sessionId: 42,
  });
  const event = app.events[0];
  assert.equal(event.turn, null, 'a string turn is not an integer turn');
  assert.equal(event.deliveryMessageId, null, 'an empty id is not an id');
  assert.equal(event.sessionId, null, 'a number is not a session id');

  // 0 is a real turn number, not a missing one.
  await tts.synthesize({ text: '零', lang: 'zh', dir: app.dir, turn: 0 });
  assert.equal(app.events[1].turn, 0);
  console.log(`3. wrong types -> turn=${event.turn} msg=${event.deliveryMessageId} session=${event.sessionId}; turn 0 -> ${app.events[1].turn}`);
});

test('4. the inline streamed path carries the same attribution (streamed: true)', async (t) => {
  fakePlayer();
  const app = await fixture(t);
  state.streamDelayMs = 40;
  t.after(() => { state.streamDelayMs = 0; });
  const result = await tts.speakStreaming({
    text: '流式一句', lang: 'zh', dir: app.dir, ffplayPath: 'fake-player', purpose: 'answer',
    turn: 7, deliveryMessageId: 'msg-stream', sessionId: 'session-s', sentenceId: 0, chunkIndex: 0,
  });
  assert.ok(result.bytes > 0);

  assert.equal(app.events.length, 1, 'one row for the streamed request');
  const event = app.events[0];
  assert.equal(event.streamed, true);
  assert.equal(event.turn, 7);
  assert.equal(event.deliveryMessageId, 'msg-stream');
  assert.equal(event.sessionId, 'session-s');
  assert.equal(event.sentenceId, 0);
  assert.equal(event.chunkIndex, 0);
  assert.equal(event.purpose, 'answer');
  assert.equal(event.engine, 'edge');
  assert.equal(event.ok, true);
  assert.equal(event.totalMs, event.slotWaitMs + event.requestMs);
  console.log(`4. streamed=${event.streamed} turn=${event.turn} msg=${event.deliveryMessageId} session=${event.sessionId} requestMs=${event.requestMs}`);
});

test('5. the file fallback of speakStreaming still reports the attribution', async (t) => {
  fakePlayer();
  const app = await fixture(t);
  // No ffplayPath and no GPT-SoVITS: speakStreaming falls back to synthesize() for the clip.
  const result = await tts.speakStreaming({
    text: '回退', lang: 'zh', dir: app.dir,
    turn: 3, deliveryMessageId: 'msg-file', sessionId: 'session-f',
  });
  assert.equal(result.via, 'file');
  assert.equal(app.events.length, 1);
  const event = app.events[0];
  assert.equal(event.streamed, false, 'the file path is not a streamed row');
  assert.equal(event.turn, 3);
  assert.equal(event.deliveryMessageId, 'msg-file');
  assert.equal(event.sessionId, 'session-f');
  console.log(`5. via=${result.via} turn=${event.turn} msg=${event.deliveryMessageId} session=${event.sessionId}`);
});

test('6. speakSentences forwards the attribution to every sentence request', async (t) => {
  fakePlayer();
  const app = await fixture(t);
  function* sentences() { yield '第一句。'; yield '第二句。'; }
  const summary = await tts.speakSentences(sentences(), {
    dir: app.dir, ffplayPath: 'fake-player',
    turn: 5, deliveryMessageId: 'msg-sent', sessionId: 'session-sent',
  });
  assert.equal(summary.status, 'completed');

  assert.equal(app.events.length, 2);
  for (const event of app.events) {
    assert.equal(event.turn, 5);
    assert.equal(event.deliveryMessageId, 'msg-sent');
    assert.equal(event.sessionId, 'session-sent');
  }
  console.log(`6. sentences=${summary.sentences} rows=${app.events.length} turn=${app.events[0].turn} msg=${app.events[0].deliveryMessageId} session=${app.events[0].sessionId}`);
});
