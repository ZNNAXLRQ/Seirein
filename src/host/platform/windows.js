/**
 * Window geometry helpers (Win32 via a short PowerShell script).
 *
 * The Host is a Node process with no window, so the VTube Studio window rectangle and the
 * virtual-screen bounds are read through user32. Results are physical pixels (the probe calls
 * SetProcessDPIAware first), matching the subtitle region coordinates.
 */
import { execFile } from 'node:child_process';

const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class WinProbe {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
}
"@
[WinProbe]::SetProcessDPIAware() | Out-Null
$screenW = [WinProbe]::GetSystemMetrics(0)
$screenH = [WinProbe]::GetSystemMetrics(1)
$p = Get-Process -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 -and ($_.ProcessName -like '*VTube*' -or $_.MainWindowTitle -like '*VTube*') } |
  Select-Object -First 1
if ($null -eq $p) {
  @{ found = $false; screen = @{ w = $screenW; h = $screenH } } | ConvertTo-Json -Compress
  exit 0
}
$r = New-Object WinProbe+RECT
[void][WinProbe]::GetWindowRect($p.MainWindowHandle, [ref]$r)
@{
  found = $true
  x = $r.Left
  y = $r.Top
  w = $r.Right - $r.Left
  h = $r.Bottom - $r.Top
  title = $p.MainWindowTitle
  process = $p.ProcessName
  screen = @{ w = $screenW; h = $screenH }
} | ConvertTo-Json -Compress
`;

/**
 * Locate the VTube Studio window and the virtual screen.
 * @returns {Promise<{found: boolean, x?: number, y?: number, w?: number, h?: number,
 *   title?: string, process?: string, screen: {w: number, h: number}} | null>}
 */
export function probeVtsWindow() {
  return new Promise((resolve) => {
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', SCRIPT],
      { windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024 },
      (error, stdout) => {
        if (error) return resolve(null);
        try {
          const parsed = JSON.parse(String(stdout).trim() || '{}');
          if (!parsed || typeof parsed !== 'object') return resolve(null);
          return resolve(parsed);
        } catch {
          return resolve(null);
        }
      },
    );
  });
}
