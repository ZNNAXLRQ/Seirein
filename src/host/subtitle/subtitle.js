/**
 * Subtitle overlay driver.
 *
 * The visible layer is a separate PowerShell/WPF process (overlay.ps1) because the Host runs
 * as a Node process with no window of its own. Communication is file based: we write
 * `<dir>/state.json` atomically, the overlay polls it, and selection mode writes
 * `<dir>/selection.json` back.
 */
import { spawn, execFile } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const SELECT_TIMEOUT_MS = 60_000;
/** A stale publication is reported at most once per second; a probe/palette burst drops many. */
const PUBLISH_DROP_THROTTLE_MS = 1_000;

/** Filesystem primitives; injectable so the concurrency behaviour can be tested without disks. */
const DEFAULT_FS = { mkdir, writeFile, rename, rm, readFile };

/** Monotonic counter keeping every `writeState` temporary file unique within this process. */
let stateWriteSeq = 0;

/** Average luminance (0–1) of a screen rectangle, measured with System.Drawing. */
function sampleLuma(region) {
  const script = [
    // Without this the probe process is DPI-unaware and CopyFromScreen sees virtualized
    // (1707x1067-style) coordinates, so it would sample the wrong patch on a scaled display.
    'Add-Type -Namespace Win32 -Name Dpi -MemberDefinition \'[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();\'',
    '[void][Win32.Dpi]::SetProcessDPIAware()',
    'Add-Type -AssemblyName System.Drawing',
    `$b = New-Object System.Drawing.Bitmap(${region.w}, ${region.h})`,
    '$g = [System.Drawing.Graphics]::FromImage($b)',
    `$g.CopyFromScreen(${region.x}, ${region.y}, 0, 0, $b.Size)`,
    '$sum = 0.0; $n = 0',
    'for ($y = 0; $y -lt $b.Height; $y += 4) { for ($x = 0; $x -lt $b.Width; $x += 4) {',
    '  $p = $b.GetPixel($x, $y); $sum += (0.2126 * $p.R + 0.7152 * $p.G + 0.0722 * $p.B) / 255.0; $n++ } }',
    '$g.Dispose(); $b.Dispose()',
    'if ($n -gt 0) { [Math]::Round($sum / $n, 3) } else { 0.5 }',
  ].join('; ');
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-Command', script], { windowsHide: true }, (error, stdout) => {
      if (error) return resolve(null);
      const value = Number.parseFloat(String(stdout).trim());
      return resolve(Number.isFinite(value) ? value : null);
    });
  });
}

/** Pick a bubble/text pair that reads well over the sampled background. */
function contrastPair(luma) {
  const dark = luma === null ? true : luma < 0.55;
  return dark
    ? { bg: '#f5f6f8', fg: '#12141a' } // dark background -> light bubble, dark text
    : { bg: '#12141a', fg: '#f7f7f7' }; // light background -> dark bubble, light text
}

/**
 * Average colour of a small patch centred in `region` (used for the model-tinted bubble).
 * Samples a 256×256 patch at most, so a fullscreen VTS window does not allocate a huge bitmap.
 * @returns {Promise<{r: number, g: number, b: number} | null>}
 */
function averageColor(region) {
  const size = Math.max(16, Math.min(256, Math.floor(region.w), Math.floor(region.h)));
  const sx = Math.round(region.x + (region.w - size) / 2);
  const sy = Math.round(region.y + (region.h - size) / 2);
  const script = [
    'Add-Type -Namespace Win32 -Name Dpi -MemberDefinition \'[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();\'',
    '[void][Win32.Dpi]::SetProcessDPIAware()',
    'Add-Type -AssemblyName System.Drawing',
    `$b = New-Object System.Drawing.Bitmap(${size}, ${size})`,
    '$g = [System.Drawing.Graphics]::FromImage($b)',
    `$g.CopyFromScreen(${sx}, ${sy}, 0, 0, $b.Size)`,
    '$r = 0.0; $gg = 0.0; $bb = 0.0; $n = 0',
    'for ($y = 0; $y -lt $b.Height; $y += 4) { for ($x = 0; $x -lt $b.Width; $x += 4) {',
    '  $p = $b.GetPixel($x, $y); $r += $p.R; $gg += $p.G; $bb += $p.B; $n++ } }',
    '$g.Dispose(); $b.Dispose()',
    'if ($n -gt 0) { "{0},{1},{2}" -f [int]($r / $n), [int]($gg / $n), [int]($bb / $n) } else { "" }',
  ].join('; ');
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-Command', script], { windowsHide: true, timeout: 10_000 }, (error, stdout) => {
      if (error) return resolve(null);
      const [r, g, b] = String(stdout).trim().split(',').map((value) => Number.parseInt(value, 10));
      if (![r, g, b].every((value) => Number.isFinite(value))) return resolve(null);
      return resolve({ r, g, b });
    });
  });
}

export { averageColor };

// ---- unified avatar geometry -------------------------------------------------------------
// One rectangle drives the bubble: the VTS client area while editing, and the active display
// layer's rectangle while the avatar is running (WPF or Spout both feed the same record).

const GEOMETRY_KEYS = ['left', 'top', 'width', 'height'];
const BUBBLE_PADDING_X = 14;
const BUBBLE_PADDING_Y = 10;
const BUBBLE_LINE_RATIO = 1.4;
const BUBBLE_PAGE_MS = 2600;
/** Below this much room a bubble side is unreadable: no full line (1.5 × line height) and < 24 px. */
const BUBBLE_MIN_LINE_RATIO = 1.5;
const BUBBLE_MIN_SPACE_PX = 24;
/** Inside placement may cover at most this fraction of the avatar window height. */
const BUBBLE_INSIDE_RATIO = 0.6;
/** Alpha of the black veil drawn behind text placed inside the avatar window. */
const BUBBLE_INSIDE_ALPHA = 200;

/** `{left,top,width,height}` / `{x,y,width,height}` / `{x,y,w,h}` → rounded rect, or null. */
export function normalizeGeometry(value) {
  if (value === null || typeof value !== 'object') return null;
  const left = Number(value.left ?? value.x);
  const top = Number(value.top ?? value.y);
  const width = Number(value.width ?? value.w);
  const height = Number(value.height ?? value.h);
  if (![left, top, width, height].every(Number.isFinite)) return null;
  if (width <= 0 || height <= 0) return null;
  return { left: Math.round(left), top: Math.round(top), width: Math.round(width), height: Math.round(height) };
}

/** Work-area rectangle in physical pixels; its `top` limits how far an upward-growing bubble can rise. */
export function normalizeWorkArea(value) {
  if (value === null || typeof value !== 'object') return null;
  const left = Number(value.left ?? value.x ?? 0);
  const top = Number(value.top ?? value.y ?? 0);
  const width = Number(value.width ?? value.w);
  const height = Number(value.height ?? value.h);
  if (![left, top, width, height].every(Number.isFinite)) return null;
  if (width <= 0 || height <= 0) return null;
  return { left: Math.round(left), top: Math.round(top), width: Math.round(width), height: Math.round(height) };
}

/** A valid DPI scale (physical pixels per DIP), or `null` when the value is unusable. */
function resolveDpiScale(value) {
  const scale = Number(value);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  return Math.min(8, Math.max(0.5, scale));
}

/**
 * Visual line ranges measured in DIP with the same wrap rule WPF applies.
 *
 * `contentWidth` is in DIP (the host converts the physical rectangle with the display scale), so
 * the line count no longer depends on the monitor's DPI. Each range partitions the source text
 * exactly; pagination slices those ranges, which is what guarantees no character is dropped.
 */
function wrapBubbleText(text, contentWidth, size) {
  const ranges = [];
  let start = 0;
  let lineWidth = 0;
  const push = (end) => {
    ranges.push({ start, end });
    start = end;
    lineWidth = 0;
  };
  let index = 0;
  while (index < text.length) {
    const codePoint = text.codePointAt(index);
    const char = String.fromCodePoint(codePoint);
    if (char === '\n') {
      push(index + 1); // the newline belongs to the line it terminates, so slices stay contiguous
      index += 1;
      continue;
    }
    const advance = codePoint >= 0x2e80 ? size : size * 0.56;
    if (lineWidth > 0 && lineWidth + advance > contentWidth) push(index);
    lineWidth += advance;
    index += char.length;
  }
  if (start < text.length || ranges.length === 0) ranges.push({ start, end: text.length });
  return ranges;
}

function paginateBubblePages(text, ranges, usable) {
  const pages = [];
  for (let index = 0; index < ranges.length; index += usable) {
    const last = Math.min(index + usable, ranges.length) - 1;
    pages.push(text.slice(ranges[index].start, ranges[last].end));
  }
  return pages.length === 0 ? [''] : pages;
}

/**
 * Bubble placement from the unified geometry. Normally the bubble's bottom-left corner is pinned
 * to the avatar window's top-left corner — left = left, bottom = top, width = width — and the
 * fixed font makes it grow upward while the bottom edge stays put. When less than a readable line
 * fits above the window, it falls back to the other side: left = left, top = the window's bottom
 * edge, growing downward. If neither side is readable, it moves inside the avatar window: top =
 * the window top, width = the window width, growing downward on a semi-transparent veil, capped
 * at BUBBLE_INSIDE_RATIO of the window height and the visible work area. `maxHeight` is the room
 * on the chosen side (the inside cap for 'inside'), and overflowing text is split into timed
 * pages instead of being truncated.
 *
 * All text metrics happen in DIP: the physical rectangle and work area are divided by the
 * display scale first, exactly like overlay.ps1 does. The overlay still re-measures the full
 * text with WPF and can split a host page further, so a small mismatch between this estimate
 * and the real glyph advance can never truncate a line.
 */
export function bubbleLayout(text, geometry, {
  workArea = null,
  font = 'Microsoft YaHei UI',
  size = 32,
  pageMs = BUBBLE_PAGE_MS,
  dpiScale = null,
} = {}) {
  const rect = normalizeGeometry(geometry);
  if (rect === null) return null;
  const body = String(text ?? '').replace(/\r\n?/gu, '\n');
  const fixedSize = Number.isFinite(Number(size)) ? Math.max(6, Number(size)) : 32;
  const scale = resolveDpiScale(dpiScale) ?? resolveDpiScale(workArea?.dpiScale) ?? 1;
  const contentWidth = Math.max(20, rect.width / scale - 2 * BUBBLE_PADDING_X); // DIP
  const lineHeight = Math.max(1, fixedSize * BUBBLE_LINE_RATIO); // DIP
  const ranges = wrapBubbleText(body, contentWidth, fixedSize);
  const requestedHeight = Math.max(1, Math.round((2 * BUBBLE_PADDING_Y + ranges.length * lineHeight) * scale));
  const area = normalizeWorkArea(workArea);
  // Room above the window (up to the work-area top) and below it (down to the work-area bottom),
  // both in physical pixels. One full line plus padding is the minimum readable space.
  const belowEdge = rect.top + rect.height;
  const topSpace = area === null ? null : Math.max(0, Math.floor(rect.top - area.top));
  const belowSpace = area === null ? null : Math.max(0, Math.floor(area.top + area.height - belowEdge));
  const minSpace = Math.max(BUBBLE_MIN_SPACE_PX, Math.ceil(lineHeight * scale * BUBBLE_MIN_LINE_RATIO));
  // One padded line is the smallest readable bubble; inside placement may never be thinner.
  const oneLineHeight = Math.max(1, Math.round((2 * BUBBLE_PADDING_Y + lineHeight) * scale));
  let side = 'above';
  let available = topSpace;
  let fallback = null;
  if (topSpace !== null && topSpace < minSpace) {
    if (belowSpace !== null && belowSpace >= minSpace) {
      // The strip above the window cannot show a line: hang the bubble off its bottom edge instead.
      side = 'below';
      available = belowSpace;
      fallback = { reason: 'top-space', side, available };
    } else {
      // Both outside strips are unreadable (the window nearly fills the screen height): show the
      // bubble inside the avatar's top edge, capped so it never covers the whole avatar and never
      // leaves the visible work area, but never thinner than one padded line.
      const screenRoom = area === null ? null : Math.max(0, area.top + area.height - rect.top);
      const cap = Math.max(oneLineHeight, Math.round(rect.height * BUBBLE_INSIDE_RATIO));
      const insideMaxHeight = Math.max(oneLineHeight, Math.min(cap, screenRoom ?? cap));
      side = 'inside';
      available = insideMaxHeight;
      fallback = { reason: 'both-sides', side, available: insideMaxHeight };
    }
  }
  const maxHeight = available === null ? null : Math.max(1, available);
  const clamped = maxHeight !== null && requestedHeight > maxHeight;
  const maxHeightDip = maxHeight === null ? null : maxHeight / scale;
  const usable = maxHeightDip === null
    ? null
    : Math.max(1, Math.floor((maxHeightDip - 2 * BUBBLE_PADDING_Y) / lineHeight));
  const height = clamped ? maxHeight : requestedHeight;
  const pages = clamped ? paginateBubblePages(body, ranges, usable) : [body];
  // `top`/`bottom` describe the visible bubble: the overlay anchors on `bottom` when growing
  // upward and on `top` when growing downward, so the window always moves away from the avatar.
  // 'inside' starts at the avatar window's own top edge and grows downward from it.
  const top = side === 'below' ? belowEdge : side === 'inside' ? rect.top : rect.top - height;
  const bottom = side === 'below' ? belowEdge + height : side === 'inside' ? rect.top + height : rect.top;
  return {
    geometry: { ...rect },
    font,
    size: fixedSize,
    side,
    lineHeight: Math.max(1, Math.round(lineHeight * scale)),
    left: rect.left,
    top,
    bottom,
    width: rect.width,
    height,
    requestedHeight,
    maxHeight,
    clamped,
    fallback,
    text: body,
    pages,
    pageMs: Number.isFinite(Number(pageMs)) ? Math.max(0, Math.round(Number(pageMs))) : BUBBLE_PAGE_MS,
  };
}

/**
 * Which unified geometry to use, from state the host already owns. Editing always follows the
 * VTS client area (and reports `hidden` when VTS is not on screen); otherwise the running display
 * layer wins; with no display the last rectangle is kept instead of silently disappearing.
 */
export function resolveAvatarGeometry({
  editing = false,
  vtsRect = null,
  backend = 'wpf',
  wpfRunning = false,
  wpfRect = null,
  spoutRunning = false,
  spoutRect = null,
  last = null,
} = {}) {
  if (editing === true) {
    const vts = normalizeGeometry(vtsRect);
    return vts === null
      ? { rect: null, source: 'edit', hidden: true }
      : { rect: vts, source: 'edit' };
  }
  const order = backend === 'spout' ? ['spout', 'wpf'] : ['wpf', 'spout'];
  for (const which of order) {
    if (which === 'wpf' && wpfRunning === true) {
      const rect = normalizeGeometry(wpfRect);
      if (rect !== null) return { rect, source: 'wpf' };
    }
    if (which === 'spout' && spoutRunning === true) {
      const rect = normalizeGeometry(spoutRect);
      if (rect !== null) return { rect, source: 'spout' };
    }
  }
  const kept = normalizeGeometry(last);
  if (kept !== null) return { rect: kept, source: 'kept' };
  return { rect: null, source: '', hidden: true };
}

/** Host-side owner of the one avatar rectangle; emits `subtitle.geometry` only on a change. */
export class SubtitleGeometryTracker {
  constructor({ onEvent = null } = {}) {
    this.onEvent = typeof onEvent === 'function' ? onEvent : null;
    this.rect = null;
    this.source = '';
    this.hiddenSource = '';
  }

  get current() {
    return this.rect === null ? null : { ...this.rect };
  }

  emit(type, payload) {
    try {
      this.onEvent?.(type, payload);
    } catch {
      /* telemetry must never break subtitle placement */
    }
  }

  set(rect, source) {
    const normalized = normalizeGeometry(rect);
    if (normalized === null) return null;
    const changed = this.rect === null
      || this.source !== source
      || GEOMETRY_KEYS.some((key) => this.rect[key] !== normalized[key]);
    this.rect = normalized;
    this.source = source;
    this.hiddenSource = '';
    if (changed) this.emit('subtitle.geometry', { source, rect: { ...normalized } });
    return { ...normalized };
  }

  /** The display closed: keep the last rectangle and say so once. */
  keep() {
    if (this.rect === null || this.source === 'kept') return this.current;
    return this.set(this.rect, 'kept');
  }

  /** Fold one observation of the runtime into the record; returns the rectangle to place on. */
  observe(input = {}) {
    const resolution = resolveAvatarGeometry({ ...input, last: input.last ?? this.rect });
    if (resolution.rect === null) {
      if (resolution.hidden === true && this.hiddenSource !== resolution.source) {
        this.hiddenSource = resolution.source;
        this.emit('subtitle.geometry', { source: resolution.source, rect: null, hidden: true });
      }
      return null;
    }
    return this.set(resolution.rect, resolution.source);
  }
}

/** Work area of the monitor containing `geometry` (physical pixels) plus its DPI scale. */
export function probeSubtitleWorkArea(geometry = null, { exec = execFile } = {}) {
  const rect = normalizeGeometry(geometry);
  const x = rect === null ? 0 : Math.round(rect.left + rect.width / 2);
  const y = rect === null ? 0 : Math.round(rect.top + rect.height / 2);
  const script = [
    'Add-Type -Namespace SubtitleWin -Name Dpi -MemberDefinition \'[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();\'',
    '[void][SubtitleWin.Dpi]::SetProcessDPIAware()',
    'Add-Type -AssemblyName System.Windows.Forms, System.Drawing',
    `$p = New-Object System.Drawing.Point(${x}, ${y})`,
    '$wa = [System.Windows.Forms.Screen]::FromPoint($p).WorkingArea',
    // The process is DPI aware here, so the desktop DC reports physical pixels per inch. Dividing
    // by 96 gives the same DIP scale overlay.ps1's WPF window uses for font and text metrics.
    '$scale = 1.0',
    'try { $g = [System.Drawing.Graphics]::FromHwnd([IntPtr]::Zero); if ($null -ne $g -and $g.DpiX -gt 0) { $scale = [double]$g.DpiX / 96.0 }; if ($null -ne $g) { $g.Dispose() } } catch { }',
    '@{ left = $wa.Left; top = $wa.Top; width = $wa.Width; height = $wa.Height; dpiScale = [Math]::Round($scale, 4) } | ConvertTo-Json -Compress',
  ].join('; ');
  return new Promise((resolve) => {
    exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10_000 }, (error, stdout) => {
      if (error) return resolve(null);
      try {
        const parsed = JSON.parse(String(stdout).trim() || '{}');
        const area = normalizeWorkArea(parsed);
        if (area === null) return resolve(null);
        const dpiScale = resolveDpiScale(parsed?.dpiScale);
        return resolve(dpiScale === null ? area : { ...area, dpiScale });
      } catch {
        return resolve(null);
      }
    });
  });
}

/**
 * Which caption line owns the screen.
 *
 * The visible line is shown as the ORIGINAL text as soon as its sentence starts playing; the
 * translated caption arrives later from its own stream. `begin()` claims the screen for one line
 * and returns its token; a repaint may only run while its token still owns the screen
 * (`owns`). When the next sentence, another lane or a hide takes over, the old token loses the
 * screen, so a translation that arrives late can never overwrite the newer line.
 */
export class SubtitleLineLedger {
  constructor() {
    this.active = null;
    this.sequence = 0;
  }

  /** Claim the screen for a new line; every earlier token stops owning it. */
  begin() {
    this.sequence += 1;
    this.active = { id: this.sequence };
    return this.active;
  }

  /** True only for the token that still owns the screen. */
  owns(line) {
    return line !== null && line !== undefined && line === this.active;
  }

  /**
   * Run one late update for `line` only while it still owns the screen. Returns what `paint`
   * returned, or `null` when the line was superseded (nothing is painted, nothing throws).
   */
  async repaint(line, paint) {
    if (!this.owns(line) || typeof paint !== 'function') return null;
    return paint(line);
  }

  /** The screen was taken away (hidden / interrupted): no pending repaint may resurrect it. */
  clear() {
    this.active = null;
  }
}

// ---- reading time -------------------------------------------------------------------------
// The post-audio hold is reading time, not a fixed timeout: a 40-character sentence needs far
// longer on screen than an 8-character one. CJK text counts one unit per glyph; Latin text
// counts one per word. Punctuation and whitespace are not reading units.

const READABLE_CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const READABLE_WORD_RE = /[\p{L}\p{N}]+/gu;
/** Milliseconds of reading time one unit (a CJK glyph or a Latin word) earns. */
export const SUBTITLE_READ_MS_PER_CHAR = 70;
/** The hold never drops below this: even a one-word line needs a moment to be read. */
export const SUBTITLE_HOLD_MIN_MS = 1200;
/** The hold never exceeds this: a long line must not pin the screen forever. */
export const SUBTITLE_HOLD_MAX_MS = 4000;

/** Reading units in `text`: CJK glyphs plus Latin/digit words, punctuation excluded. */
export function countReadable(text) {
  const value = String(text ?? '');
  const cjk = value.match(READABLE_CJK_RE) ?? [];
  const words = value.replace(READABLE_CJK_RE, ' ').match(READABLE_WORD_RE) ?? [];
  return cjk.length + words.length;
}

/**
 * The hold actually used: `clamp(max(configuredHoldMs, countReadable(text) * 70), 1200, 4000)`.
 * Returns the configured floor, the reading units and their raw reading time for the event row.
 */
export function readableHoldMs(text, configuredHoldMs = 0) {
  const chars = countReadable(text);
  const computed = chars * SUBTITLE_READ_MS_PER_CHAR;
  const configured = Number.isFinite(Number(configuredHoldMs))
    ? Math.max(0, Math.round(Number(configuredHoldMs)))
    : 0;
  const ms = Math.min(SUBTITLE_HOLD_MAX_MS, Math.max(SUBTITLE_HOLD_MIN_MS, Math.max(configured, computed)));
  return { ms, chars, computed };
}

/**
 * Post-audio hold for the visible caption.
 *
 * The line stays up for its reading time after its audio ended instead of vanishing with the
 * sound. A newer line replaces it in place (`cancel` before publishing), an interruption cancels
 * it at once, and re-showing the same line during the hold is a no-op that keeps its clock.
 */
export class SubtitleHold {
  constructor({ onHide = null, onEvent = null, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.onHide = typeof onHide === 'function' ? onHide : null;
    this.onEvent = typeof onEvent === 'function' ? onEvent : null;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.timer = null;
    this.text = '';
    this.line = null;
    this.generation = null;
  }

  get pending() {
    return this.timer !== null;
  }

  /**
   * Arm the hold. `waitMs` is the real delay (after playback ended), `holdMs` the reading time
   * actually granted; `chars`/`computed` are reported by the one observation row. Returns the
   * delay actually scheduled.
   */
  arm({ text = '', line = null, generation = null, waitMs = 0, holdMs = 0, chars = null, computed = null } = {}) {
    this.cancel();
    const delay = Math.max(0, Math.round(Number(waitMs) || 0));
    const readableChars = chars === null || chars === undefined
      ? countReadable(text)
      : (Number.isFinite(Number(chars)) ? Math.max(0, Math.round(Number(chars))) : countReadable(text));
    const readingMs = computed === null || computed === undefined
      ? readableChars * SUBTITLE_READ_MS_PER_CHAR
      : (Number.isFinite(Number(computed)) ? Math.max(0, Math.round(Number(computed)))
        : readableChars * SUBTITLE_READ_MS_PER_CHAR);
    this.text = text;
    this.line = line;
    this.generation = generation;
    this.timer = this.setTimer(() => {
      this.timer = null;
      try {
        this.onHide?.({ text, line, generation });
      } catch {
        /* a hide hook must never break the hold */
      }
    }, delay);
    this.timer?.unref?.();
    try {
      this.onEvent?.('subtitle.hold', {
        ms: Math.max(0, Math.round(Number(holdMs) || 0)),
        chars: readableChars,
        computed: readingMs,
      });
    } catch {
      /* telemetry only */
    }
    return delay;
  }

  /** True when `text` is already held: a repeated show repaints nothing and re-times nothing. */
  covers(text) {
    return this.timer !== null && this.text === text;
  }

  cancel() {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }
}

export class SubtitleOverlay {
  constructor({ dir, scriptPath, config = {}, spawnProcess = spawn, fsOps = DEFAULT_FS, onEvent = null, workArea = null, probeWorkArea = probeSubtitleWorkArea, dpiScale = null }) {
    this.dir = dir;
    this.scriptPath = scriptPath;
    this.spawnProcess = spawnProcess;
    this.fs = fsOps;
    this.child = null;
    this.starting = null;
    this.onEvent = typeof onEvent === 'function' ? onEvent : null;
    /** Injected work area (tests) or `null` to probe the monitor of the avatar rectangle. */
    this.workArea = normalizeWorkArea(workArea);
    /** Injected display scale (tests); production takes it from the work-area probe. */
    this.dpiScale = resolveDpiScale(dpiScale);
    this.probeWorkArea = typeof probeWorkArea === 'function' ? probeWorkArea : null;
    this.lastBubble = null;
    /** Last fallback placement announced, so a steady overflow reports once, not per line. */
    this.lastPlacementFallback = '';
    this.config = {
      font: 'Microsoft YaHei UI',
      sizeMax: 32,
      bg: '#1f2430',
      fg: '#ffffff',
      colorMode: 'auto',
      pageMs: BUBBLE_PAGE_MS,
      ...config,
    };
    this.sampledFor = '';
    this.sampledAt = 0;
    this.lastError = '';
    /**
     * Serialises state publications. A show computes its state across several awaits (probe,
     * palette); without this chain its rename could land after a newer hide's `hidden` write.
     */
    this.writeChain = Promise.resolve();
    /** Highest generation claimed by a show/hide; a lower generation is stale at write time. */
    this.publishGeneration = 0;
    this.lastDropAt = 0;
  }

  get statePath() {
    return join(this.dir, 'state.json');
  }

  get selectionPath() {
    return join(this.dir, 'selection.json');
  }

  get running() {
    return this.child !== null;
  }

  /**
   * Start the overlay once. Concurrent callers share the in-flight launch promise: without that
   * dedupe, two `show()` calls during startup would each spawn a second WPF process.
   */
  async ensure() {
    if (this.child !== null) return;
    if (this.starting !== null) return this.starting;
    this.starting = this.launch();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async launch() {
    await this.fs.mkdir(this.dir, { recursive: true });
    await this.writeState({ mode: 'hidden' });
    this.child = this.spawnProcess(
      'powershell',
      ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath, '-Dir', this.dir],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    this.lastError = '';
    this.child.stderr.on('data', (chunk) => {
      this.lastError = `${chunk}`.trim().slice(-400);
    });
    this.child.once('close', () => {
      this.child = null;
    });
    // Give WPF a moment to create the window before the first show.
    await new Promise((resolve) => setTimeout(resolve, 900));
  }

  async writeState(state) {
    await this.fs.mkdir(this.dir, { recursive: true });
    // A per-call temporary name: concurrent show/hide writes must never share (and overwrite)
    // one `${statePath}.tmp`, which could publish a half-written or crossed state file.
    const tmp = `${this.statePath}.${process.pid}.${(stateWriteSeq += 1)}.tmp`;
    try {
      await this.fs.writeFile(tmp, JSON.stringify(state), 'utf8');
      await this.fs.rename(tmp, this.statePath);
    } finally {
      await this.fs.rm(tmp, { force: true }).catch(() => {});
    }
  }

  /**
   * Claim a publication generation before the first await. A newer hide/show moves the high-water
   * mark, so a show that started earlier is already outranked when it finally reaches the write.
   */
  claimGeneration(generation) {
    const value = Number(generation);
    if (Number.isFinite(value) && value > this.publishGeneration) this.publishGeneration = value;
    return Number.isFinite(value) ? value : null;
  }

  /** Report one dropped publication; the event is throttled so a burst adds a single log line. */
  dropStale() {
    const now = Date.now();
    if (now - this.lastDropAt < PUBLISH_DROP_THROTTLE_MS) return;
    this.lastDropAt = now;
    this.notify('subtitle.publish.dropped', { reason: 'stale-generation' });
  }

  /**
   * Queue one state write and validate the generation when the queue reaches it — not when the
   * show began. `isCurrent` folds in the host's epoch/session checks. Either failing means the
   * line was superseded while it waited for the probe, so nothing is written at all.
   */
  async publish(state, { generation = null, isCurrent = null } = {}) {
    const run = this.writeChain.then(async () => {
      if (generation !== null && generation < this.publishGeneration) {
        this.dropStale();
        return false;
      }
      if (typeof isCurrent === 'function' && isCurrent() !== true) {
        this.dropStale();
        return false;
      }
      await this.writeState(state);
      return true;
    });
    // Keep the chain alive after a failed write; the caller still sees the rejection.
    this.writeChain = run.then(() => {}, () => {});
    return run;
  }

  /** Show `text` inside `region` (screen pixels); `colors` overrides auto contrast. */
  async show(text, region, colors = null, { generation = null, isCurrent = null } = {}) {
    // Claim before the first await: a hide issued while this call is still probing outranks it.
    const claimed = this.claimGeneration(generation);
    await this.ensure();
    if (colors !== null) {
      this.config.bg = colors.bg;
      this.config.fg = colors.fg;
    } else if (this.config.colorMode === 'auto' && (this.sampledFor !== this.regionKey(region) || this.sampledAt === 0)) {
      const luma = await sampleLuma(region);
      const pair = contrastPair(luma);
      this.config.bg = pair.bg;
      this.config.fg = pair.fg;
      this.sampledFor = this.regionKey(region);
      this.sampledAt = Date.now();
    }
    return this.publish({
      mode: 'text',
      text,
      region,
      font: this.config.font,
      sizeMax: this.config.sizeMax,
      bg: this.config.bg,
      fg: this.config.fg,
    }, { generation: claimed, isCurrent });
  }

  regionKey(region) {
    return `${region.x},${region.y},${region.w},${region.h}`;
  }

  notify(type, payload) {
    try {
      this.onEvent?.(type, payload);
    } catch {
      /* a telemetry sink must never break rendering */
    }
  }

  /**
   * Show `text` as a bubble anchored on the unified avatar geometry. The host passes the
   * rectangle; the overlay never reads the WPF layer's state.json. Returns the layout so the
   * caller can log the clamp (also emitted here as `subtitle.height.clamped`); a fallback to the
   * other side is emitted here once as `subtitle.placement.fallback`.
   */
  async showBubble(text, geometry, {
    colors = null,
    workArea = null,
    dpiScale = null,
    generation = null,
    isCurrent = null,
  } = {}) {
    // Claim before the probe: the generation must rank this show from its very first await.
    const claimed = this.claimGeneration(generation);
    await this.ensure();
    const area = workArea ?? this.workArea
      ?? (this.probeWorkArea === null ? null : await this.probeWorkArea(geometry).catch(() => null));
    const scale = resolveDpiScale(dpiScale)
      ?? resolveDpiScale(area?.dpiScale)
      ?? this.dpiScale;
    const layout = bubbleLayout(text, geometry, {
      workArea: area,
      font: this.config.font,
      size: this.config.sizeMax,
      pageMs: this.config.pageMs,
      dpiScale: scale,
    });
    if (layout === null) return null;
    if (colors !== null) {
      this.config.bg = colors.bg;
      this.config.fg = colors.fg;
    } else if (this.config.colorMode === 'auto') {
      const region = { x: layout.left, y: layout.geometry.top, w: layout.width, h: layout.geometry.height };
      const key = `bubble:${this.regionKey(region)}`;
      if (this.sampledFor !== key || this.sampledAt === 0) {
        const luma = await sampleLuma(region);
        const pair = contrastPair(luma);
        this.config.bg = pair.bg;
        this.config.fg = pair.fg;
        this.sampledFor = key;
        this.sampledAt = Date.now();
      }
    }
    const published = await this.publish({
      mode: 'text',
      layout: 'bubble',
      // The overlay re-measures this full text with WPF and owns the final page split; `pages`
      // stays as the host estimate used for the display budget and for older overlays.
      text: layout.text,
      pages: layout.pages,
      pageMs: layout.pageMs,
      geometry: layout.geometry,
      left: layout.left,
      // `side` tells the overlay which edge is fixed: 'below' and 'inside' anchor on `top`,
      // otherwise on `bottom`. `maxHeight` is the room on that side, in physical pixels.
      // 'inside' draws a semi-transparent black veil using `bgAlpha` (never a fully opaque box).
      side: layout.side,
      top: layout.top,
      bottom: layout.bottom,
      width: layout.width,
      height: layout.height,
      maxHeight: layout.maxHeight,
      requestedHeight: layout.requestedHeight,
      font: this.config.font,
      sizeMax: this.config.sizeMax,
      bg: this.config.bg,
      fg: this.config.fg,
      bgAlpha: layout.side === 'inside' ? BUBBLE_INSIDE_ALPHA : 255,
    }, { generation: claimed, isCurrent });
    if (published !== true) return null; // superseded while probing: the screen keeps its newer state
    this.lastBubble = layout;
    const fallbackKey = layout.fallback === null
      ? ''
      : `${layout.fallback.side}:${layout.fallback.available}`;
    if (fallbackKey !== this.lastPlacementFallback) {
      this.lastPlacementFallback = fallbackKey;
      if (layout.fallback !== null) this.notify('subtitle.placement.fallback', { ...layout.fallback });
    }
    if (layout.clamped) {
      this.notify('subtitle.height.clamped', { requested: layout.requestedHeight, clamped: layout.height });
    }
    return layout;
  }

  async hide({ generation = null } = {}) {
    // A hide is never itself dropped: it is the newer intent, and the queue puts its write after
    // any show that was already mid-flight. Claiming still outranks shows that started earlier.
    this.claimGeneration(generation);
    if (this.child === null) return false;
    return this.publish({ mode: 'hidden' });
  }

  /** Enter drag-to-select mode; resolves with the picked rectangle or null on timeout. */
  async select(timeoutMs = SELECT_TIMEOUT_MS) {
    await this.ensure();
    await this.fs.rm(this.selectionPath, { force: true });
    await this.writeState({ mode: 'select' });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      try {
        const raw = await this.fs.readFile(this.selectionPath, 'utf8');
        const rect = JSON.parse(raw);
        if (rect.cancelled === true) {
          await this.fs.rm(this.selectionPath, { force: true });
          await this.hide();
          return null;
        }
        if (rect.w > 8 && rect.h > 8) {
          await this.fs.rm(this.selectionPath, { force: true });
          // The picker acknowledged the state; return to hidden so a later select starts fresh.
          await this.hide();
          return rect;
        }
      } catch {
        /* not picked yet */
      }
    }
    await this.hide();
    return null;
  }

  async stop() {
    await this.hide().catch(() => {});
    if (this.child !== null) {
      try {
        this.child.kill();
      } catch {
        /* already gone */
      }
      this.child = null;
    }
  }
}
