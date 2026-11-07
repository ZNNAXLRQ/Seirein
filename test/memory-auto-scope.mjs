/**
 * Gap 1: automatic recording must obey the workspace boundary.
 *
 * A message from another project's session, or from a session whose cwd cannot be determined,
 * never reaches memory and is reported as `memory.auto.skipped {reason}`. A session inside the
 * configured workspace records normally, and a disabled memory component stays completely inert.
 *
 * Run: node --test test/memory-auto-scope.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createAutoMemoryRecorder } from '../src/host/index.js';
import { MemoryStore } from '../src/host/memory/store.js';

const SCOPE_PATH = 'C:\\Work\\seirein';

async function tempRoot() {
  return mkdtemp(join(tmpdir(), 'dsh-mem-scope-'));
}

async function cleanup(root, memory) {
  try {
    memory.close();
  } catch {
    /* already closed */
  }
  await rm(root, { recursive: true, force: true }).catch(() => {});
}

function eventLog() {
  const events = [];
  return {
    events,
    async emit(type, payload) {
      events.push({ type, payload });
      return { type, payload };
    },
  };
}

function userEvent(id, text, time = Date.now()) {
  return {
    type: 'user/message',
    time,
    data: { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
  };
}

/** The recorder only sees this verdict; index.js builds it from sessionCwd + sameDirectory. */
const scopeOf = (session) => {
  const cwd = session?.header?.cwd;
  if (typeof cwd !== 'string' || cwd.trim().length === 0) return 'no-cwd';
  return cwd.toLowerCase() === SCOPE_PATH.toLowerCase() ? 'in-scope' : 'out-of-scope';
};

test('out-of-scope, cwd-less and disabled lanes never write; in-scope writes normally', async (t) => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 2000 });
  t.after(() => cleanup(root, memory));
  const log = eventLog();
  const recorder = createAutoMemoryRecorder({
    memory,
    log,
    settings: { enabled: true, minChars: 1, maxChars: 400, includeReply: true },
    scopeOf,
  });

  // 1. In scope: the utterance lands.
  await recorder.handle({ id: 'inside', header: { cwd: SCOPE_PATH } }, userEvent('inside-u', '作用域内的这句话要入库'));
  assert.equal(memory.messageRecords({ sessionId: 'inside', limit: 10 }).length, 1, 'in-scope message is stored');

  // 2. Another project: no row, and the skip reason names the cause.
  await recorder.handle(
    { id: 'outside', header: { cwd: 'D:\\Other\\project' } },
    userEvent('outside-u', '别的项目里的这句话不能进助手记忆'),
  );
  assert.equal(memory.messageRecords({ sessionId: 'outside', limit: 10 }).length, 0, 'out-of-scope is not stored');
  const outSkip = log.events.find(
    (event) => event.type === 'memory.auto.skipped' && event.payload.sessionId === 'outside',
  );
  assert.equal(outSkip?.payload.reason, 'out-of-scope');

  // 3. Unknown cwd: default deny, never "record anyway".
  await recorder.handle({ id: 'unknown' }, userEvent('unknown-u', '没有 cwd 的会话也不能入库'));
  assert.equal(memory.messageRecords({ sessionId: 'unknown', limit: 10 }).length, 0, 'no-cwd is not stored');
  const noCwdSkip = log.events.find(
    (event) => event.type === 'memory.auto.skipped' && event.payload.sessionId === 'unknown',
  );
  assert.equal(noCwdSkip?.payload.reason, 'no-cwd');

  // Only the in-scope row exists, and there was no `memory.auto` write for the two rejects.
  assert.equal(memory.messageRecords({ limit: 100 }).length, 1);
  assert.equal(log.events.filter((event) => event.type === 'memory.auto').length, 1);
  assert.deepEqual(
    log.events.filter((event) => event.type === 'memory.auto.skipped').map((event) => event.payload.reason).sort(),
    ['no-cwd', 'out-of-scope'],
  );
});

test('a disabled memory component records nothing and emits no skip noise', async (t) => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 2000 });
  t.after(() => cleanup(root, memory));
  const log = eventLog();
  const recorder = createAutoMemoryRecorder({
    memory,
    log,
    settings: { enabled: true, minChars: 1, maxChars: 400, includeReply: true },
    featureEnabled: () => false,
    scopeOf,
  });

  await recorder.handle({ id: 'off', header: { cwd: SCOPE_PATH } }, userEvent('off-u', '组件关闭时这句话不入库'));
  assert.equal(memory.messageRecords({ limit: 100 }).length, 0);
  assert.equal(log.events.filter((event) => event.type === 'memory.auto').length, 0);
  assert.equal(log.events.filter((event) => event.type === 'memory.auto.skipped').length, 0);

  console.log('[scope] in-scope=1 row; out-of-scope=skip out-of-scope; no-cwd=skip no-cwd; feature-off=inert');
});
