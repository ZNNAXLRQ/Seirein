/**
 * Real VTube Studio window control for the Spout backend.
 *
 * The WPF backend already owns the one supported way to move the real VTS window:
 * `src/host/platform/window-move.ps1` resolves the window by title and calls
 * `SetWindowPos(hwnd, NULL, x, y, w, h, SWP_NOACTIVATE | SWP_NOZORDER)`; `-Report` returns the
 * client rectangle in screen pixels. This module reuses that exact script (and the same argument
 * shape as `avatarLayer.moveVts` / `report`) instead of adding a second Win32 implementation.
 *
 * The Spout backend needs the same capability for three transitions:
 *   - entering Spout: remember where VTS was, then move it out of the visible area;
 *   - edit mode: stop the display process, put VTS back on screen so the user drags/resizes the
 *     real window, then read that rectangle and hide VTS again before the display process starts;
 *   - leaving Spout: move VTS back to the remembered rectangle.
 *
 * Every failure is a result code (`VTS_NOT_RUNNING`, `VTS_WINDOW_TIMEOUT`, …); nothing throws.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Same off-screen corner the WPF layer uses (`avatarLayer.js` `OFFSCREEN`). */
export const VTS_OFFSCREEN = Object.freeze({ x: -2200, y: -1400, width: 900, height: 1200 });

/**
 * First-run on-screen rectangle for edit mode: used only when VTS was never captured and no saved
 * `layer.spout.bounds` exists, so a fresh installation still gets a window it can drag.
 */
export const VTS_ONSCREEN = Object.freeze({ x: 80, y: 60, width: 900, height: 1000 });

const DEFAULT_SCRIPT = fileURLToPath(new URL('../../platform/window-move.ps1', import.meta.url));
const DEFAULT_TIMEOUT_MS = 4000;

/** `{x,y,width,height}` / `{left,top,…}` → rounded rectangle, or null. */
function normalizeRect(value) {
  if (value === null || typeof value !== 'object') return null;
  const x = Number(value.x ?? value.left);
  const y = Number(value.y ?? value.top);
  const width = Number(value.width);
  const height = Number(value.height);
  if (![x, y, width, height].every((part) => Number.isFinite(part))) return null;
  if (width <= 0 || height <= 0) return null;
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
}

export class VtsWindow {
  /**
   * @param {object} [options]
   * @param {string} [options.scriptPath] - `window-move.ps1` (overridable for tests).
   * @param {Function} [options.spawnProcess] - node:child_process spawn (overridable for tests).
   * @param {number} [options.timeoutMs] - hard cap for one PowerShell invocation.
   */
  constructor({ scriptPath = DEFAULT_SCRIPT, spawnProcess = spawn, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.scriptPath = scriptPath;
    this.spawnProcess = typeof spawnProcess === 'function' ? spawnProcess : spawn;
    this.timeoutMs = Math.max(250, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
  }

  /** One `window-move.ps1` invocation: `{ ok, code, stdout, stderr }`, never a rejection. */
  run(args) {
    return new Promise((resolvePromise) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      let timer = null;
      let child = null;
      const settle = (result) => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        resolvePromise(result);
      };
      try {
        child = this.spawnProcess(
          'powershell',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath, ...args],
          { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
        );
      } catch (error) {
        settle({ ok: false, code: 'VTS_WINDOW_SPAWN_FAILED', message: error?.message ?? String(error), stdout: '' });
        return;
      }
      child.stdout?.on('data', (chunk) => {
        stdout += `${chunk}`;
      });
      child.stderr?.on('data', (chunk) => {
        stderr = `${stderr}${chunk}`.slice(-400);
      });
      child.once('error', (error) => {
        settle({ ok: false, code: 'VTS_WINDOW_SPAWN_FAILED', message: error?.message ?? String(error), stdout });
      });
      child.once('close', (exitCode) => {
        settle({ ok: exitCode === 0, code: exitCode === 0 ? '' : 'VTS_WINDOW_FAILED', exitCode, stdout, stderr });
      });
      timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        settle({ ok: false, code: 'VTS_WINDOW_TIMEOUT', message: `window-move.ps1 超时（${this.timeoutMs} ms）`, stdout });
      }, this.timeoutMs);
    });
  }

  /** Read the VTS client rectangle (screen pixels). */
  async capture() {
    const result = await this.run(['-Report']);
    if (result.ok !== true) {
      // `no-vts` is the helper's explicit "window not found" answer, not a generic crash.
      if (String(result.stdout ?? '').includes('no-vts')) {
        return { ok: false, code: 'VTS_NOT_RUNNING', message: '未找到 VTube Studio 窗口' };
      }
      return { ok: false, code: result.code ?? 'VTS_WINDOW_FAILED', message: result.message ?? result.stderr ?? '' };
    }
    const lines = String(result.stdout ?? '').trim().split(/\r?\n/u).filter((line) => line.length > 0);
    if (lines.length === 0 || lines.at(-1).includes('no-vts')) {
      return { ok: false, code: 'VTS_NOT_RUNNING', message: '未找到 VTube Studio 窗口' };
    }
    try {
      const parsed = JSON.parse(lines.at(-1));
      const bounds = normalizeRect(parsed);
      if (bounds !== null) return { ok: true, bounds };
    } catch {
      /* fall through to a reported parse failure */
    }
    return { ok: false, code: 'VTS_WINDOW_UNREADABLE', message: '无法解析 VTS 窗口矩形' };
  }

  /**
   * Move (and resize) the VTS window with the same helper the WPF backend uses.
   *
   * `options.raise` is for the edit-recovery transition only: the helper restores a minimized
   * window, brings it in front of the editor and reports whether it could. A raise that failed is
   * returned as a failure code (`VTS_RAISE_FAILED`) - never as a move that silently left VTS
   * behind the editor. Ordinary moves (parking VTS, starting a display) omit it.
   */
  async move(bounds, options = {}) {
    const rect = normalizeRect(bounds);
    if (rect === null) return { ok: false, code: 'VTS_BOUNDS_INVALID', message: 'VTS 窗口矩形无效' };
    const raise = options?.raise === true;
    const args = [
      '-X', String(rect.x),
      '-Y', String(rect.y),
      '-W', String(rect.width),
      '-H', String(rect.height),
    ];
    if (raise) args.push('-Raise');
    const result = await this.run(args);
    const stdout = String(result?.stdout ?? '');
    if (stdout.includes('no-vts')) {
      return { ok: false, code: 'VTS_NOT_RUNNING', message: '未找到 VTube Studio 窗口' };
    }
    if (raise) {
      // The helper prints the re-read rectangle plus the raise outcome; exit 0 means it reported.
      const lines = stdout.trim().split(/\r?\n/u).filter((line) => line.length > 0);
      let parsed = null;
      try {
        parsed = JSON.parse(lines.at(-1) ?? '');
      } catch {
        parsed = null;
      }
      if (parsed !== null && parsed.ok === true && parsed.raised !== false) {
        return { ok: true, bounds: rect, raised: true, raiseCode: '' };
      }
      return {
        ok: false,
        code: parsed?.code || (parsed?.raiseCode ?? '') || 'VTS_RAISE_FAILED',
        message: parsed?.message ?? 'VTS 窗口已就位，但未能前置',
      };
    }
    if (result.ok !== true) {
      return { ok: false, code: result.code ?? 'VTS_MOVE_FAILED', message: result.message ?? result.stderr ?? '' };
    }
    return { ok: true, bounds: rect };
  }
}
