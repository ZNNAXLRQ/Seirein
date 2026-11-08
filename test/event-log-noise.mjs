/**
 * Event-log noise reduction — the three write paths that dominated `events.jsonl`.
 *
 * Findings this pins (no behaviour change in the business paths themselves):
 *   1. `sandbox.skipped`: a foreign session (`sessionCwd != scopePath`) used to write one line per
 *      committed session event (~37.8 k lines / 7.5 h, all cwd-mismatch). The observer now
 *      pre-filters that case and writes ONE `sandbox.skipped.summary {sessionId, count, reason,
 *      windowMs}` per session per 5 min. A real anomaly (cwd unknown, switch failure, own-scope
 *      session) still writes one `sandbox.skipped` per occurrence.
 *   2. `spout.alpha.sample`: a steady transparent verdict writes one line per 30 s instead of
 *      ~1/s; a verdict change or a non-transparent sample is written immediately.
 *   3. `avatar.preset.commit`: 250 ms → 1 s, but the first and the last acknowledgement of each
 *      action are always written (middle ones are merged into the last; never change-only).
 *
 * Run: node --test test/event-log-noise.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';

import { observeSessionSandbox } from '../src/host/session/delivery/dispatch.js';
import { createAvatarRuntime } from '../src/host/avatar/avatarRuntime.js';
import { ALPHA_SAMPLE_LOG_INTERVAL_MS, SpoutLayer } from '../src/host/avatar/spoutLayer.js';

const settle = (ms = 30) => new Promise((done) => setTimeout(done, ms));

// ---------------------------------------------------------------------------------------------
// 1. sandbox.skipped — observer-entry pre-filter + one summary per session/window
// ---------------------------------------------------------------------------------------------

/** Capture events from a log stand-in; `emit` records synchronously so `void emitEvent` is seen. */
function createLog() {
  const events = [];
  return {
    events,
    emit(type, payload) {
      events.push({ type, payload });
    },
    types() {
      return events.map((event) => event.type);
    },
  };
}

/** Context whose `session/event` listeners can be published to, like the Host feed. */
function observerContext() {
  const listeners = [];
  return {
    listeners,
    ctx: {
      on(name, fn) {
        if (name === 'session/event') listeners.push(fn);
        return () => {};
      },
    },
    publish(session, event) {
      for (const listener of listeners) listener(session, event);
    },
  };
}

const SCOPE = resolve('C:\\data\\Seirein\\workspace');
const FOREIGN = resolve('C:\\Users\\dev\\default-workspace');

test('1a. 5000 foreign cwd-mismatch events → 0 per-event lines, 1 summary with the exact count', async () => {
  const io = observerContext();
  const log = createLog();
  const calls = [];
  const off = observeSessionSandbox({
    ctx: io.ctx,
    cwdOf: (session) => session?.header?.cwd ?? '',
    scopePathOf: () => SCOPE,
    getService: () => undefined,
    setSandboxMode: async (session) => { calls.push(session.id); },
    log,
    summaryWindowMs: 25,
  });
  assert.equal(typeof off, 'function');

  const session = { id: 'dsh-coding-session', header: { cwd: FOREIGN } };
  for (let index = 0; index < 5000; index += 1) {
    io.publish(session, { type: 'turn/start', data: { turn: index } });
  }
  assert.deepEqual(log.events, [], 'nothing is written in the middle of the window');

  await settle(60);
  assert.deepEqual(log.types(), ['sandbox.skipped.summary']);
  assert.deepEqual(log.events[0].payload, {
    sessionId: 'dsh-coding-session',
    count: 5000,
    reason: 'cwd-mismatch',
    windowMs: 25,
  }, 'the count and reason replace 5000 identical lines');
  assert.deepEqual(calls, [], 'a foreign session is still never switched');

  // The next window also reports exactly one line, with only the new events counted.
  for (let index = 0; index < 7; index += 1) {
    io.publish(session, { type: 'turn/end', data: { turn: index } });
  }
  await settle(60);
  assert.deepEqual(log.events.map((event) => event.payload), [
    { sessionId: 'dsh-coding-session', count: 5000, reason: 'cwd-mismatch', windowMs: 25 },
    { sessionId: 'dsh-coding-session', count: 7, reason: 'cwd-mismatch', windowMs: 25 },
  ]);
  off();
});

test('1b. a real anomaly (cwd unknown) is still written per event; own scope is never filtered', async () => {
  const io = observerContext();
  const log = createLog();
  observeSessionSandbox({
    ctx: io.ctx,
    cwdOf: (session) => session?.header?.cwd ?? '',
    scopePathOf: () => SCOPE,
    getService: () => undefined,
    setSandboxMode: async () => {},
    log,
    summaryWindowMs: 25,
  });

  // No header cwd and no working-directory service: the switch itself reports cwd-unknown, and
  // that is an anomaly, not the known-foreign noise — every occurrence is recorded.
  const unknown = { id: 'unknown-cwd-session', header: {} };
  io.publish(unknown, { type: 'turn/start', data: { turn: 1 } });
  io.publish(unknown, { type: 'turn/end', data: { turn: 1 } });
  io.publish(unknown, { type: 'turn/start', data: { turn: 2 } });
  await settle(60);
  assert.deepEqual(log.types(), ['sandbox.skipped', 'sandbox.skipped', 'sandbox.skipped']);
  assert.deepEqual(log.events.map((event) => event.payload), [
    { reason: 'cwd-unknown' }, { reason: 'cwd-unknown' }, { reason: 'cwd-unknown' },
  ]);

  // A session inside the plugin's own scope still takes the switch path (not the filter).
  const own = { id: 'own-session', header: { cwd: SCOPE } };
  io.publish(own, { type: 'turn/start', data: { turn: 1 } });
  await settle(60);
  assert.ok(log.types().includes('sandbox.switched'), 'the own session was switched, not filtered');
});

test('1c. a disposed observer still reports the window it aggregated', async () => {
  const io = observerContext();
  const log = createLog();
  const off = observeSessionSandbox({
    ctx: io.ctx,
    cwdOf: (session) => session?.header?.cwd ?? '',
    scopePathOf: () => SCOPE,
    getService: () => undefined,
    setSandboxMode: async () => {},
    log,
    // Long window: only the dispose can flush it inside this test.
    summaryWindowMs: 60_000,
  });
  const session = { id: 'foreign-disposed', header: { cwd: FOREIGN } };
  for (let index = 0; index < 3; index += 1) {
    io.publish(session, { type: 'turn/start', data: { turn: index } });
  }
  assert.deepEqual(log.events, []);
  off();
  assert.deepEqual(log.events[0].payload, {
    sessionId: 'foreign-disposed',
    count: 3,
    reason: 'cwd-mismatch',
    windowMs: 60_000,
  });
});

// ---------------------------------------------------------------------------------------------
// 2. spout.alpha.sample — verdict change / anomaly immediate, steady transparent once per window
// ---------------------------------------------------------------------------------------------

const alphaLine = (verdict) => JSON.stringify({
  type: 'diagnostic',
  event: verdict === 'opaque' ? 'spout.alpha.opaque-frame' : 'spout.alpha.sample',
  total: 100,
  alphaZero: verdict === 'transparent' ? 60 : 0,
  alphaOpaque: verdict === 'transparent' ? 36 : 100,
  alphaPartial: verdict === 'transparent' ? 4 : 0,
  verdict,
  width: 32,
  height: 32,
});

function createLayer(alphaSampleIntervalMs) {
  const log = createLog();
  const layer = new SpoutLayer({
    root: 'C:\\tmp\\event-log-noise',
    settings: () => ({ electronExecutable: 'C:\\tmp\\electron.exe' }),
    log,
    alphaSampleIntervalMs,
  });
  return { layer, log, samples: () => log.events.filter((event) => event.type === 'spout.alpha.sample') };
}

test('2a. steady transparent → one line per window while the snapshot keeps every sample', () => {
  assert.equal(ALPHA_SAMPLE_LOG_INTERVAL_MS, 30_000, 'the default heartbeat is 30 s');
  const { layer, samples } = createLayer(30_000);
  assert.equal(layer.alphaSampleIntervalMs, 30_000, 'the default is applied');

  for (let index = 0; index < 100; index += 1) layer.handleLine(alphaLine('transparent'));
  assert.equal(samples().length, 1, '100 transparent samples inside the window → 1 event');

  // The newest sample is still visible to the status card, i.e. the evidence is not stale.
  const snapshot = layer.snapshot().alphaSample;
  assert.equal(snapshot.verdict, 'transparent');
  assert.equal(snapshot.total, 100);
  assert.equal(snapshot.alphaZero, 60);
  assert.equal(snapshot.alphaOpaque, 36);
  assert.equal(snapshot.alphaPartial, 4);
  assert.equal(samples()[0].payload.event, 'spout.alpha.sample', 'the event type is unchanged');
});

test('2b. a verdict change and every non-transparent sample are written immediately', async () => {
  const { layer, samples } = createLayer(30_000);
  layer.handleLine(alphaLine('transparent'));
  assert.equal(samples().length, 1);

  // A change inside the 30 s window is not suppressed.
  layer.handleLine(alphaLine('opaque'));
  assert.equal(samples().length, 2);
  assert.equal(samples()[1].payload.verdict, 'opaque');
  assert.equal(samples()[1].payload.alphaOpaque, 100);

  // An anomaly stays per-sample, not throttled: this is the evidence worth locating.
  layer.handleLine(alphaLine('opaque'));
  layer.handleLine(alphaLine('opaque'));
  assert.equal(samples().length, 4, 'each anomalous sample is recorded');

  // Back to transparent: the change is written at once, then the window applies again.
  layer.handleLine(alphaLine('transparent'));
  assert.equal(samples().length, 5);
  layer.handleLine(alphaLine('transparent'));
  assert.equal(samples().length, 5, 'steady transparent after the change is throttled');

  // A short window proves the heartbeat itself (no hidden 30 s wait in the test).
  const { layer: windowed, samples: windowedSamples } = createLayer(25);
  windowed.handleLine(alphaLine('transparent'));
  windowed.handleLine(alphaLine('transparent'));
  assert.equal(windowedSamples().length, 1);
  await settle(40);
  windowed.handleLine(alphaLine('transparent'));
  assert.equal(windowedSamples().length, 2, 'a new window lets the steady verdict through again');
});

// ---------------------------------------------------------------------------------------------
// 3. avatar.preset.commit — first + last per action, 1 s throttle, the last one always arrives
// ---------------------------------------------------------------------------------------------

/** Avatar runtime on a fake motion clock whose transport acknowledges every motion frame. */
async function transportRuntime({ debugEvents = true } = {}) {
  let clock = 0;
  const frames = [];
  const logs = [];
  const transport = {
    connect: async () => {},
    disconnect: async () => {},
    write: async () => ({ ok: true }),
    writeMotion: async (payload) => {
      frames.push({ at: payload.at, entries: payload.entries.map((entry) => ({ channel: entry.channel, value: entry.value })) });
      return { ok: true };
    },
  };
  const runtime = createAvatarRuntime({
    transport,
    now: () => clock,
    log: (message, data = {}) => logs.push({ message, ...data }),
    config: {
      seed: 11,
      autoTickMs: 0,
      flushIntervalMs: 1,
      idleActions: [],
      idleSwayScale: 0,
      motionWrites: true,
      motionOutputHz: 30,
      presetExecution: true,
      presetDebugEvents: debugEvents,
    },
  });
  assert.equal((await runtime.connect()).ok, true);
  const rows = ['headX', 'headY', 'headZ', 'gazeX', 'gazeY', 'eyeOpenL', 'eyeOpenR', 'browL', 'browR']
    .map((channel) => ({ channel, inputName: `P_${channel}`, injectable: true, verified: true }));
  await runtime.setChannelMappings(rows, { channelMap: {} });
  return {
    runtime,
    frames,
    logs,
    tick: async (at) => {
      clock = at;
      runtime.tick(at);
      // Yield to the 1 ms flush timer so every tick's frame is really acknowledged (the 1 s
      // commit throttle never sees these yields: the whole loop stays well inside one window).
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
      return frames.at(-1) ?? null;
    },
  };
}

/** Start the 2.2 s idle-side-tilt trajectory deterministically (its acks span the whole test). */
function startSideTilt(runtime) {
  for (let seed = 0; seed < 96; seed += 1) {
    const drawn = runtime.preset({ state: 'idle', event: 'idle', recipe: 'idle-side-tilt', seed, at: 0 });
    if (drawn.started === true) return drawn;
  }
  return null;
}

const commitsOf = (events) => events.filter((event) => event.type === 'avatar.preset.commit');

test('3a. several acks over 2 s in one action → exactly 2 events (first + last); the last one arrives', async () => {
  const { runtime, logs } = await transportRuntime();
  const started = startSideTilt(runtime);
  assert.ok(started !== null);
  runtime.takeEvents();

  for (const at of [0, 250, 500, 750, 1000, 1250, 1500, 1750, 2000]) await runtime.tick(at);
  const acks = runtime.snapshot().motion.presets.debug.byAction.lastCommitCount;
  assert.ok(acks >= 2, `the transport acknowledged several frames: ${acks}`);

  const immediate = commitsOf(runtime.takeEvents());
  assert.equal(immediate.length, 1, 'only the first acknowledgement is written inside the window');
  assert.equal(immediate[0].commitCount, 1);
  assert.equal(immediate[0].actionId, started.actionId);
  assert.equal(immediate[0].at, 0);

  // The 1 s window closes: the newest suppressed acknowledgement is flushed, not dropped.
  await settle(1_100);
  const trailing = commitsOf(runtime.takeEvents());
  assert.equal(trailing.length, 1, 'the action ends with first + last, never a silent tail');
  const last = trailing[0];
  assert.equal(last.actionId, started.actionId, 'the trailing row keeps the action identity');
  assert.ok(last.commitCount > immediate[0].commitCount,
    `the trailing row is a later acknowledgement: ${immediate[0].commitCount} -> ${last.commitCount}`);
  assert.ok(last.commitCount >= acks, `it covers the acknowledgements seen so far (${acks})`);
  assert.equal(last.firstAt, 0, 'firstAt is still the action start');
  assert.equal(last.spanMs, last.lastAt - last.firstAt, 'spanMs covers the merged window');
  assert.equal(last.at, 2000, 'it is recorded at the last tick, before the window closed');

  // The host log sink sees the same two rows (not one row per acknowledgement).
  const logged = logs.filter((row) => row.message === 'avatar.preset.commit');
  assert.equal(logged.length, 2, 'the event log gets first + last only');
  assert.equal(logged.at(-1).commitCount, last.commitCount);
});

test('3b. presetDebugEvents:false writes no commit line (the projection counters still count)', async () => {
  const { runtime, logs } = await transportRuntime({ debugEvents: false });
  const started = startSideTilt(runtime);
  assert.ok(started !== null);
  runtime.takeEvents();
  for (const at of [0, 250, 500]) await runtime.tick(at);
  await settle(1_100);
  assert.deepEqual(commitsOf(runtime.takeEvents()), [], 'the debug gate stays silent');
  assert.equal(logs.filter((row) => row.message === 'avatar.preset.commit').length, 0);
  assert.ok(runtime.snapshot().motion.presets.transport.committed >= 1,
    'the projection counters still record the acknowledgements');
});
