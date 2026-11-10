import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  STARTUP_DIAGNOSTIC_LIMITS,
  installStartupDiagnostics,
} from '../src/host/runtime/startup-diagnostics.js';

function fixture(overrides = {}) {
  const proc = new EventEmitter();
  const rejections = [];
  const exceptions = [];
  const uninstall = installStartupDiagnostics({
    proc,
    onRejection: (summary) => { rejections.push(summary); },
    onException: (summary) => { exceptions.push(summary); },
    ...overrides,
  });
  return { proc, rejections, exceptions, uninstall };
}

test('records both event kinds as bounded summaries and removes exactly its own listeners', () => {
  const f = fixture();
  assert.equal(f.proc.listenerCount('unhandledRejection'), 1);
  assert.equal(f.proc.listenerCount('uncaughtException'), 1);

  const error = new Error('primary startup failure');
  error.name = 'StartupError';
  f.proc.emit('unhandledRejection', error, Promise.resolve());
  f.proc.emit('uncaughtException', error, 'uncaughtException');

  assert.equal(f.rejections.length, 1);
  assert.equal(f.exceptions.length, 1);
  assert.equal(f.rejections[0].reasonType, 'error');
  assert.equal(f.rejections[0].name, 'StartupError');
  assert.equal(f.rejections[0].message, 'primary startup failure');
  assert.match(f.rejections[0].stack, /primary startup failure/);
  assert.equal(f.rejections[0].messageTruncated, false);
  assert.equal(f.rejections[0].stackTruncated, false);
  assert.deepEqual(f.exceptions[0], f.rejections[0]);

  f.uninstall();
  assert.equal(f.proc.listenerCount('unhandledRejection'), 0);
  assert.equal(f.proc.listenerCount('uncaughtException'), 0);

  f.proc.emit('unhandledRejection', new Error('late'));
  f.proc.emit('uncaughtException', new Error('late'));
  assert.equal(f.rejections.length, 1);
  assert.equal(f.exceptions.length, 1);
});

test('error name/message/stack are clipped to fixed limits', () => {
  const f = fixture();
  const error = new Error('m'.repeat(10_000));
  error.stack = 's'.repeat(10_000);
  f.proc.emit('unhandledRejection', error, Promise.resolve());

  const summary = f.rejections[0];
  assert.equal(summary.message.length, STARTUP_DIAGNOSTIC_LIMITS.messageChars);
  assert.equal(summary.stack.length, STARTUP_DIAGNOSTIC_LIMITS.stackChars);
  assert.equal(summary.messageTruncated, true);
  assert.equal(summary.stackTruncated, true);
  f.uninstall();
});

test('huge, circular, hostile and credential-bearing reasons never throw and stay bounded', () => {
  const f = fixture();

  const circular = { message: 'cycle' };
  circular.self = circular;
  circular.huge = 'x'.repeat(200_000);
  assert.doesNotThrow(() => f.proc.emit('unhandledRejection', circular, Promise.resolve()));
  const summary = f.rejections[0];
  assert.equal(summary.reasonType, 'object');
  assert.ok(summary.reasonText.length <= STARTUP_DIAGNOSTIC_LIMITS.textChars);
  assert.match(summary.reasonText, /\[circular\]/);
  assert.equal(JSON.stringify(summary).includes('x'.repeat(2000)), false);

  const secret = {
    password: 'hunter2',
    token: 'token-value',
    authorization: 'Bearer secret',
    nested: { apiKey: 'key-value', ok: true },
    get boom() { throw new Error('getter must not run'); },
  };
  assert.doesNotThrow(() => f.proc.emit('unhandledRejection', secret, Promise.resolve()));
  const redacted = f.rejections[1].reasonText;
  assert.match(redacted, /password:\[redacted\]/);
  assert.match(redacted, /authorization:\[redacted\]/);
  assert.match(redacted, /nested:\{apiKey:\[redacted\], ok:true\}/);
  assert.equal(redacted.includes('hunter2'), false);
  assert.equal(redacted.includes('token-value'), false);
  assert.equal(redacted.includes('key-value'), false);
  assert.equal(redacted.includes('getter must not run'), false);

  assert.doesNotThrow(() => f.proc.emit('unhandledRejection', Array.from({ length: 100_000 })));
  assert.equal(f.rejections[2].reasonType, 'array');
  assert.ok(f.rejections[2].reasonText.length <= STARTUP_DIAGNOSTIC_LIMITS.textChars);

  assert.doesNotThrow(() => f.proc.emit('uncaughtException', 'plain text reason'));
  assert.equal(f.exceptions[0].reasonType, 'string');
  assert.equal(f.exceptions[0].reasonText, 'plain text reason');

  f.uninstall();
});

test('uninstall is idempotent and never removes foreign listeners', () => {
  const f = fixture();
  const foreign = () => {};
  f.proc.on('unhandledRejection', foreign);
  f.proc.on('uncaughtException', foreign);

  f.uninstall();
  f.uninstall();
  assert.equal(f.proc.listenerCount('unhandledRejection'), 1);
  assert.equal(f.proc.listenerCount('uncaughtException'), 1);

  f.proc.emit('unhandledRejection', new Error('late'));
  f.proc.emit('uncaughtException', new Error('late'));
  assert.equal(f.rejections.length, 0);
  assert.equal(f.exceptions.length, 0);
});

test('never calls preventDefault, whether or not the reason provides one', () => {
  let preventDefaultCalls = 0;
  const proc = new EventEmitter();
  const uninstall = installStartupDiagnostics({
    proc,
    onRejection: () => { throw new Error('logger unavailable'); },
    onException: () => { throw new Error('logger unavailable'); },
  });

  const reason = { preventDefault() { preventDefaultCalls += 1; } };
  const promise = { preventDefault() { preventDefaultCalls += 1; } };
  assert.doesNotThrow(() => proc.emit('unhandledRejection', reason, promise));
  assert.doesNotThrow(() => proc.emit('unhandledRejection', 'no preventDefault here', Promise.resolve()));

  const error = new Error('boom');
  error.preventDefault = () => { preventDefaultCalls += 1; };
  assert.doesNotThrow(() => proc.emit('uncaughtException', error, 'uncaughtException'));
  assert.equal(preventDefaultCalls, 0);

  uninstall();
  assert.equal(proc.listenerCount('unhandledRejection'), 0);
  assert.equal(proc.listenerCount('uncaughtException'), 0);
});

test('an async logging callback that rejects does not become another unhandled rejection', async () => {
  const proc = new EventEmitter();
  const uninstall = installStartupDiagnostics({
    proc,
    onRejection: async () => { throw new Error('sink down'); },
    onException: async () => { throw new Error('sink down'); },
  });

  proc.emit('unhandledRejection', new Error('original'), Promise.resolve());
  proc.emit('uncaughtException', new Error('original'), 'uncaughtException');
  await new Promise((resolve) => { setImmediate(resolve); });

  uninstall();
  assert.equal(proc.listenerCount('unhandledRejection'), 0);
  assert.equal(proc.listenerCount('uncaughtException'), 0);
});
