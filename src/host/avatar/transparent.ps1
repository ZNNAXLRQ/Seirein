param(
  [int]$Left = 200,
  [int]$Top = 200,
  [int]$Width = 480,
  [int]$Height = 860,
  [int]$Seconds = 0,
  [string]$StateDir = '',
  # Chroma key of the VTS background. Defaults are the historical magenta/tolerance 60; the host
  # can pass another key when the VTS background was changed (see WPF_KEY in avatarLayer.js).
  [int]$KeyR = 255,
  [int]$KeyG = 0,
  [int]$KeyB = 255,
  [int]$KeyTolerance = 60
)

# Transparent avatar layer.
#
# VTube Studio draws its model on a magenta key colour (255,87,255) and lets DWM key it out.
# PrintWindow(PW_RENDERFULLCONTENT) still returns that raw surface even when the VTS window is
# moved offscreen, so this script mirrors the model into our own transparent, click-through,
# always-on-top window and chroma-keys the magenta away (plus the semi-transparent UI dots).
#
# This replaces the WGC plan on machines without a .NET SDK: same visible result, no native
# helper. See prototype/wgc/README.md for why the WGC route was not usable here.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
Add-Type -AssemblyName System.Drawing

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class MirrorNative {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hwnd, ref POINT point);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int height, uint flags);

  // Cheap per-tick signature of the raw frame: one FNV pass over every 8th pixel. Identical
  // signatures across several ticks are what tell a frozen capture from real content; coverage
  // alone cannot (a black background legitimately covers the whole client area).
  public static long FrameHash(Bitmap bmp) {
    var rect = new Rectangle(0, 0, bmp.Width, bmp.Height);
    var data = bmp.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    long hash = 1469598103934665603L;
    try {
      int stride = data.Stride, w = bmp.Width, h = bmp.Height;
      byte[] row = new byte[stride];
      for (int y = 0; y < h; y += 8) {
        Marshal.Copy(data.Scan0 + y * stride, row, 0, stride);
        for (int x = 0; x < w; x += 8) {
          int i = x * 4;
          hash ^= (long)row[i] | ((long)row[i + 1] << 8) | ((long)row[i + 2] << 16) | ((long)row[i + 3] << 24);
          hash *= 1099511628211L;
        }
      }
    } finally {
      bmp.UnlockBits(data);
    }
    return hash;
  }

  public static Bitmap Capture(IntPtr hwnd, int w, int h) {
    var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
    using (var g = Graphics.FromImage(bmp)) {
      IntPtr hdc = g.GetHdc();
      try { PrintWindow(hwnd, hdc, 2); } finally { g.ReleaseHdc(hdc); }
    }
    return bmp;
  }

  // key1 = the VTS background key; key2 = the semi-transparent overlay dots.
  // stripWidth > 0 additionally keys saturated pixels inside the right-hand strip, which is
  // where VTS parks its on-screen buttons (they are not magenta, so colour distance misses them).
  public static void Key(Bitmap bmp, int r1, int g1, int b1, int tol1, int r2, int g2, int b2, int tol2, int stripWidth) {
    var rect = new Rectangle(0, 0, bmp.Width, bmp.Height);
    var data = bmp.LockBits(rect, ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
    try {
      int stride = data.Stride;
      int w = bmp.Width, h = bmp.Height;
      int stripX = stripWidth > 0 ? Math.Max(0, w - stripWidth) : w;
      byte[] row = new byte[stride];
      for (int y = 0; y < h; y++) {
        Marshal.Copy(data.Scan0 + y * stride, row, 0, stride);
        for (int x = 0; x < w; x++) {
          int i = x * 4;
          int b = row[i], g = row[i + 1], r = row[i + 2];
          int d1 = Math.Abs(r - r1) + Math.Abs(g - g1) + Math.Abs(b - b1);
          int d2 = Math.Abs(r - r2) + Math.Abs(g - g2) + Math.Abs(b - b2);
          bool keyed = d1 <= tol1 || d2 <= tol2;
          if (!keyed && x >= stripX) {
            int max = Math.Max(r, Math.Max(g, b));
            int min = Math.Min(r, Math.Min(g, b));
            // Saturated and bright: the on-screen buttons; model pixels are rarely that pure.
            keyed = max > 150 && (max - min) > 90;
          }
          if (keyed) {
            row[i + 3] = (byte)0;
            continue;
          }
          // Edge band: anti-aliased pixels are a blend of model colour and the key colour.
          // Estimate alpha from the distance to the key, then un-mix the key contribution so
          // the magenta fringe disappears instead of being left behind.
          if (d1 <= tol1 * 4) {
            double alpha = (double)(d1 - tol1) / (double)(tol1 * 3.0);
            if (alpha < 0) alpha = 0;
            if (alpha > 1) alpha = 1;
            double inv = 1.0 - alpha;
            int rr = (int)Math.Round((r - inv * r1) / Math.Max(0.15, alpha));
            int gg = (int)Math.Round((g - inv * g1) / Math.Max(0.15, alpha));
            int bb = (int)Math.Round((b - inv * b1) / Math.Max(0.15, alpha));
            row[i] = (byte)Math.Max(0, Math.Min(255, bb));
            row[i + 1] = (byte)Math.Max(0, Math.Min(255, gg));
            row[i + 2] = (byte)Math.Max(0, Math.Min(255, rr));
            row[i + 3] = (byte)(alpha * 255);
            continue;
          }
          row[i + 3] = (byte)255;
        }
        Marshal.Copy(row, 0, data.Scan0 + y * stride, stride);
      }
    } finally {
      bmp.UnlockBits(data);
    }
  }

  public static Rectangle Bounds(Bitmap bmp, int pad) {
    var rect = new Rectangle(0, 0, bmp.Width, bmp.Height);
    var data = bmp.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    int minX = bmp.Width, minY = bmp.Height, maxX = -1, maxY = -1;
    try {
      int stride = data.Stride, w = bmp.Width, h = bmp.Height;
      byte[] row = new byte[stride];
      for (int y = 0; y < h; y += 2) {
        Marshal.Copy(data.Scan0 + y * stride, row, 0, stride);
        for (int x = 0; x < w; x += 2) {
          if (row[x * 4 + 3] == 0) continue;
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    } finally {
      bmp.UnlockBits(data);
    }
    if (maxX < 0) return Rectangle.Empty;
    int x0 = Math.Max(0, minX - pad);
    int y0 = Math.Max(0, minY - pad);
    int x1 = Math.Min(bmp.Width, maxX + pad);
    int y1 = Math.Min(bmp.Height, maxY + pad);
    return Rectangle.FromLTRB(x0, y0, x1, y1);
  }
}
"@
[void][MirrorNative]::SetProcessDPIAware()
try { [void][MirrorNative]::SetThreadDpiAwarenessContext([IntPtr](-4)) } catch { }

$proc = Get-Process -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName -like '*VTube*' } |
  Select-Object -First 1
if ($null -eq $proc) { Write-Output 'no-vts'; exit 1 }
$hwnd = $proc.MainWindowHandle
$r = New-Object MirrorNative+RECT
[void][MirrorNative]::GetWindowRect($hwnd, [ref]$r)
$srcW = $r.Right - $r.Left
$srcH = $r.Bottom - $r.Top

# PrintWindow grabs the whole window including the title bar; keep only the client area.
$client = New-Object MirrorNative+RECT
[void][MirrorNative]::GetClientRect($hwnd, [ref]$client)
$origin = New-Object MirrorNative+POINT
[void][MirrorNative]::ClientToScreen($hwnd, [ref]$origin)
$offX = [Math]::Max(0, $origin.X - $r.Left)
$offY = [Math]::Max(0, $origin.Y - $r.Top)
# Raw values: zero means "VTS cannot be captured" and must not be clamped into a valid frame.
$rawClientW = $client.Right - $client.Left
$rawClientH = $client.Bottom - $client.Top
$clientW = [Math]::Max(1, $rawClientW)
$clientH = [Math]::Max(1, $rawClientH)

# ---- transparent, click-through, always-on-top window -------------------
$window = New-Object System.Windows.Window
$window.WindowStyle = 'None'
$window.AllowsTransparency = $true
$window.Background = [System.Windows.Media.Brushes]::Transparent
$window.Topmost = $true
$window.ShowInTaskbar = $false
$window.ResizeMode = 'NoResize'
$window.Left = $Left
$window.Top = $Top
$window.Width = $Width
$window.Height = $Height

$image = New-Object System.Windows.Controls.Image
$image.Stretch = 'Uniform'
[System.Windows.Media.RenderOptions]::SetBitmapScalingMode($image, [System.Windows.Media.BitmapScalingMode]::HighQuality)
$window.Content = $image
$window.Show()

$handle = (New-Object System.Windows.Interop.WindowInteropHelper($window)).Handle
# WPF properties are DIPs; the host contract is physical pixels. Apply native bounds after HWND
# creation instead of assuming a 1:1 DIP mapping on every monitor.
function Set-PhysicalBounds($box) {
  $actual = New-Object MirrorNative+RECT
  [void][MirrorNative]::GetWindowRect($handle, [ref]$actual)
  $x = $actual.Left; $y = $actual.Top
  $w = $actual.Right - $actual.Left; $h = $actual.Bottom - $actual.Top
  if ($null -ne $box.left) { $x = [int]$box.left }
  if ($null -ne $box.top) { $y = [int]$box.top }
  if ($null -ne $box.width) { $w = [int]$box.width }
  if ($null -ne $box.height) { $h = [int]$box.height }
  [void][MirrorNative]::SetWindowPos($handle, [IntPtr]::Zero, $x, $y, $w, $h, 0x0014)
}
Set-PhysicalBounds @{ left=$Left; top=$Top; width=$Width; height=$Height }
$ex = [MirrorNative]::GetWindowLong($handle, -20)
$ex = $ex -bor 0x00000020 -bor 0x00000080 -bor 0x08000000  # TRANSPARENT | TOOLWINDOW | NOACTIVATE
[void][MirrorNative]::SetWindowLong($handle, -20, $ex)

$script:lastBounds = [System.Drawing.Rectangle]::Empty

# ---- edit mode: drag + wheel resize, geometry persisted to state.json ----------
$statePath = if ($StateDir) { Join-Path $StateDir 'state.json' } else { '' }
# Corner diagnostics: sample the raw frame before keying and persist it next to state.json, so a
# black frame can be told apart from a key colour that does not match VTS's real background. The
# host passes -StateDir with this launch (avatarLayer.js); a spawn without it writes nothing.
$cornerDir = $StateDir
$script:cornerFrames = 0
$script:lastSignature = 0
$script:identicalFrames = 0
$script:editMode = $false
$script:dragging = $false
$script:dragStart = $null
$script:winStart = $null

# DPI scale of the display the window currently renders on (physical pixels per DIP).
function Get-DipScale {
  $source = [System.Windows.PresentationSource]::FromVisual($window)
  if ($null -eq $source) { return 1.0 }
  $scale = $source.CompositionTarget.TransformToDevice.M11
  if ($null -eq $scale -or $scale -le 0) { return 1.0 }
  return [double]$scale
}

function Apply-EditMode([bool]$enabled) {
  $ex = [MirrorNative]::GetWindowLong($handle, -20)
  if ($enabled) {
    $ex = $ex -band (-bnot 0x00000020)   # drop click-through so the window receives the mouse
  } else {
    $ex = $ex -bor 0x00000020
  }
  [void][MirrorNative]::SetWindowLong($handle, -20, $ex)
  $window.Cursor = if ($enabled) { [System.Windows.Input.Cursors]::SizeAll } else { [System.Windows.Input.Cursors]::Arrow }
}

function Save-State {
  if (-not $statePath) { return }
  $actual = New-Object MirrorNative+RECT
  [void][MirrorNative]::GetWindowRect($handle, [ref]$actual)
  $obj = @{ left = $actual.Left; top = $actual.Top; width = ($actual.Right - $actual.Left); height = ($actual.Bottom - $actual.Top) } | ConvertTo-Json -Compress
  try {
    [System.IO.File]::WriteAllText($statePath, $obj, (New-Object System.Text.UTF8Encoding($false)))
  } catch { }
}

$window.add_MouseLeftButtonDown({
  if (-not $script:editMode) { return }
  # DragMove follows the cursor in screen space, so the window can be dragged anywhere;
  # the old manual delta maths was relative to the moving window and capped the travel.
  try { $window.DragMove() } catch { }
  Save-State
})
$window.add_MouseMove({
  if (-not $script:dragging) { return }
  $p = [System.Windows.Input.Mouse]::GetPosition($window)
  $window.Left = $script:winStart.left + ($p.X - $script:dragStart.X)
  $window.Top = $script:winStart.top + ($p.Y - $script:dragStart.Y)
})
$window.add_MouseLeftButtonUp({
  if (-not $script:dragging) { return }
  $script:dragging = $false
  Save-State
})
$window.add_MouseWheel({
  if (-not $script:editMode) { return }
  $delta = $_.Delta / 120.0
  $ratio = $window.Height / [Math]::Max(1.0, $window.Width)
  $newWidth = [Math]::Max(160, [Math]::Min(1200, $window.Width + $delta * 30))
  $window.Width = $newWidth
  $window.Height = $newWidth * $ratio
  Save-State
})
Apply-EditMode $false

$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(90)
$timer.add_Tick({
  try {
    if ($statePath -and (Test-Path $statePath)) {
      try {
        $st = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($null -ne $st.editMode -and [bool]$st.editMode -ne $script:editMode) {
          $script:editMode = [bool]$st.editMode
          Apply-EditMode $script:editMode
        }
        if (-not $script:dragging) {
          Set-PhysicalBounds $st
        }
      } catch { }
    }
    # A hidden window or a zero-size client cannot be captured: keep the last good frame. This is a
    # real condition, unlike "the content covers the frame", which a black background always does.
    if (-not [MirrorNative]::IsWindowVisible($hwnd) -or $rawClientW -le 0 -or $rawClientH -le 0) {
      return
    }
    $full = [MirrorNative]::Capture($hwnd, $srcW, $srcH)
    $cropRect = New-Object System.Drawing.Rectangle -ArgumentList $offX, $offY, $clientW, $clientH
    $bmp = $full.Clone($cropRect, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $full.Dispose()
    # Frozen-frame evidence: identical raw pixels across ticks. A static model is fine, so this only
    # disqualifies a *covering* frame (see below), where keeping the previous one looks the same.
    $signature = [MirrorNative]::FrameHash($bmp)
    if ($signature -eq $script:lastSignature) {
      $script:identicalFrames += 1
    } else {
      $script:lastSignature = $signature
      $script:identicalFrames = 1
    }
    # Diagnostic only, before keying: the unkeyed corners show the real VTS background. A magenta
    # corner means the historical key still matches; black means VTS is on a transparent background.
    $script:cornerFrames = ($script:cornerFrames + 1) % 12
    if ($cornerDir -and $script:cornerFrames -eq 1) {
      try {
        $tl = $bmp.GetPixel(0, 0)
        $br = $bmp.GetPixel([Math]::Max(0, $bmp.Width - 1), [Math]::Max(0, $bmp.Height - 1))
        $corners = @{
          topLeft = @{ r = [int]$tl.R; g = [int]$tl.G; b = [int]$tl.B }
          bottomRight = @{ r = [int]$br.R; g = [int]$br.G; b = [int]$br.B }
          width = [int]$bmp.Width
          height = [int]$bmp.Height
          key = @{ r = [int]$KeyR; g = [int]$KeyG; b = [int]$KeyB; tolerance = [int]$KeyTolerance }
          identicalFrames = [int]$script:identicalFrames
          visible = [bool][MirrorNative]::IsWindowVisible($hwnd)
          at = (Get-Date).ToUniversalTime().ToString('o')
        } | ConvertTo-Json -Compress -Depth 5
        [System.IO.Directory]::CreateDirectory($cornerDir) | Out-Null
        [System.IO.File]::WriteAllText((Join-Path $cornerDir 'capture.json'), $corners, (New-Object System.Text.UTF8Encoding($false)))
      } catch { }
    }
    [MirrorNative]::Key($bmp, $KeyR, $KeyG, $KeyB, $KeyTolerance, 255, 146, 255, 20, 120)
    $bounds = [MirrorNative]::Bounds($bmp, 10)
    # When PrintWindow fails (e.g. DWM stopped composing an off-screen window), the frame comes
    # back as one static opaque rectangle. A *single* such frame is legitimate (a black VTS
    # background really does cover the client area), so only a full-frame picture that stayed
    # pixel-identical for several ticks is treated as frozen - never coverage on its own.
    $covering = ($bounds.Width * $bounds.Height) -ge ($clientW * $clientH * 0.95)
    if ($covering -and $script:identicalFrames -ge 3 -and $null -ne $script:bitmap) {
      $bmp.Dispose()
      return
    }
    if ($bounds.Width -gt 20 -and $bounds.Height -gt 20) {
      # Dominant model colour for the subtitle bubble: average opaque pixels of the keyed frame
      # (before LockBits, because GetPixel throws on a locked bitmap). Written twice a second.
      if ($null -eq $script:paletteFrames) { $script:paletteFrames = 0 }
      $script:paletteFrames = ($script:paletteFrames + 1) % 12
      if ($script:paletteFrames -eq 0 -and $statePath) {
        try {
          $sumR = 0; $sumG = 0; $sumB = 0; $n = 0
          for ($y = $bounds.Top; $y -lt $bounds.Bottom; $y += 12) {
            for ($x = $bounds.Left; $x -lt $bounds.Right; $x += 12) {
              $px = $bmp.GetPixel($x, $y)
              if ($px.A -gt 200) { $sumR += $px.R; $sumG += $px.G; $sumB += $px.B; $n++ }
            }
          }
          if ($n -gt 0) {
            $pal = @{ r = [int]($sumR / $n); g = [int]($sumG / $n); b = [int]($sumB / $n) } | ConvertTo-Json -Compress
            [System.IO.File]::WriteAllText((Join-Path (Split-Path $statePath) 'palette.json'), $pal, (New-Object System.Text.UTF8Encoding($false)))
          }
        } catch { }
      }
      # Display the whole client frame at 1:1 (cropping + stretching changed the model size).
      $crop = $bmp
      $data = $crop.LockBits((New-Object System.Drawing.Rectangle -ArgumentList 0, 0, $crop.Width, $crop.Height), [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
      try {
        if ($null -eq $script:bitmap -or $script:bitmap.PixelWidth -ne $crop.Width -or $script:bitmap.PixelHeight -ne $crop.Height) {
          $script:bitmap = New-Object System.Windows.Media.Imaging.WriteableBitmap -ArgumentList $crop.Width, $crop.Height, 96, 96, ([System.Windows.Media.PixelFormats]::Bgra32), $null
          $image.Source = $script:bitmap
        }
        $script:bitmap.WritePixels((New-Object System.Windows.Int32Rect -ArgumentList 0, 0, $crop.Width, $crop.Height), $data.Scan0, $data.Stride * $crop.Height, $data.Stride)
      } finally {
        $crop.UnlockBits($data)
        $crop.Dispose()
      }
    }
    $bmp.Dispose()
  } catch {
    # keep the previous frame on a transient capture failure
  }
})
$timer.Start()

if ($Seconds -gt 0) {
  $stop = New-Object System.Windows.Threading.DispatcherTimer
  $stop.Interval = [TimeSpan]::FromSeconds($Seconds)
  $stop.add_Tick({ $stop.Stop(); $timer.Stop(); $window.Close(); [System.Windows.Threading.Dispatcher]::CurrentDispatcher.InvokeShutdown() })
  $stop.Start()
}

[System.Windows.Threading.Dispatcher]::Run()
