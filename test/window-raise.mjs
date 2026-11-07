/**
 * Entering edit mode must put the REAL VTube Studio window in front of the editor.
 *
 * The reported failure was not "VTS was not moved": it was visible at the right rectangle but
 * behind the DSH window (moves used `SWP_NOACTIVATE | SWP_NOZORDER`), and an earlier parking pass
 * could leave `WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW` on the window even after a restore. The
 * contract pinned here:
 *
 *   1. Spout edit recovery restores VTS with `raise: true`; hiding it (off screen) uses
 *      `raise: false` and never asks for the foreground;
 *   2. the WPF edit recovery (`AvatarLayer.beginAdjust`) invokes the helper with `-Raise`, while
 *      parking for capture does not;
 *   3. a minimized window is restored FIRST, then brought to the front (observable in a real
 *      WinForms window standing in for VTS: it is no longer iconic and the rectangle was applied);
 *   4. a raise that cannot be performed returns a clear code (`VTS_RAISE_FAILED`) instead of
 *      throwing or reporting a successful restore;
 *   5. the style bits: parking keeps NOACTIVATE|TOOLWINDOW, a restore clears them even when the
 *      saved baseline was dirty, and sets APPWINDOW (taskbar + Alt+Tab).
 *
 * Run: node --test test/window-raise.mjs
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { AvatarLayer, verifiedVtsWindow } from '../src/host/avatar/avatarLayer.js';
import { SpoutLayer } from '../src/host/avatar/spoutLayer.js';
import { VtsWindow, VTS_OFFSCREEN } from '../src/host/avatar/spout-layer/vts-window.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(here, '..', 'src', 'host', 'platform', 'window-move.ps1');
const ORIGINAL = { x: 120, y: 80, width: 900, height: 1200 };
const HIDDEN = { x: VTS_OFFSCREEN.x, y: VTS_OFFSCREEN.y, width: ORIGINAL.width, height: ORIGINAL.height };

/** Recording stand-in for `VtsWindow`: every move keeps its rectangle AND its options. */
function fakeVts({ initial = ORIGINAL } = {}) {
  let current = { ...initial };
  const moves = [];
  const events = [];
  return {
    moves,
    events,
    get bounds() {
      return { ...current };
    },
    place(rect) {
      current = { ...rect };
    },
    async capture() {
      return { ok: true, bounds: { ...current } };
    },
    async move(rect, options = {}) {
      moves.push({ rect: { ...rect }, options: { ...options } });
      current = { ...rect };
      return { ok: true, bounds: { ...rect }, raised: options.raise === true };
    },
  };
}

function tempRoot(prefix, t) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  return root;
}

// ---- 1. Spout edit recovery raises, hiding does not --------------------------------------

test('1. spout: edit restore asks for raise=true, parking asks for raise=false', async (t) => {
  const root = tempRoot('dsh-window-raise-spout-', t);
  const log = [];
  const vts = fakeVts();
  const layer = new SpoutLayer({
    root,
    settings: () => ({ bounds: { ...ORIGINAL } }),
    log: { emit: async (type, payload) => log.push({ type, payload }) },
    vtsWindow: vts,
  });

  // Entering Spout parks VTS: this must never ask for the foreground.
  const parked = await layer.hideVts();
  assert.equal(parked.ok, true);
  assert.deepEqual(vts.moves.at(-1), { rect: HIDDEN, options: { raise: false } });
  assert.equal(vts.moves.at(-1).options.raise, false, 'hiding never raises');
  assert.equal(log.filter((entry) => entry.type === 'window.raised').length, 0, 'a hide emits no window.raised');

  // Edit ON: the display process is not running, so stop() is the idle path; the restore happens
  // through stop() and must carry raise=true.
  const entered = await layer.setEditMode(true);
  assert.equal(entered.ok, true);
  assert.deepEqual(vts.moves.at(-1), { rect: ORIGINAL, options: { raise: true } });
  assert.equal(vts.moves.at(-1).options.raise, true, 'the edit restore raises VTS');
  const raised = log.filter((entry) => entry.type === 'window.raised');
  assert.deepEqual(raised.at(-1).payload, { target: 'vts', ok: true, rect: { ...ORIGINAL } });
  assert.deepEqual(vts.bounds, ORIGINAL);

  // Edit OFF without autostart: VTS is parked again, still without a raise.
  layer.autostartOnEditExit = false;
  const exited = await layer.setEditMode(false);
  assert.equal(exited.ok, true);
  assert.deepEqual(vts.moves.at(-1), { rect: HIDDEN, options: { raise: false } });
  const raisedAfterExit = log.filter((entry) => entry.type === 'window.raised');
  assert.equal(raisedAfterExit.length, 1, 'only the edit restore emitted window.raised');

  t.diagnostic(`moves=${vts.moves.map((move) => `${move.options.raise ? 'raise' : 'plain'}:${move.rect.x},${move.rect.y}`).join(' → ')} · raised event=${JSON.stringify(raised.at(-1).payload)}`);
});

// ---- 2. WPF edit recovery uses -Raise ------------------------------------------------------

/** Spawner for `window-move.ps1`: records the arguments and answers with one JSON line. */
function moveSpawner({ reply, exitCode = 0 }) {
  const calls = [];
  const spawnProcess = (command, args = []) => {
    calls.push({ command, args: [...args] });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    queueMicrotask(() => {
      child.stdout.write(`${JSON.stringify(reply)}\n`);
      child.stdout.end();
      child.emit('close', exitCode);
    });
    return child;
  };
  return { calls, spawnProcess };
}

function wpfLayer(t, spawnProcess) {
  return new AvatarLayer({
    dir: join(tempRoot('dsh-window-raise-wpf-', t), 'avatar-layer'),
    root: join(tempRoot('dsh-window-raise-wpf-root-', t)),
    scriptPath: 'C:\\app\\transparent.ps1',
    windowScriptPath: scriptPath,
    log: { emit: async () => {} },
    spawnProcess,
    processes: { list: async () => [], inspect: async () => null, terminate: async () => {} },
  });
}

test('2. wpf: the edit recovery spawns window-move.ps1 with -Raise, parking does not', async (t) => {
  const events = [];
  const reply = {
    ok: true, raised: true, raiseCode: '', left: 120, top: 80, width: 900, height: 1200,
    requested: { left: 120, top: 80, width: 900, height: 1200 },
    delta: { left: 0, top: 0, width: 0, height: 0 },
  };
  const recorder = moveSpawner({ reply });
  const layer = wpfLayer(t, recorder.spawnProcess);
  layer.log = { emit: async (type, payload) => events.push({ type, payload }) };

  const adjusting = await layer.beginAdjust();
  assert.equal(adjusting.ok, true);
  const editArgs = recorder.calls.at(-1).args;
  assert.ok(editArgs.includes('-Raise'), `edit recovery must pass -Raise: ${editArgs.join(' ')}`);
  const raised = events.filter((entry) => entry.type === 'window.raised');
  assert.deepEqual(raised.at(-1).payload, {
    target: 'vts',
    ok: true,
    rect: { x: 120, y: 80, width: 900, height: 1200 },
  });

  // Parking VTS for the capture is not an edit recovery: no -Raise, no window.raised.
  recorder.calls.length = 0;
  const parked = await layer.moveVts(VTS_OFFSCREEN);
  assert.equal(parked.ok, true);
  assert.ok(!recorder.calls.at(-1).args.includes('-Raise'), 'parking must not raise VTS');
  assert.equal(events.filter((entry) => entry.type === 'window.raised').length, 1);

  t.diagnostic(`beginAdjust args=-Raise present=${editArgs.includes('-Raise')} · parking args=${recorder.calls.at(-1).args.length} · raised payload=${JSON.stringify(raised.at(-1).payload)}`);
});

// ---- 3 + 5. real WinForms window (fake VTS) --------------------------------

/** One bounded PowerShell run: stdout/stderr captured, non-zero exit reported. */
const runPowershell = (args, timeoutMs = 30_000) => new Promise((resolve) => {
  let stdout = '';
  let stderr = '';
  let settled = false;
  let timer = null;
  const settle = (value) => {
    if (settled) return;
    settled = true;
    if (timer !== null) clearTimeout(timer);
    resolve(value);
  };
  let child;
  try {
    child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], { windowsHide: true });
  } catch (error) {
    settle({ ok: false, stdout, stderr: String(error) });
    return;
  }
  child.stdout.on('data', (chunk) => { stdout += `${chunk}`; });
  child.stderr.on('data', (chunk) => { stderr += `${chunk}`; });
  child.once('error', (error) => settle({ ok: false, stdout, stderr: `${stderr}${error}` }));
  child.once('close', (code) => settle({ ok: code === 0, stdout, stderr }));
  timer = setTimeout(() => {
    try { child.kill(); } catch { /* already gone */ }
    settle({ ok: false, stdout, stderr: `${stderr}\n(timeout)` });
  }, timeoutMs);
  timer.unref?.();
});

const lastJson = (text) => {
  const line = `${text ?? ''}`.split(/\r?\n/u).map((entry) => entry.trim()).filter((entry) => entry.startsWith('{')).at(-1);
  assert.ok(line !== undefined, `expected a JSON line, got: ${`${text}`.slice(-300)}`);
  return JSON.parse(line);
};

const PROBE_TYPES = `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class RaiseProbe {
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int i, int v);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
}
"@
[void][RaiseProbe]::SetThreadDpiAwarenessContext([IntPtr](-4))
function Get-ClientBox([IntPtr]$h) {
  $cr = New-Object RaiseProbe+RECT
  [void][RaiseProbe]::GetClientRect($h, [ref]$cr)
  $pt = New-Object RaiseProbe+POINT
  [void][RaiseProbe]::ClientToScreen($h, [ref]$pt)
  return @{ left = $pt.X; top = $pt.Y; width = ($cr.Right - $cr.Left); height = ($cr.Bottom - $cr.Top) }
}
function New-FakeVts([string]$title) {
  $form = New-Object System.Windows.Forms.Form
  $form.Text = $title
  $form.StartPosition = 'Manual'
  $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::Sizable
  $form.ClientSize = New-Object System.Drawing.Size(420, 320)
  $form.Left = 200
  $form.Top = 200
  $form.Show()
  [System.Windows.Forms.Application]::DoEvents()
  Start-Sleep -Milliseconds 200
  return $form
}
`;

const TITLE_RAISE = 'Seirein-Window-Raise-Test';
const TITLE_STYLE = 'Seirein-Window-Style-Test';

const raiseProbe = `
$ErrorActionPreference = 'Stop'
${PROBE_TYPES}
$form = New-FakeVts '${TITLE_RAISE}'
$h = $form.Handle
$scriptPath = '${scriptPath.replace(/\\/gu, '\\\\')}'
# A minimized window cannot be foregrounded into view: the helper must restore it first.
$form.WindowState = 'Minimized'
[System.Windows.Forms.Application]::DoEvents()
Start-Sleep -Milliseconds 150
$iconicBefore = [RaiseProbe]::IsIconic($h)
$out = & powershell -NoProfile -ExecutionPolicy Bypass -File $scriptPath -Title '${TITLE_RAISE}' -X 400 -Y 300 -W 420 -H 320 -Raise
$iconicAfter = [RaiseProbe]::IsIconic($h)
$result = @{
  iconicBefore = $iconicBefore
  iconicAfter = $iconicAfter
  visible = [RaiseProbe]::IsWindowVisible($h)
  foreground = ([RaiseProbe]::GetForegroundWindow() -eq $h)
  client = Get-ClientBox $h
  move = (@($out) | Select-Object -Last 1)
} | ConvertTo-Json -Compress -Depth 5
$form.Close()
Write-Output $result
`;

const styleProbe = `
$ErrorActionPreference = 'Stop'
${PROBE_TYPES}
$form = New-FakeVts '${TITLE_STYLE}'
$h = $form.Handle
$scriptPath = '${scriptPath.replace(/\\/gu, '\\\\')}'
# A dirty baseline: an earlier session left the window non-activatable and out of the taskbar.
$dirty = [RaiseProbe]::GetWindowLong($h, -20) -bor 0x08000080
[void][RaiseProbe]::SetWindowLong($h, -20, $dirty)
$before = [RaiseProbe]::GetWindowLong($h, -20)
# Parking for capture keeps (and sets) the two bits and drops APPWINDOW.
$null = & powershell -NoProfile -ExecutionPolicy Bypass -File $scriptPath -Title '${TITLE_STYLE}' -X -2200 -Y -1400 -W 420 -H 320 -Presentation background
$parked = [RaiseProbe]::GetWindowLong($h, -20)
# Restoring to the desktop must clear them even though the saved baseline carried them.
$null = & powershell -NoProfile -ExecutionPolicy Bypass -File $scriptPath -Title '${TITLE_STYLE}' -X 400 -Y 300 -W 420 -H 320
$restored = [RaiseProbe]::GetWindowLong($h, -20)
# A second park/restore cycle must stay clean too.
$null = & powershell -NoProfile -ExecutionPolicy Bypass -File $scriptPath -Title '${TITLE_STYLE}' -X -2200 -Y -1400 -W 420 -H 320 -Presentation background
$parkedAgain = [RaiseProbe]::GetWindowLong($h, -20)
$null = & powershell -NoProfile -ExecutionPolicy Bypass -File $scriptPath -Title '${TITLE_STYLE}' -X 400 -Y 300 -W 420 -H 320
$restoredAgain = [RaiseProbe]::GetWindowLong($h, -20)
$result = @{
  before = $before; parked = $parked; restored = $restored
  parkedAgain = $parkedAgain; restoredAgain = $restoredAgain
} | ConvertTo-Json -Compress
$form.Close()
Write-Output $result
`;

const runProbe = async (t, name, source) => {
  const file = join(tmpdir(), `window-raise-${name}-${process.pid}.ps1`);
  writeFileSync(file, source, 'utf8');
  const run = await runPowershell(['-STA', '-File', file]);
  assert.equal(run.ok, true, `the probe failed: ${run.stderr.slice(-600)}`);
  return lastJson(run.stdout);
};

test('3. a minimized VTS is restored first and only then brought to the front', async (t) => {
  const probe = await runProbe(t, 'minimized', raiseProbe);
  const move = lastJson(probe.move);
  assert.equal(probe.iconicBefore, true, 'the fake VTS starts minimized');
  assert.equal(move.ok, true, 'the raised move reports success');
  assert.equal(move.raised, true, 'the helper reports it raised the window');
  assert.equal(move.wasIconic, true, 'the helper saw the minimized window');
  assert.equal(probe.iconicAfter, false, 'SW_RESTORE ran before the foreground attempt');
  assert.equal(probe.visible, true);
  assert.deepEqual(probe.client, { left: 400, top: 300, width: 420, height: 320 },
    'the re-read client rectangle is the requested one (the move survived the restore)');
  assert.ok(move.raiseMethod === 'foreground' || move.raiseMethod === 'zorder', `raise method=${move.raiseMethod}`);
  if (move.raiseMethod === 'foreground') assert.equal(probe.foreground, true, 'foreground was really taken');
  t.diagnostic(`iconic ${probe.iconicBefore}→${probe.iconicAfter} · method=${move.raiseMethod} · foreground=${probe.foreground} · client=${JSON.stringify(probe.client)}`);
});

test('4. a raise failure is a clear code, never a thrown exception or a silent success', async (t) => {
  // A. The real helper: a window that reports it could not be raised (exit 2 + JSON).
  const args = [];
  let call = 0;
  const spawnProcess = (command, commandArgs = []) => {
    args.push([...commandArgs]);
    const failing = call === 0;
    call += 1;
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    queueMicrotask(() => {
      child.stdout.write(`${JSON.stringify(failing
        ? {
          ok: false, raised: false, raiseCode: 'VTS_RAISE_FAILED', message: 'blocked',
          left: 400, top: 300, width: 500, height: 700,
        }
        : {
          ok: true, raised: false, raiseCode: '',
          left: 400, top: 300, width: 500, height: 700,
        })}\n`);
      child.stdout.end();
      child.emit('close', failing ? 2 : 0);
    });
    return child;
  };
  const window = new VtsWindow({ scriptPath, spawnProcess });
  const refused = await window.move({ x: 400, y: 300, width: 500, height: 700 }, { raise: true });
  assert.equal(refused.ok, false, 'a failed raise is not a successful move');
  assert.equal(refused.code, 'VTS_RAISE_FAILED');
  assert.ok(args.at(-1).includes('-Raise'), 'the raise request reached the helper');
  const plain = await window.move({ x: 400, y: 300, width: 500, height: 700 });
  assert.equal(plain.ok, true);
  assert.ok(!args.at(-1).includes('-Raise'), 'an ordinary move never passes -Raise');

  // B. A controller whose move reports "positioned but not raised": SpoutLayer surfaces the code.
  const root = tempRoot('dsh-window-raise-fail-', t);
  const events = [];
  const layer = new SpoutLayer({
    root,
    settings: () => ({}),
    log: { emit: async (type, payload) => events.push({ type, payload }) },
    vtsWindow: {
      capture: async () => ({ ok: true, bounds: { ...ORIGINAL } }),
      move: async () => ({ ok: true, bounds: { ...ORIGINAL }, raised: false, raiseCode: 'VTS_RAISE_FAILED' }),
    },
  });
  const result = await layer.moveVts(ORIGINAL, { raise: true });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'VTS_RAISE_FAILED');
  assert.deepEqual(result.bounds, { ...ORIGINAL }, 'the caller still learns where the window is');
  const raised = events.filter((entry) => entry.type === 'window.raised');
  assert.deepEqual(raised.at(-1).payload, {
    target: 'vts', ok: false, rect: { ...ORIGINAL }, code: 'VTS_RAISE_FAILED',
  });

  // C. The WPF helper path returns the same code from an un-raised window.
  const recorder = moveSpawner({
    reply: { ok: false, code: 'VTS_RAISE_FAILED', raised: false, left: 120, top: 80, width: 900, height: 1200 },
    exitCode: 2,
  });
  const wpfEvents = [];
  const wpf = wpfLayer(t, recorder.spawnProcess);
  wpf.log = { emit: async (type, payload) => wpfEvents.push({ type, payload }) };
  const wpfResult = await wpf.moveVts(ORIGINAL, { raise: true });
  assert.equal(wpfResult.ok, false);
  assert.equal(wpfResult.code, 'VTS_RAISE_FAILED');
  assert.equal(wpfEvents.filter((entry) => entry.type === 'window.raised').at(-1).payload.ok, false);

  // C2. A window that is not there is reported as "not running", not as an unreadable rectangle.
  const missingSpawner = {
    spawnProcess: () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      queueMicrotask(() => {
        child.stdout.write('no-vts\n');
        child.stdout.end();
        child.emit('close', 1);
      });
      return child;
    },
  };
  const missing = wpfLayer(t, missingSpawner.spawnProcess);
  const missingResult = await missing.moveVts(ORIGINAL, { raise: true });
  assert.equal(missingResult.ok, false);
  assert.equal(missingResult.code, 'VTS_NOT_RUNNING');

  // D. The verified wrapper forwards the flag (the production Spout path goes through it).
  const forwarded = [];
  const verified = verifiedVtsWindow({
    capture: async () => ({ ok: true, bounds: { ...ORIGINAL } }),
    move: async (rect, options) => {
      forwarded.push({ rect: { ...rect }, options: { ...options } });
      return { ok: true, bounds: { ...rect }, raised: options.raise === true };
    },
  });
  await verified.move(ORIGINAL, { raise: true });
  assert.deepEqual(forwarded.at(-1).options, { raise: true });
  await verified.move(ORIGINAL);
  assert.deepEqual(forwarded.at(-1).options, { raise: false }, 'an omitted option is an explicit no-raise');

  t.diagnostic(`VtsWindow raise failure=${refused.code} · SpoutLayer=${result.ok ? 'ok' : result.code} · WPF=${wpfResult.code} · wrapper options=${JSON.stringify(forwarded.map((entry) => entry.options))}`);
});

// ---- 5. shell style bits ------------------------------------------------------------------

const NOACTIVATE = 0x08000000;
const TOOLWINDOW = 0x00000080;
const APPWINDOW = 0x00040000;

test('5. parking keeps NOACTIVATE|TOOLWINDOW; restoring clears them even from a dirty baseline', async (t) => {
  const probe = await runProbe(t, 'style', styleProbe);
  const has = (style, bits) => (style & bits) === bits;

  assert.equal(has(probe.before, NOACTIVATE | TOOLWINDOW), true, 'the dirty baseline is in place');
  assert.equal(has(probe.parked, NOACTIVATE | TOOLWINDOW), true, 'parking sets NOACTIVATE|TOOLWINDOW');
  assert.equal(has(probe.parked, APPWINDOW), false, 'parking drops APPWINDOW');
  assert.equal(has(probe.restored, NOACTIVATE | TOOLWINDOW), false,
    'the restore clears both bits even when the saved baseline carried them');
  assert.equal(has(probe.restored, APPWINDOW), true, 'the restored window is in the taskbar / Alt+Tab');
  assert.equal(has(probe.parkedAgain, NOACTIVATE | TOOLWINDOW), true, 'a second park sets them again');
  assert.equal(has(probe.restoredAgain, NOACTIVATE | TOOLWINDOW), false, 'a second restore clears them again');
  assert.equal(has(probe.restoredAgain, APPWINDOW), true);

  t.diagnostic(`before=0x${(probe.before >>> 0).toString(16)} · parked=0x${(probe.parked >>> 0).toString(16)} · restored=0x${(probe.restored >>> 0).toString(16)} · restoredAgain=0x${(probe.restoredAgain >>> 0).toString(16)}`);
});
