/**
 * P-111 P2 client-local diagnostics regression.
 *
 * `client.js` is a `window.__ModuleLoader__` bundle, so this suite combines static source
 * assertions with a small evaluation of the shipped ring slice (no React, DOM or host needed).
 *
 * Pins:
 *   1. default OFF, both opt-ins (`?seireinDiag=1` / `localStorage.seireinDiag === '1'`);
 *   2. bounded ring (200) whose entries are only `{t, code, generation}`;
 *   3. the fixed code enum covers poll generation change, in-flight abort, SEND cancellation
 *      and unknown action (plus the startSession failure / timeline render observations);
 *   4. no body, digest, error.message, user text or URL query ever enters the ring;
 *   5. no new timer and no network request;
 *   6. `window.__seireinDiag` exists only on enabled pages, and `events()` returns a copy.
 *
 * Run: node --test test/client-local-diagnostics.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'client.js'), 'utf8');

const DIAG_FROM = source.indexOf("    const DIAG_KEY = '__seireinDiag';");
const DIAG_TO = source.indexOf('    /** Stop whatever poller', DIAG_FROM);
assert.ok(DIAG_FROM > 0 && DIAG_TO > DIAG_FROM, 'client.js ships the local diagnostics block');
const diagBlock = source.slice(DIAG_FROM, DIAG_TO);

/** Evaluate only the shipped ring slice with an explicit `window`; nothing else is needed. */
const loadDiag = (window) => new Function(
  'window',
  `${diagBlock}
return { diag, diagRing, diagEnabled, DIAG_MAX_EVENTS, DIAG_EVENT_CODES, DIAG_KEY, DIAG_SWITCH_KEY };`,
)(window);

/** Slice one function body out of client.js; the end marker must follow the start marker. */
const sliceBetween = (startMarker, endMarker) => {
  const from = source.indexOf(startMarker);
  const to = source.indexOf(endMarker, from);
  assert.ok(from > 0 && to > from, `the source slice ${startMarker} is found`);
  return source.slice(from, to);
};

const stopBody = () => sliceBetween('function stopPolling()', '/** Monotonic poll generation');
const startBody = () => sliceBetween('function startPolling()', 'const typeIntoComposer = (text');
const tickBody = () => sliceBetween('const tick = async () => {', 'handle.timer = setInterval(');
const composerBody = () => sliceBetween('const typeIntoComposer = (text', '// Returns the parsed reply');
const actionBody = () => sliceBetween('const action = async (body) => {', '// Announce the bundle');
const timelineBody = () => sliceBetween('function timelineSection(h, { data } = {})', 'const timeline = diagnosticsObject(data);');

const enabledWindow = () => ({ location: { search: '?seireinDiag=1' } });

test('1. default OFF, and both opt-ins (URL / localStorage) enable it', () => {
  // Static contract: the exact key and the exact value '1' gate both entry points.
  assert.match(diagBlock, /const DIAG_SWITCH_KEY = 'seireinDiag';/u);
  assert.match(diagBlock, /new URLSearchParams\(search\)\.get\(DIAG_SWITCH_KEY\) === '1'/u);
  assert.match(diagBlock, /getItem\?\.\(DIAG_SWITCH_KEY\) === '1'/u);
  assert.match(diagBlock, /const diagRing = diagEnabled \? \[\] : null;/u);

  // Default: no window, no query string, no storage.
  const plain = {};
  const plainApi = loadDiag(plain);
  assert.equal(plainApi.diagEnabled, false, 'default is OFF');
  assert.equal(plainApi.diagRing, null, 'OFF creates no ring');
  assert.equal(Object.hasOwn(plain, '__seireinDiag'), false, 'OFF exposes no global');
  plainApi.diag('poll.start', 1);
  assert.equal(Object.hasOwn(plain, '__seireinDiag'), false, 'a call on an OFF page stays inert');

  // URL switch.
  const urlWindow = { location: { search: '?x=1&seireinDiag=1' } };
  assert.equal(loadDiag(urlWindow).diagEnabled, true, '?seireinDiag=1 enables it');
  assert.equal(urlWindow.__seireinDiag.enabled, true);
  for (const search of ['', '?seireinDiag=0', '?seireinDiag=yes', '?other=1', '?seireinDiagx=1']) {
    assert.equal(loadDiag({ location: { search } }).diagEnabled, false, `${search || '(empty)'} stays OFF`);
  }

  // localStorage switch, including an unreadable store.
  const storeWindow = {
    localStorage: { getItem: (key) => (key === 'seireinDiag' ? '1' : null) },
  };
  assert.equal(loadDiag(storeWindow).diagEnabled, true, "localStorage.seireinDiag === '1' enables it");
  assert.equal(
    loadDiag({ localStorage: { seireinDiag: '1' } }).diagEnabled,
    true,
    'a storage object exposing the key as a property also enables it',
  );
  const offStore = { localStorage: { getItem: () => '0' } };
  assert.equal(loadDiag(offStore).diagEnabled, false, "a storage value other than '1' stays OFF");
  const throwingStore = {
    get localStorage() { throw new Error('storage blocked'); },
  };
  assert.equal(loadDiag(throwingStore).diagEnabled, false, 'an unreadable store stays OFF');

  // URL wins over a disabled stored preference.
  const both = {
    location: { search: '?seireinDiag=1' },
    localStorage: { getItem: () => '0' },
  };
  assert.equal(loadDiag(both).diagEnabled, true, 'the URL switch is independent of storage');

  console.log('[1] default=OFF url=ON storage=ON badValues=OFF');
});

test('2. the ring is bounded at 200 and every entry is only {t, code, generation}', () => {
  assert.equal((source.match(/const DIAG_MAX_EVENTS = 200;/u) ?? []).length, 1);
  assert.match(diagBlock, /if \(diagRing\.length > DIAG_MAX_EVENTS\) diagRing\.shift\(\);/u);

  const page = enabledWindow();
  const api = loadDiag(page);
  assert.equal(api.DIAG_MAX_EVENTS, 200);
  assert.ok(Array.isArray(api.diagRing), 'ON creates the ring');

  api.diag('poll.start', 0);
  assert.equal(page.__seireinDiag.events().length, 1, 'one event is recorded');
  assert.deepEqual(
    Object.keys(page.__seireinDiag.events()[0]).sort(),
    ['code', 'generation', 't'],
    'the entry has exactly t / code / generation',
  );
  assert.equal(typeof page.__seireinDiag.events()[0].t, 'number');
  assert.equal(page.__seireinDiag.events()[0].code, 'poll.start');
  assert.equal(page.__seireinDiag.events()[0].generation, 0);

  // Unknown codes are rejected by the fixed enum (no free-form text can become a code).
  api.diag('PRIVATE USER TEXT', 1);
  api.diag('poll.start', 'not-a-number');
  assert.equal(page.__seireinDiag.events().length, 2, 'only the fixed enum is accepted');
  assert.equal(page.__seireinDiag.events()[1].generation, 0, 'a non-numeric generation becomes 0');

  // Non-numeric value sanitization + overflow: 250 more events keep the newest 200.
  for (let index = 0; index < 250; index += 1) api.diag('poll.start', index);
  const bounded = page.__seireinDiag.events();
  assert.equal(bounded.length, 200, 'the ring never exceeds 200');
  assert.equal(bounded[0].generation, 50, 'the oldest entries are dropped first');
  assert.equal(bounded[199].generation, 249, 'the newest event is kept');
  for (const event of bounded) {
    assert.deepEqual(Object.keys(event).sort(), ['code', 'generation', 't']);
  }

  // events() is a snapshot copy; callers cannot mutate the ring through it.
  const copy = page.__seireinDiag.events();
  copy[0].code = 'tampered';
  copy.length = 0;
  assert.equal(page.__seireinDiag.events().length, 200, 'the returned array is a copy');
  assert.equal(page.__seireinDiag.events()[0].code, 'poll.start', 'the returned entries are copies');

  page.__seireinDiag.clear();
  assert.equal(page.__seireinDiag.events().length, 0, 'clear() empties the ring');

  console.log('[2] max=200 entries=3 keys unknownCodes=rejected copy=yes');
});

test('3. the fixed enum covers the four required hook points', () => {
  const api = loadDiag({});
  assert.deepEqual([...api.DIAG_EVENT_CODES], [
    'poll.start',
    'poll.abort',
    'send.cancel',
    'action.unknown',
    'session.start.failed',
    'timeline.render',
  ], 'the event code enum is fixed');
  for (const code of ['poll.start', 'poll.abort', 'send.cancel', 'action.unknown']) {
    assert.ok(api.DIAG_EVENT_CODES.includes(code), `the four required codes include ${code}`);
  }

  // Generation change / old request invalidation.
  assert.match(stopBody(), /diag\('poll\.abort', previous\.generation\);/u,
    'stopping the old generation records poll.abort');
  assert.match(startBody(), /diag\('poll\.start', handle\.generation\);/u,
    'installing a new generation records poll.start');

  // In-flight abort (only when the generation was not already logged by stopPolling).
  const tick = tickBody();
  assert.match(tick, /if \(error\?\.name === 'AbortError'\) \{/u);
  assert.match(tick, /diag\('poll\.abort', handle\.generation\);/u,
    'an AbortError records poll.abort');

  // Deferred composer SEND cancellation.
  const composer = composerBody();
  assert.match(
    composer,
    /if \(value === false && pending\.size > 0 && typeof diag === 'function'\) \{\s*\n\s*diag\('send\.cancel', handle\.generation\);/u,
    'only a deferred SEND with live timers records send.cancel',
  );

  // Unknown action (the host reply is inspected, its body is not recorded).
  const action = actionBody();
  assert.match(action, /reply\.error\.startsWith\('unknown action'\)/u);
  assert.match(action, /diag\('action\.unknown', handle\.generation\);/u);

  // Extra local observations required by the report: startSession failure and timeline render.
  assert.match(tick, /diag\('session\.start\.failed', handle\.generation\);/u);
  assert.match(timelineBody(), /diag\('timeline\.render', 0\)/u);

  // Every hook is an observation statement: the surrounding control flow is unchanged.
  assert.match(stopBody(), /previous\.cancelled = true;\s*\n\s*previous\.controller\?\.abort\(\);/u);
  assert.match(stopBody(), /previous\.cancelSend\?\.\(\);/u);
  assert.match(startBody(), /window\[POLL_KEY\] = handle;\s*\n\s*diag\('poll\.start'/u);

  console.log('[3] codes=poll.start|poll.abort|send.cancel|action.unknown (+2 local) hooks=6');
});

test('4. no body / digest / error.message / user text / URL query enters the ring', () => {
  const api = loadDiag({});
  const allowed = new Set(api.DIAG_EVENT_CODES);

  // Every diag(...) call must pass a fixed code and only a generation (or the 0 sentinel).
  const calls = [...source.matchAll(/\bdiag\('([a-z.]+)',\s*([^)]+)\)/gu)];
  assert.ok(calls.length >= 7, `all hook calls are discoverable (found ${calls.length})`);
  for (const [, code, argument] of calls) {
    assert.ok(allowed.has(code), `diag code ${code} is in the fixed enum`);
    assert.match(argument.trim(), /^(?:handle|previous)\.generation$|^0$/u,
      `diag(${code}) receives only a generation, not ${argument.trim()}`);
  }

  // The ring object itself has no room for content: only t / code / generation are pushed.
  const push = /diagRing\.push\(\{([\s\S]*?)\}\);/u.exec(diagBlock);
  assert.ok(push !== null, 'the ring push is found');
  for (const forbidden of ['body', 'digest', 'message', 'text', 'url', 'query', 'transcript', 'caption', 'speech']) {
    assert.doesNotMatch(push[1], new RegExp(`\\b${forbidden}\\b`, 'iu'),
      `the ring push never contains ${forbidden}`);
  }
  assert.match(push[1], /\bt: Date\.now\(\)/u);
  assert.match(push[1], /\bcode\b/u);
  assert.match(push[1], /\bgeneration\b/u);

  // The exposed snapshot copies exactly those three fields (plus nothing else).
  const page = enabledWindow();
  const runtime = loadDiag(page);
  runtime.diag('action.unknown', 4);
  const [event] = page.__seireinDiag.events();
  assert.deepEqual(Object.keys(event).sort(), ['code', 'generation', 't']);
  assert.equal(JSON.stringify(event).includes('PRIVATE'), false);

  // The action hook inspects only ok/error code shape; it never passes reply/body onward.
  assert.doesNotMatch(actionBody(), /diag\([^)]*reply/u);
  assert.doesNotMatch(actionBody(), /diag\([^)]*body/u);

  console.log('[4] calls=code+generation ringFields=t,code,generation forbiddenFields=none');
});

test('5. no timer, no network, no extra polling', () => {
  assert.doesNotMatch(diagBlock, /\bsetInterval\s*\(/u, 'no new interval');
  assert.doesNotMatch(diagBlock, /\bsetTimeout\s*\(/u, 'no new timeout');
  assert.doesNotMatch(diagBlock, /\brequestAnimationFrame\s*\(/u);
  assert.doesNotMatch(diagBlock, /\bfetch\s*\(/u, 'no network call');
  assert.doesNotMatch(diagBlock, /XMLHttpRequest|sendBeacon|WebSocket/iu);
  assert.doesNotMatch(diagBlock, /['"]\/assistant\//u, 'no host route is referenced');
  assert.doesNotMatch(diagBlock, /navigator\.sendBeacon/u);

  // The module still ships only its pre-existing intervals (the rollover poller and its own
  // callers); this change adds none. 2 is the baseline in client.js at this revision.
  const intervalCalls = source.match(/\bsetInterval\s*\(/gu) ?? [];
  assert.equal(intervalCalls.length, 2, 'the interval count is unchanged');

  console.log(`[5] diagTimers=0 diagNetwork=0 moduleIntervals=${intervalCalls.length}`);
});

test('6. window.__seireinDiag exists only when enabled and events() returns copies', () => {
  // Static: the global is assigned only inside the enabled guard.
  const guard = diagBlock.indexOf("if (diagEnabled && typeof window !== 'undefined')");
  const assignment = diagBlock.indexOf('window[DIAG_KEY] = {');
  assert.ok(guard > 0 && assignment > guard, 'the global is behind the enabled guard');
  assert.match(diagBlock, /enabled: true,/u);
  assert.match(diagBlock, /events: \(\) => diagRing\.map\(\(event\) => \(\{ \.\.\.event \}\)\),/u);
  assert.match(diagBlock, /clear: \(\) => \{ diagRing\.length = 0; \},/u);

  // OFF: never created, even if the ring helper is called.
  const offPage = {};
  const off = loadDiag(offPage);
  for (let index = 0; index < 5; index += 1) off.diag('poll.start', index);
  assert.equal(Object.hasOwn(offPage, '__seireinDiag'), false, 'OFF never creates the global');
  assert.equal(off.diagRing, null);

  // ON: exactly the documented surface, on demand.
  const onPage = enabledWindow();
  const on = loadDiag(onPage);
  assert.deepEqual(
    Object.keys(onPage.__seireinDiag).sort(),
    ['clear', 'enabled', 'events'],
    'the exposed surface is events / clear / enabled',
  );
  assert.equal(onPage.__seireinDiag.enabled, true);
  assert.equal(typeof onPage.__seireinDiag.events, 'function');
  assert.equal(typeof onPage.__seireinDiag.clear, 'function');
  assert.equal(onPage.__seireinDiag.events().length, 0, 'the ring starts empty');
  on.diag('poll.start', 1);
  const first = onPage.__seireinDiag.events();
  assert.equal(first.length, 1);
  first.push({ t: 0, code: 'poll.start', generation: 99 });
  assert.equal(onPage.__seireinDiag.events().length, 1, 'events() returns a copy, not the live ring');

  console.log('[6] off=noGlobal on=events/clear/enabled copy=yes');
});
