/**
 * P-111 controlled diagnostics channel: disabled-by-default, whitelisted, bounded, read-only.
 *
 * Run: node --test test/diagnostics.mjs
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  DIAGNOSTICS_LIMITS,
  DIAGNOSTICS_PROBES,
  createDiagnostics,
  redactDiagnosticText,
  resolveDiagnosticsEnabled,
} from '../src/host/runtime/diagnostics/query.js';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));

function fixture(events = []) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-diagnostics-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  const file = join(root, 'data', 'events.jsonl');
  writeFileSync(file, events.map((row) => JSON.stringify(row)).join('\n') + (events.length > 0 ? '\n' : ''), 'utf8');
  return {
    root,
    file,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const at = (offsetMs = 0) => new Date(Date.now() - offsetMs).toISOString();
const event = (type, payload, offsetMs = 0) => ({
  id: `evt-${type}-${offsetMs}`,
  ts: at(offsetMs),
  type,
  corr_id: null,
  payload,
});

function assertWhitelisted(row, fields, message) {
  for (const key of Object.keys(row)) {
    assert.ok(fields.includes(key), `${message}: unexpected field ${key}`);
  }
}

test('1. disabled by default: disabled result, no read and no audit event', async () => {
  // One resolution rule: missing both = off; config is the baseline, settings.json overrides it.
  assert.equal(resolveDiagnosticsEnabled({}, {}), false);
  assert.equal(resolveDiagnosticsEnabled({}, { diagnostics: { enabled: true } }), true);
  assert.equal(resolveDiagnosticsEnabled({}, { diagnostics: true }), true);
  assert.equal(resolveDiagnosticsEnabled({}, { diagnosticsEnabled: true }), true);
  assert.equal(resolveDiagnosticsEnabled({ diagnostics: { enabled: true } }, {}), true);
  assert.equal(resolveDiagnosticsEnabled({ diagnostics: { enabled: false } }, { diagnostics: { enabled: true } }), false);
  assert.equal(resolveDiagnosticsEnabled({ diagnostics: { enabled: 'yes' } }, {}), false);

  const f = fixture([event('voice.latency', { totalMs: 12 })]);
  let reads = 0;
  const audits = [];
  const diagnostics = createDiagnostics({
    root: f.root,
    emit: (type, payload) => audits.push({ type, payload }),
    readTail: () => {
      reads += 1;
      return { rows: [], truncated: false };
    },
  });
  try {
    const result = await diagnostics.query({ probe: 'voice.latency' });
    assert.deepEqual(result, { ok: false, reason: 'disabled' });
    assert.equal(reads, 0, 'disabled channel must not read the event log');
    assert.equal(audits.length, 0, 'disabled channel must not write diagnostics.query');
  } finally {
    f.cleanup();
  }
});

test('2. voice.latency returns the newest N rows through a field whitelist', async () => {
  const f = fixture([
    event('voice.latency', {
      turn: 1, totalMs: 111, asrMs: 40, firstAudibleLane: 'reply',
      rawText: 'PRIVATE TRANSCRIPT', token: 'SECRET-TOKEN-ONE',
    }, 2000),
    event('voice.latency', {
      turn: 2, totalMs: 222, asrMs: 50, firstAudibleLane: 'ack',
      rawText: 'PRIVATE TRANSCRIPT TWO', token: 'SECRET-TOKEN-TWO',
    }, 1000),
    event('unrelated.event', { totalMs: 999 }, 500),
  ]);
  const diagnostics = createDiagnostics({ root: f.root, isEnabled: true });
  try {
    const result = await diagnostics.query({ probe: 'voice.latency', limit: 2 });
    assert.equal(result.ok, true);
    assert.equal(result.probe, 'voice.latency');
    assert.equal(result.rows.length, 2);
    assert.equal(result.truncated, false, 'two matching rows fit exactly');
    assert.equal(result.rows[0].turn, 2, 'newest row comes first');
    assert.equal(result.rows[0].totalMs, 222);
    assert.equal(result.rows[1].totalMs, 111);
    assert.ok(typeof result.rows[0].ts === 'string' && result.rows[0].ts.length > 0);
    assert.equal(Object.hasOwn(result.rows[0], 'rawText'), false, 'transcript text is not projected');
    assert.equal(Object.hasOwn(result.rows[0], 'token'), false, 'credential fields are not projected');
    for (const row of result.rows) {
      assertWhitelisted(row, DIAGNOSTICS_PROBES['voice.latency'].fields, 'voice.latency row');
    }
  } finally {
    f.cleanup();
  }
});

test('3. over the row cap: truncated=true and rows exactly at the limit', async () => {
  const events = Array.from({ length: 60 }, (_value, index) =>
    event('voice.latency', { turn: index, totalMs: index }, (59 - index) * 1000));
  const f = fixture(events);
  const diagnostics = createDiagnostics({ root: f.root, isEnabled: true });
  try {
    const result = await diagnostics.query({ probe: 'voice.latency', limit: 50 });
    assert.equal(result.ok, true);
    assert.equal(result.truncated, true);
    assert.equal(result.rows.length, DIAGNOSTICS_LIMITS.maxLimit);
    assert.equal(result.rows[0].turn, 59, 'newest row survives truncation');

    // A caller asking beyond the hard cap is clamped to 50, never allowed to widen the budget.
    const clamped = await diagnostics.query({ probe: 'voice.latency', limit: 999 });
    assert.equal(clamped.rows.length, DIAGNOSTICS_LIMITS.maxLimit);
    assert.equal(clamped.truncated, true);
  } finally {
    f.cleanup();
  }
});

test('4. unknown probe is rejected before any read', async () => {
  const f = fixture([event('voice.latency', { totalMs: 1 })]);
  let reads = 0;
  const audits = [];
  const diagnostics = createDiagnostics({
    root: f.root,
    isEnabled: true,
    emit: (type, payload) => audits.push({ type, payload }),
    readTail: () => {
      reads += 1;
      return { rows: [], truncated: false };
    },
  });
  try {
    const result = await diagnostics.query({ probe: 'raw.events', limit: 10 });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid-probe');
    assert.deepEqual(result.rows, []);
    assert.equal(result.truncated, false);
    assert.equal(reads, 0, 'an invalid name must not reach the reader');
    assert.equal(audits.length, 0, 'an invalid name is not audited as a query');
  } finally {
    f.cleanup();
  }
});

test('5. credentials and raw content never appear in probe rows', async () => {
  const secret = 'SECRET-TOKEN-ALPHA-123456';
  const f = fixture([
    event('voice.latency', {
      totalMs: 100,
      spokenSource: `token=${secret}`,
      error: 'Authorization: Bearer ABCDEFGHIJKLMNOP',
      rawText: 'PRIVATE FILE CONTENT',
    }, 2000),
    event('hearing.noise.shadow', {
      durationMs: 900,
      endpointReason: 'silence',
      text: 'PRIVATE TRANSCRIPT',
      onlineText: 'PRIVATE ONLINE TEXT',
      offlineText: 'PRIVATE OFFLINE TEXT',
      device: 'PRIVATE MICROPHONE',
      rmsDb: -42,
      peakDb: -12,
    }, 1000),
  ]);
  const diagnostics = createDiagnostics({ root: f.root, isEnabled: true });
  try {
    const voice = await diagnostics.query({ probe: 'voice.latency', limit: 5 });
    const noise = await diagnostics.query({ probe: 'noise.shadow', limit: 5 });
    const serialized = JSON.stringify({ voice: voice.rows, noise: noise.rows });
    for (const forbidden of [secret, 'PRIVATE FILE CONTENT', 'PRIVATE TRANSCRIPT',
      'PRIVATE ONLINE TEXT', 'PRIVATE OFFLINE TEXT', 'PRIVATE MICROPHONE', 'ABCDEFGHIJKLMNOP']) {
      assert.equal(serialized.includes(forbidden), false, `leaked ${forbidden}`);
    }
    assert.equal(voice.rows[0].spokenSource, 'token=[redacted]');
    assert.equal(Object.hasOwn(voice.rows[0], 'error'), false, 'non-whitelisted error text is dropped');
    assert.equal(noise.rows[0].durationMs, 900);
    assert.equal(Object.hasOwn(noise.rows[0], 'text'), false);
    assert.equal(Object.hasOwn(noise.rows[0], 'device'), false);
    for (const row of noise.rows) {
      assertWhitelisted(row, DIAGNOSTICS_PROBES['noise.shadow'].fields, 'noise.shadow row');
    }
    // The alias names the same event surface but never a different one.
    const alias = await diagnostics.query({ probe: 'hearing.noise.shadow', limit: 1 });
    assert.equal(alias.ok, true);
    assert.equal(alias.rows[0].durationMs, 900);
    assert.equal(redactDiagnosticText('sk-abcdefghijklmnop'), '[redacted]');
  } finally {
    f.cleanup();
  }
});

test('6. HTTP action answers the probe and records diagnostics.query', async () => {
  const { apply } = await import('../src/host/index.js');
  const root = mkdtempSync(join(tmpdir(), 'dsh-diagnostics-action-'));
  const handlers = new Map();
  const disposers = [];
  const effect = (fn) => {
    const value = fn();
    disposers.push(value);
    return value;
  };
  const services = {
    systemPrompt: { section: () => ({ dispose() {} }) },
    webServer: {
      register: ({ path, handler }) => {
        handlers.set(path, handler);
        return { dispose() { handlers.delete(path); } };
      },
    },
  };
  const ctx = {
    effect,
    get: () => undefined,
    tools: { register: () => () => {} },
    inject(names, fn) {
      const scope = { effect };
      for (const key of names) scope[key] = services[key];
      fn(new Proxy(scope, { get: (target, key) => (key in target ? target[key] : () => ({ dispose() {} })) }));
    },
  };
  let mounted = false;
  try {
    apply(ctx, { root, defaultDomain: 'chat', enabled: true, diagnostics: { enabled: true } });
    mounted = true;
    const handler = handlers.get('/assistant/action');
    assert.equal(typeof handler, 'function', 'the action route is mounted');

    const invoke = (payload) => new Promise((resolve, reject) => {
      const request = Readable.from([JSON.stringify(payload)]);
      request.method = 'POST';
      const response = {
        statusCode: 0,
        body: '',
        writeHead(code) { this.statusCode = code; },
        end(text) { this.body = text; resolve({ status: this.statusCode, body: JSON.parse(text) }); },
      };
      handler(request, response).catch(reject);
    });

    const answered = await invoke({ action: 'diagnostics.query', probe: 'memory.stats', limit: 5 });
    assert.equal(answered.status, 200);
    assert.equal(answered.body.ok, true);
    assert.equal(answered.body.probe, 'memory.stats');
    assert.equal(answered.body.rows.length, 1);
    assert.equal(typeof answered.body.rows[0].candidate, 'number');
    assert.equal(typeof answered.body.rows[0].delivered, 'number');
    assert.equal(typeof answered.body.rows[0].persisted, 'number');
    assert.equal(answered.body.truncated, false);
    assert.ok(Number.isInteger(answered.body.ms) && answered.body.ms >= 0);

    const rejected = await invoke({ action: 'diagnostics.query', probe: 'raw.events' });
    assert.equal(rejected.body.ok, false);
    assert.equal(rejected.body.reason, 'invalid-probe');

    const hotkeys = await invoke({ action: 'diagnostics.query', probe: 'hotkeys' });
    assert.equal(hotkeys.body.ok, true);
    assert.ok(Array.isArray(hotkeys.body.rows[0].bindings));
    assert.equal(typeof hotkeys.body.rows[0].lastAction, 'string');

    const spout = await invoke({ action: 'diagnostics.query', probe: 'spout' });
    assert.equal(spout.body.ok, true);
    assert.equal(typeof spout.body.rows[0].running, 'boolean');
    assert.equal(Object.hasOwn(spout.body.rows[0], 'electronExecutable'), false, 'executable path is not a probe field');

    const auditFile = join(root, 'data', 'events.jsonl');
    const readAudit = () => {
      try {
        return readFileSync(auditFile, 'utf8')
          .trim().split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line))
          .filter((row) => row.type === 'diagnostics.query');
      } catch {
        return [];
      }
    };
    // The audit is fire-and-forget now, so the response can beat the appendFile write: wait for
    // the three audited queries instead of assuming they already landed on disk.
    let audit = readAudit();
    const deadline = Date.now() + 2000;
    while (audit.length < 3 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      audit = readAudit();
    }
    assert.equal(audit.length, 3, 'three audited queries');
    for (const row of audit) {
      assert.deepEqual(Object.keys(row.payload).sort(), ['limit', 'ms', 'probe', 'truncated']);
    }
    // Fire-and-forget writes can finish in a different order. Match identity, and still require
    // exactly one audit for every accepted probe with the original request/result fields.
    assert.deepEqual(audit.map((row) => row.payload.probe).sort(), ['hotkeys', 'memory.stats', 'spout']);
    const memoryAudit = audit.find((row) => row.payload.probe === 'memory.stats');
    assert.equal(memoryAudit.payload.limit, 5);
    assert.equal(memoryAudit.payload.truncated, false);
    assert.equal(memoryAudit.payload.ms, answered.body.ms);
  } finally {
    if (mounted) {
      for (const entry of disposers.reverse()) {
        if (typeof entry === 'function') await entry();
        else await entry?.dispose?.();
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('7. a never-settling audit logger cannot delay the query', async () => {
  const f = fixture([event('voice.latency', { totalMs: 222, asrMs: 40 }, 1000)]);
  const audits = [];
  let release;
  const hanging = new Promise((resolve) => { release = resolve; });
  const diagnostics = createDiagnostics({
    root: f.root,
    isEnabled: true,
    emit: (type, payload) => {
      audits.push({ type, payload });
      return hanging; // never settles; the old `await audit()` pinned the query here
    },
  });
  try {
    const started = performance.now();
    const result = await diagnostics.query({ probe: 'voice.latency', limit: 5 });
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 200, `query waited on the audit logger (${elapsed.toFixed(1)} ms)`);
    assert.equal(result.ok, true);
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].totalMs, 222);
    assert.equal(result.truncated, false);
    assert.equal(audits.length, 1, 'the audit is still attempted, just not awaited');
    assert.equal(audits[0].type, 'diagnostics.query');
    assert.equal(audits[0].payload.probe, 'voice.latency');
    release();
  } finally {
    f.cleanup();
  }
});

test('8. a throwing audit logger leaves the answer intact and reports diagnostics.audit.failed', async () => {
  const f = fixture([event('voice.latency', { totalMs: 333 }, 1000)]);
  const queries = [];
  const failures = [];
  const diagnostics = createDiagnostics({
    root: f.root,
    isEnabled: true,
    emit: (type, payload) => {
      if (type === 'diagnostics.query') {
        queries.push(payload);
        throw new Error('audit sink down: token=SECRET-VALUE'); // synchronous throw
      }
      failures.push({ type, payload });
      return Promise.resolve();
    },
  });
  try {
    const result = await diagnostics.query({ probe: 'voice.latency', limit: 5 });
    assert.equal(result.ok, true);
    assert.equal(result.rows[0].totalMs, 333);
    assert.equal(queries.length, 1);

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(failures.length, 1, 'the failure is recorded asynchronously');
    assert.equal(failures[0].type, 'diagnostics.audit.failed');
    assert.deepEqual(Object.keys(failures[0].payload), ['error']);
    assert.ok(failures[0].payload.error.includes('audit sink down'));
    assert.equal(failures[0].payload.error.includes('SECRET-VALUE'), false, 'failure detail is redacted');

    // Same guarantee when the logger rejects instead of throwing.
    const rejectedFailures = [];
    const rejecting = createDiagnostics({
      root: f.root,
      isEnabled: true,
      emit: (type) => {
        if (type === 'diagnostics.query') return Promise.reject(new Error('async audit down'));
        rejectedFailures.push(type);
        return Promise.resolve();
      },
    });
    const rejectedResult = await rejecting.query({ probe: 'voice.latency', limit: 5 });
    assert.equal(rejectedResult.ok, true);
    assert.equal(rejectedResult.rows[0].totalMs, 333);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(rejectedFailures, ['diagnostics.audit.failed']);
  } finally {
    f.cleanup();
  }
});

test('9. a normal audit logger still records diagnostics.query, asynchronously', async () => {
  const f = fixture([event('voice.latency', { totalMs: 444 }, 1000)]);
  const audits = [];
  // The logger is held open on purpose: the query must resolve while this gate is still closed.
  let releaseAudit = null;
  const auditGate = new Promise((resolve) => { releaseAudit = resolve; });
  const diagnostics = createDiagnostics({
    root: f.root,
    isEnabled: true,
    emit: (type, payload) => auditGate.then(() => {
      audits.push({ type, payload });
    }),
  });
  try {
    const result = await diagnostics.query({ probe: 'voice.latency', limit: 3 });
    assert.equal(result.ok, true);
    assert.equal(result.rows[0].totalMs, 444);
    // Deterministic ordering: the audit was *attempted* (fire-and-forget) but its logger is still
    // blocked, so the query must have resolved without waiting for it.
    assert.equal(audits.length, 0, 'the audit lands after the answer, not before it');

    await releaseAudit();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(audits.length, 1);
    assert.equal(audits[0].type, 'diagnostics.query');
    assert.deepEqual(Object.keys(audits[0].payload).sort(), ['limit', 'ms', 'probe', 'truncated']);
    assert.equal(audits[0].payload.probe, 'voice.latency');
    assert.equal(audits[0].payload.limit, 3);
    assert.equal(audits[0].payload.truncated, false);
    assert.equal(audits[0].payload.ms, result.ms, 'the recorded ms is the returned ms');
  } finally {
    f.cleanup();
  }
});

test('10. regression: smoke still passes', async (t) => {
  t.timeout = 180_000;
  const child = spawn(process.execPath, [join(PROJECT_ROOT, 'test', 'smoke.mjs')], {
    cwd: PROJECT_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (bytes) => { stdout += bytes; });
  child.stderr.on('data', (bytes) => { stderr += bytes; });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.equal(code, 0, `smoke failed\n${stderr}\n${stdout}`);
  assert.ok(stdout.includes('SMOKE TEST PASSED'), 'smoke reports its pass line');
});
