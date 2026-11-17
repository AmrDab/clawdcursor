<#
.SYNOPSIS
  Windows probe for rung R1 of the own-window plan: which apps accept input addressed to a
  BACKGROUND window while a "user" window stays in front?

.DESCRIPTION
  Measurement only. See eval/own-window/README.md. Windows PowerShell 5.1.
  Opens: a "ClawdUser" form (the fake user window), plus one target app at a time
  (ClawdTarget form, Notepad, Calculator, Edge InPrivate, VS Code). Closes all of it at the end.

.PARAMETER DryRun
  Print the plan and what is installed; open nothing, send nothing.
.PARAMETER Targets
  Subset of: winforms, notepad, calculator, edge, vscode.
.PARAMETER OutDir
  Where results\windows-<timestamp>.jsonl goes (default: results\ next to this script).
#>
[CmdletBinding()]
param(
    [switch]$DryRun,
    [ValidateSet('winforms', 'notepad', 'calculator', 'edge', 'vscode')]
    [string[]]$Targets = @('winforms', 'notepad', 'calculator', 'edge', 'vscode'),
    [string]$OutDir
)

$ErrorActionPreference = 'Stop'
$TargetBudgetSec = 20      # time box for the METHODS of one target (launch has its own wait limits)
$SettleMs = 400            # wait after each method before reading back
$Methods = @('M0', 'M1', 'M2', 'M3', 'M4', 'M5')

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $OutDir) { $OutDir = Join-Path $here 'results' }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

# ---------------------------------------------------------------- plan
$PlanText = [ordered]@{
    winforms   = 'a WinForms form "ClawdTarget" (TextBox + Button), in its own powershell.exe'
    notepad    = 'a new Notepad window'
    calculator = 'Calculator (UWP), only if it is not already running'
    edge       = 'an Edge InPrivate window on a temp HTML page (never your normal profile)'
    vscode     = 'VS Code with a throwaway --user-data-dir and an empty temp file (only if "code" is on PATH)'
}
$Applicable = @{
    winforms   = 'M0 M1 M2 M3 M4 M5'
    notepad    = 'M0 M1 M2 M3'
    calculator = 'M1 M2 M3 M4 M5'
    edge       = 'M0 M1 M2 M3 M4 M5'
    vscode     = 'M0 M1 M2 M3'
}

function Get-EdgePath {
    foreach ($k in 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe',
                   'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe') {
        $p = (Get-ItemProperty -Path $k -ErrorAction SilentlyContinue).'(default)'
        if ($p -and (Test-Path $p)) { return $p }
    }
    foreach ($p in "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") {
        if (Test-Path $p) { return $p }
    }
    return $null
}

# returns $null when installed, else the skip reason
function Test-Installed($name) {
    switch ($name) {
        'winforms'   { return $null }
        'notepad'    { if (Get-Command notepad.exe -ErrorAction SilentlyContinue) { return $null } else { return 'not installed' } }
        'calculator' { if (Get-AppxPackage -Name Microsoft.WindowsCalculator -ErrorAction SilentlyContinue) { return $null } else { return 'not installed' } }
        'edge'       { if (Get-EdgePath) { return $null } else { return 'not installed' } }
        'vscode'     { if (Get-Command code -ErrorAction SilentlyContinue) { return $null } else { return 'not installed' } }
    }
}

if ($DryRun) {
    Write-Host 'DRY RUN: nothing will be opened or sent.'
    Write-Host 'It would open the fake user window "ClawdUser", then one target at a time:'
    foreach ($n in $Targets) {
        $why = Test-Installed $n
        $state = if ($why) { "SKIP ($why)" } else { 'would run' }
        Write-Host ('  - {0,-10} {1}: {2}; methods {3}' -f $n, $state, $PlanText[$n], $Applicable[$n])
    }
    Write-Host ('Output would go to {0}\windows-{1}.jsonl' -f $OutDir, $stamp)
    return
}

Write-Host 'This probe will now OPEN windows and SEND synthetic input to them. Hands off mouse and keyboard until it finishes (about 1-2 minutes).'
Write-Host 'It opens: the user window "ClawdUser", then, one at a time:'
foreach ($n in $Targets) { Write-Host ('  - {0}: {1}' -f $n, $PlanText[$n]) }
Write-Host 'Everything it opens is closed at the end.'

# ---------------------------------------------------------------- win32 + UIA
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

if (-not ([System.Management.Automation.PSTypeName]'ClawdW32').Type) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class ClawdW32 {
    delegate bool EnumProc(IntPtr h, IntPtr l);
    [StructLayout(LayoutKind.Sequential)] struct PT { public int X; public int Y; }

    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc p, IntPtr l);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll", EntryPoint = "PostMessageW")] static extern bool PostMessageW(IntPtr h, uint m, IntPtr w, IntPtr l);
    [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW")] static extern IntPtr SendMessageTimeoutW(IntPtr h, uint m, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW", CharSet = CharSet.Unicode)] static extern IntPtr SendMessageTimeoutS(IntPtr h, uint m, IntPtr w, string l, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out PT p);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder sb, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder sb, int n);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll")] static extern bool ScreenToClient(IntPtr h, ref PT p);
    [DllImport("user32.dll")] static extern short VkKeyScanW(char c);
    [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint type);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

    public static void DpiAware() { SetProcessDPIAware(); }
    public static long Fg() { return GetForegroundWindow().ToInt64(); }
    public static long Root(long h) { return GetAncestor(new IntPtr(h), 2).ToInt64(); }
    public static string Cls(long h) { StringBuilder sb = new StringBuilder(256); GetClassName(new IntPtr(h), sb, 256); return sb.ToString(); }
    public static string Txt(long h) { StringBuilder sb = new StringBuilder(512); GetWindowText(new IntPtr(h), sb, 512); return sb.ToString(); }
    public static uint Pid(long h) { uint p; GetWindowThreadProcessId(new IntPtr(h), out p); return p; }
    public static int[] Cursor() { PT p; GetCursorPos(out p); return new int[] { p.X, p.Y }; }
    public static int[] ToClient(long h, int x, int y) { PT p = new PT(); p.X = x; p.Y = y; ScreenToClient(new IntPtr(h), ref p); return new int[] { p.X, p.Y }; }
    public static long LParam(int x, int y) { return (long)(uint)(((y & 0xFFFF) << 16) | (x & 0xFFFF)); }
    public static int Vk(char c) { return (int)VkKeyScanW(c); }
    public static uint Scan(uint vk) { return MapVirtualKey(vk, 0); }

    public static bool Post(long h, uint m, long w, long l) { return PostMessageW(new IntPtr(h), m, new IntPtr(w), new IntPtr(l)); }
    // true when the target answered inside the timeout (SMTO_ABORTIFHUNG = 2)
    public static bool SendStr(long h, uint m, string s, uint flags, uint timeoutMs) {
        IntPtr res;
        return SendMessageTimeoutS(new IntPtr(h), m, IntPtr.Zero, s, flags, timeoutMs, out res) != IntPtr.Zero;
    }

    public static long[] TopLevel() {
        List<long> lst = new List<long>();
        EnumWindows(delegate(IntPtr h, IntPtr l) { if (IsWindowVisible(h)) lst.Add(h.ToInt64()); return true; }, IntPtr.Zero);
        return lst.ToArray();
    }

    [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW", CharSet = CharSet.Unicode)] static extern IntPtr SendMessageTimeoutB(IntPtr h, uint m, IntPtr w, StringBuilder l, uint flags, uint timeout, out IntPtr result);
    // A control's text in another process: WM_GETTEXT (GetWindowText returns only captions across processes).
    public static string GetText(long h) {
        StringBuilder sb = new StringBuilder(4096); IntPtr res;
        SendMessageTimeoutB(new IntPtr(h), 0x000D, new IntPtr(4096), sb, 2, 1500, out res);
        return sb.ToString();
    }
    // First descendant whose class contains `part` (WinForms classes carry a per-build suffix); 0 when none.
    public static long DescendantLike(long root, string part) {
        long found = 0;
        EnumChildWindows(new IntPtr(root), delegate(IntPtr h, IntPtr l) {
            if (Cls(h.ToInt64()).Contains(part)) { found = h.ToInt64(); return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    // first descendant (any depth) with this window class; 0 when none
    public static long Descendant(long root, string cls) {
        IntPtr direct = FindWindowEx(new IntPtr(root), IntPtr.Zero, cls, null);
        if (direct != IntPtr.Zero) return direct.ToInt64();
        long found = 0;
        EnumChildWindows(new IntPtr(root), delegate(IntPtr h, IntPtr l) {
            if (Cls(h.ToInt64()) == cls) { found = h.ToInt64(); return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    // setup only: bring h to the front (attach to the current foreground thread to defeat the lock)
    public static bool ForceFg(long hv) {
        IntPtr h = new IntPtr(hv);
        IntPtr fg = GetForegroundWindow();
        uint dummy;
        uint fgThread = fg == IntPtr.Zero ? 0 : GetWindowThreadProcessId(fg, out dummy);
        uint me = GetCurrentThreadId();
        bool attached = fgThread != 0 && fgThread != me && AttachThreadInput(me, fgThread, true);
        if (IsIconic(h)) ShowWindow(h, 9);
        // Foreground lock: a background process may not take the foreground; a key event from this process lifts it.
        keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero);   // Alt down/up
        SetForegroundWindow(h);
        if (attached) AttachThreadInput(me, fgThread, false);
        return GetForegroundWindow() == h;
    }
}
'@
}
[ClawdW32]::DpiAware()

$UIA = [System.Windows.Automation.AutomationElement]
$Scope = [System.Windows.Automation.TreeScope]

# ---------------------------------------------------------------- state
$script:Rows = New-Object System.Collections.ArrayList
$script:Summaries = New-Object System.Collections.ArrayList
$script:OwnedRoots = @{}      # top-level hwnd (int64) -> $true, windows this script started
$script:OwnedPids = @{}       # pids this script started and that nothing else uses
$script:UserHwnd = 0L
$script:UserPid = 0
$script:UserEl = $null
$script:TempDir = Join-Path $env:TEMP ('clawd-own-window-' + $stamp)
$null = New-Item -ItemType Directory -Force -Path $script:TempDir
$null = New-Item -ItemType Directory -Force -Path $OutDir
$script:OutFile = Join-Path $OutDir ("windows-$stamp.jsonl")
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Write-Jsonl($obj) {
    $line = ($obj | ConvertTo-Json -Compress -Depth 5)
    [System.IO.File]::AppendAllText($script:OutFile, $line + "`n", $utf8)
}

# ---------------------------------------------------------------- guards and helpers
function Add-Owned($h) { $script:OwnedRoots[[int64][ClawdW32]::Root($h)] = $true }

# Posted/sent input goes ONLY to windows this script started, never to the user form.
function Assert-Sendable($h) {
    $root = [ClawdW32]::Root($h)
    if ($root -eq $script:UserHwnd -or [ClawdW32]::Pid($h) -eq $script:UserPid) { throw 'refused: that is the user window' }
    $owned = $script:OwnedRoots.ContainsKey([int64]$root) -or $script:OwnedPids.ContainsKey([int][ClawdW32]::Pid($h))
    if (-not $owned) { throw 'refused: window was not started by this script' }
}
function Post-G($h, $msg, $w, $l) { Assert-Sendable $h; $null = [ClawdW32]::Post([int64]$h, [uint32]$msg, [int64]$w, [int64]$l) }
function SendStr-G($h, $msg, $s) { Assert-Sendable $h; return [ClawdW32]::SendStr([int64]$h, [uint32]$msg, $s, 2, 1500) }

function Get-TopSet {
    $s = @{}
    foreach ($h in [ClawdW32]::TopLevel()) { $s[[int64]$h] = $true }
    return $s
}

# $match: scriptblock taking $h, true for the window we want; ignores windows already in $before
function Wait-NewWindow($before, [scriptblock]$match, $ms) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while ($sw.ElapsedMilliseconds -lt $ms) {
        foreach ($h in [ClawdW32]::TopLevel()) {
            if ($before.ContainsKey([int64]$h)) { continue }
            if (& $match $h) { return [int64]$h }
        }
        Start-Sleep -Milliseconds 200
    }
    return 0L
}

function Find-ById($root, $id) {
    $c = New-Object System.Windows.Automation.PropertyCondition($UIA::AutomationIdProperty, $id)
    return $root.FindFirst($Scope::Descendants, $c)
}
function Find-ByName($root, $name) {
    $c = New-Object System.Windows.Automation.PropertyCondition($UIA::NameProperty, $name)
    return $root.FindFirst($Scope::Descendants, $c)
}
function Find-ByClass($root, $cls) {
    $c = New-Object System.Windows.Automation.PropertyCondition($UIA::ClassNameProperty, $cls)
    return $root.FindFirst($Scope::Descendants, $c)
}
function Find-ByType($root, $type) {
    $c = New-Object System.Windows.Automation.PropertyCondition($UIA::ControlTypeProperty, $type)
    return $root.FindFirst($Scope::Descendants, $c)
}
function Retry-Find([scriptblock]$f, $ms) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    do {
        $r = & $f
        if ($r) { return $r }
        Start-Sleep -Milliseconds 300
    } while ($sw.ElapsedMilliseconds -lt $ms)
    return $null
}

function Read-ElText($el) {
    $vp = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) { return [string]$vp.Current.Value }
    $tp = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$tp)) { return [string]$tp.DocumentRange.GetText(-1) }
    return $null
}
function Invoke-El($el) {
    $ip = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $ip.Invoke()
}
function Norm($s) { if ($null -eq $s) { return '' } return ([string]$s).TrimEnd("`r", "`n") }

function Read-UserText {
    if (-not $script:UserEdit) { return $null }
    return [ClawdW32]::GetText($script:UserEdit)
}

# setup only: make the user form the foreground window again
function Ensure-UserFront {
    for ($i = 0; $i -lt 6; $i++) {
        if ([ClawdW32]::Fg() -eq $script:UserHwnd) { return $true }
        $null = [ClawdW32]::ForceFg($script:UserHwnd)
        Start-Sleep -Milliseconds 150
    }
    return ([ClawdW32]::Fg() -eq $script:UserHwnd)
}

# ---------------------------------------------------------------- child WinForms processes
$UserFormScript = @'
Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.Form
$f.Text = 'ClawdUser'; $f.Width = 460; $f.Height = 160; $f.StartPosition = 'CenterScreen'
$t = New-Object System.Windows.Forms.TextBox
$t.Name = 'userBox'; $t.Left = 10; $t.Top = 10; $t.Width = 420; $t.Text = 'user-was-here'
$f.Controls.Add($t)
$f.Add_Shown({ $this.Activate(); $this.ActiveControl = $this.Controls['userBox']; $this.Controls['userBox'].Focus() })
[void][System.Windows.Forms.Application]::Run($f)
'@

$TargetFormScript = @'
Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.Form
$f.Text = 'ClawdTarget'; $f.Width = 460; $f.Height = 200; $f.StartPosition = 'CenterScreen'
$t = New-Object System.Windows.Forms.TextBox
$t.Name = 't'; $t.Left = 10; $t.Top = 10; $t.Width = 420
$b = New-Object System.Windows.Forms.Button
$b.Name = 'b'; $b.Text = 'ClawdGo'; $b.Left = 10; $b.Top = 50; $b.Width = 120
$b.Add_Click({ $this.FindForm().Text = 'CLICKED' })
$f.Controls.Add($t); $f.Controls.Add($b)
[void][System.Windows.Forms.Application]::Run($f)
'@

function Start-FormProcess($name, $body) {
    $path = Join-Path $script:TempDir ($name + '.ps1')
    Set-Content -Path $path -Value $body -Encoding ASCII
    # Not Start-Process -WindowStyle Hidden: that sets SW_HIDE in STARTUPINFO, which Windows applies to the process's
    # first shown window, so the form itself stayed hidden. powershell's own -WindowStyle hides only its console.
    return (Start-Process powershell.exe -PassThru -ArgumentList @('-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', $path))
}

# ---------------------------------------------------------------- targets
function New-Target($name) {
    return @{
        Name = $name; Kind = $name; Skip = $null
        Top = 0L; Edit = $null; Button = $null; Text = 'hello@1!'
        InputHwnd = 0L; ClickHwnd = 0L
        NA = @(); ClickRead = $null; ClickReset = $null
        KillPids = @(); KillByCmdline = $null; Deadline = $null
    }
}

function Launch-WinForms($t) {
    $p = Start-FormProcess 'target' $TargetFormScript
    $script:OwnedPids[[int]$p.Id] = $true; $t.KillPids += $p.Id
    $script:wPid = [uint32]$p.Id
    $h = Wait-NewWindow @{} { param($h) [ClawdW32]::Pid($h) -eq $script:wPid -and [ClawdW32]::Txt($h) -eq 'ClawdTarget' } 10000
    if (-not $h) { $t.Skip = 'ClawdTarget form did not appear'; return }
    $t.Top = $h; Add-Owned $h
    $root = $UIA::FromHandle([IntPtr]$h)
    # The managed UIA client sees WinForms controls in another process as Panes (no Value/Invoke pattern): take them by
    # their HWND. M0/M5 are still attempted through UIA on those elements and recorded as what they are.
    $t.EditHwnd = [ClawdW32]::DescendantLike($h, '.EDIT.')
    $t.ButtonHwnd = [ClawdW32]::DescendantLike($h, '.BUTTON.')
    if ($t.EditHwnd) { $t.Edit = $UIA::FromHandle([IntPtr]$t.EditHwnd) }
    if ($t.ButtonHwnd) { $t.Button = $UIA::FromHandle([IntPtr]$t.ButtonHwnd) }
    $t.ClickRead = { param($t) [ClawdW32]::Txt($t.Top) -eq 'CLICKED' }
    $t.ClickReset = { param($t) $null = SendStr-G $t.Top 0xC 'ClawdTarget' }
}

function Launch-Notepad($t) {
    $t.NA = @('M4', 'M5')
    $before = Get-TopSet
    $pre = @{}; foreach ($p in (Get-Process -Name notepad -ErrorAction SilentlyContinue)) { $pre[[int]$p.Id] = $true }
    $null = Start-Process notepad.exe -PassThru
    $h = Wait-NewWindow $before { param($h) [ClawdW32]::Cls($h) -eq 'Notepad' } 10000
    if (-not $h) { $t.Skip = 'no new Notepad window appeared (maybe it opened as a tab in an existing one)'; return }
    $t.Top = $h; Add-Owned $h
    $npid = [int][ClawdW32]::Pid($h)
    if (-not $pre.ContainsKey($npid)) { $script:OwnedPids[$npid] = $true; $t.KillPids += $npid }
    $root = $UIA::FromHandle([IntPtr]$h)
    $t.Edit = Retry-Find {
        $e = Find-ByClass $root 'RichEditD2DPT'
        if (-not $e) { $e = Find-ByClass $root 'Edit' }
        if (-not $e) { $e = Find-ByType $root ([System.Windows.Automation.ControlType]::Document) }
        $e
    } 6000
    if ($t.Edit -and (Norm (Read-ElText $t.Edit)) -ne '') {
        $t.Skip = 'Notepad opened with existing (restored) text; skipped so nothing of yours is overwritten'
    }
}

function Launch-Calculator($t) {
    $t.NA = @('M0')
    $t.Text = '123'
    if (Get-Process -Name CalculatorApp -ErrorAction SilentlyContinue) { $t.Skip = 'Calculator is already running; refusing to touch it'; return }
    $before = Get-TopSet
    $null = Start-Process calc.exe -PassThru
    $script:calcFrame = 0L
    $h = Wait-NewWindow $before {
        param($h)
        if ([ClawdW32]::Cls($h) -ne 'ApplicationFrameWindow') { return $false }
        $cw = [ClawdW32]::Descendant($h, 'Windows.UI.Core.CoreWindow')
        if (-not $cw) { return $false }
        $q = Get-Process -Id ([int][ClawdW32]::Pid($cw)) -ErrorAction SilentlyContinue
        return ($q -and $q.ProcessName -eq 'CalculatorApp')
    } 12000
    if (-not $h) { $t.Skip = 'Calculator window did not appear'; return }
    $t.Top = $h; Add-Owned $h
    $cw = [ClawdW32]::Descendant($h, 'Windows.UI.Core.CoreWindow')
    $cpid = [int][ClawdW32]::Pid($cw)
    $script:OwnedPids[$cpid] = $true; $t.KillPids += $cpid
    $root = $UIA::FromHandle([IntPtr]$h)
    $t.Button = Retry-Find { Find-ById $root 'num1Button' } 5000
    $t.ClickRead = { param($t) (Read-T $t) -eq '1' }
    $t.ClickReset = { param($t) Clear-Text $t }
}

function Launch-Edge($t) {
    $exe = Get-EdgePath
    $guid = [guid]::NewGuid().ToString('N').Substring(0, 8)
    $title = "ClawdEdgeProbe-$guid"
    $html = Join-Path $script:TempDir 'edge-probe.html'
    $page = "<!doctype html><html><head><meta charset=utf-8><title>$title</title></head><body>" +
            "<input id=t autofocus><button id=b onclick=""document.title='CLICKED'"">ClawdGo</button>" +
            "<button id=r onclick=""document.title='$title'"">ClawdReset</button></body></html>"
    Set-Content -Path $html -Value $page -Encoding ASCII
    $url = 'file:///' + ($html -replace '\\', '/')
    $before = Get-TopSet
    $null = Start-Process $exe -ArgumentList @('--inprivate', '--new-window', $url)
    $script:wTitle = $title
    $h = Wait-NewWindow $before { param($h) ([ClawdW32]::Cls($h) -eq 'Chrome_WidgetWin_1') -and ([ClawdW32]::Txt($h) -like "*$script:wTitle*") } 15000
    if (-not $h) { $t.Skip = 'Edge InPrivate window did not appear'; return }
    $t.Top = $h; Add-Owned $h        # Edge process is shared with the owner's Edge: never killed, window closed only
    $root = $UIA::FromHandle([IntPtr]$h)
    $doc = Retry-Find { Find-ByType $root ([System.Windows.Automation.ControlType]::Document) } 8000
    if ($doc) {
        $t.Edit = Retry-Find { Find-ByType $doc ([System.Windows.Automation.ControlType]::Edit) } 5000
        $t.Button = Find-ByName $doc 'ClawdGo'
        $reset = Find-ByName $doc 'ClawdReset'
        $t.ClickReset = { param($t) Invoke-El $reset }.GetNewClosure()
    }
    $t.ClickRead = { param($t) [ClawdW32]::Txt($t.Top) -like '*CLICKED*' }
}

function Launch-VSCode($t) {
    $t.NA = @('M4', 'M5')
    $cmd = (Get-Command code -ErrorAction Stop).Source
    $guid = [guid]::NewGuid().ToString('N').Substring(0, 8)
    $udd = Join-Path $script:TempDir 'vscode-data'
    $file = Join-Path $script:TempDir "probe-$guid.txt"
    Set-Content -Path $file -Value '' -Encoding ASCII
    $t.KillByCmdline = $udd
    $before = Get-TopSet
    $null = Start-Process $cmd -WindowStyle Hidden -ArgumentList @('--new-window', '--user-data-dir', $udd, '--disable-extensions', '--force-renderer-accessibility', $file)
    $script:wTitle = "probe-$guid"
    $h = Wait-NewWindow $before { param($h) ([ClawdW32]::Cls($h) -eq 'Chrome_WidgetWin_1') -and ([ClawdW32]::Txt($h) -like "*$script:wTitle*") } 20000
    if (-not $h) { $t.Skip = 'VS Code window did not appear'; return }
    $t.Top = $h; Add-Owned $h
    $script:OwnedPids[[int][ClawdW32]::Pid($h)] = $true     # unique --user-data-dir, so this process is ours alone
    $root = $UIA::FromHandle([IntPtr]$h)
    $t.Edit = Retry-Find { Find-ByType $root ([System.Windows.Automation.ControlType]::Edit) } 6000
}

# which HWND an agent would address, per app class
function Resolve-Handles($t) {
    $top = $t.Top
    $ih = 0L
    switch ($t.Kind) {
        { $_ -in 'edge', 'vscode' } { $ih = [ClawdW32]::Descendant($top, 'Chrome_RenderWidgetHostHWND') }
        'calculator'                { $ih = [ClawdW32]::Descendant($top, 'Windows.UI.Core.CoreWindow') }
        default {
            if ($t.Edit) {
                $n = $t.Edit.Current.NativeWindowHandle
                $w = [System.Windows.Automation.TreeWalker]::ControlViewWalker
                $e = $t.Edit
                while (-not $n -and $e) { $e = $w.GetParent($e); if ($e) { $n = $e.Current.NativeWindowHandle } }
                $ih = [int64]$n
            }
        }
    }
    if (-not $ih) { $ih = $top }
    $t.InputHwnd = $ih
    $t.ClickHwnd = $ih
    if ($t.Kind -eq 'winforms' -and $t.Button) {
        $bh = $t.Button.Current.NativeWindowHandle
        if ($bh) { $t.ClickHwnd = [int64]$bh }
    }
}

function Read-T($t) {
    if ($t.Kind -eq 'calculator') {
        $el = Find-ById ($UIA::FromHandle([IntPtr]$t.Top)) 'CalculatorResults'
        if (-not $el) { throw 'no CalculatorResults element' }
        $n = $el.Current.Name
        if ($n -match 'Display is (.+)$') { $v = $matches[1] -replace '[,\s]', ''; if ($v -eq '0') { return '' } return $v }
        return $n
    }
    if ($t.Kind -eq 'winforms') { return [ClawdW32]::GetText($t.EditHwnd) }
    if (-not $t.Edit) { throw 'no UIA edit element to read back' }
    $v = Read-ElText $t.Edit
    if ($null -eq $v) { throw 'edit element exposes neither ValuePattern nor TextPattern' }
    return $v
}

# restore state between methods (R0 UIA on the target; WM_SETTEXT as a fallback for Notepad)
function Clear-Text($t) {
    if ($t.Kind -eq 'calculator') {
        $el = Find-ById ($UIA::FromHandle([IntPtr]$t.Top)) 'clearButton'
        if ($el) { Invoke-El $el }
        return
    }
    if ($t.Kind -eq 'winforms') { $null = SendStr-G $t.EditHwnd 0xC ''; return }
    if ($t.Edit) {
        try { $t.Edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue('') } catch { }
    }
    if ($t.Kind -eq 'notepad' -and (Norm (Read-T $t)) -ne '') { $null = SendStr-G $t.InputHwnd 0xC '' }
}

function Judge-Text($before, $after, $text) {
    $b = Norm $before; $a = Norm $after
    if ($a -eq ($b + $text)) { return 'ok' }
    if ($a -eq $b) { return 'no-effect' }
    return 'partial'
}

# ---------------------------------------------------------------- one method on one target
function Run-Method($t, $m, [scriptblock]$pre, [scriptblock]$act, [scriptblock]$effect) {
    $row = [ordered]@{
        type = 'method'; ts = (Get-Date).ToString('o'); target = $t.Name; method = $m; outcome = 'error'
        foregroundChanged = $false; cursorMoved = $false; userTextChanged = $false; hwndClass = ''; detail = ''
    }
    try {
        if ((Get-Date) -gt $t.Deadline) { throw 'time box exceeded' }
        try { if ($pre) { & $pre $t } } catch { $row.detail = 'reset failed: ' + $_.Exception.Message + '; ' }
        if (-not (Ensure-UserFront)) { throw 'could not bring the user window to the front' }
        Start-Sleep -Milliseconds 100
        $userBefore = Read-UserText
        $cur0 = [ClawdW32]::Cursor()
        $before = $null
        try { $before = Read-T $t } catch { }
        $info = & $act $t
        Start-Sleep -Milliseconds $SettleMs
        $fg = [ClawdW32]::Fg()
        $row.foregroundChanged = ($fg -ne $script:UserHwnd)
        if ($row.foregroundChanged) { $row.detail += ('foreground now: ' + [ClawdW32]::Cls($fg) + ' "' + [ClawdW32]::Txt($fg) + '"; ') }
        $cur1 = [ClawdW32]::Cursor()
        $row.cursorMoved = (($cur0[0] -ne $cur1[0]) -or ($cur0[1] -ne $cur1[1]))
        $row.userTextChanged = ((Read-UserText) -ne $userBefore)
        $row.outcome = [string](& $effect $t $before)
        if ($info) { $row.detail += [string]$info }
    }
    catch { $row.outcome = 'error'; $row.detail += $_.Exception.Message }
    $row.hwndClass = if ($script:lastCls) { $script:lastCls } else { '(uia)' }
    $script:lastCls = $null
    [void]$script:Rows.Add($row)
    Write-Jsonl $row
}

function Mark-Cls($h) { $script:lastCls = [ClawdW32]::Cls($h) }

function Run-Methods($t) {
    $text = $t.Text
    $textPre = { param($t) Clear-Text $t }
    $textEffect = { param($t, $before) Judge-Text $before (Read-T $t) $t.Text }
    $clickPre = { param($t) & $t.ClickReset $t }
    $clickEffect = { param($t, $before) if (& $t.ClickRead $t) { 'ok' } else { 'no-effect' } }

    foreach ($m in $Methods) {
        if ($t.NA -contains $m) {
            $row = [ordered]@{ type = 'method'; ts = (Get-Date).ToString('o'); target = $t.Name; method = $m; outcome = 'n/a'
                foregroundChanged = $false; cursorMoved = $false; userTextChanged = $false; hwndClass = ''; detail = 'not applicable to this target' }
            [void]$script:Rows.Add($row); Write-Jsonl $row
            continue
        }
        switch ($m) {
            'M0' {
                Run-Method $t $m $textPre {
                    param($t)
                    $t.Edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($t.Text)
                    'UIA ValuePattern.SetValue'
                } $textEffect
            }
            'M1' {
                Run-Method $t $m $textPre {
                    param($t)
                    Mark-Cls $t.InputHwnd
                    foreach ($c in $t.Text.ToCharArray()) { Post-G $t.InputHwnd 0x102 ([int]$c) 1; Start-Sleep -Milliseconds 5 }
                    'WM_CHAR posted to ' + [ClawdW32]::Cls($t.InputHwnd)
                } $textEffect
            }
            'M2' {
                Run-Method $t $m $textPre {
                    param($t)
                    Mark-Cls $t.InputHwnd
                    $ok = SendStr-G $t.InputHwnd 0xC $t.Text
                    if ($ok) { 'WM_SETTEXT answered' } else { 'WM_SETTEXT returned 0 (refused, timed out or hung)' }
                } $textEffect
            }
            'M3' {
                Run-Method $t $m $textPre {
                    param($t)
                    Mark-Cls $t.InputHwnd
                    $shifted = ''
                    foreach ($c in $t.Text.ToCharArray()) {
                        $vk = [ClawdW32]::Vk($c)
                        if ($vk -eq -1) { continue }
                        $key = $vk -band 0xFF
                        if ((($vk -shr 8) -band 1) -eq 1) { $shifted += $c }
                        $sc = [int64][ClawdW32]::Scan([uint32]$key)
                        $down = 1 + ($sc * 65536)
                        $up = $down + 3221225472     # bit 30 (was down) + bit 31 (released)
                        Post-G $t.InputHwnd 0x100 $key $down
                        Post-G $t.InputHwnd 0x101 $key $up
                        Start-Sleep -Milliseconds 5
                    }
                    if ($shifted) { 'WM_KEYDOWN/UP; shifted chars [' + $shifted + '] need Shift, which a post cannot hold (known limit)' } else { 'WM_KEYDOWN/UP' }
                } $textEffect
            }
            'M4' {
                if (-not $t.Button) { Add-NoElement $t $m 'no button element found'; continue }
                Run-Method $t $m $clickPre {
                    param($t)
                    $h = $t.ClickHwnd
                    Mark-Cls $h
                    # A native button (Win32 / WinForms) takes BM_CLICK; posted mouse messages need capture it never gets.
                    if ([ClawdW32]::Cls($h) -match 'BUTTON') { Post-G $h 0xF5 0 0; return 'BM_CLICK posted to ' + [ClawdW32]::Cls($h) }
                    $r = $t.Button.Current.BoundingRectangle
                    if ($r.IsEmpty -or [double]::IsInfinity($r.Width)) { throw 'button has no on-screen rectangle' }
                    $c = [ClawdW32]::ToClient($h, [int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2))
                    $lp = [ClawdW32]::LParam($c[0], $c[1])
                    Post-G $h 0x200 0 $lp
                    Post-G $h 0x201 1 $lp
                    Start-Sleep -Milliseconds 50
                    Post-G $h 0x202 0 $lp
                    'WM_LBUTTONDOWN/UP at client (' + $c[0] + ',' + $c[1] + ') of ' + [ClawdW32]::Cls($h)
                } $clickEffect
            }
            'M5' {
                if (-not $t.Button) { Add-NoElement $t $m 'no button element found'; continue }
                Run-Method $t $m $clickPre {
                    param($t)
                    Invoke-El $t.Button
                    'UIA InvokePattern.Invoke'
                } $clickEffect
            }
        }
    }
}

function Add-NoElement($t, $m, $why) {
    $row = [ordered]@{ type = 'method'; ts = (Get-Date).ToString('o'); target = $t.Name; method = $m; outcome = 'error'
        foregroundChanged = $false; cursorMoved = $false; userTextChanged = $false; hwndClass = ''; detail = $why }
    [void]$script:Rows.Add($row); Write-Jsonl $row
}

# ---------------------------------------------------------------- close what we opened
function Close-Target($t) {
    try {
        if ($t.Kind -eq 'notepad' -and $t.Edit) { try { Clear-Text $t } catch { } }   # avoid a save prompt
        if ($t.Top) { Post-G $t.Top 0x10 0 0 }                                          # WM_CLOSE
        Start-Sleep -Milliseconds 1200
    } catch { }
    foreach ($id in $t.KillPids) {
        try { if (Get-Process -Id $id -ErrorAction SilentlyContinue) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue } } catch { }
    }
    if ($t.KillByCmdline) {
        try {
            $needle = $t.KillByCmdline
            foreach ($p in (Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($needle) })) {
                Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
            }
        } catch { }
    }
    if ($t.Top -and [ClawdW32]::Cls($t.Top)) {
        if ([ClawdW32]::Txt($t.Top) -ne '' -and ([ClawdW32]::TopLevel() -contains [int64]$t.Top)) {
            Write-Host ('  note: window "' + [ClawdW32]::Txt($t.Top) + '" is still open (probably a save prompt); close it by hand')
        }
    }
}

function Run-Target($name) {
    $t = New-Target $name
    $script:lastCls = $null
    Write-Host ("[{0}] starting" -f $name)
    try {
        $why = Test-Installed $name
        if ($why) { $t.Skip = $why }
        else {
            switch ($name) {
                'winforms'   { Launch-WinForms $t }
                'notepad'    { Launch-Notepad $t }
                'calculator' { Launch-Calculator $t }
                'edge'       { Launch-Edge $t }
                'vscode'     { Launch-VSCode $t }
            }
            if (-not $t.Skip) {
                Resolve-Handles $t
                $t.Deadline = (Get-Date).AddSeconds($TargetBudgetSec)
                Run-Methods $t
            }
        }
    }
    catch { if (-not $t.Skip) { $t.Skip = 'setup error: ' + $_.Exception.Message } }
    finally { try { Close-Target $t } catch { } }

    $mine = @($script:Rows | Where-Object { $_.target -eq $name })
    $cells = [ordered]@{}
    foreach ($m in $Methods) {
        $r = $mine | Where-Object { $_.method -eq $m } | Select-Object -First 1
        $cells[$m] = if ($r) { $r.outcome } else { '-' }
    }
    $flag = { param($k) $x = @($mine | Where-Object { $_[$k] -eq $true } | ForEach-Object { $_.method }); if ($x.Count) { $x -join ',' } else { '' } }
    $classes = @($mine | Where-Object { $_.hwndClass -and $_.hwndClass -ne '(uia)' } | ForEach-Object { $_.hwndClass } | Select-Object -Unique)
    $sum = [ordered]@{
        type = 'target'; ts = (Get-Date).ToString('o'); target = $name; skipped = $t.Skip; cells = $cells
        foregroundChanged = ((& $flag 'foregroundChanged') -ne ''); foregroundChangedBy = (& $flag 'foregroundChanged')
        cursorMoved = ((& $flag 'cursorMoved') -ne ''); cursorMovedBy = (& $flag 'cursorMoved')
        userTextChanged = ((& $flag 'userTextChanged') -ne ''); userTextChangedBy = (& $flag 'userTextChanged')
        hwndClass = ($classes -join ' | ')
    }
    [void]$script:Summaries.Add($sum)
    Write-Jsonl $sum
    if ($t.Skip) { Write-Host ("[{0}] skipped: {1}" -f $name, $t.Skip) }
}

# ---------------------------------------------------------------- main
try {
    $up = Start-FormProcess 'user' $UserFormScript
    $script:UserPid = [int]$up.Id
    $script:wPid = [uint32]$up.Id
    # Title too: the process's own console window also belongs to this pid for a moment.
    $script:UserHwnd = Wait-NewWindow @{} { param($h) [ClawdW32]::Pid($h) -eq $script:wPid -and [ClawdW32]::Txt($h) -eq 'ClawdUser' } 10000
    if (-not $script:UserHwnd) { throw 'the ClawdUser form did not appear' }
    # The managed UIA client sees a WinForms TextBox in another process as a Pane with no ValuePattern: read it by message.
    $script:UserEdit = [ClawdW32]::DescendantLike($script:UserHwnd, '.EDIT.')
    if (-not $script:UserEdit) { throw 'cannot find the ClawdUser text box' }
    if (-not (Ensure-UserFront)) { throw 'cannot make ClawdUser the foreground window (Windows foreground lock); run from an interactive session' }
    Write-Host ('user window ready, text = "' + (Read-UserText) + '"')

    foreach ($n in $Targets) { Run-Target $n }
}
finally {
    try { if ($script:UserPid) { Stop-Process -Id $script:UserPid -Force -ErrorAction SilentlyContinue } } catch { }
    try { Remove-Item -Recurse -Force -Path $script:TempDir -ErrorAction SilentlyContinue } catch { }
}

# ---------------------------------------------------------------- table
Write-Host ''
Write-Host ('| target | ' + ($Methods -join ' | ') + ' | foreground changed | cursor moved | user text changed | hwnd class |')
Write-Host ('|' + ('---|' * ($Methods.Count + 5)))
foreach ($s in $script:Summaries) {
    if ($s.skipped) {
        Write-Host ('| {0} | skipped: {1} |{2}' -f $s.target, $s.skipped, (' |' * ($Methods.Count + 4)))
        continue
    }
    $c = ($Methods | ForEach-Object { $s.cells[$_] }) -join ' | '
    $f = { param($any, $by) if ($any) { 'yes (' + $by + ')' } else { 'no' } }
    Write-Host ('| {0} | {1} | {2} | {3} | {4} | {5} |' -f $s.target, $c,
        (& $f $s.foregroundChanged $s.foregroundChangedBy), (& $f $s.cursorMoved $s.cursorMovedBy),
        (& $f $s.userTextChanged $s.userTextChangedBy), $s.hwndClass)
}
Write-Host ''
Write-Host ('JSON lines: ' + $script:OutFile)
