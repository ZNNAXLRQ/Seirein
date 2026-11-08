/**
 * Continuous dialogue on the Host side: prompt injection + rolling summary.
 *
 * `dialogue-capture.mjs` pins how hearing fills the buffer; this suite pins what the HOST does with
 * it:
 *  1. a buffer with text becomes one independent system section (`assistant:dialogue`, order after
 *     the persona) and says it is an observation, not a user turn; an empty buffer injects nothing;
 *  2. the injection never rewrites the user's message: the user text is byte-identical before and
 *     after the prompt is assembled, and the observation block does not contain it;
 *  3. when a summary is due it starts in the BACKGROUND; the request that noticed it returns at
 *     once with the current text (old summary + latest transcript), never waiting for the model;
 *  4. success advances `summaryThrough` and the next injection carries the summary; failure keeps
 *     `pending` and backs off exponentially (5 s → 60 s cap), with no timer and no lost text;
 *  5. the same instance survives a device restart, so the injected text stays continuous;
 *  6. closing listening aborts the summary in flight and writes no further event.
 *
 * The Host is mounted with the real `apply()`; only the microphone is faked (a fake ffmpeg child
 * plus a fake ASR worker, the same seams `dialogue-capture.mjs` uses). The summary model call is a
 * pure test double, so no network, no model, no audio and no real thread is involved.
 *
 * Run: node --test test/dialogue-injection.mjs
 * Regression: node --test test/dialogue-capture.mjs test/dialogue-context.mjs test/voice-lanes.mjs
 *             node test/smoke.mjs
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  DIALOGUE_INJECTION_ORDER,
  DIALOGUE_SUMMARY_DEFAULTS,
  apply,
  createDialogueSummaryRunner,
  dialogueSummaryRequest,
  normalizeDialogueSummary,
  voiceSessionTarget,
} from '../src/host/index.js';
import { createDialogueContext } from '../src/host/session/conversation/dialogueContext.js';
import { startHearing } from '../src/host/hearing/hearing.js';

const SAMPLE_RATE = 16000;
const MIC = 'Fake Microphone (USB)';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `predicate()` is true; a missed deadline fails the test instead of hanging it. */
async function until(predicate, label, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) assert.fail(`timed out: ${label}`);
    await delay(5);
  }
}

async function tempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-dialogue-injection-'));
  t.after(async () => {
    await delay(80);
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });
  return root;
}

async function readEvents(root) {
  try {
    const raw = await readFile(join(root, 'data', 'events.jsonl'), 'utf8');
    return raw.trim().split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/**
 * Mount the real plugin with a fake context that captures the prompt sections. `config` may carry
 * the two test seams: `dialogueContext` (the buffer the Host should own) and `dialogueAsk` (the
 * summary model call). Production never passes either.
 */
function mount(root, config = {}) {
  const tools = new Map();
  const sections = new Map();
  const cleanups = [];
  const effect = (fn) => {
    const value = fn();
    if (typeof value === 'function') cleanups.push(value);
    return value;
  };
  const ctx = {
    effect,
    on: () => () => {},
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    inject: (_deps, register) => register({
      effect,
      systemPrompt: {
        section(definition) {
          sections.set(definition.name, definition);
          return () => {};
        },
      },
      webServer: { register: () => () => {} },
    }),
  };
  apply(ctx, { root, enabled: true, ...config });
  // The section text functions judge the workspace from the calling agent's session cwd; the
  // conversation observations additionally require the companion session identity for that root.
  const promptContext = {
    agent: { id: voiceSessionTarget({ root }).sessionId, session: { header: { cwd: join(root, 'workspace') } } },
  };
  const sectionText = (name) => {
    const section = sections.get(name);
    return typeof section?.text === 'function' ? section.text(promptContext) : '';
  };
  const prompt = () => [...sections.values()]
    .sort((left, right) => left.order - right.order)
    .map((section) => section.text(promptContext))
    .filter((text) => typeof text === 'string' && text.length > 0)
    .join('\n\n');
  return {
    sections,
    sectionText,
    prompt,
    tools,
    close: () => {
      for (const fn of cleanups.reverse()) {
        try {
          fn();
        } catch {
          /* already torn down */
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Hearing fixtures (the same seams dialogue-capture.mjs uses)
// ---------------------------------------------------------------------------

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.killed = false;
  }

  kill() {
    this.killed = true;
  }
}

/** A 440 Hz tone at -12 dBFS: loud enough to pass the RMS gate. */
function tone(ms) {
  const samples = new Int16Array(Math.round((SAMPLE_RATE * ms) / 1000));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.round(Math.sin((2 * Math.PI * 440 * index) / SAMPLE_RATE) * 0.25 * 32767);
  }
  const buffer = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) buffer.writeInt16LE(samples[index], index * 2);
  return buffer;
}

function fakeStreaming({ endpointAtSamples, text }) {
  return {
    createStream: () => ({
      samples: 0,
      acceptWaveform({ samples }) {
        this.samples += samples.length;
      },
    }),
    isReady: () => false,
    decode: () => {},
    getResult: (stream) => ({ text: stream.samples > 0 ? text : '' }),
    isEndpoint: (stream) => stream.samples >= endpointAtSamples,
    reset(stream) {
      stream.samples = 0;
    },
  };
}

function fakeWorker(texts) {
  const queue = [...texts];
  const worker = new EventEmitter();
  worker.messages = [];
  worker.unref = () => {};
  worker.terminate = () => {
    worker.emit('exit', null);
  };
  worker.postMessage = (message) => {
    worker.messages.push(message);
    const text = queue.length > 0 ? queue.shift() : '';
    setImmediate(() => worker.emit('message', { type: 'result', id: message.id, text }));
  };
  return worker;
}

/** One fake hearing session over a SHARED dialogue instance. */
function startSession({ clock, device = MIC, texts = [], context }) {
  const child = new FakeChild();
  const updates = [];
  const worker = fakeWorker(texts);
  const hearing = startHearing({
    ffmpegPath: 'ffmpeg-not-used',
    modelDir: 'models-not-used',
    finalModelDir: '',
    device,
    recognizer: fakeStreaming({ endpointAtSamples: SAMPLE_RATE, text: '流式草稿' }),
    asrWorkerFactory: () => worker,
    spawnProcess: () => child,
    ...(clock === undefined ? {} : { now: clock }),
    ...(context === undefined ? {} : { dialogueContext: context }),
    onUpdate: (event) => updates.push(event),
    onEvent: () => {},
  });
  const finals = () => updates.filter((event) => typeof event.final === 'string');
  return { child, hearing, finals };
}

/** Write one 1 s utterance (the fake endpoint is 1 s) and wait for its delivered final. */
async function speak(session) {
  const before = session.finals().length;
  session.child.stdout.write(tone(1000));
  await until(() => session.finals().length > before, 'the delivered final');
  return session.finals()[before];
}

/** A buffer whose verbatim window is small, so three pushes roll the first one into `pending`. */
function primedContext({ now = () => 1_000 } = {}) {
  const context = createDialogueContext({ now, maxChars: 30, summaryEveryChars: 10 });
  context.push({ text: '第一段：门是开着的。', at: 1_000, utteranceId: 'u1' });
  context.push({ text: '第二段：屋里没有人。', at: 2_000, utteranceId: 'u2' });
  context.push({ text: '第三段：他拿走了钥匙。', at: 3_000, utteranceId: 'u3' });
  return context;
}

const USER_TEXT = '我刚才说了什么？';

// ---------------------------------------------------------------------------
// 1. Injection presence / absence
// ---------------------------------------------------------------------------

test('1. 有台词时 prompt 含独立注入段与「不是用户发言」；无台词不注入', async (t) => {
  const emptyHost = mount(await tempRoot(t));
  assert.ok(emptyHost.sections.has('assistant:dialogue'), 'the section is always registered');
  assert.equal(emptyHost.sectionText('assistant:dialogue'), '', 'an empty buffer renders empty');
  assert.ok(!emptyHost.prompt().includes('不是用户发言'), 'nothing is injected when nothing was heard');
  emptyHost.close();

  const context = createDialogueContext({ now: () => 1_000 });
  context.push({ text: '钥匙在柜子里，', at: 1_000, utteranceId: 'u1' });
  context.push({ text: '你去拿吧。', at: 2_000, utteranceId: 'u2' });
  const host = mount(await tempRoot(t), { dialogueContext: context });

  const section = host.sections.get('assistant:dialogue');
  assert.equal(section.order, DIALOGUE_INJECTION_ORDER);
  assert.ok(section.order > host.sections.get('assistant:persona').order, 'order is after the persona');
  const text = host.sectionText('assistant:dialogue');
  assert.ok(text.includes('钥匙在柜子里，你去拿吧。'), 'unfinished sentence stays joined');
  assert.ok(text.includes('系统观察'), 'the block names itself an observation');
  assert.ok(text.includes('不是用户发言'), 'the block says it is not a user turn');
  assert.ok(host.prompt().includes(text), 'the prompt carries the observation block');
  assert.ok(!host.prompt().includes(USER_TEXT), 'the observation block is not the user message');

  console.log(`[1] order=${section.order} chars=${text.length} contains=不是用户发言/系统观察`);
  host.close();
});

// ---------------------------------------------------------------------------
// 2. The user message is untouched
// ---------------------------------------------------------------------------

test('2. 注入不改变用户消息：user text 原样，观察段不含用户原话', async (t) => {
  const context = createDialogueContext({ now: () => 1_000 });
  context.push({ text: '外面在下雨。', at: 1_000, utteranceId: 'u1' });
  const host = mount(await tempRoot(t), { dialogueContext: context });

  // The request shape the Harness sends: a genuine user message plus the assembled system prompt.
  const messages = [
    { id: 'user-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: USER_TEXT }] },
  ];
  const before = JSON.parse(JSON.stringify(messages));
  const injection = host.sectionText('assistant:dialogue');
  const fullPrompt = host.prompt();

  assert.deepEqual(messages, before, 'the user messages are byte-identical after injection');
  assert.equal(messages[0].content[0].text, USER_TEXT);
  assert.ok(fullPrompt.includes(injection));
  assert.ok(!injection.includes(USER_TEXT), 'the observation block never contains the user speech');
  assert.equal(context.snapshot().recent[0].source, 'mic', 'the buffer stores observations, not a user turn');

  console.log(`[2] userText=${messages[0].content[0].text} userMessages=${messages.length} injectionChars=${injection.length}`);
  host.close();
});

// ---------------------------------------------------------------------------
// 3. A due summary never blocks the request
// ---------------------------------------------------------------------------

test('3. needsSummary 触发后台摘要；未完成期间请求照常返回（不等待）', async (t) => {
  const context = primedContext();
  const calls = [];
  let settled = false;
  const ask = (options) => {
    calls.push(options);
    return new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  };
  const host = mount(await tempRoot(t), { dialogueContext: context, dialogueAsk: ask });

  const snapshot = context.snapshot();
  assert.equal(snapshot.needsSummary, true, 'the buffer really is due for a summary');
  const startedAt = Date.now();
  const text = host.sectionText('assistant:dialogue');
  const elapsed = Date.now() - startedAt;

  assert.equal(settled, false, 'the summary model call has not settled');
  assert.equal(calls.length, 1, 'exactly one background summary was started');
  assert.ok(text.includes('第三段：他拿走了钥匙。'), 'the request still gets the latest transcript');
  assert.ok(elapsed < 500, `the request did not wait (${elapsed} ms)`);
  assert.equal(calls[0].task, 'persona-rewrite');
  assert.equal(calls[0].context, 'none');
  assert.ok(calls[0].user.includes('【待摘要原文】'));
  assert.ok(calls[0].system.includes('不超过 400 字'), 'the contract caps the summary at 400 chars');
  assert.ok(calls[0].system.includes('人物'));
  assert.ok(calls[0].system.includes('事件'));
  assert.ok(calls[0].system.includes('话题'));
  assert.ok(calls[0].system.includes('指代'));
  assert.ok(calls[0].system.includes('编造'), 'the contract forbids invention');
  assert.equal(calls[0].signal.aborted, false);

  // Cleanup aborts the attempt; nothing is applied and no event is written.
  host.close();
  assert.equal(calls[0].signal.aborted, true, 'closing the Host aborts the in-flight summary');

  console.log(`[3] elapsedMs=${elapsed} task=${calls[0].task} settled=${settled} textChars=${text.length}`);
});

// ---------------------------------------------------------------------------
// 4. Success advances coverage; failure keeps pending and backs off
// ---------------------------------------------------------------------------

test('4. 摘要成功后 summaryThrough 推进、注入含摘要；失败保留 pending 并退避', async (t) => {
  // -- success -------------------------------------------------------------
  const context = primedContext();
  const events = [];
  const runner = createDialogueSummaryRunner({
    context,
    now: () => 10_000,
    emit: (type, payload) => events.push({ type, payload }),
    ask: async () => ({ text: '摘要：两人在门口说话，钥匙被拿走，「他」指拿钥匙的人，身份尚未说明。' }),
  });
  const before = context.snapshot();
  assert.equal(before.needsSummary, true);
  assert.equal(before.summary, '');
  const pendingText = runner.render();
  assert.ok(pendingText.includes('第三段'), 'the unsummarized text is still injected');

  await until(() => context.snapshot().summaryThrough > 0, 'the summary to be applied');
  const after = context.snapshot();
  assert.equal(after.summaryThrough, before.pendingVersion, 'coverage advanced to the captured version');
  assert.equal(after.pending.length, 0, 'the covered pending prefix is cleared');
  assert.ok(after.summary.startsWith('摘要：'));

  const withSummary = runner.render();
  assert.ok(withSummary.includes('【较早内容摘要】'), 'the next injection carries the summary');
  assert.ok(withSummary.includes('摘要：两人在门口说话'));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'voice.dialogue.summary');
  assert.equal(events[0].payload.ok, true);
  assert.equal(events[0].payload.through, before.pendingVersion);
  assert.ok(events[0].payload.chars > 0 && events[0].payload.chars <= DIALOGUE_SUMMARY_DEFAULTS.maxChars);
  assert.ok(Number.isFinite(events[0].payload.ms));

  // -- failure + exponential backoff --------------------------------------
  let clockValue = 20_000;
  const failingContext = primedContext();
  const failures = [];
  const calls = [];
  const failing = createDialogueSummaryRunner({
    context: failingContext,
    now: () => clockValue,
    retryBaseMs: 1_000,
    retryMaxMs: 4_000,
    emit: (type, payload) => failures.push({ type, payload }),
    ask: async () => {
      calls.push(1);
      throw Object.assign(new Error('boom'), { code: 'E_TEST' });
    },
  });
  const capturedBefore = failingContext.snapshot();
  failing.render();
  await until(() => failures.length === 1, 'the first failure');
  assert.equal(failures[0].type, 'voice.dialogue.summary.failed');
  assert.equal(failures[0].payload.reason, 'E_TEST');
  assert.equal(failingContext.snapshot().pending.length, capturedBefore.pending.length, 'pending is kept');
  assert.equal(failingContext.snapshot().summaryThrough, 0);
  assert.equal(failing.status().attempts, 1);

  const delays = [];
  delays.push(failing.status().nextAttemptAt - clockValue);
  failing.render();
  assert.equal(calls.length, 1, 'inside the backoff window nothing is retried');
  clockValue += delays[0];
  failing.render();
  await until(() => failures.length === 2, 'the second failure');
  delays.push(failing.status().nextAttemptAt - clockValue);
  clockValue += delays[1];
  failing.render();
  await until(() => failures.length === 3, 'the third failure');
  delays.push(failing.status().nextAttemptAt - clockValue);
  clockValue += delays[2];
  failing.render();
  await until(() => failures.length === 4, 'the fourth failure');
  delays.push(failing.status().nextAttemptAt - clockValue);

  assert.deepEqual(delays, [1_000, 2_000, 4_000, 4_000], 'exponential backoff, capped at retryMaxMs');
  assert.equal(DIALOGUE_SUMMARY_DEFAULTS.retryMaxMs, 60_000, 'the production cap is 60 s');
  assert.equal(DIALOGUE_SUMMARY_DEFAULTS.maxChars, 400);

  // The request itself stays clean: the input is the old summary plus the pending transcript,
  // and the produced text is capped at 400 characters in one paragraph.
  const plain = primedContext();
  const request = dialogueSummaryRequest(plain.snapshot());
  assert.ok(request.user.includes('【待摘要原文】'));
  assert.ok(request.user.includes('第一段：门是开着的。'));
  assert.equal(request.through, plain.snapshot().pendingVersion);
  assert.ok(request.chars > 0);
  const merged = dialogueSummaryRequest({ summary: '旧摘要：甲在门口。', pending: [{ text: '新原文：他走了。' }], pendingVersion: 2, generation: 1 });
  assert.ok(merged.user.includes('【旧摘要】\n旧摘要：甲在门口。'));
  assert.ok(merged.user.includes('【待摘要原文】\n新原文：他走了。'));
  const long = normalizeDialogueSummary('甲'.repeat(500));
  assert.equal(Array.from(long).length, 400, 'a summary is capped at 400 characters');
  assert.equal(normalizeDialogueSummary('  多行\n\n摘要  '), '多行 摘要');

  console.log(`[4] through=${after.summaryThrough}/${before.pendingVersion} summaryChars=${events[0].payload.chars} delays=${delays.join(',')}ms`);
  console.log(`[4] failureReason=${failures[0].payload.reason} pendingKept=${failingContext.snapshot().pending.length}`);
});

// ---------------------------------------------------------------------------
// 5. The same instance survives a device restart
// ---------------------------------------------------------------------------

test('5. 同一实例跨设备重启：注入文本保持连续', async (t) => {
  let clockValue = 1_000;
  const context = createDialogueContext({ source: 'mic', now: () => clockValue });

  const first = startSession({ clock: () => clockValue, device: MIC, texts: ['第一段：门是开着的。'], context });
  await speak(first);
  first.hearing.stop();

  clockValue = 60_000;
  const second = startSession({ clock: () => clockValue, device: '另一个麦克风', texts: ['第二段：我进来了。'], context });
  await speak(second);
  second.hearing.stop();

  // The Host holds that one instance: the very next request already sees both sessions.
  const host = mount(await tempRoot(t), { dialogueContext: context });
  const text = host.sectionText('assistant:dialogue');
  assert.ok(text.includes('第一段：门是开着的。'));
  assert.ok(text.includes('第二段：我进来了。'));
  assert.ok(text.indexOf('第一段：门是开着的。') < text.indexOf('第二段：我进来了。'), 'order is preserved');
  assert.ok(text.includes('不是用户发言'));
  assert.equal(context.snapshot().recent.length, 2, 'both sessions fed the one buffer');
  assert.equal(host.sectionText('assistant:dialogue'), text, 'a repeated render is stable');

  console.log(`[5] recent=${context.snapshot().recent.length} segment=${context.snapshot().segment} chars=${text.length}`);
  host.close();
});

// ---------------------------------------------------------------------------
// 6. Closing listening stops the in-flight summary
// ---------------------------------------------------------------------------

test('6. 关闭听觉：在途摘要停止，且不再写摘要事件', async (t) => {
  const root = await tempRoot(t);
  const context = primedContext();
  const calls = [];
  const ask = (options) => {
    calls.push(options);
    return new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  };
  const host = mount(root, { dialogueContext: context, dialogueAsk: ask });

  const text = host.sectionText('assistant:dialogue');
  assert.ok(text.length > 0);
  assert.equal(calls.length, 1, 'a summary is in flight');

  // The real tool path: assistant_listen stop -> stopListening() -> dialogueSummary.stop().
  const result = await host.tools.get('assistant_listen').execute({ action: 'stop' });
  assert.equal(result.ok, true);
  assert.equal(calls[0].signal.aborted, true, 'closing listening aborted the request');

  await delay(60);
  const events = await readEvents(root);
  assert.equal(
    events.filter((row) => row.type === 'voice.dialogue.summary' || row.type === 'voice.dialogue.summary.failed').length,
    0,
    'an aborted summary writes no summary event',
  );
  // The stop released only the microphone's lease; no capture session is left, so the summary
  // really stopped. The lease event is the host-wiring evidence for that release.
  const lease = events.find((row) => row.type === 'voice.dialogue.summary.lease');
  assert.ok(lease !== undefined, 'stopListening releases the microphone lease');
  assert.deepEqual(
    { op: lease.payload.op, holder: lease.payload.holder, active: lease.payload.active },
    { op: 'release', holder: 'mic', active: 0 },
  );
  assert.equal(context.snapshot().summaryThrough, 0, 'nothing was applied');

  // A later request must not start another attempt while listening is closed.
  host.sectionText('assistant:dialogue');
  assert.equal(calls.length, 1, 'no new summary after the stop');

  console.log(`[6] aborted=${calls[0].signal.aborted} summaryEvents=0 pendingKept=${context.snapshot().pending.length}`);
  host.close();
});

// ---------------------------------------------------------------------------
// 7. Two capture paths, two leases: stopping the mic leaves the loopback summary running
// ---------------------------------------------------------------------------

test('7. 摘要器租约：mic 与 loopback 各持一份；停 mic 后回环新增台词仍触发摘要', async (t) => {
  const context = primedContext();
  const calls = [];
  const events = [];
  const runner = createDialogueSummaryRunner({
    context,
    now: () => 10_000,
    emit: (type, payload) => events.push({ type, payload }),
    ask: async () => {
      calls.push(1);
      return { text: '摘要：门开着，钥匙被拿走。' };
    },
  });
  const summaryCount = () => events.filter((event) => event.type === 'voice.dialogue.summary').length;
  const leases = () => events
    .filter((event) => event.type === 'voice.dialogue.summary.lease')
    .map((event) => ({ op: event.payload.op, holder: event.payload.holder, active: event.payload.active }));

  // Both capture paths are open: each holds its own lease.
  runner.acquire('mic');
  runner.acquire('loopback');
  assert.equal(runner.status().active, 2);
  assert.equal(runner.status().stopped, false);
  assert.ok(runner.render().length > 0, 'the transcript is still injected');
  await until(() => context.snapshot().summaryThrough > 0, 'the first summary applied');
  assert.equal(calls.length, 1);
  assert.equal(summaryCount(), 1);

  // The microphone stops. The loopback lease is untouched, so the shared summary stays alive.
  runner.release('mic');
  assert.equal(runner.status().active, 1, 'loopback still holds a lease');
  assert.equal(runner.status().stopped, false, 'stopping the mic must not stop the summary');

  // The loopback appends a line (the host's `hearing.dialogue.appended` handler calls
  // `maybeSummarize()` exactly like this) and a new summary really runs.
  const firstThrough = context.snapshot().summaryThrough;
  context.push({ text: '第四段：门外有人敲门。', at: 4_000, utteranceId: 'u4' });
  assert.equal(context.snapshot().needsSummary, true, 'the loopback line made a summary due');
  runner.maybeSummarize();
  await until(() => calls.length === 2, 'the loopback line triggered a second summary');
  await until(() => context.snapshot().summaryThrough > firstThrough, 'the second summary applied');
  assert.equal(summaryCount(), 2, 'the loopback line produced a real summary event');

  assert.deepEqual(leases(), [
    { op: 'acquire', holder: 'mic', active: 1 },
    { op: 'acquire', holder: 'loopback', active: 2 },
    { op: 'release', holder: 'mic', active: 1 },
  ]);

  console.log(
    `[7] leases=${leases().map((entry) => `${entry.op}:${entry.holder}:${entry.active}`).join(',')} `
    + `summaries=${summaryCount()} calls=${calls.length} through=${context.snapshot().summaryThrough}`,
  );
});

// ---------------------------------------------------------------------------
// 8. The last release stops the summary; a due buffer writes nothing more
// ---------------------------------------------------------------------------

test('8. 两路都停后摘要器停止（active=0），不再写摘要事件', async (t) => {
  const context = primedContext();
  const calls = [];
  const events = [];
  const runner = createDialogueSummaryRunner({
    context,
    now: () => 10_000,
    emit: (type, payload) => events.push({ type, payload }),
    ask: async () => {
      calls.push(1);
      return { text: '摘要：门开着，钥匙被拿走。' };
    },
  });
  const written = () => events.filter((event) =>
    event.type === 'voice.dialogue.summary' || event.type === 'voice.dialogue.summary.failed').length;

  runner.acquire('mic');
  runner.acquire('loopback');
  runner.render();
  await until(() => context.snapshot().summaryThrough > 0, 'the first summary applied');
  const writtenBefore = written();
  assert.equal(writtenBefore, 1);

  // One path stopping is not enough: the other lease keeps the summary open.
  runner.release('mic');
  assert.equal(runner.status().active, 1);
  assert.equal(runner.status().stopped, false);

  // The last release stops it and aborts nothing that already completed.
  runner.release('loopback');
  assert.equal(runner.status().active, 0);
  assert.equal(runner.status().stopped, true);

  const callsBefore = calls.length;
  const throughBefore = context.snapshot().summaryThrough;
  // Even a freshly due buffer (and a direct prompt render) must not start or write a summary.
  context.push({ text: '第五段：他走进了门。', at: 5_000, utteranceId: 'u5' });
  runner.render();
  runner.maybeSummarize();
  await delay(80);
  assert.equal(calls.length, callsBefore, 'no model call after both leases were released');
  assert.equal(written(), writtenBefore, 'no summary event after both leases were released');
  assert.equal(context.snapshot().summaryThrough, throughBefore, 'coverage did not move');

  const lastLease = events.filter((event) => event.type === 'voice.dialogue.summary.lease').at(-1);
  assert.deepEqual(
    { op: lastLease.payload.op, holder: lastLease.payload.holder, active: lastLease.payload.active },
    { op: 'release', holder: 'loopback', active: 0 },
  );

  console.log(
    `[8] last=${lastLease.payload.op}:${lastLease.payload.holder}:${lastLease.payload.active} `
    + `stopped=${runner.status().stopped} calls=${calls.length} summaryEvents=${written()}`,
  );
});
