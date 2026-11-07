/**
 * R11 regression: child-process `error` events and the host's `hearing.done` consumption.
 *
 * Before this fix `listDevices()` had no `error` listener (ENOENT was an unhandled event), and
 * the host never consumed `hearing.done`, so a dead ffmpeg still made `assistant_listen` report
 * `running:true`. The fake spawn below emits the same events Node does; the host-side logic is
 * exercised through the same `watchHearingExit()` helper `src/host/index.js` uses.
 *
 * Run: node --test test/hearing-exit.mjs
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { listDevices, startHearing, watchHearingExit } from '../src/host/hearing/hearing.js';

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.kills = [];
  }

  kill(signal = 'SIGTERM') {
    this.kills.push(signal);
    queueMicrotask(() => this.emit('close', null, signal));
  }

  exit(code, signal = null) {
    this.emit('close', code, signal);
  }

  fail(error) {
    this.emit('error', error);
  }
}

const fakeRecognizer = () => ({
  createStream: () => ({}),
  isReady: () => false,
  decode: () => {},
  getResult: () => ({ text: '' }),
  isEndpoint: () => false,
  reset: () => {},
});

const startFakeHearing = (child) => startHearing({
  ffmpegPath: 'ffmpeg',
  modelDir: 'models/stream',
  finalModelDir: '',
  device: 'Fake Mic',
  recognizer: fakeRecognizer(),
  finalRecognizer: null,
  spawnProcess: () => child,
});

test('R11a spawn 报 ENOENT：listDevices 返回空数组、记录错误、不崩', async () => {
  const errors = [];
  const devices = await listDevices('C:\\missing\\ffmpeg.exe', {
    spawnProcess: () => {
      const child = new FakeChild();
      queueMicrotask(() => {
        child.fail(Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' }));
      });
      return child;
    },
    onError: (message) => errors.push(message),
  });

  assert.deepEqual(devices, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /ENOENT/u);
});

test('R11a2 spawn 同步抛 ENOENT：同样返回空数组、不崩', async () => {
  const errors = [];
  const devices = await listDevices('C:\\missing\\ffmpeg.exe', {
    spawnProcess: () => {
      throw Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' });
    },
    onError: (message) => errors.push(message),
  });

  assert.deepEqual(devices, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /ENOENT/u);
});

test('R11b 子进程异常退出：running 变 false，并记录 hearing.exit', async () => {
  const child = new FakeChild();
  const session = startFakeHearing(child);
  // Host slot: status.hearing.running is exactly `hearing !== null`.
  let slot = session;
  const exits = [];
  const observed = watchHearingExit(session, {
    isCurrent: () => slot === session,
    onExit: (exit) => {
      exits.push(exit);
      slot = null;
    },
  });

  assert.equal(slot !== null, true, '启动后应为 running:true');
  child.exit(1, null);
  const exit = await observed;

  assert.deepEqual(exits, [exit]);
  assert.equal(exit.code, 1);
  assert.equal(exit.signal, null);
  assert.equal(exit.error, null);
  assert.equal(slot, null);
  assert.equal(slot !== null, false, '退出后 status.hearing.running 必须为 false');
});

test('R11b2 子进程 error（ENOENT）：done reject、会话归零并记录错误', async () => {
  const child = new FakeChild();
  const session = startFakeHearing(child);
  let slot = session;
  const exits = [];
  const observed = watchHearingExit(session, {
    isCurrent: () => slot === session,
    onExit: (exit) => {
      exits.push(exit);
      slot = null;
    },
  });

  const failure = Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' });
  child.fail(failure);

  const rejected = await session.done.then(
    () => assert.fail('spawn 失败时 done 不应 resolve'),
    (error) => error,
  );
  assert.equal(rejected.code, 'ENOENT');

  const exit = await observed;
  assert.equal(exit.error, 'spawn ffmpeg ENOENT');
  assert.equal(slot, null);
  assert.match(session.stats().lastError, /ENOENT/u);
});

test('R11c 正常 stop：槽位归零且不误报 hearing.exit', async () => {
  const child = new FakeChild();
  const session = startFakeHearing(child);
  let slot = session;
  const exits = [];
  const observed = watchHearingExit(session, {
    isCurrent: () => slot === session,
    onExit: (exit) => {
      exits.push(exit);
      slot = null;
    },
  });

  session.stop();
  // stopListening() clears the slot before the child's close event arrives.
  slot = null;
  const exit = await observed;

  assert.equal(exit, null, '显式停止的退出不应再上报一次');
  assert.deepEqual(exits, []);
  assert.equal(slot !== null, false);
  assert.deepEqual(child.kills, ['SIGKILL']);
});

test('R11d 旧 ambient 会话迟到退出：不清掉新会话，也不清空新 partial', async () => {
  // Mirrors the host ambient wiring: one slot + one partial, and every session watched with
  // `isCurrent: () => ambient === session`.
  let ambient = null;
  let partial = '';
  const exits = [];
  const logEvents = [];
  const log = { emit: (type, payload) => logEvents.push({ type, payload }) };
  const bind = (session) =>
    watchHearingExit(session, {
      isCurrent: () => ambient === session,
      onExit: (exit) => {
        exits.push(exit);
        ambient = null;
        partial = '';
        void log.emit('ambient.exit', exit);
      },
    });

  const oldChild = new FakeChild();
  const oldSession = startFakeHearing(oldChild);
  ambient = oldSession;
  partial = 'old partial';
  const oldWatch = bind(oldSession);

  // startAmbient(): stop the old one, then replace the slot with the new session.
  oldSession.stop();
  ambient = null;
  const newChild = new FakeChild();
  const newSession = startFakeHearing(newChild);
  ambient = newSession;
  partial = 'new partial';
  const newWatch = bind(newSession);

  const oldExit = await oldWatch;
  assert.equal(oldExit, null, '被替换会话的退出不能上报');
  assert.equal(ambient, newSession, '旧进程迟到退出不能清掉新会话');
  assert.equal(partial, 'new partial', '旧进程退出不能清掉新会话的 partial');
  assert.deepEqual(exits, []);
  assert.deepEqual(logEvents, [], '旧会话被替换后不应记 ambient.exit');

  newChild.exit(0, null);
  const newExit = await newWatch;
  assert.equal(newExit.code, 0);
  assert.equal(ambient, null);
  assert.equal(partial, '');
  assert.deepEqual(exits, [newExit]);
  assert.deepEqual(logEvents, [
    { type: 'ambient.exit', payload: { code: 0, signal: null, error: null } },
  ]);
});
