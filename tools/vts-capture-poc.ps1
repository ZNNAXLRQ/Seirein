# Proof of concept: capture the VTube Studio window via PrintWindow (works even when occluded),
# then key out the background color sampled at a corner and save a transparent PNG.
param(
  [string]$Out = "$env:TEMP\vts-capture.png",
  [string]$TitleLike = 'VTube Studio'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing, System.Windows.Forms

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class Win {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$target = [IntPtr]::Zero
$found = New-Object System.Text.StringBuilder 256
$callback = {
  param($hwnd, $lparam)
  if (-not [Win]::IsWindowVisible($hwnd)) { return $true }
  [void][Win]::GetWindowText($hwnd, $found, 256)
  $text = $found.ToString()
  if ($text -like "*$TitleLike*") {
    $script:target = $hwnd
    $script:foundTitle = $text
    return $false
  }
  return $true
}
[void][Win]::EnumWindows($callback, [IntPtr]::Zero)

if ($script:target -eq [IntPtr]::Zero) { throw "VTS window not found (title like '$TitleLike')" }
"window: $($script:foundTitle)"

$rect = New-Object Win+RECT
[void][Win]::GetWindowRect($script:target, [ref]$rect)
$w = $rect.Right - $rect.Left
$h = $rect.Bottom - $rect.Top
"rect: $($rect.Left),$($rect.Top) ${w}x${h}"

$bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
# 2 = PW_RENDERFULLCONTENT (captures DWM-composited content, works when occluded)
$ok = [Win]::PrintWindow($script:target, $hdc, 2)
$g.ReleaseHdc($hdc)
$g.Dispose()
"printwindow: $ok"

# Sample the background colour from a corner and make it transparent.
$key = $bmp.GetPixel(4, 4)
"key colour: $($key.R),$($key.G),$($key.B)"
$count = 0
for ($y = 0; $y -lt $h; $y += 1) {
  for ($x = 0; $x -lt $w; $x += 1) {
    $p = $bmp.GetPixel($x, $y)
    if ([Math]::Abs($p.R - $key.R) -le 12 -and [Math]::Abs($p.G - $key.G) -le 12 -and [Math]::Abs($p.B - $key.B) -le 12) {
      $bmp.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(0, 0, 0, 0))
      $count++
    }
  }
}
"keyed pixels: $count"
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
"saved: $Out"
