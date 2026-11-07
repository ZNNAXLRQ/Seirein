import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createShutdownDiagnostics } from '../src/host/runtime/diagnostics/shutdown-resources.js';
import { createShutdownManager } from '../src/host/runtime/shutdown.js';

function fixture() {
  const proc = new EventEmitter();
  proc.pid = 123;
  proc.connected = true;
  proc.channel = {};
  let handles = [];
  let resources = [];
  proc._getActiveHandles = () => handles;
  proc._getActiveRequests = () => [];
  proc.getActiveResourcesInfo = () => resources;
  const records = [];
  const timers = [];
  const diagnostic = createShutdownDiagnostics({ root: tmpdir(), proc, write: (row) => records.push(row),
    setTimer: (fn, delay) => {
      const timer = { fn, delay, unrefed: false, cleared: false, unref() { this.unrefed = true; } };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { timer.cleared = true; },
  });
  return { proc, records, timers, diagnostic,
    handles: (next) => { handles = next; }, resources: (next) => { resources = next; } };
}

test('records whole-host resources, stable handle identities and only PID ownership hints', () => {
  const f = fixture();
  class ChildProcess { pid = 456; spawnargs = ['PRIVATE-CONTENT']; hasRef() { return true; } }
  const child = new ChildProcess();
  f.handles([child]);
  f.resources(['PipeWrap', 'Timeout', 'Timeout']);
  f.diagnostic.noteOwnedPid('hearing', 456);
  f.diagnostic.begin('host-shutdown');
  f.diagnostic.complete({ ok: true });
  const begin = f.records.find((row) => row.phase === 'shutdown-begin');
  const done = f.records.find((row) => row.phase === 'plugin-stopped');
  assert.equal(begin.scope, 'whole-host');
  assert.equal(begin.pid, 123);
  assert.ok(begin.shutdownId);
  assert.equal(begin.shutdownId, done.shutdownId);
  assert.equal(begin.handles.details[0].id, done.handles.details[0].id);
  assert.equal(done.handles.details[0].ownerHint, 'hearing');
  assert.equal(done.resources.Timeout, 2);
  assert.equal(done.delta.resources.Timeout, 2);
  assert.equal(done.ipc.connected, true);
  assert.equal(JSON.stringify(f.records).includes('PRIVATE-CONTENT'), false);
  f.diagnostic.dispose();
});

test('late probes are unreferenced, bounded, and remove process listeners', () => {
  const f = fixture();
  f.diagnostic.begin('unload');
  f.diagnostic.begin('again');
  f.diagnostic.complete({ ok: true });
  f.diagnostic.complete({ ok: false });
  assert.deepEqual(f.timers.map((timer) => timer.delay), [200, 1000]);
  assert.ok(f.timers.every((timer) => timer.unrefed));
  assert.equal(f.proc.listenerCount('exit'), 1);
  f.timers[0].fn();
  f.timers[1].fn();
  assert.equal(f.proc.listenerCount('exit'), 0);
  assert.equal(f.proc.listenerCount('beforeExit'), 0);
  assert.deepEqual(f.records.map((row) => row.phase),
    ['mounted', 'shutdown-begin', 'plugin-stopped', 'after-200ms', 'after-1000ms']);
});

test('exit snapshot cancels observers; malformed or unsupported enumerators stay explicitly unavailable', () => {
  const f = fixture();
  f.proc._getActiveHandles = () => { throw new Error('unsupported'); };
  f.proc._getActiveRequests = undefined;
  f.proc.getActiveResourcesInfo = () => null;
  f.diagnostic.begin('unload');
  f.diagnostic.complete({ ok: true });
  f.proc.emit('exit', 0);
  const row = f.records.at(-1);
  assert.equal(row.phase, 'exit');
  assert.deepEqual(row.availability, { handles: false, requests: false, resources: false });
  assert.ok(f.timers.every((timer) => timer.cleared));
  assert.equal(f.proc.listenerCount('beforeExit'), 0);
});

test('handle details are bounded and truncated comparisons are identified', () => {
  const f = fixture();
  f.handles(Array.from({ length: 100 }, () => ({})));
  f.diagnostic.begin('unload');
  const row = f.records.at(-1);
  assert.equal(row.handles.count, 100);
  assert.equal(row.handles.details.length, 64);
  assert.equal(row.handles.truncated, true);
  assert.equal(row.delta.handlesTruncated, true);
  f.diagnostic.dispose();
});

test('diagnostic failures and non-settling diagnostics cannot change a successful teardown', async () => {
  const diagnostic = createShutdownDiagnostics({ root: tmpdir(), write: () => { throw new Error('disk unavailable'); } });
  diagnostic.begin('test');
  diagnostic.dispose();
  const manager = createShutdownManager({ deadlineMs: 30, diagnostics: {
    begin() { throw new Error('diagnostic only'); },
    complete() { return new Promise(() => {}); },
  } });
  manager.setPlan(() => ({ internal: [{ name: 'test', stop: () => ({ confirmed: true }) }] }));
  const started = Date.now();
  const result = await manager.run();
  assert.equal(result.ok, true);
  assert.ok(Date.now() - started < 150);
});

test('standalone sidecar is JSONL, rotates, and is independent of the event logger', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'shutdown-evidence-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'data', 'diagnostics');
  const file = join(dir, 'shutdown.jsonl');
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, 'x'.repeat(2 * 1024 * 1024 + 1));
  const diagnostic = createShutdownDiagnostics({ root });
  diagnostic.begin('test');
  diagnostic.dispose();
  assert.equal(diagnostic.file, file);
  assert.equal(existsSync(`${file}.previous`), true);
  const rows = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(rows.map((row) => row.phase), ['mounted', 'shutdown-begin']);
});

async function runFixture(t, leak) {
  const root = mkdtempSync(join(tmpdir(), 'shutdown-observer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const moduleUrl = new URL('../src/host/runtime/diagnostics/shutdown-resources.js', import.meta.url).href;
  const source = `import { createShutdownDiagnostics } from ${JSON.stringify(moduleUrl)};
    const d = createShutdownDiagnostics({ root: ${JSON.stringify(root)} });
    ${leak ? 'const kept = setInterval(() => {}, 5000);' : ''}
    d.begin('fixture'); d.complete({ ok: true });
    ${leak ? 'setTimeout(() => clearInterval(kept), 1250);' : ''}`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (bytes) => { stderr += bytes; });
  let timer;
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code));
  });
  try {
    const code = await Promise.race([closed, new Promise((_, reject) => {
      timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('observer kept child alive')); }, 5000);
    })]);
    assert.equal(code, 0, stderr);
    return readFileSync(join(root, 'data', 'diagnostics', 'shutdown.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await closed;
    }
  }
}

test('real child exits without waiting for observation timers', async (t) => {
  const rows = await runFixture(t, false);
  assert.ok(rows.some((row) => row.phase === 'before-exit'));
  assert.ok(rows.some((row) => row.phase === 'exit'));
  assert.equal(rows.some((row) => row.phase.startsWith('after-')), false);
});

test('real referenced interval is visible after plugin-stopped even when private handle lists omit timers', async (t) => {
  const rows = await runFixture(t, true);
  const late = rows.find((row) => row.phase === 'after-1000ms');
  assert.ok(late, 'a deliberately live process permits late sampling');
  assert.ok(late.resources.Timeout > 0, 'resource enumeration exposes referenced timers');
  assert.ok(late.delta.resources.Timeout > 0, 'the timer was absent from the startup baseline');
});

test('actual plugin mount and awaited unload write the diagnostic sidecar', async (t) => {
  const { apply } = await import('../src/host/index.js');
  const root = mkdtempSync(join(tmpdir(), 'shutdown-wiring-'));
  t.after(async () => {
    // Allow the deliberately unreferenced observation window to finish before deleting evidence.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    rmSync(root, { recursive: true, force: true });
  });
  const disposers = [];
  const effect = (fn) => { const value = fn(); disposers.push(value); return value; };
  const services = {
    systemPrompt: { section: () => ({ dispose() {} }) },
    webServer: { register: () => ({ dispose() {} }) },
  };
  const ctx = { effect, get: () => undefined, tools: { register: () => () => {} },
    inject(names, fn) {
      const scope = { effect };
      for (const name of names) scope[name] = services[name];
      fn(new Proxy(scope, { get: (target, key) => key in target ? target[key] : () => ({ dispose() {} }) }));
    },
  };
  apply(ctx, { root, defaultDomain: 'chat', enabled: true });
  await Promise.all(disposers.reverse().map((entry) => typeof entry === 'function' ? entry() : entry?.dispose?.()));
  const rows = readFileSync(join(root, 'data', 'diagnostics', 'shutdown.jsonl'), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line));
  const begin = rows.find((row) => row.phase === 'shutdown-begin');
  const done = rows.find((row) => row.phase === 'plugin-stopped');
  assert.ok(begin && done, 'the manager invoked the real diagnostic hooks');
  assert.equal(done.shutdownId, begin.shutdownId);
  assert.equal(done.pid, process.pid);
  assert.equal(done.pluginConfirmed, true);
});
