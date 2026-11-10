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

/**
 * 独立原帧队列的默认边界。
 *
 * 故事板负责“宏观”：一张拼图看一段变化；原帧负责“细节”：需要看清某一帧时，必须能拿到
 * 那一帧自己的像素，而不是从拼图里裁一块。原帧只在内存里短暂保留，`take()` 时再编码成
 * PNG；`ttlMs`、`maxFrames`、`maxBytes` 保证它不会无限增长。按 1920×1200 rgb24 计，一帧
 * 约 6.9 MB，40 帧约 276 MB —— 这是刻意的上限，不是建议值。
 */
export const ORIGINAL_FRAME_DEFAULTS = Object.freeze({
  /** 原帧在内存/磁盘里的最长寿命；超过后淘汰。 */
  ttlMs: 60_000,
  /** 内存中最多保留多少帧原帧。 */
  maxFrames: 40,
  /** 内存中原帧像素的总字节上限。 */
  maxBytes: 256 * 1024 * 1024,
  /** 落盘原帧文件数上限（多张故事板共享同一上限）。 */
  maxFiles: 96,
  /** 落盘原帧文件的总字节上限。 */
  maxFileBytes: 384 * 1024 * 1024,
});

/**
 * 原帧的稳定查找键。故事板里的逐帧元数据只保留两位小数的 `t`（以及可能存在的 `i`），
 * 所以这里用同一个口径；`frameId` 是 take() 时另外生成的稳定身份，不参与查找。
 * @param {{i?: number, t?: number}} frame
 * @returns {string}
 */
export function originalFrameKey(frame) {
  const t = Number(frame?.t);
  if (Number.isFinite(t)) return `t:${t.toFixed(2)}`;
  const i = Number(frame?.i);
  if (Number.isFinite(i)) return `i:${i}`;
  return '';
}

/**
 * 有界原帧内存队列。只保存“可能被拼进故事板”的原始像素（rgb24 或 rgba），不做编码、
 * 不碰磁盘；淘汰顺序是 TTL → 帧数 → 字节，始终从最旧的开始。
 *
 * 这是一个纯模块：`now` 可注入，测试不需要真实时间；`onEvict(record, reason)` 只用于观测。
 * @param {object} [options]
 * @param {() => number} [options.now]
 * @param {number} [options.ttlMs]
 * @param {number} [options.maxFrames]
 * @param {number} [options.maxBytes]
 * @param {(record: object, reason: string) => void} [options.onEvict]
 */
export function createOriginalFrameQueue({
  now = Date.now,
  ttlMs = ORIGINAL_FRAME_DEFAULTS.ttlMs,
  maxFrames = ORIGINAL_FRAME_DEFAULTS.maxFrames,
  maxBytes = ORIGINAL_FRAME_DEFAULTS.maxBytes,
  onEvict = () => {},
} = {}) {
  const clock = () => {
    const value = Number(now());
    return Number.isFinite(value) ? value : Date.now();
  };
  const ttl = () => (Number.isFinite(ttlMs) && ttlMs >= 0 ? ttlMs : ORIGINAL_FRAME_DEFAULTS.ttlMs);
  const frameLimit = () => (Number.isFinite(maxFrames) && maxFrames > 0
    ? Math.floor(maxFrames)
    : ORIGINAL_FRAME_DEFAULTS.maxFrames);
  const byteLimit = () => (Number.isFinite(maxBytes) && maxBytes > 0
    ? Math.floor(maxBytes)
    : ORIGINAL_FRAME_DEFAULTS.maxBytes);

  /** 按加入顺序保存（采集时间单调），淘汰永远从队首开始。 */
  let entries = [];
  let bytes = 0;
  const byKey = new Map();
  /** 已排队故事板引用的原帧：在 sheet 被取走前，容量淘汰不能先把它们删掉。 */
  const pinned = new Set();

  const evict = (entry, reason) => {
    bytes -= entry.bytes;
    byKey.delete(entry.key);
    pinned.delete(entry.key);
    try {
      onEvict(entry, reason);
    } catch {
      /* 观测失败不能影响队列本身 */
    }
  };

  const firstUnpinned = () => entries.findIndex((entry) => !pinned.has(entry.key));

  /** 淘汰过期/超限帧，返回被淘汰的记录（副本）。锁定的原帧只在 TTL 到期时被淘汰。 */
  function prune() {
    const current = clock();
    const cutoff = current - ttl();
    const evicted = [];
    const kept = [];
    for (const entry of entries) {
      if (entry.capturedAt < cutoff) {
        evict(entry, 'age');
        evicted.push({ ...entry, reason: 'age' });
      } else {
        kept.push(entry);
      }
    }
    entries = kept;
    while (entries.length > frameLimit()) {
      const index = firstUnpinned();
      if (index < 0) break; // 全是排队故事板的帧：由 TTL 兜底，不让容量饥饿把它删掉
      const [entry] = entries.splice(index, 1);
      evict(entry, 'frames');
      evicted.push({ ...entry, reason: 'frames' });
    }
    while (bytes > byteLimit() && entries.length > 0) {
      const index = firstUnpinned();
      if (index < 0) break;
      const [entry] = entries.splice(index, 1);
      evict(entry, 'bytes');
      evicted.push({ ...entry, reason: 'bytes' });
    }
    return evicted;
  }

  /**
   * 保存一帧原帧。同一查找键（同一时刻）只保留一份，新数据覆盖旧数据。
   * @param {{buf?: Buffer|Uint8Array, t?: number, i?: number, capturedAt?: number, key?: string}} input
   */
  function add(input) {
    const key = typeof input?.key === 'string' && input.key.length > 0
      ? input.key
      : originalFrameKey(input);
    const buf = input?.buf;
    if (key.length === 0 || buf === null || buf === undefined
      || typeof buf.length !== 'number' || buf.length === 0) return null;
    const previous = byKey.get(key);
    if (previous !== undefined) {
      bytes -= previous.bytes;
      entries = entries.filter((entry) => entry !== previous);
      byKey.delete(key);
    }
    const capturedAt = Number(input.capturedAt);
    const record = {
      key,
      t: Number(input.t),
      i: Number(input.i),
      buf,
      bytes: buf.length,
      capturedAt: Number.isFinite(capturedAt) && capturedAt > 0 ? capturedAt : clock(),
    };
    entries.push(record);
    byKey.set(key, record);
    bytes += record.bytes;
    prune();
    return record;
  }

  /** 按逐帧元数据取原帧；过期后自动淘汰并返回 null。 */
  function get(frame) {
    prune();
    const key = originalFrameKey(frame);
    return key.length === 0 ? null : byKey.get(key) ?? null;
  }

  /** 原帧已经编码落盘后可以立刻释放像素内存；文件仍由调用方的文件账本管理。 */
  function remove(frame) {
    const key = originalFrameKey(frame);
    if (key.length === 0) return null;
    const record = byKey.get(key);
    if (record === undefined) return null;
    bytes -= record.bytes;
    entries = entries.filter((entry) => entry !== record);
    byKey.delete(key);
    pinned.delete(key);
    return record;
  }

  /**
   * 锁定一张已排队故事板引用的原帧。容量淘汰会跳过它们，直到 `take()` 把它们编码完；
   * 这不是无限缓存：TTL 仍然会淘汰，且最多只锁一张故事板的帧。
   */
  function pin(frames) {
    if (!Array.isArray(frames)) return 0;
    let count = 0;
    for (const frame of frames) {
      const key = originalFrameKey(frame);
      if (key.length === 0 || !byKey.has(key) || pinned.has(key)) continue;
      pinned.add(key);
      count += 1;
    }
    return count;
  }

  function unpinAll() {
    pinned.clear();
  }

  function clear(reason = 'clear') {
    const cleared = entries.map((entry) => ({ ...entry, reason }));
    for (const entry of entries) {
      bytes -= entry.bytes;
      try {
        onEvict(entry, reason);
      } catch {
        /* 观测失败不能影响清空 */
      }
    }
    entries = [];
    bytes = 0;
    byKey.clear();
    pinned.clear();
    return cleared;
  }

  function state() {
    return {
      frames: entries.length,
      bytes,
      pinned: pinned.size,
      oldestAt: entries.length === 0 ? null : entries[0].capturedAt,
      newestAt: entries.length === 0 ? null : entries[entries.length - 1].capturedAt,
      ttlMs: ttl(),
      maxFrames: frameLimit(),
      maxBytes: byteLimit(),
    };
  }

  return { add, get, remove, pin, unpinAll, prune, clear, state };
}

/**
 * 有界原帧文件账本。只记录“已经落盘的原帧文件”，不读像素；淘汰顺序 TTL → 文件数 → 字节。
 * `add()`/`prune()` 返回被淘汰的记录，由调用方负责删除文件；`clear()` 返回剩余全部记录。
 * @param {object} [options]
 * @param {() => number} [options.now]
 * @param {number} [options.ttlMs]
 * @param {number} [options.maxFiles]
 * @param {number} [options.maxBytes]
 */
export function createOriginalFileLedger({
  now = Date.now,
  ttlMs = ORIGINAL_FRAME_DEFAULTS.ttlMs,
  maxFiles = ORIGINAL_FRAME_DEFAULTS.maxFiles,
  maxBytes = ORIGINAL_FRAME_DEFAULTS.maxFileBytes,
} = {}) {
  const clock = () => {
    const value = Number(now());
    return Number.isFinite(value) ? value : Date.now();
  };
  const ttl = () => (Number.isFinite(ttlMs) && ttlMs >= 0 ? ttlMs : ORIGINAL_FRAME_DEFAULTS.ttlMs);
  const fileLimit = () => (Number.isFinite(maxFiles) && maxFiles > 0
    ? Math.floor(maxFiles)
    : ORIGINAL_FRAME_DEFAULTS.maxFiles);
  const byteLimit = () => (Number.isFinite(maxBytes) && maxBytes > 0
    ? Math.floor(maxBytes)
    : ORIGINAL_FRAME_DEFAULTS.maxFileBytes);

  let files = [];
  let bytes = 0;

  function prune() {
    const cutoff = clock() - ttl();
    const evicted = [];
    const kept = [];
    for (const entry of files) {
      if (entry.createdAt < cutoff) {
        bytes -= entry.bytes;
        evicted.push({ ...entry, reason: 'age' });
      } else {
        kept.push(entry);
      }
    }
    files = kept;
    while (files.length > fileLimit()) {
      const entry = files.shift();
      bytes -= entry.bytes;
      evicted.push({ ...entry, reason: 'files' });
    }
    while (bytes > byteLimit() && files.length > 0) {
      const entry = files.shift();
      bytes -= entry.bytes;
      evicted.push({ ...entry, reason: 'bytes' });
    }
    return evicted;
  }

  function add({ file, bytes: size, createdAt = clock() } = {}) {
    if (typeof file !== 'string' || file.length === 0) return [];
    const byteSize = Number(size);
    files.push({
      file,
      bytes: Number.isFinite(byteSize) && byteSize > 0 ? Math.floor(byteSize) : 0,
      createdAt: Number.isFinite(Number(createdAt)) && Number(createdAt) > 0 ? Number(createdAt) : clock(),
    });
    bytes += files[files.length - 1].bytes;
    return prune();
  }

  function clear() {
    const cleared = files.map((entry) => ({ ...entry, reason: 'clear' }));
    files = [];
    bytes = 0;
    return cleared;
  }

  function state() {
    return {
      files: files.length,
      bytes,
      oldestAt: files.length === 0 ? null : files[0].createdAt,
      newestAt: files.length === 0 ? null : files[files.length - 1].createdAt,
      ttlMs: ttl(),
      maxFiles: fileLimit(),
      maxBytes: byteLimit(),
    };
  }

  return { add, prune, clear, state };
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

/** 单张故事板最多编码多少个独立原帧；管道本身上限 40，这里再兜一层底。 */
const MAX_ORIGINAL_CELLS = 40;

/** Process-wide frame identity; evidence ids stay unique even if two sessions overlap. */
let originalFrameSequence = 0;

/**
 * 把一帧原始像素转成 `encodePng` 需要的 rgb24。
 *
 * 真实采集链路（dsh-see-now spawnFrames）给的是 rgb24；测试/未来版本可能给 rgba。
 * 按长度判断：4 通道丢掉 alpha（截图不透明，alpha 没有信息量），3 通道原样使用。
 * @param {Buffer|Uint8Array|null|undefined} buf
 * @param {number} width
 * @param {number} height
 * @returns {Buffer|Uint8Array|null}
 */
function rgbPixelsOf(buf, width, height) {
  if (buf === null || buf === undefined || typeof buf.length !== 'number') return null;
  const pixels = Number(width) * Number(height);
  if (!Number.isInteger(pixels) || pixels <= 0) return null;
  if (buf.length >= pixels * 4) {
    const rgb = Buffer.allocUnsafe(pixels * 3);
    for (let pixel = 0, source = 0, target = 0; pixel < pixels; pixel += 1, source += 4, target += 3) {
      rgb[target] = buf[source];
      rgb[target + 1] = buf[source + 1];
      rgb[target + 2] = buf[source + 2];
    }
    return rgb;
  }
  if (buf.length >= pixels * 3) return buf.subarray(0, pixels * 3);
  return null;
}

export async function startStoryboard({ ffmpegPath, dir, width, height, fps = 12, source = { kind: 'screen' }, signal }) {
  signal?.throwIfAborted();
  const size = resolveStoryboardSize({ width, height });
  const [
    { spawnFrames, pickScreenEngine, captureArgs },
    { createPipeline },
    { encodePng },
  ] = await Promise.all([
    import('dsh-see-now/capture'),
    import('dsh-see-now/pipeline'),
    import('dsh-see-now/png'),
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
   * 原帧队列只保留“可能被拼进故事板”的帧：pipelines 决定了哪些帧留下之后，才把对应
   * 的原始像素放进有界队列；`take()` 再用这份像素编码独立 PNG。这样既不会把每帧都
   * 常驻内存，也不需要在 take 时反解拼图。
   */
  const originalFrames = createOriginalFrameQueue();
  const originalFiles = createOriginalFileLedger();
  /** 已判定但未写入磁盘的原帧（`pipeline.log` 只记元数据，不保留像素）。 */
  const rawPending = [];
  let lastRawFrame = null;
  /** 当前已排队、等待 take() 的故事板；它引用的原帧在取走前不能被容量淘汰。 */
  let pinnedSheet = null;
  let originalFrameCount = 0;
  let originalFrameBytes = 0;
  let originalFrameErrors = 0;
  /** `stop()` 的磁盘清理任务：重复 stop 共享同一个 Promise。 */
  let stopCleanup = null;

  const deleteOriginalFiles = (records) => Promise.all(records
    .filter((record) => typeof record?.file === 'string' && record.file.length > 0)
    .map((record) => rm(record.file, { force: true }).catch(() => {})));

  const pruneOriginalFiles = () => {
    const evicted = originalFiles.prune();
    if (evicted.length > 0) void deleteOriginalFiles(evicted);
    return evicted;
  };

  /**
   * 排队中的故事板优先：每次 push 后看管线队首，把它引用的原帧锁进队列。证据采集/工具
   * 取图通常只隔 2 秒，但高变化画面可能在 2 秒里把 40 帧上限再次填满；不锁的话，先
   * flush 的故事板会先丢掉自己的原帧。只锁一张（管线 queueDepth 默认 1），TTL 仍是硬上限。
   */
  const syncPinnedSheet = () => {
    let queued = null;
    try {
      queued = typeof pipeline?.peek === 'function' ? pipeline.peek() : null;
    } catch {
      queued = null;
    }
    if (queued !== pinnedSheet) {
      pinnedSheet = queued ?? null;
      originalFrames.unpinAll();
    }
    // 每次调用都重新 pin：flush 发生在 push 内部，最新判定的那帧可能晚一步才进队列。
    if (pinnedSheet !== null) originalFrames.pin(pinnedSheet.frames);
  };
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
        if (frames % 120 === 0) {
          pruneCapturedAt(capturedAt);
          pruneOriginalFiles();
        }
      }
      // 管线延迟一帧判定：push 之后，`pipeline.log` 是否增长决定了最老那帧有没有被留下。
      // 只有留下来的帧才值得保留原始像素；`log` 缺失时退化为“有 frame.buf 才可用”。
      const raw = {
        t: Number(frame?.t),
        i: index,
        buf: frame?.buf,
        capturedAt,
      };
      lastRawFrame = raw;
      if (rawPending.length === 0) {
        rawPending.push(raw);
        pipeline.push(frame);
        syncPinnedSheet();
        return;
      }
      rawPending.push(raw);
      const logBefore = Array.isArray(pipeline?.log) ? pipeline.log.length : 0;
      pipeline.push(frame);
      const logAfter = Array.isArray(pipeline?.log) ? pipeline.log.length : 0;
      const decided = rawPending.shift();
      if (decided !== undefined && logAfter > logBefore) originalFrames.add(decided);
      syncPinnedSheet();
    },
  });

  const stop = () => {
    if (stopped) return stopCleanup ?? Promise.resolve();
    stopped = true;
    pipeline = null; // Release every buffered pre-boundary frame, not just the active child.
    rawPending.length = 0;
    lastRawFrame = null;
    pinnedSheet = null;
    // 隐私/切源/停止：原帧（内存像素 + 已落盘文件）都属于当前代次，不能跨边界留下。
    originalFrames.clear('stop');
    const remaining = originalFiles.clear();
    signal?.removeEventListener('abort', stop);
    try { run.stop(); } catch { /* already gone */ }
    stopCleanup = deleteOriginalFiles(remaining);
    return stopCleanup;
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
      // 独立原帧：只报数量/字节/失败计数，不含任何路径或像素。
      originalFrames: originalFrameCount,
      originalBytes: originalFrameBytes,
      originalFrameErrors,
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
      // 每次取图顺手淘汰过期原帧文件：即使没有新帧，磁盘占用也有清晰上界。
      pruneOriginalFiles();
      const sheetId = randomUUID();
      const file = join(dir, `${sheetId}.png`);
      const createdFrameFiles = [];
      const cells = [];
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
        const sheetFrames = Array.isArray(sheet.frames) ? sheet.frames : [];
        const sheetWidth = Number(sheet.w) > 0 ? Math.round(Number(sheet.w)) : size.width;
        const sheetHeight = Number(sheet.h) > 0 ? Math.round(Number(sheet.h)) : size.height;
        const frameTimes = [];
        for (const frame of sheetFrames) {
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
        /**
         * 独立原帧：优先使用 `frame.buf`（未来 dsh-see-now 若把像素留在 sheet 上），否则从
         * 有界原帧队列里按 `t` 取回。队列只保留管线真正留下的帧，所以不会把 12fps 的整条
         * 流常驻内存；取不到像素的帧只跳过 cells，绝不影响故事板本身。
         */
        for (let cellIndex = 0; cellIndex < sheetFrames.length; cellIndex += 1) {
          if (cells.length >= MAX_ORIGINAL_CELLS) break;
          signal?.throwIfAborted();
          if (stopped) throw new Error('storyboard stopped');
          const frame = sheetFrames[cellIndex];
          const frameKey = originalFrameKey(frame);
          const rawRecord = originalFrames.get(frame);
          const fallbackRaw = frameKey.length > 0 && lastRawFrame !== null
            && originalFrameKey(lastRawFrame) === frameKey
            ? lastRawFrame
            : null;
          const rgb = rgbPixelsOf(
            frame?.buf ?? rawRecord?.buf ?? fallbackRaw?.buf,
            sheetWidth,
            sheetHeight,
          );
          if (rgb === null) continue;
          // 采集时刻：真实到达时间优先；没有时退回管线时刻（相对 sheet 起点），仍夹在本张范围内。
          const rawAt = Number(rawRecord?.capturedAt ?? fallbackRaw?.capturedAt);
          const stamped = capturedAtById.get(frameIndex(frame));
          const providedAt = Number(frame?.capturedAt);
          const relative = Number(frame?.t);
          let at = Number.isFinite(rawAt) && rawAt > 0 ? rawAt : null;
          if (at === null && Number.isFinite(providedAt) && providedAt > 0) at = providedAt;
          if (at === null && Number.isFinite(stamped)) at = stamped;
          if (at === null && Number.isFinite(relative) && Number.isFinite(fromSec)) {
            at = capturedAt + Math.max(0, (relative - fromSec) * 1000);
          }
          const frameCapturedAt = at === null
            ? capturedAt
            : Math.min(endedAt, Math.max(capturedAt, at));
          let png;
          try {
            // level 1：原帧只用于“看清细节”，编码延迟比几 MB 的额外体积更重要。
            png = encodePng(rgb, sheetWidth, sheetHeight, { level: 1 });
          } catch {
            originalFrameErrors += 1;
            continue;
          }
          const rawFile = join(dir, `${sheetId}-frame-${cellIndex}.png`);
          let rawInfo;
          try {
            await writeFile(rawFile, png, { signal });
            rawInfo = await stat(rawFile);
          } catch (error) {
            await rm(rawFile, { force: true }).catch(() => {});
            if (signal?.aborted) throw signal.reason ?? error;
            if (stopped) throw new Error('storyboard stopped');
            originalFrameErrors += 1;
            continue;
          }
          createdFrameFiles.push(rawFile);
          // 像素已经变成独立 PNG，立刻释放内存；文件由账本继续按 TTL/容量管理。
          originalFrames.remove(frame);
          originalFrameCount += 1;
          originalFrameBytes += rawInfo.size;
          const evicted = originalFiles.add({
            file: rawFile,
            bytes: rawInfo.size,
            createdAt: Date.now(),
          });
          if (evicted.length > 0) void deleteOriginalFiles(evicted);
          cells.push({
            // 稳定身份：同一张故事板里每个 cell 一旦生成就不再变化。shotId 由宿主在登记
            // 证据时补上（采集层还不知道宿主的镜头分段），这里先留空字符串。
            frameId: `frame-${++originalFrameSequence}`,
            capturedAt: frameCapturedAt,
            shotId: typeof sheet.shotId === 'string' ? sheet.shotId : '',
            width: sheetWidth,
            height: sheetHeight,
            bytes: rawInfo.size,
            // 仅供宿主复制/清理；不进入 status，也不进入模型可见的工具结果。
            file: rawFile,
          });
        }
        // 这张故事板已经取走：解除原帧锁定，容量淘汰恢复。
        originalFrames.unpinAll();
        pinnedSheet = null;
        const shotBreak = sheet.why === 'cut'
          || sheetFrames.some((frame) => frame?.via === 'cut');
        return {
          file, bytes: info.size, width: sheetWidth, height: sheetHeight,
          // Observation age comes from the earliest packed frame, never from packing/writing time:
          // a sheet that waited in the queue must keep aging instead of looking freshly captured.
          at: capturedAt,
          capturedAt,
          // 真实可见范围：从最早打包帧到最后一帧（sheet.from/to 的时长），不再压成一个点。
          startedAt: capturedAt,
          endedAt,
          generatedAt: Date.now(),
          from: sheet.from, to: sheet.to,
          frames: sheetFrames.length,
          frameTimes: [...new Set(frameTimes)].sort((left, right) => left - right),
          // 原帧引用（含内部 file 路径）：宿主登记进证据窗口时保存，status/模型输出只取
          // frameId/时间/尺寸/字节这些安全字段。
          cells,
          shotBreak,
          why: sheet.why ?? '',
        };
      } catch (error) {
        originalFrames.unpinAll();
        pinnedSheet = null;
        await Promise.all(createdFrameFiles.map((rawFile) => rm(rawFile, { force: true }).catch(() => {})));
        await rm(file, { force: true });
        throw error;
      }
    },
    stop,
    // 会话退出后仍要等原帧清理落地：调用方 `await session.done` 才能看到目录干净。
    get done() {
      return Promise.resolve(run.done).then((value) => (
        stopCleanup === null ? value : stopCleanup.then(() => value)
      ));
    },
  };
}

/** Launch an external player for a file (unused for now; kept for symmetry with tts). */
export function spawnDetached(command, args) {
  const child = spawn(command, args, { windowsHide: true, stdio: 'ignore', detached: true });
  child.unref();
  return child;
}
