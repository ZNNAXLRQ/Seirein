param(
  [Parameter(Mandatory = $true)][string]$Dir
)

# Transparent, click-through subtitle overlay.
# Protocol is file based: the host writes <Dir>\state.json, we render it. In select mode we
# show a full-screen picker and write <Dir>\selection.json when the user releases the mouse.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Xaml, System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class SubtitleNative {
  public const int GWL_EXSTYLE = -20;
  public const int WS_EX_TRANSPARENT = 0x00000020;
  public const int WS_EX_TOOLWINDOW = 0x00000080;
  public const int WS_EX_NOACTIVATE = 0x08000000;
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  /** Physical screen pixels, independent of the WPF DIP scale. */
  public static int[] CursorPos() { POINT p; GetCursorPos(out p); return new int[] { p.X, p.Y }; }
}
"@

$statePath = Join-Path $Dir 'state.json'
$selPath = Join-Path $Dir 'selection.json'
$state = $null
$lastRaw = ''
$selecting = $false
$startPoint = $null
$startScreen = $null
$selectAcknowledged = $false
# Bubble rendering state: the host sends the full text plus the physical cap; WPF measures the
# real glyphs and owns the final line wrap, page split and page height. The 120 ms poll must not
# re-measure unchanged text, hence the render key.
$script:bubbleRaw = ''
$script:bubblePage = 0
$script:bubblePageAt = 0
$script:bubbleRendered = ''
$script:bubblePages = @()
$script:bubblePeriodMs = 2600

function Read-State {
  if (-not (Test-Path $statePath)) { return $null }
  try {
    $raw = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8
    if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
    if ($raw -eq $script:lastRaw) { return $script:state }
    $script:lastRaw = $raw
    $script:state = $raw | ConvertFrom-Json
    return $script:state
  } catch {
    return $script:state
  }
}

# ---- main window --------------------------------------------------------
$window = New-Object System.Windows.Window
$window.WindowStyle = 'None'
$window.AllowsTransparency = $true
$window.Background = [System.Windows.Media.Brushes]::Transparent
$window.Topmost = $true
$window.ShowInTaskbar = $false
$window.ResizeMode = 'NoResize'
$window.Left = -10000
$window.Top = -10000
$window.Width = 1
$window.Height = 1

$border = New-Object System.Windows.Controls.Border
$border.CornerRadius = [System.Windows.CornerRadius]::new(12)
$border.Padding = [System.Windows.Thickness]::new(14, 10, 14, 10)
$border.Background = [System.Windows.Media.Brushes]::Black
$border.Effect = $null

$textBlock = New-Object System.Windows.Controls.TextBlock
$textBlock.TextWrapping = 'Wrap'
$textBlock.TextAlignment = 'Center'
$textBlock.FontFamily = [System.Windows.Media.FontFamily]::new('Microsoft YaHei UI')
$textBlock.Foreground = [System.Windows.Media.Brushes]::White
$textBlock.VerticalAlignment = 'Center'
$border.Child = $textBlock
$window.Content = $border
$window.Show()

# Click-through + never steal focus.
$handle = (New-Object System.Windows.Interop.WindowInteropHelper($window)).Handle
$ex = [SubtitleNative]::GetWindowLong($handle, [SubtitleNative]::GWL_EXSTYLE)
$ex = $ex -bor [SubtitleNative]::WS_EX_TRANSPARENT -bor [SubtitleNative]::WS_EX_TOOLWINDOW -bor [SubtitleNative]::WS_EX_NOACTIVATE
[void][SubtitleNative]::SetWindowLong($handle, [SubtitleNative]::GWL_EXSTYLE, $ex)

function Get-DipScale {
  $source = [System.Windows.PresentationSource]::FromVisual($window)
  if ($null -eq $source) { return 1.0 }
  return $source.CompositionTarget.TransformToDevice.M11
}

function Set-WindowRect([double]$x, [double]$y, [double]$w, [double]$h) {
  $window.Left = $x
  $window.Top = $y
  $window.Width = [Math]::Max(1, $w)
  $window.Height = [Math]::Max(1, $h)
}

# Largest font size (<= requested) whose text fits the box; requested size is used when it fits.
function Fit-FontSize([string]$text, [double]$maxWidth, [double]$maxHeight, [double]$maxSize, [string]$family) {
  $size = [Math]::Max(6, $maxSize)
  while ($size -ge 6) {
    $formatted = New-Object System.Windows.Media.FormattedText(
      $text,
      [System.Globalization.CultureInfo]::CurrentUICulture,
      [System.Windows.FlowDirection]::LeftToRight,
      [System.Windows.Media.Typeface]::new($family),
      $size,
      [System.Windows.Media.Brushes]::White,
      [double]::PositiveInfinity
    )
    $formatted.MaxTextWidth = $maxWidth
    if ($formatted.Height -le $maxHeight -and $formatted.Width -le $maxWidth) { return $size }
    $size -= 1
  }
  return 6
}

# ---- bubble text measurement (DIP) --------------------------------------
# The host only estimates line count; the real advance and line height come from WPF. Measuring
# here means a page always fits the actual font at the actual DPI, and page slices partition the
# full text, so a host estimate made on another DPI can never cut the last sentences away.
function New-MeasureBlock([string]$family, [double]$size) {
  $block = New-Object System.Windows.Controls.TextBlock
  $block.TextWrapping = 'Wrap'
  $block.FontFamily = [System.Windows.Media.FontFamily]::new($family)
  $block.FontSize = $size
  return $block
}

function Measure-TextHeight($block, [string]$text, [double]$width) {
  $block.Text = $text
  $block.Measure([System.Windows.Size]::new($width, [double]::PositiveInfinity))
  return $block.DesiredSize.Height
}

# Largest prefix of $text whose measured height fits $available, then the same for the rest.
# A full-text measurement and an estimated page capacity keep the search near the boundary, so
# even a very long line costs only a handful of small measurements per page.
function Split-BubbleText([string]$text, [double]$width, [double]$available, [string]$family, [double]$size) {
  $block = New-MeasureBlock $family $size
  $total = Measure-TextHeight $block $text $width
  if ($total -le $available) { return $text }

  $lineHeight = Measure-TextHeight $block ([string][char]0x957F) $width
  if ($lineHeight -le 0) { $lineHeight = 1 }
  $totalLines = [Math]::Max(1, [Math]::Ceiling($total / $lineHeight))
  $linesPerPage = [Math]::Max(1, [Math]::Floor($available / $lineHeight))
  $guess = [Math]::Max(1, [int][Math]::Ceiling(($text.Length * $linesPerPage) / $totalLines))

  $pages = New-Object System.Collections.Generic.List[string]
  $rest = $text
  while ($rest.Length -gt 0) {
    $span = [Math]::Min($rest.Length, $guess)
    $best = 0
    if ((Measure-TextHeight $block $rest.Substring(0, $span) $width) -le $available) {
      $best = $span
      while ($best -lt $rest.Length) {
        $next = [Math]::Min($rest.Length, $best * 2)
        if ((Measure-TextHeight $block $rest.Substring(0, $next) $width) -le $available) {
          $best = $next
        } else {
          $low = $best + 1
          $high = $next - 1
          while ($low -le $high) {
            $middle = [int][Math]::Floor(($low + $high) / 2)
            if ((Measure-TextHeight $block $rest.Substring(0, $middle) $width) -le $available) {
              $best = $middle
              $low = $middle + 1
            } else {
              $high = $middle - 1
            }
          }
          break
        }
      }
    } else {
      $low = 1
      $high = $span - 1
      while ($low -le $high) {
        $middle = [int][Math]::Floor(($low + $high) / 2)
        if ((Measure-TextHeight $block $rest.Substring(0, $middle) $width) -le $available) {
          $best = $middle
          $low = $middle + 1
        } else {
          $high = $middle - 1
        }
      }
    }
    if ($best -le 0) { $best = 1 }
    if ($best -lt $rest.Length -and [char]::IsHighSurrogate($rest[$best - 1]) -and [char]::IsLowSurrogate($rest[$best])) { $best -= 1 }
    if ($best -le 0) { $best = 1 }
    # Prefer a natural break (newline or space) when one sits near the measured edge.
    $floor = [Math]::Max(1, [int][Math]::Floor($best * 0.75))
    for ($cursor = $best; $cursor -gt $floor; $cursor--) {
      $char = $rest[$cursor - 1]
      if ($char -eq "`n" -or [char]::IsWhiteSpace($char)) {
        $best = $cursor
        break
      }
    }
    $pages.Add($rest.Substring(0, $best))
    $rest = $rest.Substring($best)
    $guess = [Math]::Max(1, $best)
  }
  if ($pages.Count -eq 0) { $pages.Add('') }
  return $pages.ToArray()
}

# Full text from the host, measured and paginated against the physical work-area cap (converted
# to DIP with the same scale the window uses).
function Get-BubblePages($s) {
  $scale = Get-DipScale
  $dipWidth = [Math]::Max(1, [double]$s.width / $scale)
  $dipMax = if ($null -ne $s.maxHeight) { [double]$s.maxHeight / $scale } else { [double]::PositiveInfinity }
  $family = if ($s.font) { [string]$s.font } else { 'Microsoft YaHei UI' }
  $size = if ($s.sizeMax) { [double]$s.sizeMax } else { 32.0 }
  $full = [string]$s.text
  # Older hosts put only the first page in `text`; the pages array then holds the full line.
  $joined = (@($s.pages) -join '')
  if ($joined.Length -gt $full.Length) { $full = $joined }
  if ([string]::IsNullOrEmpty($full)) { return '' }
  if ([double]::IsPositiveInfinity($dipMax)) { return $full }
  $inner = [Math]::Max(20, $dipWidth - 28)
  $available = [Math]::Max(1, $dipMax - 20)
  return Split-BubbleText $full $inner $available $family $size
}

# Keep the host's page interval when WPF finds no more pages than the host estimated. If WPF
# needs more pages than the host counted, the hide timer (armed from the host count) would cut
# the tail, so shorten the interval just enough to fit every real page inside that same budget.
function Get-BubblePagePeriod($s, [int]$count) {
  $period = if ($s.pageMs) { [double]$s.pageMs } else { 2600 }
  if ($period -le 0) { $period = 2600 }
  $declared = @($s.pages).Count
  if ($declared -lt 1) { $declared = 1 }
  if ($count -le $declared) { return $period }
  return [Math]::Max(1, ($period * $declared) / $count)
}

# Bubble mode: the host sends the side to grow on. Normally left = geometry.left, bottom =
# geometry.top (the avatar window's TOP edge) and wrapped text grows upward from that edge. When
# the avatar sits at the work-area top, side = 'below': the window starts at `top` (the avatar
# window's BOTTOM edge) and grows downward. When neither side can hold a line, side = 'inside':
# the window starts at the avatar window's own top edge, keeps its width and grows downward over
# a semi-transparent black veil (alpha = bgAlpha, default 200) so the model stays visible. The
# host-provided maxHeight caps every side; WPF measures each page's real height.
function Apply-BubbleState($s) {
  $scale = Get-DipScale
  $dipLeft = [double]$s.left / $scale
  $below = ($s.side -eq 'below' -and $null -ne $s.top)
  $inside = ($s.side -eq 'inside' -and $null -ne $s.top)
  $dipTop = if ($below -or $inside) { [double]$s.top / $scale } else { 0.0 }
  $dipBottom = if ($below -or $inside) { 0.0 } else { [double]$s.bottom / $scale }
  $dipWidth = [Math]::Max(1, [double]$s.width / $scale)
  $dipMax = if ($null -ne $s.maxHeight) { [double]$s.maxHeight / $scale } else { [double]::PositiveInfinity }

  if ($script:bubblePages.Count -eq 0) { $script:bubblePages = @(Get-BubblePages $s) }
  $index = [Math]::Max(0, [Math]::Min([int]$script:bubblePage, $script:bubblePages.Count - 1))
  $renderKey = "$($script:lastRaw)|$index"
  if ($script:bubbleRendered -eq $renderKey) { return }
  $script:bubbleRendered = $renderKey

  $text = [string]$script:bubblePages[$index]
  $textBlock.Text = $text
  $family = if ($s.font) { [string]$s.font } else { 'Microsoft YaHei UI' }
  $textBlock.FontFamily = [System.Windows.Media.FontFamily]::new($family)
  $textBlock.FontSize = if ($s.sizeMax) { [double]$s.sizeMax } else { 32.0 }
  $textBlock.TextTrimming = 'None'
  if ($s.fg) { $textBlock.Foreground = Convert-Brush $s.fg } else { $textBlock.Foreground = [System.Windows.Media.Brushes]::White }
  if ($inside) {
    # Semi-transparent black veil: readable over the model, but the avatar stays visible through
    # it. The window itself is still WS_EX_TRANSPARENT + WS_EX_NOACTIVATE, so clicks pass through.
    $alpha = if ($null -ne $s.bgAlpha) { [int]$s.bgAlpha } else { 200 }
    $alpha = [Math]::Max(0, [Math]::Min(255, $alpha))
    $border.Background = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Color]::FromArgb($alpha, 0, 0, 0))
    $textBlock.Foreground = [System.Windows.Media.Brushes]::White
  } elseif ($s.bg) {
    $border.Background = Convert-Brush $s.bg
  } else {
    $border.Background = [System.Windows.Media.Brushes]::Black
  }

  $paddingX = 14.0
  $paddingY = 10.0
  $inner = [Math]::Max(20, $dipWidth - 2 * $paddingX)
  $measure = New-MeasureBlock $family $textBlock.FontSize
  $desired = (Measure-TextHeight $measure $text $inner) + 2 * $paddingY
  # Never grow past the host's work-area cap; the anchored edge stays fixed either way.
  $height = if ([double]::IsPositiveInfinity($dipMax)) { $desired } else { [Math]::Min($desired, [Math]::Max(1, $dipMax)) }
  $height = [Math]::Max(1, $height)
  if ($below -or $inside) {
    # 'below' hangs from the avatar window's bottom edge; 'inside' grows from its top edge.
    Set-WindowRect $dipLeft $dipTop $dipWidth $height
  } else {
    Set-WindowRect $dipLeft ($dipBottom - $height) $dipWidth $height
  }
  $window.Show()
}

function Apply-TextState($s) {
  if ($s.layout -eq 'bubble' -and $null -ne $s.left) {
    Apply-BubbleState $s
    return
  }
  $textBlock.TextTrimming = 'None'
  $scale = Get-DipScale
  $region = $s.region
  if ($null -eq $region) { $window.Hide(); return }

  $dipX = $region.x / $scale
  $dipY = $region.y / $scale
  $dipW = [Math]::Max(40, $region.w / $scale)
  $dipH = [Math]::Max(30, $region.h / $scale)

  $textBlock.Text = [string]$s.text
  $family = if ($s.font) { [string]$s.font } else { 'Microsoft YaHei UI' }
  $textBlock.FontFamily = [System.Windows.Media.FontFamily]::new($family)
  if ($s.fg) { $textBlock.Foreground = Convert-Brush $s.fg } else { $textBlock.Foreground = [System.Windows.Media.Brushes]::White }
  if ($s.bg) { $border.Background = Convert-Brush $s.bg } else { $border.Background = [System.Windows.Media.Brushes]::Black }

  $paddingX = 14.0
  $paddingY = 10.0
  $inner = [Math]::Max(20, $dipW - 2 * $paddingX)
  $limit = if ($s.sizeMax) { [double]$s.sizeMax } else { 32.0 }
  $size = Fit-FontSize $textBlock.Text $inner ($dipH - 2 * $paddingY) $limit $family
  $textBlock.FontSize = $size

  Set-WindowRect $dipX $dipY $dipW $dipH
  $window.Show()
}

function Convert-Brush([string]$hex) {
  $color = [System.Windows.Media.ColorConverter]::ConvertFromString($hex)
  $brush = New-Object System.Windows.Media.SolidColorBrush($color)
  return $brush
}

# ---- selection mode -----------------------------------------------------
# Selection coordinates come from Win32 GetCursorPos (screen pixels): the region is stored
# and consumed in physical pixels, while the WPF rectangle is drawn in DIP.
function Write-SelectionJson([hashtable]$payload) {
  $result = $payload | ConvertTo-Json -Compress
  $tmp = "$selPath.tmp"
  [System.IO.File]::WriteAllText($tmp, $result, (New-Object System.Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $tmp -Destination $selPath -Force
}

function End-Select([bool]$cancelled) {
  if ($cancelled) { Write-SelectionJson @{ cancelled = $true } }
  $script:startPoint = $null
  $script:startScreen = $null
  if ($null -ne $script:selectWindow) {
    $script:selectWindow.Close()
    $script:selectWindow = $null
  }
  $script:selecting = $false
  # state.json still says "select" until the host writes "hidden"; don't reopen in between.
  $script:selectAcknowledged = $true
  $script:lastRaw = ''
}

$selectWindow = $null
function Start-Select {
  if ($script:selecting) { return }
  $script:selecting = $true
  $script:window.Hide()

  $script:selectWindow = New-Object System.Windows.Window
  $script:selectWindow.WindowStyle = 'None'
  $script:selectWindow.AllowsTransparency = $true
  $script:selectWindow.Background = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Color]::FromArgb(70, 0, 0, 0))
  $script:selectWindow.Topmost = $true
  $script:selectWindow.ShowInTaskbar = $false
  $script:selectWindow.Left = [System.Windows.SystemParameters]::VirtualScreenLeft
  $script:selectWindow.Top = [System.Windows.SystemParameters]::VirtualScreenTop
  $script:selectWindow.Width = [System.Windows.SystemParameters]::VirtualScreenWidth
  $script:selectWindow.Height = [System.Windows.SystemParameters]::VirtualScreenHeight
  $script:selectWindow.Cursor = [System.Windows.Input.Cursors]::Cross

  # Script-scoped, because WPF invokes these handlers after Start-Select has returned.
  $script:selectCanvas = New-Object System.Windows.Controls.Canvas
  # A Canvas without a background is not hit-testable: the picker window would appear but
  # mouse drags would fall through. Transparent still counts as a background for input.
  $script:selectCanvas.Background = [System.Windows.Media.Brushes]::Transparent
  $script:selectRect = New-Object System.Windows.Shapes.Rectangle
  $script:selectRect.Stroke = [System.Windows.Media.Brushes]::DeepSkyBlue
  $script:selectRect.StrokeThickness = 2
  $script:selectRect.Fill = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Color]::FromArgb(40, 0, 150, 255))
  $script:selectRect.Visibility = 'Collapsed'
  [void]$script:selectCanvas.Children.Add($script:selectRect)

  $script:selectHint = New-Object System.Windows.Controls.TextBlock
  $script:selectHint.Text = '拖拽框选字幕区域（至少 40×30）· Esc / 右键取消'
  $script:selectHint.FontSize = 16
  $script:selectHint.Padding = [System.Windows.Thickness]::new(14, 8, 14, 8)
  $script:selectHint.TextAlignment = 'Center'
  $script:selectHint.Foreground = [System.Windows.Media.Brushes]::White
  $script:selectHint.Background = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Color]::FromArgb(170, 0, 0, 0))
  $script:selectHint.Width = 460
  $script:selectHint.IsHitTestVisible = $false
  [System.Windows.Controls.Canvas]::SetLeft($script:selectHint, [Math]::Max(0, ($script:selectWindow.Width - 460) / 2))
  [System.Windows.Controls.Canvas]::SetTop($script:selectHint, 36)
  [void]$script:selectCanvas.Children.Add($script:selectHint)
  $script:selectWindow.Content = $script:selectCanvas

  $script:selectCanvas.add_MouseLeftButtonDown({
    $script:startPoint = $_.GetPosition($script:selectCanvas)
    $script:startScreen = [SubtitleNative]::CursorPos()
    [System.Windows.Controls.Canvas]::SetLeft($script:selectRect, $script:startPoint.X)
    [System.Windows.Controls.Canvas]::SetTop($script:selectRect, $script:startPoint.Y)
    $script:selectRect.Width = 0
    $script:selectRect.Height = 0
    $script:selectRect.Visibility = 'Visible'
    [void]$script:selectCanvas.CaptureMouse()
  })
  $script:selectCanvas.add_MouseMove({
    if ($null -eq $script:startPoint) { return }
    $p = $_.GetPosition($script:selectCanvas)
    $x = [Math]::Min($script:startPoint.X, $p.X)
    $y = [Math]::Min($script:startPoint.Y, $p.Y)
    [System.Windows.Controls.Canvas]::SetLeft($script:selectRect, $x)
    [System.Windows.Controls.Canvas]::SetTop($script:selectRect, $y)
    $script:selectRect.Width = [Math]::Abs($p.X - $script:startPoint.X)
    $script:selectRect.Height = [Math]::Abs($p.Y - $script:startPoint.Y)
  })
  $script:selectCanvas.add_MouseLeftButtonUp({
    if ($null -eq $script:startPoint) { return }
    [void]$script:selectCanvas.ReleaseMouseCapture()
    $end = [SubtitleNative]::CursorPos()
    $start = $script:startScreen
    $x = [Math]::Min($start[0], $end[0])
    $y = [Math]::Min($start[1], $end[1])
    $w = [Math]::Abs($end[0] - $start[0])
    $h = [Math]::Abs($end[1] - $start[1])
    if ($w -lt 40 -or $h -lt 30) {
      # A plain click must not close the picker: reset and wait for a real drag.
      $script:startPoint = $null
      $script:startScreen = $null
      $script:selectRect.Visibility = 'Collapsed'
      $script:selectHint.Text = '区域太小（至少 40×30），请重新拖拽 · Esc / 右键取消'
      return
    }
    Write-SelectionJson @{ x = [int]$x; y = [int]$y; w = [int]$w; h = [int]$h }
    End-Select $false
  })
  $script:selectCanvas.add_MouseRightButtonUp({ End-Select $true })
  $script:selectWindow.add_KeyDown({
    if ($_.Key -eq [System.Windows.Input.Key]::Escape) { End-Select $true }
  })
  $script:selectWindow.Show()
  [void]$script:selectWindow.Activate()
  [void]$script:selectWindow.Focus()
}

# ---- paging -------------------------------------------------------------
# A new state file rebuilds the real WPF page split from the full text; a long lifetime rotates
# through those pages. Paging never moves the bottom edge, so a clamped bubble stays anchored.
function Update-BubblePage($s) {
  if ($script:bubbleRaw -ne $script:lastRaw) {
    $script:bubbleRaw = $script:lastRaw
    $script:bubblePages = @(Get-BubblePages $s)
    $script:bubblePeriodMs = Get-BubblePagePeriod $s $script:bubblePages.Count
    $script:bubblePage = 0
    $script:bubblePageAt = [DateTime]::UtcNow.Ticks
    $script:bubbleRendered = ''
    return
  }
  if ($script:bubblePages.Count -le 1 -or $script:bubblePeriodMs -le 0) { return }
  $elapsedMs = ([DateTime]::UtcNow.Ticks - $script:bubblePageAt) / 10000
  if ($elapsedMs -lt $script:bubblePeriodMs) { return }
  $script:bubblePage = ([int]$script:bubblePage + 1) % $script:bubblePages.Count
  $script:bubblePageAt = [DateTime]::UtcNow.Ticks
  $script:bubbleRendered = ''
}

# ---- polling loop -------------------------------------------------------
$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(120)
$timer.add_Tick({
  $s = Read-State
  if ($null -eq $s) { return }
  if ($s.mode -eq 'select') {
    if (-not $script:selectAcknowledged) { Start-Select }
    return
  }
  $script:selectAcknowledged = $false
  if ($script:selecting) { return }
  if ($s.mode -eq 'hidden' -or -not $s.text) {
    $window.Hide()
    $script:bubbleRaw = ''
    $script:bubbleRendered = ''
    $script:bubblePages = @()
    return
  }
  if ($s.layout -eq 'bubble') { Update-BubblePage $s }
  Apply-TextState $s
})
$timer.Start()

[System.Windows.Threading.Dispatcher]::Run()
