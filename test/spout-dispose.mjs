/**
 * Plugin-unload cleanup regression.
 *
 * A hot reload keeps the host process alive, so the Spout display child never sees stdin EOF on
 * its own and the 10 s memory-maintenance one-shot would outlive the plugin. Both must be
 * released by the disposer that `apply()` registers.
 *
 * Covered here:
 *   a) a *running* display process (real Electron layer, started through the host action route) is
 *      torn down by ctx unload alone: process tree gone, window destroyed, attribution session
 *      cleared — no manual `stop()` before dispose;
 *   b) when `stop()` rejects, the disposer still does not throw and records the failure;
 *   c) after unloading, advancing past the 10 s boot timer must not run memory maintenance.
 *
 * Choice for (a): the real Electron layer (`src/host/avatar/spout-layer/main.js`) is used instead of a
 * fake Electron/stub because the regression is about the real disposer ordering; a stub would not
 * prove that `apply()`'s disposer closes the actual window. The test skips only when the explicit
 * Electron runtime (`.tmp-electron-44.7.0`, or SPOUT_TEST_ELECTRON) is absent.
 *
 * Run: node --test test/spout-dispose.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable, PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { apply } from '../src/host/index.js';
import { MemoryStore } from '../src/host/memory/store.js';
import { SpoutLayer } from '../src/host/avatar/spoutLayer.js';

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const electronPath = resolve(
  process.env.SPOUT_TEST_ELECTRON || join(repo, '.tmp-electron-44.7.0', 'electron.exe'),
);
const scratchRoot = () => mkdtempSync(join(tmpdir(), 'spout-dispose-'));
const tick = () => new Promise((resolvePromise) => setImmediate(resolvePromise));
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

const processAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
};

const powershell = (script) =>
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim();

/** OS window handle for the layer's Electron main window (0 while absent/destroyed). */
const windowHandle = (pid) => {
  if (!processAlive(pid)) return 0;
  const text = powershell(
    `$p = Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue; if ($p) { $p.MainWindowHandle.ToInt64() } else { '0' }`,
  );
  return Number(text || '0');
};

// Match this instance's isolated paths, never the global electron.exe population. Another
// Electron application may start/exit during the test without being owned by this plugin.
const layerPids = (root) => {
  const literal = String(root).replace(/'/gu, "''");
  const rows = JSON.parse(powershell(
    `@((Get-CimInstance Win32_Process -ErrorAction Stop) | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains('${literal}') } | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress`,
  ) || '[]');
  return (Array.isArray(rows) ? rows : [rows]).map(Number);
};

/** Poll until the probe returns truthy; returns the last value on timeout. */
async function waitFor(probe, timeoutMs) {
  const end = Date.now() + timeoutMs;
  let last = await probe();
  while (Date.now() < end && last === 0) {
    await sleep(150);
    last = await probe();
  }
  return last;
}

/** Minimal stand-in for the DSH context: collects effect disposers and action routes. */
function makeContext() {
  const routes = new Map();
  const disposers = [];
  const effect = (fn) => {
    const result = fn();
    disposers.push(result);
    return result;
  };
  const services = {
    systemPrompt: { section: () => ({ dispose() {} }) },
    webServer: {
      register: (route) => {
        routes.set(route.path, route.handler);
        return { dispose() {} };
      },
    },
  };
  const scopeOf = (names) => {
    const target = { effect };
    for (const service of names) target[service] = services[service];
    return new Proxy(target, { get: (inner, key) => (key in inner ? inner[key] : () => ({ dispose() {} })) });
  };
  let disposed = false;
  return {
    ctx: {
      effect,
      tools: { register: () => () => {} },
      get: () => undefined,
      inject: (names, fn) => fn(scopeOf(names)),
    },
    routes,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const entry of disposers.reverse()) {
        if (typeof entry === 'function') entry();
        else entry?.dispose?.();
      }
    },
  };
}

async function callRoute(routes, path, body) {
  const handler = routes.get(path);
  if (handler === undefined) throw new Error(`route not registered: ${path}`);
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  req.method = body === undefined ? 'GET' : 'POST';
  const res = {
    statusCode: 0,
    body: '',
    writeHead(code) {
      this.statusCode = code;
    },
    end(text) {
      this.body = String(text ?? '');
    },
  };
  await handler(req, res);
  return JSON.parse(res.body);
}

/** The session file the cleanup must remove, written before mount like a previous start would. */
function seedSession(root) {
  const dir = join(root, 'cache', 'spout-layer');
  const file = join(dir, 'session.json');
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify({ root, instance: 'deadbeef', gen: 1, pid: 1234, created: '' }, null, 2));
  return file;
}

function readEvents(root) {
  try {
    return readFileSync(join(root, 'data', 'events.jsonl'), 'utf8');
  } catch {
    return '';
  }
}

/** Parsed event-log entries; a partially written trailing line is ignored. */
function readEventEntries(root) {
  const entries = [];
  for (const line of readEvents(root).split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      /* a line still being appended */
    }
  }
  return entries;
}

/** Wait for an event-log predicate; returns the matching entry (or null) and every entry seen. */
async function waitForEvent(root, predicate, timeoutMs = 4000) {
  const end = Date.now() + timeoutMs;
  let entries = [];
  for (;;) {
    entries = readEventEntries(root);
    const hit = entries.find(predicate);
    if (hit !== undefined) return { hit, entries };
    if (Date.now() >= end) return { hit: null, entries };
    await sleep(25);
  }
}

/**
 * Display-process double with real EventEmitter exit/close semantics and a PassThrough stdout, so
 * `SpoutLayer.attach` parses protocol lines exactly as it does for the real child.
 */
function makeChildDouble({ pid, onShutdown = () => {} } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = {
    on() {},
    write(line) {
      onShutdown(String(line), child);
      return true;
    },
    end() {},
  };
  child.exitNow = (code = 0) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.exitCode = code;
    child.signalCode = null;
    child.emit('exit', code, null);
    child.emit('close', code);
  };
  return child;
}

test('a) unloading a running layer kills the tree, destroys the window and clears the session', async (t) => {
  if (!existsSync(electronPath)) {
    t.skip(`Electron runtime not present: ${electronPath}`);
    return;
  }
  const root = scratchRoot();
  const mounted = makeContext();
  let pid = 0;

  t.after(() => {
    try {
      mounted.dispose();
    } catch {
      /* teardown is best-effort */
    }
    if (pid > 0 && processAlive(pid)) {
      try {
        execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } catch {
        /* already gone */
      }
    }
  });

  apply(mounted.ctx, { root, defaultDomain: 'chat', enabled: true });
  const started = await callRoute(mounted.routes, '/assistant/action', {
    action: 'spoutLayer.start',
    electronExecutable: electronPath,
  });
  t.diagnostic(JSON.stringify({ root, pid: started.pid, lastPid: started.lastPid,
    code: started.code, lastExit: started.lastExit, diagnostics: started.diagnostics }));
  pid = started.pid || started.lastPid || 0;
  assert.equal(started.ok, true, `the real layer starts through the host route: ${JSON.stringify(started)}`);
  assert.ok(started.pid > 0, 'a display PID is recorded');
  pid = started.pid;

  const sessionFile = join(root, 'cache', 'spout-layer', 'session.json');
  assert.equal(existsSync(sessionFile), true, 'start writes the attribution session record');
  const handleBefore = await waitFor(() => windowHandle(pid), 20_000);
  assert.ok(handleBefore > 0, 'the layer window is visible before unload');
  assert.equal(processAlive(pid), true, 'the display process is running before unload');
  await waitFor(
    async () => {
      const status = await callRoute(mounted.routes, '/assistant/status');
      const phase = status?.live2d?.spoutLayer?.readyPhase ?? '';
      return phase === 'receiver' || phase === 'waiting-sender' ? 1 : 0;
    },
    20_000,
  );

  const ownedPids = [...new Set([pid, ...layerPids(root)])];
  t.diagnostic(JSON.stringify({ beforeDisposePids: ownedPids }));

  // No manual stop: unload alone must close the running window.
  mounted.dispose();
  const gone = await waitFor(() => (processAlive(pid) ? 0 : 1), 12_000);
  assert.equal(gone, 1, 'the display process exits after ctx unload');
  assert.equal(processAlive(pid), false, 'the process tree is gone');
  // The record is removed only after the disposer's stop() confirms the exit, so wait for it.
  const sessionGone = await waitFor(() => (existsSync(sessionFile) ? 0 : 1), 6000);
  assert.equal(sessionGone, 1, 'the attribution session is cleared');
  assert.equal(windowHandle(pid), 0, 'the window handle is gone with the process');

  const after = await waitFor(
    () => (ownedPids.every((id) => !processAlive(id)) && layerPids(root).length === 0 ? 1 : 0),
    5000,
  );
  assert.equal(after, 1, `no process belonging to this layer remains: ${JSON.stringify({
    capturedAlive: ownedPids.filter(processAlive), current: layerPids(root),
  })}`);
});

test('b) a rejecting stop is reported as an unconfirmed spoutLayer item, never escapes the disposer, and keeps the session', async () => {
  const root = scratchRoot();
  const sessionFile = seedSession(root);
  const mounted = makeContext();
  const originalStop = SpoutLayer.prototype.stop;
  SpoutLayer.prototype.stop = async function rejectingStop() {
    throw new Error('stop failed on purpose');
  };

  try {
    apply(mounted.ctx, { root, defaultDomain: 'chat', enabled: true });
    assert.doesNotThrow(() => mounted.dispose(), 'a rejected stop must be swallowed');
    // The manager reports the exact item, not just "some timeout": `confirmed:false` on
    // shutdown.item plus the matching shutdown.timeout entry for the same item name.
    const item = await waitForEvent(
      root,
      (entry) => entry.type === 'shutdown.item' && entry.payload?.name === 'spoutLayer',
    );
    assert.ok(item.hit !== null, 'shutdown.item names the spoutLayer item');
    assert.equal(item.hit.payload.confirmed, false, 'the rejected stop is unconfirmed, not successful');
    const timeout = await waitForEvent(
      root,
      (entry) => entry.type === 'shutdown.timeout' && entry.payload?.item === 'spoutLayer',
    );
    assert.ok(timeout.hit !== null, 'the unconfirmed item is reported as shutdown.timeout for spoutLayer');
    assert.equal(timeout.hit.payload.item, 'spoutLayer', 'the timeout belongs to spoutLayer, not any other item');
    assert.equal(
      item.entries.some((entry) => entry.type === 'shutdown.item' && entry.payload?.confirmed === false && entry.payload?.name !== 'spoutLayer'),
      false,
      'only spoutLayer is unconfirmed',
    );
    // A failed stop proves nothing about the process: its attribution record must stay.
    assert.equal(existsSync(sessionFile), true, 'the session is kept after a failed stop');
  } finally {
    SpoutLayer.prototype.stop = originalStop;
    mounted.dispose();
  }
});

test('d) a stop that cannot confirm the exit returns ok:false and keeps the session', async () => {
  const root = scratchRoot();
  const events = [];
  const layer = new SpoutLayer({
    root,
    settings: () => ({}),
    log: { emit: async (type, payload) => { events.push({ type, payload }); } },
  });
  const live = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  try {
    await sleep(400);
    const created = powershell(
      `try { [System.Diagnostics.Process]::GetProcessById(${live.pid}).StartTime.ToUniversalTime().ToString('o') } catch { '' }`,
    );
    const sessionFile = join(root, 'cache', 'spout-layer', 'session.json');
    mkdirSync(dirname(sessionFile), { recursive: true });
    writeFileSync(
      sessionFile,
      JSON.stringify({ root, instance: layer.instance, gen: 3, pid: live.pid, created }, null, 2),
    );

    // A layer that ignores stdin and whose tree kill fails: the process is still alive at the end.
    const fakeChild = new EventEmitter();
    fakeChild.stdin = { end() {} };
    fakeChild.exitCode = null;
    fakeChild.signalCode = null;
    layer.child = fakeChild;
    layer.pid = live.pid;
    layer.created = created;
    layer.generation = 3;
    layer.processCreatedAt = async () => created;
    layer.killTree = async () => false;

    const result = await layer.stop();
    assert.equal(result.ok, false, 'a failed stop must not be reported as success');
    assert.equal(result.code, 'STOP_FAILED');
    assert.equal(result.stopped, false);
    assert.equal(result.running, true, 'the process is still running');
    assert.equal(result.stopFailed, true);
    assert.equal(result.sessionRetained, true);
    assert.equal(layer.snapshot().stopFailed, true);
    assert.equal(layer.snapshot().running, true);
    assert.equal(existsSync(sessionFile), true, 'the attribution record survives a failed stop');
    const kept = JSON.parse(readFileSync(sessionFile, 'utf8'));
    assert.deepEqual(
      { pid: kept.pid, gen: kept.gen, created: kept.created },
      { pid: live.pid, gen: 3, created },
      'PID, generation and creation time are still on disk',
    );
    assert.ok(
      events.some((entry) => entry.type === 'spoutLayer.stop.failed'),
      'the failure is recorded',
    );
  } finally {
    // This fixture is a direct Node child with no descendants. Use the spawn handle: restricted
    // runners may refuse taskkill even though this parent can terminate its own child.
    if (live.exitCode === null && live.signalCode === null) {
      const closed = new Promise((done) => live.once('close', done));
      live.kill('SIGKILL');
      let timer;
      try {
        await Promise.race([closed, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`fixture child ${live.pid} did not exit`)), 2000);
        })]);
      } finally {
        clearTimeout(timer);
      }
    }
  }
});

test('e) an old controller cannot delete the next generation session record', async () => {
  const root = scratchRoot();
  const events = [];
  const layer = new SpoutLayer({
    root,
    settings: () => ({}),
    log: { emit: async (type, payload) => { events.push({ type, payload }); } },
  });
  const sessionFile = join(root, 'cache', 'spout-layer', 'session.json');
  mkdirSync(dirname(sessionFile), { recursive: true });
  const created = new Date().toISOString();
  // The next generation already wrote its record (same root/instance, new generation).
  const nextGeneration = { root, instance: layer.instance, gen: 2, pid: 424242, created };
  writeFileSync(sessionFile, JSON.stringify(nextGeneration, null, 2));

  // The old controller (gen 1) owns a process that is already gone; its cleanup must stop here.
  const fakeChild = new EventEmitter();
  fakeChild.stdin = { end() {} };
  fakeChild.exitCode = 0;
  fakeChild.signalCode = null;
  layer.child = fakeChild;
  layer.pid = 424242;
  layer.created = created;
  layer.generation = 1;
  layer.alive = () => false;

  const result = await layer.stop();
  assert.equal(result.ok, true, 'the old process itself is gone');
  assert.equal(result.sessionRetained, true, 'the record is not deleted');
  assert.equal(existsSync(sessionFile), true);
  assert.deepEqual(JSON.parse(readFileSync(sessionFile, 'utf8')), nextGeneration);
  assert.ok(
    events.some((entry) => entry.type === 'spoutLayer.session.foreign' && entry.payload?.mismatch === 'generation'),
    'the refused deletion is recorded as spoutLayer.session.foreign',
  );
});

test('f) an empty child slot does not confirm a live attributed descendant', async () => {
  const root = scratchRoot();
  const layer = new SpoutLayer({ root, settings: () => ({}), log: { emit: async () => {} } });
  // The main process already exited: its close handler cleared child/pid, but the runtime
  // ownership record still names two PIDs that are alive.
  layer.child = null;
  layer.pid = 0;
  layer.generation = 3;
  layer.created = '2026-11-06T00:00:00.000Z';
  layer.ownership = {
    root,
    instance: layer.instance,
    generation: 3,
    pid: 900101,
    created: layer.created,
    children: [900102],
    capturedAt: Date.now(),
    scans: 1,
  };
  layer.alive = (pid) => [900101, 900102].includes(Number(pid));

  const begin = Date.now();
  const result = await layer.stop({ deadlineAt: begin + 250 });

  assert.equal(result.ok, false, 'an empty slot is not a confirmed stop');
  assert.equal(result.confirmed, false);
  assert.equal(result.processTreeGone, false);
  assert.equal(result.code, 'STOP_FAILED');
  assert.deepEqual(result.survivors, [900101, 900102], 'the attributed PIDs are reported');
  assert.equal(result.sessionRetained, true, 'the attribution record is kept while a PID lives');
  assert.notEqual(layer.ownership, null, 'ownership evidence survives an unconfirmed idle stop');
  assert.ok(Date.now() - begin <= 250 + 150);
});

test('g) releaseSession cannot overrun the stop deadline when the event log stalls', async () => {
  const root = scratchRoot();
  let emitSettled = false;
  const layer = new SpoutLayer({
    root,
    settings: () => ({}),
    log: {
      emit: async () => {
        await sleep(150);
        emitSettled = true;
      },
    },
  });
  const sessionFile = join(root, 'cache', 'spout-layer', 'session.json');
  mkdirSync(dirname(sessionFile), { recursive: true });
  writeFileSync(
    sessionFile,
    JSON.stringify({ root, instance: layer.instance, gen: 99, pid: 1234, created: '' }, null, 2),
  );

  const begin = Date.now();
  const result = await layer.releaseSession('test', {}, begin + 30);
  const elapsed = Date.now() - begin;

  assert.equal(result.ok, false);
  assert.equal(result.code, 'SESSION_FOREIGN');
  assert.equal(result.mismatch, 'generation');
  assert.ok(elapsed <= 30 + 80, `releaseSession took ${elapsed} ms with a 30 ms budget`);
  assert.equal(emitSettled, false, 'the slow log did not gate the return');
  await sleep(180);
  assert.equal(emitSettled, true, 'the diagnostic still ran after the bounded wait was abandoned');
});

test('h) a timed-out graceful wait leaves childExitAt and mainExitAt null', async () => {
  const root = scratchRoot();
  const pid = 900201;
  const created = '2026-11-06T00:00:00.000Z';
  const layer = new SpoutLayer({ root, settings: () => ({}) });
  layer.generation = 1;
  layer.pid = pid;
  layer.created = created;
  const child = makeChildDouble({
    pid,
    onShutdown: (line, fake) => {
      const message = JSON.parse(line);
      setTimeout(() => {
        const now = Date.now();
        fake.stdout.write(`${JSON.stringify({
          type: 'shutdown-ack',
          seq: message.seq,
          receivedAt: now,
          stages: { requestReceivedAt: now },
        })}\n`);
        // The peer requested its exit, but the process never actually exits.
        fake.stdout.write(`${JSON.stringify({
          type: 'shutdown-stage',
          stage: 'app-exit',
          atMs: now,
          stages: { exitRequestedAt: now, appExitCalledAt: now },
        })}\n`);
      }, 5);
    },
  });
  layer.child = child;
  layer.attach(child);
  layer.ownership = {
    root,
    instance: layer.instance,
    generation: 1,
    pid,
    created,
    children: [],
    capturedAt: Date.now(),
    scans: 1,
  };
  layer.alive = () => true;
  layer.killTree = async () => false;
  layer.killPids = async () => [];

  const begin = Date.now();
  const result = await layer.stop({ deadlineAt: begin + 500 });

  assert.equal(result.confirmed, false);
  assert.equal(result.ok, false);
  assert.ok(Number(result.stages.exitRequestedAt) > 0, 'the exit request is timestamped');
  assert.equal(result.stages.mainExitAt, null, 'no main exit happened');
  assert.equal(result.stages.childExitAt, null, 'the timeout is not recorded as a child exit');
});

test('i) a confirmed graceful exit timestamps request, main exit and child exit in order', async () => {
  const root = scratchRoot();
  const pid = 900301;
  const created = '2026-11-06T00:00:00.000Z';
  const layer = new SpoutLayer({ root, settings: () => ({}) });
  layer.generation = 1;
  layer.pid = pid;
  layer.created = created;
  const alive = new Set([pid]);
  const child = makeChildDouble({
    pid,
    onShutdown: (line, fake) => {
      const message = JSON.parse(line);
      setTimeout(() => {
        const now = Date.now();
        fake.stdout.write(`${JSON.stringify({
          type: 'shutdown-ack',
          seq: message.seq,
          receivedAt: now,
          stages: { requestReceivedAt: now },
        })}\n`);
        fake.stdout.write(`${JSON.stringify({
          type: 'shutdown-stage',
          stage: 'app-exit',
          atMs: now,
          stages: { exitRequestedAt: now, appExitCalledAt: now },
        })}\n`);
        fake.stdout.write(`${JSON.stringify({
          type: 'shutdown-stage',
          stage: 'main-exit',
          atMs: now + 1,
          stages: { mainExitAt: now + 1 },
        })}\n`);
        setTimeout(() => {
          alive.delete(pid);
          fake.exitNow(0);
        }, 20);
      }, 5);
    },
  });
  layer.child = child;
  layer.attach(child);
  layer.ownership = {
    root,
    instance: layer.instance,
    generation: 1,
    pid,
    created,
    children: [],
    capturedAt: Date.now(),
    scans: 1,
  };
  layer.alive = (id) => alive.has(Number(id));
  layer.killTree = async () => false;
  layer.killPids = async () => [];

  const begin = Date.now();
  const result = await layer.stop({ deadlineAt: begin + 2000 });

  assert.equal(result.ok, true);
  assert.equal(result.confirmed, true);
  assert.ok(Number(result.stages.exitRequestedAt) > 0, 'exit request is timestamped');
  assert.ok(Number(result.stages.mainExitAt) > 0, 'main exit is timestamped before the child exit');
  assert.ok(Number(result.stages.childExitAt) > 0, 'the observed child exit is timestamped');
  assert.ok(
    result.stages.exitRequestedAt <= result.stages.mainExitAt
      && result.stages.mainExitAt <= result.stages.childExitAt,
    'request -> main exit -> child exit',
  );
});

test('c) unload cancels the 10 s memory boot maintenance', async (t) => {
  const root = scratchRoot();
  const mounted = makeContext();
  const originalMaintain = MemoryStore.prototype.maintain;
  let maintainCalls = 0;
  MemoryStore.prototype.maintain = function countedMaintain(...args) {
    maintainCalls += 1;
    return originalMaintain.apply(this, args);
  };
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });

  try {
    apply(mounted.ctx, { root, defaultDomain: 'chat', enabled: true });
    mounted.dispose();
    // Cross the 10 s one-shot: the plugin is gone, so maintenance must not run.
    t.mock.timers.tick(10_000);
    await tick();
    assert.equal(maintainCalls, 0, 'the boot timer was cleared during unload');
    // The periodic 15 min interval must be gone as well.
    t.mock.timers.tick(15 * 60 * 1000);
    await tick();
    assert.equal(maintainCalls, 0, 'the periodic maintenance timer was cleared during unload');
  } finally {
    MemoryStore.prototype.maintain = originalMaintain;
    mounted.dispose();
  }
});
