/**
 * Subtitle publication generations (P2).
 *
 * A bubble show awaits the work-area probe and the palette *after* it has decided to display.
 * During that window an interruption hides the line; the old show then finished its write and put
 * the stale text back on screen. The host now claims a generation for every show/hide, and the
 * overlay re-checks it inside the serialised write queue — immediately before `state.json` is
 * renamed into place. The generation and the probe are injected here, so the exact interleaving is
 * deterministic and no PowerShell/WPF process is involved.
 *
 * Run: node --test test/subtitle-generation.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';

import { countReadable, readableHoldMs, SubtitleHold, SubtitleLineLedger, SubtitleOverlay } from '../src/host/subtitle/subtitle.js';

function fakeChild(pid) {
  return {
    pid,
    stderr: new EventEmitter(),
    once() {},
    kill() {},
  };
}

/** In-memory subset of node:fs/promises that also records the order of published states. */
function fakeFs() {
  const files = new Map();
  const writes = [];
  const published = [];
  return {
    files,
    writes,
    published,
    async mkdir() {},
    async writeFile(path, data) {
      writes.push({ path, data });
      files.set(path, data);
    },
    async rename(from, to) {
      if (!files.has(from)) {
        const error = new Error(`ENOENT: no such file, rename '${from}'`);
        error.code = 'ENOENT';
        throw error;
      }
      published.push(JSON.parse(files.get(from)));
      files.set(to, files.get(from));
      files.delete(from);
    },
    async rm(path) {
      files.delete(path);
    },
    async readFile(path) {
      if (!files.has(path)) throw new Error(`ENOENT: no such file, open '${path}'`);
      return files.get(path);
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A host-like generation counter: every show/hide claims the next value. */
function hostGeneration() {
  let value = 0;
  return {
    claim: () => (value += 1),
    isCurrent: (generation) => generation === value,
    get value() {
      return value;
    },
  };
}

/** Overlay whose WPF process is already up (no spawn, no ensure delay). */
function makeOverlay({ dir, probeWorkArea = null, onEvent = null } = {}) {
  const io = fakeFs();
  const overlay = new SubtitleOverlay({
    dir,
    scriptPath: 'overlay.ps1',
    fsOps: io,
    spawnProcess: () => fakeChild(9200),
    probeWorkArea,
    onEvent,
    config: { font: 'Microsoft YaHei UI', sizeMax: 32, colorMode: 'fixed', bg: '#101010', fg: '#ffffff' },
  });
  overlay.child = fakeChild(9200);
  return { overlay, io };
}

const geometry = { left: 120, top: 700, width: 480, height: 380 };
const workArea = { left: 0, top: 0, width: 2560, height: 1440 };
const colors = { bg: '#202020', fg: '#ffffff' };
const statePath = (dir) => join(dir, 'state.json');
const drops = (events) => events.filter((event) => event.type === 'subtitle.publish.dropped');
const textWrites = (io) => io.published.filter((state) => state.mode === 'text');

test('1. a hide lands while the show waits for its probe: the stale bubble is not written', async (t) => {
  const dir = join('C:', 'fake', 'generation-probe-hide');
  const probe = deferred();
  let probeStarted;
  const started = new Promise((resolve) => { probeStarted = resolve; });
  const events = [];
  const { overlay, io } = makeOverlay({
    dir,
    probeWorkArea: () => {
      probeStarted();
      return probe.promise;
    },
    onEvent: (type, payload) => events.push({ type, ...payload }),
  });
  const generation = hostGeneration();

  const showGeneration = generation.claim();
  const pendingShow = overlay.showBubble('旧字幕', geometry, {
    colors,
    generation: showGeneration,
    isCurrent: () => generation.isCurrent(showGeneration),
  });
  await started; // the show is now parked on the work-area probe

  const hideGeneration = generation.claim();
  assert.equal(await overlay.hide({ generation: hideGeneration }), true);
  const publishedBeforeProbeReturns = io.published.length;

  probe.resolve(workArea); // the probe returns after the hide, exactly the P2 repro
  const layout = await pendingShow;

  assert.equal(layout, null, 'the superseded show reports no layout');
  assert.equal(io.published.length, publishedBeforeProbeReturns, 'the late probe writes nothing');
  assert.equal(textWrites(io).length, 0, 'no stale text was ever published');
  assert.equal(JSON.parse(io.files.get(statePath(dir))).mode, 'hidden', 'the final screen state stays hidden');
  const dropped = drops(events);
  assert.equal(dropped.length, 1, 'the drop is reported once');
  assert.deepEqual(dropped[0], { type: 'subtitle.publish.dropped', reason: 'stale-generation' });
  t.diagnostic(`probe-late show: writes=${io.published.length} final=${JSON.parse(io.files.get(statePath(dir))).mode} drops=${dropped.length}`);
});

test('2. a normal show publishes the bubble once', async (t) => {
  const dir = join('C:', 'fake', 'generation-normal');
  const { overlay, io } = makeOverlay({ dir });
  const generation = hostGeneration();
  const showGeneration = generation.claim();

  const layout = await overlay.showBubble('正常字幕', geometry, {
    colors,
    workArea,
    generation: showGeneration,
    isCurrent: () => generation.isCurrent(showGeneration),
  });

  assert.notEqual(layout, null);
  assert.equal(io.published.length, 1, 'exactly one published state');
  assert.equal(textWrites(io).length, 1);
  const state = JSON.parse(io.files.get(statePath(dir)));
  assert.equal(state.mode, 'text');
  assert.equal(state.layout, 'bubble');
  assert.equal(state.text, '正常字幕');
  assert.equal(state.left, geometry.left);
  assert.equal(state.bottom, geometry.top, 'the bubble hangs from the avatar window top edge, which stays fixed');
  t.diagnostic(`normal show: writes=${io.published.length} final=${state.mode} text=${JSON.stringify(state.text)}`);
});

test('3. two shows in a row: the later one wins and the earlier one never lands late', async (t) => {
  const dir = join('C:', 'fake', 'generation-two-shows');
  const probe = deferred();
  let probeStarted;
  const started = new Promise((resolve) => { probeStarted = resolve; });
  const { overlay, io } = makeOverlay({
    dir,
    probeWorkArea: () => {
      probeStarted();
      return probe.promise;
    },
  });
  const generation = hostGeneration();

  const firstGeneration = generation.claim();
  const firstShow = overlay.showBubble('第一句', geometry, {
    colors,
    generation: firstGeneration,
    isCurrent: () => generation.isCurrent(firstGeneration),
  });
  await started;

  const secondGeneration = generation.claim();
  const secondLayout = await overlay.showBubble('第二句', geometry, {
    colors,
    workArea,
    generation: secondGeneration,
    isCurrent: () => generation.isCurrent(secondGeneration),
  });
  assert.notEqual(secondLayout, null);
  assert.equal(secondLayout.text, '第二句');
  const writesAfterSecond = io.published.length;

  probe.resolve(workArea); // the first show's probe finally answers
  assert.equal(await firstShow, null, 'the older show is dropped');

  assert.equal(io.published.length, writesAfterSecond, 'no write arrives after the newer show');
  assert.equal(textWrites(io).length, 1, 'only the newer line was published');
  const state = JSON.parse(io.files.get(statePath(dir)));
  assert.equal(state.mode, 'text');
  assert.equal(state.text, '第二句', 'the final screen state is the later show');
  t.diagnostic(`two shows: writes=${io.published.length} final=${state.mode} text=${JSON.stringify(state.text)}`);
});

test('4. hide then a new show: the new generation displays normally', async (t) => {
  const dir = join('C:', 'fake', 'generation-hide-then-show');
  const probe = deferred();
  let probeStarted;
  const started = new Promise((resolve) => { probeStarted = resolve; });
  const { overlay, io } = makeOverlay({
    dir,
    probeWorkArea: () => {
      probeStarted();
      return probe.promise;
    },
  });
  const generation = hostGeneration();

  const firstGeneration = generation.claim();
  const oldShow = overlay.showBubble('被打断的旧字幕', geometry, {
    colors,
    generation: firstGeneration,
    isCurrent: () => generation.isCurrent(firstGeneration),
  });
  await started;

  const hideGeneration = generation.claim();
  await overlay.hide({ generation: hideGeneration });
  probe.resolve(workArea);
  assert.equal(await oldShow, null, 'the interrupted show is dropped');
  assert.equal(JSON.parse(io.files.get(statePath(dir))).mode, 'hidden');

  const nextGeneration = generation.claim();
  const layout = await overlay.showBubble('打断后的新字幕', geometry, {
    colors,
    workArea,
    generation: nextGeneration,
    isCurrent: () => generation.isCurrent(nextGeneration),
  });

  assert.notEqual(layout, null, 'the newer generation may display');
  assert.equal(layout.text, '打断后的新字幕');
  const state = JSON.parse(io.files.get(statePath(dir)));
  assert.equal(state.mode, 'text');
  assert.equal(state.text, '打断后的新字幕', 'the final screen state is the new line');
  assert.deepEqual(io.published.map((row) => row.mode), ['hidden', 'text']);
  t.diagnostic(`hide then show: writes=${io.published.length} sequence=${io.published.map((row) => row.mode).join('->')} final=${JSON.parse(io.files.get(statePath(dir))).text}`);
});

test('5. stale drops are throttled to one event per burst', async (t) => {
  const dir = join('C:', 'fake', 'generation-throttle');
  const probe = deferred();
  let probes = 0;
  let bothStarted;
  const started = new Promise((resolve) => { bothStarted = resolve; });
  const events = [];
  const { overlay, io } = makeOverlay({
    dir,
    probeWorkArea: () => {
      probes += 1;
      if (probes === 2) bothStarted();
      return probe.promise;
    },
    onEvent: (type, payload) => events.push({ type, ...payload }),
  });
  const generation = hostGeneration();

  const firstGeneration = generation.claim();
  const firstShow = overlay.showBubble('旧字幕一', geometry, {
    colors,
    generation: firstGeneration,
    isCurrent: () => generation.isCurrent(firstGeneration),
  });
  const secondGeneration = generation.claim();
  const secondShow = overlay.showBubble('旧字幕二', geometry, {
    colors,
    generation: secondGeneration,
    isCurrent: () => generation.isCurrent(secondGeneration),
  });
  await started; // both shows are parked on the same probe

  const hideGeneration = generation.claim();
  await overlay.hide({ generation: hideGeneration });
  probe.resolve(workArea);
  const results = await Promise.all([firstShow, secondShow]);

  assert.deepEqual(results, [null, null], 'both superseded shows are dropped');
  assert.equal(textWrites(io).length, 0);
  assert.deepEqual(io.published.map((row) => row.mode), ['hidden']);
  assert.equal(drops(events).length, 1, 'two drops in the same burst produce one throttled event');
  assert.equal(drops(events)[0].reason, 'stale-generation');
  t.diagnostic(`throttle: writes=${io.published.length} final=${io.published[0].mode} drops=${drops(events).length} droppedShows=${results.filter((value) => value === null).length}`);
});

test('6. the original paints first; a late translation only repaints the line that still owns the screen', async (t) => {
  const dir = join('C:', 'fake', 'generation-late-translation');
  const { overlay, io } = makeOverlay({ dir });
  const generation = hostGeneration();
  const lines = new SubtitleLineLedger();
  // Exactly the host's publication call: a show carries the generation and the live epoch check.
  const show = (text, line) => overlay.showBubble(text, geometry, {
    colors,
    workArea,
    generation: generation.claim(),
    isCurrent: () => lines.owns(line),
  });

  // Sentence 1: its ORIGINAL line is painted at once; its translation is still being generated.
  const line1 = lines.begin();
  assert.notEqual(await show('第一句原文', line1), null);
  assert.equal(textWrites(io).at(-1).text, '第一句原文', 'the original text is visible before the translation');

  // Sentence 2 is displayed before sentence 1's translation arrives: it now owns the screen.
  const line2 = lines.begin();
  assert.notEqual(await show('第二句原文', line2), null);
  assert.equal(lines.owns(line1), false, 'the earlier line lost the screen');

  // The late translation of sentence 1 must be refused instead of overwriting sentence 2.
  const late = await lines.repaint(line1, () => show('第一句译文', line1));
  assert.equal(late, null, 'the superseded line paints nothing');
  assert.equal(io.published.length, 2, 'no write follows the newer line');
  assert.equal(JSON.parse(io.files.get(statePath(dir))).text, '第二句原文', 'the screen keeps the newer sentence');

  // A translation for the line that is still current does replace its own wording.
  const updated = await lines.repaint(line2, () => show('第二句译文', line2));
  assert.notEqual(updated, null, 'the current line may still repaint itself');
  assert.equal(JSON.parse(io.files.get(statePath(dir))).text, '第二句译文', 'the current line ends in its translation');
  t.diagnostic(`late translation: writes=${io.published.length} final=${JSON.stringify(JSON.parse(io.files.get(statePath(dir))).text)} lateRejected=${late === null} currentUpdated=${updated !== null}`);
});

test('7. the post-audio hold keeps one line stable, cancels at once and hides once', (t) => {
  const hides = [];
  const events = [];
  let timer = null;
  const setTimer = (fn, ms) => {
    timer = { fn, ms };
    return timer;
  };
  const clearTimer = (token) => {
    if (timer === token) timer = null;
  };
  const hold = new SubtitleHold({
    setTimer,
    clearTimer,
    onHide: (info) => hides.push(info),
    onEvent: (type, payload) => events.push({ type, ...payload }),
  });

  // Arm for 1200ms; the same line is already on screen, so a repeated show changes nothing.
  const delay = hold.arm({ text: '第一句', line: { id: 1 }, generation: 1, waitMs: 1200, holdMs: 1200 });
  assert.equal(delay, 1200);
  assert.equal(hold.pending, true);
  assert.equal(hold.covers('第一句'), true, 'the same line is still held');
  assert.equal(hold.covers('第一句译文'), false, 'a different wording is a different line');
  assert.deepEqual(
    events,
    [{ type: 'subtitle.hold', ms: 1200, chars: 3, computed: 210 }],
    'one observation row per hold: the used ms, the read units and their raw reading time',
  );

  // A newer line replaces it in place: the timer is cancelled before it can hide anything.
  hold.cancel();
  assert.equal(hold.pending, false);
  assert.equal(timer, null, 'the pending callback is gone, so it cannot hide the newer line');
  assert.equal(hides.length, 0);

  // An interruption is also a cancel: it never waits out the hold.
  hold.arm({ text: '第二句', line: { id: 2 }, generation: 2, waitMs: 1200, holdMs: 1200 });
  hold.cancel();
  assert.equal(hides.length, 0, 'a cancelled hold hides nothing');

  // A hold that really runs hides exactly once, with the line that was held.
  hold.arm({ text: '第三句', line: { id: 3 }, generation: 3, waitMs: 1200, holdMs: 1200 });
  const scheduled = timer;
  scheduled.fn();
  assert.equal(hides.length, 1);
  assert.deepEqual(hides[0], { text: '第三句', line: { id: 3 }, generation: 3 });
  assert.equal(hold.pending, false);
  t.diagnostic(`hold: delays=[1200,1200,1200] cancelledHides=0 firedHides=${hides.length} events=${events.length}`);
});

test('8. reading units are CJK glyphs and Latin words, never punctuation', (t) => {
  assert.equal(countReadable('你好，世界。'), 4, 'four Han glyphs, punctuation ignored');
  assert.equal(countReadable('hello brave new world'), 4, 'one unit per Latin word');
  assert.equal(countReadable('你好 world 你好'), 5, 'mixed text adds both kinds');
  assert.equal(countReadable('  ，。！ '), 0, 'punctuation-only text has no reading time');
  assert.equal(countReadable(''), 0);
  t.diagnostic('readable units: han=4 words=4 mixed=5 punctuation=0');
});

test('9. the hold is the caption reading time: 40 chars -> 2800, 8 -> 1200 floor, 100 -> 4000 cap', (t) => {
  // 40 characters × 70ms is above the configured 1200 and inside the cap: the text wins.
  assert.deepEqual(readableHoldMs('字'.repeat(40), 1200), { ms: 2800, chars: 40, computed: 2800 });
  // 8 characters only earn 560ms: the 1200ms floor keeps a short line readable.
  assert.deepEqual(readableHoldMs('字'.repeat(8), 1200), { ms: 1200, chars: 8, computed: 560 });
  // 100 characters would need 7000ms: the 4000ms cap keeps the screen from being pinned.
  assert.deepEqual(readableHoldMs('字'.repeat(100), 1200), { ms: 4000, chars: 100, computed: 7000 });
  // A configured hold above the reading time still wins (and is itself clamped to the range).
  assert.deepEqual(readableHoldMs('短', 2500), { ms: 2500, chars: 1, computed: 70 });
  assert.deepEqual(readableHoldMs('短', 9000), { ms: 4000, chars: 1, computed: 70 });

  // The observation row reports the hold actually used, not the configured one.
  const events = [];
  const hold = new SubtitleHold({
    setTimer: () => ({}),
    clearTimer: () => {},
    onEvent: (type, payload) => events.push({ type, ...payload }),
  });
  hold.arm({ text: '字'.repeat(40), line: { id: 7 }, generation: 7, waitMs: 2800, holdMs: 2800, chars: 40, computed: 2800 });
  assert.deepEqual(events, [{ type: 'subtitle.hold', ms: 2800, chars: 40, computed: 2800 }]);
  hold.cancel();
  t.diagnostic(`holds: 40ch=${readableHoldMs('字'.repeat(40), 1200).ms} 8ch=${readableHoldMs('字'.repeat(8), 1200).ms} 100ch=${readableHoldMs('字'.repeat(100), 1200).ms}`);
});
