# Persistent PowerShell UIA Bridge
# Reads newline-delimited JSON commands from stdin, writes results to stdout.
# Keeps UI Automation assemblies and Win32 types loaded between calls —
# eliminates 200-500ms PowerShell startup overhead on every a11y operation.

# Force UTF-8 on stdin/stdout so non-ASCII window titles, accessibility
# names, and clipboard contents survive the round-trip to Node. Without
# this, PowerShell uses the system code page (Windows-1252 in most
# locales) while Node decodes as UTF-8 — every non-ASCII char arrives as
# `?` or `�`. Also sets $OutputEncoding so PS-side `ConvertTo-Json`
# doesn't re-encode the output through the legacy console codepath.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding  = [System.Text.Encoding]::UTF8
$OutputEncoding           = [System.Text.Encoding]::UTF8

try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
} catch {
    [Console]::Out.WriteLine((@{ error = "Assembly load failed: $($_.Exception.Message)" } | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
    exit 1
}

try {
    Add-Type @"
    using System;
    using System.Runtime.InteropServices;
    public static class Win32UIA {
        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll", SetLastError = true)]
        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")]
        public static extern bool BringWindowToTop(IntPtr hWnd);
        [DllImport("user32.dll")]
        public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
        [DllImport("user32.dll")]
        public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
        [DllImport("user32.dll")]
        public static extern bool AllowSetForegroundWindow(int dwProcessId);
        [DllImport("kernel32.dll")]
        public static extern uint GetCurrentThreadId();
        [DllImport("user32.dll")]
        public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
        [DllImport("user32.dll")]
        public static extern IntPtr WindowFromPoint(int x, int y);
        [DllImport("user32.dll")]
        public static extern IntPtr GetAncestor(IntPtr hWnd, uint gaFlags);
        // Additional constants for force-focus path:
        //   HWND_TOPMOST    = -1
        //   HWND_NOTOPMOST  = -2
        //   SWP_NOSIZE      = 0x0001
        //   SWP_NOMOVE      = 0x0002
        //   SWP_SHOWWINDOW  = 0x0040
        //   SWP_NOACTIVATE  = 0x0010
        //   GA_ROOT         = 2  (for GetAncestor)
    }
"@
} catch { } # May already be defined in a long-running session

$ErrorActionPreference = 'Continue'

# Control type map
$ctMap = @{
    "Button"      = [System.Windows.Automation.ControlType]::Button
    "CheckBox"    = [System.Windows.Automation.ControlType]::CheckBox
    "ComboBox"    = [System.Windows.Automation.ControlType]::ComboBox
    "Custom"      = [System.Windows.Automation.ControlType]::Custom
    "DataGrid"    = [System.Windows.Automation.ControlType]::DataGrid
    "DataItem"    = [System.Windows.Automation.ControlType]::DataItem
    "Document"    = [System.Windows.Automation.ControlType]::Document
    "Edit"        = [System.Windows.Automation.ControlType]::Edit
    "Group"       = [System.Windows.Automation.ControlType]::Group
    "Hyperlink"   = [System.Windows.Automation.ControlType]::Hyperlink
    "Image"       = [System.Windows.Automation.ControlType]::Image
    "List"        = [System.Windows.Automation.ControlType]::List
    "ListItem"    = [System.Windows.Automation.ControlType]::ListItem
    "Menu"        = [System.Windows.Automation.ControlType]::Menu
    "MenuBar"     = [System.Windows.Automation.ControlType]::MenuBar
    "MenuItem"    = [System.Windows.Automation.ControlType]::MenuItem
    "Pane"        = [System.Windows.Automation.ControlType]::Pane
    "RadioButton" = [System.Windows.Automation.ControlType]::RadioButton
    "ScrollBar"   = [System.Windows.Automation.ControlType]::ScrollBar
    "Slider"      = [System.Windows.Automation.ControlType]::Slider
    "Spinner"     = [System.Windows.Automation.ControlType]::Spinner
    "SplitButton" = [System.Windows.Automation.ControlType]::SplitButton
    "Tab"         = [System.Windows.Automation.ControlType]::Tab
    "TabItem"     = [System.Windows.Automation.ControlType]::TabItem
    "Text"        = [System.Windows.Automation.ControlType]::Text
    "ToolBar"     = [System.Windows.Automation.ControlType]::ToolBar
    "Tree"        = [System.Windows.Automation.ControlType]::Tree
    "TreeItem"    = [System.Windows.Automation.ControlType]::TreeItem
    "Window"      = [System.Windows.Automation.ControlType]::Window
}

$interactiveTypes = @(
    'ControlType.Button', 'ControlType.Edit', 'ControlType.ComboBox',
    'ControlType.CheckBox', 'ControlType.RadioButton', 'ControlType.Hyperlink',
    'ControlType.MenuItem', 'ControlType.Menu', 'ControlType.Tab',
    'ControlType.TabItem', 'ControlType.ListItem', 'ControlType.TreeItem',
    'ControlType.Slider', 'ControlType.Document', 'ControlType.DataItem',
    'ControlType.Pane', 'ControlType.Custom', 'ControlType.ToolBar',
    'ControlType.Text', 'ControlType.Group'
)

# ── UI tree builder ───────────────────────────────────────────────────────────
function ConvertTo-UINode {
    param(
        [System.Windows.Automation.AutomationElement]$Element,
        [int]$Depth = 0,
        [int]$MaxDepth = 8,
        [int]$RawDepth = 0
    )
    if ($null -eq $Element) { return $null }
    # Hard cap on RAW recursion so a pathological/cyclic provider can't hang the
    # bridge now that pass-through containers no longer consume semantic depth.
    if ($RawDepth -gt 60) { return $null }
    # Time budget (set by get-screen-context): a huge web app (Stripe in Edge)
    # took longer than the 20 s command timeout, so the caller got NOTHING and
    # the bridge kept walking. Stop and return what we have, flagged partial.
    if ($null -ne $script:treeDeadline -and [DateTime]::UtcNow -gt $script:treeDeadline) {
        $script:treeTruncated = $true
        return $null
    }
    try { $cur = $Element.Current } catch { return $null }

    $typeName = $cur.ControlType.ProgrammaticName
    $hasName = $cur.Name -and $cur.Name.Trim().Length -gt 0
    # Structural containers (Pane/Group/Custom) only carry meaning when NAMED
    # ("Reading Pane", "Chrome Legacy Window"); an unnamed one is pure layout.
    # They live in $interactiveTypes, which force-emitted every anonymous
    # WebView2 wrapper as a name:"" node — bloating the tree AND consuming
    # depth budget, so real controls 10+ Panes deep never made it into the
    # snapshot. Unnamed structural nodes route to the pass-through branch.
    $isUnnamedStructural = (-not $hasName) -and ($typeName -eq 'ControlType.Pane' -or $typeName -eq 'ControlType.Group' -or $typeName -eq 'ControlType.Custom')
    $isInteractive = ($interactiveTypes -contains $typeName) -and -not $isUnnamedStructural

    if (-not $isInteractive -and -not $hasName -and $Depth -gt 0) {
        # Unnamed non-interactive pass-through — flattened out of the output
        # (children are emitted in its place), so it must NOT consume semantic
        # depth either. WebView2/Electron apps (new Outlook, Teams, VS Code)
        # nest 10-15 anonymous Panes before the first real control: charging
        # each one against MaxDepth=8 truncated the tree to containers-only,
        # which read as "sparse a11y, escalate to OCR/vision" and cost every
        # form task its cheap a11y path (#173). Depth = what the LLM sees.
        if ($Depth -ge $MaxDepth) { return $null }
        $childNodes = @()
        try {
            $kids = $Element.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
            foreach ($kid in $kids) {
                $cn = ConvertTo-UINode -Element $kid -Depth $Depth -MaxDepth $MaxDepth -RawDepth ($RawDepth + 1)
                if ($null -ne $cn) { $childNodes += $cn }
            }
        } catch {}
        # Skip unnamed leaves — but recurse into unnamed containers that have children
        if ($childNodes.Count -eq 0) { return $null }
        return $childNodes
    }

    $rect = $cur.BoundingRectangle
    $bounds = if ([double]::IsInfinity($rect.X) -or [double]::IsInfinity($rect.Y) -or $rect.X -lt -100 -or $rect.Y -lt -100) {
        @{ x = 0; y = 0; width = 0; height = 0 }
    } else {
        @{ x = [Math]::Round($rect.X); y = [Math]::Round($rect.Y); width = [Math]::Round($rect.Width); height = [Math]::Round($rect.Height) }
    }

    # Read the field VALUE for editable controls so the value-aware fingerprint
    # (which hashes element.value) actually moves when text is typed on Windows —
    # the tree node carried NO value before, so the D2 fix was inert here while
    # working on macOS (audit 2026-06-11, M5). Guarded: only Edit/Document/
    # ComboBox controls, never password fields, capped length, never throws.
    $nodeValue = $null
    if ($typeName -eq 'ControlType.Edit' -or $typeName -eq 'ControlType.Document' -or $typeName -eq 'ControlType.ComboBox') {
        $isPassword = $false
        try { $isPassword = $cur.IsPassword } catch { }
        if (-not $isPassword) {
            try {
                $vp = $Element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
                $v = $vp.Current.Value
                if ($v -and $v.Length -gt 0) { $nodeValue = $v }
            } catch { }
            if ($null -eq $nodeValue) {
                try {
                    $tp = $Element.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
                    $t = $tp.DocumentRange.GetText(2000)
                    if ($t -and $t.Length -gt 0) { $nodeValue = $t }
                } catch { }
            }
            if ($nodeValue -and $nodeValue.Length -gt 2000) { $nodeValue = $nodeValue.Substring(0, 2000) }
        }
    }

    $node = [ordered]@{
        name         = if ($cur.Name) { $cur.Name } else { "" }
        automationId = if ($cur.AutomationId) { $cur.AutomationId } else { "" }
        controlType  = $typeName
        className    = if ($cur.ClassName) { $cur.ClassName } else { "" }
        isEnabled    = $cur.IsEnabled
        bounds       = $bounds
        value        = $nodeValue
        children     = @()
    }

    if ($Depth -lt $MaxDepth) {
        try {
            $kids = $Element.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
            foreach ($kid in $kids) {
                $cn = ConvertTo-UINode -Element $kid -Depth ($Depth + 1) -MaxDepth $MaxDepth -RawDepth ($RawDepth + 1)
                if ($null -ne $cn) {
                    if ($cn -is [array]) { $node.children += $cn } else { $node.children += $cn }
                }
            }
        } catch {}
    }
    return $node
}

# ── Command: get-screen-context ───────────────────────────────────────────────
function Cmd-GetScreenContext {
    param($cmd)
    $focusedPid = if ($cmd.focusedProcessId) { [int]$cmd.focusedProcessId } else { 0 }
    $maxDepth   = if ($cmd.maxDepth)         { [int]$cmd.maxDepth }         else { 8 }

    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $winCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Window
    )
    $allWins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $winCond)

    $windowList = @()
    foreach ($win in $allWins) {
        try {
            $c = $win.Current
            if (-not $c.Name -or $c.Name.Trim().Length -eq 0) { continue }
            $pName = "unknown"
            try { $pName = [System.Diagnostics.Process]::GetProcessById($c.ProcessId).ProcessName } catch {}
            $rect = $c.BoundingRectangle
            $bounds = if ([double]::IsInfinity($rect.X)) { @{ x=0;y=0;width=0;height=0 } }
                else { @{ x=[Math]::Round($rect.X); y=[Math]::Round($rect.Y); width=[Math]::Round($rect.Width); height=[Math]::Round($rect.Height) } }
            $isMin = $false
            try {
                $wp = $win.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern)
                if ($wp.Current.WindowVisualState -eq [System.Windows.Automation.WindowVisualState]::Minimized) { $isMin = $true }
            } catch {}
            $windowList += [ordered]@{
                handle = $c.NativeWindowHandle; title = $c.Name; processName = $pName
                processId = $c.ProcessId; bounds = $bounds; isMinimized = $isMin
            }
        } catch {}
    }

    $uiTree = $null
    if ($focusedPid -gt 0) {
        $pidCond = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $focusedPid
        )
        $targetWin = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $pidCond)
        if ($null -ne $targetWin) {
            $budgetMs = if ($cmd.budgetMs) { [int]$cmd.budgetMs } else { 8000 }
            $script:treeTruncated = $false
            $script:treeDeadline = [DateTime]::UtcNow.AddMilliseconds($budgetMs)
            try {
                $uiTree = ConvertTo-UINode -Element $targetWin -Depth 0 -MaxDepth $maxDepth
            } finally {
                $script:treeDeadline = $null
            }
        }
    }

    return [ordered]@{ windows = $windowList; uiTree = $uiTree; truncated = [bool]$script:treeTruncated }
}

# Never raise a window belonging to the AI-agent host or clawdcursor's own
# spawned consoles at a click point — an overlapping self/host window can
# legitimately be the topmost thing at a given pixel (see #173: a fullscreen
# host app sitting over the real target), and blindly foregrounding it just
# hijacks the user's whole desktop focus away from the app the agent is
# driving — worse than a missed click, since a stray keystroke can then land
# in the host/chat window instead. Extend via CLAWD_FOREGROUND_DENYLIST (comma-
# separated process names, e.g. "Claude,Cursor,Code,Windsurf,MyIDE").
$script:ForegroundDenylistProcs = @('Claude', 'Cursor', 'Code', 'Windsurf')
if ($env:CLAWD_FOREGROUND_DENYLIST) {
    $script:ForegroundDenylistProcs += ($env:CLAWD_FOREGROUND_DENYLIST -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}
$script:ForegroundDenylistTitlePrefix = 'Clawd Cursor'

function Test-ForegroundDenylisted($procName, $title) {
    if ($procName -and ($script:ForegroundDenylistProcs -contains $procName)) { return $true }
    if ($title -and $title.StartsWith($script:ForegroundDenylistTitlePrefix)) { return $true }
    return $false
}

# ── Command: activate-at-point ────────────────────────────────────────────────
# Before a coordinate click, ensure the window at (x, y) is the foreground.
# This prevents clicks from landing on a background window when a dialog sits
# over another window and the foreground changed between screenshot and click.
#
# Uses the same AttachThreadInput + AllowSetForegroundWindow dance as
# Cmd-FocusWindow so that the Windows foreground lock is properly overcome.
# ── Multi-monitor: physical virtual-desktop coordinates on ANY monitor ─────────
# The bridge process is DPI-unaware; each command below switches only ITS OWN
# THREAD to per-monitor-v2 awareness (and restores it), so every coordinate is
# a physical pixel on the whole virtual desktop — any monitor, any position
# (negative origins included), any per-monitor scaling. nut-js cannot do this:
# it normalises absolute moves to the PRIMARY display only.
if (-not ([System.Management.Automation.PSTypeName]'ScreenPM').Type) {
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Collections.Generic;
public static class ScreenPM {
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [StructLayout(LayoutKind.Sequential)] public struct PT { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out PT p);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct MI { public int cb; public RECT rc; public RECT work; public uint flags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dev; }
  public delegate bool EnumProc(IntPtr h, IntPtr dc, ref RECT r, IntPtr d);
  [DllImport("user32.dll")] public static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, EnumProc cb, IntPtr d);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetMonitorInfo(IntPtr h, ref MI mi);
  [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr h, int t, out uint x, out uint y);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
  public static string ClassOf(IntPtr h) { var sb = new System.Text.StringBuilder(256); GetClassName(h, sb, 256); return sb.ToString(); }
  public static IntPtr Aware() { return SetThreadDpiAwarenessContext(new IntPtr(-4)); }
  public static void Restore(IntPtr prev) { if (prev != IntPtr.Zero) SetThreadDpiAwarenessContext(prev); }
  public static List<object[]> Monitors() {
    var o = new List<object[]>();
    EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (IntPtr h, IntPtr dc, ref RECT r, IntPtr d) => {
      uint dx = 96, dy = 96; try { GetDpiForMonitor(h, 0, out dx, out dy); } catch {}
      var mi = new MI(); mi.cb = Marshal.SizeOf(typeof(MI)); GetMonitorInfo(h, ref mi);
      o.Add(new object[] { mi.dev, (mi.flags & 1) == 1, r.L, r.T, r.R - r.L, r.B - r.T, (int)dx });
      return true; }, IntPtr.Zero);
    return o;
  }
}
"@
}

function Cmd-ListDisplays {
    $prev = [ScreenPM]::Aware()
    try {
        $i = 0
        $list = foreach ($m in [ScreenPM]::Monitors()) {
            [ordered]@{ index = $i++; name = $m[0]; primary = $m[1]; x = $m[2]; y = $m[3]; width = $m[4]; height = $m[5]; dpi = $m[6]; scale = [math]::Round($m[6] / 96, 4) }
        }
        return @{ success = $true; displays = @($list) }
    } finally { [ScreenPM]::Restore($prev) }
}

function Cmd-MoveCursor {
    param($cmd)
    $prev = [ScreenPM]::Aware()
    try {
        [void][ScreenPM]::SetCursorPos([int]$cmd.x, [int]$cmd.y)
        $p = New-Object ScreenPM+PT; [void][ScreenPM]::GetCursorPos([ref]$p)
        return @{ success = $true; x = $p.X; y = $p.Y }
    } finally { [ScreenPM]::Restore($prev) }
}

function Cmd-GetCursor {
    $prev = [ScreenPM]::Aware()
    try { $p = New-Object ScreenPM+PT; [void][ScreenPM]::GetCursorPos([ref]$p); return @{ success = $true; x = $p.X; y = $p.Y } }
    finally { [ScreenPM]::Restore($prev) }
}

function Cmd-CaptureRect {
    param($cmd)
    Add-Type -AssemblyName System.Drawing
    $prev = [ScreenPM]::Aware()
    try {
        $w = [int]$cmd.width; $h = [int]$cmd.height
        $bmp = New-Object System.Drawing.Bitmap $w, $h
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        try { $g.CopyFromScreen([int]$cmd.x, [int]$cmd.y, 0, 0, $bmp.Size) } finally { $g.Dispose() }
        $ms = New-Object System.IO.MemoryStream
        $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
        return @{ success = $true; width = $w; height = $h; png = [Convert]::ToBase64String($ms.ToArray()) }
    } finally { [ScreenPM]::Restore($prev) }
}

function Cmd-ActivateAtPoint {
    param($cmd)
    $x = [int]$cmd.x
    $y = [int]$cmd.y
    # physical:true → (x,y) are physical virtual-desktop pixels (any monitor).
    if ($cmd.physical) {
        $prevCtx = [ScreenPM]::Aware()
        try { $hwnd = [Win32UIA]::WindowFromPoint($x, $y) } finally { [ScreenPM]::Restore($prevCtx) }
    } else {
        $hwnd = [Win32UIA]::WindowFromPoint($x, $y)
    }
    if ($hwnd -eq [IntPtr]::Zero) { return @{ success=$true; action="noop"; reason="no-window-at-point" } }
    # Walk up to the root owner (GA_ROOT = 2) so child controls map to their
    # top-level window before we compare / promote to foreground.
    $root = [Win32UIA]::GetAncestor($hwnd, 2)
    if ($root -eq [IntPtr]::Zero) { $root = $hwnd }
    $fg = [Win32UIA]::GetForegroundWindow()
    if ($root -eq $fg) { return @{ success=$true; action="noop"; reason="already-foreground" } }

    # Resolve identity BEFORE deciding whether to raise, so a denylisted
    # self/host window can be skipped without ever touching foreground.
    $rootPidEarly = 0
    [void][Win32UIA]::GetWindowThreadProcessId($root, [ref]$rootPidEarly)
    $rootNameEarly = "unknown"; $rootTitleEarly = ""
    try { $rootNameEarly = [System.Diagnostics.Process]::GetProcessById($rootPidEarly).ProcessName } catch {}
    try {
        $elEarly = [System.Windows.Automation.AutomationElement]::FromHandle($root)
        if ($elEarly) { $rootTitleEarly = $elEarly.Current.Name }
    } catch {}
    if (Test-ForegroundDenylisted $rootNameEarly $rootTitleEarly) {
        return @{
            success = $true; action = "skipped-self-window"; activated = $false
            processId = $rootPidEarly; processName = $rootNameEarly; title = $rootTitleEarly
            reason = "target point is covered by a denylisted self/host window - not raised"
        }
    }

    # AttachThreadInput dance — needed to overcome Windows focus lock.
    $currentThread = [Win32UIA]::GetCurrentThreadId()
    $pidTmp = 0
    $fgThread = 0
    if ($fg -ne [IntPtr]::Zero) {
        $fgThread = [Win32UIA]::GetWindowThreadProcessId($fg, [ref]$pidTmp)
    }
    $attached = $false
    if ($fgThread -ne 0 -and $fgThread -ne $currentThread) {
        try { [Win32UIA]::AttachThreadInput($currentThread, $fgThread, $true) | Out-Null; $attached = $true } catch {}
    }
    try {
        [Win32UIA]::AllowSetForegroundWindow(-1) | Out-Null
        [Win32UIA]::BringWindowToTop($root) | Out-Null
        [Win32UIA]::SetForegroundWindow($root) | Out-Null
    } catch {}
    finally {
        if ($attached) { try { [Win32UIA]::AttachThreadInput($currentThread, $fgThread, $false) | Out-Null } catch {} }
    }

    Start-Sleep -Milliseconds 40
    $newFg = [Win32UIA]::GetForegroundWindow()
    # Report the identity of the window we promoted (resolved above, before the
    # raise), so the click tool can warn when activation FAILED (Windows
    # foreground-lock) or when the window at the coords is NOT what the agent
    # intended — a blind keystroke after a missed click leaked an OTP into the
    # wrong window (session 2026-06-11).
    return @{
        success   = $true
        action    = "activated"
        activated = ($newFg -eq $root)
        processId = $rootPidEarly
        processName = $rootNameEarly
        title     = $rootTitleEarly
    }
}

# ── Command: get-foreground-window ────────────────────────────────────────────
function Cmd-GetForegroundWindow {
    $fgWin = [Win32UIA]::GetForegroundWindow()
    if ($fgWin -eq [IntPtr]::Zero) { return @{ error = "No foreground window" } }
    $wpid = 0
    [void][Win32UIA]::GetWindowThreadProcessId($fgWin, [ref]$wpid)
    $pName = "unknown"
    try { $pName = [System.Diagnostics.Process]::GetProcessById($wpid).ProcessName } catch {}
    $title = ""
    try {
        $el = [System.Windows.Automation.AutomationElement]::FromHandle($fgWin)
        if ($el) { $title = $el.Current.Name }
    } catch {}
    $cls = ''; try { $cls = [ScreenPM]::ClassOf($fgWin) } catch {}
    return [ordered]@{ handle=[int]$fgWin; processId=$wpid; processName=$pName; title=$title; className=$cls; success=$true }
}

# ── Command: focus-window ─────────────────────────────────────────────────────
function Cmd-FocusWindow {
    param($cmd)
    $title   = if ($cmd.title)     { $cmd.title }           else { "" }
    $wpid    = if ($cmd.processId) { [int]$cmd.processId }  else { 0 }
    $restore = if ($cmd.restore)   { $true }                else { $false }

    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $winCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Window
    )
    $allWins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $winCond)

    $target = $null
    # When BOTH pid and title are supplied, AND-match. Disambiguates tabbed
    # apps like Win11 Notepad where multiple windows share one pid.
    if ($wpid -gt 0 -and $title -ne "") {
        $tl = $title.ToLower()
        foreach ($w in $allWins) {
            try {
                if ($w.Current.ProcessId -ne $wpid) { continue }
                if ($w.Current.Name -and $w.Current.Name.ToLower().Contains($tl)) { $target = $w; break }
            } catch {}
        }
        # Fall back to pid-only if no title match (caller may have passed a stale title)
        if ($null -eq $target) {
            foreach ($w in $allWins) {
                try { if ($w.Current.ProcessId -eq $wpid) { $target = $w; break } } catch {}
            }
        }
    } elseif ($wpid -gt 0) {
        foreach ($w in $allWins) {
            try { if ($w.Current.ProcessId -eq $wpid) { $target = $w; break } } catch {}
        }
    } elseif ($title -ne "") {
        $tl = $title.ToLower()
        foreach ($w in $allWins) {
            try { if ($w.Current.Name -and $w.Current.Name.ToLower().Contains($tl)) { $target = $w; break } } catch {}
        }
    }

    if ($null -eq $target) { return @{ success=$false; error="Window not found: title='$title' pid=$wpid" } }

    if ($restore) {
        try {
            $wp = $target.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern)
            if ($wp.Current.WindowVisualState -eq [System.Windows.Automation.WindowVisualState]::Minimized) {
                $wp.SetWindowVisualState([System.Windows.Automation.WindowVisualState]::Normal)
                Start-Sleep -Milliseconds 120
            }
        } catch {}
    }

    # Force-focus path. Windows' focus-lock blocks SetForegroundWindow from
    # any process that isn't the current foreground. We ALWAYS run the full
    # Win32 path (AttachThreadInput + AllowSetForegroundWindow + BringWindowToTop
    # + SetForegroundWindow) and ALWAYS verify by reading GetForegroundWindow
    # back. UIA SetFocus alone is NOT sufficient on Windows because it only
    # signals accessibility focus -- it does not change the global foreground,
    # which is what subsequent SendInput keystrokes follow. This is the bug
    # that made New Outlook compose-and-type fail: SetFocus reported success
    # but the daemon's launching terminal kept the foreground, so mod+n and
    # type_text landed on PowerShell, not Outlook.
    $hwnd = [IntPtr]$target.Current.NativeWindowHandle

    # Try UIA SetFocus too (cheap, helps with some custom apps); ignore result.
    try { $target.SetFocus() } catch {}

    # SW_RESTORE = 9. ShowWindow is a no-op when the window is already shown.
    [Win32UIA]::ShowWindow($hwnd, 9) | Out-Null
    Start-Sleep -Milliseconds 30

    # Topmost toggle pushes the window to the top of the z-order without
    # changing its always-on-top behavior afterwards.
    $HWND_TOPMOST    = [IntPtr]::new(-1)
    $HWND_NOTOPMOST  = [IntPtr]::new(-2)
    $SWP_NOMOVE_SIZE = 0x0003  # NOMOVE | NOSIZE
    [Win32UIA]::SetWindowPos($hwnd, $HWND_TOPMOST,   0, 0, 0, 0, $SWP_NOMOVE_SIZE) | Out-Null
    Start-Sleep -Milliseconds 10
    [Win32UIA]::SetWindowPos($hwnd, $HWND_NOTOPMOST, 0, 0, 0, 0, $SWP_NOMOVE_SIZE) | Out-Null

    # AttachThreadInput dance.
    $currentThread = [Win32UIA]::GetCurrentThreadId()
    $fg = [Win32UIA]::GetForegroundWindow()
    $pidTmp = 0
    $fgThread = 0
    if ($fg -ne [IntPtr]::Zero) {
        $fgThread = [Win32UIA]::GetWindowThreadProcessId($fg, [ref]$pidTmp)
    }
    $attached = $false
    if ($fgThread -ne 0 -and $fgThread -ne $currentThread) {
        try { [Win32UIA]::AttachThreadInput($currentThread, $fgThread, $true) | Out-Null; $attached = $true } catch {}
    }
    try {
        # Give the target's process permission to set foreground, then ask.
        # ASFW_ANY = -1 (any process can SetForegroundWindow until next user input).
        [Win32UIA]::AllowSetForegroundWindow(-1) | Out-Null
        [Win32UIA]::BringWindowToTop($hwnd) | Out-Null
        [Win32UIA]::SetForegroundWindow($hwnd) | Out-Null
    } catch { }
    finally {
        if ($attached) { try { [Win32UIA]::AttachThreadInput($currentThread, $fgThread, $false) | Out-Null } catch {} }
    }

    # Verify -- the only thing that matters.
    Start-Sleep -Milliseconds 60
    $foreground = ([Win32UIA]::GetForegroundWindow() -eq $hwnd)

    # If we still don't have foreground, try the Alt-tap synthesis trick.
    # Some Windows configurations require a key event to break the lock.
    if (-not $foreground) {
        try {
            [System.Windows.Forms.SendKeys]::SendWait('%') | Out-Null
            Start-Sleep -Milliseconds 30
            [Win32UIA]::AllowSetForegroundWindow(-1) | Out-Null
            [Win32UIA]::SetForegroundWindow($hwnd) | Out-Null
            Start-Sleep -Milliseconds 50
            $foreground = ([Win32UIA]::GetForegroundWindow() -eq $hwnd)
        } catch {}
    }

    $c = $target.Current
    # success is now an honest report: the window was found AND it actually
    # became the foreground window. Callers that need to trust this for
    # downstream SendInput must check `foreground`.
    return [ordered]@{
        success    = $foreground
        foreground = $foreground
        title      = $c.Name
        processId  = $c.ProcessId
        handle     = $c.NativeWindowHandle
    }
}

# ── Command: find-element (fuzzy name match) ──────────────────────────────────
function Cmd-FindElement {
    param($cmd)
    $name        = if ($cmd.name)        { $cmd.name }           else { "" }
    $automationId= if ($cmd.automationId){ $cmd.automationId }   else { "" }
    $controlType = if ($cmd.controlType) { $cmd.controlType }    else { "" }
    $wpid        = if ($cmd.processId)   { [int]$cmd.processId } else { 0 }
    $maxResults  = if ($cmd.maxResults)  { [int]$cmd.maxResults } else { 20 }

    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $searchRoots = @($root)
    if ($wpid -gt 0) {
        $pc = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $wpid
        )
        # Every top-level window of the process, not just the first: a browser
        # with several windows otherwise searched only whichever came first.
        $searchRoots = @($root.FindAll([System.Windows.Automation.TreeScope]::Children, $pc))
        if ($searchRoots.Count -eq 0) { return ,(New-Object System.Object[] 0) }
    }

    $conditions = @()
    if ($automationId -ne "") {
        $conditions += New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::AutomationIdProperty, $automationId
        )
    }
    if ($controlType -ne "" -and $ctMap.ContainsKey($controlType)) {
        $conditions += New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty, $ctMap[$controlType]
        )
    }

    $searchCond = if ($conditions.Count -eq 0) { [System.Windows.Automation.Condition]::TrueCondition }
        elseif ($conditions.Count -eq 1) { $conditions[0] }
        else { New-Object System.Windows.Automation.AndCondition([System.Windows.Automation.Condition[]]$conditions) }

    $results = @()
    $nameLower = $name.ToLower()

    foreach ($searchRoot in $searchRoots) {
    if ($results.Count -ge $maxResults) { break }
    $elements = $searchRoot.FindAll([System.Windows.Automation.TreeScope]::Descendants, $searchCond)
    foreach ($el in $elements) {
        if ($results.Count -ge $maxResults) { break }
        try {
            $c = $el.Current
            if ($name -ne "") {
                # Fuzzy: strip keyboard shortcut suffix ("Save\tCtrl+S" → "save"), then contains-match
                $elName = ($c.Name -replace '\t.*$', '').Trim().ToLower()
                if (-not $elName.Contains($nameLower) -and -not $nameLower.Contains($elName)) { continue }
                if ($elName.Length -eq 0) { continue }
            }
            $rect = $c.BoundingRectangle
            $bounds = if ([double]::IsInfinity($rect.X)) { @{x=0;y=0;width=0;height=0} }
                else { @{x=[int]$rect.X;y=[int]$rect.Y;width=[int]$rect.Width;height=[int]$rect.Height} }
            $results += [ordered]@{
                name=$c.Name; automationId=$c.AutomationId; controlType=$c.ControlType.ProgrammaticName
                className=$c.ClassName; processId=$c.ProcessId; isEnabled=$c.IsEnabled; bounds=$bounds
            }
        } catch {}
    }
    }
    return ,$results
}

# ── Resolve a matched element to the EDITABLE control it represents ───────────
# Name/label matching often lands on a static label (e.g. the Win11 Save dialog's
# "File name:" is a Text label, not the editable field) or on a ComboBox wrapping
# an Edit. Walk to the real editable target so set-value writes somewhere writable.
# App-agnostic: relies only on UIA control types and the LabeledBy relationship.
function Resolve-EditableTarget {
    param($el)
    if ($null -eq $el) { return $null }
    $EDIT  = [System.Windows.Automation.ControlType]::Edit
    $DOC   = [System.Windows.Automation.ControlType]::Document
    $COMBO = [System.Windows.Automation.ControlType]::ComboBox
    $editCond  = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $EDIT)
    $editable  = New-Object System.Windows.Automation.OrCondition(
        $editCond,
        (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $DOC)),
        (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $COMBO)))
    $ct = $el.Current.ControlType
    # 1) Already editable.
    if ($ct -eq $EDIT -or $ct -eq $DOC) { return $el }
    if ($ct -eq $COMBO) { try { $i = $el.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $editCond); if ($i) { return $i } } catch {}; return $el }
    # 2) Editable descendant (matched a group/pane wrapping the field).
    try { $d = $el.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $editable); if ($d) { if ($d.Current.ControlType -eq $COMBO) { try { $i = $d.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $editCond); if ($i) { return $i } } catch {} }; return $d } } catch {}
    # 3) Matched a label: find the editable control it labels among its siblings.
    try {
        $parent = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($el)
        if ($parent) {
            $cands = $parent.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editable)
            $fallback = $null
            for ($k = 0; $k -lt $cands.Count; $k++) {
                $cand = $cands.Item($k)
                if ($null -eq $fallback) { $fallback = $cand }
                try {
                    $lb = $cand.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::LabeledByProperty)
                    if ($lb -and $lb.Current.Name -eq $el.Current.Name) {
                        if ($cand.Current.ControlType -eq $COMBO) { try { $i = $cand.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $editCond); if ($i) { return $i } } catch {} }
                        return $cand
                    }
                } catch {}
            }
            if ($fallback) {
                if ($fallback.Current.ControlType -eq $COMBO) { try { $i = $fallback.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $editCond); if ($i) { return $i } } catch {} }
                return $fallback
            }
        }
    } catch {}
    return $el
}

# ── Command: invoke-element (fuzzy name match) ────────────────────────────────
function Cmd-InvokeElement {
    param($cmd)
    $name        = if ($cmd.name)        { $cmd.name }           else { "" }
    $automationId= if ($cmd.automationId){ $cmd.automationId }   else { "" }
    $controlType = if ($cmd.controlType) { $cmd.controlType }    else { "" }
    $wpid        = [int]$cmd.processId
    $action      = $cmd.action
    $value       = if ($cmd.value)       { $cmd.value }          else { "" }

    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $pc = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $wpid
    )
    $window = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $pc)
    if ($null -eq $window) { return @{ success=$false; error="No window for pid $wpid" } }

    # Find element: prefer automationId (exact), then fuzzy name walk
    $element = $null
    if ($automationId -ne "") {
        $aidCond = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::AutomationIdProperty, $automationId
        )
        $element = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $aidCond)
    }

    if ($null -eq $element -and $name -ne "") {
        $nameLower = $name.ToLower()
        $ctCond = if ($controlType -ne "" -and $ctMap.ContainsKey($controlType)) {
            New-Object System.Windows.Automation.PropertyCondition(
                [System.Windows.Automation.AutomationElement]::ControlTypeProperty, $ctMap[$controlType]
            )
        } else { [System.Windows.Automation.Condition]::TrueCondition }

        $candidates = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $ctCond)
        # First pass: exact match after stripping shortcut suffix
        foreach ($el in $candidates) {
            try {
                $elName = ($el.Current.Name -replace '\t.*$', '').Trim().ToLower()
                if ($elName -eq $nameLower -and $elName.Length -gt 0) { $element = $el; break }
            } catch {}
        }
        # Second pass: contains match
        if ($null -eq $element) {
            foreach ($el in $candidates) {
                try {
                    $elName = ($el.Current.Name -replace '\t.*$', '').Trim().ToLower()
                    if ($elName.Length -gt 0 -and ($elName.Contains($nameLower) -or $nameLower.Contains($elName))) {
                        $element = $el; break
                    }
                } catch {}
            }
        }
    }

    if ($null -eq $element) {
        return @{ success=$false; error="Element not found: name='$name' id='$automationId' ct='$controlType'" }
    }

    switch ($action) {
        "click" {
            # "click" is the generic ACTIVATE intent. A named target can be a
            # Button (InvokePattern), a checkbox (TogglePattern), or a ListItem /
            # combo-item (SelectionItemPattern) — and a blind agent can't see
            # which. Cascade through the activation patterns in ONE bridge call so
            # the agent never has to retry verbs or fall back to a coord-click
            # (which needs a screenshot). Live regression 2026-06-07: invoke
            # "Cool blue" (a ListItem) failed here because only SelectionItem fit.
            try {
                $p = $element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
                $p.Invoke()
                return @{ success=$true; action="click"; method="InvokePattern" }
            } catch {
                try {
                    $p = $element.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
                    $p.Toggle()
                    return @{ success=$true; action="click"; method="TogglePattern" }
                } catch {
                    try {
                        $p = $element.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
                        $p.Select()
                        return @{ success=$true; action="click"; method="SelectionItemPattern" }
                    } catch {
                        $rect = $element.Current.BoundingRectangle
                        return @{ success=$false; action="click"; error="No invoke/toggle/select pattern";
                            clickPoint=@{x=[int]($rect.X+$rect.Width/2);y=[int]($rect.Y+$rect.Height/2)};
                            bounds=@{x=[int]$rect.X;y=[int]$rect.Y;width=[int]$rect.Width;height=[int]$rect.Height} }
                    }
                }
            }
        }
        "set-value" {
            if ($value -eq "") { return @{ success=$false; error="value required for set-value" } }
            # App-agnostic set-value. The named element is often NOT the editable field
            # itself — e.g. the Win11 Save dialog's "File name:" is a read-only Text
            # label, and other fields are a ComboBox wrapping an Edit. Resolve to the
            # real editable target, set it via ValuePattern, VERIFY, then fall back to
            # keyboard entry. Verification catches silent no-ops (wrong-name saves).
            $readVal = { param($el) try { return $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value } catch { return $null } }
            $target = Resolve-EditableTarget $element

            # 1) Writable ValuePattern on the resolved target, verified.
            try {
                $vp = $target.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
                if (-not $vp.Current.IsReadOnly) {
                    $vp.SetValue($value)
                    if ((& $readVal $target) -eq $value) { return @{ success=$true; action="set-value"; value=$value; method="ValuePattern" } }
                }
            } catch { }

            # 2) Keyboard fallback: focus the resolved target, select-all, type. Last
            #    resort for controls with no usable (writable) ValuePattern.
            try {
                Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
                $target.SetFocus()
                Start-Sleep -Milliseconds 60
                $esc = [regex]::Replace($value, '([+^%~(){}\[\]])', '{$1}')
                [System.Windows.Forms.SendKeys]::SendWait("^a"); Start-Sleep -Milliseconds 30
                [System.Windows.Forms.SendKeys]::SendWait($esc); Start-Sleep -Milliseconds 60
                $after = & $readVal $target
                if ($after -eq $value -or $null -eq $after) { return @{ success=$true; action="set-value"; value=$value; method="keyboard" } }
                return @{ success=$false; error="set-value did not stick (got '$after')" }
            } catch {
                return @{ success=$false; error="set-value failed (ValuePattern + keyboard): $($_.Exception.Message)" }
            }
        }
        "get-value" {
            # Document/RichEdit controls (Win11 Notepad, WordPad, many editors)
            # expose a ValuePattern that GetCurrentPattern returns successfully
            # but whose .Current.Value is ALWAYS "" — the real text lives in the
            # TextPattern. The old code returned that "" because the try only
            # caught a throw, not an empty value, so get_value /
            # element_value_contains read blank while text was on screen →
            # false DEVIATIONs that told the model to retry (duplicating writes).
            # Try ValuePattern, and if it yields nothing, fall through to
            # TextPattern, then Name. Prefer the first NON-EMPTY result.
            $val = $null; $method = $null
            try {
                $vp = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
                $v = $vp.Current.Value
                if ($null -ne $v -and $v.Length -gt 0) { $val = $v; $method = "ValuePattern" }
            } catch { }
            if ($null -eq $val) {
                try {
                    $tp = $element.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
                    $t = $tp.DocumentRange.GetText(-1)
                    if ($null -ne $t -and $t.Length -gt 0) { $val = $t; $method = "TextPattern" }
                } catch { }
            }
            if ($null -eq $val) {
                # Combo boxes / lists / tab strips: the value is the selected item.
                try {
                    $sp = $element.GetCurrentPattern([System.Windows.Automation.SelectionPattern]::Pattern)
                    $sel = $sp.Current.GetSelection()
                    if ($sel.Length -gt 0 -and $sel[0].Current.Name) { $val = $sel[0].Current.Name; $method = "SelectionPattern" }
                } catch { }
            }
            if ($null -eq $val) { $val = $element.Current.Name; $method = "Name" }
            return @{ success=$true; action="get-value"; value=$val; method=$method }
        }
        "focus" {
            try { $element.SetFocus(); return @{ success=$true; action="focus" } }
            catch { return @{ success=$false; error="SetFocus failed: $($_.Exception.Message)" } }
        }
        "expand" {
            try {
                $p = $element.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
                $p.Expand(); return @{ success=$true; action="expand" }
            } catch { return @{ success=$false; error="ExpandCollapsePattern not supported" } }
        }
        "collapse" {
            try {
                $p = $element.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
                $p.Collapse(); return @{ success=$true; action="collapse" }
            } catch { return @{ success=$false; error="ExpandCollapsePattern not supported" } }
        }
        "toggle" {
            try {
                $p = $element.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
                $p.Toggle()
                $state = $p.Current.ToggleState.ToString()
                return @{ success=$true; action="toggle"; data=@{ toggleState=$state } }
            } catch { return @{ success=$false; error="TogglePattern not supported" } }
        }
        "select" {
            try {
                $p = $element.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
                $p.Select(); return @{ success=$true; action="select" }
            } catch { return @{ success=$false; error="SelectionItemPattern not supported" } }
        }
        default { return @{ success=$false; error="Unknown action: $action" } }
    }
}

# ── Command: get-focused-element ──────────────────────────────────────────────
function Cmd-GetFocusedElement {
    try {
        $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
        if ($null -eq $focused) { return @{ success=$false; error="No focused element" } }
        $cur = $focused.Current
        $rect = $cur.BoundingRectangle
        $bounds = if ([double]::IsInfinity($rect.X) -or [double]::IsInfinity($rect.Y)) {
            @{ x=0; y=0; width=0; height=0 }
        } else {
            @{ x=[Math]::Round($rect.X); y=[Math]::Round($rect.Y); width=[Math]::Round($rect.Width); height=[Math]::Round($rect.Height) }
        }
        $typeName = if ($cur.ControlType) { $cur.ControlType.ProgrammaticName } else { "" }
        # Try to read current value if it's an editable element
        $value = ""
        try {
            $vp = $focused.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
            $value = $vp.Current.Value
        } catch {
            try {
                $tp = $focused.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
                $value = $tp.DocumentRange.GetText(1000)
            } catch {}
        }
        return [ordered]@{
            success      = $true
            name         = if ($cur.Name) { $cur.Name } else { "" }
            automationId = if ($cur.AutomationId) { $cur.AutomationId } else { "" }
            controlType  = $typeName
            className    = if ($cur.ClassName) { $cur.ClassName } else { "" }
            processId    = $cur.ProcessId
            isEnabled    = $cur.IsEnabled
            bounds       = $bounds
            value        = $value
        }
    } catch {
        return @{ success=$false; error=$_.Exception.Message }
    }
}

# ── Main: signal ready, then read commands ────────────────────────────────────
[Console]::Out.WriteLine('{"ready":true}')
[Console]::Out.Flush()

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line -or $line.Trim() -eq "EXIT") { break }
    $line = $line.Trim()
    if ($line -eq "") { continue }

    try {
        $cmd = $line | ConvertFrom-Json
        $result = switch ($cmd.cmd) {
            "get-screen-context"    { Cmd-GetScreenContext $cmd }
            "get-foreground-window" { Cmd-GetForegroundWindow }
            "focus-window"          { Cmd-FocusWindow $cmd }
            "find-element"          { Cmd-FindElement $cmd }
            "invoke-element"        { Cmd-InvokeElement $cmd }
            "get-focused-element"   { Cmd-GetFocusedElement }
            "activate-at-point"     { Cmd-ActivateAtPoint $cmd }
            "list-displays"         { Cmd-ListDisplays }
            "move-cursor"           { Cmd-MoveCursor $cmd }
            "get-cursor"            { Cmd-GetCursor }
            "capture-rect"          { Cmd-CaptureRect $cmd }
            "ping"                  { @{ pong=$true } }
            default                 { @{ error="Unknown command: $($cmd.cmd)" } }
        }
        # -InputObject (NOT pipe): piping an EMPTY array sends zero objects to
        # ConvertTo-Json, which then writes nothing → the bridge never answers
        # and PSRunner stalls for its full 20s timeout (every element MISS paid
        # this; it poisoned wait_for_element / element_exists / the reactive
        # settle-poll). -InputObject serializes @() as "[]" and also preserves
        # single-element arrays instead of unwrapping them to a bare object.
        [Console]::Out.WriteLine((ConvertTo-Json -InputObject $result -Depth 50 -Compress))
    } catch {
        [Console]::Out.WriteLine((ConvertTo-Json -InputObject @{ error=$_.Exception.Message } -Compress))
    }
    [Console]::Out.Flush()
}
