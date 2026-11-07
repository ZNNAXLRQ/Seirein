/**
 * The desktop avatar mirror: host log wiring, configurable WPF chroma key and capture-corner
 * diagnostics.
 *
 * Without `log`, `AvatarLayer.emitEvent` only pushes to its in-memory ring, so telemetry such as
 * `avatarLayer.stale.unverified` never reaches `data/events.jsonl`. The factory is exported so
 * the wiring is testable without spawning PowerShell. The key must still default to magenta, and
 * `wpf.capture.corner` must name both sampled corner pixels so a black frame can be diagnosed.
 *
 * Run: node --test test/avatar-layer-log.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AvatarLayer, WPF_KEY, evaluateFrame, frameCorners, keyMatches, keyingArgs } from '../src/host/avatar/avatarLayer.js';
import { createAvatarLayer } from '../src/host/index.js';

const transparentScript = readFileSync(new URL('../src/host/avatar/transparent.ps1', import.meta.url), 'utf8');

function fakeLog() {
  const events = [];
  return {
    events,
    async emit(type, payload) {
      events.push({ type, payload });
    },
  };
}

test('createAvatarLayer injects the same log sink the host uses', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-avatar-log-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });
  const log = fakeLog();

  const layer = createAvatarLayer({ root, log });
  assert.equal(layer.dir, join(root, 'cache', 'avatar-layer'), 'the instance is configured for this root');
  assert.equal(layer.log, log, 'the constructor received log: the host log sink, not null');

  // And the sink is live: a stale/unverified observation lands in the log.
  const report = { checked: 0, killed: [], skipped: 0, unverified: 0 };
  await layer.noteUnverified(report, 4242, 'test-unverified');
  assert.equal(report.unverified, 1);
  const stale = log.events.filter((entry) => entry.type === 'avatarLayer.stale.unverified');
  assert.equal(stale.length, 1, 'avatarLayer.stale.unverified reached the injected log');
  assert.equal(stale[0].payload.pid, 4242);
  assert.equal(stale[0].payload.reason, 'test-unverified');
});

test('the WPF chroma key is configurable and still defaults to magenta', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-avatar-key-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  // Default: exactly the historical key, so no user-visible behaviour changes.
  assert.deepEqual({ ...WPF_KEY }, { r: 255, g: 0, b: 255, tolerance: 60 });
  assert.deepEqual(
    keyingArgs(),
    ['-KeyR', '255', '-KeyG', '0', '-KeyB', '255', '-KeyTolerance', '60'],
    'omitting the key reproduces the old hard-coded parameters',
  );
  const defaultLayer = createAvatarLayer({ root, log: fakeLog() });
  assert.deepEqual(defaultLayer.key, WPF_KEY, 'a layer without an override keeps the magenta key');

  // Injection: a different key produces different PowerShell arguments (and is clamped to bytes).
  const green = keyingArgs({ r: 0, g: 255, b: 0, tolerance: 42 });
  assert.deepEqual(green, ['-KeyR', '0', '-KeyG', '255', '-KeyB', '0', '-KeyTolerance', '42']);
  assert.notDeepEqual(green, keyingArgs());
  const layer = new AvatarLayer({
    dir: join(root, 'cache', 'avatar-layer'),
    root,
    scriptPath: 'C:\\app\\transparent.ps1',
    windowScriptPath: 'C:\\app\\window-move.ps1',
    key: { r: 12, g: 240, b: 9, tolerance: 33 },
  });
  assert.deepEqual(layer.key, { r: 12, g: 240, b: 9, tolerance: 33 });
  assert.deepEqual(keyingArgs(layer.key), ['-KeyR', '12', '-KeyG', '240', '-KeyB', '9', '-KeyTolerance', '33']);

  // The script's own parameters carry the same defaults and consume the injected values.
  assert.match(transparentScript, /\[int\]\$KeyR = 255/u);
  assert.match(transparentScript, /\[int\]\$KeyG = 0/u);
  assert.match(transparentScript, /\[int\]\$KeyB = 255/u);
  assert.match(transparentScript, /\[int\]\$KeyTolerance = 60/u);
  assert.match(transparentScript, /\[MirrorNative\]::Key\(\$bmp, \$KeyR, \$KeyG, \$KeyB, \$KeyTolerance,/u);
});

test('frameCorners reads the top-left and bottom-right pixel of a fake frame', () => {
  const rgba = new Uint8Array(2 * 2 * 4);
  rgba.set([255, 0, 255, 255], 0); // top-left, magenta background
  rgba.set([10, 20, 30, 255], 1 * 4); // top-right (not read)
  rgba.set([1, 2, 3, 255], 2 * 4); // bottom-left (not read)
  rgba.set([0, 0, 0, 255], 3 * 4); // bottom-right, transparent-black captured as black
  assert.deepEqual(frameCorners({ width: 2, height: 2, pixels: rgba }), {
    topLeft: { r: 255, g: 0, b: 255 },
    bottomRight: { r: 0, g: 0, b: 0 },
  });

  // PrintWindow's Bitmap is BGRA; the helper must not swap red and blue on that path.
  const bgra = new Uint8Array([30, 20, 10, 255, 0, 0, 0, 0, 0, 0, 0, 0, 5, 6, 7, 255]);
  assert.deepEqual(frameCorners({ width: 2, height: 2, pixels: bgra, channelOrder: 'bgra' }), {
    topLeft: { r: 10, g: 20, b: 30 },
    bottomRight: { r: 7, g: 6, b: 5 },
  });
  assert.equal(frameCorners({ width: 2, height: 2, pixels: new Uint8Array(4) }), null, 'short frames are not guessed');
  assert.equal(frameCorners(null), null);
});

test('wpf.capture.corner carries both corner pixels to the host log', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-avatar-corner-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });
  const log = fakeLog();
  const layer = createAvatarLayer({ root, log });
  const pixels = new Uint8Array(3 * 2 * 4);
  pixels.set([255, 87, 255, 255], 0); // top-left
  pixels.set([18, 52, 86, 255], (3 * 2 - 1) * 4); // bottom-right
  const corners = frameCorners({ width: 3, height: 2, pixels });

  await layer.emitCaptureCorners(corners);
  const events = log.events.filter((entry) => entry.type === 'wpf.capture.corner');
  assert.equal(events.length, 2, 'one event per corner');
  assert.deepEqual(events[0].payload, { corner: 'top-left', r: 255, g: 87, b: 255 });
  assert.deepEqual(events[1].payload, { corner: 'bottom-right', r: 18, g: 52, b: 86 });
});

test('readCaptureCorners reads the script file and refuses a malformed one', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-avatar-capture-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });
  const dir = join(root, 'cache', 'avatar-layer');
  const layer = createAvatarLayer({ root, log: fakeLog() });
  assert.equal(await layer.readCaptureCorners(), null, 'no capture file yet');

  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'capture.json'),
    JSON.stringify({
      topLeft: { r: 255, g: 0, b: 255 },
      bottomRight: { r: 0, g: 0, b: 0 },
      width: 720,
      height: 748,
      key: { r: 255, g: 0, b: 255, tolerance: 60 },
    }),
    'utf8',
  );
  assert.deepEqual(await layer.readCaptureCorners(), {
    topLeft: { r: 255, g: 0, b: 255 },
    bottomRight: { r: 0, g: 0, b: 0 },
  });

  await writeFile(join(dir, 'capture.json'), JSON.stringify({ topLeft: { r: 1, g: 2 } }), 'utf8');
  assert.equal(await layer.readCaptureCorners(), null, 'a partial sample is not guessed');
});

test('a black VTS background is NOT a failed frame: only a frozen covering frame is', () => {
  // The old rule dropped every frame whose keyed content covered >95% of the client area. A black
  // background always covers it, so the first black frame stuck forever. A single black frame is a
  // legitimate picture now; the bad-frame criterion is a full frame that stays pixel-identical.
  const black = evaluateFrame({
    bounds: { width: 720, height: 748 },
    clientWidth: 720,
    clientHeight: 748,
    identicalFrames: 1,
    visible: true,
  });
  assert.equal(black.accept, true, 'the first black frame is displayed');
  assert.equal(black.reason, 'ok');

  const stillBlack = evaluateFrame({
    bounds: { width: 720, height: 748 },
    clientWidth: 720,
    clientHeight: 748,
    identicalFrames: 3,
    visible: true,
  });
  assert.equal(stillBlack.accept, false);
  assert.equal(stillBlack.reason, 'frozen-covering-frame', 'the reason names the frozen frame, not its coverage');

  // More reliable conditions: a hidden window or a zero-size client never yields a "frame".
  assert.equal(evaluateFrame({ bounds: { width: 720, height: 748 }, clientWidth: 720, clientHeight: 748, visible: false }).reason, 'window-invisible');
  assert.equal(evaluateFrame({ bounds: { width: 720, height: 748 }, clientWidth: 0, clientHeight: 748 }).reason, 'client-size-zero');

  // ...and the mirror script implements the same rule (no coverage-only rejection left).
  assert.match(transparentScript, /IsWindowVisible/u);
  assert.match(transparentScript, /FrameHash/u);
  assert.match(transparentScript, /\$script:identicalFrames -ge 3/u);
  assert.doesNotMatch(
    transparentScript,
    /if \(\$covering -and \$null -ne \$script:bitmap\)/u,
    'coverage alone must not decide that a capture failed',
  );
});

test('a background that does not match the key emits wpf.key.mismatch (and never pretends to be transparent)', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-avatar-key-mismatch-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });
  const log = fakeLog();
  const layer = createAvatarLayer({ root, log });

  // VTS on a black background: the opposite of the configured magenta key.
  assert.equal(keyMatches({ r: 0, g: 0, b: 0 }, WPF_KEY), false);
  const mismatched = await layer.checkKey({ topLeft: { r: 0, g: 0, b: 0 }, bottomRight: { r: 0, g: 0, b: 0 } });
  assert.equal(mismatched, false);
  const events = log.events.filter((entry) => entry.type === 'wpf.key.mismatch');
  assert.equal(events.length, 1, 'one wpf.key.mismatch event');
  assert.deepEqual(events[0].payload.cornerColor, { r: 0, g: 0, b: 0 });
  assert.deepEqual(events[0].payload.keyColor, { ...WPF_KEY }, 'the configured key is reported, not a guessed one');
  assert.deepEqual(layer.snapshot().keyMismatch, {
    cornerColor: { r: 0, g: 0, b: 0 },
    keyColor: { ...WPF_KEY },
  }, 'the incompatibility is visible in the status snapshot');

  // The real VTS background: close to the key, so no event and the layer is allowed to claim transparency.
  const matched = await layer.checkKey({ topLeft: { r: 255, g: 0, b: 255 }, bottomRight: { r: 255, g: 0, b: 255 } });
  assert.equal(matched, true);
  assert.equal(layer.snapshot().keyMismatch, null);
  assert.equal(log.events.filter((entry) => entry.type === 'wpf.key.mismatch').length, 1, 'no duplicate warning');
  assert.equal(keyMatches({ r: 255, g: 87, b: 255 }, { r: 255, g: 0, b: 255, tolerance: 60 }), false,
    'a 87-point channel difference is outside the configured tolerance');
});
