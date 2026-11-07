/**
 * Spout info-log throttling.
 *
 * The texture loop used to produce two `spoutLayer.info` lines per frame, which at 10 MB per
 * rotation left only ~40 minutes of speech/memory/tool timing in `events.jsonl`. These cases pin
 * the replacement contract:
 *   1. 100 identical info lines → 1 recorded line (the other 99 counted, not written);
 *   2. a changed message is recorded immediately;
 *   3. after the window the same message is recorded again and carries the suppressed count;
 *   4. `error` lines are never suppressed;
 *   5. info lines that report a failure are never suppressed either;
 *   6. the layer process applies the same coalescing to its own stdout before the host sees it.
 *
 * Run: node --test test/spout-info-throttle.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { INFO_THROTTLE_MS, SpoutLayer } from '../src/host/avatar/spoutLayer.js';

const require = createRequire(import.meta.url);
const {
  INFO_THROTTLE_MS: LAYER_THROTTLE_MS,
  resetInfoThrottle,
  throttleInfo,
} = require('../src/host/avatar/spout-layer/main.js');

/** EventLog stand-in: records every event synchronously so a `void emitEvent` is observable. */
function createLog() {
  const events = [];
  return {
    events,
    emit(type, payload) {
      events.push({ type, payload });
    },
    of(type) {
      return events.filter((event) => event.type === type);
    },
  };
}

function createLayer(infoThrottleMs) {
  const log = createLog();
  const layer = new SpoutLayer({
    root: 'C:\\tmp\\spout-info-throttle',
    settings: () => ({ electronExecutable: 'C:\\tmp\\electron.exe' }),
    log,
    infoThrottleMs,
  });
  return { layer, log };
}

const infoLine = (message, extra = {}) => JSON.stringify({ type: 'info', message, ...extra });

test('100 identical info line → 1 spoutLayer.info, 99 coalesced', () => {
  const { layer, log } = createLayer(60_000);
  for (let i = 0; i < 100; i += 1) layer.handleLine(infoLine('shared texture delivered', { ms: i }));

  const infos = log.of('spoutLayer.info');
  assert.equal(infos.length, 1, 'only the first of 100 identical status lines is written');
  assert.equal(infos[0].payload.message, 'shared texture delivered');
  assert.equal(infos[0].payload.throttled, 0);
  assert.equal(layer.infoThrottled, 99, 'the other 99 repeats are counted');
  assert.equal(layer.snapshot().infoThrottled, 99, 'the count is visible in the status snapshot');
  assert.equal(infos[0].type, 'spoutLayer.info', 'the event type name is unchanged');
});

test('changed content is recorded immediately', () => {
  const { layer, log } = createLayer(60_000);
  for (let i = 0; i < 50; i += 1) layer.handleLine(infoLine('shared texture delivered'));
  layer.handleLine(infoLine('source size changed', { width: 978, height: 844 }));

  const infos = log.of('spoutLayer.info');
  assert.equal(infos.length, 2);
  assert.deepEqual(infos.map((event) => event.payload.message), [
    'shared texture delivered',
    'source size changed',
  ]);
  assert.equal(layer.infoThrottled, 49);
});

test('after the window the message is written again and carries the throttled count', async () => {
  const { layer, log } = createLayer(30);
  for (let i = 0; i < 100; i += 1) layer.handleLine(infoLine('shared texture delivered'));
  assert.equal(log.of('spoutLayer.info').length, 1);

  await new Promise((resolvePromise) => setTimeout(resolvePromise, 40));
  layer.handleLine(infoLine('shared texture delivered'));

  const infos = log.of('spoutLayer.info');
  assert.equal(infos.length, 2, 'a window boundary lets the line through');
  assert.equal(infos[1].payload.throttled, 99, 'the next line reports what was suppressed');
  assert.equal(infos[1].payload.message, 'shared texture delivered');
  assert.equal(layer.infoThrottled, 99, 'the cumulative count does not double-count the summary');
});

test('the host keeps the child-reported throttled count', () => {
  const { layer, log } = createLayer(60_000);
  layer.handleLine(infoLine('shared texture delivered', { throttled: 3599 }));
  const infos = log.of('spoutLayer.info');
  assert.equal(infos.length, 1);
  assert.equal(infos[0].payload.throttled, 3599, 'the source count is not dropped by the host gate');
});

test('error events are recorded every single time', () => {
  const { layer, log } = createLayer(60_000);
  for (let i = 0; i < 5; i += 1) {
    layer.handleLine(JSON.stringify({ type: 'error', code: 'RECEIVER_NOT_READY', message: 'not registered' }));
  }
  const errors = log.of('spoutLayer.error');
  assert.equal(errors.length, 5, 'errors are never coalesced');
  assert.equal(log.of('spoutLayer.info').length, 0);
  assert.equal(layer.infoThrottled, 0);
});

test('info lines that report a failure are recorded every single time', () => {
  const { layer, log } = createLayer(60_000);
  for (let i = 0; i < 5; i += 1) {
    layer.handleLine(infoLine('shared texture send timed out', { ms: 1000, timeout: true }));
  }
  const infos = log.of('spoutLayer.info');
  assert.equal(infos.length, 5, 'failure reports bypass the coalescing gate');
  assert.equal(layer.infoThrottled, 0);
});

test('the layer process coalesces its own info stdout before the host parses it', () => {
  assert.equal(LAYER_THROTTLE_MS, INFO_THROTTLE_MS);
  resetInfoThrottle();

  const now = 1_000_000;
  let written = 0;
  for (let i = 0; i < 100; i += 1) {
    if (throttleInfo({ type: 'info', message: 'shared texture delivered', ms: i }, now) !== null) written += 1;
  }
  assert.equal(written, 1, 'one stdout line for 100 identical status reports');

  const changed = throttleInfo({ type: 'info', message: 'source size changed' }, now + 1);
  assert.equal(changed.message, 'source size changed');
  assert.equal(changed.type, 'info', 'the protocol line type is unchanged');

  const next = throttleInfo({ type: 'info', message: 'shared texture delivered' }, now + LAYER_THROTTLE_MS);
  assert.notEqual(next, null);
  assert.equal(next.throttled, 99, 'the next line carries the suppressed count');

  for (let i = 0; i < 5; i += 1) {
    const failure = throttleInfo({ type: 'info', message: 'shared texture send failed' }, now + LAYER_THROTTLE_MS);
    assert.notEqual(failure, null, 'failure info lines are never suppressed');
  }
});
