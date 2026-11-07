# Capture the VTS window region from the screen (model included) and key out the magenta
# background. PoC for the transparent desktop layer.
param(
  [string]$Out = "$env:TEMP\vts-keyed.png",
  [string]$TitleLike = 'VTube Studio'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class Win2 {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$target = [IntPtr]::Zero
$buf = New-Object System.Text.StringBuilder 256
$cb = {
  param($hwnd, $lparam)
  if (-not [Win2]::IsWindowVisible($hwnd)) { return $true }
  [void][Win2]::GetWindowText($hwnd, $buf, 256)
  if ($buf.ToString() -like "*$TitleLike*") { $script:target = $hwnd; return $false }
  return $true
}
[void][Win2]::EnumWindows($cb, [IntPtr]::Zero)
if ($script:target -eq [IntPtr]::Zero) { throw 'VTS window not found' }

$rect = New-Object Win2+RECT
[void][Win2]::GetWindowRect($script:target, [ref]$rect)
$w = $rect.Right - $rect.Left
$h = $rect.Bottom - $rect.Top
"rect: $($rect.Left),$($rect.Top) ${w}x${h}"

$bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bmp.Size)
$g.Dispose()

# Key near-magenta to transparent (tolerant of compression/gamma).
$data = $bmp.LockBits((New-Object System.Drawing.Rectangle(0, 0, $w, $h)), [System.Drawing.Imaging.ImageLockMode]::ReadWrite, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$bytes = New-Object byte[] ($data.Stride * $h)
[System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
$keyed = 0
for ($i = 0; $i -lt $bytes.Length; $i += 4) {
  $b = $bytes[$i]; $gg = $bytes[$i + 1]; $r = $bytes[$i + 2]
  if ($r -ge 180 -and $b -ge 180 -and $gg -le 90) {
    $bytes[$i] = 0; $bytes[$i + 1] = 0; $bytes[$i + 2] = 0; $bytes[$i + 3] = 0
    $keyed++
  }
}
[System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $data.Scan0, $bytes.Length)
$bmp.UnlockBits($data)
"keyed pixels: $keyed / $(($w * $h))"
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
"saved: $Out"
