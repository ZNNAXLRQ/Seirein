/**
 * Cancellation is per USE, not per shared in-flight request.
 *
 * A subtitle and a speech line of the same sentence, same target language and same required form
 * share ONE model call. The bug: when the subtitle (the owner) was cancelled, every joiner was
 * settled with `TRANSLATE_CANCELLED` too — the speech line was cancelled although its own signal
 * was alive. These tests pin the fix:
 *
 *   1. subtitle owns, speech joins -> cancel subtitle  -> speech still returns its translation
 *   2. speech owns, subtitle joins -> cancel speech    -> subtitle still returns its translation
 *   3. both cancel                -> the request really cancels, no cache row, no rejection
 *   4. the takeover result equals a standalone call with the same text/language, and is cached
 *   5. owner succeeds -> the joiner reuses the ONE result and the model is called once (regression)
 *   6. priority: the voice waiter takes over even when a subtitle waiter joined first
 *
 * Run: node --test test/translate-share-cancel.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createTranslator, createTranslationCache } from '../src/host/speech/translate.js';

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

const waitUntil = async (check, message, timeoutMs = 2000) => {
  const startedAt = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out: ${message}`);
    await tick(2);
  }
};

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

/** Reject when the caller's own signal fires; never settles otherwise (used inside a race). */
const aborted = (signal) => new Promise((_, reject) => {
  const fail = () => reject(signal.reason ?? new Error('aborted'));
  if (signal?.aborted === true) { fail(); return; }
  signal?.addEventListener?.('abort', fail, { once: true });
});

const TEXT = '今天天气很好。';
const SUBTITLE_JA = '今日はいい天気ですね。';      // normal Japanese writing (the subtitle form)
const SPEECH_JA = 'きょう は いい おてんき です ね。'; // the speech answer of the same sentence

/**
 * The channel answers per PURPOSE (`input.purpose`), so a takeover is visible: if the speech
 * caller inherited the subtitle's request, the second model call would still carry
 * `purpose:'subtitle'`. `hold` keeps the first call in flight so a cancel lands while it runs.
 * `jaSpeechScript:'mixed'` makes the two purposes require the SAME form — the only case in which
 * they share one request; with a kana script the two share keys differ by design.
 */
function harness({ hold = null } = {}) {
  const calls = [];
  const events = [];
  const translator = createTranslator({
    cache: createTranslationCache(),
    jaSpeechScript: 'mixed',
    onEvent: (type, payload) => events.push({ type, ...payload }),
    channel: {
      async ask({ input, signal }) {
        calls.push({ purpose: input.purpose, text: input.text });
        if (hold !== null) await Promise.race([hold.promise, aborted(signal)]);
        if (signal?.aborted) throw signal.reason ?? new Error('aborted');
        return {
          text: input.purpose === 'subtitle' ? SUBTITLE_JA : SPEECH_JA,
          complete: true,
          finishKind: 'stop',
        };
      },
    },
    request: async () => { throw new Error('the channel owns the prompt; request must not run'); },
  });
  return { translator, calls, events };
}

test('1. subtitle first, speech shares: cancelling the subtitle leaves the speech line alive', async () => {
  const hold = deferred();
  const { translator, calls, events } = harness({ hold });
  const subtitleTurn = new AbortController();
  const subtitlePromise = translator.translate(TEXT, {
    from: 'zh', to: 'ja', purpose: 'subtitle', signal: subtitleTurn.signal,
  });
  await waitUntil(() => calls.length === 1, 'the subtitle owner reached the model');

  const speechPromise = translator.translate(TEXT, { from: 'zh', to: 'ja', purpose: 'speech' });
  await tick(0);
  assert.equal(calls.length, 1, 'the speech line joined the in-flight request instead of starting one');

  // The subtitle overlay is hidden: only the subtitle purpose is cancelled.
  subtitleTurn.abort(new Error('subtitle overlay hidden'));
  hold.resolve();
  const [subtitle, speech] = await Promise.all([subtitlePromise, speechPromise]);

  assert.equal(subtitle.ok, false);
  assert.equal(subtitle.code, 'TRANSLATE_CANCELLED', 'the cancelled subtitle stays cancelled');
  assert.equal(speech.ok, true, 'the speech line is NOT cancelled with the subtitle');
  assert.notEqual(speech.code, 'TRANSLATE_CANCELLED');
  assert.equal(speech.text, SPEECH_JA, 'the takeover ran the SPEECH purpose, not the subtitle one');
  assert.equal(speech.reused, undefined, 'the re-issued request is not a reuse of a dead owner');
  assert.equal(calls.length, 2, 'the speech waiter re-issued the one shared request');
  assert.equal(calls[1].purpose, 'speech', 'the second call carries the speech purpose');

  const reowner = events.find((event) => event.type === 'translate.share.reowner');
  assert.ok(reowner, 'the hand-over is reported');
  assert.deepEqual({ from: reowner.from, to: reowner.to }, { from: 'zh', to: 'ja' });
  assert.equal(
    events.some((event) => event.type === 'translate.share.cancelled'),
    false,
    'one purpose cancelling is not the shared request cancelling',
  );
  console.log(`1) subtitle=${subtitle.code} speech={ok:${speech.ok},text:${speech.text},reused:${speech.reused}} calls=${calls.length} call2Purpose=${calls[1].purpose} reowner=${reowner.from}->${reowner.to} shareCancelled=0`);
});

test('2. speech first, subtitle shares: cancelling the speech leaves the subtitle line alive', async () => {
  const hold = deferred();
  const { translator, calls, events } = harness({ hold });
  const speechTurn = new AbortController();
  const speechPromise = translator.translate(TEXT, {
    from: 'zh', to: 'ja', purpose: 'speech', signal: speechTurn.signal,
  });
  await waitUntil(() => calls.length === 1, 'the speech owner reached the model');

  const subtitlePromise = translator.translate(TEXT, { from: 'zh', to: 'ja', purpose: 'subtitle' });
  await tick(0);
  assert.equal(calls.length, 1, 'the subtitle joined the in-flight speech request');

  speechTurn.abort(new Error('turn interrupted'));
  hold.resolve();
  const [speech, subtitle] = await Promise.all([speechPromise, subtitlePromise]);

  assert.equal(speech.code, 'TRANSLATE_CANCELLED', 'the cancelled speech stays cancelled');
  assert.equal(subtitle.ok, true, 'the subtitle is NOT cancelled with the speech');
  assert.equal(subtitle.text, SUBTITLE_JA, 'the takeover ran the SUBTITLE purpose');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].purpose, 'subtitle', 'the second call carries the subtitle purpose');
  const reowner = events.find((event) => event.type === 'translate.share.reowner');
  assert.ok(reowner, 'the hand-over is reported');
  assert.equal(events.some((event) => event.type === 'translate.share.cancelled'), false);
  console.log(`2) speech=${speech.code} subtitle={ok:${subtitle.ok},text:${subtitle.text}} calls=${calls.length} call2Purpose=${calls[1].purpose} reowner=1 shareCancelled=0`);
});

test('3. both purposes cancel: the shared request really cancels, no cache row, no rejection', async () => {
  const hold = deferred();
  const { translator, calls, events } = harness({ hold });
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const subtitleTurn = new AbortController();
    const speechTurn = new AbortController();
    const subtitlePromise = translator.translate(TEXT, {
      from: 'zh', to: 'ja', purpose: 'subtitle', signal: subtitleTurn.signal,
    });
    await waitUntil(() => calls.length === 1, 'the subtitle owner reached the model');
    const speechPromise = translator.translate(TEXT, {
      from: 'zh', to: 'ja', purpose: 'speech', signal: speechTurn.signal,
    });
    await tick(0);

    subtitleTurn.abort(new Error('subtitle hidden'));
    speechTurn.abort(new Error('turn interrupted'));
    hold.resolve();
    const [subtitle, speech] = await Promise.all([subtitlePromise, speechPromise]);

    assert.equal(subtitle.code, 'TRANSLATE_CANCELLED');
    assert.equal(speech.code, 'TRANSLATE_CANCELLED');
    assert.equal(calls.length, 1, 'both waiters gone: no orphan request is started');
    assert.equal(translator.cache.size, 0, 'a cancelled request writes no cache row');
    assert.deepEqual(translator.stats(), { active: 0, peak: 1, max: 3 }, 'no slot or task is left behind');
    const cancelled = events.find((event) => event.type === 'translate.share.cancelled');
    assert.ok(cancelled, 'the real cancellation is reported');
    assert.equal(cancelled.waiters, 1, 'the one waiter was cancelled too');
    assert.equal(
      events.some((event) => event.type === 'translate.share.reowner'),
      false,
      'nobody is left to take the request over',
    );
    await tick(20);
    assert.deepEqual(unhandled, [], 'no unhandled rejection escapes the cancellation');
    console.log(`3) subtitle=${subtitle.code} speech=${speech.code} calls=${calls.length} cacheSize=${translator.cache.size} active=${translator.stats().active} shareCancelledWaiters=${cancelled.waiters} reowner=0 unhandled=${unhandled.length}`);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('4. the takeover returns exactly what a standalone call returns, and caches it', async () => {
  const standaloneCalls = [];
  const standalone = harness({}).translator;
  const expected = await standalone.translate(TEXT, { from: 'zh', to: 'ja', purpose: 'speech' });
  assert.equal(expected.ok, true);
  assert.equal(expected.text, SPEECH_JA);

  const hold = deferred();
  const { translator, calls } = harness({ hold });
  const subtitleTurn = new AbortController();
  const subtitlePromise = translator.translate(TEXT, {
    from: 'zh', to: 'ja', purpose: 'subtitle', signal: subtitleTurn.signal,
  });
  await waitUntil(() => calls.length === 1, 'the subtitle owner reached the model');
  const speechPromise = translator.translate(TEXT, { from: 'zh', to: 'ja', purpose: 'speech' });
  await tick(0);
  subtitleTurn.abort(new Error('subtitle hidden'));
  hold.resolve();
  const [subtitle, speech] = await Promise.all([subtitlePromise, speechPromise]);
  assert.equal(subtitle.code, 'TRANSLATE_CANCELLED');
  assert.equal(speech.ok, true);
  assert.equal(speech.text, expected.text, 'the takeover matches the standalone translation');
  assert.equal(speech.text, SPEECH_JA);
  assert.equal(standaloneCalls.length, 0, 'the standalone call used its own channel');

  // The takeover wrote the speech purpose's row: the next line of the same sentence is a hit.
  const again = await translator.translate(TEXT, { from: 'zh', to: 'ja', purpose: 'speech' });
  assert.equal(again.cached, true, 'the takeover result is cached under the speech purpose');
  assert.equal(again.text, speech.text);
  assert.equal(calls.length, 2, 'the cache hit never reaches the model');
  console.log(`4) takeoverText=${speech.text} standaloneText=${expected.text} equal=${speech.text === expected.text} cachedAgain=${again.cached} calls=${calls.length}`);
});

test('6. priority: the voice waiter takes over even when the subtitle waiter joined first', async () => {
  const hold = deferred();
  const { translator, calls, events } = harness({ hold });
  const subtitleTurn = new AbortController();
  const owner = translator.translate(TEXT, {
    from: 'zh', to: 'ja', purpose: 'subtitle', signal: subtitleTurn.signal,
  });
  await waitUntil(() => calls.length === 1, 'the subtitle owner reached the model');
  // The subtitle waiter arrives BEFORE the voice waiter.
  const subtitleLater = translator.translate(TEXT, { from: 'zh', to: 'ja', purpose: 'subtitle' });
  const speech = translator.translate(TEXT, { from: 'zh', to: 'ja', purpose: 'speech' });
  await tick(0);

  subtitleTurn.abort(new Error('subtitle hidden'));
  hold.resolve();
  const [cancelledOwner, subtitleResult, speechResult] = await Promise.all([owner, subtitleLater, speech]);

  assert.equal(cancelledOwner.code, 'TRANSLATE_CANCELLED');
  assert.equal(calls.length, 2, 'the voice waiter re-issued once; the subtitle waiter was adopted');
  assert.equal(calls[1].purpose, 'speech', 'voice outranks subtitle for the takeover');
  assert.equal(speechResult.ok, true, 'the voice line completes');
  assert.equal(speechResult.text, SPEECH_JA);
  assert.equal(subtitleResult.ok, true, 'the adopted subtitle still gets its line');
  assert.equal(subtitleResult.reused, true, 'it reuses the one shared result');
  assert.equal(subtitleResult.text, SPEECH_JA);
  assert.equal(events.filter((event) => event.type === 'translate.share.reowner').length, 1);
  assert.equal(events.some((event) => event.type === 'translate.share.cancelled'), false);
  console.log(`6) order=cancelledOwner,subtitleLater,speech call2Purpose=${calls[1].purpose} speech={ok:${speechResult.ok},text:${speechResult.text}} subtitle={ok:${subtitleResult.ok},reused:${subtitleResult.reused}} calls=${calls.length} reowner=1`);
});

test('5. owner succeeds: the joiner reuses the one result and the model is called once', async () => {
  const hold = deferred();
  const { translator, calls, events } = harness({ hold });
  const subtitlePromise = translator.translate(TEXT, { from: 'zh', to: 'ja', purpose: 'subtitle' });
  await waitUntil(() => calls.length === 1, 'the subtitle owner reached the model');
  const speechPromise = translator.translate(TEXT, { from: 'zh', to: 'ja', purpose: 'speech' });
  await tick(0);
  hold.resolve();
  const [subtitle, speech] = await Promise.all([subtitlePromise, speechPromise]);

  assert.equal(subtitle.ok, true);
  assert.equal(speech.ok, true);
  assert.equal(speech.reused, true, 'the joiner reuses the owner result');
  assert.equal(speech.text, SUBTITLE_JA, 'the shared result is the one text both purposes need');
  assert.equal(calls.length, 1, 'one shared in-flight request, one model call');
  assert.equal(translator.cache.size, 2, 'the shared text is cached under both purpose keys');
  const shared = events.find((event) => event.type === 'voice.translate.shared');
  assert.ok(shared, 'the reuse is reported');
  assert.equal(shared.purpose, 'speech');
  assert.equal(events.some((event) => event.type === 'translate.share.reowner'), false);
  console.log(`5) subtitle={ok:${subtitle.ok},text:${subtitle.text}} speech={ok:${speech.ok},text:${speech.text},reused:${speech.reused}} calls=${calls.length} cacheSize=${translator.cache.size} sharedPurpose=${shared.purpose}`);
});
