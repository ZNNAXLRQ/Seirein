/**
 * Vision: two paths, one interface.
 *
 * 1. Storyboard (preferred): delegate frame capture and change-scoring to `dsh-see-now`
 *    (ffmpeg ddagrab/gdigrab → 12 fps raw pipe → 4–8 changed frames packed into one image).
 *    The heavy lifting and its tuned thresholds are theirs; we only keep the loop and the file.
 * 2. Snapshot (fallback): PowerShell + System.Drawing when ffmpeg is absent, so "look at the
 *    screen" still works on a bare machine.
 */
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Default freshness window for a perception result: anything older is no longer "now". */
export const OBSERVATION_TTL_MS = 30_000;

/**
 * Storyboard capture resolution.
 *
 * 800×450 was too small to read desktop text in a packed sheet. 1920×1200 is the trial default:
 * it is 75% of a 2560×1600 screen on each axis (16:10, so text stays sharp) while the packed sheet
 * and the per-frame rgb24 buffers stay well below native 2560×1600.
 */
export const STORYBOARD_DEFAULT_SIZE = Object.freeze({ width: 1920, height: 1200 });

/**
 * Bounds for caller/config supplied sizes. Below the minimum text turns to mush; above the
 * maximum every buffered frame and the composed sheet grow past what the analyzer can use.
 */
export const STORYBOARD_SIZE_BOUNDS = Object.freeze({
  minWidth: 1280,
  minHeight: 720,
  maxWidth: 2560,
  maxHeight: 1600,
});

/** Clamp one axis: unusable values fall back to the default, valid ones stay inside the bounds. */
function captureDimension(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

/**
 * Resolve a storyboard capture size. Both axes are clamped independently so an extreme config
 * can never make the raw frame buffers (or the packed sheet) unbounded; an override inside the
 * bounds is kept exactly as given.
 * @param {{width?: number|string, height?: number|string}} [size]
 * @returns {{width: number, height: number}}
 */
export function resolveStoryboardSize({ width, height } = {}) {
  return {
    width: captureDimension(
      width,
      STORYBOARD_DEFAULT_SIZE.width,
      STORYBOARD_SIZE_BOUNDS.minWidth,
      STORYBOARD_SIZE_BOUNDS.maxWidth,
    ),
    height: captureDimension(
      height,
      STORYBOARD_DEFAULT_SIZE.height,
      STORYBOARD_SIZE_BOUNDS.minHeight,
      STORYBOARD_SIZE_BOUNDS.maxHeight,
    ),
  };
}

/** Normalize a caller-supplied TTL; an unusable value falls back to the default window. */
function observationTtl(ttlMs) {
  const value = Number(ttlMs);
  return Number.isFinite(value) && value >= 0 ? value : OBSERVATION_TTL_MS;
}

/**
 * Pure freshness verdict for one observation timestamp.
 *
 * Reaching the TTL counts as expired (a 30 s window holds frames strictly younger than 30 s).
 * A wall clock that stepped backwards is clamped to zero age instead of producing a negative one;
 * a missing/unusable stamp is stale by construction because freshness cannot be proven.
 * @param {number} at - observation time (epoch ms)
 * @param {number} [now] - read time (epoch ms)
 * @param {number} [ttlMs] - configurable freshness window
 * @returns {{at: number|null, ageMs: number|null, stale: boolean}}
 */
export function freshnessOf(at, now = Date.now(), ttlMs = OBSERVATION_TTL_MS) {
  const stamp = Number(at);
  if (!Number.isFinite(stamp) || stamp <= 0) return { at: null, ageMs: null, stale: true };
  const current = Number(now);
  const ageMs = Number.isFinite(current) ? Math.max(0, current - stamp) : null;
  return { at: stamp, ageMs, stale: ageMs === null ? true : ageMs >= observationTtl(ttlMs) };
}

/**
 * Read a stored observation at `now`: keep its `at`, derive `ageMs`/`stale`, and attach a hint
 * the host can show or use to decide the result must be discarded instead of treated as current.
 *
 * `capturedAt` (when the pixels really left the capture device) wins over `at`; `at` stays as the
 * legacy field, so a sheet stamped at packing time can never pass as freshly captured.
 * @param {object} observation - a shot/utterance carrying `capturedAt` or `at`
 * @param {{now?: number, ttlMs?: number}} [options]
 */
export function readObservation(observation, { now = Date.now(), ttlMs = OBSERVATION_TTL_MS } = {}) {
  const value = observation ?? {};
  const captured = Number(value.capturedAt);
  const stored = Number.isFinite(captured) && captured > 0 ? captured : value.at;
  const freshness = freshnessOf(stored, now, ttlMs);
  const seconds = Math.round(observationTtl(ttlMs) / 1000);
  const hint = freshness.stale
    ? freshness.ageMs === null
      ? '这条观察没有可信的采集时间，不能当作当前事实'
      : `这条观察已过去 ${Math.round(freshness.ageMs / 1000)} 秒（阈值 ${seconds} 秒），可能已不是当前状态`
    : '';
  return { ...value, ...freshness, hint };
}

const CAPTURE_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;
$ErrorActionPreference = 'Stop';
Add-Type -Namespace Win32 -Name Dpi -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();';
[void][Win32.Dpi]::SetProcessDPIAware();
Add-Type -AssemblyName System.Windows.Forms;
Add-Type -AssemblyName System.Drawing;
$target = $env:ASSISTANT_SHOT_PATH;
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen;
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height;
$g = [System.Drawing.Graphics]::FromImage($bmp);
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size);
$bmp.Save($target, [System.Drawing.Imaging.ImageFormat]::Png);
$g.Dispose(); $bmp.Dispose();
Write-Output ("{0}x{1}" -f $b.Width, $b.Height);
`;

/**
 * Find ffmpeg the same way DSH Desktop and dsh-see-now do.
 * @param {string} root - assistant root (for a plugin-local copy)
 * @param {{ffmpegPath?: string}} config
 * @returns {string | null}
 */
export function resolveFfmpeg(root, config) {
  const candidates = [
    config?.ffmpegPath,
    process.env.DSH_FFMPEG_PATH,
    process.env.FFMPEG_PATH,
    join(root, 'bin', 'ffmpeg.exe'),
    join(homedir(), '.dsh', 'tools', 'ffmpeg', 'bin', 'ffmpeg.exe'),
    join(homedir(), '.dsh', 'bin', 'ffmpeg.exe'),
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0 && existsSync(candidate)) return candidate;
  }
  return null;
}

/** ffplay sits next to ffmpeg in the same build; null when only ffmpeg exists. */
export function resolveFfplay(root, config) {
  const ffmpeg = resolveFfmpeg(root, config);
  if (ffmpeg === null) return null;
  const candidate = ffmpeg.replace(/ffmpeg(\.exe)?$/u, (match, ext) => `ffplay${ext ?? ''}`);
  return existsSync(candidate) ? candidate : null;
}

/** Wait for execFile's close callback before deleting an aborted writer's output. */
function runCapture(command, args, { signal, ...options }) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let child;
    const cancel = () => {
      try { child?.kill('SIGKILL'); } catch { /* close/error still owns settlement */ }
    };
    child = execFile(command, args, options, (error, stdout, stderr) => {
      signal?.removeEventListener('abort', cancel);
      if (signal?.aborted) reject(signal.reason);
      else if (error) reject(new Error(String(stderr ?? '').trim() || error.message));
      else resolve(stdout);
    });
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}

/** Snapshot one PNG of every display (fallback path). */
export async function capture({ dir, signal }) {
  signal?.throwIfAborted();
  const at = Date.now();
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${randomUUID()}.png`);
  try {
    const output = await runCapture(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', CAPTURE_SCRIPT],
      {
        windowsHide: true,
        timeout: 15000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, ASSISTANT_SHOT_PATH: file },
        signal,
      },
    );
    const info = await stat(file);
    signal?.throwIfAborted();
    if (info.size === 0) throw new Error('screen capture produced an empty file');
    const [width, height] = String(output).trim().split('x').map((value) => Number.parseInt(value, 10));
    return { file, bytes: info.size, width: width || 0, height: height || 0, at };
  } catch (error) {
    await rm(file, { force: true });
    throw error;
  }
}

/** PNG stores width/height as big-endian u32 at bytes 16 and 20 of the IHDR chunk. */
function pngSize(buffer) {
  if (buffer.length < 24) return { width: 0, height: 0 };
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/**
 * Snapshot the desktop with ffmpeg: ddagrab (GPU desktop duplication) first, then gdigrab.
 * Watch mode uses this instead of OBS, matching the storyboard's capture path.
 * @param {{dir: string, ffmpegPath: string, timeoutMs?: number, signal?: AbortSignal}} options
 */
export async function captureDesktop({ dir, ffmpegPath, timeoutMs = 20000, signal }) {
  signal?.throwIfAborted();
  const at = Date.now();
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${randomUUID()}.png`);
  const attempts = [
    {
      engine: 'ddagrab',
      args: ['-f', 'lavfi', '-i', 'ddagrab=framerate=30:draw_mouse=0', '-vf', 'hwdownload,format=bgra'],
    },
    {
      engine: 'gdigrab',
      args: ['-f', 'gdigrab', '-framerate', '30', '-i', 'desktop'],
    },
  ];
  const errors = [];
  for (const attempt of attempts) {
    try {
      await runCapture(
        ffmpegPath,
        ['-hide_banner', '-v', 'error', '-nostdin', ...attempt.args, '-frames:v', '1', '-y', file],
        { windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024, signal },
      );
      const info = await stat(file);
      if (info.size === 0) throw new Error('empty frame');
      const { width, height } = pngSize(await readFile(file));
      signal?.throwIfAborted();
      return { file, bytes: info.size, width, height, engine: attempt.engine, at };
    } catch (error) {
      errors.push(`${attempt.engine}: ${error?.message ?? String(error)}`);
      await rm(file, { force: true });
      // Cancellation must never select gdigrab (or the host's PowerShell fallback).
      signal?.throwIfAborted();
    }
  }
  throw new Error(`桌面取帧失败（${errors.join('；')}）`);
}

/**
 * Snapshot one frame from a DirectShow device, used by scene mode to read OBS's
 * program output through the virtual camera instead of the physical desktop.
 * @param {{dir: string, ffmpegPath: string, device?: string}} options
 */
export async function captureDevice({ dir, ffmpegPath, device = 'OBS Virtual Camera', signal }) {
  signal?.throwIfAborted();
  const at = Date.now();
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${randomUUID()}.png`);
  const args = [
    '-hide_banner', '-v', 'error', '-nostdin',
    '-f', 'dshow', '-i', `video=${device}`,
    '-frames:v', '1', '-y', file,
  ];
  try {
    await runCapture(ffmpegPath, args, { windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024, signal });
    const info = await stat(file);
    if (info.size === 0) throw new Error(`「${device}」没有产生画面`);
    const { width, height } = pngSize(await readFile(file));
    signal?.throwIfAborted();
    return { file, bytes: info.size, width, height, at };
  } catch (error) {
    await rm(file, { force: true });
    throw error;
  }
}

/**
 * Scale a captured PNG down proportionally until it fits `maxBytes`.
 *
 * A frame that already fits is returned untouched so desktop text keeps its native resolution;
 * only an oversized one is re-encoded, through ffmpeg's own scaler (the same binary that captured
 * it). The scale factor starts from the byte overshoot and tightens until the cap is met.
 *
 * @param {{file: string, bytes?: number, width?: number, height?: number}} shot
 * @param {{dir?: string, ffmpegPath?: string, maxBytes: number, signal?: AbortSignal, attempts?: number}} options
 * @returns {Promise<{file: string, bytes: number, width: number, height: number, data: Buffer} | null>}
 *   A new shot carrying the resized bytes, or null when it cannot be brought under the cap.
 */
export async function shrinkShot(shot, { dir, ffmpegPath, maxBytes, signal, attempts = 4 } = {}) {
  signal?.throwIfAborted();
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return null;
  const data = await readFile(shot.file);
  if (data.length <= maxBytes) return { ...shot, bytes: data.length, data };
  if (typeof ffmpegPath !== 'string' || ffmpegPath.length === 0) return null;
  const size = pngSize(data);
  const width = Number(shot.width) > 0 ? Number(shot.width) : size.width;
  const height = Number(shot.height) > 0 ? Number(shot.height) : size.height;
  if (width < 2 || height < 2) return null;
  const outputDir = dir ?? dirname(shot.file);
  let scale = Math.sqrt(maxBytes / data.length);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    signal?.throwIfAborted();
    const targetWidth = Math.max(2, Math.floor(width * scale));
    const targetHeight = Math.max(2, Math.floor(height * scale));
    const file = join(outputDir, `${randomUUID()}.png`);
    try {
      await runCapture(
        ffmpegPath,
        ['-hide_banner', '-v', 'error', '-nostdin', '-i', shot.file,
          '-vf', `scale=${targetWidth}:${targetHeight}:flags=lanczos`, '-frames:v', '1', '-y', file],
        { windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024, signal },
      );
      const info = await stat(file);
      signal?.throwIfAborted();
      if (info.size > 0 && info.size <= maxBytes) {
        return { ...shot, file, bytes: info.size, width: targetWidth, height: targetHeight, data: await readFile(file) };
      }
    } catch (error) {
      await rm(file, { force: true });
      if (signal?.aborted) throw signal.reason;
      return null;
    }
    await rm(file, { force: true });
    scale *= 0.85;
  }
  return null;
}

/**
 * Continuous capture with change-gated frame packing, delegated to dsh-see-now.
 * `source` selects the input: the desktop, or OBS's virtual camera for scene mode.
 * `width`/`height` default to the trial storyboard size (1920×1200) and are clamped by
 * `resolveStoryboardSize`; the actual values are reported through `stats()`.
 * @param {{ffmpegPath: string, dir: string, width?: number, height?: number, fps?: number, source?: object, signal?: AbortSignal}} options
 */
let cancellableScreenEngine = null;

/** How long one frame's arrival stamp is kept: comfortably longer than a sheet can sit queued. */
const CAPTURED_AT_RETENTION_MS = 180_000;

export async function startStoryboard({ ffmpegPath, dir, width, height, fps = 12, source = { kind: 'screen' }, signal }) {
  signal?.throwIfAborted();
  const size = resolveStoryboardSize({ width, height });
  const [{ spawnFrames, pickScreenEngine, captureArgs }, { createPipeline }] = await Promise.all([
    import('dsh-see-now/capture'),
    import('dsh-see-now/pipeline'),
  ]);

  await mkdir(dir, { recursive: true });
  // The engine only matters for desktop capture; device sources ignore it.
  let captureEngine = 'auto';
  if (source.kind === 'screen') {
    if (signal === undefined) captureEngine = await pickScreenEngine({ ffmpegPath, fps });
    else {
      // The dependency's cached probe has no cancellation API. Use the same tiny raw-frame
      // probe through our cancellable runner, so privacy also stops a *starting* storyboard.
      if (cancellableScreenEngine === null) {
        const args = captureArgs({
          source: { kind: 'screen', engine: 'ddagrab' }, width: 64, height: 36,
          fps, ffmpegPath, engine: 'ddagrab',
        }).slice(1);
        args.splice(args.length - 1, 0, '-frames:v', '1');
        try {
          const output = await runCapture(ffmpegPath, args, {
            windowsHide: true, timeout: 2500, maxBuffer: 1024 * 1024, encoding: 'buffer', signal,
          });
          signal.throwIfAborted();
          cancellableScreenEngine = output.length >= 64 * 36 * 3 ? 'ddagrab' : 'gdigrab';
        } catch {
          signal.throwIfAborted();
          cancellableScreenEngine = 'gdigrab';
        }
      }
      captureEngine = cancellableScreenEngine;
    }
  }
  signal?.throwIfAborted();
  // Report the source as the engine for device captures, so callers see "obs" not "auto".
  const label = source.kind === 'screen' ? captureEngine : source.kind;
  let pipeline = createPipeline({ width: size.width, height: size.height, fps });
  let stopped = false;

  const startedAt = Date.now();
  let frames = 0;
  let firstFrameMs = null;
  let sheets = 0;
  /**
   * Actual capture time per ffmpeg frame index (`Date.now()` the moment the frame arrived).
   *
   * The pipeline keeps only the presentation timestamp (`t = index / fps`) and rebuilds every
   * frame object while packing, so the wall-clock stamp has to live beside it — otherwise a sheet
   * that queued up ten seconds ago would look freshly captured the moment it is taken.
   */
  const capturedAtById = new Map();
  const pruneCapturedAt = (now) => {
    const oldest = now - CAPTURED_AT_RETENTION_MS;
    for (const [index, at] of capturedAtById) if (at < oldest) capturedAtById.delete(index);
  };
  /** Frame index of a pipeline frame: `i` when known, otherwise the presentation clock. */
  const frameIndex = (frame) => (Number.isFinite(frame?.i) ? frame.i : Math.round(Number(frame?.t) * fps));

  const run = spawnFrames({
    source,
    width: size.width,
    height: size.height,
    fps,
    engine: captureEngine,
    ffmpegPath,
    onFrame: (frame) => {
      if (stopped || signal?.aborted) return;
      const capturedAt = Date.now();
      frames += 1;
      if (firstFrameMs === null) firstFrameMs = capturedAt - startedAt;
      const index = frameIndex(frame);
      if (Number.isFinite(index)) {
        capturedAtById.set(index, capturedAt);
        if (frames % 120 === 0) pruneCapturedAt(capturedAt);
      }
      pipeline.push(frame);
    },
  });

  const stop = () => {
    if (stopped) return;
    stopped = true;
    pipeline = null; // Release every buffered pre-boundary frame, not just the active child.
    signal?.removeEventListener('abort', stop);
    try { run.stop(); } catch { /* already gone */ }
  };
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  // Attach both handlers immediately: an aborted ffmpeg may reject its done promise.
  void Promise.resolve(run.done).then(stop, stop);
  signal?.throwIfAborted();

  /**
   * Capture time of the earliest frame the pipeline actually packed into `sheet`.
   *
   * With no per-frame stamp (a pre-built/foreign sheet) it falls back to this session's own
   * capture start, clamped to `now`: an unstamped sheet can only read as older, never fresher.
   */
  const sheetCapturedAt = (sheet) => {
    const times = (Array.isArray(sheet.frames) ? sheet.frames : [])
      .map((frame) => capturedAtById.get(frameIndex(frame)))
      .filter((value) => Number.isFinite(value));
    if (times.length > 0) return Math.min(...times);
    const from = Number(sheet.from);
    const start = Number.isFinite(from) && from > 0 ? startedAt + from * 1000 : startedAt;
    return Math.min(start, Date.now());
  };

  return {
    engine: label,
    sourceKind: source.kind ?? 'screen',
    get running() { return !stopped; },
    stats: () => ({
      engine: label,
      sourceKind: source.kind ?? 'screen',
      // 采集分辨率是本次会话真实生效的值（config 覆盖后再 clamp），不是调用方传入的原始值。
      width: size.width,
      height: size.height,
      frames,
      sheets,
      firstFrameMs,
      uptimeMs: Date.now() - startedAt,
    }),
    /** Take the current storyboard, write it to disk, and return its metadata. */
    async take({ force = true } = {}) {
      signal?.throwIfAborted();
      if (stopped) throw new Error('storyboard stopped');
      let sheet = pipeline.take();
      // A static screen may not have crossed the change threshold yet. The user asked *now*,
      // so fall back to the newest decoded frame instead of returning nothing.
      if ((sheet === null || sheet === undefined) && force) {
        sheet = pipeline.flushNow(null, 'user');
      }
      if (sheet === null || sheet === undefined) return null;
      const file = join(dir, `${randomUUID()}.png`);
      try {
        await writeFile(file, sheet.png, { signal });
        const info = await stat(file);
        signal?.throwIfAborted();
        if (stopped) throw new Error('storyboard stopped');
        sheets += 1;
        const capturedAt = sheetCapturedAt(sheet);
        // 一张故事板可能覆盖数秒：把 sheet.from/to 的时长保留为 endedAt，而不是只留
        // 最早帧的 capturedAt。逐帧采集时刻也一并返回（绝对毫秒），供证据层按真实
        // 范围检索；它们只是时间点，不含文件路径或画面正文。
        const fromSec = Number(sheet.from);
        const toSec = Number(sheet.to);
        const spanMs = Number.isFinite(fromSec) && Number.isFinite(toSec)
          ? Math.max(0, (toSec - fromSec) * 1000)
          : 0;
        const endedAt = capturedAt + Math.min(spanMs, 120_000);
        const frameTimes = [];
        for (const frame of Array.isArray(sheet.frames) ? sheet.frames : []) {
          const stamped = capturedAtById.get(frameIndex(frame));
          const relative = Number(frame?.t);
          const at = Number.isFinite(stamped)
            ? stamped
            : (Number.isFinite(relative) && Number.isFinite(fromSec)
              ? capturedAt + Math.max(0, (relative - fromSec) * 1000)
              : null);
          if (at === null) continue;
          frameTimes.push(Math.min(endedAt, Math.max(capturedAt, at)));
          if (frameTimes.length >= 40) break;
        }
        const shotBreak = sheet.why === 'cut'
          || (Array.isArray(sheet.frames) && sheet.frames.some((frame) => frame?.via === 'cut'));
        return {
          file, bytes: info.size, width: sheet.w, height: sheet.h,
          // Observation age comes from the earliest packed frame, never from packing/writing time:
          // a sheet that waited in the queue must keep aging instead of looking freshly captured.
          at: capturedAt,
          capturedAt,
          // 真实可见范围：从最早打包帧到最后一帧（sheet.from/to 的时长），不再压成一个点。
          startedAt: capturedAt,
          endedAt,
          generatedAt: Date.now(),
          from: sheet.from, to: sheet.to,
          frames: Array.isArray(sheet.frames) ? sheet.frames.length : 0,
          frameTimes: [...new Set(frameTimes)].sort((left, right) => left - right),
          shotBreak,
          why: sheet.why ?? '',
        };
      } catch (error) {
        await rm(file, { force: true });
        throw error;
      }
    },
    stop,
    done: run.done,
  };
}

/** Launch an external player for a file (unused for now; kept for symmetry with tts). */
export function spawnDetached(command, args) {
  const child = spawn(command, args, { windowsHide: true, stdio: 'ignore', detached: true });
  child.unref();
  return child;
}
