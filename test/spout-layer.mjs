/**
 * Spout display layer — phase 0 acceptance harness.
 *
 * Exercises the real host wiring (plugin mount → /assistant/action → SpoutLayer) and the real
 * display process, using an Electron runtime the user must configure explicitly. It covers the
 * phase-0 checklist:
 *
 *   1. unset launcher → ELECTRON_EXE_UNSET and no spawn;
 *   2. launcher validation → ELECTRON_EXE_INVALID / ELECTRON_VERSION_MISMATCH;
 *   3. real start → control ready, then a *registered* receiver (receiver, or waiting-sender when
 *      the default sender is down) and a visible window;
 *   4. stop → process tree gone within the 3 s grace;
 *   5. host dies (stdin EOF) → the child exits on its own; a non-pipe launch still reaches a
 *      registered receiver phase;
 *   6. attribution sweep → a PID whose creation time does not match is NOT killed;
 *   7. @napolab/texture-bridge is actually loaded → version + the real `.node` path, and a
 *      failed load reports BRIDGE_LOAD_FAILED with the original MODULE_NOT_FOUND text;
 *   8. geometry → GetWindowRect equals the host-supplied bounds; no bounds → centred 520×800 with
 *      boundsSource:"fallback";
 *   9. a missing sender → waiting-sender (registered:true) then SENDER_NOT_FOUND, window alive.
 *
 * Run: node test/spout-layer.mjs
 * Env: SPOUT_TEST_ELECTRON=<absolute path to electron.exe>  (default: ./.tmp-electron-44.7.0)
 */
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { apply } from '../src/host/index.js';
import { DEFAULT_STOP_DEADLINE_MS, PINNED_ELECTRON_MAJOR, SpoutLayer } from '../src/host/avatar/spoutLayer.js';

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const electronPath = resolve(
  process.env.SPOUT_TEST_ELECTRON || join(repo, '.tmp-electron-44.7.0', 'electron.exe'),
);
const layerMain = join(repo, 'src', 'host', 'avatar', 'spout-layer', 'main.js');
const bridgeEntry = join(repo, 'node_modules', '@napolab', 'texture-bridge', 'index.js');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const steps = [];
const check = (name, condition, detail) => {
  steps.push({ name, ok: condition === true, detail });
  if (!condition) throw new Error(`assertion failed: ${name} :: ${JSON.stringify(detail)}`);
  return detail;
};

const powershell = (script) =>
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim();

/** Actual OS window rectangle (GetWindowRect), not Electron's self-report. */
const windowRect = (pid) => {
  const script = `
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class DshWin32 {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}';
[void][DshWin32]::SetProcessDPIAware();
$p = Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue;
if ($p -and $p.MainWindowHandle -ne 0) {
  $r = New-Object DshWin32+RECT;
  [void][DshWin32]::GetWindowRect($p.MainWindowHandle, [ref]$r);
  [pscustomobject]@{ left = $r.Left; top = $r.Top; width = $r.Right - $r.Left; height = $r.Bottom - $r.Top; handle = $p.MainWindowHandle.ToInt64() } | ConvertTo-Json -Compress
} else { '{"handle":0}' }
`;
  return JSON.parse(powershell(script));
};

/** The default sender is only present while VTS is actually running. */
const vtsRunning = () => powershell("(Get-Process -Name 'VTube Studio' -ErrorAction SilentlyContinue | Measure-Object).Count") !== '0';

const processAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
};

/** PIDs still carrying this run's isolated profile path (leaked descendants included). */
const liveLayerPids = (needle) => {
  const escaped = String(needle).replace(/'/gu, "''");
  // Query failure must fail the evidence check; it cannot mean "no survivors". Exclude the
  // query itself, whose command line also contains the needle.
  const text = powershell(
    `$rows = Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains('${escaped}') }; @($rows | Select-Object ProcessId,Name) | ConvertTo-Json -Compress`,
  );
  const parsed = JSON.parse(text === '' ? '[]' : text);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.map((row) => Number(row?.ProcessId)).filter((id) => Number.isInteger(id) && id > 0);
};

/** Minimal stand-in for the DSH context: enough for apply() to mount and register routes. */
function makeContext() {
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
  return {
    ctx,
    routes,
    dispose: () => {
      for (const entry of disposers.reverse()) {
        try {
          if (typeof entry === 'function') entry();
          else entry?.dispose?.();
        } catch {
          /* teardown is best-effort */
        }
      }
    },
  };
}

async function callRoute(routes, path, body) {
  const handler = routes.get(path);
  if (handler === undefined) throw new Error(`route not registered: ${path}`);
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  req.method = body === undefined ? 'GET' : 'POST';
  const res = {
    statusCode: 0,
    body: '',
    writeHead(code) {
      this.statusCode = code;
    },
    end(text) {
      this.body = String(text ?? '');
    },
  };
  await handler(req, res);
  return JSON.parse(res.body);
}

// ---------------------------------------------------------------------------------------------
// 1-2. Launcher validation, with no display process involved at all.
// ---------------------------------------------------------------------------------------------
const scratch = mkdtempSync(join(tmpdir(), 'spout-layer-check-'));
const validationRoot = join(scratch, 'root');
const validation = new SpoutLayer({ root: validationRoot, settings: () => ({ electronExecutable: '' }) });

const unset = await validation.validate('');
check('unset launcher is rejected', unset.code === 'ELECTRON_EXE_UNSET', unset);

const missing = await validation.validate(join(scratch, 'nope', 'electron.exe'));
check('missing file is rejected', missing.code === 'ELECTRON_EXE_INVALID', missing);

const relative = await validation.validate('electron.exe');
check('relative path is rejected', relative.code === 'ELECTRON_EXE_INVALID', relative);

const self = await validation.validate(process.execPath);
check('DSH/self executable is rejected', self.code === 'ELECTRON_EXE_INVALID', self);

// A real executable with the wrong Electron major: node.exe pretending to be electron.exe.
const fakeDir = join(scratch, 'fake-electron');
const fakeExe = join(fakeDir, 'electron.exe');
mkdirSync(fakeDir, { recursive: true });
copyFileSync(process.execPath, fakeExe);
writeFileSync(join(fakeDir, 'chrome_100_percent.pak'), '');
const mismatch = await validation.validate(fakeExe);
check(
  'wrong Electron major is rejected',
  mismatch.code === 'ELECTRON_VERSION_MISMATCH',
  { code: mismatch.code, message: mismatch.message },
);

const bareRuntime = join(scratch, 'bare-runtime.exe');
copyFileSync(process.execPath, bareRuntime);
const notElectron = await validation.validate(bareRuntime);
check('non-Electron binary is rejected', notElectron.code === 'ELECTRON_EXE_INVALID', {
  code: notElectron.code,
  message: notElectron.message,
});

check('electron runtime present for the live runs', existsSync(electronPath), electronPath);
const pinnedOk = await validation.validate(electronPath);
check('configured Electron 44 passes validation', pinnedOk.ok === true && pinnedOk.version.startsWith(`${PINNED_ELECTRON_MAJOR}.`), pinnedOk);

// ---------------------------------------------------------------------------------------------
// 3-4. Real start/stop through the host action route.
// ---------------------------------------------------------------------------------------------
const mountRoot = join(scratch, 'plugin-root');
const mounted = makeContext();
apply(mounted.ctx, { root: mountRoot, defaultDomain: 'chat', enabled: true });

const unsetStart = await callRoute(mounted.routes, '/assistant/action', { action: 'spoutLayer.start' });
check('start without a launcher returns ELECTRON_EXE_UNSET', unsetStart.ok === false && unsetStart.code === 'ELECTRON_EXE_UNSET', {
  ok: unsetStart.ok,
  code: unsetStart.code,
  error: unsetStart.error,
  pid: unsetStart.pid,
});
await sleep(300);
check('unset launcher spawns nothing', unsetStart.lastPid === 0 && unsetStart.running === false, {
  pid: unsetStart.pid, lastPid: unsetStart.lastPid,
});

const started = await callRoute(mounted.routes, '/assistant/action', {
  action: 'spoutLayer.start',
  electronExecutable: electronPath,
});
check('start with a valid launcher succeeds', started.ok === true && started.pid > 0, {
  ok: started.ok,
  pid: started.pid,
  phase: started.readyPhase,
  created: started.created,
  lastPid: started.lastPid,
  code: started.code,
  lastExit: started.lastExit,
  error: started.error,
  diagnostics: started.diagnostics,
});
check(
  'start records the receiver timeout and a diagnostics log',
  started.receiverTimeoutMs === 5000 && typeof started.diagnostics === 'string' && existsSync(started.diagnostics),
  { receiverTimeoutMs: started.receiverTimeoutMs, diagnostics: started.diagnostics },
);

// The snapshot the status route exposes is the source of truth the UI reads.
let status = null;
let phaseReached = '';
const deadline = Date.now() + 45_000;
while (Date.now() < deadline) {
  status = await callRoute(mounted.routes, '/assistant/status');
  phaseReached = status?.live2d?.spoutLayer?.readyPhase ?? '';
  if (phaseReached === 'receiver' || phaseReached === 'waiting-sender') break;
  if (phaseReached === 'failed') break;
  await sleep(250);
}
const snapshot = status?.live2d?.spoutLayer ?? {};
check(
  'status reaches a registered receiver phase (receiver, or waiting-sender without VTS)',
  (phaseReached === 'receiver' || phaseReached === 'waiting-sender')
    && snapshot?.receiver?.registered === true,
  {
    phase: phaseReached,
    pid: snapshot.pid,
    receiver: snapshot.receiver,
    error: snapshot.error,
  },
);
check(
  'receiver registration reports the configured sender (default VTubeStudioSpout)',
  snapshot?.receiver?.sender === 'VTubeStudioSpout',
  snapshot?.receiver ?? null,
);
check(
  'ready(receiver) includes the native surface descriptor',
  snapshot?.receiver?.surface !== null
    && typeof snapshot?.receiver?.surface === 'object'
    && snapshot.receiver.surface.platform === 'spout',
  snapshot?.receiver?.surface ?? null,
);
check(
  "the renderer registered Electron's shared-texture receiver before reporting ready",
  snapshot?.sharedTextureRegistered === true
    && Number.isFinite(Number(snapshot?.textureTimeouts))
    && Number.isFinite(Number(snapshot?.lastTextureSendMs)),
  {
    sharedTextureRegistered: snapshot?.sharedTextureRegistered,
    textureTimeouts: snapshot?.textureTimeouts,
    lastTextureSendMs: snapshot?.lastTextureSendMs,
    texturePush: snapshot?.texturePush,
  },
);
check(
  'the control report carries bridge version + the actual .node path',
  snapshot?.versions?.bridge === '0.17.0'
    && String(snapshot?.versions?.bridgeNative ?? '').endsWith('.node')
    && snapshot?.versions?.bridgePlatform === 'spout'
    && snapshot?.versions?.bridgeError === '',
  {
    bridge: snapshot?.versions?.bridge,
    native: snapshot?.versions?.bridgeNative,
    nativeFiles: snapshot?.versions?.bridgeNativeFiles,
    platform: snapshot?.versions?.bridgePlatform,
    senders: snapshot?.versions?.bridgeSenders,
    error: snapshot?.versions?.bridgeError,
  },
);
check(
  'window falls back to a centred 520×800 and reports boundsSource=fallback',
  snapshot?.boundsSource === 'fallback'
    && Number(snapshot?.display?.bounds?.width ?? 0) === 520
    && Number(snapshot?.display?.bounds?.height ?? 0) === 800,
  { boundsSource: snapshot?.boundsSource, display: snapshot?.display, windowBounds: snapshot?.windowBounds },
);
if (phaseReached === 'receiver') {
  check('the actual time to receiver is recorded', Number(snapshot?.receiverMs ?? 0) > 0, {
    receiverMs: snapshot?.receiverMs,
    timeoutMs: snapshot?.receiverTimeoutMs,
  });
} else {
  check('waiting-sender keeps the process alive instead of crashing', snapshot?.running === true, {
    running: snapshot?.running,
    pid: snapshot.pid,
  });
}

const windowProbe = JSON.parse(
  powershell(
    `$p = Get-Process -Id ${started.pid} -ErrorAction SilentlyContinue; if ($p) { [pscustomobject]@{ handle = $p.MainWindowHandle.ToInt64(); title = $p.MainWindowTitle } | ConvertTo-Json -Compress } else { '{"handle":0,"title":""}' }`,
  ),
);
check(
  'display process is alive with a visible window',
  windowProbe.handle > 0 && /Spout layer/u.test(windowProbe.title),
  windowProbe,
);

const stopPids = [...new Set([started.pid, ...liveLayerPids(mountRoot)])];
const stopBegin = Date.now();
const stopped = await callRoute(mounted.routes, '/assistant/action', { action: 'spoutLayer.stop' });
const stopWallMs = Date.now() - stopBegin;
// Old assertion: `killed === false`, i.e. the child always exits on stdin EOF within the grace.
// Evidence (diagnostics `[stop] how=timeout`): a transparent Electron window with the shared
// texture receiver can take >6 s to tear down on a loaded machine, so the documented 3 s kill
// fallback is a legitimate outcome. What must hold is: the stop succeeds (the root is confirmed
// gone) and reports which path it took.
check(
  'stop succeeds and reports the path it took (stdin EOF or 3 s kill fallback)',
  stopped.ok === true && stopped.stopped === true,
  { ok: stopped.ok, stopped: stopped.stopped, how: stopped.how, killed: stopped.killed, elapsedMs: stopped.elapsedMs, error: stopped.error },
);
// Every phase spends the same deadline. A 20 s assertion would hide regressions against the
// Host's 5 s exit budget. Allow only scheduler/route bookkeeping above the controller's budget.
check(
  'stop and its force fallback share the configured deadline',
  stopWallMs <= DEFAULT_STOP_DEADLINE_MS + 500 && stopped.hostTeardownFinished === true,
  { stopWallMs, how: stopped.how, killed: stopped.killed, elapsedMs: stopped.elapsedMs },
);
await sleep(400);
check('process tree is gone after stop', processAlive(started.pid) === false, { pid: started.pid });
const afterStop = liveLayerPids(mountRoot);
check('no process belonging to this stopped layer remains',
  afterStop.length === 0 && stopPids.every((id) => !processAlive(id)),
  { afterStop, capturedAlive: stopPids.filter(processAlive) });

let diagnosticsText = readFileSync(started.diagnostics, 'utf8');
check(
  'diagnostics keep the raw receiver/registration line and its elapsed time',
  /\[ready\] phase=(?:receiver|waiting-sender)/u.test(diagnosticsText)
    && /\[stdout\] .*"registered":true/u.test(diagnosticsText)
    && /\[stdout\] .*"elapsedMs":\d+/u.test(diagnosticsText),
  { diagnostics: started.diagnostics, excerpt: diagnosticsText.split(/\r?\n/u).filter((line) => line.includes('"registered"')).slice(0, 2) },
);
check(
  'diagnostics record the shared-texture registration and its counters',
  /\[stdout\] .*"sharedTextureRegistered":true/u.test(diagnosticsText)
    && /\[texture\] registered=true timeouts=\d+ lastSendMs=\d+/u.test(diagnosticsText),
  {
    textureLines: diagnosticsText.split(/\r?\n/u).filter((line) => line.includes('sharedTextureRegistered') || line.startsWith('[texture]')).slice(0, 4),
  },
);
// Windows can report an Electron GUI process gone to the liveness check before — or without —
// delivering the Node `exit` event. Either the OS exit line or a `confirmed=true` stop is real
// termination evidence; poll instead of asserting an event this runtime may never deliver.
let terminationEvidence = '';
const evidenceDeadline = Date.now() + 20_000;
for (;;) {
  const lines = diagnosticsText.split(/\r?\n/u);
  const exitLine = lines.find((line) => /^\[exit\] code=(?:0|1)/u.test(line));
  const stopLine = lines.find((line) => /^\[stop\] .*confirmed=true/u.test(line));
  terminationEvidence = exitLine ?? stopLine ?? '';
  if (terminationEvidence !== '' || Date.now() >= evidenceDeadline) break;
  await sleep(200);
  diagnosticsText = readFileSync(started.diagnostics, 'utf8');
}
check(
  'diagnostics keep the termination evidence and the full stderr',
  terminationEvidence !== '' && /\[stderr\]/u.test(diagnosticsText),
  {
    evidence: terminationEvidence,
    exitLine: diagnosticsText.split(/\r?\n/u).find((line) => line.startsWith('[exit]')) ?? '',
  },
);

// ---------------------------------------------------------------------------------------------
// 3b. Host route geometry: settings.layerGeometry (the existing WPF rectangle) must reach the
//     spawned layer as `--dsh-bounds`, not the centred 520×800 fallback.
// ---------------------------------------------------------------------------------------------
const geometryRoot = join(scratch, 'geometry-root');
const layerGeometry = { left: 140, top: 100, width: 600, height: 760 };
mkdirSync(join(geometryRoot, 'data'), { recursive: true });
writeFileSync(
  join(geometryRoot, 'data', 'settings.json'),
  JSON.stringify({
    layerGeometry,
    spoutLayer: {
      electronExecutable: electronPath,
      sender: `DSH Geometry ${Date.now()}`,
      senderTimeoutMs: 3000,
      receiverTimeoutMs: 8000,
    },
  }, null, 2),
);
const geometryMounted = makeContext();
apply(geometryMounted.ctx, { root: geometryRoot, defaultDomain: 'chat', enabled: true });
const geometryStarted = await callRoute(geometryMounted.routes, '/assistant/action', { action: 'spoutLayer.start' });
check(
  'the host route reuses settings.layerGeometry as the initial bounds',
  geometryStarted.ok === true
    && geometryStarted.boundsSource === 'argument'
    && geometryStarted.bounds?.left === layerGeometry.left
    && geometryStarted.bounds?.top === layerGeometry.top
    && geometryStarted.bounds?.width === layerGeometry.width
    && geometryStarted.bounds?.height === layerGeometry.height,
  {
    ok: geometryStarted.ok,
    bounds: geometryStarted.bounds,
    boundsSource: geometryStarted.boundsSource,
    layerGeometry,
  },
);
const geometryArgs = readFileSync(geometryStarted.diagnostics, 'utf8')
  .split(/\r?\n/u)
  .find((line) => line.startsWith('args=')) ?? '';
check(
  'the layer is spawned with --dsh-bounds equal to the layer geometry',
  geometryArgs.includes(`--dsh-bounds=${layerGeometry.left},${layerGeometry.top},${layerGeometry.width},${layerGeometry.height}`),
  { args: geometryArgs },
);
await sleep(1500);
let geometryRect = windowRect(geometryStarted.pid);
const geometryRectDeadline = Date.now() + 45_000;
while ((geometryRect.handle ?? 0) === 0 && Date.now() < geometryRectDeadline) {
  await sleep(200);
  geometryRect = windowRect(geometryStarted.pid);
}
check(
  'the real window rectangle equals settings.layerGeometry',
  geometryRect.left === layerGeometry.left
    && geometryRect.top === layerGeometry.top
    && geometryRect.width === layerGeometry.width
    && geometryRect.height === layerGeometry.height,
  { requested: layerGeometry, actual: geometryRect },
);
const geometryStop = await callRoute(geometryMounted.routes, '/assistant/action', { action: 'spoutLayer.stop' });
check(
  'the geometry layer stops cleanly',
  geometryStop.ok === true && processAlive(geometryStarted.pid) === false,
  { ok: geometryStop.ok, how: geometryStop.how, pid: geometryStarted.pid },
);
geometryMounted.dispose();

// ---------------------------------------------------------------------------------------------
// 4a. Geometry + native receiver registration *without* VTS. A missing sender must still register
//     the receiver (`registered:true`), enter waiting-sender, keep the window alive, and only then
//     report SENDER_NOT_FOUND. The OS window rectangle must equal the host-supplied bounds.
// ---------------------------------------------------------------------------------------------
const boundsRoot = join(scratch, 'bounds-root');
const requestedBounds = { left: 180, top: 120, width: 640, height: 480 };
const missingSender = `DSH Missing Sender ${Date.now()}`;
const bounded = new SpoutLayer({
  root: boundsRoot,
  settings: () => ({
    electronExecutable: electronPath,
    sender: missingSender,
    senderTimeoutMs: 3000,
    receiverTimeoutMs: 8000,
    bounds: requestedBounds,
  }),
});
const boundedStart = await bounded.start();
check('start with host-supplied bounds succeeds', boundedStart.ok === true && boundedStart.pid > 0, {
  ok: boundedStart.ok,
  pid: boundedStart.pid,
  bounds: boundedStart.bounds,
  boundsSource: boundedStart.boundsSource,
});

const waitSnapshot = async (layer, predicate, timeoutMs) => {
  const end = Date.now() + timeoutMs;
  let last = layer.snapshot();
  while (Date.now() < end) {
    last = layer.snapshot();
    if (predicate(last)) return last;
    await sleep(100);
  }
  return last;
};

const waiting = await waitSnapshot(
  bounded,
  (snap) => snap.readyPhase === 'waiting-sender' || snap.readyPhase === 'failed',
  45_000,
);
check(
  'missing sender registers the receiver and enters waiting-sender without crashing',
  waiting.readyPhase === 'waiting-sender'
    && waiting.receiver?.registered === true
    && waiting.receiver?.connected === false
    && waiting.receiver?.sender === missingSender
    && waiting.running === true,
  {
    phase: waiting.readyPhase,
    receiver: waiting.receiver,
    running: waiting.running,
    error: waiting.error,
  },
);
const boundedRect = windowRect(boundedStart.pid);
check(
  'GetWindowRect equals the requested bounds before sender timeout',
  boundedRect.left === requestedBounds.left
    && boundedRect.top === requestedBounds.top
    && boundedRect.width === requestedBounds.width
    && boundedRect.height === requestedBounds.height,
  { requested: requestedBounds, actual: boundedRect },
);
check(
  'the control report carries the requested rectangle and boundsSource=argument',
  waiting.windowBounds?.requested?.left === requestedBounds.left
    && waiting.windowBounds?.bounds?.width === requestedBounds.width
    && waiting.boundsSource === 'argument',
  { windowBounds: waiting.windowBounds, boundsSource: waiting.boundsSource },
);

const senderTimeout = await waitSnapshot(
  bounded,
  (snap) => snap.error?.code === 'SENDER_NOT_FOUND',
  10_000,
);
check(
  'the missing sender times out as SENDER_NOT_FOUND while the window stays alive',
  senderTimeout.error?.code === 'SENDER_NOT_FOUND'
    && senderTimeout.running === true
    && processAlive(boundedStart.pid) === true,
  { error: senderTimeout.error, running: senderTimeout.running, pid: boundedStart.pid },
);
const boundedRectAfter = windowRect(boundedStart.pid);
check(
  'the window rectangle is unchanged after the sender timeout',
  boundedRectAfter.left === requestedBounds.left
    && boundedRectAfter.top === requestedBounds.top
    && boundedRectAfter.width === requestedBounds.width
    && boundedRectAfter.height === requestedBounds.height,
  { requested: requestedBounds, actual: boundedRectAfter },
);

const boundedStop = await bounded.stop();
check(
  'waiting-sender layer stops through the stdin path',
  boundedStop.ok === true && boundedStop.killed === false && processAlive(boundedStart.pid) === false,
  { how: boundedStop.how, killed: boundedStop.killed, pid: boundedStart.pid },
);

// ---------------------------------------------------------------------------------------------
// 4a-2. Shared-texture negative path: a frame sent *before* the renderer registered
//     `setSharedTextureReceiver` must reject with Electron's 1000 ms timeout, be counted in
//     textureTimeouts, and leave the layer alive. The selftest runs before the page loads, so the
//     target renderer provably has no receiver.
// ---------------------------------------------------------------------------------------------
const textureRoot = join(scratch, 'texture-selftest-root');
const textureLayer = new SpoutLayer({
  root: textureRoot,
  settings: () => ({
    electronExecutable: electronPath,
    sender: `DSH Texture ${Date.now()}`,
    senderTimeoutMs: 3000,
    receiverTimeoutMs: 8000,
    textureSelfTest: true,
  }),
});
const textureStart = await textureLayer.start();
check('the texture selftest layer starts', textureStart.ok === true && textureStart.pid > 0, {
  ok: textureStart.ok,
  pid: textureStart.pid,
  args: textureStart.boundsSource,
});
const textureSnapshot = await waitSnapshot(
  textureLayer,
  (snap) => snap.readyPhase === 'waiting-sender' || snap.readyPhase === 'receiver' || snap.readyPhase === 'failed',
  60_000,
);
check(
  'a send before receiver registration times out after 1000ms and is counted, not fatal',
  textureSnapshot.readyPhase !== 'failed'
    && textureSnapshot.textureTimeouts >= 1
    && textureSnapshot.lastTextureSendMs >= 900
    && textureSnapshot.lastTextureSendMs < 4000,
  {
    phase: textureSnapshot.readyPhase,
    textureTimeouts: textureSnapshot.textureTimeouts,
    lastTextureSendMs: textureSnapshot.lastTextureSendMs,
    error: textureSnapshot.error,
  },
);
const textureDiagnostics = readFileSync(textureStart.diagnostics, 'utf8');
check(
  'the 1000ms timeout is recorded in the diagnostics log',
  /timed out after 1000ms/u.test(textureDiagnostics)
    && /"textureTimeouts":1/u.test(textureDiagnostics),
  {
    lines: textureDiagnostics.split(/\r?\n/u).filter((line) => line.includes('timed out after 1000ms') || line.includes('textureTimeouts')).slice(0, 4),
  },
);
const textureStop = await textureLayer.stop();
check('the texture selftest layer stops cleanly', textureStop.ok === true && processAlive(textureStart.pid) === false, {
  ok: textureStop.ok,
  how: textureStop.how,
  pid: textureStart.pid,
});

// ---------------------------------------------------------------------------------------------
// 4b. Non-pipe stdin (stdio: 'ignore') must still start and reach receiver. This is the failure
//     mode that produced "waiting for ready(receiver) failed, final state stopped": fd 0 reads
//     0 bytes immediately, the old watcher treated that as host death and quit while the page
//     was still loading. A launcher without a stdin pipe must not be mistaken for a dead host.
// ---------------------------------------------------------------------------------------------
const noPipeRoot = join(scratch, 'nopipe-root');
const noPipeKey = `root=${noPipeRoot};instance=nopipe;gen=1`;
const vtsWasRunning = vtsRunning();
const noPipe = spawn(
  electronPath,
  [
    '--force-device-scale-factor=1',
    `--user-data-dir=${join(noPipeRoot, 'user-data')}`,
    // A cold GPU on a loaded machine can take longer than the production 5 s default to reach
    // the receiver; this test is about stdin lifetime, not the watchdog budget.
    '--dsh-receiver-timeout-ms=20000',
    '--dsh-sender-timeout-ms=30000',
    '--dsh-sender=VTubeStudioSpout',
    `--dsh-layer-key=${noPipeKey}`,
    layerMain,
  ],
  {
    cwd: mkdtempSync(join(tmpdir(), 'spout-nopipe-')),
    env: (() => {
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      delete env.NODE_OPTIONS;
      return env;
    })(),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
const noPipePhases = [];
let noPipeBuffer = '';
let noPipeStderr = '';
noPipe.stdout.setEncoding('utf8');
noPipe.stdout.on('data', (chunk) => {
  noPipeBuffer += chunk;
  let at = noPipeBuffer.indexOf('\n');
  while (at !== -1) {
    const line = noPipeBuffer.slice(0, at).trim();
    noPipeBuffer = noPipeBuffer.slice(at + 1);
    if (line.length > 0) {
      try {
        const payload = JSON.parse(line);
        if (payload.type === 'ready') noPipePhases.push(payload.phase);
      } catch {
        /* diagnostic line */
      }
    }
    at = noPipeBuffer.indexOf('\n');
  }
});
noPipe.stderr.setEncoding('utf8');
noPipe.stderr.on('data', (chunk) => {
  noPipeStderr += chunk;
});
const noPipeExited = new Promise((done) => noPipe.once('exit', (code, signal) => done({ code, signal })));
const noPipeDeadline = Date.now() + 45_000;
while (Date.now() < noPipeDeadline && noPipePhases.length < 2 && noPipe.exitCode === null) await sleep(100);
const noPipeAlive = processAlive(noPipe.pid);
const noPipeWindowProbe = noPipeAlive
  ? JSON.parse(
      powershell(
        `$p = Get-Process -Id ${noPipe.pid} -ErrorAction SilentlyContinue; if ($p) { [pscustomobject]@{ handle = $p.MainWindowHandle.ToInt64(); title = $p.MainWindowTitle } | ConvertTo-Json -Compress } else { '{"handle":0,"title":""}' }`,
      ),
    )
  : { handle: 0, title: '' };
try {
  execFileSync('taskkill', ['/PID', String(noPipe.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
} catch {
  /* already exited */
}
await Promise.race([noPipeExited, sleep(3000)]);
check(
  'a layer without a stdin pipe reaches control + a registered receiver phase',
  noPipePhases.includes('control')
    && (noPipePhases.includes('receiver') || noPipePhases.includes('waiting-sender')),
  { readyPhases: noPipePhases, alive: noPipeAlive, stderr: noPipeStderr.slice(0, 300) },
);
check(
  'a non-pipe layer reaches receiver when the default sender is available',
  vtsWasRunning === false || noPipePhases.includes('receiver'),
  { vtsWasRunning, readyPhases: noPipePhases },
);
check(
  'a layer without a stdin pipe shows its window instead of quitting at boot',
  noPipeAlive === true && noPipeWindowProbe.handle > 0,
  noPipeWindowProbe,
);

// ---------------------------------------------------------------------------------------------
// 5. stdin EOF self-exit (what happens when the host is killed outright).
// ---------------------------------------------------------------------------------------------
const eofRoot = join(scratch, 'eof-root');
const eofKey = `root=${eofRoot};instance=eof;gen=1`;
const child = spawn(
  electronPath,
  [
    '--force-device-scale-factor=1',
    `--user-data-dir=${join(eofRoot, 'user-data')}`,
    '--dsh-receiver-timeout-ms=20000',
    '--dsh-sender-timeout-ms=30000',
    '--dsh-sender=VTubeStudioSpout',
    `--dsh-layer-key=${eofKey}`,
    layerMain,
  ],
  {
    cwd: mkdtempSync(join(tmpdir(), 'spout-eof-')),
    env: (() => {
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      delete env.NODE_OPTIONS;
      return env;
    })(),
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  },
);

const lines = [];
let stdoutBuffer = '';
const readyPhases = [];
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  stdoutBuffer += chunk;
  let at = stdoutBuffer.indexOf('\n');
  while (at !== -1) {
    const line = stdoutBuffer.slice(0, at).trim();
    stdoutBuffer = stdoutBuffer.slice(at + 1);
    if (line.length > 0) {
      lines.push(line);
      try {
        const payload = JSON.parse(line);
        if (payload.type === 'ready') readyPhases.push(payload.phase);
      } catch {
        /* diagnostics are fine on stdout */
      }
    }
    at = stdoutBuffer.indexOf('\n');
  }
});
let stderrText = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => {
  stderrText += chunk;
});

const exited = new Promise((done) => child.once('exit', (code, signal) => done({ code, signal })));
const readyDeadline = Date.now() + 45_000;
while (Date.now() < readyDeadline && readyPhases.length < 2) await sleep(100);

check(
  'layer reports control + a registered receiver phase',
  readyPhases.includes('control')
    && (readyPhases.includes('receiver') || readyPhases.includes('waiting-sender')),
  { readyPhases, lineCount: lines.length, lastLines: lines.slice(-6), stderr: stderrText.slice(-300) },
);

// Pull the bridge evidence out of the control report before dropping the pipe.
const controlLine = lines
  .map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  })
  .find((payload) => payload?.type === 'ready' && payload.phase === 'control');
const bridgeNative = String(controlLine?.versions?.bridgeNative ?? '');
check(
  'the native bridge is actually loaded: version + real .node path, no MODULE_NOT_FOUND/ERR_DLOPEN_FAILED',
  controlLine?.versions?.bridge === '0.17.0'
    && bridgeNative.endsWith('.node')
    && existsSync(bridgeNative.replace(/^\\\\\?\\/u, ''))
    && controlLine?.versions?.bridgePlatform === 'spout'
    && controlLine?.versions?.bridgeError === '',
  {
    version: controlLine?.versions?.bridge ?? '',
    packagePath: controlLine?.versions?.bridgePath ?? '',
    native: bridgeNative,
    nativeFiles: controlLine?.versions?.bridgeNativeFiles ?? [],
    platform: controlLine?.versions?.bridgePlatform ?? '',
    senders: controlLine?.versions?.bridgeSenders ?? [],
    error: controlLine?.versions?.bridgeError ?? '',
  },
);

const eofPid = child.pid;
const eofAt = Date.now();
const eofStdoutStart = lines.length;
child.stdin.end();
// Evidence: on this machine a bare Electron 44.7.0 app (no window at all) takes ~6.5 s from
// `process.exit()` to actual process termination, and the full layer observed ~12.7 s; the
// original 5 s budget was measuring the runtime's teardown, not our stdin watcher. The watcher
// fires at once (the `exit` line is on stdout). The host additionally force-kills a layer that
// outlives the 3 s grace, so a slow teardown never blocks the user's stop.
const eofExit = await Promise.race([exited, sleep(20_000).then(() => ({ timeout: true }))]);
const eofMs = Date.now() - eofAt;
// Let the pipe flush before judging: `exit` can fire before the last stdout data event.
await sleep(300);
const EOF_STAGES = ['received', 'receiver-clean', 'app.exit', 'main-exit', 'child-exit'];
const eofSeen = new Set();
for (const line of lines.slice(eofStdoutStart)) {
  let payload = null;
  try {
    payload = JSON.parse(line);
  } catch {
    continue;
  }
  if (payload?.type === 'shutdown-ack') eofSeen.add('received');
  if (payload?.type === 'shutdown-stage') {
    const stage = String(payload.stage ?? '');
    if (stage === 'receiver-cleanup-start' || stage === 'receiver-cleanup-done') eofSeen.add('receiver-clean');
    else if (stage === 'app-exit') eofSeen.add('app.exit');
    else if (stage === 'main-exit') eofSeen.add('main-exit');
  }
}
if (eofExit?.timeout !== true) eofSeen.add('child-exit');
const eofLastStage = [...EOF_STAGES].reverse().find((stage) => eofSeen.has(stage)) ?? 'none';
const eofAlivePids = liveLayerPids(eofRoot);
// Failure diagnostics: the raw stdout after EOF, the last shutdown stage that was reached and the
// PIDs that are actually still alive locate where the child got stuck.
const eofDiagnostics = {
  lastStage: eofLastStage,
  stagesSeen: [...eofSeen],
  stdoutAfterEof: [
    ...lines.slice(eofStdoutStart),
    ...(stdoutBuffer.length > 0 ? [`<partial>${stdoutBuffer}`] : []),
  ],
  alivePids: eofAlivePids.length > 0 ? eofAlivePids : (processAlive(eofPid) ? [eofPid] : []),
  stderr: stderrText.slice(-400),
};
check('stdin EOF makes the child exit on its own', eofExit?.timeout !== true, {
  ...eofExit,
  eofMs,
  ...eofDiagnostics,
});
check('child is gone after stdin EOF', processAlive(eofPid) === false, {
  pid: eofPid,
  lastStage: eofDiagnostics.lastStage,
  alivePids: eofDiagnostics.alivePids,
});

// ---------------------------------------------------------------------------------------------
// 5b. A bridge that cannot load must fail loudly. Module id is overridable so the asar-unpacked
//     deployment shape can be tested too; a missing module must surface the original
//     MODULE_NOT_FOUND text as BRIDGE_LOAD_FAILED, not a silent window with no receiver.
// ---------------------------------------------------------------------------------------------
const badRoot = join(scratch, 'bad-bridge-root');
const badChild = spawn(
  electronPath,
  [
    '--force-device-scale-factor=1',
    `--user-data-dir=${join(badRoot, 'user-data')}`,
    `--dsh-bridge-module=${join(scratch, 'definitely-missing-texture-bridge.js')}`,
    '--dsh-sender=VTubeStudioSpout',
    '--dsh-layer-key=root=bad;instance=bad;gen=1',
    layerMain,
  ],
  {
    cwd: mkdtempSync(join(tmpdir(), 'spout-bad-bridge-')),
    env: (() => {
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      delete env.NODE_OPTIONS;
      return env;
    })(),
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  },
);
let badOut = '';
badChild.stdout.setEncoding('utf8');
badChild.stdout.on('data', (chunk) => {
  badOut += chunk;
});
let badErr = '';
badChild.stderr.setEncoding('utf8');
badChild.stderr.on('data', (chunk) => {
  badErr += chunk;
});
const badExit = new Promise((done) => badChild.once('exit', (code, signal) => done({ code, signal })));
let badErrorLine = null;
for (let attempt = 0; attempt < 300 && badErrorLine === null; attempt += 1) {
  for (const line of badOut.split(/\r?\n/u)) {
    try {
      const payload = JSON.parse(line);
      if (payload?.type === 'error') badErrorLine = payload;
    } catch {
      /* partial line */
    }
  }
  if (badErrorLine === null) await sleep(100);
}
check(
  'an unloadable bridge reports BRIDGE_LOAD_FAILED with the original MODULE_NOT_FOUND text',
  badErrorLine?.code === 'BRIDGE_LOAD_FAILED'
    && /MODULE_NOT_FOUND/u.test(String(badErrorLine?.message ?? '')),
  { error: badErrorLine, stderr: badErr.slice(0, 200) },
);
await Promise.race([badExit, sleep(4000)]);
try {
  badChild.kill();
} catch {
  /* already exited */
}
check('a bridge-load failure exits instead of showing a dead window', processAlive(badChild.pid) === false, {
  pid: badChild.pid,
  error: badErrorLine,
});

// A layer that ignores stdin must be killed after the grace, and only because it is ours.
const stubDir = join(scratch, 'stub-layer');
mkdirSync(stubDir, { recursive: true });
writeFileSync(join(stubDir, 'main.js'), 'setInterval(() => {}, 1000);\n');
const stub = new SpoutLayer({
  root: join(scratch, 'stub-root'),
  settings: () => ({ electronExecutable: electronPath }),
  mainPath: join(stubDir, 'main.js'),
});
const stubStart = await stub.start();
const stubPid = stubStart.pid;
const stubBegin = Date.now();
const stubStop = await stub.stop();
const stubMs = Date.now() - stubBegin;
check('a layer ignoring stdin is killed after the grace', stubStop.killed === true && stubMs >= 2500, {
  pid: stubPid,
  how: stubStop.how,
  killed: stubStop.killed,
  stubMs,
});
await sleep(300);
check('killed stub process is gone', processAlive(stubPid) === false, { pid: stubPid });

// ---------------------------------------------------------------------------------------------
// 6. Attribution sweep: a PID with a mismatched creation time must survive.
// ---------------------------------------------------------------------------------------------
const sweepRoot = join(scratch, 'sweep-root');
const sweep = new SpoutLayer({ root: sweepRoot, settings: () => ({ electronExecutable: electronPath }) });
const sessionDir = join(sweepRoot, 'cache', 'spout-layer');
mkdirSync(sessionDir, { recursive: true });
const instance = createHash('sha1').update(String(sweepRoot)).digest('hex').slice(0, 8);

const dummy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
await sleep(500);
const dummyCreated = powershell(
  `try { [System.Diagnostics.Process]::GetProcessById(${dummy.pid}).StartTime.ToUniversalTime().ToString('o') } catch { '' }`,
);

// Negative: same PID, creation time offset by five minutes → not ours, must not be killed.
writeFileSync(
  join(sessionDir, 'session.json'),
  JSON.stringify({
    root: sweepRoot,
    instance,
    gen: 3,
    pid: dummy.pid,
    created: new Date(Date.parse(dummyCreated) - 5 * 60_000).toISOString(),
  }, null, 2),
);
const refused = await sweep.cleanupStale();
check('mismatched creation time is not killed', refused.killed === false && refused.code === 'ORPHAN_UNVERIFIED', refused);
await sleep(300);
check('unverified process is still alive', processAlive(dummy.pid) === true, { pid: dummy.pid });

// Positive: same PID and the recorded creation time → attributed and killed.
writeFileSync(
  join(sessionDir, 'session.json'),
  JSON.stringify({ root: sweepRoot, instance, gen: 4, pid: dummy.pid, created: dummyCreated }, null, 2),
);
const killed = await sweep.cleanupStale();
check('attributed session is cleaned up', killed.killed === true, killed);
await sleep(300);
check('attributed process is gone', processAlive(dummy.pid) === false, { pid: dummy.pid });

// A session belonging to another instance is never touched, even with a matching PID.
const foreign = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
await sleep(500);
const foreignCreated = powershell(
  `try { [System.Diagnostics.Process]::GetProcessById(${foreign.pid}).StartTime.ToUniversalTime().ToString('o') } catch { '' }`,
);
writeFileSync(
  join(sessionDir, 'session.json'),
  JSON.stringify({ root: sweepRoot, instance: 'deadbeef', gen: 5, pid: foreign.pid, created: foreignCreated }, null, 2),
);
const foreignSweep = await sweep.cleanupStale();
check('another instance root is not touched', foreignSweep.killed === false && processAlive(foreign.pid) === true, foreignSweep);
try {
  foreign.kill();
} catch {
  /* already gone */
}

mounted.dispose();
await sleep(200);
let finalPids = liveLayerPids(scratch);
const finalDeadline = Date.now() + 20_000;
while (finalPids.length > 0 && Date.now() < finalDeadline) {
  await sleep(100);
  finalPids = liveLayerPids(scratch);
}
check('host teardown leaves no display process belonging to this test', finalPids.length === 0, { finalPids });

const report = {
  electron: { path: electronPath, pinnedMajor: PINNED_ELECTRON_MAJOR },
  diagnostics: {
    file: started.diagnostics,
    lines: diagnosticsText.split(/\r?\n/u).length,
    receiverMs: snapshot.receiverMs,
    receiverTimeoutMs: snapshot.receiverTimeoutMs,
    sender: snapshot.sender,
    senderTimeoutMs: snapshot.senderTimeoutMs,
  },
  receiver: {
    routePhase: phaseReached,
    status: snapshot.receiver,
    waitingSender: waiting.receiver,
    senderTimeoutError: senderTimeout.error,
    vtsRunningAtNonPipeTest: vtsWasRunning,
  },
  bounds: {
    requested: requestedBounds,
    getWindowRect: boundedRect,
    getWindowRectAfterTimeout: boundedRectAfter,
    source: waiting.boundsSource,
    windowBounds: waiting.windowBounds,
    routeFallback: {
      boundsSource: snapshot.boundsSource,
      display: snapshot.display?.bounds ?? null,
    },
  },
  nonPipeStdin: { readyPhases: noPipePhases, alive: noPipeAlive, vtsWasRunning },
  eofSelfExit: {
    exit: eofExit,
    ms: eofMs,
    lastStage: eofDiagnostics.lastStage,
    stagesSeen: eofDiagnostics.stagesSeen,
    alivePids: eofDiagnostics.alivePids,
    stdoutAfterEof: eofDiagnostics.stdoutAfterEof.slice(-20),
  },
  stop: {
    how: stopped.how,
    killed: stopped.killed,
    elapsedMs: stopped.elapsedMs,
    wallMs: stopWallMs,
    stages: stopped.stages,
  },
  bridge: {
    version: controlLine?.versions?.bridge ?? '',
    packagePath: controlLine?.versions?.bridgePath ?? '',
    native: controlLine?.versions?.bridgeNative ?? '',
    nativeFiles: controlLine?.versions?.bridgeNativeFiles ?? [],
    platform: controlLine?.versions?.bridgePlatform ?? '',
    senders: controlLine?.versions?.bridgeSenders ?? [],
    error: controlLine?.versions?.bridgeError ?? '',
    loadFailure: badErrorLine,
  },
  readyLineSample: {
    control: controlLine?.phase ?? '',
    receiver: lines.map((line) => { try { return JSON.parse(line); } catch { return null; } }).find((p) => p?.phase === 'receiver') ?? null,
    waitingSender: lines.map((line) => { try { return JSON.parse(line); } catch { return null; } }).find((p) => p?.phase === 'waiting-sender') ?? null,
  },
  statusSnapshot: snapshot,
  steps,
};
console.log(JSON.stringify(report, null, 2));
console.log('\nSPOUT LAYER ACCEPTANCE PASSED');
