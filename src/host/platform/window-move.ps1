# Move the VTube Studio window, or report its client rectangle.
#
# One rectangle semantics for every caller: `{left,top,width,height}` is the window's CLIENT area
# on the desktop (screen pixels) - the "model picture" the user positions. `-Report` reads that
# rectangle. A move takes the same rectangle and converts it to the window frame SetWindowPos
# wants (client + the GetWindowRect - GetClientRect border), then re-reads the client rectangle
# and prints what the window actually has, so a caller never mistakes its request for the result.
#
# `-Raise` is for the one transition that must put VTS in front of the editor (entering edit mode):
# a minimized window is restored before the frame is measured (an iconic window has no usable frame
# metrics, and restoring re-applies its own saved placement), then the requested rectangle is
# applied and the window is brought forward. Ordinary moves (parking VTS, starting a display) never
# pass it.
param(
  [int]$X = -2200,
  [int]$Y = -1400,
  [int]$W = 700,
  [int]$H = 1000,
  [switch]$Report,
  [ValidateSet('auto','background','normal')][string]$Presentation = 'auto',
  # Bring the window to the foreground after the move; failures are reported, never thrown.
  [switch]$Raise,
  # Window-title pattern; only tests pass a different one, so the default behaviour is unchanged.
  [string]$Title = '*VTube Studio*'
)

Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class VtsMove {
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int index);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int index, int value);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr GetProp(IntPtr h, string name);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool SetProp(IntPtr h, string name, IntPtr value);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr RemoveProp(IntPtr h, string name);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int command);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int c);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
}
"@

# Reports and SetWindowPos must share physical desktop pixels, including at 125/150% scaling.
try { [void][VtsMove]::SetThreadDpiAwarenessContext([IntPtr](-4)) }
catch { [void][VtsMove]::SetProcessDPIAware() }

$found = [IntPtr]::Zero
$sb = New-Object System.Text.StringBuilder 256
$cb = {
  param($h, $l)
  [void][VtsMove]::GetWindowText($h, $sb, 256)
  if ($sb.ToString() -like $script:Title) { $script:found = $h; return $false }
  return $true
}
[void][VtsMove]::EnumWindows($cb, [IntPtr]::Zero)
if ($script:found -eq [IntPtr]::Zero) { 'no-vts'; exit 1 }

# The one client-rectangle reading both `-Report` and a move use.
function Get-ClientBox([IntPtr]$h) {
  $cr = New-Object VtsMove+RECT
  [void][VtsMove]::GetClientRect($h, [ref]$cr)
  $pt = New-Object VtsMove+POINT
  [void][VtsMove]::ClientToScreen($h, [ref]$pt)
  return @{
    left = $pt.X
    top = $pt.Y
    width = ($cr.Right - $cr.Left)
    height = ($cr.Bottom - $cr.Top)
  }
}

if ($Report) {
  (Get-ClientBox $script:found | ConvertTo-Json -Compress)
  exit 0
}

# The capture corner is a rendering window, not an interactive task. Preserve only the style
# bits we own on the HWND itself: repeated helper processes and backend switches share this
# property, and destruction of the VTS window removes it automatically.
$background = $Presentation -eq 'background' -or ($Presentation -eq 'auto' -and $X -eq -2200 -and $Y -eq -1400)
$property = 'Seirein.VTS.OriginalShellStyle.v1'
$mask = 0x08040080 # NOACTIVATE | APPWINDOW | TOOLWINDOW
$style = [VtsMove]::GetWindowLong($script:found, -20)
$saved = [VtsMove]::GetProp($script:found, $property)
$nextStyle = $style
if ($background) {
  if ($saved -eq [IntPtr]::Zero) {
    if (-not [VtsMove]::SetProp($script:found, $property, [IntPtr](($style -band $mask) + 1))) {
      throw 'Cannot save VTS shell style; refusing an irreversible presentation change'
    }
  }
  $nextStyle = ($style -bor 0x08000080) -band (-bnot 0x00040000)
} else {
  if ($saved -ne [IntPtr]::Zero) {
    $nextStyle = ($style -band (-bnot $mask)) -bor ([int]$saved.ToInt64() - 1)
  }
  # The visible/edit presentation must never keep the parking bits, even when the saved baseline
  # itself was dirty (VTS parked while it already carried NOACTIVATE|TOOLWINDOW): an un-activatable,
  # taskbar-less VTS looks like "the window did not come back". Force the activatable shell flags.
  $nextStyle = ($nextStyle -band (-bnot 0x08000080)) -bor 0x00040000
}
if ($nextStyle -ne $style) {
  $wasVisible = [VtsMove]::IsWindowVisible($script:found)
  if ($wasVisible) { [void][VtsMove]::ShowWindow($script:found, 0) }
  [void][VtsMove]::SetWindowLong($script:found, -20, $nextStyle)
  if ($wasVisible) { [void][VtsMove]::ShowWindow($script:found, 8) }
}
if (-not $background -and $saved -ne [IntPtr]::Zero) {
  [void][VtsMove]::RemoveProp($script:found, $property)
}

# Client rectangle -> window frame: SetWindowPos takes the outer rectangle, so add the border
# (outer - client) and shift by the client origin's offset inside the frame.
# `-Raise` restores a minimized window BEFORE the frame is measured: an iconic window does not
# report its normal frame metrics, and restoring re-applies its own saved placement - so the
# restore has to finish first and the requested rectangle is applied afterwards.
$wasIconic = $false
if ($Raise -and [VtsMove]::IsIconic($script:found)) {
  $wasIconic = $true
  [void][VtsMove]::ShowWindow($script:found, 9) # SW_RESTORE
}
$wr = New-Object VtsMove+RECT
[void][VtsMove]::GetWindowRect($script:found, [ref]$wr)
$before = Get-ClientBox $script:found
$frameW = ($wr.Right - $wr.Left) - $before.width
$frameH = ($wr.Bottom - $wr.Top) - $before.height
$offsetX = $before.left - $wr.Left
$offsetY = $before.top - $wr.Top
$outerX = $X - $offsetX
$outerY = $Y - $offsetY
$outerW = $W + $frameW
$outerH = $H + $frameH
# SWP_NOACTIVATE | SWP_NOZORDER
[void][VtsMove]::SetWindowPos($script:found, [IntPtr]::Zero, $outerX, $outerY, $outerW, $outerH, 0x0034)

# `-Raise` is the edit-recovery transition: the window is now positioned (and, if it was minimized,
# already restored above), so it only has to come forward. SetForegroundWindow is refused to a
# background helper by the Windows foreground lock; the documented fallback raises the window in
# the z-order without activation (no SWP_NOZORDER, HWND_TOP), which is what makes it visible over
# the editor. Both failing is a real error, returned as a code - never silently swallowed.
$raised = $false
$raiseMethod = ''
$raiseCode = ''
if ($Raise) {
  if ([VtsMove]::SetForegroundWindow($script:found)) {
    $raised = $true
    $raiseMethod = 'foreground'
  } elseif ([VtsMove]::SetWindowPos($script:found, [IntPtr]::Zero, 0, 0, 0, 0, 0x0053)) {
    # SWP_SHOWWINDOW | SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE, inserted at HWND_TOP.
    $raised = $true
    $raiseMethod = 'zorder'
  } else {
    $raiseCode = 'VTS_RAISE_FAILED'
  }
}

# The request is not the result: read the client rectangle back and report the actual values.
$actual = Get-ClientBox $script:found
$obj = @{
  ok = -not ($Raise -and -not $raised)
  raised = $raised
  raiseMethod = $raiseMethod
  raiseCode = $raiseCode
  wasIconic = $wasIconic
  left = $actual.left
  top = $actual.top
  width = $actual.width
  height = $actual.height
  requested = @{ left = $X; top = $Y; width = $W; height = $H }
  outer = @{ left = $outerX; top = $outerY; width = $outerW; height = $outerH }
  delta = @{
    left = $actual.left - $X
    top = $actual.top - $Y
    width = $actual.width - $W
    height = $actual.height - $H
  }
} | ConvertTo-Json -Compress -Depth 5
$obj
if ($Raise -and -not $raised) { exit 2 }
