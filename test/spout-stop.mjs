/**
 * Spout stop-path regressions — doubles only, no real Electron runtime.
 *
 * The acceptance harness (`test/spout-layer.mjs`) proves the happy path with the real display
 * runtime. This file proves the two defects that harness could not express:
 *
 *   1. a successful `taskkill` must never be reported as "the process is gone";
 *   2. the whole stop shares the host's deadline — no 5.5 s WMI query at close, no per-phase
 *      budgets appended on top of it.
 *
 * It also covers the explicit `shutdown` / `shutdown-ack` protocol, the receiver-cleanup and
 * app-exit stage timestamps, a descendant that outlives its root, and the stdin-EOF fallback.
 *
 * Run: node --test test/spout-stop.mjs
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { SpoutLayer } from '../src/host/avatar/spoutLayer.js';

const require = createRequire(import.meta.url);
const layerMain = require('../src/host/avatar/spout-layer/main.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('accepted shutdown never starts another blocking stdin read', async () => {
  let stopping = false;
  let reads = 0;
  let received = 0;
  layerMain.watchParentStdin({
    hasChannel: () => true,
    isStopping: () => stopping,
    receive: (message) => { assert.equal(message.type, 'shutdown'); received += 1; stopping = true; },
    readStdin: (_fd, buffer, offset, _length, _position, callback) => {
      reads += 1;
      if (reads > 1) return; // An unwanted second read would remain blocked on the open pipe.
      const bytes = buffer.write('{"type":"shutdown","seq":1}\n', offset);
      queueMicrotask(() => callback(null, bytes));
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(received, 1);
  assert.equal(reads, 1, 'the shutdown message must be the final read');
});

/**
 * Minimal display-process double: real EventEmitter close/exit semantics, PassThrough stdout so
 * `SpoutLayer.attach` parses protocol lines exactly as it does for the real child.
 */
function makeFakeChild({ pid, onShutdown = null, onStdinEnd = null } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdinWrites = [];
  child.stdinEnds = 0;
  child.stdin = {
    on() {},
    write(line) {
      child.stdinWrites.push(String(line));
      onShutdown?.(String(line), child);
      return true;
    },
    end() {
      child.stdinEnds += 1;
      onStdinEnd?.(child);
    },
  };
  child.exitNow = (code = 0, signal = null) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.exitCode = code;
    child.signalCode = signal;
    child.emit('exit', code, signal);
    child.emit('close', code);
  };
  return child;
}

function seedSession(layer) {
  mkdirSync(layer.dir, { recursive: true });
  writeFileSync(layer.sessionFile, JSON.stringify({
    root: layer.root,
    instance: layer.instance,
    gen: layer.generation,
    pid: layer.pid,
    created: layer.created,
  }, null, 2));
  return layer.sessionFile;
}

function makeLayer({ pid, created = '2026-11-06T00:00:00.000Z', children = [], events = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'spout-stop-'));
  const layer = new SpoutLayer({
    root,
    settings: () => ({}),
    log: { emit: async (type, payload) => events.push({ type, payload }) },
  });
  layer.generation = 1;
  layer.pid = pid;
  layer.created = created;
  layer.ownership = {
    root,
    instance: layer.instance,
    generation: 1,
    pid,
    created,
    children: [...children],
    capturedAt: Date.now(),
    scans: 1,
  };
  return layer;
}

function attachFake(layer, child) {
  layer.child = child;
  layer.attach(child);
}

test('startup exit during the creation-time probe is a failure with the original PID', async (t) => {
  const pid = 800099;
  const child = makeFakeChild({ pid });
  let spawnCount = 0;
  const events = [];
  const root = mkdtempSync(join(tmpdir(), 'spout-launch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const layer = new SpoutLayer({ root, settings: () => ({}),
    spawnProcess: () => { spawnCount += 1; return child; },
    log: { emit: async (type, payload) => events.push({ type, payload }) },
  });
  layer.validate = async () => ({ ok: true, path: 'electron.exe', version: '44.7.0' });
  layer.cleanupStale = async () => ({ ok: true });
  layer.processCreatedAt = async (queriedPid) => {
    assert.equal(queriedPid, pid);
    await sleep(5);
    child.exitNow(2147483651);
    return '';
  };
  const result = await layer.start();
  assert.equal(spawnCount, 1);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'LAUNCH_EXITED_EARLY');
  assert.equal(result.lastPid, pid);
  assert.equal(result.lastExit.code, 2147483651);
  assert.equal(existsSync(layer.sessionFile), false, 'no pid=0 session is written');
  assert.equal(layer.ownership.pid, pid, 'the spawn identity survives close');
  assert.ok(events.some((event) => event.type === 'spoutLayer.start.failed' && event.payload.pid === pid));
  assert.equal(events.some((event) => event.type === 'spoutLayer.spawned'), false);
});

test('a failed spawn with no PID never writes a session or reports success', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'spout-launch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const child = makeFakeChild({});
  const layer = new SpoutLayer({ root, settings: () => ({}), spawnProcess: () => child });
  layer.validate = async () => ({ ok: true, path: 'electron.exe', version: '44.7.0' });
  layer.cleanupStale = async () => ({ ok: true });
  layer.processCreatedAt = async () => { throw new Error('must not probe PID zero'); };
  const result = await layer.start();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'WINDOW_FAILED');
  assert.equal(result.running, false);
  assert.equal(existsSync(layer.sessionFile), false);
});

test('1. a successful taskkill is not a confirmed stop while liveness still says alive', async (t) => {
  const pid = 800001;
  const events = [];
  const layer = makeLayer({ pid, events });
  const child = makeFakeChild({ pid }); // ignores shutdown and never exits
  attachFake(layer, child);
  const sessionFile = seedSession(layer);

  let killCalls = 0;
  let descendantCalls = 0;
  layer.alive = () => true; // the fake lives forever
  // Identity is verified before the kill: the root's recorded creation time matches.
  layer.processCreatedAt = async () => layer.created;
  layer.killTree = async () => {
    killCalls += 1;
    return true; // taskkill "succeeds"
  };
  layer.killPids = async () => [];
  layer.descendantPids = async () => {
    descendantCalls += 1;
    return [];
  };
  t.after(() => rmSync(layer.root, { recursive: true, force: true }));

  const begin = Date.now();
  const result = await layer.stop({ deadlineAt: begin + 300 });

  assert.equal(killCalls >= 1, true, 'the force-kill path ran');
  assert.equal(result.ok, false, 'a success from taskkill must not become ok:true');
  assert.equal(result.confirmed, false);
  assert.equal(result.processTreeGone, false);
  assert.equal(result.stopped, false);
  assert.equal(result.stopFailed, true);
  assert.equal(result.killed, true, 'the kill *reported* success — and that is exactly what must not be trusted');
  assert.equal(result.hostTeardownFinished, true, 'it returned inside the passed deadline');
  assert.ok(result.elapsedMs <= 300 + 150, `elapsed ${result.elapsedMs} ms`);
  assert.equal(descendantCalls, 0, 'stop() must not start a WMI descendant query');
  assert.equal(descendantCalls, 0);
  assert.equal(existsSync(sessionFile), true, 'the attribution session is retained');
  assert.equal(result.sessionRetained, true);
  assert.equal(result.ownership?.pid, pid, 'the ownership record is returned');
  assert.equal(layer.snapshot().ownership?.pid, pid);
  assert.ok(events.some((entry) => entry.type === 'spoutLayer.stop.failed' && entry.payload?.confirmed === false));
});

test('2. the shutdown message is parsed, acknowledged, and enters the graceful quit path', async () => {
  const events = [];
  const acks = [];
  let quitReason = '';
  const timeline = {};
  const receiver = layerMain.createShutdownReceiver({
    emit: (payload) => {
      events.push(payload);
      if (payload.type === 'shutdown-ack') acks.push(payload);
    },
    quit: (reason) => { quitReason = reason; },
    now: () => 12345,
    timeline,
  });
  const parser = layerMain.createStdinParser({ onMessage: (message) => receiver.receive(message) });

  // A chunk split in the middle of the JSON must still parse once the line completes.
  parser.feed('{"type":"shut');
  assert.equal(acks.length, 0, 'a partial line is buffered, not discarded');
  parser.feed('down","seq":7,"deadlineAt":99999,"reason":"host-stop"}\n');

  assert.equal(quitReason, 'shutdown', 'the main process walked the graceful quit path');
  assert.equal(acks.length, 1, 'exactly one shutdown-ack is written');
  assert.equal(acks[0].seq, 7);
  assert.equal(acks[0].receivedAt, 12345);
  assert.equal(acks[0].deadlineAt, 99999);
  assert.equal(acks[0].stages.requestReceivedAt, 12345);
  assert.equal(timeline.requestReceivedAt, 12345);
  assert.equal(receiver.handled, true);

  // A duplicate request is ignored; an unrelated line is not mistaken for shutdown.
  const second = layerMain.createShutdownReceiver({ emit: () => {}, quit: () => {}, timeline: {} });
  assert.equal(second.receive({ type: 'info' }).ok, false);
  assert.equal(second.receive({ type: 'shutdown' }).ok, true);
  assert.equal(second.receive({ type: 'shutdown' }).ok, false);
  assert.equal(events[0].type, 'shutdown-ack');
});

test('3. stage timestamps cover request, receiver cleanup, app.exit, main exit and child exit', async (t) => {
  const pid = 800003;
  const events = [];
  const alive = new Set([pid]);
  const layer = makeLayer({ pid, events });
  const stamps = {
    requestReceivedAt: 0,
    receiverCleanupStartedAt: 0,
    receiverCleanupFinishedAt: 0,
    appExitCalledAt: 0,
    mainExitAt: 0,
  };
  const child = makeFakeChild({
    pid,
    onShutdown: (line, fake) => {
      const message = JSON.parse(line);
      setTimeout(() => {
        const t0 = Date.now();
        stamps.requestReceivedAt = t0;
        stamps.receiverCleanupStartedAt = t0 + 1;
        stamps.receiverCleanupFinishedAt = t0 + 2;
        stamps.appExitCalledAt = t0 + 3;
        stamps.mainExitAt = t0 + 4;
        const write = (payload) => fake.stdout.write(`${JSON.stringify(payload)}\n`);
        write({
          type: 'shutdown-ack',
          seq: message.seq,
          receivedAt: stamps.requestReceivedAt,
          stages: { requestReceivedAt: stamps.requestReceivedAt },
        });
        write({
          type: 'shutdown-stage',
          stage: 'receiver-cleanup-start',
          atMs: stamps.receiverCleanupStartedAt,
          stages: { receiverCleanupStartedAt: stamps.receiverCleanupStartedAt },
        });
        write({
          type: 'shutdown-stage',
          stage: 'receiver-cleanup-done',
          atMs: stamps.receiverCleanupFinishedAt,
          stages: { receiverCleanupFinishedAt: stamps.receiverCleanupFinishedAt },
        });
        write({
          type: 'shutdown-stage',
          stage: 'app-exit',
          atMs: stamps.appExitCalledAt,
          stages: { appExitCalledAt: stamps.appExitCalledAt, mainExitAt: stamps.mainExitAt },
        });
        write({
          type: 'exit',
          reason: 'shutdown',
          stages: { ...stamps },
        });
        setTimeout(() => {
          alive.delete(pid);
          fake.exitNow(0);
        }, 20);
      }, 10);
    },
  });
  attachFake(layer, child);
  layer.alive = (id) => alive.has(Number(id));
  layer.killTree = async () => false;
  layer.killPids = async () => [];
  layer.descendantPids = async () => [];
  t.after(() => rmSync(layer.root, { recursive: true, force: true }));

  const begin = Date.now();
  const result = await layer.stop({ deadlineAt: begin + 4000 });
  const stages = result.stages;

  assert.equal(result.ok, true);
  assert.equal(result.confirmed, true);
  assert.equal(result.processTreeGone, true);
  assert.equal(result.ackReceived, true);
  for (const key of [
    'requestedAt',
    'shutdownSentAt',
    'ackReceivedAt',
    'requestReceivedAt',
    'receiverCleanupStartedAt',
    'receiverCleanupFinishedAt',
    'appExitCalledAt',
    'mainExitAt',
    'childExitAt',
    'confirmedAt',
  ]) {
    assert.ok(Number(stages[key]) > 0, `stage ${key} has a timestamp: ${JSON.stringify(stages)}`);
  }
  assert.ok(stages.requestedAt <= stages.requestReceivedAt, 'request -> main received');
  assert.ok(stages.requestReceivedAt <= stages.receiverCleanupStartedAt, 'received -> cleanup start');
  assert.ok(stages.receiverCleanupStartedAt <= stages.receiverCleanupFinishedAt, 'cleanup start -> done');
  assert.ok(stages.receiverCleanupFinishedAt <= stages.appExitCalledAt, 'cleanup done -> app.exit');
  assert.ok(stages.appExitCalledAt <= stages.mainExitAt, 'app.exit -> main exiting');
  assert.ok(stages.mainExitAt <= stages.childExitAt, 'main exiting -> child observed gone');
  assert.ok(stages.childExitAt <= stages.confirmedAt, 'child exit -> confirmed');
  assert.equal(result.hostTeardownFinished, true);
});

test('4. deadline 500 ms with a 2 s receiver cleanup returns at ~500 ms with confirmed:false', async (t) => {
  const pid = 800004;
  const alive = new Set([pid]);
  const layer = makeLayer({ pid });
  const child = makeFakeChild({
    pid,
    // The main process acknowledges, then its receiver cleanup is wedged for 2 s: no exit.
    onShutdown: (line, fake) => {
      const message = JSON.parse(line);
      setTimeout(() => {
        fake.stdout.write(`${JSON.stringify({
          type: 'shutdown-ack',
          seq: message.seq,
          receivedAt: Date.now(),
          stages: { requestReceivedAt: Date.now() },
        })}\n`);
      }, 5);
    },
  });
  attachFake(layer, child);
  layer.alive = (id) => alive.has(Number(id));
  // Keep the wedged-kill path under test: the root identity still matches, so the force kill runs.
  layer.processCreatedAt = async () => layer.created;
  layer.killTree = async () => new Promise(() => {}); // a wedged taskkill, never settles
  layer.killPids = async () => new Promise(() => {});
  let descendantCalls = 0;
  layer.descendantPids = async () => {
    descendantCalls += 1;
    return [];
  };
  t.after(() => rmSync(layer.root, { recursive: true, force: true }));

  const begin = Date.now();
  const result = await layer.stop({ deadlineAt: begin + 500 });
  const elapsed = Date.now() - begin;

  assert.equal(result.confirmed, false);
  assert.equal(result.processTreeGone, false);
  assert.equal(result.ok, false);
  assert.equal(result.hostTeardownFinished, true);
  assert.ok(elapsed <= 500 + 150, `stop took ${elapsed} ms, budget 500 ms`);
  assert.ok(result.elapsedMs <= 500 + 150, `reported ${result.elapsedMs} ms`);
  assert.equal(descendantCalls, 0, 'no 5.5 s descendant query was started at close');
  assert.ok(Number(result.stages.ackReceivedAt) > 0, 'the ack is still recorded');
});

test('5. a descendant that outlives the root keeps the tree unconfirmed', async (t) => {
  const rootPid = 800005;
  const childPid = 800006;
  const childCreated = '2026-11-06T00:00:01.000Z';
  const alive = new Set([childPid]); // root is already gone, GPU/renderer child is not
  const layer = makeLayer({ pid: rootPid, children: [childPid] });
  // The descendant's own identity was captured while the layer was running; it still matches.
  layer.ownership.childCreated = { [childPid]: childCreated };
  layer.processCreatedAt = async (id) => (Number(id) === childPid ? childCreated : '');
  const child = makeFakeChild({ pid: rootPid });
  child.exitCode = 0; // main process already exited
  attachFake(layer, child);
  const sessionFile = seedSession(layer);
  layer.alive = (id) => alive.has(Number(id));
  layer.killTree = async () => false;
  let killedChildren = [];
  layer.killPids = async (ids) => {
    killedChildren = [...ids];
    return [];
  };
  layer.descendantPids = async () => [];
  t.after(() => rmSync(layer.root, { recursive: true, force: true }));

  const begin = Date.now();
  const result = await layer.stop({ deadlineAt: begin + 300 });

  assert.deepEqual(killedChildren, [childPid], 'the recorded child was targeted, not the whole image name');
  assert.equal(result.confirmed, false);
  assert.equal(result.processTreeGone, false);
  assert.equal(result.ok, false);
  assert.equal(result.stopFailed, true);
  assert.deepEqual(result.ownership?.children, [childPid], 'ownership survives the failed stop');
  assert.deepEqual(result.ownership?.childCreated, { [childPid]: childCreated });
  assert.equal(existsSync(sessionFile), true, 'session.json survives the failed stop');
  assert.ok(result.elapsedMs <= 300 + 150);
});

test('6. stdin EOF remains the host-death fallback when the peer never acks', async (t) => {
  const pid = 800007;
  const alive = new Set([pid]);
  const layer = makeLayer({ pid });
  const child = makeFakeChild({
    pid,
    onShutdown: () => {
      // Deliberately ignore the message: this simulates an older layer or a wedged reader.
    },
    onStdinEnd: (fake) => {
      setTimeout(() => {
        alive.delete(pid);
        fake.exitNow(0);
      }, 20);
    },
  });
  attachFake(layer, child);
  layer.alive = (id) => alive.has(Number(id));
  layer.killTree = async () => false;
  layer.killPids = async () => [];
  layer.descendantPids = async () => [];
  t.after(() => rmSync(layer.root, { recursive: true, force: true }));

  const begin = Date.now();
  const result = await layer.stop({ deadlineAt: begin + 1000 });

  assert.equal(child.stdinEnds, 1, 'stdin was closed as the fallback');
  assert.equal(result.ackReceived, false, 'no ack was faked into existence');
  assert.ok(Number(result.stages.eofFallbackAt) > 0, 'the EOF fallback is timestamped');
  assert.equal(result.confirmed, true);
  assert.equal(result.processTreeGone, true);
  assert.equal(result.ok, true);
  assert.equal(result.how, 'exit');
});
