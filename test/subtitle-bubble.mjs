/**
 * Unified avatar geometry → subtitle bubble placement.
 *
 * The host passes one rectangle; the overlay only writes the WPF state file (spawn and fs are
 * injected), so these tests assert the placement parameters and the height clamp without ever
 * creating a window. Region mode is covered as a regression: it must keep its old path.
 *
 * Run: node --test test/subtitle-bubble.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  SubtitleGeometryTracker,
  SubtitleOverlay,
  bubbleLayout,
  resolveAvatarGeometry,
} from '../src/host/subtitle/subtitle.js';

function fakeChild(pid) {
  return {
    pid,
    stderr: new EventEmitter(),
    once() {},
    kill() {},
  };
}

/** In-memory subset of node:fs/promises used by SubtitleOverlay. */
function fakeFs() {
  const files = new Map();
  const writes = [];
  const renames = [];
  return {
    files,
    writes,
    renames,
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
      renames.push({ from, to });
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

/** Overlay with an injected work area, so no PowerShell probe can run. */
function makeOverlay({ dir, workArea = null, dpiScale = null, onEvent = null } = {}) {
  const io = fakeFs();
  const overlay = new SubtitleOverlay({
    dir: dir ?? join('C:', 'fake', 'subtitle-bubble'),
    scriptPath: 'overlay.ps1',
    fsOps: io,
    spawnProcess: () => fakeChild(9100),
    workArea,
    dpiScale,
    onEvent,
    config: { font: 'Microsoft YaHei UI', sizeMax: 32, colorMode: 'fixed', bg: '#101010', fg: '#ffffff' },
  });
  // Pretend the WPF process is already up: `showBubble` then only writes state.
  overlay.child = fakeChild(9100);
  return { overlay, io };
}

function publishedState(io, dir) {
  return JSON.parse(io.files.get(join(dir, 'state.json')));
}

const geometry = { left: 120, top: 700, width: 480, height: 380 };
/** The WPF overlay is the only place alpha and click-through can be applied, so read it once. */
const overlaySource = readFileSync(new URL('../src/host/subtitle/overlay.ps1', import.meta.url), 'utf8');
const workArea = { left: 0, top: 0, width: 2560, height: 1440 };
/** A window that nearly fills the work area: 40 px above and 50 px below, both below one line. */
const squeezed = { left: 120, top: 40, width: 480, height: 1350 };
const ONE_PADDED_LINE = 65; // round(2 * 10 padding + 32 * 1.4 line) at 100 %

test('bubble anchors on the avatar window top-left corner: left / bottom = top / width', async () => {
  const dir = join('C:', 'fake', 'bubble-place');
  const { overlay, io } = makeOverlay({ dir, workArea: { left: 0, top: 0, width: 2560, height: 1440 } });
  const layout = await overlay.showBubble('你好，世界', geometry, { colors: { bg: '#202020', fg: '#ffffff' } });

  const state = publishedState(io, dir);
  assert.equal(state.mode, 'text');
  assert.equal(state.layout, 'bubble');
  assert.equal(state.left, geometry.left, 'left edge = geometry.left');
  assert.equal(state.bottom, geometry.top, 'bottom edge = geometry.top (the window top edge)');
  assert.equal(state.width, geometry.width, 'width = geometry.width');
  assert.deepEqual(state.geometry, geometry);
  assert.equal(layout.left, state.left);
  assert.equal(layout.bottom, state.bottom);
  assert.equal(layout.width, state.width);
  assert.equal(layout.clamped, false, 'a short line fits without clamping');
  assert.equal(layout.height, state.height);
  assert.ok(state.height > 0);
  // The bubble body sits entirely above the window's top edge, never on its bottom edge.
  assert.ok(layout.bottom - layout.height < geometry.top, 'the visible rectangle is above the window');
});

test('longer text grows the bubble upward while the bottom edge stays on the window top', () => {
  const workArea = { left: 0, top: 0, width: 2560, height: 1440 };
  // 480 px wide / 32 px CJK glyphs → 14 characters per line at 100 %.
  const short = bubbleLayout('字'.repeat(14), geometry, { workArea });
  const tall = bubbleLayout('字'.repeat(14 * 10), geometry, { workArea });

  for (const layout of [short, tall]) {
    assert.equal(layout.left, geometry.left);
    assert.equal(layout.bottom, geometry.top, 'bottom is pinned to the window top for every length');
    assert.equal(layout.width, geometry.width);
    assert.equal(layout.clamped, false, 'both fit in the open space above the window');
  }
  assert.ok(tall.height > short.height, 'more lines make the bubble taller');
  assert.ok(tall.bottom - tall.height < short.bottom - short.height, 'the window top moves upward');
});

test('Spout display geometry positions the bubble correctly without any WPF layer', async () => {
  const tracker = new SubtitleGeometryTracker();
  const spoutRect = { x: 840, y: 120, width: 520, height: 760 };
  // No WPF at all: `wpfRunning:false` and `wpfRect:null`.
  const rect = tracker.observe({
    editing: false,
    backend: 'spout',
    wpfRunning: false,
    wpfRect: null,
    spoutRunning: true,
    spoutRect,
  });
  assert.deepEqual(rect, { left: 840, top: 120, width: 520, height: 760 });

  // The pure resolver also answers from Spout when WPF is absent.
  const resolved = resolveAvatarGeometry({
    backend: 'spout', wpfRunning: false, spoutRunning: true, spoutRect,
  });
  assert.equal(resolved.source, 'spout');
  assert.deepEqual(resolved.rect, rect);

  const dir = join('C:', 'fake', 'bubble-spout');
  const { overlay, io } = makeOverlay({ dir, workArea: { left: 0, top: 0, width: 2560, height: 1440 } });
  await overlay.showBubble('来自 Spout 的字幕', rect, { colors: { bg: '#303030', fg: '#ffffff' } });
  const state = publishedState(io, dir);
  assert.equal(state.left, 840);
  assert.equal(state.bottom, 120, 'bottom = the Spout window top edge, not its bottom');
  assert.equal(state.width, 520);
});

test('during editing the geometry follows the VTS client area, not the display layer', async () => {
  const events = [];
  const tracker = new SubtitleGeometryTracker({ onEvent: (type, payload) => events.push({ type, ...payload }) });
  const vtsClient = { left: 200, top: 100, width: 600, height: 900 };
  const rect = tracker.observe({
    editing: true,
    vtsRect: vtsClient,
    backend: 'wpf',
    wpfRunning: true,
    wpfRect: { left: 0, top: 0, width: 300, height: 300 },
    spoutRunning: true,
    spoutRect: { left: 50, top: 50, width: 300, height: 300 },
  });
  assert.deepEqual(rect, vtsClient);
  assert.equal(tracker.source, 'edit');
  assert.deepEqual(events.at(-1), { type: 'subtitle.geometry', source: 'edit', rect: vtsClient });
});

test('editing with no visible VTS client area hides the bubble and records it', async () => {
  const events = [];
  const tracker = new SubtitleGeometryTracker({ onEvent: (type, payload) => events.push({ type, ...payload }) });
  tracker.set({ left: 10, top: 20, width: 300, height: 400 }, 'wpf');
  events.length = 0;
  const rect = tracker.observe({ editing: true, vtsRect: null, wpfRunning: true, wpfRect: { left: 10, top: 20, width: 300, height: 400 } });
  assert.equal(rect, null, 'no stale bubble while the editable VTS window is not on screen');
  assert.deepEqual(events.at(-1), { type: 'subtitle.geometry', source: 'edit', rect: null, hidden: true });
});

test('a long line is clamped to the room above the window, paged, and stays anchored at the window top', async () => {
  const dir = join('C:', 'fake', 'bubble-clamp');
  const events = [];
  const { overlay, io } = makeOverlay({
    dir,
    workArea: { left: 0, top: 0, width: 2560, height: 1440 },
    onEvent: (type, payload) => events.push({ type, ...payload }),
  });
  const text = '长'.repeat(4000);
  const layout = await overlay.showBubble(text, { left: 100, top: 800, width: 500, height: 400 }, {
    colors: { bg: '#202020', fg: '#ffffff' },
  });

  assert.equal(layout.clamped, true);
  assert.equal(layout.maxHeight, 800, 'max height is the room between the window top and the work-area top');
  assert.equal(layout.height, layout.maxHeight, 'height is clamped');
  assert.equal(layout.bottom, 800, 'the bottom edge stays on the window top');
  assert.ok(layout.pages.length > 1, 'overflowing text is split into pages');
  assert.equal(layout.pages.join(''), text, 'paging keeps every character');

  const state = publishedState(io, dir);
  assert.equal(state.left, 100);
  assert.equal(state.bottom, 800);
  assert.equal(state.width, 500);
  assert.equal(state.height, layout.maxHeight);
  assert.equal(state.maxHeight, layout.maxHeight);
  assert.ok(Array.isArray(state.pages) && state.pages.length === layout.pages.length);

  const clamped = events.find((event) => event.type === 'subtitle.height.clamped');
  assert.ok(clamped, 'the clamp is recorded');
  assert.equal(clamped.requested, layout.requestedHeight);
  assert.equal(clamped.clamped, layout.maxHeight);
  assert.ok(clamped.requested > clamped.clamped);
});

test('a window at the work-area top flips the bubble below it instead of a 1 px strip', async () => {
  const dir = join('C:', 'fake', 'bubble-below');
  const events = [];
  const { overlay, io } = makeOverlay({
    dir,
    workArea: { left: 0, top: 0, width: 2560, height: 1440 },
    onEvent: (type, payload) => events.push({ type, ...payload }),
  });
  const nearTop = { left: 120, top: 40, width: 480, height: 380 };
  const layout = await overlay.showBubble('你好，世界', nearTop, {
    colors: { bg: '#202020', fg: '#ffffff' },
  });

  assert.equal(layout.side, 'below', '40 px above cannot hold a line: place below the window');
  assert.equal(layout.top, nearTop.top + nearTop.height, 'top = the avatar window bottom edge');
  assert.equal(layout.bottom, layout.top + layout.height);
  assert.equal(layout.maxHeight, 1440 - layout.top, 'room grows down to the work-area bottom');
  assert.equal(layout.clamped, false, 'the short line fits below');
  assert.ok(layout.height >= layout.lineHeight, 'a whole line is visible');
  assert.ok(layout.height >= 24, 'never the old 1 px strip');
  assert.ok(layout.height > 40, 'taller than the room that used to clamp it');

  const state = publishedState(io, dir);
  assert.equal(state.side, 'below');
  assert.equal(state.top, 420);
  assert.equal(state.left, 120);
  assert.equal(state.width, 480);
  assert.equal(state.height, layout.height);
  assert.equal(state.maxHeight, 1020);

  const fallback = events.find((event) => event.type === 'subtitle.placement.fallback');
  assert.deepEqual(fallback, {
    type: 'subtitle.placement.fallback',
    reason: 'top-space',
    side: 'below',
    available: 1020,
  });

  // Touching the work-area top used to leave the old 1 px strip; it now flips below instead.
  const atTop = bubbleLayout('你好，世界', { ...nearTop, top: 0 }, { workArea: { left: 0, top: 0, width: 2560, height: 1440 } });
  assert.equal(atTop.side, 'below');
  assert.equal(atTop.top, 380, 'top = 0 + window height');
  assert.ok(atTop.height >= atTop.lineHeight, 'a whole line fits');
  assert.ok(atTop.height > 1, 'never a 1 px bubble');
});

test('when neither side has a readable line the bubble sits inside the avatar top, never a thin strip', () => {
  const text = '长'.repeat(300);
  const layout = bubbleLayout(text, squeezed, { workArea });

  assert.equal(layout.side, 'inside', 'both outside strips are below one line');
  assert.equal(layout.top, squeezed.top, 'top = the avatar window top (inside, not above it)');
  assert.equal(layout.left, squeezed.left);
  assert.equal(layout.width, squeezed.width, 'width stays equal to the window width');
  assert.equal(layout.maxHeight, 810, 'inside height cap = 60 % of the 1350 px window');
  assert.equal(layout.height, 810, 'the cap is used before paging the long text');
  assert.ok(layout.height >= ONE_PADDED_LINE, 'at least one full padded line, never a 1 px strip');
  assert.ok(layout.height <= Math.round(squeezed.height * 0.6), 'never taller than 60 % of the avatar');
  assert.ok(layout.height < squeezed.height, 'never covers the whole avatar');
  assert.equal(layout.clamped, true);
  assert.ok(layout.pages.length > 1, 'the inside bubble still pages its long text');
  assert.equal(layout.pages.join(''), text, 'paging keeps every character');
  assert.deepEqual(layout.fallback, { reason: 'both-sides', side: 'inside', available: 810 });

  // A short line inside needs only its measured height, still a full padded line.
  const short = bubbleLayout('你好，世界', squeezed, { workArea });
  assert.equal(short.side, 'inside');
  assert.equal(short.height, ONE_PADDED_LINE);
  assert.equal(short.top, squeezed.top);
  assert.equal(short.top + short.height, squeezed.top + ONE_PADDED_LINE);
  assert.equal(short.clamped, false);
});

test('inside long text pages within insideMaxHeight and keeps the source intact', () => {
  const text = '逐字分页'.repeat(240);
  const filled = { left: 200, top: 30, width: 500, height: 1380 };
  const layout = bubbleLayout(text, filled, { workArea });
  const insideMaxHeight = Math.round(filled.height * 0.6);

  assert.equal(layout.side, 'inside');
  assert.equal(layout.maxHeight, insideMaxHeight, 'total height budget is 60 % of the window');
  assert.equal(layout.height, insideMaxHeight, 'the long text is clamped to that budget');
  assert.ok(layout.pages.length > 1);
  assert.equal(layout.pages.join(''), text, 'pages partition the source exactly');
  for (const page of layout.pages) assert.ok(text.includes(page), 'each page is a verbatim slice');
  assert.ok(layout.top + layout.height <= workArea.top + workArea.height, 'never leaves the visible work area');
  assert.equal(layout.fallback.reason, 'both-sides');
  assert.equal(layout.fallback.side, 'inside');
  assert.equal(layout.fallback.available, insideMaxHeight);
});

test('placement priority is above, then below, then inside', () => {
  const normal = bubbleLayout('正常字幕', geometry, { workArea });
  assert.equal(normal.side, 'above', 'room above is enough');
  assert.equal(normal.fallback, null);

  const topTight = bubbleLayout('正常字幕', { left: 120, top: 40, width: 480, height: 380 }, { workArea });
  assert.equal(topTight.side, 'below', 'above is tight but below is readable');
  assert.deepEqual(topTight.fallback, { reason: 'top-space', side: 'below', available: 1020 });

  const bothTight = bubbleLayout('正常字幕', squeezed, { workArea });
  assert.equal(bothTight.side, 'inside', 'only both-sides-tight falls through to inside');
  assert.deepEqual(bothTight.fallback, { reason: 'both-sides', side: 'inside', available: 810 });
});

test('inside placement publishes a semi-transparent, click-through top strip', async () => {
  const dir = join('C:', 'fake', 'bubble-inside');
  const events = [];
  const { overlay, io } = makeOverlay({
    dir,
    workArea,
    onEvent: (type, payload) => events.push({ type, ...payload }),
  });
  const layout = await overlay.showBubble('窗口占满高度时的字幕', squeezed, {
    colors: { bg: '#202020', fg: '#ffffff' },
  });

  const state = publishedState(io, dir);
  assert.equal(state.side, 'inside');
  assert.equal(state.top, squeezed.top, 'overlay anchors the window on geometry.top');
  assert.equal(state.left, squeezed.left);
  assert.equal(state.width, squeezed.width);
  assert.equal(state.height, layout.height);
  assert.ok(state.height >= ONE_PADDED_LINE, 'a complete padded line, not a 1 px line');
  assert.equal(state.bgAlpha, 200, 'background is not fully opaque');
  assert.ok(state.bgAlpha < 255, `alpha must stay below 255 (got ${state.bgAlpha})`);

  const fallback = events.find((event) => event.type === 'subtitle.placement.fallback');
  assert.deepEqual(fallback, {
    type: 'subtitle.placement.fallback',
    reason: 'both-sides',
    side: 'inside',
    available: layout.maxHeight,
  });

  // Alpha and click-through only exist in the WPF/Win32 layer, so assert the overlay contract.
  assert.match(overlaySource, /\$s\.side -eq 'inside'/, 'overlay recognises the inside side');
  assert.match(overlaySource, /FromArgb\(\$alpha, 0, 0, 0\)/, 'inside background is a black veil at the host alpha');
  assert.match(overlaySource, /AllowsTransparency = \$true/, 'the WPF window must be transparent for the veil');
  assert.match(overlaySource, /WS_EX_TRANSPARENT/, 'clicks pass through the overlay');
  assert.match(overlaySource, /WS_EX_NOACTIVATE/, 'the overlay never steals focus');
});

test('with normal room the bubble still hangs above and never flips below', () => {
  const workArea = { left: 0, top: 0, width: 2560, height: 1440 };
  const layout = bubbleLayout('正常字幕', { left: 120, top: 700, width: 480, height: 380 }, { workArea });
  assert.equal(layout.side, 'above');
  assert.equal(layout.bottom, 700, 'bottom is pinned to the window top');
  assert.equal(layout.top, 700 - layout.height, 'the top edge is what moves');
  assert.equal(layout.maxHeight, 700);
  assert.equal(layout.fallback, null, 'no fallback event for normal placement');
});

test('the fallback event is emitted only when the placement actually changes', async () => {
  const dir = join('C:', 'fake', 'bubble-fallback-events');
  const events = [];
  const { overlay } = makeOverlay({
    dir,
    workArea: { left: 0, top: 0, width: 2560, height: 1440 },
    onEvent: (type, payload) => events.push({ type, ...payload }),
  });
  const colors = { bg: '#202020', fg: '#ffffff' };
  const nearTop = { left: 120, top: 40, width: 480, height: 380 };
  const fallbacks = () => events.filter((event) => event.type === 'subtitle.placement.fallback');

  await overlay.showBubble('第一句', nearTop, { colors });
  await overlay.showBubble('第二句', nearTop, { colors });
  assert.equal(fallbacks().length, 1, 'the same below placement is announced once');
  assert.deepEqual(fallbacks()[0], {
    type: 'subtitle.placement.fallback',
    reason: 'top-space',
    side: 'below',
    available: 1020,
  });

  // Moving the avatar down restores the normal upward placement: no fallback event.
  await overlay.showBubble('第三句', { left: 120, top: 700, width: 480, height: 380 }, { colors });
  assert.equal(fallbacks().length, 1, 'normal placement emits nothing');

  // Both sides now too tight: the placement changes to inside and is reported once more.
  await overlay.showBubble('第四句', { left: 120, top: 60, width: 480, height: 1330 }, { colors });
  assert.equal(fallbacks().length, 2);
  assert.deepEqual(fallbacks()[1], {
    type: 'subtitle.placement.fallback',
    reason: 'both-sides',
    side: 'inside',
    available: 798,
  });
});

test('150% DPI: width 300 / available height 292 paginates the whole long text without truncation', async () => {
  const dir = join('C:', 'fake', 'bubble-dpi-150');
  const { overlay, io } = makeOverlay({
    dir,
    dpiScale: 1.5,
    workArea: { left: 0, top: 700, width: 3840, height: 2160 },
  });
  const text = '长'.repeat(200);
  // The window top sits 292 px below the work-area top, so the bubble has exactly 292 px to grow.
  const layout = await overlay.showBubble(text, { left: 120, top: 992, width: 300, height: 300 }, {
    colors: { bg: '#202020', fg: '#ffffff' },
  });

  // 5 DIP characters per line (172 DIP inner width), 3 lines per page (194.7 DIP cap - padding).
  assert.equal(layout.clamped, true);
  assert.equal(layout.maxHeight, 292, 'physical work-area cap is 292 px');
  assert.equal(layout.height, 292, 'the window height stays clamped');
  assert.equal(layout.bottom, 992, 'the bottom edge stays on the window top');
  assert.equal(layout.pages.length, 14);
  assert.equal(layout.pages.join(''), text, 'concatenating the pages reproduces the source exactly');
  assert.equal(layout.pages.at(-1).length, 5, 'the final page carries the tail, not an ellipsis');

  const state = publishedState(io, dir);
  assert.equal(state.text, text, 'the overlay receives the full text so it can re-measure it');
  assert.deepEqual(state.pages, layout.pages);
  assert.equal(state.height, 292);
});

test('pagination follows the display scale at 100% / 125% / 150% / 200%', () => {
  const geometry = { left: 120, top: 992, width: 300, height: 300 };
  const workArea = { left: 0, top: 700, width: 3840, height: 2160 };
  const text = '长'.repeat(200);
  const expected = [
    { dpiScale: 1, pages: 5, charsPerLine: 8, linesPerPage: 6 },
    { dpiScale: 1.25, pages: 9, charsPerLine: 6, linesPerPage: 4 },
    { dpiScale: 1.5, pages: 14, charsPerLine: 5, linesPerPage: 3 },
    { dpiScale: 2, pages: 34, charsPerLine: 3, linesPerPage: 2 },
  ];

  for (const item of expected) {
    const layout = bubbleLayout(text, geometry, { workArea, dpiScale: item.dpiScale });
    assert.equal(layout.maxHeight, 292);
    assert.equal(layout.bottom, 992, `scale ${item.dpiScale} keeps the bottom on the window top`);
    assert.equal(layout.pages.length, item.pages, `scale ${item.dpiScale} page count`);
    assert.equal(layout.pages.join(''), text, `scale ${item.dpiScale} covers every character`);
    assert.equal(layout.height, 292, `scale ${item.dpiScale} keeps the height clamp`);
    const firstPageChars = layout.pages[0].length;
    assert.equal(firstPageChars, item.charsPerLine * item.linesPerPage, `scale ${item.dpiScale} page capacity`);
  }
  // A higher scale leaves fewer DIP per line/page, so it must never need fewer pages.
  const counts = expected.map((item) => bubbleLayout(text, geometry, { workArea, dpiScale: item.dpiScale }).pages.length);
  assert.deepEqual(counts, [...counts].sort((a, b) => a - b), 'page count grows with the scale');
});

test('150% DPI keeps explicit newlines intact across page boundaries', () => {
  const text = '第一行字幕\n第二行字幕\n'.repeat(40);
  const layout = bubbleLayout(text, { left: 120, top: 992, width: 300, height: 300 }, {
    workArea: { left: 0, top: 700, width: 3840, height: 2160 },
    dpiScale: 1.5,
  });
  assert.equal(layout.clamped, true);
  assert.equal(layout.pages.join(''), text, 'newlines stay in the same partition, so nothing is duplicated or lost');
  for (const page of layout.pages) assert.ok(text.includes(page), 'every page is a verbatim slice of the source');
});

test('a short 150% line is one page with its measured DIP height scaled back to physical pixels', () => {
  const layout = bubbleLayout('你好，世界', { left: 120, top: 992, width: 300, height: 300 }, {
    workArea: { left: 0, top: 700, width: 3840, height: 2160 },
    dpiScale: 1.5,
  });
  assert.equal(layout.clamped, false);
  assert.deepEqual(layout.pages, ['你好，世界']);
  assert.equal(layout.bottom, 992, 'the short line still hangs from the window top');
  // One 44.8 DIP line + 10 DIP padding above/below, measured at 150%: 97 physical pixels.
  assert.equal(layout.height, 97);
  assert.ok(layout.height < layout.maxHeight);
});

test('closing the avatar keeps the last geometry and the bubble continues there', async () => {
  const events = [];
  const tracker = new SubtitleGeometryTracker({ onEvent: (type, payload) => events.push({ type, ...payload }) });
  const last = { left: 300, top: 500, width: 420, height: 700 };
  tracker.set(last, 'wpf');
  tracker.keep();
  assert.deepEqual(tracker.current, last, 'the rectangle is retained after the display closes');
  assert.equal(tracker.source, 'kept');
  assert.deepEqual(events.at(-1), { type: 'subtitle.geometry', source: 'kept', rect: last });

  // A later observation with no running display resolves to the retained rectangle, not null.
  const resolved = tracker.observe({ editing: false, wpfRunning: false, spoutRunning: false });
  assert.deepEqual(resolved, last);
  assert.equal(events.filter((event) => event.type === 'subtitle.geometry' && event.source === 'kept').length, 1,
    'the kept record is announced once, not on every subtitle line');

  const dir = join('C:', 'fake', 'bubble-kept');
  const { overlay, io } = makeOverlay({ dir, workArea: { left: 0, top: 0, width: 2560, height: 1440 } });
  await overlay.showBubble('形象关闭后仍在原位置', tracker.current, { colors: { bg: '#202020', fg: '#ffffff' } });
  const state = publishedState(io, dir);
  assert.equal(state.left, 300);
  assert.equal(state.bottom, 500);
  assert.equal(state.width, 420);
});

test('region mode keeps its independent placement and never uses the avatar geometry', async () => {
  const dir = join('C:', 'fake', 'subtitle-region');
  const { overlay, io } = makeOverlay({ dir, workArea: { left: 0, top: 0, width: 2560, height: 1440 } });
  const region = { x: 640, y: 900, w: 800, h: 160 };
  await overlay.show('区域模式字幕', region, { bg: '#202020', fg: '#ffffff' });

  const state = publishedState(io, dir);
  assert.deepEqual(state.region, region, 'the picked region is passed through unchanged');
  assert.equal(state.layout, undefined, 'region mode is not a bubble layout');
  assert.equal(state.geometry, undefined);
  assert.equal(state.maxHeight, undefined);
  assert.equal(state.pages, undefined);
  assert.equal(state.left, undefined);
  assert.equal(state.bottom, undefined);
  assert.equal(overlay.lastBubble, null);
});
