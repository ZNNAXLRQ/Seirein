/**
 * R13 static regression for the always-on rollover poller in `client.js`.
 *
 * The browser bundle cannot be imported in Node (it is a `window.__ModuleLoader__` wrapper that
 * needs React and a DOM), so these are source-order assertions over the shipped file: the poll
 * interval must be stored on a handle that a reload can clear, the removed `client.diag` action
 * must be gone, and a rollover retry must be claimed once before the composer retry loop.
 *
 * Run: node --test test/client-polling.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = await readFile(join(here, '..', 'client.js'), 'utf8');

test('the poll interval is stored on a window handle, not left anonymous', () => {
  assert.match(source, /const POLL_KEY = '__seireinPoll';/u);
  assert.match(source, /window\[POLL_KEY\] = handle;/u);
  assert.match(source, /const handle = \{[^}]*timer: null/u);
  assert.match(source, /handle\.timer = setInterval\(/u);
  // The old anonymous `setInterval(async () => ..., 1500)` must not survive.
  assert.doesNotMatch(source, /^\s*setInterval\(async \(\) => \{/mu);
});

test('startPolling sweeps the previous generation before installing a new timer', () => {
  const start = source.indexOf('function startPolling()');
  const stopCall = source.indexOf('stopPolling();', start);
  const install = source.indexOf('handle.timer = setInterval(', start);
  assert.ok(start > 0, 'startPolling is defined');
  assert.ok(stopCall > start, 'startPolling calls stopPolling first');
  assert.ok(install > stopCall, 'the new timer is installed after the old one is gone');
  // apply() is the injection point, so every activation (and every reload) arms the poller.
  const apply = source.indexOf('apply(ctx) {');
  const arm = source.indexOf('startPolling();', apply);
  const slots = source.indexOf('ctx.slots.inject', apply);
  assert.ok(apply > 0 && arm > apply && slots > arm, 'apply arms the poller, then registers slots');
});

test('stopPolling clears the stored interval and drops its listeners', () => {
  assert.match(source, /function stopPolling\(\)/u);
  assert.match(source, /clearInterval\(previous\.timer\)/u);
  assert.match(source, /const entry of previous\.listeners \?\? \[\]/u);
  assert.match(source, /removeEventListener\?\.\(entry\.type, entry\.handler, entry\.options\)/u);
  assert.match(source, /window\[POLL_KEY\] = null;/u);
});

test('the removed client.diag action is never called again', () => {
  assert.doesNotMatch(source, /client\.diag/u);
});

// The cleanup path is pure apart from `window` and `clearInterval`, so run the shipped slice
// against a fake page: a reload must be able to kill the previous generation with no leftovers.
const loadStopPolling = () => {
  const startMarker = "    const POLL_KEY = '__seireinPoll';";
  const endMarker = '    /** Install exactly one poller on this page, replacing any older one. */';
  const from = source.indexOf(startMarker);
  const to = source.indexOf(endMarker, from);
  assert.ok(from > 0 && to > from, 'the poller header is found in client.js');
  const slice = source.slice(from, to);
  return (window, clearInterval) => new Function(
    'window', 'clearInterval', `${slice}\nreturn { stopPolling, POLL_KEY };`,
  )(window, clearInterval);
};

test('stopPolling clears a seeded timer, removes its listener and is idempotent', () => {
  const cleared = [];
  const removed = [];
  const fakeWindow = {};
  const { stopPolling, POLL_KEY } = loadStopPolling()(fakeWindow, (id) => cleared.push(id));
  assert.equal(POLL_KEY, '__seireinPoll');

  // No poller yet: safe no-op.
  assert.doesNotThrow(() => stopPolling());
  assert.deepEqual(cleared, []);

  const target = { removeEventListener: (...args) => removed.push(args) };
  fakeWindow[POLL_KEY] = {
    timer: 42,
    listeners: [{ target, type: 'visibilitychange', handler: () => {}, options: undefined }],
  };
  stopPolling();
  assert.deepEqual(cleared, [42], 'the previous interval is cleared');
  assert.equal(removed.length, 1, 'the previous listener is removed');
  assert.equal(removed[0][0], 'visibilitychange', 'the listener type is passed through');
  assert.equal(removed[0].length, 3, 'type, handler and options are all passed to removeEventListener');
  assert.equal(fakeWindow[POLL_KEY], null, 'the handle is dropped');
  // Running it again must not throw and must not double-clear.
  assert.doesNotThrow(() => stopPolling());
  assert.deepEqual(cleared, [42]);
});

// Same trick for the whole poller: run the shipped startPolling/stopPolling pair on a fake page
// and count intervals, which is exactly what a plugin reload does in the real bundle.
const loadPolling = () => {
  const from = source.indexOf("    const POLL_KEY = '__seireinPoll';");
  const to = source.indexOf('    function Panel() {', from);
  assert.ok(from > 0 && to > from, 'the poller block is found in client.js');
  const slice = source.slice(from, to);
  return (page) => new Function(
    'window', 'setInterval', 'clearInterval', 'fetch', 'document', 'console', 'CLIENT_VERSION',
    `${slice}\nreturn { startPolling, stopPolling, POLL_KEY };`,
  )(page.window, page.setInterval, page.clearInterval, page.fetch, page.document, page.console, 'test');
};

test('re-arming the poller leaves exactly one interval, and stopPolling clears it', () => {
  const installed = [];
  const cleared = [];
  const page = {
    window: {},
    document: {},
    console: { warn() {} },
    fetch: async () => ({ ok: false, json: async () => ({}) }),
    setInterval: (callback) => { installed.push(callback); return installed.length; },
    clearInterval: (id) => { cleared.push(id); },
  };
  const { startPolling, stopPolling, POLL_KEY } = loadPolling()(page);

  const first = startPolling();
  assert.equal(first.timer, 1, 'the first interval id is stored on the handle');
  assert.equal(page.window[POLL_KEY], first);

  const second = startPolling();
  assert.deepEqual(cleared, [1], 're-arming clears the previous interval');
  assert.equal(second.timer, 2);
  assert.equal(page.window[POLL_KEY], second, 'the window handle points at the live generation');

  stopPolling();
  assert.deepEqual(cleared, [1, 2]);
  assert.equal(page.window[POLL_KEY], null);
});


test('a rollover retry is claimed before the composer retry loop starts', () => {
  const claim = source.indexOf("action: 'rollover.claim'");
  const retry = source.indexOf('for (let attempt = 0; attempt < 20');
  assert.ok(claim > 0, 'the host claim action is called');
  assert.ok(retry > claim, 'the claim happens before the 20x300ms retry loop');
  assert.match(source, /claim\.claimed !== false/u);
  // Fallback for hosts without rollover.claim: a timestamp lock, 10 s per winner.
  assert.match(source, /ROLLOVER_LOCK_KEY/u);
  assert.match(source, /ROLLOVER_LOCK_MS = 10000;/u);
  assert.match(source, /window\.sessionStorage/u);
  assert.match(source, /now - last < ROLLOVER_LOCK_MS/u);
});

// ---- Lifecycle: generation cancellation ------------------------------------------------
// This file also pins the fix for the polling lifecycle gap: stopPolling() must invalidate the
// generation and abort the in-flight request, every await in tick must re-check the generation
// before touching the page, and apply() must unregister exactly its own generation on unload.

test('stopPolling cancels the generation and aborts its in-flight request', () => {
  const start = source.indexOf('function stopPolling()');
  const end = source.indexOf('/** Monotonic poll generation', start);
  assert.ok(start > 0 && end > start, 'stopPolling body is found');
  const stop = source.slice(start, end);
  assert.match(stop, /previous\.cancelled = true;/u);
  assert.match(stop, /previous\.controller\?\.abort\(\);/u);
  // Invalidate before releasing the interval: nothing can slip past the flag afterwards.
  assert.ok(
    stop.indexOf('previous.cancelled = true;') < stop.indexOf('clearInterval(previous.timer)'),
    'the generation is invalidated before the timer is cleared',
  );
});

test('the poller handle carries a generation, a cancel flag and an AbortController', () => {
  const start = source.indexOf('function startPolling()');
  const end = source.indexOf('function Panel()', start);
  assert.ok(start > 0 && end > start, 'startPolling body is found');
  const poller = source.slice(start, end);
  assert.match(poller, /generation: \(pollGeneration \+= 1\)/u);
  assert.match(poller, /cancelled: false/u);
  assert.match(poller, /controller: new AbortController\(\)/u);
  // Both requests the poller owns must be abortable with that controller.
  assert.match(poller, /fetch\('\/assistant\/status', \{[\s\S]*?signal: handle\.controller\.signal/u);
  assert.match(poller, /fetch\('\/assistant\/action', \{[\s\S]*?signal: handle\.controller\.signal/u);
});

test('every await in tick re-checks the generation before touching the page', () => {
  const tickStart = source.indexOf('const tick = async () => {');
  const tickEnd = source.indexOf('handle.timer = setInterval(', tickStart);
  assert.ok(tickStart > 0 && tickEnd > tickStart, 'tick body is found');
  const tick = source.slice(tickStart, tickEnd);
  const checks = tick.match(/if \(handle\.cancelled \|\| window\[POLL_KEY\] !== handle\) return;/gu) ?? [];
  assert.ok(checks.length >= 6, `tick re-checks after every await (found ${checks.length})`);
  // The 20x300ms retry checks on every round, and again after the composer await.
  assert.match(
    tick,
    /await new Promise\(\(resolve\) => setTimeout\(resolve, 300\)\);\s*\n\s*\/\/ Each retry round[^\n]*\n\s*if \(handle\.cancelled \|\| window\[POLL_KEY\] !== handle\) return;/u,
  );
  assert.match(
    tick,
    /typed = await typeIntoComposer\(data\.rollover\.digest, isActive\);\s*\n\s*\/\/ The outer check[^\n]*\n\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*if \(!isActive\(\)\) return;/u,
  );
  // The host rollover claim is also generation-gated after its await.
  assert.match(
    source,
    /const claim = await action\(\{ action: 'rollover\.claim' \}\);\s*\n\s*\/\/ The generation may have stopped[^\n]*\n\s*if \(handle\.cancelled \|\| window\[POLL_KEY\] !== handle\) return false;/u,
  );
  // An aborted request is expected silence, never an error.
  assert.match(tick, /error\?\.name === 'AbortError'/u);
  assert.doesNotMatch(source, /console\.error/u);
});

test('apply unregisters exactly its own generation on unload', () => {
  const apply = source.indexOf('apply(ctx) {');
  assert.ok(apply > 0, 'apply is found');
  const cleanup = source.indexOf('ctx.effect(() => () => {', apply);
  assert.ok(cleanup > apply, 'apply registers an effect cleanup');
  const body = source.slice(cleanup, source.indexOf('const options =', cleanup));
  assert.match(body, /window\[POLL_KEY\] === handle/u);
  assert.match(body, /stopPolling\(\)/u);
  assert.match(source, /const handle = startPolling\(\);/u);
});

// ---- Lifecycle behaviour ---------------------------------------------------------------
// Run the shipped slice against a fake page. The factory only needs browser globals at call
// time, so the real tick/stopPolling/apply code executes in Node with controllable fetches.

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

/** A fake page: controllable status/action replies, and a recorder for every page action. */
const makePage = ({ status, action } = {}) => {
  const calls = {
    status: [], action: [], openWorkspace: [], startSession: [], dom: 0, clears: [], errors: [], timers: [],
  };
  const uiWorkspace = {
    openWorkspace: async (id) => { calls.openWorkspace.push(id); },
    startSession: (id) => { calls.startSession.push(id); },
  };
  return {
    calls,
    window: { __seireinCtx: { get: (name) => (name === 'uiWorkspace' ? uiWorkspace : undefined) } },
    document: {
      querySelector: () => { calls.dom += 1; return null; },
      querySelectorAll: () => { calls.dom += 1; return []; },
      body: {},
    },
    console: { warn: () => {}, error: (...args) => { calls.errors.push(args); } },
    setInterval: (callback) => { calls.timers.push(callback); return calls.timers.length; },
    clearInterval: (id) => { calls.clears.push(id); },
    fetch: (url, init) => {
      if (url === '/assistant/status') {
        calls.status.push(init);
        return status(init, calls.status.length);
      }
      const body = JSON.parse(init.body);
      calls.action.push({ body, init });
      return action(body, init);
    },
  };
};

const makePageWith = (overrides = {}) => makePage({
  status: async () => ({ ok: true, json: async () => ({}) }),
  action: async () => ({ ok: true, claimed: true }),
  ...overrides,
});

const loadPollerSlice = (text) => {
  const from = text.indexOf("    const POLL_KEY = '__seireinPoll';");
  const to = text.indexOf('    function Panel() {', from);
  assert.ok(from > 0 && to > from, 'the poller block is found in client.js');
  const slice = text.slice(from, to);
  return (page) => new Function(
    'window', 'setInterval', 'clearInterval', 'fetch', 'document', 'console', 'CLIENT_VERSION',
    `${slice}\nreturn { startPolling, stopPolling, POLL_KEY };`,
  )(page.window, page.setInterval, page.clearInterval, page.fetch, page.document, page.console, 'test');
};

const loadPluginSlice = (text) => {
  const from = text.indexOf("    const POLL_KEY = '__seireinPoll';");
  const to = text.lastIndexOf('    };');
  assert.ok(from > 0 && to > from, 'the plugin block is found in client.js');
  const slice = text.slice(from, to + '    };'.length);
  return (page) => new Function(
    'window', 'setInterval', 'clearInterval', 'fetch', 'document', 'console', 'CLIENT_VERSION',
    `${slice}`,
  )(page.window, page.setInterval, page.clearInterval, page.fetch, page.document, page.console, 'test');
};

// a) The request the first tick issued lands after stopPolling(): no hello, ping, claim,
//    openWorkspace, startSession, composer typing or DOM poke may run.
test('a cancelled tick performs no page action when its status reply lands late', async () => {
  let resolveStatus;
  const page = makePageWith({
    status: () => new Promise((resolve) => { resolveStatus = resolve; }),
  });
  const { startPolling, stopPolling, POLL_KEY } = loadPollerSlice(source)(page);

  const handle = startPolling();
  assert.equal(page.calls.status.length, 1, 'the first tick issues the status request');
  assert.equal(page.calls.status[0].signal, handle.controller.signal, 'the request is abortable');
  assert.equal(page.calls.action.length, 0, 'nothing is sent before the reply arrives');

  stopPolling();
  assert.equal(handle.cancelled, true, 'the generation is invalidated');
  assert.equal(handle.controller.signal.aborted, true, 'the in-flight request is aborted');
  assert.equal(page.window[POLL_KEY], null, 'the window handle is dropped');

  // The reply arrives anyway (a real fetch may resolve before observing the abort).
  resolveStatus({ ok: true, json: async () => ({ rollover: { digest: 'day-2' }, workspace: { id: 'ws-1' } }) });
  await flush();

  assert.deepEqual(page.calls.action, [], 'no hello/ping/claim/ack may reach the host');
  assert.deepEqual(page.calls.openWorkspace, [], 'openWorkspace is skipped');
  assert.deepEqual(page.calls.startSession, [], 'startSession is skipped');
  assert.equal(page.calls.dom, 0, 'no DOM action is attempted');
  assert.deepEqual(page.calls.errors, [], 'the late reply is not reported as an error');
});

// a2) A fetch that honours the abort rejects with AbortError: it must be swallowed, not logged.
test('an aborted generation request is silent, never an error', async () => {
  const page = makePageWith({
    status: (init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';
        reject(error);
      });
    }),
  });
  const { startPolling, stopPolling } = loadPollerSlice(source)(page);

  startPolling();
  stopPolling();
  await flush();

  assert.deepEqual(page.calls.action, []);
  assert.equal(page.calls.dom, 0);
  assert.deepEqual(page.calls.errors, [], 'AbortError is not reported');
});

// b) A tick owned by a replaced generation returns after the new one is installed: it must stay
//    inert even though its reply carries a rollover digest.
test('a replaced generation does nothing when its tick returns after a new generation starts', async () => {
  const statusResolvers = [];
  const page = makePageWith({
    status: () => new Promise((resolve) => { statusResolvers.push(resolve); }),
  });
  const { startPolling, POLL_KEY } = loadPollerSlice(source)(page);

  const first = startPolling();
  const second = startPolling();
  assert.equal(page.calls.status.length, 2, 'each generation issues its own request');
  assert.equal(first.cancelled, true, 'the first generation is cancelled by the re-arm');
  assert.equal(second.cancelled, false);
  assert.equal(page.window[POLL_KEY], second, 'generation two owns the page');
  assert.ok(second.generation > first.generation, 'the generation counter moves forward');

  // Generation two sees an ordinary day: only hello and ping, no rollover.
  statusResolvers[1]({ ok: true, json: async () => ({ rollover: null }) });
  await flush();
  const liveActions = page.calls.action.map((call) => call.body.action).sort();
  assert.deepEqual(liveActions, ['client.hello', 'client.ping']);

  // Generation one's reply lands now; it must not act on a page it no longer owns.
  statusResolvers[0]({
    ok: true,
    json: async () => ({ rollover: { digest: 'stale' }, workspace: { id: 'ws-1' } }),
  });
  await flush();

  assert.deepEqual(
    page.calls.action.map((call) => call.body.action).sort(),
    liveActions,
    'the stale generation adds no hello/ping/claim/ack',
  );
  assert.deepEqual(page.calls.openWorkspace, [], 'openWorkspace is skipped');
  assert.deepEqual(page.calls.startSession, [], 'startSession is skipped');
  assert.equal(page.calls.dom, 0, 'no DOM action is attempted');
});

// c) Hot reload: apply() of generation two installs first, then generation one's disposer runs.
//    The old disposer must not stop the new poller.
test('an unload disposer stops only the generation it armed', async () => {
  const page = makePageWith();
  const plugin = loadPluginSlice(source)(page);
  const disposers = [];
  const makeCtx = () => ({
    effect: (callback) => { disposers.push(callback()); },
    slots: { inject() {}, register() { return () => {}; } },
  });

  plugin.apply(makeCtx());
  const gen1 = page.window.__seireinPoll;
  const gen1Timer = gen1.timer;
  plugin.apply(makeCtx());
  const gen2 = page.window.__seireinPoll;
  const gen2Timer = gen2.timer;

  assert.notEqual(gen1, gen2, 'the second apply installs a fresh generation');
  assert.equal(gen1.cancelled, true, 'the old generation was replaced');
  assert.equal(gen2.cancelled, false);
  assert.equal(page.calls.timers.length, 2, 'two intervals were armed');
  assert.deepEqual(page.calls.clears, [gen1Timer], 'the second apply cleared the old interval');
  await flush();

  // Unload of the first apply only: the new generation must survive untouched.
  disposers[0]();
  assert.equal(page.window.__seireinPoll, gen2, 'the old disposer leaves the live poller installed');
  assert.equal(gen2.cancelled, false, 'the live generation is not cancelled');
  assert.equal(gen2.controller.signal.aborted, false, 'its request controller is untouched');
  assert.deepEqual(page.calls.clears, [gen1Timer], 'the old disposer clears no timer');
  const statusBefore = page.calls.status.length;
  page.calls.timers[1]();
  assert.equal(page.calls.status.length, statusBefore + 1, 'the live poller still ticks');
  await flush();

  // Unload of the second apply stops exactly generation two.
  disposers[1]();
  assert.equal(page.window.__seireinPoll, null, 'the live handle is dropped');
  assert.equal(gen2.cancelled, true);
  assert.equal(gen2.controller.signal.aborted, true);
  assert.deepEqual(page.calls.clears, [gen1Timer, gen2Timer]);
});

// ---- Deferred SEND: the 120ms and 140ms timers must obey the generation ----------------
// A stopPolling() after the fill used to leave both send timers alive, so a stale generation
// clicked SEND anyway. These cases run the shipped typeIntoComposer slice on a fake page and a
// fake clock, so "cancelled before 120ms" and "cancelled inside the 140ms retry" are exact.

const loadComposerSlice = () => {
  const from = source.indexOf('const typeIntoComposer = (text');
  const to = source.indexOf('// Returns the parsed reply', from);
  assert.ok(from > 0 && to > from, 'the typeIntoComposer slice is found in client.js');
  const slice = source.slice(from, to);
  return (page) => new Function(
    'window', 'document', 'setTimeout', 'clearTimeout', 'InputEvent', 'KeyboardEvent', 'handle',
    `${slice}\nreturn typeIntoComposer;`,
  )(page.window, page.document, page.setTimeout, page.clearTimeout,
    page.InputEvent, page.KeyboardEvent, page.handle);
};

/** A virtual clock: only `advance()` moves time, so the 120/140/350ms windows are deterministic. */
const makeComposerClock = () => {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    cleared: [],
    setTimeout(fn, ms) {
      seq += 1;
      timers.set(seq, { id: seq, at: now + ms, fn });
      return seq;
    },
    clearTimeout(id) {
      this.cleared.push(id);
      timers.delete(id);
    },
    pending: () => timers.size,
    async advance(ms) {
      const until = now + ms;
      for (;;) {
        let next = null;
        for (const entry of timers.values()) {
          if (entry.at > until) continue;
          if (next === null || entry.at < next.at
            || (entry.at === next.at && entry.id < next.id)) next = entry;
        }
        if (next === null) break;
        timers.delete(next.id);
        now = next.at;
        next.fn();
        await Promise.resolve(); // let the promise continuation run between timers
      }
      now = until;
    },
  };
};

/** A fake composer: the fill is real (execCommand), a click empties the editor like DSH does. */
const makeComposerPage = (clock) => {
  const calls = { clicks: 0, enters: 0, inputs: 0 };
  const target = {
    tagName: 'DIV',
    textContent: '',
    offsetParent: null,
    focus() {},
    dispatchEvent(event) {
      if (event.type === 'input') calls.inputs += 1;
      if (event.type === 'keydown') calls.enters += 1;
      return true;
    },
  };
  const composer = {
    querySelector: (selector) => (selector === '[contenteditable="true"]' ? target : null),
    querySelectorAll: () => [],
  };
  const sendButton = {
    disabled: false,
    click() {
      calls.clicks += 1;
      target.textContent = ''; // a real send clears the composer
    },
    getAttribute: () => '发送消息',
    closest: () => null,
    parentElement: { parentElement: composer },
  };
  const document = {
    body: {},
    querySelector: (selector) => (selector.startsWith('button') ? sendButton : composer.querySelector(selector)),
    querySelectorAll: () => [],
    createRange: () => ({ selectNodeContents() {} }),
    execCommand: (command, ui, text) => { target.textContent = text; return true; },
  };
  return {
    calls,
    target,
    sendButton,
    handle: {},
    window: { getSelection: () => ({ removeAllRanges() {}, addRange() {} }) },
    document,
    setTimeout: clock.setTimeout.bind(clock),
    clearTimeout: clock.clearTimeout.bind(clock),
    InputEvent: class FakeInputEvent { constructor(type, init) { this.type = type; Object.assign(this, init); } },
    KeyboardEvent: class FakeKeyboardEvent { constructor(type, init) { this.type = type; Object.assign(this, init); } },
  };
};

/** Wire the shipped slice to a fake page plus the generation flag stopPolling() would flip. */
const makeComposer = () => {
  const clock = makeComposerClock();
  const page = makeComposerPage(clock);
  const typeIntoComposer = loadComposerSlice()(page);
  const state = { cancelled: false };
  return {
    clock,
    page,
    typeIntoComposer,
    isActive: () => !state.cancelled,
    // Exactly what stopPolling() does to a deferred SEND: invalidate, then drop its timers.
    stop() {
      state.cancelled = true;
      page.handle.cancelSend?.();
    },
  };
};

// a) Filled, then stopped before the 120ms send timer: the timer is cleared, SEND never happens,
//    and the promise resolves false (the draft was not sent). Before the fix: SEND 1.
test('a cancelled generation never clicks SEND when the stop lands before 120ms', async () => {
  const composer = makeComposer();
  const sent = composer.typeIntoComposer('day-2 digest', composer.isActive);
  assert.equal(composer.page.target.textContent, 'day-2 digest', 'the composer was filled');
  assert.equal(composer.clock.pending(), 1, 'one deferred SEND timer is armed');
  await composer.clock.advance(60);
  assert.equal(composer.page.calls.clicks, 0, 'nothing is clicked while the generation lives');

  composer.stop(); // < 120ms
  assert.equal(composer.clock.pending(), 0, 'the un-fired SEND timer is cleared, not left to run');
  assert.equal(composer.clock.cleared.length, 1, 'clearTimeout was called on that timer');
  await composer.clock.advance(600);
  assert.equal(composer.page.calls.clicks, 0, 'no send click after cancellation');
  assert.equal(composer.page.calls.enters, 0, 'no Enter key is dispatched');
  assert.equal(await sent, false, 'the promise resolves false: nothing was sent');
});

// b) The send button is disabled, so 120ms fell through to the 140ms retry; stopping in that
//    window must drop the retry. Before the fix: SEND 1 (Enter keydown).
test('a cancelled generation never sends from the 140ms retry path', async () => {
  const composer = makeComposer();
  composer.page.sendButton.disabled = true; // forces the re-fill + 140ms retry branch
  const sent = composer.typeIntoComposer('day-2 digest', composer.isActive);
  await composer.clock.advance(120);
  assert.equal(composer.page.calls.inputs, 1, 'the 120ms callback re-filled and armed the retry');
  assert.equal(composer.clock.pending(), 1, 'the 140ms retry is pending');
  assert.equal(composer.page.calls.clicks, 0, 'nothing was sent yet');

  composer.stop(); // between 120ms and 140ms
  assert.equal(composer.clock.pending(), 0, 'the 140ms retry timer is cleared');
  await composer.clock.advance(1000);
  assert.equal(composer.page.calls.clicks, 0, 'no send click after cancellation');
  assert.equal(composer.page.calls.enters, 0, 'no Enter key is dispatched');
  assert.equal(await sent, false, 'the promise resolves false: nothing was sent');
});

// c) A live generation is untouched: the click happens, the editor empties, the promise is true.
test('a live generation still clicks SEND and resolves true only once the editor empties', async () => {
  const composer = makeComposer();
  const sent = composer.typeIntoComposer('day-2 digest', composer.isActive);
  await composer.clock.advance(120);
  assert.equal(composer.page.calls.clicks, 1, 'the send button is clicked');
  assert.equal(composer.clock.pending(), 1, 'only the 350ms confirmation is left');
  await composer.clock.advance(350);
  assert.equal(await sent, true, 'true because the send emptied the editor');
  assert.equal(composer.page.target.textContent, '', 'the editor is empty');
});

// c2) The original guarantee survives: a draft the click did not clear must not resolve true.
test('a click the editor does not confirm resolves false, never true', async () => {
  const composer = makeComposer();
  composer.page.sendButton.click = () => {}; // the click is ignored, the draft survives
  const sent = composer.typeIntoComposer('draft', composer.isActive);
  await composer.clock.advance(120);
  await composer.clock.advance(350);
  assert.equal(await sent, false, 'an unsent draft is never acknowledged as sent');
});

// 4) Static shape: the checks exist literally in submit and in both timer callbacks, and the
//    cancellation path clears the stored timer ids.
test('static: submit and both SEND timers check isActive, and cancel clears their timers', () => {
  const from = source.indexOf('const typeIntoComposer = (text');
  const to = source.indexOf('// Returns the parsed reply', from);
  assert.ok(from > 0 && to > from, 'the typeIntoComposer body is found');
  const fn = source.slice(from, to);
  assert.match(fn, /const typeIntoComposer = \(text, isActive = \(\) => true\)/u);

  const submit = fn.slice(fn.indexOf('const submit = () => {'), fn.indexOf('sendButton.click()'));
  assert.match(submit, /if \(!isActive\(\)\)/u, 'submit checks the generation before clicking SEND');

  const at120 = fn.indexOf('}, 120);');
  const from120 = fn.indexOf('const first = setTimeout');
  const at140 = fn.indexOf('}, 140);');
  const from140 = fn.indexOf('const retry = setTimeout');
  assert.ok(at120 > from120 && from120 > 0, 'the 120ms timer registration is found');
  assert.ok(at140 > from140 && from140 > from120 && at140 < at120, 'the 140ms timer registration is found');
  assert.match(fn.slice(from120, at120), /if \(!isActive\(\)\)/u, 'the 120ms callback checks first');
  assert.match(fn.slice(from140, at140), /if \(!isActive\(\)\)/u, 'the 140ms callback checks before submit');

  // Cancellation keeps the ids, clears the un-fired timers and resolves false, not emptied().
  assert.match(fn, /const pending = new Set\(\);/u);
  assert.match(fn, /pending\.add\(first\);/u);
  assert.match(fn, /pending\.add\(retry\);/u);
  assert.match(fn, /for \(const timer of pending\) clearTimeout\(timer\);/u);
  assert.match(fn, /handle\.cancelSend = \(\) => finish\(false\);/u);
  const cancelPath = fn.slice(fn.indexOf('const finish = '), fn.indexOf('handle.cancelSend = () =>'));
  assert.doesNotMatch(cancelPath, /emptied\(\)/u, 'cancellation never claims the draft was sent');

  // stopPolling() invokes the hook, and tick hands the composer its generation gate.
  assert.match(source, /previous\.cancelSend\?\.\(\);/u);
  assert.match(source, /const isActive = \(\) => !handle\.cancelled && window\[POLL_KEY\] === handle;/u);
  assert.match(source, /typed = await typeIntoComposer\(data\.rollover\.digest, isActive\);/u);
});

test('stopPolling drops the deferred SEND the old generation still owns', () => {
  let cancelled = 0;
  const fakeWindow = {};
  const { stopPolling, POLL_KEY } = loadStopPolling()(fakeWindow, () => {});
  fakeWindow[POLL_KEY] = { timer: 7, listeners: [], cancelSend: () => { cancelled += 1; } };
  stopPolling();
  assert.equal(cancelled, 1, 'the pending composer SEND is cancelled with the generation');
});

