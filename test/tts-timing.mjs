/**
 * `voice.tts.request` observation.
 *
 * Every finished synthesis request writes one debug row: purpose, engine, characters, queue wait,
 * provider round trip, cold start, retries and cache hint. The row must never carry the spoken
 * text, must keep `slotWaitMs` (queue) and `requestMs` (provider) as separate measurements, and
 * must be written for failures/timeouts too. Nothing here changes synthesis: the event hook is
 * fire-and-forget, so a slow log can never delay audio.
 *
 * Run: node --test test/tts-timing.mjs
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A controlled transport: the streaming path opens a real Edge socket and a real player, so both
// are replaced before tts.js is imported (the same seams test/tts-queue.mjs uses).
const state = { spawn: null, streamDelayMs: 0, fetch: null };
const realFetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
  if (typeof state.fetch !== 'function') throw new Error(`unexpected fetch: ${url}`);
  return state.fetch(String(url), options);
};
globalThis.__ttsTiming = state;
const hooks = registerHooks({ load(url, context, next) {
  if (url === 'node:child_process') return { format: 'module', shortCircuit: true,
    source: `export const spawn = (...a) => globalThis.__ttsTiming.spawn(...a);
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
                Number(globalThis.__ttsTiming.streamDelayMs) || 0);
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
after(() => {
  globalThis.fetch = realFetch;
  delete globalThis.__ttsTiming;
});

const API = 'http://127.0.0.1:9880';
const REF = '<root>\\voice\\Reference\\Hina_ExWeapon_Get.wav';
const WAV = (() => {
  const buffer = Buffer.alloc(48);
  buffer.write('RIFF', 0, 'ascii');
  buffer.write('WAVE', 8, 'ascii');
  return buffer;
})();
const wavBody = () => WAV.buffer.slice(WAV.byteOffset, WAV.byteOffset + WAV.length);
const wavResponse = () => ({ ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => wavBody() });
const textResponse = (status, body) => ({
  ok: false,
  status,
  headers: { get: () => null },
  arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer,
});

function gptSettings(patch = {}) {
  return {
    enabled: true,
    apiBase: API,
    refAudioPath: REF,
    promptText: '参考音频里说的话',
    promptLang: '',
    textLang: '',
    models: { gptModelPath: '', sovitsModelPath: '' },
    ...patch,
  };
}

/** Route the provider fetch for one test (the GPT-SoVITS HTTP path). */
function useFetch(t, handler) {
  state.fetch = handler;
  t.after(() => { state.fetch = null; });
}

/** Recording hooks plus a controllable Edge double; every fixture is a fresh provider generation. */
async function fixture(t, { gpt = null, edgeDelays = [], edgeFail = null, coldStartRequests } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tts-timing-'));
  const events = [];
  const slotWaits = [];
  const delays = [...edgeDelays];
  const provider = { gpt };
  tts.configureTts({
    gptSovits: () => provider.gpt,
    probeReference: async () => 8.4,
    onSlotWait: (payload) => slotWaits.push(payload),
    onTtsRequest: (payload) => events.push(payload),
    coldStartRequests,
    edgeSynthesize: async ({ text, voice, signal }) => {
      const delayMs = delays.length > 0 ? delays.shift() : 0;
      if (delayMs > 0) await sleep(delayMs);
      if (signal?.aborted) throw signal.reason ?? Object.assign(new Error('aborted'), { name: 'AbortError' });
      if (edgeFail !== null) throw edgeFail();
      return { file: join(dir, 'edge.mp3'), bytes: 10, durationMs: 1000, provider: 'edge-tts' };
    },
  });
  t.after(async () => {
    tts.stopTts();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  return { dir, events, slotWaits, provider };
}

/** The player double: the streaming path writes to stdin and waits for a real `close`. */
function fakePlayer() {
  state.spawn = () => {
    const player = new EventEmitter();
    player.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    player.stdin.on('finish', () => setImmediate(() => player.emit('close', 0)));
    player.kill = () => setImmediate(() => player.emit('close', 1));
    setImmediate(() => player.emit('spawn'));
    return player;
  };
}

const EVENT_FIELDS = [
  'purpose', 'engine', 'chars', 'slotWaitMs', 'requestMs', 'totalMs', 'ok', 'errorCode',
  'cached', 'chunkIndex', 'sentenceId', 'coldStart', 'queueDepth',
];

test('1. one successful synthesis: every field is present and totalMs is slotWait + request', async (t) => {
  const app = await fixture(t, { gpt: gptSettings() });
  // The provider answers after 30 ms, so `requestMs` has a measurable lower bound.
  useFetch(t, async () => { await sleep(30); return wavResponse(); });

  const result = await tts.synthesize({
    text: 'こんにちは', lang: 'ja', dir: app.dir, purpose: 'answer',
  });
  assert.equal(result.provider, 'gpt-sovits');

  assert.equal(app.events.length, 1, 'exactly one row per request');
  const event = app.events[0];
  for (const field of EVENT_FIELDS) assert.ok(field in event, `missing field: ${field}`);
  assert.equal(event.level, 'debug');
  assert.equal(event.purpose, 'answer');
  assert.equal(event.engine, 'gpt-sovits');
  assert.equal(event.chars, 5);
  assert.equal(event.ok, true);
  assert.equal(event.errorCode, null);
  assert.equal(event.cached, false);
  assert.equal(event.chunkIndex, null);
  assert.equal(event.sentenceId, null);
  assert.equal(event.coldStart, true, 'the first request of the generation is cold');
  assert.equal(event.retried, false);
  assert.equal(event.retries, 0);
  assert.equal(event.slotWaitMs, 0);
  assert.ok(event.requestMs >= 30 && event.requestMs < 5000, `requestMs ${event.requestMs}`);
  assert.equal(event.totalMs, event.slotWaitMs + event.requestMs);
  assert.ok(!JSON.stringify(event).includes('こんにちは'), 'the row never carries the text');
  console.log(`1. ok=${event.ok} engine=${event.engine} chars=${event.chars} slotWait=${event.slotWaitMs} request=${event.requestMs} total=${event.totalMs}`);
});

test('2. a queued request reports the wait separately from the provider round trip', async (t) => {
  // Edge only: a queued job and a fast provider make the two clocks easy to separate.
  const app = await fixture(t, { edgeDelays: [80, 20] });
  const first = tts.synthesize({ text: '第一句', lang: 'ja', dir: app.dir });
  const second = tts.synthesize({ text: '第二句', lang: 'ja', dir: app.dir });
  await Promise.all([first, second]);

  assert.equal(app.events.length, 2);
  const [fast, queued] = app.events;
  assert.equal(fast.slotWaitMs, 0);
  assert.equal(fast.queueDepth, 0);
  assert.ok(fast.requestMs >= 60, `requestMs ${fast.requestMs} holds its own round trip`);
  assert.ok(queued.slotWaitMs >= 60, `slotWaitMs ${queued.slotWaitMs} must show the wait`);
  assert.ok(queued.queueDepth >= 1, `queueDepth ${queued.queueDepth}`);
  assert.ok(queued.requestMs >= 10 && queued.requestMs < 60, `requestMs ${queued.requestMs} is its own round trip, not the wait`);
  assert.equal(queued.totalMs, queued.slotWaitMs + queued.requestMs);
  // The pre-existing slot-wait row still fires for the same request (unchanged behavior).
  assert.equal(app.slotWaits.length, 1);
  assert.equal(app.slotWaits[0].slotWaitMs, queued.slotWaitMs);
  assert.ok(!JSON.stringify(app.events).includes('第一句'));
  console.log(`2. first slotWait=${fast.slotWaitMs} request=${fast.requestMs}; queued slotWait=${queued.slotWaitMs} request=${queued.requestMs} depth=${queued.queueDepth}`);
});

test('3. failures: timeout fallback is one retry, all-failed carries the code, abort is coded', async (t) => {
  // (a) GPT-SoVITS times out (an aborted provider fetch) and Edge serves the line: ok, one retry.
  const fallback = await fixture(t, { gpt: gptSettings({ timeoutMs: 5000 }) });
  useFetch(t, () => Promise.reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })));
  const recovered = await tts.synthesize({ text: 'テスト', lang: 'ja', dir: fallback.dir });
  assert.equal(recovered.provider, 'edge-tts');
  assert.equal(fallback.events.length, 1);
  const retried = fallback.events[0];
  assert.equal(retried.ok, true);
  assert.equal(retried.engine, 'edge');
  assert.equal(retried.retried, true);
  assert.equal(retried.retries, 1, 'the automatic Edge fallback is exactly one retry');
  assert.equal(retried.retryErrorCode, 'TTS_TIMEOUT');
  assert.equal(retried.totalMs, retried.slotWaitMs + retried.requestMs);

  // (b) Both engines fail: ok:false, a stable code, and the retry is still declared.
  const both = await fixture(t, {
    gpt: gptSettings(),
    edgeFail: () => Object.assign(new Error('edge down'), { code: 'EDGE_SOCKET' }),
  });
  useFetch(t, async () => textResponse(500, { message: 'boom 秘密口令ABC-9f3c' }));
  await assert.rejects(tts.synthesize({ text: '秘密口令ABC-9f3c', lang: 'ja', dir: both.dir }), /edge down/u);
  assert.equal(both.events.length, 1);
  const failed = both.events[0];
  assert.equal(failed.ok, false);
  assert.equal(failed.errorCode, 'EDGE_SOCKET');
  assert.equal(failed.engine, 'edge');
  assert.equal(failed.retried, true);
  assert.equal(failed.retries, 1);
  assert.equal(failed.retryErrorCode, 'TTS_HTTP_500');
  assert.equal(failed.totalMs, failed.slotWaitMs + failed.requestMs);
  assert.ok(!JSON.stringify(failed).includes('秘密口令'), 'a server body never reaches the row');

  // (c) A cancelled request is reported as cancelled, not as an engine failure.
  const cancelled = await fixture(t, { edgeDelays: [100] });
  const controller = new AbortController();
  const pending = tts.synthesize({ text: '中止', lang: 'ja', dir: cancelled.dir, signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(cancelled.events.length, 1);
  assert.equal(cancelled.events[0].ok, false);
  assert.equal(cancelled.events[0].errorCode, 'TTS_ABORTED');
  assert.equal(cancelled.events[0].retried, false);
  console.log(`3. fallback ok=${retried.ok} retries=${retried.retries} code=${retried.retryErrorCode}; all-fail code=${failed.errorCode}; abort code=${cancelled.events[0].errorCode}`);
});

test('4. cold start marks the first 3 requests and the first one after a warm-up', async (t) => {
  const app = await fixture(t, { gpt: gptSettings() });
  useFetch(t, async () => wavResponse());
  for (let index = 0; index < 4; index += 1) {
    await tts.synthesize({ text: 'あ', lang: 'ja', dir: app.dir });
  }
  assert.deepEqual(app.events.map((event) => event.coldStart), [true, true, true, false]);

  const warm = await tts.warmupGptSovits({ dir: app.dir, speech: 'ja' });
  assert.equal(warm.ok, true);
  await tts.synthesize({ text: 'あ', lang: 'ja', dir: app.dir });
  await tts.synthesize({ text: 'あ', lang: 'ja', dir: app.dir });
  assert.deepEqual(app.events.map((event) => event.coldStart), [true, true, true, false, true, false]);
  console.log(`4. coldStart flags: ${app.events.map((event) => event.coldStart).join(',')}`);
});

test('5. a cache-declared request keeps cached:true and a small requestMs behind a queue', async (t) => {
  const app = await fixture(t, { edgeDelays: [80, 15] });
  const slow = tts.synthesize({ text: '需要合成的一句长话', lang: 'ja', dir: app.dir });
  // `cached` is a caller-declared observation: this module owns no audio cache, so the flag
  // records what the caller knows. Its provider round trip is still measured separately.
  const cached = tts.synthesize({ text: '已经缓存的一句', lang: 'ja', dir: app.dir, cached: true });
  await Promise.all([slow, cached]);

  assert.equal(app.events[0].cached, false);
  const hit = app.events[1];
  assert.equal(hit.cached, true);
  assert.ok(hit.slotWaitMs >= 60, `slotWaitMs ${hit.slotWaitMs}`);
  assert.ok(hit.requestMs >= 10 && hit.requestMs < 60, `requestMs ${hit.requestMs} stays small while the queue wait grows`);
  assert.equal(hit.totalMs, hit.slotWaitMs + hit.requestMs);
  console.log(`5. cached=${hit.cached} slotWait=${hit.slotWaitMs} request=${hit.requestMs}`);
});

test('6. the row carries characters and times, never the spoken text', async (t) => {
  const secret = '这是绝不能出现在事件里的句子';
  const app = await fixture(t, { gpt: gptSettings() });
  // The server echoes the sent text in its 400 body: only the code may reach the event.
  useFetch(t, async () => textResponse(400, { message: `参考音频无效：${secret}` }));
  await tts.synthesize({ text: secret, lang: 'ja', dir: app.dir });

  assert.equal(app.events.length, 1);
  const event = app.events[0];
  assert.equal(event.chars, [...secret].length);
  const serialized = JSON.stringify(event);
  assert.ok(!serialized.includes(secret));
  assert.ok(!serialized.includes('参考音频无效'));
  for (const key of ['text', 'speech', 'body', 'error', 'message']) {
    assert.ok(!(key in event), `the row must not carry "${key}"`);
  }
  console.log(`6. chars=${event.chars} (no text field, server body dropped)`);
});

test('7. the inline Edge stream (whole sentence) reports one streamed row', async (t) => {
  fakePlayer();
  const app = await fixture(t);
  state.streamDelayMs = 60;
  const result = await tts.speakStreaming({
    text: 'ストリームの文', lang: 'ja', dir: app.dir, ffplayPath: 'fake-player', purpose: 'answer',
  });
  await sleep(20); // let the player close release the slots
  state.streamDelayMs = 0;

  assert.ok(result.bytes > 0);
  assert.equal(app.events.length, 1);
  const event = app.events[0];
  assert.equal(event.streamed, true);
  assert.equal(event.engine, 'edge');
  assert.equal(event.purpose, 'answer');
  assert.equal(event.chars, 7);
  assert.equal(event.ok, true);
  assert.equal(event.slotWaitMs, 0);
  assert.ok(event.requestMs >= 50 && event.requestMs < 1000, `requestMs ${event.requestMs} is time-to-first-audio`);
  assert.equal(event.totalMs, event.slotWaitMs + event.requestMs);
  assert.ok(!JSON.stringify(event).includes('ストリーム'));
  console.log(`7. streamed=${event.streamed} engine=${event.engine} requestMs=${event.requestMs} chars=${event.chars}`);
});

test('8. without the hook the module still synthesizes and writes nothing (zero overhead)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tts-timing-plain-'));
  t.after(() => rm(dir, { recursive: true, force: true }).catch(() => {}));
  tts.configureTts({ edgeSynthesize: async () => ({ file: join(dir, 'edge.mp3'), bytes: 1, durationMs: 1, provider: 'edge-tts' }) });
  const result = await tts.synthesize({ text: '静默', dir });
  assert.equal(result.provider, 'edge-tts');
  console.log('8. no onTtsRequest hook: synthesis unaffected, no row written');
});
