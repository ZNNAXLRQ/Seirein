/**
 * Window geometry: the user's position is the CLIENT rectangle of the model window.
 *
 * `window-move.ps1` used to hand the client rectangle straight to SetWindowPos (which takes the
 * OUTER frame), so every move was off by the border and changed the size; its `-Report` was right
 * but a move never re-read anything, so callers "verified" their own request. These tests pin the
 * one semantics end to end:
 *   - a real bordered window is moved to a client rectangle; the outer frame must be
 *     client + border and the measured client must equal the request;
 *   - a borderless window has no border, so frame and client coincide;
 *   - a re-read that deviates past 2 px is a `window.move.mismatch`, never a success report.
 *
 * The PowerShell cases start a private WinForms window with a unique title (`-Title`), so the real
 * VTube Studio window is never touched. Run: node --test test/window-geometry.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { apply, EDIT_GEOMETRY_LIMITS, validateEditGeometry } from '../src/host/index.js';
import { SpoutLayer } from '../src/host/avatar/spoutLayer.js';
import { VTS_OFFSCREEN, VtsWindow } from '../src/host/avatar/spout-layer/vts-window.mjs';
import {
  AvatarLayer,
  MOVE_TOLERANCE_PX,
  WPF_OFFSCREEN,
  WPF_ONSCREEN,
  clientRect,
  evaluateFrame,
  isCaptureRect,
  sanitizeStoredGeometry,
  verifiedVtsWindow,
} from '../src/host/avatar/avatarLayer.js';

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(here, '..', 'src', 'host', 'platform', 'window-move.ps1');
const TITLE = '*Seirein-Window-Geometry-Test*';
const REQUESTED = { left: 460, top: 300, width: 520, height: 380 };

test('WPF applies physical bounds rather than DIPs on the actual monitor', async (t) => {
  const source = await readFile(join(here, '..', 'src', 'host', 'avatar', 'transparent.ps1'), 'utf8');
  const begin = source.indexOf('function Set-PhysicalBounds(');
  const end = source.indexOf('Set-PhysicalBounds @{', begin);
  const helper = source.slice(begin, end);
  const script = `
Add-Type -AssemblyName PresentationFramework
Add-Type @"
using System; using System.Runtime.InteropServices;
public class MirrorNative {
 [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left,Top,Right,Bottom; }
 [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
 [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h,IntPtr a,int x,int y,int w,int height,uint f);
}
"@
[void][MirrorNative]::SetThreadDpiAwarenessContext([IntPtr](-4))
$window=New-Object System.Windows.Window
$window.WindowStyle='None'; $window.AllowsTransparency=$true
$window.ShowInTaskbar=$false
$window.Show()
$handle=(New-Object System.Windows.Interop.WindowInteropHelper($window)).Handle
${helper}
Set-PhysicalBounds @{left=460;top=300;width=520;height=380}
$window.Dispatcher.Invoke([Action]{},[System.Windows.Threading.DispatcherPriority]::Render)
$r=New-Object MirrorNative+RECT
[void][MirrorNative]::GetWindowRect($handle,[ref]$r)
$result=@{left=$r.Left;top=$r.Top;width=($r.Right-$r.Left);height=($r.Bottom-$r.Top)}
$window.Close()
$result | ConvertTo-Json -Compress
`;
  const result = await runPowershell(['-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]);
  assert.equal(result.ok, true, result.stderr);
  const actual = JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1));
  assert.deepEqual(actual, REQUESTED);
  t.diagnostic(`actual WPF HWND physical bounds=${JSON.stringify(actual)}`);
});

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
  child.stdout.on('data', (chunk) => {
    stdout += `${chunk}`;
  });
  child.stderr.on('data', (chunk) => {
    stderr += `${chunk}`;
  });
  child.once('error', (error) => settle({ ok: false, stdout, stderr: `${stderr}${error}` }));
  child.once('close', (code) => settle({ ok: code === 0, stdout, stderr }));
  timer = setTimeout(() => {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    settle({ ok: false, stdout, stderr: `${stderr}\n(timeout)` });
  }, timeoutMs);
  timer.unref?.();
});

/** A window of our own: `-Title` keeps the script away from the real VTube Studio. */
const geometryProbe = (bordered) => `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class GeoProbe {
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int index);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
}
"@
[void][GeoProbe]::SetThreadDpiAwarenessContext([IntPtr](-4))
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Seirein-Window-Geometry-Test'
$form.StartPosition = 'Manual'
$form.Left = 120
$form.Top = 160
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::${bordered ? 'Sizable' : 'None'}
$form.ClientSize = New-Object System.Drawing.Size(420, 320)
$form.Show()
[System.Windows.Forms.Application]::DoEvents()
Start-Sleep -Milliseconds 250
$script = '${scriptPath.replace(/\\/gu, '\\\\')}'
$move = & powershell -NoProfile -ExecutionPolicy Bypass -File $script -Title '${TITLE}' -X ${REQUESTED.left} -Y ${REQUESTED.top} -W ${REQUESTED.width} -H ${REQUESTED.height}
$report = & powershell -NoProfile -ExecutionPolicy Bypass -File $script -Title '${TITLE}' -Report
$h = $form.Handle
$originalStyle = [GeoProbe]::GetWindowLong($h,-20)
$null = & powershell -NoProfile -ExecutionPolicy Bypass -File $script -Title '${TITLE}' -X ${REQUESTED.left} -Y ${REQUESTED.top} -W ${REQUESTED.width} -H ${REQUESTED.height} -Presentation background
$backgroundStyle = [GeoProbe]::GetWindowLong($h,-20)
# Repeated background operations must not overwrite the original saved shell flags.
$null = & powershell -NoProfile -ExecutionPolicy Bypass -File $script -Title '${TITLE}' -X ${REQUESTED.left} -Y ${REQUESTED.top} -W ${REQUESTED.width} -H ${REQUESTED.height} -Presentation background
$null = & powershell -NoProfile -ExecutionPolicy Bypass -File $script -Title '${TITLE}' -X ${REQUESTED.left} -Y ${REQUESTED.top} -W ${REQUESTED.width} -H ${REQUESTED.height} -Presentation normal
$restoredStyle = [GeoProbe]::GetWindowLong($h,-20)
$wr = New-Object GeoProbe+RECT
[void][GeoProbe]::GetWindowRect($h, [ref]$wr)
$cr = New-Object GeoProbe+RECT
[void][GeoProbe]::GetClientRect($h, [ref]$cr)
$pt = New-Object GeoProbe+POINT
[void][GeoProbe]::ClientToScreen($h, [ref]$pt)
$result = @{
  originalStyle = $originalStyle; backgroundStyle = $backgroundStyle; restoredStyle = $restoredStyle
  move = $move
  report = $report
  outer = @{ left = $wr.Left; top = $wr.Top; width = ($wr.Right - $wr.Left); height = ($wr.Bottom - $wr.Top) }
  client = @{ left = $pt.X; top = $pt.Y; width = ($cr.Right - $cr.Left); height = ($cr.Bottom - $cr.Top) }
} | ConvertTo-Json -Compress -Depth 5
$form.Close()
Write-Output $result
`;

/** Last JSON object in a text blob (PowerShell may print banner/warning lines before it). */
const lastJson = (text) => {
  const line = `${text ?? ''}`.split(/\r?\n/u).map((entry) => entry.trim()).filter((entry) => entry.startsWith('{')).at(-1);
  assert.ok(line !== undefined, `expected a JSON line, got: ${`${text}`.slice(-300)}`);
  return JSON.parse(line);
};

const runGeometryProbe = async (bordered) => {
  const file = join(tmpdir(), `window-geometry-${bordered ? 'bordered' : 'borderless'}-${process.pid}.ps1`);
  await writeFile(file, geometryProbe(bordered), 'utf8');
  const run = await runPowershell(['-STA', '-File', file]);
  assert.equal(run.ok, true, `the probe failed: ${run.stderr.slice(-400)}`);
  const parsed = lastJson(run.stdout);
  assert.equal(parsed.backgroundStyle & 0x08000080, 0x08000080, 'background is a non-activating tool window');
  assert.equal(parsed.backgroundStyle & 0x00040000, 0, 'background has no APPWINDOW flag');
  assert.equal(parsed.restoredStyle & 0x08040080, parsed.originalStyle & 0x08040080, 'edit restores original shell flags after repeated parking');
  return { move: lastJson(parsed.move), report: lastJson(parsed.report), outer: parsed.outer, client: parsed.client };
};

test('1. a bordered window is moved to the requested CLIENT rectangle, not to the frame', async (t) => {
  const probe = await runGeometryProbe(true);

  // What the script handed SetWindowPos: an OUTER frame bigger than the client rectangle.
  const borderX = probe.move.outer.left - REQUESTED.left;
  const borderY = probe.move.outer.top - REQUESTED.top;
  const borderW = probe.move.outer.width - REQUESTED.width;
  const borderH = probe.move.outer.height - REQUESTED.height;
  assert.ok(borderX < 0, `SetWindowPos must be shifted left by the border (outer.left=${probe.move.outer.left})`);
  assert.ok(borderY < 0, `SetWindowPos must be shifted up by the border/title (outer.top=${probe.move.outer.top})`);
  assert.ok(borderW > 0 && borderH > 0, `the outer frame must include the border (${borderW}x${borderH})`);

  // The window really has that frame, and its client really is the request.
  assert.deepEqual(probe.outer, probe.move.outer, 'the measured outer frame equals what SetWindowPos received');
  assert.deepEqual(probe.client, REQUESTED, 'the measured client rectangle equals the request');
  assert.deepEqual(
    { left: probe.move.left, top: probe.move.top, width: probe.move.width, height: probe.move.height },
    REQUESTED,
    'the move result reports the re-read client rectangle',
  );
  assert.deepEqual(probe.move.delta, { left: 0, top: 0, width: 0, height: 0 }, 'the re-read matches the request');
  assert.deepEqual(probe.report, REQUESTED, '-Report reads the same client rectangle');

  // The regression this pins: the old code passed the client rect as the frame, which would have
  // put the client at requested + border and shrunk it by the border.
  assert.notDeepEqual(probe.outer, REQUESTED, 'outer and client are different rectangles');
  t.diagnostic(`requested client=${JSON.stringify(REQUESTED)} · outer=${JSON.stringify(probe.move.outer)} (border ${-borderX}/${-borderY}, ${borderW}x${borderH}) · measured client=${JSON.stringify(probe.client)} · report=${JSON.stringify(probe.report)}`);
});

test('2. a borderless window has outer == client, and the move stays exact', async (t) => {
  const probe = await runGeometryProbe(false);
  assert.deepEqual(probe.outer, REQUESTED, 'no border means the frame is the client rectangle');
  assert.deepEqual(probe.client, REQUESTED, 'the measured client rectangle equals the request');
  assert.deepEqual(probe.move.outer, REQUESTED);
  assert.deepEqual(probe.move.delta, { left: 0, top: 0, width: 0, height: 0 });
  assert.deepEqual(probe.report, REQUESTED);
  t.diagnostic(`borderless outer=${JSON.stringify(probe.outer)} · client=${JSON.stringify(probe.client)} · delta=${JSON.stringify(probe.move.delta)}`);
});

test('3. the move result is the re-read rectangle, and a >2 px deviation is a mismatch', async () => {
  const events = [];
  let current = { left: 300, top: 200, width: 500, height: 700 };
  const fake = {
    capture: async () => ({ ok: true, bounds: { ...current } }),
    move: async (rect) => {
      const target = clientRect(rect);
      current = { ...target };
      return { ok: true, bounds: { ...target } };
    },
  };
  const verified = verifiedVtsWindow(fake, { onMismatch: (result) => events.push(result) });

  const first = await verified.move({ x: -2200, y: -1400, width: 900, height: 1200 });
  assert.equal(first.ok, true);
  assert.deepEqual(first.actual, { left: -2200, top: -1400, width: 900, height: 1200 });
  assert.equal(first.mismatch, false);
  assert.equal(events.length, 0, 'an honest move records nothing');

  // The OS refuses the width by 8 px: the request is not the result.
  fake.move = async (rect) => {
    const target = clientRect(rect);
    current = { ...target, width: target.width - 8 };
    return { ok: true, bounds: { ...target } };
  };
  const clamped = await verified.move({ x: 40, y: 50, width: 500, height: 600 });
  assert.equal(clamped.ok, true);
  assert.equal(clamped.mismatch, true);
  assert.deepEqual(clamped.actual, { left: 40, top: 50, width: 492, height: 600 });
  assert.equal(events.length, 1, 'window.move.mismatch is emitted once');
  assert.deepEqual(events[0].requested, { left: 40, top: 50, width: 500, height: 600 });
  assert.deepEqual(events[0].actual, clamped.actual);
  assert.equal(MOVE_TOLERANCE_PX, 2);
});

test('4. AvatarLayer.moveVts takes the helper re-read value and records window.move.mismatch', async () => {
  const events = [];
  const log = { emit: async (type, payload) => events.push({ type, payload }) };
  let answer = null;
  const spawnProcess = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    queueMicrotask(() => {
      child.stdout.write(`${JSON.stringify(answer)}\n`);
      child.stdout.end();
      child.emit('close', 0);
    });
    return child;
  };
  const layer = new AvatarLayer({
    dir: join(tmpdir(), 'dsh-window-geometry-layer'),
    root: join(tmpdir(), 'dsh-window-geometry-root'),
    scriptPath: 'C:\\app\\transparent.ps1',
    windowScriptPath: scriptPath,
    log,
    spawnProcess,
  });

  answer = {
    ok: true,
    left: 400, top: 200, width: 500, height: 700,
    requested: { left: 400, top: 200, width: 500, height: 700 },
    delta: { left: 0, top: 0, width: 0, height: 0 },
  };
  const exact = await layer.moveVts({ x: 400, y: 200, width: 500, height: 700 });
  assert.equal(exact.ok, true);
  assert.deepEqual(exact.actual, { left: 400, top: 200, width: 500, height: 700 });
  assert.equal(exact.mismatch, false);
  assert.equal(events.length, 0);

  answer = {
    ok: true,
    left: 400, top: 200, width: 490, height: 700,
    requested: { left: 400, top: 200, width: 500, height: 700 },
    delta: { left: 0, top: 0, width: -10, height: 0 },
  };
  const off = await layer.moveVts({ x: 400, y: 200, width: 500, height: 700 });
  assert.equal(off.mismatch, true);
  assert.deepEqual(off.actual, { left: 400, top: 200, width: 490, height: 700 }, 'the actual client rect is returned');
  assert.notDeepEqual(off.actual, off.requested, 'the request is never reported as the result');
  const mismatch = events.filter((entry) => entry.type === 'window.move.mismatch');
  assert.equal(mismatch.length, 1);
  assert.deepEqual(mismatch[0].payload.requested, { left: 400, top: 200, width: 500, height: 700 });
  assert.deepEqual(mismatch[0].payload.actual, { left: 400, top: 200, width: 490, height: 700 });
});

test('5. a capture position is never a user position; frame acceptance is not coverage alone', () => {
  assert.equal(isCaptureRect(WPF_OFFSCREEN), true);
  assert.equal(isCaptureRect({ x: -2200, y: -1400, width: 100, height: 100 }), true, 'a different size is still the corner');
  assert.equal(isCaptureRect({ x: -400, y: 100, width: 400, height: 600 }), false, 'a monitor left of the primary is valid');
  assert.equal(isCaptureRect(null), false);

  // The reported bug: a black VTS background frames the whole client area. That is a real picture,
  // not a failed capture; only a full frame that stayed identical for several ticks is frozen.
  const black = evaluateFrame({
    bounds: { width: 900, height: 1200 },
    clientWidth: 900,
    clientHeight: 1200,
    identicalFrames: 1,
    visible: true,
  });
  assert.equal(black.accept, true, 'a black frame must not be rejected');
  assert.equal(black.reason, 'ok');
  const frozen = evaluateFrame({ bounds: { width: 900, height: 1200 }, clientWidth: 900, clientHeight: 1200, identicalFrames: 3 });
  assert.equal(frozen.accept, false);
  assert.equal(frozen.reason, 'frozen-covering-frame');
  assert.notEqual(frozen.reason, 'coverage', 'coverage alone is not the criterion');
  assert.equal(evaluateFrame({ bounds: { width: 900, height: 1200 }, clientWidth: 900, clientHeight: 1200, visible: false }).reason, 'window-invisible');
  assert.equal(evaluateFrame({ bounds: { width: 0, height: 0 }, clientWidth: 0, clientHeight: 0 }).reason, 'client-size-zero');
});

test('6. a polluted configuration (capture corner saved as user geometry) is corrected with old -> new', () => {
  const polluted = {
    layerGeometry: { left: -2200, top: -1400, width: 900, height: 1200 },
    layer: { backend: 'spout', spout: { bounds: { x: -2200, y: -1400, width: 900, height: 1200 } } },
  };
  const correction = sanitizeStoredGeometry(polluted);
  assert.equal(correction.fixes.length, 2, 'both polluted keys are reported');
  assert.deepEqual(correction.fixes[0].key, 'layerGeometry');
  assert.deepEqual(correction.fixes[0].oldValue, polluted.layerGeometry);
  assert.deepEqual(correction.fixes[0].newValue, {
    left: WPF_ONSCREEN.x, top: WPF_ONSCREEN.y, width: WPF_ONSCREEN.width, height: WPF_ONSCREEN.height,
  }, 'the on-screen default replaces the capture corner');
  assert.equal(correction.fixes[1].key, 'layer.spout.bounds');
  assert.deepEqual(correction.fixes[1].oldValue, polluted.layer.spout.bounds);
  assert.deepEqual(correction.fixes[1].newValue, {
    x: WPF_ONSCREEN.x, y: WPF_ONSCREEN.y, width: WPF_ONSCREEN.width, height: WPF_ONSCREEN.height,
  });
  assert.deepEqual(correction.patch.layer.backend, 'spout', 'unrelated layer settings are untouched');
  assert.deepEqual(correction.patch.layer.spout.bounds, correction.fixes[1].newValue);

  // A legitimate configuration (the live one on this machine: 1345,561 330x472) is left alone.
  const healthy = { layerGeometry: { left: 1345, top: 561, width: 330, height: 472 }, layer: { backend: 'spout' } };
  const clean = sanitizeStoredGeometry(healthy);
  assert.deepEqual(clean.fixes, []);
  assert.deepEqual(clean.patch, {});
});

// ---- edit geometry: enter is read-only, exit validates + commits ---------------------------

/**
 * A fake `powershell.exe` placed first on PATH. The host talks to the real VTS window through
 * `window-move.ps1` twice (capture `-Report`, move `-X/-Y/-W/-H`, `-Raise` for edit recovery) and
 * to the WPF mirror through `transparent.ps1 -Seconds 0`. The shim answers the former from a state
 * file the test can "drag" between calls and keeps the mirror child alive on the latter. No real
 * VTS, WinForms window or Display is touched.
 */
let fakePowerShellPromise = null;
const ensureFakePowerShell = () => {
  if (fakePowerShellPromise === null) {
    fakePowerShellPromise = (async () => {
      const dir = await mkdtemp(join(tmpdir(), 'dsh-geometry-powershell-'));
      const source = join(dir, 'fake-powershell.cs');
      const exe = join(dir, 'powershell.exe');
      const log = join(dir, 'calls.log');
      writeFileSync(source, String.raw`
using System;
using System.IO;
using System.Threading;
public class FakePowerShell {
  static string Arg(string[] args, string name) {
    for (int i = 0; i < args.Length - 1; i++) {
      if (args[i] == name) return args[i + 1];
    }
    return null;
  }
  static int[] ReadState(string path) {
    try {
      string[] parts = File.ReadAllText(path).Trim().Split(',');
      return new int[] { int.Parse(parts[0]), int.Parse(parts[1]), int.Parse(parts[2]), int.Parse(parts[3]) };
    } catch {
      return new int[] { 120, 80, 900, 1200 };
    }
  }
  public static int Main(string[] args) {
    string all = string.Join(" ", args);
    string log = Environment.GetEnvironmentVariable("DSH_FAKE_POWERSHELL_LOG");
    if (log != null && log.Length > 0) {
      try { File.AppendAllText(log, all + "\n"); } catch { }
    }
    if (all.Contains("-Seconds")) { Thread.Sleep(120000); return 0; }
    if (all.Contains("-Report") && Environment.GetEnvironmentVariable("DSH_FAKE_WINDOW_REPORT_FAIL") == "1") {
      Console.WriteLine("no-vts");
      return 1;
    }
    string state = Environment.GetEnvironmentVariable("DSH_FAKE_WINDOW_STATE");
    int[] r = ReadState(state);
    if (!all.Contains("-Report")) {
      string sx = Arg(args, "-X"), sy = Arg(args, "-Y"), sw = Arg(args, "-W"), sh = Arg(args, "-H");
      if (sx != null && sy != null && sw != null && sh != null) {
        r = new int[] { int.Parse(sx), int.Parse(sy), int.Parse(sw), int.Parse(sh) };
        try { File.WriteAllText(state, r[0] + "," + r[1] + "," + r[2] + "," + r[3]); } catch { }
      }
    }
    bool raised = all.Contains("-Raise");
    Console.WriteLine("{\"ok\":true,\"raised\":" + (raised ? "true" : "false") + ",\"left\":" + r[0] + ",\"top\":" + r[1] + ",\"width\":" + r[2] + ",\"height\":" + r[3] + "}");
    return 0;
  }
}
`, 'utf8');
      const quote = (value) => `'${String(value).replace(/'/gu, "''")}'`;
      execFileSync('powershell', [
        '-NoProfile', '-NonInteractive', '-Command',
        `Add-Type -TypeDefinition ([IO.File]::ReadAllText(${quote(source)})) -OutputAssembly ${quote(exe)} -OutputType ConsoleApplication`,
      ], { windowsHide: true, timeout: 60_000 });
      return { dir, log, state: join(dir, 'window.txt') };
    })().catch((error) => {
      fakePowerShellPromise = null;
      throw error;
    });
  }
  return fakePowerShellPromise;
};

/** The test "drags" the VTS client rectangle by writing the state file the shim answers from. */
const placeWindow = (stateFile, rect) => {
  writeFileSync(stateFile, `${rect.x ?? rect.left},${rect.top ?? rect.y},${rect.width},${rect.height}\n`, 'utf8');
};

/** Minimal stand-in for the DSH context: enough for `apply()` to mount and register routes. */
function makeHostContext() {
  const routes = new Map();
  const disposers = [];
  const effect = (fn) => {
    const result = fn();
    disposers.push(result);
    return result;
  };
  const services = {
    systemPrompt: { section: () => ({ dispose() {} }) },
    webServer: {
      register: (route) => {
        routes.set(route.path, route.handler);
        return { dispose() {} };
      },
    },
  };
  const scopeOf = (names) => {
    const target = { effect };
    for (const service of names) target[service] = services[service];
    return new Proxy(target, { get: (inner, key) => (key in inner ? inner[key] : () => ({ dispose() {} })) });
  };
  const ctx = {
    effect,
    tools: { register: () => () => {} },
    get: () => undefined,
    inject: (names, fn) => fn(scopeOf(names)),
  };
  return { ctx, routes, dispose: () => {
    for (const entry of disposers.reverse()) {
      try {
        if (typeof entry === 'function') entry();
        else entry?.dispose?.();
      } catch {
        /* teardown is best-effort */
      }
    }
  } };
}

/** One `/assistant/action` or `/assistant/status` call, exactly like the page makes it. */
async function callRoute(routes, path, body) {
  const handler = routes.get(path);
  if (handler === undefined) throw new Error(`route not registered: ${path}`);
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  req.method = body === undefined ? 'GET' : 'POST';
  const res = {
    statusCode: 0,
    body: '',
    writeHead(code) { this.statusCode = code; },
    end(text) { this.body = String(text ?? ''); },
  };
  await handler(req, res);
  return JSON.parse(res.body);
}

const readHostEvents = (root) => {
  const file = join(root, 'data', 'events.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
};

/**
 * A loopback TCP port with nothing listening on it.
 *
 * The plugin schedules a VTube Studio auto-connect 8 s after a mount. Pointed at the real 8001 it
 * opens a real WebSocket to the user's VTS: an authorization request left waiting (or a granted
 * connection) is owned by no test fixture, so it outlives `ctx.dispose()` and the test process
 * never exits. Every mount gets a dead port instead — the attempt fails at once and leaves nothing.
 */
const unusedLoopbackPort = () => new Promise((resolvePort, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolvePort(port));
  });
});

let hostSequence = 0;
/** Mount the real plugin against the fake window helper and a real settings.json. */
async function mountHost(t, initialSettings) {
  const shim = await ensureFakePowerShell();
  const vtsPort = await unusedLoopbackPort();
  hostSequence += 1;
  const stateFile = join(shim.dir, `window-${process.pid}-${hostSequence}.txt`);
  placeWindow(stateFile, { x: 140, y: 260, width: 480, height: 720 });
  const root = await mkdtemp(join(tmpdir(), 'dsh-geometry-host-'));
  const settingsFile = join(root, 'data', 'settings.json');
  await mkdir(join(root, 'data'), { recursive: true });
  writeFileSync(settingsFile, `${JSON.stringify(initialSettings, null, 2)}\n`, 'utf8');
  const pathBefore = process.env.PATH;
  const logBefore = process.env.DSH_FAKE_POWERSHELL_LOG;
  const stateBefore = process.env.DSH_FAKE_WINDOW_STATE;
  const failBefore = process.env.DSH_FAKE_WINDOW_REPORT_FAIL;
  process.env.PATH = `${shim.dir};${pathBefore ?? ''}`;
  process.env.DSH_FAKE_POWERSHELL_LOG = shim.log;
  process.env.DSH_FAKE_WINDOW_STATE = stateFile;
  delete process.env.DSH_FAKE_WINDOW_REPORT_FAIL;
  const mounted = makeHostContext();
  t.after(async () => {
    mounted.dispose();
    if (pathBefore === undefined) delete process.env.PATH;
    else process.env.PATH = pathBefore;
    if (logBefore === undefined) delete process.env.DSH_FAKE_POWERSHELL_LOG;
    else process.env.DSH_FAKE_POWERSHELL_LOG = logBefore;
    if (stateBefore === undefined) delete process.env.DSH_FAKE_WINDOW_STATE;
    else process.env.DSH_FAKE_WINDOW_STATE = stateBefore;
    if (failBefore === undefined) delete process.env.DSH_FAKE_WINDOW_REPORT_FAIL;
    else process.env.DSH_FAKE_WINDOW_REPORT_FAIL = failBefore;
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });
  // `vtsPort` keeps the plugin's auto-connect away from the user's real VTube Studio.
  apply(mounted.ctx, { root, defaultDomain: 'chat', enabled: true, dependencyBootDelayMs: 600000, vtsPort });
  return {
    root,
    routes: mounted.routes,
    place: (rect) => placeWindow(stateFile, rect),
    failRead: () => { process.env.DSH_FAKE_WINDOW_REPORT_FAIL = '1'; },
    settings: () => JSON.parse(readFileSync(settingsFile, 'utf8')),
    events: () => readHostEvents(root),
    status: () => callRoute(mounted.routes, '/assistant/status'),
  };
}

const displayRect = (transparent) => ({
  x: transparent.left,
  y: transparent.top,
  width: transparent.width,
  height: transparent.height,
});
const asXY = (rect) => ({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
const savedRect = (settings) => settings.layerGeometry;

test('7. 进入编辑只读已保存几何：layerGeometry 文件值不变，读回值只进 editRect', async (t) => {
  const saved = { left: 140, top: 260, width: 480, height: 720 };
  const host = await mountHost(t, { layer: { backend: 'wpf' }, layerGeometry: saved });

  const entered = await callRoute(host.routes, '/assistant/action', { action: 'layer.edit.enter' });

  assert.equal(entered.ok, true, entered.error ?? entered.code ?? 'enter failed');
  assert.deepEqual(savedRect(host.settings()), saved, 'settings.layerGeometry is not overwritten on enter');
  const status = await host.status();
  assert.equal(status.layer.editMode, true);
  assert.deepEqual(status.layer.editRect, saved, 'editRect holds the actual read-back rectangle');
  assert.equal(host.events().filter((event) => event.type === 'layer.geometry.saved').length, 0, 'no save event on enter');
  t.diagnostic(`layerGeometry=${JSON.stringify(savedRect(host.settings()))} · editRect=${JSON.stringify(status.layer.editRect)} · savedEvents=0`);
});

test('8. 退出编辑且矩形有效：保存 layerGeometry 并以同 bounds 启动显示层', async (t) => {
  const old = { left: 140, top: 260, width: 480, height: 720 };
  const user = { x: 300, y: 200, width: 500, height: 700 };
  const host = await mountHost(t, { layer: { backend: 'wpf' }, layerGeometry: old });
  await callRoute(host.routes, '/assistant/action', { action: 'layer.edit.enter' });
  host.place(user);

  const exited = await callRoute(host.routes, '/assistant/action', { action: 'layer.edit.exit' });

  assert.equal(exited.ok, true, exited.code ?? 'exit failed');
  assert.deepEqual(savedRect(host.settings()), { left: 300, top: 200, width: 500, height: 700 });
  const status = await host.status();
  assert.deepEqual(displayRect(status.transparent), user, 'the display started with exactly the saved bounds');
  const savedEvents = host.events().filter((event) => event.type === 'layer.geometry.saved');
  assert.equal(savedEvents.length, 1);
  assert.equal(savedEvents[0].payload.source, 'wpf');
  assert.deepEqual(savedEvents[0].payload.rect, user);
  t.diagnostic(`saved=${JSON.stringify(savedRect(host.settings()))} · start bounds=${JSON.stringify(displayRect(status.transparent))} · event=layer.geometry.saved rect=${JSON.stringify(savedEvents[0].payload.rect)}`);
});

test('9. 退出编辑且矩形过小（150×150）：拒绝、旧几何保留、显示层按旧几何启动', async (t) => {
  const old = { left: 140, top: 260, width: 480, height: 720 };
  const tiny = { x: 10, y: 10, width: 150, height: 150 };
  const host = await mountHost(t, { layer: { backend: 'wpf' }, layerGeometry: old });
  await callRoute(host.routes, '/assistant/action', { action: 'layer.edit.enter' });
  host.place(tiny);

  const exited = await callRoute(host.routes, '/assistant/action', { action: 'layer.edit.exit' });

  assert.equal(exited.ok, false, 'the failure is reported, never silent');
  assert.equal(exited.code, 'GEOMETRY_SIZE_INVALID');
  assert.equal(exited.geometryRejected, true);
  assert.deepEqual(savedRect(host.settings()), old, 'the old geometry is untouched');
  const status = await host.status();
  assert.deepEqual(displayRect(status.transparent), asXY(old), 'the display started from the old geometry');
  const rejected = host.events().filter((event) => event.type === 'layer.geometry.rejected');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].payload.reason, 'GEOMETRY_SIZE_INVALID');
  assert.deepEqual(rejected[0].payload.rect, tiny);
  assert.equal(host.events().filter((event) => event.type === 'layer.geometry.saved').length, 0);
  t.diagnostic(`code=${exited.code} · layerGeometry=${JSON.stringify(savedRect(host.settings()))} · start bounds=${JSON.stringify(displayRect(status.transparent))} · rejected=${rejected[0].payload.reason} rect=${JSON.stringify(rejected[0].payload.rect)}`);
});

test('10. 退出编辑且读回等于采集位置：拒绝，绝不写入 layerGeometry', async (t) => {
  const old = { left: 140, top: 260, width: 480, height: 720 };
  const host = await mountHost(t, { layer: { backend: 'wpf' }, layerGeometry: old });
  await callRoute(host.routes, '/assistant/action', { action: 'layer.edit.enter' });
  host.place({ x: WPF_OFFSCREEN.x, y: WPF_OFFSCREEN.y, width: WPF_OFFSCREEN.width, height: WPF_OFFSCREEN.height });

  const exited = await callRoute(host.routes, '/assistant/action', { action: 'layer.edit.exit' });

  assert.equal(exited.ok, false);
  assert.equal(exited.code, 'GEOMETRY_CAPTURE_POSITION');
  assert.deepEqual(savedRect(host.settings()), old);
  const status = await host.status();
  assert.deepEqual(displayRect(status.transparent), asXY(old), 'the display presents the old geometry, not the corner');
  const rejected = host.events().filter((event) => event.type === 'layer.geometry.rejected');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].payload.reason, 'GEOMETRY_CAPTURE_POSITION');
  assert.deepEqual(rejected[0].payload.rect, { ...WPF_OFFSCREEN });
  t.diagnostic(`code=${exited.code} · corner=${JSON.stringify(WPF_OFFSCREEN)} · saved=${JSON.stringify(savedRect(host.settings()))} · start=${JSON.stringify(displayRect(status.transparent))}`);
});

test('11. 副屏负坐标（-1200,300,800×600）是合法位置，允许保存并使用', async (t) => {
  const old = { left: 140, top: 260, width: 480, height: 720 };
  const negative = { x: -1200, y: 300, width: 800, height: 600 };
  assert.equal(isCaptureRect(negative), false, 'negative coordinates alone are not a capture corner');
  const host = await mountHost(t, { layer: { backend: 'wpf' }, layerGeometry: old });
  await callRoute(host.routes, '/assistant/action', { action: 'layer.edit.enter' });
  host.place(negative);

  const exited = await callRoute(host.routes, '/assistant/action', { action: 'layer.edit.exit' });

  assert.equal(exited.ok, true, exited.code ?? 'negative coordinates must be accepted');
  assert.deepEqual(savedRect(host.settings()), { left: -1200, top: 300, width: 800, height: 600 });
  const status = await host.status();
  assert.deepEqual(displayRect(status.transparent), negative);
  assert.equal(host.events().filter((event) => event.type === 'layer.geometry.rejected').length, 0);
  t.diagnostic(`negative=${JSON.stringify(negative)} · saved=${JSON.stringify(savedRect(host.settings()))} · start=${JSON.stringify(displayRect(status.transparent))} · rejected=0`);
});

test('12. 编辑中切后端：editRect 交接实际矩形，layerGeometry 与 layer.spout.bounds 都不变', async (t) => {
  const wpfSaved = { left: 640, top: 480, width: 400, height: 640 };
  const spoutSaved = { x: 140, y: 260, width: 480, height: 720 };
  const user = { x: -1200, y: 300, width: 800, height: 600 };
  const host = await mountHost(t, {
    layer: { backend: 'spout', spout: { bounds: spoutSaved } },
    layerGeometry: wpfSaved,
  });
  const entered = await callRoute(host.routes, '/assistant/action', { action: 'layer.edit.enter' });
  assert.equal(entered.ok, true, entered.code ?? 'spout edit enter failed');
  assert.equal(entered.editBackend, 'spout');
  host.place(user);

  const switched = await callRoute(host.routes, '/assistant/action', { action: 'layer.backend', backend: 'wpf' });

  assert.equal(switched.ok, true, switched.code ?? 'switch failed');
  assert.equal(switched.editMode, true, 'the edit session survives the switch');
  assert.equal(switched.editBackend, 'wpf');
  assert.equal(switched.handedOff, true);
  assert.deepEqual(switched.bounds, { left: -1200, top: 300, width: 800, height: 600 }, 'the handover carries the actual session rectangle');
  assert.deepEqual(host.settings().layerGeometry, wpfSaved, 'layerGeometry is not written by the handover');
  assert.deepEqual(host.settings().layer.spout.bounds, spoutSaved, 'the Spout rectangle is not written either');
  const status = await host.status();
  assert.deepEqual(status.layer.editRect, { left: -1200, top: 300, width: 800, height: 600 }, 'WPF adopted editRect');
  assert.equal(host.events().filter((event) => event.type === 'layer.geometry.saved').length, 0, 'a handover commits nothing');
  t.diagnostic(`switch editMode=${switched.editMode} editBackend=${status.layer.editBackend} · editRect=${JSON.stringify(status.layer.editRect)} · layerGeometry=${JSON.stringify(host.settings().layerGeometry)} · spout.bounds=${JSON.stringify(host.settings().layer.spout.bounds)} · savedEvents=0`);
});

test('13. 校验只拒绝尺寸/比例/采集位置/读回失败，不拒绝负坐标', () => {
  assert.deepEqual(EDIT_GEOMETRY_LIMITS, { minSize: 200, maxSize: 4000, minAspect: 0.2, maxAspect: 5 });
  assert.deepEqual(validateEditGeometry({ x: -1200, y: -600, width: 800, height: 600 }), {
    ok: true, reason: '', rect: { x: -1200, y: -600, width: 800, height: 600 },
  }, 'negative x/y is a valid monitor position');
  assert.equal(validateEditGeometry(null).reason, 'GEOMETRY_READ_FAILED', 'unreadable/timeout read');
  assert.equal(validateEditGeometry({ x: 0, y: 0, width: 150, height: 150 }).reason, 'GEOMETRY_SIZE_INVALID');
  assert.equal(validateEditGeometry({ x: 0, y: 0, width: 5000, height: 600 }).reason, 'GEOMETRY_SIZE_INVALID');
  assert.equal(validateEditGeometry({ x: 0, y: 0, width: 2000, height: 200 }).reason, 'GEOMETRY_ASPECT_INVALID');
  assert.equal(validateEditGeometry({ ...WPF_OFFSCREEN }).reason, 'GEOMETRY_CAPTURE_POSITION');
  assert.equal(validateEditGeometry({ x: -2200, y: -1400, width: 300, height: 400 }).reason, 'GEOMETRY_CAPTURE_POSITION',
    'origin only: a different size at the capture corner is still refused');
});

test('14. 退出编辑读回失败（窗口不可读/超时同路径）：拒绝、旧几何保留、显示层按旧几何启动', async (t) => {
  const old = { left: 140, top: 260, width: 480, height: 720 };
  const host = await mountHost(t, { layer: { backend: 'wpf' }, layerGeometry: old });
  await callRoute(host.routes, '/assistant/action', { action: 'layer.edit.enter' });
  host.place({ x: 300, y: 200, width: 500, height: 700 });
  host.failRead();

  const exited = await callRoute(host.routes, '/assistant/action', { action: 'layer.edit.exit' });

  assert.equal(exited.ok, false, 'an unreadable window is an explicit failure');
  assert.equal(exited.code, 'GEOMETRY_READ_FAILED');
  assert.deepEqual(savedRect(host.settings()), old, 'the old geometry is not overwritten');
  const status = await host.status();
  assert.deepEqual(displayRect(status.transparent), asXY(old), 'the display starts from the saved geometry');
  const rejected = host.events().filter((event) => event.type === 'layer.geometry.rejected');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].payload.reason, 'GEOMETRY_READ_FAILED');
  assert.equal(rejected[0].payload.rect, null);
  t.diagnostic(`code=${exited.code} · layerGeometry=${JSON.stringify(savedRect(host.settings()))} · start=${JSON.stringify(displayRect(status.transparent))} · rejected=${rejected[0].payload.reason} rect=null`);
});

// ---- Spout edit exit: ONE validated read drives park / start / save ------------------------

/**
 * Replace the real window helper with a scripted one for a Spout exit:
 *  - `arm(rect|null)` is the host's read (`null` = unreadable); it is answered exactly once;
 *  - `later` is what the layer's OWN geometry read would answer (the second read of the bug);
 *  - every display start is recorded instead of spawning Electron.
 * The verification re-read inside `verifiedVtsWindow.move()` is not a geometry read and is not
 * counted: `layerReads` only counts `SpoutLayer.captureVts()`.
 */
function stubSpoutExit(t, { current }) {
  const state = {
    current: { ...current },
    hostReads: 0,
    layerReads: 0,
    starts: [],
    moves: [],
    later: null,
    armed: undefined,
  };
  const original = {
    capture: VtsWindow.prototype.capture,
    move: VtsWindow.prototype.move,
    captureVts: SpoutLayer.prototype.captureVts,
    start: SpoutLayer.prototype.start,
  };
  VtsWindow.prototype.capture = async function capture() {
    if (state.armed !== undefined) {
      const answer = state.armed;
      state.armed = undefined;
      state.hostReads += 1;
      if (answer === null) return { ok: false, code: 'VTS_NOT_RUNNING', message: 'no-vts' };
      state.current = { ...answer };
      return { ok: true, bounds: { ...answer } };
    }
    return { ok: true, bounds: { ...state.current } };
  };
  VtsWindow.prototype.move = async function move(rect) {
    state.moves.push({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    state.current = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    return { ok: true, bounds: { ...state.current } };
  };
  SpoutLayer.prototype.captureVts = async function captureVts() {
    state.layerReads += 1;
    if (state.later === null) return { ok: false, code: 'VTS_NOT_RUNNING', message: 'no-vts' };
    return { ok: true, bounds: { ...state.later } };
  };
  SpoutLayer.prototype.start = async function start(options) {
    const bounds = options?.bounds ?? null;
    state.starts.push(bounds === null ? null : { ...bounds });
    return { ok: true, running: true, pid: 700_001, bounds: bounds === null ? null : { ...bounds } };
  };
  t.after(() => {
    VtsWindow.prototype.capture = original.capture;
    VtsWindow.prototype.move = original.move;
    SpoutLayer.prototype.captureVts = original.captureVts;
    SpoutLayer.prototype.start = original.start;
  });
  state.arm = (answer) => { state.armed = answer ?? null; };
  return state;
}

/** The real VTS window's remembered restore target, as the host reports it (no private state). */
const vtsOriginalOf = async (host) => (await host.status()).live2d.spoutLayer.vtsWindow.original;
/** Where `hideVts()` parks VTS: the shared far corner, at the width/height it is remembering. */
const parkedVts = (rect) => ({ x: VTS_OFFSCREEN.x, y: VTS_OFFSCREEN.y, width: rect.width, height: rect.height });

test('15. 退出 Spout 编辑：首次读取有效 → start bounds === 校验矩形，第二次读 150×150 被忽略', async (t) => {
  const old = { left: 140, top: 260, width: 480, height: 720 };
  const host = await mountHost(t, { layer: { backend: 'spout', spout: { bounds: old } }, layerGeometry: old });
  const stub = stubSpoutExit(t, { current: asXY(old) });
  const entered = await callRoute(host.routes, '/assistant/action', { action: 'layer.edit.enter' });
  assert.equal(entered.ok, true, entered.code ?? entered.error ?? 'spout enter failed');

  const user = { x: 300, y: 200, width: 500, height: 700 };
  // The window changes between the host read and the layer's old second read: the bug started
  // the display at this one while reporting a rejection.
  stub.later = { x: 10, y: 10, width: 150, height: 150 };
  stub.arm(user);

  const exited = await callRoute(host.routes, '/assistant/action', { action: 'layer.edit.exit' });

  assert.equal(exited.ok, true, exited.code ?? 'exit failed');
  assert.equal(stub.hostReads, 1, 'the host reads the VTS window exactly once');
  assert.equal(stub.layerReads, 0, 'the layer never performs a second read');
  assert.deepEqual(stub.starts, [user], 'only the validated rectangle is started');
  assert.deepEqual(exited.bounds, user, 'the return value is the started rectangle');
  // The SOURCE window is the one that must not be resized: parking, restore target and start all
  // carry the validated rectangle.
  assert.deepEqual(stub.moves.at(-1), parkedVts(user), 'VTS is parked at the validated size');
  assert.deepEqual(stub.current, parkedVts(user), 'the real VTS window is 500×700, not 150×150');
  assert.deepEqual(await vtsOriginalOf(host), user, 'the VTS restore target is the validated rectangle');
  assert.deepEqual(savedRect(host.settings()), { left: 300, top: 200, width: 500, height: 700 });
  assert.deepEqual(host.settings().layer.spout.bounds, user);
  const saved = host.events().filter((event) => event.type === 'layer.geometry.saved');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].payload.source, 'spout');
  assert.deepEqual(saved[0].payload.rect, user);
  t.diagnostic(`reads host=${stub.hostReads} layer=${stub.layerReads} · start bounds=${JSON.stringify(stub.starts[0])} · VTS parked=${JSON.stringify(stub.current)} · vtsOriginal=${JSON.stringify(await vtsOriginalOf(host))} · return=${JSON.stringify(exited.bounds)} · saved=${JSON.stringify(savedRect(host.settings()))}`);
});

test('16. 退出 Spout 编辑：首个读取非法（150×150）→ 不启动该校验值、按旧几何启动、返回拒绝', async (t) => {
  const old = { left: 140, top: 260, width: 480, height: 720 };
  const host = await mountHost(t, { layer: { backend: 'spout', spout: { bounds: old } }, layerGeometry: old });
  const stub = stubSpoutExit(t, { current: asXY(old) });
  const entered = await callRoute(host.routes, '/assistant/action', { action: 'layer.edit.enter' });
  assert.equal(entered.ok, true, entered.code ?? entered.error ?? 'spout enter failed');

  const invalid = { x: 10, y: 10, width: 150, height: 150 };
  // A second read would be valid: it must not rescue the rejected rectangle or be started.
  stub.later = { x: 300, y: 200, width: 500, height: 700 };
  stub.arm(invalid);

  const exited = await callRoute(host.routes, '/assistant/action', { action: 'layer.edit.exit' });

  assert.equal(exited.ok, false, 'the rejection is reported, never silent');
  assert.equal(exited.code, 'GEOMETRY_SIZE_INVALID');
  assert.equal(exited.geometryRejected, true);
  assert.equal(stub.hostReads, 1);
  assert.equal(stub.layerReads, 0, 'a rejected host read is not retried by the layer');
  assert.deepEqual(stub.starts, [asXY(old)], 'the display starts from the saved geometry, never 150×150');
  assert.deepEqual(exited.bounds, asXY(old));
  // The SOURCE window: parking, restore target and start are the safe (saved) rectangle. The
  // rejected 150×150 must not appear in any real position.
  assert.deepEqual(stub.moves.at(-1), parkedVts(old), 'VTS is parked at the safe size, not 150×150');
  assert.deepEqual(stub.current, parkedVts(old), 'the real VTS window stayed 480×720');
  assert.deepEqual(await vtsOriginalOf(host), asXY(old), 'the restore target is the saved geometry');
  assert.deepEqual(savedRect(host.settings()), old, 'the old geometry is untouched');
  const rejected = host.events().filter((event) => event.type === 'layer.geometry.rejected');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].payload.reason, 'GEOMETRY_SIZE_INVALID');
  assert.deepEqual(rejected[0].payload.rect, invalid);
  assert.equal(host.events().filter((event) => event.type === 'layer.geometry.saved').length, 0);
  t.diagnostic(`code=${exited.code} · reads host=${stub.hostReads} layer=${stub.layerReads} · start bounds=${JSON.stringify(stub.starts[0])} · VTS parked=${JSON.stringify(stub.current)} · vtsOriginal=${JSON.stringify(await vtsOriginalOf(host))} · return=${JSON.stringify(exited.bounds)} · saved=${JSON.stringify(savedRect(host.settings()))}`);
});

test('17. 退出 Spout 编辑：读取失败 → 不启动、按旧几何启动、返回 GEOMETRY_READ_FAILED', async (t) => {
  const old = { left: 140, top: 260, width: 480, height: 720 };
  const host = await mountHost(t, { layer: { backend: 'spout', spout: { bounds: old } }, layerGeometry: old });
  const stub = stubSpoutExit(t, { current: asXY(old) });
  const entered = await callRoute(host.routes, '/assistant/action', { action: 'layer.edit.enter' });
  assert.equal(entered.ok, true, entered.code ?? entered.error ?? 'spout enter failed');

  // The host read fails; a retry inside the layer would answer a valid rectangle.
  stub.later = { x: 300, y: 200, width: 500, height: 700 };
  stub.arm(null);

  const exited = await callRoute(host.routes, '/assistant/action', { action: 'layer.edit.exit' });

  assert.equal(exited.ok, false, 'an unreadable window is an explicit failure');
  assert.equal(exited.code, 'GEOMETRY_READ_FAILED');
  assert.equal(stub.hostReads, 1);
  assert.equal(stub.layerReads, 0, 'a failed host read is not retried by the layer');
  assert.deepEqual(stub.starts, [asXY(old)], 'the display starts from the saved geometry');
  assert.deepEqual(exited.bounds, asXY(old));
  assert.deepEqual(stub.moves.at(-1), parkedVts(old), 'VTS is parked at the saved size');
  assert.deepEqual(await vtsOriginalOf(host), asXY(old), 'the restore target is the saved geometry');
  assert.deepEqual(savedRect(host.settings()), old);
  const rejected = host.events().filter((event) => event.type === 'layer.geometry.rejected');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].payload.reason, 'GEOMETRY_READ_FAILED');
  assert.equal(rejected[0].payload.rect, null);
  assert.equal(host.events().filter((event) => event.type === 'layer.geometry.saved').length, 0);
  t.diagnostic(`code=${exited.code} · reads host=${stub.hostReads} layer=${stub.layerReads} · start bounds=${JSON.stringify(stub.starts[0])} · VTS parked=${JSON.stringify(stub.current)} · vtsOriginal=${JSON.stringify(await vtsOriginalOf(host))} · return=${JSON.stringify(exited.bounds)} · saved=${JSON.stringify(savedRect(host.settings()))}`);
});

// ---- the safe rectangle when the last SAVED geometry is unusable ---------------------------

test('18. 退出 Spout 编辑：旧几何不可用 + 读取失败 → 用当前 VTS 可见矩形作 safe rect', async (t) => {
  // No usable saved geometry: neither `layerGeometry` nor `layer.spout.bounds` exists.
  const host = await mountHost(t, { layer: { backend: 'spout' } });
  const stub = stubSpoutExit(t, { current: { x: 80, y: 60, width: 900, height: 1000 } });
  const entered = await callRoute(host.routes, '/assistant/action', { action: 'layer.edit.enter' });
  assert.equal(entered.ok, true, entered.code ?? entered.error ?? 'spout enter failed');

  // The user left VTS at this visible rectangle; the host read itself fails.
  const visible = { x: 320, y: 180, width: 520, height: 760 };
  stub.current = { ...visible };
  stub.arm(null);

  const exited = await callRoute(host.routes, '/assistant/action', { action: 'layer.edit.exit' });

  assert.equal(exited.ok, false, 'the rejection is still reported');
  assert.equal(exited.code, 'GEOMETRY_READ_FAILED');
  assert.equal(stub.layerReads, 0, 'the layer still never reads the window');
  assert.deepEqual(stub.starts, [visible], 'the display starts at the visible rectangle');
  assert.deepEqual(exited.bounds, visible, 'the return value is what was started/parked');
  assert.deepEqual(stub.moves.at(-1), parkedVts(visible), 'VTS is parked at the visible size');
  assert.deepEqual(stub.current, parkedVts(visible));
  assert.deepEqual(await vtsOriginalOf(host), visible, 'the restore target is the visible rectangle');
  // Nothing was saved: the rejected read is not a geometry, and neither is a guessed default.
  assert.equal(host.settings().layerGeometry, undefined, 'no layerGeometry is invented');
  assert.equal(host.settings().layer.spout?.bounds, undefined, 'no spout bounds are invented');
  const rejected = host.events().filter((event) => event.type === 'layer.geometry.rejected');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].payload.reason, 'GEOMETRY_READ_FAILED');
  t.diagnostic(`code=${exited.code} · saved=unusable · visible read=${JSON.stringify(visible)} · start bounds=${JSON.stringify(stub.starts[0])} · VTS parked=${JSON.stringify(stub.current)} · vtsOriginal=${JSON.stringify(await vtsOriginalOf(host))} · return=${JSON.stringify(exited.bounds)} · layerGeometry=${JSON.stringify(host.settings().layerGeometry)}`);
});

test('19. 退出 Spout 编辑：既无旧几何、可见矩形也非法 → 不移动 VTS，只报错', async (t) => {
  const host = await mountHost(t, { layer: { backend: 'spout' } });
  const stub = stubSpoutExit(t, { current: { x: 80, y: 60, width: 900, height: 1000 } });
  const entered = await callRoute(host.routes, '/assistant/action', { action: 'layer.edit.enter' });
  assert.equal(entered.ok, true, entered.code ?? entered.error ?? 'spout enter failed');
  const movesBefore = stub.moves.length;

  // The read fails AND the window the host can see is the illegal rectangle: nothing is safe.
  stub.current = { x: 10, y: 10, width: 150, height: 150 };
  stub.arm(null);

  const exited = await callRoute(host.routes, '/assistant/action', { action: 'layer.edit.exit' });

  assert.equal(exited.ok, false, 'the failure is reported');
  assert.equal(exited.code, 'GEOMETRY_READ_FAILED');
  assert.equal(stub.moves.length, movesBefore, 'VTS is not moved at all');
  assert.deepEqual(stub.current, { x: 10, y: 10, width: 150, height: 150 }, 'VTS keeps the rectangle it had');
  assert.deepEqual(stub.starts, [], 'no display is started at an unknown rectangle');
  assert.equal(exited.bounds, null, 'there is no rectangle to report as started/parked');
  assert.equal(await vtsOriginalOf(host), null, 'no restore target is invented');
  const status = await host.status();
  assert.equal(status.layer.editMode, false, 'the edit session is closed, VTS left visible');
  const closeEvent = host.events().filter((event) => event.type === 'spout.edit.exit').at(-1);
  assert.equal(closeEvent?.payload.closeOnly, true);
  assert.equal(closeEvent?.payload.moved, false);
  t.diagnostic(`code=${exited.code} · VTS unchanged=${JSON.stringify(stub.current)} · moves=${stub.moves.length - movesBefore} · starts=0 · vtsOriginal=null · bounds=null`);
});
